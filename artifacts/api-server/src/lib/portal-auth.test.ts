/**
 * portal-auth.test.ts — unit tests for candidate session resolution.
 *
 * The drizzle admin handle's `select` is stubbed with an in-memory fake, so
 * NO real database queries run. A dummy SESSION_SECRET is set before import
 * so we can mint valid bearer tokens for the happy paths.
 * Run: npx tsx --test src/lib/portal-auth.test.ts
 */
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = "unit-test-session-secret-0123456789abcdef";

const { dbAdmin } = await import("@workspace/db");
const { issueToken } = await import("./auth-token");
const { resolveCandidateSession, resolveCandidateId } = await import("./portal-auth");

/** Rows returned by consecutive select() calls (1st = users, 2nd = candidates). */
let selectResults: unknown[][] = [];
let selectCalls = 0;

function stubDb() {
  selectCalls = 0;
  mock.method(dbAdmin as any, "select", () => {
    const rows = selectResults[selectCalls] ?? [];
    selectCalls += 1;
    return {
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    };
  });
}

function authedReq(p: { userId: string; role: string; tenantId: string | null }) {
  return { headers: { authorization: `Bearer ${issueToken(p)}` } };
}

beforeEach(() => {
  mock.restoreAll();
  stubDb();
  selectResults = [];
});

test("valid candidate token + linked candidate row resolves a session", async () => {
  selectResults = [
    [{ id: "user-1", role: "candidate", tenantId: "ten-1" }],
    [{ id: "cand-9" }],
  ];
  const s = await resolveCandidateSession(
    authedReq({ userId: "user-1", role: "candidate", tenantId: "ten-1" }),
  );
  assert.deepEqual(s, { userId: "user-1", candidateId: "cand-9", tenantId: "ten-1" });
});

test("no / invalid bearer token → null without touching the DB", async () => {
  assert.equal(await resolveCandidateSession({ headers: {} }), null);
  assert.equal(
    await resolveCandidateSession({ headers: { authorization: "Bearer garbage" } }),
    null,
  );
  assert.equal(selectCalls, 0, "must short-circuit before any DB query");
});

test("token user no longer exists in DB → null", async () => {
  selectResults = [[]]; // users lookup returns nothing
  const s = await resolveCandidateSession(
    authedReq({ userId: "ghost", role: "candidate", tenantId: "t" }),
  );
  assert.equal(s, null);
});

test("non-candidate roles are rejected even with a valid token (auth-shadowing guard)", async () => {
  for (const role of ["recruiter", "recruiter_admin", "platform_admin", "hiring_manager"]) {
    selectResults = [
      [{ id: "user-1", role, tenantId: "ten-1" }],
      [{ id: "cand-9" }], // even if a candidate row would match, role gate fires first
    ];
    selectCalls = 0;
    const s = await resolveCandidateSession(
      authedReq({ userId: "user-1", role, tenantId: "ten-1" }),
    );
    assert.equal(s, null, `role '${role}' must not resolve a candidate session`);
    assert.equal(selectCalls, 1, "must stop after the users lookup");
  }
});

test("candidate user with no linked candidate row → null (no email fallback)", async () => {
  selectResults = [
    [{ id: "user-1", role: "candidate", tenantId: "ten-1" }],
    [], // no candidates.user_id link
  ];
  const s = await resolveCandidateSession(
    authedReq({ userId: "user-1", role: "candidate", tenantId: "ten-1" }),
  );
  assert.equal(s, null);
});

test("resolveCandidateId returns just the id, or null", async () => {
  selectResults = [
    [{ id: "user-1", role: "candidate", tenantId: "ten-1" }],
    [{ id: "cand-42" }],
  ];
  assert.equal(
    await resolveCandidateId(authedReq({ userId: "user-1", role: "candidate", tenantId: "ten-1" })),
    "cand-42",
  );
  assert.equal(await resolveCandidateId({ headers: {} }), null);
});
