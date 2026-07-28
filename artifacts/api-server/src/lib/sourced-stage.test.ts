/**
 * sourced-stage.test.ts — proves the stage precedence rule can never diverge.
 *
 * The 4d gate: once a STORED raw.stage can coexist with a DERIVABLE stage, one
 * candidate must never resolve to two different stages depending on the surface.
 * These tests pin the single-source rule in deriveSourcedStage():
 *   - stored wins over a CONFLICTING derived signal
 *   - derive is the fallback only when no stored stage exists
 *   - a stored value equal to what derivation yields is a no-op (no board move)
 *   - "sourced" stored is treated as unset (never masks a real derived stage)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveSourcedStage } from "./sourced-stage.js";

test("stored stage WINS over a conflicting derived signal", () => {
  // Signals would derive "rejected"; a stored "shortlisted" (a recorded move) must win.
  const raw = { stage: "shortlisted", screened: true, screeningResult: { recommendation: "reject" } };
  assert.equal(deriveSourcedStage(raw), "shortlisted");

  // Signals would derive "screening"; stored "hm_review" wins.
  const raw2 = { stage: "hm_review", screened: true, screeningResult: { recommendation: "advance" } };
  assert.equal(deriveSourcedStage(raw2), "hm_review");
});

test("derive is the fallback ONLY when no stored stage exists", () => {
  assert.equal(deriveSourcedStage({ screened: true, screeningResult: { recommendation: "reject" } }), "rejected");
  assert.equal(deriveSourcedStage({ screened: true, screeningResult: { recommendation: "advance" } }), "screening");
  assert.equal(deriveSourcedStage({ screened: true, screeningResult: { recommendation: "hold" } }), "screening");
});

test("writing a stored stage that EQUALS the derived value is a no-op (no board move)", () => {
  // Before the choke-point writes: derives "screening".
  const before = { screened: true, screeningResult: { recommendation: "advance" } };
  const derived = deriveSourcedStage(before);
  // After the choke-point writes the SAME value it derived:
  const after = { ...before, stage: derived };
  assert.equal(deriveSourcedStage(after), derived, "stored==derived must not change the resolved stage");

  const beforeReject = { screened: true, screeningResult: { recommendation: "reject" } };
  const derivedReject = deriveSourcedStage(beforeReject);
  assert.equal(deriveSourcedStage({ ...beforeReject, stage: derivedReject }), derivedReject);
});

test('stored "sourced" is treated as unset — never masks a real derived stage', () => {
  const raw = { stage: "sourced", screened: true, screeningResult: { recommendation: "advance" } };
  assert.equal(deriveSourcedStage(raw), "screening");
});

test("default is 'sourced' when there is no stored stage and no screening signal", () => {
  assert.equal(deriveSourcedStage({}), "sourced");
  assert.equal(deriveSourcedStage(null), "sourced");
  assert.equal(deriveSourcedStage({ screened: false, screeningResult: { recommendation: "advance" } }), "sourced");
  // screened but no result object → not enough to derive
  assert.equal(deriveSourcedStage({ screened: true }), "sourced");
});
