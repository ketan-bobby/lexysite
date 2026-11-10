import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetJobWorkflowStateQueryKey,
  useEnrollCandidateWorkflow,
  type JobWorkflowState,
  type WorkflowEnrollmentInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  ErrorLine,
  errText,
  useIdempotency,
  pathLabel,
  CONCRETE_PATHS,
  type ConcretePath,
} from "./workflow-shared";

export function EnrollForm({ state, jobId }: { state: JobWorkflowState; jobId: string }) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const m = useEnrollCandidateWorkflow({});
  const usable = state.journeys.filter((j) => j.status === "approved" && !j.stale);
  const [journeyId, setJourneyId] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [path, setPath] = useState<ConcretePath | "">("");
  const [error, setError] = useState<string | null>(null);
  const journey = usable.find((j) => j.id === journeyId);
  const selected = state.candidates.find((c) => c.id === candidateId);
  const openIds = new Set(
    state.workflows
      .filter((w) => w.status === "ready" || w.status === "paused")
      .map((w) => w.candidateId),
  );
  const candidates = state.candidates.filter((c) => !openIds.has(c.id));
  const needsPath = journey?.interviewPath === "recruiter_choice";
  const ready = !!journey && !!candidateId && (!needsPath || !!path) && state.jobApproved;
  const submit = () => {
    if (!journey) return;
    setError(null);
    const data: WorkflowEnrollmentInput = {
      idempotencyKey: idem.get(
        `${journeyId}:${candidateId}:${needsPath ? path : ""}:${state.briefHash}`,
      ),
      expectedBriefHash: state.briefHash,
      journeyId,
      candidateId,
      ...(needsPath && path ? { interviewPath: path } : {}),
    };
    m.mutate(
      { jobId, data },
      {
        onSuccess: () => {
          idem.clear();
          setCandidateId("");
          setPath("");
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
        onError: (e) => setError(errText(e)),
      },
    );
  };
  const sel =
    "h-8 w-full min-w-0 max-w-full rounded-md border border-border bg-background px-2 text-sm sm:w-auto";
  return (
    <div className="min-w-0 space-y-2" data-testid="enroll-form">
      <h4 className="text-sm font-semibold">Plan a candidate</h4>
      {usable.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Approve a current journey before planning a candidate.
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No eligible linked candidates without an open planned workflow.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <select
            className={sel}
            value={journeyId}
            onChange={(e) => setJourneyId(e.target.value)}
            aria-label="Approved journey"
            data-testid="select-enroll-journey"
          >
            <option value="">Approved journey</option>
            {usable.map((j) => (
              <option key={j.id} value={j.id}>
                v{j.version} · {pathLabel(j.interviewPath)}
              </option>
            ))}
          </select>
          <select
            className={sel}
            value={candidateId}
            onChange={(e) => setCandidateId(e.target.value)}
            aria-label="Candidate"
            data-testid="select-enroll-candidate"
          >
            <option value="">Candidate</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {needsPath && (
            <select
              className={sel}
              value={path}
              onChange={(e) => setPath(e.target.value as ConcretePath | "")}
              aria-label="Interview path"
              data-testid="select-enroll-path"
            >
              <option value="">Choose interview path</option>
              {CONCRETE_PATHS.map((p) => (
                <option key={p} value={p}>
                  {pathLabel(p)}
                </option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            className="h-auto min-h-8 w-full whitespace-normal sm:w-auto"
            onClick={submit}
            disabled={!ready || m.isPending}
            data-testid="button-enroll"
          >
            {m.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
            Create planned workflow
          </Button>
        </div>
      )}
      {!state.jobApproved && (
        <p className="text-xs text-muted-foreground">
          The job must be approved or live to plan candidates.
        </p>
      )}
      {selected?.screeningReadiness && !selected.screeningReadiness.ready && (
        <p className="text-xs text-muted-foreground" data-testid="text-enroll-screening-input">
          You can plan this workflow now. Before screening: {selected.screeningReadiness.reason}
        </p>
      )}
      <ErrorLine message={error} testId="text-enroll-error" />
    </div>
  );
}
