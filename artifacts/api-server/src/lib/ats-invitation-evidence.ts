import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  interviewSessionsTable as sessions,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
} from "@workspace/db";
import type { AtsInvitationEvidence, AtsInvitationReconciliationInput } from "@workspace/api-zod";
import { reviewGreenhouseInvitation } from "./ats-interview-invitations";
import { invitationAttempt } from "./interview-provider-events";
import { lock } from "./ats-imports";
import { fingerprint, WorkflowConflict, type WorkflowScope } from "./recruiting-workflows";

type Handle = Parameters<typeof reviewGreenhouseInvitation>[0];
type Visible = Parameters<typeof reviewGreenhouseInvitation>[4];
async function review(h: Handle, s: WorkflowScope, w: string, r: string, visible: Visible) {
  const current = await reviewGreenhouseInvitation(h, s, w, r, visible);
  const attempt = await invitationAttempt(h, s, w, current.state.sessionId);
  const binding = attempt?.binding;
  const matching =
    !!attempt &&
    attempt.data.recordId === r &&
    attempt.data.recipientHash === fingerprint(current.state.recipient) &&
    (typeof attempt.outcomeData.messageId !== "string" ||
      attempt.outcomeData.messageId === binding?.messageId);
  const observed = matching && current.state.status !== "simulated" ? binding : null;
  const reviewHash = fingerprint({
    sessionId: current.state.sessionId,
    receipt: attempt?.receipt,
    binding: observed,
    recipientHash: fingerprint(current.state.recipient),
  });
  const state: AtsInvitationEvidence = {
    sessionId: current.state.sessionId,
    attemptId: attempt?.claim.id ?? null,
    sendStatus: current.state.status,
    providerStatus: observed?.status ?? "unobserved",
    messageId: observed?.messageId ?? null,
    occurredAt: observed?.occurredAt ?? null,
    receivedAt: observed?.receivedAt ?? null,
    observations: observed?.events.map(({ status, occurredAt }) => ({ status, occurredAt })) ?? [],
    reviewHash,
    canReconcile: !!observed && current.state.status === "review_required",
    explanation: observed
      ? "Signed SES evidence matches this original attempt and recipient. Delivered means acceptance by the recipient mail server, not inbox placement or that the candidate read it. Failure and complaint signals are never downgraded. Recognition never sends or releases an invitation."
      : "No usable signed, attempt-bound evidence is available. This is not proof of non-delivery. Legacy, simulated, changed-recipient and untagged attempts cannot be released or resent here.",
  };
  return { state, current, attempt };
}
export async function readAtsInvitationEvidence(
  s: WorkflowScope,
  w: string,
  r: string,
  visible: Visible,
) {
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, s, w);
    return (await review(tx, s, w, r, visible)).state;
  });
}
export async function reconcileAtsInvitation(
  s: WorkflowScope,
  w: string,
  r: string,
  input: AtsInvitationReconciliationInput,
  visible: Visible,
) {
  if (input.acknowledge !== true)
    throw new WorkflowConflict("Explicit recognition of this evidence is required.", 400);
  return dbAdmin.transaction(async (tx) => {
    await lock(tx, s, w);
    const view = await review(tx, s, w, r, visible);
    if (
      view.attempt?.outcome.action === "ats.interview.invitation.reconciled" &&
      view.attempt.claim.id === input.attemptId
    )
      return view.state;
    if (
      !view.state.canReconcile ||
      view.state.reviewHash !== input.reviewHash ||
      view.attempt?.claim.id !== input.attemptId ||
      !view.attempt.binding
    )
      throw new WorkflowConflict(
        "Exact signed evidence or current review is missing or changed. No send was authorized.",
      );
    const { attempt } = view,
      now = new Date(),
      id = randomUUID();
    await tx.insert(events).values({
      id,
      tenantId: s.tenantId,
      jobId: s.jobId,
      workflowId: w,
      actorId: s.actorId,
      action: "ats.interview.invitation.reconciled",
      note: JSON.stringify({
        attemptId: attempt.claim.id,
        sessionId: view.state.sessionId,
        recordId: r,
        reviewHash: attempt.data.reviewHash,
        messageId: attempt.binding!.messageId,
        evidenceId: attempt.bindingRow!.id,
        recognitionRecordedAt: now.toISOString(),
      }),
    });
    await tx
      .update(receipts)
      .set({ resultId: id })
      .where(
        and(
          eq(receipts.tenantId, s.tenantId),
          eq(receipts.jobId, s.jobId),
          eq(receipts.id, attempt.receipt.id),
          eq(receipts.resultId, attempt.receipt.resultId),
        ),
      );
    // Recognition time, not a reconstructed original send timestamp.
    await tx
      .update(sessions)
      .set({ inviteSentAt: sql`coalesce(${sessions.inviteSentAt},${now})` })
      .where(and(eq(sessions.id, view.state.sessionId), eq(sessions.tenantId, s.tenantId)));
    return (await review(tx, s, w, r, visible)).state;
  });
}
