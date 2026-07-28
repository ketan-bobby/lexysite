/**
 * storage-recording-part-scoping.test.ts — Auth + ownership scoping for the
 * screen-recording part-upload route.
 *
 *   POST /storage/uploads/recording/part
 *
 * The route's S3 object key is derived DIRECTLY from the caller-supplied
 * sessionId:
 *
 *   private/recordings/<sessionId>/part_<NNNN>.<ext>
 *
 * Before the fix the handler only checked `resolveCaller` (any Bearer token) and
 * then wrote to that attacker-controlled key — so ANY authenticated user could
 * inject or clobber recording parts inside another candidate's session folder.
 * The fix applies the SAME ownership/capability check the sibling POST
 * /storage/uploads/recording and POST /storage/uploads/recording/chunk routes
 * use (isCallerAuthorizedForSession, the gate inside attachRecordingToSession)
 * BEFORE any storage I/O.
 *
 * GUARD USED (reported): the siblings resolve the caller from a Bearer token
 * (resolveCaller → getAuthUserId) and authorize via candidates.user_id FK /
 * tenant subtree / platform_admin — they do NOT use requireInterviewSessionCookie.
 * This route matches that pattern.
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * App-layer scoping (an explicit ownership predicate), not Postgres RLS. We
 * mount the REAL storage router on a bare Express app, seed sessions/candidates
 * across two unrelated tenants via `dbAdmin` (BYPASSRLS), issue real bearer
 * tokens, and drive the route over HTTP with multipart/form-data. Outside
 * withTenantContext the `db` proxy falls through to dbAdmin so RLS never filters
 * — isolating the app-layer ownership gate.
 *
 * Fixture ids all prefixed `srp_` for safe teardown. The single authorized-path
 * test writes one tiny object to S3 and deletes it under its prefix in teardown.
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
  candidatesTable,
  interviewSessionsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { ObjectStorageService } from "../lib/objectStorage";
import storageRouter from "./storage";

const P = "srp_";
const id = (s: string) => P + s;

// interview_sessions.id must be a UUID (route schema enforces UUID shape).
const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // owned by candA in tenantA
const SESSION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // owned by candB in tenantB
const SESSION_MISSING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // no row

const TENANT_IDS = ["tenantA", "tenantB"].map(id);
const USER_IDS = ["candUserA", "candUserB", "recruiterA", "recruiterB", "pAdmin"].map(id);
const CAND_IDS = ["candA", "candB"].map(id);
const SESSION_IDS = [SESSION_A, SESSION_B];

let server: Server;
let baseUrl: string;

const tok = {
  // candUserA is the FK owner of candA → SESSION_A.
  candUserA: () => issueToken({ userId: id("candUserA"), role: "candidate", tenantId: id("tenantA") }),
  // candUserB is the FK owner of candB → SESSION_B (a DIFFERENT session).
  candUserB: () => issueToken({ userId: id("candUserB"), role: "candidate", tenantId: id("tenantB") }),
  // recruiterA is a tenant_admin inside SESSION_A's tenant.
  recruiterA: () => issueToken({ userId: id("recruiterA"), role: "tenant_admin", tenantId: id("tenantA") }),
  // recruiterB is a tenant_admin in an unrelated tenant (must NOT reach SESSION_A).
  recruiterB: () => issueToken({ userId: id("recruiterB"), role: "tenant_admin", tenantId: id("tenantB") }),
  pAdmin: () => issueToken({ userId: id("pAdmin"), role: "platform_admin", tenantId: id("tenantA") }),
};

/** POST a part with a tiny in-memory webm blob. */
async function uploadPart(
  sessionId: string,
  partNumber: number,
  token?: string,
): Promise<{ status: number; json: any }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "video/webm" }), "part.webm");
  form.append("sessionId", sessionId);
  form.append("partNumber", String(partNumber));
  const res = await fetch(baseUrl + "/storage/uploads/recording/part", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(interviewSessionsTable).where(inArray(interviewSessionsTable.id, SESSION_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, CAND_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, USER_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
  // Remove any S3 objects the authorized-path test wrote.
  try { await new ObjectStorageService().deleteObjectsUnderPrefix(`recordings/${SESSION_A}`); } catch { /* best-effort */ }
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("tenantA"), name: "SRP Tenant A", slug: id("tenantA"), plan: "enterprise" },
    { id: id("tenantB"), name: "SRP Tenant B", slug: id("tenantB"), plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("candUserA"), tenantId: id("tenantA"), email: id("candUserA") + "@t.test", name: "Cand User A", passwordHash: "x", role: "candidate" },
    { id: id("candUserB"), tenantId: id("tenantB"), email: id("candUserB") + "@t.test", name: "Cand User B", passwordHash: "x", role: "candidate" },
    { id: id("recruiterA"), tenantId: id("tenantA"), email: id("recruiterA") + "@t.test", name: "Recruiter A", passwordHash: "x", role: "tenant_admin" },
    { id: id("recruiterB"), tenantId: id("tenantB"), email: id("recruiterB") + "@t.test", name: "Recruiter B", passwordHash: "x", role: "tenant_admin" },
    { id: id("pAdmin"), tenantId: id("tenantA"), email: id("pAdmin") + "@t.test", name: "P Admin", passwordHash: "x", role: "platform_admin" },
  ]);

  await dbAdmin.insert(candidatesTable).values([
    { id: id("candA"), tenantId: id("tenantA"), userId: id("candUserA"), firstName: "A", lastName: "Owner", email: id("candA") + "@t.test", pool: "tenant" },
    { id: id("candB"), tenantId: id("tenantB"), userId: id("candUserB"), firstName: "B", lastName: "Owner", email: id("candB") + "@t.test", pool: "tenant" },
  ]);

  await dbAdmin.insert(interviewSessionsTable).values([
    { id: SESSION_A, tenantId: id("tenantA"), applicationId: id("appA"), planId: id("planA"), candidateId: id("candA"), status: "in_progress" },
    { id: SESSION_B, tenantId: id("tenantB"), applicationId: id("appB"), planId: id("planB"), candidateId: id("candB"), status: "in_progress" },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  // pino-http normally attaches req.log in production; the bare test app has no
  // such middleware, so shim a no-op logger the storage handlers can call.
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use(storageRouter);
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
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ── no auth / cookie → 401 ───────────────────────────────────────────────────
test("no bearer token → 401 (before any storage I/O)", async () => {
  const { status } = await uploadPart(SESSION_A, 2);
  assert.equal(status, 401);
});

// ── valid session/capability → works ─────────────────────────────────────────
test("session's own candidate → 200 (authorized owner)", async () => {
  const { status, json } = await uploadPart(SESSION_A, 2, tok.candUserA());
  assert.equal(status, 200);
  assert.equal(json?.ok, true);
  assert.equal(json?.sessionId, SESSION_A);
  assert.match(String(json?.objectPath), new RegExp(`^/objects/recordings/${SESSION_A}/part_0002\\.`));
});

// ── wrong session's part → 404 ───────────────────────────────────────────────
test("candidate uploading to a DIFFERENT candidate's session → 404", async () => {
  const { status } = await uploadPart(SESSION_B, 2, tok.candUserA());
  assert.equal(status, 404);
});

test("recruiter OUTSIDE the session's tenant → 404", async () => {
  const { status } = await uploadPart(SESSION_A, 2, tok.recruiterB());
  assert.equal(status, 404);
});

test("nonexistent session → 404 (existence not probeable)", async () => {
  const { status } = await uploadPart(SESSION_MISSING, 2, tok.candUserA());
  assert.equal(status, 404);
});

// ── malformed sessionId → 400 (schema, before ownership + I/O) ────────────────
test("non-UUID sessionId → 400 validation", async () => {
  const { status } = await uploadPart("not-a-uuid", 2, tok.candUserA());
  assert.equal(status, 400);
});
