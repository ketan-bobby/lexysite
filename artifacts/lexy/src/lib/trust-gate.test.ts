/**
 * trust-gate.test.ts — Verification-gate display rule.
 *
 * RULE: when a candidate's Trust score is below the advance threshold (<65),
 * the card's PRIMARY visual must be the gate status ("Needs Verification"),
 * with the hire-probability percentage rendered smaller/secondary. Only
 * candidates who've cleared the gate show the score as the primary number.
 *
 * Part 1 asserts the gate predicate's semantics (mirrors the backend
 * decideNextAction advance requirement of trustScore >= 65).
 * Part 2 is a source guard: every surface that renders hire probability as
 * its primary number must import @/lib/trust-gate and branch on isTrustGated.
 *
 * Run via: pnpm --filter @workspace/lexy run test:trust-gate
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isTrustGated, TRUST_ADVANCE_THRESHOLD } from "./trust-gate";

const SRC = resolve(import.meta.dirname, "..");

/* ── Part 1: gate semantics ─────────────────────────────────────────────── */

test("threshold mirrors the backend advance requirement (65)", () => {
  assert.equal(TRUST_ADVANCE_THRESHOLD, 65);
});

test("trust below 65 is gated; 65+ has cleared the gate", () => {
  assert.equal(isTrustGated(0), true);
  assert.equal(isTrustGated(50), true);   // the 85/85/50 case that motivated this
  assert.equal(isTrustGated(64), true);
  assert.equal(isTrustGated(65), false);
  assert.equal(isTrustGated(85), false);
  assert.equal(isTrustGated(100), false);
});

test("unknown trust (null/undefined) is gated — unverified is the gate's whole point", () => {
  assert.equal(isTrustGated(null), true);
  assert.equal(isTrustGated(undefined), true);
});

/* ── Part 2: source guard — hp-primary surfaces branch on the gate ──────── */

const HP_PRIMARY_SURFACES = [
  // BrainCard's ProbabilityRing is the loudest element on the summary card.
  "pages/recruiter/candidates/index.tsx",
  // Full "Lexy Prediction" card + compact inline variant both lead with hp%.
  "components/intelligence/LexyCandidatePrediction.tsx",
  // Decision-queue card leads with a 2xl hp% in the left rail.
  "pages/recruiter/decision-queue.tsx",
  // Dashboard "Hire-Ready Candidates" widget headlines the hp badge.
  "pages/recruiter/dashboard.tsx",
  // Executive view: Top-3 cards + ready/blocked CandidateRow hp figures.
  "components/intelligence/ExecutiveJobView.tsx",
];

test("every hp-primary surface imports the trust gate and branches on it", () => {
  for (const rel of HP_PRIMARY_SURFACES) {
    const src = readFileSync(resolve(SRC, rel), "utf8");
    assert.match(
      src,
      /from ["']@\/lib\/trust-gate["']/,
      `${rel} renders hire probability as the primary number but does not import @/lib/trust-gate`,
    );
    assert.match(
      src,
      /isTrustGated\s*\(/,
      `${rel} imports trust-gate but never calls isTrustGated — the gate branch is missing`,
    );
  }
});

test("gated surfaces do not hardcode a divergent trust threshold", () => {
  // Any inline `trustScore < N` comparison in the display surfaces risks
  // drifting from the canonical threshold — must go through isTrustGated.
  const offenders: string[] = [];
  for (const rel of HP_PRIMARY_SURFACES) {
    const src = readFileSync(resolve(SRC, rel), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/trustScore\s*[<>]=?\s*\d+/.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.equal(
    offenders.length,
    0,
    `Inline trust-threshold comparison found — use isTrustGated() instead:\n${offenders.join("\n")}`,
  );
});
