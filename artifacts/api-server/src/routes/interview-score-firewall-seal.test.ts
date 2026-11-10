/**
 * interview-score-firewall-seal.test.ts — PROOF THAT THE INTERVIEW-SCORE
 * FAIRNESS FIREWALL IS DATA-LAYER, NOT UI-LAYER.
 *
 * The rule: for RECRUITER-run interviews / AI screens, the candidate must
 * never see the AI score or feedback (they see "results shared with the
 * hiring team"). Only staff read interview results.
 *
 * Two holes this test seals:
 *   1. GET /interviews/:id — the bearer branch of gateInterviewRead used
 *      getAllowedTenantIds alone, which is NOT a staff gate (candidate users
 *      also carry a tenantId). A logged-in candidate could fetch ANY session
 *      in their tenant by id and read score / per-question grades /
 *      proctoring signals (IDOR + firewall leak).
 *   2. GET /interviews (list) — same missing role gate, and the list enriches
 *      each session with interview_summaries (overallScore, recommendation,
 *      recruiterSummary, strengths, weaknesses).
 *
 * Assertions are two-sided: the candidate bearer is refused / stripped AND
 * the staff bearer still receives the full results (no all-blocked
 * false-pass).
 *
 * Harness mirrors internal-search-firewall-seal.test.ts: outside
 * withTenantContext the `db` proxy falls through to dbAdmin (no RLS), so this
 * isolates the app-layer seal. Routes read the caller via the Bearer token.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import { inArray, eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  interviewPlansTable,
  interviewSessionsTable,
  interviewSummariesTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import interviewsRouter from "./interviews";

const P = "iscf_";
const id = (s: string) => P + s;

const TENANT = id("tenant");
const FOREIGN_TENANT = id("foreign_tenant");
const TENANT_IDS = [TENANT, FOREIGN_TENANT];

let server: Server;
let baseUrl: string;

const recruiterToken = () => issueToken({ userId: id("recruiter"), role: "recruiter", tenantId: TENANT });
const candidateToken = () => issueToken({ userId: id("canduser"), role: "candidate", tenantId: TENANT });

async function api(method: string, path: string, token?: string) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(interviewSummariesTable).where(inArray(interviewSummariesTable.interviewSessionId, [id("session"), id("foreign_session")]));
  await dbAdmin.delete(interviewSessionsTable).where(inArray(interviewSessionsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(interviewPlansTable).where(inArray(interviewPlansTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

async function seed() {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: TENANT, name: "Acme", slug: TENANT, plan: "enterprise" },
    { id: FOREIGN_TENANT, name: "Independent synthetic customer", slug: FOREIGN_TENANT, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: id("recruiter"), tenantId: TENANT, email: id("recruiter") + "@t.test", name: "Rec", passwordHash: "x", role: "recruiter", status: "active" },
    // A logged-in CANDIDATE portal user in the SAME tenant — the attacker in
    // the IDOR scenario (they know/guess the session id of their own — or any
    // other candidate's — recruiter-run interview).
    { id: id("canduser"), tenantId: TENANT, email: id("canduser") + "@t.test", name: "Cand", passwordHash: "x", role: "candidate", status: "active" },
    { id: id("unassigned"), tenantId: TENANT, email: id("unassigned") + "@t.test", name: "Unassigned synthetic recruiter", passwordHash: "x", role: "recruiter", status: "active" },
    { id: id("foreign_recruiter"), tenantId: FOREIGN_TENANT, email: id("foreign_recruiter") + "@t.test", name: "Foreign synthetic recruiter", passwordHash: "x", role: "recruiter", status: "active" },
  ]);
  await dbAdmin.insert(jobsTable).values([{ id: id("job"), tenantId: TENANT, title: "Engineer", description: "d", status: "active", assignedRecruiterId: id("recruiter") }]);
  await dbAdmin.insert(candidatesTable).values([
    { id: id("cand"), tenantId: TENANT, pool: "tenant", source: "career_site", firstName: "C", lastName: "One", email: id("cand") + "@t.test" },
  ]);
  await dbAdmin.insert(applicationsTable).values([
    { id: id("app"), tenantId: TENANT, jobId: id("job"), candidateId: id("cand"), stage: "interview" } as any,
  ]);
  await dbAdmin.insert(interviewPlansTable).values([
    { id: id("plan"), tenantId: TENANT, jobId: id("job"), title: "Screen" },
  ]);
  // A COMPLETED recruiter-run AI screening interview with a real score,
  // per-question AI grades, and proctoring internals.
  await dbAdmin.insert(interviewSessionsTable).values([
    {
      id: id("session"), tenantId: TENANT, applicationId: id("app"), planId: id("plan"),
      candidateId: id("cand"), status: "completed", completedAt: new Date(),
      score: 87.5,
      answers: [{ questionId: "q1", answerText: "a", score: 90, feedback: "Strong answer" }],
      proctoring_events: [{ kind: "tab_blur", ts: new Date().toISOString() }],
      trustScore: 72,
    } as any,
  ]);
  await dbAdmin.insert(interviewSummariesTable).values([
    {
      interviewSessionId: id("session"), overallScore: 87.5,
      strengths: ["communication"], weaknesses: ["depth"],
      recommendation: "yes", recruiterSummary: "Hire-worthy candidate",
    },
  ]);
  await dbAdmin.insert(jobsTable).values({
    id: id("foreign_job"), tenantId: FOREIGN_TENANT, title: "Synthetic foreign role",
    description: "Isolated fixture", assignedRecruiterId: id("foreign_recruiter"),
  });
  await dbAdmin.insert(candidatesTable).values({
    id: id("foreign_cand"), tenantId: FOREIGN_TENANT, firstName: "Synthetic",
    lastName: "Foreign", email: id("foreign_cand") + "@example.invalid", pool: "tenant",
  });
  await dbAdmin.insert(interviewPlansTable).values({
    id: id("foreign_plan"), tenantId: FOREIGN_TENANT, jobId: id("foreign_job"), title: "Synthetic foreign interview",
  });
  await dbAdmin.insert(interviewSessionsTable).values({
    id: id("foreign_session"), tenantId: FOREIGN_TENANT, applicationId: "direct",
    candidateId: id("foreign_cand"), planId: id("foreign_plan"), status: "completed",
  });
  await dbAdmin.insert(interviewSummariesTable).values({
    interviewSessionId: id("foreign_session"), overallScore: 12,
    recruiterSummary: "FOREIGN_PRIVATE_SUMMARY", recruiterComments: "FOREIGN_PRIVATE_NOTE",
  });
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(interviewsRouter);
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

/* ── GET /interviews/:id (detail) ─────────────────────────────────────── */

test("STAFF control: recruiter bearer gets the full session incl. score (no all-blocked false-pass)", async () => {
  const { status, json } = await api("GET", `/interviews/${id("session")}`, recruiterToken());
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.score, 87.5, "recruiter must still see the AI score");
  assert.ok(Array.isArray(json.answers) && json.answers[0]?.score === 90, "recruiter must still see per-question grades");
});

test("FIREWALL/IDOR: candidate bearer CANNOT read a recruiter-run session by id", async () => {
  const { status, json } = await api("GET", `/interviews/${id("session")}`, candidateToken());
  // Candidate bearer must fall to the interview-cookie path, which refuses a
  // completed session (410) — it must NEVER return the session row.
  assert.notEqual(status, 200, `LEAK: candidate bearer read the session: ${JSON.stringify(json)}`);
  assert.equal(json?.score, undefined, "LEAK: score present in candidate response");
  assert.equal(json?.answers, undefined, "LEAK: per-question grades present in candidate response");
});

test("no-auth control: anonymous caller cannot read the completed session", async () => {
  const { status, json } = await api("GET", `/interviews/${id("session")}`);
  assert.notEqual(status, 200, JSON.stringify(json));
  assert.equal(json?.score, undefined);
});

test("staff response never echoes session-binding secret material", async () => {
  const { status, json } = await api("GET", `/interviews/${id("session")}`, recruiterToken());
  assert.equal(status, 200);
  for (const k of ["bindSecret", "bindFingerprint", "cookieNonce", "stepUpOtpHash"]) {
    assert.equal(json[k], undefined, `response must not echo ${k}`);
  }
});

/* ── GET /interviews (list + summary enrichment) ──────────────────────── */

test("STAFF control: recruiter list includes the session with the summary verdict", async () => {
  const { status, json } = await api("GET", "/interviews", recruiterToken());
  assert.equal(status, 200, JSON.stringify(json));
  const row = (json as any[]).find(s => s.id === id("session"));
  assert.ok(row, "recruiter must see the session in the list");
  assert.equal(row.overallScore, 87.5, "recruiter must see the summary overallScore");
});

test("FIREWALL: candidate bearer is refused on the staff interview list", async () => {
  const { status, json } = await api("GET", "/interviews", candidateToken());
  assert.equal(status, 403, `LEAK: candidate bearer reached the staff interview list: ${JSON.stringify(json)}`);
});

/* ── GET /interviews/:id/proctor-report ───────────────────────────────── */

test("summary: authorised recruiters keep their own assessment; foreign and missing sessions share 404", async () => {
  const own = await api("GET", `/interviews/${id("session")}/summary`, recruiterToken());
  assert.equal(own.status, 200);
  assert.equal(own.json.overallScore, 87.5);
  const foreign = await api("GET", `/interviews/${id("foreign_session")}/summary`, recruiterToken());
  const missing = await api("GET", `/interviews/${id("missing_session")}/summary`, recruiterToken());
  assert.deepEqual(foreign, { status: 404, json: { error: "Summary not found" } });
  assert.deepEqual(missing, foreign);
  const foreignToken = issueToken({ userId: id("foreign_recruiter"), role: "recruiter", tenantId: FOREIGN_TENANT });
  const positive = await api("GET", `/interviews/${id("foreign_session")}/summary`, foreignToken);
  assert.equal(positive.status, 200);
  assert.equal(positive.json.recruiterSummary, "FOREIGN_PRIVATE_SUMMARY");
});

test("summary: candidate, anonymous and same-tenant unassigned recruiter cannot read the assessment", async () => {
  const path = `/interviews/${id("session")}/summary`;
  assert.equal((await api("GET", path)).status, 401);
  assert.equal((await api("GET", path, candidateToken())).status, 404);
  const unassigned = issueToken({ userId: id("unassigned"), role: "recruiter", tenantId: TENANT });
  assert.equal((await api("GET", path, unassigned)).status, 404);
  const rows = await api("GET", "/interviews", unassigned);
  assert.equal(rows.status, 200);
  assert.deepEqual(rows.json, []);
});

test("list: two independent customers receive only their own session and assessment", async () => {
  const foreignToken = issueToken({ userId: id("foreign_recruiter"), role: "recruiter", tenantId: FOREIGN_TENANT });
  for (const [token, sessionId, forbidden] of [
    [recruiterToken(), id("session"), "FOREIGN_PRIVATE_SUMMARY"],
    [foreignToken, id("foreign_session"), "Hire-worthy candidate"],
  ]) {
    const response = await api("GET", "/interviews", token);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.map((row: any) => row.id), [sessionId]);
    assert.equal(JSON.stringify(response.json).includes(forbidden), false);
    assert.equal(typeof response.json[0].overallScore, "number");
  }
});

test("recruiter comments: foreign and unassigned writes are denied without changing stored notes", async () => {
  const unassigned = issueToken({ userId: id("unassigned"), role: "recruiter", tenantId: TENANT });
  for (const [sessionId, token] of [[id("foreign_session"), recruiterToken()], [id("session"), unassigned]]) {
    const [before] = await dbAdmin.select().from(interviewSummariesTable)
      .where(eq(interviewSummariesTable.interviewSessionId, sessionId));
    const response = await fetch(`${baseUrl}/interviews/${sessionId}/recruiter-comments`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comments: "Unauthorised replacement" }),
    });
    assert.equal(response.status, 404);
    const [after] = await dbAdmin.select().from(interviewSummariesTable)
      .where(eq(interviewSummariesTable.interviewSessionId, sessionId));
    assert.deepEqual(after, before);
  }
});

test("STAFF control: recruiter can read the proctor report", async () => {
  const { status, json } = await api("GET", `/interviews/${id("session")}/proctor-report`, recruiterToken());
  assert.equal(status, 200, JSON.stringify(json));
});

test("FIREWALL: candidate bearer cannot read the proctor report by id", async () => {
  const { status, json } = await api("GET", `/interviews/${id("session")}/proctor-report`, candidateToken());
  assert.equal(status, 404, `LEAK: candidate bearer read proctoring internals: ${JSON.stringify(json)}`);
});

/* ── submit-code evaluation sanitizer ─────────────────────────────────── */

test("FIREWALL: candidate-visible code evaluation is iteration feedback only — never the recruiter grade", async () => {
  const { sanitizeCodeEvalForCandidate } = await import("./interviews");
  const raw = {
    score: 62, codeQuality: "fair", correctness: "partial",
    passed: true, feedback: "Handles the base case; misses the edge case.",
    suggestions: ["Guard empty input"], timeComplexity: "O(n)", spaceComplexity: "O(1)",
    someFutureGradeField: 9,
  };
  const out = sanitizeCodeEvalForCandidate(raw);
  assert.deepEqual(Object.keys(out).sort(), ["feedback", "passed", "spaceComplexity", "suggestions", "timeComplexity"],
    `LEAK: sanitizer echoed unexpected fields: ${JSON.stringify(out)}`);
  assert.equal((out as any).score, undefined, "LEAK: 0-100 grade reached the candidate");
  assert.equal(out.passed, true);
  assert.equal(out.feedback, raw.feedback);
  assert.deepEqual(out.suggestions, raw.suggestions);
});

test("FIREWALL: sanitizer scrubs rating phrases from free-text feedback (prose backstop)", async () => {
  const { sanitizeCodeEvalForCandidate } = await import("./interviews");
  const out = sanitizeCodeEvalForCandidate({
    passed: false,
    feedback: "Solid attempt but I scored it 62/100 overall. The loop handles the base case.",
    suggestions: ["I would rate this 6/10 as-is", "Guard empty input"],
  });
  assert.ok(!/62\s*\/\s*100/.test(out.feedback ?? ""), `LEAK: numeric grade survived in feedback: ${out.feedback}`);
  assert.ok(!out.suggestions.some((s: string) => /6\s*\/\s*10/.test(s)), `LEAK: rating survived in suggestions: ${JSON.stringify(out.suggestions)}`);
  assert.ok((out.feedback ?? "").includes("base case"), "over-scrub: legitimate iteration feedback removed");
});
