/**
 * candidate-privacy-seal-recommendation.test.ts
 * ────────────────────────────────────────────────────────────────────────────
 * CRITICAL-CONTAINMENT regression net for the employer-facing RECOMMENDATION
 * PUSH path (platform-recommendation-engine.ts).
 *
 * WHY THIS IS ITS OWN TEST (and treated as CRITICAL, not routine enumeration):
 *   The LIST/SEARCH leak (candidate-privacy-seal-combinatorial.test.ts) requires
 *   an employer to go LOOKING for a candidate. The recommendation engine is worse
 *   in one dimension: it DELIVERS platform-pool job-seekers to an employer
 *   UNPROMPTED — runPlatformRecommendationForJob / runPlatformRecommendationScan
 *   score every platform candidate and, on a strong match, INSERT them into the
 *   client tenant's talent_pool_submissions AND email the candidate "you were
 *   matched". A paused / hidden / blocked / DNC / erased job-seeker being actively
 *   recommended to the very company they hid from is the exact catastrophe this
 *   whole audit exists to prevent.
 *
 * WHAT THIS PROVES:
 *   Both entry points funnel through the shared evaluator
 *   evaluateJobAgainstCandidates(job, platformCandidates), which — BEFORE any
 *   push or email — applies the FULL canonical seal, per RECEIVING tenant
 *   (job.tenantId, the talent_pool_submissions.client_tenant_id target):
 *       applyCandidateHardExclusions()          → erased / DNC / pending_profile
 *       applyCandidatePrivacyFilter(job.tenantId) → paused / hide-from-employer
 *                                                    / block / match-only.
 *   This test drives that EXACT composition (the same imported functions, in the
 *   same order, with the receiving tenant as the viewer) over a rich, realistic
 *   population, and asserts that no privacy-barred candidate survives to the
 *   push while a compliant CONTROL does.
 *
 * WHY NOT drive runPlatformRecommendationForJob() end-to-end here:
 *   The engine fetches the ENTIRE live platform pool and calls the (paid,
 *   non-deterministic) GPT-4o scorer on every seal-surviving, location-eligible
 *   candidate. A push additionally depends on the model returning score ≥ 75.
 *   That makes an end-to-end assertion flaky, slow, and dependent on real AI
 *   credentials — a poor regression gate. The security-decisive step is the seal
 *   that runs BEFORE scoring, so we prove the seal deterministically here, and
 *   the STATIC guard (check-platform-pool-read.mjs) enforces that both engine
 *   entry points remain wired to it (VERIFIED-CONTROLLED allowlist entries that
 *   name this test).
 *
 * KEY INVARIANTS PROVEN
 *   1. Per-employer, not global: a job-seeker who hid from Acme is still
 *      recommendable to Globex, and vice-versa (hide/block are relative to the
 *      RECEIVING tenant).
 *   2. Hard exclusions are absolute: erased / DNC never reach the push for ANY
 *      employer.
 *   3. Combined vectors fail closed: any one active bar removes the candidate.
 *   4. A compliant CONTROL survives the seal on every receiving tenant — guards
 *      against an all-empty false-pass (a seal that nuked everyone would look
 *      "safe" but is actually broken).
 *
 * Asserts on SEEDED ids only, so it is robust to whatever else lives in the pool.
 * Uses dbAdmin for seeding (bare/background context falls through to dbAdmin, the
 * same way the scheduler invokes the engine), so no HTTP/router is needed.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { dbAdmin, tenantsTable, candidatesTable } from "@workspace/db";
import { applyCandidatePrivacyFilter, applyCandidateHardExclusions } from "./candidates";

const P = "cpsr_"; // combinatorial privacy seal — recommendation push
const id = (s: string) => P + s;

/* ── Receiving employers (job.tenantId targets) ───────────────────────────── */
const ACME = id("acme");     // acme.com
const GLOBEX = id("globex"); // globex.com
const ALL_TENANTS = [ACME, GLOBEX];

/* ── Platform-pool candidate fixtures (pool="platform") ───────────────────── */
const C = {
  clean:       id("pClean"),       // CONTROL — no flags, recommendable to both
  paused:      id("pPaused"),      // discoveryPaused — barred from both
  hideAcme:    id("pHideAcme"),    // hide-from-employer @ acme.com — barred @ Acme only
  blockAcme:   id("pBlockAcme"),   // blockedCompanyDomains=[acme.com] — barred @ Acme only
  blockGlobex: id("pBlockGlobex"), // blockedCompanyDomains=[globex.com] — barred @ Globex only
  blockBoth:   id("pBlockBoth"),   // blockedCompanyDomains=[acme.com, globex.com] — barred from both
  matchOnly:   id("pMatchOnly"),   // matchOnlyVisibility, no preferredRoles — barred from both
  dnc:         id("pDnc"),         // doNotContact — hard exclusion, barred from both
  erased:      id("pErased"),      // dataErasedAt — hard exclusion, barred from both
  combo:       id("pCombo"),       // paused + hideAcme + blockGlobex + matchOnly — barred from both
};

// Barred from EVERY receiving tenant regardless of domain.
const BARRED_ALL = [C.paused, C.blockBoth, C.matchOnly, C.dnc, C.erased, C.combo];
const ALL_SEEDED = [
  C.clean, ...BARRED_ALL, C.hideAcme, C.blockAcme, C.blockGlobex,
];

/** Run the EXACT seal the engine applies inside evaluateJobAgainstCandidates,
 *  for a given receiving tenant (job.tenantId), and return the surviving ids. */
async function sealFor(receivingTenantId: string): Promise<Set<string>> {
  const rows = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(inArray(candidatesTable.id, ALL_SEEDED));
  const sealed = await applyCandidatePrivacyFilter(
    applyCandidateHardExclusions(rows),
    receivingTenantId,
  );
  return new Set<string>(sealed.map((r: any) => r.id));
}

function assertRecommendable(ids: Set<string>, want: string[], where: string) {
  for (const cid of want)
    assert.ok(ids.has(cid), `${where}: expected ${cid} to be RECOMMENDABLE but the seal dropped it`);
}
function assertBarred(ids: Set<string>, barred: string[], where: string) {
  for (const cid of barred)
    assert.ok(!ids.has(cid), `LEAK @ ${where}: barred candidate ${cid} survived the seal and could be pushed to this employer`);
}

async function cleanup() {
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, ALL_SEEDED));
  for (const t of ALL_TENANTS) await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, t));
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: ACME,   name: "Acme (receiving)",   slug: ACME,   plan: "enterprise", website: "https://acme.com" },
    { id: GLOBEX, name: "Globex (receiving)", slug: GLOBEX, plan: "enterprise", website: "https://globex.com" },
  ]);

  await dbAdmin.insert(candidatesTable).values([
    { id: C.clean,       tenantId: "platform", firstName: "Clean",  lastName: "Control",   email: C.clean + "@js.test",       pool: "platform", source: "career_site" },
    { id: C.paused,      tenantId: "platform", firstName: "Paused", lastName: "Seeker",    email: C.paused + "@js.test",      pool: "platform", source: "career_site", discoveryPaused: true },
    { id: C.hideAcme,    tenantId: "platform", firstName: "Hidden", lastName: "FromAcme",  email: C.hideAcme + "@js.test",    pool: "platform", source: "career_site", hideFromCurrentEmployer: true, currentEmployerDomain: "acme.com" },
    { id: C.blockAcme,   tenantId: "platform", firstName: "Block",  lastName: "Acme",      email: C.blockAcme + "@js.test",   pool: "platform", source: "career_site", blockedCompanyDomains: ["acme.com"] },
    { id: C.blockGlobex, tenantId: "platform", firstName: "Block",  lastName: "Globex",    email: C.blockGlobex + "@js.test", pool: "platform", source: "career_site", blockedCompanyDomains: ["globex.com"] },
    { id: C.blockBoth,   tenantId: "platform", firstName: "Block",  lastName: "Both",      email: C.blockBoth + "@js.test",   pool: "platform", source: "career_site", blockedCompanyDomains: ["acme.com", "globex.com"] },
    { id: C.matchOnly,   tenantId: "platform", firstName: "Match",  lastName: "OnlySeeker", email: C.matchOnly + "@js.test",  pool: "platform", source: "career_site", matchOnlyVisibility: true },
    { id: C.dnc,         tenantId: "platform", firstName: "DoNot",  lastName: "Contact",   email: C.dnc + "@js.test",         pool: "platform", source: "career_site", doNotContact: true },
    { id: C.erased,      tenantId: "platform", firstName: "Erased", lastName: "Seeker",    email: C.erased + "@js.test",      pool: "platform", source: "career_site", dataErasedAt: new Date() },
    { id: C.combo,       tenantId: "platform", firstName: "Combo",  lastName: "AllBars",   email: C.combo + "@js.test",       pool: "platform", source: "career_site", discoveryPaused: true, hideFromCurrentEmployer: true, currentEmployerDomain: "acme.com", blockedCompanyDomains: ["globex.com"], matchOnlyVisibility: true },
  ]);
}

before(seed);
after(cleanup);

/* ════════════════════════ receiving tenant = Acme ═════════════════════════ */

test("rec-push seal @ Acme: compliant control + Globex-only-blocked survive; Acme's barred never do", async () => {
  const ids = await sealFor(ACME);
  // Recommendable to Acme: the clean control, and a candidate who only blocked Globex.
  assertRecommendable(ids, [C.clean, C.blockGlobex], "rec-seal/acme");
  // Barred from Acme: hide-from-acme, block-acme, and every all-tenant bar.
  assertBarred(ids, [C.hideAcme, C.blockAcme, ...BARRED_ALL], "rec-seal/acme");
});

/* ════════════════════════ receiving tenant = Globex ═══════════════════════ */

test("rec-push seal @ Globex: seal is per-employer, not global", async () => {
  const ids = await sealFor(GLOBEX);
  // Recommendable to Globex: control, and candidates whose bar targets Acme only.
  assertRecommendable(ids, [C.clean, C.hideAcme, C.blockAcme], "rec-seal/globex");
  // Barred from Globex: block-globex, and every all-tenant bar.
  assertBarred(ids, [C.blockGlobex, ...BARRED_ALL], "rec-seal/globex");
});

/* ════════════════════════ false-pass guard ═══════════════════════════════ */

test("rec-push seal admits a compliant control (not an all-empty nuke)", async () => {
  // If the seal returned nothing, the 'barred never survive' assertions above
  // would pass vacuously. Prove the compliant control genuinely gets through on
  // every receiving tenant, so 'no barred pushed' means the seal WORKS, not that
  // it removed everyone.
  for (const t of ALL_TENANTS) {
    const ids = await sealFor(t);
    assert.ok(ids.has(C.clean), `false-pass guard: compliant control was dropped for receiving tenant ${t}`);
  }
});
