/**
 * schema/external_clicks.ts — Candidate External Job Click Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_external_clicks   — Records when a candidate clicks through to an
 *                                 external job board link from a Lexy email or
 *                                 portal. Used by external-click-engine.ts to
 *                                 trigger follow-up sequences when the candidate
 *                                 doesn't return within a configured window.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/external-click-engine.ts     — reads/writes click and follow-up data
 *   lib/external-click-scheduler.ts  — triggers follow-up check
 */
import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const candidateExternalClicksTable = pgTable("candidate_external_clicks", {
  id:               text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId:      text("candidate_id").notNull(),
  jobId:            text("job_id"),
  jobTitle:         text("job_title"),
  company:          text("company"),
  sourceUrl:        text("source_url"),
  sourceDomain:     text("source_domain"),
  isExternal:       boolean("is_external").notNull().default(false),
  followUpSentAt:   timestamp("follow_up_sent_at"),
  followUpResponse: text("follow_up_response"),
  createdAt:        timestamp("created_at").notNull().defaultNow(),
});
