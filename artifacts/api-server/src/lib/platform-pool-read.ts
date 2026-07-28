/**
 * platform-pool-read.ts — named-exemption machinery for reads of the shared
 * job-seeker pool (candidates.pool = "platform").
 *
 * WHY THIS EXISTS
 * ---------------
 * A platform-pool candidate is a real person who self-registered on Lexy to
 * look for a job. They can set privacy controls (pause discovery, hide from
 * their current employer, block specific companies, match-only visibility) and
 * compliance states (GDPR-erased, do-not-contact). The incident that motivated
 * this module was an employer-facing read path that returned platform rows
 * WITHOUT applying those controls — a privacy leak.
 *
 * THE CANONICAL SEAL (single source of truth)
 * -------------------------------------------
 * Every EMPLOYER-FACING read of platform rows must pass the returned rows
 * through the two exported helpers in routes/candidates.ts:
 *     applyCandidateHardExclusions(rows)          // erased / DNC / pending_profile
 *     applyCandidatePrivacyFilter(rows, tenantId) // paused / hide / block / match-only
 * No read path may re-implement these filters inline. `check-platform-pool-read.mjs`
 * enforces this: any `eq(candidatesTable.pool, "platform")` DB read whose
 * enclosing function does not call one of those helpers fails the build, unless
 * it declares a NAMED exemption below (or is a reviewed ALLOWLIST entry).
 *
 * NAMED EXEMPTIONS — for reads that are legitimately NOT employer-facing
 * ---------------------------------------------------------------------
 * Some reads of the platform pool are a DIFFERENT risk class than "show these
 * people to an employer", so the employer-visibility seal does not apply to
 * them. Each such read must call `platformReadExemption(PLATFORM_READ_EXEMPTION.X)`
 * in the same function, naming WHICH justification applies. This makes every
 * exemption a documented, greppable decision — never a silent bypass.
 */

export const PLATFORM_READ_EXEMPTION = Object.freeze({
  /**
   * A scheduler / engine that reads platform rows to CONTACT THE CANDIDATE
   * THEMSELVES (their own weekly digest, a re-engagement nudge, etc.).
   *
   * Risk class: this is the candidate receiving their own mail, NOT an employer
   * being shown the candidate. The employer-visibility controls (discoveryPaused,
   * hideFromCurrentEmployer, blockedCompanyDomains, matchOnlyVisibility) are
   * therefore N/A — a job-seeker who is "invisible to employers" still gets
   * their own account email.
   *
   * OBLIGATION that DOES still apply: the messaging path MUST suppress
   * do-not-contact (doNotContact) and GDPR-erased (dataErasedAt) rows itself,
   * because those are about contacting the person at all, not about employer
   * visibility. Verified per call-site; also tracked for the Step-2 sweep.
   */
  SELF_DIRECTED_CANDIDATE_MESSAGING: "self_directed_candidate_messaging",

  /**
   * An analytics query that COUNTS platform rows into an aggregate metric and
   * never returns per-candidate PII to an employer.
   *
   * Risk class: an aggregate number ("N candidates in scope") does not expose
   * any individual, so the per-employer visibility seal is not applied here.
   * Compliance exclusions (dataErasedAt / doNotContact / pending_profile) ARE
   * already applied in the same query, and platform rows are only included when
   * the tenant has candidateDatabaseAccess.
   *
   * OPEN QUESTION for Step 2: whether per-employer visibility controls (paused/
   * hide/block/match-only) should also shrink these counts is a policy decision,
   * flagged for the enumeration pass — this exemption covers the aggregate-only
   * shape, not that policy question.
   */
  AGGREGATE_ANALYTICS_COUNT: "aggregate_analytics_count",
} as const);

export type PlatformReadExemption =
  (typeof PLATFORM_READ_EXEMPTION)[keyof typeof PLATFORM_READ_EXEMPTION];

const KNOWN = new Set<string>(Object.values(PLATFORM_READ_EXEMPTION));

/**
 * Declares — at runtime and to the CI guard — that the platform-pool read in
 * this function is deliberately NOT employer-facing and is exempt from the
 * privacy seal for the named reason. Throws if handed an unknown reason so an
 * anonymous / typo'd exemption can never compile-and-run silently.
 *
 * Returns the reason so it can be used inline without a dangling statement.
 */
export function platformReadExemption(reason: PlatformReadExemption): PlatformReadExemption {
  if (!KNOWN.has(reason)) {
    throw new Error(
      `[platformReadExemption] unknown exemption "${reason}" — use a named constant from PLATFORM_READ_EXEMPTION`,
    );
  }
  return reason;
}
