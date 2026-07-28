/**
 * schema/intelligence.ts — Candidate Intelligence & Decision Policy Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_job_intelligence  — Pre-calculated intelligence record for a
 *                                 candidate×job pair: composite scores (fit,
 *                                 quality, trust, conversion), stage probabilities,
 *                                 next_best_action, AI playbook, and signal freshness.
 *                                 Updated after each agent run.
 *   decision_overrides          — Recruiter manual overrides of AI decisions. Each
 *                                 row captures the original decision, the override,
 *                                 and the stated reason for the audit trail.
 *   hiring_outcomes             — Post-hire outcome tracking: final hire/reject
 *                                 decision and time-to-fill for model learning.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   next_best_action  — advance · hold · review · interview · reject
 *   hiring_outcome    — hired · rejected · withdrew · offer_declined
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/intelligence.ts        — primary writer
 *   routes/intelligence.ts     — read/override API
 */
import { pgTable, text, timestamp, real, jsonb, pgEnum, unique, boolean, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const nextBestActionEnum = pgEnum("next_best_action", [
  "advance",
  "schedule",
  "recruiter_review",
  "re_engage",
  "manual_verification",
  "reject",
  "hold",
]);

export const hiringOutcomeEnum = pgEnum("hiring_outcome", [
  "hired",
  "rejected",
  "ghosted",
  "no_show",
  "offer_accepted",
  "offer_declined",
]);

export const candidateJobIntelligenceTable = pgTable(
  "candidate_job_intelligence",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    candidateId: text("candidate_id").notNull(),

    /* ── Composite Scores (0–100) ─────────────────────────────── */
    fitScore:        real("fit_score"),        // ICP + skill + experience alignment
    qualityScore:    real("quality_score"),     // sourcing + screening + interview
    trustScore:      real("trust_score"),       // verification + proctoring + consistency
    conversionScore: real("conversion_score"),  // outreach + scheduling + anti-ghosting
    hireProbability: real("hire_probability"),  // weighted composite of all four

    /* ── Stage-Aware Predictions ──────────────────────────────── */
    stageProbsJson: jsonb("stage_probs_json"),
    /*
      {
        nextStageSuccessProbability: number,   // will they pass the next stage?
        offerProbability:            number,   // will they receive an offer?
        offerAcceptanceProbability:  number,   // will they accept if offered?
        dropoffProbability:          number,   // will they ghost/drop off?
      }
    */

    /* ── Decision Engine ──────────────────────────────────────── */
    nextBestAction: nextBestActionEnum("next_best_action"),

    /* ── Top Signals (human-readable) ───────────────────────────*/
    topStrengths: jsonb("top_strengths"),  // string[]
    topRisks:     jsonb("top_risks"),      // string[]

    /* ── Explanation Layer ────────────────────────────────────── */
    explanationJson: jsonb("explanation_json"),

    /* ── Raw Agent Signals ────────────────────────────────────── */
    signalsJson: jsonb("signals_json"),

    /* ── Signal Timestamps ────────────────────────────────────── */
    signalTimestampsJson: jsonb("signal_timestamps_json"),
    /*
      {
        screening:    ISO8601 string,   // when screening agent last updated
        sourcing:     ISO8601 string,
        interview:    ISO8601 string,
        proctoring:   ISO8601 string,
        outreach:     ISO8601 string,
        antiGhosting: ISO8601 string,
        verification: ISO8601 string,
        scheduling:   ISO8601 string,
        analytics:    ISO8601 string,
        icp:          ISO8601 string,
      }
    */

    /* ── Human Override Tracking ──────────────────────────────── */
    overridesJson: jsonb("overrides_json"),
    /*
      OverrideRecord[]:
      {
        id:                  uuid,
        overriddenAt:        ISO8601,
        originalDecision:    NextBestAction,
        recruiterDecision:   NextBestAction,
        recruiterReason:     string,
        recruiterId?:        string,
        finalOutcome?:       HiringOutcome,  // filled in later
      }[]
    */

    /* ── Learning Layer ───────────────────────────────────────── */
    outcome:   hiringOutcomeEnum("outcome"),
    outcomeAt: timestamp("outcome_at"),

    /* Which scoring model version produced these scores. Stamped on every
     * persist so a backtest can attribute scores to a config and a scoring
     * change can be rolled back / compared by version. */
    modelVersion: text("model_version"),

    lastUpdated: timestamp("last_updated").notNull().defaultNow(),
    createdAt:   timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("uniq_intel_job_candidate").on(t.jobId, t.candidateId)]
);

/* ── Scoring Model Versions ───────────────────────────────────────────────────
 * A platform-global (NOT tenant-scoped) registry of scoring configurations.
 * Each row is one version of the intelligence engine's composite weights. The
 * single `is_live` row is the configuration used to score+persist new rows; a
 * scoring change is rolled back simply by re-activating an earlier version.
 * Managed exclusively through controlDb by platform admins. */
export const scoringModelVersionsTable = pgTable("scoring_model_versions", {
  id:         text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  version:    text("version").notNull().unique(),
  label:      text("label").notNull(),
  /* Full ScoringConfig (see lib/scoring-config.ts) — the composite weights. */
  configJson: jsonb("config_json").notNull(),
  isLive:     boolean("is_live").notNull().default(false),
  notes:      text("notes"),
  createdAt:  timestamp("created_at").notNull().defaultNow(),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
});

/* ── Per-Tenant Learned Scoring Weights ───────────────────────────────────────
 * Outcome-calibrated `hireProbability` weights learned from a single tenant's
 * own labeled outcomes (candidate_job_intelligence rows with a non-null
 * outcome), shrunk toward the hardcoded prior. A learned version only becomes
 * the `is_active` config for a tenant after it (a) clears a tunable minimum
 * sample gate and (b) beats the live config on that tenant's labeled set via
 * the backtest harness. Exactly one active version per tenant is enforced in
 * code (deactivate-then-activate transaction). The deterministic hardcoded /
 * live config is the permanent fallback — scoring never depends on a row here
 * existing or being valid. Managed via controlDb (cross-tenant admin concern). */
export const tenantScoringWeightsTable = pgTable(
  "tenant_scoring_weights",
  {
    id:         text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:   text("tenant_id").notNull(),
    version:    text("version").notNull(),
    /* Full ScoringConfig (see lib/scoring-config.ts) — a clone of the base
     * config with the learned hireProbability weights substituted in. */
    configJson: jsonb("config_json").notNull(),
    /* Number of labeled outcomes used to train this version. */
    sampleSize: integer("sample_size").notNull(),
    isActive:   boolean("is_active").notNull().default(false),
    /* The BacktestComparison (candidate vs live) that justified activation. */
    backtestJson: jsonb("backtest_json"),
    notes:      text("notes"),
    createdAt:  timestamp("created_at").notNull().defaultNow(),
    updatedAt:  timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_tenant_scoring_version").on(t.tenantId, t.version),
    // At most one active learned version per tenant — a DB-level backstop on top
    // of the deactivate-then-activate transaction, so the read path can never
    // see two competing active configs for the same tenant.
    uniqueIndex("uniq_tenant_scoring_active").on(t.tenantId).where(sql`${t.isActive}`),
  ]
);

/* ── Cross-Tenant Global Scoring Prior (network effect) ───────────────────────
 * A platform-global (NOT tenant-scoped) versioned meta-model: the four
 * `hireProbability` composite weights learned from ANONYMIZED, AGGREGATED
 * signal→outcome statistics pooled across tenants. Customer #500 gets a smarter
 * cold-start prior than the static builtin; customer #1's raw data NEVER crosses
 * a tenant boundary — only sufficient-statistic aggregates (sums/counts, no
 * candidate or tenant identifiers) are pooled to produce these weights.
 *
 * Usage: a new/thin-data tenant (no active learned config of its own)
 * initializes its scoring prior from the active row here instead of the static
 * hardcoded weights; as the tenant accrues its own labeled outcomes, per-tenant
 * learning (tenant_scoring_weights) shrinks toward this prior and eventually
 * overrides it. A row only becomes `is_active` after clearing minimum
 * contributing-tenant + total-sample gates AND a federated evaluation (each
 * tenant backtests the prior locally; only scalar metrics aggregate). The static
 * builtin remains the PERMANENT fallback — serving never depends on a row here.
 * Managed exclusively via controlDb by platform admins. */
export const globalScoringPriorsTable = pgTable(
  "global_scoring_priors",
  {
    id:        text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    version:   text("version").notNull().unique(),
    label:     text("label").notNull(),
    /* The four hireProbability composite weights {fit,quality,trust,conversion}
     * (sums to 1.0) — the meta-prior. */
    priorJson: jsonb("prior_json").notNull(),
    /* Total labeled outcomes pooled across all contributing tenants. */
    sampleSize:         integer("sample_size").notNull(),
    /* How many tenants contributed aggregate statistics to this prior. */
    contributingTenants: integer("contributing_tenants").notNull(),
    /* The pooled per-dimension sufficient statistics + recovered correlations
     * that produced the weights — for audit. Contains NO tenant/candidate ids. */
    aggregateJson: jsonb("aggregate_json"),
    isActive:  boolean("is_active").notNull().default(false),
    /* The federated evaluation summary (meta-prior vs builtin) that justified
     * activation — aggregate scalar metrics only. */
    evaluationJson: jsonb("evaluation_json"),
    notes:     text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // At most one active meta-prior platform-wide — DB backstop on top of the
    // deactivate-then-activate transaction, so the read path never sees two.
    uniqueIndex("uniq_global_scoring_prior_active").on(t.isActive).where(sql`${t.isActive}`),
  ]
);

/* ── Candidate profile embeddings (similar-hire signal corpus) ─────────────────
 * One vector per (tenant, candidate). Profiles are embedded and stored from the
 * moment this ships so the comparison corpus accumulates BEFORE the embedding
 * signal turns on. The vector is stored as a JSON number[] (no pgvector
 * dependency) — corpora are small (per role family) and the kNN cosine math runs
 * in application code. `textHash` lets the writer skip re-embedding unchanged
 * profiles, keeping it idempotent and cheap. */
export const candidateEmbeddingsTable = pgTable(
  "candidate_embeddings",
  {
    id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:    text("tenant_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    /* Embedding model id (e.g. text-embedding-3-small). Stored so a model swap
     * never silently mixes incomparable vectors — readers filter by model. */
    model:       text("model").notNull(),
    dims:        integer("dims").notNull(),
    /* Hash of the exact profile text that produced this vector — skip re-embed
     * when the profile is unchanged. */
    textHash:    text("text_hash").notNull(),
    /* The vector itself, as a JSON number[]. */
    vector:      jsonb("vector").notNull(),
    /* The profile text that was embedded (debugging / re-embed provenance). */
    profileText: text("profile_text"),
    createdAt:   timestamp("created_at").notNull().defaultNow(),
    updatedAt:   timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_candidate_embedding").on(t.tenantId, t.candidateId),
  ]
);

/* ── Similar-hire signal activation (per tenant) ───────────────────────────────
 * The similar-hire embedding signal only "ships" — i.e. feeds the live fitScore
 * via analytics.similarHirePatternScore — for a tenant after the backtest harness
 * confirms it beats the LLM-vs-ICP fallback on that tenant's labeled outcomes.
 * One row per tenant: isActive is set true ONLY by a winning backtest and read
 * (never-throws → false) on the hot path. When absent/inactive the signal falls
 * back to the LLM-vs-ICP comparison — exactly today's behaviour. */
export const similarHireModelsTable = pgTable(
  "similar_hire_models",
  {
    id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId:     text("tenant_id").notNull(),
    isActive:     boolean("is_active").notNull().default(false),
    /* Min successful-hire exemplars a role family needs before the embedding path
     * is used for it (mirrors the value the trainer gated on). */
    minExemplars: integer("min_exemplars").notNull(),
    /* Number of labeled outcomes the activating backtest scored over. */
    sampleSize:   integer("sample_size").notNull().default(0),
    /* The BacktestComparison (with-signal vs without) that justified activation. */
    backtestJson: jsonb("backtest_json"),
    notes:        text("notes"),
    createdAt:    timestamp("created_at").notNull().defaultNow(),
    updatedAt:    timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uniq_similar_hire_tenant").on(t.tenantId),
  ]
);

/* ── Tenant Decision Policies ─────────────────────────────────────────────── */

export const tenantDecisionPoliciesTable = pgTable("tenant_decision_policies", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),

  tenantId:  text("tenant_id").notNull(),
  roleId:    text("role_id"),    // null = applies to all roles for this tenant
  stage:     text("stage"),      // null = applies to all stages

  isDefault: boolean("is_default").notNull().default(false),
  label:     text("label").notNull().default("Default Policy"),

  policyJson: jsonb("policy_json").notNull(),
  /*
    TenantPolicy:
    {
      // Trust rules
      lowTrustAction:    "manual_verification" | "reject",
      lowTrustThreshold: number,   // 0-100, default 45

      // Automation rules
      allowAutoOutreach:          boolean,
      allowAutoSchedule:          boolean,
      allowAutoReengage:          boolean,
      requireRecruiterApproval:   boolean,

      // Score thresholds
      advanceThreshold:            number,  // default 80
      scheduleThreshold:           number,  // default 63
      rejectMinQuality:            number,  // default 25
      rejectMinFit:                number,  // default 20
      reengageConversionThreshold: number,  // default 35

      // Stage-specific rules
      stageRules: {
        [stage: string]: {
          requireApproval:      boolean,
          minHireProbability:   number,
          minTrustScore:        number,
        }
      }
    }
  */

  createdAt:  timestamp("created_at").notNull().defaultNow(),
  updatedAt:  timestamp("updated_at").notNull().defaultNow(),
});

/* ── Zod / Insert types ───────────────────────────────────────────────────── */

export const insertIntelligenceSchema = createInsertSchema(candidateJobIntelligenceTable).omit({
  id: true, createdAt: true, lastUpdated: true,
});
export type InsertIntelligence = z.infer<typeof insertIntelligenceSchema>;
export type CandidateJobIntelligence = typeof candidateJobIntelligenceTable.$inferSelect;

export const insertPolicySchema = createInsertSchema(tenantDecisionPoliciesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertPolicy = z.infer<typeof insertPolicySchema>;
export type TenantDecisionPolicy = typeof tenantDecisionPoliciesTable.$inferSelect;

export const insertTenantScoringWeightsSchema = createInsertSchema(tenantScoringWeightsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertTenantScoringWeights = z.infer<typeof insertTenantScoringWeightsSchema>;
export type TenantScoringWeights = typeof tenantScoringWeightsTable.$inferSelect;

export const insertGlobalScoringPriorSchema = createInsertSchema(globalScoringPriorsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertGlobalScoringPrior = z.infer<typeof insertGlobalScoringPriorSchema>;
export type GlobalScoringPrior = typeof globalScoringPriorsTable.$inferSelect;

export const insertCandidateEmbeddingSchema = createInsertSchema(candidateEmbeddingsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertCandidateEmbedding = z.infer<typeof insertCandidateEmbeddingSchema>;
export type CandidateEmbedding = typeof candidateEmbeddingsTable.$inferSelect;

export const insertSimilarHireModelSchema = createInsertSchema(similarHireModelsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertSimilarHireModel = z.infer<typeof insertSimilarHireModelSchema>;
export type SimilarHireModel = typeof similarHireModelsTable.$inferSelect;
