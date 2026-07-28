/**
 * morning-report.test.ts — CONTRACT TEST for GET /analytics/morning-report
 *
 * Step 1 of the Morning Report is a read-only data contract: the server emits
 * FACTS (which sentence types are non-zero, and their counts), the client
 * renders copy. This test pins that contract:
 *
 *   1. VARIANTS
 *      • welcome — a user who has never seen a report (last_report_seen_at NULL).
 *      • quiet   — a user who has seen one, but nothing is non-zero since then.
 *      • report  — a user who has seen one and ≥1 sentence is non-zero.
 *   2. RECONCILIATION — every count equals its canonical source query run
 *      independently, and the awaiting_decision count reconciles with the REAL
 *      governance queue (GET /applications/pending-human-review) restricted to
 *      compliant candidates.
 *   3. COMPLIANCE SEAL — an erased / do-not-contact candidate appears in NO
 *      sentence, even when it carries the full countable artifact.
 *   4. AUTHZ — a candidate role is refused (403); the /seen write advances the
 *      caller's own watermark and flips the variant.
 *
 * Harness mirrors compliance-no-erased-dnc-in-counts.test.ts: mount the REAL
 * routers on a bare Express app, seed via dbAdmin (BYPASSRLS), drive over HTTP
 * with real bearer tokens.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  pipelineRunsTable,
  pipelineRunEventsTable,
  recruiterInboxTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import analyticsRouter from "./analytics";
import governanceRouter from "./governance";

const P = "mrpt_";
const id = (s: string) => P + s;
const T = id("t"); // main tenant (full fixture)
const T2 = id("t2"); // empty tenant (quiet / welcome / seen)
const T3 = id("t3"); // recruiter-scope tenant (A/B isolation vs admin tenant-wide)
const T4 = id("t4"); // fix_contacts quiet nudge (blocked-only, no news)
const T5 = id("t5"); // source_role quiet nudge (an active role with no candidates)

// Watermark 1h ago; "since" artifacts are 10min ago; "before" artifacts 2h ago.
const WATERMARK = new Date(Date.now() - 3_600_000);
const AFTER = new Date(Date.now() - 600_000);
const BEFORE = new Date(Date.now() - 7_200_000);

// Candidates: a compliant control + a barred variant per candidate-bearing
// sentence type. Barred = erased OR do-not-contact.
const C = {
  aOk: id("aOk"), aErased: id("aErased"), aDnc: id("aDnc"),   // awaiting_decision
  bOk: id("bOk"), bErased: id("bErased"),                     // blocked_work
  rOk: id("rOk"), rErased: id("rErased"),                     // replies_events
};

let server: Server;
let baseUrl: string;

function tok(userId: string, role: string, tenantId: string) {
  return issueToken({ userId, role, tenantId });
}
const tAdmin = () => tok(id("tadmin"), "tenant_admin", T);
const t2Admin = () => tok(id("t2admin"), "tenant_admin", T2);
const t2Welcome = () => tok(id("t2welcome"), "tenant_admin", T2);
const t2Seen = () => tok(id("t2seen"), "tenant_admin", T2);
const candTok = () => tok(id("candUser"), "candidate", T);
// Recruiter-scope tenant: an admin (tenant-wide), two recruiters each assigned a
// disjoint req, and a recruiter with no assignments (no scope at all).
const t3Admin = () => tok(id("t3admin"), "tenant_admin", T3);
const recA = () => tok(id("recA"), "recruiter", T3);
const recB = () => tok(id("recB"), "recruiter", T3);
const recNone = () => tok(id("recNone"), "recruiter", T3);
const t4Admin = () => tok(id("t4admin"), "tenant_admin", T4);
const t5Admin = () => tok(id("t5admin"), "tenant_admin", T5);

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function sentence(report: any, type: string) {
  return (report.sentences ?? []).find((s: any) => s.sentenceType === type);
}

async function cleanup() {
  for (const t of [T, T2, T3, T4, T5]) {
    await dbAdmin.delete(recruiterInboxTable).where(eq(recruiterInboxTable.tenantId, t));
    await dbAdmin.delete(pipelineRunEventsTable).where(eq(pipelineRunEventsTable.tenantId, t));
    await dbAdmin.delete(pipelineRunsTable).where(eq(pipelineRunsTable.tenantId, t));
    await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.tenantId, t));
    await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, t));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, t));
    await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, t));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, t));
  }
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: T, name: "Morning Report Tenant", slug: T, plan: "enterprise" },
    { id: T2, name: "Empty Tenant", slug: T2, plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    // Main admin: has seen a report (watermark set) → report/quiet eligible.
    { id: id("tadmin"), tenantId: T, email: id("tadmin") + "@t.test", name: "TAdmin", passwordHash: "x", role: "tenant_admin", status: "active", lastReportSeenAt: WATERMARK },
    // A candidate user in the main tenant → must be refused (403).
    { id: id("candUser"), tenantId: T, email: id("candUser") + "@t.test", name: "Cand User", passwordHash: "x", role: "candidate", status: "active" },
    // Empty-tenant admins: one seen (quiet), one never-seen (welcome), one for /seen.
    { id: id("t2admin"), tenantId: T2, email: id("t2admin") + "@t.test", name: "T2Admin", passwordHash: "x", role: "tenant_admin", status: "active", lastReportSeenAt: WATERMARK },
    { id: id("t2welcome"), tenantId: T2, email: id("t2welcome") + "@t.test", name: "T2New", passwordHash: "x", role: "tenant_admin", status: "active", lastReportSeenAt: null },
    { id: id("t2seen"), tenantId: T2, email: id("t2seen") + "@t.test", name: "T2Seen", passwordHash: "x", role: "tenant_admin", status: "active", lastReportSeenAt: null },
  ]);

  await dbAdmin.insert(jobsTable).values([
    { id: id("jobA"), tenantId: T, title: "Job A", description: "desc", status: "active" },
  ]);

  await dbAdmin.insert(candidatesTable).values([
    { id: C.aOk, tenantId: T, firstName: "A", lastName: "Ok", email: C.aOk + "@t.test", pool: "tenant", source: "linkedin" },
    { id: C.aErased, tenantId: T, firstName: "A", lastName: "Erased", email: C.aErased + "@t.test", pool: "tenant", source: "linkedin", dataErasedAt: new Date() },
    { id: C.aDnc, tenantId: T, firstName: "A", lastName: "Dnc", email: C.aDnc + "@t.test", pool: "tenant", source: "linkedin", doNotContact: true },
    // Blocked: non-deliverable placeholder emails.
    { id: C.bOk, tenantId: T, firstName: "B", lastName: "Ok", email: C.bOk + "@unknown.local", pool: "tenant", source: "import" },
    { id: C.bErased, tenantId: T, firstName: "B", lastName: "Erased", email: C.bErased + "@import.local", pool: "tenant", source: "import", dataErasedAt: new Date() },
    // Replies.
    { id: C.rOk, tenantId: T, firstName: "R", lastName: "Ok", email: C.rOk + "@t.test", pool: "tenant", source: "linkedin" },
    { id: C.rErased, tenantId: T, firstName: "R", lastName: "Erased", email: C.rErased + "@t.test", pool: "tenant", source: "linkedin", doNotContact: true },
  ]);

  const app = (c: string) => id("app_" + c);
  // awaiting_decision: aiRecommendation set + finalDecision NULL (3, but only aOk compliant).
  // blocked_work: placeholder-email candidates need an application to be "in pipeline".
  await dbAdmin.insert(applicationsTable).values([
    { id: app(C.aOk), tenantId: T, jobId: id("jobA"), candidateId: C.aOk, stage: "screening", aiRecommendation: "advance", aiRecommendationAt: AFTER },
    { id: app(C.aErased), tenantId: T, jobId: id("jobA"), candidateId: C.aErased, stage: "screening", aiRecommendation: "advance", aiRecommendationAt: AFTER },
    { id: app(C.aDnc), tenantId: T, jobId: id("jobA"), candidateId: C.aDnc, stage: "screening", aiRecommendation: "advance", aiRecommendationAt: AFTER },
    { id: app(C.bOk), tenantId: T, jobId: id("jobA"), candidateId: C.bOk, stage: "sourced" },
    { id: app(C.bErased), tenantId: T, jobId: id("jobA"), candidateId: C.bErased, stage: "sourced" },
  ]);

  // pipeline_runs. Two failures + one interruption SINCE watermark (→ 2 counted
  // once we include both statuses), one failure BEFORE (excluded by time).
  await dbAdmin.insert(pipelineRunsTable).values([
    { id: id("runFail"), tenantId: T, jobId: id("jobA"), status: "failed", startedAt: AFTER, completedAt: AFTER },
    { id: id("runInt"), tenantId: T, jobId: id("jobA"), status: "interrupted", startedAt: AFTER, completedAt: AFTER },
    { id: id("runFailOld"), tenantId: T, jobId: id("jobA"), status: "failed", startedAt: BEFORE, completedAt: BEFORE },
    // completed SINCE watermark (counts) + completed BEFORE (excluded).
    { id: id("runDone"), tenantId: T, jobId: id("jobA"), status: "completed", startedAt: AFTER, completedAt: AFTER },
    { id: id("runDoneOld"), tenantId: T, jobId: id("jobA"), status: "completed", startedAt: BEFORE, completedAt: BEFORE },
  ]);

  // Sourcing step_completed events: runDone adds 5 (counted); runDoneOld adds 99
  // (must NOT be summed — its run is before the watermark).
  await dbAdmin.insert(pipelineRunEventsTable).values([
    { tenantId: T, runId: id("runDone"), seq: 1, type: "step_completed", stepName: "sourcing", message: "sourced", count: 5 },
    { tenantId: T, runId: id("runDoneOld"), seq: 1, type: "step_completed", stepName: "sourcing", message: "sourced", count: 99 },
  ]);

  // recruiter_inbox: rOk positive + rOk question SINCE watermark (2 replies, 1
  // interested); rErased positive SINCE (excluded by compliance); rOk negative
  // BEFORE (excluded by time).
  await dbAdmin.insert(recruiterInboxTable).values([
    { tenantId: T, candidateId: C.rOk, campaignId: "camp1", type: "positive_reply", subject: "s", preview: "p", receivedAt: AFTER },
    { tenantId: T, candidateId: C.rOk, campaignId: "camp1", type: "question", subject: "s", preview: "p", receivedAt: AFTER },
    { tenantId: T, candidateId: C.rErased, campaignId: "camp1", type: "positive_reply", subject: "s", preview: "p", receivedAt: AFTER },
    { tenantId: T, candidateId: C.rOk, campaignId: "camp1", type: "negative_reply", subject: "s", preview: "p", receivedAt: BEFORE },
  ]);

  /* ── T3: RECRUITER-SCOPE ISOLATION ─────────────────────────────────────────
   * recA and recB each own ONE disjoint req. recA's report must contain zero of
   * recB's items and vice-versa; the tenant admin sees both. recNone has no
   * assignment → no scope at all → quiet with rolesActive 0. */
  await dbAdmin.insert(tenantsTable).values([
    { id: T3, name: "Recruiter Scope Tenant", slug: T3, plan: "enterprise" },
    { id: T4, name: "Fix Contacts Tenant", slug: T4, plan: "enterprise" },
    { id: T5, name: "Source Role Tenant", slug: T5, plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("t3admin"), tenantId: T3, email: id("t3admin") + "@t.test", name: "T3Admin", passwordHash: "x", role: "tenant_admin", status: "active", lastReportSeenAt: WATERMARK },
    { id: id("recA"), tenantId: T3, email: id("recA") + "@t.test", name: "Rec A", passwordHash: "x", role: "recruiter", status: "active", lastReportSeenAt: WATERMARK },
    { id: id("recB"), tenantId: T3, email: id("recB") + "@t.test", name: "Rec B", passwordHash: "x", role: "recruiter", status: "active", lastReportSeenAt: WATERMARK },
    { id: id("recNone"), tenantId: T3, email: id("recNone") + "@t.test", name: "Rec None", passwordHash: "x", role: "recruiter", status: "active", lastReportSeenAt: WATERMARK },
    { id: id("t4admin"), tenantId: T4, email: id("t4admin") + "@t.test", name: "T4Admin", passwordHash: "x", role: "tenant_admin", status: "active", lastReportSeenAt: WATERMARK },
    { id: id("t5admin"), tenantId: T5, email: id("t5admin") + "@t.test", name: "T5Admin", passwordHash: "x", role: "tenant_admin", status: "active", lastReportSeenAt: WATERMARK },
  ]);

  await dbAdmin.insert(jobsTable).values([
    { id: id("jobA3"), tenantId: T3, title: "Job A3", description: "desc", status: "active", assignedRecruiterId: id("recA") },
    { id: id("jobB3"), tenantId: T3, title: "Job B3", description: "desc", status: "active", assignedRecruiterId: id("recB") },
    { id: id("jobA4"), tenantId: T4, title: "Job A4", description: "desc", status: "active" },
    { id: id("jobA5"), tenantId: T5, title: "Job A5", description: "desc", status: "active" },
  ]);

  await dbAdmin.insert(candidatesTable).values([
    { id: id("cA3"), tenantId: T3, firstName: "Ca", lastName: "Three", email: id("cA3") + "@t.test", pool: "tenant", source: "linkedin" },
    { id: id("cB3"), tenantId: T3, firstName: "Cb", lastName: "Three", email: id("cB3") + "@t.test", pool: "tenant", source: "linkedin" },
    // T4 blocked candidate: in-pipeline but non-deliverable email.
    { id: id("cBlk4"), tenantId: T4, firstName: "Cblk", lastName: "Four", email: id("cBlk4") + "@unknown.local", pool: "tenant", source: "import" },
  ]);

  await dbAdmin.insert(applicationsTable).values([
    // awaiting_decision on each recruiter's own req (disjoint).
    { id: id("app_cA3"), tenantId: T3, jobId: id("jobA3"), candidateId: id("cA3"), stage: "screening", aiRecommendation: "advance", aiRecommendationAt: AFTER },
    { id: id("app_cB3"), tenantId: T3, jobId: id("jobB3"), candidateId: id("cB3"), stage: "screening", aiRecommendation: "advance", aiRecommendationAt: AFTER },
    // T4: blocked candidate must be in-pipeline to count as blocked_work.
    { id: id("app_cBlk4"), tenantId: T4, jobId: id("jobA4"), candidateId: id("cBlk4"), stage: "sourced" },
    // T5 (jobA5) intentionally has NO applications → source_role nudge.
  ]);

  // A reply that belongs to recB's candidate only — must NOT surface for recA.
  await dbAdmin.insert(recruiterInboxTable).values([
    { tenantId: T3, candidateId: id("cB3"), campaignId: "camp3", type: "positive_reply", subject: "s", preview: "p", receivedAt: AFTER },
  ]);

  // Run-derived sentences must isolate by recruiter scope too: a COMPLETED run
  // on recA's req (jobA3) and a FAILED run on recB's req (jobB3). recA must see
  // completed_work but not interrupted_failed; recB the inverse; admin sees both.
  await dbAdmin.insert(pipelineRunsTable).values([
    { id: id("runDone3"), tenantId: T3, jobId: id("jobA3"), status: "completed", startedAt: AFTER, completedAt: AFTER },
    { id: id("runFail3"), tenantId: T3, jobId: id("jobB3"), status: "failed", startedAt: AFTER, completedAt: AFTER },
  ]);
  await dbAdmin.insert(pipelineRunEventsTable).values([
    { tenantId: T3, runId: id("runDone3"), seq: 1, type: "step_completed", stepName: "sourcing", message: "sourced", count: 7 },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(analyticsRouter);
  app.use(governanceRouter);
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

/* ─── VARIANT: welcome ─────────────────────────────────────────────────────── */
test("welcome variant when the user has never seen a report", async () => {
  const r = await api("GET", "/analytics/morning-report", t2Welcome());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.variant, "welcome");
  assert.equal(r.json.sinceLastSeen, null);
  assert.deepEqual(r.json.sentences, []);
  assert.ok(typeof r.json.generatedAt === "string");
  // Step 3 onboarding fields: T2 has no jobs → 0 roles set up; the nudge points
  // the newcomer at their work orders to run sourcing.
  assert.equal(r.json.rolesSetUp, 0, "empty tenant has no roles set up");
  assert.equal(r.json.nextAction.type, "run_sourcing");
  assert.equal(r.json.nextAction.linkTarget.view, "work_orders");
});

/* ─── VARIANT: quiet ───────────────────────────────────────────────────────── */
test("quiet variant when seen but nothing is non-zero in scope", async () => {
  const r = await api("GET", "/analytics/morning-report", t2Admin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.variant, "quiet");
  assert.ok(typeof r.json.sinceLastSeen === "string");
  assert.deepEqual(r.json.sentences, []);
  // Step 3 fields: empty tenant has no active roles and nothing to nudge.
  assert.equal(r.json.rolesActive, 0);
  assert.equal(r.json.nextAction, null);
});

/* ─── VARIANT: report + all five sentence counts ───────────────────────────── */
test("report variant returns every non-zero sentence with canonical counts, rank-sorted", async () => {
  const r = await api("GET", "/analytics/morning-report", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.variant, "report");
  assert.ok(typeof r.json.sinceLastSeen === "string");

  // Sorted by rank ascending.
  const ranks = r.json.sentences.map((s: any) => s.rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "sentences must be rank-sorted");

  const dec = sentence(r.json, "awaiting_decision");
  assert.ok(dec, "awaiting_decision sentence present");
  assert.equal(dec.count, 1, "awaiting_decision must exclude erased + DNC");
  assert.equal(dec.rank, 1);
  assert.equal(dec.textParams.count, 1);

  const blocked = sentence(r.json, "blocked_work");
  assert.ok(blocked, "blocked_work sentence present");
  assert.equal(blocked.count, 1, "blocked_work must exclude the erased placeholder candidate");
  assert.equal(blocked.rank, 2);

  const failed = sentence(r.json, "interrupted_failed");
  assert.ok(failed, "interrupted_failed sentence present");
  assert.equal(failed.count, 2, "failed + interrupted since watermark, old failure excluded");
  assert.equal(failed.rank, 3);

  const done = sentence(r.json, "completed_work");
  assert.ok(done, "completed_work sentence present");
  assert.equal(done.count, 1, "one completed run since watermark (old one excluded)");
  assert.equal(done.textParams.candidatesAdded, 5, "sourcing event count summed for in-window runs only (99 excluded)");
  assert.equal(done.rank, 4);

  const replies = sentence(r.json, "replies_events");
  assert.ok(replies, "replies_events sentence present");
  assert.equal(replies.count, 2, "2 replies since watermark (erased + before-watermark excluded)");
  assert.equal(replies.textParams.interested, 1, "only the positive_reply is interested");
  assert.equal(replies.rank, 5);
});

/* ─── RECONCILIATION with the real governance queue ────────────────────────── */
test("awaiting_decision reconciles exactly with the pending-human-review queue", async () => {
  const report = await api("GET", "/analytics/morning-report", tAdmin());
  const dec = sentence(report.json, "awaiting_decision");

  const queue = await api("GET", "/applications/pending-human-review", tAdmin());
  assert.equal(queue.status, 200, JSON.stringify(queue.json));

  // Both surfaces now apply the same compliance seal, so the report count must
  // equal the live queue length exactly — no compliant-subset filtering needed.
  assert.equal(dec.count, queue.json.length, "report review count must equal the live queue length exactly");

  // The seal must also hold at the source: no erased/DNC app appears in the queue.
  const barredAppIds = new Set([id("app_" + C.aErased), id("app_" + C.aDnc)]);
  assert.ok(!queue.json.some((row: any) => barredAppIds.has(row.applicationId)), "no barred app may appear in the governance queue");
  assert.ok(queue.json.some((row: any) => row.applicationId === id("app_" + C.aOk)), "the compliant app must be in the queue");
});

/* ─── COMPLIANCE SEAL: erased/DNC in NO sentence ───────────────────────────── */
test("no barred candidate leaks into any sentence count", async () => {
  const r = await api("GET", "/analytics/morning-report", tAdmin());
  // Every candidate-bearing sentence reflects only the compliant control.
  assert.equal(sentence(r.json, "awaiting_decision").count, 1);
  assert.equal(sentence(r.json, "blocked_work").count, 1);
  assert.equal(sentence(r.json, "replies_events").count, 2);
  assert.equal(sentence(r.json, "replies_events").textParams.interested, 1);
});

/* ─── AUTHZ: candidates refused ────────────────────────────────────────────── */
test("candidate role is refused", async () => {
  const r = await api("GET", "/analytics/morning-report", candTok());
  assert.equal(r.status, 403);
  const w = await api("POST", "/analytics/morning-report/seen", candTok(), {});
  assert.equal(w.status, 403);
});

/* ─── /seen advances the watermark and flips the variant ───────────────────── */
test("POST /seen advances the caller's watermark (welcome → quiet)", async () => {
  const before = await api("GET", "/analytics/morning-report", t2Seen());
  assert.equal(before.json.variant, "welcome");

  const w = await api("POST", "/analytics/morning-report/seen", t2Seen(), {});
  assert.equal(w.status, 200, JSON.stringify(w.json));
  assert.equal(w.json.ok, true);
  assert.ok(typeof w.json.lastReportSeenAt === "string");

  const after = await api("GET", "/analytics/morning-report", t2Seen());
  assert.equal(after.json.variant, "quiet", "empty tenant with a watermark now → quiet");
  assert.ok(typeof after.json.sinceLastSeen === "string");
});

/* ─── PERFORMANCE: one dashboard round trip, bounded query count ────────────── */
async function countQueries(fn: () => Promise<void>): Promise<number> {
  const orig = (pool as any).query.bind(pool);
  let n = 0;
  (pool as any).query = (...args: any[]) => { n++; return orig(...args); };
  try { await fn(); } finally { (pool as any).query = orig; }
  return n;
}

test("report is one dashboard round trip with a bounded query count", async () => {
  const n = await countQueries(async () => {
    const r = await api("GET", "/analytics/morning-report", tAdmin());
    assert.equal(r.json.variant, "report");
  });
  console.log(`[qcount] tenant_admin report path = ${n} queries`);
  // The report handler issues 5 data queries (subtree scope, review, blocked,
  // runs+events merged, replies); resolveUser adds 2 identity lookups in-test
  // (user row + tenant region, since test tokens carry no region claim — it is 1
  // in production where the login mints the claim). Guard against a regression
  // that reintroduces a per-sentence fan-out.
  assert.ok(n <= 8, `expected a consolidated query count, got ${n}`);
});

/* ─── RECRUITER SCOPE: A/B isolation vs admin tenant-wide ───────────────────── */
test("recruiter A's report contains zero items from recruiter B's reqs", async () => {
  const a = await api("GET", "/analytics/morning-report", recA());
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.variant, "report");
  // recA owns jobA3 only: exactly one awaiting decision (cA3), and NO reply —
  // the only reply belongs to cB3 on recB's req.
  assert.equal(sentence(a.json, "awaiting_decision").count, 1, "recA sees only its own req's review item");
  assert.equal(sentence(a.json, "replies_events"), undefined, "recA must not see recB's candidate's reply");

  const b = await api("GET", "/analytics/morning-report", recB());
  assert.equal(b.json.variant, "report");
  assert.equal(sentence(b.json, "awaiting_decision").count, 1, "recB sees only its own req's review item");
  assert.equal(sentence(b.json, "replies_events").count, 1, "recB sees its own candidate's reply");
});

test("tenant admin sees the whole tenant, recruiters only their slice", async () => {
  const admin = await api("GET", "/analytics/morning-report", t3Admin());
  assert.equal(admin.json.variant, "report");
  // Admin is tenant-wide: BOTH reqs' review items + the one reply.
  assert.equal(sentence(admin.json, "awaiting_decision").count, 2, "admin sees both reqs' review items");
  assert.equal(sentence(admin.json, "replies_events").count, 1);

  // A recruiter with no assignments has no scope at all → quiet, no roles.
  const none = await api("GET", "/analytics/morning-report", recNone());
  assert.equal(none.json.variant, "quiet", "unassigned recruiter has no scope → quiet");
  assert.equal(none.json.rolesActive, 0);
  assert.equal(none.json.nextAction, null);
});

test("run-derived sentences isolate by recruiter scope", async () => {
  // recA owns the COMPLETED run (jobA3), recB owns the FAILED run (jobB3).
  const a = await api("GET", "/analytics/morning-report", recA());
  const aDone = sentence(a.json, "completed_work");
  assert.ok(aDone, "recA sees its own completed run");
  assert.equal(aDone.count, 1);
  assert.equal(aDone.textParams.candidatesAdded, 7, "candidatesAdded is recA's run only, not recB's");
  assert.equal(sentence(a.json, "interrupted_failed"), undefined, "recA must not see recB's failed run");

  const b = await api("GET", "/analytics/morning-report", recB());
  assert.equal(sentence(b.json, "interrupted_failed").count, 1, "recB sees its own failed run");
  assert.equal(sentence(b.json, "completed_work"), undefined, "recB must not see recA's completed run");

  // Admin is tenant-wide: both run-derived sentences, with recA's added count.
  const admin = await api("GET", "/analytics/morning-report", t3Admin());
  assert.equal(sentence(admin.json, "completed_work").textParams.candidatesAdded, 7);
  assert.equal(sentence(admin.json, "interrupted_failed").count, 1);
});

/* ─── QUIET nudges derived from current state ──────────────────────────────── */
test("quiet fix_contacts nudge when the only condition is blocked contacts", async () => {
  const r = await api("GET", "/analytics/morning-report", t4Admin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // blocked_work alone is a standing condition, not news → still quiet.
  assert.equal(r.json.variant, "quiet");
  assert.deepEqual(r.json.sentences, []);
  assert.equal(r.json.rolesActive, 1, "one active role in the tenant");
  assert.equal(r.json.nextAction.type, "fix_contacts");
  assert.equal(r.json.nextAction.count, 1);
  assert.equal(r.json.nextAction.linkTarget.view, "pipeline_blocked");
});

test("quiet source_role nudge when an active role has no candidates", async () => {
  const r = await api("GET", "/analytics/morning-report", t5Admin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.variant, "quiet");
  assert.equal(r.json.rolesActive, 1);
  assert.equal(r.json.nextAction.type, "source_role");
  assert.equal(r.json.nextAction.roleTitle, "Job A5");
  assert.equal(r.json.nextAction.linkTarget.view, "role");
  assert.equal(r.json.nextAction.linkTarget.params.jobId, id("jobA5"));
});
