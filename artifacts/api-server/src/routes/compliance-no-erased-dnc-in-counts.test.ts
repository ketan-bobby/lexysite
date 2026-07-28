/**
 * compliance-no-erased-dnc-in-counts.test.ts — THE PERMANENT COMPLIANCE SEAL
 *
 * A GDPR-erased candidate (`data_erased_at` set) and a do-not-contact candidate
 * (`do_not_contact = true`) must NEVER appear in ANY analytics/reporting count,
 * no matter how much pipeline artifact they accumulated before being barred.
 * This is a legal invariant (right-to-erasure + DNC), not a cosmetic one.
 *
 * ─── Worst-case leakage fixture ───────────────────────────────────────────────
 * We seed ONE tenant with THREE candidates that are byte-for-byte identical
 * EXCEPT for their compliance flag:
 *
 *   candOk      — compliant CONTROL (no flag)
 *   candErased  — data_erased_at set
 *   candDnc     — do_not_contact = true
 *
 * Each of the three gets the FULL set of countable artifacts — an application at
 * a live stage, a candidate_event, a COMPLETED + SCORED interview_session, a
 * `hired` candidate_outcome, and a candidate_job_intelligence row — i.e. the
 * absolute worst case for a leak on every surface.
 *
 * The CONTROL candidate is the crux of the test: because candOk is fully
 * compliant and fully populated, every surface MUST report exactly 1 (never 0,
 * never 2, never 3). That simultaneously proves:
 *   • the surface DOES count a real, compliant candidate (so an all-zero
 *     false-pass — e.g. a broken query returning nothing — cannot slip through),
 *   • yet counts NEITHER barred fixture.
 *
 * ─── The 7 count surfaces asserted ────────────────────────────────────────────
 *   1. GET /analytics/overview             — totalCandidates / candidatesInPipeline
 *                                            / pipelineEntries / interviewsCompleted KPIs
 *   2. GET /analytics/funnel               — per-stage candidate counts
 *   3. GET /analytics/trend                — monthly applications + interviews
 *   4. GET /analytics/score-distribution   — completed-session score buckets
 *   5. GET /outcomes/coverage              — terminal-outcome (hired) counts
 *   6. GET /intelligence                   — intelligence record list
 *   7. GET /analytics/recruiter-performance— per-recruiter + team KPIs
 *
 * ─── Harness (same as recruiter-ownership-sweep.test.ts) ──────────────────────
 * Mount the REAL analytics / recruiter-performance / outcomes / intelligence
 * routers on a bare Express app exactly as routes/index.ts does, seed via
 * `dbAdmin` (BYPASSRLS), and drive every surface over HTTP with a real bearer
 * token. The caller is a tenant_admin scoped to the test tenant, so every count
 * is naturally confined to our fixture — the only candidates in scope are the
 * three we seeded, making the "must equal 1" assertions exact.
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

const P = "cnedc_";
const id = (s: string) => P + s;

const CAND = { ok: id("candOk"), erased: id("candErased"), dnc: id("candDnc") };
const BARRED = [CAND.erased, CAND.dnc];

let server: Server;
let baseUrl: string;

function tok(userId: string, role: string) {
  return issueToken({ userId, role, tenantId: id("t") });
}
const tAdmin = () => tok(id("tadmin"), "tenant_admin");

async function api(method: string, path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  // FK-safe order, all scoped to the test tenant so any generated-id side rows
  // are swept regardless of id.
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

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("t"), name: "Compliance Seal Tenant", slug: id("t"), plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("tadmin"), tenantId: id("t"), email: id("tadmin") + "@t.test", name: "TAdmin", passwordHash: "x", role: "tenant_admin", status: "active" },
    // A recruiter assigned to the fixture job — gives recruiter-performance a cohort.
    { id: id("recr"), tenantId: id("t"), email: id("recr") + "@t.test", name: "Recr", passwordHash: "x", role: "recruiter", status: "active" },
  ]);

  await dbAdmin.insert(jobsTable).values([
    { id: id("jobA"), tenantId: id("t"), title: "Job A", description: "desc", status: "active", assignedRecruiterId: id("recr") },
  ]);

  // Three candidates, identical except the compliance flag.
  await dbAdmin.insert(candidatesTable).values([
    { id: CAND.ok, tenantId: id("t"), firstName: "Cand", lastName: "Ok", email: CAND.ok + "@t.test", pool: "tenant", source: "linkedin" },
    { id: CAND.erased, tenantId: id("t"), firstName: "Cand", lastName: "Erased", email: CAND.erased + "@t.test", pool: "tenant", source: "linkedin", dataErasedAt: new Date() },
    { id: CAND.dnc, tenantId: id("t"), firstName: "Cand", lastName: "Dnc", email: CAND.dnc + "@t.test", pool: "tenant", source: "linkedin", doNotContact: true },
  ]);

  // One HIRED application per candidate (entry_type applied). We use the hired
  // stage — with DISTINCT time-to-hire per fixture — so the avgTimeToHireDays
  // KPI is exercised: the compliant control took 10 days, each barred candidate
  // took 100 days. A leak would drag the average far from 10, so asserting
  // avgTimeToHireDays === 10 is a genuine exclusion check (identical timings
  // could not distinguish 1 vs 3 rows). The funnel is cumulative
  // (reached-stage-or-beyond), so a hired candidate still counts in every
  // earlier bar exactly as an interview-stage one would.
  const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
  const hundredDaysAgo = new Date(Date.now() - 100 * 86_400_000);
  const app = (cand: string) => id("app_" + cand);
  await dbAdmin.insert(applicationsTable).values([
    { id: app(CAND.ok), tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.ok, stage: "hired", entryType: "applied", createdAt: tenDaysAgo },
    { id: app(CAND.erased), tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.erased, stage: "hired", entryType: "applied", createdAt: hundredDaysAgo },
    { id: app(CAND.dnc), tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.dnc, stage: "hired", entryType: "applied", createdAt: hundredDaysAgo },
  ]);

  // A candidate_event per candidate — proves raw events alone never leak into
  // a recruiter-performance KPI when the candidate is barred.
  const now = new Date();
  await dbAdmin.insert(candidateEventsTable).values([
    { tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.ok, applicationId: app(CAND.ok), eventType: "INTERVIEW_COMPLETED", eventTimestamp: now },
    { tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.erased, applicationId: app(CAND.erased), eventType: "INTERVIEW_COMPLETED", eventTimestamp: now },
    { tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.dnc, applicationId: app(CAND.dnc), eventType: "INTERVIEW_COMPLETED", eventTimestamp: now },
  ]);

  // A COMPLETED + SCORED interview_session per candidate (score 85 → 80-89 bucket).
  // PLUS a terminal *ghosting* session (abandoned/expired) for EACH barred
  // candidate only. The control has a single completed session, so the sealed
  // ghosting rate is 0%. If a barred candidate leaked, its abandoned/expired
  // session would push the ghosting rate above 0 — which is exactly what the
  // ghosting assertion guards against (an all-completed fixture would read 0%
  // whether sealed or leaking, so the barred ghosting sessions are essential).
  await dbAdmin.insert(interviewSessionsTable).values([
    { id: id("is_ok"), tenantId: id("t"), applicationId: app(CAND.ok), planId: "plan", candidateId: CAND.ok, jobId: id("jobA"), status: "completed", totalQuestions: 2, score: 85, completedAt: now },
    { id: id("is_erased"), tenantId: id("t"), applicationId: app(CAND.erased), planId: "plan", candidateId: CAND.erased, jobId: id("jobA"), status: "completed", totalQuestions: 2, score: 85, completedAt: now },
    { id: id("is_dnc"), tenantId: id("t"), applicationId: app(CAND.dnc), planId: "plan", candidateId: CAND.dnc, jobId: id("jobA"), status: "completed", totalQuestions: 2, score: 85, completedAt: now },
    { id: id("is_erased_ghost"), tenantId: id("t"), applicationId: app(CAND.erased), planId: "plan", candidateId: CAND.erased, jobId: id("jobA"), status: "abandoned", totalQuestions: 2 },
    { id: id("is_dnc_ghost"), tenantId: id("t"), applicationId: app(CAND.dnc), planId: "plan", candidateId: CAND.dnc, jobId: id("jobA"), status: "expired", totalQuestions: 2 },
  ]);

  // A terminal `hired` outcome per candidate (candidate_outcomes = enum axis).
  await dbAdmin.insert(candidateOutcomesTable).values([
    { tenantId: id("t"), applicationId: app(CAND.ok), candidateId: CAND.ok, jobId: id("jobA"), outcome: "hired" },
    { tenantId: id("t"), applicationId: app(CAND.erased), candidateId: CAND.erased, jobId: id("jobA"), outcome: "hired" },
    { tenantId: id("t"), applicationId: app(CAND.dnc), candidateId: CAND.dnc, jobId: id("jobA"), outcome: "hired" },
  ]);

  // An intelligence record per candidate.
  await dbAdmin.insert(candidateJobIntelligenceTable).values([
    { tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.ok, hireProbability: 80 },
    { tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.erased, hireProbability: 80 },
    { tenantId: id("t"), jobId: id("jobA"), candidateId: CAND.dnc, hireProbability: 80 },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  // Mounted exactly as routes/index.ts does.
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

/* ─── 1. /analytics/overview ─────────────────────────────────────────────────
 * Candidate, pipeline AND interview-session KPIs must count ONLY the compliant
 * control candidate. */
test("overview KPIs count only the compliant candidate (never the erased/DNC pair)", async () => {
  const r = await api("GET", "/analytics/overview", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.totalCandidates, 1, "totalCandidates must exclude erased + DNC");
  assert.equal(r.json.candidatesInPipeline, 1, "candidatesInPipeline must exclude erased + DNC");
  assert.equal(r.json.pipelineEntries, 1, "pipelineEntries must exclude erased + DNC applications");
  assert.equal(r.json.totalApplications, 1, "totalApplications must exclude erased + DNC applications");
  assert.equal(r.json.interviewsCompleted, 1, "interviewsCompleted must exclude erased + DNC sessions");
  assert.equal(r.json.avgInterviewScore, 85, "avgInterviewScore must be computed over the compliant session only");
  // Only the control (10-day) hire may be averaged; the barred 100-day hires
  // must not drag the number toward 70.
  assert.equal(r.json.avgTimeToHireDays, 10, "avgTimeToHireDays must be computed over the compliant hire only");
  // Control has a single completed session (0% ghosting); the barred
  // abandoned/expired sessions must NOT count into the terminal/ghosted totals.
  assert.equal(r.json.ghostingRatePercent, 0, "ghostingRatePercent must exclude erased + DNC ghosting sessions");
});

/* ─── 2. /analytics/funnel ───────────────────────────────────────────────────
 * Every stage bar counts DISTINCT candidates who reached it — the compliant
 * control reached the hired stage, so it counts in every cumulative bar up to
 * Hired (each reads 1); no bar may ever exceed 1 (a 2 or 3 would mean a barred
 * candidate leaked in). */
test("funnel stage counts never include the erased/DNC pair", async () => {
  const r = await api("GET", "/analytics/funnel", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const stages: Array<{ stage: string; count: number }> = r.json.stages;
  const sourced = stages.find(s => s.stage === "Sourced");
  assert.ok(sourced, "funnel must return a Sourced stage");
  assert.equal(sourced!.count, 1, "Sourced must count only the compliant candidate");
  for (const s of stages) {
    assert.ok(s.count <= 1, `stage ${s.stage} count ${s.count} exceeds 1 — a barred candidate leaked`);
  }
});

/* ─── 3. /analytics/trend ──────────────────────────────────────────────────── */
test("trend monthly applications + interviews never include the erased/DNC pair", async () => {
  const r = await api("GET", "/analytics/trend", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const trend: Array<{ applications: number; interviews: number; hires: number }> = r.json.trend;
  const totalApps = trend.reduce((s, m) => s + m.applications, 0);
  const totalIv = trend.reduce((s, m) => s + m.interviews, 0);
  assert.equal(totalApps, 1, "trend applications must exclude erased + DNC");
  assert.equal(totalIv, 1, "trend interviews must exclude erased + DNC");
});

/* ─── 4. /analytics/score-distribution ───────────────────────────────────────
 * All three sessions score 85, but only the compliant one may be bucketed. */
test("score-distribution buckets never include the erased/DNC pair", async () => {
  const r = await api("GET", "/analytics/score-distribution", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.total, 1, "score-distribution total must exclude erased + DNC sessions");
  const buckets: Array<{ range: string; count: number }> = r.json.distribution;
  const b8089 = buckets.find(b => b.range === "80-89");
  assert.equal(b8089!.count, 1, "the 80-89 bucket must count only the compliant session");
  for (const b of buckets) {
    if (b.range !== "80-89") assert.equal(b.count, 0, `bucket ${b.range} must be empty`);
  }
});

/* ─── 5. /outcomes/coverage ──────────────────────────────────────────────────
 * All three are `hired` outcomes; only the compliant one may be counted. */
test("outcomes coverage hired count never includes the erased/DNC pair", async () => {
  const r = await api("GET", "/outcomes/coverage", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.hires, 1, "coverage.hires must exclude erased + DNC");
  assert.equal(r.json.outcomes.hired, 1, "coverage.outcomes.hired must exclude erased + DNC");
});

/* ─── 6. /intelligence (list) ────────────────────────────────────────────────
 * The list must surface the compliant candidate's record and NEITHER barred
 * candidate's record. */
test("intelligence list never includes the erased/DNC pair", async () => {
  const r = await api("GET", "/intelligence", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ids: string[] = (r.json.data ?? []).map((x: any) => x.candidateId);
  assert.ok(ids.includes(CAND.ok), "intelligence list must include the compliant candidate");
  for (const barred of BARRED) {
    assert.ok(!ids.includes(barred), `intelligence list must NOT include barred candidate ${barred}`);
  }
});

/* ─── 7. /analytics/recruiter-performance ─────────────────────────────────────
 * Per-recruiter candidatesManaged + team totals must count only the compliant
 * candidate on the recruiter's assigned requisition. */
test("recruiter-performance KPIs never include the erased/DNC pair", async () => {
  const r = await api("GET", "/analytics/recruiter-performance", tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.team.totalCandidates, 1, "team.totalCandidates must exclude erased + DNC");
  const recr = (r.json.recruiters ?? []).find((x: any) => x.recruiterId === id("recr"));
  assert.ok(recr, "the seeded recruiter must appear in the cohort");
  assert.equal(recr.candidatesManaged, 1, "candidatesManaged must exclude erased + DNC");
});
