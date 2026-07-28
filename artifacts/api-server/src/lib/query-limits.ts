/**
 * query-limits.ts — Defensive caps for collection-returning queries.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Most GET-list handlers in routes/* run `db.select().from(X)` with no LIMIT
 * and then slice/filter in JavaScript. That's fine for a 50-row tenant but a
 * 50,000-candidate tenant hitting GET /candidates pulls the entire table into
 * Node memory and can OOM the api-server process — taking down every other
 * tenant on the replica.
 *
 * This file exports a single hard cap, MAX_PAGE_SIZE, that those queries
 * append as `.limit(MAX_PAGE_SIZE)`. It is a safety net, not pagination.
 * Hitting the cap means the route returned a truncated page, and the
 * frontend may show a stale-looking count — but the server stays up. The
 * proper fix (push pagination + filters + SQL counts into the database)
 * is tracked separately for each route.
 *
 * ─── Why 1000 ─────────────────────────────────────────────────────────────────
 * Chosen as a balance between (a) almost no real UI screen renders more
 * than a few hundred rows at once, so 1000 is "safely above any legitimate
 * page", and (b) 1000 rows of a wide table like candidates is on the order
 * of a few MB of JSON — survivable per request even at moderate concurrency.
 *
 * ─── What this is NOT for ─────────────────────────────────────────────────────
 * Analytics endpoints (routes/analytics.ts) that compute counts/aggregates
 * over the full tenant dataset MUST NOT use this cap — silently aggregating
 * over a truncated 1000-row sample would produce wrong numbers. Those
 * routes need to move to SQL aggregations (count(), sum(), group by) at
 * the database level. Tracked as a follow-up.
 */
export const MAX_PAGE_SIZE = 1000;

/** Clamp a user-supplied limit query param to the safety cap. Accepts the
 *  raw query value (string|number|undefined), returns a positive integer
 *  at most MAX_PAGE_SIZE. Useful when a route accepts ?limit= but the
 *  underlying query should still respect the hard cap. */
export function clampLimit(raw: unknown, defaultLimit = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Math.min(defaultLimit, MAX_PAGE_SIZE);
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}
