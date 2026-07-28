/**
 * schema/applications.ts — Job Application Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   applications   — One row per candidate application to a job. Tracks the
 *                    current pipeline stage, AI fit score, recruiter notes,
 *                    and stage timestamps for funnel analytics.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   application_stage — applied · screening · shortlisted · interview ·
 *                       verification · offer · hired · rejected · withdrawn
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/applications.ts  — CRUD and stage management
 *   routes/pipeline.ts      — Kanban board column grouping
 *   lib/intelligence.ts     — intelligence scoring context
 */
import { pgTable, text, timestamp, real, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { aiRecommendationEnum, finalDecisionEnum } from "./governance";

/* entry_type = ORIGIN of the pipeline entry (immutable, independent of stage):
 *   sourced — surfaced by the AI sourcing agent (not a formal applicant)
 *   applied — candidate applied through the public career site
 *   manual  — a recruiter manually added / linked the candidate to the job
 * Conversion / compliance denominators use ('applied','manual'); volume /
 * pipeline surfaces include all three. See migration 0041.
 *
 * ─── Split-filter counting doctrine (compliance reconciliation) ───────────────
 * Counting doctrine for this table lives here so entry_type and the filter model
 * are one document. Three filter classes compose independently on top of
 * entry_type; keep them distinct or the surfaces disagree:
 *   1. compliance-universal — erased + DNC candidates are excluded from EVERY
 *      count on EVERY surface (overview, funnel, KPIs, reports). Compliance is
 *      never optional and never varies by surface.
 *      (Sealed by compliance-no-erased-dnc-in-counts.test.ts.)
 *   2. list-cosmetic — "visible candidates" / list surfaces layer additional
 *      presentation-only filters (platform-pool, pending_profile). These scope
 *      what a list *shows*; they are NOT compliance and are NOT applied to the
 *      funnel or to conversion denominators.
 *   3. live-stage — funnel / pipeline surfaces count all live pipeline
 *      participants by furthest stage reached (reached-it-or-beyond),
 *      independent of entry_type and of the list-cosmetic filters.
 * Two-axis rule (the axes are orthogonal — never fold one into the other):
 *   • axis A = entry_type ORIGIN, which chooses the conversion/compliance
 *     DENOMINATOR: ('applied','manual') for formal-application & conversion
 *     rates, all three for raw volume;
 *   • axis B = the compliance-universal filter, which applies to every
 *     numerator and denominator regardless of axis A.
 * Labeled intentional gaps: because the funnel is live-stage while "Total
 * Candidates" is list-cosmetic and "formal applications" is entry_type-scoped,
 * funnel stage totals can legitimately EXCEED both the visible Total Candidates
 * count and the formal-applications figure. This is expected, not a bug, and is
 * surfaced to users via the funnel Info tooltip.
 * (Structural relationships sealed by analytics-structural-invariants.test.ts.) */
export const applicationEntryTypeEnum = pgEnum("application_entry_type", [
  "sourced",
  "applied",
  "manual",
]);

export const applicationStageEnum = pgEnum("application_stage", [
  "sourced",
  "applied",
  "screening",
  "verification",
  "shortlisted",
  "phone_screen",
  "assessment",
  "interview_scheduled",
  "interview",
  "interview_completed",
  "hm_review",
  "offer",
  "offer_recommended",
  "offer_extended",
  "offer_accepted",
  "offer_declined",
  "hired",
  "started",
  "rejected",
  "withdrawn",
]);

export const applicationsTable = pgTable("applications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  stage: applicationStageEnum("stage").notNull().default("applied"),
  entryType: applicationEntryTypeEnum("entry_type").notNull().default("applied"),
  /* ── Sourcing-origin attribution (migration 0055) ──────────────────────────
   * Captured ONCE when the pipeline link is created; immutable afterwards
   * except via the staff-only correction workflow (origin_corrections audit).
   * origin_evidence records the triggering event so a per-hire fee is
   * defensible in a dispute:
   *   ai_sourcing → { channel:'ai_sourcing', source, sourcingRunAt, ... }
   *   linx        → { channel:'linx', linxRequestId, submissionId, ... }
   *   applied     → { channel:'inbound', via }
   *   manual      → { channel:'customer', via, actorId }
   * FEE ELIGIBILITY = entry_type='sourced' AND origin_evidence IS NOT NULL.
   * Pre-launch rows have NULL evidence and are therefore never fee-eligible
   * (fail-closed by construction — no retroactive billing).
   * A DB trigger (applications_origin_immutable) rejects any change to
   * entry_type or a non-null origin_evidence unless the correction workflow
   * sets app.allow_origin_correction = 'on' for the transaction. */
  originSetAt: timestamp("origin_set_at", { withTimezone: true }),
  originSetBy: text("origin_set_by"),
  originEvidence: jsonb("origin_evidence"),
  matchScore: real("match_score"),
  notes: text("notes"),
  /* ─── AI Governance Layer (migration 0016) ─────────────────────────────
   * The columns below split AI-produced recommendations from human-
   * attested final decisions. See docs/AI_GOVERNANCE_ARCHITECTURE.md
   * and lib/db/src/schema/governance.ts. DB-level CHECK constraints
   * enforce that final_decision_by + final_decision_attestation are
   * non-null whenever final_decision is set (except for the reserved
   * `legacy_pre_gate` value). */
  aiRecommendation: aiRecommendationEnum("ai_recommendation"),
  aiRecommendationAt: timestamp("ai_recommendation_at", { withTimezone: true }),
  aiRecommendationModel: text("ai_recommendation_model"),
  aiRecommendationScore: real("ai_recommendation_score"),
  finalDecision: finalDecisionEnum("final_decision"),
  finalDecisionBy: text("final_decision_by"),
  finalDecisionAt: timestamp("final_decision_at", { withTimezone: true }),
  finalDecisionAttestation: text("final_decision_attestation"),
  finalDecisionReason: text("final_decision_reason"),
  gatedByJurisdiction: text("gated_by_jurisdiction").array().notNull().default(sql`'{}'::text[]`),
  policyVersionId: text("policy_version_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertApplicationSchema = createInsertSchema(applicationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const selectApplicationSchema = createSelectSchema(applicationsTable);
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type Application = typeof applicationsTable.$inferSelect;
