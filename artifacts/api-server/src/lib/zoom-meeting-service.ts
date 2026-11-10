import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  interviewZoomMeetingsTable as meetings,
  interviewZoomLinksTable as manualLinks,
  interviewCalendarInvitationAttemptsTable as attempts,
  staffZoomAccountsTable as accounts,
} from "@workspace/db";
import { z } from "zod/v4";
import { CalendarError } from "./outlook-calendar-core";
import { calendarStaff } from "./calendar-staff";
import { visibleSchedule } from "../routes/outlook-calendar";
import { lockCurrent, requireAttemptStorage } from "../routes/outlook-candidate-invitations";
import { storage, type PanelCaller, type PanelSchedule } from "./calendar-panel-access";
import { scheduleVersion } from "./coordinator-schedule-version";
import { zoomJoinUrl, zoomLinkReason, zoomSnapshot, zoomChanged } from "./staff-zoom-link";
import { zoomStaffAccountService } from "./zoom-staff-account";
import { zoomAppConfig, zoomProvider, zoomProviderError } from "./zoom-provider";

const action = z.enum(["create", "update", "cancel"]);
export const zoomMeetingReview = z.strictObject({
  action,
  expectedVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
  accountRevision: z.uuid(),
  expectedOperationId: z.uuid().nullable(),
});
export const zoomMeetingApproval = zoomMeetingReview.extend({
  confirm: z.literal(true),
  expiresAt: z.iso.datetime({ offset: true }),
  approvalToken: z.string().regex(/^zm_[a-f0-9]{64}$/),
});
type Review = z.infer<typeof zoomMeetingReview>;
type Approval = z.infer<typeof zoomMeetingApproval>;
type Saved = typeof meetings.$inferSelect;

function signed(actor: string, id: string, snapshot: string, review: Review, expiresAt: string) {
  const secret = process.env.SESSION_SECRET || process.env.AUTH_SECRET;
  if (!secret) throw zoomProviderError("zoom_setup_required");
  return `zm_${createHmac("sha256", secret)
    .update(
      JSON.stringify([
        "zoom-meeting-v1",
        actor,
        id,
        snapshot,
        review.action,
        review.expectedVersion,
        review.accountRevision,
        review.expectedOperationId,
        expiresAt,
      ]),
    )
    .digest("hex")}`;
}
export function verifyZoomReview(token: string, expected: string, expires: string) {
  const expire = Date.parse(expires);
  if (
    !Number.isFinite(expire) ||
    expire <= Date.now() ||
    expire > Date.now() + 10 * 60_000 ||
    token.length !== expected.length ||
    !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  )
    throw zoomChanged();
}
export function zoomMeetingState(row: PanelSchedule, saved: Saved | undefined) {
  const fresh = Boolean(
    saved?.status === "confirmed" &&
    saved.joinUrl &&
    saved.snapshotHash === zoomSnapshot(row) &&
    !zoomLinkReason(row, false),
  );
  return {
    scheduleId: row.schedule.id,
    version: scheduleVersion(row.schedule),
    scheduledAt: row.schedule.scheduledAt,
    durationMinutes: row.schedule.durationMinutes,
    jobTitle: row.job.title,
    operationId: saved?.operationId ?? null,
    status: saved?.status ?? "none",
    joinUrl: fresh && saved?.joinUrl ? zoomJoinUrl(saved.joinUrl) : null,
    providerVerified: fresh,
    approvedAt: saved?.approvedAt ?? null,
    acceptedAt: saved?.acceptedAt ?? null,
    hostUserId: saved?.hostUserId ?? null,
  };
}
function checkAction(row: PanelSchedule, saved: Saved | undefined, kind: Review["action"]) {
  if (saved?.status === "pending" || saved?.status === "uncertain")
    throw new CalendarError(
      409,
      "zoom_needs_review",
      "Zoom may have accepted a previous request. Check it in Zoom; do not retry automatically.",
    );
  if (kind === "create") {
    if (saved && saved.status !== "cancelled") throw zoomChanged();
  } else {
    if (!saved || saved.status !== "confirmed" || !saved.meetingId) throw zoomChanged();
    if (kind === "update" && saved.snapshotHash === zoomSnapshot(row)) throw zoomChanged();
  }
}
export async function authorizeZoomSchedule(
  caller: PanelCaller,
  id: string,
  allowCancelled = false,
) {
  const actor = await calendarStaff(caller.id);
  if (
    actor.accountErasedAt ||
    actor.tenantId !== caller.tenantId ||
    actor.role !== caller.role ||
    !actor.tenantId
  )
    throw zoomChanged();
  const row = await visibleSchedule(actor, id, true);
  if (!allowCancelled && (row.candidate.dataErasedAt || row.candidate.doNotContact))
    throw new CalendarError(404, "schedule_not_found", "Appointment not found.");
  return row;
}
export function zoomMeetingService(
  database: Pick<typeof dbAdmin, "select" | "transaction"> = dbAdmin,
  account = zoomStaffAccountService(),
  providerFactory = zoomProvider,
) {
  async function current(caller: PanelCaller, id: string, kind?: Review["action"]) {
    const row = await authorizeZoomSchedule(caller, id, kind === "cancel");
    const [saved] = await database
      .select()
      .from(meetings)
      .where(and(eq(meetings.scheduleId, id), eq(meetings.tenantId, row.schedule.tenantId)))
      .limit(1);
    return { row, saved };
  }
  async function ensure(caller: PanelCaller, id: string, input: Review) {
    const { row, saved } = await current(caller, id, input.action);
    if (
      input.expectedVersion !== scheduleVersion(row.schedule) ||
      input.expectedOperationId !== (saved?.operationId ?? null) ||
      (saved && saved.hostUserId !== caller.id)
    )
      throw zoomChanged();
    checkAction(row, saved, input.action);
    const actor = { id: caller.id, tenantId: caller.tenantId! };
    const status = await account.status(actor);
    if (!status.connected || status.revision !== input.accountRevision)
      throw zoomProviderError("zoom_reconnect_required", 409);
    if (input.action !== "cancel") {
      const [manual] = await database
        .select({ joinUrl: manualLinks.joinUrl })
        .from(manualLinks)
        .where(eq(manualLinks.scheduleId, id))
        .limit(1);
      if (manual?.joinUrl)
        throw new CalendarError(
          409,
          "zoom_manual_link_exists",
          "Remove the staff-provided link before creating a native Zoom meeting.",
        );
      const [invitation] = await database
        .select({ scheduleId: attempts.scheduleId })
        .from(attempts)
        .where(eq(attempts.scheduleId, id))
        .limit(1);
      if (zoomLinkReason(row, !!invitation)) throw zoomChanged();
    }
    return { row, saved, actor };
  }
  return {
    async read(caller: PanelCaller, id: string) {
      const { row, saved } = await current(caller, id);
      return zoomMeetingState(row, saved);
    },
    async review(caller: PanelCaller, id: string, input: Review) {
      const { row, saved } = await ensure(caller, id, input);
      const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      return {
        ...zoomMeetingState(row, saved),
        action: input.action,
        accountRevision: input.accountRevision,
        expiresAt,
        approvalToken: signed(caller.id, id, zoomSnapshot(row), input, expiresAt),
      };
    },
    async approve(caller: PanelCaller, id: string, input: Approval) {
      const { row, saved, actor } = await ensure(caller, id, input);
      verifyZoomReview(
        input.approvalToken,
        signed(caller.id, id, zoomSnapshot(row), input, input.expiresAt),
        input.expiresAt,
      );
      const cfg = zoomAppConfig();
      if (!cfg) throw zoomProviderError("zoom_setup_required");
      const grant = await account.access(actor, input.accountRevision);
      if (saved && grant.zoomUserId !== saved.hostZoomId) throw zoomChanged();
      const operationId = randomUUID();
      await database.transaction(async (tx) => {
        await storage(tx, "interview_zoom_meetings");
        const [hostAccount] = await tx
          .select()
          .from(accounts)
          .where(and(eq(accounts.userId, caller.id), eq(accounts.tenantId, actor.tenantId)))
          .for("update");
        if (
          !hostAccount ||
          hostAccount.revision !== input.accountRevision ||
          hostAccount.zoomUserId !== grant.zoomUserId ||
          !hostAccount.refreshTokenEnc ||
          hostAccount.needsReconnect
        )
          throw zoomChanged();
        const locked = await lockCurrent(tx, caller, row, input.action === "cancel");
        await requireAttemptStorage(tx);
        const [previous] = await tx
          .select()
          .from(meetings)
          .where(eq(meetings.scheduleId, id))
          .for("update");
        if (
          scheduleVersion(locked.schedule) !== input.expectedVersion ||
          input.expectedOperationId !== (previous?.operationId ?? null)
        )
          throw zoomChanged();
        checkAction(locked, previous, input.action);
        const [manual] = await tx.select().from(manualLinks).where(eq(manualLinks.scheduleId, id));
        if (input.action !== "cancel" && manual?.joinUrl) throw zoomChanged();
        const [invitation] = await tx
          .select({ scheduleId: attempts.scheduleId })
          .from(attempts)
          .where(eq(attempts.scheduleId, id));
        if (input.action !== "cancel" && zoomLinkReason(locked, !!invitation)) throw zoomChanged();
        const values = {
          tenantId: row.schedule.tenantId,
          candidateId: row.candidate.id,
          hostUserId: caller.id,
          hostZoomId: grant.zoomUserId,
          operationId,
          status: "pending",
          action: input.action,
          meetingId: input.action === "create" ? null : (previous?.meetingId ?? null),
          joinUrl: input.action === "create" ? null : (previous?.joinUrl ?? null),
          snapshotHash: zoomSnapshot(row),
          approvedAt: new Date(),
          acceptedAt: null,
        };
        await tx
          .insert(meetings)
          .values({ scheduleId: id, ...values })
          .onConflictDoUpdate({ target: meetings.scheduleId, set: values });
      });
      let receipt: { meetingId: string; joinUrl: string } | null = null;
      try {
        const provider = providerFactory(cfg);
        const start = new Date(row.schedule.scheduledAt).toISOString();
        if (input.action === "create")
          receipt = await provider.create(
            grant.accessToken,
            `Interview — ${row.job.title}`,
            start,
            row.schedule.durationMinutes,
            operationId,
          );
        else if (input.action === "update")
          receipt = await provider.update(
            grant.accessToken,
            saved!.meetingId!,
            start,
            row.schedule.durationMinutes,
            operationId,
          );
        else await provider.remove(grant.accessToken, saved!.meetingId!);
      } catch {
        // A timeout could mean Zoom accepted the request. Never retry automatically.
        await database
          .transaction(async (tx) => {
            await tx
              .update(meetings)
              .set({ status: "uncertain" })
              .where(and(eq(meetings.scheduleId, id), eq(meetings.operationId, operationId)));
          })
          .catch(() => {});
        throw zoomProviderError("zoom_needs_review", 409);
      }
      try {
        await database.transaction(async (tx) => {
          const [latest] = await tx
            .select()
            .from(meetings)
            .where(eq(meetings.scheduleId, id))
            .for("update");
          const fresh = await visibleSchedule(caller, id, true);
          if (
            !latest ||
            latest.operationId !== operationId ||
            latest.status !== "pending" ||
            (input.action !== "cancel" && scheduleVersion(fresh.schedule) !== input.expectedVersion)
          )
            throw zoomChanged();
          await tx
            .update(meetings)
            .set({
              status: input.action === "cancel" ? "cancelled" : "confirmed",
              meetingId: receipt?.meetingId ?? latest.meetingId,
              joinUrl: input.action === "cancel" ? null : (receipt?.joinUrl ?? null),
              snapshotHash: zoomSnapshot(fresh),
              acceptedAt: new Date(),
            })
            .where(and(eq(meetings.scheduleId, id), eq(meetings.operationId, operationId)));
        });
      } catch {
        // Zoom accepted, but local persistence is unconfirmed. The durable
        // pending intent blocks a duplicate; a human must reconcile it.
        throw zoomProviderError("zoom_needs_review", 409);
      }
      const fresh = await current(caller, id, "cancel");
      return zoomMeetingState(fresh.row, fresh.saved);
    },
  };
}
