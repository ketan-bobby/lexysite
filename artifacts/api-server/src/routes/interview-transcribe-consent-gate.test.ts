/**
 * interview-transcribe-consent-gate.test.ts — Session + consent gate on the
 * candidate voice-audio STT endpoint.
 *
 *   POST /interviews/:interviewId/transcribe
 *
 * Before the fix, transcription lived at the UNAUTHENTICATED path
 * POST /interviews/transcribe — no session binding, no consent check: anyone
 * could POST raw audio and have it processed server-side, and the "candidate
 * consented first" claim rested entirely on client-side ordering.
 *
 * The fix moves the route under the session path so the path-scoped HMAC
 * interview cookie (minted ONLY by /begin, which itself enforces the AI +
 * biometric consent gate) authenticates every audio segment, and RE-CHECKS
 * hasActiveAiConsent per request so a mid-session revocation stops further
 * audio processing (412 AI_CONSENT_REQUIRED).
 *
 * Harness mirrors interview-generate-link-idempotency.test.ts: mount the REAL
 * interviews router on a bare Express app (plus cookieParser + the same raw
 * body mount app.ts uses), seed via dbAdmin, and drive over HTTP. We forge a
 * VALID cookie with the real signCookie helper so the tests isolate exactly
 * the layer under test (missing cookie → 401, valid cookie but no consent →
 * 412, valid cookie + active consent → 200).
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

const P = "tcg_";
const T = P + "tenant";
const CAND_NO_CONSENT = P + "cand_no_consent";
const CAND_CONSENTED = P + "cand_consented";
const CAND_REVOKED = P + "cand_revoked";

/* Fixed headers so the request fingerprint is deterministic; must match the
   sha256 recipe in fingerprintFor() (ua|accept-language|sec-ch-ua|platform). */
const UA = "tcg-test-agent/1.0";
const AL = "en-US";
const FP = crypto.createHash("sha256").update(`${UA}|${AL}||`).digest("hex");

let server: Server;
let baseUrl: string;
let planId: string;
const sessionIds: string[] = [];

async function seedSession(candidateId: string, opts: { bound?: boolean } = {}): Promise<{ id: string; nonce: string }> {
  const nonce = crypto.randomBytes(18).toString("hex");
  const bound = opts.bound !== false;
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
    ...(bound
      ? {
          bindSecret: crypto.randomBytes(32).toString("hex"),
          cookieNonce: nonce,
          bindFingerprint: FP,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }
      : {}),
  } as any).returning({ id: interviewSessionsTable.id });
  sessionIds.push(row.id);
  return { id: row.id, nonce };
}

/** POST a tiny audio blob to the transcribe route. */
async function postAudio(path: string, cookie?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "audio/webm",
      "User-Agent": UA,
      "Accept-Language": AL,
      "X-Language": "en-US",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function cookieFor(sid: string, nonce: string): string {
  return `${cookieNameFor(sid)}=${encodeURIComponent(signCookie(sid, nonce))}`;
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
    tenantId: T, jobId: P + "job", title: "Gate Test Interview", interviewType: "general",
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
  /* Same raw-body mount app.ts uses (router path is unprefixed in tests). */
  app.use(/^\/interviews\/[A-Za-z0-9_-]+\/transcribe$/, express.raw({ type: "*/*", limit: "10mb" }));
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

test("legacy unauthenticated path POST /interviews/transcribe is gone", async () => {
  const r = await postAudio(`/interviews/transcribe`);
  assert.equal(r.status, 404, "old ungated route must not exist");
});

test("no cookie + never-begun session → 401 (fails closed, no audio processed)", async () => {
  const { id } = await seedSession(CAND_CONSENTED, { bound: false });
  const r = await postAudio(`/interviews/${id}/transcribe`);
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "session_not_started");
});

test("bound session but missing/invalid cookie → 401", async () => {
  const { id } = await seedSession(CAND_CONSENTED);
  const noCookie = await postAudio(`/interviews/${id}/transcribe`);
  assert.equal(noCookie.status, 401, "no cookie rejected");
  const badCookie = await postAudio(`/interviews/${id}/transcribe`, `${cookieNameFor(id)}=garbage`);
  assert.equal(badCookie.status, 401, "forged cookie rejected");
});

test("nonexistent session → 404", async () => {
  const r = await postAudio(`/interviews/${P}does_not_exist/transcribe`);
  assert.equal(r.status, 404);
});

test("valid session cookie but NO consent row → 412 AI_CONSENT_REQUIRED", async () => {
  const { id, nonce } = await seedSession(CAND_NO_CONSENT);
  const r = await postAudio(`/interviews/${id}/transcribe`, cookieFor(id, nonce));
  assert.equal(r.status, 412, "consent is re-verified server-side, not trusted from the client");
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
});

test("valid session cookie but consent REVOKED → 412 (mid-session revocation stops audio)", async () => {
  const { id, nonce } = await seedSession(CAND_REVOKED);
  const r = await postAudio(`/interviews/${id}/transcribe`, cookieFor(id, nonce));
  assert.equal(r.status, 412);
  assert.equal(r.json.error, "AI_CONSENT_REQUIRED");
});

test("valid session cookie + active consent → request passes the gate (200)", async () => {
  const { id, nonce } = await seedSession(CAND_CONSENTED);
  const r = await postAudio(`/interviews/${id}/transcribe`, cookieFor(id, nonce));
  assert.equal(r.status, 200, "consented session is admitted");
  assert.ok("transcript" in r.json, "returns a transcript payload (empty is fine without STT providers)");
});
