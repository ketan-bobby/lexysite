/** A bound workflow has already passed its persisted human screening review. */
export function interviewScreeningBlockReason(
  screened: unknown,
  recommendation: unknown,
  reviewedWorkflow: boolean,
): string | null {
  if (screened !== true) return "not_yet_screened";
  if (recommendation === "advance" || (reviewedWorkflow && recommendation === "hold")) return null;
  return `screening_${recommendation ?? "unknown"}`;
}
