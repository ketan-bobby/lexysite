/**
 * governance/decision-events.ts — Immutable Audit Event Writer
 *
 * Single insert path for the append-only `decision_events` table. The
 * table has BEFORE UPDATE / BEFORE DELETE triggers that raise an
 * exception on any mutation, so this writer can never modify history —
 * a misbehaving service simply cannot rewrite an event after the fact.
 *
 * Every gated AI recommendation, human confirmation, override, appeal
 * request, and policy application writes a row here. This is the table
 * the LL144 independent auditor reads, the CO AG would subpoena, and
 * SOC2 evidence collection draws from.
 *
 * ─── Best-effort design ──────────────────────────────────────────────────────
 * recordDecisionEvent() catches insert failures and logs loudly. We
 * never throw to the caller because losing the candidate's user-facing
 * flow over an audit-log hiccup is the wrong trade. Failures show up
 * in the api-server logs as `[governance] decision_event insert failed`
 * and are alertable.
 */
import { db } from "@workspace/db";
import { decisionEventsTable } from "@workspace/db";
import type { AiRecommendation, FinalDecision } from "@workspace/db";
import { logger } from "../logger.js";

export type DecisionEventType =
  | "decision_created"      // AI produced a recommendation (gated or not)
  | "decision_reviewed"     // human confirmed AI recommendation
  | "decision_overridden"   // human chose a different decision than AI
  | "appeal_requested"      // candidate (or proxy) filed an appeal
  | "appeal_completed"      // appeal resolved
  | "policy_applied"        // a jurisdiction policy gated an automated path
  | "disclosure_shown";     // candidate-facing notice rendered

export type ActorKind =
  | "system"
  | "ai"
  | "recruiter"
  | "tenant_admin"
  | "hiring_manager"
  | "platform_admin"
  | "candidate";

export interface RecordDecisionEventInput {
  tenantId: string;
  applicationId?: string | null;
  candidateId?: string | null;
  jobId?: string | null;
  eventType: DecisionEventType;
  actorUserId?: string | null;
  actorKind: ActorKind;
  aiRecommendation?: AiRecommendation | null;
  finalDecision?: FinalDecision | null;
  rationale?: string | null;
  attestation?: string | null;
  modelId?: string | null;
  modelVersion?: string | null;
  promptVersion?: string | null;
  scoringVersion?: string | null;
  orchestrationVersion?: string | null;
  policyVersionId?: string | null;
  jurisdictions?: string[];
  disclosureVersionId?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordDecisionEvent(
  input: RecordDecisionEventInput,
): Promise<{ id: string | null }> {
  try {
    const [row] = await db
      .insert(decisionEventsTable)
      .values({
        tenantId: input.tenantId,
        applicationId: input.applicationId ?? null,
        candidateId: input.candidateId ?? null,
        jobId: input.jobId ?? null,
        eventType: input.eventType,
        actorUserId: input.actorUserId ?? null,
        actorKind: input.actorKind,
        aiRecommendation: input.aiRecommendation ?? null,
        finalDecision: input.finalDecision ?? null,
        rationale: input.rationale ?? null,
        attestation: input.attestation ?? null,
        modelId: input.modelId ?? null,
        modelVersion: input.modelVersion ?? null,
        promptVersion: input.promptVersion ?? null,
        scoringVersion: input.scoringVersion ?? null,
        orchestrationVersion: input.orchestrationVersion ?? null,
        policyVersionId: input.policyVersionId ?? null,
        jurisdictions: input.jurisdictions ?? [],
        disclosureVersionId: input.disclosureVersionId ?? null,
        payload: input.payload ?? {},
      })
      .returning({ id: decisionEventsTable.id });
    return { id: row?.id ?? null };
  } catch (err: any) {
    logger.error(
      { err: err?.message, eventType: input.eventType, applicationId: input.applicationId },
      "[governance] decision_event insert failed",
    );
    return { id: null };
  }
}
