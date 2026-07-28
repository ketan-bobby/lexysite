/**
 * lib/pipeline-stages.ts — canonical pipeline stage-axis constants.
 *
 * The single source of truth for the "terminal-negative" application stages: an
 * application in one of these has LEFT the live pipeline through a negative or
 * withdrawn exit (as opposed to advancing toward, or reaching, a hire). Anything
 * measuring live pipeline presence — funnel bars, recruiter in-pipeline counts,
 * overview candidatesInPipeline — must exclude these.
 *
 * This is the STAGE axis only. It is deliberately NOT the same thing as the
 * outcome axis (candidate_outcomes / intelligence), which classifies terminal
 * results independently; do not conflate the two.
 */
export const TERMINAL_NEGATIVE_STAGES = ["rejected", "withdrawn", "offer_declined"] as const;

/** Set form for O(1) membership checks (`.has(stage)`). */
export const TERMINAL_NEGATIVE_STAGE_SET: ReadonlySet<string> = new Set(TERMINAL_NEGATIVE_STAGES);
