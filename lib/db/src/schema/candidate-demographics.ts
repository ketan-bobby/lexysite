/**
 * schema/candidate-demographics.ts — Candidate Voluntary Self-Identification
 *
 * ─── Why this table is separate from `candidates` ────────────────────────────
 * EEO (US) and GDPR Article 9 (EU) both require that protected demographic
 * data be collected on a strictly voluntary basis, decoupled from any
 * screening or hiring decision, and never visible to the people making
 * those decisions on an individual basis. To honour that:
 *
 *   1. Demographics live in their OWN table, joined to candidates only by
 *      candidate_id (UNIQUE, cascade delete). The recruiter-facing
 *      candidate detail query MUST NOT join this table.
 *   2. The recruiter UI never renders a single candidate's demographics —
 *      only aggregate, k-anonymised (>= 5 per bucket) views via the
 *      /analytics/diversity endpoint.
 *   3. Consent is captured per-row: consent_version + consented_at.
 *      `region` is a snapshot of the tenant's region at consent time so
 *      we can prove which disclosure copy the candidate saw (OFCCP for
 *      US, GDPR Article 9 explicit consent for EU).
 *   4. Every field is nullable — every option includes "prefer not to say",
 *      which we represent as NULL.
 *
 * If you ever need to surface demographics in another context, do it via a
 * separate explicit query against this table — never widen the candidate
 * SELECT to JOIN this one in. That separation is the entire compliance
 * story.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/candidates.ts        — candidate-facing GET/PATCH /candidates/me/demographics
 *   routes/analytics.ts         — recruiter-facing GET /analytics/diversity (aggregate)
 */
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const candidateDemographicsTable = pgTable(
  "candidate_demographics",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    candidateId: text("candidate_id").notNull(),
    /* Snapshot of the tenant's region at consent time. Used for audit:
     * proves which disclosure copy the candidate consented under. */
    region: text("region").notNull(),
    /* All demographic fields are nullable; NULL = "prefer not to say". */
    gender: text("gender"),                       // 'female' | 'male' | 'non_binary' | 'self_describe'
    genderSelfDescribe: text("gender_self_describe"),
    raceEthnicity: text("race_ethnicity").array(),// multi-select; e.g. ['hispanic','asian']
    veteranStatus: text("veteran_status"),        // 'protected_veteran' | 'not_veteran' | 'prefer_not_to_say'
    disabilityStatus: text("disability_status"),  // 'yes' | 'no' | 'prefer_not_to_say'
    consentVersion: text("consent_version").notNull(),
    consentedAt: timestamp("consented_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    /* One demographics row per candidate. PATCH = upsert against this. */
    candidateUq: uniqueIndex("candidate_demographics_candidate_uq").on(t.candidateId),
  }),
);

export const insertCandidateDemographicsSchema = createInsertSchema(candidateDemographicsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const selectCandidateDemographicsSchema = createSelectSchema(candidateDemographicsTable);
export type InsertCandidateDemographics = z.infer<typeof insertCandidateDemographicsSchema>;
export type CandidateDemographics = typeof candidateDemographicsTable.$inferSelect;
