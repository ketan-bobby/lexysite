/**
 * schema/candidate_rejections.ts — Candidate Rejection Record Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_rejections   — Logs every formal rejection event: who rejected,
 *                            the reason code, whether a rejection email was sent,
 *                            and the AI-generated email body for audit purposes.
 *                            One row per rejection; a candidate can have multiple
 *                            rows if rejected from several jobs.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/record-rejection.ts          — writes rejection rows
 *   lib/candidate-rejection-email.ts — generates and sends the email
 *   routes/applications.ts           — stage-change reject action
 */
import { pgTable, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const candidateRejectionsTable = pgTable("candidate_rejections", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id"),
  sourcedId: text("sourced_id"),
  applicationId: text("application_id"),
  jobId: text("job_id"),
  rejectedByUserId: text("rejected_by_user_id"),
  rejectedByRole: text("rejected_by_role"),
  reason: text("reason"),
  notes: text("notes"),
  fromStage: text("from_stage"),
  language: text("language"),
  emailSent: boolean("email_sent").notNull().default(false),
  emailError: text("email_error"),
  candidateEmail: text("candidate_email"),
  candidateName: text("candidate_name"),
  jobTitle: text("job_title"),
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCandidateRejectionSchema = createInsertSchema(candidateRejectionsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertCandidateRejection = z.infer<typeof insertCandidateRejectionSchema>;
export type CandidateRejection = typeof candidateRejectionsTable.$inferSelect;
