import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEEPGRAM_STT_MODEL, deepgramConfigured, deepgramLanguageFor } from "./transcribe";
import { meteredFetch } from "./vendor-usage";
import { withUsageActivity } from "./vendor-usage-context";
import type { MeetingSpeakerEvidence } from "@workspace/db";
import { MAX_MEETING_BYTES, MAX_MEETING_SECONDS } from "./meeting-notes-core";
export type { MeetingSpeakerEvidence } from "@workspace/db";

export const meetingProcessingInput = z
  .object({
    separateSpeakers: z.boolean().optional().default(false),
  })
  .strict();

const utterance = z
  .object({
    speaker: z.number().int().min(0).max(99),
    start: z.number().finite().min(0).max(MAX_MEETING_SECONDS),
    end: z.number().finite().min(0).max(MAX_MEETING_SECONDS),
    transcript: z.string().trim().min(1).max(4000),
  })
  .refine((item) => item.end > item.start);
const providerResult = z.object({
  metadata: z.object({
    diarize_info: z.object({ arch: z.literal("v1"), model_uuid: z.string().uuid() }),
  }),
  results: z.object({ utterances: z.array(utterance).min(1).max(6000) }),
});

export const meetingSpeakerReviewInput = z
  .object({
    sourceRevision: z.string().uuid(),
    previousRevision: z.string().uuid().nullable(),
    confirm: z.literal(true),
    labels: z
      .array(
        z
          .object({
            speaker: z.number().int().min(0).max(99),
            label: z
              .string()
              .trim()
              .min(1)
              .max(80)
              .regex(/^[^\u0000-\u001f\u007f]*$/),
            role: z.enum(["candidate", "interviewer", "other", "unknown"]),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export class MeetingSpeakerReviewError extends Error {}

export function meetingSpeakerLabels(
  input: z.infer<typeof meetingSpeakerReviewInput>,
  evidence: MeetingSpeakerEvidence,
) {
  const speakers = new Set(evidence.segments.map((segment) => segment.speaker));
  const selected = new Set<number>();
  if (input.sourceRevision !== evidence.revision) {
    throw new MeetingSpeakerReviewError("The speaker source changed. Refresh before reviewing.");
  }
  for (const label of input.labels) {
    if (!speakers.has(label.speaker) || selected.has(label.speaker)) {
      throw new MeetingSpeakerReviewError("Use each existing speaker group at most once.");
    }
    selected.add(label.speaker);
  }
  return input.labels;
}

/** Anonymous voice groups only: not participant identity, a score or an assessment. */
export function parseMeetingSpeakers(value: unknown): MeetingSpeakerEvidence {
  const parsed = providerResult.parse(value);
  const segments = parsed.results.utterances.map((item) => ({
    speaker: item.speaker,
    start: item.start,
    end: item.end,
    text: item.transcript,
  }));
  if (segments.some((item, index) => index > 0 && item.start < segments[index - 1].start)) {
    throw new Error("Speaker evidence is not chronological.");
  }
  if (segments.reduce((length, item) => length + item.text.length, 0) > 100_000) {
    throw new Error("Speaker evidence exceeds the recording limit.");
  }
  return {
    revision: randomUUID(),
    generatedAt: new Date().toISOString(),
    provider: "deepgram",
    model: DEEPGRAM_STT_MODEL,
    diarizerModel: "v1",
    diarizerBuild: parsed.metadata.diarize_info.model_uuid,
    segments,
  };
}

export async function transcribeMeetingSpeakers(
  input: { bytes: Buffer; contentType: string; language: string; tenantId: string; jobId: string },
  dependencies: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
) {
  const env = dependencies.env ?? process.env;
  if (!deepgramConfigured(env)) throw new Error("Speaker separation is not configured.");
  if (!input.bytes.length || input.bytes.length > MAX_MEETING_BYTES) {
    throw new Error("Recording exceeds the supported limit.");
  }
  const language = deepgramLanguageFor(input.language);
  if (!language) throw new Error("Speaker separation does not support this recording language.");
  const params = new URLSearchParams({
    model: DEEPGRAM_STT_MODEL,
    language,
    diarize_model: "v1",
    utterances: "true",
    smart_format: "true",
  });
  const request =
    dependencies.fetch ??
    meteredFetch("deepgram", undefined, undefined, {
      model: DEEPGRAM_STT_MODEL,
      audioBytes: input.bytes.length,
      operationKey: "human-meeting-speaker-separation",
    });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await withUsageActivity(input.tenantId, "recruiter", () =>
      request(`https://api.deepgram.com/v1/listen?${params}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
          "Content-Type": input.contentType,
        },
        body: new Uint8Array(input.bytes),
        signal: controller.signal,
      }),
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Speaker transcription did not complete.");
    }
    // Do not retain/log unbounded provider payloads or provider error bodies.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("Speaker response exceeds the supported limit.");
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const evidence = parseMeetingSpeakers(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return { transcript: evidence.segments.map((item) => item.text).join("\n\n"), evidence };
  } finally {
    clearTimeout(timer);
  }
}
