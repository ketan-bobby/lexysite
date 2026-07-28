/**
 * schema/candidate-connection-engine.ts — Candidate-Side Connection Engine Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_connection_events    — Raw behavioural events from the candidate's
 *                                    perspective (e.g. completed_ai_interview,
 *                                    replied_to_message). Written by candidateConnectionEngine.ts.
 *   candidate_connection_insights  — Pre-calculated scores shown to the candidate:
 *                                    connectionStrengthScore, hiringMomentumScore,
 *                                    nextBestAction label. One row per candidate+job.
 *
 * ─── Important boundary ──────────────────────────────────────────────────────
 * These tables are CANDIDATE-SIDE only. They are completely separate from the
 * employer-side connection_events / connection_scores tables in connection-engine.ts.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/candidateConnectionEngine.ts           — reads/writes both tables
 *   routes/candidate-connection-engine.ts      — exposes insight API
 */
// Separate from the employer-side connection_events / connection_scores tables.

import { pgTable, text, timestamp, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const candidateConnectionEventsTable = pgTable("candidate_connection_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id"),
  employerId: text("employer_id"),
  eventType: text("event_type").notNull(),
  eventValue: text("event_value"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const candidateConnectionInsightsTable = pgTable("candidate_connection_insights", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id"),
  employerId: text("employer_id"),
  connectionStrengthScore: real("connection_strength_score").notNull().default(0),
  connectionStrengthLabel: text("connection_strength_label").notNull().default("Cold"),
  hiringMomentumScore: real("hiring_momentum_score"),
  hiringMomentumLabel: text("hiring_momentum_label"),
  nextBestAction: text("next_best_action").notNull().default(""),
  explanation: jsonb("explanation"),
  topSignals: jsonb("top_signals"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCandidateConnectionEventSchema = createInsertSchema(candidateConnectionEventsTable).omit({ id: true, createdAt: true });
export type InsertCandidateConnectionEvent = z.infer<typeof insertCandidateConnectionEventSchema>;
export type CandidateConnectionEvent = typeof candidateConnectionEventsTable.$inferSelect;

export const insertCandidateConnectionInsightSchema = createInsertSchema(candidateConnectionInsightsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCandidateConnectionInsight = z.infer<typeof insertCandidateConnectionInsightSchema>;
export type CandidateConnectionInsight = typeof candidateConnectionInsightsTable.$inferSelect;
