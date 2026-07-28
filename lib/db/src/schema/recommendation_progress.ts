/**
 * schema/recommendation_progress.ts — Platform Recommendation Scan Progress Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_recommendation_progress   — Tracks which platform-pool candidates
 *                                         have already been evaluated against which
 *                                         jobs in the last recommendation scan.
 *                                         Used for idempotency: prevents re-scoring
 *                                         the same candidate+job pair in subsequent
 *                                         24-hour scan cycles.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/platform-recommendation-engine.ts   — reads/writes progress rows
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const candidateRecommendationProgressTable = pgTable("candidate_recommendation_progress", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  recKey:      text("rec_key").notNull(),
  completedAt: timestamp("completed_at"),
  notes:       text("notes"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export type CandidateRecommendationProgress = typeof candidateRecommendationProgressTable.$inferSelect;
