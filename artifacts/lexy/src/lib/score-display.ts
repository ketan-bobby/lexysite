/**
 * score-display.ts — Single source of truth for RENDERING an intelligence
 * dimension score (Fit / Quality / Trust / Conversion / Hire Probability).
 *
 * The accrued candidate_job_intelligence record is the canonical score store,
 * but a dimension can legitimately be NULL (no agent signal yet). Every surface
 * must render that null the SAME way, or the same record "drifts" by page:
 * the summary card once showed 0, the detail view showed a fabricated 50.
 *
 * Rules (enforced by score-display.test.ts source guard):
 *  - null/undefined  → "—"   (unknown, never fabricate a neutral 50 or a 0)
 *  - real number     → rounded integer string (a real 0 stays "0")
 * Bar widths for unknown scores are 0 (nothing to fill), NOT a half bar.
 */
export function displayScore(value: number | null | undefined): string {
  return value == null ? "—" : String(Math.round(value));
}

/** Width (0–100) for a score progress bar. Unknown → empty bar. */
export function scoreBarWidth(value: number | null | undefined): number {
  if (value == null) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
