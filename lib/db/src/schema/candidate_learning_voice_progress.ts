import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export type CandidateLearningVoiceCycleState =
  | "baseline_draft"
  | "training"
  | "progress_draft"
  | "completed";
export type CandidateLearningVoicePhase = "baseline" | "progress";
export type CandidateLearningVoiceTurnStatus = "draft" | "submitted";
export type CandidateLearningVoiceSnapshot = Record<string, unknown>;

export const candidateLearningVoiceCyclesTable = pgTable("candidate_learning_voice_cycles", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  courseId: text("course_id").notNull(),
  courseVersion: integer("course_version").notNull(),
  comparisonFamilyVersion: text("comparison_family_version").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  evaluatorVersion: text("evaluator_version").notNull(),
  state: text("state").$type<CandidateLearningVoiceCycleState>().notNull().default("baseline_draft"),
  baselineSnapshot: jsonb("baseline_snapshot").$type<CandidateLearningVoiceSnapshot | null>(),
  progressSnapshot: jsonb("progress_snapshot").$type<CandidateLearningVoiceSnapshot | null>(),
  comparisonSnapshot: jsonb("comparison_snapshot").$type<CandidateLearningVoiceSnapshot | null>(),
  baselineCompletedAt: timestamp("baseline_completed_at", { withTimezone: true }),
  progressStartedAt: timestamp("progress_started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  trainingCompletedAt: timestamp("training_completed_at", { withTimezone: true }),
  trainingEvidence: text("training_evidence").$type<"enrollment_completion" | "candidate_confirmed_review" | "tracked_review_attempt" | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("candidate_learning_voice_cycles_id_tenant_uidx").on(table.id, table.tenantId),
  uniqueIndex("candidate_learning_voice_cycles_id_candidate_tenant_uidx").on(table.id, table.candidateId, table.tenantId),
  uniqueIndex("candidate_learning_voice_cycles_candidate_course_active_uidx")
    .on(table.candidateId, table.courseId)
    .where(sql`state <> 'completed'`),
]);

export const candidateLearningVoiceTurnsTable = pgTable("candidate_learning_voice_turns", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  cycleId: text("cycle_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  phase: text("phase").$type<CandidateLearningVoicePhase>().notNull(),
  form: text("form").notNull(),
  taskKey: text("task_key").notNull(),
  revision: integer("revision").notNull().default(0),
  status: text("status").$type<CandidateLearningVoiceTurnStatus>().notNull().default("draft"),
  response: text("response").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("candidate_learning_voice_turns_cycle_phase_task_uidx")
    .on(table.cycleId, table.phase, table.taskKey),
]);

export type CandidateLearningVoiceCycle = typeof candidateLearningVoiceCyclesTable.$inferSelect;
export type CandidateLearningVoiceTurn = typeof candidateLearningVoiceTurnsTable.$inferSelect;