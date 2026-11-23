import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { CandidateEvaluation, interviewSessionsTable } from "@workspace/db";
import type { QorInterviewStatus } from "@workspace/api-zod";
import { hasJobBoundEvaluation, reviewEditsStatus } from "./evaluation-review-edits";
import { mergeEvaluation, type EvaluationContent } from "./evaluation-synthesis";

export const qorDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export const qorContactHash = (email: string) => qorDigest(email.trim().toLowerCase());
export const qorContactLock = (tenantId: string, digest: string) =>
  `qor-contact:${tenantId}:${digest}`;
export const qorApplicationMarker = (requestId: string) => `qor-request:${requestId}`;

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
export const qorFingerprint = (value: unknown) => qorDigest(JSON.stringify(canonical(value)));

export class QorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const missingQorRequest = () => new QorError(404, "not_found", "Request unavailable.");
export const qorConflict = (message: string) => new QorError(409, "review_required", message);

type Session = typeof interviewSessionsTable.$inferSelect;
export function qorSessionStatus(
  session: Session | null,
  prepared: boolean,
): QorInterviewStatus["interview"]["status"] {
  if (!session) return prepared ? "needs_attention" : "awaiting_review";
  switch (session.status) {
    case "scheduled":
    case "invited":
      return "prepared";
    case "opened":
    case "verified":
    case "active":
    case "in_progress":
    case "paused":
    case "resumed":
      return "in_progress";
    case "completed":
    case "reviewed":
      return session.completedAt ? "completed" : "needs_attention";
    case "expired":
    case "abandoned":
      return session.status;
    default:
      return "needs_attention";
  }
}

const evidenceShape = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  competencies: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(200),
        evidence: z.string().trim().min(1).max(2000),
      }),
    )
    .max(30),
  limitations: z.array(z.string().trim().min(1).max(500)).max(25),
});
type Evidence = z.infer<typeof evidenceShape>;

function safeNarrative(value: string, sessionId: string) {
  return value
    .replaceAll(sessionId, "[redacted]")
    .replace(
      /\b(?:https?:\/\/|www\.)\S+|\/(?:interviews|objects|storage|api)\/[^\s)]+/gi,
      "[link removed]",
    )
    .replace(/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[contact removed]");
}

/** No live overlays, private notes, raw transcript, identity verification or decisions. */
export function qorEvidence(row: CandidateEvaluation, sessionId: string): Evidence | null {
  const raw = row.aiContent as EvaluationContent | null;
  if (
    row.approvalState !== "approved" ||
    !row.approvedAt ||
    !raw ||
    !hasJobBoundEvaluation(raw, row) ||
    raw.evidenceBasis?.provenance?.interviewSessionId !== sessionId ||
    raw.evidenceBasis.hasInterview !== true ||
    !(raw.evidenceBasis.interviewAnswers > 0) ||
    reviewEditsStatus(row) === "requires_review"
  )
    return null;
  try {
    const merged = mergeEvaluation(raw, row.humanEdits, row.competencyKeys, row);
    const text = (value: string) => safeNarrative(value, sessionId);
    const candidate = evidenceShape.safeParse({
      summary: text(merged.executiveSummary),
      competencies: merged.competencies
        .filter((entry) => !entry.insufficientEvidence && entry.evidence.trim())
        .map((entry) => ({ name: text(entry.label), evidence: text(entry.evidence) })),
      limitations: [
        ...new Set([
          ...(merged.assessmentQualityWarnings ?? []).map(text),
          ...merged.competencies
            .filter((entry) => entry.insufficientEvidence)
            .map((entry) => `Insufficient evidence: ${text(entry.label)}`),
        ]),
      ],
    });
    return candidate.success ? candidate.data : null;
  } catch {
    return null;
  }
}
