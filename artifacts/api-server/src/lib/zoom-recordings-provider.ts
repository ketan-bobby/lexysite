import { z } from "zod/v4";
import { meteredFetch } from "./vendor-usage";
import { MAX_MEETING_BYTES, MAX_MEETING_SECONDS } from "./meeting-notes-core";

export class NativeRecordingError extends Error {
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
  new NativeRecordingError(
    503,
    "Zoom did not confirm accessible recording evidence. Retry the preview explicitly, or use the existing recording upload.",
  );
const stamp = z.iso.datetime({ offset: true });
const file = z
  .object({
    id: z.string().min(1).max(160),
    file_type: z.string().max(40),
    recording_type: z.string().max(100).optional(),
    status: z.string().max(40),
    file_size: z.number().int().nonnegative(),
    recording_start: stamp.optional(),
    recording_end: stamp.optional(),
    download_url: z.string().max(8000).optional(),
  })
  .passthrough();
const recording = z
  .object({
    id: z.union([z.number().int().positive(), z.string().regex(/^\d{9,15}$/)]),
    uuid: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9+/=]+$/),
    host_id: z.string().min(1).max(255),
    start_time: stamp,
    recording_files: z.array(file).max(100),
  })
  .passthrough();
export type ZoomRecordingFile = {
  id: string;
  format: "MP4" | "M4A";
  kind: string;
  bytes: number;
  start: string;
  end: string;
  downloadUrl: string;
  eligible: boolean;
  unavailableReason: string | null;
};
export type ZoomRecording = {
  meetingId: string;
  uuid: string;
  hostId: string;
  recordedAt: string;
  files: ZoomRecordingFile[];
};
export function zoomRecordingUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unavailable();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !(
      url.hostname === "zoom.us" ||
      url.hostname.endsWith(".zoom.us") ||
      url.hostname === "zoom.com" ||
      url.hostname.endsWith(".zoom.com")
    ) ||
    !url.pathname.startsWith("/rec/")
  )
    throw unavailable();
  return url;
}
export async function boundedRecordingBody(response: Response, maximum: number): Promise<Buffer> {
  if (!response.body) throw unavailable();
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) {
    await response.body.cancel().catch(() => {});
    throw new NativeRecordingError(413, "The recording exceeds the supported size.");
  }
  const reader = response.body.getReader(),
    chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel().catch(() => {});
        throw new NativeRecordingError(413, "The recording exceeds the supported size.");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export function parseZoomRecording(raw: unknown, meetingId: string, hostId: string): ZoomRecording {
  const parsed = recording.safeParse(raw);
  if (!parsed.success || String(parsed.data.id) !== meetingId || parsed.data.host_id !== hostId)
    throw unavailable();
  const seen = new Set<string>();
  const files: ZoomRecordingFile[] = [];
  for (const row of parsed.data.recording_files) {
    if (row.status !== "completed" || !["MP4", "M4A"].includes(row.file_type)) continue;
    if (seen.has(row.id) || !row.recording_start || !row.recording_end || !row.download_url)
      throw unavailable();
    seen.add(row.id);
    zoomRecordingUrl(row.download_url);
    const seconds = (Date.parse(row.recording_end) - Date.parse(row.recording_start)) / 1000;
    if (!(seconds > 0) || row.file_size === 0) throw unavailable();
    const eligible = row.file_size <= MAX_MEETING_BYTES && seconds <= MAX_MEETING_SECONDS;
    files.push({
      id: row.id,
      format: row.file_type as "MP4" | "M4A",
      kind: row.recording_type ?? "recording",
      bytes: row.file_size,
      start: row.recording_start,
      end: row.recording_end,
      downloadUrl: row.download_url,
      eligible,
      unavailableReason: eligible
        ? null
        : "This file exceeds the 100 MB / 60-minute recording-processing bounds. Export the full meeting as compressed audio within these bounds.",
    });
  }
  return { meetingId, uuid: parsed.data.uuid, hostId, recordedAt: parsed.data.start_time, files };
}
function status(response: Response) {
  if (response.status === 401 || response.status === 403)
    throw new NativeRecordingError(
      409,
      "The original Zoom host needs cloud-recording read/download permission. Ask the Zoom app owner to enable cloud_recording:read:list_recording_files (or recording:read), then reconnect that host. A recording-enabled Zoom account is also required.",
    );
  if (!response.ok) throw unavailable();
}
export function zoomRecordingsProvider(request: typeof fetch = meteredFetch("zoom")) {
  async function send(...args: Parameters<typeof fetch>) {
    try {
      return await request(...args);
    } catch {
      throw unavailable();
    }
  }
  return {
    async list(token: string, identity: string, meetingId: string, hostId: string) {
      let encoded = encodeURIComponent(identity);
      if (identity.startsWith("/") || identity.includes("//"))
        encoded = encodeURIComponent(encoded);
      const response = await send(`https://api.zoom.us/v2/meetings/${encoded}/recordings`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      try {
        status(response);
        const raw = JSON.parse(
          (await boundedRecordingBody(response, 2 * 1024 * 1024)).toString("utf8"),
        );
        return parseZoomRecording(raw, meetingId, hostId);
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        if (error instanceof NativeRecordingError) throw error;
        throw unavailable();
      }
    },
    async download(token: string, selected: ZoomRecordingFile) {
      let url = zoomRecordingUrl(selected.downloadUrl);
      const signal = AbortSignal.timeout(60_000);
      for (let hop = 0; hop < 4; hop++) {
        const response = await send(url, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "manual",
          signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => {});
          if (!location || hop === 3) throw unavailable();
          // Never forward host credentials to a CDN, user URL or another origin.
          try {
            url = zoomRecordingUrl(new URL(location, url).toString());
          } catch {
            throw unavailable();
          }
          continue;
        }
        try {
          status(response);
          const bytes = await boundedRecordingBody(response, MAX_MEETING_BYTES);
          if (bytes.length !== selected.bytes) throw unavailable();
          return bytes;
        } catch (error) {
          await response.body?.cancel().catch(() => {});
          if (error instanceof NativeRecordingError) throw error;
          throw unavailable();
        }
      }
      throw unavailable();
    },
  };
}
