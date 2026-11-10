import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetJobWorkflowState,
  getGetJobWorkflowStateQueryKey,
  useDraftJobWorkflowJourney,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { ErrorLine, errText, useIdempotency } from "./workflow-shared";
import { JourneyCard } from "./WorkflowJourneyCard";
import { EnrollForm } from "./WorkflowEnrollForm";
import { WorkflowRow } from "./WorkflowRow";
import { WorkflowShadow } from "./WorkflowShadow";
import { SourcingControls } from "./SourcingControls";

export function WorkflowPlanningCard({
  jobId,
  briefRevision,
}: {
  jobId: string;
  briefRevision?: string;
}) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const query = useGetJobWorkflowState(jobId, {
    query: {
      queryKey: [...getGetJobWorkflowStateQueryKey(jobId), briefRevision],
      enabled: !!jobId,
      staleTime: 0,
      refetchInterval: 15_000,
    },
  });
  const draft = useDraftJobWorkflowJourney({});
  const [draftError, setDraftError] = useState<string | null>(null);
  const state = query.data;

  const createDraft = () => {
    if (!state) return;
    setDraftError(null);
    draft.mutate(
      {
        jobId,
        data: { idempotencyKey: idem.get(state.briefHash), expectedBriefHash: state.briefHash },
      },
      {
        onSuccess: () => {
          idem.clear();
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
        onError: (e) => setDraftError(errText(e)),
      },
    );
  };

  return (
    <div
      className="min-w-0 w-full max-w-full break-words rounded-xl border border-border bg-card p-3 sm:p-5 space-y-4"
      data-testid="workflow-planning"
    >
      <h3 className="text-sm font-semibold">Planned workflow</h3>
      <p className="text-xs text-muted-foreground" data-testid="text-workflow-phase-note">
        Plan the journey and review evidence from saved screening, identity checks, outreach replies
        and job interviews. Observations are not approvals. Request next action uses the guarded
        execution path. Admins can separately approve one-hour screening, identity-advice, outreach
        or interview-invitation pilots for a separate test work order and controlled candidate.
        Other workflow dispatch remains locked; each contact step needs separate approval and the
        controlled staff inbox. Planning and review do not change application stages. Human review
        and final hiring decisions remain separate. Existing assisted actions remain available.
      </p>
      {query.isLoading && (
        <div className="space-y-2" data-testid="workflow-loading">
          <div className="h-4 w-1/2 skeleton-shimmer rounded" />
          <div className="h-16 skeleton-shimmer rounded" />
        </div>
      )}
      {query.isError && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive" data-testid="text-workflow-error">
            Could not load the planned workflow: {errText(query.error)}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => query.refetch()}
            data-testid="button-workflow-retry"
          >
            Retry
          </Button>
        </div>
      )}
      {state && (
        <>
          <WorkflowShadow
            jobId={jobId}
            stateVersion={JSON.stringify({
              briefHash: state.briefHash,
              jobApproved: state.jobApproved,
              canApprove: state.canApprove,
              journeys: state.journeys.map((j) => [j.id, j.status, j.stale]),
              workflows: state.workflows.map((w) => [w.id, w.revision, w.stale]),
            })}
          />
          <SourcingControls key={jobId} jobId={jobId} state={state} />
          <p className="text-xs text-muted-foreground">
            Autonomous execution:{" "}
            {state.autonomyExecutionEnabled ? "reported enabled by server" : "not enabled"}
            {!state.canEdit && " · Read-only view for your role."}
          </p>
          <section className="space-y-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-semibold">Journeys</h4>
              {state.canEdit && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-auto min-h-8 max-w-full whitespace-normal text-left"
                  onClick={createDraft}
                  disabled={draft.isPending}
                  data-testid="button-draft-journey"
                >
                  {draft.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
                  Create draft from current brief
                </Button>
              )}
            </div>
            <ErrorLine message={draftError} testId="text-draft-error" />
            {state.journeys.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-journeys">
                No journey has been drafted for this job yet.
              </p>
            ) : (
              state.journeys.map((j) => (
                <JourneyCard key={j.id} journey={j} state={state} jobId={jobId} />
              ))
            )}
            <p className="text-xs text-muted-foreground">
              After material brief changes, create a new draft. Existing candidate plans stay bound
              to their original version and are never rerouted automatically.
            </p>
          </section>
          {state.canEdit && <EnrollForm state={state} jobId={jobId} />}
          <section className="space-y-2">
            <h4 className="text-sm font-semibold">Candidate workflows</h4>
            {state.workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="text-no-workflows">
                No candidates have been planned yet.
              </p>
            ) : (
              state.workflows.map((w) => (
                <WorkflowRow key={w.id} wf={w} state={state} jobId={jobId} />
              ))
            )}
          </section>
          <section className="space-y-1">
            <h4 className="text-sm font-semibold">History</h4>
            {state.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No history yet.</p>
            ) : (
              <ul className="space-y-1 text-xs" data-testid="list-workflow-events">
                {state.events.map((e) => (
                  <li key={e.id} className="min-w-0 break-words">
                    <span className="text-muted-foreground">
                      {new Date(e.createdAt).toLocaleString()}
                    </span>{" "}
                    <b>{e.action.replace(/_/g, " ")}</b> by {e.actorId}
                    {e.note ? ` - ${e.note}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
