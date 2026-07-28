/**
 * interview-runtime-consent-gate.test.ts — Per-request AI-consent re-check on
 * the desktop interview runtime routes:
 *
 *   POST /interviews/:interviewId/converse
 *   POST /interviews/:interviewId/save-turn
 *   POST /interviews/:interviewId/end
 *   POST /interviews/:interviewId/answer
 *   POST /interviews/:interviewId/submit-code
 *   POST /interviews/:interviewId/proctor-event
 *   POST /interviews/:interviewId/work-auth
 *   POST /interviews/:interviewId/upload-token
 *
 * Check 3 found an asymmetry: only /transcribe (the mobile server-STT path)
 * re-verified consent per request, so a desktop candidate who REVOKED consent
 * mid-interview could still run the session to completion — Web Speech capture
 * is in-browser and converse/save-turn/end only required the session cookie
 * (which proves consent existed at /begin time, not now).
 *
 * The fix applies the same requireActiveAiConsent middleware used by
 * /transcribe to these routes: revoked or missing consent → 412
 * AI_CONSENT_REQUIRED, which the room client's requireConsent() handles by
 * resetting the UI to the consent gate.
 *
 * Harness mirrors interview-transcribe-consent-gate.test.ts: mount the REAL
 * interviews router on a bare Express app, seed via dbAdmin, forge a VALID
 * cookie with the real signCookie helper, and drive over HTTP.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import { inArray, eq } from "drizzle-orm";
import {
  dbAdmin,
  interviewPlansTable,
  interviewSessionsTable,
  candidateAiConsentTable,
} from "@workspace/db";
import { signCookie, cookieNameFor } from "../lib/interview-session-cookie";
import { CURRENT_AI_CONSENT_VERSION, getCurrentDisclosure } from "../lib/ai-consent";
import interviewsRouter from "./interviews";

const P = "rcg_";
const T = P + "tenant";
const CAND_NO_CONSENT = P + "cand_no_consent";
const CAND_CONSENTED = P + "cand_consented";
const CAND_REVOKED = P + "cand_revoked";

/* Fixed headers so the request fingerprint is deterministic; must match the
   sha256 recipe in fingerprintFor() (ua|accept-language|sec-ch-ua|platform). */
const UA = "rcg-test-agent/1.0";
const AL = "en-US";
const FP = crypto.createHash("sha256").update(`${UA}|${AL}||`).digest("hex");

let server: Server;
let baseUrl: string;
let planId: string;
const sessionIds: string[] = [];

async function seedSession(candidateId: string): Promise<{ id: string; nonce: string }> {
  const nonce = crypto.randomBytes(18).toString("hex");
  const [row] = await dbAdmin.insert(interviewSessionsTable).values({
    tenantId: T,
    applicationId: "direct",
    planId,
    candidateId,
    language: "en-US",
    status: "in_progress",
    currentQuestionIndex: 0,
    totalQuestions: 1,
    answers: [],
    bindSecret: crypto.randomBytes(32).toString("hex"),
    cookieNonce: nonce,
    bindFingerprint: FP,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  } as any).returning({ id: interviewSessionsTable.id });
  sessionIds.push(row.id);
  return { id: row.id, nonce };
}

function cookieFor(sid: string, nonce: string): string {
  return `${cookieNameFor(sid)}=${encodeURIComponent(signCookie(sid, nonce))}`;
}

/** POST JSON to a runtime route. requireSameOriginPost fails closed on a
    missing Origin/Referer, so send a same-origin Origin header — the
    middleware always allows the request's own host. */
async function postJson(path: string, body: any, cookie?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": baseUrl,
      "User-Agent": UA,
      "Accept-Language": AL,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function cleanup() {
  if (sessionIds.length) {
    await dbAdmin.delete(interviewSessionsTable).where(inArray(interviewSessionsTable.id, sessionIds));
  }
  await dbAdmin.delete(candidateAiConsentTable)
    .where(inArray(candidateAiConsentTable.candidateId, [CAND_NO_CONSENT, CAND_CONSENTED, CAND_REVOKED]));
  await dbAdmin.delete(interviewPlansTable).where(eq(interviewPlansTable.tenantId, T));
}

before(async () => {
  await cleanup();
  const [plan] = await dbAdmin.insert(interviewPlansTable).values({
    tenantId: T, jobId: P + "job", title: "Runtime Gate Test Interview", interviewType: "general",
    language: "en-US", questions: [{ id: "q1", text: "Q", category: "behavioral", order: 1 }],
    estimatedDurationMinutes: 30,
  } as any).returning({ id: interviewPlansTable.id });
  planId = plan.id;

  /* Active consent for CAND_CONSENTED; revoked row for CAND_REVOKED. */
  await dbAdmin.insert(candidateAiConsentTable).values([
    {
      candidateId: CAND_CONSENTED,
      consentVersion: CURRENT_AI_CONSENT_VERSION,
      disclosureSnapshot: getCurrentDisclosure() as any,
    },
    {
      candidateId: CAND_REVOKED,
      consentVersion: CURRENT_AI_CONSENT_VERSION,
      disclosureSnapshot: getCurrentDisclosure() as any,
      revokedAt: new Date(),
    },
  ] as any);

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/", interviewsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ── converse ─────────────────────────────────────────────────────────────── */

test("converse: no cookie → 401 (consent gate is behind session auth)", async () => {
  const { id } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/converse`, { history: [], questionNumber: 1, totalQuestions: 1 });
  assert.equal(r.status, 401);
});

test("converse: valid cookie but consent REVOKED mid-session → 412 AI_CONSENT_REQUIRED", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/converse`, { history: [], questionNumber: 1, totalQuestions: 1 }, cookieFor(id, nonce));
  assert.equal(r.status, 412, "desktop AI turn must halt after revocation");
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
});

test("converse: valid cookie but NO consent row → 412", async () => {
  const { id, nonce } = await seedSession(CAND_NO_CONSENT);
  const r = await postJson(`/interviews/${id}/converse`, { history: [], questionNumber: 1, totalQuestions: 1 }, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
});

/* ── save-turn ────────────────────────────────────────────────────────────── */

test("save-turn: valid cookie but consent REVOKED → 412 (answer capture halts)", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/save-turn`, { questionText: "Q", answerText: "A", turnNumber: 1 }, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
});

test("save-turn: valid cookie + ACTIVE consent → passes the gate (200, control case)", async () => {
  const { id, nonce } = await seedSession(CAND_CONSENTED);
  const r = await postJson(`/interviews/${id}/save-turn`, { questionText: "Q", answerText: "A", turnNumber: 1 }, cookieFor(id, nonce));
  assert.equal(r.status, 200, "consented desktop session keeps working — the gate only blocks revoked/missing consent");
});

/* ── end ──────────────────────────────────────────────────────────────────── */

test("end: valid cookie but consent REVOKED → 412 (no AI grading of a revoked candidate's answers)", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/end`, {}, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
  /* The session must NOT have been finalized. */
  const [row] = await dbAdmin.select({ status: interviewSessionsTable.status })
    .from(interviewSessionsTable).where(eq(interviewSessionsTable.id, id)).limit(1);
  assert.notEqual(row.status, "completed", "412 must short-circuit before completion");
});

test("end: no cookie → 401", async () => {
  const { id } = await seedSession(CAND_CONSENTED);
  const r = await postJson(`/interviews/${id}/end`, {});
  assert.equal(r.status, 401);
});

/* ── proctor-event (the surveillance channel) ────────────────────────────── */

test("proctor-event: valid cookie but consent REVOKED → 412 (surveillance capture halts)", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/proctor-event`, { type: "tab_switch" }, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
});

test("proctor-event: valid cookie + ACTIVE consent → passes the gate (control case)", async () => {
  const { id, nonce } = await seedSession(CAND_CONSENTED);
  const r = await postJson(`/interviews/${id}/proctor-event`, { type: "tab_switch" }, cookieFor(id, nonce));
  assert.equal(r.status, 200, "consented session keeps proctoring — the gate only blocks revoked/missing consent");
});

/* ── answer ──────────────────────────────────────────────────────────────── */

test("answer: valid cookie but consent REVOKED → 412 (no AI grading of the answer)", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/answer`, { questionId: "q1", answerText: "my answer" }, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
  /* The answer must NOT have been persisted. */
  const [row] = await dbAdmin.select({ answers: interviewSessionsTable.answers })
    .from(interviewSessionsTable).where(eq(interviewSessionsTable.id, id)).limit(1);
  assert.equal(((row.answers as any[]) || []).length, 0, "412 must short-circuit before answer capture");
});

/* ── submit-code ─────────────────────────────────────────────────────────── */

test("submit-code: valid cookie but consent REVOKED → 412 (no AI code evaluation)", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/submit-code`, { questionId: "q1", code: "print(1)", language: "python" }, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
});

/* ── work-auth ───────────────────────────────────────────────────────────── */

test("work-auth: valid cookie but consent REVOKED → 412 (no work-auth extraction)", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/work-auth`, { answerText: "Yes, I am authorized" }, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
});

/* ── upload-token ────────────────────────────────────────────────────────── */

test("upload-token: valid cookie but consent REVOKED → 412 (no recording-upload capability minted)", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postJson(`/interviews/${id}/upload-token`, {}, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
  assert.equal(r.json.uploadToken, undefined, "no token may leak alongside the 412");
});
