/** Development-only browser fixture: real editor, synthetic query snapshots. */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getGetCandidateWorkflowOfferQueryKey,
  type ControlledOfferState,
} from "@workspace/api-client-react";
import { WorkflowControlledOffer } from "../components/jobs/WorkflowControlledOffer";
import "../index.css";

export function mountOfferFixture(
  host: HTMLElement,
  initial: ControlledOfferState,
  jobId = "offer-ui-fixture-job",
  workflowId = "offer-ui-fixture-workflow",
) {
  if (!import.meta.env.DEV) throw new Error("Offer browser fixture is development-only");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const root = createRoot(host);
  const render = (state: ControlledOfferState, job: string, workflow: string) => {
    client.setQueryData(getGetCandidateWorkflowOfferQueryKey(job, workflow), state);
    root.render(
      <QueryClientProvider client={client}>
        <div className="mx-auto max-w-3xl p-4">
          <WorkflowControlledOffer jobId={job} wf={{ id: workflow }} />
        </div>
      </QueryClientProvider>,
    );
  };
  render(initial, jobId, workflowId);
  return {
    snapshot: (state: ControlledOfferState) =>
      client.setQueryData(getGetCandidateWorkflowOfferQueryKey(jobId, workflowId), state),
    switchContext: render,
    unmount: () => {
      root.unmount();
      client.clear();
    },
  };
}
