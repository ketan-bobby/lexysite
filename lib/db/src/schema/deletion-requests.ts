/**
 * schema/deletion-requests.ts — Right-to-Erasure Request Queue
 *
 * ─── Why this table exists ───────────────────────────────────────────────────
 * Multiple regulations grant candidates a right to request deletion of
 * their data:
 *   • IL AIVI Act     — 30-day window for video interview content
 *   • GDPR Article 17 — right to erasure for EU candidates
 *   • CCPA / CPRA     — right to delete for California residents
 *   • UK GDPR         — equivalent right
 *
 * Rather than have a candidate-fronted hard-delete button (which is
 * destructive, irreversible, and can be abused via a compromised session),
 * we queue every request here. A platform_admin reviews the queue and
 * fulfils via the admin tool, which performs the cascade delete and
 * writes a row to audit_logs with action 'candidate.deletion_fulfilled'.
 *
 * ─── Status state machine ────────────────────────────────────────────────────
 *   pending     — candidate submitted; awaiting review
 *   in_progress — admin claimed and is working on it
 *   fulfilled   — data has been deleted; audit trail written
 *   denied      — request rejected (e.g. legal hold, fraud suspected)
 *   withdrawn   — candidate withdrew the request before fulfilment
 *
 * ─── What gets deleted vs. retained ──────────────────────────────────────────
 * Defined in docs/RUNBOOK_DATA_DELETION.md. In short: candidate PII,
 * resume, interview transcripts, demographics, AI consent rows.
 * Retained: audit_logs rows referencing the candidate (legal-hold
 * requirement; we tombstone the subject_label to "deleted-candidate" to
 * remove direct PII while keeping the immutable trail).
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/career-profile.ts  — /portal/candidate/deletion-request (submit)
 *   routes/admin-deletion.ts  — /admin/deletion-requests (list, fulfil)
 */
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const deletionRequestsTable = pgTable(
  "deletion_requests",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    candidateId: text("candidate_id").notNull(),
    /* Snapshot of candidate email at request time.  We keep this even
     * after the candidate row is deleted so the admin can confirm the
     * fulfilment notification went to the right address. */
    candidateEmailSnapshot: text("candidate_email_snapshot"),
    /* Free-form reason the candidate gave (optional). */
    reason: text("reason"),
    /* Which regulation the candidate is invoking.  Drives the SLA: AIVI
     * is 30 days, GDPR is 30 days (extendable to 90), CCPA is 45 days. */
    jurisdiction: text("jurisdiction").notNull(), // 'il_aivi' | 'gdpr' | 'ccpa' | 'other'
    /* 'pending' | 'in_progress' | 'fulfilled' | 'denied' | 'withdrawn' */
    status: text("status").notNull().default("pending"),
    /* platform_admin who claimed / fulfilled. */
    handledByUserId: text("handled_by_user_id"),
    handledAt: timestamp("handled_at"),
    /* Free-form note from the admin (e.g. "fulfilled — cascade verified",
     * or "denied — open lawsuit, legal hold from counsel"). */
    handlerNotes: text("handler_notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("deletion_requests_status_idx").on(t.status, t.createdAt),
    candidateIdx: index("deletion_requests_candidate_idx").on(t.candidateId),
  }),
);

export type DeletionRequest = typeof deletionRequestsTable.$inferSelect;
export type InsertDeletionRequest = typeof deletionRequestsTable.$inferInsert;
