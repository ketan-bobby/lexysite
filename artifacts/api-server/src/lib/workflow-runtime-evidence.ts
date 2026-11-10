import { createHash } from "node:crypto";
import { interviewEvaluationWarning } from "./interview-turn-policy";
import { and, eq, inArray, or } from "drizzle-orm";
import {
  db,
  resumeScreensTable,
  sourcedCandidatesTable,
  verificationRecordsTable,
  outreachMessagesTable,
  interviewSessionsTable,
  interviewPlansTable,
  interviewSummariesTable,
  interviewSchedulesTable,
  applicationsTable,
  recruitingWorkflowsTable,
} from "@workspace/db";

type Workflow = typeof recruitingWorkflowsTable.$inferSelect;
type Handle = Pick<typeof db, "select">;
export type RuntimeEvidence = {
  id: string;
  stepKey: string;
  sourceType: string;
  sourceId: string;
  occurredAt: string;
  scope: "job" | "candidate_identity";
  summary: string;
  attentionRequired: boolean;
  readyForReview: boolean;
  reason: string | null;
};
export type Observation = Omit<RuntimeEvidence, "id" | "readyForReview" | "reason"> & {
  candidateId: string;
  initiatedAt: string;
  qualifies: boolean;
  version?: string;
};
const date = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : null;

/** Surface unresolved checks without treating a pending record as verification evidence. */
export function verificationActivity(
  status: string,
): Pick<Observation, "summary" | "attentionRequired" | "qualifies"> | null {
  if (!["verified", "review", "flagged", "rejected", "failed", "pending"].includes(status))
    return null;
  return {
    summary:
      status === "pending"
        ? "Candidate identity verification is pending or awaiting human resolution; it is not completed verification evidence."
        : `Candidate identity check: ${status}. This is not a job-fit assessment.`,
    attentionRequired: status !== "verified",
    qualifies: status !== "pending",
  };
}

export function runtimeEvidenceBlockedReason(
  workflow: Workflow,
  approved: boolean,
  currentJourney: boolean,
): string | null {
  if (!approved) return "Work order is not approved.";
  if (!currentJourney) return "The approved journey does not match the current brief and version.";
  if (workflow.status === "paused") return "Workflow is paused.";
  if (workflow.status === "cancelled" || workflow.status === "completed")
    return "Workflow is terminal.";
  return null;
}

/** Pure projection. Observed activity is never a human approval or execution authority. */
export function projectRuntimeEvidence(
  workflow: Workflow,
  observations: Observation[],
  blocked: string | null,
  now = new Date(),
): RuntimeEvidence[] {
  if (blocked && blocked !== "Workflow is paused." && blocked !== "Workflow is terminal.")
    return [];
  const terminal = workflow.status === "cancelled" || workflow.status === "completed";
  const ceiling = terminal ? workflow.updatedAt.getTime() : now.getTime();
  const eligible = observations.filter(
    (o) =>
      o.candidateId === workflow.candidateId &&
      workflow.steps.some((s) => s.key === o.stepKey) &&
      (o.sourceType !== "interview_assessment" ||
        workflow.steps.some((s) => s.key === "ai_interview")) &&
      (o.sourceType !== "human_interview_feedback" ||
        workflow.steps.some((s) => s.key === "human_interview")) &&
      // Pending identity may predate enrollment. Show it for resolution, never as completed evidence.
      ((o.sourceType === "identity_verification" && !o.qualifies) ||
        (Date.parse(o.initiatedAt) >= workflow.createdAt.getTime() &&
          Date.parse(o.occurredAt) >= workflow.createdAt.getTime())) &&
      Date.parse(o.occurredAt) <= ceiling,
  );
  return eligible
    .map((o): RuntimeEvidence => {
      const index = workflow.steps.findIndex((s) => s.key === o.stepKey);
      const preceding = workflow.steps.slice(0, index).every((s) => s.status === "completed");
      const positiveReplyBeforeInterview =
        !(
          ["ai_interview", "human_interview"].includes(o.stepKey) ||
          (o.stepKey === "evaluation_review" &&
            ["interview_assessment", "human_interview_feedback"].includes(o.sourceType))
        ) ||
        eligible.some(
          (reply) =>
            reply.stepKey === "engagement" &&
            reply.qualifies &&
            !reply.attentionRequired &&
            Date.parse(reply.occurredAt) <= Date.parse(o.initiatedAt),
        );
      const sequenceReason = positiveReplyBeforeInterview
        ? null
        : "No preceding positive reply is recorded for this workflow. Review any manual invitation.";
      const completedReason =
        workflow.steps[index]?.status === "completed"
          ? "This workflow step is already completed. Observations do not reopen it."
          : null;
      const reason =
        blocked ??
        completedReason ??
        sequenceReason ??
        (!o.qualifies
          ? o.sourceType === "identity_verification"
            ? "Identity verification is still pending. Completed verification evidence or a human resolution is required."
            : "This activity is not sufficient assessment or interest evidence."
          : null) ??
        (!preceding ? "Review and complete the preceding workflow steps first." : null);
      return {
        id: createHash("sha256")
          .update(
            JSON.stringify([
              workflow.id,
              workflow.journeyId,
              workflow.journeyVersion,
              o.stepKey,
              o.sourceType,
              o.sourceId,
              o.occurredAt,
              o.version ?? o.summary,
            ]),
          )
          .digest("hex"),
        stepKey: o.stepKey,
        sourceType: o.sourceType,
        sourceId: o.sourceId,
        occurredAt: o.occurredAt,
        scope: o.scope,
        summary: o.summary,
        attentionRequired: o.attentionRequired || !positiveReplyBeforeInterview,
        readyForReview: !reason,
        reason,
      };
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
}

/** Called only after job authorization and current candidate/privacy filtering. */
export async function readRuntimeObservations(
  handle: Handle,
  jobId: string,
  tenantId: string,
  candidates: { id: string; tenantId: string }[],
): Promise<Observation[]> {
  if (!candidates.length) return [];
  const ids = candidates.map((c) => c.id);
  const ownerIds = [...new Set([tenantId, ...candidates.map((c) => c.tenantId)])];
  const owners = new Map(candidates.map((c) => [c.id, c.tenantId]));
  const [screens, sourced, verifications, messages, interviews, human] = await Promise.all([
    handle
      .select()
      .from(resumeScreensTable)
      .where(
        and(
          eq(resumeScreensTable.jobId, jobId),
          inArray(resumeScreensTable.tenantId, ownerIds),
          inArray(resumeScreensTable.candidateId, ids),
        ),
      ),
    handle
      .select()
      .from(sourcedCandidatesTable)
      .where(
        and(
          inArray(sourcedCandidatesTable.tenantId, ownerIds),
          inArray(sourcedCandidatesTable.normalizedCandidateId, ids),
        ),
      ),
    handle
      .select()
      .from(verificationRecordsTable)
      .where(
        and(
          inArray(verificationRecordsTable.tenantId, ownerIds),
          inArray(verificationRecordsTable.candidateId, ids),
        ),
      ),
    handle
      .select({
        message: outreachMessagesTable,
        normalizedId: sourcedCandidatesTable.normalizedCandidateId,
      })
      .from(outreachMessagesTable)
      .leftJoin(
        sourcedCandidatesTable,
        eq(sourcedCandidatesTable.id, outreachMessagesTable.candidateId),
      )
      .where(
        and(
          eq(outreachMessagesTable.jobId, jobId),
          eq(outreachMessagesTable.tenantId, tenantId),
          or(
            inArray(outreachMessagesTable.candidateId, ids),
            and(
              inArray(sourcedCandidatesTable.normalizedCandidateId, ids),
              inArray(sourcedCandidatesTable.tenantId, ownerIds),
            ),
          ),
        ),
      ),
    handle
      .select({
        session: interviewSessionsTable,
        plan: interviewPlansTable,
        assessment: interviewSummariesTable,
      })
      .from(interviewSessionsTable)
      .innerJoin(interviewPlansTable, eq(interviewPlansTable.id, interviewSessionsTable.planId))
      .leftJoin(
        interviewSummariesTable,
        eq(interviewSummariesTable.interviewSessionId, interviewSessionsTable.id),
      )
      .where(
        and(
          eq(interviewPlansTable.jobId, jobId),
          eq(interviewPlansTable.tenantId, tenantId),
          eq(interviewSessionsTable.tenantId, tenantId),
          inArray(interviewSessionsTable.candidateId, ids),
        ),
      ),
    handle
      .select({ schedule: interviewSchedulesTable, candidateId: applicationsTable.candidateId })
      .from(interviewSchedulesTable)
      .innerJoin(applicationsTable, eq(applicationsTable.id, interviewSchedulesTable.applicationId))
      .where(
        and(
          eq(applicationsTable.jobId, jobId),
          eq(interviewSchedulesTable.tenantId, tenantId),
          inArray(applicationsTable.candidateId, ids),
        ),
      ),
  ]);
  const result: Observation[] = [];
  function add(
    candidateId: string,
    stepKey: string,
    sourceType: string,
    sourceId: string,
    at: Date | string | null,
    summary: string,
    attentionRequired = false,
    qualifies = true,
    initiated: Date | string | null = at,
    scope: Observation["scope"] = "job",
    version?: string,
  ) {
    if (!at || !initiated) return;
    result.push({
      candidateId,
      stepKey,
      sourceType,
      sourceId,
      occurredAt: date(at)!,
      initiatedAt: date(initiated)!,
      summary,
      attentionRequired,
      qualifies,
      scope,
      version,
    });
  }
  for (const s of screens) {
    if (s.tenantId !== tenantId && s.tenantId !== owners.get(s.candidateId)) continue;
    add(
      s.candidateId,
      "screening",
      "resume_screen",
      s.id,
      s.createdAt,
      `Job-specific résumé screen recorded · score ${s.screeningScore}/100.`,
      false,
      Number.isFinite(s.screeningScore),
      s.createdAt,
      "job",
      String(s.screeningScore),
    );
  }
  for (const s of sourced) {
    const raw = s.rawData as any;
    const binding = raw?.screeningEvidence;
    if (
      !s.normalizedCandidateId ||
      (s.tenantId !== tenantId && s.tenantId !== owners.get(s.normalizedCandidateId)) ||
      binding?.jobId !== jobId ||
      binding?.candidateId !== s.normalizedCandidateId ||
      typeof binding?.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(binding.recordedAt)) ||
      !raw.screeningResult ||
      !Number.isFinite(raw.screeningResult.score)
    )
      continue;
    add(
      s.normalizedCandidateId,
      "screening",
      "agent_screen",
      s.id,
      binding.recordedAt,
      `Job-specific agent screen recorded · score ${raw.screeningResult.score}/100 · ${raw.screeningResult.recommendation}.`,
      raw.screeningResult.recommendation !== "advance",
      true,
      binding.recordedAt,
      "job",
      JSON.stringify(raw.screeningResult),
    );
  }
  for (const v of verifications) {
    if (v.tenantId !== owners.get(v.candidateId)) continue;
    const activity = verificationActivity(v.status);
    if (!activity) continue;
    add(
      v.candidateId,
      "verification",
      "identity_verification",
      v.id,
      v.updatedAt,
      activity.summary,
      activity.attentionRequired,
      activity.qualifies,
      v.updatedAt,
      "candidate_identity",
      JSON.stringify([v.status, v.riskScore, v.flags, v.identityVerified]),
    );
  }
  for (const { message: m, normalizedId } of messages) {
    if (!m.sentAt) continue; // Draft, queued, failed and provider-acceptance-only records aren't replies.
    const candidateId = ids.includes(m.candidateId) ? m.candidateId : normalizedId;
    if (!candidateId || !ids.includes(candidateId)) continue;
    const positive =
      !!m.repliedAt &&
      m.replySentiment === "positive" &&
      ["sent", "replied", "opened"].includes(m.status) &&
      m.repliedAt.getTime() >= m.sentAt.getTime();
    add(
      candidateId,
      "engagement",
      "outreach_message",
      m.id,
      m.repliedAt ?? m.sentAt,
      m.repliedAt
        ? `Outreach reply recorded: ${m.replySentiment ?? "unclassified"}.`
        : "Outreach sent; no reply recorded.",
      !positive,
      positive,
      m.createdAt,
      "job",
      JSON.stringify([m.status, m.replySentiment, date(m.sentAt), date(m.repliedAt)]),
    );
  }
  for (const { session: s, assessment: a } of interviews) {
    if (s.status !== "completed" || !s.completedAt || !a) continue;
    const evaluationWarning = interviewEvaluationWarning(
      a.overallScore,
      a.recommendation,
      (s.answers ?? []) as { score?: unknown; answer?: unknown }[],
      s.totalQuestions,
    );
    add(
      s.candidateId,
      "ai_interview",
      "interview_assessment",
      a.id,
      s.completedAt,
      `Job interview completed and assessed · score ${a.overallScore}/100 · recommendation ${a.recommendation}. Human review required.${evaluationWarning ? ` ${evaluationWarning}` : ""}`,
      a.recommendation !== "yes" || !!evaluationWarning,
      true,
      s.createdAt,
      "job",
      JSON.stringify([s.id, a.overallScore, a.recommendation, s.answers, s.totalQuestions]),
    );
    add(
      s.candidateId,
      "evaluation_review",
      "interview_assessment",
      a.id,
      s.completedAt,
      `Saved job-interview evaluation available for human review.${evaluationWarning ? ` ${evaluationWarning}` : ""}`,
      !!evaluationWarning,
      true,
      s.createdAt,
      "job",
      JSON.stringify([s.id, a.overallScore, a.recommendation]),
    );
  }
  for (const { schedule: s, candidateId } of human) {
    if (/\b(ai|mock|baseline|practice)\b/i.test(s.type.replaceAll("_", " "))) continue;
    if (s.status !== "completed" || (s.feedbackRating == null && !s.feedbackNotes?.trim()))
      continue;
    add(
      candidateId,
      "human_interview",
      "human_interview_feedback",
      s.id,
      s.scheduledAt,
      "Human interview marked completed with saved feedback. Timestamp is its scheduled start.",
      false,
      true,
      s.createdAt,
      "job",
      JSON.stringify([s.feedbackRating, s.feedbackNotes]),
    );
    add(
      candidateId,
      "evaluation_review",
      "human_interview_feedback",
      s.id,
      s.scheduledAt,
      "Saved human-interview feedback available for evaluation review.",
      false,
      true,
      s.createdAt,
      "job",
      JSON.stringify([s.feedbackRating, s.feedbackNotes]),
    );
  }
  return result;
}
