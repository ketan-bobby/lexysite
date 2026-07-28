/**
 * schema/governance.ts — AI Governance Layer (Migration 0016)
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Splits the previously-conflated "where is this application in the funnel"
 * from "who made the terminal decision on this candidate." The DB itself
 * makes it structurally impossible to store an autonomous AI rejection
 * in applications.final_decision — that's the LL144 / CO AI Act audit
 * guarantee.
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   jurisdiction_ai_policy_rules      — versioned append-only policy
 *   jurisdiction_disclosure_templates — versioned candidate-facing notice copy
 *   decision_events                   — append-only immutable audit log
 *   appeals_requests                  — stub for CO right-to-appeal flow
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   ai_recommendation_enum  — values an AI system may produce
 *   final_decision_enum     — values a human (or candidate) may produce.
 *                             Deliberately has NO ai_* values.
 */
import { pgTable, text, timestamp, boolean, real, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiRecommendationEnum = pgEnum("ai_recommendation_enum", [
  "advance",
  "reject",
  "hold",
  "lapsed",
  "flag_fraud",
  "no_recommendation",
]);

export const finalDecisionEnum = pgEnum("final_decision_enum", [
  "human_advance",
  "human_reject",
  "human_hold",
  "human_lapsed",
  "human_hired",
  "human_offer",
  "candidate_withdrawn",
  "legacy_pre_gate",
]);

export const jurisdictionAiPolicyRulesTable = pgTable("jurisdiction_ai_policy_rules", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  jurisdictionCode: text("jurisdiction_code").notNull(),
  jurisdictionLabel: text("jurisdiction_label").notNull(),
  scope: text("scope").notNull(),                       // 'platform_floor' | 'tenant_extension'
  tenantId: text("tenant_id"),                          // null when scope='platform_floor'
  gateRejects: boolean("gate_rejects").notNull().default(true),
  gateLapsed: boolean("gate_lapsed").notNull().default(true),
  gateHolds: boolean("gate_holds").notNull().default(false),
  requireDisclosure: boolean("require_disclosure").notNull().default(true),
  requireAppeal: boolean("require_appeal").notNull().default(false),
  requireAudit: boolean("require_audit").notNull().default(true),
  basis: text("basis"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const jurisdictionDisclosureTemplatesTable = pgTable("jurisdiction_disclosure_templates", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  jurisdictionCode: text("jurisdiction_code").notNull(),
  language: text("language").notNull().default("en"),
  templateKey: text("template_key").notNull(),
  subject: text("subject"),
  bodyMarkdown: text("body_markdown").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const decisionEventsTable = pgTable("decision_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  applicationId: text("application_id"),
  candidateId: text("candidate_id"),
  jobId: text("job_id"),
  eventType: text("event_type").notNull(),
  actorUserId: text("actor_user_id"),
  actorKind: text("actor_kind").notNull(),
  aiRecommendation: aiRecommendationEnum("ai_recommendation"),
  finalDecision: finalDecisionEnum("final_decision"),
  rationale: text("rationale"),
  attestation: text("attestation"),
  modelId: text("model_id"),
  modelVersion: text("model_version"),
  promptVersion: text("prompt_version"),
  scoringVersion: text("scoring_version"),
  orchestrationVersion: text("orchestration_version"),
  policyVersionId: text("policy_version_id"),
  jurisdictions: text("jurisdictions").array().notNull().default(sql`'{}'::text[]`),
  disclosureVersionId: text("disclosure_version_id"),
  payload: jsonb("payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const appealsRequestsTable = pgTable("appeals_requests", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  applicationId: text("application_id").notNull(),
  candidateId: text("candidate_id"),
  requestedBy: text("requested_by").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("received"),
  reviewerUserId: text("reviewer_user_id"),
  outcomeReason: text("outcome_reason"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /* T011 — real workflow columns. See migration 0017. CHECK constraints
   * enforce that a resolved appeal must have reviewer + attestation. */
  slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
  outcome: text("outcome"),                 // 'upheld' | 'reversed' | 'withdrawn' | 'duplicate' | 'out_of_scope'
  outcomeNotes: text("outcome_notes"),
  reviewerAttestation: text("reviewer_attestation"),
  candidateNotifiedAt: timestamp("candidate_notified_at", { withTimezone: true }),
});

export const insertJurisdictionPolicySchema = createInsertSchema(jurisdictionAiPolicyRulesTable).omit({ id: true, createdAt: true });
export const selectJurisdictionPolicySchema = createSelectSchema(jurisdictionAiPolicyRulesTable);
export type JurisdictionPolicy = typeof jurisdictionAiPolicyRulesTable.$inferSelect;

export const insertDecisionEventSchema = createInsertSchema(decisionEventsTable).omit({ id: true, createdAt: true });
export type DecisionEvent = typeof decisionEventsTable.$inferSelect;

export const insertAppealSchema = createInsertSchema(appealsRequestsTable).omit({ id: true, createdAt: true });
export type AppealRequest = typeof appealsRequestsTable.$inferSelect;

export type AiRecommendation = (typeof aiRecommendationEnum.enumValues)[number];
export type FinalDecision = (typeof finalDecisionEnum.enumValues)[number];
