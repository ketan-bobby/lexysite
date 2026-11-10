import type { QueryClient } from "@tanstack/react-query";
import {
  getGetCandidateOfferRoutingQueryKey,
  getGetCandidateWorkflowOfferQueryKey,
  getGetEmployerOfferInboxItemQueryKey,
  getGetEmployerOfferInboxQueryKey,
  getGetJobWorkflowStateQueryKey,
} from "@workspace/api-client-react";

/** A human decision changes eligibility and employer handoff, not just the row. */
export function refreshWorkflowDecisionViews(
  client: Pick<QueryClient, "invalidateQueries">,
  jobId: string,
  workflowId: string,
) {
  return Promise.all(
    [
      getGetJobWorkflowStateQueryKey(jobId),
      getGetCandidateWorkflowOfferQueryKey(jobId, workflowId),
      getGetCandidateOfferRoutingQueryKey(jobId, workflowId),
      getGetEmployerOfferInboxItemQueryKey(workflowId),
      getGetEmployerOfferInboxQueryKey(),
    ].map((queryKey) => client.invalidateQueries({ queryKey })),
  );
}
