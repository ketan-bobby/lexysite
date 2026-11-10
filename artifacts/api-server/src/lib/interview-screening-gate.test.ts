import { test } from "node:test";
import assert from "node:assert/strict";
import { interviewScreeningBlockReason } from "./interview-screening-gate";

test("reviewed workflow hold can continue without rewriting the source recommendation", () => {
  const source = Object.freeze({ screened: true, recommendation: "hold" });
  assert.equal(interviewScreeningBlockReason(source.screened, source.recommendation, true), null);
  assert.equal(source.recommendation, "hold");
  assert.equal(interviewScreeningBlockReason(true, "hold", false), "screening_hold");
});

test("advance still passes, but a review never bypasses absent screening or rejection", () => {
  for (const reviewed of [false, true]) {
    assert.equal(interviewScreeningBlockReason(true, "advance", reviewed), null);
    assert.equal(interviewScreeningBlockReason(false, "advance", reviewed), "not_yet_screened");
    assert.equal(interviewScreeningBlockReason(undefined, "hold", reviewed), "not_yet_screened");
    assert.equal(interviewScreeningBlockReason(true, "reject", reviewed), "screening_reject");
    assert.equal(interviewScreeningBlockReason(true, undefined, reviewed), "screening_unknown");
  }
});
