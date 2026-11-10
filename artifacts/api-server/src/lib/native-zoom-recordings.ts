import { and, desc, eq } from "drizzle-orm";
import {
  dbAdmin,
  interviewZoomMeetingsTable as meetings,
  interviewSchedulesTable as schedules,
  applicationsTable as applications,
  meetingNotesTable as notes,
} from "@workspace/db";
import { zoomStaffAccountService, zoomStaffActor } from "./zoom-staff-account";
import { zoomRecordingsProvider, NativeRecordingError } from "./zoom-recordings-provider";
import {
  meetingScope,
  meetingNoteDTO,
  saveMeetingNote,
  type MeetingScope,
} from "./meeting-notes-service";
import { meetingMediaType } from "./meeting-notes-core";
import { withMeetingAudio } from "./meeting-notes-media";
import { withUsageActivity } from "./vendor-usage-context";
import {
  signRecordingReview,
  readRecordingReview,
  recordingFileHash,
  nativeRecordingKey,
  type NativeRecordingClaims,
  nativeZoomImportInput,
} from "./native-recording-review";
import type { z } from "zod";
import { scheduleVersion } from "./coordinator-schedule-version";

const account = zoomStaffAccountService();
const provider = zoomRecordingsProvider();
const changed = () =>
  new NativeRecordingError(
    409,
    "The appointment, host, account or recording changed. Load a fresh recording preview.",
  );
const meetingWhere = (scope: MeetingScope, scheduleId?: string) =>
  and(
    eq(meetings.tenantId, scope.tenantId),
    eq(meetings.candidateId, scope.candidateId),
    eq(schedules.tenantId, scope.tenantId),
    eq(applications.jobId, scope.jobId),
    eq(applications.candidateId, scope.candidateId),
    eq(meetings.hostUserId, scope.actorId),
    eq(meetings.status, "confirmed"),
    scheduleId ? eq(meetings.scheduleId, scheduleId) : undefined,
  );
export async function nativeZoomAttendanceContext(scope: MeetingScope, scheduleId: string) {
  const fresh = await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
  if (fresh.tenantId !== scope.tenantId) throw changed();
  const [row] = await dbAdmin
    .select({ meeting: meetings, schedule: schedules })
    .from(meetings)
    .innerJoin(schedules, eq(schedules.id, meetings.scheduleId))
    .innerJoin(applications, eq(applications.id, schedules.applicationId))
    .where(meetingWhere(fresh, scheduleId))
    .limit(1);
  if (!row?.meeting.meetingId || row.schedule.status === "cancelled")
    throw new NativeRecordingError(
      404,
      "A confirmed Zoom appointment hosted by you was not found in this interview context.",
    );
  const actor = await zoomStaffActor(scope.actorId);
  const state = await account.status(actor);
  if (!state.connected || !state.revision)
    throw new NativeRecordingError(
      409,
      "Connect the original Zoom host in Calendar settings before loading cloud recordings. Cloud-recording permission and an eligible Zoom account are required.",
    );
  return { ...row, actor, accountRevision: state.revision };
}
const context = nativeZoomAttendanceContext;
function verifyContext(
  row: Awaited<ReturnType<typeof context>>,
  claims: NativeRecordingClaims,
  scope: MeetingScope,
) {
  if (
    claims.actorId !== scope.actorId ||
    claims.tenantId !== scope.tenantId ||
    claims.jobId !== scope.jobId ||
    claims.candidateId !== scope.candidateId ||
    claims.scheduleVersion !== scheduleVersion(row.schedule) ||
    claims.operationId !== row.meeting.operationId ||
    claims.snapshotHash !== row.meeting.snapshotHash ||
    claims.meetingId !== row.meeting.meetingId ||
    claims.hostZoomId !== row.meeting.hostZoomId ||
    claims.accountRevision !== row.accountRevision
  )
    throw changed();
}
export async function nativeZoomAppointments(scope: MeetingScope) {
  const fresh = await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
  return (
    await dbAdmin
      .select({
        scheduleId: meetings.scheduleId,
        scheduledAt: schedules.scheduledAt,
        durationMinutes: schedules.durationMinutes,
        status: schedules.status,
      })
      .from(meetings)
      .innerJoin(schedules, eq(schedules.id, meetings.scheduleId))
      .innerJoin(applications, eq(applications.id, schedules.applicationId))
      .where(meetingWhere(fresh))
      .orderBy(desc(schedules.scheduledAt))
      .limit(20)
  )
    .filter((row) => row.status !== "cancelled")
    .map(({ status: _status, ...row }) => row);
}
export async function previewNativeZoom(scope: MeetingScope, scheduleId: string) {
  const row = await context(scope, scheduleId);
  const grant = await account.access(row.actor, row.accountRevision);
  if (grant.zoomUserId !== row.meeting.hostZoomId) throw changed();
  const recording = await withUsageActivity(scope.tenantId, "recruiter", () =>
    provider.list(
      grant.accessToken,
      row.meeting.meetingId!,
      row.meeting.meetingId!,
      row.meeting.hostZoomId,
    ),
  );
  const latest = await context(scope, scheduleId);
  if (
    latest.meeting.operationId !== row.meeting.operationId ||
    latest.meeting.snapshotHash !== row.meeting.snapshotHash ||
    scheduleVersion(latest.schedule) !== scheduleVersion(row.schedule) ||
    latest.meeting.meetingId !== row.meeting.meetingId ||
    latest.meeting.hostZoomId !== row.meeting.hostZoomId ||
    latest.accountRevision !== row.accountRevision
  )
    throw changed();
  return {
    scheduleId,
    recordedAt: recording.recordedAt,
    files: recording.files.map(({ downloadUrl: _url, ...file }) => ({
      ...file,
      reviewToken: file.eligible
        ? signRecordingReview({
            actorId: scope.actorId,
            tenantId: scope.tenantId,
            jobId: scope.jobId,
            candidateId: scope.candidateId,
            scheduleId,
            scheduleVersion: scheduleVersion(row.schedule),
            operationId: row.meeting.operationId,
            snapshotHash: row.meeting.snapshotHash,
            accountRevision: row.accountRevision,
            hostZoomId: row.meeting.hostZoomId,
            meetingId: recording.meetingId,
            uuid: recording.uuid,
            fileId: file.id,
            fileHash: recordingFileHash({ ...file, downloadUrl: _url }),
            expires: Date.now() + 10 * 60_000,
          })
        : null,
    })),
  };
}
export async function importNativeZoom(
  scope: MeetingScope,
  input: z.infer<typeof nativeZoomImportInput>,
) {
  const claims = readRecordingReview(input.reviewToken);
  // Validate audience before resolving a caller-supplied/signed appointment ID.
  if (
    claims.actorId !== scope.actorId ||
    claims.tenantId !== scope.tenantId ||
    claims.jobId !== scope.jobId ||
    claims.candidateId !== scope.candidateId
  )
    throw changed();
  const row = await context(scope, claims.scheduleId);
  verifyContext(row, claims, scope);
  const key = nativeRecordingKey(claims);
  const [existing] = await dbAdmin
    .select()
    .from(notes)
    .where(
      and(
        eq(notes.tenantId, scope.tenantId),
        eq(notes.jobId, scope.jobId),
        eq(notes.candidateId, scope.candidateId),
        eq(notes.sourceKey, key),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.error?.startsWith("Deletion pending.")) throw changed();
    verifyContext(await context(scope, claims.scheduleId), claims, scope);
    return meetingNoteDTO(existing);
  }
  const grant = await account.access(row.actor, row.accountRevision);
  if (grant.zoomUserId !== claims.hostZoomId) throw changed();
  const recording = await withUsageActivity(scope.tenantId, "recruiter", () =>
    provider.list(grant.accessToken, claims.uuid, claims.meetingId, claims.hostZoomId),
  );
  const selected = recording.files.find((file) => file.id === claims.fileId);
  if (
    recording.uuid !== claims.uuid ||
    !selected?.eligible ||
    recordingFileHash(selected) !== claims.fileHash
  )
    throw changed();
  const recheck = async () => {
    readRecordingReview(input.reviewToken);
    verifyContext(await context(scope, claims.scheduleId), claims, scope);
  };
  await recheck();
  const bytes = await withUsageActivity(scope.tenantId, "recruiter", () =>
    provider.download(grant.accessToken, selected),
  );
  const mime = meetingMediaType(bytes);
  if (mime !== "video/mp4" && mime !== "audio/mp4")
    throw new NativeRecordingError(
      415,
      "Zoom returned unsupported recording bytes. No recording was imported.",
    );
  // Decode/validate the real media before creating a durable private copy.
  await withMeetingAudio(bytes, async () => {});
  await recheck();
  return saveMeetingNote(
    scope,
    {
      buffer: bytes,
      originalname: `zoom-${selected.id}.${selected.format.toLowerCase()}`,
    },
    input,
    mime,
    {
      sourceKey: key,
      recheck,
      source: {
        provider: "zoom",
        scheduleId: claims.scheduleId,
        meetingId: claims.meetingId,
        meetingUuid: claims.uuid,
        fileId: claims.fileId,
        hostUserId: scope.actorId,
        recordingStart: selected.start,
        recordingEnd: selected.end,
      },
    },
  );
}
