/**
 * candidate-privacy-seal-combinatorial.test.ts
 * ────────────────────────────────────────────────────────────────────────────
 * PERMANENT combinatorial privacy fixture across the two primary employer
 * LIST/SEARCH surfaces.
 *
 * The single-vector proof (candidate-database-privacy-seal.test.ts) shows the
 * ONE incident endpoint is sealed. This test is the durable regression net for
 * the WHOLE leak class: a rich, realistic population of shared-pool job-seekers
 * spread across MULTIPLE licensed employers — some also carried as an employer's
 * own employee, some erased/DNC/paused/blocked/match-only, some with several
 * privacy vectors at once — driven through the two primary employer-facing reads
 * that return platform-pool rows.
 *
 * SURFACES SWEPT:
 *   • GET /tenants/:tenantId/candidate-database   (tenants.ts — the shared search)
 *   • GET /candidates                             (candidates.ts — the main list)
 * Both resolve platform access from tenant.candidateDatabaseAccess and MUST run
 * the canonical seal (applyCandidateHardExclusions + applyCandidatePrivacyFilter).
 *
 * NOT driven here (AI-parsed, so exercised by the CI guard rather than this
 * deterministic fixture): POST /candidates/nl-search shares the SAME canonical
 * seal — after refactor it calls applyCandidateHardExclusions + the privacy
 * filter — and check-platform-pool-read.mjs enforces that seal statically. The
 * employer-facing rec-push paths in platform-recommendation-engine.ts are the
 * two documented KNOWN GAP allowlist entries (deferred to Step 2), NOT covered.
 *
 * KEY INVARIANTS PROVEN
 *   1. Per-employer, not global: a job-seeker who hid from Acme is still visible
 *      to Globex, and vice-versa (hide/block are relative to the viewing tenant).
 *   2. Hard exclusions are absolute: erased / DNC / pending_profile never appear
 *      to ANY employer, on ANY surface, in ANY pool (incl. a tenant's own rows).
 *   3. Privacy filter is platform-pool only: an employer's OWN employee row
 *      (pool="tenant") stays visible even when that person set job-seeker privacy
 *      flags — internal ATS records must not vanish. (The "also an employee" mix.)
 *   4. Combined vectors fail closed: any one active bar hides the candidate.
 *   5. No-access tenant sees ZERO platform rows on every surface.
 *   6. A compliant CONTROL is present on every positive surface — guards against
 *      an all-empty false-pass (a broken query that returns nothing looks "safe").
 *
 * Asserts on SEEDED ids only, so it is robust to whatever else lives in the pool.
 * Harness mirrors candidate-database-privacy-seal.test.ts.
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
import candidatesRouter from "./candidates";

const P = "cpsc_"; // combinatorial privacy seal
const id = (s: string) => P + s;

/* ── Tenants ──────────────────────────────────────────────────────────────
 * Two LICENSED employers with distinct, resolvable domains (so hide/block
 * vectors bind to a real recruiter domain) + one UNLICENSED employer. */
const ACME = id("acme");        // acme.com,   candidateDatabaseAccess = true
const GLOBEX = id("globex");    // globex.com, candidateDatabaseAccess = true
const NOACCESS = id("noaccess");// no platform access

const ADMIN = {
  acme: id("adminAcme"),
  globex: id("adminGlobex"),
  noaccess: id("adminNoAccess"),
};

/* ── Candidate fixtures ───────────────────────────────────────────────────── */
const C = {
  // Shared-pool job-seekers (pool="platform", tenantId="platform").
  clean:      id("pClean"),       // no flags — CONTROL, visible to every licensed employer
  paused:     id("pPaused"),      // discoveryPaused — hidden from all
  hideAcme:   id("pHideAcme"),    // hideFromCurrentEmployer @ acme.com — hidden from Acme only
  blockGlobex:id("pBlockGlobex"), // blockedCompanyDomains=[globex.com] — hidden from Globex only
  matchOnly:  id("pMatchOnly"),   // matchOnlyVisibility, no matching jobs — hidden from all
  dnc:        id("pDnc"),         // doNotContact — hard exclusion, hidden from all
  erased:     id("pErased"),      // dataErasedAt — hard exclusion, hidden from all
  combo:      id("pCombo"),       // paused + hideAcme + blockGlobex + matchOnly — hidden from all
  blockBoth:  id("pBlockBoth"),   // blockedCompanyDomains=[acme.com, globex.com] — hidden from all

  // Hard-exclusion in a NON-platform pool (would otherwise be in Acme's scope).
  pending:    id("pPending"),     // pool="pending_profile" @ Acme — hard-excluded everywhere

  // Employer-owned employee rows (pool="tenant") — the "also an employee" mix.
  acmeEmp:    id("eAcmeEmp"),     // Acme employee WHO ALSO set job-seeker hide flags — STILL visible to Acme
  acmeEmpDnc: id("eAcmeEmpDnc"),  // Acme employee with doNotContact — hard-excluded even from Acme
  globexEmp:  id("eGlobexEmp"),   // Globex employee, no flags — visible to Globex, not Acme
};

const PLATFORM_BARRED_ALL = [
  C.paused, C.matchOnly, C.dnc, C.erased, C.combo, C.blockBoth,
];
const ALL_SEEDED_CANDS = [
  C.clean, ...PLATFORM_BARRED_ALL, C.hideAcme, C.blockGlobex,
  C.pending, C.acmeEmp, C.acmeEmpDnc, C.globexEmp,
];
const ALL_TENANTS = [ACME, GLOBEX, NOACCESS];

let server: Server;
let baseUrl: string;

const tok = (userId: string, tenantId: string) =>
  issueToken({ userId, role: "tenant_admin", tenantId });

async function api(path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, { headers: { Authorization: `Bearer ${token}` } });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

/** Seeded ids returned by GET /candidates for a given admin token. */
async function candidatesList(userId: string, tenantId: string): Promise<Set<string>> {
  const r = await api(`/candidates?limit=1000`, tok(userId, tenantId));
  assert.equal(r.status, 200, `GET /candidates → ${r.status}: ${JSON.stringify(r.json)}`);
  return new Set<string>((r.json.candidates ?? []).map((c: any) => c.id));
}

/** Seeded ids returned by GET /tenants/:id/candidate-database (platform pool). */
async function candidateDatabase(userId: string, tenantId: string): Promise<{ access: boolean; ids: Set<string> }> {
  const r = await api(`/tenants/${tenantId}/candidate-database?limit=1000`, tok(userId, tenantId));
  assert.equal(r.status, 200, `GET candidate-database → ${r.status}: ${JSON.stringify(r.json)}`);
  return { access: r.json.access === true, ids: new Set<string>((r.json.candidates ?? []).map((c: any) => c.id)) };
}

function assertVisible(ids: Set<string>, want: string[], where: string) {
  for (const cid of want) assert.ok(ids.has(cid), `${where}: expected ${cid} to be VISIBLE but it was absent`);
}
function assertHidden(ids: Set<string>, barred: string[], where: string) {
  for (const cid of barred) assert.ok(!ids.has(cid), `LEAK @ ${where}: barred candidate ${cid} was returned`);
}

async function cleanup() {
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, ALL_SEEDED_CANDS));
  for (const t of ALL_TENANTS) {
    await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, t));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, t));
  }
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: ACME,     name: "Acme (licensed)",   slug: ACME,     plan: "enterprise", website: "https://acme.com",   candidateDatabaseAccess: true },
    { id: GLOBEX,   name: "Globex (licensed)", slug: GLOBEX,   plan: "enterprise", website: "https://globex.com", candidateDatabaseAccess: true },
    { id: NOACCESS, name: "NoAccess Corp",     slug: NOACCESS, plan: "starter",    website: "https://noaccess.com", candidateDatabaseAccess: false },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: ADMIN.acme,     tenantId: ACME,     email: ADMIN.acme + "@acme.com",         name: "Acme Admin",     passwordHash: "x", role: "tenant_admin", status: "active" },
    { id: ADMIN.globex,   tenantId: GLOBEX,   email: ADMIN.globex + "@globex.com",     name: "Globex Admin",   passwordHash: "x", role: "tenant_admin", status: "active" },
    { id: ADMIN.noaccess, tenantId: NOACCESS, email: ADMIN.noaccess + "@noaccess.com", name: "NoAccess Admin", passwordHash: "x", role: "tenant_admin", status: "active" },
  ]);

  await dbAdmin.insert(candidatesTable).values([
    // ── shared-pool job-seekers ──────────────────────────────────────────────
    { id: C.clean,       tenantId: "platform", firstName: "Clean",  lastName: "Control",  email: C.clean + "@js.test",       pool: "platform", source: "career_site" },
    { id: C.paused,      tenantId: "platform", firstName: "Paused", lastName: "Seeker",   email: C.paused + "@js.test",      pool: "platform", source: "career_site", discoveryPaused: true },
    { id: C.hideAcme,    tenantId: "platform", firstName: "Hidden", lastName: "FromAcme", email: C.hideAcme + "@js.test",    pool: "platform", source: "career_site", hideFromCurrentEmployer: true, currentEmployerDomain: "acme.com" },
    { id: C.blockGlobex, tenantId: "platform", firstName: "Block",  lastName: "Globex",   email: C.blockGlobex + "@js.test", pool: "platform", source: "career_site", blockedCompanyDomains: ["globex.com"] },
    { id: C.matchOnly,   tenantId: "platform", firstName: "Match",  lastName: "OnlySeeker", email: C.matchOnly + "@js.test", pool: "platform", source: "career_site", matchOnlyVisibility: true },
    { id: C.dnc,         tenantId: "platform", firstName: "DoNot",  lastName: "Contact",  email: C.dnc + "@js.test",         pool: "platform", source: "career_site", doNotContact: true },
    { id: C.erased,      tenantId: "platform", firstName: "Erased", lastName: "Seeker",   email: C.erased + "@js.test",      pool: "platform", source: "career_site", dataErasedAt: new Date() },
    { id: C.combo,       tenantId: "platform", firstName: "Combo",  lastName: "AllBars",  email: C.combo + "@js.test",       pool: "platform", source: "career_site", discoveryPaused: true, hideFromCurrentEmployer: true, currentEmployerDomain: "acme.com", blockedCompanyDomains: ["globex.com"], matchOnlyVisibility: true },
    { id: C.blockBoth,   tenantId: "platform", firstName: "Block",  lastName: "Both",     email: C.blockBoth + "@js.test",   pool: "platform", source: "career_site", blockedCompanyDomains: ["acme.com", "globex.com"] },

    // ── hard-exclusion in a non-platform pool (in Acme scope but must vanish) ──
    { id: C.pending,     tenantId: ACME, firstName: "Pending", lastName: "Profile", email: C.pending + "@js.test", pool: "pending_profile", source: "career_site" },

    // ── employer-owned employee rows (the "also an employee" mix) ─────────────
    // Acme's own employee who ALSO set job-seeker hide flags — the privacy filter
    // is platform-pool only, so Acme's internal record MUST stay visible to Acme.
    { id: C.acmeEmp,    tenantId: ACME,   firstName: "Acme",   lastName: "Employee",  email: C.acmeEmp + "@js.test",    pool: "tenant", source: "manual", hideFromCurrentEmployer: true, currentEmployerDomain: "acme.com" },
    // Acme employee with a HARD exclusion — must vanish even from their own employer.
    { id: C.acmeEmpDnc, tenantId: ACME,   firstName: "Acme",   lastName: "EmpDnc",    email: C.acmeEmpDnc + "@js.test", pool: "tenant", source: "manual", doNotContact: true },
    // Globex employee, no flags — visible to Globex, invisible to Acme (tenant scope).
    { id: C.globexEmp,  tenantId: GLOBEX, firstName: "Globex", lastName: "Employee",  email: C.globexEmp + "@js.test",  pool: "tenant", source: "manual" },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(tenantsRouter);
  app.use(candidatesRouter);
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

/* ════════════════════════ candidate-database (platform search) ════════════ */

test("candidate-database: Acme sees compliant + Globex-only-blocked, never its own barred", async () => {
  const { access, ids } = await candidateDatabase(ADMIN.acme, ACME);
  assert.equal(access, true, "Acme is licensed → access:true");
  assertVisible(ids, [C.clean, C.blockGlobex], "candidate-database/acme");
  assertHidden(ids, [C.hideAcme, C.combo, ...PLATFORM_BARRED_ALL], "candidate-database/acme");
});

test("candidate-database: Globex sees compliant + Acme-only-hidden, never its own barred", async () => {
  const { access, ids } = await candidateDatabase(ADMIN.globex, GLOBEX);
  assert.equal(access, true, "Globex is licensed → access:true");
  // hideAcme is only hidden from Acme, so Globex may see them; blockGlobex must be hidden.
  assertVisible(ids, [C.clean, C.hideAcme], "candidate-database/globex");
  assertHidden(ids, [C.blockGlobex, C.combo, ...PLATFORM_BARRED_ALL], "candidate-database/globex");
});

test("candidate-database: unlicensed tenant gets access:false and zero platform rows", async () => {
  const { access, ids } = await candidateDatabase(ADMIN.noaccess, NOACCESS);
  assert.equal(access, false, "unlicensed tenant must have access:false");
  assertHidden(ids, ALL_SEEDED_CANDS, "candidate-database/noaccess");
});

/* ════════════════════════ GET /candidates (main list) ═════════════════════ */

test("GET /candidates: Acme — platform seal + own employee visible + hard exclusions gone", async () => {
  const ids = await candidatesList(ADMIN.acme, ACME);
  // Visible: compliant platform control, platform blocked-only-at-Globex, and
  // Acme's OWN employee row (privacy flags don't hide an internal ATS record).
  assertVisible(ids, [C.clean, C.blockGlobex, C.acmeEmp], "candidates/acme");
  // Hidden: every platform bar that applies to Acme, the pending_profile row,
  // Acme's own DNC employee (hard exclusion beats pool), and Globex's employee.
  assertHidden(ids, [
    C.hideAcme, C.combo, ...PLATFORM_BARRED_ALL,
    C.pending, C.acmeEmpDnc, C.globexEmp,
  ], "candidates/acme");
});

test("GET /candidates: Globex — per-employer seal is not global", async () => {
  const ids = await candidatesList(ADMIN.globex, GLOBEX);
  assertVisible(ids, [C.clean, C.hideAcme, C.globexEmp], "candidates/globex");
  assertHidden(ids, [
    C.blockGlobex, C.combo, ...PLATFORM_BARRED_ALL,
    C.pending, C.acmeEmp, C.acmeEmpDnc,
  ], "candidates/globex");
});

test("GET /candidates: unlicensed tenant sees no platform rows at all", async () => {
  const ids = await candidatesList(ADMIN.noaccess, NOACCESS);
  // NoAccess has no platform license and no seeded tenant rows → none of ours.
  assertHidden(ids, ALL_SEEDED_CANDS, "candidates/noaccess");
});
