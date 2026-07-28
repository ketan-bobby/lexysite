/**
 * score-band.test.ts — Unit tests for the canonical match/fit score band.
 *
 * ─── What this asserts ────────────────────────────────────────────────────────
 * Pins the single source of truth (scoreBand / bandBy / SCORE_BAND_PILL) so a
 * change to the 75/55 cutoffs is a deliberate, test-breaking decision — never an
 * accidental drift. Every match/fit surface consumes these, so the boundaries
 * (75 and 55 are inclusive lower bounds) must stay exactly here.
 *
 * Run via:
 *   pnpm --filter @workspace/lexy run test:score-band
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreBand, bandBy, SCORE_BAND_PILL } from "./score-band";

test("scoreBand: >=75 is strong (incl. boundary)", () => {
  assert.equal(scoreBand(100), "strong");
  assert.equal(scoreBand(78), "strong");
  assert.equal(scoreBand(76), "strong");
  assert.equal(scoreBand(75), "strong"); // inclusive lower bound
});

test("scoreBand: 55–74 is good (incl. boundary)", () => {
  assert.equal(scoreBand(74), "good");
  assert.equal(scoreBand(60), "good");
  assert.equal(scoreBand(55), "good"); // inclusive lower bound
});

test("scoreBand: <55 is fair", () => {
  assert.equal(scoreBand(54), "fair");
  assert.equal(scoreBand(20), "fair");
  assert.equal(scoreBand(0), "fair");
});

test("bandBy: returns the value keyed by the canonical band", () => {
  const byBand = { strong: "S", good: "G", fair: "F" };
  assert.equal(bandBy(76, byBand), "S");
  assert.equal(bandBy(78, byBand), "S");
  assert.equal(bandBy(74, byBand), "G");
  assert.equal(bandBy(55, byBand), "G");
  assert.equal(bandBy(54, byBand), "F");
});

test("SCORE_BAND_PILL: has a class string for every band", () => {
  for (const band of ["strong", "good", "fair"] as const) {
    assert.equal(typeof SCORE_BAND_PILL[band], "string");
    assert.ok(SCORE_BAND_PILL[band].length > 0);
  }
});
