import { matchStageMappings } from "./zoho-stage-metadata-policy";

/**
 * A read-only disposition, never authorization. In particular, a default-catalog
 * match cannot establish application-specific transition eligibility.
 */
export function stageEligibility(
  matches: ReturnType<typeof matchStageMappings>,
  currentStatus: string,
) {
  return matches.map((match) => {
    const disposition = (() => {
      switch (match.result) {
        case "unset":
          return {
            nextAction: "mapping_required" as const,
            explanation:
              "Save a proposed canonical Zoho status for this decision, then check again.",
          };
        case "missing":
        case "ambiguous":
          return {
            nextAction: "mapping_review_required" as const,
            explanation:
              "Review this mapping with the employer. It does not identify one canonical status in the default catalogue.",
          };
        case "restricted":
          return {
            nextAction: "separate_human_process" as const,
            explanation:
              "This status belongs to a separate human-controlled process. This stage handoff cannot issue offers or establish employment.",
          };
        case "matched":
          // Exact canonical comparison only, after unambiguous, unrestricted matching.
          return match.targetStatus === currentStatus
            ? {
                nextAction: "no_update_needed" as const,
                explanation:
                  "The application already has this exact status at the time of this read. No update is needed; this is not a Lexy delivery receipt or transition approval.",
              }
            : {
                nextAction: "transition_verification_required" as const,
                explanation:
                  "The default catalogue contains this status, but permitted next transitions for this application have not been verified. Do not send an update from this result.",
              };
      }
    })();
    return { ...match, ...disposition, canWrite: false as const };
  });
}
