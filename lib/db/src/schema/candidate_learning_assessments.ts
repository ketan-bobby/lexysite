import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export type CandidateLearningAssessmentStatus = "draft" | "completed";
export type CandidateLearningAssessmentTaskStatus = "not_started" | "draft" | "submitted";
export type CandidateLearningAssessmentReport = Record<string, unknown>;

export const candidateLearningAssessmentsTable = pgTable("candidate_learning_assessments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  courseId: text("course_id").notNull(),
  courseVersion: integer("course_version").notNull(),
  path: text("path").notNull(),
  taskSetVersion: integer("task_set_version").notNull(),
  rubricVersion: text("rubric_version").notNull(),
  status: text("status").$type<CandidateLearningAssessmentStatus>().notNull().default("draft"),
  reportSnapshot: jsonb("report_snapshot").$type<CandidateLearningAssessmentReport | null>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("candidate_learning_assessments_id_tenant_uidx").on(table.id, table.tenantId),
  uniqueIndex("candidate_learning_assessments_id_candidate_tenant_uidx").on(table.id, table.candidateId, table.tenantId),
]);

export const candidateLearningAssessmentTasksTable = pgTable("candidate_learning_assessment_tasks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  assessmentId: text("assessment_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  taskKey: text("task_key").notNull(),
  revision: integer("revision").notNull().default(0),
  status: text("status").$type<CandidateLearningAssessmentTaskStatus>().notNull().default("not_started"),
  response: text("response").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("candidate_learning_assessment_tasks_assessment_task_uidx").on(table.assessmentId, table.taskKey),
]);

export type CandidateLearningAssessment = typeof candidateLearningAssessmentsTable.$inferSelect;
export type CandidateLearningAssessmentTask = typeof candidateLearningAssessmentTasksTable.$inferSelect;