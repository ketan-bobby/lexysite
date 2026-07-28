/**
 * candidate-database-privacy-seal.test.ts — PROOF THE PLATFORM-POOL LEAK IS CLOSED
 *
 * Incident: GET /tenants/:tenantId/candidate-database (the employer-facing
 * shared candidate-database search) returned platform-pool (job-seeker) rows
 * WITHOUT the privacy seal — a licensed employer could surface a job-seeker who
 * had explicitly hidden themselves. The fix routes the endpoint through the
 * SAME canonical seal as GET /candidates:
 *   applyCandidateHardExclusions  → erased / DNC / pending_profile
 *   applyCandidatePrivacyFilter   → pause / hide-from-employer / blocklist / match-only
 *
 * This test drives the REAL endpoint over HTTP with a real bearer token for a
 * licensed employer (tenant_admin whose tenant has candidateDatabaseAccess), and
 * seeds ONE platform candidate per privacy vector plus a compliant CONTROL:
 *
 *   candOk        — compliant control (MUST appear)  ← guards against an
 *                   all-empty false-pass (a broken query returning nothing)
 *   candPaused    — discoveryPaused = true            (MUST be hidden)
 *   candHide      — hideFromCurrentEmployer + currentEmployerDomain=acme.com
 *   candBlock     — blockedCompanyDomains = [acme.com]
 *   candMatchOnly — matchOnlyVisibility (employer has no matching open job)
 *   candDnc       — doNotContact = true               (hard exclusion)
 *   candErased    — dataErasedAt set                  (hard exclusion)
 *
 * The employer tenant's domain is acme.com (via website), so the hide/block
 * vectors resolve against a real recruiter domain. We assert on the SEEDED ids
 * only (the shared pool may contain other platform rows), which makes the test
 * robust regardless of other data: the control must be present, every barred
 * fixture must be absent.
 *
 * Harness mirrors compliance-no-erased-dnc-in-counts.test.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import tenantsRouter from "./tenants";

const P = "cdbps_";
const id = (s: string) => P + s;

const T = id("acme");
const CAND = {
  ok: id("candOk"),
  paused: id("candPaused"),
  hide: id("candHide"),
  block: id("candBlock"),
  matchOnly: id("candMatchOnly"),
  dnc: id("candDnc"),
  erased: id("candErased"),
};
const BARRED = [CAND.paused, CAND.hide, CAND.block, CAND.matchOnly, CAND.dnc, CAND.erased];
const ALL_SEEDED = [CAND.ok, ...BARRED];

let server: Server;
let baseUrl: string;

const tAdmin = () => issueToken({ userId: id("tadmin"), role: "tenant_admin", tenantId: T });

async function api(method: string, path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}` } });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, ALL_SEEDED));
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, T));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, T));
}

async function seed() {
  await cleanup();

  // Employer tenant: LICENSED for the shared pool + has a resolvable domain so
  // the hide/blocklist vectors match a real recruiter domain (acme.com).
  await dbAdmin.insert(tenantsTable).values([
    { id: T, name: "Acme (licensed employer)", slug: T, plan: "enterprise", website: "https://acme.com", candidateDatabaseAccess: true },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("tadmin"), tenantId: T, email: id("tadmin") + "@acme.com", name: "Acme Admin", passwordHash: "x", role: "tenant_admin", status: "active" },
  ]);

  // One platform-pool (job-seeker) candidate per privacy vector + a control.
  await dbAdmin.insert(candidatesTable).values([
    { id: CAND.ok, tenantId: T, firstName: "Clean", lastName: "Control", email: CAND.ok + "@js.test", pool: "platform", source: "career_site" },
    { id: CAND.paused, tenantId: T, firstName: "Paused", lastName: "Seeker", email: CAND.paused + "@js.test", pool: "platform", source: "career_site", discoveryPaused: true },
    { id: CAND.hide, tenantId: T, firstName: "Hidden", lastName: "FromAcme", email: CAND.hide + "@js.test", pool: "platform", source: "career_site", hideFromCurrentEmployer: true, currentEmployerDomain: "acme.com" },
    { id: CAND.block, tenantId: T, firstName: "Blocked", lastName: "Acme", email: CAND.block + "@js.test", pool: "platform", source: "career_site", blockedCompanyDomains: ["acme.com"] },
    { id: CAND.matchOnly, tenantId: T, firstName: "MatchOnly", lastName: "Seeker", email: CAND.matchOnly + "@js.test", pool: "platform", source: "career_site", matchOnlyVisibility: true },
    { id: CAND.dnc, tenantId: T, firstName: "DoNot", lastName: "Contact", email: CAND.dnc + "@js.test", pool: "platform", source: "career_site", doNotContact: true },
    { id: CAND.erased, tenantId: T, firstName: "Erased", lastName: "Seeker", email: CAND.erased + "@js.test", pool: "platform", source: "career_site", dataErasedAt: new Date() },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(tenantsRouter); // mounted at root, exactly as routes/index.ts does
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

test("licensed employer sees the compliant control candidate (no all-empty false-pass)", async () => {
  const r = await api("GET", `/tenants/${T}/candidate-database?limit=200`, tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.access, true, "licensed tenant must have access:true");
  const ids: string[] = (r.json.candidates ?? []).map((c: any) => c.id);
  assert.ok(ids.includes(CAND.ok), "the compliant control platform candidate MUST be returned");
});

test("privacy-flagged platform job-seekers are NEVER returned to a licensed employer", async () => {
  const r = await api("GET", `/tenants/${T}/candidate-database?limit=200`, tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ids = new Set<string>((r.json.candidates ?? []).map((c: any) => c.id));
  for (const barred of BARRED) {
    assert.ok(!ids.has(barred), `LEAK: barred platform candidate ${barred} was returned to a licensed employer`);
  }
});

test("free-text search cannot surface a hidden job-seeker by name", async () => {
  // Even a targeted search for the hidden candidate's name must return nothing —
  // proves the seal runs BEFORE the search filter, not after.
  const r = await api("GET", `/tenants/${T}/candidate-database?search=Hidden&limit=200`, tAdmin());
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const ids = new Set<string>((r.json.candidates ?? []).map((c: any) => c.id));
  assert.ok(!ids.has(CAND.hide), "LEAK: a name search surfaced a hide-from-employer job-seeker");
  assert.ok(!ids.has(CAND.block), "LEAK: a name search surfaced a blocklisted job-seeker");
});
