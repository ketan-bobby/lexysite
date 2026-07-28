/**
 * schema/prep.ts — Interview Preparation Session Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   prep_sessions   — One prep session per candidate per interview. Stores the
 *                     preparation mode (quick / deep / roleplay), status, AI-
 *                     generated question bank, practice answers, and a progress score.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   prep_mode           — quick · deep · roleplay
 *   prep_session_status — active · completed
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/prep.ts   — prep plan generation and session management API
 */
import { pgTable, text, timestamp, integer, real, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const prepModeEnum = pgEnum("prep_mode", [
  "quick",
  "full",
  "mock_interview",
  "behavioral",
  "technical",
  "competency",
  "product_sense",
  "domain_deep_dive",
]);

export const prepSessionStatusEnum = pgEnum("prep_session_status", ["active", "completed"]);

export const prepSessionsTable = pgTable("prep_sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id").notNull(),
  mode: prepModeEnum("mode").notNull().default("quick"),
  status: prepSessionStatusEnum("status").notNull().default("active"),
  questionsAnswered: integer("questions_answered").notNull().default(0),
  totalQuestions: integer("total_questions").notNull().default(5),
  questions: jsonb("questions").notNull().default([]),
  answers: jsonb("answers").notNull().default([]),
  readinessScore: real("readiness_score"),
  /* Per-dimension rubric: { clarity, depth, structure, signal } each 0-100 */
  rubricScores: jsonb("rubric_scores"),
  /* Up to 3 verbatim quote snippets pulled from the candidate's strongest answers. */
  verbatimQuotes: jsonb("verbatim_quotes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const prepPlansTable = pgTable("prep_plans", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id").notNull(),
  mode: prepModeEnum("mode").notNull().default("quick"),
  likelyQuestions: text("likely_questions").array().notNull().default([]),
  keySkillsToFocus: text("key_skills_to_focus").array().notNull().default([]),
  preparationTips: text("preparation_tips").array().notNull().default([]),
  estimatedPrepTimeMinutes: integer("estimated_prep_time_minutes").notNull().default(30),
  readinessScore: real("readiness_score"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertPrepSessionSchema = createInsertSchema(prepSessionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertPrepSession = z.infer<typeof insertPrepSessionSchema>;
export type PrepSession = typeof prepSessionsTable.$inferSelect;
