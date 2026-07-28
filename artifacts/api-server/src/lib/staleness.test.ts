/**
 * staleness.test.ts — regression tests for the profile-staleness ranking
 * multiplier (run: pnpm run test:staleness).
 *
 * Core regression (user-specified): two candidates with IDENTICAL underlying
 * fit, one fresh and one 200-days-stale — the fresh one must rank higher and
 * the stale one must STILL APPEAR (demote, never erase).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stalenessMultiplier,
  daysInactive,
  rankWithStaleness,
  STALENESS_FLOOR,
} from "./staleness.js";

const NOW = new Date("2026-07-07T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

test("full weight at ≤30 days", () => {
  assert.equal(stalenessMultiplier(daysAgo(0), NOW), 1);
  assert.equal(stalenessMultiplier(daysAgo(15), NOW), 1);
  assert.equal(stalenessMultiplier(daysAgo(30), NOW), 1);
});

test("linear taper between 30 and 180 days, monotonically decreasing", () => {
  const m60 = stalenessMultiplier(daysAgo(60), NOW);
  const m105 = stalenessMultiplier(daysAgo(105), NOW);
  const m150 = stalenessMultiplier(daysAgo(150), NOW);
  assert.ok(m60 < 1 && m60 > m105 && m105 > m150 && m150 > STALENESS_FLOOR);
  // midpoint of taper (105d) ≈ 0.8
  assert.ok(Math.abs(m105 - 0.8) < 0.01);
});

test("hard floor at 0.6 — never lower, never zero", () => {
  assert.equal(stalenessMultiplier(daysAgo(180), NOW), STALENESS_FLOOR);
  assert.equal(stalenessMultiplier(daysAgo(200), NOW), STALENESS_FLOOR);
  assert.equal(stalenessMultiplier(daysAgo(2000), NOW), STALENESS_FLOOR);
});

test("unknown last-activity → full weight (never punish missing data)", () => {
  assert.equal(stalenessMultiplier(null, NOW), 1);
  assert.equal(stalenessMultiplier(undefined, NOW), 1);
  assert.equal(stalenessMultiplier("not-a-date", NOW), 1);
  assert.equal(daysInactive(null, NOW), null);
});

test("REGRESSION: identical fit, fresh vs 200-days-stale — fresh ranks higher, stale still appears", () => {
  const fresh = { id: "fresh", fit: 90, lastActiveAt: daysAgo(3) };
  const stale = { id: "stale", fit: 90, lastActiveAt: daysAgo(200) };
  const ranked = rankWithStaleness(
    [stale, fresh], // deliberately stale-first input order
    (c) => c.fit,
    (c) => c.lastActiveAt,
    NOW,
  );
  // Both still present — demoted, not erased.
  assert.equal(ranked.length, 2);
  // Fresh outranks stale despite identical underlying fit.
  assert.equal(ranked[0].item.id, "fresh");
  assert.equal(ranked[1].item.id, "stale");
  assert.ok(ranked[1].rankScore > 0);
  // Base (displayed) score is untouched for both.
  assert.equal(ranked[0].baseScore, 90);
  assert.equal(ranked[1].baseScore, 90);
});

test("a strong-but-stale candidate still beats a mediocre fresh one", () => {
  const strongStale = { id: "strong-stale", fit: 90, lastActiveAt: daysAgo(200) }; // 90×0.6 = 54
  const weakFresh = { id: "weak-fresh", fit: 50, lastActiveAt: daysAgo(1) };       // 50×1.0 = 50
  const ranked = rankWithStaleness([weakFresh, strongStale], (c) => c.fit, (c) => c.lastActiveAt, NOW);
  assert.equal(ranked[0].item.id, "strong-stale");
});
