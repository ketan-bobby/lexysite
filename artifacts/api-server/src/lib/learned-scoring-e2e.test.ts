/**
 * learned-scoring-e2e.test.ts — end-to-end verification of the learned-scoring
 * train/promote decision with SEEDED outcomes (backlog: "Verify learned scoring
 * end-to-end with seeded outcomes" + "Lock in the train/promote decision with
 * an integration test").
 *
 * Seeds real candidate_job_intelligence rows (via dbAdmin) with labeled hiring
 * outcomes and drives the REAL trainTenantWeights() pipeline:
 *   – sample gate: below MIN_SAMPLES nothing is persisted;
 *   – above the gate: exactly one new version row per call, at most one active;
 *   – promoted  ⇒ getEffectiveScoringConfig serves the learned version;
 *   – rejected  ⇒ getEffectiveScoringConfig keeps the live/builtin fallback;
 *   – deactivate reverts the tenant to fallback;
 *   – the auto-refresh scheduler's findTenantsNeedingRetrain() flags the tenant
 *     only while it has outcomes NEWER than its last training attempt.
 *
 * Cleanup deletes only rows under the test prefix — safe against real data.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  jobsTable,
  candidatesTable,
  candidateJobIntelligenceTable,
  tenantScoringWeightsTable,
} from "@workspace/db";
import {
  trainTenantWeights,
  getEffectiveScoringConfig,
  deactivateLearnedVersions,
  MIN_SAMPLES,
} from "./learned-scoring";
import { findTenantsNeedingRetrain } from "./learned-scoring-scheduler";

const P = "lsE2e_";
const TENANT = P + "t";
const JOB = P + "job";

async function cleanup() {
  await dbAdmin
    .delete(candidateJobIntelligenceTable)
    .where(eq(candidateJobIntelligenceTable.tenantId, TENANT));
  await dbAdmin
    .delete(tenantScoringWeightsTable)
    .where(eq(tenantScoringWeightsTable.tenantId, TENANT));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, TENANT));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, TENANT));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, TENANT));
}

/** Strongly separable signals: hires score high on every dimension, rejects low
 *  — so learned weights have real structure to find and the backtest is not a
 *  coin flip. */
function signalsFor(hired: boolean, i: number) {
  const hi = 88 - (i % 5);
  const lo = 22 + (i % 5);
  const v = hired ? hi : lo;
  return {
    screening: { skillMatchScore: v, experienceScore: v, resumeConsistencyScore: v },
    interview: { overallScore: v, communicationScore: v },
    verification: { identityScore: v, resumeConsistencyScore: v },
    outreach: { responseRate: v / 100, engagementScore: v },
  };
}

async function seedLabeledRows(n: number, opts: { outcomeAt?: Date; startIndex?: number } = {}) {
  const start = opts.startIndex ?? 0;
  const outcomeAt = opts.outcomeAt ?? new Date();
  for (let i = start; i < start + n; i++) {
    const hired = i % 2 === 0;
    const candId = `${P}cand${i}`;
    await dbAdmin.insert(candidatesTable).values({
      id: candId,
      tenantId: TENANT,
      firstName: "T",
      lastName: `C${i}`,
      email: `${P}${i}@t.test`,
    } as any);
    await dbAdmin.insert(candidateJobIntelligenceTable).values({
      id: `${P}intel${i}`,
      tenantId: TENANT,
      jobId: JOB,
      candidateId: candId,
      signalsJson: signalsFor(hired, i),
      signalTimestampsJson: {},
      outcome: hired ? "hired" : "rejected",
      outcomeAt,
    } as any);
  }
}

before(async () => {
  await cleanup();
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: TENANT, name: "Learned E2E Tenant", slug: P + "slug" } as any);
  await dbAdmin.insert(jobsTable).values({
    id: JOB,
    tenantId: TENANT,
    title: "E2E Role",
    description: "Seeded role for learned-scoring e2e test",
    status: "active",
  } as any);
});

after(async () => {
  await cleanup();
});

test("sample gate: below MIN_SAMPLES nothing is persisted", async () => {
  await seedLabeledRows(Math.max(0, MIN_SAMPLES - 5));
  const r = await trainTenantWeights(TENANT);
  assert.equal(r.status, "insufficient_samples");
  assert.equal(r.activated, false);
  const rows = await dbAdmin
    .select()
    .from(tenantScoringWeightsTable)
    .where(eq(tenantScoringWeightsTable.tenantId, TENANT));
  assert.equal(rows.length, 0, "no version row may be written below the sample gate");
});

test("scheduler detection: tenant with untrained outcomes is flagged", async () => {
  const tenants = await findTenantsNeedingRetrain();
  assert.ok(tenants.includes(TENANT), "never-trained tenant with labeled rows must be flagged");
});

test("train/promote decision is locked: one row per call, promotion ⇔ effective config switch", async () => {
  // Top up past the gate.
  await seedLabeledRows(10, { startIndex: MIN_SAMPLES - 5 });
  const r = await trainTenantWeights(TENANT);
  assert.ok(
    r.status === "promoted" || r.status === "rejected_by_backtest",
    `above the gate the decision must be promote-or-reject, got ${r.status}`,
  );
  assert.ok(r.version, "an above-gate run always records a version");
  assert.ok(r.comparison, "an above-gate run always records the backtest comparison");
  // promote ⇔ backtest winner is the candidate — the ONLY promotion criterion.
  assert.equal(r.activated, r.comparison!.winner === "candidate");

  const rows = await dbAdmin
    .select()
    .from(tenantScoringWeightsTable)
    .where(eq(tenantScoringWeightsTable.tenantId, TENANT));
  assert.equal(rows.length, 1, "exactly one version row per training call");
  const active = rows.filter((x) => x.isActive);
  assert.equal(active.length, r.activated ? 1 : 0);

  const effective = await getEffectiveScoringConfig(TENANT);
  if (r.activated) {
    assert.equal(effective.version, r.version, "promoted config must be served");
  } else {
    assert.notEqual(effective.version, r.version, "rejected config must NOT be served");
  }

  // Second call on the SAME data: still one new row max, never more than one active.
  const r2 = await trainTenantWeights(TENANT);
  const rows2 = await dbAdmin
    .select()
    .from(tenantScoringWeightsTable)
    .where(eq(tenantScoringWeightsTable.tenantId, TENANT));
  assert.equal(rows2.length, 2, "each call writes at most one new version row");
  assert.equal(
    rows2.filter((x) => x.isActive).length,
    r2.activated ? 1 : 0,
    "at most one active version",
  );
});

test("scheduler detection: freshly trained tenant is NOT re-flagged until a new outcome arrives", async () => {
  let tenants = await findTenantsNeedingRetrain();
  assert.ok(!tenants.includes(TENANT), "no outcomes newer than the last training attempt");

  // A new outcome arrives after training → flagged again.
  await seedLabeledRows(1, { startIndex: 9000, outcomeAt: new Date(Date.now() + 60_000) });
  tenants = await findTenantsNeedingRetrain();
  assert.ok(tenants.includes(TENANT), "new outcome after last training must re-flag the tenant");
});

test("deactivation reverts the tenant to the fallback config", async () => {
  await deactivateLearnedVersions(TENANT);
  const effective = await getEffectiveScoringConfig(TENANT);
  assert.ok(
    !effective.version.startsWith(`learned-${TENANT}`),
    "after deactivation the tenant must serve the live/builtin fallback",
  );
  const active = await dbAdmin
    .select()
    .from(tenantScoringWeightsTable)
    .where(
      and(
        eq(tenantScoringWeightsTable.tenantId, TENANT),
        eq(tenantScoringWeightsTable.isActive, true),
      ),
    );
  assert.equal(active.length, 0);
});
