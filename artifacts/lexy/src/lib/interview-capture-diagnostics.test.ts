import { test } from "node:test";
import assert from "node:assert/strict";
import {
  InterviewCaptureDiagnosticsReporter,
  createCaptureDiagnosticAttempt,
} from "./interview-capture-diagnostics";
import { InterviewSpeechEvidence } from "./interview-speech-evidence";

test("diagnostic snapshots do not change the weak/strong signal decision", () => {
  const evidence = new InterviewSpeechEvidence();
  evidence.observe(true, 0);
  evidence.observe(false, 16);
  assert.deepEqual(evidence.diagnostic, {
    longestRunMs: 0,
    thresholdMs: 200,
    sampleCount: 2,
    aboveThresholdSamples: 1,
  });
  assert.equal(evidence.needsReview, true);
  for (let t = 100; t <= 340; t += 16) evidence.observe(true, t);
  assert.equal(evidence.diagnostic.longestRunMs, 240);
  assert.equal(evidence.needsReview, false);
});

test("ordered events are deduplicated per attempt and contain no answer content", async () => {
  const sent: any[] = [];
  const reporter = new InterviewCaptureDiagnosticsReporter(
    async (event) => {
      sent.push(event);
    },
    () => assert.fail(),
  );
  const context = createCaptureDiagnosticAttempt(1)!;
  reporter.record({ ...context, event: "capture_decision", reason: "weak_signal" });
  reporter.record({ ...context, event: "review_shown", inViewport: true });
  reporter.record({ ...context, event: "review_shown", inViewport: true });
  reporter.record({
    ...context,
    event: "review_confirmed",
    reason: "confirmed_review",
    edited: true,
  });
  await reporter.flush();
  assert.deepEqual(
    sent.map((e) => e.event),
    ["capture_decision", "review_shown", "review_confirmed"],
  );
  assert.equal(new Set(sent.map((e) => e.eventId)).size, 3);
  assert.ok(sent.every((e) => !("answer" in e) && !("transcript" in e) && !("audio" in e)));
});

test("failed requests retry the same id, then report failure without rejecting", async () => {
  const ids: string[] = [];
  let failures = 0;
  const reporter = new InterviewCaptureDiagnosticsReporter(
    async (event) => {
      ids.push(event.eventId);
      throw new Error("offline");
    },
    () => {
      failures += 1;
    },
  );
  reporter.record({
    ...createCaptureDiagnosticAttempt(1)!,
    event: "submission_requested",
    reason: "typed",
  });
  await reporter.flush();
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(failures, 1);
});

test("even a failing diagnostic failure callback never rejects completion", async () => {
  const reporter = new InterviewCaptureDiagnosticsReporter(
    async () => {
      throw new Error("offline");
    },
    () => {
      throw new Error("bad observer");
    },
  );
  reporter.record({
    ...createCaptureDiagnosticAttempt(1)!,
    event: "submission_saved",
    reason: "sustained_signal",
  });
  await assert.doesNotReject(reporter.flush());
});

test("a retry creates a distinct trace without collecting audio or answer text", () => {
  const one = createCaptureDiagnosticAttempt(2)!;
  const two = createCaptureDiagnosticAttempt(2)!;
  assert.notEqual(one.attemptId, two.attemptId);
  assert.equal(one.turnNumber, two.turnNumber);
  assert.deepEqual(Object.keys(one).sort(), ["attemptId", "reason", "turnNumber"]);
});
