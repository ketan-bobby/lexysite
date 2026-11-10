import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  dbAdmin,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
  interviewSessionsTable as sessions,
  candidatesTable as candidates,
} from "@workspace/db";
import { fingerprint } from "./recruiting-workflows";
import { invitationDeliveryRank, type InvitationProviderEvent } from "./interview-provider-policy";

type Handle = typeof dbAdmin | Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Scope = { tenantId: string; jobId: string };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const statuses = z.enum(["accepted", "delayed", "delivered", "bounced", "rejected", "complained"]);
const observation = z.object({ id: z.string(), status: statuses, occurredAt: z.string() });
export const invitationBindingSchema = z.object({
  attemptId: z.string(),
  sessionId: z.string(),
  recordId: z.string(),
  reviewHash: hash,
  recipientHash: hash,
  messageId: z.string().min(1).max(256),
  status: statuses,
  occurredAt: z.string(),
  receivedAt: z.string(),
  events: z.array(observation).max(16),
});
function json(note: string | null): Record<string, unknown> {
  try {
    return JSON.parse(note ?? "{}");
  } catch {
    return {};
  }
}
async function scoped(h: Handle, s: Scope, w: string, id: string) {
  const [row] = await h
    .select()
    .from(events)
    .where(
      and(
        eq(events.id, id),
        eq(events.tenantId, s.tenantId),
        eq(events.jobId, s.jobId),
        eq(events.workflowId, w),
      ),
    );
  return row;
}
export async function invitationAttempt(h: Handle, s: Scope, w: string, sessionId: string) {
  const [receipt] = await h
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.tenantId, s.tenantId),
        eq(receipts.jobId, s.jobId),
        eq(receipts.key, `gh-interview-invitation:${sessionId}`),
      ),
    );
  const outcome = receipt ? await scoped(h, s, w, receipt.resultId) : undefined;
  if (
    !receipt ||
    !outcome ||
    !["claimed", "provider_accepted", "review_required", "simulated", "reconciled"].some(
      (x) => outcome.action === `ats.interview.invitation.${x}`,
    )
  )
    return null;
  const outcomeData = json(outcome.note);
  const attemptId =
    outcome.action === "ats.interview.invitation.claimed" ? outcome.id : outcomeData.attemptId;
  if (typeof attemptId !== "string") return null;
  const claim = await scoped(h, s, w, attemptId),
    data = json(claim?.note ?? null);
  const parsed = z
    .object({ sessionId: z.string(), recordId: z.string(), reviewHash: hash, recipientHash: hash })
    .safeParse(data);
  if (
    claim?.action !== "ats.interview.invitation.claimed" ||
    !parsed.success ||
    parsed.data.sessionId !== sessionId ||
    parsed.data.reviewHash !== receipt.requestHash
  )
    return null;
  const bindingRow = await scoped(h, s, w, `gh-invite-binding:${attemptId}`);
  const parsedBinding = invitationBindingSchema.safeParse(json(bindingRow?.note ?? null));
  const binding =
    bindingRow?.action === "ats.interview.invitation.provider_binding" &&
    parsedBinding.success &&
    parsedBinding.data.attemptId === attemptId &&
    parsedBinding.data.sessionId === sessionId &&
    parsedBinding.data.recordId === parsed.data.recordId &&
    parsedBinding.data.reviewHash === receipt.requestHash &&
    parsedBinding.data.recipientHash === parsed.data.recipientHash
      ? parsedBinding.data
      : null;
  return { receipt, outcome, outcomeData, claim, data: parsed.data, bindingRow, binding };
}

/** Only call after BOTH SNS signature and exact topic verification.
 * Does not change invitation receipts, approvals, stages or workflow revisions. */
export async function recordInvitationProviderEvent(event: InvitationProviderEvent) {
  const [target] = await dbAdmin
    .select({ tenantId: events.tenantId })
    .from(events)
    .where(
      and(
        eq(events.id, event.attemptId),
        eq(events.jobId, event.jobId),
        eq(events.workflowId, event.workflowId),
        eq(events.action, "ats.interview.invitation.claimed"),
      ),
    );
  if (!target) return { updated: false };
  const s = { tenantId: target.tenantId, jobId: event.jobId };
  return dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-employer:${s.tenantId}`},0))`,
    );
    // Erasure fence: a callback must not recreate per-person evidence after purge.
    const [person] = await tx
      .select({ id: candidates.id })
      .from(sessions)
      .innerJoin(
        candidates,
        and(eq(candidates.id, sessions.candidateId), eq(candidates.tenantId, s.tenantId)),
      )
      .where(
        and(
          eq(sessions.id, event.sessionId),
          eq(sessions.tenantId, s.tenantId),
          eq(candidates.pool, "tenant"),
          isNull(candidates.dataErasedAt),
        ),
      )
      .for("share");
    if (!person) return { updated: false };
    const attempt = await invitationAttempt(tx, s, event.workflowId, event.sessionId);
    if (
      !attempt ||
      attempt.claim.id !== event.attemptId ||
      attempt.outcome.action === "ats.interview.invitation.simulated" ||
      attempt.data.recipientHash !== fingerprint(event.recipients[0]) ||
      (typeof attempt.outcomeData.messageId === "string" &&
        attempt.outcomeData.messageId !== event.messageId) ||
      (attempt.bindingRow && !attempt.binding) ||
      (attempt.binding && attempt.binding.messageId !== event.messageId)
    )
      return { updated: false };
    const eventId = `gh-invite-event:${event.id}`;
    if (await scoped(tx, s, event.workflowId, eventId)) return { updated: false };
    const old = attempt.binding;
    const advances =
      !old ||
      invitationDeliveryRank[event.status] > invitationDeliveryRank[old.status] ||
      (event.status === old.status && event.occurredAt > old.occurredAt);
    const now = new Date().toISOString();
    const binding = {
      ...attempt.data,
      attemptId: event.attemptId,
      messageId: event.messageId,
      status: advances ? event.status : old!.status,
      occurredAt: advances ? event.occurredAt : old!.occurredAt,
      receivedAt: now,
      events: [
        ...(old?.events ?? []),
        { id: event.id, status: event.status, occurredAt: event.occurredAt },
      ]
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id))
        .slice(0, 16),
    };
    await tx.insert(events).values({
      id: eventId,
      ...s,
      workflowId: event.workflowId,
      actorId: "ses-provider",
      action: "ats.interview.invitation.provider_event",
      note: JSON.stringify({
        attemptId: event.attemptId,
        sessionId: event.sessionId,
        recordId: attempt.data.recordId,
        messageId: event.messageId,
        status: event.status,
        occurredAt: event.occurredAt,
      }),
    });
    if (attempt.bindingRow)
      await tx
        .update(events)
        .set({ note: JSON.stringify(binding) })
        .where(
          and(
            eq(events.id, attempt.bindingRow.id),
            eq(events.tenantId, s.tenantId),
            eq(events.jobId, s.jobId),
            eq(events.workflowId, event.workflowId),
          ),
        );
    else
      await tx.insert(events).values({
        id: `gh-invite-binding:${event.attemptId}`,
        ...s,
        workflowId: event.workflowId,
        actorId: "ses-provider",
        action: "ats.interview.invitation.provider_binding",
        note: JSON.stringify(binding),
      });
    return { updated: true };
  });
}
