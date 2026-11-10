import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetJobWorkflowStateQueryKey,
  useRecoverCandidateWorkflowAction,
  type PlannedCandidateWorkflow,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorLine, errText, useIdempotency } from "./workflow-shared";

export function WorkflowRecovery({
  wf,
  jobId,
  canApprove,
  jobApproved,
}: {
  wf: PlannedCandidateWorkflow;
  jobId: string;
  canApprove: boolean;
  jobApproved: boolean;
}) {
  const qc = useQueryClient();
  const mutation = useRecoverCandidateWorkflowAction({});
  const idem = useIdempotency();
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recovery = wf.recovery;
  if (!recovery?.attemptId && !recovery?.authorized) return null;
  return (
    <section
      className="space-y-2 rounded-md border border-border p-3"
      aria-label="Workflow recovery"
    >
      <p className="text-sm font-medium">Previous action needs review</p>
      {recovery.authorized ? (
        <p className="text-xs text-muted-foreground" role="status">
          One recovery attempt is authorized. No action has started. Approve live execution
          separately when you are ready; the original attempt and its history are kept.
        </p>
      ) : !recovery.available ? (
        <p className="text-xs text-muted-foreground" role="status">
          {recovery.blockedReason}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            The server recorded that this attempt stopped before external work: {recovery.reason}.
            Recovery keeps the original attempt and opens one new attempt. It does not activate
            spending, send email, or complete a workflow step. Live execution needs separate
            approval.
          </p>
          {canApprove && (
            <>
              <label className="flex items-start gap-2 text-xs">
                <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} />I reviewed
                this pre-effect failure and approve one recovery attempt.
              </label>
              <Button
                size="sm"
                variant="outline"
                data-testid={`button-recover-workflow-${wf.id}`}
                disabled={
                  !ack || mutation.isPending || wf.status !== "ready" || wf.stale || !jobApproved
                }
                onClick={() => {
                  setError(null);
                  mutation.mutate(
                    {
                      jobId,
                      workflowId: wf.id,
                      data: {
                        expectedRevision: wf.revision,
                        attemptId: recovery.attemptId!,
                        acknowledge: ack,
                        idempotencyKey: idem.get(`${wf.id}:${wf.revision}:${recovery.attemptId}`),
                      },
                    },
                    {
                      onSuccess: () => {
                        setAck(false);
                        idem.clear();
                        qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
                      },
                      onError: (e) => {
                        setError(errText(e));
                        qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
                      },
                    },
                  );
                }}
              >
                {mutation.isPending ? "Authorizing recovery…" : "Authorize one recovery"}
              </Button>
            </>
          )}
        </>
      )}
      <ErrorLine message={error} testId={`text-recovery-error-${wf.id}`} />
    </section>
  );
}
