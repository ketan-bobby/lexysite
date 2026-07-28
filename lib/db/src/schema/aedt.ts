/**
 * schema/aedt.ts — NYC Local Law 144 (AEDT) decision log
 *
 * ─── Why this table exists ───────────────────────────────────────────────────
 * NYC Local Law 144 ("Automated Employment Decision Tool" rules,
 * 6 RCNY § 5-300) requires that employers using an AEDT for hiring in
 * NYC keep auditor-reproducible records of every AI-assisted decision,
 * such that an independent auditor can compute the bias-audit metrics
 * (selection rate, impact ratio) and re-run on a sample.
 *
 * `ai_decision_log` is the auditor-facing append-only log. One row per
 * AI-driven recommendation (interview scoring, fit ranking, screen-out
 * suggestion). The candidate-link is denormalised so the auditor can
 * compute selection-rate breakdowns without joining demographics
 * directly (demographics stays decoupled — see
 * candidate-demographics.ts).
 *
 * `decisionType` taxonomy (extend as we add AI flows):
 *   'interview_score'   — Lexy's interview transcript → numeric score
 *   'fit_rank'          — Lexy's candidate-vs-JD fit ranking
 *   'screen_out'        — AI-recommended rejection
 *   'shortlist'         — AI-recommended advance
 *
 * `inputHash` is sha256 of the canonicalised input payload, so the
 * auditor can verify that a stored decision is reproducible from the
 * recorded input (defends against quiet model drift between audit
 * windows).
 *
 * The bias-audit export endpoint (/analytics/aedt-export) joins this
 * table to candidate_demographics with k-anonymity ≥ 5 and emits the
 * CSV the auditor needs.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/interviews.ts  — writes 'interview_score' rows
 *   routes/analytics.ts   — /analytics/aedt-export reads
 */
import { pgTable, text, timestamp, jsonb, integer, index, boolean } from "drizzle-orm/pg-core";

export const aiDecisionLogTable = pgTable(
  "ai_decision_log",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id"),
    candidateId: text("candidate_id"),
    decisionType: text("decision_type").notNull(),
    /* Numeric score (e.g. 0-100). Optional — boolean decisions use
     * decisionBool. */
    score: integer("score"),
    decisionBool: boolean("decision_bool"),
    /* Free-form label for ranking decisions ('shortlist' / 'reject' /
     * 'review'). */
    label: text("label"),
    /* sha256 hex of canonicalised input payload. */
    inputHash: text("input_hash"),
    /* Model identifier + version for reproducibility. */
    modelId: text("model_id"),
    /* Full input + output snapshot for auditor reproducibility.  May be
     * large — keep prompt and transcript here. */
    snapshot: jsonb("snapshot"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    tenantJobIdx: index("ai_decision_log_tenant_job_idx").on(t.tenantId, t.jobId, t.createdAt),
    candidateIdx: index("ai_decision_log_candidate_idx").on(t.candidateId),
    typeIdx: index("ai_decision_log_type_idx").on(t.decisionType, t.createdAt),
  }),
);

export type AiDecisionLog = typeof aiDecisionLogTable.$inferSelect;
export type InsertAiDecisionLog = typeof aiDecisionLogTable.$inferInsert;
