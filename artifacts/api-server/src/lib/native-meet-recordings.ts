import { and, desc, eq } from "drizzle-orm";
import {
  dbAdmin,
  interviewCalendarInvitationAttemptsTable as attempts,
  interviewSchedulesTable as schedules,
  applicationsTable as applications,
  candidatesTable as candidates,
  jobsTable as jobs,
  staffGoogleCalendarsTable as calendars,
  meetingNotesTable as notes,
} from "@workspace/db";
import {
  meetingScope,
  meetingNoteDTO,
  saveMeetingNote,
  type MeetingScope,
} from "./meeting-notes-service";
import {
  makeMeetRecordingAccount,
  meetRecordingStaffActor,
} from "../routes/google-meet-recording-account";
import { googleStaffConfig } from "./google-staff-config";
import { verifyNativeMeetReceipt } from "./native-meet-recording-context";
import { nativeMeetRecordings } from "./native-meet-recording-core";
import {
  googleMeetRecordingsProvider,
  GoogleMeetRecordingError,
} from "./google-meet-recordings-provider";
import { meetRecordingChanged, readMeetRecordingReview } from "./native-meet-recording-review";
import { meetingMediaType } from "./meeting-notes-core";
import { withMeetingAudio } from "./meeting-notes-media";
import { withUsageActivity } from "./vendor-usage-context";
import { readGoogleInvitationPanel } from "./google-invitation-panel";
import { calendarStaff } from "./calendar-staff";

async function rows(scope: MeetingScope, scheduleId?: string) {
  const fresh = await meetingScope(scope.actorId, scope.jobId, scope.candidateId);
  if (fresh.tenantId !== scope.tenantId) throw meetRecordingChanged();
  const actor = await meetRecordingStaffActor(scope.actorId);
  const records = await dbAdmin
    .select({
      schedule: schedules,
      application: applications,
      candidate: candidates,
      job: jobs,
      attempt: attempts,
      connection: calendars,
    })
    .from(attempts)
    .innerJoin(schedules, eq(schedules.id, attempts.scheduleId))
    .innerJoin(applications, eq(applications.id, schedules.applicationId))
    .innerJoin(candidates, eq(candidates.id, applications.candidateId))
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(
      calendars,
      and(eq(calendars.userId, actor.id), eq(calendars.tenantId, actor.tenantId)),
    )
    .where(
      and(
        eq(schedules.tenantId, scope.tenantId),
        eq(jobs.tenantId, scope.tenantId),
        eq(applications.jobId, scope.jobId),
        eq(applications.candidateId, scope.candidateId),
        eq(attempts.candidateId, scope.candidateId),
        eq(attempts.applicationId, applications.id),
        eq(attempts.organizerId, scope.actorId),
        eq(attempts.provider, "google"),
        eq(attempts.status, "accepted"),
        scheduleId ? eq(schedules.id, scheduleId) : undefined,
      ),
    )
    .orderBy(desc(schedules.scheduledAt))
    .limit(scheduleId ? 1 : 20);
  const staff = records.some((row) => row.schedule.panelRevision)
    ? await calendarStaff(scope.actorId)
    : null;
  return {
    actor,
    records: await Promise.all(
      records.map(async (row) => ({
        ...row,
        panel:
          row.schedule.panelRevision && staff
            ? await dbAdmin.transaction((tx) => readGoogleInvitationPanel(tx, staff, row))
            : undefined,
      })),
    ),
  };
}
export async function nativeMeetAppointments(scope: MeetingScope) {
  const { actor, records } = await rows(scope);
  return records.flatMap((row) => {
    try {
      verifyNativeMeetReceipt(
        {
          context: row,
          connection: row.connection,
          attempt: row.attempt,
          hoursAllowed: false,
          panel: row.panel,
        },
        actor,
        googleStaffConfig()?.fingerprint,
      );
      return [
        {
          scheduleId: row.schedule.id,
          scheduledAt: row.schedule.scheduledAt,
          durationMinutes: row.schedule.durationMinutes,
        },
      ];
    } catch {
      return [];
    }
  });
}
async function context(scope: MeetingScope, scheduleId: string) {
  const { actor, records } = await rows(scope, scheduleId);
  const row = records[0];
  if (!row)
    throw new GoogleMeetRecordingError(
      404,
      "A verified Google Meet interview organized by you was not found in this candidate/job context.",
    );
  const proof = verifyNativeMeetReceipt(
    {
      context: row,
      connection: row.connection,
      attempt: row.attempt,
      hoursAllowed: false,
      panel: row.panel,
    },
    actor,
    googleStaffConfig()?.fingerprint,
  );
  const status = await makeMeetRecordingAccount().status(actor);
  if (!status.canReadRecordings || !status.revision)
    throw new GoogleMeetRecordingError(
      409,
      "Connect your separate Google Meet recording account in Calendar settings first. The original Google organizer account and recording permissions are required.",
    );
  return { scheduleId, ...proof, accountRevision: status.revision };
}
export const nativeMeetService = nativeMeetRecordings({
  context,
  access: async (scope, context) =>
    makeMeetRecordingAccount().access(
      await meetRecordingStaffActor(scope.actorId),
      context.accountRevision,
    ),
  provider: {
    conferences: (token, window) => googleMeetRecordingsProvider().conferences(token, window),
    preview: (token, window, name) => googleMeetRecordingsProvider().preview(token, window, name),
    download: (token, file) => googleMeetRecordingsProvider().download(token, file),
  },
  existing: async (scope, key) => {
    const [row] = await dbAdmin
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
    if (row?.error?.startsWith("Deletion pending.")) throw meetRecordingChanged();
    return row ? meetingNoteDTO(row) : undefined;
  },
  validateMedia: async (bytes) => {
    if (meetingMediaType(bytes) !== "video/mp4")
      throw new GoogleMeetRecordingError(
        415,
        "Google returned unsupported recording bytes. Nothing was imported.",
      );
    await withMeetingAudio(bytes, async () => {});
  },
  save: async (scope, input, bytes, file, sourceKey, recheck) => {
    const claims = readMeetRecordingReview(input.reviewToken);
    return saveMeetingNote(
      scope,
      { buffer: bytes, originalname: `google-meet-${file.fileId}.mp4` },
      input,
      "video/mp4",
      {
        sourceKey,
        recheck,
        source: {
          provider: "google_meet",
          scheduleId: claims.scheduleId,
          meetingId: file.spaceName,
          meetingUuid: file.conferenceName,
          fileId: file.fileId,
          hostUserId: scope.actorId,
          recordingStart: file.start,
          recordingEnd: file.end,
        },
      },
    );
  },
});
// Attribute only real, explicitly requested provider reads to the staff/job scope.
export const withNativeMeetUsage = <T>(scope: MeetingScope, fn: () => Promise<T>) =>
  withUsageActivity(scope.tenantId, "recruiter", fn);
