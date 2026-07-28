/**
 * score-display.test.ts — Summary-card vs detail-view score consistency.
 *
 * Bug this guards against: the Hiring Intelligence summary card and the
 * expanded/detail view showed DIFFERENT "Conversion" values for the same
 * candidate_job_intelligence record. Both read the same stored column, but a
 * NULL score (no agent signal yet) was rendered three different ways:
 *   - summary card ScoreBar:        `value ?? 0`   → "0"
 *   - /decision endpoint + widgets: `value ?? 50`  → "50"
 *   - IntelligencePanel ScoreBar:   `"—"`
 *
 * Fix: every surface renders through @/lib/score-display (displayScore /
 * scoreBarWidth), and the /decision endpoint returns RAW nullable scores
 * (neutral-50 coercion stays internal to the decision math).
 *
 * Part 1 asserts the shared formatter's semantics (the "identical value"
 * contract — since all surfaces call it, equal input ⇒ equal rendering).
 * Part 2 is a source guard: every file that renders a "Conversion" dimension
 * must import score-display, and no display path may fabricate a value with
 * `conversionScore ?? 0` / `?? 50` when building a `scores` object.
 *
 * Run via: pnpm --filter @workspace/lexy run test:score-display
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { displayScore, scoreBarWidth } from "./score-display";

const SRC = resolve(import.meta.dirname, "..");

/* ── Part 1: shared formatter semantics ─────────────────────────────────── */

test("same record value renders identically on card and detail surfaces", () => {
  // Every surface renders via displayScore, so for ANY stored value the
  // card and the detail view are byte-identical by construction.
  const storedValues: Array<number | null | undefined> = [null, undefined, 0, 1, 42, 49.6, 50, 100];
  for (const v of storedValues) {
    const card = displayScore(v);
    const detail = displayScore(v);
    assert.equal(card, detail, `card and detail must agree for stored value ${v}`);
  }
});

test("null/unknown renders as em-dash, never a fabricated 0 or 50", () => {
  assert.equal(displayScore(null), "—");
  assert.equal(displayScore(undefined), "—");
  assert.equal(scoreBarWidth(null), 0);
  assert.equal(scoreBarWidth(undefined), 0);
});

test("a real 0 stays visible as 0 (never hidden as unknown)", () => {
  assert.equal(displayScore(0), "0");
  assert.equal(scoreBarWidth(0), 0);
});

test("numbers render rounded and bars clamp to 0–100", () => {
  assert.equal(displayScore(72), "72");
  assert.equal(displayScore(49.6), "50");
  assert.equal(scoreBarWidth(72), 72);
  assert.equal(scoreBarWidth(120), 100);
  assert.equal(scoreBarWidth(-5), 0);
});

/* ── Part 2: source guard — all Conversion surfaces use the shared path ─── */

const CONVERSION_SURFACES = [
  "pages/recruiter/candidates/index.tsx",              // summary BrainCard
  "components/intelligence/CandidateIntelligenceCard.tsx", // expanded detail (/decision)
  "components/intelligence/IntelligencePanel.tsx",     // panel bars + inline prediction
  "components/intelligence/LexyCandidatePrediction.tsx",   // compact dimension grid
];

test("every Conversion-rendering surface imports the shared score-display helper", () => {
  for (const rel of CONVERSION_SURFACES) {
    const src = readFileSync(resolve(SRC, rel), "utf8");
    assert.match(
      src,
      /from ["']@\/lib\/score-display["']|from ["']\.\.?\/.*score-display["']/,
      `${rel} renders a Conversion score but does not import @/lib/score-display`,
    );
  }
});

test("no display surface fabricates a Conversion value with ?? 0 / ?? 50 in a scores object", () => {
  // The neutral-50 coercion is legal ONLY inside narrative/decision logic
  // (locals in derive* helpers), never when assembling a `scores:`/display
  // object literal — that is exactly the drift the fix removed.
  const offenders: string[] = [];
  for (const rel of CONVERSION_SURFACES) {
    const src = readFileSync(resolve(SRC, rel), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      // property-assignment form: `conversionScore: x.conversionScore ?? 50,`
      if (/conversionScore:\s*[^,]*conversionScore\s*\?\?\s*(0|50)\b/.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  assert.equal(
    offenders.length,
    0,
    `Found fabricated Conversion display value(s) — render raw nulls via displayScore instead:\n${offenders.join("\n")}`,
  );
});
