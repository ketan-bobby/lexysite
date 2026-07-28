/**
 * self-report-reengagement.test.ts — regression suite for the candidate
 * self-reported job-change flow.
 *
 * The contract under test (the "closure plan" replacing the EnrichLayer diff):
 *   1. A candidate editing their OWN current company/title fires the same
 *      congratulate/re-engage flow the LinkedIn monitor used: canonical
 *      candidates row synced + a follow_up communication_events row written
 *      (the observable proof the email path completed — sendEmail runs in
 *      simulated mode here because AWS creds are removed in-test).
 *   2. QUIET GATES: doNotContact and discoveryPaused suppress the email
 *      (no communication_events row) but NEVER block the profile sync itself.
 *      A paused candidate updating their profile must not get surprise mail.
 *   3. No-change edits are a no-op (no sync churn, no email).
 *   4. Cooldown: a follow_up sent within 30 days suppresses a repeat.
 *   5. Tenant-pool candidate with an unresolvable tenant is synced but never
 *      emailed under Lexy branding.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  db,
  candidatesTable,
  communicationEventsTable,
  tenantsTable,
} from "@workspace/db";
import { processSelfReportedJobChange, isSameValueFuzzy } from "./self-report-reengagement.js";

/* Force the simulated-send branch of email.ts: it reads AWS creds LIVE from
 * process.env, so removing them here guarantees no real SES traffic. */
const SAVED_ENV: Record<string, string | undefined> = {};
for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SES_FROM_EMAIL"]) {
  SAVED_ENV[k] = process.env[k];
  delete process.env[k];
}
process.on("exit", () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) if (v !== undefined) process.env[k] = v;
});

const uid = () => crypto.randomUUID();

async function seedCandidate(overrides: Partial<Record<string, any>> = {}) {
  const tenantId = overrides.tenantId ?? `t_selfreport_${uid()}`;
  if (!overrides.skipTenant && tenantId !== "platform") {
    await db.insert(tenantsTable).values({
      id: tenantId,
      name: "SelfReport Test Agency",
      slug: `selfreport-${uid()}`.slice(0, 48),
    } as any).onConflictDoNothing();
  }
  const [cand] = await db.insert(candidatesTable).values({
    tenantId,
    firstName: "Test",
    lastName: "Candidate",
    email: `selfreport-${uid()}@t.test`,
    currentTitle: "Software Engineer",
    currentCompany: "Old Corp",
    pool: "tenant",
    ...overrides.candidate,
  } as any).returning({ id: candidatesTable.id });
  return { candidateId: cand.id, tenantId };
}

async function commEvents(candidateId: string) {
  return db.select().from(communicationEventsTable)
    .where(and(
      eq(communicationEventsTable.candidateId, candidateId),
      eq(communicationEventsTable.type, "follow_up"),
    ));
}

async function candidateRow(candidateId: string) {
  const [row] = await db.select({
    currentTitle:   candidatesTable.currentTitle,
    currentCompany: candidatesTable.currentCompany,
  }).from(candidatesTable).where(eq(candidatesTable.id, candidateId));
  return row;
}

async function cleanup(candidateId: string) {
  await db.delete(communicationEventsTable).where(eq(communicationEventsTable.candidateId, candidateId));
  await db.delete(candidatesTable).where(eq(candidatesTable.id, candidateId));
}

/* ── 1. Happy path: self-reported change fires the congratulate flow ────── */
test("company change syncs the candidate row AND fires the re-engage flow", async () => {
  const { candidateId } = await seedCandidate();
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Engineer", prevCompany: "Old Corp",
      newTitle: "Staff Engineer", newCompany: "New Startup Inc",
    });
    assert.equal(r.changed, true, "change must be detected");
    assert.equal(r.emailSent, true, `email must fire (reason=${r.reason ?? "none"})`);

    const row = await candidateRow(candidateId);
    assert.equal(row.currentTitle, "Staff Engineer", "candidates.currentTitle must sync");
    assert.equal(row.currentCompany, "New Startup Inc", "candidates.currentCompany must sync");

    const events = await commEvents(candidateId);
    assert.equal(events.length, 1, "exactly one follow_up communication event");
    assert.match(events[0].body ?? "", /Self-reported job change/, "event body records the self-report source");
    assert.match(events[0].subject ?? "", /Congratulations/, "congratulations email subject");
  } finally { await cleanup(candidateId); }
});

/* ── 2a. DNC: sync yes, email NO ─────────────────────────────────────────── */
test("doNotContact suppresses the email but the profile edit still syncs", async () => {
  const { candidateId } = await seedCandidate({ candidate: { doNotContact: true } });
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Engineer", prevCompany: "Old Corp",
      newTitle: undefined, newCompany: "Fresh Co",
    });
    assert.equal(r.changed, true);
    assert.equal(r.emailSent, false, "DNC candidate must never be emailed");
    assert.equal(r.reason, "do_not_contact");

    const row = await candidateRow(candidateId);
    assert.equal(row.currentCompany, "Fresh Co", "sync must still happen — quiet ≠ frozen profile");

    assert.equal((await commEvents(candidateId)).length, 0, "no communication event under DNC");
  } finally { await cleanup(candidateId); }
});

/* ── 2b. Pause discovery: sync yes, email NO ─────────────────────────────── */
test("discoveryPaused suppresses the email but the profile edit still syncs", async () => {
  const { candidateId } = await seedCandidate({ candidate: { discoveryPaused: true } });
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Engineer", prevCompany: "Old Corp",
      newTitle: "Principal Engineer", newCompany: undefined,
    });
    assert.equal(r.changed, true);
    assert.equal(r.emailSent, false, "paused candidate must stay quiet");
    assert.equal(r.reason, "discovery_paused");

    const row = await candidateRow(candidateId);
    assert.equal(row.currentTitle, "Principal Engineer", "sync must still happen while paused");

    assert.equal((await commEvents(candidateId)).length, 0, "no communication event while paused");
  } finally { await cleanup(candidateId); }
});

/* ── 2c. Erased data: fully quiet, no sync churn on an erased record ─────── */
test("dataErasedAt suppresses the email", async () => {
  const { candidateId } = await seedCandidate({ candidate: { dataErasedAt: new Date() } });
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Engineer", prevCompany: "Old Corp",
      newTitle: undefined, newCompany: "Erased Co",
    });
    assert.equal(r.emailSent, false, "erased candidate must never be emailed");
    assert.equal((await commEvents(candidateId)).length, 0, "no communication event for erased data");
  } finally { await cleanup(candidateId); }
});

/* ── 2d. Synthetic email: never send to placeholder addresses ────────────── */
test("synthetic placeholder email suppresses the send but sync proceeds", async () => {
  const { candidateId } = await seedCandidate({
    candidate: { email: `synthetic-${uid()}@unknown.local` },
  });
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Engineer", prevCompany: "Old Corp",
      newTitle: undefined, newCompany: "Synthetic Co",
    });
    assert.equal(r.changed, true);
    assert.equal(r.emailSent, false, "placeholder address must never receive mail");
    assert.equal(r.reason, "no_real_email");
    assert.equal((await commEvents(candidateId)).length, 0);
    assert.equal((await candidateRow(candidateId)).currentCompany, "Synthetic Co", "sync still happens");
  } finally { await cleanup(candidateId); }
});

/* ── 3. No change = no-op ────────────────────────────────────────────────── */
test("resubmitting identical values is a no-op (no email, no event)", async () => {
  const { candidateId } = await seedCandidate();
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Engineer", prevCompany: "Old Corp",
      newTitle: "  software ENGINEER ", newCompany: "old corp", // normalization must match
    });
    assert.equal(r.changed, false, "case/whitespace variants are not a job change");
    assert.equal((await commEvents(candidateId)).length, 0);
  } finally { await cleanup(candidateId); }
});

/* ── 3b. Fuzzy equivalence: cosmetic edits are never a "new role" ────────── */
test("isSameValueFuzzy treats typos, abbreviations and reordering as same", () => {
  // typo fixes
  assert.equal(isSameValueFuzzy("Software Enginer", "Software Engineer"), true);
  assert.equal(isSameValueFuzzy("Googel", "Google"), true);
  // abbreviation swaps
  assert.equal(isSameValueFuzzy("Sr. Software Engineer", "Senior Software Engineer"), true);
  assert.equal(isSameValueFuzzy("Eng Mgr", "Engineering Manager"), false); // eng→engineer ≠ engineering: real-word distance still catches it?
  assert.equal(isSameValueFuzzy("VP Sales", "Vice President Sales"), true);
  // corporate suffixes and punctuation
  assert.equal(isSameValueFuzzy("Acme, Inc.", "Acme"), true);
  assert.equal(isSameValueFuzzy("Acme Corp", "ACME"), true);
  // token reordering
  assert.equal(isSameValueFuzzy("Software Engineer, Senior", "Senior Software Engineer"), true);
  // genuinely different values must NOT be collapsed
  assert.equal(isSameValueFuzzy("Software Engineer", "Product Manager"), false);
  assert.equal(isSameValueFuzzy("Google", "Meta"), false);
  assert.equal(isSameValueFuzzy("Old Corp", "New Startup Inc"), false);
  // short acronyms: every character matters — no typo budget
  assert.equal(isSameValueFuzzy("CFO", "CEO"), false);
  assert.equal(isSameValueFuzzy("COO", "CEO"), false);
  // "co" only drops as a trailing legal suffix, never mid-title
  assert.equal(isSameValueFuzzy("Co-Founder", "Founder"), false);
  assert.equal(isSameValueFuzzy("Tata Group", "Adani Group"), false);
  assert.equal(isSameValueFuzzy("Alpha Holdings", "Beta Holdings"), false);
  // trailing-suffix drop still works for real legal-name variants
  assert.equal(isSameValueFuzzy("Acme Co", "Acme"), true);
});

test("a typo fix syncs the spelling but fires NO congratulations email", async () => {
  const { candidateId } = await seedCandidate({
    candidate: { currentTitle: "Software Enginer", currentCompany: "Acme, Inc." },
  });
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Enginer", prevCompany: "Acme, Inc.",
      newTitle: "Software Engineer", newCompany: "Acme Inc",
    });
    assert.equal(r.changed, false, "typo fix is not a job change");
    assert.equal(r.emailSent, false);
    assert.equal((await commEvents(candidateId)).length, 0, "no congrats email for a typo fix");

    const row = await candidateRow(candidateId);
    assert.equal(row.currentTitle, "Software Engineer", "corrected spelling still syncs");
  } finally { await cleanup(candidateId); }
});

test("abbreviation swap (Sr. → Senior) fires NO email", async () => {
  const { candidateId } = await seedCandidate({
    candidate: { currentTitle: "Sr. Software Engineer" },
  });
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Sr. Software Engineer", prevCompany: "Old Corp",
      newTitle: "Senior Software Engineer", newCompany: undefined,
    });
    assert.equal(r.changed, false, "Sr./Senior is the same role");
    assert.equal((await commEvents(candidateId)).length, 0);
  } finally { await cleanup(candidateId); }
});

/* ── 4. Cooldown: recent follow_up suppresses a repeat ───────────────────── */
test("a follow_up within 30 days suppresses a second congratulations", async () => {
  const { candidateId, tenantId } = await seedCandidate();
  try {
    await db.insert(communicationEventsTable).values({
      tenantId, candidateId,
      type: "follow_up", channel: "email", status: "sent",
      subject: "prior engagement", body: "x", sentAt: new Date(),
    } as any);

    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Engineer", prevCompany: "Old Corp",
      newTitle: undefined, newCompany: "Another New Co",
    });
    assert.equal(r.changed, true);
    assert.equal(r.emailSent, false, "cooldown must suppress the second email");
    assert.equal(r.reason, "cooldown");
    assert.equal((await commEvents(candidateId)).length, 1, "still just the prior event");

    const row = await candidateRow(candidateId);
    assert.equal(row.currentCompany, "Another New Co", "sync still happens under cooldown");
  } finally { await cleanup(candidateId); }
});

/* ── 5. Unresolvable tenant: never mis-branded as Lexy ───────────────────── */
test("tenant-pool candidate with an unresolvable tenant is synced but not emailed", async () => {
  const { candidateId } = await seedCandidate({ tenantId: `t_ghost_${uid()}`, skipTenant: true });
  try {
    const r = await processSelfReportedJobChange({
      candidateId,
      prevTitle: "Software Engineer", prevCompany: "Old Corp",
      newTitle: undefined, newCompany: "Brandless Co",
    });
    assert.equal(r.changed, true);
    assert.equal(r.emailSent, false, "no brand → no email (never Lexy fallback for tenant pool)");
    assert.equal(r.reason, "no_brand");
    assert.equal((await commEvents(candidateId)).length, 0);
    assert.equal((await candidateRow(candidateId)).currentCompany, "Brandless Co");
  } finally { await cleanup(candidateId); }
});
