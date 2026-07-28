/**
 * lib/sourced-stage.ts — The SINGLE source of truth for a sourced candidate's
 * pipeline stage (ticket 4d precedence gate).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * A sourced candidate has no `stage` column; its kanban position was historically
 * DERIVED at read time from screening signals (`screened` + `screeningResult`).
 * Ticket 4d adds a STORED `raw_data.stage` written by the audit choke-point so
 * agent moves become attributable. The instant a stored value can exist alongside
 * a derivable one, we risk two sources of truth for one candidate's stage — the
 * divergence disease. This function makes the precedence rule explicit, testable,
 * and the ONE place any surface may compute a sourced stage.
 *
 * ─── Precedence rule (authoritative) ─────────────────────────────────────────
 *   1. STORED WINS: a persisted `raw.stage` (other than the initial "sourced")
 *      is authoritative — it reflects a recorded, attributed move.
 *   2. DERIVE (fallback): for candidates with no stored stage yet (the
 *      pre-migration backlog and freshly-sourced rows), fall back to the screening
 *      signal — reject → "rejected", advance/hold → "screening".
 *   3. DEFAULT: "sourced".
 *
 * Because the choke-point only ever writes the SAME value derivation would yield
 * for the same signals (screening reject→"rejected", advance/hold→"screening"),
 * stored and derived can never disagree for one candidate: whichever applies, the
 * board position is identical. A stored value of "sourced" is treated as "unset"
 * so it can never mask a real derived stage.
 */

/** Minimal shape this reads from a sourced_candidates.raw_data blob. */
export interface SourcedStageSignals {
  stage?: unknown;
  screened?: unknown;
  screeningResult?: { recommendation?: unknown } | null;
}

export function deriveSourcedStage(raw: SourcedStageSignals | null | undefined): string {
  const stored = typeof raw?.stage === "string" ? raw.stage : null;
  // 1. Stored (recorded, attributed) move wins — except the initial "sourced".
  if (stored && stored !== "sourced") return stored;

  // 2. Fallback: derive from the screening signal.
  const screened = raw?.screened === true;
  const screeningResult = raw?.screeningResult;
  if (screened && screeningResult) {
    return screeningResult.recommendation === "reject" ? "rejected" : "screening";
  }

  // 3. Default.
  return "sourced";
}
