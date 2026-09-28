import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export type CandidateLearningPath = "voice" | "chat_email";
export type CandidateLearningEnrollmentStatus = "in_progress" | "completed";
export type CandidateLearningLessonStatus = "draft" | "completed";
export type CandidateLearningAnswers = Record<string, string>;
export type CandidateLearningFeedback = Array<{
  exerciseId: string;
  message: string;
  correct: boolean | null;
  modelAnswer: string | null;
}>;

export const candidateLearningEnrollmentsTable = pgTable("candidate_learning_enrollments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  courseId: text("course_id").notNull(),
  courseVersion: integer("course_version").notNull(),
  path: text("path").$type<CandidateLearningPath>().notNull(),
  status: text("status").$type<CandidateLearningEnrollmentStatus>().notNull().default("in_progress"),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("candidate_learning_enrollments_candidate_course_uidx")
    .on(table.candidateId, table.courseId),
  uniqueIndex("candidate_learning_enrollments_id_tenant_uidx")
    .on(table.id, table.tenantId),
]);

export const candidateLearningLessonProgressTable = pgTable("candidate_learning_lesson_progress", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  enrollmentId: text("enrollment_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  lessonId: text("lesson_id").notNull(),
  courseVersion: integer("course_version").notNull(),
  revision: integer("revision").notNull().default(0),
  status: text("status").$type<CandidateLearningLessonStatus>().notNull().default("draft"),
  answers: jsonb("answers").$type<CandidateLearningAnswers>().notNull().default({}),
  feedback: jsonb("feedback").$type<CandidateLearningFeedback>().notNull().default([]),
  attempts: integer("attempts").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("candidate_learning_lesson_progress_enrollment_lesson_uidx")
    .on(table.enrollmentId, table.lessonId),
]);

export type CandidateLearningEnrollment = typeof candidateLearningEnrollmentsTable.$inferSelect;
export type CandidateLearningLessonProgressRow = typeof candidateLearningLessonProgressTable.$inferSelect;