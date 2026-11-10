import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signRecordingReview,
  readRecordingReview,
  nativeRecordingKey,
  recordingFileHash,
  nativeZoomImportInput,
} from "./native-recording-review";
import type { NativeRecordingClaims } from "./native-recording-review";
const key = "synthetic-native-review-test-only";
const claims: NativeRecordingClaims = {
  actorId: "actor",
  tenantId: "tenant",
  jobId: "job",
  candidateId: "candidate",
  scheduleId: "appointment",
  scheduleVersion: "version",
  operationId: "operation",
  snapshotHash: "snapshot",
  accountRevision: "account",
  hostZoomId: "host",
  meetingId: "12345678901",
  uuid: "instance==",
  fileId: "file",
  fileHash: "hash",
  expires: Date.now() + 60_000,
};
test("signed source review survives round-trip and refuses expiry, tampering and another signing key", () => {
  const token = signRecordingReview(claims, key);
  assert.deepEqual(readRecordingReview(token, Date.now(), key), claims);
  assert.throws(() => readRecordingReview(token, claims.expires, key));
  assert.throws(() => readRecordingReview(token, Date.now(), "different-key"));
  const [body, sig] = token.split(".");
  const changed = Buffer.from(JSON.stringify({ ...claims, candidateId: "another" })).toString(
    "base64url",
  );
  assert.throws(() => readRecordingReview(`${changed}.${sig}`, Date.now(), key));
  assert.throws(() => readRecordingReview(`${body}.${sig}.extra`, Date.now(), key));
});
test("native recording deduplication is context/instance-bound, not a global file match", () => {
  const anotherExpiry = { ...claims, expires: 0 };
  assert.equal(nativeRecordingKey(claims), nativeRecordingKey(anotherExpiry));
  for (const patch of [
    { candidateId: "other" },
    { jobId: "other" },
    { tenantId: "other" },
    { uuid: "other" },
    { hostZoomId: "other" },
    { fileId: "other" },
  ])
    assert.notEqual(nativeRecordingKey(claims), nativeRecordingKey({ ...claims, ...patch }));
});
test("file review binds source metadata while permitting provider-only URL signature refresh", () => {
  const file = {
    id: "file",
    format: "M4A" as const,
    kind: "audio_only",
    bytes: 4,
    start: "2026-11-04T10:00:00Z",
    end: "2026-11-04T10:01:00Z",
    downloadUrl: "https://zoom.us/rec/download/one",
    eligible: true,
    unavailableReason: null,
  };
  assert.equal(
    recordingFileHash(file),
    recordingFileHash({ ...file, downloadUrl: "https://zoom.us/rec/download/two" }),
  );
  assert.notEqual(recordingFileHash(file), recordingFileHash({ ...file, bytes: 5 }));
});
test("import requires explicit boolean consent and rejects URLs, host/identity overrides and unbounded fields", () => {
  const input = {
    reviewToken: "signed-source-review",
    title: "Meeting",
    consent: true,
    consentStatement: "All participants consented and this is the right candidate interview.",
  };
  assert.equal(nativeZoomImportInput.parse(input).plannedQuestions, "");
  for (const patch of [
    { consent: false },
    { consent: "true" },
    { consentStatement: "short" },
    { downloadUrl: "https://zoom.us/rec/x" },
    { hostZoomId: "spoof" },
    { createdBy: "spoof" },
    { title: "x".repeat(161) },
  ])
    assert.equal(nativeZoomImportInput.safeParse({ ...input, ...patch }).success, false);
});
