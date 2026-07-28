/**
 * staleness.ts — profile-staleness ranking multiplier
 *
 * Makes the re-engagement email's promise true: inactive profiles rank BELOW
 * equally-matched active candidates on the recruiter-facing ranking surfaces
 * (talent-rediscovery fit ranking, intelligence hire-probability ranking).
 *
 * Semantics — DEMOTE, never ERASE:
 *   • ≤ 30 days since last activity → full weight (×1.0)
 *   • 30 → 180 days → linear taper from 1.0 down to 0.6
 *   • ≥ 180 days → hard floor at ×0.6 (a genuinely strong stale candidate
 *     still surfaces for a great match — e.g. a 90-fit at 200 days ranks as
 *     54, above a fresh 50-fit — it is never filtered out)
 *   • unknown last-activity → full weight (never punish missing data)
 *
 * Applied at READ-TIME only: stored scores (applications.match_score,
 * candidate_job_intelligence.*, candidates.talent_match_score) are NEVER
 * decayed in place — the multiplier is recomputed fresh on every ranking
 * read, so there is no cached-staleness invalidation problem and un-pausing
 * activity instantly restores full weight.
 *
 * Displayed match-quality scores stay the BASE score (match quality doesn't
 * change with inactivity); ranking order uses `rankScore = base × multiplier`.
 */

export const STALENESS_FULL_WEIGHT_DAYS = 30;
export const STALENESS_FLOOR_DAYS = 180;
export const STALENESS_FLOOR = 0.6;

/** Days since the given date; null when unknown. */
export function daysInactive(lastActiveAt: Date | string | null | undefined, now: Date = new Date()): number | null {
  if (!lastActiveAt) return null;
  const t = lastActiveAt instanceof Date ? lastActiveAt.getTime() : Date.parse(String(lastActiveAt));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

/** ×1.0 at ≤30d, linear taper to ×0.6 at 180d, floored at 0.6. Unknown → 1.0. */
export function stalenessMultiplier(lastActiveAt: Date | string | null | undefined, now: Date = new Date()): number {
  const days = daysInactive(lastActiveAt, now);
  if (days === null || days <= STALENESS_FULL_WEIGHT_DAYS) return 1;
  if (days >= STALENESS_FLOOR_DAYS) return STALENESS_FLOOR;
  const span = STALENESS_FLOOR_DAYS - STALENESS_FULL_WEIGHT_DAYS;
  const frac = (days - STALENESS_FULL_WEIGHT_DAYS) / span;
  return Math.round((1 - frac * (1 - STALENESS_FLOOR)) * 1000) / 1000;
}

export interface StalenessRanked<T> {
  item: T;
  baseScore: number;
  rankScore: number;
  stalenessMultiplier: number;
  daysInactive: number | null;
}

/**
 * Rank items by staleness-adjusted score, descending. Shared by the
 * production ranking surfaces AND the regression test, so the test exercises
 * the exact code path recruiters see. Never drops an item.
 */
export function rankWithStaleness<T>(
  items: T[],
  getBaseScore: (t: T) => number,
  getLastActiveAt: (t: T) => Date | string | null | undefined,
  now: Date = new Date(),
): StalenessRanked<T>[] {
  return items
    .map((item) => {
      const baseScore = getBaseScore(item);
      const mult = stalenessMultiplier(getLastActiveAt(item), now);
      return {
        item,
        baseScore,
        rankScore: Math.round(baseScore * mult * 100) / 100,
        stalenessMultiplier: mult,
        daysInactive: daysInactive(getLastActiveAt(item), now),
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}
