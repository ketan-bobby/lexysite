/**
 * schema/candidate-ai-consent.ts — Candidate AI-Interview Consent
 *
 * ─── Why this table exists ───────────────────────────────────────────────────
 * The Illinois Artificial Intelligence Video Interview Act (820 ILCS 42)
 * requires that, before an AI is used to evaluate a candidate by video,
 * the employer must:
 *   (1) notify the applicant that AI may be used,
 *   (2) explain how the AI works and what general types of characteristics
 *       it uses to evaluate the applicant, and
 *   (3) obtain the applicant's consent.
 * The candidate may also request deletion of their video within 30 days
 * (see `deletion-requests.ts`).
 *
 * This table is the canonical record that (a) the candidate was shown a
 * specific consent_version, (b) the disclosed traits at that time, and
 * (c) the candidate affirmatively consented. The interview /begin
 * endpoint refuses to mint a session if no active consent row exists for
 * the current consentVersion.
 *
 * The same record is reused for jurisdictions outside Illinois — the
 * disclosure copy is the strictest of (IL AIVI, NYC LL144 candidate
 * notice, EU AI Act Article 26(11) deployer information), so consenting
 * once satisfies all three.
 *
 * ─── Withdrawal ──────────────────────────────────────────────────────────────
 * `revokedAt` records when the candidate withdrew consent. A non-null
 * revokedAt means the row is no longer "active" for /begin purposes; the
 * candidate must re-consent (which inserts a new row, leaving the old one
 * for the audit trail).
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/career-profile.ts  — /portal/candidate/ai-consent endpoints
 *   routes/interviews.ts      — /interviews/:id/begin consent gate
 */
import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const candidateAiConsentTable = pgTable(
  "candidate_ai_consent",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    candidateId: text("candidate_id").notNull(),
    /* Version string of the disclosure copy the candidate consented under.
     * Bump this string in code whenever the consent text materially
     * changes (e.g. add a new evaluated trait). Old rows remain valid for
     * the version they were captured under; new versions require fresh
     * consent. */
    consentVersion: text("consent_version").notNull(),
    /* Snapshot of the evaluated-traits list shown to the candidate at
     * consent time. We store the snapshot (not just the version pointer)
     * so that an auditor can reconstruct the exact disclosure even if the
     * canonical copy is later edited.  Shape: { traits: string[],
     * dataSources: string[], decisionMaker: 'human-in-the-loop' | ... } */
    disclosureSnapshot: jsonb("disclosure_snapshot").notNull(),
    consentedAt: timestamp("consented_at").notNull().defaultNow(),
    /* Set when the candidate explicitly withdraws.  Once revokedAt is
     * set, the row no longer satisfies the /begin gate. */
    revokedAt: timestamp("revoked_at"),
    /* User-agent / IP captured at consent time. Useful for an auditor
     * reconstructing the candidate environment.  Stored as opaque jsonb
     * to keep PII handling tight and reversible. */
    captureContext: jsonb("capture_context"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    candidateIdx: index("candidate_ai_consent_candidate_idx").on(t.candidateId, t.consentedAt),
  }),
);

export type CandidateAiConsent = typeof candidateAiConsentTable.$inferSelect;
export type InsertCandidateAiConsent = typeof candidateAiConsentTable.$inferInsert;
