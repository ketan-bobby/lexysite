/**
 * intelligence-bands.ts — Banding thresholds for Lexy INTELLIGENCE sub-scores
 * (trust, quality, conversion, confidence, coverage, freshness, and any
 * hire-probability surfaced as an intelligence signal).
 *
 * These are a DIFFERENT quantity from candidate↔job MATCH fit. They share ONE
 * banding convention across the intelligence panels, but they are deliberately
 * NOT the canonical match band defined in lib/score-band.ts.
 *
 * The fact that the current cutoffs (75 / 55) equal the match cutoffs is
 * COINCIDENTAL: changing the match band must not silently move these, and
 * moving these must not touch the match band. Keep them independent on purpose.
 */
export const INTELLIGENCE_BANDS = { strong: 75, moderate: 55 } as const;

export type IntelBand = "strong" | "moderate" | "weak";

/** Classify an intelligence sub-score into its band. */
export function intelBand(score: number): IntelBand {
  if (score >= INTELLIGENCE_BANDS.strong) return "strong";
  if (score >= INTELLIGENCE_BANDS.moderate) return "moderate";
  return "weak";
}

/**
 * The ONE sanctioned per-surface picker for intelligence sub-scores: callers
 * supply their own colour/label vocabulary keyed by band, sharing the threshold
 * without hard-coding it inline.
 */
export function intelBandBy<T>(score: number, byBand: { strong: T; moderate: T; weak: T }): T {
  return byBand[intelBand(score)];
}
