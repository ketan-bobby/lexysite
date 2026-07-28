/**
 * trust-gate.ts — Canonical "verification gate" for candidate score surfaces.
 *
 * The decision engine will NOT auto-advance a candidate whose Trust score is
 * below the advance threshold (it routes them to manual verification instead).
 * UI rule that mirrors this: on any card for a gated candidate, the PRIMARY
 * visual must be the gate status ("Needs Verification"), with the hire
 * probability percentage rendered smaller/secondary. The percentage may only
 * be the loudest element once the candidate has cleared the gate.
 *
 * Mirrors the backend advance requirement (trustScore >= 65 in
 * api-server decideNextAction). Keep in sync if the policy changes.
 */

/** Minimum Trust score required for the engine to auto-advance. */
export const TRUST_ADVANCE_THRESHOLD = 65;

/**
 * True when the candidate is verification-gated and the card must lead with
 * the gate status instead of the score. An UNKNOWN trust score (null) is
 * gated — no verification signal is exactly the case the gate exists for.
 */
export function isTrustGated(trustScore: number | null | undefined): boolean {
  return trustScore == null || trustScore < TRUST_ADVANCE_THRESHOLD;
}

/** Short badge label for gated cards. */
export const TRUST_GATE_LABEL = "Needs Verification";

/** Longer explanatory label where space allows. */
export const TRUST_GATE_LABEL_LONG = "Cannot Advance — Verify Trust";
