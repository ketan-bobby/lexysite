import { createHash } from "node:crypto";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  icpTable,
  jobPipelinesTable,
  candidatesTable,
  verificationRecordsTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
  type WorkflowStep,
} from "@workspace/db";
import { readRuntimeObservations, projectRuntimeEvidence } from "./workflow-runtime-evidence";
import { restrictToRealCandidates } from "./synthetic-fixture-scope";

type Transaction = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Handle = Transaction | typeof dbAdmin;
export type WorkflowScope = {
  jobId: string;
  tenantId: string;
  actorId: string;
  actorName?: string;
  canApprove: boolean;
  canEdit?: boolean;
};
export class WorkflowConflict extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
function fail(message: string, status = 409): never {
  throw new WorkflowConflict(message, status);
}
export const approvedJob = (status: string) => status === "active";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}
export const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const scopeWhere = (scope: WorkflowScope) =>
  and(eq(journeys.jobId, scope.jobId), eq(journeys.tenantId, scope.tenantId));

export function journeySteps(path: string): WorkflowStep[] {
  const keys = [
    ["screening", "Screening evidence"],
    ["verification", "Verification evidence"],
    ["engagement", "Engagement evidence"],
    ...(path === "recruiter_choice"
      ? [["interview_choice", "Human choice of interview path"]]
      : path === "ai"
        ? [["ai_interview", "AI interview evidence"]]
        : path === "human"
          ? [["human_interview", "Human interview evidence"]]
          : path === "ai_then_human"
            ? [
                ["ai_interview", "AI interview evidence"],
                ["human_interview", "Human interview evidence"],
              ]
            : path === "human_then_ai"
              ? [
                  ["human_interview", "Human interview evidence"],
                  ["ai_interview", "AI interview evidence"],
                ]
              : fail("Unsupported interview path", 400)),
    ["evaluation_review", "Human evaluation review"],
    ["hiring_decision", "Human hiring decision"],
  ];
  return keys.map(([key, label]) => ({
    key,
    label,
    authority: "human_review",
    status: "pending",
    evidence: null,
  }));
}

export async function readBrief(handle: Pick<Handle, "select">, scope: WorkflowScope) {
  const [job] = await handle
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, scope.jobId), eq(jobsTable.tenantId, scope.tenantId)));
  if (!job) fail("Not found", 404);
  const [icp] = await handle
    .select()
    .from(icpTable)
    .where(and(eq(icpTable.jobId, scope.jobId), eq(icpTable.tenantId, scope.tenantId)))
    .orderBy(desc(icpTable.version))
    .limit(1);
  const [pipeline] = await handle
    .select({
      interviewTypes: jobPipelinesTable.interviewTypes,
      interviewDirection: jobPipelinesTable.interviewDirection,
    })
    .from(jobPipelinesTable)
    .where(
      and(eq(jobPipelinesTable.jobId, scope.jobId), eq(jobPipelinesTable.tenantId, scope.tenantId)),
    );
  const icpBrief = icp
    ? Object.fromEntries(
        Object.entries(icp).filter(
          ([key]) => !["id", "tenantId", "jobId", "createdAt", "updatedAt"].includes(key),
        ),
      )
    : null;
  const brief = {
    title: job.title,
    description: job.description,
    department: job.department,
    location: job.location,
    workType: job.workType,
    employmentType: job.employmentType,
    language: job.language,
    salaryMin: job.salaryMin,
    salaryMax: job.salaryMax,
    internalMobility: job.internalMobility,
    isConfidential: job.isConfidential,
    platformRecommendationsEnabled: job.platformRecommendationsEnabled,
    aedtEnabled: job.aedtEnabled,
    recruitingMode: job.recruitingMode,
    interviewPath: job.interviewPath,
    icp: icpBrief,
    interview: pipeline ?? null,
  };
  return { job, brief, hash: fingerprint(brief) };
}

type MutationInput = { idempotencyKey: string };
export async function atomic<T extends MutationInput>(
  scope: WorkflowScope,
  operation: string,
  input: T,
  perform: (
    tx: Transaction,
  ) => Promise<{ id: string; workflowId?: string; journeyId?: string; note?: string }>,
  beforeJobLock?: (tx: Transaction) => Promise<void>,
) {
  return dbAdmin.transaction(async (tx) => {
    await beforeJobLock?.(tx);
    // Cross-process serialization; job lock also coordinates ordinary requisition edits.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recruiting-workflow:${scope.jobId}`},0))`,
    );
    const [job] = await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, scope.jobId), eq(jobsTable.tenantId, scope.tenantId)))
      .for("update");
    if (!job) fail("Not found", 404);
    const hash = fingerprint({ operation, input, actorId: scope.actorId });
    const [receipt] = await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.tenantId, scope.tenantId),
          eq(receipts.jobId, scope.jobId),
          eq(receipts.key, input.idempotencyKey),
        ),
      );
    if (receipt) {
      if (receipt.requestHash !== hash)
        fail("Idempotency key was already used for a different request");
      return { id: receipt.resultId, replayed: true, autonomyExecutionEnabled: false as const };
    }
    const result = await perform(tx);
    if (result.workflowId) {
      const { syncOfferNotifications } = await import("./offer-notifications");
      await syncOfferNotifications(
        tx,
        scope,
        result.workflowId,
        operation.startsWith("offer.") &&
          !["offer.recipient_response", "offer.delivery_result"].includes(operation),
      );
    }
    await tx.insert(events).values({
      tenantId: scope.tenantId,
      jobId: scope.jobId,
      actorId: scope.actorId,
      action: operation,
      workflowId: result.workflowId ?? null,
      journeyId: result.journeyId ?? null,
      note: result.note ?? null,
    });
    await tx.insert(receipts).values({
      tenantId: scope.tenantId,
      jobId: scope.jobId,
      key: input.idempotencyKey,
      requestHash: hash,
      resultId: result.id,
    });
    return { id: result.id, replayed: false, autonomyExecutionEnabled: false as const };
  });
}

async function currentJourney(tx: Transaction, scope: WorkflowScope, id: string) {
  const [journey] = await tx
    .select()
    .from(journeys)
    .where(and(scopeWhere(scope), eq(journeys.id, id)));
  if (!journey) fail("Not found", 404);
  const current = await readBrief(tx, scope);
  if (journey.briefHash !== current.hash)
    fail(
      "The brief changed. Capture and approve a new journey; existing workflows are not rerouted.",
    );
  return { journey, current };
}

export async function draftJourney(
  scope: WorkflowScope,
  input: MutationInput & { expectedBriefHash: string },
) {
  return atomic(scope, "journey.drafted", input, async (tx) => {
    const current = await readBrief(tx, scope);
    if (current.hash !== input.expectedBriefHash)
      fail("The brief changed. Refresh before capturing a draft.");
    const [last] = await tx
      .select({ version: journeys.version })
      .from(journeys)
      .where(scopeWhere(scope))
      .orderBy(desc(journeys.version))
      .limit(1);
    const [row] = await tx
      .insert(journeys)
      .values({
        tenantId: scope.tenantId,
        jobId: scope.jobId,
        version: (last?.version ?? 0) + 1,
        briefHash: current.hash,
        brief: current.brief,
        interviewPath: current.job.interviewPath,
        steps: journeySteps(current.job.interviewPath),
        createdById: scope.actorId,
      })
      .returning();
    return { id: row.id, journeyId: row.id };
  });
}

export async function approveJourney(
  scope: WorkflowScope,
  journeyId: string,
  input: MutationInput & { expectedBriefHash: string },
) {
  if (!scope.canApprove) fail("Human approver role required", 403);
  return atomic(scope, "journey.approved", { ...input, journeyId }, async (tx) => {
    const { journey, current } = await currentJourney(tx, scope, journeyId);
    if (current.hash !== input.expectedBriefHash)
      fail("The brief changed. Refresh before approving.");
    if (!approvedJob(current.job.status))
      fail("The requisition must be approved before its journey can be approved.");
    if (journey.status !== "draft") fail("Journey already approved. Its snapshot is immutable.");
    await tx
      .update(journeys)
      .set({ status: "approved", approvedById: scope.actorId, approvedAt: new Date() })
      .where(and(scopeWhere(scope), eq(journeys.id, journeyId)));
    return { id: journeyId, journeyId };
  });
}

export async function enrollWorkflow(
  scope: WorkflowScope,
  input: MutationInput & {
    journeyId: string;
    candidateId: string;
    expectedBriefHash: string;
    interviewPath?: string;
  },
  candidateAllowed: (tx: Transaction, candidateId: string) => Promise<boolean>,
) {
  return atomic(scope, "workflow.enrolled", input, async (tx) => {
    const { journey, current } = await currentJourney(tx, scope, input.journeyId);
    if (current.hash !== input.expectedBriefHash)
      fail("The brief changed. Refresh before enrolling.");
    if (journey.status !== "approved" || !approvedJob(current.job.status)) {
      fail("An approved journey and live requisition are required for enrollment.");
    }
    if (!(await candidateAllowed(tx, input.candidateId))) fail("Not found", 404);
    const path =
      journey.interviewPath === "recruiter_choice" ? input.interviewPath : journey.interviewPath;
    if (!path || path === "recruiter_choice")
      fail("Choose an explicit interview path for this candidate", 400);
    if (input.interviewPath && input.interviewPath !== path)
      fail("Candidate path must match the approved journey", 400);
    const [open] = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, scope.tenantId),
          eq(workflows.jobId, scope.jobId),
          eq(workflows.candidateId, input.candidateId),
          sql`${workflows.status} IN ('ready','paused')`,
        ),
      );
    if (open) fail("This candidate already has an open workflow for this requisition.");
    const [row] = await tx
      .insert(workflows)
      .values({
        tenantId: scope.tenantId,
        jobId: scope.jobId,
        candidateId: input.candidateId,
        journeyId: journey.id,
        journeyVersion: journey.version,
        interviewPath: path,
        steps: journeySteps(path),
        createdById: scope.actorId,
      })
      .returning();
    return { id: row.id, workflowId: row.id, journeyId: journey.id };
  });
}

async function lockedWorkflow(tx: Transaction, scope: WorkflowScope, id: string, revision: number) {
  const [row] = await tx
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, scope.tenantId),
        eq(workflows.jobId, scope.jobId),
        eq(workflows.id, id),
      ),
    )
    .for("update");
  if (!row) fail("Not found", 404);
  if (row.revision !== revision) fail("Workflow changed. Refresh before applying this action.");
  if (["cancelled", "completed"].includes(row.status))
    fail("This workflow is terminal. History is retained.");
  return row;
}

export async function controlWorkflow(
  scope: WorkflowScope,
  workflowId: string,
  input: MutationInput & { expectedRevision: number; action: "pause" | "resume" | "cancel" },
  candidateAllowed: (tx: Transaction, candidateId: string) => Promise<boolean>,
) {
  return atomic(scope, `workflow.${input.action}`, { ...input, workflowId }, async (tx) => {
    const row = await lockedWorkflow(tx, scope, workflowId, input.expectedRevision);
    if (input.action === "resume") {
      const { current } = await currentJourney(tx, scope, row.journeyId);
      if (!(await candidateAllowed(tx, row.candidateId))) fail("Not found", 404);
      if (!approvedJob(current.job.status)) fail("Resume requires a live approved requisition.");
      if (row.status !== "paused") fail("Only paused workflows can resume.");
    }
    if (input.action === "pause" && row.status !== "ready") fail("Only ready workflows can pause.");
    const status =
      input.action === "cancel" ? "cancelled" : input.action === "pause" ? "paused" : "ready";
    const steps =
      input.action === "cancel"
        ? row.steps.map((s) =>
            s.status === "completed" ? s : { ...s, status: "cancelled" as const },
          )
        : row.steps;
    await tx
      .update(workflows)
      .set({ status, steps, revision: row.revision + 1, updatedAt: new Date() })
      .where(
        and(
          eq(workflows.id, row.id),
          eq(workflows.jobId, scope.jobId),
          eq(workflows.tenantId, scope.tenantId),
        ),
      );
    return { id: row.id, workflowId: row.id, journeyId: row.journeyId };
  });
}

export async function recordWorkflowEvidence(
  scope: WorkflowScope,
  workflowId: string,
  input: MutationInput & {
    expectedRevision: number;
    stepKey: string;
    status: "completed" | "review_required" | "failed";
    evidence: string;
    runtimeEvidenceId?: string;
    decision?: "hire" | "hold" | "decline";
  },
  candidateAllowed: (tx: Transaction, candidateId: string) => Promise<boolean>,
) {
  return atomic(scope, "workflow.evidence_recorded", { ...input, workflowId }, async (tx) => {
    const row = await lockedWorkflow(tx, scope, workflowId, input.expectedRevision);
    const { current } = await currentJourney(tx, scope, row.journeyId);
    if (row.status !== "ready" || !approvedJob(current.job.status))
      fail("Workflow and requisition must be ready before recording new work.");
    if (!(await candidateAllowed(tx, row.candidateId))) fail("Not found", 404);
    const next = row.steps.find((s) => s.status !== "completed");
    if (!next || next.key !== input.stepKey) fail("Complete or review the preceding step first.");
    if (next.key === "hiring_decision" && !scope.canApprove)
      fail("Final hiring decisions require a human approver", 403);
    if (input.decision && next.key !== "hiring_decision")
      fail("A human hiring outcome belongs only on the final decision step.", 400);
    if (next.key === "hiring_decision" && input.status === "completed" && !input.decision)
      fail("Choose Hire or Decline before completing the human decision.", 400);
    if (
      input.decision &&
      (input.status !== (input.decision === "hold" ? "review_required" : "completed") ||
        input.evidence.trim().length < 10)
    )
      fail(
        "Hold requires review required; Hire/Decline require completed and a reason of at least 10 characters.",
        400,
      );
    let humanDecision: WorkflowStep["humanDecision"];
    if (input.decision) {
      const [candidate] = await tx
        .select({
          eligibleForRealHiring: sql<boolean>`${restrictToRealCandidates(candidatesTable.id)}`,
        })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, row.candidateId));
      if (!candidate) fail("Not found", 404);
      humanDecision = {
        outcome: input.decision,
        actorId: scope.actorId,
        actorName: scope.actorName?.trim() || scope.actorId,
        decidedAt: new Date().toISOString(),
        reason: input.evidence.trim(),
        testOnly: candidate.eligibleForRealHiring !== true,
      };
    }
    let evidence = input.evidence.trim();
    if (next.key === "verification" && input.status === "completed") {
      const [candidate] = await tx
        .select({
          tenantId: candidatesTable.tenantId,
          status: candidatesTable.verificationStatus,
        })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, row.candidateId));
      const [identity] = candidate?.tenantId
        ? await tx
            .select()
            .from(verificationRecordsTable)
            .where(
              and(
                eq(verificationRecordsTable.candidateId, row.candidateId),
                eq(verificationRecordsTable.tenantId, candidate.tenantId),
              ),
            )
        : [];
      if (
        candidate?.status !== "verified" ||
        identity?.status !== "verified" ||
        identity.identityVerified !== true
      )
        fail(
          "AI advice or a manual note cannot complete identity verification. Resolve identity with independent corroboration or an explicit workflow-only synthetic-test clearance.",
        );
      if (!input.runtimeEvidenceId)
        evidence = `Reviewed saved corroborated identity ${identity.id}. ${evidence}`;
    }
    if (input.runtimeEvidenceId) {
      const [candidate] = await tx
        .select({ id: candidatesTable.id, tenantId: candidatesTable.tenantId })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, row.candidateId));
      if (!candidate) fail("Not found", 404);
      const observations = await readRuntimeObservations(tx, scope.jobId, scope.tenantId, [
        candidate,
      ]);
      const selected = projectRuntimeEvidence(row, observations, null).find(
        (entry) => entry.id === input.runtimeEvidenceId && entry.stepKey === next.key,
      );
      if (!selected?.readyForReview)
        fail(
          "Source evidence changed, is out of sequence, or is not sufficient. Refresh before reviewing.",
        );
      evidence = `Reviewed saved source ${selected.sourceType}:${selected.sourceId} at ${selected.occurredAt} [${selected.id}]. ${evidence}`;
    }
    const steps = row.steps.map((s) =>
      s.key === next.key
        ? {
            ...s,
            status: input.status,
            evidence,
            ...(humanDecision
              ? {
                  humanDecision,
                  humanDecisionHistory: [
                    ...(s.humanDecisionHistory ?? []),
                    ...(s.humanDecision ? [s.humanDecision] : []),
                  ],
                }
              : {}),
          }
        : s,
    );
    await tx
      .update(workflows)
      .set({
        steps,
        revision: row.revision + 1,
        updatedAt: new Date(),
        status: steps.every((s) => s.status === "completed") ? "completed" : "ready",
      })
      .where(
        and(
          eq(workflows.id, row.id),
          eq(workflows.jobId, scope.jobId),
          eq(workflows.tenantId, scope.tenantId),
        ),
      );
    return {
      id: row.id,
      workflowId: row.id,
      journeyId: row.journeyId,
      note: humanDecision
        ? `${next.key}: ${humanDecision.outcome}${humanDecision.testOnly ? " [TEST ONLY — not a hiring outcome]" : " [decision only — not confirmed employment]"}. ${humanDecision.actorName} (${humanDecision.actorId}) at ${humanDecision.decidedAt}. Reason: ${humanDecision.reason}`
        : `${next.key}: ${input.status}. ${evidence}`,
    };
  });
}
