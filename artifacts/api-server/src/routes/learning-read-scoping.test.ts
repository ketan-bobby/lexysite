/**
 * learning-read-scoping.test.ts — Auth + tenant scoping for the learning
 * analytics READ routes.
 *
 * Covers the security fix for the five cross-tenant analytics GETs:
 *   GET /learning/source-quality
 *   GET /learning/score-correlation
 *   GET /learning/agent-coverage
 *   GET /learning/recommendations
 *   GET /learning/predicted-vs-actual
 *
 * All five read `candidate_job_intelligence`, which is NOT an RLS-protected
 * table (it is absent from every RLS migration). Before the fix the handlers
 * ran an unscoped `db` query and returned platform-wide aggregates to ANY
 * authenticated caller — a cross-tenant leak of learned hiring signal. The fix
 * resolves the caller, enforces the recruiter-class STAFF_ROLES allowlist, and
 * applies an explicit `candidate_job_intelligence.tenant_id` predicate derived
 * from getAllowedTenantIds (null ⇒ platform sees all; otherwise the caller's
 * tenant subtree).
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * The scoping under test is APP-layer (an explicit tenant predicate), not
 * Postgres RLS. So we mount the REAL learning router on a bare Express app, seed
 * two unrelated tenants via `dbAdmin` (BYPASSRLS), issue real bearer tokens, and
 * hit the routes over HTTP. Outside withTenantContext the `db` proxy falls
 * through to dbAdmin, so RLS never filters — isolating the app-layer predicate:
 * if scoping still holds here, it is the predicate doing the work, not RLS.
 *
 * ─── Fixture (all ids prefixed `lrs_` for safe teardown) ─────────────────────
 *   tenantA / tenantB  — two unrelated top-level tenants
 *   adminA  — tenant_admin in tenantA   (recruiter-class → allowed)
 *   candA   — candidate  in tenantA     (excluded role → 403)
 *   pAdmin  — platform_admin            (allowed=null → sees ALL tenants)
 *
 * tenantA has 3 intelligence rows (all with outcomes, source "linkedin");
 * tenantB has 2 intelligence rows (all with outcomes, source "referral"). Every
 * aggregate endpoint exposes a count/discriminator we assert against so tenantA
 * reflects ONLY its 3 rows while pAdmin reflects all 5.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  candidateJobIntelligenceTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import learningRouter from "./learning";

const P = "lrs_";
const id = (s: string) => P + s;

const TENANT_IDS = ["tenantA", "tenantB"].map(id);
const USER_IDS = ["adminA", "candA", "pAdmin"].map(id);

// Test-unique candidate source labels — collision-proof against this env's
// pre-existing intelligence rows so the per-source bucket assertions stay hermetic.
const SRC_A = id("src_a");
const SRC_B = id("src_b");

let server: Server;
let baseUrl: string;

const tok = {
  adminA: () => issueToken({ userId: id("adminA"), role: "tenant_admin", tenantId: id("tenantA") }),
  candA: () => issueToken({ userId: id("candA"), role: "candidate", tenantId: id("tenantA") }),
  pAdmin: () => issueToken({ userId: id("pAdmin"), role: "platform_admin", tenantId: id("tenantA") }),
};

async function api(
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(candidateJobIntelligenceTable).where(inArray(candidateJobIntelligenceTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, USER_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("tenantA"), name: "LRS Tenant A", slug: id("tenantA"), plan: "enterprise" },
    { id: id("tenantB"), name: "LRS Tenant B", slug: id("tenantB"), plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("adminA"), tenantId: id("tenantA"), email: id("adminA") + "@t.test", name: "Admin A", passwordHash: "x", role: "tenant_admin" },
    { id: id("candA"), tenantId: id("tenantA"), email: id("candA") + "@t.test", name: "Cand A", passwordHash: "x", role: "candidate" },
    { id: id("pAdmin"), tenantId: id("tenantA"), email: id("pAdmin") + "@t.test", name: "P Admin", passwordHash: "x", role: "platform_admin" },
  ]);

  await dbAdmin.insert(jobsTable).values([
    { id: id("jobA"), tenantId: id("tenantA"), title: "Job A", description: "desc", status: "active" },
    { id: id("jobB"), tenantId: id("tenantB"), title: "Job B", description: "desc", status: "active" },
  ]);

  // Distinctive, test-unique source labels so the per-source buckets can never
  // collide with this env's pre-existing intelligence rows (hermetic assertions).
  await dbAdmin.insert(candidatesTable).values([
    { id: id("candA1"), tenantId: id("tenantA"), firstName: "A", lastName: "1", email: id("candA1") + "@t.test", currentTitle: "Engineer", pool: "tenant", source: SRC_A },
    { id: id("candA2"), tenantId: id("tenantA"), firstName: "A", lastName: "2", email: id("candA2") + "@t.test", currentTitle: "Engineer", pool: "tenant", source: SRC_A },
    { id: id("candA3"), tenantId: id("tenantA"), firstName: "A", lastName: "3", email: id("candA3") + "@t.test", currentTitle: "Engineer", pool: "tenant", source: SRC_A },
    { id: id("candB1"), tenantId: id("tenantB"), firstName: "B", lastName: "1", email: id("candB1") + "@t.test", currentTitle: "Engineer", pool: "tenant", source: SRC_B },
    { id: id("candB2"), tenantId: id("tenantB"), firstName: "B", lastName: "2", email: id("candB2") + "@t.test", currentTitle: "Engineer", pool: "tenant", source: SRC_B },
  ]);

  // Varied scores + real outcomes so score-correlation / predicted-vs-actual run.
  await dbAdmin.insert(candidateJobIntelligenceTable).values([
    { id: id("intelA1"), tenantId: id("tenantA"), jobId: id("jobA"), candidateId: id("candA1"), outcome: "hired",   fitScore: 90, qualityScore: 85, trustScore: 80, conversionScore: 75, hireProbability: 88, nextBestAction: "advance" },
    { id: id("intelA2"), tenantId: id("tenantA"), jobId: id("jobA"), candidateId: id("candA2"), outcome: "rejected", fitScore: 40, qualityScore: 45, trustScore: 50, conversionScore: 42, hireProbability: 35, nextBestAction: "reject" },
    { id: id("intelA3"), tenantId: id("tenantA"), jobId: id("jobA"), candidateId: id("candA3"), outcome: "hired",   fitScore: 70, qualityScore: 65, trustScore: 60, conversionScore: 68, hireProbability: 72, nextBestAction: "advance" },
    { id: id("intelB1"), tenantId: id("tenantB"), jobId: id("jobB"), candidateId: id("candB1"), outcome: "hired",   fitScore: 95, qualityScore: 92, trustScore: 90, conversionScore: 88, hireProbability: 94, nextBestAction: "advance" },
    { id: id("intelB2"), tenantId: id("tenantB"), jobId: id("jobB"), candidateId: id("candB2"), outcome: "rejected", fitScore: 30, qualityScore: 35, trustScore: 33, conversionScore: 31, hireProbability: 28, nextBestAction: "reject" },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use("/learning", learningRouter);
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

const PATHS = [
  "/learning/source-quality",
  "/learning/score-correlation",
  "/learning/agent-coverage",
  "/learning/recommendations",
  "/learning/predicted-vs-actual",
];

/* ── 1. No token → 401 (every fixed handler) ─────────────────────────────── */
for (const path of PATHS) {
  test(`GET ${path} without a token → 401`, async () => {
    const { status } = await api("GET", path);
    assert.equal(status, 401);
  });
}

/* ── 2. Candidate role → 403 (recruiter-class allowlist) ─────────────────── */
for (const path of PATHS) {
  test(`GET ${path} as a candidate → 403`, async () => {
    const { status } = await api("GET", path, tok.candA());
    assert.equal(status, 403);
  });
}

/* ── 3a. source-quality: tenantA sees ONLY its own source bucket ─────────── */
test("source-quality: tenantA sees only its own source bucket, never tenantB's", async () => {
  const { status, json } = await api("GET", "/learning/source-quality", tok.adminA());
  assert.equal(status, 200);
  const bySource = new Map<string, any>((json.data ?? []).map((d: any) => [d.source, d]));
  assert.ok(bySource.has(SRC_A), "tenantA's source bucket present");
  assert.equal(bySource.get(SRC_A).total, 3, "exactly tenantA's 3 rows");
  assert.ok(!bySource.has(SRC_B), "tenantB's source bucket must NOT leak");
});

test("source-quality: platform_admin sees BOTH tenants' source buckets", async () => {
  const { status, json } = await api("GET", "/learning/source-quality", tok.pAdmin());
  assert.equal(status, 200);
  const bySource = new Map<string, any>((json.data ?? []).map((d: any) => [d.source, d]));
  assert.equal(bySource.get(SRC_A)?.total, 3);
  assert.equal(bySource.get(SRC_B)?.total, 2);
});

/* ── 3b. score-correlation: sampleSize scoped ────────────────────────────── */
test("score-correlation: tenantA sampleSize counts only its 3 rows", async () => {
  const { status, json } = await api("GET", "/learning/score-correlation", tok.adminA());
  assert.equal(status, 200);
  assert.equal(json.data.sampleSize, 3, "tenantA's 3 outcome rows only");
});

test("score-correlation: platform_admin sampleSize counts across tenants (> tenantA's 3)", async () => {
  const { status, json } = await api("GET", "/learning/score-correlation", tok.pAdmin());
  assert.equal(status, 200);
  // allowed=null → sees ALL outcome rows incl. any pre-existing in this env.
  assert.ok(json.data.sampleSize >= 5, `expected >=5, got ${json.data.sampleSize}`);
  assert.ok(json.data.sampleSize > 3, "platform sees more than tenantA's scoped 3");
});

/* ── 3c. agent-coverage: totalCandidates scoped ──────────────────────────── */
test("agent-coverage: tenantA totalCandidates counts only its 3 rows", async () => {
  const { status, json } = await api("GET", "/learning/agent-coverage", tok.adminA());
  assert.equal(status, 200);
  assert.equal(json.totalCandidates, 3);
});

test("agent-coverage: platform_admin totalCandidates counts across tenants (> tenantA's 3)", async () => {
  const { status, json } = await api("GET", "/learning/agent-coverage", tok.pAdmin());
  assert.equal(status, 200);
  // allowed=null → sees ALL rows incl. this env's pre-existing intelligence, so
  // assert it strictly exceeds tenantA's scoped 3 and includes our 5 seeded rows.
  assert.ok(json.totalCandidates >= 5, `expected >=5, got ${json.totalCandidates}`);
  assert.ok(json.totalCandidates > 3, "platform sees more than tenantA's scoped 3");
});

/* ── 3d. recommendations: summary.totalRecords scoped ────────────────────── */
test("recommendations: tenantA summary.totalRecords counts only its 3 rows", async () => {
  const { status, json } = await api("GET", "/learning/recommendations", tok.adminA());
  assert.equal(status, 200);
  assert.equal(json.data.summary.totalRecords, 3);
});

test("recommendations: platform_admin summary.totalRecords counts across tenants (> tenantA's 3)", async () => {
  const { status, json } = await api("GET", "/learning/recommendations", tok.pAdmin());
  assert.equal(status, 200);
  assert.ok(json.data.summary.totalRecords >= 5, `expected >=5, got ${json.data.summary.totalRecords}`);
  assert.ok(json.data.summary.totalRecords > 3, "platform sees more than tenantA's scoped 3");
});

/* ── 3e. predicted-vs-actual: totalRecords scoped ────────────────────────── */
test("predicted-vs-actual: tenantA totalRecords counts only its 3 rows", async () => {
  const { status, json } = await api("GET", "/learning/predicted-vs-actual", tok.adminA());
  assert.equal(status, 200);
  assert.equal(json.data.totalRecords, 3);
});

test("predicted-vs-actual: platform_admin totalRecords counts across tenants (> tenantA's 3)", async () => {
  const { status, json } = await api("GET", "/learning/predicted-vs-actual", tok.pAdmin());
  assert.equal(status, 200);
  assert.ok(json.data.totalRecords >= 5, `expected >=5, got ${json.data.totalRecords}`);
  assert.ok(json.data.totalRecords > 3, "platform sees more than tenantA's scoped 3");
});
