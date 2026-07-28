/**
 * interview-generate-link-idempotency.test.ts — POST /interviews/generate-link
 * must be safe to double-fire (recruiter double-click, two tabs, retried request).
 *
 * The unique identity of a "live" interview link is (tenant, candidate,
 * plan.jobId, plan.interviewType). jobId + type live on interview_plans, not
 * interview_sessions, so the guard is app-level (fast-path pre-check) + a
 * per-identity transaction advisory lock in the mint transaction — NOT a unique
 * index. This test pins the observable contract:
 *
 *   1. IDEMPOTENT  — a live session is returned unchanged (200, reused:true);
 *      no second session, no second interview-credit row.
 *   2. CONCURRENT double-click on an EXISTING live session → same result.
 *   3. FRESH mint on a clean identity → 201, reused:false, exactly one session
 *      + exactly one credit.
 *   4. CONCURRENT fresh mint (true race, no pre-existing session) → the advisory
 *      lock serializes: both requests resolve to the SAME session id, one
 *      session, one credit.
 *   5. REGENERATE — expires the live session and mints a fresh one (new id,
 *      fresh credit).
 *
 * Harness mirrors morning-report.test.ts: mount the REAL interviews router on a
 * bare Express app, seed via dbAdmin (BYPASSRLS), drive over HTTP with a real
 * bearer token. Outside withTenantContext the `db` proxy falls through to
 * dbAdmin, so RLS never filters. The AI question generator is not stubbed — the
 * route falls back to canned questions when it's unavailable, so a mint is
 * hermetic regardless.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  interviewPlansTable,
  interviewSessionsTable,
  creditUsageEventsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import interviewsRouter from "./interviews";

const P = "glidem_";
const id = (s: string) => P + s;
const T = id("t");
const JOB = id("job");
const CAND = id("cand");
const ADMIN = id("admin");

let server: Server;
let baseUrl: string;

const tok = () => issueToken({ userId: ADMIN, role: "tenant_admin", tenantId: T });

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

async function cleanup() {
  await dbAdmin.delete(interviewSessionsTable).where(eq(interviewSessionsTable.tenantId, T));
  await dbAdmin.delete(interviewPlansTable).where(eq(interviewPlansTable.tenantId, T));
  await dbAdmin.delete(creditUsageEventsTable).where(eq(creditUsageEventsTable.tenantId, T));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, T));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, T));
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, T));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, T));
}

/** Base fixture: an approved (status active) job, a tenant_admin caller, and one
 *  candidate. No interview session yet. */
async function seedBase() {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values({ id: T, name: "GL Idem Tenant", slug: T, plan: "enterprise" });
  await dbAdmin.insert(usersTable).values({
    id: ADMIN, tenantId: T, email: ADMIN + "@t.test", name: "Admin", passwordHash: "x", role: "tenant_admin", status: "active",
  });
  await dbAdmin.insert(jobsTable).values({ id: JOB, tenantId: T, title: "Engineer", description: "Build things", status: "active" });
  await dbAdmin.insert(candidatesTable).values({
    id: CAND, tenantId: T, firstName: "Cand", lastName: "One", email: CAND + "@t.test", pool: "tenant", source: "linkedin",
  });
}

/** Add a live scheduled session (+plan) for the (T, CAND, JOB, general) identity. */
async function seedLiveSession() {
  const [plan] = await dbAdmin.insert(interviewPlansTable).values({
    tenantId: T, jobId: JOB, title: "General Interview", interviewType: "general", language: "en-US",
    questions: [{ id: "q1", text: "Tell me about yourself", category: "behavioral", order: 1 }],
    estimatedDurationMinutes: 64,
  } as any).returning();
  const [session] = await dbAdmin.insert(interviewSessionsTable).values({
    tenantId: T, applicationId: "direct", planId: plan.id, candidateId: CAND, language: "en-US",
    status: "scheduled", currentQuestionIndex: 0, totalQuestions: 1, startedAt: null, answers: [],
  } as any).returning();
  return { plan, session };
}

/** All sessions (id + status) for the (T, CAND, JOB, general) identity. */
async function sessionsForIdentity(): Promise<Array<{ id: string; status: string }>> {
  return dbAdmin
    .select({ id: interviewSessionsTable.id, status: interviewSessionsTable.status })
    .from(interviewSessionsTable)
    .innerJoin(interviewPlansTable, eq(interviewSessionsTable.planId, interviewPlansTable.id))
    .where(and(
      eq(interviewSessionsTable.tenantId, T),
      eq(interviewSessionsTable.candidateId, CAND),
      eq(interviewPlansTable.jobId, JOB),
      eq(interviewPlansTable.interviewType, "general" as any),
    )) as any;
}

async function interviewCreditCount(): Promise<number> {
  const rows = await dbAdmin
    .select({ id: creditUsageEventsTable.id })
    .from(creditUsageEventsTable)
    .where(and(eq(creditUsageEventsTable.tenantId, T), eq(creditUsageEventsTable.kind, "interview")));
  return rows.length;
}

before(async () => {
  const app = express();
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

test("idempotent: a live session is returned unchanged — no new session, no new credit", async () => {
  await seedBase();
  const { session } = await seedLiveSession();
  // A pre-existing credit row so we can prove the reuse path adds none.
  await dbAdmin.insert(creditUsageEventsTable).values({ tenantId: T, kind: "interview", refId: session.id, metadata: { source: "seed" } });

  const r = await api("POST", "/interviews/generate-link", tok(), { jobId: JOB, candidateId: CAND, interviewType: "general" });
  assert.equal(r.status, 200, "returns 200 (not a fresh 201)");
  assert.equal(r.json.reused, true);
  assert.equal(r.json.sessionId, session.id, "returns the same session");

  assert.equal((await sessionsForIdentity()).length, 1, "no second session minted");
  assert.equal(await interviewCreditCount(), 1, "no second credit recorded on reuse");
});

test("concurrent double-click on an existing live session → one session, one credit", async () => {
  await seedBase();
  const { session } = await seedLiveSession();
  await dbAdmin.insert(creditUsageEventsTable).values({ tenantId: T, kind: "interview", refId: session.id, metadata: { source: "seed" } });

  const [a, b] = await Promise.all([
    api("POST", "/interviews/generate-link", tok(), { jobId: JOB, candidateId: CAND, interviewType: "general" }),
    api("POST", "/interviews/generate-link", tok(), { jobId: JOB, candidateId: CAND, interviewType: "general" }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json.sessionId, session.id);
  assert.equal(b.json.sessionId, session.id);

  assert.equal((await sessionsForIdentity()).length, 1);
  assert.equal(await interviewCreditCount(), 1);
});

test("fresh mint on a clean identity records exactly one session and one credit", async () => {
  await seedBase();
  const r = await api("POST", "/interviews/generate-link", tok(), { jobId: JOB, candidateId: CAND, interviewType: "general", questionCount: 3 });
  assert.equal(r.status, 201);
  assert.equal(r.json.reused, false);
  assert.ok(r.json.sessionId);

  assert.equal((await sessionsForIdentity()).length, 1);
  assert.equal(await interviewCreditCount(), 1);
});

test("concurrent fresh mint (true race) → advisory lock yields one session, one credit", async () => {
  await seedBase();
  const [a, b] = await Promise.all([
    api("POST", "/interviews/generate-link", tok(), { jobId: JOB, candidateId: CAND, interviewType: "general", questionCount: 3 }),
    api("POST", "/interviews/generate-link", tok(), { jobId: JOB, candidateId: CAND, interviewType: "general", questionCount: 3 }),
  ]);
  assert.ok([200, 201].includes(a.status), `unexpected status ${a.status}`);
  assert.ok([200, 201].includes(b.status), `unexpected status ${b.status}`);
  // One request mints (201), the other blocks on the advisory lock, re-checks,
  // and reuses (200). Both must resolve to the same session id.
  assert.equal(a.json.sessionId, b.json.sessionId, "both requests resolve to the same session");

  assert.equal((await sessionsForIdentity()).length, 1, "advisory lock prevented a duplicate session");
  assert.equal(await interviewCreditCount(), 1, "advisory lock prevented a double credit");
});

test("regenerate expires the live session and mints a fresh one with a fresh credit", async () => {
  await seedBase();
  const { session: old } = await seedLiveSession();

  const r = await api("POST", "/interviews/generate-link", tok(), { jobId: JOB, candidateId: CAND, interviewType: "general", questionCount: 3, regenerate: true });
  assert.equal(r.status, 201);
  assert.equal(r.json.reused, false);
  assert.notEqual(r.json.sessionId, old.id, "a genuinely new session is minted");

  const rows = await sessionsForIdentity();
  const expired = rows.filter((s) => s.status === "expired");
  const live = rows.filter((s) => s.status !== "expired");
  assert.equal(rows.length, 2, "old (expired) + new (live)");
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, old.id, "the OLD session is the one expired");
  assert.equal(live.length, 1);
  assert.equal(live[0].id, r.json.sessionId);

  assert.equal(await interviewCreditCount(), 1, "regenerate mints exactly one fresh credit");
});
