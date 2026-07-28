/**
 * viewer-privacy-seal.test.ts — PROOF the retroactive viewer-privacy seal
 * actually hides blocked-company view events, with a canary that guards
 * against an all-empty false pass.
 *
 * Incident class this guards: 4 of 5 readers of eventType='recruiter_view'
 * were missed by a name-based sweep. A repo-scan claim ("no unsealed reader
 * remains") is not proof, so this file has two layers:
 *
 *   A. Helper-level tests of the canonical seal (getViewerPrivacySeal +
 *      countSealedRecruiterViews in lib/viewer-privacy.ts) — the exact
 *      semantics every reader must inherit:
 *        1. A view from a blocked company ("Acme", domain on the candidate's
 *           blockedCompanyDomains) is excluded — from the SQL predicate, the
 *           count, and the in-memory isTenantExcluded check alike.
 *        2. CANARY: a same-timestamp view from a NOT-blocked company ("Beta")
 *           still counts — the seal demotes selectively, it does not return
 *           empty results.
 *        3. discoveryPaused=true silences the entire seen-surface, and
 *           unpausing restores history minus blocked companies.
 *        4. Fail-CLOSED: an unresolvable viewer-tenant domain is excluded.
 *        5. Anonymous NULL-tenant events are kept.
 *        6. No-block control: empty block list → nothing excluded.
 *
 *   B. ONE reader-level test that walks ALL FIVE readers of recruiter_view
 *      events against the SAME seeded violation — a single test so the five
 *      surfaces can never drift out of sync:
 *        1. GET /portal/engagement    — counts, top-viewer companies, tiers,
 *                                       target-company matches.
 *        2. GET /portal/career-progress — weekly view count + recent-actions feed.
 *        3. Weekly digest email       — rendered "N recruiters viewed you".
 *        4. Achievement engine        — view-driven badge eligibility.
 *        5. Market-event emitter      — target-company + view-burst alerts.
 *      Each surface asserts BOTH suppression (Acme never appears/counts/fires)
 *      AND capability (Beta does) — proving the seal filters selectively
 *      rather than the feature being broken.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray, eq, and, like, desc } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  candidateActionEventsTable,
  candidateAchievementsTable,
  candidateCareerProfilesTable,
  candidateProgressSnapshotsTable,
  candidateMarketEventsSentTable,
  auditLogsTable,
} from "@workspace/db";
import { getViewerPrivacySeal, countSealedRecruiterViews } from "./viewer-privacy.js";
import { issueToken } from "./auth-token";

const P = "vps_" + crypto.randomUUID().slice(0, 8) + "_";
const id = (s: string) => P + s;

const T_ACME  = id("acme");     // blocked company — website resolves to acme-blocked.test
const T_BETA  = id("beta");     // canary company — NOT blocked
const T_MYST  = id("mystery");  // unresolvable domain (no website, no contact email)
const T_GAMMA = id("gamma");    // extra unblocked viewer (burst arithmetic)
const T_DELTA = id("delta");    // extra unblocked viewer (burst arithmetic)
const T_GHOST = id("ghost");    // HAS a website but it's malformed/unparseable — the
                                //   second unresolvable-domain flavor (Mystery = none)
const CAND_BLOCKING = id("candBlocking"); // blocks acme-blocked.test — phases 1-4
const CAND_OPEN     = id("candOpen");     // empty block list (plumbing control)
const CAND_EMITTER  = id("candEmitter");  // blocks acme-blocked.test — phase 5 (emitter
                                          //   needs fresh views: recordRecruiterView has a
                                          //   5-min (candidate,viewer) dedupe that would
                                          //   short-circuit on the pre-seeded rows above)
const CAND_PAUSED   = id("candPaused");   // NO blocks — the discovery-paused probe (test 2)
const USER_BLOCKING = id("userBlocking"); // portal login for the blocking candidate
const USER_PAUSED   = id("userPaused");   // portal login for the paused candidate
const ALL_CANDS   = [CAND_BLOCKING, CAND_OPEN, CAND_EMITTER, CAND_PAUSED];
const ALL_TENANTS = [T_ACME, T_BETA, T_MYST, T_GAMMA, T_DELTA, T_GHOST];

async function cleanup() {
  await dbAdmin.delete(candidateAchievementsTable)
    .where(inArray(candidateAchievementsTable.candidateId, ALL_CANDS)).catch(() => {});
  await dbAdmin.delete(candidateProgressSnapshotsTable)
    .where(inArray(candidateProgressSnapshotsTable.candidateId, ALL_CANDS)).catch(() => {});
  await dbAdmin.delete(candidateMarketEventsSentTable)
    .where(inArray(candidateMarketEventsSentTable.candidateId, ALL_CANDS)).catch(() => {});
  await dbAdmin.delete(candidateCareerProfilesTable)
    .where(inArray(candidateCareerProfilesTable.candidateId, ALL_CANDS)).catch(() => {});
  await dbAdmin.delete(auditLogsTable)
    .where(inArray(auditLogsTable.subjectId, ALL_CANDS)).catch(() => {});
  await dbAdmin.delete(candidateActionEventsTable)
    .where(inArray(candidateActionEventsTable.candidateId, ALL_CANDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, ALL_CANDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, [USER_BLOCKING, USER_PAUSED]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, ALL_TENANTS));
}

const view = (candidateId: string, viewerTenantId: string | null) => ({
  candidateId,
  eventType: "recruiter_view" as const,
  viewerTenantId,
  payload: {},
  createdAt: new Date(), // all events "now" — recency can never explain an exclusion
});

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: T_ACME,  name: "Acme Corp",        slug: T_ACME,  plan: "enterprise", website: "https://www.acme-blocked.test" },
    { id: T_BETA,  name: "Beta Inc",         slug: T_BETA,  plan: "enterprise", website: "https://beta-canary.test" },
    // Mystery: no website, no contactEmail — the fail-closed probe.
    { id: T_MYST,  name: "Mystery Holdings", slug: T_MYST,  plan: "enterprise" },
    { id: T_GAMMA, name: "Gamma Labs",       slug: T_GAMMA, plan: "enterprise", website: "https://gamma-ok.test" },
    { id: T_DELTA, name: "Delta Works",      slug: T_DELTA, plan: "enterprise", website: "https://delta-ok.test" },
    // Ghost: website present but unparseable as a URL — domain resolution must
    // throw, leaving tenantDoms empty → same fail-closed path as no-website.
    { id: T_GHOST, name: "Ghost Ventures",   slug: T_GHOST, plan: "enterprise", website: "not a valid url ##" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: USER_BLOCKING, tenantId: T_BETA, email: USER_BLOCKING + "@js.test", name: "Blocked Blocker", passwordHash: "x", role: "candidate", status: "active" },
    { id: USER_PAUSED,   tenantId: T_BETA, email: USER_PAUSED + "@js.test",   name: "Paused Probe",    passwordHash: "x", role: "candidate", status: "active" },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    {
      id: CAND_BLOCKING, tenantId: T_BETA, firstName: "Blocked", lastName: "Blocker",
      email: CAND_BLOCKING + "@js.test", source: "career_site",
      userId: USER_BLOCKING,
      pool: "platform", // weekly digest only scans the platform pool
      discoveryPaused: false,
      blockedCompanyDomains: ["acme-blocked.test"],
    },
    {
      id: CAND_OPEN, tenantId: T_BETA, firstName: "Open", lastName: "Control",
      email: CAND_OPEN + "@js.test", source: "career_site",
      discoveryPaused: false,
      blockedCompanyDomains: [],
    },
    {
      id: CAND_EMITTER, tenantId: T_BETA, firstName: "Emitter", lastName: "Probe",
      email: CAND_EMITTER + "@js.test", source: "career_site",
      discoveryPaused: false,
      blockedCompanyDomains: ["acme-blocked.test"],
    },
    {
      // Discovery-pause probe (test 2): NO blocks — every exclusion asserted
      // there must come from the pause switch alone. Seeded pool='tenant' so
      // test 1's runWeeklyDigest() (platform-pool scan) can't touch it and
      // burn its weeklyDigestLastSentAt gate; test 2 flips it to 'platform'.
      id: CAND_PAUSED, tenantId: T_BETA, firstName: "Paused", lastName: "Probe",
      email: CAND_PAUSED + "@js.test", source: "career_site",
      userId: USER_PAUSED,
      pool: "tenant",
      discoveryPaused: false,
      blockedCompanyDomains: [],
    },
  ]);
  // Target-company lists: BOTH candidates target Acme AND Beta, so a
  // target-match surfaced for Beta but never Acme is seal behavior, not a
  // missing target entry.
  await dbAdmin.insert(candidateCareerProfilesTable).values([
    { candidateId: CAND_BLOCKING, targetCompanies: ["Acme Corp", "Beta Inc"] } as any,
    { candidateId: CAND_EMITTER,  targetCompanies: ["Acme Corp", "Beta Inc"] } as any,
    // Paused probe targets Gamma+Delta so test 2 can prove a target-company
    // alert is suppressed by the pause (Gamma) and fires after unpause (Delta).
    { candidateId: CAND_PAUSED,   targetCompanies: ["Gamma Labs", "Delta Works"] } as any,
  ]);
  await dbAdmin.insert(candidateActionEventsTable).values([
    // The violation case + canary, both timestamped now:
    view(CAND_BLOCKING, T_ACME),   // must be sealed away
    view(CAND_BLOCKING, T_BETA),   // CANARY — must survive
    view(CAND_BLOCKING, T_MYST),   // unresolvable domain (no website) — must fail closed
    view(CAND_BLOCKING, T_GHOST),  // unresolvable domain (malformed website) — must fail closed
    view(CAND_BLOCKING, null),     // anonymous legacy row — must be kept
    // Plumbing control candidate — same viewers, no blocks:
    view(CAND_OPEN, T_ACME),
    view(CAND_OPEN, T_BETA),
    view(CAND_OPEN, T_GHOST),      // same malformed-domain viewer, no blocks → must SHOW
    // Paused probe's PRIOR history: 12 views from a NON-blocked company —
    // enough to clear the 10-view 'in_demand' badge threshold once unpaused,
    // so badge suppression while paused is provably the pause, not low volume.
    ...Array.from({ length: 12 }, () => view(CAND_PAUSED, T_BETA)),
  ]);
});

after(cleanup);

test("SEAL: blocked-company view is excluded; CANARY same-time non-blocked view survives", async () => {
  const seal = await getViewerPrivacySeal(CAND_BLOCKING);
  assert.equal(seal.viewsPaused, false);
  assert.ok(seal.excludedViewerTenantIds.includes(T_ACME),
    "LEAK: the blocked company's tenant was not excluded by the seal");
  assert.ok(!seal.excludedViewerTenantIds.includes(T_BETA),
    "FALSE POSITIVE: the non-blocked canary tenant was excluded — seal is over-hiding");

  // In-memory check readers use on already-fetched rows:
  assert.equal(seal.isTenantExcluded(T_ACME), true, "isTenantExcluded must hide Acme");
  assert.equal(seal.isTenantExcluded(T_BETA), false, "isTenantExcluded must keep the Beta canary");

  // Count = Beta canary + mystery? No — mystery fails closed. + NULL anon kept.
  const n = await countSealedRecruiterViews(CAND_BLOCKING, null, seal);
  assert.equal(n, 2,
    `sealed count must be exactly 2 (Beta canary + anonymous NULL row); got ${n} — ` +
    "0/1 means the seal is nuking everything (empty-result false pass), 3+ means Acme or Mystery leaked");
});

test("FAIL-CLOSED: unresolvable viewer-tenant domain is excluded while blocks are active", async () => {
  const seal = await getViewerPrivacySeal(CAND_BLOCKING);
  assert.ok(seal.excludedViewerTenantIds.includes(T_MYST),
    "LEAK: a viewer tenant with an unresolvable domain must be excluded, not shown");
});

test("FAIL-CLOSED (malformed domain): unparseable tenant website is hidden with blocks active, shown without", async () => {
  // Ghost Ventures HAS a website — it's just not parseable as a URL. Same
  // conservative rule as the recruiter-side privacy filter: with active
  // blocks, "can't resolve" must mean "hide", never "show".
  const sealed = await getViewerPrivacySeal(CAND_BLOCKING);
  assert.ok(sealed.excludedViewerTenantIds.includes(T_GHOST),
    "LEAK: a viewer tenant with a MALFORMED website domain must fail closed while blocks are active");
  assert.equal(sealed.isTenantExcluded(T_GHOST), true,
    "isTenantExcluded must hide the malformed-domain tenant");
  assert.equal(await countSealedRecruiterViews(CAND_BLOCKING, null, sealed), 2,
    "sealed count must stay 2 — the malformed-domain view must not slip into counts");

  // Contrast: NO blocks → nothing to protect → the same viewer is shown.
  // Proves the exclusion is the fail-closed rule, not a blanket ban on
  // unresolvable tenants (which would over-hide for every candidate).
  const open = await getViewerPrivacySeal(CAND_OPEN);
  assert.equal(open.isTenantExcluded(T_GHOST), false,
    "OVER-HIDING: with no active blocks the malformed-domain viewer must be shown");
});

test("ANONYMOUS: NULL-tenant events are kept in sealed counts", async () => {
  const seal = await getViewerPrivacySeal(CAND_BLOCKING);
  assert.equal(seal.isTenantExcluded(null), false);
  assert.equal(seal.isTenantExcluded(undefined), false);
});

test("PAUSE: discoveryPaused silences the whole surface; unpausing restores history minus blocks", async () => {
  await dbAdmin.update(candidatesTable)
    .set({ discoveryPaused: true }).where(eq(candidatesTable.id, CAND_BLOCKING));
  try {
    const paused = await getViewerPrivacySeal(CAND_BLOCKING);
    assert.equal(paused.viewsPaused, true);
    assert.equal(await countSealedRecruiterViews(CAND_BLOCKING, null, paused), 0,
      "while paused the sealed count must be zero");
  } finally {
    await dbAdmin.update(candidatesTable)
      .set({ discoveryPaused: false }).where(eq(candidatesTable.id, CAND_BLOCKING));
  }
  const unpaused = await getViewerPrivacySeal(CAND_BLOCKING);
  assert.equal(unpaused.viewsPaused, false);
  assert.equal(await countSealedRecruiterViews(CAND_BLOCKING, null, unpaused), 2,
    "unpausing must restore history (canary + anon) while blocked companies stay hidden");
});

test("CONTROL: with an empty block list nothing is excluded — exclusions come from the block list, not the plumbing", async () => {
  const seal = await getViewerPrivacySeal(CAND_OPEN);
  assert.equal(seal.viewsPaused, false);
  assert.equal(seal.excludedViewerTenantIds.length, 0,
    "a candidate with no blocks must have no excluded viewers (incl. the unresolvable-domain tenant)");
  const n = await countSealedRecruiterViews(CAND_OPEN, null, seal);
  assert.equal(n, 3, `open candidate must see all their views (Acme + Beta + malformed-domain Ghost); got ${n}`);
});

test("WINDOW: `since` cutoff still applies under the seal", async () => {
  const seal = await getViewerPrivacySeal(CAND_BLOCKING);
  const future = new Date(Date.now() + 60_000);
  assert.equal(await countSealedRecruiterViews(CAND_BLOCKING, future, seal), 0,
    "a future `since` must yield zero — the seal must not bypass the time window");
});

/* ── ALL FIVE READERS, ONE TEST ─────────────────────────────────────────────
 * The incident class was an unsealed READER, not a broken seal. Unit-testing
 * the helper cannot catch a reader that stops calling it, and five separate
 * reader tests could drift out of sync — so this single test walks every
 * reader of recruiter_view events against the same seeded violation.
 *
 * Phase order matters: phases 1-2 assert the exact sealed count (2) on the
 * pristine fixture; phase 3 adds bulk views to move badge thresholds; phase 4
 * (digest) recomputes its expectation from the post-phase-3 ledger; phase 5
 * uses a dedicated candidate because the emitter dedupes repeat views. */
test("READERS: the seal holds across all five recruiter_view readers", async (t) => {
  // Force the simulated-send branch in email.ts — isEmailConfigured() reads
  // AWS creds LIVE from process.env, so deleting them here prevents any real
  // SES delivery from the digest/emitter phases (restored in finally).
  const SAVED_ENV: Record<string, string | undefined> = {};
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SES_FROM_EMAIL"]) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }

  const careerProfileRouter = (await import("../routes/career-profile")).default;
  const app = express();
  app.use(express.json());
  app.use(careerProfileRouter);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = issueToken({ userId: USER_BLOCKING, role: "candidate", tenantId: T_BETA });
  const authGet = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, `${path} must respond 200, got ${res.status}: ${await res.clone().text()}`);
    return res.json() as Promise<any>;
  };

  try {
    /* ── READER 1: GET /portal/engagement ──────────────────────────────── */
    await t.test("reader 1: /portal/engagement — counts, companies, tiers, target matches", async () => {
      const body = await authGet("/portal/engagement");

      // All 4 events are "now" → every window sees the same set. Sealed truth
      // = Beta canary + anonymous NULL row = 2. Raw query = 5; over-hiding = 0/1.
      for (const key of ["last24h", "last7d", "last30d"] as const) {
        const v = Number(body?.recruiterPulse?.[key]);
        assert.equal(v, 2,
          `LEAK/REGRESSION: ${key} must be the sealed count 2 (canary + anon); got ${v} — ` +
          "5 = reader bypassed the seal, 0/1 = seal over-hiding (empty false-pass)");
      }

      // Identified-company list: canary visible, blocked company never.
      const names = (body?.topViewerCompanies ?? []).map((c: any) => String(c?.name ?? ""));
      assert.ok(names.includes("Beta Inc"),
        `CANARY MISSING: Beta Inc must appear in topViewerCompanies; got ${JSON.stringify(names)}`);
      assert.ok(!names.includes("Acme Corp"),
        `LEAK: blocked company in topViewerCompanies: ${JSON.stringify(names)}`);
      assert.ok(!names.includes("Mystery Holdings"),
        `LEAK: unresolvable-domain company must fail closed out of topViewerCompanies: ${JSON.stringify(names)}`);
      assert.ok(!names.includes("Ghost Ventures"),
        `LEAK: malformed-domain company must fail closed out of topViewerCompanies: ${JSON.stringify(names)}`);

      // Tier buckets: both Acme and Beta classify as tier3 (not in the tier1/2
      // name lists), so a sealed tier read shows exactly ONE tier3 company (Beta).
      const tiers = body?.viewerCompaniesByTier ?? {};
      const totalTierViews = ["tier1", "tier2", "tier3"]
        .reduce((s, k) => s + Number(tiers?.[k]?.count ?? 0), 0);
      assert.equal(totalTierViews, 1,
        `LEAK: tier buckets must contain only the Beta view (1); got ${totalTierViews} — ` +
        "2+ means a hidden viewer (Acme/Mystery) leaked into the tier counts");

      // Target-company matches: candidate targets BOTH Acme and Beta; only
      // Beta may surface — an Acme match here is the exact "target company
      // viewed you" leak the seal exists to prevent.
      const matchNames = (body?.targetCompanyMatches ?? []).map((m: any) => String(m?.name ?? ""));
      assert.ok(matchNames.includes("Beta Inc"),
        `CANARY MISSING: Beta Inc target match must surface; got ${JSON.stringify(matchNames)}`);
      assert.ok(!matchNames.includes("Acme Corp"),
        `LEAK: blocked company surfaced as a target-company match: ${JSON.stringify(matchNames)}`);
    });

    /* ── READER 2: GET /portal/career-progress ─────────────────────────── */
    await t.test("reader 2: /portal/career-progress — weekly count + recent-actions feed", async () => {
      const body = await authGet("/portal/career-progress");

      const weekly = Number(body?.weeklyStats?.recruiterViewsThisWeek);
      assert.equal(weekly, 2,
        `LEAK/REGRESSION: recruiterViewsThisWeek must be the sealed 2; got ${weekly} — ` +
        "5 = unsealed, 0/1 = over-hiding");

      const feed: any[] = body?.recentActions ?? [];
      const feedViews = feed.filter((e) => e?.eventType === "recruiter_view");
      assert.ok(feedViews.some((e) => e?.viewerTenantId === T_BETA),
        "CANARY MISSING: the Beta view must appear in the recentActions feed");
      assert.ok(!feedViews.some((e) => e?.viewerTenantId === T_ACME),
        "LEAK: the blocked company's view appeared in the recentActions feed");
      assert.ok(!feedViews.some((e) => e?.viewerTenantId === T_MYST),
        "LEAK: the unresolvable-domain view must fail closed out of the feed");
      assert.ok(!feedViews.some((e) => e?.viewerTenantId === T_GHOST),
        "LEAK: the malformed-domain view must fail closed out of the feed");
    });

    /* ── READER 3: achievement engine ──────────────────────────────────── */
    // 'in_demand' badge = recruiterViewsAllTime >= 10 (sealed). Push the RAW
    // count past 10 with Acme views: 5 seeded + 9 Acme = 14 raw, but sealed
    // stays 2 → badge must NOT be awarded. Then add 8 Beta views → sealed 10
    // → badge MUST be awarded. The seal alone decides eligibility.
    await t.test("reader 3: achievement engine — Acme views don't qualify badges, Beta views do", async () => {
      const { awardAchievements } = await import("./achievement-engine.js");
      const badge = async () => (await dbAdmin.select().from(candidateAchievementsTable)
        .where(and(
          eq(candidateAchievementsTable.candidateId, CAND_BLOCKING),
          eq(candidateAchievementsTable.code, "in_demand"),
        ))).length > 0;

      await dbAdmin.insert(candidateActionEventsTable)
        .values(Array.from({ length: 9 }, () => view(CAND_BLOCKING, T_ACME)));
      await awardAchievements(CAND_BLOCKING);
      assert.equal(await badge(), false,
        "LEAK: 'in_demand' was awarded off blocked-company views (raw 14, sealed 2 < 10)");

      await dbAdmin.insert(candidateActionEventsTable)
        .values(Array.from({ length: 8 }, () => view(CAND_BLOCKING, T_BETA)));
      const earned = await awardAchievements(CAND_BLOCKING);
      assert.ok(earned.some((a) => a.code === "in_demand") || await badge(),
        "CANARY MISSING: with 10 sealed (Beta+anon) views 'in_demand' must be awarded — " +
        "badges must not be broken generally, only blocked views excluded");
    });

    /* ── READER 4: weekly digest email ─────────────────────────────────── */
    // Post-phase-3 ledger for CAND_BLOCKING (all within 7d):
    //   Acme 10 + Mystery 1 + Ghost 1 (all hidden) + Beta 9 + anon 1 = 22 raw, 10 sealed.
    // The digest subject template is "<name>, N recruiters viewed your profile
    // this week" and sendEmail persists the subject as audit_logs.title
    // (action 'weekly_digest.send') even on the simulated-send branch — that
    // stored title is the rendered content we assert on.
    await t.test("reader 4: weekly digest — rendered view count excludes Acme, includes Beta", async () => {
      const { runWeeklyDigest } = await import("./weekly-digest-scheduler.js");
      await runWeeklyDigest();

      // recordAudit is fire-and-forget — poll briefly for the audit row.
      let title: string | null = null;
      for (let i = 0; i < 20 && title === null; i++) {
        const [row] = await dbAdmin.select({ title: auditLogsTable.title })
          .from(auditLogsTable)
          .where(and(
            eq(auditLogsTable.subjectId, CAND_BLOCKING),
            eq(auditLogsTable.action, "weekly_digest.send"),
          ))
          .orderBy(desc(auditLogsTable.createdAt))
          .limit(1);
        if (row) title = row.title ?? "";
        else await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(title !== null,
        "digest email was never sent for the platform-pool candidate (no weekly_digest.send audit row) — " +
        "with 10 sealed views the digest must not be skipped as empty");
      assert.ok(/\b10 recruiters viewed\b/.test(title!),
        `LEAK/REGRESSION: digest must render the sealed count "10 recruiters viewed"; got title: "${title}" — ` +
        "22 = raw unsealed count leaked, other values = count drifted from the seal");
      assert.ok(!/\b22\b/.test(title!), `LEAK: raw unsealed count 22 in digest title: "${title}"`);
    });

    /* ── READER 5: market-event emitter ────────────────────────────────── */
    // Dedicated candidate (emitter dedupes repeat (candidate,viewer) views).
    // Targets BOTH Acme and Beta. shouldSend() records every fired alert in
    // candidate_market_events_sent BEFORE emailing — those rows are the
    // ground truth for "did an alert fire", independent of transport.
    // Burst arithmetic: after Acme+Gamma+Beta the RAW distinct-viewer count
    // is 3 (burst threshold) but the SEALED count is 2 → no burst. Adding
    // Delta makes sealed 3 → burst fires. Suppression proven, alerts intact.
    await t.test("reader 5: market-event emitter — Acme never fires alerts, Beta/burst still can", async () => {
      const { recordRecruiterView } = await import("./market-event-emitter.js");
      const sentKeys = async () => (await dbAdmin.select({ key: candidateMarketEventsSentTable.eventKey })
        .from(candidateMarketEventsSentTable)
        .where(eq(candidateMarketEventsSentTable.candidateId, CAND_EMITTER)))
        .map((r) => r.key);

      await recordRecruiterView({ candidateId: CAND_EMITTER, viewerTenantId: T_ACME });
      let keys = await sentKeys();
      assert.equal(keys.length, 0,
        `LEAK: blocked-company view fired a market alert: ${JSON.stringify(keys)}`);

      await recordRecruiterView({ candidateId: CAND_EMITTER, viewerTenantId: T_GAMMA });
      await recordRecruiterView({ candidateId: CAND_EMITTER, viewerTenantId: T_BETA });
      keys = await sentKeys();
      assert.ok(keys.includes(`target_company_view:${T_BETA}`),
        `CANARY MISSING: Beta target-company alert must fire (alerts must not be broken generally); got ${JSON.stringify(keys)}`);
      assert.ok(!keys.includes(`target_company_view:${T_ACME}`),
        `LEAK: Acme target-company alert fired: ${JSON.stringify(keys)}`);
      assert.ok(!keys.includes("recruiter_view_burst"),
        "LEAK: view-burst fired at 3 RAW viewers — the hidden Acme view counted toward the burst (sealed is only 2)");

      await recordRecruiterView({ candidateId: CAND_EMITTER, viewerTenantId: T_DELTA });
      keys = await sentKeys();
      assert.ok(keys.includes("recruiter_view_burst"),
        `CANARY MISSING: with 3 sealed viewers (Gamma+Beta+Delta) the burst must fire — got ${JSON.stringify(keys)}`);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

/* ── DISCOVERY-PAUSED, ALL FIVE READERS ─────────────────────────────────────
 * Counterpart to the seal-readers test above: the SAME five readers must go
 * fully quiet when discoveryPaused=true, even for a candidate with NO blocks
 * and real prior history from a non-blocked company — and that history must
 * reappear intact after unpausing. Runs after the readers test (node:test is
 * sequential in-file), so the paused-phase digest run below sees the blocking
 * candidate already gated by its weeklyDigestLastSentAt from the run above. */
test("PAUSED READERS: discoveryPaused silences all five readers; unpausing restores non-blocked history", async (t) => {
  const SAVED_ENV: Record<string, string | undefined> = {};
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SES_FROM_EMAIL"]) {
    SAVED_ENV[k] = process.env[k];
    delete process.env[k];
  }

  const careerProfileRouter = (await import("../routes/career-profile")).default;
  const app = express();
  app.use(express.json());
  app.use(careerProfileRouter);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = issueToken({ userId: USER_PAUSED, role: "candidate", tenantId: T_BETA });
  const authGet = async (path: string) => {
    const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, `${path} must respond 200, got ${res.status}: ${await res.clone().text()}`);
    return res.json() as Promise<any>;
  };
  const digestTitle = async (): Promise<string | null> => {
    const [row] = await dbAdmin.select({ title: auditLogsTable.title })
      .from(auditLogsTable)
      .where(and(
        eq(auditLogsTable.subjectId, CAND_PAUSED),
        eq(auditLogsTable.action, "weekly_digest.send"),
      ))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(1);
    return row ? (row.title ?? "") : null;
  };
  const sentKeys = async () => (await dbAdmin.select({ key: candidateMarketEventsSentTable.eventKey })
    .from(candidateMarketEventsSentTable)
    .where(eq(candidateMarketEventsSentTable.candidateId, CAND_PAUSED)))
    .map((r) => r.key);

  try {
    // Enter the paused state; flip pool to 'platform' so the digest scan
    // includes this candidate (it was seeded 'tenant' to hide from test 1).
    await dbAdmin.update(candidatesTable)
      .set({ discoveryPaused: true, pool: "platform" } as any)
      .where(eq(candidatesTable.id, CAND_PAUSED));

    /* ── PAUSED phase: all five readers must be zero/quiet ──────────────── */
    await t.test("paused reader 1: /portal/engagement is fully zeroed", async () => {
      const body = await authGet("/portal/engagement");
      for (const key of ["last24h", "last7d", "last30d"] as const) {
        const v = Number(body?.recruiterPulse?.[key]);
        assert.equal(v, 0,
          `PAUSE LEAK: ${key} must be 0 while paused; got ${v} (raw history is 12 Beta views)`);
      }
      assert.equal((body?.topViewerCompanies ?? []).length, 0,
        `PAUSE LEAK: topViewerCompanies must be empty while paused: ${JSON.stringify(body?.topViewerCompanies)}`);
      const tiers = body?.viewerCompaniesByTier ?? {};
      const totalTierViews = ["tier1", "tier2", "tier3"]
        .reduce((s, k) => s + Number(tiers?.[k]?.count ?? 0), 0);
      assert.equal(totalTierViews, 0,
        `PAUSE LEAK: tier buckets must be empty while paused; got ${totalTierViews}`);
      assert.equal((body?.targetCompanyMatches ?? []).length, 0,
        `PAUSE LEAK: targetCompanyMatches must be empty while paused: ${JSON.stringify(body?.targetCompanyMatches)}`);
    });

    await t.test("paused reader 2: /portal/career-progress shows no views", async () => {
      const body = await authGet("/portal/career-progress");
      const weekly = Number(body?.weeklyStats?.recruiterViewsThisWeek);
      assert.equal(weekly, 0,
        `PAUSE LEAK: recruiterViewsThisWeek must be 0 while paused; got ${weekly}`);
      const feedViews = (body?.recentActions ?? []).filter((e: any) => e?.eventType === "recruiter_view");
      assert.equal(feedViews.length, 0,
        `PAUSE LEAK: recruiter_view rows in the recentActions feed while paused: ${JSON.stringify(feedViews)}`);
    });

    await t.test("paused reader 3: 12 raw views do NOT earn 'in_demand' while paused", async () => {
      const { awardAchievements } = await import("./achievement-engine.js");
      await awardAchievements(CAND_PAUSED);
      const rows = await dbAdmin.select().from(candidateAchievementsTable)
        .where(and(
          eq(candidateAchievementsTable.candidateId, CAND_PAUSED),
          eq(candidateAchievementsTable.code, "in_demand"),
        ));
      assert.equal(rows.length, 0,
        "PAUSE LEAK: 'in_demand' awarded while paused (raw 12 views, sealed must be 0)");
    });

    await t.test("paused reader 4: weekly digest renders no view count", async () => {
      const { runWeeklyDigest } = await import("./weekly-digest-scheduler.js");
      await runWeeklyDigest();
      // recordAudit is fire-and-forget — give it a moment to land, then check.
      await new Promise((r) => setTimeout(r, 1_500));
      const title = await digestTitle();
      // A digest MAY still send for non-view content (e.g. a badge earned by
      // the paused awardAchievements call above) — that's fine. What must
      // never happen is a view-count subject line while paused.
      if (title !== null) {
        assert.ok(!/viewed your profile/.test(title),
          `PAUSE LEAK: paused digest rendered a recruiter-view subject: "${title}"`);
        assert.ok(!/\b12\b/.test(title),
          `PAUSE LEAK: raw view count 12 in paused digest title: "${title}"`);
      }
    });

    await t.test("paused reader 5: a targeted-company view fires no alert", async () => {
      const { recordRecruiterView } = await import("./market-event-emitter.js");
      // Gamma Labs IS on the candidate's target list — unpaused this exact
      // view would fire target_company_view. Paused, it must fire nothing.
      await recordRecruiterView({ candidateId: CAND_PAUSED, viewerTenantId: T_GAMMA });
      const keys = await sentKeys();
      assert.equal(keys.length, 0,
        `PAUSE LEAK: market alert fired while paused: ${JSON.stringify(keys)}`);
    });

    /* ── UNPAUSE: the pre-existing non-blocked history must reappear ────── */
    await dbAdmin.update(candidatesTable)
      .set({ discoveryPaused: false }).where(eq(candidatesTable.id, CAND_PAUSED));

    // Ledger after unpause: 12 seeded Beta views + 1 Gamma view logged (but
    // not alerted) during the paused emitter probe = 13 visible views.
    await t.test("unpaused: engagement + career-progress restore the full history", async () => {
      const eng = await authGet("/portal/engagement");
      for (const key of ["last24h", "last7d", "last30d"] as const) {
        const v = Number(eng?.recruiterPulse?.[key]);
        assert.equal(v, 13,
          `RESTORE FAIL: ${key} must show all 13 views after unpausing; got ${v} — ` +
          "0 means the pause stuck, other values mean history was mutated by pausing");
      }
      const names = (eng?.topViewerCompanies ?? []).map((c: any) => String(c?.name ?? ""));
      assert.ok(names.includes("Beta Inc"),
        `RESTORE FAIL: Beta Inc missing from topViewerCompanies after unpause: ${JSON.stringify(names)}`);
      const matchNames = (eng?.targetCompanyMatches ?? []).map((m: any) => String(m?.name ?? ""));
      assert.ok(matchNames.includes("Gamma Labs"),
        `RESTORE FAIL: the Gamma view logged during pause must surface as a target match after unpause: ${JSON.stringify(matchNames)}`);

      const prog = await authGet("/portal/career-progress");
      const weekly = Number(prog?.weeklyStats?.recruiterViewsThisWeek);
      assert.equal(weekly, 13,
        `RESTORE FAIL: recruiterViewsThisWeek must be 13 after unpausing; got ${weekly}`);
      const feedViews = (prog?.recentActions ?? []).filter((e: any) => e?.eventType === "recruiter_view");
      assert.ok(feedViews.some((e: any) => e?.viewerTenantId === T_BETA),
        "RESTORE FAIL: Beta views missing from the recentActions feed after unpause");
    });

    await t.test("unpaused: 'in_demand' badge is now earned from the restored history", async () => {
      const { awardAchievements } = await import("./achievement-engine.js");
      const earned = await awardAchievements(CAND_PAUSED);
      const rows = await dbAdmin.select().from(candidateAchievementsTable)
        .where(and(
          eq(candidateAchievementsTable.candidateId, CAND_PAUSED),
          eq(candidateAchievementsTable.code, "in_demand"),
        ));
      assert.ok(earned.some((a) => a.code === "in_demand") || rows.length > 0,
        "RESTORE FAIL: with 13 sealed views 'in_demand' must be awarded after unpausing");
    });

    await t.test("unpaused: weekly digest renders the restored view count", async () => {
      // Clear the paused-phase digest artifacts so the rerun isn't gated by
      // MIN_DAYS_BETWEEN_DIGESTS and the title poll can't match a stale row.
      await dbAdmin.update(candidatesTable)
        .set({ weeklyDigestLastSentAt: null } as any)
        .where(eq(candidatesTable.id, CAND_PAUSED));
      await dbAdmin.delete(auditLogsTable)
        .where(and(
          eq(auditLogsTable.subjectId, CAND_PAUSED),
          eq(auditLogsTable.action, "weekly_digest.send"),
        ));

      const { runWeeklyDigest } = await import("./weekly-digest-scheduler.js");
      await runWeeklyDigest();
      let title: string | null = null;
      for (let i = 0; i < 20 && title === null; i++) {
        title = await digestTitle();
        if (title === null) await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(title !== null,
        "RESTORE FAIL: no digest sent after unpausing — 13 restored views must produce a digest");
      assert.ok(/\b13 recruiters viewed\b/.test(title!),
        `RESTORE FAIL: digest must render "13 recruiters viewed" after unpausing; got: "${title}"`);
    });

    await t.test("unpaused: a targeted-company view fires the alert again", async () => {
      const { recordRecruiterView } = await import("./market-event-emitter.js");
      await recordRecruiterView({ candidateId: CAND_PAUSED, viewerTenantId: T_DELTA });
      const keys = await sentKeys();
      assert.ok(keys.includes(`target_company_view:${T_DELTA}`),
        `RESTORE FAIL: Delta target-company alert must fire after unpausing (alerts must work again); got ${JSON.stringify(keys)}`);
      assert.ok(!keys.includes(`target_company_view:${T_GAMMA}`),
        `PAUSE LEAK: the paused-phase Gamma view retroactively fired an alert: ${JSON.stringify(keys)}`);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await dbAdmin.update(candidatesTable)
      .set({ discoveryPaused: false }).where(eq(candidatesTable.id, CAND_PAUSED));
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});
