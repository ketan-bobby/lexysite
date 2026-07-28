/**
 * analytics-structural-invariants.test.ts — STRUCTURAL COUNT CONTRACTS
 *
 * These are shape/ordering invariants that must hold for EVERY analytics count
 * surface regardless of the underlying data — the complement to the compliance
 * seal (which asserts specific values). Two contracts are enforced:
 *
 *   1. FUNNEL MONOTONICITY — the pipeline funnel counts "candidates who reached
 *      this stage or beyond", so each later stage is a strict subset of the
 *      earlier one. The per-stage counts must therefore be monotonically
 *      NON-INCREASING down the funnel's stage order. A later bar that exceeds
 *      an earlier bar is structurally impossible and would signal a broken
 *      ordinal / cumulative-count computation.
 *
 *   2. NO NEGATIVE COUNTS — no count surface may ever emit a negative number.
 *      We recursively walk each endpoint's JSON response and assert every finite
 *      numeric leaf is >= 0. The ONE documented exception is `trendPct` (a signed
 *      period-over-period delta on recruiter-performance rows, which is a rate of
 *      change, not a count) — it is skipped by key name.
 *
 * NOT asserted here (deliberately): a "rejected funnel <= overview" invariant.
 * Under the split-filter model the funnel excludes terminal-negative stages
 * while some overview bases do not, so that relationship is FALSE by design and
 * must not be encoded as a contract.
 *
 * ─── Fixture ──────────────────────────────────────────────────────────────────
 * One tenant, one recruiter-assigned job, and candidates spread ACROSS live
 * stages so the cumulative funnel actually steps down (proving the monotonic
 * assertion can catch a violation rather than trivially passing on flat data):
 *
 *   3 @ sourced · 2 @ applied · 2 @ interview_completed · 1 @ hired
 *
 * yielding a descending cumulative funnel (8, 5, 3, 3, 1, 1, 1, 1, 0). The
 * interviewed + hired candidates also get completed/scored sessions, hired
 * outcomes and intelligence rows so the interview/score/outcome/intelligence
 * surfaces return real, populated (non-zero) numbers to walk.
 *
 * ─── Harness ──────────────────────────────────────────────────────────────────
 * Same as compliance-no-erased-dnc-in-counts.test.ts: mount the REAL routers on
 * a bare Express app, seed via dbAdmin (BYPASSRLS), drive each surface over HTTP
 * with a real bearer token for a tenant_admin scoped to the test tenant.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  interviewSessionsTable,
  candidateEventsTable,
  candidateOutcomesTable,
  candidateJobIntelligenceTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import analyticsRouter from "./analytics";
import recruiterPerformanceRouter from "./recruiter-performance";
import outcomesRouter from "./outcomes";
import intelligenceRouter from "./intelligence";

const P = "structinv_";
const id = (s: string) => P + s;

let server: Server;
let baseUrl: string;

const tAdmin = () => issueToken({ userId: id("tadmin"), role: "tenant_admin", tenantId: id("t") });

async function api(method: string, path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}` } });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(candidateOutcomesTable).where(eq(candidateOutcomesTable.tenantId, id("t")));
  await dbAdmin.delete(candidateJobIntelligenceTable).where(eq(candidateJobIntelligenceTable.tenantId, id("t")));
  await dbAdmin.delete(candidateEventsTable).where(eq(candidateEventsTable.tenantId, id("t")));
  await dbAdmin.delete(interviewSessionsTable).where(eq(interviewSessionsTable.tenantId, id("t")));
  await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.tenantId, id("t")));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, id("t")));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, id("t")));
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, id("t")));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, id("t")));
}

/** Candidates spread across stages so the cumulative funnel steps down. */
const STAGE_PLAN: Array<{ stage: string; n: number }> = [
  { stage: "sourced", n: 3 },
  { stage: "applied", n: 2 },
  { stage: "interview_completed", n: 2 },
  { stage: "hired", n: 1 },
];

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("t"), name: "Structural Invariants Tenant", slug: id("t"), plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("tadmin"), tenantId: id("t"), email: id("tadmin") + "@t.test", name: "TAdmin", passwordHash: "x", role: "tenant_admin", status: "active" },
    { id: id("recr"), tenantId: id("t"), email: id("recr") + "@t.test", name: "Recr", passwordHash: "x", role: "recruiter", status: "active" },
  ]);

  await dbAdmin.insert(jobsTable).values([
    { id: id("jobA"), tenantId: id("t"), title: "Job A", description: "desc", status: "active", assignedRecruiterId: id("recr") },
  ]);

  const now = new Date();
  const cands: any[] = [];
  const apps: any[] = [];
  const sessions: any[] = [];
  const events: any[] = [];
  const outcomes: any[] = [];
  const intel: any[] = [];

  let k = 0;
  for (const { stage, n } of STAGE_PLAN) {
    for (let i = 0; i < n; i++) {
      const cid = id(`c${k}`);
      const aid = id(`a${k}`);
      cands.push({ id: cid, tenantId: id("t"), firstName: "Cand", lastName: String(k), email: cid + "@t.test", pool: "tenant", source: "linkedin" });
      apps.push({ id: aid, tenantId: id("t"), jobId: id("jobA"), candidateId: cid, stage, entryType: "applied", createdAt: now });
      // Interviewed + hired candidates get a completed, scored session so the
      // interview / score-distribution surfaces return real numbers.
      if (stage === "interview_completed" || stage === "hired") {
        sessions.push({ id: id(`is${k}`), tenantId: id("t"), applicationId: aid, planId: "plan", candidateId: cid, jobId: id("jobA"), status: "completed", totalQuestions: 2, score: 85, completedAt: now });
        events.push({ tenantId: id("t"), jobId: id("jobA"), candidateId: cid, applicationId: aid, eventType: "INTERVIEW_COMPLETED", eventTimestamp: now });
      }
      if (stage === "hired") {
        outcomes.push({ tenantId: id("t"), applicationId: aid, candidateId: cid, jobId: id("jobA"), outcome: "hired" });
      }
      intel.push({ tenantId: id("t"), jobId: id("jobA"), candidateId: cid, hireProbability: 80 });
      k++;
    }
  }

  await dbAdmin.insert(candidatesTable).values(cands);
  await dbAdmin.insert(applicationsTable).values(apps);
  if (sessions.length) await dbAdmin.insert(interviewSessionsTable).values(sessions);
  if (events.length) await dbAdmin.insert(candidateEventsTable).values(events);
  if (outcomes.length) await dbAdmin.insert(candidateOutcomesTable).values(outcomes);
  await dbAdmin.insert(candidateJobIntelligenceTable).values(intel);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(analyticsRouter);
  app.use(recruiterPerformanceRouter);
  app.use(outcomesRouter);
  app.use("/intelligence", intelligenceRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

/* ─── 1. Funnel monotonicity ──────────────────────────────────────────────────
 * The funnel is cumulative (reached-stage-or-beyond), so counts must never rise
 * as you descend the stage order. */
test("funnel stage counts are monotonically non-increasing down the stage order", async () => {
  const r = await api("GET", "/analytics/funnel", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const stages: Array<{ stage: string; count: number }> = r.json.stages;
  assert.ok(Array.isArray(stages) && stages.length > 0, "funnel must return stages");
  // Pin the stage order so an accidental stage removal/reorder (which would
  // silently invalidate the "down the stage order" premise) fails loudly here.
  assert.deepEqual(
    stages.map(s => s.stage),
    ["Sourced", "Applied", "Screening", "Interviewed", "HM Review", "Offer Extended", "Offer Accepted", "Hired", "Started"],
    "funnel must return the canonical stage order",
  );
  // Guard against a trivial all-zero pass: with candidates seeded across stages,
  // the top-of-funnel bar must be populated AND the funnel must actually descend.
  assert.ok(stages[0].count > 0, "top-of-funnel (Sourced) must be populated by the fixture");
  assert.ok(stages[0].count > stages[stages.length - 1].count, "fixture must produce a descending funnel, not a flat one");
  for (let i = 1; i < stages.length; i++) {
    assert.ok(
      stages[i].count <= stages[i - 1].count,
      `funnel not monotonic: ${stages[i - 1].stage}(${stages[i - 1].count}) -> ${stages[i].stage}(${stages[i].count})`,
    );
  }
});

/* ─── 2. No negative counts on any surface ────────────────────────────────────
 * Recursively assert every finite numeric leaf is >= 0. `trendPct` (a signed
 * period-over-period delta, not a count) is the one documented exception. */
const SIGNED_KEYS = new Set(["trendPct"]);

function assertNoNegative(node: unknown, path: string) {
  if (node === null || node === undefined) return;
  if (typeof node === "number") {
    if (Number.isFinite(node)) {
      assert.ok(node >= 0, `${path} returned a negative number: ${node}`);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertNoNegative(v, `${path}[${i}]`));
    return;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (SIGNED_KEYS.has(key)) continue;
      assertNoNegative(value, `${path}.${key}`);
    }
  }
}

const COUNT_SURFACES = [
  "/analytics/overview",
  "/analytics/funnel",
  "/analytics/trend",
  "/analytics/score-distribution",
  "/outcomes/coverage",
  "/intelligence",
  "/analytics/recruiter-performance",
];

for (const surface of COUNT_SURFACES) {
  test(`no count surface returns a negative number — ${surface}`, async () => {
    const r = await api("GET", surface, tAdmin());
    assert.equal(r.status, 200, `${surface} -> ${r.status}: ${JSON.stringify(r.json)}`);
    assert.ok(r.json != null, `${surface} returned no body`);
    assertNoNegative(r.json, surface);
  });
}

/* A minimal populated-fixture sanity check: overview must actually count the
 * seeded candidates, so an accidentally-empty fixture (which would make the
 * no-negative walk vacuously pass) fails loudly. */
test("fixture is populated (overview counts the seeded candidates)", async () => {
  const r = await api("GET", "/analytics/overview", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok((r.json.totalCandidates ?? 0) > 0, "overview.totalCandidates must be > 0 for the seeded fixture");
});
