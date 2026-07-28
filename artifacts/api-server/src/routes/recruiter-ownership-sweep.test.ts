/**
 * recruiter-ownership-sweep.test.ts — Recruiter ownership-ceiling VERIFICATION
 *
 * Part of the recruiter ownership-ceiling verification package. Proves the
 * per-route ownership gates added to the inline-gated routers behave correctly
 * under a TWO-RECRUITER DISJOINT-ASSIGNMENT scenario:
 *
 *   recrX ── assigned ──▶ jobX   (+ campX, msgX, enrX/stepX, sessX)
 *   recrY ── assigned ──▶ jobY   (+ campY, msgY, enrY/stepY, sessY)
 *
 * Each recruiter owns exactly ONE requisition's outreach/prep resources. The
 * OTHER recruiter — same tenant, valid token — must get a 404 (never 403, to
 * avoid ID enumeration) on the peer's resources. A tenant_admin (non-recruiter)
 * is ceilinged only by tenant scope, so it sees both.
 *
 * ─── How this test works (same harness as recruiter-admin-permissions.test.ts)
 * The ownership ceiling is enforced at the APP layer, not by Postgres RLS, so we
 * exercise the REAL route handlers over HTTP on a bare Express app:
 *   • mount the REAL prep + outreach + intelligence routers (each self-auths:
 *     prep via requireAuthedUser in-handler, outreach via a /outreach-scoped
 *     resolveUser, intelligence via router.use(resolveUser) — exactly as
 *     routes/index.ts mounts them),
 *   • seed the fixture via `dbAdmin` (BYPASSRLS),
 *   • issue real bearer tokens with issueToken(), hit routes with global fetch().
 *
 * Outside withTenantContext the `db` proxy falls through to `dbAdmin`, so RLS
 * never filters here — isolating the app-layer ownership logic under test.
 *
 * COVERAGE (one representative route per converted file):
 *   • prep.ts     POST /prep/sessions/:sessionId/answer  (candidate self /
 *                 cross-candidate / unassigned-recruiter / owner / admin)
 *                 + GET /prep/sessions list scoping
 *   • outreach.ts :id ALIAS RESOLUTION — one aliased route per resource kind:
 *                   MESSAGE     GET   /outreach/messages/:id       (→ jobId)
 *                   CAMPAIGN    GET   /outreach/campaigns/:campaignId
 *                   ENROLLMENT  PATCH /outreach/step-messages/:id  (→ campaignId)
 *   • intelligence.ts GET /intelligence/job/:jobId  (enforceOwnership jobId)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray, eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  outreachCampaignsTable,
  outreachMessagesTable,
  outreachEnrollmentsTable,
  outreachStepMessagesTable,
  prepSessionsTable,
  interviewSessionsTable,
  interviewPlansTable,
  sourcedCandidatesTable,
  aiMessageGenerationsTable,
  aiMessageFeedbackTable,
  talentMatchesTable,
  icpTable,
  outreachConversationDraftsTable,
  inviteTokensTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import prepRouter from "./prep";
import outreachRouter from "./outreach";
import intelligenceRouter from "./intelligence";
import agentsRouter from "./agents";
import sourcingRouter from "./sourcing";
import aiMessagesRouter from "./ai-messages";
import verifyRouter from "./verify";
import outcomesRouter from "./outcomes";
import interviewsRouter from "./interviews";
import candidateEventsRouter from "./candidate-events";
import invitesRouter from "./invites";
import recruiterAvatarRouter from "./recruiter-avatar";
import conversationDraftsRouter from "./conversation-drafts";
import talentMatchRouter from "./talent_match";
import icpRouter from "./icp";
import governanceRouter from "./governance";

const P = "rost_";
const id = (s: string) => P + s;

const TENANT_IDS = [id("t")];
const USER_IDS = ["padmin", "tadmin", "recrX", "recrY", "candU", "candNo"].map(id);
const JOB_IDS = ["jobX", "jobY"].map(id);
const CAND_IDS = ["candX", "candY", "candSelf", "candSelf2"].map(id);
const APP_IDS = ["appX", "appY"].map(id);
const CAMP_IDS = ["campX", "campY"].map(id);
const MSG_IDS = ["msgX", "msgY"].map(id);
const ENR_IDS = ["enrX", "enrY"].map(id);
const STEP_IDS = ["stepX", "stepY"].map(id);
const SESS_IDS = ["sessSelf", "sessSelf2", "sessX", "sessY"].map(id);
// interview sessions (proctoring) + sourced-pool rows for the agents.ts / sourcing.ts sweeps
const ISESS_IDS = ["isessX", "isessY"].map(id);
const SRCD_IDS = ["srcdX", "srcdY"].map(id);
// Tier-2 sweep additions: one owned resource per remaining converted file.
const PLAN_IDS = ["planX", "planY"].map(id);       // interviews.ts   (jobX / jobY)
const GEN_IDS = ["genX", "genY"].map(id);          // ai-messages.ts  (jobX / jobY)
const ICP_IDS = ["icpX", "icpY"].map(id);          // icp.ts          (jobX / jobY)
const DRAFT_IDS = ["draftX", "draftY"].map(id);    // conversation-drafts.ts (jobX / jobY)

let server: Server;
let baseUrl: string;

function tokenFor(userId: string, role: string, tenantId: string | null) {
  return issueToken({ userId, role, tenantId });
}
const tok = {
  pAdmin: () => tokenFor(id("padmin"), "platform_admin", id("t")),
  tAdmin: () => tokenFor(id("tadmin"), "tenant_admin", id("t")),
  recrX: () => tokenFor(id("recrX"), "recruiter", id("t")),
  recrY: () => tokenFor(id("recrY"), "recruiter", id("t")),
  candU: () => tokenFor(id("candU"), "candidate", id("t")),
  // Authenticated candidate-role user with NO candidates.userId mapping.
  candNo: () => tokenFor(id("candNo"), "candidate", id("t")),
};

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
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function cleanup() {
  // ingest test creates a sourced row with a generated id → clear the whole test tenant's pool.
  await dbAdmin.delete(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.tenantId, id("t")));
  // Tier-2 additions — clear by tenant so any generated-id side rows (talent-match
  // writes, ai-message feedback, invite tokens + ensureCandidateUser portal users)
  // are swept regardless of id, keeping the tenant delete below FK-safe.
  await dbAdmin.delete(inviteTokensTable).where(eq(inviteTokensTable.tenantId, id("t")));
  await dbAdmin.delete(talentMatchesTable).where(eq(talentMatchesTable.tenantId, id("t")));
  await dbAdmin.delete(aiMessageFeedbackTable).where(eq(aiMessageFeedbackTable.tenantId, id("t")));
  await dbAdmin.delete(aiMessageGenerationsTable).where(inArray(aiMessageGenerationsTable.id, GEN_IDS));
  await dbAdmin.delete(icpTable).where(inArray(icpTable.id, ICP_IDS));
  await dbAdmin.delete(outreachConversationDraftsTable).where(inArray(outreachConversationDraftsTable.id, DRAFT_IDS));
  await dbAdmin.delete(interviewPlansTable).where(inArray(interviewPlansTable.id, PLAN_IDS));
  await dbAdmin.delete(interviewSessionsTable).where(inArray(interviewSessionsTable.id, ISESS_IDS));
  await dbAdmin.delete(outreachStepMessagesTable).where(inArray(outreachStepMessagesTable.id, STEP_IDS));
  await dbAdmin.delete(outreachEnrollmentsTable).where(inArray(outreachEnrollmentsTable.id, ENR_IDS));
  await dbAdmin.delete(outreachMessagesTable).where(inArray(outreachMessagesTable.id, MSG_IDS));
  await dbAdmin.delete(outreachCampaignsTable).where(inArray(outreachCampaignsTable.id, CAMP_IDS));
  await dbAdmin.delete(prepSessionsTable).where(inArray(prepSessionsTable.id, SESS_IDS));
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.id, APP_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, JOB_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, CAND_IDS));
  // Delete users by tenant (not just the fixed ids): the invites owner/admin path
  // calls ensureCandidateUser which mints a portal user with a generated id.
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, id("t")));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

function draftReset() {
  // POST /conversation-drafts/:id/reject only works on a "pending" draft; reset
  // before each ownership assertion so a prior successful reject can't taint the next.
  return dbAdmin.update(outreachConversationDraftsTable)
    .set({ status: "pending", rejectedBy: null, rejectedAt: null, rejectedReason: null })
    .where(inArray(outreachConversationDraftsTable.id, DRAFT_IDS));
}

function stepMsgReset() {
  // step-message edit only works on a pending_approval draft; reset before each
  // alias-resolution assertion so a prior successful edit can't taint the next.
  return dbAdmin.update(outreachStepMessagesTable)
    .set({ status: "pending_approval", subject: "Draft", body: "Draft body" })
    .where(inArray(outreachStepMessagesTable.id, STEP_IDS));
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("t"), name: "ROST Tenant", slug: id("t"), plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("padmin"), tenantId: id("t"), email: id("padmin") + "@t.test", name: "PAdmin", passwordHash: "x", role: "platform_admin" },
    { id: id("tadmin"), tenantId: id("t"), email: id("tadmin") + "@t.test", name: "TAdmin", passwordHash: "x", role: "tenant_admin" },
    { id: id("recrX"), tenantId: id("t"), email: id("recrX") + "@t.test", name: "RecrX", passwordHash: "x", role: "recruiter" },
    { id: id("recrY"), tenantId: id("t"), email: id("recrY") + "@t.test", name: "RecrY", passwordHash: "x", role: "recruiter" },
    { id: id("candU"), tenantId: id("t"), email: id("candU") + "@t.test", name: "CandU", passwordHash: "x", role: "candidate" },
    // candNo: candidate-role user with NO candidate record (orphaned account).
    { id: id("candNo"), tenantId: id("t"), email: id("candNo") + "@t.test", name: "CandNo", passwordHash: "x", role: "candidate" },
  ]);

  // Disjoint assignment: recrX ↔ jobX, recrY ↔ jobY.
  await dbAdmin.insert(jobsTable).values([
    { id: id("jobX"), tenantId: id("t"), title: "Job X", description: "desc", status: "active", assignedRecruiterId: id("recrX") },
    { id: id("jobY"), tenantId: id("t"), title: "Job Y", description: "desc", status: "active", assignedRecruiterId: id("recrY") },
  ]);

  // candSelf is the portal-linked candidate for candU (userId FK). candX/candY
  // are sourced rows with no portal user, linked to their job via applications.
  await dbAdmin.insert(candidatesTable).values([
    { id: id("candX"), tenantId: id("t"), firstName: "Cand", lastName: "X", email: id("candX") + "@t.test", pool: "tenant" },
    { id: id("candY"), tenantId: id("t"), firstName: "Cand", lastName: "Y", email: id("candY") + "@t.test", pool: "tenant" },
    { id: id("candSelf"), tenantId: id("t"), userId: id("candU"), firstName: "Cand", lastName: "Self", email: id("candU") + "@t.test", pool: "tenant" },
    // candSelf2: a SECOND candidate record for the SAME user (candU). candidates.userId
    // has no unique index, so one user → many candidate rows is permitted (re-applications,
    // cross-tenant candidacies). Self-access must mean "any of my candidate ids".
    { id: id("candSelf2"), tenantId: id("t"), userId: id("candU"), firstName: "Cand", lastName: "Self2", email: id("candU") + "+2@t.test", pool: "tenant" },
  ]);

  // appX carries an AI recommendation with NO human final decision → it lands in
  // the governance "pending-human-review" queue (payload-scoped to assigned reqs).
  await dbAdmin.insert(applicationsTable).values([
    { id: id("appX"), tenantId: id("t"), jobId: id("jobX"), candidateId: id("candX"), stage: "applied", aiRecommendation: "advance" },
    { id: id("appY"), tenantId: id("t"), jobId: id("jobY"), candidateId: id("candY"), stage: "applied" },
  ]);

  await dbAdmin.insert(outreachCampaignsTable).values([
    { id: id("campX"), tenantId: id("t"), jobId: id("jobX"), name: "Campaign X", status: "draft" },
    { id: id("campY"), tenantId: id("t"), jobId: id("jobY"), name: "Campaign Y", status: "draft" },
  ]);

  await dbAdmin.insert(outreachMessagesTable).values([
    { id: id("msgX"), tenantId: id("t"), jobId: id("jobX"), candidateId: id("candX"), subject: "Hi X", body: "Body X", status: "queued" },
    { id: id("msgY"), tenantId: id("t"), jobId: id("jobY"), candidateId: id("candY"), subject: "Hi Y", body: "Body Y", status: "queued" },
  ]);

  await dbAdmin.insert(outreachEnrollmentsTable).values([
    { id: id("enrX"), tenantId: id("t"), campaignId: id("campX"), candidateId: id("candX"), jobId: id("jobX"), recipientEmail: id("candX") + "@t.test", status: "enrolled" },
    { id: id("enrY"), tenantId: id("t"), campaignId: id("campY"), candidateId: id("candY"), jobId: id("jobY"), recipientEmail: id("candY") + "@t.test", status: "enrolled" },
  ]);

  await dbAdmin.insert(outreachStepMessagesTable).values([
    { id: id("stepX"), campaignId: id("campX"), enrollmentId: id("enrX"), stepNumber: 1, toEmail: id("candX") + "@t.test", subject: "Draft", body: "Draft body", status: "pending_approval" },
    { id: id("stepY"), campaignId: id("campY"), enrollmentId: id("enrY"), stepNumber: 1, toEmail: id("candY") + "@t.test", subject: "Draft", body: "Draft body", status: "pending_approval" },
  ]);

  const questions = ["Tell me about yourself.", "Why this role?"];
  await dbAdmin.insert(prepSessionsTable).values([
    { id: id("sessSelf"), tenantId: id("t"), candidateId: id("candSelf"), jobId: id("jobX"), mode: "quick", status: "active", questions, totalQuestions: 2, answers: [] },
    { id: id("sessSelf2"), tenantId: id("t"), candidateId: id("candSelf2"), jobId: id("jobX"), mode: "quick", status: "active", questions, totalQuestions: 2, answers: [] },
    { id: id("sessX"), tenantId: id("t"), candidateId: id("candX"), jobId: id("jobX"), mode: "quick", status: "active", questions, totalQuestions: 2, answers: [] },
    { id: id("sessY"), tenantId: id("t"), candidateId: id("candY"), jobId: id("jobY"), mode: "quick", status: "active", questions, totalQuestions: 2, answers: [] },
  ]);

  // Interview sessions for the proctoring sweep — isessX on jobX/candX (recrX-owned),
  // isessY on jobY/candY (recrY-owned). Proctoring events present so a 200 returns data.
  await dbAdmin.insert(interviewSessionsTable).values([
    { id: id("isessX"), tenantId: id("t"), applicationId: id("appX"), planId: "plan", candidateId: id("candX"), status: "completed", totalQuestions: 2, proctoring_events: [{ type: "tab_switch", ts: 1 }] },
    { id: id("isessY"), tenantId: id("t"), applicationId: id("appY"), planId: "plan", candidateId: id("candY"), status: "completed", totalQuestions: 2, proctoring_events: [{ type: "tab_switch", ts: 1 }] },
  ]);

  // Sourced-pool rows keyed to each candidate — proves GET /sourcing/candidates
  // stays tenant-wide (both recruiters see both) and feeds the merge sweep.
  await dbAdmin.insert(sourcedCandidatesTable).values([
    { id: id("srcdX"), tenantId: id("t"), source: "linkedin", normalizedCandidateId: id("candX"), rawData: {} },
    { id: id("srcdY"), tenantId: id("t"), source: "linkedin", normalizedCandidateId: id("candY"), rawData: {} },
  ]);

  // ── Tier-2 owned resources (one per remaining converted file) ─────────────
  // interviews.ts — plan keyed to a job (ceiling via plan.jobId).
  const planQuestions = [{ id: "q1", text: "Tell me about yourself.", category: "behavioral", order: 1 }];
  await dbAdmin.insert(interviewPlansTable).values([
    { id: id("planX"), tenantId: id("t"), jobId: id("jobX"), title: "Plan X", questions: planQuestions },
    { id: id("planY"), tenantId: id("t"), jobId: id("jobY"), title: "Plan Y", questions: planQuestions },
  ]);

  // ai-messages.ts — draft generation keyed to a job (ceiling via generation.jobId).
  // status must NOT be "sent" so the PATCH edit is permitted for the owner/admin.
  await dbAdmin.insert(aiMessageGenerationsTable).values([
    { id: id("genX"), tenantId: id("t"), jobId: id("jobX"), candidateId: id("candX"), messageType: "outreach", body: "Draft body X", status: "generated" },
    { id: id("genY"), tenantId: id("t"), jobId: id("jobY"), candidateId: id("candY"), messageType: "outreach", body: "Draft body Y", status: "generated" },
  ]);

  // icp.ts — ideal-candidate profile keyed to a job (write-ceiling via requireIcpWriteAccess).
  await dbAdmin.insert(icpTable).values([
    { id: id("icpX"), tenantId: id("t"), jobId: id("jobX"), jobTitle: "Job X", version: 1 },
    { id: id("icpY"), tenantId: id("t"), jobId: id("jobY"), jobTitle: "Job Y", version: 1 },
  ]);

  // conversation-drafts.ts — AI reply draft keyed to a job (ceiling via recruiterOwnsDraft).
  const now = new Date();
  await dbAdmin.insert(outreachConversationDraftsTable).values([
    { id: id("draftX"), tenantId: id("t"), jobId: id("jobX"), candidateId: id("candX"), candidateEmail: id("candX") + "@t.test", inboundBody: "Is this remote?", inboundReceivedAt: now, subject: "Re: your question", body: "Yes, remote-friendly.", verdict: "needs_review", status: "pending" },
    { id: id("draftY"), tenantId: id("t"), jobId: id("jobY"), candidateId: id("candY"), candidateEmail: id("candY") + "@t.test", inboundBody: "Is this remote?", inboundReceivedAt: now, subject: "Re: your question", body: "Yes, remote-friendly.", verdict: "needs_review", status: "pending" },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  // Mounted exactly as routes/index.ts does: prep + outreach unprefixed
  // (each self-auths), intelligence under /intelligence.
  app.use(prepRouter);
  app.use(outreachRouter);
  app.use("/intelligence", intelligenceRouter);
  // agents + sourcing self-auth in-handler (getAuthUserId), mounted unprefixed.
  app.use(agentsRouter);
  app.use(sourcingRouter);
  // Tier-2 sweep routers — all self-auth in-handler and mount unprefixed at root,
  // exactly as routes/index.ts does.
  app.use(aiMessagesRouter);
  app.use(verifyRouter);
  app.use(outcomesRouter);
  app.use(interviewsRouter);
  app.use(candidateEventsRouter);
  app.use(invitesRouter);
  app.use(recruiterAvatarRouter);
  app.use(conversationDraftsRouter);
  app.use(talentMatchRouter);
  app.use(icpRouter);
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

const answerBody = () => ({ questionId: "0", answerText: "This is my thoughtful answer to the question." });

/* ─────────────────────────────────────────────────────────────────────────────
 * prep.ts — POST /prep/sessions/:sessionId/answer (post-load owner check)
 * Candidate model: user.id → candidates.userId → candidate.id (NOT authId==id).
 * ──────────────────────────────────────────────────────────────────────────── */
test("prep answer: candidate on OWN session → allowed (2xx)", async () => {
  const r = await api("POST", `/prep/sessions/${id("sessSelf")}/answer`, tok.candU(), answerBody());
  assert.ok(r.status < 300, `candidate self should be allowed, got ${r.status} ${JSON.stringify(r.json)}`);
});

test("prep answer: candidate on ANOTHER candidate's session → 404", async () => {
  const r = await api("POST", `/prep/sessions/${id("sessX")}/answer`, tok.candU(), answerBody());
  assert.equal(r.status, 404, "cross-candidate prep session must 404");
});

test("prep answer: recruiter on session for an UNASSIGNED job → 404", async () => {
  // recrX is assigned jobX only; sessY belongs to jobY (recrY's req).
  const r = await api("POST", `/prep/sessions/${id("sessY")}/answer`, tok.recrX(), answerBody());
  assert.equal(r.status, 404, "unassigned-recruiter prep session must 404");
});

test("prep answer: recruiter on session for an ASSIGNED job → allowed (2xx)", async () => {
  const r = await api("POST", `/prep/sessions/${id("sessX")}/answer`, tok.recrX(), answerBody());
  assert.ok(r.status < 300, `assigned recruiter should be allowed, got ${r.status} ${JSON.stringify(r.json)}`);
});

test("prep answer: tenant_admin on any tenant session → allowed (2xx)", async () => {
  const r = await api("POST", `/prep/sessions/${id("sessY")}/answer`, tok.tAdmin(), answerBody());
  assert.ok(r.status < 300, `tenant_admin should be allowed, got ${r.status} ${JSON.stringify(r.json)}`);
});

test("prep list: recruiter sees ONLY assigned-job sessions; candidate sees ONLY own", async () => {
  const rx = await api("GET", "/prep/sessions", tok.recrX());
  assert.equal(rx.status, 200);
  const rxIds = new Set((rx.json.sessions ?? rx.json ?? []).map((s: any) => s.id));
  assert.ok(rxIds.has(id("sessX")), "recrX should see its assigned-job session");
  assert.ok(!rxIds.has(id("sessY")), "recrX must NOT see recrY's session");

  const rc = await api("GET", "/prep/sessions", tok.candU());
  assert.equal(rc.status, 200);
  const rcIds = new Set((rc.json.sessions ?? rc.json ?? []).map((s: any) => s.id));
  assert.ok(rcIds.has(id("sessSelf")), "candidate should see own session");
  assert.ok(!rcIds.has(id("sessX")) && !rcIds.has(id("sessY")), "candidate must NOT see others' sessions");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * prep.ts — CANDIDATE SELF-PATH MAPPING (user.id → candidates.userId → id[])
 * Server-resolved identity: the client-supplied candidateId is only ever COMPARED
 * against the caller's own candidate ids, never trusted as identity. Covers the
 * one-to-MANY case (a user with multiple candidate rows) and the NULL-mapping case
 * (authed candidate-role user with no candidate record).
 * ──────────────────────────────────────────────────────────────────────────── */
test("prep self-path 1:many — candidate reaches a session under their SECOND candidate record", async () => {
  // candU maps to BOTH candSelf and candSelf2 (candidates.userId is not unique).
  // Self-access is "any of my candidate ids", so a session on candSelf2 is reachable.
  const r = await api("POST", `/prep/sessions/${id("sessSelf2")}/answer`, tok.candU(), answerBody());
  assert.ok(r.status < 300, `own 2nd-record session should be allowed, got ${r.status} ${JSON.stringify(r.json)}`);
});

test("prep self-path 1:many — list returns ALL of the candidate's own records' sessions", async () => {
  const rc = await api("GET", "/prep/sessions", tok.candU());
  assert.equal(rc.status, 200);
  const ids = new Set((rc.json.sessions ?? rc.json ?? []).map((s: any) => s.id));
  assert.ok(ids.has(id("sessSelf")) && ids.has(id("sessSelf2")), "candidate must see sessions across ALL their candidate records");
});

test("prep null-mapping — candidate-role user with NO candidate record → 404 on answer", async () => {
  const r = await api("POST", `/prep/sessions/${id("sessSelf")}/answer`, tok.candNo(), answerBody());
  assert.equal(r.status, 404, "no-mapping user must 404, never fall through to broader access");
});

test("prep null-mapping — no candidate record → empty list (not a leak)", async () => {
  const r = await api("GET", "/prep/sessions", tok.candNo());
  assert.equal(r.status, 200);
  const rows = r.json.sessions ?? r.json ?? [];
  assert.equal(rows.length, 0, "no-mapping user must see an EMPTY list");
});

test("prep null-mapping — create with no candidateId → 404 (no 'default' orphan session)", async () => {
  const r = await api("POST", "/prep/sessions", tok.candNo(), { jobId: id("jobX"), mode: "quick" });
  assert.equal(r.status, 404, "no-mapping candidate must NOT create a 'default' orphan session");
});

test("prep null-mapping — generate for a non-owned candidateId → 404", async () => {
  // candNo has no candidate record; the client candidateId is compared, never trusted.
  const r = await api("POST", "/prep/generate", tok.candNo(), { candidateId: id("candSelf"), jobId: id("jobX"), mode: "quick" });
  assert.equal(r.status, 404, "no-mapping user must 404 on generate, never generate for someone else's record");
});

test("prep self-path — create with no candidateId attaches to the caller's own record", async () => {
  const r = await api("POST", "/prep/sessions", tok.candU(), { jobId: id("jobX"), mode: "quick" });
  assert.ok(r.status < 300, `mapped candidate should create own session, got ${r.status} ${JSON.stringify(r.json)}`);
  const created = r.json.session ?? r.json;
  assert.ok(
    created.candidateId === id("candSelf") || created.candidateId === id("candSelf2"),
    `created session must attach to one of the caller's own candidate ids, got ${created.candidateId}`,
  );
  // Clean up the ad-hoc created session so it doesn't leak across runs.
  if (created?.id) await dbAdmin.delete(prepSessionsTable).where(inArray(prepSessionsTable.id, [created.id]));
});

/* ─────────────────────────────────────────────────────────────────────────────
 * outreach.ts — :id ALIAS RESOLUTION (one aliased route per resource kind)
 * Each :id resolves to a different underlying owning resource BEFORE the
 * recruiter ownership check fires: message→jobId, campaign→campaignId,
 * step-message→enrollment→campaignId.
 * ──────────────────────────────────────────────────────────────────────────── */
test("outreach MESSAGE alias: /outreach/messages/:id resolves to jobId owner", async () => {
  const owner = await api("GET", `/outreach/messages/${id("msgX")}`, tok.recrX());
  assert.equal(owner.status, 200, "owning recruiter (via message.jobId) sees the message");

  const peer = await api("GET", `/outreach/messages/${id("msgX")}`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 (message.jobId not assigned)");

  const admin = await api("GET", `/outreach/messages/${id("msgX")}`, tok.tAdmin());
  assert.equal(admin.status, 200, "tenant_admin (non-recruiter) sees the message");
});

test("outreach CAMPAIGN alias: /outreach/campaigns/:campaignId resolves to campaign owner", async () => {
  const owner = await api("GET", `/outreach/campaigns/${id("campX")}`, tok.recrX());
  assert.equal(owner.status, 200, "owning recruiter (via campaign→jobId) sees the campaign");

  const peer = await api("GET", `/outreach/campaigns/${id("campX")}`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 (campaign's req not assigned)");

  const admin = await api("GET", `/outreach/campaigns/${id("campX")}`, tok.tAdmin());
  assert.equal(admin.status, 200, "tenant_admin sees the campaign");
});

test("outreach ENROLLMENT alias: /outreach/step-messages/:id resolves via enrollment→campaign owner", async () => {
  // peer recruiter is denied at the ownership gate (BEFORE the status check),
  // proving the :id was resolved through enrollment→campaign→job first.
  await stepMsgReset();
  const peer = await api("PATCH", `/outreach/step-messages/${id("stepX")}`, tok.recrY(), { subject: "Hacked" });
  assert.equal(peer.status, 404, "peer recruiter must 404 (enrollment's campaign req not assigned)");

  await stepMsgReset();
  const owner = await api("PATCH", `/outreach/step-messages/${id("stepX")}`, tok.recrX(), { subject: "Edited by owner" });
  assert.equal(owner.status, 200, "owning recruiter (via enrollment→campaign→jobId) can edit the draft");

  await stepMsgReset();
  const admin = await api("PATCH", `/outreach/step-messages/${id("stepX")}`, tok.tAdmin(), { subject: "Edited by admin" });
  assert.equal(admin.status, 200, "tenant_admin can edit the draft");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * intelligence.ts — GET /intelligence/job/:jobId (enforceOwnership jobId)
 * ──────────────────────────────────────────────────────────────────────────── */
test("intelligence job alias: enforceOwnership jobId (owned 2xx / peer 404 / admin 2xx)", async () => {
  const owner = await api("GET", `/intelligence/job/${id("jobX")}`, tok.recrX());
  assert.ok(owner.status < 300, `owning recruiter must pass the jobId ownership gate, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("GET", `/intelligence/job/${id("jobX")}`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 on an unassigned job's intelligence");

  const admin = await api("GET", `/intelligence/job/${id("jobX")}`, tok.tAdmin());
  assert.ok(admin.status < 300, `tenant_admin must pass the jobId ownership gate, got ${admin.status} ${JSON.stringify(admin.json)}`);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * agents.ts — the two formerly-UNAUTHENTICATED staff reads.
 * GET /agents/events/candidate/:candidateId  (candidate timeline, candidateId gate)
 * GET /agents/proctoring/:sessionId          (proctoring events, gate via session's candidate)
 * candX lives on jobX (recrX-owned), so recrY is the disjoint peer.
 * ──────────────────────────────────────────────────────────────────────────── */
test("agents events/candidate: no token → 401", async () => {
  const r = await fetch(baseUrl + `/agents/events/candidate/${id("candX")}`);
  assert.equal(r.status, 401, "unauthenticated read must be rejected");
});

test("agents events/candidate: owner 2xx / peer 404 / admin 2xx / unknown 404", async () => {
  const owner = await api("GET", `/agents/events/candidate/${id("candX")}`, tok.recrX());
  assert.ok(owner.status < 300, `owning recruiter should read the timeline, got ${owner.status}`);

  const peer = await api("GET", `/agents/events/candidate/${id("candX")}`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 on a candidate outside their reqs");

  const admin = await api("GET", `/agents/events/candidate/${id("candX")}`, tok.tAdmin());
  assert.ok(admin.status < 300, `tenant_admin should read the timeline, got ${admin.status}`);

  const unknown = await api("GET", `/agents/events/candidate/${id("nope")}`, tok.tAdmin());
  assert.equal(unknown.status, 404, "unknown candidate must 404 (existence hidden)");
});

test("agents proctoring: no token → 401", async () => {
  const r = await fetch(baseUrl + `/agents/proctoring/${id("isessX")}`);
  assert.equal(r.status, 401, "unauthenticated read must be rejected");
});

test("agents proctoring: owner 2xx / peer 404 / admin 2xx / unknown 404", async () => {
  const owner = await api("GET", `/agents/proctoring/${id("isessX")}`, tok.recrX());
  assert.ok(owner.status < 300, `owning recruiter should read proctoring, got ${owner.status}`);

  const peer = await api("GET", `/agents/proctoring/${id("isessX")}`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 on a session outside their reqs");

  const admin = await api("GET", `/agents/proctoring/${id("isessX")}`, tok.tAdmin());
  assert.ok(admin.status < 300, `tenant_admin should read proctoring, got ${admin.status}`);

  const unknown = await api("GET", `/agents/proctoring/${id("nope")}`, tok.tAdmin());
  assert.equal(unknown.status, 404, "unknown session must 404 (existence hidden)");
});

/* Non-staff role gate: these are STAFF surfaces. recruiterOwnsResource returns
 * TRUE for a candidate, so without the AGENT_VIEW_ROLES allowlist an in-tenant
 * candidate token would sail through — the role gate is load-bearing. */
test("agents events/candidate: candidate token → 403 (non-staff role)", async () => {
  const r = await api("GET", `/agents/events/candidate/${id("candX")}`, tok.candU());
  assert.equal(r.status, 403, "a candidate is not staff and must not read the timeline");
});

test("agents proctoring: candidate token → 403 (non-staff role)", async () => {
  const r = await api("GET", `/agents/proctoring/${id("isessX")}`, tok.candU());
  assert.equal(r.status, 403, "a candidate is not staff and must not read proctoring");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * sourcing.ts
 *  GET  /sourcing/candidates  — read stays TENANT-WIDE (SOURCED_POOL_VISIBILITY):
 *                               BOTH disjoint recruiters see the whole pool.
 *  POST /sourcing/ingest      — auth + tenant resolved from caller (no "acme").
 *  POST /sourcing/merge       — FULL recruiter ceiling on primary + duplicates.
 * ──────────────────────────────────────────────────────────────────────────── */
test("sourcing candidates: read is tenant-wide — a recruiter sees the whole pool (not just own reqs)", async () => {
  const rX = await api("GET", "/sourcing/candidates", tok.recrX());
  assert.equal(rX.status, 200, "recruiter read must succeed");
  const idsX = (rX.json as any[]).map((s) => s.id);
  assert.ok(idsX.includes(id("srcdX")) && idsX.includes(id("srcdY")),
    "recrX must see BOTH sourced rows — read is not narrowed to assigned reqs");

  const rY = await api("GET", "/sourcing/candidates", tok.recrY());
  const idsY = (rY.json as any[]).map((s) => s.id);
  assert.ok(idsY.includes(id("srcdX")) && idsY.includes(id("srcdY")),
    "disjoint recrY must ALSO see BOTH rows — confirms tenant-wide read exemption");
});

test("sourcing ingest: no token → 401", async () => {
  const r = await fetch(baseUrl + "/sourcing/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "linkedin" }),
  });
  assert.equal(r.status, 401, "unauthenticated ingest must be rejected");
});

test("sourcing ingest: tenant resolved from caller (not a hardcoded literal)", async () => {
  const r = await api("POST", "/sourcing/ingest", tok.recrX(), { source: "linkedin", profileUrl: "https://x.test/p" });
  assert.equal(r.status, 200, `ingest should succeed, got ${r.status} ${JSON.stringify(r.json)}`);
  assert.equal(r.json.tenantId, id("t"), "ingested row must land in the CALLER's tenant, never 'acme'");
});

test("sourcing merge: no token → 401", async () => {
  const r = await fetch(baseUrl + "/sourcing/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ primaryCandidateId: id("candX"), duplicateCandidateIds: [id("candX")] }),
  });
  assert.equal(r.status, 401, "unauthenticated merge must be rejected");
});

test("sourcing merge: owner 2xx / peer 404 / admin 2xx", async () => {
  const body = { primaryCandidateId: id("candX"), duplicateCandidateIds: [id("candX")] };

  const owner = await api("POST", "/sourcing/merge", tok.recrX(), body);
  assert.ok(owner.status < 300, `owning recruiter should merge, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("POST", "/sourcing/merge", tok.recrY(), body);
  assert.equal(peer.status, 404, "peer recruiter must 404 — merge write is req-ceilinged");

  const admin = await api("POST", "/sourcing/merge", tok.tAdmin(), body);
  assert.ok(admin.status < 300, `tenant_admin should merge (bypasses ceiling), got ${admin.status}`);
});

/* ═════════════════════════════════════════════════════════════════════════════
 * TIER-2 SWEEP — remaining converted files, one representative route each.
 * Disjoint two-recruiter model: recrX↔jobX, recrY↔jobY. A peer recruiter is the
 * disjoint one; a tenant_admin (non-recruiter) is ceilinged only by tenant scope.
 * The denial status is the one the REAL handler returns (404 for enforceOwnership
 * / recruiterOwnsResource; 403 for the explicit write-access gates; empty-200 for
 * the payload-scoped governance queue) — reported verbatim, not normalized.
 * ════════════════════════════════════════════════════════════════════════════ */

/* ai-messages.ts — PATCH /ai-messages/:id (loadGeneration resolves generation.jobId) */
test("ai-messages edit: owner 2xx / peer 404 / admin 2xx", async () => {
  const owner = await api("PATCH", `/ai-messages/${id("genX")}`, tok.recrX(), { body: "Edited by owner" });
  assert.ok(owner.status < 300, `owning recruiter should edit the draft, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("PATCH", `/ai-messages/${id("genX")}`, tok.recrY(), { body: "Hacked" });
  assert.equal(peer.status, 404, "peer recruiter must 404 (generation.jobId not assigned)");

  const admin = await api("PATCH", `/ai-messages/${id("genX")}`, tok.tAdmin(), { body: "Edited by admin" });
  assert.ok(admin.status < 300, `tenant_admin should edit the draft, got ${admin.status}`);
});

/* verify.ts — GET /verify/:candidateId (enforceOwnership candidateId → application→jobId) */
test("verify: owner 2xx / peer 404 / admin 2xx", async () => {
  const owner = await api("GET", `/verify/${id("candX")}`, tok.recrX());
  assert.ok(owner.status < 300, `owning recruiter should read verification, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("GET", `/verify/${id("candX")}`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 on a candidate outside their reqs");

  const admin = await api("GET", `/verify/${id("candX")}`, tok.tAdmin());
  assert.ok(admin.status < 300, `tenant_admin should read verification, got ${admin.status}`);
});

/* outcomes.ts — GET /outcomes?applicationId= (getGatedApp resolves application.jobId) */
test("outcomes: owner 2xx / peer 404 / admin 2xx", async () => {
  const owner = await api("GET", `/outcomes?applicationId=${id("appX")}`, tok.recrX());
  assert.ok(owner.status < 300, `owning recruiter should read the outcome, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("GET", `/outcomes?applicationId=${id("appX")}`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 on an application outside their reqs");

  const admin = await api("GET", `/outcomes?applicationId=${id("appX")}`, tok.tAdmin());
  assert.ok(admin.status < 300, `tenant_admin should read the outcome, got ${admin.status}`);
});

/* interviews.ts — GET /interviews/plans/:planId (recruiterOwnsResource plan.jobId) */
test("interviews plan: owner 2xx / peer 404 / admin 2xx", async () => {
  const owner = await api("GET", `/interviews/plans/${id("planX")}`, tok.recrX());
  assert.ok(owner.status < 300, `owning recruiter should read the plan, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("GET", `/interviews/plans/${id("planX")}`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 on a plan whose req is unassigned");

  const admin = await api("GET", `/interviews/plans/${id("planX")}`, tok.tAdmin());
  assert.ok(admin.status < 300, `tenant_admin should read the plan, got ${admin.status}`);
});

/* candidate-events.ts — GET /candidates/:candidateId/events (enforceOwnership candidateId) */
test("candidate-events: owner 2xx / peer 404 / admin 2xx", async () => {
  const owner = await api("GET", `/candidates/${id("candX")}/events`, tok.recrX());
  assert.ok(owner.status < 300, `owning recruiter should read the timeline, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("GET", `/candidates/${id("candX")}/events`, tok.recrY());
  assert.equal(peer.status, 404, "peer recruiter must 404 on a candidate outside their reqs");

  const admin = await api("GET", `/candidates/${id("candX")}/events`, tok.tAdmin());
  assert.ok(admin.status < 300, `tenant_admin should read the timeline, got ${admin.status}`);
});

/* invites.ts — POST /invites/generate (recruiterOwnsResource candidateId).
 * The peer is denied at the ceiling — recruiterOwnsResource fires BEFORE any side
 * effect (ensureCandidateUser mints a portal user, then a magic-link email is sent).
 * The owner/admin success path DOES dispatch a real SES email in this env, so we
 * temporarily unset the AWS credentials for the duration of this test to force
 * email.ts down its isEmailConfigured()===false SIMULATED-SEND branch (logs only,
 * still returns ok). isEmailConfigured() reads the creds live from process.env, so
 * this flips the behavior at call-time without a module-reload. The creds are
 * restored in `finally`. This keeps the sweep side-effect-free (no bounce emails to
 * the fake @t.test addresses) while still proving owner-2xx / admin-bypass for the
 * candidateId ceiling on this file's own route. Portal users + invite tokens minted
 * by the owner/admin calls are swept in cleanup() (by-tenant delete). */
test("invites generate: owner 2xx / peer 404 / admin 2xx (email forced to simulated send)", async () => {
  const savedKey = process.env.AWS_ACCESS_KEY_ID;
  const savedSecret = process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  try {
    const peer = await api("POST", "/invites/generate", tok.recrY(), { candidateId: id("candX") });
    assert.equal(peer.status, 404, "peer recruiter must 404 (candidate's req unassigned) before any user/token is minted or email is sent");

    const owner = await api("POST", "/invites/generate", tok.recrX(), { candidateId: id("candX") });
    assert.ok(owner.status < 300, `owning recruiter should generate the invite, got ${owner.status} ${JSON.stringify(owner.json)}`);

    const admin = await api("POST", "/invites/generate", tok.tAdmin(), { candidateId: id("candX") });
    assert.ok(admin.status < 300, `tenant_admin should generate the invite (bypasses ceiling), got ${admin.status} ${JSON.stringify(admin.json)}`);
  } finally {
    if (savedKey !== undefined) process.env.AWS_ACCESS_KEY_ID = savedKey;
    if (savedSecret !== undefined) process.env.AWS_SECRET_ACCESS_KEY = savedSecret;
  }
});

/* recruiter-avatar.ts — GET /recruiter-avatar/video-jobs/:id.
 * This route is TENANT/DATA-SCOPED (resolveStaff), NOT requisition-ceilinged —
 * avatar renders are recruiter-authored assets, so a same-tenant peer recruiter
 * legitimately succeeds by design. Its success path calls HeyGen, so we assert
 * only the cheap gate outcomes that fire BEFORE the poll: no-token→401,
 * non-staff→403, unknown-id→404. Documented as a tenant-scoped exemption. */
test("recruiter-avatar video-jobs: no token → 401", async () => {
  const r = await fetch(baseUrl + `/recruiter-avatar/video-jobs/${id("nope")}`);
  assert.equal(r.status, 401, "unauthenticated read must be rejected");
});

test("recruiter-avatar video-jobs: candidate token → 403 (non-staff) / unknown id → 404 (staff)", async () => {
  const cand = await api("GET", `/recruiter-avatar/video-jobs/${id("nope")}`, tok.candU());
  assert.equal(cand.status, 403, "a candidate is not staff and must not read avatar jobs");

  const unknown = await api("GET", `/recruiter-avatar/video-jobs/${id("nope")}`, tok.tAdmin());
  assert.equal(unknown.status, 404, "unknown avatar job must 404 before the HeyGen poll");
});

/* conversation-drafts.ts — POST /conversation-drafts/:id/reject (recruiterOwnsDraft draft.jobId).
 * /reject shares the SAME ownership ceiling as /send but performs no external send. */
test("conversation-drafts reject: owner 2xx / peer 404 / admin 2xx", async () => {
  await draftReset();
  const peer = await api("POST", `/conversation-drafts/${id("draftX")}/reject`, tok.recrY(), { reason: "nope" });
  assert.equal(peer.status, 404, "peer recruiter must 404 (draft's req unassigned) before the status check");

  await draftReset();
  const owner = await api("POST", `/conversation-drafts/${id("draftX")}/reject`, tok.recrX(), { reason: "handled offline" });
  assert.ok(owner.status < 300, `owning recruiter should reject the draft, got ${owner.status} ${JSON.stringify(owner.json)}`);

  await draftReset();
  const admin = await api("POST", `/conversation-drafts/${id("draftX")}/reject`, tok.tAdmin(), { reason: "handled offline" });
  assert.ok(admin.status < 300, `tenant_admin should reject the draft, got ${admin.status}`);
});

/* talent_match.ts — POST /talent-match (requireRequisitionWriteAccess → 403 for peer).
 * A WRITE gate: the disjoint peer is denied 403 (not 404) by design. Heuristic
 * scorer (no LLM). Written match rows are swept in cleanup() (by-tenant delete). */
test("talent-match: owner 2xx / peer 403 (write gate) / admin 2xx", async () => {
  const body = { candidateId: id("candX"), jobId: id("jobX") };

  const owner = await api("POST", "/talent-match", tok.recrX(), body);
  assert.ok(owner.status < 300, `owning recruiter should score, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("POST", "/talent-match", tok.recrY(), body);
  assert.equal(peer.status, 403, "peer recruiter must 403 — talent-match write is req-ceilinged (requireRequisitionWriteAccess)");

  const admin = await api("POST", "/talent-match", tok.tAdmin(), body);
  assert.ok(admin.status < 300, `tenant_admin should score (bypasses ceiling), got ${admin.status}`);
});

/* icp.ts — PATCH /jobs/:jobId/icp (requireIcpWriteAccess → 403 for peer).
 * A WRITE gate: the disjoint peer is denied 403 (not 404) by design. PATCH edits
 * the latest ICP version in-place (no LLM, unlike POST). */
test("icp edit: owner 2xx / peer 403 (write gate) / admin 2xx", async () => {
  const body = { requiredSkills: ["TypeScript"] };

  const owner = await api("PATCH", `/jobs/${id("jobX")}/icp`, tok.recrX(), body);
  assert.ok(owner.status < 300, `owning recruiter should edit the ICP, got ${owner.status} ${JSON.stringify(owner.json)}`);

  const peer = await api("PATCH", `/jobs/${id("jobX")}/icp`, tok.recrY(), body);
  assert.equal(peer.status, 403, "peer recruiter must 403 — ICP write is req-ceilinged (requireIcpWriteAccess)");

  const admin = await api("PATCH", `/jobs/${id("jobX")}/icp`, tok.tAdmin(), body);
  assert.ok(admin.status < 300, `tenant_admin should edit the ICP (bypasses ceiling), got ${admin.status}`);
});

/* governance.ts — GET /applications/pending-human-review (payload-scoped to assigned reqs).
 * Not an id-route: the ceiling narrows the LIST to the caller's assigned jobIds, so
 * a peer gets a 200 with an EMPTY payload rather than a 404. appX (on jobX) carries
 * an AI recommendation + null final decision, so it is a genuine queue member. */
test("governance pending-review: owner sees appX / peer sees empty / admin sees appX", async () => {
  const pickIds = (j: any): Set<string> => {
    const rows = Array.isArray(j) ? j : (j?.applications ?? j?.items ?? j?.queue ?? j?.rows ?? []);
    return new Set(rows.map((r: any) => r.id ?? r.applicationId));
  };

  const owner = await api("GET", "/applications/pending-human-review", tok.recrX());
  assert.equal(owner.status, 200, "owning recruiter should read its queue");
  assert.ok(pickIds(owner.json).has(id("appX")), "owning recruiter must see appX in its review queue");

  const peer = await api("GET", "/applications/pending-human-review", tok.recrY());
  assert.equal(peer.status, 200, "peer recruiter still gets a 200 (list route)");
  assert.ok(!pickIds(peer.json).has(id("appX")), "peer recruiter's queue must be scoped away from appX (empty of it)");

  const admin = await api("GET", "/applications/pending-human-review", tok.tAdmin());
  assert.equal(admin.status, 200, "tenant_admin should read the queue");
  assert.ok(pickIds(admin.json).has(id("appX")), "tenant_admin must see appX (tenant-scoped, not req-ceilinged)");
});
