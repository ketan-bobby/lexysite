/**
 * scoring-core.ts — Shared weight-sum-clamp scoring scaffolding
 *
 * Used by BOTH connection engines:
 *   • connectionEngine.ts           (employer-side, connection_events/scores)
 *   • candidateConnectionEngine.ts  (candidate-side, candidate_connection_*)
 *
 * The two engines remain completely independent — different weight tables,
 * different DB tables, different consumers. Only the generic math lives here
 * so a fix in the sum/clamp/top-signals logic can never drift between them.
 */

/** Sum event weights and clamp the result to [0, 100]. */
export function sumWeightsClamped(
  events: { eventType: string }[],
  weights: Record<string, number>,
): number {
  let raw = 0;
  for (const ev of events) {
    raw += weights[ev.eventType] ?? 0;
  }
  return Math.min(100, Math.max(0, raw));
}

/**
 * Derive the top-N contributing signals (event types) sorted by weight
 * magnitude, for display purposes.
 *
 * `skipZeroWeight` preserves a behavioral difference between the two engines:
 * the candidate-side engine excludes unweighted event types from the counts,
 * the employer-side engine includes them. Do not unify without checking both
 * call sites.
 */
export function topSignalsByWeight(
  events: { eventType: string }[],
  weights: Record<string, number>,
  opts: { skipZeroWeight?: boolean; limit?: number } = {},
): string[] {
  const { skipZeroWeight = false, limit = 3 } = opts;
  const counts: Record<string, number> = {};
  for (const ev of events) {
    if (skipZeroWeight && (weights[ev.eventType] ?? 0) === 0) continue;
    counts[ev.eventType] = (counts[ev.eventType] ?? 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => Math.abs(weights[b[0]] ?? 0) - Math.abs(weights[a[0]] ?? 0))
    .slice(0, limit)
    .map(([type]) => type);
}
