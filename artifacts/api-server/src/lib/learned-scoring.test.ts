/**
 * learned-scoring.test.ts — Per-tenant learned scoring weights (Task #25)
 *
 * ─── What this asserts ────────────────────────────────────────────────────────
 * The whole point of learned scoring is that it can NEVER make scoring worse or
 * less deterministic than the hardcoded baseline. These tests lock in the two
 * pure cores that guarantee that:
 *
 *   selectEffectiveConfig()        — the read-path fallback decision. It must
 *                                    return the live/hardcoded config on every
 *                                    unhealthy condition (no learned row,
 *                                    inactive, below the sample gate, or an
 *                                    invalid stored config) and only return the
 *                                    learned config when it is active, gated, and
 *                                    valid.
 *   learnHireProbabilityWeights()  — the trainer. It must shrink toward the prior
 *                                    in inverse proportion to label count, stay a
 *                                    valid weight vector (non-negative, sums≈1),
 *                                    be deterministic, and fall back to the prior
 *                                    on degenerate data.
 *
 * Run via: pnpm --filter @workspace/api-server run test:learned
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectEffectiveConfig,
  learnHireProbabilityWeights,
  MIN_SAMPLES,
  type DimensionScoreRow,
} from "./learned-scoring";
import { BUILTIN_LIVE_CONFIG, type ScoringConfig } from "./scoring-config";

const LIVE: ScoringConfig = BUILTIN_LIVE_CONFIG;
const PRIOR = LIVE.weights.hireProbability;

/** A structurally valid learned config: a clone of live with a distinct version
 *  and re-weighted hireProbability (still summing to 1). */
function validLearnedConfig(): ScoringConfig {
  return {
    version: "learned-test-tenant-1",
    label: "Learned (test)",
    weights: {
      ...LIVE.weights,
      hireProbability: { fit: 0.4, quality: 0.3, trust: 0.2, conversion: 0.1 },
    },
  };
}

const ABOVE_GATE = MIN_SAMPLES + 5;
const BELOW_GATE = Math.max(0, MIN_SAMPLES - 1);

/* ── selectEffectiveConfig: fallback to live on every unhealthy condition ──── */

test("selectEffectiveConfig: null learned row → live config", () => {
  const got = selectEffectiveConfig({ learned: null, liveConfig: LIVE, minSamples: MIN_SAMPLES });
  assert.equal(got.version, LIVE.version);
});

test("selectEffectiveConfig: inactive learned row → live config", () => {
  const got = selectEffectiveConfig({
    learned: { configJson: validLearnedConfig(), sampleSize: ABOVE_GATE, isActive: false },
    liveConfig: LIVE,
    minSamples: MIN_SAMPLES,
  });
  assert.equal(got.version, LIVE.version);
});

test("selectEffectiveConfig: below the sample gate → live config", () => {
  const got = selectEffectiveConfig({
    learned: { configJson: validLearnedConfig(), sampleSize: BELOW_GATE, isActive: true },
    liveConfig: LIVE,
    minSamples: MIN_SAMPLES,
  });
  assert.equal(got.version, LIVE.version);
});

test("selectEffectiveConfig: invalid stored config → live config (never throws)", () => {
  const got = selectEffectiveConfig({
    learned: { configJson: { not: "a config" }, sampleSize: ABOVE_GATE, isActive: true },
    liveConfig: LIVE,
    minSamples: MIN_SAMPLES,
  });
  assert.equal(got.version, LIVE.version);
});

test("selectEffectiveConfig: NaN/garbage sampleSize → live config", () => {
  const got = selectEffectiveConfig({
    learned: { configJson: validLearnedConfig(), sampleSize: NaN, isActive: true },
    liveConfig: LIVE,
    minSamples: MIN_SAMPLES,
  });
  assert.equal(got.version, LIVE.version);
});

test("selectEffectiveConfig: active + gated + valid → learned config", () => {
  const learnedCfg = validLearnedConfig();
  const got = selectEffectiveConfig({
    learned: { configJson: learnedCfg, sampleSize: ABOVE_GATE, isActive: true },
    liveConfig: LIVE,
    minSamples: MIN_SAMPLES,
  });
  assert.equal(got.version, learnedCfg.version);
  assert.deepEqual(got.weights.hireProbability, learnedCfg.weights.hireProbability);
});

/* ── learnHireProbabilityWeights: shrinkage, validity, determinism, fallback ── */

/** n rows where `fit` perfectly predicts `hired` and the other three dimensions
 *  are constant (zero variance ⇒ zero correlation ⇒ no learned weight). */
function fitDrivenRows(n: number): DimensionScoreRow[] {
  const rows: DimensionScoreRow[] = [];
  for (let i = 0; i < n; i++) {
    const hired = (i % 2 === 0 ? 1 : 0) as 0 | 1;
    rows.push({ fit: hired ? 80 : 20, quality: 50, trust: 50, conversion: 50, hired });
  }
  return rows;
}

function weightSum(w: { fit: number; quality: number; trust: number; conversion: number }): number {
  return w.fit + w.quality + w.trust + w.conversion;
}

test("learnHireProbabilityWeights: empty rows → prior unchanged (degenerate)", () => {
  const res = learnHireProbabilityWeights([], PRIOR);
  assert.equal(res.degenerate, true);
  assert.deepEqual(res.weights, { ...PRIOR });
});

test("learnHireProbabilityWeights: no outcome variance → prior (degenerate)", () => {
  // All hired ⇒ the label has zero variance ⇒ no correlation anywhere ⇒ prior.
  const rows: DimensionScoreRow[] = Array.from({ length: 40 }, (_, i) => ({
    fit: i, quality: i, trust: i, conversion: i, hired: 1 as const,
  }));
  const res = learnHireProbabilityWeights(rows, PRIOR);
  assert.equal(res.degenerate, true);
  assert.deepEqual(res.weights, { ...PRIOR });
});

test("learnHireProbabilityWeights: weights are a valid vector (≥0, sum≈1)", () => {
  const res = learnHireProbabilityWeights(fitDrivenRows(200), PRIOR);
  for (const v of Object.values(res.weights)) assert.ok(v >= 0, `weight ${v} must be ≥ 0`);
  assert.ok(Math.abs(weightSum(res.weights) - 1) < 1e-3, `sum ${weightSum(res.weights)} ≈ 1`);
});

test("learnHireProbabilityWeights: deterministic for identical input", () => {
  const a = learnHireProbabilityWeights(fitDrivenRows(120), PRIOR);
  const b = learnHireProbabilityWeights(fitDrivenRows(120), PRIOR);
  assert.deepEqual(a.weights, b.weights);
});

test("learnHireProbabilityWeights: shrinks toward prior — small n moves less than large n", () => {
  const small = learnHireProbabilityWeights(fitDrivenRows(4), PRIOR);
  const large = learnHireProbabilityWeights(fitDrivenRows(800), PRIOR);

  // Data points entirely at `fit`, so the fit weight should rise above the prior
  // in both cases, but never reach the pure-data extreme of 1.0.
  assert.ok(small.weights.fit > PRIOR.fit, "small-n fit weight should move toward data");
  assert.ok(large.weights.fit > small.weights.fit, "more data ⇒ less shrinkage ⇒ closer to data");
  assert.ok(large.weights.fit < 1, "shrinkage keeps it below the pure-data extreme");

  // And the small-n result must stay much closer to the prior than the large-n one.
  const dSmall = Math.abs(small.weights.fit - PRIOR.fit);
  const dLarge = Math.abs(large.weights.fit - PRIOR.fit);
  assert.ok(dLarge > dSmall, "large-n result is further from the prior than small-n");
});
