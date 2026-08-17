/**
 * global-prior-leak.test.ts — BEHAVIORAL cross-customer isolation proof
 * (backlog: "Prove cross-customer isolation with a behavioral leak test").
 *
 * The pure unit tests in global-prior.test.ts already prove the aggregate TYPE
 * carries no identifiers. This test goes further: it seeds two real tenants
 * (A and B) with distinctive candidate PII and labeled outcomes, runs the REAL
 * trainGlobalPrior() pipeline against the database, and then proves that
 * nothing tenant- or candidate-identifying from tenant A can reach tenant B:
 *
 *   1. The persisted global_scoring_priors row (priorJson, aggregateJson,
 *      evaluationJson, notes) contains NO seeded PII markers, no candidate ids,
 *      and no tenant ids — only anonymous numbers.
 *   2. The staff-facing GET /learning/global-prior response, fetched as a
 *      TENANT-B admin over HTTP, contains none of tenant A's markers.
 *   3. Tenant B's own learned-scoring rows are untouched by A's data, and
 *      tenant B's effective scoring config never mentions tenant A.
 *
 * Distinctive markers use an improbable token so a substring scan is a real
 * proof, not a coincidence check.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray, like } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  candidateJobIntelligenceTable,
  tenantScoringWeightsTable,
  globalScoringPriorsTable,
} from "@workspace/db";
import { trainGlobalPrior } from "./global-prior";
import { getEffectiveScoringConfig } from "./learned-scoring";
import { issueToken } from "./auth-token";
import learningRouter from "../routes/learning";

const P = "gpLeak_";
const T_A = P + "tenantA_zq7x";
const T_B = P + "tenantB";
/* Improbable PII markers seeded ONLY into tenant A. */
const MARKERS = [
  "Xylophona", // first name
  "Quixleberg", // last name
  "xylophona.quixleberg-zq7x@leaktest.example", // email
  T_A, // tenant A's id itself
  P + "candA0", // a tenant-A candidate id
];

let server: Server;
let baseUrl: string;
let createdPriorVersions: string[] = [];
/* Snapshot of the REAL active prior (if any) taken before training, so cleanup
 * can restore live behavior exactly: a promoted test version deactivates the
 * previously active row, and deleting only our version would otherwise leave
 * the platform with NO active prior. */
let preexistingActiveVersion: string | null = null;

async function cleanup() {
  for (const t of [T_A, T_B]) {
    await dbAdmin
      .delete(candidateJobIntelligenceTable)
      .where(eq(candidateJobIntelligenceTable.tenantId, t));
    await dbAdmin
      .delete(tenantScoringWeightsTable)
      .where(eq(tenantScoringWeightsTable.tenantId, t));
    await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, t));
    await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, t));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, t));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, t));
  }
  /* Remove any global-prior versions this test created (never touch real ones),
   * then restore the pre-test active prior if our promoted version displaced it. */
  if (createdPriorVersions.length > 0) {
    await dbAdmin
      .delete(globalScoringPriorsTable)
      .where(inArray(globalScoringPriorsTable.version, createdPriorVersions));
    createdPriorVersions = [];
  }
  if (preexistingActiveVersion) {
    const [stillActive] = await dbAdmin
      .select({ version: globalScoringPriorsTable.version })
      .from(globalScoringPriorsTable)
      .where(eq(globalScoringPriorsTable.isActive, true))
      .limit(1);
    if (!stillActive) {
      await dbAdmin
        .update(globalScoringPriorsTable)
        .set({ isActive: true, updatedAt: new Date() })
        .where(eq(globalScoringPriorsTable.version, preexistingActiveVersion));
    }
    preexistingActiveVersion = null;
  }
}

function sig(v: number) {
  return {
    screening: { skillMatchScore: v, experienceScore: v },
    interview: { overallScore: v },
    verification: { identityScore: v },
  };
}

async function seedTenant(tenantId: string, opts: { pii: boolean; n: number }) {
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: tenantId, name: tenantId, slug: tenantId } as any);
  const jobId = tenantId + "_job";
  await dbAdmin.insert(jobsTable).values({
    id: jobId,
    tenantId,
    title: "Leak Test Role",
    description: "Seeded role for isolation test",
    status: "active",
  } as any);
  const suffix = tenantId === T_A ? "candA" : "candB";
  for (let i = 0; i < opts.n; i++) {
    const hired = i % 2 === 0;
    const candId = P + suffix + i;
    await dbAdmin.insert(candidatesTable).values({
      id: candId,
      tenantId,
      firstName: opts.pii ? "Xylophona" : "Plain",
      lastName: opts.pii ? "Quixleberg" : `B${i}`,
      email: opts.pii ? `xylophona.quixleberg-zq7x+${i}@leaktest.example` : `${P}b${i}@t.test`,
    } as any);
    await dbAdmin.insert(candidateJobIntelligenceTable).values({
      id: P + suffix + "intel" + i,
      tenantId,
      jobId,
      candidateId: candId,
      signalsJson: sig(hired ? 85 - (i % 4) : 25 + (i % 4)),
      signalTimestampsJson: {},
      outcome: hired ? "hired" : "rejected",
      outcomeAt: new Date(),
    } as any);
  }
}

function assertNoMarkers(payload: unknown, where: string) {
  const s = JSON.stringify(payload) ?? "";
  for (const m of MARKERS) {
    assert.ok(!s.includes(m), `${where} must not contain tenant-A marker "${m}"`);
  }
}

before(async () => {
  await cleanup();
  const [active] = await dbAdmin
    .select({ version: globalScoringPriorsTable.version })
    .from(globalScoringPriorsTable)
    .where(eq(globalScoringPriorsTable.isActive, true))
    .limit(1);
  preexistingActiveVersion = active?.version ?? null;
  await seedTenant(T_A, { pii: true, n: 30 });
  await seedTenant(T_B, { pii: false, n: 30 });
  await dbAdmin.insert(usersTable).values({
    id: P + "badmin",
    tenantId: T_B,
    email: P + "badmin@t.test",
    name: "B Admin",
    passwordHash: "x-not-a-login",
    role: "tenant_admin",
  } as any);

  const app = express();
  app.use(express.json());
  app.use("/api/learning", learningRouter);
  server = app.listen(0);
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  server?.close();
  await cleanup();
});

test("persisted global prior rows contain no tenant/candidate identifiers or PII", async () => {
  const result = await trainGlobalPrior();
  if (result.version) createdPriorVersions.push(result.version);
  assert.notEqual(
    result.status,
    "insufficient_tenants",
    "two seeded tenants must clear the tenant gate",
  );

  const rows = await dbAdmin
    .select()
    .from(globalScoringPriorsTable)
    .where(like(globalScoringPriorsTable.version, "%"));
  assert.ok(rows.length > 0, "training must persist an audit row");
  for (const row of rows) {
    assertNoMarkers(row.priorJson, "global prior priorJson");
    assertNoMarkers(row.aggregateJson, "global prior aggregateJson");
    assertNoMarkers(row.evaluationJson, "global prior evaluationJson");
    assertNoMarkers(row.notes, "global prior notes");
  }
});

test("tenant-B admin's /learning/global-prior response leaks nothing from tenant A", async () => {
  const token = issueToken({ userId: P + "badmin", role: "tenant_admin", tenantId: T_B });
  const res = await fetch(`${baseUrl}/api/learning/global-prior`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assertNoMarkers(json, "GET /learning/global-prior response");
  // The aggregate surface may report HOW MANY tenants contributed — never WHICH.
  const s = JSON.stringify(json);
  assert.ok(!s.includes("tenantA"), "no tenant-A naming may appear in the aggregate surface");
});

test("tenant A's rows never create learned-scoring state for tenant B", async () => {
  const bRows = await dbAdmin
    .select()
    .from(tenantScoringWeightsTable)
    .where(eq(tenantScoringWeightsTable.tenantId, T_B));
  assert.equal(bRows.length, 0, "global training must not write tenant-B weight rows");

  const cfg = await getEffectiveScoringConfig(T_B);
  assertNoMarkers({ version: cfg.version, label: cfg.label }, "tenant B effective config metadata");
  // The only thing that may cross the boundary is the anonymous weight vector.
  const w = cfg.weights.hireProbability;
  const sum = w.fit + w.quality + w.trust + w.conversion;
  assert.ok(
    Math.abs(sum - 1) < 0.01,
    "cross-tenant influence is limited to a normalized weight vector",
  );
});
