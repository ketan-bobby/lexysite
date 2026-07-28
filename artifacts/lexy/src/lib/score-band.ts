/* Canonical match/fit score banding — the single source of truth for how a
 * 0–100 match/fit score maps to a strength band and its pill colours. Every
 * match pill across the app must consume this rather than re-declaring local
 * thresholds, so a candidate who reads "76% — strong" on one surface never
 * reads a different band on another.
 *
 * Thresholds (>=75 strong / 55–74 good / <55 fair) encode the RATIFIED,
 * user-facing Intelligence legend (IntelligencePanel.tsx renders "≥75 Strong",
 * "55–74 Moderate"). They are deliberately NOT the older inline `>=80/>=60`
 * pill code these values replaced — that was un-ratified drift, not a decision.
 * The lib must encode the legend, not compete with it: change the number HERE
 * and update the legend in lockstep (a user-visible semantics change). */
export type ScoreBand = "strong" | "good" | "fair";

export function scoreBand(score: number): ScoreBand {
  if (score >= 75) return "strong";
  if (score >= 55) return "good";
  return "fair";
}

/* Map a match/fit score to an arbitrary per-surface value (a colour token, a
 * hex string, a label — anything) keyed by its canonical band. This is the ONE
 * sanctioned way for a match surface to pick a colour/label WITHOUT restating
 * the 75/55 cutoffs. Surfaces keep their own colour vocabulary (Tailwind, hex,
 * neon) but all share the single threshold, so drift cannot creep back in. */
export function bandBy<T>(score: number, byBand: Record<ScoreBand, T>): T {
  return byBand[scoreBand(score)];
}

/* Tailwind classes for a bordered, tinted pill, keyed by band. All colours are
 * existing design tokens / theme-aware pairs. */
export const SCORE_BAND_PILL: Record<ScoreBand, string> = {
  strong: "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/25",
  good: "text-primary bg-primary/10 border-primary/25",
  fair: "text-orange-700 dark:text-orange-400 bg-orange-500/10 border-orange-500/25",
};
