/**
 * schema/recruiter_digest.ts — Recruiter Daily Digest Queue Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   recruiter_digest_queue   — Pending digest items for each recruiter. Other
 *                              parts of the system (e.g. screening agent) INSERT
 *                              rows here; the recruiter-digest-scheduler drains
 *                              them once per calendar day and sends one summary
 *                              email. Rows are stamped sentAt after delivery —
 *                              they are never deleted so historical digests are
 *                              auditable.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/recruiter-digest-scheduler.ts   — drains and sends digest
 *   routes/digests.ts                   — inspector and manual trigger API
 */
import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * recruiter_digest_queue — pending notification items waiting to be rolled
 * up into a daily digest email.
 *
 * Items are inserted by automated agent runs (orchestrator/scheduler) and
 * drained by `recruiter-digest-scheduler` once per day at the recruiter's
 * local 08:00. Items triggered by an explicit user action skip the queue
 * and send a real-time email instead.
 */
export const recruiterDigestQueueTable = pgTable(
  "recruiter_digest_queue",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    recruiterId: text("recruiter_id").notNull(),
    jobId: text("job_id"),

    // Slug describing the kind of event being queued.
    //   "screening.batch", "sourcing.batch", "verification.batch", …
    eventType: text("event_type").notNull(),

    // Free-form JSON payload describing the event (counts, candidate names,
    // recommendations, etc). The digest builder reads this to compose the
    // summary section for this row.
    payload: jsonb("payload").notNull(),

    // Set to the digest's send timestamp once the row has been included in
    // a delivered digest. NULL = pending.
    sentAt: timestamp("sent_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pendingIdx: index("digest_queue_pending_idx").on(t.recruiterId, t.sentAt),
    tenantIdx: index("digest_queue_tenant_idx").on(t.tenantId, t.createdAt),
  }),
);

export type RecruiterDigestQueueItem = typeof recruiterDigestQueueTable.$inferSelect;
export type InsertRecruiterDigestQueueItem = typeof recruiterDigestQueueTable.$inferInsert;
