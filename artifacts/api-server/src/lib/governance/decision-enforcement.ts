/**
 * governance/decision-enforcement.ts — THE central enforcement service.
 *
 * ─── Why this file is the choke point ────────────────────────────────────────
 * Per the design spec: every materially-adverse automated outcome MUST
 * route through this service. If you find yourself writing
 * `applications.stage = 'rejected'` (or 'lapsed', or 'hold' in a gated
 * jurisdiction) anywhere else in the codebase, you are creating a
 * compliance bypass. The architect review explicitly scans for that.
 *
 * Allowed direct writes from elsewhere (NOT routed through here):
 *   - advancement (advance, schedule, hold-but-not-gated, hire)
 *   - candidate-initiated withdrawal
 *   - sourcing-stage mutations (sourced → applied, etc) — these are
 *     non-adverse pipeline movements, not decisions
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 * For AI-initiated adverse intents:
 *   evaluateAndApplyAi({...})
 *     1. classifyJurisdictions(candidateLoc, jobLoc) → list
 *     2. resolveActivePolicy(jurisdictions, tenantId)
 *     3. If policy.gateRejects (for reject intent) OR gateLapsed (for
 *        lapsed intent): write applications.ai_recommendation only
 *        (final_decision stays NULL). Record a 'decision_created' +
 *        'policy_applied' decision_event. Return { gated: true, ...
 *        applicationId } so the caller knows the candidate now sits
 *        in the human-review queue.
 *     4. If not gated: still write ai_recommendation AND record a
 *        decision_event, but ALSO allow the caller to proceed with the
 *        existing legacy stage write (current `applications.stage`
 *        column is left in caller's hands for backward compatibility
 *        with all the existing dashboard/UI queries). final_decision
 *        is still NOT set automatically — the law calls for a human
 *        attestation even where geography doesn't force it, so the
 *        recruiter UI surfaces a one-click confirm.
 *
 * For human-initiated decisions (manual recruiter reject, etc.):
 *   applyHumanDecision({...})
 *     Writes applications.final_decision + final_decision_by/at/
 *     attestation/reason, optionally clears any pending
 *     ai_recommendation, records 'decision_reviewed' or
 *     'decision_overridden' event. The DB CHECK constraint guarantees
 *     final_decision can never carry an ai_* value.
 *
 * ─── Return semantics ────────────────────────────────────────────────────────
 * evaluateAndApplyAi returns { gated, jurisdictions, policyVersionId }.
 * Callers MUST honour `gated: true` by NOT subsequently writing
 * applications.stage = 'rejected'. The grep for legacy reject paths is
 * the architect's check.
 */
import { db } from "@workspace/db";
import { applicationsTable, jobsTable, candidatesTable } from "@workspace/db";
import type { AiRecommendation, FinalDecision } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import { classifyJurisdictions } from "./jurisdictions.js";
import type { JurisdictionCode } from "./jurisdictions.js";
import { resolveActivePolicy } from "./policy-resolver.js";
import { recordDecisionEvent } from "./decision-events.js";
import type { ActorKind } from "./decision-events.js";

export interface EvaluateAiInput {
  applicationId: string;
  intendedAction: "reject" | "lapsed" | "hold" | "advance" | "flag_fraud" | "no_recommendation";
  aiRecommendation: AiRecommendation;
  modelId?: string | null;
  modelVersion?: string | null;
  promptVersion?: string | null;
  scoringVersion?: string | null;
  orchestrationVersion?: string | null;
  score?: number | null;
  rationale?: string | null;
  candidateLocationOverride?: string | null;
  jobLocationOverride?: string | null;
}

export interface EvaluateAiResult {
  gated: boolean;
  jurisdictions: JurisdictionCode[];
  policyVersionId: string | null;
  applicationId: string;
  /** True means the caller MUST NOT subsequently write
   *  applications.stage to an adverse value (rejected, withdrawn-as-
   *  reject, etc). The candidate now sits in the human review queue. */
  blockLegacyStageWrite: boolean;
}

/**
 * Resolve all the context we need (application row + candidate + job
 * locations) and return null if the application is missing. Keeps the
 * main flow short and the error path explicit.
 */
async function loadContext(applicationId: string) {
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId))
    .limit(1);
  if (!app) return null;

  const [candidate] = await db
    .select({ id: candidatesTable.id, location: candidatesTable.location })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, app.candidateId))
    .limit(1);

  const [job] = await db
    .select({ id: jobsTable.id, location: jobsTable.location })
    .from(jobsTable)
    .where(eq(jobsTable.id, app.jobId))
    .limit(1);

  return { app, candidate, job };
}

/**
 * AI is intending an action against this application. Route it through
 * the gate. Always records an audit event. Writes ai_recommendation if
 * appropriate. Never writes final_decision (DB CHECK enforces this).
 */
export async function evaluateAndApplyAi(input: EvaluateAiInput): Promise<EvaluateAiResult> {
  const ctx = await loadContext(input.applicationId);
  if (!ctx) {
    logger.warn({ applicationId: input.applicationId }, "[governance] application not found");
    return {
      gated: false,
      jurisdictions: [],
      policyVersionId: null,
      applicationId: input.applicationId,
      blockLegacyStageWrite: false,
    };
  }
  const { app, candidate, job } = ctx;
  const candidateLocation = input.candidateLocationOverride ?? candidate?.location ?? null;
  const jobLocation = input.jobLocationOverride ?? job?.location ?? null;

  const jurisdictions = classifyJurisdictions(candidateLocation, jobLocation);
  const policy = await resolveActivePolicy(jurisdictions, app.tenantId, new Date());

  const isAdverse =
    input.intendedAction === "reject" ||
    input.intendedAction === "lapsed" ||
    (input.intendedAction === "hold" && policy.gateHolds);

  /* Decide gating. For non-adverse intents we still record the AI
   * recommendation but do not block anything. */
  const gated =
    isAdverse &&
    ((input.intendedAction === "reject" && policy.gateRejects) ||
      (input.intendedAction === "lapsed" && policy.gateLapsed) ||
      (input.intendedAction === "hold" && policy.gateHolds));

  /* Persist ai_recommendation on the application row regardless of
   * gating — the recruiter UI needs to see it either way. Importantly
   * we do NOT touch final_decision here; the DB CHECK constraint
   * would reject it without a human actor anyway. */
  await db
    .update(applicationsTable)
    .set({
      aiRecommendation: input.aiRecommendation,
      aiRecommendationAt: new Date(),
      aiRecommendationModel: input.modelId ?? input.modelVersion ?? null,
      aiRecommendationScore: input.score ?? null,
      gatedByJurisdiction: gated ? jurisdictions : app.gatedByJurisdiction ?? [],
      policyVersionId: policy.policyVersionIds[0] ?? null,
      updatedAt: new Date(),
    })
    .where(eq(applicationsTable.id, input.applicationId));

  /* Audit events. We split into two rows so an auditor can filter on
   * `event_type='policy_applied'` to see every time a gate fired. */
  await recordDecisionEvent({
    tenantId: app.tenantId,
    applicationId: input.applicationId,
    candidateId: app.candidateId,
    jobId: app.jobId,
    eventType: "decision_created",
    actorUserId: null,
    actorKind: "ai",
    aiRecommendation: input.aiRecommendation,
    finalDecision: null,
    rationale: input.rationale ?? null,
    modelId: input.modelId ?? null,
    modelVersion: input.modelVersion ?? null,
    promptVersion: input.promptVersion ?? null,
    scoringVersion: input.scoringVersion ?? null,
    orchestrationVersion: input.orchestrationVersion ?? null,
    policyVersionId: policy.policyVersionIds[0] ?? null,
    jurisdictions,
    payload: {
      intendedAction: input.intendedAction,
      score: input.score ?? null,
      candidateLocation,
      jobLocation,
      allPolicyVersionIds: policy.policyVersionIds,
      contributingBasis: policy.contributingBasis,
    },
  });

  if (gated) {
    await recordDecisionEvent({
      tenantId: app.tenantId,
      applicationId: input.applicationId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      eventType: "policy_applied",
      actorUserId: null,
      actorKind: "system",
      aiRecommendation: input.aiRecommendation,
      finalDecision: null,
      rationale: `Adverse AI action gated by ${jurisdictions.join(", ")} policy. Awaiting human review.`,
      policyVersionId: policy.policyVersionIds[0] ?? null,
      jurisdictions,
      payload: {
        intendedAction: input.intendedAction,
        gateReason: "platform_floor",
        allPolicyVersionIds: policy.policyVersionIds,
      },
    });
  }

  return {
    gated,
    jurisdictions,
    policyVersionId: policy.policyVersionIds[0] ?? null,
    applicationId: input.applicationId,
    blockLegacyStageWrite: gated,
  };
}

export interface ApplyHumanDecisionInput {
  applicationId: string;
  finalDecision: FinalDecision;
  decidedByUserId: string;
  decidedByRole: ActorKind;
  attestation: string;
  reason?: string | null;
  /** When the human is reviewing a prior AI recommendation, pass it so
   *  we record decision_reviewed vs decision_overridden. */
  priorAiRecommendation?: AiRecommendation | null;
}

export interface ApplyHumanDecisionResult {
  ok: boolean;
  applicationId: string;
  wasOverride: boolean;
  error?: string;
}

/**
 * Human (recruiter / admin / hiring manager) is recording a final
 * decision on an application. Writes the final_decision* columns and
 * the audit event. The DB CHECK constraints enforce that
 * final_decision is non-null only when final_decision_by is set
 * (or the row is legacy).
 */
export async function applyHumanDecision(
  input: ApplyHumanDecisionInput,
): Promise<ApplyHumanDecisionResult> {
  const ctx = await loadContext(input.applicationId);
  if (!ctx) {
    return { ok: false, applicationId: input.applicationId, wasOverride: false, error: "application_not_found" };
  }
  const { app } = ctx;

  if (!input.attestation || input.attestation.trim().length === 0) {
    return { ok: false, applicationId: input.applicationId, wasOverride: false, error: "attestation_required" };
  }

  const prior = input.priorAiRecommendation ?? app.aiRecommendation ?? null;
  const recommendedHuman = aiToHumanCounterpart(prior);
  const wasOverride =
    recommendedHuman !== null && input.finalDecision !== recommendedHuman;

  await db
    .update(applicationsTable)
    .set({
      finalDecision: input.finalDecision,
      finalDecisionBy: input.decidedByUserId,
      finalDecisionAt: new Date(),
      finalDecisionAttestation: input.attestation,
      finalDecisionReason: input.reason ?? null,
      updatedAt: new Date(),
    })
    .where(eq(applicationsTable.id, input.applicationId));

  await recordDecisionEvent({
    tenantId: app.tenantId,
    applicationId: input.applicationId,
    candidateId: app.candidateId,
    jobId: app.jobId,
    eventType: wasOverride ? "decision_overridden" : "decision_reviewed",
    actorUserId: input.decidedByUserId,
    actorKind: input.decidedByRole,
    aiRecommendation: prior,
    finalDecision: input.finalDecision,
    rationale: input.reason ?? null,
    attestation: input.attestation,
    policyVersionId: app.policyVersionId ?? null,
    jurisdictions: app.gatedByJurisdiction ?? [],
    payload: {
      priorAiRecommendation: prior,
      wasOverride,
    },
  });

  return { ok: true, applicationId: input.applicationId, wasOverride };
}

/** Map an AI recommendation to the "non-override" human counterpart. */
function aiToHumanCounterpart(ai: AiRecommendation | null): FinalDecision | null {
  if (!ai) return null;
  switch (ai) {
    case "advance":    return "human_advance";
    case "reject":     return "human_reject";
    case "hold":       return "human_hold";
    case "lapsed":     return "human_lapsed";
    case "flag_fraud": return "human_hold";   // fraud-flag → human review → typically hold
    case "no_recommendation": return null;
  }
}
