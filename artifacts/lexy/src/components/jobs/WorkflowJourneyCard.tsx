import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetJobWorkflowStateQueryKey,
  useApproveJobWorkflowJourney,
  type JobWorkflowState,
  type PlannedCandidateWorkflow,
  type PlannedWorkflowJourney,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { ErrorLine, StepList, errText, useIdempotency, pathLabel } from "./workflow-shared";

export function JourneyCard({
  journey,
  state,
  jobId,
}: {
  journey: PlannedWorkflowJourney;
  state: JobWorkflowState;
  jobId: string;
}) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const m = useApproveJobWorkflowJourney({});
  const [error, setError] = useState<string | null>(null);
  const reason = !state.canApprove
    ? "Your role cannot approve journeys."
    : journey.stale
      ? "Brief changed since this draft; create a new draft."
      : !state.jobApproved
        ? "The job must be approved or live first."
        : null;
  const approve = () => {
    setError(null);
    m.mutate(
      {
        jobId,
        journeyId: journey.id,
        data: {
          idempotencyKey: idem.get(`${journey.id}:${state.briefHash}`),
          expectedBriefHash: state.briefHash,
        },
      },
      {
        onSuccess: () => {
          idem.clear();
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
        onError: (e) => setError(errText(e)),
      },
    );
  };
  return (
    <div
      className="rounded-lg border border-border p-3 space-y-2"
      data-testid={`journey-${journey.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <b>Version {journey.version}</b>
        <Badge variant="outline">{journey.status}</Badge>
        {journey.stale && <Badge variant="destructive">stale</Badge>}
        <span className="text-muted-foreground">Path: {pathLabel(journey.interviewPath)}</span>
      </div>
      <StepList steps={journey.steps as PlannedCandidateWorkflow["steps"]} />
      {journey.status === "draft" && (
        <div className="space-y-1">
          <Button
            size="sm"
            onClick={approve}
            disabled={!!reason || m.isPending}
            data-testid={`button-approve-journey-${journey.id}`}
          >
            {m.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
            Approve plan
          </Button>
          {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
          <ErrorLine message={error} testId={`text-approve-error-${journey.id}`} />
        </div>
      )}
    </div>
  );
}
