/**
 * similar-hire.test.ts — Real similar-hire embedding signal (Task #26)
 *
 * ─── What this asserts ────────────────────────────────────────────────────────
 * The embedding signal must NEVER be less deterministic or less safe than the
 * permanent LLM-vs-ICP fallback. These tests lock in the pure cores that
 * guarantee that, with no DB or network:
 *
 *   buildCandidateProfileText  — deterministic + order/dup-insensitive over
 *                                skills, so the same profile always hashes the
 *                                same and the writer can skip re-embedding.
 *   cosineSimilarity           — correct on the canonical cases (identical,
 *                                orthogonal, opposite) and safe on degenerate
 *                                input (zero norm, length mismatch).
 *   scoreFromSimilarities      — top-K mean cosine mapped [-1,1]→[0,100],
 *                                deterministic, honors topK, null on empty.
 *   selectSimilarHireStrategy  — the gate: inactive→fallback, below the exemplar
 *                                gate→fallback, only active+gated→embedding.
 *   profileTextHash            — stable + sensitive to text and model.
 *
 * Run via: pnpm --filter @workspace/api-server run test:similar
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCandidateProfileText,
  profileTextHash,
  cosineSimilarity,
  scoreFromSimilarities,
  selectSimilarHireStrategy,
  withSimilarHire,
} from "./similar-hire";
import type { AgentSignals } from "./intelligence";

/* ── buildCandidateProfileText: deterministic + order/dup-insensitive ──────── */

test("buildCandidateProfileText: deterministic for the same input", () => {
  const c = { currentTitle: "Senior RN", currentCompany: "Acme Health", skills: ["Epic", "Triage"] };
  assert.equal(buildCandidateProfileText(c), buildCandidateProfileText({ ...c, skills: [...c.skills] }));
});

test("buildCandidateProfileText: skill order does not change the text", () => {
  const a = buildCandidateProfileText({ currentTitle: "RN", skills: ["Triage", "Epic", "ICU"] });
  const b = buildCandidateProfileText({ currentTitle: "RN", skills: ["ICU", "Epic", "Triage"] });
  assert.equal(a, b);
});

test("buildCandidateProfileText: duplicate/blank skills are collapsed", () => {
  const a = buildCandidateProfileText({ currentTitle: "RN", skills: ["Epic", "Epic", "", "  ", "Triage"] });
  const b = buildCandidateProfileText({ currentTitle: "RN", skills: ["Triage", "Epic"] });
  assert.equal(a, b);
});

test("buildCandidateProfileText: missing fields render as Unknown, never throws", () => {
  const text = buildCandidateProfileText({});
  assert.match(text, /Title: Unknown/);
  assert.match(text, /Company: Unknown/);
});

/* ── profileTextHash: stable + sensitive ──────────────────────────────────── */

test("profileTextHash: stable for the same model+text", () => {
  assert.equal(profileTextHash("m", "hello"), profileTextHash("m", "hello"));
});

test("profileTextHash: changes with text and with model", () => {
  assert.notEqual(profileTextHash("m", "a"), profileTextHash("m", "b"));
  assert.notEqual(profileTextHash("m1", "a"), profileTextHash("m2", "a"));
});

/* ── cosineSimilarity: canonical + degenerate cases ───────────────────────── */

test("cosineSimilarity: identical vectors → 1", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
});

test("cosineSimilarity: orthogonal vectors → 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosineSimilarity: opposite vectors → -1", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2], [-1, -2]) - -1) < 1e-12);
});

test("cosineSimilarity: scale-invariant", () => {
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
});

test("cosineSimilarity: zero-norm / mismatched length → 0 (never NaN)", () => {
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

/* ── scoreFromSimilarities: mapping, determinism, topK, empty ─────────────── */

test("scoreFromSimilarities: all-identical (cos=1) → 100", () => {
  assert.equal(scoreFromSimilarities([1, 1, 1], 3), 100);
});

test("scoreFromSimilarities: all-opposite (cos=-1) → 0", () => {
  assert.equal(scoreFromSimilarities([-1, -1], 2), 0);
});

test("scoreFromSimilarities: cos=0 → 50 (midpoint)", () => {
  assert.equal(scoreFromSimilarities([0], 1), 50);
});

test("scoreFromSimilarities: takes the top-K most similar, ignores the rest", () => {
  // top-2 of [0.9, 0.8, -1, -1] → mean 0.85 → (0.85+1)/2*100 = 92.5 → 93
  assert.equal(scoreFromSimilarities([0.9, 0.8, -1, -1], 2), 93);
});

test("scoreFromSimilarities: deterministic regardless of input order", () => {
  const a = scoreFromSimilarities([0.2, 0.9, -0.3, 0.5], 2);
  const b = scoreFromSimilarities([0.5, -0.3, 0.9, 0.2], 2);
  assert.equal(a, b);
});

test("scoreFromSimilarities: empty / no finite values → null", () => {
  assert.equal(scoreFromSimilarities([], 5), null);
  assert.equal(scoreFromSimilarities([NaN, Infinity], 5), null);
});

/* ── selectSimilarHireStrategy: the gate ──────────────────────────────────── */

test("selectSimilarHireStrategy: inactive → fallback (even with plenty of exemplars)", () => {
  assert.equal(selectSimilarHireStrategy({ active: false, exemplarCount: 100, minExemplars: 5 }), "fallback");
});

test("selectSimilarHireStrategy: active but below the exemplar gate → fallback", () => {
  assert.equal(selectSimilarHireStrategy({ active: true, exemplarCount: 4, minExemplars: 5 }), "fallback");
});

test("selectSimilarHireStrategy: active and at/above the gate → embedding", () => {
  assert.equal(selectSimilarHireStrategy({ active: true, exemplarCount: 5, minExemplars: 5 }), "embedding");
  assert.equal(selectSimilarHireStrategy({ active: true, exemplarCount: 9, minExemplars: 5 }), "embedding");
});

test("selectSimilarHireStrategy: non-finite exemplar count → fallback", () => {
  assert.equal(selectSimilarHireStrategy({ active: true, exemplarCount: NaN, minExemplars: 5 }), "fallback");
});

/* ── withSimilarHire: the one place the backtest arms differ ───────────────── */

test("withSimilarHire: sets the score without mutating the input", () => {
  const signals: AgentSignals = { screening: { score: 70 } } as AgentSignals;
  const out = withSimilarHire(signals, 80);
  assert.equal(out.analytics?.similarHirePatternScore, 80);
  // input untouched
  assert.equal(signals.analytics, undefined);
});

test("withSimilarHire: overwrites any prior score (no stale value leaks)", () => {
  const signals = { analytics: { similarHirePatternScore: 12 } } as AgentSignals;
  assert.equal(withSimilarHire(signals, 88).analytics?.similarHirePatternScore, 88);
});

test("withSimilarHire: null clears the score (honest 'fallback unavailable' row)", () => {
  const signals = { analytics: { similarHirePatternScore: 50 } } as AgentSignals;
  assert.equal(withSimilarHire(signals, null).analytics?.similarHirePatternScore, undefined);
});

test("withSimilarHire: preserves other analytics fields", () => {
  const signals = { analytics: { peerPercentile: 33, similarHirePatternScore: 5 } } as any;
  const out = withSimilarHire(signals, 90) as any;
  assert.equal(out.analytics.peerPercentile, 33);
  assert.equal(out.analytics.similarHirePatternScore, 90);
});

/* ── Backtest arm selection: candidate arm = embedding ?? fallback ─────────────
 * The backtest activates the signal only when the embedding strategy beats the
 * FALLBACK strategy. These lock in the per-row score each arm feeds the scorer:
 *   baseline arm  → always the fallback score
 *   candidate arm → embedding score when present, else the same fallback score
 * so a row below the exemplar gate (embedding null) is byte-identical in both
 * arms and cannot, on its own, swing the promotion decision. */

function armScores(embeddingScore: number | null, fallbackScore: number | null) {
  return { baseline: fallbackScore, candidate: embeddingScore ?? fallbackScore };
}

test("backtest arms: below-gate row (embedding null) is identical in both arms", () => {
  const { baseline, candidate } = armScores(null, 64);
  assert.equal(baseline, candidate);
});

test("backtest arms: gated row uses the embedding score for the candidate arm only", () => {
  const { baseline, candidate } = armScores(91, 64);
  assert.equal(baseline, 64);
  assert.equal(candidate, 91);
});

test("backtest arms: fallback unavailable + no embedding → both null (no signal)", () => {
  const { baseline, candidate } = armScores(null, null);
  assert.equal(baseline, null);
  assert.equal(candidate, null);
});
