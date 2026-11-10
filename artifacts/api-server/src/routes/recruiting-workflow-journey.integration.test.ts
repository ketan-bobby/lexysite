/**
 * Fictional source results, real HTTP authorization and workflow persistence.
 * Every table is private to this process; the egress preload denies providers.
 * This proves review/control plumbing, not live sourcing or identity verification.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import * as tables from "@workspace/db";
import type { JobWorkflowState } from "@workspace/api-zod";
import { createTransactionalDb } from "../test-fixtures/transactional-db";
import {
  checkWorkflowIsolation,
  type IsolationCase,
} from "../test-fixtures/workflow-isolation-checks";
import type { WorkflowActionContext } from "../lib/workflow-execution";

let fixture: Awaited<ReturnType<typeof createTransactionalDb>>;
let server: Server;
let base: string;
let issueToken: (typeof import("../lib/auth-token"))["issueToken"];
let execution: typeof import("../lib/workflow-execution");
let fingerprint: (typeof import("../lib/recruiting-workflows"))["fingerprint"];
const tenant = "fictional_workflow_tenant";
const originalNodeEnv = process.env.NODE_ENV;
const foreign = "fictional_foreign_tenant";
const actors = {
  admin: "tenant_admin",
  recruiter: "recruiter",
  hm: "hiring_manager",
  candidate: "candidate",
  outsider: "tenant_admin",
} as const;
type Actor = keyof typeof actors;
type Body = JobWorkflowState & { id: string; replayed: boolean; error: string };
type Workflow = JobWorkflowState["workflows"][number];
type Case = { jobId: string; candidateId: string; applicationId: string; workflowId: string };

before(async () => {
  process.env.NODE_ENV = "test";
  fixture = await createTransactionalDb([
    tables.tenantsTable,
    tables.usersTable,
    tables.jobsTable,
    tables.candidatesTable,
    tables.applicationsTable,
    tables.icpTable,
    tables.jobPipelinesTable,
    tables.jobRecruitersTable,
    tables.recruiterAdminClientsTable,
    tables.recruitingJourneysTable,
    tables.recruitingWorkflowsTable,
    tables.recruitingWorkflowEventsTable,
    tables.recruitingWorkflowReceiptsTable,
    tables.resumeScreensTable,
    tables.verificationRecordsTable,
    tables.sourcedCandidatesTable,
    tables.outreachMessagesTable,
    tables.outreachConversationDraftsTable,
    tables.outreachCampaignsTable,
    tables.outreachEnrollmentsTable,
    tables.outreachSequenceStepsTable,
    tables.outreachStepMessagesTable,
    tables.interviewPlansTable,
    tables.interviewSessionsTable,
    tables.interviewSummariesTable,
    tables.interviewSchedulesTable,
    tables.aiJobsTable,
    tables.candidateEventsTable,
    tables.auditLogsTable,
    tables.vendorUsageAttemptsTable,
    tables.tenantAiBrandProfilesTable,
    tables.tenantAiDocumentsTable,
    tables.workorderAiContextsTable,
    tables.workorderAiDocumentsTable,
  ]);
  await fixture.db
    .insert(tables.tenantsTable)
    .values([tenant, foreign].map((id) => ({ id, name: "Fictional fixture only", slug: id })));
  await fixture.db.insert(tables.usersTable).values(
    Object.entries(actors).map(([id, role]) => ({
      id,
      tenantId: id === "outsider" ? foreign : tenant,
      name: `Synthetic ${id}`,
      email: `${id}@example.invalid`,
      passwordHash: "unused-synthetic-password",
      role,
      status: "active" as const,
    })),
  );
  // Import consumers only after the private DB has replaced @workspace/db.
  const { default: router } = await import("./recruiting-workflows");
  const { default: outreachRouter } = await import("./outreach");
  ({ issueToken } = await import("../lib/auth-token"));
  execution = await import("../lib/workflow-execution");
  ({ fingerprint } = await import("../lib/recruiting-workflows"));
  const app = express();
  app.use(express.json());
  const { resolveUser, requireRole } = await import("../middlewares/resolveUser");
  app.get("/cleanup-auth/:jobId", resolveUser, requireRole("tenant_admin"), (req, res) => {
    const jobId: string = req.params.jobId;
    // @ts-expect-error Named parameters must not become wildcard arrays.
    const arrayId: string[] = req.params.jobId;
    void arrayId;
    res.json({ jobId, role: req.resolvedUser?.role });
  });
  app.use(router);
  app.use(outreachRouter);
  app.use((await import("./pipeline")).default);
  app.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
      res.status(500).json({ error: error.message }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});

test("cleanup: role middleware preserves named IDs and authoritative role checks", async () => {
  const url = `${base}/cleanup-auth/legacy-job`;
  assert.equal((await fetch(url)).status, 401);
  const adminToken = issueToken({ userId: "admin", role: "tenant_admin", tenantId: tenant });
  const allowed = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { jobId: "legacy-job", role: "tenant_admin" });
  const forgedRole = issueToken({ userId: "recruiter", role: "tenant_admin", tenantId: tenant });
  assert.equal(
    (await fetch(url, { headers: { Authorization: `Bearer ${forgedRole}` } })).status,
    403,
  );
  await fixture.db
    .update(tables.usersTable)
    .set({ status: "suspended" })
    .where(eq(tables.usersTable.id, "admin"));
  try {
    assert.equal(
      (await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } })).status,
      403,
    );
  } finally {
    await fixture.db
      .update(tables.usersTable)
      .set({ status: "active" })
      .where(eq(tables.usersTable.id, "admin"));
  }
});

test("cleanup: missing outreach subjects fail before transport without advancing enrollment", async () => {
  const c = await createCase();
  const campaignId = randomUUID();
  const enrollmentId = randomUUID();
  const messageId = randomUUID();
  await fixture.db.insert(tables.outreachCampaignsTable).values({
    id: campaignId,
    tenantId: tenant,
    jobId: c.jobId,
    name: "Private null-subject regression",
    status: "active",
  });
  await fixture.db.insert(tables.outreachEnrollmentsTable).values({
    id: enrollmentId,
    campaignId,
    tenantId: tenant,
    jobId: c.jobId,
    candidateId: c.candidateId,
    recipientEmail: "never-send@example.invalid",
    currentStep: 1,
  });
  await fixture.db.insert(tables.outreachStepMessagesTable).values({
    id: messageId,
    campaignId,
    enrollmentId,
    stepNumber: 2,
    toEmail: "never-send@example.invalid",
    subject: null,
    body: "Synthetic private regression only",
    status: "scheduled",
    scheduledFor: new Date(Date.now() - 1000),
  });
  const { sendScheduledMessages } = await import("../lib/outreach-engine");
  assert.deepEqual(await sendScheduledMessages(campaignId), { sent: 0, failed: 1 });
  const [saved] = await fixture.db
    .select()
    .from(tables.outreachStepMessagesTable)
    .where(eq(tables.outreachStepMessagesTable.id, messageId));
  assert.equal(saved.status, "failed");
  assert.equal(saved.failedReason, "Missing recipient or subject");
  assert.equal(saved.sentAt, null);
  const [enrollment] = await fixture.db
    .select()
    .from(tables.outreachEnrollmentsTable)
    .where(eq(tables.outreachEnrollmentsTable.id, enrollmentId));
  assert.equal(enrollment.currentStep, 1);
  const [campaign] = await fixture.db
    .select()
    .from(tables.outreachCampaignsTable)
    .where(eq(tables.outreachCampaignsTable.id, campaignId));
  assert.equal(campaign.sentCount, 0);
  // Retry only this known non-attempt fixture with malformed variants. A
  // provider-uncertain row is never reset by the application to obtain this.
  for (const fields of [
    { subject: "", toEmail: "never-send@example.invalid" },
    { subject: "   ", toEmail: "never-send@example.invalid" },
    { subject: "Valid synthetic subject", toEmail: "" },
    { subject: "Valid synthetic subject", toEmail: "   " },
  ]) {
    await fixture.db
      .update(tables.outreachStepMessagesTable)
      .set({ ...fields, status: "scheduled", failedReason: null })
      .where(eq(tables.outreachStepMessagesTable.id, messageId));
    assert.deepEqual(await sendScheduledMessages(campaignId), { sent: 0, failed: 1 });
    const [message] = await fixture.db
      .select()
      .from(tables.outreachStepMessagesTable)
      .where(eq(tables.outreachStepMessagesTable.id, messageId));
    assert.equal(message.status, "failed");
    assert.equal(message.sentAt, null);
    assert.equal(message.failedReason, "Missing recipient or subject");
    const [unchanged] = await fixture.db
      .select()
      .from(tables.outreachEnrollmentsTable)
      .where(eq(tables.outreachEnrollmentsTable.id, enrollmentId));
    assert.equal(unchanged.currentStep, 1);
  }
});

test("cleanup: approved draft audit retains approver identity with demo transport suppressed", async () => {
  const { DEMO_EMAIL_DOMAIN } = await import("../lib/demo-email");
  const draftId = randomUUID();
  await fixture.db.insert(tables.outreachConversationDraftsTable).values({
    id: draftId,
    tenantId: tenant,
    candidateEmail: `approval-fixture@${DEMO_EMAIL_DOMAIN}`,
    inboundBody: "Synthetic request",
    inboundReceivedAt: new Date(),
    subject: "Synthetic approved reply",
    body: "Private approval metadata regression",
    verdict: "needs_review",
    status: "pending",
  });
  const { approveAndSendDraft } = await import("../lib/agents/outreach-conversation");
  assert.equal((await approveAndSendDraft(draftId, "recruiter", tenant)).ok, true);
  let audit: typeof tables.auditLogsTable.$inferSelect | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await fixture.db
      .select()
      .from(tables.auditLogsTable)
      .where(
        and(
          eq(tables.auditLogsTable.tenantId, tenant),
          eq(tables.auditLogsTable.action, "email.suppressed_demo"),
        ),
      );
    audit = rows.find((row) => (row.metadata as { draftId?: string } | null)?.draftId === draftId);
    if (audit) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(audit, "suppressed transport must still retain its audit metadata");
  assert.equal((audit.metadata as { approverUserId?: string }).approverUserId, "recruiter");
  const [saved] = await fixture.db
    .select()
    .from(tables.outreachConversationDraftsTable)
    .where(eq(tables.outreachConversationDraftsTable.id, draftId));
  assert.equal(saved.sentBy, "recruiter");
});

async function identityResolutionCase(isolated = true) {
  const c = isolated ? await pilotCase() : await createCase();
  await screen(c);
  assert.equal((await review(c, "screening")).status, 200);
  const { persistWorkflowIdentityAdvice } = await import("../lib/workflow-identity-review");
  await persistWorkflowIdentityAdvice(c.candidateId, tenant, {
    linkedinMatch: "verified",
    resumeConsistency: "consistent",
    emailValidity: "valid",
    profileCompleteness: 95,
    overallScore: 95,
    riskFlags: [],
    verdict: "clear",
    notes: "Fictional AI advice only; this is not independent identity proof.",
  });
  return c;
}
async function identityInput(c: Case, decision = "internal_test") {
  const wf = await current(c);
  const source = wf.runtimeEvidence!.find((e) => e.sourceType === "identity_verification")!;
  assert.ok(source);
  return {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    recordId: source.sourceId,
    recordUpdatedAt: source.occurredAt,
    decision,
    evidence:
      "Private fixture review only: authorised synthetic staff inbox; no real identity claim.",
    acknowledge: true,
  };
}
const resolveIdentity = (c: Case, input: Record<string, unknown>, actor: Actor | null = "admin") =>
  post(c, `candidate-workflows/${c.workflowId}/identity-resolution`, input, actor);

async function portalRecipientCase(existing?: Case) {
  const c = existing ?? (await pilotCase());
  const userId = randomUUID();
  const email = `${userId}@example.invalid`;
  await fixture.db.insert(tables.usersTable).values({
    id: userId,
    email,
    tenantId: foreign,
    name: "Fictional portal inbox",
    role: "candidate",
    status: "active",
    passwordHash: "unused-synthetic-password",
  });
  await fixture.db
    .update(tables.candidatesTable)
    .set({ email })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  return { ...c, email, userId };
}
async function recipientInput(c: Case & { email: string }, action = "approve_recipient") {
  return {
    idempotencyKey: randomUUID(),
    expectedRevision: (await current(c)).revision,
    action,
    controlledEmail: c.email,
    acknowledgeTestRecipient: true,
  };
}
const recipientControl = (c: Case, body: unknown, actor: Actor | null = "admin") =>
  post(c, `candidate-workflows/${c.workflowId}/live-pilot`, body, actor);
async function recipientStatus(c: Case) {
  const [wf] = await fixture.db
    .select()
    .from(tables.recruitingWorkflowsTable)
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  return (await import("../lib/workflow-test-recipient")).readWorkflowTestRecipient(fixture.db, wf);
}

test("test recipient: explicit admin attestation is idempotent, changes no login role and grants no execution", async () => {
  const c = await portalRecipientCase();
  const input = await recipientInput(c);
  for (const actor of [null, "candidate", "recruiter", "outsider"] as const)
    assert.ok([401, 403, 404].includes((await recipientControl(c, input, actor)).status));
  assert.equal(
    (await recipientControl(c, { ...input, acknowledgeTestRecipient: false })).status,
    400,
  );
  assert.equal(
    (await recipientControl(c, { ...input, controlledEmail: "wrong@example.invalid" })).status,
    409,
  );
  assert.equal(
    (
      await recipientControl(c, {
        ...input,
        action: "activate",
        stepKey: "screening",
        acknowledgeUnknownCosts: true,
      })
    ).status,
    409,
  );
  const approved = await recipientControl(c, input);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const replay = await recipientControl(c, input);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const wf = await current(c);
  assert.equal(wf.livePilot?.testRecipient?.active, true);
  assert.equal(wf.livePilot?.active, false);
  assert.ok(wf.steps.every((s) => s.status === "pending"));
  const [user] = await fixture.db
    .select()
    .from(tables.usersTable)
    .where(eq(tables.usersTable.id, c.userId));
  assert.equal(user.role, "candidate");
  const [candidate] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.notEqual(candidate.verificationStatus, "verified");
  const { restrictToRealCandidates, preserveSyntheticFixture } =
    await import("../lib/synthetic-fixture-scope");
  await fixture.db
    .update(tables.candidatesTable)
    .set({
      verificationResult: preserveSyntheticFixture({ notes: "Advisory refresh only" }),
    })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal(
    (
      await fixture.db
        .select()
        .from(tables.candidatesTable)
        .where(
          and(
            eq(tables.candidatesTable.id, c.candidateId),
            restrictToRealCandidates(tables.candidatesTable.id),
          ),
        )
    ).length,
    0,
  );
  for (const table of [tables.outreachMessagesTable, tables.interviewPlansTable])
    assert.equal((await fixture.db.select().from(table).where(eq(table.jobId, c.jobId))).length, 0);
});

test("test recipient: revocation, expiry, recipient/account changes and pause invalidate authority", async () => {
  const c = await portalRecipientCase();
  assert.equal((await recipientControl(c, await recipientInput(c))).status, 200);
  const initial = await current(c);
  const activate = {
    idempotencyKey: randomUUID(),
    expectedRevision: initial.revision,
    action: "activate",
    stepKey: "screening",
    controlledEmail: c.email,
    acknowledgeUnknownCosts: true,
  };
  assert.equal((await recipientControl(c, activate)).status, 200);
  assert.equal((await current(c)).livePilot?.active, true);
  await fixture.db
    .update(tables.usersTable)
    .set({ status: "suspended" })
    .where(eq(tables.usersTable.id, c.userId));
  assert.equal((await recipientStatus(c)).active, false);
  assert.equal((await current(c)).livePilot?.active, false);
  await fixture.db
    .update(tables.usersTable)
    .set({ status: "active" })
    .where(eq(tables.usersTable.id, c.userId));
  await fixture.db
    .update(tables.candidatesTable)
    .set({ verificationStatus: "verified" })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal((await recipientStatus(c)).active, false);
  assert.equal((await recipientControl(c, await recipientInput(c))).status, 409);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ verificationStatus: "pending" })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  await fixture.db
    .update(tables.candidatesTable)
    .set({ email: "changed@example.invalid" })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal((await recipientStatus(c)).active, false);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ email: c.email, doNotContact: true })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal((await recipientStatus(c)).active, false);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ doNotContact: false, dataErasedAt: new Date() })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal((await recipientStatus(c)).active, false);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ dataErasedAt: null })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal(
    (
      await post(c, `candidate-workflows/${c.workflowId}/control`, {
        idempotencyKey: randomUUID(),
        expectedRevision: (await current(c)).revision,
        action: "pause",
      })
    ).status,
    200,
  );
  assert.equal((await recipientStatus(c)).active, false);
  assert.equal(
    (await recipientControl(c, await recipientInput(c, "revoke_recipient"))).status,
    200,
  );
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({ status: "ready" })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  assert.equal((await recipientStatus(c)).active, false);
  assert.equal((await current(c)).livePilot?.active, false);
  assert.equal((await recipientControl(c, await recipientInput(c))).status, 200);
  const [entry] = await fixture.db
    .select()
    .from(tables.recruitingWorkflowEventsTable)
    .where(
      and(
        eq(tables.recruitingWorkflowEventsTable.workflowId, c.workflowId),
        eq(tables.recruitingWorkflowEventsTable.action, "workflow.test_recipient"),
      ),
    )
    .orderBy(sql`${tables.recruitingWorkflowEventsTable.createdAt} DESC`)
    .limit(1);
  await fixture.db
    .update(tables.recruitingWorkflowEventsTable)
    .set({
      note: JSON.stringify({ ...JSON.parse(entry.note!), expiresAt: new Date(0).toISOString() }),
    })
    .where(eq(tables.recruitingWorkflowEventsTable.id, entry.id));
  assert.equal((await recipientStatus(c)).active, false);
  assert.equal((await current(c)).livePilot?.active, false);
});

test("test recipient: approval cannot transfer jobs and fails on brief changes, foreign approvers or corrupt authority", async () => {
  const c = await portalRecipientCase();
  assert.equal((await recipientControl(c, await recipientInput(c))).status, 200);
  const [entry] = await fixture.db
    .select()
    .from(tables.recruitingWorkflowEventsTable)
    .where(
      and(
        eq(tables.recruitingWorkflowEventsTable.workflowId, c.workflowId),
        eq(tables.recruitingWorkflowEventsTable.action, "workflow.test_recipient"),
      ),
    );
  const other = await portalRecipientCase();
  await fixture.db.insert(tables.recruitingWorkflowEventsTable).values({
    ...entry,
    id: randomUUID(),
    jobId: other.jobId,
    workflowId: other.workflowId,
  });
  assert.equal((await recipientStatus(other)).active, false);
  const [job] = await fixture.db
    .select()
    .from(tables.jobsTable)
    .where(eq(tables.jobsTable.id, c.jobId));
  await fixture.db
    .update(tables.jobsTable)
    .set({ description: "Materially changed brief" })
    .where(eq(tables.jobsTable.id, c.jobId));
  assert.equal((await recipientStatus(c)).active, false);
  await fixture.db
    .update(tables.jobsTable)
    .set({ description: job.description })
    .where(eq(tables.jobsTable.id, c.jobId));
  await fixture.db
    .update(tables.recruitingWorkflowEventsTable)
    .set({ actorId: "outsider" })
    .where(eq(tables.recruitingWorkflowEventsTable.id, entry.id));
  assert.equal((await recipientStatus(c)).active, false);
  await fixture.db
    .update(tables.recruitingWorkflowEventsTable)
    .set({ actorId: "admin", note: "corrupt permission" })
    .where(eq(tables.recruitingWorkflowEventsTable.id, entry.id));
  assert.equal((await recipientStatus(c)).active, false);
});

test("test recipient: synthetic identity remains pending and revocation blocks subsequent contact", async () => {
  const c = await portalRecipientCase(await identityResolutionCase());
  assert.equal((await recipientControl(c, await recipientInput(c))).status, 200);
  const identity = await identityInput(c);
  assert.equal((await resolveIdentity(c, identity)).status, 200);
  const input = {
    ...(await recipientInput(c)),
    action: "activate",
    stepKey: "engagement",
    acknowledgeUnknownCosts: true,
  };
  assert.equal((await recipientControl(c, input)).status, 200);
  assert.equal((await current(c)).livePilot?.active, true);
  const [record] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal(record.identityVerified, false);
  assert.equal(record.status, "pending");
  assert.equal(
    (
      await recipientControl(c, {
        ...(await recipientInput(c)),
        action: "activate",
        stepKey: "ai_interview",
        acknowledgeUnknownCosts: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (await recipientControl(c, await recipientInput(c, "revoke_recipient"))).status,
    200,
  );
  assert.equal((await current(c)).livePilot?.active, false);
  const [raw] = await fixture.db
    .select()
    .from(tables.recruitingWorkflowsTable)
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  assert.equal(
    await (
      await import("../lib/workflow-identity-resolution")
    ).hasWorkflowTestIdentityClearance(fixture.db, raw),
    false,
  );
});

test("identity resolution: synthetic clearance is atomic, idempotent and never changes global identity", async () => {
  const c = await identityResolutionCase();
  const [before] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  const input = await identityInput(c);
  const first = await resolveIdentity(c, input);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await resolveIdentity(c, input);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const [after] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.deepEqual(after, before);
  const [candidate] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal(candidate.verificationStatus, "pending");
  assert.equal((candidate.verificationResult as Record<string, unknown>).overallScore, null);
  assert.deepEqual((candidate.verificationResult as Record<string, unknown>).syntheticFixture, {
    kind: "staff_inbox",
    workflowId: c.workflowId,
  });
  const { restrictToRealCandidates } = await import("../lib/synthetic-fixture-scope");
  const reportable = await fixture.db
    .select({ id: tables.candidatesTable.id })
    .from(tables.candidatesTable)
    .where(
      and(
        eq(tables.candidatesTable.id, c.candidateId),
        restrictToRealCandidates(tables.candidatesTable.id),
      ),
    );
  assert.equal(reportable.length, 0, "test clearance cannot become real reporting evidence");
  const wf = await current(c);
  assert.equal(wf.revision, input.expectedRevision + 1);
  assert.equal(wf.steps[1].status, "completed");
  assert.match(wf.steps[1].evidence!, /Synthetic.*unverified/);
  assert.equal(wf.steps[2].status, "pending");
  const audits = await fixture.db
    .select()
    .from(tables.recruitingWorkflowEventsTable)
    .where(
      and(
        eq(tables.recruitingWorkflowEventsTable.workflowId, c.workflowId),
        eq(tables.recruitingWorkflowEventsTable.action, "workflow.identity_resolved"),
      ),
    );
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorId, "admin");
  assert.equal((await pilotControl(c, "activate", { stepKey: "engagement" })).status, 200);
  const messages = await fixture.db
    .select()
    .from(tables.outreachMessagesTable)
    .where(eq(tables.outreachMessagesTable.jobId, c.jobId));
  assert.equal(messages.length, 0);
});

test("identity resolution: canonical and historical synthetic classification cannot become real-person corroboration", async () => {
  const c = await identityResolutionCase();
  const [original] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, c.candidateId));
  await fixture.db
    .update(tables.candidatesTable)
    .set({
      verificationResult: {
        ...(original.verificationResult as Record<string, unknown>),
        syntheticFixture: { kind: "controlled_inbox", workflowId: c.workflowId },
      },
    })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  const before = await current(c);
  const rejected = await resolveIdentity(c, await identityInput(c, "corroborated"));
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
  assert.match(rejected.body.error, /synthetic fixture/i);
  assert.equal((await current(c)).revision, before.revision);
  const [record] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal(record.identityVerified, false);
  assert.equal(record.status, "pending");
  assert.equal(record.reviewedAt, null);

  // The permitted synthetic pilot still progresses, without claiming identity.
  const cleared = await resolveIdentity(c, await identityInput(c, "internal_test"));
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const clearedWorkflow = await current(c);
  assert.equal(clearedWorkflow.steps[1].status, "completed");

  // Private-table legacy simulation only: earlier fixtures can have the
  // structured clearance audit without a canonical marker. That classification
  // remains permanent even when identity review is revisited.
  await fixture.db
    .update(tables.candidatesTable)
    .set({ verificationResult: original.verificationResult })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({ steps: before.steps, revision: clearedWorkflow.revision + 1 })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  const legacyBefore = await current(c);
  const legacyRejected = await resolveIdentity(c, await identityInput(c, "corroborated"));
  assert.equal(legacyRejected.status, 409, JSON.stringify(legacyRejected.body));
  assert.match(legacyRejected.body.error, /synthetic fixture/i);
  assert.equal((await current(c)).revision, legacyBefore.revision);
  const [unchanged] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.id, record.id));
  assert.equal(unchanged.identityVerified, false);
  assert.equal(unchanged.status, "pending");
  assert.equal(unchanged.reviewedAt, null);
});

test("synthetic contact sequence: mocked transport still requires reviewed interest and separate invitation authority", async () => {
  const c = await identityResolutionCase();
  assert.equal((await resolveIdentity(c, await identityInput(c))).status, 200);
  assert.equal((await pilotControl(c, "activate", { stepKey: "engagement" })).status, 200);
  const { createWorkflowOutreachDraft } = await import("../lib/workflow-outreach");
  const context = await actionContext(c);
  context.input.stepKey = "engagement";
  let messageId = "";
  assert.equal(
    (
      await execution.executeWorkflowAction(context, {
        mode: "live",
        invoke: async () => {
          const message = await createWorkflowOutreachDraft(
            {
              jobId: c.jobId,
              tenantId: tenant,
              candidateId: c.candidateId,
              subject: "Private synthetic fixture",
              body: "No real email transport",
              status: "queued",
            },
            context,
          );
          messageId = message.id;
          assert.equal(message.status, "pending_approval");
          return message.id;
        },
      })
    ).state,
    "succeeded",
  );
  const send = await actionContext(c);
  send.input.stepKey = "engagement";
  send.input.actionKind = "outreach_send";
  assert.equal(
    (
      await execution.executeWorkflowAction(send, {
        mode: "live",
        // Transport is deliberately replaced by a private DB receipt. This proves
        // authority/order, not provider acceptance, delivery or real inbox interest.
        invoke: async () => {
          await fixture.db
            .update(tables.outreachMessagesTable)
            .set({ status: "sent", sentAt: new Date() })
            .where(eq(tables.outreachMessagesTable.id, messageId));
          return "Mock acceptance only";
        },
      })
    ).state,
    "succeeded",
  );
  assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 409);
  const [source] = await fixture.db
    .insert(tables.sourcedCandidatesTable)
    .values({
      tenantId: tenant,
      source: "internal",
      normalizedCandidateId: c.candidateId,
      rawData: {
        jobId: c.jobId,
        stage: "outreach_sent",
        screened: true,
        screeningResult: { recommendation: "advance", score: 85 },
      },
    })
    .returning();
  const reply = await request(`/jobs/${c.jobId}/pipeline/card-action`, {
    action: "log_reply",
    sourcedId: source.id,
    sentiment: "positive",
    replyBody: "Fictional Interested: private fixture only",
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(
    (reply.body as unknown as { interviewInvite: { deferred: boolean } }).interviewInvite.deferred,
    true,
  );
  assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 409);
  assert.equal((await review(c, "engagement")).status, 200);
  assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 200);
  const invitation = await actionContext(c);
  invitation.input.stepKey = "ai_interview";
  let attempts = 0;
  const invoke = async () => {
    attempts++;
    return "Mock invitation acceptance only";
  };
  assert.equal(
    (await execution.executeWorkflowAction(invitation, { mode: "live", invoke })).state,
    "succeeded",
  );
  assert.equal(
    (await execution.executeWorkflowAction(invitation, { mode: "live", invoke })).state,
    "already_claimed",
  );
  assert.equal(attempts, 1);
  const [identity] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  const [candidate] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal(identity.status, "pending");
  assert.equal(identity.identityVerified, false);
  assert.equal(candidate.verificationStatus, "pending");
  assert.equal(
    (
      await fixture.db
        .select()
        .from(tables.interviewSessionsTable)
        .where(eq(tables.interviewSessionsTable.candidateId, c.candidateId))
    ).length,
    0,
  );
});

test("identity resolution: corroboration preserves advice; unresolved keeps contact blocked", async () => {
  const c = await identityResolutionCase();
  assert.equal((await resolveIdentity(c, await identityInput(c, "unresolved"))).status, 200);
  assert.equal((await pilotControl(c, "activate", { stepKey: "engagement" })).status, 409);
  assert.equal((await current(c)).steps[1].status, "review_required");
  const [before] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, c.candidateId));
  const input = await identityInput(c, "corroborated");
  input.evidence =
    "Private test of a fictional human corroboration reference; never a live person.";
  const result = await resolveIdentity(c, input);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const [record] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal(record.status, "verified");
  assert.equal(record.identityVerified, true);
  assert.ok(record.reviewedAt);
  assert.match(record.reviewNotes!, /AI profile-consistency advice only/);
  assert.match(record.reviewNotes!, /Human corroborated review by admin/);
  assert.equal(record.riskScore, 50);
  const [after] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.deepEqual(
    (after.verificationResult as Record<string, unknown>).advisory,
    (before.verificationResult as Record<string, unknown>).advisory,
  );
  assert.equal((after.verificationResult as Record<string, unknown>).overallScore, null);
  assert.equal((await current(c)).steps[1].status, "completed");
});

test("identity resolution: auth, source ownership, consent and optimistic concurrency fail closed", async () => {
  const c = await identityResolutionCase();
  const input = await identityInput(c);
  assert.equal((await resolveIdentity(c, input, null)).status, 401);
  assert.equal((await resolveIdentity(c, input, "candidate")).status, 403);
  assert.equal((await resolveIdentity(c, input, "recruiter")).status, 403);
  assert.equal((await resolveIdentity(c, input, "outsider")).status, 404);
  assert.equal((await resolveIdentity(c, { ...input, acknowledge: false })).status, 400);
  assert.equal((await resolveIdentity(c, { ...input, evidence: " ".repeat(40) })).status, 400);
  assert.equal(
    (await resolveIdentity(c, { ...input, expectedRevision: input.expectedRevision - 1 })).status,
    409,
  );
  assert.equal(
    (await resolveIdentity(c, { ...input, recordUpdatedAt: "2000-01-01T00:00:00Z" })).status,
    409,
  );
  const other = await identityResolutionCase();
  assert.equal(
    (await resolveIdentity(c, { ...input, recordId: (await identityInput(other)).recordId }))
      .status,
    404,
  );
  assert.equal((await current(c)).revision, input.expectedRevision);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ doNotContact: true })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal((await resolveIdentity(c, input)).status, 404);
});

test("identity resolution: screening, approved brief, paused and staff-inbox restrictions are enforced", async () => {
  const ordinary = await identityResolutionCase(false);
  assert.equal((await resolveIdentity(ordinary, await identityInput(ordinary))).status, 409);
  const c = await identityResolutionCase();
  const input = await identityInput(c);
  const [wf] = await fixture.db
    .select()
    .from(tables.recruitingWorkflowsTable)
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({
      steps: wf.steps.map((s) =>
        s.key === "screening" ? { ...s, status: "pending" as const } : s,
      ),
    })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  assert.equal((await resolveIdentity(c, input)).status, 409);
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({ steps: wf.steps, status: "paused" })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  assert.equal((await resolveIdentity(c, input)).status, 409);
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({ status: "ready" })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  await fixture.db
    .update(tables.candidatesTable)
    .set({ email: "not-staff@example.invalid" })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal((await resolveIdentity(c, input)).status, 409);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ email: `${c.candidateId}@example.invalid` })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  await fixture.db
    .update(tables.jobsTable)
    .set({ title: "Ordinary non-pilot work order" })
    .where(eq(tables.jobsTable.id, c.jobId));
  assert.equal((await resolveIdentity(c, input)).status, 409);
  const [record] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.id, input.recordId));
  assert.equal(record.identityVerified, false);
});

test("identity resolution: test clearance cannot transfer or survive source and recipient drift", async () => {
  const c = await identityResolutionCase();
  const input = await identityInput(c);
  assert.equal((await resolveIdentity(c, input)).status, 200);
  const { hasWorkflowTestIdentityClearance } = await import("../lib/workflow-identity-resolution");
  const [wf] = await fixture.db
    .select()
    .from(tables.recruitingWorkflowsTable)
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  assert.equal(await hasWorkflowTestIdentityClearance(fixture.db as never, wf), true);
  assert.equal(
    await hasWorkflowTestIdentityClearance(fixture.db as never, { ...wf, id: randomUUID() }),
    false,
  );
  assert.equal(
    await hasWorkflowTestIdentityClearance(fixture.db as never, { ...wf, status: "paused" }),
    false,
  );
  await fixture.db
    .update(tables.usersTable)
    .set({ status: "suspended" })
    .where(eq(tables.usersTable.id, `pilotstaff-${c.candidateId}`));
  assert.equal(await hasWorkflowTestIdentityClearance(fixture.db as never, wf), false);
  await fixture.db
    .update(tables.usersTable)
    .set({ status: "active" })
    .where(eq(tables.usersTable.id, `pilotstaff-${c.candidateId}`));
  await fixture.db
    .update(tables.candidatesTable)
    .set({ email: "drift@example.invalid" })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  assert.equal(await hasWorkflowTestIdentityClearance(fixture.db as never, wf), false);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ email: `${c.candidateId}@example.invalid` })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  await fixture.db
    .update(tables.verificationRecordsTable)
    .set({ reviewNotes: "New unresolved concern" })
    .where(eq(tables.verificationRecordsTable.id, input.recordId));
  assert.equal(await hasWorkflowTestIdentityClearance(fixture.db as never, wf), false);
});

test("identity resolution: discovery visibility is not authority to write another tenant's identity", async () => {
  const c = await identityResolutionCase();
  const input = await identityInput(c, "corroborated");
  assert.equal((await current(c)).identityResolutionAllowed, true);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ tenantId: foreign })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  await fixture.db
    .update(tables.verificationRecordsTable)
    .set({ tenantId: foreign })
    .where(eq(tables.verificationRecordsTable.id, input.recordId));
  const { resolveWorkflowIdentity } = await import("../lib/workflow-identity-resolution");
  await assert.rejects(
    resolveWorkflowIdentity(
      {
        actorId: "admin",
        tenantId: tenant,
        jobId: c.jobId,
        canApprove: true,
      },
      c.workflowId,
      { ...input, decision: "corroborated", recordUpdatedAt: new Date(input.recordUpdatedAt) },
      async () => true,
    ),
    (error: unknown) => (error as { status: number }).status === 404,
  );
  const [record] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.id, input.recordId));
  assert.equal(record.identityVerified, false);
  assert.equal(record.status, "pending");
});

test("identity completion: manual notes and inconsistent verified labels cannot bypass corroboration", async () => {
  const c = await identityResolutionCase();
  const before = await current(c);
  const complete = () =>
    request(`/jobs/${c.jobId}/candidate-workflows/${c.workflowId}/evidence`, {
      idempotencyKey: randomUUID(),
      expectedRevision: before.revision,
      stepKey: "verification",
      status: "completed",
      evidence: "Fictional negative test: manual advice cannot independently corroborate identity.",
    });
  assert.equal((await complete()).status, 409);
  await fixture.db
    .update(tables.candidatesTable)
    .set({ verificationStatus: "verified" })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  await fixture.db
    .update(tables.verificationRecordsTable)
    .set({ status: "verified", identityVerified: false })
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal((await complete()).status, 409);
  const unchanged = await current(c);
  assert.equal(unchanged.revision, before.revision);
  assert.equal(unchanged.steps.find((step) => step.key === "verification")!.status, "pending");
  // Simulated already-corroborated source, not a real person's verification.
  await fixture.db
    .update(tables.verificationRecordsTable)
    .set({ identityVerified: true })
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal((await complete()).status, 200);
});

test("identity pilot needs separate approval after source-backed screening and never promotes AI clear to verified", async () => {
  const c = await pilotCase();
  assert.equal((await pilotControl(c, "activate", { stepKey: "verification" })).status, 409);
  const { ensureWorkflowProfileSource } = await import("../lib/workflow-profile-screening");
  const [profile] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, c.candidateId));
  const [sourceA, sourceB] = await Promise.all([
    ensureWorkflowProfileSource(tenant, c.jobId, profile),
    ensureWorkflowProfileSource(tenant, c.jobId, profile),
  ]);
  assert.equal(sourceA.id, sourceB.id);
  assert.equal((await current(c)).runtimeEvidence?.length, 0);
  assert.equal((await pilotControl(c, "activate")).status, 200);
  await screen(c);
  assert.equal((await review(c, "screening")).status, 200);
  let wf = await current(c);
  assert.equal(wf.livePilot?.stepKey, "verification");
  assert.equal(wf.livePilot?.active, false);
  assert.equal(wf.livePilot?.attempted, false);
  const context = await actionContext(c);
  context.input.stepKey = "verification";
  await assert.rejects(
    execution.executeWorkflowAction(context, {
      mode: "live",
      invoke: async () => assert.fail("Unapproved verification"),
    }),
    /approval|authority/,
  );
  assert.equal((await pilotControl(c, "activate", { stepKey: "verification" })).status, 200);
  const { persistWorkflowIdentityAdvice } = await import("../lib/workflow-identity-review");
  const { orchestrator: agent } = await import("../lib/agents/orchestrator");
  const internal = agent as unknown as {
    _runAgent: (id: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const original = internal._runAgent;
  try {
    internal._runAgent = async (id, input) => {
      assert.equal(id, "verification");
      assert.equal(input.candidateId, c.candidateId);
      return persistWorkflowIdentityAdvice(c.candidateId, tenant, {
        linkedinMatch: "verified",
        resumeConsistency: "consistent",
        emailValidity: "valid",
        profileCompleteness: 100,
        overallScore: 100,
        riskFlags: [],
        verdict: "clear",
        notes: "Synthetic model advice, not a queried identity source.",
      });
    };
    const bound = await actionContext(c);
    bound.input.stepKey = "verification";
    const input = { jobId: c.jobId, candidateId: c.candidateId };
    bound.input.payloadHash = fingerprint({ agentId: "verification", input });
    assert.equal(
      (await agent.triggerAgent("verification", input, "user", { workflow: bound })).status,
      "completed",
    );
  } finally {
    internal._runAgent = original;
  }
  const [record] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal(record.status, "pending");
  assert.equal(record.identityVerified, false);
  wf = await current(c);
  assert.equal(wf.livePilot?.attempted, true);
  assert.equal(wf.steps.find((s) => s.key === "verification")?.status, "pending");
  assert.equal(
    wf.runtimeEvidence?.find((e) => e.stepKey === "verification")?.readyForReview,
    false,
  );
  assert.notEqual((await review(c, "verification")).status, 200);
  assert.equal((await pilotControl(c, "activate", { stepKey: "verification" })).status, 409);
  await assert.rejects(persistWorkflowIdentityAdvice(c.candidateId, tenant, {}));
  await assert.rejects(
    persistWorkflowIdentityAdvice(c.candidateId, tenant, {
      linkedinMatch: "mismatch",
      resumeConsistency: "major_discrepancies",
      emailValidity: "suspicious",
      profileCompleteness: 10,
      overallScore: 10,
      riskFlags: ["Different synthetic advice"],
      verdict: "flag",
      notes: "Must not replace the existing pending record.",
    }),
    /must not be replaced/,
  );
  const [unchanged] = await fixture.db
    .select()
    .from(tables.verificationRecordsTable)
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal(unchanged.id, record.id);
  assert.equal(unchanged.status, "pending");
});

if (process.argv.includes("--live-screening-acceptance")) {
  test("one real native screening response in a private synthetic fixture", async (t) => {
    const c = await pilotCase();
    await fixture.db
      .update(tables.candidatesTable)
      .set({
        currentTitle: "Synthetic Backend Engineer",
        currentCompany: "Fictional Test Company",
        skills: ["TypeScript", "Node.js", "PostgreSQL", "REST APIs"],
      })
      .where(eq(tables.candidatesTable.id, c.candidateId));
    await fixture.db.insert(tables.sourcedCandidatesTable).values({
      tenantId: tenant,
      source: "internal",
      normalizedCandidateId: c.candidateId,
      rawData: { jobId: c.jobId, firstName: "Fictional", lastName: "Candidate", stage: "sourced" },
    });
    assert.equal((await pilotControl(c, "activate")).status, 200);
    const { withOneLiveScreeningRequest, liveScreeningRequestCount } =
      await import("../../../../scripts/live-screening-egress.mjs");
    const { orchestrator: agent } = await import("../lib/agents/orchestrator");
    const input = { jobId: c.jobId, candidateId: c.candidateId };
    const bound = await actionContext(c);
    bound.input.payloadHash = fingerprint({ agentId: "screening", input });
    const run = await withOneLiveScreeningRequest(() =>
      agent.triggerAgent("screening", input, "user", { workflow: bound }),
    );
    assert.equal(
      run.status,
      "completed",
      "Configured provider did not complete the claimed screening",
    );
    assert.equal(liveScreeningRequestCount(), 1);
    const wf = await current(c);
    const evidence = wf.runtimeEvidence?.find((e) => e.stepKey === "screening");
    assert.equal(wf.livePilot?.attempted, true);
    assert.equal(wf.steps[0].status, "pending");
    assert.equal(
      evidence?.readyForReview,
      true,
      "Real grade was not persisted as usable source evidence",
    );
    t.diagnostic(
      JSON.stringify({
        providerRequests: liveScreeningRequestCount(),
        screened: run.output?.screened,
        score: run.output?.screeningResults?.[0]?.score,
        recommendation: run.output?.screeningResults?.[0]?.recommendation,
        sourceReadyForReview: evidence?.readyForReview,
        workflowStepBeforeReview: wf.steps[0].status,
      }),
    );
    assert.equal((await review(c, "screening")).status, 200);
    assert.equal((await current(c)).livePilot?.stepKey, "verification");
  });
}

after(async () => {
  try {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    try {
      await fixture?.close();
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

async function request(path: string, body?: unknown, actor: Actor | null = "admin") {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(actor
        ? {
            Authorization: `Bearer ${issueToken({
              userId: actor,
              tenantId: actor === "outsider" ? foreign : tenant,
              role: actors[actor],
            })}`,
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Body };
}
const state = (c: Case, actor: Actor | null = "admin") =>
  request(`/jobs/${c.jobId}/workflow-state`, undefined, actor);
const post = (c: Case, suffix: string, body: unknown, actor: Actor | null = "admin") =>
  request(`/jobs/${c.jobId}/${suffix}`, body, actor);
async function current(c: Case): Promise<Workflow> {
  const result = await state(c);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.workflows.find((w) => w.id === c.workflowId)!;
}
async function createCase(owner: "admin" | "outsider" = "admin"): Promise<Case> {
  const caseTenant = owner === "outsider" ? foreign : tenant;
  const c = {
    jobId: randomUUID(),
    candidateId: randomUUID(),
    applicationId: randomUUID(),
    workflowId: "",
  };
  await fixture.db.insert(tables.candidatesTable).values({
    id: c.candidateId,
    tenantId: caseTenant,
    firstName: "Fictional",
    lastName: "Candidate",
    currentTitle: "Synthetic Software Engineer",
    skills: ["Synthetic fixture skill"],
    email: `${c.candidateId}@example.invalid`,
    pool: "tenant",
  });
  await fixture.db.insert(tables.jobsTable).values({
    id: c.jobId,
    tenantId: caseTenant,
    title: "Synthetic backend role — never contact",
    description: "Fictional fixture, not a live requisition",
    status: "active",
    assignedRecruiterId: owner === "admin" ? "recruiter" : owner,
    assignedHiringManagerId: owner === "admin" ? "hm" : owner,
    recruitingMode: "lexy_autonomous",
    interviewPath: "ai",
  });
  await fixture.db.insert(tables.applicationsTable).values({
    id: c.applicationId,
    tenantId: caseTenant,
    candidateId: c.candidateId,
    jobId: c.jobId,
    stage: "applied",
  });
  const hash = (await state(c, owner)).body.briefHash;
  const input = () => ({ idempotencyKey: randomUUID(), expectedBriefHash: hash });
  const drafted = await post(c, "workflow-journeys", input(), owner);
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  const approval = `workflow-journeys/${drafted.body.id}/approve`;
  if (owner === "admin") assert.equal((await post(c, approval, input(), "recruiter")).status, 403);
  assert.equal((await post(c, approval, input(), owner)).status, 200);
  const enrolled = await post(
    c,
    "candidate-workflows",
    {
      ...input(),
      journeyId: drafted.body.id,
      candidateId: c.candidateId,
    },
    owner,
  );
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  c.workflowId = enrolled.body.id;
  return c;
}

test("isolation matrix: six-stage reads and writes are customer and parent-job bound", async () => {
  const describe = async (owner: "admin" | "outsider"): Promise<IsolationCase> => {
    const c = await createCase(owner);
    const result = await state(c, owner);
    const wf = result.body.workflows.find((row) => row.id === c.workflowId)!;
    return {
      ...c,
      journeyId: wf.journeyId,
      revision: wf.revision,
      briefHash: result.body.briefHash,
      stepKeys: wf.steps.map((step) => step.key),
    };
  };
  const primary = await describe("admin");
  const sibling = await describe("admin");
  const other = await describe("outsider");
  const snapshot = async () => {
    const result: string[][] = [];
    // This fixture owns one pg connection; do not enqueue parallel queries.
    for (const table of [
      tables.jobsTable,
      tables.candidatesTable,
      tables.applicationsTable,
      tables.recruitingJourneysTable,
      tables.recruitingWorkflowsTable,
      tables.recruitingWorkflowEventsTable,
      tables.recruitingWorkflowReceiptsTable,
      tables.auditLogsTable,
      tables.aiJobsTable,
      tables.outreachMessagesTable,
      tables.interviewPlansTable,
      tables.interviewSessionsTable,
      tables.vendorUsageAttemptsTable,
    ]) {
      const rows = await fixture.db.select().from(table);
      result.push(rows.map((row) => JSON.stringify(row)).sort());
    }
    return result;
  };
  const result = await checkWorkflowIsolation({
    primary,
    sibling,
    foreign: other,
    request,
    snapshot,
  });
  assert.equal(result.stages, 6);
  assert.equal(result.denied, 95);
  for (const [actor, status] of [
    ["outsider", 404],
    ["candidate", 403],
  ] as const) {
    const response = await fetch(`${base}/jobs/${primary.jobId}/workflow-state`, {
      headers: {
        Authorization: `Bearer ${issueToken({
          userId: actor,
          tenantId: tenant,
          role: "platform_admin",
        })}`,
      },
    });
    assert.equal(response.status, status, "JWT role/tenant claims overrode the real account");
  }
});
async function review(
  c: Case,
  stepKey: string,
  status: "completed" | "review_required" = "completed",
  actor: Actor = "recruiter",
) {
  const wf = await current(c);
  const source = wf.runtimeEvidence?.find((e) => e.stepKey === stepKey);
  assert.ok(source, `Missing synthetic ${stepKey} source`);
  return post(
    c,
    `candidate-workflows/${c.workflowId}/evidence`,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: wf.revision,
      stepKey,
      status,
      runtimeEvidenceId: source.id,
      evidence: "Human fixture review of fictional source; not a real candidate assessment.",
    },
    actor,
  );
}
async function control(c: Case, action: "pause" | "resume" | "cancel") {
  return post(c, `candidate-workflows/${c.workflowId}/control`, {
    idempotencyKey: randomUUID(),
    expectedRevision: (await current(c)).revision,
    action,
  });
}
async function screen(c: Case) {
  await fixture.db.insert(tables.resumeScreensTable).values({
    tenantId: tenant,
    candidateId: c.candidateId,
    jobId: c.jobId,
    screeningScore: 88,
    recruiterSummary: "Synthetic résumé-screen result; no model was called.",
  });
}

test("fictional six-step HTTP journey respects source evidence and human authority", async (t) => {
  const c = await createCase();
  await t.test("starts pending and denies anonymous/foreign access", async () => {
    assert.equal((await state(c, null)).status, 401);
    assert.equal((await state(c, "outsider")).status, 404);
    const snapshot = (await state(c)).body;
    assert.equal(snapshot.autonomyExecutionEnabled, false);
    assert.equal(snapshot.workflows[0].steps.length, 6);
    assert.ok(snapshot.workflows[0].steps.every((s) => s.status === "pending"));
  });
  await t.test("screening needs a saved source and explicit review", async () => {
    assert.equal((await current(c)).runtimeEvidence?.length, 0);
    await screen(c);
    const wf = await current(c);
    assert.equal(wf.steps[0].status, "pending");
    assert.equal(wf.runtimeEvidence?.[0].readyForReview, true);
    assert.equal((await review(c, "screening")).status, 200);
  });
  await t.test("pending and flagged verification cannot silently pass", async () => {
    await fixture.db.insert(tables.verificationRecordsTable).values({
      tenantId: tenant,
      candidateId: c.candidateId,
      status: "pending",
      reviewNotes: "Synthetic profile requires human review",
    });
    const pending = (await current(c)).runtimeEvidence?.find((e) => e.stepKey === "verification");
    assert.equal(pending?.readyForReview, false);
    assert.equal(pending?.attentionRequired, true);
    assert.equal((await review(c, "verification")).status, 409);
    await fixture.db
      .update(tables.verificationRecordsTable)
      .set({ status: "flagged", updatedAt: new Date() })
      .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
    assert.equal((await review(c, "verification", "review_required")).status, 200);
    assert.equal((await current(c)).steps[1].status, "review_required");
    // A controlled stand-in for resolved evidence, not a live verification claim.
    await fixture.db
      .update(tables.verificationRecordsTable)
      .set({ status: "verified", identityVerified: true, updatedAt: new Date() })
      .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
    await fixture.db
      .update(tables.candidatesTable)
      .set({ verificationStatus: "verified" })
      .where(eq(tables.candidatesTable.id, c.candidateId));
    assert.equal((await review(c, "verification")).status, 200);
  });
  await t.test("sent mail alone is insufficient; a positive reply can be reviewed", async () => {
    const [message] = await fixture.db
      .insert(tables.outreachMessagesTable)
      .values({
        tenantId: tenant,
        jobId: c.jobId,
        candidateId: c.candidateId,
        subject: "Fictional message — never sent",
        body: "Synthetic delivery/reply records only",
        status: "sent",
        sentAt: new Date(),
      })
      .returning();
    assert.equal((await review(c, "engagement")).status, 409);
    await fixture.db
      .update(tables.outreachMessagesTable)
      .set({ status: "replied", repliedAt: new Date(), replySentiment: "positive" })
      .where(eq(tables.outreachMessagesTable.id, message.id));
    assert.equal((await review(c, "engagement")).status, 200);
  });
  await t.test("assessment stays pending and private answers stay private", async () => {
    const [plan] = await fixture.db
      .insert(tables.interviewPlansTable)
      .values({ tenantId: tenant, jobId: c.jobId, title: "Fictional interview" })
      .returning();
    const [session] = await fixture.db
      .insert(tables.interviewSessionsTable)
      .values({
        tenantId: tenant,
        applicationId: c.applicationId,
        candidateId: c.candidateId,
        planId: plan.id,
        status: "completed",
        completedAt: new Date(),
      })
      .returning();
    await fixture.db.insert(tables.interviewSummariesTable).values({
      interviewSessionId: session.id,
      overallScore: 82,
      recommendation: "yes",
      recruiterSummary: "Private synthetic assessment",
      transcript: [{ content: "PRIVATE_SYNTHETIC_ANSWER" }],
    });
    const wf = await current(c);
    assert.equal(wf.steps[3].status, "pending");
    assert.equal(
      wf.runtimeEvidence?.find((e) => e.stepKey === "ai_interview")?.readyForReview,
      true,
    );
    assert.ok(!JSON.stringify(wf).includes("PRIVATE_SYNTHETIC_ANSWER"));
    assert.equal((await review(c, "evaluation_review")).status, 409);
  });
  await t.test("pause blocks evidence; changed brief prevents resume", async () => {
    assert.equal((await control(c, "pause")).status, 200);
    assert.ok((await current(c)).runtimeEvidence?.every((e) => !e.readyForReview));
    assert.equal((await review(c, "ai_interview")).status, 409);
    await fixture.db
      .update(tables.jobsTable)
      .set({ title: "Changed fictional brief" })
      .where(eq(tables.jobsTable.id, c.jobId));
    assert.equal((await control(c, "resume")).status, 409);
    await fixture.db
      .update(tables.jobsTable)
      .set({ title: "Synthetic backend role — never contact" })
      .where(eq(tables.jobsTable.id, c.jobId));
    assert.equal((await control(c, "resume")).status, 200);
    assert.equal((await review(c, "ai_interview")).status, 200);
    assert.equal((await review(c, "evaluation_review")).status, 200);
  });
  await t.test("final decision is human-owned, retry-safe and stage-neutral", async () => {
    const wf = await current(c);
    const body = {
      idempotencyKey: randomUUID(),
      expectedRevision: wf.revision,
      stepKey: "hiring_decision",
      decision: "decline",
      status: "completed",
      evidence: "Fictional human decision for a disposable test only.",
    };
    const path = `candidate-workflows/${c.workflowId}/evidence`;
    assert.equal((await post(c, path, body, "recruiter")).status, 403);
    assert.equal((await post(c, path, body, "hm")).status, 200);
    const completed = await current(c);
    assert.equal(completed.status, "completed");
    const replay = await post(c, path, body, "hm");
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal((await current(c)).revision, completed.revision);
    const [application] = await fixture.db
      .select()
      .from(tables.applicationsTable)
      .where(eq(tables.applicationsTable.id, c.applicationId));
    assert.equal(application.stage, "applied");
  });
});

test("structured human decisions keep synthetic outcomes isolated and preserve Hold history", async () => {
  const early = await createCase();
  const tooEarly = await post(early, `candidate-workflows/${early.workflowId}/evidence`, {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    stepKey: "screening",
    status: "completed",
    decision: "hire",
    evidence: "An outcome must not be accepted on screening.",
  });
  assert.equal(tooEarly.status, 400);
  const c = await createCase();
  const original = await current(c);
  // Seed fictional prerequisites in this private schema; this is not a live assessment.
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({
      steps: original.steps.map((step) =>
        step.key === "hiring_decision"
          ? step
          : {
              ...step,
              status: "completed",
              evidence: "Private synthetic prerequisite fixture.",
            },
      ),
    })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  await fixture.db
    .update(tables.candidatesTable)
    .set({
      verificationResult: {
        syntheticFixture: { kind: "controlled_inbox", workflowId: c.workflowId },
      },
    })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  const path = `candidate-workflows/${c.workflowId}/evidence`;
  const hold = {
    idempotencyKey: randomUUID(),
    expectedRevision: 1,
    stepKey: "hiring_decision",
    decision: "hold",
    status: "review_required",
    evidence: "A synthetic review needs more evidence before a final decision.",
  };
  assert.equal((await post(c, path, hold, "recruiter")).status, 403);
  assert.equal((await post(c, path, { ...hold, testOnly: false }, "hm")).status, 400);
  assert.equal((await post(c, path, hold, "hm")).status, 200);
  assert.equal((await post(c, path, hold, "hm")).body.replayed, true);
  const held = await current(c);
  assert.equal(held.status, "ready");
  assert.equal(held.steps.at(-1)?.humanDecision?.testOnly, true);
  assert.equal(held.steps.at(-1)?.humanDecision?.outcome, "hold");
  assert.equal(held.steps.at(-1)?.humanDecision?.actorId, "hm");
  const decline = {
    ...hold,
    idempotencyKey: randomUUID(),
    expectedRevision: held.revision,
    decision: "decline",
    status: "completed",
    evidence: "The synthetic scenario ends here; this is not a real rejection.",
  };
  const responses = await Promise.all([post(c, path, decline, "hm"), post(c, path, decline, "hm")]);
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(responses.filter((r) => r.body.replayed).length, 1);
  const final = await current(c);
  assert.equal(final.status, "completed");
  assert.equal(final.revision, held.revision + 1);
  assert.equal(final.steps.at(-1)?.humanDecision?.outcome, "decline");
  assert.equal(final.steps.at(-1)?.humanDecision?.testOnly, true);
  assert.deepEqual(final.steps.at(-1)?.humanDecisionHistory, [held.steps.at(-1)?.humanDecision]);
  const [application] = await fixture.db
    .select()
    .from(tables.applicationsTable)
    .where(eq(tables.applicationsTable.id, c.applicationId));
  assert.equal(application.stage, "applied");
  assert.equal(application.finalDecision, null);
  assert.equal(
    (
      await fixture.db
        .select()
        .from(tables.outreachMessagesTable)
        .where(eq(tables.outreachMessagesTable.jobId, c.jobId))
    ).length,
    0,
  );
});

test("cancel retains accepted evidence and permanently blocks new work", async () => {
  const c = await createCase();
  await screen(c);
  assert.equal((await review(c, "screening")).status, 200);
  const evidence = (await current(c)).steps[0].evidence;
  assert.equal((await control(c, "cancel")).status, 200);
  const cancelled = await current(c);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.steps[0].evidence, evidence);
  assert.equal(cancelled.steps[0].status, "completed");
  assert.ok(cancelled.steps.slice(1).every((s) => s.status === "cancelled"));
  assert.equal((await control(c, "resume")).status, 409);
  assert.equal((await review(c, "screening")).status, 409);
});

test("fixture cannot touch shared data, and controls never enqueue provider work", async () => {
  await assert.rejects(
    () => fixture.db.execute(sql`SELECT count(*) FROM public.jobs`),
    (error: unknown) => error instanceof Error && /escape/.test(String(error.cause)),
  );
  const [{ count }] = await fixture.db
    .select({ count: sql<number>`count(*)::int` })
    .from(tables.aiJobsTable);
  assert.equal(count, 0);
});

test("recovery: trusted no-effect proof opens one generation and keeps the original claim", async () => {
  const { WorkflowPreEffectError } = await import("../lib/workflow-action-recovery");
  const c = await pilotCase();
  assert.equal((await pilotControl(c, "activate")).status, 200);
  const context = await actionContext(c);
  const failed = await execution.executeWorkflowAction(context, {
    mode: "controlled_test",
    invoke: async () => {
      throw new WorkflowPreEffectError("Fictional eligibility failed before external work.");
    },
  });
  assert.equal(failed.state, "no_effect");
  const wf = await current(c);
  assert.equal(wf.recovery?.available, true);
  const body = {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    attemptId: failed.attemptId,
    acknowledge: true,
  };
  for (const actor of [null, "candidate", "recruiter", "outsider"] as const) {
    assert.notEqual(
      (await post(c, `candidate-workflows/${c.workflowId}/recover`, body, actor)).status,
      200,
    );
  }
  assert.equal(
    (await post(c, `candidate-workflows/${c.workflowId}/recover`, { ...body, acknowledge: false }))
      .status,
    400,
  );
  assert.equal(
    (
      await post(c, `candidate-workflows/${c.workflowId}/recover`, {
        ...body,
        expectedRevision: wf.revision + 1,
      })
    ).status,
    409,
  );
  const recovered = await post(c, `candidate-workflows/${c.workflowId}/recover`, body);
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const replay = await post(c, `candidate-workflows/${c.workflowId}/recover`, body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const refreshed = await current(c);
  assert.equal(refreshed.revision, wf.revision + 1);
  assert.equal(refreshed.livePilot?.attempted, false);
  assert.equal(refreshed.livePilot?.active, false);
  assert.equal(refreshed.recovery?.available, false);
  assert.equal(refreshed.recovery?.authorized, true);
  let calls = 0;
  const second = await actionContext(c);
  const adapter = {
    mode: "controlled_test" as const,
    invoke: async () => {
      calls++;
      return {};
    },
  };
  const results = await Promise.all([
    execution.executeWorkflowAction(second, adapter),
    execution.executeWorkflowAction(
      { ...second, input: { ...second.input, idempotencyKey: randomUUID() } },
      adapter,
    ),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter((r) => r.state === "succeeded").length, 1);
  const claims = await fixture.db
    .select()
    .from(tables.recruitingWorkflowReceiptsTable)
    .where(
      and(
        eq(tables.recruitingWorkflowReceiptsTable.jobId, c.jobId),
        sql`${tables.recruitingWorkflowReceiptsTable.key} LIKE 'workflow-action:%'`,
      ),
    );
  assert.equal(claims.length, 2);
  assert.ok(claims.some((r) => r.resultId === failed.attemptId));
  assert.equal((await current(c)).recovery?.available, false);
});

test("recovery: unknown failures and timed-out work cannot be relabelled by a client", async () => {
  const c = await pilotCase();
  const context = await actionContext(c);
  const failed = await execution.executeWorkflowAction(context, {
    mode: "controlled_test",
    invoke: async () => {
      throw new Error("Ambiguous provider response");
    },
  });
  assert.equal(failed.state, "unknown");
  const wf = await current(c);
  assert.equal(wf.recovery?.available, false);
  const body = {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    attemptId: failed.attemptId,
    acknowledge: true,
  };
  assert.equal((await post(c, `candidate-workflows/${c.workflowId}/recover`, body)).status, 409);
  assert.equal(
    (await post(c, `candidate-workflows/${c.workflowId}/recover`, { ...body, noEffects: true }))
      .status,
    400,
  );
  const { WorkflowPreEffectError } = await import("../lib/workflow-action-recovery");
  const other = await pilotCase();
  const timed = await execution.executeWorkflowAction(await actionContext(other), {
    mode: "controlled_test",
    maxDurationMs: 2000,
    invoke: async () => {
      await new Promise((r) => setTimeout(r, 2500));
      throw new WorkflowPreEffectError("Too late to establish pre-effect proof");
    },
  });
  assert.equal(timed.state, "unknown");
  assert.equal((await current(other)).recovery?.available, false);
});

test("first-send usage: validated workflow labels reach the real persistence sink and never leak", async () => {
  const { vendorUsageScope, meteredFetch } = await import("../lib/vendor-usage");
  const { meterSesHandler } = await import("../lib/vendor-usage-ses");
  const cases = await Promise.all([contactCase(), contactCase()]);
  const contexts = await Promise.all(cases.map(actionContext));
  let requests = 0;
  const invoke = async () => {
    const handler = {
      handle: async (_request?: unknown) => {
        requests++;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { response: { statusCode: 200 } };
      },
    };
    // No sink override: this uses the production durable sink against fixture tables.
    meterSesHandler(handler as any);
    await handler.handle({
      headers: {},
      body: JSON.stringify({ Destination: { ToAddresses: ["never-sent@example.invalid"] } }),
    } as any);
    return { accepted: true };
  };
  const results = await Promise.all(
    contexts.map((context) =>
      execution.executeWorkflowAction(
        {
          ...context,
          input: { ...context.input, stepKey: "engagement", actionKind: "outreach_send" },
        },
        { mode: "controlled_test", invoke, isSuccessful: (result) => result.accepted },
      ),
    ),
  );
  assert.ok(results.every((result) => result.state === "succeeded"));
  assert.equal(requests, 2);
  assert.equal(vendorUsageScope.getStore(), undefined);
  for (const c of cases) {
    const rows = await fixture.db
      .select()
      .from(tables.vendorUsageAttemptsTable)
      .where(
        and(
          eq(tables.vendorUsageAttemptsTable.tenantId, tenant),
          eq(tables.vendorUsageAttemptsTable.area, `workflow:${c.workflowId}:engagement`),
        ),
      );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, "aws_ses");
    assert.equal(rows[0].status, "succeeded");
    assert.equal(rows[0].httpStatus, 200);
    assert.equal(rows[0].costStatus, "unknown");
    assert.equal(rows[0].units.observed_api_requests, 1);
    assert.ok(!JSON.stringify(rows).includes("never-sent@"));
  }
  await meteredFetch("ms_graph", async () => new Response(null, { status: 202 }))(
    "https://graph.example.invalid/v1.0/me/sendMail",
    { method: "POST" },
  );
  const [unbound] = await fixture.db
    .select()
    .from(tables.vendorUsageAttemptsTable)
    .where(eq(tables.vendorUsageAttemptsTable.provider, "ms_graph"));
  assert.equal(unbound.tenantId, null);
  assert.equal(unbound.area, "unattributed");
  await execution.executeWorkflowAction(
    {
      ...contexts[0],
      input: {
        ...contexts[0].input,
        stepKey: "engagement",
        actionKind: "outreach_send",
        idempotencyKey: randomUUID(),
      },
    },
    { mode: "controlled_test", invoke },
  );
  assert.equal(requests, 2);
});

test("workflow-owned legacy follow-ups are held before model calls, sends or invite-token rotation", async () => {
  const c = await contactCase();
  const context = await actionContext(c);
  context.input.stepKey = "engagement";
  const { createWorkflowOutreachDraft } = await import("../lib/workflow-outreach");
  await createWorkflowOutreachDraft(
    {
      tenantId: tenant,
      jobId: c.jobId,
      candidateId: c.candidateId,
      subject: "Synthetic contact ownership",
      body: "Never sent",
      status: "queued",
    },
    context,
  );
  const sourceId = randomUUID();
  await fixture.db.insert(tables.sourcedCandidatesTable).values({
    id: sourceId,
    tenantId: tenant,
    normalizedCandidateId: c.candidateId,
    source: "internal",
    rawData: { jobId: c.jobId },
  });
  const { hasBoundInvitationWorkflow, unownedWorkflowContactCondition } =
    await import("../lib/workflow-contact-gates");
  assert.equal(await hasBoundInvitationWorkflow(c.jobId, tenant, sourceId), true);
  assert.equal(await hasBoundInvitationWorkflow(c.jobId, foreign, sourceId), false);
  const unrelated = await createCase();
  assert.equal(
    await hasBoundInvitationWorkflow(unrelated.jobId, tenant, unrelated.candidateId),
    false,
  );
  const campaignId = randomUUID();
  await fixture.db.insert(tables.outreachCampaignsTable).values({
    id: campaignId,
    tenantId: tenant,
    jobId: c.jobId,
    name: "Synthetic held follow-up",
    status: "active",
  });
  await fixture.db.insert(tables.outreachSequenceStepsTable).values({
    campaignId,
    stepNumber: 2,
    subjectTemplate: "Never generated",
    bodyTemplate: "Never generated",
  });
  for (const candidateId of [c.candidateId, sourceId]) {
    const enrollmentId = randomUUID();
    await fixture.db.insert(tables.outreachEnrollmentsTable).values({
      id: enrollmentId,
      campaignId,
      tenantId: tenant,
      jobId: c.jobId,
      candidateId,
      recipientEmail: "never-sent@example.invalid",
      currentStep: 1,
    });
    const messageId = randomUUID();
    await fixture.db.insert(tables.outreachStepMessagesTable).values({
      id: messageId,
      campaignId,
      enrollmentId,
      stepNumber: 1,
      toEmail: "never-sent@example.invalid",
      status: "scheduled",
    });
  }
  const [plan] = await fixture.db
    .insert(tables.interviewPlansTable)
    .values({
      tenantId: tenant,
      jobId: c.jobId,
      title: "Synthetic held re-engagement",
    })
    .returning();
  const [session] = await fixture.db
    .insert(tables.interviewSessionsTable)
    .values({
      tenantId: tenant,
      candidateId: sourceId,
      planId: plan.id,
      applicationId: "pipeline",
      inviteToken: "unchanged-fixture-token",
      status: "invited",
    })
    .returning();
  const { sendScheduledMessages, generateMessages } = await import("../lib/outreach-engine");
  const { sendReEngagement } = await import("../lib/agents/interview-reply");
  for (const status of ["ready", "paused", "cancelled"] as const) {
    await fixture.db
      .update(tables.recruitingWorkflowsTable)
      .set({ status })
      .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
    const claims = await fixture.db
      .update(tables.interviewSessionsTable)
      .set({ inviteToken: "must-not-rotate" })
      .where(
        and(
          eq(tables.interviewSessionsTable.id, session.id),
          unownedWorkflowContactCondition(c.jobId, tenant, sourceId),
        ),
      )
      .returning();
    assert.equal(claims.length, 0);
    assert.deepEqual(await generateMessages(campaignId), []);
    await fixture.db
      .update(tables.outreachStepMessagesTable)
      .set({ status: "scheduled" })
      .where(eq(tables.outreachStepMessagesTable.campaignId, campaignId));
    assert.deepEqual(await sendScheduledMessages(campaignId), { sent: 0, failed: 0 });
    const held = await fixture.db
      .select()
      .from(tables.outreachStepMessagesTable)
      .where(eq(tables.outreachStepMessagesTable.campaignId, campaignId));
    assert.ok(
      held.every(
        (m) => m.status === "draft" && m.sentAt === null && m.failedReason?.startsWith("Held:"),
      ),
    );
    const result = await sendReEngagement(session.id);
    assert.equal(result.ok, false);
    assert.match(result.error!, /workflow-owned/);
    const [saved] = await fixture.db
      .select()
      .from(tables.interviewSessionsTable)
      .where(eq(tables.interviewSessionsTable.id, session.id));
    assert.equal(saved.inviteToken, session.inviteToken);
    assert.equal(saved.reEngagementSentAt, null);
  }
  const receipts = await fixture.db
    .select()
    .from(tables.vendorUsageAttemptsTable)
    .where(
      and(
        eq(tables.vendorUsageAttemptsTable.tenantId, tenant),
        sql`${tables.vendorUsageAttemptsTable.area} LIKE ${`workflow:${c.workflowId}:%`}`,
      ),
    );
  assert.equal(receipts.length, 0);
});

async function actionContext(c: Case): Promise<WorkflowActionContext> {
  const wf = await current(c);
  return {
    scope: { tenantId: tenant, jobId: c.jobId, actorId: "recruiter", canApprove: false },
    input: {
      workflowId: c.workflowId,
      candidateId: c.candidateId,
      journeyId: wf.journeyId,
      journeyVersion: wf.journeyVersion,
      expectedRevision: wf.revision,
      stepKey: "screening",
      actionKind: "agent",
      idempotencyKey: randomUUID(),
      payloadHash: fingerprint({ candidateId: c.candidateId, kind: "fixture" }),
    },
    candidateAllowed: async (tx, candidateId: string) => {
      const [application] = await tx
        .select()
        .from(tables.applicationsTable)
        .where(eq(tables.applicationsTable.id, c.applicationId));
      return application?.candidateId === candidateId && application.jobId === c.jobId;
    },
  };
}

async function engagementDraft() {
  const c = await createCase();
  const wf = await current(c);
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({
      steps: wf.steps.map((step, index) =>
        index < 2
          ? { ...step, status: "completed" as const, evidence: "Controlled prerequisite only" }
          : step,
      ),
    })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  const context = await actionContext(c);
  context.input.stepKey = "engagement";
  const { createWorkflowOutreachDraft } = await import("../lib/workflow-outreach");
  const message = await createWorkflowOutreachDraft(
    {
      jobId: c.jobId,
      tenantId: tenant,
      candidateId: c.candidateId,
      subject: "Fictional fixture — never send",
      body: "Controlled message, no real candidate",
      status: "queued",
      approvedBy: "admin",
      approvedAt: new Date(),
    },
    context,
  );
  return { c, context, message };
}

test("launch HTTP endpoint derives identity, checks controls and retains the live lock", async () => {
  const c = await createCase();
  const path = `candidate-workflows/${c.workflowId}/execute`;
  const body = { idempotencyKey: randomUUID(), expectedRevision: (await current(c)).revision };
  assert.equal((await request(`/jobs/${c.jobId}/${path}`, body, null)).status, 401);
  assert.equal((await post(c, path, body, "outsider")).status, 404);
  assert.equal((await post(c, path, { ...body, candidateId: randomUUID() })).status, 400);
  const ready = await post(c, path, body, "recruiter");
  assert.equal(ready.status, 409, JSON.stringify(ready.body));
  assert.match(ready.body.error, /locked/);
  assert.equal((await post(c, path, { ...body, expectedRevision: 999 })).status, 409);
  await control(c, "pause");
  const paused = await post(c, path, {
    ...body,
    expectedRevision: (await current(c)).revision,
  });
  assert.equal(paused.status, 409);
  assert.match(paused.body.error, /ready|paused/);
  await control(c, "cancel");
  assert.equal(
    (
      await post(c, path, {
        ...body,
        expectedRevision: (await current(c)).revision,
      })
    ).status,
    409,
  );
  const claims = await fixture.db
    .select()
    .from(tables.recruitingWorkflowReceiptsTable)
    .where(eq(tables.recruitingWorkflowReceiptsTable.jobId, c.jobId));
  assert.equal(claims.filter((row) => row.key.startsWith("workflow-action:")).length, 0);
});

test("draft binding persists atomically and forces fresh approval despite queued input", async () => {
  const { c, message } = await engagementDraft();
  assert.equal(message.status, "pending_approval");
  assert.equal(message.approvedBy, null);
  assert.equal(message.approvedAt, null);
  const bindings = await fixture.db
    .select()
    .from(tables.recruitingWorkflowEventsTable)
    .where(
      eq(tables.recruitingWorkflowEventsTable.action, `workflow.outreach_bound:${message.id}`),
    );
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].workflowId, c.workflowId);
  const { storedOutreachWorkflow } = await import("../lib/workflow-outreach");
  await assert.rejects(
    storedOutreachWorkflow(message.id, {
      body: message.body,
      subject: message.subject,
      candidateEmail: undefined,
    }),
    /explicit approval/,
  );
});

test("untagged approval dispatch recovers binding after Pause and Cancel", async () => {
  for (const action of ["pause", "cancel"] as const) {
    const { c, message } = await engagementDraft();
    await fixture.db
      .update(tables.outreachMessagesTable)
      .set({ approvedBy: "recruiter", approvedAt: new Date() })
      .where(eq(tables.outreachMessagesTable.id, message.id));
    await control(c, action);
    const { dispatchOutreachMessage } = await import("../lib/outreach-dispatch");
    await assert.rejects(
      dispatchOutreachMessage(
        message.id,
        message.body,
        message.subject,
        `${c.candidateId}@example.invalid`,
      ),
      /ready|paused|terminal|cancelled/,
    );
    const [saved] = await fixture.db
      .select()
      .from(tables.outreachMessagesTable)
      .where(eq(tables.outreachMessagesTable.id, message.id));
    assert.equal(saved.sentAt, null);
    assert.equal(saved.status, "pending_approval");
  }
});

test("real approval HTTP refusal releases its stamp so Resume does not strand the draft", async () => {
  const { c, message } = await engagementDraft();
  await control(c, "pause");
  const path = `/outreach/messages/${message.id}/approve`;
  const paused = await request(path, {}, "recruiter");
  assert.equal(paused.status, 409, JSON.stringify(paused.body));
  const [held] = await fixture.db
    .select()
    .from(tables.outreachMessagesTable)
    .where(eq(tables.outreachMessagesTable.id, message.id));
  assert.equal(held.approvedAt, null);
  assert.equal(held.approvedBy, null);
  await control(c, "resume");
  const retry = await request(path, {}, "recruiter");
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.match(retry.body.error, /locked/);
  const [saved] = await fixture.db
    .select()
    .from(tables.outreachMessagesTable)
    .where(eq(tables.outreachMessagesTable.id, message.id));
  assert.equal(saved.approvedAt, null);
  assert.equal(saved.sentAt, null);
});

test("bound rejection cannot regenerate through legacy prior-approval auto-send", async () => {
  const { c, message } = await engagementDraft();
  await fixture.db.insert(tables.outreachMessagesTable).values({
    jobId: c.jobId,
    candidateId: c.candidateId,
    tenantId: tenant,
    body: "Older controlled fixture",
    subject: "Never send",
    approvedBy: "recruiter",
    approvedAt: new Date(),
    status: "sent",
  });
  const result = await request(
    `/outreach/messages/${message.id}/reject`,
    {
      reason: "Fictional feedback, not real delivery",
    },
    "recruiter",
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((result.body as unknown as { regenerated: unknown }).regenerated, null);
  const rows = await fixture.db
    .select()
    .from(tables.outreachMessagesTable)
    .where(eq(tables.outreachMessagesTable.jobId, c.jobId));
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === message.id)?.status, "rejected");
});

test("concurrent bound approvals never report successful delivery while execution is locked", async () => {
  const { message } = await engagementDraft();
  const results = await Promise.all(
    [1, 2].map(() => request(`/outreach/messages/${message.id}/approve`, {}, "recruiter")),
  );
  assert.ok(
    results.every((result) => result.status === 409),
    JSON.stringify(results),
  );
  const [saved] = await fixture.db
    .select()
    .from(tables.outreachMessagesTable)
    .where(eq(tables.outreachMessagesTable.id, message.id));
  assert.equal(saved.status, "pending_approval");
  assert.equal(saved.approvedAt, null);
  assert.equal(saved.sentAt, null);
});

test("sourced identity bindings are checked and unrelated legacy drafts stay unbound", async () => {
  const { c, context, message } = await engagementDraft();
  const { createWorkflowOutreachDraft, storedOutreachWorkflow } =
    await import("../lib/workflow-outreach");
  const before = await fixture.db.select().from(tables.outreachMessagesTable);
  await assert.rejects(
    createWorkflowOutreachDraft(
      {
        jobId: c.jobId,
        tenantId: tenant,
        candidateId: randomUUID(),
        subject: "Never send",
        body: "Mismatched fixture",
      },
      context,
    ),
    /identity/,
  );
  assert.equal(
    (await fixture.db.select().from(tables.outreachMessagesTable)).length,
    before.length,
  );
  const [source] = await fixture.db
    .insert(tables.sourcedCandidatesTable)
    .values({
      tenantId: tenant,
      source: "manual",
      normalizedCandidateId: c.candidateId,
      rawData: { firstName: "Fictional", lastName: "Source" },
    })
    .returning();
  const draft = await createWorkflowOutreachDraft(
    {
      jobId: c.jobId,
      tenantId: tenant,
      candidateId: source.id,
      subject: "Never send",
      body: "Source-bound controlled fixture",
    },
    context,
  );
  const restored = await storedOutreachWorkflow(
    draft.id,
    {
      body: draft.body,
      subject: draft.subject,
      candidateEmail: undefined,
    },
    "recruiter",
  );
  assert.equal(restored?.input.candidateId, c.candidateId);
  const legacy = await createWorkflowOutreachDraft({
    jobId: c.jobId,
    tenantId: tenant,
    candidateId: c.candidateId,
    subject: message.subject,
    body: message.body,
  });
  assert.equal(
    await storedOutreachWorkflow(legacy.id, {
      body: legacy.body,
      subject: legacy.subject,
      candidateEmail: undefined,
    }),
    undefined,
  );
});

test("workflow-bound execution rechecks Pause/Cancel after preparation", async () => {
  for (const action of ["pause", "cancel"] as const) {
    const c = await createCase();
    let invoked = false;
    const context = await actionContext(c);
    await assert.rejects(
      execution.executeWorkflowAction(context, {
        mode: "controlled_test",
        prepare: async () => {
          assert.equal((await control(c, action)).status, 200);
        },
        invoke: async () => {
          invoked = true;
        },
      }),
      /paused|cancelled/,
    );
    assert.equal(invoked, false);
    const [receipt] = await fixture.db
      .select()
      .from(tables.recruitingWorkflowReceiptsTable)
      .where(eq(tables.recruitingWorkflowReceiptsTable.resultId, c.workflowId));
    assert.ok(receipt); // Enrollment/control receipts exist, no effect was required.
  }
});

async function pilotCase() {
  const c = await createCase();
  await fixture.db
    .update(tables.jobsTable)
    .set({ title: "[AUTONOMY PILOT] Fictional profile screening" })
    .where(eq(tables.jobsTable.id, c.jobId));
  await fixture.db.insert(tables.usersTable).values({
    id: `pilotstaff-${c.candidateId}`,
    email: `${c.candidateId}@example.invalid`,
    tenantId: tenant,
    name: "Fictional internal tester",
    role: "recruiter",
    status: "active",
    passwordHash: "unused-fixture-password",
  });
  // Brief changed: create and approve a new snapshot, then explicitly enroll it.
  const drafted = await post(c, "workflow-journeys", {
    expectedBriefHash: (await state(c)).body.briefHash,
    idempotencyKey: randomUUID(),
  });
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  const approved = await post(c, `workflow-journeys/${drafted.body.id}/approve`, {
    expectedBriefHash: (await state(c)).body.briefHash,
    idempotencyKey: randomUUID(),
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  await control(c, "cancel");
  const enrolled = await post(c, "candidate-workflows", {
    expectedBriefHash: (await state(c)).body.briefHash,
    idempotencyKey: randomUUID(),
    journeyId: drafted.body.id,
    candidateId: c.candidateId,
  });
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  c.workflowId = enrolled.body.id;
  return c;
}

async function pilotControl(
  c: Case,
  action: "activate" | "revoke",
  extra = {},
  actor: Actor = "admin",
) {
  return post(
    c,
    `candidate-workflows/${c.workflowId}/live-pilot`,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: (await current(c)).revision,
      action,
      ...(action === "activate"
        ? { controlledEmail: `${c.candidateId}@example.invalid`, acknowledgeUnknownCosts: true }
        : {}),
      ...extra,
    },
    actor,
  );
}

async function contactCase() {
  const c = await pilotCase();
  const wf = await current(c);
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({
      steps: wf.steps.map((step, index) =>
        index < 2
          ? { ...step, status: "completed" as const, evidence: "Private fixture human review only" }
          : step,
      ),
    })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  await fixture.db.insert(tables.verificationRecordsTable).values({
    tenantId: tenant,
    candidateId: c.candidateId,
    status: "verified",
    identityVerified: true,
    reviewedAt: new Date(),
    reviewNotes: "Fictional corroboration fixture, not real identity proof",
  });
  return c;
}

async function followUpCase() {
  const c = await contactCase();
  const wf = await current(c);
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({
      steps: wf.steps.map((s, index) =>
        index < 3
          ? { ...s, status: "completed" as const, evidence: "Fictional reviewed engagement only" }
          : s,
      ),
    })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  return c;
}
const followUpPath = (c: Case) => `/jobs/${c.jobId}/candidate-workflows/${c.workflowId}/follow-ups`;
async function followUpInput(c: Case, extra: Record<string, unknown> = {}) {
  return {
    action: "draft",
    expectedRevision: (await current(c)).revision,
    idempotencyKey: randomUUID(),
    subject: "Private fixture check-in",
    body: "Fictional check-in. No provider is contacted.",
    scheduledAt: new Date(Date.now() - 10_000).toISOString(),
    ...extra,
  };
}

test("follow-ups: scoped HTTP review, exact snapshots, edits revoke approval, and persisted reload", async () => {
  const c = await followUpCase();
  const path = followUpPath(c);
  for (const actor of [null, "candidate", "outsider"] as const)
    assert.notEqual((await request(path, undefined, actor)).status, 200);
  assert.equal(
    (
      await request(
        path,
        await followUpInput(c, { body: "Visit https://example.invalid/interviews/fake" }),
      )
    ).status,
    400,
  );
  const input = await followUpInput(c);
  const draft = await request(path, input);
  assert.equal(draft.status, 200, draft.body.error);
  assert.equal((await request(path, input)).body.id, draft.body.id);
  const get = async () => {
    const response = await request(path);
    assert.equal(response.status, 200, response.body.error);
    return (
      response.body as unknown as {
        followUps: {
          id: string;
          version: number;
          status: string;
          body: string;
          recipient: string;
        }[];
      }
    ).followUps;
  };
  assert.equal((await get()).length, 1);
  let value = (await get())[0];
  assert.equal(value.body, input.body);
  const approve = await followUpInput(c, {
    action: "approve",
    id: value.id,
    expectedVersion: value.version,
    acknowledgeUnknownCost: true,
  });
  // Remove draft-only fields; approval reviews the saved snapshot, not input text.
  delete (approve as Record<string, unknown>).subject;
  delete (approve as Record<string, unknown>).body;
  delete (approve as Record<string, unknown>).scheduledAt;
  assert.equal((await request(path, { ...approve, acknowledgeUnknownCost: false })).status, 409);
  assert.equal((await request(path, approve, "recruiter")).status, 403);
  assert.equal((await request(path, approve)).status, 200);
  value = (await get())[0];
  assert.equal(value.status, "approved");
  assert.equal(
    (
      await request(
        path,
        await followUpInput(c, {
          id: value.id,
          expectedVersion: value.version,
          body: "Changed exact text; approval must be removed.",
        }),
      )
    ).status,
    200,
  );
  const edited = (await get())[0];
  assert.equal(edited.status, "draft");
  assert.equal(edited.version, value.version + 1);
  assert.equal((await request(path, { ...approve, idempotencyKey: randomUUID() })).status, 409);
  const cancelled = await request(path, {
    action: "cancel",
    id: edited.id,
    expectedVersion: edited.version,
    expectedRevision: (await current(c)).revision,
    idempotencyKey: randomUUID(),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await get())[0].status, "cancelled");
});

test("follow-ups: durable single claim, concurrent workers, usage scope, unknown outcomes and no retry", async () => {
  const { dispatchWorkflowFollowUp } = await import("../lib/workflow-follow-ups");
  const { vendorUsageScope } = await import("../lib/vendor-usage");
  const c = await followUpCase();
  const scope = { tenantId: tenant, jobId: c.jobId, actorId: "admin", canApprove: true };
  const path = followUpPath(c);
  const makeApproved = async () => {
    const draft = await request(path, await followUpInput(c));
    assert.equal(draft.status, 200, draft.body.error);
    const result = await request(path, {
      action: "approve",
      id: draft.body.id,
      expectedVersion: 1,
      acknowledgeUnknownCost: true,
      expectedRevision: (await current(c)).revision,
      idempotencyKey: randomUUID(),
    });
    assert.equal(result.status, 200, result.body.error);
    return {
      action: "send" as const,
      id: draft.body.id,
      expectedVersion: 2,
      expectedRevision: (await current(c)).revision,
      idempotencyKey: randomUUID(),
    };
  };
  let sends = 0;
  const input = await makeApproved();
  const transport = async () => {
    sends++;
    assert.deepEqual(vendorUsageScope.getStore(), {
      tenantId: tenant,
      area: `workflow:${c.workflowId}:engagement`,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { ok: true, simulated: false, messageId: "synthetic-only" };
  };
  const results = await Promise.all([
    dispatchWorkflowFollowUp(scope, c.workflowId, input, transport),
    dispatchWorkflowFollowUp(
      scope,
      c.workflowId,
      { ...input, idempotencyKey: randomUUID() },
      transport,
    ),
  ]);
  assert.equal(sends, 1);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  assert.equal(vendorUsageScope.getStore(), undefined);
  const snapshot = await request(path);
  assert.equal(
    (snapshot.body as unknown as { followUps: { status: string }[] }).followUps[0].status,
    "sent",
  );
  const failed = await makeApproved();
  await dispatchWorkflowFollowUp(scope, c.workflowId, failed, async () => {
    sends++;
    throw new Error("Synthetic ambiguous transport outcome");
  });
  await dispatchWorkflowFollowUp(scope, c.workflowId, failed, transport);
  assert.equal(sends, 2);
  const unknown = await request(path);
  assert.ok(
    (unknown.body as unknown as { followUps: { status: string }[] }).followUps.some(
      (v) => v.status === "unknown",
    ),
  );
  assert.equal((await request(path, await followUpInput(c))).status, 409);
});

test("follow-ups: paused/cancelled, stale revision, recipient drift, erasure, identity and uncertain original actions fail before transport", async () => {
  const { dispatchWorkflowFollowUp } = await import("../lib/workflow-follow-ups");
  for (const gate of [
    "paused",
    "cancelled",
    "revision",
    "recipient",
    "erasure",
    "dnc",
    "identity",
    "original_unknown",
    "disabled",
  ] as const) {
    const c = await followUpCase();
    const path = followUpPath(c);
    const draft = await request(path, await followUpInput(c));
    assert.equal(draft.status, 200, draft.body.error);
    const revision = (await current(c)).revision;
    assert.equal(
      (
        await request(path, {
          action: "approve",
          id: draft.body.id,
          expectedVersion: 1,
          acknowledgeUnknownCost: true,
          expectedRevision: revision,
          idempotencyKey: randomUUID(),
        })
      ).status,
      200,
    );
    if (gate === "paused" || gate === "cancelled" || gate === "revision")
      await fixture.db
        .update(tables.recruitingWorkflowsTable)
        .set(gate === "revision" ? { revision: revision + 1 } : { status: gate })
        .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
    if (gate === "recipient" || gate === "erasure" || gate === "dnc")
      await fixture.db
        .update(tables.candidatesTable)
        .set(
          gate === "recipient"
            ? { email: "changed@example.invalid" }
            : gate === "dnc"
              ? { doNotContact: true }
              : { dataErasedAt: new Date() },
        )
        .where(eq(tables.candidatesTable.id, c.candidateId));
    if (gate === "identity")
      await fixture.db
        .update(tables.verificationRecordsTable)
        .set({ status: "pending", identityVerified: false })
        .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
    if (gate === "original_unknown")
      await fixture.db.insert(tables.recruitingWorkflowEventsTable).values({
        tenantId: tenant,
        jobId: c.jobId,
        workflowId: c.workflowId,
        actorId: "admin",
        action: "workflow.execution_claimed",
        note: `ai_interview: action ${randomUUID()} claimed. Outcome is not known.`,
      });
    if (gate === "disabled")
      await fixture.db
        .insert(tables.tenantAiBrandProfilesTable)
        .values({ tenantId: tenant, aiMessagingEnabled: false });
    let calls = 0;
    await assert.rejects(
      dispatchWorkflowFollowUp(
        { tenantId: tenant, jobId: c.jobId, actorId: "admin", canApprove: true },
        c.workflowId,
        {
          action: "send",
          id: draft.body.id,
          expectedVersion: 2,
          expectedRevision: revision,
          idempotencyKey: randomUUID(),
        },
        async () => {
          calls++;
          return { ok: true };
        },
      ),
    );
    assert.equal(calls, 0, gate);
    if (gate === "disabled")
      await fixture.db
        .delete(tables.tenantAiBrandProfilesTable)
        .where(eq(tables.tenantAiBrandProfilesTable.tenantId, tenant));
  }
});

test("follow-ups: scheduler respects future schedules and sends a current due approval once", async () => {
  const { dispatchDueWorkflowFollowUps, dispatchWorkflowFollowUp } =
    await import("../lib/workflow-follow-ups");
  const c = await followUpCase();
  const path = followUpPath(c);
  const draft = await request(
    path,
    await followUpInput(c, { scheduledAt: new Date(Date.now() + 3600_000).toISOString() }),
  );
  assert.equal(draft.status, 200, draft.body.error);
  const approve = async (version: number) =>
    request(path, {
      action: "approve",
      id: draft.body.id,
      expectedVersion: version,
      acknowledgeUnknownCost: true,
      expectedRevision: (await current(c)).revision,
      idempotencyKey: randomUUID(),
    });
  assert.equal((await approve(1)).status, 200);
  let calls = 0;
  const transport = async (value: { id: string }) => {
    if (value.id === draft.body.id) calls++;
    return { ok: true, simulated: false };
  };
  await assert.rejects(
    dispatchWorkflowFollowUp(
      { tenantId: tenant, jobId: c.jobId, actorId: "admin", canApprove: true },
      c.workflowId,
      {
        action: "send",
        id: draft.body.id,
        expectedVersion: 2,
        expectedRevision: (await current(c)).revision,
        idempotencyKey: randomUUID(),
      },
      transport,
    ),
    /not due/,
  );
  await dispatchDueWorkflowFollowUps(transport);
  assert.equal(calls, 0);
  assert.equal(
    (await request(path, await followUpInput(c, { id: draft.body.id, expectedVersion: 2 }))).status,
    200,
  );
  assert.equal((await approve(3)).status, 200);
  await dispatchDueWorkflowFollowUps(transport);
  await dispatchDueWorkflowFollowUps(transport);
  assert.equal(calls, 1);
  assert.equal(
    (
      await request(path).then(
        (r) => (r.body as unknown as { followUps: { status: string }[] }).followUps,
      )
    )[0].status,
    "sent",
  );
});

test("contact pilots require resolved identity, separate authority, and one draft plus one first send", async () => {
  const c = await contactCase();
  await fixture.db
    .update(tables.verificationRecordsTable)
    .set({ status: "pending", identityVerified: false })
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal((await pilotControl(c, "activate", { stepKey: "engagement" })).status, 409);
  await fixture.db
    .update(tables.verificationRecordsTable)
    .set({ status: "verified", identityVerified: true })
    .where(eq(tables.verificationRecordsTable.candidateId, c.candidateId));
  assert.equal((await pilotControl(c, "activate", { stepKey: "engagement" })).status, 200);
  const context = await actionContext(c);
  context.input.stepKey = "engagement";
  let drafts = 0,
    sends = 0;
  assert.equal(
    (
      await execution.executeWorkflowAction(context, {
        mode: "live",
        invoke: async () => {
          drafts++;
          return "held";
        },
      })
    ).state,
    "succeeded",
  );
  // Fresh authority may extend the send window, never authorize a second draft.
  assert.equal((await pilotControl(c, "revoke")).status, 200);
  assert.equal((await pilotControl(c, "activate", { stepKey: "engagement" })).status, 200);
  context.input.expectedRevision = (await current(c)).revision;
  await assert.rejects(
    execution.executeWorkflowAction(context, {
      mode: "live",
      invoke: async () => {
        drafts++;
      },
    }),
    /Idempotency key was already used/,
  );
  context.input.actionKind = "outreach_send";
  assert.equal(
    (
      await execution.executeWorkflowAction(context, {
        mode: "live",
        invoke: async () => {
          sends++;
          return "mock acceptance, no transport";
        },
      })
    ).state,
    "succeeded",
  );
  assert.equal(
    (
      await execution.executeWorkflowAction(context, {
        mode: "live",
        invoke: async () => {
          sends++;
        },
      })
    ).state,
    "already_claimed",
  );
  assert.equal(drafts, 1);
  assert.equal(sends, 1);
  assert.equal((await current(c)).livePilot?.sendAttempted, true);
  assert.equal((await pilotControl(c, "activate", { stepKey: "engagement" })).status, 409);
});

test("invitation authority rejects manual completion, unbound, unsent, negative and out-of-order replies", async () => {
  const c = await contactCase();
  const context = await actionContext(c);
  context.input.stepKey = "engagement";
  const { createWorkflowOutreachDraft } = await import("../lib/workflow-outreach");
  const message = await createWorkflowOutreachDraft(
    {
      tenantId: tenant,
      jobId: c.jobId,
      candidateId: c.candidateId,
      subject: "Private fictional fixture",
      body: "No email sent",
      status: "queued",
    },
    context,
  );
  const wf = await current(c);
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({
      steps: wf.steps.map((step, i) =>
        i === 2
          ? {
              ...step,
              status: "completed" as const,
              evidence: "Manual note cannot invent positive interest",
            }
          : step,
      ),
    })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 409);
  const sent = new Date();
  await fixture.db.insert(tables.outreachMessagesTable).values({
    tenantId: tenant,
    jobId: c.jobId,
    candidateId: c.candidateId,
    subject: "Unbound fictional reply",
    body: "Not workflow authority",
    status: "replied",
    sentAt: sent,
    repliedAt: sent,
    replySentiment: "positive",
  });
  assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 409);
  for (const patch of [
    { status: "sent", sentAt: sent, repliedAt: null, replySentiment: null },
    { status: "replied", sentAt: sent, repliedAt: sent, replySentiment: "negative" },
    { status: "queued", sentAt: sent, repliedAt: sent, replySentiment: "positive" },
    {
      status: "replied",
      sentAt: sent,
      repliedAt: new Date(sent.getTime() - 1000),
      replySentiment: "positive",
    },
  ]) {
    await fixture.db
      .update(tables.outreachMessagesTable)
      .set(patch)
      .where(eq(tables.outreachMessagesTable.id, message.id));
    assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 409);
  }
  await fixture.db
    .update(tables.outreachMessagesTable)
    .set({
      status: "replied",
      sentAt: sent,
      repliedAt: new Date(),
      replySentiment: "positive",
    })
    .where(eq(tables.outreachMessagesTable.id, message.id));
  assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 200);
  const invite = await actionContext(c);
  invite.input.stepKey = "ai_interview";
  let invoked = false;
  await assert.rejects(
    execution.executeWorkflowAction(invite, {
      mode: "live",
      prepare: async () => {
        await fixture.db
          .update(tables.outreachMessagesTable)
          .set({ replySentiment: "negative" })
          .where(eq(tables.outreachMessagesTable.id, message.id));
      },
      invoke: async () => {
        invoked = true;
      },
    }),
    /positive reply/,
  );
  assert.equal(invoked, false);
});

test("legacy invitation helpers defer bound candidates, not read-only planning, without side effects", async () => {
  const c = await contactCase();
  const { hasBoundInvitationWorkflow } = await import("../lib/workflow-contact-gates");
  assert.equal(await hasBoundInvitationWorkflow(c.jobId, tenant, c.candidateId), false);
  const context = await actionContext(c);
  context.input.stepKey = "engagement";
  const { createWorkflowOutreachDraft } = await import("../lib/workflow-outreach");
  await createWorkflowOutreachDraft(
    {
      jobId: c.jobId,
      tenantId: tenant,
      candidateId: c.candidateId,
      subject: "Fictional owned contact",
      body: "Never sent",
      status: "queued",
    },
    context,
  );
  assert.equal(await hasBoundInvitationWorkflow(c.jobId, randomUUID(), c.candidateId), false);
  const { sendInterviewInviteFromReply } = await import("../lib/agents/interview-reply");
  const before = await fixture.db.select().from(tables.interviewSessionsTable);
  const [application] = await fixture.db
    .select()
    .from(tables.applicationsTable)
    .where(eq(tables.applicationsTable.id, c.applicationId));
  const result = await sendInterviewInviteFromReply({
    jobId: c.jobId,
    sourcedId: c.candidateId,
    replyBody: "Synthetic Interested, never emailed",
  });
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(result.sessionId, undefined);
  assert.equal(
    (await fixture.db.select().from(tables.interviewSessionsTable)).length,
    before.length,
  );
  const [after] = await fixture.db
    .select()
    .from(tables.applicationsTable)
    .where(eq(tables.applicationsTable.id, c.applicationId));
  assert.equal(after.stage, application.stage);
});

test("manual Interested logs a reply but cannot advance a bound workflow or claim an invitation", async () => {
  const c = await contactCase();
  const context = await actionContext(c);
  context.input.stepKey = "engagement";
  const { createWorkflowOutreachDraft } = await import("../lib/workflow-outreach");
  const message = await createWorkflowOutreachDraft(
    {
      jobId: c.jobId,
      tenantId: tenant,
      candidateId: c.candidateId,
      subject: "Fictional held first touch",
      body: "Not real mail",
      status: "queued",
    },
    context,
  );
  const [source] = await fixture.db
    .insert(tables.sourcedCandidatesTable)
    .values({
      tenantId: tenant,
      source: "internal",
      normalizedCandidateId: c.candidateId,
      rawData: {
        jobId: c.jobId,
        stage: "outreach_sent",
        screened: true,
        screeningResult: { recommendation: "advance", score: 85 },
      },
    })
    .returning();
  const [before] = await fixture.db
    .select()
    .from(tables.applicationsTable)
    .where(eq(tables.applicationsTable.id, c.applicationId));
  const reply = await request(`/jobs/${c.jobId}/pipeline/card-action`, {
    action: "log_reply",
    sourcedId: source.id,
    sentiment: "positive",
    replyBody: "Fictional Interested",
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const response = reply.body as unknown as {
    interviewInvite: { deferred: boolean };
    stage: string;
  };
  assert.equal(response.interviewInvite.deferred, true);
  assert.equal(response.stage, "outreach_sent");
  const [after] = await fixture.db
    .select()
    .from(tables.applicationsTable)
    .where(eq(tables.applicationsTable.id, c.applicationId));
  assert.equal(after.stage, before.stage);
  const [sent] = await fixture.db
    .select()
    .from(tables.outreachMessagesTable)
    .where(eq(tables.outreachMessagesTable.id, message.id));
  assert.equal(sent.replySentiment, "positive");
  const invitations = await fixture.db
    .select()
    .from(tables.candidateEventsTable)
    .where(
      and(
        eq(tables.candidateEventsTable.candidateId, c.candidateId),
        eq(tables.candidateEventsTable.eventType, "INTERVIEW_INVITED"),
      ),
    );
  assert.equal(invitations.length, 0);
  const manualInvite = await request(`/jobs/${c.jobId}/pipeline/card-action`, {
    action: "accept_interview",
    sourcedId: source.id,
  });
  assert.equal(manualInvite.status, 409, JSON.stringify(manualInvite.body));
  await fixture.db
    .update(tables.candidatesTable)
    .set({ verificationStatus: "verified" })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  const { orchestrator } = await import("../lib/agents/orchestrator");
  const native = orchestrator as unknown as {
    _runInterview: (input: Record<string, unknown>) => Promise<{
      interviewLinksGenerated: number;
      skipped: { reason: string }[];
    }>;
  };
  for (const input of [{ jobId: c.jobId, candidateId: c.candidateId }, { jobId: c.jobId }]) {
    const result = await native._runInterview(input);
    assert.equal(result.interviewLinksGenerated, 0);
    assert.ok(result.skipped.some((row) => row.reason === "workflow_invitation_requires_approval"));
  }
});

test("native outreach wrapper requires exactly one held draft and never enables immediate sending", async () => {
  const { orchestrator: agent } = await import("../lib/agents/orchestrator");
  const { createWorkflowOutreachDraft, WORKFLOW_OUTREACH_CONTEXT } =
    await import("../lib/workflow-outreach");
  const internal = agent as unknown as {
    _runAgent: (
      id: string,
      input: Record<string | symbol, any>,
    ) => Promise<Record<string, unknown>>;
  };
  const original = internal._runAgent;
  try {
    for (const valid of [true, false]) {
      const c = await contactCase();
      assert.equal((await pilotControl(c, "activate", { stepKey: "engagement" })).status, 200);
      const context = await actionContext(c);
      const input = {
        jobId: c.jobId,
        candidateId: c.candidateId,
        autoSendOutreach: true,
        passedCandidateIds: ["never-authorised"],
      };
      context.input.stepKey = "engagement";
      context.input.payloadHash = fingerprint({ agentId: "outreach", input });
      internal._runAgent = async (_id, selected) => {
        assert.equal(selected.autoSendOutreach, false);
        assert.deepEqual(selected.passedCandidateIds, [c.candidateId]);
        if (!valid) return { messagesPending: 0, messagesSent: 0, outreachIds: [] };
        const draft = await createWorkflowOutreachDraft(
          {
            jobId: c.jobId,
            tenantId: tenant,
            candidateId: c.candidateId,
            subject: "Synthetic",
            body: "Never sent",
            status: "queued",
          },
          selected[WORKFLOW_OUTREACH_CONTEXT],
        );
        assert.equal(draft.status, "pending_approval");
        return { messagesPending: 1, messagesSent: 0, outreachIds: [draft.id] };
      };
      if (valid) {
        const run = await agent.triggerAgent("outreach", input, "user", { workflow: context });
        assert.equal(run.output?.messagesPending, 1);
      } else {
        await assert.rejects(
          agent.triggerAgent("outreach", input, "user", { workflow: context }),
          /uncertain/,
        );
      }
    }
  } finally {
    internal._runAgent = original;
  }
});

test("native invitation wrapper rejects link-only success and keeps the canonical recipient fixed", async () => {
  const c = await contactCase();
  const context = await actionContext(c);
  const { createWorkflowOutreachDraft, WORKFLOW_INVITATION_RECIPIENT } =
    await import("../lib/workflow-outreach");
  context.input.stepKey = "engagement";
  const draft = await createWorkflowOutreachDraft(
    {
      jobId: c.jobId,
      tenantId: tenant,
      candidateId: c.candidateId,
      subject: "Fixture",
      body: "Never sent",
      status: "queued",
    },
    context,
  );
  await fixture.db
    .update(tables.outreachMessagesTable)
    .set({
      status: "replied",
      sentAt: new Date(),
      repliedAt: new Date(),
      replySentiment: "positive",
    })
    .where(eq(tables.outreachMessagesTable.id, draft.id));
  const wf = await current(c);
  await fixture.db
    .update(tables.recruitingWorkflowsTable)
    .set({
      steps: wf.steps.map((step, index) =>
        index === 2
          ? { ...step, status: "completed" as const, evidence: "Fictional reviewed positive reply" }
          : step,
      ),
    })
    .where(eq(tables.recruitingWorkflowsTable.id, c.workflowId));
  await fixture.db.insert(tables.sourcedCandidatesTable).values({
    tenantId: tenant,
    source: "internal",
    normalizedCandidateId: c.candidateId,
    rawData: {
      jobId: c.jobId,
      screened: true,
      screeningResult: { score: 85, recommendation: "advance" },
    },
  });
  assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 200);
  const { orchestrator: agent } = await import("../lib/agents/orchestrator");
  const internal = agent as unknown as {
    _runAgent: (
      id: string,
      input: Record<string | symbol, any>,
    ) => Promise<Record<string, unknown>>;
  };
  const original = internal._runAgent;
  let invoked = 0;
  try {
    internal._runAgent = async (_id, selected) => {
      invoked++;
      assert.equal(selected.candidateId, c.candidateId);
      assert.deepEqual(selected.passedCandidateIds, [c.candidateId]);
      assert.equal(selected[WORKFLOW_INVITATION_RECIPIENT], `${c.candidateId}@example.invalid`);
      return { interviewLinksGenerated: 1, sessionIds: ["fictional-only"], invitationAccepted: 0 };
    };
    const input = { jobId: c.jobId, candidateId: c.candidateId };
    const inviteContext = await actionContext(c);
    inviteContext.input.stepKey = "ai_interview";
    inviteContext.input.payloadHash = fingerprint({ agentId: "interview", input });
    await assert.rejects(
      agent.triggerAgent("interview", input, "user", { workflow: inviteContext }),
      /uncertain/,
    );
    await assert.rejects(
      agent.triggerAgent("interview", input, "user", { workflow: inviteContext }),
      /claimed|uncertain/,
    );
    assert.equal(invoked, 1);
    assert.equal((await pilotControl(c, "activate", { stepKey: "ai_interview" })).status, 409);
  } finally {
    internal._runAgent = original;
  }
});

test("live pilot approval requires scope, staff inbox, cost acknowledgement and a test requisition", async () => {
  const legacy = await createCase();
  assert.equal((await pilotControl(legacy, "activate")).status, 409);
  const c = await pilotCase();
  assert.equal((await pilotControl(c, "activate", {}, "recruiter")).status, 403);
  assert.equal((await pilotControl(c, "activate", {}, "hm")).status, 403);
  assert.equal((await state(c, "hm")).body.canControlLivePilot, false);
  assert.equal((await state(c)).body.canControlLivePilot, true);
  assert.equal((await pilotControl(c, "activate", {}, "outsider")).status, 404);
  assert.equal((await pilotControl(c, "activate", { acknowledgeUnknownCosts: false })).status, 400);
  assert.equal(
    (await pilotControl(c, "activate", { controlledEmail: "outsider@example.invalid" })).status,
    409,
  );
  const result = await pilotControl(c, "activate");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const wf = await current(c);
  assert.equal(wf.livePilot?.active, true);
  assert.equal(wf.livePilot?.attempted, false);
  assert.ok(Date.parse(wf.livePilot!.expiresAt as unknown as string) > Date.now());
  assert.equal(wf.steps[0].status, "pending");
});

test("pilot authority is revoked and rechecked after read-only preparation", async () => {
  const c = await pilotCase();
  assert.equal((await pilotControl(c, "activate")).status, 200);
  const context = await actionContext(c);
  let calls = 0;
  await assert.rejects(
    execution.executeWorkflowAction(context, {
      mode: "live",
      prepare: async () => {
        assert.equal((await pilotControl(c, "revoke")).status, 200);
        context.input.expectedRevision = (await current(c)).revision;
      },
      invoke: async () => {
        calls++;
        return true;
      },
    }),
    /locked/,
  );
  assert.equal(calls, 0);
  assert.equal((await current(c)).livePilot?.active, false);
});

test("pilot expiry, recipient changes and approver suspension block new live claims", async () => {
  for (const change of ["expiry", "recipient", "approver"] as const) {
    const c = await pilotCase();
    assert.equal((await pilotControl(c, "activate")).status, 200);
    const context = await actionContext(c);
    if (change === "expiry") {
      const rows = await fixture.db
        .select()
        .from(tables.recruitingWorkflowEventsTable)
        .where(eq(tables.recruitingWorkflowEventsTable.workflowId, c.workflowId));
      const row = rows.find((e) => e.action === "workflow.live_screening_pilot")!;
      await fixture.db
        .update(tables.recruitingWorkflowEventsTable)
        .set({
          note: JSON.stringify({ ...JSON.parse(row.note!), expiresAt: new Date(0).toISOString() }),
        })
        .where(eq(tables.recruitingWorkflowEventsTable.id, row.id));
    } else if (change === "recipient") {
      await fixture.db
        .update(tables.candidatesTable)
        .set({ email: "not-controlled@example.invalid" })
        .where(eq(tables.candidatesTable.id, c.candidateId));
    } else {
      await fixture.db
        .update(tables.usersTable)
        .set({ status: "suspended" })
        .where(eq(tables.usersTable.id, "admin"));
    }
    let calls = 0;
    try {
      await assert.rejects(
        execution.executeWorkflowAction(context, {
          mode: "live",
          invoke: async () => {
            calls++;
            return true;
          },
        }),
        /locked|controlled|authority/,
      );
      assert.equal(calls, 0);
    } finally {
      await fixture.db
        .update(tables.usersTable)
        .set({ status: "active" })
        .where(eq(tables.usersTable.id, "admin"));
    }
  }
});

test("screening handoff refuses link-only inputs before claiming an action and permits saved qualifications", async () => {
  const c = await pilotCase();
  await fixture.db
    .update(tables.candidatesTable)
    .set({
      currentTitle: null,
      skills: [],
      resumeUrl: "/private/fictional-unparsed-cv.pdf",
    })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  const missing = await state(c);
  const option = missing.body.candidates.find(
    (candidate: { id: string }) => candidate.id === c.candidateId,
  );
  assert.equal(option?.screeningReadiness?.ready, false);
  const before = await fixture.db
    .select()
    .from(tables.recruitingWorkflowEventsTable)
    .where(
      and(
        eq(tables.recruitingWorkflowEventsTable.jobId, c.jobId),
        eq(tables.recruitingWorkflowEventsTable.action, "workflow.execution_claimed"),
      ),
    );
  let invoked = 0;
  await assert.rejects(
    execution.executeWorkflowAction(await actionContext(c), {
      mode: "controlled_test",
      invoke: async () => {
        invoked++;
        return { saved: true };
      },
    }),
    /qualifications.*not available|parsing/,
  );
  assert.equal(invoked, 0);
  const after = await fixture.db
    .select()
    .from(tables.recruitingWorkflowEventsTable)
    .where(
      and(
        eq(tables.recruitingWorkflowEventsTable.jobId, c.jobId),
        eq(tables.recruitingWorkflowEventsTable.action, "workflow.execution_claimed"),
      ),
    );
  assert.equal(after.length, before.length);
  await fixture.db
    .update(tables.candidatesTable)
    .set({
      skills: ["Synthetic test qualification"],
    })
    .where(eq(tables.candidatesTable.id, c.candidateId));
  const ready = await state(c);
  assert.equal(
    ready.body.workflows.find((workflow: { id: string }) => workflow.id === c.workflowId)
      ?.screeningReadiness?.ready,
    true,
  );
  const result = await execution.executeWorkflowAction(await actionContext(c), {
    mode: "controlled_test",
    invoke: async () => {
      invoked++;
      return { saved: true };
    },
  });
  assert.equal(result.state, "succeeded");
  assert.equal(invoked, 1);
  const workflow = await current(c);
  assert.notEqual(workflow.steps[0].status, "completed");
});

test("screening handoff reuses its scoped source and refreshes qualifications without changing earlier evidence", async () => {
  const { ensureWorkflowProfileSource } = await import("../lib/workflow-profile-screening");
  const c = await createCase();
  const [candidate] = await fixture.db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, c.candidateId));
  const first = await ensureWorkflowProfileSource(tenant, c.jobId, candidate);
  await fixture.db
    .update(tables.sourcedCandidatesTable)
    .set({
      rawData: {
        ...(first.rawData as Record<string, unknown>),
        stage: "screening",
        screeningResult: { score: 72 },
        nativeDiscovery: { operationId: "fictional" },
      },
    })
    .where(eq(tables.sourcedCandidatesTable.id, first.id));
  const [edited] = await fixture.db
    .update(tables.candidatesTable)
    .set({
      currentTitle: "Current synthetic role",
      skills: ["Current synthetic skill"],
    })
    .where(eq(tables.candidatesTable.id, candidate.id))
    .returning();
  const second = await ensureWorkflowProfileSource(tenant, c.jobId, edited);
  assert.equal(second.id, first.id);
  const saved = second.rawData as Record<string, unknown>;
  assert.equal(saved.currentTitle, edited.currentTitle);
  assert.deepEqual(saved.skills, edited.skills);
  assert.equal(saved.stage, "screening");
  assert.deepEqual(saved.screeningResult, { score: 72 });
  assert.deepEqual(saved.nativeDiscovery, { operationId: "fictional" });
  const rows = await fixture.db
    .select()
    .from(tables.sourcedCandidatesTable)
    .where(
      and(
        eq(tables.sourcedCandidatesTable.tenantId, tenant),
        eq(tables.sourcedCandidatesTable.normalizedCandidateId, candidate.id),
        sql`${tables.sourcedCandidatesTable.rawData}->>'jobId' = ${c.jobId}`,
      ),
    );
  assert.equal(rows.length, 1);
});

test("production screening wrapper forces one canonical target and refuses zero-work or malformed grades", async () => {
  const { orchestrator: agent } = await import("../lib/agents/orchestrator");
  const { vendorUsageScope } = await import("../lib/vendor-usage");
  const internal = agent as unknown as {
    _runAgent: (id: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
  const original = internal._runAgent;
  try {
    for (const kind of ["valid", "zero", "malformed"]) {
      const c = await pilotCase();
      assert.equal((await pilotControl(c, "activate")).status, 200);
      const input = {
        jobId: c.jobId,
        candidateId: c.candidateId,
        topCandidateIds: ["never-authorised"],
      };
      const context = await actionContext(c);
      context.input.payloadHash = fingerprint({ agentId: "screening", input });
      internal._runAgent = async (_id, selected) => {
        assert.deepEqual(vendorUsageScope.getStore(), {
          tenantId: context.scope.tenantId,
          area: `workflow:${context.input.workflowId}:${context.input.stepKey}`,
        });
        assert.deepEqual(selected.topCandidateIds, [c.candidateId]);
        assert.equal(selected.candidateId, c.candidateId);
        return {
          screened: kind === "zero" ? 0 : 1,
          screeningResults:
            kind === "zero"
              ? []
              : [
                  {
                    candidateId: c.candidateId,
                    ...(kind === "valid" ? { score: 72, recommendation: "hold" } : {}),
                  },
                ],
        };
      };
      const run = agent.triggerAgent("screening", input, "user", { workflow: context });
      if (kind === "valid") assert.equal((await run).status, "completed");
      else await assert.rejects(run, /uncertain|reconciliation/);
      assert.equal((await current(c)).livePilot?.attempted, true);
      assert.equal((await current(c)).steps[0].status, "pending");
      const retry = agent.triggerAgent("screening", input, "user", { workflow: context });
      await assert.rejects(retry, /claimed|uncertain/);
    }
  } finally {
    internal._runAgent = original;
  }
});

test("concurrent different request keys still claim one workflow action", async () => {
  const c = await createCase();
  const context = await actionContext(c);
  let calls = 0;
  const invoke = async () => {
    calls++;
    return { synthetic: true };
  };
  const results = await Promise.all([
    execution.executeWorkflowAction(context, { mode: "controlled_test", invoke }),
    execution.executeWorkflowAction(
      { ...context, input: { ...context.input, idempotencyKey: randomUUID() } },
      { mode: "controlled_test", invoke },
    ),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(results.map((r) => r.state).sort(), ["already_claimed", "succeeded"]);
  assert.equal(results[0].attemptId, results[1].attemptId);
  assert.equal((await current(c)).steps[0].status, "pending");
  assert.equal((await current(c)).revision, context.input.expectedRevision);
});

test("an uncertain attempt is not resent, including after Pause/Resume", async () => {
  const c = await createCase();
  let calls = 0;
  const context = await actionContext(c);
  const invoke = async () => {
    calls++;
    throw new Error("Synthetic uncertain provider outcome");
  };
  const first = await execution.executeWorkflowAction(context, {
    mode: "controlled_test",
    invoke,
  });
  assert.equal(first.state, "unknown");
  const replay = await execution.executeWorkflowAction(context, {
    mode: "controlled_test",
    invoke,
  });
  assert.equal(replay.state, "already_claimed");
  assert.equal((await control(c, "pause")).status, 200);
  assert.equal((await control(c, "resume")).status, 200);
  await assert.rejects(
    execution.executeWorkflowAction(await actionContext(c), {
      mode: "controlled_test",
      invoke,
    }),
    /already used/,
  );
  assert.equal(calls, 1);
  assert.equal((await current(c)).steps[0].status, "pending");
});

test("stale, foreign, hidden, assisted and human-decision actions never dispatch", async () => {
  const c = await createCase();
  const context = await actionContext(c);
  let calls = 0;
  const adapter = {
    mode: "controlled_test" as const,
    invoke: async () => calls++,
  };
  await assert.rejects(
    execution.executeWorkflowAction(
      { ...context, input: { ...context.input, journeyVersion: 999 } },
      adapter,
    ),
    /journey/,
  );
  await assert.rejects(
    execution.executeWorkflowAction(
      { ...context, scope: { ...context.scope, actorId: "outsider" } },
      adapter,
    ),
    /Not found/,
  );
  await assert.rejects(
    execution.executeWorkflowAction({ ...context, candidateAllowed: async () => false }, adapter),
    /Not found/,
  );
  await assert.rejects(
    execution.executeWorkflowAction(
      { ...context, input: { ...context.input, stepKey: "hiring_decision" } },
      adapter,
    ),
    /human review/,
  );
  await fixture.db
    .update(tables.jobsTable)
    .set({ recruitingMode: "human_assisted" })
    .where(eq(tables.jobsTable.id, c.jobId));
  await assert.rejects(execution.executeWorkflowAction(context, adapter), /autonomous requisition/);
  assert.equal(calls, 0);
});

test("live adapters remain locked before preparation or provider invocation", async () => {
  const c = await createCase();
  let calls = 0;
  await assert.rejects(
    execution.executeWorkflowAction(await actionContext(c), {
      mode: "live",
      prepare: async () => {
        calls++;
      },
      invoke: async () => calls++,
    }),
    /locked|disabled|Real/i,
  );
  assert.equal(calls, 0);
});

test("the production orchestrator honors the workflow boundary before starting a run", async () => {
  const { orchestrator } = await import("../lib/agents/orchestrator");
  const c = await createCase();
  const context = await actionContext(c);
  const input = { jobId: c.jobId, candidateId: c.candidateId };
  context.input.payloadHash = fingerprint({ agentId: "screening", input });
  assert.equal((await control(c, "pause")).status, 200);
  await assert.rejects(
    orchestrator.triggerAgent("screening", input, "user", { workflow: context }),
    /paused/,
  );
  assert.equal((await control(c, "resume")).status, 200);
  const fresh = await actionContext(c);
  fresh.input.payloadHash = context.input.payloadHash;
  await assert.rejects(
    orchestrator.triggerAgent("screening", input, "user", { workflow: fresh }),
    /locked|disabled|Real/i,
  );
});

test("the production first-touch sink honors Pause and never mutates its message", async () => {
  const { dispatchOutreachMessage } = await import("../lib/outreach-dispatch");
  const c = await createCase();
  const [message] = await fixture.db
    .insert(tables.outreachMessagesTable)
    .values({
      tenantId: tenant,
      jobId: c.jobId,
      candidateId: c.candidateId,
      subject: "Fixture boundary test",
      body: "Do not deliver",
      status: "pending_approval",
    })
    .returning();
  const context = await actionContext(c);
  context.input.stepKey = "engagement";
  context.input.actionKind = "outreach_send";
  context.input.payloadHash = fingerprint({
    msgId: message.id,
    body: message.body,
    subject: message.subject,
    candidateEmail: "fixture@example.invalid",
  });
  assert.equal((await control(c, "pause")).status, 200);
  await assert.rejects(
    dispatchOutreachMessage(
      message.id,
      message.body,
      message.subject,
      "fixture@example.invalid",
      context,
    ),
    /paused/,
  );
  const [unchanged] = await fixture.db
    .select()
    .from(tables.outreachMessagesTable)
    .where(eq(tables.outreachMessagesTable.id, message.id));
  assert.equal(unchanged.status, "pending_approval");
  assert.equal(unchanged.sentAt, null);
});

test("timeout and negative confirmation stay uncertain without auto-completing a step", async () => {
  for (const timeout of [true, false]) {
    const c = await createCase();
    const result = await execution.executeWorkflowAction(await actionContext(c), {
      mode: "controlled_test",
      maxDurationMs: timeout ? 3_000 : 30_000,
      invoke: async () => (timeout ? new Promise<boolean>(() => {}) : false),
      isSuccessful: (confirmed) => confirmed,
    });
    assert.equal(result.state, "unknown");
    assert.equal((await current(c)).steps[0].status, "pending");
  }
});

test("Pause after a durable claim leaves the in-flight outcome and blocks the next claim", async () => {
  const c = await createCase();
  const context = await actionContext(c);
  const result = await execution.executeWorkflowAction(context, {
    mode: "controlled_test",
    invoke: async () => {
      assert.equal((await control(c, "pause")).status, 200);
      return "synthetic in-flight completion";
    },
  });
  assert.equal(result.state, "succeeded");
  assert.equal((await current(c)).status, "paused");
  await assert.rejects(
    execution.executeWorkflowAction(await actionContext(c), {
      mode: "controlled_test",
      invoke: async () => assert.fail("Must not begin another action"),
    }),
    /paused/,
  );
});
