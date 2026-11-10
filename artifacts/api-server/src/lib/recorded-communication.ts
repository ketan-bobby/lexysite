import { createHash } from "node:crypto";
import { db, communicationEventsTable, type CommunicationEvent } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sendEmail, type SendEmailResult } from "./email";

type State = "pending" | "sent" | "failed";
export interface RecordedCommunication {
  id: string;
  tenantId: string;
  candidateId: string;
  applicationId?: string;
  type: CommunicationEvent["type"];
  to: string;
  subject: string;
  body: string;
  html?: string;
  htmlOnly?: boolean;
  senderUserId?: string;
  actorLabel: string;
  subjectLabel?: string;
  action: string;
  metadata?: Record<string, unknown>;
}
export function inboxReplyOperationId(input: {
  tenantId: string;
  inboxId: string;
  senderId: string;
  subject: string;
  body: string;
}) {
  // Do not include the resolved email: an address correction must not release
  // an uncertain attempt for the same reply intent.
  return (
    "inbox-reply:" +
    createHash("sha256")
      .update(
        JSON.stringify([
          input.tenantId,
          input.inboxId,
          input.senderId,
          input.subject.trim(),
          input.body.trim(),
        ]),
      )
      .digest("hex")
  );
}
const review = (): SendEmailResult => ({
  ok: false,
  reviewRequired: true,
  error:
    "This email has an attempt in progress or requiring review. Check its Activity record before sending again.",
});

export function createRecordedCommunicationSender(deps: {
  insertPending: (input: RecordedCommunication) => Promise<boolean>;
  readState: (input: RecordedCommunication) => Promise<State | undefined>;
  retryRejected: (input: RecordedCommunication) => Promise<boolean>;
  finish: (input: RecordedCommunication, result: SendEmailResult, state: State) => Promise<boolean>;
  send: typeof sendEmail;
}) {
  return async (input: RecordedCommunication): Promise<SendEmailResult> => {
    try {
      if (!(await deps.insertPending(input))) {
        const state = await deps.readState(input);
        if (state === "sent") return { ok: true, acceptance: "accepted", delivery: "unverified" };
        if (state !== "failed" || !(await deps.retryRejected(input))) return review();
      }
    } catch {
      return review();
    }
    let result: SendEmailResult;
    try {
      result = await deps.send({
        to: input.to,
        subject: input.subject,
        text: input.htmlOnly ? undefined : input.body,
        html: input.html,
        senderUserId: input.senderUserId,
        useRecruiterMailbox: Boolean(input.senderUserId),
        singleAttempt: true,
        audit: {
          tenantId: input.tenantId,
          actorLabel: input.actorLabel,
          subjectType: "candidate",
          subjectId: input.candidateId,
          subjectLabel: input.subjectLabel ?? input.to,
          action: input.action,
          metadata: { ...input.metadata, mailOperationId: input.id },
        },
      });
    } catch {
      result = review();
    }
    const state: State = result.ok
      ? "sent"
      : !result.reviewRequired &&
          (result.acceptance === "rejected" || result.acceptance === "not_attempted")
        ? "failed"
        : "pending";
    try {
      if (!(await deps.finish(input, result, state))) return review();
    } catch {
      return review();
    }
    return state === "pending" ? review() : result;
  };
}

const scope = (input: RecordedCommunication) =>
  and(
    eq(communicationEventsTable.id, input.id),
    eq(communicationEventsTable.tenantId, input.tenantId),
  );
export const recordedCommunicationStore = {
  insertPending: async (input) =>
    (
      await db
        .insert(communicationEventsTable)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          candidateId: input.candidateId,
          applicationId: input.applicationId,
          type: input.type,
          channel: "email",
          status: "pending",
          subject: input.subject,
          body: input.body,
        })
        .onConflictDoNothing()
        .returning({ id: communicationEventsTable.id })
    ).length === 1,
  readState: async (input) => {
    const [row] = await db
      .select({ status: communicationEventsTable.status })
      .from(communicationEventsTable)
      .where(
        and(
          eq(communicationEventsTable.id, input.id),
          eq(communicationEventsTable.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    return row?.status === "sent" || row?.status === "failed" || row?.status === "pending"
      ? row.status
      : undefined;
  },
  retryRejected: async (input) =>
    (
      await db
        .update(communicationEventsTable)
        .set({ status: "pending", sentAt: null })
        .where(and(scope(input), eq(communicationEventsTable.status, "failed")))
        .returning({ id: communicationEventsTable.id })
    ).length === 1,
  finish: async (input, result, state) => {
    const pending = and(scope(input), eq(communicationEventsTable.status, "pending"));
    // These flags are explicit no-provider-I/O results. Do not count a demo as
    // sent/failed or leave a fake uncertainty hold when configuration changes.
    if (result.ok && (result.simulated || result.suppressed))
      return (
        (
          await db
            .delete(communicationEventsTable)
            .where(pending)
            .returning({ id: communicationEventsTable.id })
        ).length === 1
      );
    return (
      (
        await db
          .update(communicationEventsTable)
          .set({
            status: state,
            sentAt: state === "sent" ? new Date() : null,
          })
          .where(pending)
          .returning({ id: communicationEventsTable.id })
      ).length === 1
    );
  },
} satisfies Omit<Parameters<typeof createRecordedCommunicationSender>[0], "send">;
export const sendRecordedCommunication = createRecordedCommunicationSender({
  ...recordedCommunicationStore,
  send: sendEmail,
});
