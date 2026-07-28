/**
 * schema/ai-messages.ts — AI Message Generation, Feedback & Examples
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   ai_message_generations  — Every AI-generated draft for the NEW message types
 *                            (follow_up, interview_invite, rejection, nurture,
 *                            hm_summary, submission_summary, talking_points,
 *                            client_update). First-touch cold `outreach` stays in
 *                            `outreach_messages` (already has its approval gate);
 *                            the recruiter approval queue aggregates both.
 *   ai_message_feedback     — Learning-loop action log (generated/edited/approved/
 *                            rejected/sent) used to improve future generations.
 *   approved_message_examples — Tenant-specific few-shot examples saved by
 *                            recruiters ("Save as example") and pulled (bounded)
 *                            into future prompts of the same message type.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   ai_message_type   — outreach · follow_up · interview_invite · rejection ·
 *                       nurture · hm_summary · submission_summary ·
 *                       talking_points · client_update
 *   ai_message_status — generated · edited · approved · rejected · sent
 *
 * `sourceContext` records which context layers were injected so the UI can show
 * "why this message was generated" for trust/governance.
 */
import { pgTable, text, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { aiToneEnum } from "./ai-brand";

export const aiMessageTypeEnum = pgEnum("ai_message_type", [
  "outreach",
  "follow_up",
  "interview_invite",
  "rejection",
  "nurture",
  "hm_summary",
  "submission_summary",
  "talking_points",
  "client_update",
]);

export const aiMessageStatusEnum = pgEnum("ai_message_status", [
  "generated",
  "edited",
  "approved",
  "rejected",
  "sent",
]);

export const aiMessageGenerationsTable = pgTable("ai_message_generations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  /** Optional links — depends on message type. */
  jobId: text("job_id"),
  candidateId: text("candidate_id"),
  messageType: aiMessageTypeEnum("message_type").notNull(),
  tone: aiToneEnum("tone"),
  subject: text("subject"),
  body: text("body").notNull(),
  status: aiMessageStatusEnum("status").notNull().default("generated"),
  /**
   * Full context snapshot used for this generation — which layers were present
   * AND the actual bounded briefs/facts fed to the model, so a draft can be
   * audited later ("why was this generated this way").
   */
  sourceContext: jsonb("source_context"),
  /** Human-readable summary of the context used, shown in the UI. */
  contextSummary: text("context_summary"),
  model: text("model"),
  /**
   * Version of the AI Context Engine prompt template that produced this draft.
   * Stored for auditability so outputs can be traced to the exact prompt logic.
   */
  promptVersion: text("prompt_version"),
  createdById: text("created_by_id"),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  rejectedReason: text("rejected_reason"),
  rejectedAt: timestamp("rejected_at"),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const aiMessageFeedbackTable = pgTable("ai_message_feedback", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  generationId: text("generation_id").notNull(),
  /** One of: generated · edited · approved · rejected · sent. */
  action: aiMessageStatusEnum("action").notNull(),
  userId: text("user_id"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const approvedMessageExamplesTable = pgTable("approved_message_examples", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  messageType: aiMessageTypeEnum("message_type").notNull(),
  tone: aiToneEnum("tone"),
  subject: text("subject"),
  body: text("body").notNull(),
  tags: jsonb("tags"),
  sourceGenerationId: text("source_generation_id"),
  createdById: text("created_by_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAiMessageGenerationSchema = createInsertSchema(aiMessageGenerationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const selectAiMessageGenerationSchema = createSelectSchema(aiMessageGenerationsTable);
export type InsertAiMessageGeneration = z.infer<typeof insertAiMessageGenerationSchema>;
export type AiMessageGeneration = typeof aiMessageGenerationsTable.$inferSelect;

export const insertAiMessageFeedbackSchema = createInsertSchema(aiMessageFeedbackTable).omit({
  id: true,
  createdAt: true,
});
export const selectAiMessageFeedbackSchema = createSelectSchema(aiMessageFeedbackTable);
export type InsertAiMessageFeedback = z.infer<typeof insertAiMessageFeedbackSchema>;
export type AiMessageFeedback = typeof aiMessageFeedbackTable.$inferSelect;

export const insertApprovedMessageExampleSchema = createInsertSchema(approvedMessageExamplesTable).omit({
  id: true,
  createdAt: true,
});
export const selectApprovedMessageExampleSchema = createSelectSchema(approvedMessageExamplesTable);
export type InsertApprovedMessageExample = z.infer<typeof insertApprovedMessageExampleSchema>;
export type ApprovedMessageExample = typeof approvedMessageExamplesTable.$inferSelect;
