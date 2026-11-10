/**
 * Explicit opt-in paid provider diagnostic using Deepgram's own public sample.
 * No candidate audio, invitations, ATS mutations or meeting-note rows.
 */
import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { transcribeMeetingSpeakers } from "../src/lib/meeting-speakers";
import { withMeetingAudio } from "../src/lib/meeting-notes-media";
import { DEEPGRAM_STT_MODEL, deepgramConfigured } from "../src/lib/transcribe";
import { meteredFetch } from "../src/lib/vendor-usage";

let phase = "development-target";
let providerStatus: number | null = null;
try {
  assert.notEqual(process.env.NODE_ENV, "production");
  assert.equal(process.env.MEETING_SPEAKER_LIVE_CONFIRM, "public-sample-paid-call");
  assert.ok(process.env.MEETING_SPEAKER_TEST_DB_CONFIRM);
  assert.ok(process.env.MEETING_SPEAKER_TEST_JOB_ID);
  const target = await pool.query(
    "select md5(current_database() || ':' || coalesce(inet_server_addr()::text,'local')) as fingerprint",
  );
  assert.equal(target.rows[0].fingerprint, process.env.MEETING_SPEAKER_TEST_DB_CONFIRM);
  const job = await pool.query("select tenant_id from public.jobs where id=$1", [
    process.env.MEETING_SPEAKER_TEST_JOB_ID,
  ]);
  assert.ok(job.rows[0]?.tenant_id);
  assert.ok(deepgramConfigured());
  phase = "public-sample";
  const sample = await fetch(
    "https://res.cloudinary.com/deepgram/video/upload/v1680127025/dg-audio/nasa-spacewalk-interview_ljjahn.wav",
    { signal: AbortSignal.timeout(30_000) },
  );
  assert.ok(sample.ok);
  assert.ok(Number(sample.headers.get("content-length")) <= 50 * 1024 * 1024);
  const bytes = Buffer.from(await sample.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length <= 50 * 1024 * 1024);
  phase = "media-validation";
  const result = await withMeetingAudio(bytes, async () => {
    phase = "provider";
    const request = meteredFetch(
      "deepgram",
      async (url, options) => {
        const response = await fetch(url, options);
        providerStatus = response.status;
        return response;
      },
      undefined,
      {
        model: DEEPGRAM_STT_MODEL,
        audioBytes: bytes.length,
        operationKey: "public-sample-speaker-check",
      },
    );
    return transcribeMeetingSpeakers(
      {
        bytes,
        contentType: "audio/wav",
        language: "en",
        tenantId: job.rows[0].tenant_id,
        jobId: process.env.MEETING_SPEAKER_TEST_JOB_ID!,
      },
      { fetch: request },
    );
  });
  console.log(
    JSON.stringify({
      passed: true,
      source: "Deepgram official public sample",
      providerStatus,
      model: result.evidence.model,
      diarizer: result.evidence.diarizerModel,
      segments: result.evidence.segments.length,
      speakerGroups: new Set(result.evidence.segments.map((segment) => segment.speaker)).size,
      hasText: !!result.transcript.trim(),
      candidateDataSent: false,
      meetingNotesCreated: false,
    }),
  );
} catch {
  // No credentials, source speech or provider payload/error text.
  console.error(JSON.stringify({ passed: false, phase, providerStatus, candidateDataSent: false }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
