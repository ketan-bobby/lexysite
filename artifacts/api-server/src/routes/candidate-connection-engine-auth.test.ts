/**
 * candidate-connection-engine-auth.test.ts — Auth shape for the candidate-side
 * Connection Engine routes after the resolver hardening.
 *
 * ─── What this guards ────────────────────────────────────────────────────────
 * routes/candidate-connection-engine.ts used to carry its OWN local
 * resolveCandidateId that (1) accepted role === "recruiter", (2) resolved the
 * candidate via a candidates.email === users.email JOIN, and (3) silently fell
 * back to `?? u.id` when no candidate row matched. Three routes rested on that
 * resolver with NO self-equality backstop — the two write/recalculate POSTs
 * (`/candidate/connection-event`, `/candidate/connection-insights/recalculate`)
 * and the `/candidate/connection-insights/me` GET — so a same-email recruiter
 * could read AND mutate a candidate's connection insights (auth shadowing).
 *
 * The fix swaps ALL call sites to the canonical portal-auth resolveCandidateId
 * (HMAC-verified session `sub` → users row → candidates.user_id FK; role MUST be
 * "candidate"; null on any failure → 401). The self-equality gate on the
 * :candidateId routes becomes redundant belt-and-suspenders rather than the sole
 * control.
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * The resolver is APP-layer auth (not Postgres RLS). We mount the REAL router on
 * a bare Express app, seed one tenant + a candidate-owner (linked via
 * candidates.user_id), a second candidate (non-owner), and a recruiter via
 * `dbAdmin` (BYPASSRLS), issue real bearer tokens, and hit the routes over HTTP.
 * The feature flag is enabled for the whole file.
 *
 * ─── Fixture (all ids prefixed `ccea_` for safe teardown) ────────────────────
 *   tenant  — one top-level tenant
 *   uOwner  — candidate USER, linked to candidate row cOwner via user_id
 *   uOther  — a DIFFERENT candidate USER, linked to cOther (the non-owner)
 *   uRec    — a recruiter USER (must never resolve into a candidate session)
 *   cOwner has one seeded insight row (jobId jOwner).
 */
process.env.ENABLE_CANDIDATE_CONNECTION_ENGINE = "true";

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
  candidateConnectionInsightsTable,
  candidateConnectionEventsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import candidateConnectionRouter from "./candidate-connection-engine";

const P = "ccea_";
const id = (s: string) => P + s;

const TENANT_IDS = [id("tenant")];
// uUnlinked = candidate-role USER with NO candidates.user_id row (proves the
// resolver returns null instead of the old `?? u.id` fallback).
// uEmailRec = recruiter USER whose email exactly matches a candidate row's email
// (proves the resolver no longer resolves via a candidates.email === users.email join).
const USER_IDS = ["uOwner", "uOther", "uRec", "uUnlinked", "uEmailRec"].map(id);
const CAND_IDS = ["cOwner", "cOther", "cEmailMatch"].map(id);

// Shared email used by BOTH the recruiter user (uEmailRec) and a candidate row
// (cEmailMatch). Under the old email-join resolver this collision would have let
// the recruiter resolve into that candidate. The canonical resolver ignores email.
const SHARED_EMAIL = id("shared") + "@t.test";

let server: Server;
let baseUrl: string;

const tok = {
  owner: () => issueToken({ userId: id("uOwner"), role: "candidate", tenantId: id("tenant") }),
  other: () => issueToken({ userId: id("uOther"), role: "candidate", tenantId: id("tenant") }),
  recruiter: () => issueToken({ userId: id("uRec"), role: "recruiter", tenantId: id("tenant") }),
  unlinked: () => issueToken({ userId: id("uUnlinked"), role: "candidate", tenantId: id("tenant") }),
  emailRec: () => issueToken({ userId: id("uEmailRec"), role: "recruiter", tenantId: id("tenant") }),
};

async function api(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(candidateConnectionInsightsTable).where(inArray(candidateConnectionInsightsTable.candidateId, CAND_IDS));
  await dbAdmin.delete(candidateConnectionEventsTable).where(inArray(candidateConnectionEventsTable.candidateId, CAND_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, CAND_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, USER_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("tenant"), name: "CCEA Tenant", slug: id("tenant"), plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("uOwner"), tenantId: id("tenant"), email: id("uOwner") + "@t.test", name: "Owner Cand", passwordHash: "x", role: "candidate" },
    { id: id("uOther"), tenantId: id("tenant"), email: id("uOther") + "@t.test", name: "Other Cand", passwordHash: "x", role: "candidate" },
    { id: id("uRec"), tenantId: id("tenant"), email: id("uRec") + "@t.test", name: "Recruiter", passwordHash: "x", role: "recruiter" },
    // candidate ROLE but no linked candidates.user_id row → resolver must return null.
    { id: id("uUnlinked"), tenantId: id("tenant"), email: id("uUnlinked") + "@t.test", name: "Unlinked Cand", passwordHash: "x", role: "candidate" },
    // recruiter whose email collides with a candidate row (email-join bait).
    { id: id("uEmailRec"), tenantId: id("tenant"), email: SHARED_EMAIL, name: "Email Recruiter", passwordHash: "x", role: "recruiter" },
  ]);

  // candidates.user_id is the ONLY link the canonical resolver trusts (FK), not email.
  await dbAdmin.insert(candidatesTable).values([
    { id: id("cOwner"), tenantId: id("tenant"), userId: id("uOwner"), firstName: "Owner", lastName: "C", email: id("cOwner") + "@t.test", currentTitle: "Engineer", pool: "tenant" },
    { id: id("cOther"), tenantId: id("tenant"), userId: id("uOther"), firstName: "Other", lastName: "C", email: id("cOther") + "@t.test", currentTitle: "Engineer", pool: "tenant" },
    // candidate row sharing the recruiter's email, deliberately NOT linked to uEmailRec.
    { id: id("cEmailMatch"), tenantId: id("tenant"), firstName: "Email", lastName: "Match", email: SHARED_EMAIL, currentTitle: "Engineer", pool: "tenant" },
  ]);

  await dbAdmin.insert(candidateConnectionInsightsTable).values([
    { id: id("insOwner"), candidateId: id("cOwner"), jobId: id("jOwner"), connectionStrengthScore: 72, connectionStrengthLabel: "Engaged", hiringMomentumScore: 78, hiringMomentumLabel: "High", nextBestAction: "Complete your AI interview to stand out." },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(candidateConnectionRouter);
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

/* ── 1. Happy path: candidate reads OWN insights ✓ ───────────────────────── */
test("GET /candidate/connection-insights/me as the owner → 200 with own insights", async () => {
  const { status, json } = await api("GET", "/candidate/connection-insights/me", tok.owner());
  assert.equal(status, 200);
  assert.equal(json.candidateId, id("cOwner"));
  assert.ok(Array.isArray(json.insights), "insights is an array");
  assert.ok(json.insights.length >= 1, "owner's seeded insight is present");
});

test("GET /candidate/connection-insights/:candidateId with OWN id → 200 (self-equality belt holds)", async () => {
  const { status, json } = await api("GET", `/candidate/connection-insights/${id("cOwner")}`, tok.owner());
  assert.equal(status, 200);
  assert.equal(json.candidateId, id("cOwner"));
  assert.ok(Array.isArray(json.insights));
});

/* ── 2. No session → 401 (every route that rested on the weak resolver) ──── */
test("GET /me without a token → 401", async () => {
  const { status } = await api("GET", "/candidate/connection-insights/me");
  assert.equal(status, 401);
});

test("POST /candidate/connection-event without a token → 401", async () => {
  const { status } = await api("POST", "/candidate/connection-event", undefined, { eventType: "portal_login" });
  assert.equal(status, 401);
});

test("POST /candidate/connection-insights/recalculate without a token → 401", async () => {
  const { status } = await api("POST", "/candidate/connection-insights/recalculate", undefined, {});
  assert.equal(status, 401);
});

/* ── 3. Recruiter (non-candidate role) is refused everywhere ─────────────── */
// The canonical resolver rejects role !== "candidate" BEFORE any handler logic,
// so a recruiter can neither read the /me view nor mutate insights. This is the
// core auth-shadow closure: previously the local resolver accepted "recruiter".
test("GET /me as a recruiter → 401 (role !== candidate is refused)", async () => {
  const { status } = await api("GET", "/candidate/connection-insights/me", tok.recruiter());
  assert.equal(status, 401);
});

test("POST /candidate/connection-event as a recruiter → 401 (write shadow closed)", async () => {
  const { status } = await api("POST", "/candidate/connection-event", tok.recruiter(), { eventType: "portal_login" });
  assert.equal(status, 401);
});

test("POST /candidate/connection-insights/recalculate as a recruiter → 401 (write shadow closed)", async () => {
  const { status } = await api("POST", "/candidate/connection-insights/recalculate", tok.recruiter(), {});
  assert.equal(status, 401);
});

/* ── 4. IDOR belt: a candidate cannot read ANOTHER candidate's :candidateId ─ */
test("GET /candidate/connection-insights/:candidateId for another candidate → 404 (self-equality)", async () => {
  const { status } = await api("GET", `/candidate/connection-insights/${id("cOwner")}`, tok.other());
  assert.equal(status, 404);
});

test("GET /candidate/connection-insight/:candidateId/:jobId for another candidate → 404 (self-equality)", async () => {
  const { status } = await api("GET", `/candidate/connection-insight/${id("cOwner")}/${id("jOwner")}`, tok.other());
  assert.equal(status, 404);
});

test("GET /candidate/connection-insights/:candidateId as a recruiter → 401 (resolver null before the gate)", async () => {
  const { status } = await api("GET", `/candidate/connection-insights/${id("cOwner")}`, tok.recruiter());
  assert.equal(status, 401);
});

/* ── 5. No silent fallback: candidate-role token with NO linked candidate row ─ */
// Proves the removed `?? u.id` fallback: a candidate USER with no candidates.user_id
// row resolves to null → 401, never to some other id.
test("GET /me as a candidate-role user with no linked candidate row → 401 (no fallback)", async () => {
  const { status } = await api("GET", "/candidate/connection-insights/me", tok.unlinked());
  assert.equal(status, 401);
});

/* ── 6. No email-join: recruiter sharing a candidate's email is still refused ─ */
// Proves the removed email-join: the recruiter's email matches cEmailMatch's email,
// but identity comes from the signed session (role !== candidate) → 401, not that
// candidate's session.
test("GET /me as a recruiter whose email matches a candidate row → 401 (no email-join)", async () => {
  const { status } = await api("GET", "/candidate/connection-insights/me", tok.emailRec());
  assert.equal(status, 401);
});
