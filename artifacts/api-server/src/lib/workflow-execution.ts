/**
 * Execution boundary for explicitly workflow-bound actions. A durable claim is
 * the action-start point, serialized with Pause/Cancel by the existing job lock.
 * No provider request holds a database transaction open.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  usersTable,
  candidatesTable,
  recruitingWorkflowsTable as workflows,
  recruitingJourneysTable as journeys,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import {
  atomic,
  approvedJob,
  journeySteps,
  readBrief,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { getDataScopeTenantIds, recruiterIsAssignedToJob } from "./tenantUtils";
import { workflowScreeningReadiness } from "./workflow-profile-screening";
import { assertWorkflowPilotAllowed } from "./workflow-live-pilot";
import { workflowActionKey, WorkflowPreEffectError } from "./workflow-action-recovery";
import { vendorUsageScope } from "./vendor-usage";

type Transaction = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
export type WorkflowActionInput = {
  idempotencyKey: string;
  workflowId: string;
  candidateId: string;
  journeyId: string;
  journeyVersion: number;
  expectedRevision: number;
  stepKey: string;
  actionKind: "agent" | "outreach_send";
  /** Fingerprint of the action payload, never the recipient/body itself. */
  payloadHash: string;
};
export type CandidateAllowed = (tx: Transaction, candidateId: string) => Promise<boolean>;
export type WorkflowActionAdapter<T> = {
  mode: "controlled_test" | "live";
  maxDurationMs?: number;
  /** Read-only preparation. Execution authority is rechecked after this returns. */
  prepare?: (signal: AbortSignal) => Promise<void>;
  invoke: (signal: AbortSignal) => Promise<T>;
  isSuccessful?: (output: T) => boolean;
  /** Trusted native marker, not caller-supplied output or missing telemetry. */
  preEffectFailure?: (output: T) => string | null;
};
export type WorkflowActionResult<T> =
  | { attemptId: string; state: "succeeded"; replayed: false; output: T }
  | { attemptId: string; state: "already_claimed"; replayed: true }
  | { attemptId: string; state: "unknown" | "no_effect"; replayed: false };
// A known pre-effect result requires explicit human recovery, never auto-retry.
export type WorkflowActionContext = {
  scope: WorkflowScope;
  input: WorkflowActionInput;
  candidateAllowed: CandidateAllowed;
};
const EXECUTABLE = ["screening", "verification", "engagement", "ai_interview", "human_interview"];
const STAFF = ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"];
const fail = (message: string, status = 409): never => {
  throw new WorkflowConflict(message, status);
};

async function jobLock(tx: Transaction, scope: WorkflowScope) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recruiting-workflow:${scope.jobId}`},0))`,
  );
  const [job] = await tx
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, scope.jobId), eq(jobsTable.tenantId, scope.tenantId)))
    .for("update");
  if (!job) fail("Not found", 404);
}

export async function assertWorkflowActionReadyInTransaction(
  tx: Transaction,
  scope: WorkflowScope,
  input: WorkflowActionInput,
  candidateAllowed: CandidateAllowed,
  allowReview = false,
) {
  const [actor] = await tx.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
  if (!actor || actor.status !== "active") fail("Unauthorized", 401);
  if (!STAFF.includes(actor.role)) fail("Staff execution authority required", 403);
  const { job, hash } = await readBrief(tx, scope);
  const allowed = await getDataScopeTenantIds(actor);
  if (
    (allowed !== null && !allowed.includes(job.tenantId)) ||
    (actor.role === "recruiter" && !(await recruiterIsAssignedToJob(actor.id, job))) ||
    (actor.role === "hiring_manager" && job.assignedHiringManagerId !== actor.id)
  )
    fail("Not found", 404);
  if (!approvedJob(job.status) || job.recruitingMode !== "lexy_autonomous")
    fail("An approved autonomous requisition is required.");
  const [wf] = await tx
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, input.workflowId),
        eq(workflows.tenantId, scope.tenantId),
        eq(workflows.jobId, scope.jobId),
      ),
    )
    .for("update");
  if (!wf) fail("Not found", 404);
  if (wf.candidateId !== input.candidateId) fail("Not found", 404);
  if (wf.status !== "ready") fail(`Workflow is ${wf.status}; no new action may begin.`);
  if (wf.revision !== input.expectedRevision) fail("Workflow changed. Refresh before executing.");
  if (wf.journeyId !== input.journeyId || wf.journeyVersion !== input.journeyVersion)
    fail("Action does not match the bound journey version.");
  const [journey] = await tx
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, wf.journeyId),
        eq(journeys.tenantId, scope.tenantId),
        eq(journeys.jobId, scope.jobId),
      ),
    );
  if (
    !journey ||
    journey.status !== "approved" ||
    journey.version !== wf.journeyVersion ||
    journey.briefHash !== hash ||
    (journey.interviewPath !== "recruiter_choice" && journey.interviewPath !== wf.interviewPath)
  )
    fail("The bound approved journey is stale or invalid.");
  const [candidate] = await tx
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, wf.candidateId));
  if (
    !candidate ||
    candidate.dataErasedAt ||
    candidate.doNotContact ||
    candidate.pool === "pending_profile" ||
    !(await candidateAllowed(tx, wf.candidateId))
  )
    fail("Not found", 404);
  const expected = journeySteps(wf.interviewPath);
  if (
    wf.steps.map((s) => s.key).join("|") !== expected.map((s) => s.key).join("|") ||
    wf.steps.some((s) => s.authority !== "human_review")
  )
    fail("Workflow state needs human reconciliation.");
  const next = wf.steps.find((s) => s.status !== "completed");
  if (
    !next ||
    next.key !== input.stepKey ||
    (next.status !== "pending" && !(allowReview && next.status === "review_required")) ||
    !EXECUTABLE.includes(next.key) ||
    wf.steps.some((s) => s.status === "completed" && !s.evidence?.trim())
  )
    fail("Resolve the preceding steps or human review before requesting this action.");
  if (next?.key === "screening" && next.status === "pending") {
    const readiness = workflowScreeningReadiness(candidate);
    if (!readiness.ready) fail(readiness.reason!);
  }
}

async function bounded<T>(signal: AbortSignal, invoke: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let removeAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new Error("Workflow action deadline exceeded"));
    signal.addEventListener("abort", abort, { once: true });
    removeAbort = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([Promise.resolve().then(invoke), timeout]);
  } finally {
    removeAbort?.();
  }
}

/**
 * Live adapters retain the existing execution lock. Controlled adapters can
 * only run in a test process. Replays never retry an already claimed effect,
 * even if its outcome could not be saved after a crash or timeout.
 */
export async function assertWorkflowActionReady(context: WorkflowActionContext): Promise<void> {
  await dbAdmin.transaction(async (tx) => {
    await jobLock(tx, context.scope);
    await assertWorkflowActionReadyInTransaction(
      tx,
      context.scope,
      context.input,
      context.candidateAllowed,
    );
  });
}

export async function executeWorkflowAction<T>(
  context: WorkflowActionContext,
  adapter: WorkflowActionAdapter<T>,
): Promise<WorkflowActionResult<T>> {
  const { scope, input, candidateAllowed } = context;
  if (!/^[a-f0-9]{64}$/.test(input.payloadHash) || !input.idempotencyKey?.trim())
    fail("A stable action key and payload fingerprint are required.", 400);
  if (
    !["agent", "outreach_send"].includes(input.actionKind) ||
    (input.actionKind === "outreach_send" && input.stepKey !== "engagement")
  )
    fail("Unsupported workflow action kind.", 400);
  if (adapter.mode === "controlled_test" && process.env.NODE_ENV !== "test")
    fail("Controlled adapters are test-only.", 403);
  if (!["controlled_test", "live"].includes(adapter.mode)) fail("Unsupported execution adapter.");
  const duration = adapter.maxDurationMs ?? 30_000;
  if (!Number.isInteger(duration) || duration < 1 || duration > 30_000)
    fail("Execution duration must be bounded.", 400);
  await assertWorkflowActionReady(context);
  if (adapter.mode === "live")
    await dbAdmin.transaction((tx) => assertWorkflowPilotAllowed(tx, scope, input));
  const signal = AbortSignal.timeout(duration);
  if (adapter.prepare) await bounded(signal, () => adapter.prepare!(signal));
  signal.throwIfAborted();
  // Natural step identity also dedupes different request keys and resume/retry.
  // Changing a payload after an uncertain attempt requires human reconciliation.
  const claimInput = {
    ...input,
    idempotencyKey: await workflowActionKey(
      dbAdmin,
      scope,
      {
        id: input.workflowId,
        journeyId: input.journeyId,
        journeyVersion: input.journeyVersion,
      },
      input.stepKey,
      input.actionKind,
    ),
  };
  const claim = await atomic(scope, "workflow.execution_claimed", claimInput, async (tx) => {
    await assertWorkflowActionReadyInTransaction(tx, scope, input, candidateAllowed);
    if (adapter.mode === "live") await assertWorkflowPilotAllowed(tx, scope, input);
    signal.throwIfAborted();
    const id = randomUUID();
    return {
      id,
      workflowId: input.workflowId,
      journeyId: input.journeyId,
      note: `${input.stepKey}: action ${id} claimed. In-flight effects are not automatically retried.`,
    };
  });
  if (claim.replayed) return { attemptId: claim.id, state: "already_claimed", replayed: true };
  async function outcome(state: "succeeded" | "unknown" | "no_effect", reason?: string) {
    await dbAdmin.insert(events).values({
      tenantId: scope.tenantId,
      jobId: scope.jobId,
      actorId: scope.actorId,
      workflowId: input.workflowId,
      journeyId: input.journeyId,
      action: `workflow.execution_${state}`,
      note:
        state === "no_effect"
          ? JSON.stringify({
              attemptId: claim.id,
              stepKey: input.stepKey,
              actionKind: input.actionKind,
              journeyVersion: input.journeyVersion,
              reason,
            })
          : `${input.stepKey}: action ${claim.id} ${state}. This does not complete a workflow step.`,
    });
  }
  try {
    signal.throwIfAborted();
    // Establish attribution at the common, already-authorized effect boundary.
    // This includes separately approved sends, not just agent-generated drafts.
    // ALS also keeps late receipts bound to their original action after timeout.
    const output = await bounded(signal, () =>
      vendorUsageScope.run(
        {
          tenantId: scope.tenantId,
          area: `workflow:${input.workflowId}:${input.stepKey}`,
        },
        () => adapter.invoke(signal),
      ),
    );
    const preEffect = adapter.preEffectFailure?.(output);
    if (preEffect && !signal.aborted) {
      await outcome("no_effect", preEffect);
      return { attemptId: claim.id, state: "no_effect", replayed: false };
    }
    if (adapter.isSuccessful && !adapter.isSuccessful(output))
      throw new Error("Action did not confirm success");
    await outcome("succeeded");
    return { attemptId: claim.id, state: "succeeded", replayed: false, output };
  } catch (error) {
    if (error instanceof WorkflowPreEffectError && !signal.aborted) {
      await outcome("no_effect", error.reason);
      return { attemptId: claim.id, state: "no_effect", replayed: false };
    }
    // A durable claim survives even if this outcome write fails. Never resend.
    await outcome("unknown");
    return { attemptId: claim.id, state: "unknown", replayed: false };
  }
}
