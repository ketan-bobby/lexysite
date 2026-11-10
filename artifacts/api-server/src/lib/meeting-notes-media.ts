import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MEETING_BYTES, MAX_MEETING_SECONDS } from "./meeting-notes-core";

const exec = promisify(execFile);
const formats = "mov,matroska,webm,wav,mp3,ogg,flac";

/** Files stay in a private temporary directory and are always removed. */
export async function withMeetingAudio<T>(
  bytes: Buffer,
  run: (parts: string[], read: (path: string) => Promise<Buffer>) => Promise<T>,
): Promise<T> {
  if (!bytes.length || bytes.length > MAX_MEETING_BYTES)
    throw new Error("Recording must be nonempty and at most 100 MB.");
  const dir = await mkdtemp(join(tmpdir(), "lexy-meeting-"));
  const input = join(dir, "recording");
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    const { stdout } = await exec(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        formats,
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        input,
      ],
      { timeout: 30_000, maxBuffer: 32_000 },
    );
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_MEETING_SECONDS) {
      throw new Error("Recording must contain audio and be at most 60 minutes.");
    }
    await exec(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        formats,
        "-i",
        input,
        // Decode one extra segment as an overflow sentinel. If container
        // metadata understates the audio length, reject instead of accepting
        // a silently truncated recording or decoding without a bound.
        "-t",
        String(MAX_MEETING_SECONDS + 25),
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-f",
        "segment",
        "-segment_time",
        "25",
        "-reset_timestamps",
        "1",
        join(dir, "part-%04d.wav"),
      ],
      { timeout: 180_000, maxBuffer: 32_000 },
    );
    const parts = (await readdir(dir))
      .filter((name) => /^part-\d{4}\.wav$/.test(name))
      .sort()
      .map((name) => join(dir, name));
    if (!parts.length || parts.length > Math.ceil(MAX_MEETING_SECONDS / 25))
      throw new Error("Unsupported recording duration.");
    return await run(parts, readFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
