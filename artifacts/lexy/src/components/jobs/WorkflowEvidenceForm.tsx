import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetJobWorkflowStateQueryKey,
  useRecordCandidateWorkflowEvidence,
  type PlannedCandidateWorkflow,
  type WorkflowEvidenceInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { ErrorLine, errText, useIdempotency, FINAL_STEP } from "./workflow-shared";

export function EvidenceForm({
  wf,
  jobId,
  canApprove,
}: {
  wf: PlannedCandidateWorkflow;
  jobId: string;
  canApprove: boolean;
}) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const m = useRecordCandidateWorkflowEvidence({});
  const step = wf.steps.find((s) => s.status !== "completed");
  const [status, setStatus] = useState<WorkflowEvidenceInput["status"]>("review_required");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState("");
  if (!step) return null;
  const finalLocked = step.key === FINAL_STEP && !canApprove;
  const trimmed = note.trim();
  const sources = (wf.runtimeEvidence ?? []).filter(
    (entry) => entry.stepKey === step.key && entry.readyForReview,
  );
  const changedSource = !!sourceId && !sources.some((entry) => entry.id === sourceId);
  const invalid = !trimmed || trimmed.length > 4000 || finalLocked || changedSource;
  const submit = () => {
    setError(null);
    m.mutate(
      {
        jobId,
        workflowId: wf.id,
        data: {
          idempotencyKey: idem.get(
            `${wf.id}:${wf.revision}:${step.key}:${status}:${trimmed}:${sourceId}`,
          ),
          expectedRevision: wf.revision,
          stepKey: step.key,
          status,
          evidence: trimmed,
          ...(sourceId ? { runtimeEvidenceId: sourceId } : {}),
        },
      },
      {
        onSuccess: () => {
          idem.clear();
          setNote("");
          setSourceId("");
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
        onError: (e) => setError(errText(e)),
      },
    );
  };
  return (
    <div className="space-y-2 border-t border-border pt-2" data-testid={`evidence-form-${wf.id}`}>
      <p className="text-sm font-medium">Record manual evidence: {step.label}</p>
      {step.key === "verification" && (
        <p className="text-xs text-muted-foreground" data-testid={`verification-note-${wf.id}`}>
          AI advice and manual notes do not verify identity. Completion requires a saved verified
          identity or the separate identity-resolution review. Synthetic-test clearance never
          verifies the person.
        </p>
      )}
      <label className="block text-xs space-y-1">
        <span>Evidence source</span>
        <select
          className="w-full min-w-0 max-w-full h-8 rounded-md border border-border bg-background px-2 text-sm"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          data-testid={`select-runtime-evidence-${wf.id}`}
        >
          <option value="">Manual note only — not a verified assessment</option>
          {sources.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.sourceType} · {entry.summary}
            </option>
          ))}
        </select>
        <span
          className="block min-w-0 break-words text-muted-foreground sm:hidden"
          data-testid={`text-selected-source-${wf.id}`}
        >
          {sourceId
            ? (() => {
                const entry = sources.find((x) => x.id === sourceId);
                return entry ? `${entry.sourceType} · ${entry.summary}` : "Selected source";
              })()
            : "Manual note only — not a verified assessment"}
        </span>
      </label>
      {changedSource && (
        <p className="text-xs text-amber-600" role="alert">
          The selected source changed or is no longer eligible. Select current evidence before
          saving.
        </p>
      )}
      <select
        className="h-8 w-full min-w-0 max-w-full rounded-md border border-border bg-background px-2 text-sm sm:w-auto"
        value={status}
        onChange={(e) => setStatus(e.target.value as WorkflowEvidenceInput["status"])}
        aria-label="Evidence status"
        data-testid={`select-evidence-status-${wf.id}`}
      >
        <option value="completed">Completed</option>
        <option value="review_required">Review required</option>
        <option value="failed">Failed</option>
      </select>
      <textarea
        className="w-full rounded-md border border-border bg-background p-2 text-sm"
        rows={3}
        maxLength={4000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What a human reviewed or observed (required)"
        aria-label="Evidence notes"
        data-testid={`input-evidence-${wf.id}`}
      />
      {finalLocked && (
        <p className="text-xs text-muted-foreground">
          Only an approver role can record any evidence on the final hiring decision step.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Review required or failed is recorded as-is and never implies a rejection.
      </p>
      <Button
        size="sm"
        onClick={submit}
        disabled={invalid || m.isPending}
        data-testid={`button-record-evidence-${wf.id}`}
      >
        {m.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
        {sourceId ? "Save source review" : "Record evidence"}
      </Button>
      <ErrorLine message={error} testId={`text-evidence-error-${wf.id}`} />
    </div>
  );
}
