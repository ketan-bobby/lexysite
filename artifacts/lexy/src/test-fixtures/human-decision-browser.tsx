/** Development-only: real decision controls; no auth or persistence bypass. */
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ControlledOfferState, PlannedCandidateWorkflow } from "@workspace/api-client-react";
import { WorkflowHumanDecision } from "../components/jobs/WorkflowHumanDecision";
import "../index.css";

export type HumanDecisionFixtureState = {
  wf: PlannedCandidateWorkflow;
  canApprove: boolean;
  jobApproved: boolean;
  offerState: ControlledOfferState;
};
export function mountHumanDecisionFixture(
  host: HTMLElement,
  initial: HumanDecisionFixtureState,
  jobId = "offer-ui-fixture-job",
) {
  if (!import.meta.env.DEV) throw new Error("Decision browser fixture is development-only");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  const render = (next: HumanDecisionFixtureState, job = jobId) => {
    root.render(
      <QueryClientProvider client={client}>
        <div className="mx-auto max-w-3xl p-4">
          <WorkflowHumanDecision
            wf={next.wf}
            jobId={job}
            canApprove={next.canApprove}
            jobApproved={next.jobApproved}
          />
        </div>
      </QueryClientProvider>,
    );
  };
  render(initial);
  return {
    snapshot: render,
    switchContext: render,
    unmount: () => {
      root.unmount();
      client.clear();
    },
  };
}
