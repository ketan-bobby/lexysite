import type { z } from "zod";
import type { MeetingScope } from "./meeting-notes-service";
import type { nativeZoomImportInput } from "./native-recording-review";
import {
  googleMeetRecordingsProvider,
  meetRecordingFingerprint,
  GoogleMeetRecordingError,
  type MeetRecordingFile,
  type MeetRecordingWindow,
} from "./google-meet-recordings-provider";
import {
  meetRecordingChanged,
  readMeetRecordingReview,
  signMeetRecordingReview,
  meetRecordingSourceKey,
  type NativeMeetReview,
} from "./native-meet-recording-review";
import { digest } from "./google-staff-config";

export type NativeMeetContext = {
  scheduleId: string;
  binding: string;
  accountRevision: string;
  subjectHash: string;
  window: MeetRecordingWindow;
};
type Provider = ReturnType<typeof googleMeetRecordingsProvider>;
export type NativeMeetDependencies<T> = {
  context: (scope: MeetingScope, scheduleId: string) => Promise<NativeMeetContext>;
  access: (
    scope: MeetingScope,
    context: NativeMeetContext,
  ) => Promise<{ accessToken: string; subject: string }>;
  provider: Provider;
  existing: (scope: MeetingScope, key: string) => Promise<T | undefined>;
  validateMedia: (bytes: Buffer) => Promise<void>;
  save: (
    scope: MeetingScope,
    input: z.infer<typeof nativeZoomImportInput>,
    bytes: Buffer,
    file: MeetRecordingFile,
    key: string,
    recheck: () => Promise<void>,
  ) => Promise<T>;
  now?: () => number;
};
export function nativeMeetRecordings<T>(deps: NativeMeetDependencies<T>) {
  const now = deps.now ?? Date.now;
  const current = async (scope: MeetingScope, prior: NativeMeetContext) => {
    const latest = await deps.context(scope, prior.scheduleId);
    if (JSON.stringify(latest) !== JSON.stringify(prior)) throw meetRecordingChanged();
    return latest;
  };
  const access = async (scope: MeetingScope, context: NativeMeetContext) => {
    const grant = await deps.access(scope, context);
    if (digest(grant.subject) !== context.subjectHash) throw meetRecordingChanged();
    await current(scope, context);
    return grant.accessToken;
  };
  const verify = (scope: MeetingScope, context: NativeMeetContext, claims: NativeMeetReview) => {
    if (
      claims.actorId !== scope.actorId ||
      claims.tenantId !== scope.tenantId ||
      claims.jobId !== scope.jobId ||
      claims.candidateId !== scope.candidateId ||
      claims.scheduleId !== context.scheduleId ||
      claims.binding !== context.binding ||
      claims.accountRevision !== context.accountRevision ||
      claims.subjectHash !== context.subjectHash
    )
      throw meetRecordingChanged();
  };
  return {
    async conferences(scope: MeetingScope, scheduleId: string) {
      const context = await deps.context(scope, scheduleId);
      const token = await access(scope, context);
      const rows = await deps.provider.conferences(token, context.window);
      await current(scope, context);
      return rows.map((row) => ({ name: row.name, start: row.startTime, end: row.endTime! }));
    },
    async preview(scope: MeetingScope, scheduleId: string, conferenceName: string) {
      const context = await deps.context(scope, scheduleId);
      const token = await access(scope, context);
      const recording = await deps.provider.preview(token, context.window, conferenceName);
      await current(scope, context);
      return {
        scheduleId,
        recordedAt: recording.conference.startTime,
        files: recording.files.map((file) => ({
          id: file.fileId,
          format: "MP4" as const,
          kind: "Google Meet recording",
          bytes: file.bytes,
          start: file.start,
          end: file.end,
          eligible: file.eligible,
          unavailableReason: file.unavailableReason,
          reviewToken: file.eligible
            ? signMeetRecordingReview({
                actorId: scope.actorId,
                tenantId: scope.tenantId,
                jobId: scope.jobId,
                candidateId: scope.candidateId,
                scheduleId,
                binding: context.binding,
                accountRevision: context.accountRevision,
                subjectHash: context.subjectHash,
                spaceName: file.spaceName,
                conferenceName: file.conferenceName,
                fileId: file.fileId,
                fileHash: meetRecordingFingerprint(file),
                expires: now() + 600_000,
              })
            : null,
        })),
      };
    },
    async import(scope: MeetingScope, input: z.infer<typeof nativeZoomImportInput>) {
      if (input.consent !== true || input.consentStatement.trim().length < 20)
        throw new GoogleMeetRecordingError(
          400,
          "Confirm participant consent and the selected interview source before importing.",
        );
      const claims = readMeetRecordingReview(input.reviewToken, now());
      // Audience is checked before resolving any signed-but-foreign appointment.
      if (
        claims.actorId !== scope.actorId ||
        claims.tenantId !== scope.tenantId ||
        claims.jobId !== scope.jobId ||
        claims.candidateId !== scope.candidateId
      )
        throw meetRecordingChanged();
      const context = await deps.context(scope, claims.scheduleId);
      verify(scope, context, claims);
      const recheck = async () => {
        readMeetRecordingReview(input.reviewToken, now());
        verify(scope, await current(scope, context), claims);
      };
      const key = meetRecordingSourceKey(claims);
      const existing = await deps.existing(scope, key);
      if (existing) {
        await recheck();
        return existing;
      }
      const token = await access(scope, context);
      const recording = await deps.provider.preview(token, context.window, claims.conferenceName);
      const file = recording.files.find((row) => row.fileId === claims.fileId);
      if (
        !file?.eligible ||
        file.spaceName !== claims.spaceName ||
        file.conferenceName !== claims.conferenceName ||
        meetRecordingFingerprint(file) !== claims.fileHash
      )
        throw meetRecordingChanged();
      await recheck();
      const bytes = await deps.provider.download(token, file);
      await deps.validateMedia(bytes);
      await recheck();
      return deps.save(scope, input, bytes, file, key, recheck);
    },
  };
}
