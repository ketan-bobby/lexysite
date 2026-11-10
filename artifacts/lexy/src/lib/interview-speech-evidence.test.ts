import { strict as assert } from "node:assert";
import { test } from "node:test";
import { InterviewSpeechEvidence } from "./interview-speech-evidence";

test("silence and a single noise spike require explicit review", () => {
  const evidence = new InterviewSpeechEvidence();
  assert.equal(evidence.needsReview, true);
  evidence.observe(true, 100);
  evidence.observe(false, 116);
  assert.equal(evidence.needsReview, true);
});

test("separate spikes never accumulate into sustained evidence", () => {
  const evidence = new InterviewSpeechEvidence();
  for (let t = 0; t < 10000; t += 500) {
    evidence.observe(true, t);
    evidence.observe(true, t + 16);
    evidence.observe(false, t + 32);
  }
  assert.equal(evidence.needsReview, true);
});

test("sustained levels preserve the existing automatic spoken-answer flow", () => {
  const evidence = new InterviewSpeechEvidence();
  for (let t = 0; t <= 240; t += 16) evidence.observe(true, t);
  evidence.observe(false, 256);
  assert.equal(evidence.needsReview, false);
});

test("long polling gaps and a backwards clock are not sustained evidence", () => {
  const evidence = new InterviewSpeechEvidence();
  for (const t of [0, 500, 1000, 200, 400]) evidence.observe(true, t);
  assert.equal(evidence.needsReview, true);
});

test("weak evidence routes any answer to review, without a length or language filter", () => {
  for (const answer of [
    "Yes",
    "No",
    "Java",
    "I don't know",
    "हाँ",
    "是",
    "A long transcript from background noise",
  ]) {
    assert.ok(answer);
    assert.equal(new InterviewSpeechEvidence().needsReview, true);
  }
});
