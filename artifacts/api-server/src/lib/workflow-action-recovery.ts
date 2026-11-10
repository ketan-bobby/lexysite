import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
} from "@workspace/db";
import { atomic, readBrief, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";
import type { CandidateAllowed, WorkflowActionContext } from "./workflow-execution";
import { assertWorkflowContactPrerequisites } from "./workflow-contact-gates";

type Handle = Pick<typeof dbAdmin, "select">;
type Workflow = typeof workflows.$inferSelect;
export const WORKFLOW_PRE_EFFECT_RESULT = Symbol("trusted-workflow-pre-effect-result");

/** Only throw at a native control-flow exit that precedes ALL external work. */
export class WorkflowPreEffectError extends WorkflowConflict {
  constructor(public readonly reason: string) {
    super(reason, 409);
  }
}

function data(note: string | null): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(note ?? "");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function history(handle: Handle, scope: WorkflowScope, wf: Workflow) {
  return handle
    .select()
    .from(events)
    .where(
      and(
        eq(events.tenantId, scope.tenantId),
        eq(events.jobId, scope.jobId),
        eq(events.workflowId, wf.id),
        eq(events.journeyId, wf.journeyId),
      ),
    )
    .orderBy(desc(events.createdAt), desc(events.id));
}

export async function workflowActionKey(
  handle: Handle,
  scope: WorkflowScope,
  wf: Pick<Workflow, "id" | "journeyId" | "journeyVersion">,
  stepKey: string,
  actionKind: string,
) {
  const root = `workflow-action:${wf.id}:${wf.journeyVersion}:${stepKey}:${actionKind}`;
  const records = await history(handle, scope, wf as Workflow);
  const authorized = records.find((e) => {
    const value = data(e.note);
    return (
      e.action === "workflow.execution_recovery_authorized" &&
      value?.journeyVersion === wf.journeyVersion &&
      value.stepKey === stepKey &&
      value.actionKind === actionKind
    );
  });
  return authorized ? `${root}:recovery:${authorized.id}` : root;
}

export async function readWorkflowRecovery(handle: Handle, scope: WorkflowScope, wf: Workflow) {
  const stepKey = wf.steps.find((s) => s.status !== "completed")?.key;
  if (!stepKey)
    return {
      available: false,
      authorized: false,
      attemptId: null,
      reason: null,
      blockedReason: null,
    };
  const key = await workflowActionKey(handle, scope, wf, stepKey, "agent");
  const [claim] = await handle
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.tenantId, scope.tenantId),
        eq(receipts.jobId, scope.jobId),
        eq(receipts.key, key),
      ),
    );
  if (!claim)
    return {
      available: false,
      authorized: key.includes(":recovery:"),
      attemptId: null,
      reason: null,
      blockedReason: null,
    };
  const records = await history(handle, scope, wf);
  const ambiguous = records.some(
    (e) =>
      ["workflow.execution_unknown", "workflow.execution_succeeded"].includes(e.action) &&
      e.note?.includes(claim.resultId),
  );
  const proof = records.find((e) => {
    const value = data(e.note);
    return (
      e.action === "workflow.execution_no_effect" &&
      value?.attemptId === claim.resultId &&
      value.stepKey === stepKey &&
      value.actionKind === "agent" &&
      value.journeyVersion === wf.journeyVersion &&
      typeof value.reason === "string"
    );
  });
  return {
    available: !ambiguous && !!proof,
    authorized: false,
    attemptId: claim.resultId,
    reason: !ambiguous && proof ? String(data(proof.note)!.reason) : null,
    blockedReason:
      ambiguous || !proof
        ? "This attempt has no durable pre-effect proof. Unknown, partial and completed outcomes cannot be retried."
        : null,
  };
}

export async function recoverWorkflowAction(
  scope: WorkflowScope,
  workflowId: string,
  input: {
    idempotencyKey: string;
    expectedRevision: number;
    attemptId: string;
    acknowledge: boolean;
  },
  candidateAllowed: CandidateAllowed,
) {
  if (!input.acknowledge) throw new WorkflowConflict("Explicit recovery review is required.", 400);
  return atomic(
    scope,
    "workflow.execution_recovery_authorized",
    { ...input, workflowId },
    async (tx) => {
      const [actor] = await tx.select().from(usersTable).where(eq(usersTable.id, scope.actorId));
      if (
        !actor ||
        actor.status !== "active" ||
        !["platform_admin", "tenant_admin", "recruiter_admin"].includes(actor.role)
      )
        throw new WorkflowConflict("Admin recovery authority required.", 403);
      const [wf] = await tx
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.id, workflowId),
            eq(workflows.tenantId, scope.tenantId),
            eq(workflows.jobId, scope.jobId),
          ),
        )
        .for("update");
      if (!wf) throw new WorkflowConflict("Not found", 404);
      const { job } = await readBrief(tx, scope);
      const { isIsolatedPilotJob } = await import("./workflow-pilot-policy");
      if (!isIsolatedPilotJob(job.title))
        throw new WorkflowConflict("Recovery is limited to isolated pilots.", 403);
      const step = wf.steps.find((s) => s.status !== "completed");
      if (!step) throw new WorkflowConflict("No pending action.");
      const context: WorkflowActionContext = {
        scope,
        candidateAllowed,
        input: {
          ...input,
          workflowId,
          candidateId: wf.candidateId,
          journeyId: wf.journeyId,
          journeyVersion: wf.journeyVersion,
          stepKey: step.key,
          actionKind: "agent",
          payloadHash: "",
        },
      };
      const { assertWorkflowActionReadyInTransaction } = await import("./workflow-execution");
      await assertWorkflowActionReadyInTransaction(
        tx,
        scope,
        context.input,
        candidateAllowed,
        true,
      );
      const recovery = await readWorkflowRecovery(tx, scope, wf);
      if (!recovery.available || recovery.attemptId !== input.attemptId)
        throw new WorkflowConflict(
          recovery.blockedReason ?? "Recovery proof changed. Refresh first.",
        );
      await assertWorkflowContactPrerequisites(tx, wf, step.key);
      const { revokeWorkflowPilotForRecovery } = await import("./workflow-live-pilot");
      await revokeWorkflowPilotForRecovery(tx, scope, wf);
      await tx
        .update(workflows)
        .set({
          steps: wf.steps.map((s) =>
            s.key === step.key ? { ...s, status: "pending" as const } : s,
          ),
          revision: wf.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, wf.id));
      const id = randomUUID();
      // atomic's audit event is the durable one-use recovery generation.
      return {
        id,
        workflowId: wf.id,
        journeyId: wf.journeyId,
        note: JSON.stringify({
          attemptId: recovery.attemptId,
          journeyVersion: wf.journeyVersion,
          stepKey: step.key,
          actionKind: "agent",
          reason: recovery.reason,
        }),
      };
    },
  );
}
