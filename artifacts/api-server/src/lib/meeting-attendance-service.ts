import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  dbAdmin,
  meetingAttendanceTable as attempts,
  meetingAssistantWorkspacesTable as workspaces,
  meetingAssistantEventsTable as events,
  meetingNotesTable as notes,
  meetingAssistantCleanupTable as cleanupRequests,
  jobsTable,
  type MeetingAttendance,
} from "@workspace/db";
import { calendarStaff } from "./calendar-staff";
import { meetingScope, saveMeetingNote, type MeetingScope } from "./meeting-notes-service";
import { nativeZoomAttendanceContext, nativeZoomAppointments } from "./native-zoom-recordings";
import { scheduleVersion } from "./coordinator-schedule-version";
import { recallAttendanceProvider } from "./recall-attendance-provider";
import {
  AttendanceError,
  attendanceHash,
  recallEventInput,
  recallState,
  recallBotConfiguration,
  type attendanceApprovalInput,
  type attendanceWorkspaceInput,
  type attendanceImportInput,
} from "./meeting-attendance-core";
import { meetingMediaType } from "./meeting-notes-core";
import { withMeetingAudio } from "./meeting-notes-media";
import { logger } from "./logger";
import { isJobApprovedForInterview, JOB_NOT_APPROVED_MESSAGE } from "./job-approval";
import { withUsageActivity } from "./vendor-usage-context";
import type { z } from "zod";

const provider = recallAttendanceProvider();
const where = (s: MeetingScope, id?: string) =>
  and(
    eq(attempts.tenantId, s.tenantId),
    eq(attempts.jobId, s.jobId),
    eq(attempts.candidateId, s.candidateId),
    id ? eq(attempts.id, id) : undefined,
  );
const changed = () =>
  new AttendanceError(
    409,
    "The appointment, host, workspace or consent changed. Stop the old assistant and review the current appointment.",
  );
const dto = (r: MeetingAttendance) => ({
  id: r.id,
  scheduleId: r.scheduleId,
  state: r.state,
  providerState: r.providerState,
  approvedAt: r.approvedAt.toISOString(),
  stopRequested: Boolean(r.stopRequestedAt),
  mediaDeleted: Boolean(r.mediaDeletedAt),
  importedNoteId: r.importedNoteId,
  updatedAt: r.updatedAt.toISOString(),
});
async function workspace(s: MeetingScope) {
  const [row] = await dbAdmin
    .select()
    .from(workspaces)
    .where(eq(workspaces.tenantId, s.tenantId))
    .limit(1);
  return row;
}
async function context(s: MeetingScope, scheduleId: string) {
  const row = await nativeZoomAttendanceContext(s, scheduleId);
  const [job] = await dbAdmin
    .select({ status: jobsTable.status })
    .from(jobsTable)
    .where(and(eq(jobsTable.id, s.jobId), eq(jobsTable.tenantId, s.tenantId)))
    .limit(1);
  if (!isJobApprovedForInterview(job?.status))
    throw new AttendanceError(409, JOB_NOT_APPROVED_MESSAGE);
  const binding = await workspace(s);
  if (!binding || binding.revokedAt)
    throw new AttendanceError(
      409,
      "A platform administrator must authorize this employer's Recall workspace first.",
    );
  if (!row.meeting.joinUrl || !row.meeting.meetingId) throw changed();
  return {
    row,
    binding,
    hash: attendanceHash({
      schedule: scheduleVersion(row.schedule),
      operation: row.meeting.operationId,
      snapshot: row.meeting.snapshotHash,
      host: row.meeting.hostZoomId,
      account: row.accountRevision,
      binding: binding.revision,
    }),
  };
}
async function attempt(s: MeetingScope, id: string, hostOnly = true) {
  await meetingScope(s.actorId, s.jobId, s.candidateId);
  const [row] = await dbAdmin.select().from(attempts).where(where(s, id)).limit(1);
  if (!row) throw new AttendanceError(404, "Meeting assistant not found.");
  const caller = await calendarStaff(s.actorId);
  if (
    row.hostUserId !== s.actorId &&
    (hostOnly || !["platform_admin", "tenant_admin"].includes(caller.role))
  )
    throw new AttendanceError(
      403,
      "Only the original host or an employer administrator can stop this assistant.",
    );
  return row;
}
async function verify(s: MeetingScope, r: MeetingAttendance) {
  const c = await context(s, r.scheduleId);
  if (
    c.hash !== r.contextHash ||
    c.binding.revision !== r.workspaceRevision ||
    c.binding.connectionId !== r.connectionId ||
    r.stopRequestedAt
  )
    throw changed();
  return c;
}
export async function attendanceView(s: MeetingScope) {
  await meetingScope(s.actorId, s.jobId, s.candidateId);
  const caller = await calendarStaff(s.actorId);
  const binding = await workspace(s);
  return {
    workspaceAuthorized: Boolean(binding && !binding.revokedAt),
    webhookConfigured: Boolean(process.env.RECALL_WEBHOOK_SECRET?.startsWith("whsec_")),
    canAuthorizeWorkspace: caller.role === "platform_admin",
    connections: caller.role === "platform_admin" ? await provider.connections() : [],
    appointments: (await nativeZoomAppointments(s)).map((a) => ({
      scheduleId: a.scheduleId,
      scheduledAt: a.scheduledAt.toISOString(),
      durationMinutes: a.durationMinutes,
    })),
    attempts: (
      await dbAdmin
        .select()
        .from(attempts)
        .where(where(s))
        .orderBy(desc(attempts.createdAt))
        .limit(50)
    ).map(dto),
  };
}
export async function authorizeAttendanceWorkspace(
  s: MeetingScope,
  input: z.infer<typeof attendanceWorkspaceInput>,
) {
  await meetingScope(s.actorId, s.jobId, s.candidateId);
  if ((await calendarStaff(s.actorId)).role !== "platform_admin")
    throw new AttendanceError(403, "Platform administrator authorization is required.");
  await provider.probe(input.connectionId);
  await meetingScope(s.actorId, s.jobId, s.candidateId);
  if ((await calendarStaff(s.actorId)).role !== "platform_admin")
    throw new AttendanceError(403, "Platform administrator authorization is required.");
  const value = {
    tenantId: s.tenantId,
    connectionId: input.connectionId,
    revision: randomUUID(),
    authorizedBy: s.actorId,
    authorizedAt: new Date(),
    revokedAt: null,
  };
  await dbAdmin
    .insert(workspaces)
    .values(value)
    .onConflictDoUpdate({ target: workspaces.tenantId, set: value });
  return attendanceView(s);
}
export async function revokeAttendanceWorkspace(s: MeetingScope) {
  await meetingScope(s.actorId, s.jobId, s.candidateId);
  if (!["platform_admin", "tenant_admin"].includes((await calendarStaff(s.actorId)).role))
    throw new AttendanceError(403, "Employer administrator access is required.");
  await dbAdmin
    .update(workspaces)
    .set({ revokedAt: new Date(), revision: randomUUID() })
    .where(eq(workspaces.tenantId, s.tenantId));
  await dbAdmin
    .update(attempts)
    .set({ stopRequestedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(attempts.tenantId, s.tenantId), isNull(attempts.mediaDeletedAt)));
  return attendanceView(s);
}
export async function approveAttendance(
  s: MeetingScope,
  input: z.infer<typeof attendanceApprovalInput>,
) {
  const c = await context(s, input.scheduleId);
  if (["completed", "no_show", "cancelled"].includes(c.row.schedule.status)) throw changed();
  recallBotConfiguration({
    id: randomUUID(),
    token: randomUUID(),
    joinUrl: c.row.meeting.joinUrl!,
    meetingId: c.row.meeting.meetingId!,
    scheduledAt: c.row.schedule.scheduledAt,
    durationMinutes: c.row.schedule.durationMinutes,
  });
  const [row] = await dbAdmin
    .insert(attempts)
    .values({
      id: randomUUID(),
      tenantId: s.tenantId,
      jobId: s.jobId,
      candidateId: s.candidateId,
      scheduleId: input.scheduleId,
      hostUserId: s.actorId,
      connectionId: c.binding.connectionId,
      workspaceRevision: c.binding.revision,
      contextHash: c.hash,
      consentStatement: input.consentStatement,
      approvedAt: new Date(),
      state: "approved",
    })
    .onConflictDoNothing({
      target: attempts.scheduleId,
      where: sql`${attempts.state} <> 'deleted'`,
    })
    .returning();
  if (!row)
    throw new AttendanceError(
      409,
      "This appointment already has an attendance approval. Use its saved attempt; no duplicate was created.",
    );
  return dto(row);
}
export async function dispatchAttendance(s: MeetingScope, id: string) {
  if (!process.env.RECALL_WEBHOOK_SECRET?.startsWith("whsec_"))
    throw new AttendanceError(
      409,
      "Configure Recall's signed lifecycle webhook before dispatch. Approval can be saved without sending an assistant.",
    );
  const r = await attempt(s, id);
  const c = await verify(s, r);
  if (r.state !== "approved") return dto(r);
  if (["completed", "no_show", "cancelled"].includes(c.row.schedule.status)) throw changed();
  const token = randomUUID();
  const config = {
    id,
    token,
    joinUrl: c.row.meeting.joinUrl!,
    meetingId: c.row.meeting.meetingId!,
    scheduledAt: c.row.schedule.scheduledAt,
    durationMinutes: c.row.schedule.durationMinutes,
  };
  recallBotConfiguration(config); // Validate current timing BEFORE an irreversible dispatch claim.
  const [claimed] = await dbAdmin
    .update(attempts)
    .set({
      state: "dispatching",
      dispatchToken: token,
      updatedAt: new Date(),
    })
    .where(
      and(
        where(s, id),
        eq(attempts.state, "approved"),
        isNull(attempts.stopRequestedAt),
        isNull(attempts.dispatchToken),
      ),
    )
    .returning();
  if (!claimed) throw changed();
  let writeStarted = false;
  try {
    // Recheck after the durable claim and immediately before the one provider write.
    await verify(s, claimed);
    writeStarted = true;
    const bot = await withUsageActivity(s.tenantId, "recruiter", () =>
      provider.create(claimed.connectionId, config),
    );
    if (bot.metadata.lexy_attendance !== id || bot.metadata.lexy_dispatch !== token)
      throw changed();
    // Keep the receipt even if authority changed while Recall was accepting the call.
    await dbAdmin
      .update(attempts)
      .set({ botId: bot.id, state: "scheduled", updatedAt: new Date() })
      .where(
        and(where(s, id), eq(attempts.dispatchToken, token), eq(attempts.state, "dispatching")),
      );
    try {
      await verify(s, await attempt(s, id));
    } catch {
      await dbAdmin
        .update(attempts)
        .set({ stopRequestedAt: new Date(), updatedAt: new Date() })
        .where(where(s, id));
      await cleanupAttendance(id);
    }
  } catch {
    if (!writeStarted) {
      // Authority was lost before any provider write, so there is no ambiguous bot.
      await dbAdmin
        .update(attempts)
        .set({
          state: "deleted",
          dispatchToken: null,
          mediaDeletedAt: new Date(),
          stopRequestedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(where(s, id), eq(attempts.state, "dispatching"), eq(attempts.dispatchToken, token)),
        );
      return dto(await attempt(s, id));
    }
    // A network error, malformed 2xx or interrupted receipt write is NOT proof of no bot.
    await dbAdmin
      .update(attempts)
      .set({ state: "unknown", updatedAt: new Date() })
      .where(and(where(s, id), eq(attempts.state, "dispatching")));
  }
  return dto(await attempt(s, id));
}
export async function recoverAttendance(s: MeetingScope, id: string) {
  const r = await attempt(s, id, false);
  if (r.state !== "unknown" || !r.dispatchToken) throw changed();
  const bot = await provider.recover(r.connectionId, r.id, r.dispatchToken);
  await dbAdmin
    .update(attempts)
    .set({
      botId: bot.id,
      providerState: bot.status_changes.at(-1)?.code ?? null,
      state: r.stopRequestedAt
        ? "stopping"
        : (recallState(bot.status_changes.at(-1)?.code ?? "") ?? "scheduled"),
      updatedAt: new Date(),
    })
    .where(
      and(where(s, id), eq(attempts.state, "unknown"), eq(attempts.dispatchToken, r.dispatchToken)),
    );
  try {
    await verify(s, await attempt(s, id, false));
  } catch {
    await dbAdmin
      .update(attempts)
      .set({ stopRequestedAt: new Date(), updatedAt: new Date() })
      .where(where(s, id));
    await cleanupAttendance(id);
  }
  return dto(await attempt(s, id, false));
}
export async function stopAttendance(s: MeetingScope, id: string) {
  await attempt(s, id, false);
  await dbAdmin
    .update(attempts)
    .set({ stopRequestedAt: new Date(), updatedAt: new Date() })
    .where(where(s, id));
  await cleanupAttendance(id);
  return dto(await attempt(s, id, false));
}
// Service-only cleanup: never needs a still-active user's access to remove remote data.
export async function cleanupAttendance(id: string) {
  const [r] = await dbAdmin.select().from(attempts).where(eq(attempts.id, id)).limit(1);
  if (!r || r.mediaDeletedAt || !r.stopRequestedAt) return;
  if (!r.dispatchToken) {
    await dbAdmin
      .update(attempts)
      .set({ state: "deleted", mediaDeletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(attempts.id, id), isNull(attempts.dispatchToken)));
    return;
  }
  if (!r.botId) return; // Unknown create outcome: preserve the recovery token/receipt.
  const terminal = ["done", "cancelled"].includes(r.providerState ?? "");
  const stopped = terminal
    ? "ended"
    : await withUsageActivity(r.tenantId, "recruiter", () =>
        provider.stop(r.connectionId, r.botId!),
      );
  if (stopped === "pending") {
    await dbAdmin
      .update(attempts)
      .set({ state: "stopping", updatedAt: new Date() })
      .where(eq(attempts.id, id));
    return;
  }
  // Scheduled DELETE removes the bot itself. Otherwise remove all stored media.
  if (stopped === "ended")
    await withUsageActivity(r.tenantId, "recruiter", () =>
      provider.deleteMedia(r.connectionId, r.botId!),
    );
  await dbAdmin
    .update(attempts)
    .set({
      state: "deleted",
      mediaDeletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(attempts.id, id));
}
export async function acceptAttendanceEvent(eventId: string, raw: unknown) {
  const parsed = recallEventInput.safeParse(raw);
  if (!parsed.success) return; // Ignore unrelated provider events without retaining their payloads.
  const e = parsed.data,
    m = e.data.bot.metadata,
    stamp = new Date(e.data.data.updated_at);
  await dbAdmin.transaction(async (tx) => {
    const [fresh] = await tx
      .insert(events)
      .values({ id: eventId })
      .onConflictDoNothing()
      .returning();
    if (!fresh) return;
    // Match BOTH opaque attempt and dispatch token. Never bind by meeting URL or candidate email.
    const [r] = await tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.id, m.lexy_attendance), eq(attempts.dispatchToken, m.lexy_dispatch)))
      .for("update")
      .limit(1);
    if (
      !r ||
      r.mediaDeletedAt ||
      (r.botId && r.botId !== e.data.bot.id) ||
      (r.eventAt && r.eventAt >= stamp)
    )
      return;
    const next = recallState(e.data.data.code);
    // Late join events cannot reopen a finished bot.
    if (r.providerState === "done" && e.data.data.code !== "done") return;
    if (r.providerState === "fatal" && !["done", "fatal"].includes(e.data.data.code)) return;
    await tx
      .update(attempts)
      .set({
        botId: e.data.bot.id,
        providerState: e.data.data.code,
        eventAt: stamp,
        state: r.stopRequestedAt ? "stopping" : (next ?? r.state),
        updatedAt: new Date(),
      })
      .where(eq(attempts.id, r.id));
  });
}
export async function importAttendanceAudio(
  s: MeetingScope,
  id: string,
  input: z.infer<typeof attendanceImportInput>,
) {
  const r = await attempt(s, id);
  await verify(s, r);
  if (r.state !== "done" || !r.botId || !r.dispatchToken || r.mediaDeletedAt) throw changed();
  const key = `recall:${r.id}`;
  const [existing] = await dbAdmin
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.tenantId, s.tenantId),
        eq(notes.jobId, s.jobId),
        eq(notes.candidateId, s.candidateId),
        eq(notes.sourceKey, key),
      ),
    )
    .limit(1);
  let noteId = existing?.id;
  if (existing?.error?.startsWith("Deletion pending.")) throw changed();
  if (!noteId) {
    const audio = await withUsageActivity(s.tenantId, "recruiter", () =>
      provider.audio(r.connectionId, r.botId!, id, r.dispatchToken!),
    );
    const bytes = audio.bytes;
    const mime = meetingMediaType(bytes);
    if (mime !== "audio/mpeg")
      throw new AttendanceError(415, "Recall did not return supported MP3 audio.");
    await withMeetingAudio(bytes, async () => {});
    const recheck = async () => {
      await verify(s, await attempt(s, id));
    };
    await recheck();
    const saved = await saveMeetingNote(
      s,
      { buffer: bytes, originalname: "lexy-meeting.mp3" },
      input,
      mime,
      {
        sourceKey: key,
        recheck,
        source: {
          provider: "recall",
          scheduleId: r.scheduleId,
          meetingId: r.botId,
          hostUserId: r.hostUserId,
          meetingUuid: r.botId,
          fileId: audio.recordingId,
          recordingStart: audio.startedAt,
          recordingEnd: audio.completedAt,
        },
      },
    );
    noteId = saved.id;
  }
  await dbAdmin
    .update(attempts)
    .set({
      importedNoteId: noteId,
      stopRequestedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(where(s, id));
  // Imported evidence stays private and unprocessed; review through the existing notes workflow.
  try {
    await cleanupAttendance(id);
  } catch {
    /* Durable stop request is retried by maintenance. */
  }
  return dto(await attempt(s, id));
}
let maintenanceRunning = false;
export async function maintainAttendance() {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    const requests = await dbAdmin
      .select()
      .from(cleanupRequests)
      .orderBy(cleanupRequests.createdAt)
      .limit(20);
    for (const request of requests) {
      await dbAdmin
        .update(attempts)
        .set({ stopRequestedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(attempts.id, request.attemptId), isNull(attempts.mediaDeletedAt)));
      await dbAdmin.delete(cleanupRequests).where(eq(cleanupRequests.attemptId, request.attemptId));
    }
    const batch = await dbAdmin
      .select()
      .from(attempts)
      .where(isNull(attempts.mediaDeletedAt))
      .orderBy(attempts.updatedAt)
      .limit(20);
    for (const r of batch) {
      const s = {
        actorId: r.hostUserId,
        tenantId: r.tenantId,
        jobId: r.jobId,
        candidateId: r.candidateId,
      };
      let stop = Boolean(r.stopRequestedAt);
      if (!stop) {
        try {
          await verify(s, r);
        } catch {
          stop = true;
        }
      }
      if (r.state === "dispatching" && r.updatedAt.getTime() < Date.now() - 90_000)
        await dbAdmin
          .update(attempts)
          .set({ state: "unknown", updatedAt: new Date() })
          .where(and(eq(attempts.id, r.id), eq(attempts.state, "dispatching")));
      if (stop) {
        await dbAdmin
          .update(attempts)
          .set({ stopRequestedAt: r.stopRequestedAt ?? new Date(), updatedAt: new Date() })
          .where(eq(attempts.id, r.id));
        try {
          await cleanupAttendance(r.id);
        } catch {
          logger.warn({ attendanceId: r.id }, "Recall cleanup remains pending");
        }
      } else if (r.state !== "dispatching") {
        await dbAdmin.update(attempts).set({ updatedAt: new Date() }).where(eq(attempts.id, r.id));
      }
    }
    await dbAdmin.delete(events).where(lt(events.receivedAt, new Date(Date.now() - 7 * 86400_000)));
  } finally {
    maintenanceRunning = false;
  }
}
