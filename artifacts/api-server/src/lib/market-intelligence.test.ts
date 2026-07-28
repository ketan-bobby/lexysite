/**
 * market-intelligence.test.ts — Step 1 data-tool discipline.
 *
 * Every tool MUST return the explicit honest-empty shape
 * ({ status: "no_data", asOf, reason }) when data doesn't exist — never a
 * zero/null/default substitute. Tests exercise the pure compute functions
 * directly (no DB, no LLM), matching how the tools were structured.
 *
 * Run via: pnpm --filter @workspace/api-server run test:market-intel
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeHiringVelocity,
  computeCandidateSupply,
  computeCompSignal,
  computeInternalBench,
  parseSalaryRange,
  roleMatches,
  MIN_COMP_SAMPLE,
  MIN_VELOCITY_SAMPLE,
} from "./market-intelligence";

function assertNoData(result: any, reasonPattern: RegExp) {
  assert.equal(result.status, "no_data", `expected honest-empty, got: ${JSON.stringify(result)}`);
  assert.ok(typeof result.asOf === "string" && !Number.isNaN(Date.parse(result.asOf)), "asOf must be a valid ISO timestamp");
  assert.match(result.reason, reasonPattern);
  // The honest-empty shape must NOT smuggle fabricated aggregates alongside
  assert.equal("medianDaysToFill" in result, false);
  assert.equal("sampleSize" in result, false);
  assert.equal("medianLow" in result, false);
  assert.equal("matchCount" in result, false);
}

/* ── getHiringVelocity ────────────────────────────────────────────────────── */

test("hiring velocity: zero hires → no_data, not zeros", () => {
  assertNoData(computeHiringVelocity([], 0, 0, "tenant"), /no completed hires/);
});

test("hiring velocity: below minimum sample → no_data naming the threshold", () => {
  const r = computeHiringVelocity([12], 5, 1, "tenant");
  assertNoData(r, new RegExp(`below the minimum sample of ${MIN_VELOCITY_SAMPLE}`));
});

test("hiring velocity: real data → median + ratio + sample size + timestamp", () => {
  const r = computeHiringVelocity([10, 20, 30, 40], 10, 4, "tenant");
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.medianDaysToFill, 25);
  assert.equal(r.sourcedToHireRatio, 0.4);
  assert.equal(r.sampleSize, 4);
  assert.ok(!Number.isNaN(Date.parse(r.asOf)));
});

test("hiring velocity: no sourced entries → ratio is null, never a fake 0", () => {
  const r = computeHiringVelocity([10, 20, 30], 0, 0, "tenant");
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.sourcedToHireRatio, null);
});

/* ── getCandidateSupply ───────────────────────────────────────────────────── */

test("candidate supply: no searches in window → no_data with the window named", () => {
  assertNoData(computeCandidateSupply([], 30), /no comparable sourcing searches ran in the last 30 days/);
});

test("candidate supply: stale runs outside the window → still no_data (honest staleness)", () => {
  const old = new Date(Date.now() - 90 * 86_400_000);
  assertNoData(computeCandidateSupply([{ found: 40, startedAt: old }], 30), /last 30 days/);
});

test("candidate supply: recent runs → totals + recency statement; no prior window → trend null", () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 5 * 86_400_000);
  const r = computeCandidateSupply([{ found: 12, startedAt: recent }, { found: 18, startedAt: recent }], 30, now);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.searchesInWindow, 2);
  assert.equal(r.totalCandidatesFound, 30);
  assert.equal(r.trend, null); // no prior-window data → honest null, not "flat"
  assert.match(r.basedOn, /last 30 days/);
});

test("candidate supply: prior window present → trend computed", () => {
  const now = new Date();
  const recent = new Date(now.getTime() - 5 * 86_400_000);
  const prior = new Date(now.getTime() - 40 * 86_400_000);
  const r = computeCandidateSupply(
    [{ found: 30, startedAt: recent }, { found: 10, startedAt: prior }],
    30,
    now,
  );
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.trend, "up");
});

/* ── getCompSignal ────────────────────────────────────────────────────────── */

test("comp signal: zero matching candidates → no_data", () => {
  assertNoData(computeCompSignal([]), /no candidates with a stated salary expectation/);
});

test(`comp signal: below k-anonymity minimum (${MIN_COMP_SAMPLE}) → insufficient data, no aggregates`, () => {
  const few: Array<[number, number]> = [[100_000, 120_000], [110_000, 130_000]];
  assertNoData(computeCompSignal(few), new RegExp(`minimum sample is ${MIN_COMP_SAMPLE}`));
});

test("comp signal: at threshold → aggregate medians only, never individual rows", () => {
  const ranges: Array<[number, number]> = [
    [100_000, 120_000], [110_000, 130_000], [120_000, 140_000], [130_000, 150_000], [140_000, 160_000],
  ];
  const r = computeCompSignal(ranges);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.sampleSize, 5);
  assert.equal(r.medianLow, 120_000);
  assert.equal(r.medianHigh, 140_000);
  assert.equal("ranges" in (r as any), false); // raw values never leave the tool
});

test("salary parsing: k-suffix, currency symbols, commas; garbage → null (never a guess)", () => {
  assert.deepEqual(parseSalaryRange("$120k-$150k"), [120_000, 150_000]);
  assert.deepEqual(parseSalaryRange("120,000 - 140,000"), [120_000, 140_000]);
  assert.deepEqual(parseSalaryRange("around 95k"), [95_000, 95_000]);
  assert.equal(parseSalaryRange("competitive"), null);
  assert.equal(parseSalaryRange(""), null);
  assert.equal(parseSalaryRange(null), null);
});

/* ── getInternalBench ─────────────────────────────────────────────────────── */

test("internal bench: empty pool → no_data, not matchCount 0", () => {
  assertNoData(computeInternalBench([], "Design Engineer", ["figma"]), /no candidates in your own talent pool/);
});

test("internal bench: candidates exist but none match → no_data", () => {
  const pool = [
    { id: "1", firstName: "A", lastName: "B", currentTitle: "Accountant", skills: ["excel"], isCurrentEmployee: false },
  ];
  assertNoData(computeInternalBench(pool, "Design Engineer", ["figma", "cad"]), /no candidates in your own talent pool/);
});

test("internal bench: matches → count, employee split, capped top matches", () => {
  const pool = [
    { id: "1", firstName: "Dana", lastName: "K", currentTitle: "Design Engineer", skills: ["figma", "cad"], isCurrentEmployee: true },
    { id: "2", firstName: "Sam", lastName: "L", currentTitle: "Senior Design Engineer", skills: ["cad"], isCurrentEmployee: false },
    { id: "3", firstName: "Pat", lastName: "M", currentTitle: "Chef", skills: ["cooking"], isCurrentEmployee: false },
  ];
  const r = computeInternalBench(pool, "Design Engineer", ["figma", "cad"]);
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.matchCount, 2);
  assert.equal(r.currentEmployeeCount, 1);
  assert.equal(r.topMatches[0].candidateId, "1"); // best match leads
  assert.ok(r.topMatches.every(m => m.matchScore >= 50));
});

/* ── shared matching ──────────────────────────────────────────────────────── */

test("roleMatches: containment + token overlap, case-insensitive", () => {
  assert.equal(roleMatches("design engineer", "Senior Design Engineer II"), true);
  assert.equal(roleMatches("Design Engineer", "engineer, design systems"), true);
  assert.equal(roleMatches("design engineer", "Account Manager"), false);
  assert.equal(roleMatches("", "Design Engineer"), false);
});
