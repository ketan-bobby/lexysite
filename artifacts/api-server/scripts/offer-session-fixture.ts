/** Opt-in development fixture. Never connect this runner to an unverified target. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  dbAdmin,
  controlDb,
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
import { journeySteps, readBrief } from "../src/lib/recruiting-workflows";
import { offerSessionIdentity, type OfferSessionIdentity } from "./offer-session-journal";

const identity = sql`SELECT md5(current_database() || ':' || system_identifier::text)
  AS fingerprint FROM pg_control_system()`;

export async function assertDevelopmentTarget(expected: string | undefined) {
  assert.notEqual(process.env.NODE_ENV, "production", "Never run this fixture in production.");
  assert.match(
    expected ?? "",
    /^[a-f0-9]{32}$/,
    "An explicit verified development fingerprint is required.",
  );
  for (const handle of [dbAdmin, controlDb]) {
    const result = await handle.execute(identity);
    assert.equal(
      result.rows[0]?.fingerprint,
      expected,
      "Database is not the verified development target; no fixture writes allowed.",
    );
  }
}

export function newOfferSessionFixture() {
  const prefix = `offer_session_${randomUUID()}`;
  const actor = (name: string) => ({
    id: `${prefix}_${name}`,
    email: `${prefix}_${name}@example.invalid`,
    password: `Aa1!${randomBytes(24).toString("base64url")}`,
  });
  return {
    ...offerSessionIdentity(prefix),
    ownershipTag: randomUUID(),
    ownershipProof: "",
    actors: { revoked: actor("revoked"), retained: actor("retained") },
    candidateNames: Array.from({ length: 26 }, (_, i) => `SessionPrivate${i} Fixture`),
  };
}
export type OfferSessionFixture = ReturnType<typeof newOfferSessionFixture>;

export async function prepareOfferSessionFixture(f: OfferSessionFixture) {
  assert.match(
    f.ownershipProof,
    /^[a-f0-9]{64}$/,
    "Durable journal ownership is required before fixture writes.",
  );
  // Both passwords stay in memory; neither passwords nor session tokens are printed.
  const actors = await Promise.all(
    Object.values(f.actors).map(async (a) => ({
      ...a,
      passwordHash: await bcrypt.hash(a.password, 12),
    })),
  );
  await dbAdmin.transaction(async (tx) => {
    await tx.insert(tenantsTable).values({
      id: f.tenantId,
      slug: f.tenantId,
      name: `ISOLATED Session Access Employer ${f.ownershipProof}`,
    });
    await tx.insert(usersTable).values(
      actors.map((a) => ({
        id: a.id,
        email: a.email,
        passwordHash: a.passwordHash,
        tenantId: f.tenantId,
        name: "Isolated session staff",
        role: "tenant_admin" as const,
        status: "active" as const,
      })),
    );
    await tx.insert(jobsTable).values({
      id: f.jobId,
      tenantId: f.tenantId,
      status: "active",
      interviewPath: "human",
      title: "ISOLATED session access role",
      description: `Synthetic staff-access fixture. No candidate contact or real hiring decision. Owner ${f.ownershipProof}`,
    });
    const brief = await readBrief(tx, {
      jobId: f.jobId,
      tenantId: f.tenantId,
      actorId: f.actors.retained.id,
      canApprove: true,
    });
    const now = new Date().toISOString();
    const steps = journeySteps("human").map((step) => ({
      ...step,
      status: "completed" as const,
      evidence: "SYNTHETIC WORKFLOW ONLY. No assessments, identity clearance or real hiring.",
      ...(step.key === "hiring_decision"
        ? {
            humanDecision: {
              outcome: "hire" as const,
              actorId: f.actors.retained.id,
              actorName: "Synthetic staff",
              decidedAt: now,
              testOnly: true,
              reason: "Isolated session-access test only. Not an employment decision.",
            },
            offerRouting: {
              mode: "native" as const,
              ownerUserId: f.actors.revoked.id,
              approverUserId: f.actors.retained.id,
              senderUserId: f.actors.retained.id,
              externalSystem: null,
              externalApplicationUrl: null,
              configuredBy: f.actors.retained.id,
              configuredAt: now,
            },
          }
        : {}),
    }));
    await tx.insert(journeys).values({
      id: f.journeyId,
      tenantId: f.tenantId,
      jobId: f.jobId,
      version: 1,
      status: "approved",
      briefHash: brief.hash,
      brief: brief.brief,
      interviewPath: "human",
      steps,
      createdById: f.actors.retained.id,
      approvedById: f.actors.retained.id,
      approvedAt: new Date(),
    });
    await tx.insert(candidatesTable).values(
      f.workflowIds.map((id, i) => ({
        id: f.candidateIds[i],
        tenantId: f.tenantId,
        firstName: `SessionPrivate${i}`,
        lastName: "Fixture",
        email: `${f.prefix}_candidate_${i}@example.invalid`,
        pool: "tenant" as const,
        verificationStatus: "pending" as const,
        verificationResult: { syntheticFixture: { kind: "controlled_inbox", workflowId: id } },
      })),
    );
    await tx.insert(applicationsTable).values(
      f.workflowIds.map((_, i) => ({
        id: f.applicationIds[i],
        tenantId: f.tenantId,
        jobId: f.jobId,
        candidateId: `${f.prefix}_candidate_${i}`,
        stage: "applied" as const,
      })),
    );
    await tx.insert(workflows).values(
      f.workflowIds.map((id, i) => ({
        id,
        tenantId: f.tenantId,
        jobId: f.jobId,
        candidateId: `${f.prefix}_candidate_${i}`,
        journeyId: f.journeyId,
        journeyVersion: 1,
        status: "completed" as const,
        interviewPath: "human" as const,
        steps,
        createdById: f.actors.retained.id,
        updatedAt: new Date(Date.now() - i * 1000),
      })),
    );
  });
}

export async function verifyOfferSessionFixture(
  f: OfferSessionFixture,
  scenario: "suspension" | "role-change",
) {
  const actors = await dbAdmin.select().from(usersTable).where(eq(usersTable.tenantId, f.tenantId));
  assert.equal(
    actors.find((a) => a.id === f.actors.revoked.id)?.status,
    scenario === "suspension" ? "suspended" : "active",
  );
  assert.equal(
    actors.find((a) => a.id === f.actors.revoked.id)?.role,
    scenario === "suspension" ? "tenant_admin" : "interviewer",
  );
  assert.equal(actors.find((a) => a.id === f.actors.retained.id)?.status, "active");
  const rows = await dbAdmin.select().from(workflows).where(eq(workflows.tenantId, f.tenantId));
  assert.equal(rows.length, 26);
  assert.ok(rows.every((row) => !row.steps.some((step) => step.controlledOffer)));
  const result = await pool.query(
    `SELECT count(*)::int AS count FROM candidate_outcomes WHERE tenant_id=$1`,
    [f.tenantId],
  );
  assert.equal(result.rows[0].count, 0);
  const fees = await pool.query(
    `SELECT count(*)::int AS count FROM fee_line_items WHERE tenant_id=$1`,
    [f.tenantId],
  );
  assert.equal(fees.rows[0].count, 0);
}

export async function cleanupOfferSessionFixture(
  f: OfferSessionIdentity & { ownershipProof: string },
  emptyOnly = false,
) {
  assert.match(
    f.ownershipProof,
    /^[a-f0-9]{64}$/,
    "Fixture ownership proof is required for cleanup.",
  );
  assert.deepEqual(offerSessionIdentity(f.prefix), {
    prefix: f.prefix,
    tenantId: f.tenantId,
    jobId: f.jobId,
    journeyId: f.journeyId,
    staffIds: f.staffIds,
    candidateIds: f.candidateIds,
    applicationIds: f.applicationIds,
    workflowIds: f.workflowIds,
  });
  await dbAdmin.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${f.prefix}, 0))`);
    const [tenant] = await tx
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, f.tenantId))
      .for("update");
    const specifications = [
      { table: workflows, ids: f.workflowIds },
      { table: journeys, ids: [f.journeyId] },
      { table: applicationsTable, ids: f.applicationIds },
      { table: candidatesTable, ids: f.candidateIds },
      { table: jobsTable, ids: [f.jobId] },
      { table: usersTable, ids: f.staffIds },
    ];
    for (const { table, ids } of specifications) {
      const rows = await tx
        .select({ id: table.id, tenantId: table.tenantId })
        .from(table)
        .where(or(eq(table.tenantId, f.tenantId), inArray(table.id, ids)));
      assert.ok(
        rows.every((row) => row.tenantId === f.tenantId && ids.includes(row.id)),
        "Unexpected fixture scope; cleanup refused.",
      );
      if (!tenant || emptyOnly)
        assert.equal(
          rows.length,
          0,
          "Completed/missing fixture root still has records; cleanup refused.",
        );
    }
    for (const table of [receipts, events]) {
      const rows = await tx
        .select({ id: table.id })
        .from(table)
        .where(eq(table.tenantId, f.tenantId));
      assert.equal(rows.length, 0, "Unexpected workflow activity; cleanup refused.");
    }
    if (!tenant) return; // Pending-before-commit and repeated cleanup are safe no-ops.
    assert.ok(!emptyOnly, "A completed fixture was recreated; cleanup refused.");
    assert.ok(
      tenant.name === `ISOLATED Session Access Employer ${f.ownershipProof}`,
      "Fixture ownership marker mismatch.",
    );
    const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, f.jobId));
    if (job)
      assert.ok(
        job.description ===
          `Synthetic staff-access fixture. No candidate contact or real hiring decision. Owner ${f.ownershipProof}`,
        "Fixture job ownership mismatch.",
      );
    const users = await tx.select().from(usersTable).where(eq(usersTable.tenantId, f.tenantId));
    assert.ok(
      users.every(
        (u) =>
          u.email === `${u.id}@example.invalid` &&
          u.name === "Isolated session staff" &&
          ["tenant_admin", "interviewer"].includes(u.role),
      ),
      "Unexpected staff data; cleanup refused.",
    );
    const offers = await tx.select().from(workflows).where(eq(workflows.tenantId, f.tenantId));
    assert.ok(
      offers.every(
        (w) =>
          w.jobId === f.jobId &&
          w.journeyId === f.journeyId &&
          f.candidateIds.includes(w.candidateId) &&
          !w.steps.some((s) => s.controlledOffer) &&
          w.steps.find((s) => s.key === "hiring_decision")?.humanDecision?.testOnly === true,
      ),
      "Unexpected offer data; cleanup refused.",
    );
    for (const table of ["candidate_outcomes", "fee_line_items"]) {
      const rows = await tx.execute(
        sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)} WHERE tenant_id=${f.tenantId}`,
      );
      assert.equal(rows.rows[0]?.count, 0, "Unexpected outcomes/fees; cleanup refused.");
    }
    for (const { table, ids } of specifications) {
      await tx.delete(table).where(and(eq(table.tenantId, f.tenantId), inArray(table.id, ids)));
    }
    await tx.delete(tenantsTable).where(eq(tenantsTable.id, f.tenantId));
    for (const table of [
      workflows,
      journeys,
      applicationsTable,
      candidatesTable,
      jobsTable,
      usersTable,
    ]) {
      const remaining = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.tenantId, f.tenantId));
      assert.equal(remaining[0].count, 0, "Synthetic business fixture was not fully removed.");
    }
    assert.equal(
      (await tx.select().from(tenantsTable).where(eq(tenantsTable.id, f.tenantId))).length,
      0,
    );
  });
}
