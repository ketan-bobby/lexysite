/**
 * schema/outreach-engine.ts — Outreach Campaign Sequence & Execution Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   outreach_enrollments       — One row per candidate+campaign enrolment. Tracks
 *                                current step, A/B variant, and lifecycle status.
 *   outreach_sequence_steps    — Step definitions for a campaign (e.g. Day 0, 3, 7, 14):
 *                                delay, subject template, and A/B prompt variants.
 *   outreach_step_messages     — One row per generated/sent email. Stores the final
 *                                subject + body, send status, and open/reply timestamps.
 *   outreach_replies           — Inbound replies from candidates, with classification
 *                                label (interested / question / unsubscribe / etc.).
 *   outreach_autopilot_runs    — Run log for each autopilot scheduler tick: how many
 *                                messages were generated and sent.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/outreach-engine.ts     — reads/writes all five tables
 *   routes/outreach.ts         — campaign management API
 */
import { pgTable, text, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

export const outreachEnrollmentsTable = pgTable("outreach_enrollments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  campaignId: text("campaign_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id").notNull(),
  tenantId: text("tenant_id").notNull().default("acme"),
  recipientEmail: text("recipient_email").notNull().default(""),
  recipientName: text("recipient_name"),
  recipientData: jsonb("recipient_data").notNull().default({}),
  status: text("status").notNull().default("enrolled"),
  currentStep: integer("current_step").notNull().default(0),
  totalStepsSent: integer("total_steps_sent").notNull().default(0),
  abVariant: text("ab_variant"),
  enrolledAt: timestamp("enrolled_at").notNull().defaultNow(),
  lastSentAt: timestamp("last_sent_at"),
  repliedAt: timestamp("replied_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const outreachSequenceStepsTable = pgTable("outreach_sequence_steps", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  campaignId: text("campaign_id").notNull(),
  stepNumber: integer("step_number").notNull(),
  type: text("type").notNull().default("email"),
  subjectTemplate: text("subject_template"),
  bodyTemplate: text("body_template"),
  delayDays: integer("delay_days").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const outreachStepMessagesTable = pgTable("outreach_step_messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  campaignId: text("campaign_id").notNull(),
  enrollmentId: text("enrollment_id").notNull(),
  stepNumber: integer("step_number").notNull(),
  toEmail: text("to_email").notNull(),
  subject: text("subject"),
  body: text("body"),
  status: text("status").notNull().default("draft"),
  abVariant: text("ab_variant"),
  scheduledFor: timestamp("scheduled_for"),
  sentAt: timestamp("sent_at"),
  failedReason: text("failed_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const outreachRepliesTable = pgTable("outreach_replies", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  campaignId: text("campaign_id").notNull(),
  enrollmentId: text("enrollment_id").notNull(),
  messageId: text("message_id"),
  body: text("body").notNull(),
  sentiment: text("sentiment"),
  classification: text("classification"),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
});

export const outreachAutopilotRunsTable = pgTable("outreach_autopilot_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  campaignId: text("campaign_id").notNull(),
  enrolled: integer("enrolled").default(0),
  messagesGenerated: integer("messages_generated").default(0),
  messagesSent: integer("messages_sent").default(0),
  messagesFailed: integer("messages_failed").default(0),
  ranAt: timestamp("ran_at").notNull().defaultNow(),
});

export type OutreachEnrollment = typeof outreachEnrollmentsTable.$inferSelect;
export type OutreachSequenceStep = typeof outreachSequenceStepsTable.$inferSelect;
export type OutreachStepMessage = typeof outreachStepMessagesTable.$inferSelect;
export type OutreachReply = typeof outreachRepliesTable.$inferSelect;
