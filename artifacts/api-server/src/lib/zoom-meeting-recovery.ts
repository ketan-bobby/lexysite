import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  dbAdmin,
  interviewZoomMeetingsTable as meetings,
  staffZoomAccountsTable as accounts,
  auditLogsTable as audit,
  interviewZoomLinksTable as manualLinks,
  interviewCalendarInvitationAttemptsTable as invitations,
  usersTable,
} from "@workspace/db";
import { storage, type PanelCaller } from "./calendar-panel-access";
import { lockCurrent, requireAttemptStorage } from "../routes/outlook-candidate-invitations";
import { scheduleVersion } from "./coordinator-schedule-version";
import { zoomSnapshot, zoomChanged, zoomLinkReason } from "./staff-zoom-link";
import { zoomStaffAccountService } from "./zoom-staff-account";
import {
  zoomAppConfig,
  zoomProvider,
  zoomProviderError,
  zoomOperationMarker,
} from "./zoom-provider";
import { authorizeZoomSchedule, verifyZoomReview, zoomMeetingState } from "./zoom-meeting-service";

export const zoomRecoveryReview = z.strictObject({
  expectedVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
  accountRevision: z.uuid(),
  expectedOperationId: z.uuid(),
  meetingId: z
    .string()
    .regex(/^\d{9,15}$/)
    .optional(),
});
export const zoomRecoveryApproval = zoomRecoveryReview.extend({
  confirm: z.literal(true),
  reason: z.literal("provider_evidence_checked"),
  expiresAt: z.iso.datetime({ offset: true }),
  approvalToken: z.string().regex(/^zm_[a-f0-9]{64}$/),
});
type Review = z.infer<typeof zoomRecoveryReview>;

function insufficient() {
  return zoomProviderError("zoom_evidence_unavailable", 409);
}

/** Recovery only reads Zoom. It never POSTs, PATCHes or DELETEs a meeting. */
export function zoomMeetingRecovery(
  database: Pick<typeof dbAdmin, "select" | "transaction"> = dbAdmin,
  account = zoomStaffAccountService(),
  providerFactory = zoomProvider,
) {
  async function inspect(caller: PanelCaller, id: string, input: Review) {
    // Read authorization and resolve original-host ownership BEFORE refreshing
    // credentials or asking Zoom about a caller-supplied meeting identifier.
    const row = await authorizeZoomSchedule(caller, id, true);
    const [saved] = await database
      .select()
      .from(meetings)
      .where(and(eq(meetings.scheduleId, id), eq(meetings.tenantId, row.schedule.tenantId)));
    if (
      !saved ||
      saved.hostUserId !== caller.id ||
      !["pending", "uncertain"].includes(saved.status) ||
      saved.operationId !== input.expectedOperationId ||
      saved.candidateId !== row.candidate.id ||
      scheduleVersion(row.schedule) !== input.expectedVersion
    )
      throw zoomChanged();
    if (
      saved.action !== "cancel" &&
      (saved.snapshotHash !== zoomSnapshot(row) || zoomLinkReason(row, false))
    )
      throw insufficient();
    const meetingId = saved.meetingId ?? input.meetingId;
    if (!meetingId || (input.meetingId && input.meetingId !== meetingId)) throw insufficient();
    const actor = { id: caller.id, tenantId: caller.tenantId! };
    const cfg = zoomAppConfig();
    if (!cfg) throw zoomProviderError("zoom_setup_required");
    const grant = await account.access(actor, input.accountRevision);
    if (grant.zoomUserId !== saved.hostZoomId) throw zoomChanged();
    const evidence = await providerFactory(cfg).inspect(grant.accessToken, meetingId);
    let resolution: "confirmed" | "cancelled";
    if (saved.action === "cancel") {
      if (evidence !== null) throw insufficient();
      resolution = "cancelled";
    } else {
      if (
        !evidence ||
        evidence.hostZoomId !== saved.hostZoomId ||
        evidence.agenda !== zoomOperationMarker(saved.operationId) ||
        evidence.topic !== `Interview — ${row.job.title}` ||
        Date.parse(evidence.startTime) !== new Date(row.schedule.scheduledAt).getTime() ||
        evidence.durationMinutes !== row.schedule.durationMinutes
      )
        throw insufficient();
      resolution = "confirmed";
    }
    return { row, saved, meetingId, evidence, resolution, actor };
  }
  function signed(
    caller: PanelCaller,
    id: string,
    input: Review,
    proof: Awaited<ReturnType<typeof inspect>>,
    expiresAt: string,
  ) {
    const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
    if (!secret) throw zoomProviderError("zoom_setup_required");
    return `zm_${createHmac("sha256", secret)
      .update(
        JSON.stringify([
          "zoom-recovery-v1",
          caller.id,
          caller.tenantId,
          id,
          input.expectedVersion,
          input.accountRevision,
          input.expectedOperationId,
          input.meetingId ?? null,
          proof.saved.snapshotHash,
          proof.saved.action,
          proof.saved.hostZoomId,
          proof.meetingId,
          proof.resolution,
          proof.evidence,
          expiresAt,
        ]),
      )
      .digest("hex")}`;
  }
  return {
    async review(caller: PanelCaller, id: string, input: Review) {
      const proof = await inspect(caller, id, input);
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      return {
        ...zoomMeetingState(proof.row, proof.saved),
        accountRevision: input.accountRevision,
        action: proof.saved.action,
        resolution: proof.resolution,
        meetingId: proof.meetingId,
        hostZoomId: proof.saved.hostZoomId,
        providerStartAt: proof.evidence?.startTime ?? null,
        providerDurationMinutes: proof.evidence?.durationMinutes ?? null,
        expiresAt,
        approvalToken: signed(caller, id, input, proof, expiresAt),
      };
    },
    async approve(caller: PanelCaller, id: string, input: z.infer<typeof zoomRecoveryApproval>) {
      // Re-read provider evidence. A review alone is never authorization to
      // accept a subsequently changed or missing meeting.
      const proof = await inspect(caller, id, input);
      verifyZoomReview(
        input.approvalToken,
        signed(caller, id, input, proof, input.expiresAt),
        input.expiresAt,
      );
      return database.transaction(async (tx) => {
        await storage(tx, "interview_zoom_meetings");
        const [host] = await tx
          .select()
          .from(accounts)
          .where(and(eq(accounts.userId, caller.id), eq(accounts.tenantId, proof.actor.tenantId)))
          .for("update");
        if (
          !host ||
          host.revision !== input.accountRevision ||
          host.needsReconnect ||
          !host.refreshTokenEnc ||
          host.zoomUserId !== proof.saved.hostZoomId
        )
          throw zoomChanged();
        await tx
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.id, caller.id))
          .for("share");
        await authorizeZoomSchedule(caller, id, proof.resolution === "cancelled");
        const locked = await lockCurrent(tx, caller, proof.row, proof.resolution === "cancelled");
        const [latest] = await tx
          .select()
          .from(meetings)
          .where(and(eq(meetings.scheduleId, id), eq(meetings.tenantId, locked.schedule.tenantId)))
          .for("update");
        if (
          !latest ||
          latest.operationId !== input.expectedOperationId ||
          latest.hostUserId !== caller.id ||
          latest.hostZoomId !== host.zoomUserId ||
          latest.candidateId !== locked.candidate.id ||
          latest.action !== proof.saved.action ||
          latest.snapshotHash !== proof.saved.snapshotHash ||
          latest.meetingId !== proof.saved.meetingId ||
          !["pending", "uncertain"].includes(latest.status) ||
          scheduleVersion(locked.schedule) !== input.expectedVersion
        )
          throw zoomChanged();
        if (proof.resolution === "confirmed") {
          await requireAttemptStorage(tx);
          const [manual] = await tx
            .select()
            .from(manualLinks)
            .where(eq(manualLinks.scheduleId, id));
          const [invitation] = await tx
            .select()
            .from(invitations)
            .where(eq(invitations.scheduleId, id));
          if (
            manual?.joinUrl ||
            zoomLinkReason(locked, !!invitation) ||
            latest.snapshotHash !== zoomSnapshot(locked)
          )
            throw zoomChanged();
        }
        const [resolved] = await tx
          .update(meetings)
          .set({
            status: proof.resolution,
            meetingId: proof.meetingId,
            joinUrl: proof.resolution === "confirmed" ? proof.evidence!.joinUrl : null,
            acceptedAt: new Date(),
          })
          .where(and(eq(meetings.scheduleId, id), eq(meetings.operationId, latest.operationId)))
          .returning();
        // Audit and state change commit together; no best-effort audit fallback.
        // No tokens, participant passwords, agenda or candidate answers retained.
        await tx.insert(audit).values({
          id: randomUUID(),
          tenantId: latest.tenantId,
          actorType: "user",
          actorId: caller.id,
          subjectType: "interview_schedule",
          subjectId: id,
          channel: "system",
          direction: "internal",
          action: "zoom.operation_reconciled",
          title: "Staff reconciled Zoom provider evidence",
          metadata: {
            operationId: latest.operationId,
            originalAction: latest.action,
            previousStatus: latest.status,
            resolution: proof.resolution,
            meetingId: proof.meetingId,
            hostZoomId: latest.hostZoomId,
            accountRevision: input.accountRevision,
            reason: input.reason,
            expectedVersion: input.expectedVersion,
            snapshotHash: latest.snapshotHash,
            providerStartAt: proof.evidence?.startTime ?? null,
            providerDurationMinutes: proof.evidence?.durationMinutes ?? null,
          },
        });
        return zoomMeetingState(locked, resolved);
      });
    },
  };
}
