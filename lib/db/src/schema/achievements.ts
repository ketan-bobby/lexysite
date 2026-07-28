/**
 * schema/achievements.ts — Candidate Achievements & Skill Score History
 *
 * candidate_achievements    — Badges earned by candidates (first_interview,
 *                             profile_complete, five_mocks, etc.). One row per
 *                             (candidate, code) pair via unique index.
 * candidate_skill_scores    — Per-skill score history powering the improvement
 *                             sparkline on the Career Hub. One row per
 *                             measurement, queried by (candidate_id, skill).
 */
import { pgTable, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

export const candidateAchievementsTable = pgTable("candidate_achievements", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  code:        text("code").notNull(),
  title:       text("title").notNull(),
  description: text("description").notNull(),
  icon:        text("icon").notNull().default("trophy"),
  metadata:    jsonb("metadata").$type<Record<string, any>>().default({}),
  earnedAt:    timestamp("earned_at").notNull().defaultNow(),
});

export const candidateSkillScoresTable = pgTable("candidate_skill_scores", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  skill:       text("skill").notNull(),
  score:       integer("score").notNull().default(0),
  source:      text("source").notNull().default("baseline_interview"),
  sessionId:   text("session_id"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export type CandidateAchievement  = typeof candidateAchievementsTable.$inferSelect;
export type CandidateSkillScore   = typeof candidateSkillScoresTable.$inferSelect;
