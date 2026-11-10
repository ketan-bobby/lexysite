import { createHash } from "node:crypto";
import { z } from "zod";
import type { EvaluationContent, EvaluationHumanEdits } from "./evaluation-synthesis";

const text = z.string().max(20000);
const texts = z.array(text).max(100);
// Only job-assessment editorial fields. Verdict, confidence, provenance and
// verification status are server-owned; private source blobs are not accepted.
export const EvaluationReviewEditsSchema = z
  .object({
    headline: text.optional(),
    executiveSummary: text.optional(),
    roleAlignment: text.optional(),
    behavioralInsights: z
      .array(
        z
          .object({
            dimension: text,
            descriptor: text,
          })
          .strict(),
      )
      .max(100)
      .optional(),
    observations: z
      .array(
        z
          .object({
            observed: text,
            whyItMatters: text,
            followUps: texts,
          })
          .strict(),
      )
      .max(100)
      .optional(),
    developmentOpportunities: z
      .array(
        z
          .object({
            area: text,
            impact: z.enum(["high", "medium", "low"]),
            coaching: text,
          })
          .strict(),
      )
      .max(100)
      .optional(),
    riskAssessment: z
      .object({
        concerns: texts.optional(),
        toValidate: texts.optional(),
      })
      .strict()
      .optional(),
    recommendation: z.object({ rationale: text.optional() }).strict().optional(),
    verification: z.object({ summary: text.optional() }).strict().optional(),
    competencyOverrides: z
      .record(
        z
          .object({
            score: z.number().finite().min(0).max(100).nullable().optional(),
            insufficientEvidence: z.boolean().optional(),
            evidence: text.optional(),
            rationale: text.optional(),
          })
          .strict(),
      )
      .optional(),
    recruiterComments: text.optional(),
  })
  .strict();

export type EvaluationEditBinding = {
  id: string;
  tenantId: string;
  jobId: string;
  candidateId: string;
};
type EditSource = EvaluationEditBinding & { aiContent: unknown; humanEdits?: unknown };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function draftHash(content: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(content)))
    .digest("hex");
}

export function hasJobBoundEvaluation(content: unknown, binding: EvaluationEditBinding): boolean {
  const p = (content as EvaluationContent | null)?.evidenceBasis?.provenance;
  return (
    p?.kind === "job_bound_evaluation_v1" &&
    p.jobId === binding.jobId &&
    p.candidateId === binding.candidateId
  );
}

/** Called only AFTER route authorization and body validation, never from input metadata. */
export function sealEvaluationReviewEdits(
  source: EditSource,
  edits: EvaluationHumanEdits,
  userId: string,
) {
  const previous = source.humanEdits as Record<string, unknown> | null;
  return {
    kind: "job_bound_recruiter_review_v1",
    evaluationId: source.id,
    tenantId: source.tenantId,
    jobId: source.jobId,
    candidateId: source.candidateId,
    draftHash: draftHash(source.aiContent),
    editedByUserId: userId,
    recordedAt: new Date().toISOString(),
    edits: EvaluationReviewEditsSchema.parse(edits),
    // Preserve withheld historical notes in storage, never in API/PDF output.
    legacyPrivateEdits:
      previous?.kind === "job_bound_recruiter_review_v1"
        ? (previous.legacyPrivateEdits ?? null)
        : (source.humanEdits ?? null),
  };
}

/** Historical/raw overlays and copied or stale envelopes fail closed. */
export function readEvaluationReviewEdits(
  content: unknown,
  stored: unknown,
  binding?: EvaluationEditBinding,
): EvaluationHumanEdits | null {
  if (!binding || !hasJobBoundEvaluation(content, binding) || !stored || typeof stored !== "object")
    return null;
  const e = stored as Record<string, unknown>;
  if (
    e.kind !== "job_bound_recruiter_review_v1" ||
    e.evaluationId !== binding.id ||
    e.tenantId !== binding.tenantId ||
    e.jobId !== binding.jobId ||
    e.candidateId !== binding.candidateId ||
    e.draftHash !== draftHash(content) ||
    typeof e.editedByUserId !== "string" ||
    !e.editedByUserId ||
    typeof e.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(e.recordedAt))
  )
    return null;
  const parsed = EvaluationReviewEditsSchema.safeParse(e.edits);
  return parsed.success ? parsed.data : null;
}

export function reviewEditsStatus(source: EditSource): "none" | "verified" | "requires_review" {
  if (!source.humanEdits || Object.keys(source.humanEdits as object).length === 0) return "none";
  return readEvaluationReviewEdits(source.aiContent, source.humanEdits, source)
    ? "verified"
    : "requires_review";
}
