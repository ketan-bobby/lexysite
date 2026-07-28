/**
 * schema/candidate-outcomes.ts — Candidate Hiring Outcome Records
 *
 * ─── Tables ───────────────────────────────────────────────────────────────────
 *   candidate_outcomes  — One row per application that enters the offer/hire
 *                         funnel. Captures offer details, dates, and final
 *                         outcome (accepted / declined / started).
 *
 *   The `outcome` / `outcomeAt` columns capture the TERMINAL pipeline label
 *   (hired · rejected · withdrawn · ghosted) so the learning loop has a label
 *   for every closed application, not just offer-track ones. `hireQualityScore`
 *   plus the pulse_* columns hold the post-hire 30/90-day quality signal.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/outcomes.ts          — CRUD, stage-action, pulse + coverage endpoints
 *   lib/record-terminal-outcome — auto-capture of terminal outcomes
 *   lib/post-hire-pulse-scheduler — sends 30/90-day quality pulses
 *   routes/analytics.ts         — Funnel and KPI aggregation
 */
import { pgTable, text, timestamp, real, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const candidateOutcomesTable = pgTable("candidate_outcomes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  applicationId: text("application_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  jobId: text("job_id").notNull(),
  offerDate: timestamp("offer_date", { withTimezone: true }),
  offerAmount: real("offer_amount"),
  offerAccepted: boolean("offer_accepted"),
  offerAcceptDate: timestamp("offer_accept_date", { withTimezone: true }),
  hireDate: timestamp("hire_date", { withTimezone: true }),
  startDate: timestamp("start_date", { withTimezone: true }),
  declineReason: text("decline_reason"),
  outcomeSource: text("outcome_source"),
  /* Terminal pipeline label — hired · rejected · withdrawn · ghosted. Set
   * automatically when an application reaches a terminal stage. */
  outcome: text("outcome"),
  outcomeAt: timestamp("outcome_at", { withTimezone: true }),
  /* Post-hire quality signal (0–100) computed from the 30/90-day pulse. */
  hireQualityScore: real("hire_quality_score"),
  pulse30SentAt: timestamp("pulse_30_sent_at", { withTimezone: true }),
  pulse30RespondedAt: timestamp("pulse_30_responded_at", { withTimezone: true }),
  pulse90SentAt: timestamp("pulse_90_sent_at", { withTimezone: true }),
  pulse90RespondedAt: timestamp("pulse_90_responded_at", { withTimezone: true }),
  /* Raw pulse answers, keyed by phase: { "30": {...}, "90": {...} }. */
  pulseResponses: jsonb("pulse_responses"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  /* One outcome row per application — the conflict target for the atomic
   * upserts in record-terminal-outcome.ts and routes/outcomes.ts. */
  applicationIdUniq: uniqueIndex("candidate_outcomes_application_id_uniq").on(table.applicationId),
}));

export const insertCandidateOutcomeSchema = createInsertSchema(candidateOutcomesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const selectCandidateOutcomeSchema = createSelectSchema(candidateOutcomesTable);
export type InsertCandidateOutcome = z.infer<typeof insertCandidateOutcomeSchema>;
export type CandidateOutcome = typeof candidateOutcomesTable.$inferSelect;
