import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsImportHistoryQueryKey,
  getGetCandidateAtsImportsQueryKey,
  getGetCandidateAtsVerificationQueryKey,
  useGetCandidateAtsImportHistory,
  useRefreshCandidateAtsImport,
  type AtsImportedRecord,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { errText } from "./workflow-shared";
import { WorkflowAtsProfileImport } from "./WorkflowAtsProfileImport";
import { WorkflowAtsApplicantInterview } from "./WorkflowAtsApplicantInterview";

export function WorkflowAtsImportRefresh({
  jobId,
  workflowId,
  bindingRevision,
  workflowRevision,
  record,
  disabled = false,
  onPendingChange,
}: {
  disabled?: boolean;
  onPendingChange?: (recordId: string, pending: boolean) => void;
  jobId: string;
  workflowId: string;
  bindingRevision: number;
  workflowRevision: number;
  record: AtsImportedRecord;
}) {
  const qc = useQueryClient();
  const m = useRefreshCandidateAtsImport({ mutation: { retry: false, gcTime: 0 } });
  const resetRef = useRef(m.reset);
  resetRef.current = m.reset;
  const mounted = useRef(true);
  const submitting = useRef(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const histKey = getGetCandidateAtsImportHistoryQueryKey(jobId, workflowId, record.id);
  const hist = useGetCandidateAtsImportHistory(jobId, workflowId, record.id, {
    query: {
      queryKey: histKey,
      enabled: open && !error,
      refetchOnMount: "always",
      staleTime: 0,
      gcTime: 0,
    },
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resetRef.current();
    };
  }, []);

  const pendingCbRef = useRef(onPendingChange);
  pendingCbRef.current = onPendingChange;
  const isPending = m.isPending;
  const rid = record.id;
  useEffect(() => {
    pendingCbRef.current?.(rid, isPending);
    return () => pendingCbRef.current?.(rid, false);
  }, [rid, isPending]);

  const refresh = () => {
    if (submitting.current || disabled) return;
    submitting.current = true;
    setError(null);
    setMsg(null);
    m.mutate(
      {
        jobId,
        workflowId,
        recordId: record.id,
        data: {
          expectedBindingRevision: bindingRevision,
          expectedWorkflowRevision: workflowRevision,
          expectedRecordRevision: record.refreshRevision,
          idempotencyKey: crypto.randomUUID(),
        },
      },
      {
        onSuccess: (res) => {
          submitting.current = false;
          if (!mounted.current) return;
          qc.setQueryData(histKey, res);
          qc.invalidateQueries({ queryKey: getGetCandidateAtsImportsQueryKey(jobId, workflowId) });
          qc.invalidateQueries({ queryKey: histKey });
          setMsg(
            `Checked on ${new Date(res.record.lastCheckedAt ?? res.record.observedAt).toLocaleString()}. Read-only check of this record; not automatic or live sync.`,
          );
        },
        onError: (e) => {
          submitting.current = false;
          qc.removeQueries({ queryKey: histKey });
          qc.invalidateQueries({
            queryKey: getGetCandidateAtsVerificationQueryKey(jobId, workflowId),
          });
          qc.invalidateQueries({ queryKey: getGetCandidateAtsImportsQueryKey(jobId, workflowId) });
          if (!mounted.current) return;
          setError(errText(e));
        },
      },
    );
  };

  const busy = m.isPending;
  const id = record.id;
  const data = error || hist.isError ? undefined : hist.data;

  return (
    <div className="mt-0.5 space-y-1" data-testid={`ats-refresh-${id}`}>
      <p className="text-muted-foreground">
        Original import {new Date(record.importedAt).toLocaleString()} · Last checked{" "}
        {record.lastCheckedAt ? new Date(record.lastCheckedAt).toLocaleString() : "never"} ·{" "}
        {record.availability}
      </p>
      {record.availability === "unavailable" && (
        <p role="status" className="text-destructive" data-testid={`ats-unavailable-${id}`}>
          Not returned by Greenhouse at the last check. This is not proof it was deleted. Details
          shown are the last-known metadata.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || disabled}
          onClick={refresh}
          data-testid={`ats-refresh-btn-${id}`}
        >
          {error ? "Retry refresh" : "Refresh from Greenhouse"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen((o) => !o)}
          data-testid={`ats-history-toggle-${id}`}
        >
          {open ? "Hide history" : "Show history"}
        </Button>
      </div>
      {busy && (
        <p role="status" className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Refreshing
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive" data-testid={`ats-refresh-error-${id}`}>
          Refresh failed. {error}
        </p>
      )}
      {msg && (
        <p role="status" data-testid={`ats-refresh-success-${id}`}>
          {msg}
        </p>
      )}
      <WorkflowAtsProfileImport
        jobId={jobId}
        workflowId={workflowId}
        recordId={record.id}
        bindingRevision={bindingRevision}
        importRevision={record.refreshRevision}
        workflowRevision={workflowRevision}
      />
      <WorkflowAtsApplicantInterview
        jobId={jobId}
        workflowId={workflowId}
        recordId={record.id}
        bindingRevision={bindingRevision}
        importRevision={record.refreshRevision}
        workflowRevision={workflowRevision}
      />
      {open && (
        <div data-testid={`ats-history-${id}`}>
          {hist.isLoading && (
            <p role="status" className="text-muted-foreground">
              Loading history
            </p>
          )}
          {hist.isError && !error && (
            <div role="alert" className="text-destructive">
              Could not load history.{" "}
              <Button size="sm" variant="outline" onClick={() => hist.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {data && (
            <>
              <ul className="space-y-0.5">
                {data.history.map((h) => (
                  <li key={h.revision} className="[overflow-wrap:anywhere]">
                    {h.revision === 0 ? "Revision 0 (import baseline)" : `Revision ${h.revision}`} ·{" "}
                    {new Date(h.checkedAt).toLocaleString()} ·{" "}
                    {h.availability === "unavailable"
                      ? "not returned at this check (not proof deleted)"
                      : h.availability}{" "}
                    · Job {h.job.name} ({h.job.status})
                    {h.application
                      ? ` · ${h.application.status} · ${h.application.stageName ?? "no stage"}`
                      : ""}
                  </li>
                ))}
              </ul>
              {data.truncated && (
                <p className="text-muted-foreground">
                  Showing the baseline and the 20 most recent refresh checks.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
