import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseZoomRecording,
  zoomRecordingsProvider,
  zoomRecordingUrl,
  boundedRecordingBody,
  NativeRecordingError,
} from "./zoom-recordings-provider";

const sample = () => ({
  id: 12345678901,
  uuid: "a+/b==",
  host_id: "fixture-host",
  start_time: "2026-11-04T10:00:00Z",
  recording_files: [
    {
      id: "fixture-file",
      file_type: "M4A",
      recording_type: "audio_only",
      file_size: 4,
      status: "completed",
      recording_start: "2026-11-04T10:00:00Z",
      recording_end: "2026-11-04T10:01:00Z",
      download_url: "https://us02web.zoom.us/rec/download/fixture",
    },
  ],
});
test("full-hour recordings beyond the old size bound are eligible, but longer sources are not", () => {
  const raw = sample();
  raw.recording_files[0].recording_end = "2026-11-04T11:00:00Z";
  raw.recording_files[0].file_size = 80 * 1024 * 1024;
  assert.equal(parseZoomRecording(raw, "12345678901", "fixture-host").files[0]!.eligible, true);
  raw.recording_files[0].recording_end = "2026-11-04T11:00:01Z";
  assert.equal(parseZoomRecording(raw, "12345678901", "fixture-host").files[0]!.eligible, false);
});

test("recording metadata is host/meeting-bound, completed media only, with explicit processing bounds", () => {
  const raw = sample();
  raw.recording_files.push({ ...raw.recording_files[0], id: "chat", file_type: "CHAT" });
  const parsed = parseZoomRecording(raw, "12345678901", "fixture-host");
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].eligible, true);
  raw.recording_files[0].file_size = 100 * 1024 * 1024 + 1;
  const tooBig = parseZoomRecording(raw, "12345678901", "fixture-host").files[0];
  assert.equal(tooBig.eligible, false);
  assert.match(tooBig.unavailableReason!, /100 MB/);
});
test("foreign host/meeting, missing UUID, duplicates and impossible timing are not accepted as evidence", () => {
  for (const raw of [
    { ...sample(), id: 99999999999 },
    { ...sample(), host_id: "other" },
    { ...sample(), uuid: "" },
    { ...sample(), recording_files: [sample().recording_files[0], sample().recording_files[0]] },
    {
      ...sample(),
      recording_files: [{ ...sample().recording_files[0], recording_end: "2026-11-04T09:00:00Z" }],
    },
  ])
    assert.throws(
      () => parseZoomRecording(raw, "12345678901", "fixture-host"),
      NativeRecordingError,
    );
});
test("download URL validation refuses SSRF, lookalike hosts, non-HTTPS, credentials and alternate ports", () => {
  for (const value of [
    "http://zoom.us/rec/x",
    "https://zoom.us.attacker.test/rec/x",
    "https://127.0.0.1/rec/x",
    "https://zoom.us:8443/rec/x",
    "https://user:password@zoom.us/rec/x",
    "https://zoom.us/oauth/token",
    "https://zoom.us/rec/x#private",
  ])
    assert.throws(() => zoomRecordingUrl(value), NativeRecordingError);
});
test("recording lookup encodes special UUID twice and performs one GET only", async () => {
  let called = 0;
  const request: typeof fetch = async (url, init) => {
    called++;
    assert.equal(String(url), "https://api.zoom.us/v2/meetings/%252Finstance%253D%253D/recordings");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    return Response.json({ ...sample(), uuid: "/instance==" });
  };
  const result = await zoomRecordingsProvider(request).list(
    "synthetic-token",
    "/instance==",
    "12345678901",
    "fixture-host",
  );
  assert.equal(called, 1);
  assert.equal(result.uuid, "/instance==");
});
test("missing recording permission fails explicitly and is not retried", async () => {
  let count = 0;
  await assert.rejects(
    zoomRecordingsProvider(async () => {
      count++;
      return new Response("", { status: 403 });
    }).list("synthetic-token", "12345678901", "12345678901", "fixture-host"),
    (error: NativeRecordingError) =>
      error.status === 409 && error.message.includes("cloud_recording"),
  );
  assert.equal(count, 1);
});
test("recording streams are bounded even without content-length", async () => {
  await assert.rejects(
    boundedRecordingBody(new Response(new Uint8Array(5)), 4),
    (error: NativeRecordingError) => error.status === 413,
  );
});
test("downloads reject size drift and never forward credentials to an external redirect", async () => {
  const selected = parseZoomRecording(sample(), "12345678901", "fixture-host").files[0];
  await assert.rejects(
    zoomRecordingsProvider(async () => new Response("short")).download("synthetic-token", selected),
    NativeRecordingError,
  );
  let calls = 0;
  await assert.rejects(
    zoomRecordingsProvider(async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://attacker.test/rec/file" },
      });
    }).download("synthetic-token", selected),
    NativeRecordingError,
  );
  assert.equal(calls, 1);
});
test("valid recording download sends bearer header only and no remote mutations", async () => {
  const selected = parseZoomRecording(sample(), "12345678901", "fixture-host").files[0];
  const bytes = await zoomRecordingsProvider(async (url, init) => {
    assert.equal(String(url), selected.downloadUrl);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-token");
    assert.equal(init?.redirect, "manual");
    assert.ok(!init?.method || init.method === "GET");
    return new Response("data");
  }).download("synthetic-token", selected);
  assert.equal(bytes.toString(), "data");
});
