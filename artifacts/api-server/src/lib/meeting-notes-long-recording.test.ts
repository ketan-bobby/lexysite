import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_MEETING_BYTES,
  MAX_MEETING_SECONDS,
  MEETING_LEASE_MS,
  MEETING_PROCESSING_MS,
} from "./meeting-notes-core";
import { withMeetingAudio } from "./meeting-notes-media";

function syntheticWave(seconds: number) {
  const samples = seconds * 8000;
  const wav = Buffer.alloc(44 + samples);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples, 40);
  wav.fill(Buffer.from([128, 190, 215, 190, 128, 66, 41, 66]), 44);
  return wav;
}

test("technical bounds match web capture/upload and leave a provider-call margin before lease expiry", async () => {
  const web = await readFile(
    resolve(import.meta.dirname, "../../../lexy/src/lib/meeting-recording-limits.ts"),
    "utf8",
  );
  assert.match(web, /MAX_MEETING_BYTES = 100 \* 1024 \* 1024/);
  assert.match(web, /MAX_MEETING_SECONDS = 60 \* 60/);
  assert.equal(MAX_MEETING_BYTES, 100 * 1024 * 1024);
  assert.equal(MAX_MEETING_SECONDS, 3600);
  assert.ok(MEETING_LEASE_MS - MEETING_PROCESSING_MS >= 5 * 60_000);
});

test(
  "real decoder covers every sample of a full 60-minute source and always removes private parts",
  { timeout: 180_000 },
  async () => {
    // A complete, small synthetic PCM source: no speech, providers or retained
    // asset. Only one full-length decode; failure cleanup uses a one-second source.
    const bytes = syntheticWave(3600);
    let temporaryPart = "";
    assert.ok(bytes.length < MAX_MEETING_BYTES);
    let sampleBytes = 0;
    await withMeetingAudio(bytes, async (parts, read) => {
      assert.equal(parts.length, 144);
      temporaryPart = parts.at(-1)!;
      for (const part of parts) {
        const wav = await read(part);
        const data = wav.indexOf(Buffer.from("data"), 12);
        assert.ok(data >= 12);
        sampleBytes += wav.readUInt32LE(data + 4);
        assert.ok(wav.subarray(data + 8).some((byte) => byte !== 0));
      }
    });
    assert.equal(sampleBytes, 3600 * 16_000 * 2, "no missing or silently trimmed audio samples");
    await assert.rejects(stat(temporaryPart), { code: "ENOENT" });
    await assert.rejects(
      withMeetingAudio(syntheticWave(1), async (parts) => {
        temporaryPart = parts[0]!;
        throw new Error("synthetic downstream failure");
      }),
      /synthetic downstream failure/,
    );
    await assert.rejects(stat(temporaryPart), { code: "ENOENT" });
  },
);

test("decoder rejects a genuinely overlong source instead of clipping it to the accepted length", async () => {
  // A tiny valid WAV with low sample rate can represent an overlong source
  // without allocating an hour of PCM or contacting a provider.
  const samples = 3601;
  const wav = Buffer.alloc(44 + samples);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(1, 24);
  wav.writeUInt32LE(1, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples, 40);
  let called = false;
  await assert.rejects(
    withMeetingAudio(wav, async () => {
      called = true;
    }),
    /at most 60 minutes/,
  );
  assert.equal(called, false);
});
