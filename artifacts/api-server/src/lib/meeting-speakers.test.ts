import { test } from "node:test";
import assert from "node:assert/strict";
import {
  meetingProcessingInput,
  parseMeetingSpeakers,
  transcribeMeetingSpeakers,
  meetingSpeakerReviewInput,
  meetingSpeakerLabels,
} from "./meeting-speakers";
import { DEEPGRAM_STT_MODEL } from "./transcribe";
import { vendorUsageScope } from "./vendor-usage";

const value = {
  metadata: { diarize_info: { arch: "v1", model_uuid: "11111111-1111-4111-8111-111111111111" } },
  results: {
    utterances: [
      { speaker: 0, start: 0.2, end: 1.5, transcript: "What did you build?" },
      { speaker: 1, start: 1.3, end: 3.6, transcript: "A Python service." },
    ],
  },
};
const input = {
  bytes: Buffer.from("synthetic"),
  contentType: "audio/webm",
  language: "en-US",
  tenantId: "test-tenant",
  jobId: "test-job",
};
const env = { DEEPGRAM_API_KEY: "synthetic-test-key-not-a-credential" };

test("speaker labels are explicit human annotations on known groups, never inferred identity", () => {
  const evidence = parseMeetingSpeakers(value);
  const input = meetingSpeakerReviewInput.parse({
    sourceRevision: evidence.revision,
    previousRevision: null,
    confirm: true,
    labels: [{ speaker: 1, label: "Reviewed applicant", role: "candidate" }],
  });
  const before = JSON.stringify(evidence);
  assert.deepEqual(meetingSpeakerLabels(input, evidence), input.labels);
  assert.equal(JSON.stringify(evidence), before, "Human review must not rewrite provider source.");
});
test("speaker review requires literal confirmation and refuses invented roles or actor fields", () => {
  const input = {
    sourceRevision: parseMeetingSpeakers(value).revision,
    previousRevision: null,
    confirm: true,
    labels: [],
  };
  for (const confirm of [false, "true", 1, undefined]) {
    assert.equal(meetingSpeakerReviewInput.safeParse({ ...input, confirm }).success, false);
  }
  assert.equal(
    meetingSpeakerReviewInput.safeParse({ ...input, reviewedBy: "spoofed" }).success,
    false,
  );
  assert.equal(
    meetingSpeakerReviewInput.safeParse({
      ...input,
      labels: [{ speaker: 0, label: " ", role: "candidate" }],
    }).success,
    false,
  );
  assert.equal(
    meetingSpeakerReviewInput.safeParse({
      ...input,
      labels: [{ speaker: 0, label: "Text\ninjected", role: "candidate" }],
    }).success,
    false,
  );
  assert.equal(
    meetingSpeakerReviewInput.safeParse({
      ...input,
      labels: [{ speaker: 0, label: "A", role: "verified_identity" }],
    }).success,
    false,
  );
});
test("unknown, duplicate or stale-source speaker review fails rather than relabelling another voice", () => {
  const evidence = parseMeetingSpeakers(value);
  const input = {
    sourceRevision: evidence.revision,
    previousRevision: null,
    confirm: true as const,
    labels: [{ speaker: 0, label: "A", role: "unknown" as const }],
  };
  assert.throws(() =>
    meetingSpeakerLabels(
      { ...input, sourceRevision: parseMeetingSpeakers(value).revision },
      evidence,
    ),
  );
  assert.throws(() =>
    meetingSpeakerLabels({ ...input, labels: [...input.labels, ...input.labels] }, evidence),
  );
  assert.throws(() =>
    meetingSpeakerLabels({ ...input, labels: [{ ...input.labels[0], speaker: 99 }] }, evidence),
  );
});
test("clearing speaker annotations is explicit and does not alter voice-group source evidence", () => {
  const evidence = parseMeetingSpeakers(value);
  const input = meetingSpeakerReviewInput.parse({
    sourceRevision: evidence.revision,
    previousRevision: null,
    confirm: true,
    labels: [],
  });
  assert.deepEqual(meetingSpeakerLabels(input, evidence), []);
  assert.equal(evidence.segments.length, 2);
});

test("legacy empty processing request stays standard and opt-in is strict", () => {
  assert.equal(meetingProcessingInput.parse({}).separateSpeakers, false);
  assert.equal(meetingProcessingInput.parse({ separateSpeakers: true }).separateSpeakers, true);
  for (const body of [{ separateSpeakers: "true" }, { separateSpeakers: 1 }, { arbitrary: true }]) {
    assert.equal(meetingProcessingInput.safeParse(body).success, false);
  }
});
test("anonymous speaker evidence preserves overlap, timestamps and exact source text", () => {
  const parsed = parseMeetingSpeakers(value);
  assert.equal(parsed.provider, "deepgram");
  assert.equal(parsed.model, DEEPGRAM_STT_MODEL);
  assert.match(parsed.revision, /^[a-f0-9-]{36}$/);
  assert.deepEqual(
    parsed.segments.map((x) => [x.speaker, x.start, x.end, x.text]),
    [
      [0, 0.2, 1.5, "What did you build?"],
      [1, 1.3, 3.6, "A Python service."],
    ],
  );
  assert.equal(JSON.stringify(parsed).includes("candidate"), false);
});
test("speaker timestamps include the final second of a full-hour meeting", () => {
  const evidence = parseMeetingSpeakers({
    metadata: {
      diarize_info: {
        arch: "v1",
        model_uuid: "00000000-0000-4000-8000-000000000001",
      },
    },
    results: {
      utterances: [{ speaker: 0, start: 3590, end: 3600, transcript: "Final source statement." }],
    },
  });
  assert.equal(evidence.segments[0]!.end, 3600);
});

test("missing, malformed, excessive or out-of-order evidence fails instead of inventing speakers", () => {
  for (const utterances of [
    [],
    [{ start: 0, end: 1, transcript: "No speaker" }],
    [{ speaker: -1, start: 0, end: 1, transcript: "Bad speaker" }],
    [{ speaker: 0, start: 4, end: 2, transcript: "Reversed" }],
    [{ speaker: 0, start: 0, end: 3601, transcript: "Too long" }],
    [{ speaker: 0, start: 0, end: 1, transcript: " " }],
    [
      { speaker: 0, start: 3, end: 4, transcript: "Later" },
      { speaker: 1, start: 1, end: 2, transcript: "Earlier" },
    ],
    Array.from({ length: 6001 }, () => ({ speaker: 0, start: 0, end: 1, transcript: "Repeated" })),
    Array.from({ length: 26 }, (_, i) => ({
      speaker: 0,
      start: i,
      end: i + 1,
      transcript: "a".repeat(4000),
    })),
  ])
    assert.throws(() => parseMeetingSpeakers({ ...value, results: { utterances } }));
});
test("optional human recording request reuses configured model and scopes measured usage", async () => {
  let calls = 0;
  const result = await transcribeMeetingSpeakers(input, {
    env,
    fetch: async (url, options) => {
      calls++;
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, "https://api.deepgram.com");
      assert.equal(parsed.searchParams.get("model"), DEEPGRAM_STT_MODEL);
      assert.equal(parsed.searchParams.get("language"), "en");
      assert.equal(parsed.searchParams.get("diarize_model"), "v1");
      assert.equal(parsed.searchParams.has("diarize"), false);
      assert.equal(parsed.searchParams.get("utterances"), "true");
      assert.equal(options?.method, "POST");
      assert.deepEqual(vendorUsageScope.getStore(), {
        tenantId: "test-tenant",
        area: "activity:recruiter",
      });
      return Response.json(value);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.transcript, "What did you build?\n\nA Python service.");
  assert.equal(result.evidence.segments.length, 2);
});
test("unconfigured provider, unsupported language and invalid bytes do not call any provider", async () => {
  let calls = 0;
  const fetchMock: typeof fetch = async () => {
    calls++;
    return Response.json(value);
  };
  await assert.rejects(() => transcribeMeetingSpeakers(input, { env: {}, fetch: fetchMock }));
  await assert.rejects(() =>
    transcribeMeetingSpeakers({ ...input, language: "ar" }, { env, fetch: fetchMock }),
  );
  await assert.rejects(() =>
    transcribeMeetingSpeakers({ ...input, bytes: Buffer.alloc(0) }, { env, fetch: fetchMock }),
  );
  assert.equal(calls, 0);
});
test("provider refusal fails without exposing provider error bodies or invoking a fallback", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      transcribeMeetingSpeakers(input, {
        env,
        fetch: async () => {
          calls++;
          return new Response("PRIVATE provider payload", { status: 403 });
        },
      }),
    (error: Error) => !error.message.includes("PRIVATE"),
  );
  assert.equal(calls, 1);
});
test("unstructured and oversized provider responses are rejected", async () => {
  await assert.rejects(() =>
    transcribeMeetingSpeakers(input, { env, fetch: async () => Response.json({ results: {} }) }),
  );
  await assert.rejects(() =>
    transcribeMeetingSpeakers(input, {
      env,
      fetch: async () => new Response("a".repeat(2 * 1024 * 1024 + 1)),
    }),
  );
});

test("missing diarizer metadata or a different diarizer version is not accepted as speaker evidence", () => {
  assert.throws(() => parseMeetingSpeakers({ results: value.results }));
  assert.throws(() =>
    parseMeetingSpeakers({
      ...value,
      metadata: { diarize_info: { ...value.metadata.diarize_info, arch: "v2" } },
    }),
  );
  assert.equal(parseMeetingSpeakers(value).diarizerModel, "v1");
});
