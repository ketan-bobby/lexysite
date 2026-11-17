import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getGetGreenhouseOfferWorkspaceQueryKey,
  type GreenhouseOfferWorkspace,
} from "@workspace/api-client-react";
import { GreenhouseOfferWorkspace as Workspace } from "../components/jobs/GreenhouseOfferWorkspace";
import "../index.css";

/** Isolated browser fixture only; not imported by the app or exposed as an app route. */
export function mountGreenhouseOfferFixture(element: HTMLElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const key = getGetGreenhouseOfferWorkspaceQueryKey("synthetic-job", "synthetic-workflow");
  const root = createRoot(element);
  root.render(
    <QueryClientProvider client={queryClient}>
      <Workspace jobId="synthetic-job" workflowId="synthetic-workflow" enabled />
    </QueryClientProvider>,
  );
  return {
    update(state: GreenhouseOfferWorkspace) {
      queryClient.setQueryData(key, state);
    },
    refresh() {
      return queryClient.refetchQueries({ queryKey: key });
    },
    close() {
      root.unmount();
      queryClient.clear();
    },
  };
}
