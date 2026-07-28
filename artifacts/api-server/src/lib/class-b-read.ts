/**
 * class-b-read.ts — named-exemption machinery for reads of CLASS-B tables
 * (candidate-data tables with NO database-level tenant isolation; see
 * scripts/check-classb-read.mjs and docs/SECURITY_REVIEW_2026-07.md §5).
 *
 * WHY THIS EXISTS
 * ---------------
 * A Class-B table has no RLS in dev OR prod — application code is the SOLE thing
 * keeping one tenant's rows out of another tenant's response. `check-classb-read`
 * flags every read whose own query span carries no tenant predicate. Many of
 * those reads ARE safe, but for a reason the static scanner cannot observe (an
 * upstream gate, a token, a self-owned FK, a deliberately cross-tenant model).
 *
 * Each such read declares its justification with `classBRead(CLASS_B_READ_EXEMPTION.X)`
 * in the same function. This turns "the scanner can't see the tenant filter" into
 * a documented, greppable, individually-reasoned decision — NEVER a silent bypass
 * and NEVER a bulk "these are all fine". Throws on an unknown reason so a typo'd
 * or anonymous exemption cannot compile-and-run.
 *
 * IMPORTANT: an exemption is a CLAIM about WHY a read is safe, not a scope. It
 * does not filter anything. If the claimed mechanism is wrong, the read is a
 * leak — so only attach one after verifying the named justification holds.
 */

export const CLASS_B_READ_EXEMPTION = Object.freeze({
  /**
   * A read that is INTENTIONALLY cross-tenant: it pools sufficient statistics /
   * outcomes across tenants to train or evaluate a model (global prior, learned
   * per-tenant weights via a federated baseline, similar-hire embeddings,
   * promotion backtests). It must NEVER return per-candidate PII to an employer —
   * it reduces rows to aggregates / vectors / scores. Tenant-scoping it would
   * defeat its purpose. Obligation: the OUTPUT surface stays aggregate, and any
   * per-tenant serving path re-scopes downstream.
   */
  CROSS_TENANT_MODEL_TRAINING: "cross_tenant_model_training",

  /**
   * A read that is INTENTIONALLY cross-tenant and AGGREGATE-ONLY for market
   * statistics (Market Intelligence comp signal): it pools anonymized values
   * (e.g. desiredSalaryRange) across the whole platform, reduces them to
   * medians/percentiles, and enforces a k-anonymity minimum sample (k≥5)
   * before returning ANYTHING — below the threshold it returns an explicit
   * "insufficient data" shape. Tenant-scoping it would defeat its purpose
   * (same doctrine as the learned-scoring global prior). Obligation: the
   * OUTPUT surface is aggregates only — no candidate ids, names, or
   * individual values may ever leave the function.
   */
  CROSS_TENANT_AGGREGATE_ONLY: "cross_tenant_aggregate_only",

  /**
   * A CANDIDATE reading their OWN data through the portal, scoped by
   * candidates.userId (the authenticated self), not by a tenant column. The
   * employer tenant seal is N/A — the subject is reading about themselves.
   * Obligation: the read is keyed by the caller's own candidate/user id, never a
   * caller-supplied id for someone else.
   */
  CANDIDATE_SELF_OWNED: "candidate_self_owned",

  /**
   * A single-row read authorized by an opaque, expiring SHARE TOKEN rather than a
   * tenant membership (the hiring-manager no-login package). Authorization is the
   * token + its expiry/decision checks in the same handler, verified before the
   * read is trusted. A tenant column would be meaningless here (the HM has no
   * tenant). Obligation: the token is validated (exists, unexpired) first.
   */
  TOKEN_PRE_AUTHORIZED: "token_pre_authorized",

  /**
   * A staff analytics read whose enclosing handler has ALREADY applied an
   * explicit caller-role gate AND an explicit tenant predicate on the DRIVING
   * table of the query, and this Class-B table is JOINED in for attributes only —
   * the join inherits the driving table's tenant scope. Used where the tenant
   * filter provably lives on a sibling table in the same query, not on the
   * Class-B symbol itself. Verify the driving-table predicate before attaching.
   */
  TENANT_SCOPED_VIA_JOIN: "tenant_scoped_via_join",

  /**
   * The rows are tenant-filtered in application code AFTER the await
   * (`rows.filter(r => allowed.includes(r.tenantId))`), so the DB span carries no
   * predicate but the response is scoped before it leaves the handler. Weaker
   * than a DB predicate (the full set is materialised in memory first) — prefer
   * pushing the filter into the query — but it IS a real scope. Verify the
   * post-filter is unconditional and precedes every response path.
   */
  POST_QUERY_TENANT_FILTER: "post_query_tenant_filter",
} as const);

export type ClassBReadExemption =
  (typeof CLASS_B_READ_EXEMPTION)[keyof typeof CLASS_B_READ_EXEMPTION];

const KNOWN = new Set<string>(Object.values(CLASS_B_READ_EXEMPTION));

/**
 * Declares — at runtime and to `check-classb-read.mjs` — that the Class-B read in
 * this function is deliberately safe without a tenant predicate in its query
 * span, for the named reason. Throws on an unknown reason. Returns the reason so
 * it reads naturally as a statement beside the query.
 */
export function classBRead(reason: ClassBReadExemption): ClassBReadExemption {
  if (!KNOWN.has(reason)) {
    throw new Error(
      `[classBRead] unknown exemption "${reason}" — use a named constant from CLASS_B_READ_EXEMPTION`,
    );
  }
  return reason;
}
