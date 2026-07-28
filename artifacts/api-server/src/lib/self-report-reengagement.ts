/**
 * self-report-reengagement.ts — Candidate self-reported job-change flow
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * When a candidate edits their OWN current title/company in the portal, this
 * detects the change (new value vs. the stored prior value at save-time) and
 * routes it into the same congratulate/re-engage email flow the EnrichLayer
 * LinkedIn monitor uses — with zero third-party lookups. Self-reported data
 * beats an inferred LinkedIn diff, and it's candidate-initiated by construction.
 *
 * ─── Quiet gates (checked BEFORE any email) ─────────────────────────────────
 * A candidate updating their profile must never be surprised by an email when
 * they've asked for quiet. All of these suppress the email but NEVER block the
 * profile sync itself:
 *   • doNotContact       — explicit DNC always wins
 *   • discoveryPaused    — "stay invisible until you're ready" means quiet too
 *   • dataErasedAt       — erased candidates get nothing
 *   • synthetic email    — @unknown.local / @import.local placeholders
 *   • 30-day cooldown    — a prior follow_up communication_events row within
 *                          30 days suppresses a repeat (rapid successive edits
 *                          fire at most one congratulations)
 *   • unresolvable brand — tenant-pool candidate whose tenant can't be loaded
 *                          is skipped, never mis-branded as Lexy
 *
 * ─── Called by ──────────────────────────────────────────────────────────────
 *   routes/career-profile.ts — PUT /portal/career-profile (fire-and-forget
 *   after a successful save; prior values are read in the same request before
 *   the update is applied)
 */
import { db } from "@workspace/db";
import { candidatesTable, communicationEventsTable, tenantsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import { buildJobChangeEmail, tenantBrand, LEXY_BRAND, type Brand } from "./linkedin-profile-monitor.js";

const SELF_REPORT_COOLDOWN_DAYS = 30;

const normalize = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().trim().replace(/\s+/g, " ");

/* ── Fuzzy same-role detection ────────────────────────────────────────────
 * A typo fix, capitalization change, or abbreviation swap ("Sr." → "Senior")
 * is NOT a job change. Sending "congrats on your new role!" over a typo fix
 * erodes trust, so equivalence here is deliberately generous: when in doubt,
 * treat it as the same role and stay quiet. */

/** Common title/company token abbreviations mapped to a canonical form. */
const TOKEN_CANON: Record<string, string> = {
  "sr": "senior", "jr": "junior",
  "eng": "engineer", "engr": "engineer",
  "dev": "developer",
  "mgr": "manager", "mgmt": "management",
  "dir": "director",
  "vp": "vice president", "svp": "senior vice president", "evp": "executive vice president",
  "assoc": "associate", "asst": "assistant",
  "admin": "administrator",
  "tech": "technical", "technologist": "technical",
  "swe": "software engineer", "sde": "software development engineer",
  "pm": "product manager",
  "hr": "human resources",
  "qa": "quality assurance",
  "acct": "account", "exec": "executive",
  "coord": "coordinator",
  "spec": "specialist",
  "intl": "international",
  "&": "and",
};

/** Corporate legal suffixes — dropped ONLY from the trailing position, so
 * "Co-Founder" / "Group Product Manager" keep their meaningful tokens. */
const TRAILING_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "limited",
  "corp", "corporation", "co", "company", "gmbh", "plc",
  "sa", "srl", "bv", "pty", "pvt", "holdings", "group",
]);

/** Canonical comparable form: lowercase, strip punctuation, expand tokens,
 * drop trailing corporate suffixes only. */
function canonical(s: string | null | undefined): string {
  const tokens = normalize(s)
    .replace(/[.,\/\\()\[\]{}'’"“”\-–—_+|:;!?]/g, " ")
    .split(/\s+/)
    .map(tok => (tok in TOKEN_CANON ? TOKEN_CANON[tok] : tok))
    .filter(Boolean);
  while (tokens.length > 1 && TRAILING_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

/** Damerau-Levenshtein edit distance (transposition = 1 edit; small strings only). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, i) => i)];
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(
        rows[i - 1][j] + 1,
        cur[j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, rows[i - 2][j - 2] + 1); // adjacent transposition ("oe" ↔ "eo")
      }
      cur[j] = v;
    }
    rows.push(cur);
  }
  return rows[a.length][b.length];
}

/**
 * Are two values the "same" role/company for re-engagement purposes?
 * True when canonical forms match, one contains the other, or the edit
 * distance is small relative to length (typo territory, ~85% similar).
 */
export function isSameValueFuzzy(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = canonical(a);
  const cb = canonical(b);
  if (ca === cb) return true;
  if (!ca || !cb) return false;
  // "Senior Software Engineer" vs "Software Engineer, Senior" — same token set
  const ta = ca.split(" ").sort().join(" ");
  const tb = cb.split(" ").sort().join(" ");
  if (ta === tb) return true;
  // Acronym territory: short strings (CFO vs CEO, AWS vs GCP) carry meaning
  // in every character — require exact match, no typo budget.
  const minLen = Math.min(ca.length, cb.length);
  if (minLen <= 4) return false;
  // Typo territory: allow ~15% of the longer string, min 1, max 3 edits.
  const maxLen = Math.max(ca.length, cb.length);
  const budget = Math.min(3, Math.max(1, Math.floor(maxLen * 0.15)));
  return editDistance(ca, cb) <= budget;
}

/** Synthetic placeholder addresses minted for no-email candidates — never send. */
function isRealEmail(email: string | null | undefined): boolean {
  if (!email || !email.includes("@")) return false;
  const domain = email.split("@").pop()!.toLowerCase();
  return domain !== "unknown.local" && domain !== "import.local";
}

export interface SelfReportChangeInput {
  candidateId: string;
  /** Stored values BEFORE this save (career profile row, if it existed). */
  prevTitle:   string | null | undefined;
  prevCompany: string | null | undefined;
  /** Values the candidate just submitted (undefined = field not in payload). */
  newTitle:    string | null | undefined;
  newCompany:  string | null | undefined;
}

export interface SelfReportResult {
  changed:   boolean;
  emailSent: boolean;
  reason?:   string;
}

/**
 * Detect a self-reported job change and, when appropriate, send the
 * congratulate/re-engage email. Always syncs the canonical candidates row
 * (currentTitle/currentCompany) when a change is detected, regardless of
 * whether an email goes out.
 */
export async function processSelfReportedJobChange(input: SelfReportChangeInput): Promise<SelfReportResult> {
  const { candidateId } = input;

  /* Load the canonical candidate row — it is both the fallback "prior value"
   * (first-time career-profile saves have no stored prior) and the source of
   * every quiet gate. */
  const [candidate] = await db
    .select({
      id:              candidatesTable.id,
      firstName:       candidatesTable.firstName,
      lastName:        candidatesTable.lastName,
      email:           candidatesTable.email,
      currentTitle:    candidatesTable.currentTitle,
      currentCompany:  candidatesTable.currentCompany,
      pool:            candidatesTable.pool,
      tenantId:        candidatesTable.tenantId,
      doNotContact:    candidatesTable.doNotContact,
      discoveryPaused: (candidatesTable as any).discoveryPaused,
      dataErasedAt:    candidatesTable.dataErasedAt,
    })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId))
    .limit(1);

  if (!candidate) return { changed: false, emailSent: false, reason: "candidate_not_found" };

  /* Prior value: career-profile stored value when present, else the canonical
   * candidates row (covers first-time profile creation). */
  const priorTitle   = input.prevTitle   !== undefined && input.prevTitle   !== null ? input.prevTitle   : candidate.currentTitle;
  const priorCompany = input.prevCompany !== undefined && input.prevCompany !== null ? input.prevCompany : candidate.currentCompany;

  /* A change requires a NEW non-empty value that differs MEANINGFULLY from
   * the prior one. Clearing a field is not a "new role", and neither is a
   * typo fix, capitalization change, or abbreviation swap ("Sr." → "Senior")
   * — the fuzzy check treats those as the same role, so no congrats email
   * fires over a cosmetic edit. */
  const titleChanged   = input.newTitle   !== undefined && normalize(input.newTitle)   !== "" && !isSameValueFuzzy(input.newTitle, priorTitle);
  const companyChanged = input.newCompany !== undefined && normalize(input.newCompany) !== "" && !isSameValueFuzzy(input.newCompany, priorCompany);

  /* Cosmetic-only edit (fuzzy-same but textually different): keep the
   * candidate's exact spelling in sync, but it's not a job change. */
  if (!titleChanged && !companyChanged) {
    const cosmetic: Record<string, any> = {};
    if (input.newTitle   !== undefined && normalize(input.newTitle)   !== "" && normalize(input.newTitle)   !== normalize(candidate.currentTitle))   cosmetic.currentTitle   = input.newTitle;
    if (input.newCompany !== undefined && normalize(input.newCompany) !== "" && normalize(input.newCompany) !== normalize(candidate.currentCompany)) cosmetic.currentCompany = input.newCompany;
    if (Object.keys(cosmetic).length > 0) {
      cosmetic.updatedAt = new Date();
      await db.update(candidatesTable).set(cosmetic).where(eq(candidatesTable.id, candidateId));
    }
    return { changed: false, emailSent: false, reason: "no_change" };
  }

  /* Sync the canonical candidates row so every downstream surface (search,
   * staleness, hide-from-employer domain matching context) sees the update. */
  const sync: Record<string, any> = { updatedAt: new Date() };
  if (titleChanged)   sync.currentTitle   = input.newTitle;
  if (companyChanged) sync.currentCompany = input.newCompany;
  await db.update(candidatesTable).set(sync).where(eq(candidatesTable.id, candidateId));

  /* ── Quiet gates — email suppressed, sync already done ─────────────────── */
  if (candidate.dataErasedAt)          return { changed: true, emailSent: false, reason: "erased" };
  if (candidate.doNotContact)          return { changed: true, emailSent: false, reason: "do_not_contact" };
  if (candidate.discoveryPaused)       return { changed: true, emailSent: false, reason: "discovery_paused" };
  if (!isRealEmail(candidate.email))   return { changed: true, emailSent: false, reason: "no_real_email" };

  /* Cooldown: at most one re-engagement email per 30 days (shares the
   * follow_up communication_events type with the LinkedIn monitor, so the two
   * paths can never double-email the same person). */
  const [recent] = await db
    .select({ maxSentAt: sql<string>`MAX(${communicationEventsTable.sentAt})` })
    .from(communicationEventsTable)
    .where(
      and(
        eq(communicationEventsTable.candidateId, candidateId),
        eq(communicationEventsTable.type, "follow_up"),
      ),
    );
  if (recent?.maxSentAt) {
    const days = (Date.now() - new Date(recent.maxSentAt).getTime()) / 86_400_000;
    if (days < SELF_REPORT_COOLDOWN_DAYS) {
      return { changed: true, emailSent: false, reason: "cooldown" };
    }
  }

  /* Branding: platform pool → Lexy; tenant pool → the owning tenant's brand,
   * NEVER Lexy as a fallback (skip instead of mis-branding). */
  let brand: Brand | null = null;
  if (candidate.pool === "platform" || candidate.tenantId === "platform") {
    brand = LEXY_BRAND;
  } else if (candidate.tenantId) {
    const [t] = await db
      .select({ name: tenantsTable.name, primaryColor: tenantsTable.primaryColor })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, candidate.tenantId))
      .limit(1);
    if (t) brand = tenantBrand(t.name, t.primaryColor);
  }
  if (!brand) {
    logger.warn({ candidateId, tenantId: candidate.tenantId }, "[self-report] No tenant branding resolved — skipping email to avoid Lexy mis-branding");
    return { changed: true, emailSent: false, reason: "no_brand" };
  }

  const firstName = candidate.firstName ?? "there";
  const fullName  = `${firstName} ${candidate.lastName ?? ""}`.trim();
  const newTitle   = titleChanged   ? (input.newTitle   ?? null) : (priorTitle   ?? null);
  const newCompany = companyChanged ? (input.newCompany ?? null) : (priorCompany ?? null);

  const email = buildJobChangeEmail(firstName, newTitle, newCompany, brand);

  const sendResult = await sendEmail({
    to:      candidate.email!,
    subject: email.subject,
    html:    email.html,
    audit: {
      tenantId:     candidate.tenantId,
      actorLabel:   "Self-Report Re-engagement",
      subjectType:  "candidate",
      subjectId:    candidateId,
      subjectLabel: fullName,
      action:       "self_report.job_change",
      metadata:     { source: "candidate_self_report", newTitle, newCompany },
    },
  });

  if (!sendResult.ok) {
    logger.warn({ candidateId, error: sendResult.error }, "[self-report] Congratulations email send failed");
    return { changed: true, emailSent: false, reason: "send_failed" };
  }

  await db.insert(communicationEventsTable).values({
    tenantId:    candidate.tenantId,
    candidateId,
    type:        "follow_up",
    channel:     "email",
    status:      "sent",
    subject:     email.subject,
    body:        `Self-reported job change (${newTitle ?? "?"}${newCompany ? ` @ ${newCompany}` : ""})`,
    sentAt:      new Date(),
  } as any);

  logger.info({ candidateId, newTitle, newCompany }, "[self-report] Job-change congratulations sent");
  return { changed: true, emailSent: true };
}
