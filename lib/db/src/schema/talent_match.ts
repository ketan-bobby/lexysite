/**
 * schema/talent_match.ts — Talent Match Score & Resume Screen Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   talent_matches    — AI talent-match score (0–100) for a candidate+job pair.
 *                       Computed by the screening agent against the ICP and JD.
 *                       Stores the skill gap list, strength areas, and a brief
 *                       rationale for recruiter transparency.
 *   resume_screens    — Per-resume screening result: pass / hold / reject
 *                       verdict, score, and AI-generated summary for the recruiter
 *                       digest.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/talent-match.ts         — score retrieval API
 *   lib/agents/orchestrator.ts     — screening agent writes both tables
 */
import { pgTable, text, timestamp, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const talentMatchesTable = pgTable("talent_matches", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id").notNull(),
  fitScore: real("fit_score").notNull(),
  matchExplanation: text("match_explanation").notNull(),
  strengths: text("strengths").array().notNull().default([]),
  gaps: text("gaps").array().notNull().default([]),
  recommendation: text("recommendation").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const resumeScreensTable = pgTable("resume_screens", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id"),
  screeningScore: real("screening_score").notNull(),
  extractedSkills: text("extracted_skills").array().notNull().default([]),
  missingSkills: text("missing_skills").array().notNull().default([]),
  adjacentSkills: text("adjacent_skills").array().notNull().default([]),
  workHistory: jsonb("work_history").notNull().default([]),
  education: text("education").array().notNull().default([]),
  recruiterSummary: text("recruiter_summary").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTalentMatchSchema = createInsertSchema(talentMatchesTable).omit({ id: true, createdAt: true });
export type InsertTalentMatch = z.infer<typeof insertTalentMatchSchema>;
export type TalentMatch = typeof talentMatchesTable.$inferSelect;
