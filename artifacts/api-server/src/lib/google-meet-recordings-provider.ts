import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { meteredFetch } from "./vendor-usage";
import { MAX_MEETING_BYTES, MAX_MEETING_SECONDS } from "./meeting-notes-core";

/** Separate, opt-in grants. These are deliberately NOT calendar consent defaults. */
export const GOOGLE_MEET_RECORDING_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.readonly",
  "https://www.googleapis.com/auth/drive.meet.readonly",
] as const;

export class GoogleMeetRecordingError extends Error {
  get statusCode() {
    return this.status;
  }
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const unavailable = () =>
  new GoogleMeetRecordingError(
    503,
    "Google did not confirm accessible Meet recording evidence. Load a fresh preview or use recording upload.",
  );
const changed = () =>
  new GoogleMeetRecordingError(
    409,
    "The meeting instance or recording changed. Load a fresh preview before importing.",
  );
const id = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const stamp = z.iso.datetime({ offset: true });
const conferenceName = z.string().regex(/^conferenceRecords\/[A-Za-z0-9_-]{1,160}$/);
const spaceName = z.string().regex(/^spaces\/[A-Za-z0-9_-]{1,160}$/);
const windowSchema = z
  .object({
    meetingCode: z.string().regex(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/),
    windowStart: stamp,
    windowEnd: stamp,
  })
  .strict()
  .refine((row) => {
    const duration = Date.parse(row.windowEnd) - Date.parse(row.windowStart);
    return duration > 0 && duration <= 24 * 60 * 60_000;
  });
export type MeetRecordingWindow = z.infer<typeof windowSchema>;
const spaceSchema = z.object({ name: spaceName, meetingCode: z.string() });
const conferenceSchema = z.object({
  name: conferenceName,
  space: spaceName,
  startTime: stamp,
  endTime: stamp.optional(),
});
const recordingSchema = z.object({
  name: z
    .string()
    .regex(/^conferenceRecords\/[A-Za-z0-9_-]{1,160}\/recordings\/[A-Za-z0-9_-]{1,160}$/),
  state: z.enum(["STATE_UNSPECIFIED", "STARTED", "ENDED", "FILE_GENERATED"]),
  startTime: stamp.optional(),
  endTime: stamp.optional(),
  driveDestination: z.object({ file: id }).optional(),
});
const driveSchema = z.object({
  id,
  mimeType: z.literal("video/mp4"),
  size: z.string().regex(/^[1-9]\d{0,15}$/),
  version: z.string().regex(/^[1-9]\d{0,19}$/),
  md5Checksum: z.string().regex(/^[a-f0-9]{32}$/),
  modifiedTime: stamp,
  trashed: z.literal(false),
  capabilities: z.object({ canDownload: z.literal(true) }),
  videoMediaMetadata: z.object({
    durationMillis: z.string().regex(/^[1-9]\d{0,15}$/),
  }),
});
export type MeetRecordingFile = {
  name: string;
  conferenceName: string;
  spaceName: string;
  fileId: string;
  start: string;
  end: string;
  bytes: number;
  durationMillis: number;
  version: string;
  md5Checksum: string;
  modifiedTime: string;
  eligible: boolean;
  unavailableReason: string | null;
};
export function meetRecordingFingerprint(file: MeetRecordingFile) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        file.name,
        file.conferenceName,
        file.spaceName,
        file.fileId,
        file.start,
        file.end,
        file.bytes,
        file.durationMillis,
        file.version,
        file.md5Checksum,
        file.modifiedTime,
      ]),
    )
    .digest("hex");
}
async function boundedBody(response: Response, maximum: number) {
  if (!response.body) throw unavailable();
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) {
    await response.body.cancel().catch(() => {});
    throw new GoogleMeetRecordingError(413, "The Google response exceeds the supported size.");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw new GoogleMeetRecordingError(413, "The Google response exceeds the supported size.");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
const driveFields =
  "id,mimeType,size,version,md5Checksum,modifiedTime,trashed,capabilities(canDownload),videoMediaMetadata(durationMillis)";

/**
 * Read-only provider boundary, not authorization for an application import.
 * The caller must bind the staff grant, job, candidate and appointment, obtain
 * consent, sign the preview and revalidate that authority before persistence.
 * No account-wide Drive listing, arbitrary URL fetch, processing or scoring.
 */
export function googleMeetRecordingsProvider(request: typeof fetch = meteredFetch("google_meet")) {
  async function get(
    token: string,
    url: URL,
    maximum = 2 * 1024 * 1024,
    signal = AbortSignal.timeout(20_000),
  ) {
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await request(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal,
      });
      if (response.status === 401 || response.status === 403)
        throw new GoogleMeetRecordingError(
          409,
          "The connected organizer needs separate Meet metadata and Meet-created Drive recording read access. Calendar consent alone is insufficient.",
        );
      if (response.status === 404)
        throw new GoogleMeetRecordingError(
          404,
          "This meeting or recording is no longer accessible. No recording was imported.",
        );
      // Partial bodies and redirects must never be treated as a complete recording.
      if (response.status !== 200) throw unavailable();
      return await boundedBody(response, maximum);
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (error instanceof GoogleMeetRecordingError) throw error;
      // Never surface Google's body, a bearer token, or a signed playback URL.
      throw unavailable();
    }
  }
  async function json<T>(
    token: string,
    url: URL,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const body = await get(token, url, 2 * 1024 * 1024, signal);
    try {
      return schema.parse(JSON.parse(body.toString("utf8")));
    } catch {
      throw unavailable();
    }
  }
  async function resolveSpace(token: string, raw: MeetRecordingWindow, signal: AbortSignal) {
    const parsed = windowSchema.safeParse(raw);
    if (!parsed.success)
      throw new GoogleMeetRecordingError(
        400,
        "Select a valid meeting and a window of at most one day.",
      );
    const input = parsed.data;
    const space = await json(
      token,
      new URL(`https://meet.googleapis.com/v2/spaces/${input.meetingCode}`),
      spaceSchema,
      signal,
    );
    if (space.meetingCode !== input.meetingCode) throw changed();
    return { input, space };
  }
  function checkConference(
    conference: z.infer<typeof conferenceSchema>,
    space: string,
    input: MeetRecordingWindow,
  ) {
    if (
      conference.space !== space ||
      Date.parse(conference.startTime) < Date.parse(input.windowStart) ||
      Date.parse(conference.startTime) >= Date.parse(input.windowEnd) ||
      (conference.endTime && Date.parse(conference.endTime) <= Date.parse(conference.startTime))
    )
      throw changed();
  }
  async function drive(token: string, fileId: string, signal: AbortSignal) {
    if (!id.safeParse(fileId).success) throw changed();
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.searchParams.set("fields", driveFields);
    const file = await json(token, url, driveSchema, signal);
    if (file.id !== fileId) throw changed();
    return file;
  }
  return {
    async conferences(token: string, raw: MeetRecordingWindow) {
      const signal = AbortSignal.timeout(20_000);
      const { input, space } = await resolveSpace(token, raw, signal);
      const url = new URL("https://meet.googleapis.com/v2/conferenceRecords");
      url.searchParams.set("pageSize", "100");
      url.searchParams.set(
        "filter",
        `space.name = "${space.name}" AND start_time >= "${input.windowStart}" AND start_time < "${input.windowEnd}"`,
      );
      const result = await json(
        token,
        url,
        z.object({
          conferenceRecords: z.array(conferenceSchema).max(100).default([]),
          nextPageToken: z.string().max(4096).optional(),
        }),
        signal,
      );
      if (result.nextPageToken)
        throw new GoogleMeetRecordingError(
          409,
          "Too many meeting instances. Select a narrower window.",
        );
      const seen = new Set<string>();
      for (const row of result.conferenceRecords) {
        checkConference(row, space.name, input);
        if (seen.has(row.name)) throw unavailable();
        seen.add(row.name);
      }
      return result.conferenceRecords.filter((row) => row.endTime != null);
    },
    async preview(token: string, raw: MeetRecordingWindow, name: string) {
      if (!conferenceName.safeParse(name).success) throw changed();
      const signal = AbortSignal.timeout(60_000);
      const { input, space } = await resolveSpace(token, raw, signal);
      const conference = await json(
        token,
        new URL(`https://meet.googleapis.com/v2/${name}`),
        conferenceSchema,
        signal,
      );
      if (conference.name !== name || !conference.endTime) throw changed();
      checkConference(conference, space.name, input);
      const result = await json(
        token,
        new URL(`https://meet.googleapis.com/v2/${name}/recordings?pageSize=100`),
        z.object({
          recordings: z.array(recordingSchema).max(100).default([]),
          nextPageToken: z.string().max(4096).optional(),
        }),
        signal,
      );
      if (result.nextPageToken || result.recordings.length > 20)
        throw new GoogleMeetRecordingError(
          409,
          "Too many recordings for this instance. Use recording upload.",
        );
      const seen = new Set<string>();
      const files: MeetRecordingFile[] = [];
      for (const row of result.recordings) {
        if (!row.name.startsWith(`${name}/recordings/`) || seen.has(row.name)) throw changed();
        seen.add(row.name);
        if (row.state !== "FILE_GENERATED") continue;
        if (!row.startTime || !row.endTime || !row.driveDestination) throw unavailable();
        const seconds = (Date.parse(row.endTime) - Date.parse(row.startTime)) / 1000;
        if (
          seconds <= 0 ||
          Date.parse(row.startTime) < Date.parse(conference.startTime) ||
          Date.parse(row.endTime) > Date.parse(conference.endTime)
        )
          throw changed();
        const metadata = await drive(token, row.driveDestination.file, signal);
        const bytes = Number(metadata.size);
        const durationMillis = Number(metadata.videoMediaMetadata.durationMillis);
        if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(durationMillis))
          throw unavailable();
        const eligible =
          bytes <= MAX_MEETING_BYTES &&
          seconds <= MAX_MEETING_SECONDS &&
          durationMillis <= MAX_MEETING_SECONDS * 1000;
        files.push({
          name: row.name,
          conferenceName: name,
          spaceName: space.name,
          fileId: metadata.id,
          start: row.startTime,
          end: row.endTime,
          bytes,
          durationMillis,
          version: metadata.version,
          md5Checksum: metadata.md5Checksum,
          modifiedTime: metadata.modifiedTime,
          eligible,
          unavailableReason: eligible
            ? null
            : "This recording exceeds the 100 MB / 60-minute processing bounds. Export the full meeting as compressed audio within these bounds.",
        });
      }
      return { conference, files };
    },
    async download(token: string, expected: MeetRecordingFile) {
      const signal = AbortSignal.timeout(60_000);
      // Only a fresh server-side preview should reach this method. This check
      // prevents forged IDs/oversize metadata from even starting a media request.
      if (
        !expected.eligible ||
        !id.safeParse(expected.fileId).success ||
        !Number.isSafeInteger(expected.bytes) ||
        expected.bytes < 1 ||
        expected.bytes > MAX_MEETING_BYTES ||
        !Number.isSafeInteger(expected.durationMillis) ||
        expected.durationMillis < 1 ||
        expected.durationMillis > MAX_MEETING_SECONDS * 1000
      )
        throw changed();
      const verify = async () => {
        const metadata = await drive(token, expected.fileId, signal);
        if (
          metadata.version !== expected.version ||
          metadata.md5Checksum !== expected.md5Checksum ||
          Number(metadata.size) !== expected.bytes ||
          metadata.modifiedTime !== expected.modifiedTime ||
          Number(metadata.videoMediaMetadata.durationMillis) !== expected.durationMillis
        )
          throw changed();
      };
      await verify();
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${expected.fileId}?alt=media`);
      const bytes = await get(token, url, MAX_MEETING_BYTES, signal);
      if (
        bytes.length !== expected.bytes ||
        createHash("md5").update(bytes).digest("hex") !== expected.md5Checksum
      )
        throw changed();
      await verify();
      return bytes;
    },
  };
}
