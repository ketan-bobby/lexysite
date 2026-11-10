import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { jsonObjectSchema, jsonRowsSchema } from "../test-utils/json-response";
import crypto from "node:crypto";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  interviewPlansTable,
  interviewSessionsTable,
  candidateAiConsentTable,
  auditLogsTable,
} from "@workspace/db";
import { signCookie, cookieNameFor } from "../lib/interview-session-cookie";
import { issueToken } from "../lib/auth-token";
import { CURRENT_AI_CONSENT_VERSION, getCurrentDisclosure } from "../lib/ai-consent";
import interviewsRouter from "./interviews";

const P = `capdiag_${crypto.randomUUID().slice(0, 8)}_`;
const T = P + "tenant",
  C = P + "candidate",
  J = P + "job",
  U = P + "admin",
  F = P + "foreign";
const UA = "capture-diagnostic-test",
  AL = "en-US";
const nonce = crypto.randomBytes(18).toString("hex");
let sid: string, planId: string, base: string, server: Server;
const event = () => ({
  eventId: crypto.randomUUID(),
  attemptId: crypto.randomUUID(),
  turnNumber: 1,
  event: "capture_decision",
  reason: "weak_signal",
  longestRunMs: 16,
  thresholdMs: 200,
  sampleCount: 4,
  aboveThresholdSamples: 2,
  textPresent: true,
  inViewport: true,
});
const cookie = () => `${cookieNameFor(sid)}=${encodeURIComponent(signCookie(sid, nonce))}`;
async function request(method: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/interviews/${sid}/capture-diagnostics`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      "User-Agent": UA,
      "Accept-Language": AL,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  await dbAdmin.insert(tenantsTable).values([
    { id: T, name: "Capture diagnostics test", slug: T },
    { id: F, name: "Foreign diagnostic test", slug: F },
  ]);
  await dbAdmin.insert(usersTable).values([
    {
      id: U,
      tenantId: T,
      email: `${U}@test.invalid`,
      name: "Test admin",
      passwordHash: "x",
      role: "tenant_admin",
      status: "active",
    },
    {
      id: F,
      tenantId: F,
      email: `${F}@test.invalid`,
      name: "Foreign admin",
      passwordHash: "x",
      role: "tenant_admin",
      status: "active",
    },
  ]);
  await dbAdmin.insert(jobsTable).values({
    id: J,
    tenantId: T,
    title: "Diagnostic test",
    description: "No real interview",
    status: "active",
  });
  await dbAdmin.insert(candidatesTable).values({
    id: C,
    tenantId: T,
    firstName: "Test",
    lastName: "Capture",
    email: `${C}@test.invalid`,
    pool: "tenant",
    source: "linkedin",
  });
  const [plan] = await dbAdmin
    .insert(interviewPlansTable)
    .values({
      tenantId: T,
      jobId: J,
      title: "Diagnostic test",
      interviewType: "general",
      language: "en-US",
      questions: [],
      estimatedDurationMinutes: 1,
    })
    .returning();
  planId = plan.id;
  const [session] = await dbAdmin
    .insert(interviewSessionsTable)
    .values({
      tenantId: T,
      candidateId: C,
      applicationId: "direct",
      planId,
      status: "in_progress",
      totalQuestions: 1,
      currentQuestionIndex: 0,
      answers: [],
      bindSecret: crypto.randomBytes(32).toString("hex"),
      cookieNonce: nonce,
      bindFingerprint: crypto.createHash("sha256").update(`${UA}|${AL}||`).digest("hex"),
      expiresAt: new Date(Date.now() + 3600000),
    })
    .returning();
  sid = session.id;
  await dbAdmin.insert(candidateAiConsentTable).values({
    candidateId: C,
    consentVersion: CURRENT_AI_CONSENT_VERSION,
    disclosureSnapshot: getCurrentDisclosure(),
  });
  const app = express();
  app.use(express.json(), cookieParser(), interviewsRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbAdmin.delete(auditLogsTable).where(eq(auditLogsTable.tenantId, T));
  await dbAdmin.delete(candidateAiConsentTable).where(eq(candidateAiConsentTable.candidateId, C));
  await dbAdmin.delete(interviewSessionsTable).where(eq(interviewSessionsTable.tenantId, T));
  await dbAdmin.delete(interviewPlansTable).where(eq(interviewPlansTable.id, planId));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, C));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.id, J));
  for (const id of [U, F]) await dbAdmin.delete(usersTable).where(eq(usersTable.id, id));
  for (const id of [T, F]) await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, id));
});

test("diagnostics reject tokenless writes and cross-origin cookie writes", async () => {
  assert.equal((await request("POST", event())).status, 401);
  assert.equal(
    (await request("POST", event(), { Cookie: cookie(), Origin: "https://untrusted.invalid" }))
      .status,
    403,
  );
});
test("safe events persist once and never alter answers or proctoring", async () => {
  const body = event();
  assert.equal((await request("POST", body, { Cookie: cookie() })).status, 202);
  assert.equal((await request("POST", body, { Cookie: cookie() })).status, 202);
  const rows = await dbAdmin
    .select()
    .from(auditLogsTable)
    .where(eq(auditLogsTable.id, body.eventId));
  assert.equal(rows.length, 1);
  assert.equal(jsonObjectSchema.parse(rows[0].metadata).clientReported, true);
  const [s] = await dbAdmin
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, sid));
  assert.deepEqual(s.answers, []);
  assert.equal(s.currentQuestionIndex, 0);
});
test("arbitrary text and spoofed tenant fields are rejected, not stored", async () => {
  for (const extra of [
    { answerText: "PRIVATE ANSWER" },
    { audio: "base64" },
    { tenantId: F },
    { turnNumber: 1.5 },
    { sampleCount: 1000001 },
  ]) {
    assert.equal(
      (await request("POST", { ...event(), ...extra }, { Cookie: cookie() })).status,
      400,
    );
  }
});
test("staff ownership gates diagnostic reads and candidates cannot read the staff stream", async () => {
  const good = await request("GET", undefined, {
    Authorization: `Bearer ${issueToken({ userId: U, tenantId: T, role: "tenant_admin" })}`,
  });
  assert.equal(good.status, 200);
  assert.equal(jsonRowsSchema.parse(jsonObjectSchema.parse(good.json).events).length, 1);
  assert.ok(!JSON.stringify(good.json).includes("PRIVATE ANSWER"));
  assert.equal((await request("GET", undefined, { Cookie: cookie() })).status, 403);
  const foreign = await request("GET", undefined, {
    Authorization: `Bearer ${issueToken({ userId: F, tenantId: F, role: "tenant_admin" })}`,
  });
  assert.ok([401, 403, 404].includes(foreign.status));
});
test("revoked consent and completed sessions cannot write diagnostic events", async () => {
  await dbAdmin
    .update(candidateAiConsentTable)
    .set({ revokedAt: new Date() })
    .where(eq(candidateAiConsentTable.candidateId, C));
  assert.equal((await request("POST", event(), { Cookie: cookie() })).status, 412);
  await dbAdmin
    .update(interviewSessionsTable)
    .set({ status: "completed" })
    .where(eq(interviewSessionsTable.id, sid));
  assert.equal((await request("POST", event(), { Cookie: cookie() })).status, 410);
});
