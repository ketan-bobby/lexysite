/** Isolated browser fixtures. No real mailboxes, model calls or provider sends. */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { and, eq, inArray, sql } from "drizzle-orm";
import assert from "node:assert/strict";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
} from "@workspace/db";
import { issueToken } from "../src/lib/auth-token";
import { journeySteps, readBrief, type WorkflowScope } from "../src/lib/recruiting-workflows";
import { controlControlledOffer, readControlledOffer } from "../src/lib/controlled-offers";
const file = "/tmp/controlled-offer-browser-fixture.json";
if (process.argv.includes("--verify-decision")) {
  const f = JSON.parse(await readFile(file, "utf8"));
  const rows = await dbAdmin.select().from(workflows).where(eq(workflows.tenantId, f.tenantId));
  const staff = rows.find((row) => row.id === f.staffWorkflowId)!;
  const recipient = rows.find((row) => row.id === f.recipientWorkflowId)!;
  const final = staff.steps.find((s) => s.key === "hiring_decision")!;
  assert.equal(final.humanDecision?.outcome, "decline");
  assert.equal(final.humanDecisionHistory?.length, 2);
  assert.equal(final.humanDecisionHistory?.[0].outcome, "hire");
  assert.equal(final.humanDecisionHistory?.[1].outcome, "hold");
  assert.equal(final.evidence, "Workflow-only synthetic fixture.");
  assert.equal(final.controlledOffer?.status, "draft");
  assert.equal(final.controlledOffer?.version, 3);
  assert.equal(final.controlledOffer?.approvedBy, undefined);
  const offered = recipient.steps.find((s) => s.key === "hiring_decision")!;
  assert.equal(offered.humanDecision?.outcome, "decline");
  assert.equal(offered.humanDecision?.offerEffect, "sent_retained");
  assert.equal(offered.controlledOffer?.status, "accepted");
  const apps = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(inArray(applicationsTable.jobId, f.jobIds));
  assert.ok(apps.length === 2 && apps.every((app) => app.stage === "applied"));
  const outcomes = await dbAdmin.execute(
    sql`SELECT count(*) AS count FROM candidate_outcomes WHERE candidate_id=${f.candidateId}`,
  );
  const fees = await dbAdmin.execute(
    sql`SELECT count(*) AS count FROM fee_line_items WHERE tenant_id=${f.tenantId} OR candidate_id=${f.candidateId}`,
  );
  assert.equal(Number(outcomes.rows[0].count), 0);
  assert.equal(Number(fees.rows[0].count), 0);
  process.stdout.write(
    "Verified decision corrections, original evidence/history, reset draft, retained accepted offer, unchanged applications and zero employment/fees.\n",
  );
} else if (process.argv.includes("--verify")) {
  const f = JSON.parse(await readFile(file, "utf8"));
  const rows = await dbAdmin.select().from(workflows).where(eq(workflows.tenantId, f.tenantId));
  const offers = rows.flatMap((row) =>
    row.steps.flatMap((step) => (step.controlledOffer ? [step.controlledOffer] : [])),
  );
  assert.deepEqual(offers.map((offer) => offer.status).sort(), ["accepted", "approved"]);
  assert.ok(offers.every((offer) => offer.testOnly));
  assert.equal(offers.find((offer) => offer.status === "approved")?.version, 2);
  const apps = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(inArray(applicationsTable.jobId, f.jobIds));
  assert.equal(apps.length, 2);
  assert.ok(apps.every((app) => app.stage === "applied"));
  const outcomes = await dbAdmin.execute(
    sql`SELECT count(*) AS count FROM candidate_outcomes WHERE candidate_id=${f.candidateId}`,
  );
  const fees = await dbAdmin.execute(
    sql`SELECT count(*) AS count FROM fee_line_items WHERE tenant_id=${f.tenantId} OR candidate_id=${f.candidateId}`,
  );
  assert.equal(Number(outcomes.rows[0].count), 0);
  assert.equal(Number(fees.rows[0].count), 0);
  process.stdout.write(
    "Verified isolated browser flow: approved staff v2, accepted recipient, unchanged applications, zero employment outcomes and fee items.\n",
  );
} else if (process.argv.includes("--cleanup")) {
  const f = JSON.parse(await readFile(file, "utf8"));
  await dbAdmin.delete(receipts).where(eq(receipts.tenantId, f.tenantId));
  await dbAdmin.delete(events).where(eq(events.tenantId, f.tenantId));
  await dbAdmin.delete(workflows).where(eq(workflows.tenantId, f.tenantId));
  await dbAdmin.delete(journeys).where(eq(journeys.tenantId, f.tenantId));
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.jobId, f.jobIds));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, f.jobIds));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, f.tenantId));
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, f.tenantId));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, f.tenantId));
  await unlink(file);
  process.stdout.write("Isolated controlled-offer fixtures removed.\n");
} else {
  const tenantId = `offer_qa_${randomUUID()}`,
    actorId = randomUUID(),
    candidateId = randomUUID();
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: tenantId, name: "Isolated offer QA", slug: tenantId });
  await dbAdmin.insert(usersTable).values({
    id: actorId,
    tenantId,
    name: "Isolated offer reviewer",
    email: `${actorId}@example.invalid`,
    role: "tenant_admin",
    status: "active",
    passwordHash: "disabled-qa-password",
  });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId,
    firstName: "Synthetic",
    lastName: "Offer QA",
    email: `${candidateId}@example.invalid`,
    pool: "tenant",
    verificationResult: {
      syntheticFixture: { kind: "controlled_inbox" },
      privateCoaching: "PRIVATE_QA_NOT_FOR_EMPLOYERS",
    },
  });
  const jobIds: string[] = [];
  async function fixture(title: string) {
    const jobId = randomUUID(),
      workflowId = randomUUID(),
      journeyId = randomUUID();
    jobIds.push(jobId);
    await dbAdmin.insert(jobsTable).values({
      id: jobId,
      tenantId,
      title,
      status: "active",
      description: "Isolated synthetic workflow fixture, not a real vacancy.",
      assignedRecruiterId: actorId,
      interviewPath: "human",
    });
    await dbAdmin
      .insert(applicationsTable)
      .values({ tenantId, jobId, candidateId, stage: "applied" });
    const scope: WorkflowScope = {
      tenantId,
      jobId,
      actorId,
      actorName: "Isolated offer reviewer",
      canApprove: true,
    };
    const brief = await readBrief(dbAdmin, scope);
    const steps = journeySteps("human").map((s) => ({
      ...s,
      status: "completed" as const,
      evidence: "Workflow-only synthetic fixture.",
      ...(s.key === "hiring_decision"
        ? {
            humanDecision: {
              outcome: "hire" as const,
              actorId,
              actorName: scope.actorName!,
              decidedAt: new Date().toISOString(),
              reason: "Workflow-only synthetic offer QA, not hiring evidence.",
              testOnly: true,
            },
          }
        : {}),
    }));
    await dbAdmin.insert(journeys).values({
      id: journeyId,
      tenantId,
      jobId,
      version: 1,
      status: "approved",
      briefHash: brief.hash,
      brief: brief.brief,
      interviewPath: "human",
      steps,
      createdById: actorId,
      approvedById: actorId,
      approvedAt: new Date(),
    });
    await dbAdmin.insert(workflows).values({
      id: workflowId,
      tenantId,
      jobId,
      candidateId,
      journeyId,
      journeyVersion: 1,
      status: "completed",
      interviewPath: "human",
      steps,
      createdById: actorId,
    });
    return { scope, jobId, workflowId };
  }
  const staff = await fixture("Controlled offer — staff QA");
  const recipient = await fixture("Controlled offer — recipient QA");
  let recipientPath = "";
  const visible = async (handle: typeof dbAdmin, id: string) =>
    (
      await handle
        .select({ id: candidatesTable.id })
        .from(candidatesTable)
        .where(and(eq(candidatesTable.id, id), eq(candidatesTable.tenantId, tenantId)))
    ).length === 1;
  for (const target of [recipient, ...(process.argv.includes("--decision") ? [staff] : [])]) {
    for (const action of ["save_draft", "submit_review", "approve", "send"] as const) {
      if (target === staff && action === "send") continue;
      const state = await readControlledOffer(target.scope, target.workflowId, visible);
      await controlControlledOffer(
        target.scope,
        target.workflowId,
        {
          action,
          expectedRevision: state.workflowRevision,
          idempotencyKey: randomUUID(),
          ...(action === "save_draft"
            ? {
                terms: {
                  employerName: "Fixture employer",
                  roleTitle: "Synthetic role",
                  amount: 100000,
                  currency: "USD",
                  frequency: "annual" as const,
                  location: "Remote",
                  startDate: "2027-01-15",
                  expiresAt: new Date(Date.now() + 86400000).toISOString(),
                  letter:
                    "Synthetic QA only. These are approved fixture terms, not a real employment offer.",
                },
              }
            : {}),
        },
        visible,
        {
          baseUrl: "https://fixture.invalid",
          send: async (input) => {
            recipientPath = input.text!.match(/(\/offer\/[a-f0-9]{64})/)![1];
            return { ok: true, messageId: "QA_FAKE_PROVIDER_ACCEPTED_NO_EMAIL" };
          },
        },
      );
    }
  }
  await writeFile(
    file,
    JSON.stringify({
      tenantId,
      jobIds,
      actorId,
      candidateId,
      staffWorkflowId: staff.workflowId,
      staffPath: `/jobs/${staff.jobId}`,
      recipientWorkflowId: recipient.workflowId,
      recipientStaffPath: `/jobs/${recipient.jobId}`,
      recipientPath,
      sessionToken: issueToken({ userId: actorId, tenantId, role: "tenant_admin" }),
    }),
    { mode: 0o600 },
  );
  process.stdout.write(
    "Isolated staff and recipient fixtures prepared. Zero real emails or provider calls.\n",
  );
}
await pool.end();
