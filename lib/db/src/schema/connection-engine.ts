/**
 * schema/connection-engine.ts — Employer-Side Connection Score Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   connection_events   — Raw behavioural events from the recruiter/employer
 *                         perspective (e.g. replied_to_outreach, booked_interview).
 *                         Written by connectionEngine.ts after each signal event.
 *   connection_scores   — Pre-calculated connection score (0–100) + label for a
 *                         candidate+job pair. One row per pair; upserted on each
 *                         recalculation.
 *
 * ─── Important boundary ──────────────────────────────────────────────────────
 * These are EMPLOYER-SIDE tables. Do not confuse with candidate_connection_events /
 * candidate_connection_insights (candidate-connection-engine.ts), which are completely
 * independent.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/connectionEngine.ts          — reads/writes both tables
 *   routes/connection-engine.ts      — exposes score retrieval API
 */

import { pgTable, text, timestamp, integer, jsonb, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const connectionEventsTable = pgTable("connection_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id"),
  employerId: text("employer_id"),
  eventType: text("event_type").notNull(),
  eventValue: text("event_value"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const connectionScoresTable = pgTable("connection_scores", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id"),
  employerId: text("employer_id"),
  score: real("score").notNull().default(0),
  lastCalculatedAt: timestamp("last_calculated_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertConnectionEventSchema = createInsertSchema(connectionEventsTable).omit({ id: true, createdAt: true });
export type InsertConnectionEvent = z.infer<typeof insertConnectionEventSchema>;
export type ConnectionEvent = typeof connectionEventsTable.$inferSelect;

export const insertConnectionScoreSchema = createInsertSchema(connectionScoresTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertConnectionScore = z.infer<typeof insertConnectionScoreSchema>;
export type ConnectionScore = typeof connectionScoresTable.$inferSelect;
