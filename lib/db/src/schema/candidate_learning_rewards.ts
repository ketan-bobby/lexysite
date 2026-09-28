import { integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const candidateLearningCourseReviewAttemptsTable = pgTable("candidate_learning_course_review_attempts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  cycleId: text("cycle_id").notNull(),
  courseId: text("course_id").notNull(),
  courseVersion: integer("course_version").notNull(),
  status: text("status").$type<"in_progress" | "completed">().notNull().default("in_progress"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("candidate_learning_course_review_attempts_cycle_uidx").on(table.cycleId)]);

export const candidateLearningCourseReviewLessonsTable = pgTable("candidate_learning_course_review_lessons", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  attemptId: text("attempt_id").notNull(),
  lessonId: text("lesson_id").notNull(),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("candidate_learning_course_review_lessons_attempt_lesson_uidx").on(table.attemptId, table.lessonId)]);

export const candidateLearningRewardLedgerTable = pgTable("candidate_learning_reward_ledger", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  eventKey: text("event_key").notNull(),
  eventType: text("event_type").notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  badgeKey: text("badge_key"),
  creditsDelta: integer("credits_delta").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  earnedAt: timestamp("earned_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("candidate_learning_reward_ledger_event_key_uidx").on(table.eventKey)]);

export type CandidateLearningCourseReviewAttempt = typeof candidateLearningCourseReviewAttemptsTable.$inferSelect;
export type CandidateLearningCourseReviewLesson = typeof candidateLearningCourseReviewLessonsTable.$inferSelect;
export type CandidateLearningRewardLedger = typeof candidateLearningRewardLedgerTable.$inferSelect;