/**
 * schema/discovery-consent.ts — Platform-Pool Discovery Opt-In Consent
 *
 * ─── Why this table exists ───────────────────────────────────────────────────
 * Ruling (July 2026): portal access and platform-pool discovery are DECOUPLED.
 * No intake path (apply-to-job, recruiter-invite, self-register) may auto-
 * promote a candidate into the shared platform pool. Entry into the platform
 * pool — i.e. becoming discoverable/recruitable by every licensed tenant —
 * requires an explicit, affirmative candidate opt-in, captured with the exact
 * disclosure language shown at the time.
 *
 * This table is the canonical, append-only audit record of that opt-in:
 *   (a) which candidate,
 *   (b) which consent_version / disclosure snapshot they were shown,
 *   (c) when they consented, and
 *   (d) when (if ever) they withdrew.
 *
 * The ONLY code allowed to write candidates.pool = 'platform' is the
 * chokepoint lib (api-server lib/discovery-consent.ts), which inserts a row
 * here in the same transaction. CI guard check-platform-pool-write.mjs
 * enforces the chokepoint.
 *
 * ─── Withdrawal ──────────────────────────────────────────────────────────────
 * `revokedAt` marks withdrawal; the row is kept for the audit trail and the
 * candidate's pool is restored to `previousPool` (captured at grant time) so
 * an applied/invited candidate returns to tenant scope and a self-registered
 * candidate returns to the hidden pending_profile stage.
 */
import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { isNull } from "drizzle-orm";

export const candidateDiscoveryConsentTable = pgTable(
  "candidate_discovery_consent",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    candidateId: text("candidate_id").notNull(),
    /* Version string of the discovery disclosure copy. Bump in code whenever
     * the language materially changes; old rows stay valid for their version. */
    consentVersion: text("consent_version").notNull(),
    /* Snapshot of the exact disclosure shown at consent time. */
    disclosureSnapshot: jsonb("disclosure_snapshot").notNull(),
    /* Pool the candidate was in immediately before promotion — restored on
     * withdrawal ("tenant" for applied/invited, "pending_profile" for
     * self-registered mid-onboarding). */
    previousPool: text("previous_pool").notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /* UA / IP / surface (onboarding vs settings) captured at grant time. */
    captureContext: jsonb("capture_context"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("candidate_discovery_consent_candidate_idx").on(t.candidateId, t.consentedAt),
    /* One ACTIVE (un-revoked) consent per candidate+version — makes the
     * grant chokepoint race-safe: concurrent double-POSTs collapse into
     * one row (23505 handled in lib/discovery-consent.ts). */
    uniqueIndex("candidate_discovery_consent_active_uniq")
      .on(t.candidateId, t.consentVersion)
      .where(isNull(t.revokedAt)),
  ],
);
