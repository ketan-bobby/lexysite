/**
 * lib/compliance-scope.ts — Canonical candidate-compliance predicate
 * ============================================================================
 *
 * ONE place that defines the compliance-mandatory candidate filter used by
 * every count/aggregate surface. Modeled on the reference implementation in
 * routes/analytics.ts (the `/analytics/overview` `visibleCandidateIds` path),
 * but stripped down to ONLY the compliance conditions.
 *
 * ── What "compliance" means here ────────────────────────────────────────────
 * A candidate must be excluded from ALL metrics when either is true:
 *   • data_erased_at IS NOT NULL   → the person exercised GDPR erasure
 *   • do_not_contact IS TRUE       → the person opted out of contact
 * i.e. a candidate is COMPLIANT (may be counted) only when:
 *   data_erased_at IS NULL AND do_not_contact IS NOT TRUE
 *
 * ── Compliance vs. list-cosmetic (IMPORTANT) ────────────────────────────────
 * The overview reference bundles the compliance conditions together with two
 * LIST-COSMETIC conditions — `pool IS DISTINCT FROM 'pending_profile'` and the
 * platform-pool visibility rule. Those two are NOT compliance; they only shape
 * what a particular *list* shows. They MUST stay surface-specific and are
 * intentionally left OUT of this helper. Only the compliance conditions are
 * universal.
 *
 * ── The two measurement axes (DO NOT UNIFY) ─────────────────────────────────
 * Count surfaces measure candidates along two DIFFERENT axes that must never be
 * merged into a single "stage" concept:
 *
 *   1. Application-stage ordinals — funnel / overview / recruiter-performance
 *      count progress through the applications.stage ladder
 *      (sourced → applied → screening → … → hired → started). "Reached stage X
 *      or beyond" is an ORDINAL comparison over applications.stage.
 *
 *   2. candidate_outcomes enums — outcomes/coverage and intelligence count
 *      terminal outcome labels (hired / rejected / withdrawn / ghosted / …)
 *      stored on candidate_outcomes / candidate_job_intelligence. These are
 *      categorical ENUMS, NOT points on the stage ladder.
 *
 * These are different questions ("how far did they get in the pipeline?" vs
 * "how did it end?") with different domains, so they must be reported
 * independently. The COMPLIANCE predicate in this module applies to BOTH axes
 * (no erased/DNC candidate may appear in any count). The stage-ordinal
 * predicate applies ONLY to axis 1 and lives with those surfaces — it is not
 * part of this module.
 *
 * ── Why exclusion instead of positive `IN (compliant ids)` ──────────────────
 * `restrictToCompliantCandidates` removes ONLY rows whose linked candidate is
 * known erased/DNC. It is null-safe and orphan-safe: a row with a NULL
 * candidate id, or a candidate id not present in `candidates` at all (e.g. an
 * interview session for a sourced-only lead), is KEPT. A naive positive
 * `candidate_id IN (SELECT id FROM candidates WHERE compliant)` would silently
 * drop those unrelated rows too — a non-compliance behavior change. Because the
 * only rows this predicate removes are the compliance-barred ones, applying it
 * where there are currently zero erased/DNC candidates produces ZERO movement.
 */
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import { candidatesTable } from "@workspace/db";

/**
 * THE single canonical definition of a contact-barred (non-compliant)
 * candidate. Every other export in this module derives from this one function,
 * so the erased/DNC rule lives in exactly one place.
 */
function contactBarredCandidateSql(): SQL {
  return sql`${candidatesTable.dataErasedAt} IS NOT NULL OR ${candidatesTable.doNotContact} IS TRUE`;
}

/**
 * Positive compliance predicate for use directly in a WHERE over the
 * `candidates` table (equivalent to `data_erased_at IS NULL AND
 * do_not_contact IS NOT TRUE`). Provided for surfaces that query candidates
 * directly; the count surfaces use `restrictToCompliantCandidates` instead.
 */
export function compliantCandidatePredicate(): SQL {
  return sql`NOT (${contactBarredCandidateSql()})`;
}

/**
 * Restrict a foreign candidate-id column (e.g. applications.candidate_id,
 * candidate_outcomes.candidate_id, interview_sessions.candidate_id,
 * candidate_job_intelligence.candidate_id) to compliant candidates.
 *
 * Null-safe and orphan-safe: keeps rows with a NULL candidate id or a
 * candidate id absent from `candidates`; removes ONLY rows whose linked
 * candidate is erased or do-not-contact.
 */
export function restrictToCompliantCandidates(candidateIdCol: AnyColumn | SQL): SQL {
  return sql`(${candidateIdCol} IS NULL OR ${candidateIdCol} NOT IN (
    SELECT ${candidatesTable.id} FROM ${candidatesTable}
    WHERE ${contactBarredCandidateSql()}
  ))`;
}
