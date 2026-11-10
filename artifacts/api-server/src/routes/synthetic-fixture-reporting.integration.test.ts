/**
 * Reuse the seven real HTTP compliance-report assertions in a PRIVATE schema,
 * adding fully populated synthetic hires that would otherwise inflate them.
 * No public candidate reads/writes, providers or email transports.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, and, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as tables from "@workspace/db";
import { createTransactionalDb } from "../test-fixtures/transactional-db";

const fixture = await createTransactionalDb(
  (Object.values(tables) as unknown[]).filter(
    (value): value is PgTable => value instanceof PgTable,
  ),
);
// Import AFTER replacing @workspace/db; its seeding and HTTP routers must both
// use the private pool. Its cleanup hook runs before fixture.close below.
const { complianceFixtureExtensions } = await import("./compliance-no-erased-dnc-in-counts.test");
const db = fixture.db;
const tenant = "cnedc_t";
const control = "cnedc_candOk";
const erased = "cnedc_candErased";
const synthetic = ["synthetic_marker", "synthetic_legacy"];
const syntheticTenant = "synthetic_only_tenant";

complianceFixtureExtensions.afterSeed = async () => {
  for (const candidateId of synthetic) {
    const [source] = await db
      .select()
      .from(tables.candidatesTable)
      .where(eq(tables.candidatesTable.id, erased));
    await db.insert(tables.candidatesTable).values({
      ...source,
      id: candidateId,
      email: `${candidateId}@example.invalid`,
      dataErasedAt: null,
      doNotContact: false,
      verificationResult:
        candidateId === synthetic[0]
          ? { syntheticFixture: { kind: "staff_inbox", workflowId: "fixture" } }
          : null,
    });
    const [application] = await db
      .select()
      .from(tables.applicationsTable)
      .where(eq(tables.applicationsTable.candidateId, erased));
    const applicationId = randomUUID();
    await db.insert(tables.applicationsTable).values({
      ...application,
      id: applicationId,
      candidateId,
    });
    for (const table of [
      tables.interviewSessionsTable,
      tables.candidateEventsTable,
      tables.candidateOutcomesTable,
      tables.candidateJobIntelligenceTable,
    ]) {
      const rows = await db.select().from(table).where(eq(table.candidateId, erased));
      for (const row of rows) {
        await db.insert(table).values({
          ...row,
          id: randomUUID(),
          candidateId,
          ...("eventId" in row ? { eventId: randomUUID() } : {}),
          ...("applicationId" in row ? { applicationId } : {}),
        } as any);
      }
    }
  }
  // Historical clearance must exclude the fixture even without the new marker;
  // cancellation or a later human review must not turn fictional data real.
  await db.insert(tables.recruitingWorkflowsTable).values({
    id: "legacy_fixture_workflow",
    tenantId: tenant,
    jobId: "cnedc_jobA",
    candidateId: synthetic[1],
    journeyId: "fixture",
    journeyVersion: 1,
    interviewPath: "ai",
    createdById: "cnedc_tadmin",
    status: "cancelled",
    steps: [],
  });
  await db.insert(tables.recruitingWorkflowEventsTable).values({
    tenantId: tenant,
    jobId: "cnedc_jobA",
    workflowId: "legacy_fixture_workflow",
    action: "workflow.identity_resolved",
    actorId: "cnedc_tadmin",
    note: JSON.stringify({ decision: "internal_test", candidateId: synthetic[1] }),
  });
  // Realistic free text must not be parsed as JSON or classified as clearance.
  await db.insert(tables.recruitingWorkflowEventsTable).values({
    tenantId: tenant,
    jobId: "cnedc_jobA",
    workflowId: "legacy_fixture_workflow",
    action: "workflow.paused",
    actorId: "cnedc_tadmin",
    note: "not JSON",
  });
  // Test-like names/domains alone do not classify ordinary records.
  await db
    .update(tables.candidatesTable)
    .set({ firstName: "Synthetic test" })
    .where(eq(tables.candidatesTable.id, control));
};

test("training readers, global cohorts and retraining scheduler exclude synthetic outcomes", async () => {
  const signals = { screening: { skillMatchScore: 85, experienceScore: 85 } };
  await db
    .update(tables.candidateJobIntelligenceTable)
    .set({ outcome: "hired", signalsJson: signals })
    .where(inArray(tables.candidateJobIntelligenceTable.candidateId, [control, ...synthetic]));
  await db.insert(tables.tenantsTable).values({
    id: syntheticTenant,
    name: "Private fake tenant",
    slug: syntheticTenant,
  });
  await db.insert(tables.candidatesTable).values({
    id: "only_fake",
    tenantId: syntheticTenant,
    firstName: "Fake",
    lastName: "Fixture",
    email: "only_fake@example.invalid",
    verificationResult: { syntheticFixture: { kind: "staff_inbox", workflowId: "fixture" } },
  });
  await db.insert(tables.candidateJobIntelligenceTable).values({
    tenantId: syntheticTenant,
    candidateId: "only_fake",
    jobId: "fake_job",
    outcome: "hired",
    signalsJson: signals,
  });
  const { loadTenantLabeledRows } = await import("../lib/learned-scoring");
  const { loadTenantIdsWithOutcomes } = await import("../lib/global-prior");
  const { findTenantsNeedingRetrain } = await import("../lib/learned-scoring-scheduler");
  assert.equal((await loadTenantLabeledRows(tenant)).length, 1);
  assert.equal((await loadTenantLabeledRows(syntheticTenant)).length, 0);
  assert.deepEqual(await loadTenantIdsWithOutcomes(), [tenant]);
  assert.deepEqual(await findTenantsNeedingRetrain(), [tenant]);
});

test("marker survives verification refresh; agents cannot mark an ordinary candidate synthetic", async () => {
  const { preserveSyntheticFixture, restrictToRealCandidates } =
    await import("../lib/synthetic-fixture-scope");
  for (const candidateId of [synthetic[0], control]) {
    await db
      .update(tables.candidatesTable)
      .set({
        verificationResult: preserveSyntheticFixture({
          overallScore: 80,
          syntheticFixture: { kind: "staff_inbox", workflowId: "forged" },
        }),
      })
      .where(eq(tables.candidatesTable.id, candidateId));
  }
  const [marked] = await db
    .select()
    .from(tables.candidatesTable)
    .where(eq(tables.candidatesTable.id, synthetic[0]));
  assert.equal((marked.verificationResult as any).syntheticFixture.workflowId, "fixture");
  const eligible = await db
    .select({ id: tables.candidatesTable.id })
    .from(tables.candidatesTable)
    .where(
      and(
        inArray(tables.candidatesTable.id, [control, ...synthetic]),
        restrictToRealCandidates(tables.candidatesTable.id),
      ),
    );
  assert.deepEqual(eligible, [{ id: control }]);
  const orphan = await db.execute(sql`SELECT
    ${restrictToRealCandidates(sql`NULL::text`)} AS null_kept,
    ${restrictToRealCandidates(sql`'missing_candidate'::text`)} AS orphan_kept`);
  assert.deepEqual(orphan.rows, [{ null_kept: true, orphan_kept: true }]);
});

test("similar-hire exemplars contain the real control, not marker or legacy synthetic hires", async () => {
  const { EMBEDDING_MODEL, EMBEDDING_DIMS } = await import("../lib/ai");
  const { loadSuccessfulHireVectors } = await import("../lib/similar-hire");
  await db.insert(tables.icpTable).values({
    tenantId: tenant,
    jobId: "cnedc_jobA",
    jobTitle: "Fixture",
    roleFamily: "fixture_engineering",
  });
  const controlVector = Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i === 0 ? 1 : 0));
  await db.insert(tables.candidateEmbeddingsTable).values(
    [control, ...synthetic].map((candidateId) => ({
      tenantId: tenant,
      candidateId,
      model: EMBEDDING_MODEL,
      dims: EMBEDDING_DIMS,
      textHash: candidateId,
      vector: controlVector,
    })),
  );
  const vectors = await loadSuccessfulHireVectors(tenant, "fixture_engineering");
  assert.equal(vectors.length, 1, "all-empty is not proof of a working exclusion");
  assert.deepEqual(vectors[0], controlVector);
});

after(async () => {
  await fixture.close();
});
