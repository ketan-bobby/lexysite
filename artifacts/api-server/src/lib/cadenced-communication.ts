import { randomUUID } from "node:crypto";
import { dbAdmin, candidatesTable, communicationEventsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { sendEmail, type SendEmailResult } from "./email";
import {
  createRecordedCommunicationSender,
  recordedCommunicationStore,
  type RecordedCommunication,
} from "./recorded-communication";
import { classBRead, CLASS_B_READ_EXEMPTION } from "./class-b-read";
import { platformReadExemption, PLATFORM_READ_EXEMPTION } from "./platform-pool-read";
import { weeklyDigestOperationId, type WeeklyRecapBinding } from "./weekly-digest-recap";

export interface CadencedCommunication extends Omit<RecordedCommunication, "id" | "type"> {
  kind: "platform_inactivity" | "self_report" | "status_checkin" | "weekly_digest";
  intervalDays: number;
  ownerTenantId: string | null;
  expectedTitle?: string | null;
  expectedCompany?: string | null;
  expectedUpdatedAt?: Date;
  expectedPool?: string | null;
  weeklyRecap?: WeeklyRecapBinding;
}
type Reservation = { reserved: true } | { reserved: false; reason: string };
export type CadencedResult = SendEmailResult & { reason?: string; operationId?: string };

export const cadencedCommunicationStore = {
  reserve: async (
    input: CadencedCommunication,
    record: RecordedCommunication,
  ): Promise<Reservation> => {
    // Candidate-directed lifecycle mail, not an employer data-read surface.
    // Independent transaction: never send while a reservation can still be
    // rolled back by a surrounding profile-save transaction.
    return dbAdmin.transaction(async (tx) => {
      platformReadExemption(PLATFORM_READ_EXEMPTION.SELF_DIRECTED_CANDIDATE_MESSAGING);
      classBRead(CLASS_B_READ_EXEMPTION.CANDIDATE_SELF_OWNED);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(
        hashtext(${"candidate-mail-cadence"}),hashtext(${input.candidateId + ":" + record.type}))`);
      const [candidate] = await tx
        .select({
          email: candidatesTable.email,
          tenantId: candidatesTable.tenantId,
          pool: candidatesTable.pool,
          doNotContact: candidatesTable.doNotContact,
          discoveryPaused: candidatesTable.discoveryPaused,
          dataErasedAt: candidatesTable.dataErasedAt,
          currentTitle: candidatesTable.currentTitle,
          currentCompany: candidatesTable.currentCompany,
          updatedAt: candidatesTable.updatedAt,
          weeklyDigestLastSentAt: candidatesTable.weeklyDigestLastSentAt,
          userId: candidatesTable.userId,
        })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, input.candidateId))
        .limit(1);
      if (!candidate) return { reserved: false, reason: "candidate_not_found" };
      if (candidate.dataErasedAt) return { reserved: false, reason: "erased" };
      if (candidate.doNotContact) return { reserved: false, reason: "do_not_contact" };
      if (input.kind === "self_report" && candidate.discoveryPaused)
        return { reserved: false, reason: "discovery_paused" };
      if (
        candidate.email !== input.to ||
        candidate.tenantId !== input.ownerTenantId ||
        (input.weeklyRecap && candidate.userId !== input.weeklyRecap.userId) ||
        ((input.kind === "platform_inactivity" || input.kind === "weekly_digest") &&
          candidate.pool !== "platform") ||
        (input.expectedPool !== undefined && candidate.pool !== input.expectedPool) ||
        (input.expectedTitle !== undefined && candidate.currentTitle !== input.expectedTitle) ||
        (input.expectedCompany !== undefined &&
          candidate.currentCompany !== input.expectedCompany) ||
        (input.expectedUpdatedAt &&
          new Date(candidate.updatedAt).getTime() !== input.expectedUpdatedAt.getTime())
      )
        return { reserved: false, reason: "profile_changed" };
      if (
        input.kind === "weekly_digest" &&
        candidate.weeklyDigestLastSentAt &&
        Date.now() - new Date(candidate.weeklyDigestLastSentAt).getTime() <
          input.intervalDays * 86400000
      )
        return { reserved: false, reason: "cooldown" };
      // Shared candidate/type cooldown includes legacy monitor receipts. Only
      // timestamps/statuses are read; no other customer's message body escapes.
      const [history] = await tx
        .select({
          pending: sql<boolean>`COALESCE(bool_or(${communicationEventsTable.status} = 'pending'
          AND starts_with(${communicationEventsTable.id},${`candidate-cadence:${cadenceGroup(input.kind)}:`})),false)`,
          lastAccepted: sql<string>`MAX(${communicationEventsTable.sentAt})`,
        })
        .from(communicationEventsTable)
        .where(
          and(
            eq(communicationEventsTable.candidateId, input.candidateId),
            eq(communicationEventsTable.type, record.type),
            ...(input.kind === "weekly_digest"
              ? [
                  sql`starts_with(${communicationEventsTable.id},'candidate-cadence:weekly_digest:')`,
                ]
              : []),
          ),
        );
      if (history?.pending) return { reserved: false, reason: "review_required" };
      if (
        history?.lastAccepted &&
        Date.now() - new Date(history.lastAccepted).getTime() < input.intervalDays * 86400000
      )
        return { reserved: false, reason: "cooldown" };
      await tx.insert(communicationEventsTable).values({
        id: record.id,
        tenantId: record.tenantId,
        candidateId: record.candidateId,
        type: record.type,
        channel: "email",
        status: "pending",
        subject: record.subject,
        body: record.body,
      });
      return { reserved: true };
    });
  },
  finish: recordedCommunicationStore.finish,
};

function cadenceGroup(kind: CadencedCommunication["kind"]) {
  return kind === "status_checkin" ? "self_report" : kind;
}

export function createCadencedCommunicationSender(deps: {
  reserve: typeof cadencedCommunicationStore.reserve;
  finish: typeof recordedCommunicationStore.finish;
  send: typeof sendEmail;
}) {
  return async (input: CadencedCommunication): Promise<CadencedResult> => {
    if (!Number.isFinite(input.intervalDays) || input.intervalDays <= 0)
      return { ok: false, acceptance: "not_attempted", reason: "invalid_cadence" };
    if (
      input.weeklyRecap &&
      (input.kind !== "weekly_digest" ||
        !(input.weeklyRecap.periodEnd instanceof Date) ||
        !Number.isFinite(input.weeklyRecap.periodEnd?.getTime()) ||
        (input.weeklyRecap.userId !== null && typeof input.weeklyRecap.userId !== "string"))
    )
      return { ok: false, acceptance: "not_attempted", reason: "invalid_recap_binding" };
    const record: RecordedCommunication = {
      ...input,
      id: input.weeklyRecap
        ? weeklyDigestOperationId({ ...input, weeklyRecap: input.weeklyRecap }, randomUUID())
        : `candidate-cadence:${cadenceGroup(input.kind)}:${randomUUID()}`,
      type:
        input.kind === "self_report" || input.kind === "status_checkin"
          ? "follow_up"
          : input.kind === "weekly_digest"
            ? "status_update"
            : "re_engagement",
    };
    let reservation: Reservation | undefined;
    const sender = createRecordedCommunicationSender({
      insertPending: async (current) => {
        reservation = await deps.reserve(input, current);
        return reservation.reserved;
      },
      readState: async () => undefined,
      retryRejected: async () => false,
      finish: deps.finish,
      send: deps.send,
    });
    const result = await sender(record);
    if (reservation && !reservation.reserved)
      return {
        ok: false,
        acceptance: "not_attempted",
        reason: reservation.reason,
        reviewRequired: reservation.reason === "review_required",
      };
    return {
      ...result,
      operationId: record.id,
      reason: result.reviewRequired
        ? "review_required"
        : !result.ok
          ? "send_failed"
          : result.simulated
            ? "simulated"
            : result.suppressed
              ? "suppressed"
              : undefined,
    };
  };
}
export const sendCadencedCommunication = createCadencedCommunicationSender({
  ...cadencedCommunicationStore,
  send: sendEmail,
});
