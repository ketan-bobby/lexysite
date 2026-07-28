/**
 * schema/evaluations.ts — Client-facing Candidate Evaluation Reports
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_evaluations — One rich, versioned evaluation per candidate×job.
 *                           A single persisted, structured object drives BOTH the
 *                           in-app report view AND the client-ready PDF (one
 *                           source of truth, two renderers).
 *
 * ─── Human-driven model ──────────────────────────────────────────────────────
 * The AI produces a DRAFT (`ai_content`). Recruiters override which competencies
 * appear (`competency_keys`) and edit any section / add comments (`human_edits`,
 * a sparse overlay merged over `ai_content` at read time). Nothing is shared with
 * a client until a recruiter APPROVES (`approval_state` → 'approved'). The 5-band
 * recommendation is deterministic from scores/red-flags; a recruiter may still
 * override the band inside `human_edits`.
 *
 * ─── Tenancy ─────────────────────────────────────────────────────────────────
 * `tenant_id` is the JOB's tenant (a client-facing evaluation belongs to the
 * requisition it was produced for; scoring is candidate↔job against the job's
 * tenant). FORCE RLS (Class-A) on app_tenant_in_scope(tenant_id); routes ALSO
 * apply the same predicates explicitly (dev strips RLS on most tables).
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/evaluations.ts           — CRUD + generate/regenerate/approve API
 *   lib/evaluation-synthesis.ts     — produces ai_content
 *   lib/competency-library.ts       — role-adaptive competency selection
 */
import { pgTable, text, timestamp, real, jsonb, pgEnum, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const evaluationApprovalStateEnum = pgEnum("evaluation_approval_state", [
  "draft",
  "approved",
]);

export const candidateEvaluationsTable = pgTable(
  "candidate_evaluations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    candidateId: text("candidate_id").notNull(),

    /* The AI-generated draft — the immutable record of what the model produced
     * for this generation. Shape = EvaluationContent (see lib/evaluation-synthesis). */
    aiContent: jsonb("ai_content").notNull(),

    /* Sparse recruiter overrides, merged OVER ai_content at read time. Same shape
     * as EvaluationContent but every field optional, plus recruiterComments. */
    humanEdits: jsonb("human_edits"),

    /* The selected competency set (library keys). Recruiter-overridable; drives
     * which competencies render. Persisted so overrides survive a page reload and
     * a regenerate re-scores exactly this set. */
    competencyKeys: text("competency_keys").array().notNull().default([]),

    /* Deterministic 5-band recommendation computed from scores + red flags at
     * generation time. A recruiter override lives in human_edits.recommendation.band. */
    recommendationBand: text("recommendation_band").notNull().default("further_assessment"),

    /* 0–100 evidence-backed confidence (coverage + interview depth + verification). */
    confidence: real("confidence"),

    approvalState: evaluationApprovalStateEnum("approval_state").notNull().default("draft"),

    /* Provenance. */
    model: text("model"),
    generatedByUserId: text("generated_by_user_id"),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("uniq_evaluation_job_candidate").on(t.jobId, t.candidateId)],
);

export const insertCandidateEvaluationSchema = createInsertSchema(candidateEvaluationsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCandidateEvaluation = z.infer<typeof insertCandidateEvaluationSchema>;
export type CandidateEvaluation = typeof candidateEvaluationsTable.$inferSelect;
