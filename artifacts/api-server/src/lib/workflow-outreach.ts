/**
 * First-touch drafts retain their workflow ownership across later approvals.
 * A server-only symbol carries context into drafting; JSON agent inputs cannot
 * impersonate it. The message and binding event commit in one transaction.
 */
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  dbAdmin,
  outreachMessagesTable as messages,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowsTable as workflows,
  sourcedCandidatesTable as sources,
  candidatesTable,
  usersTable,
} from "@workspace/db";
import { fingerprint, WorkflowConflict } from "./recruiting-workflows";
import type { WorkflowActionContext } from "./workflow-execution";
import { getAllowedTenantIds } from "./tenantUtils";

export const WORKFLOW_OUTREACH_CONTEXT = Symbol("trusted-workflow-outreach-context");
export const WORKFLOW_INVITATION_RECIPIENT = Symbol("trusted-workflow-invitation-recipient");
const bindingAction = (messageId: string) => `workflow.outreach_bound:${messageId}`;
type Draft = typeof messages.$inferInsert;

export async function createWorkflowOutreachDraft(values: Draft, context?: WorkflowActionContext) {
  if (!context) {
    const [message] = await dbAdmin.insert(messages).values(values).returning();
    return message;
  }
  if (
    context.input.stepKey !== "engagement" ||
    context.input.actionKind !== "agent" ||
    values.jobId !== context.scope.jobId ||
    values.tenantId !== context.scope.tenantId
  )
    throw new WorkflowConflict("Draft does not match its workflow.", 409);
  return dbAdmin.transaction(async (tx) => {
    const [wf] = await tx
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.id, context.input.workflowId),
          eq(workflows.jobId, context.scope.jobId),
          eq(workflows.tenantId, context.scope.tenantId),
        ),
      );
    if (
      !wf ||
      wf.candidateId !== context.input.candidateId ||
      wf.journeyId !== context.input.journeyId ||
      wf.journeyVersion !== context.input.journeyVersion
    )
      throw new WorkflowConflict("Draft workflow binding is invalid.", 409);
    if (values.candidateId !== wf.candidateId) {
      const [source] = await tx
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.id, values.candidateId),
            sql`EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=${sources.normalizedCandidateId} AND a.job_id=${wf.jobId})`,
            eq(sources.tenantId, wf.tenantId),
            eq(sources.normalizedCandidateId, wf.candidateId),
          ),
        );
      if (!source) throw new WorkflowConflict("Draft candidate identity is invalid.", 409);
    }
    const [message] = await tx
      .insert(messages)
      .values({ ...values, status: "pending_approval", approvedAt: null, approvedBy: null })
      .returning();
    await tx.insert(events).values({
      tenantId: wf.tenantId,
      jobId: wf.jobId,
      workflowId: wf.id,
      journeyId: wf.journeyId,
      actorId: context.scope.actorId,
      action: bindingAction(message.id),
      note: "First-touch draft bound to this workflow. Approval must recheck current controls.",
    });
    return message;
  });
}

/** Every dispatcher caller, including older approval routes, uses this lookup. */
export async function storedOutreachWorkflow(
  messageId: string,
  payload: { body: string; subject: string; candidateEmail: string | null | undefined },
  /** Internal read-only regeneration preflight, never permission to send. */
  draftActorId?: string,
): Promise<WorkflowActionContext | undefined> {
  const [message] = await dbAdmin.select().from(messages).where(eq(messages.id, messageId));
  if (!message) return undefined;
  const bindings = await dbAdmin
    .select()
    .from(events)
    .where(
      and(
        eq(events.tenantId, message.tenantId),
        eq(events.jobId, message.jobId),
        eq(events.action, bindingAction(messageId)),
      ),
    );
  if (!bindings.length) return undefined;
  if (bindings.length !== 1 || (!draftActorId && (!message.approvedAt || !message.approvedBy)))
    throw new WorkflowConflict("Workflow outreach requires explicit approval.", 409);
  const binding = bindings[0];
  const [wf] = await dbAdmin
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.id, binding.workflowId ?? ""),
        eq(workflows.jobId, message.jobId),
        eq(workflows.tenantId, message.tenantId),
      ),
    );
  if (!wf || wf.journeyId !== binding.journeyId)
    throw new WorkflowConflict("Stored outreach workflow needs reconciliation.", 409);
  return {
    scope: {
      jobId: wf.jobId,
      tenantId: wf.tenantId,
      actorId: draftActorId ?? message.approvedBy!,
      canApprove: false,
    },
    input: {
      workflowId: wf.id,
      candidateId: wf.candidateId,
      journeyId: wf.journeyId,
      journeyVersion: wf.journeyVersion,
      expectedRevision: wf.revision,
      stepKey: "engagement",
      actionKind: "outreach_send",
      idempotencyKey: `outreach:${message.id}`,
      payloadHash: fingerprint({ msgId: message.id, ...payload }),
    },
    candidateAllowed: async (tx, candidateId) => {
      const [user] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, draftActorId ?? message.approvedBy!));
      if (!user || user.status !== "active") return false;
      const allowed = await getAllowedTenantIds(user);
      const rows = await tx
        .select()
        .from(candidatesTable)
        .where(
          and(
            eq(candidatesTable.id, candidateId),
            allowed === null
              ? undefined
              : or(
                  inArray(candidatesTable.tenantId, allowed),
                  eq(candidatesTable.pool, "platform"),
                ),
            sql`EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id=${candidatesTable.id} AND a.job_id=${wf.jobId})`,
          ),
        );
      const { applyCandidateHardExclusions, applyCandidatePrivacyFilter } =
        await import("../routes/candidates");
      return (
        await applyCandidatePrivacyFilter(
          applyCandidateHardExclusions(rows),
          user.role === "platform_admin" ? null : wf.tenantId,
        )
      ).some((row) => row.id === candidateId);
    },
  };
}
