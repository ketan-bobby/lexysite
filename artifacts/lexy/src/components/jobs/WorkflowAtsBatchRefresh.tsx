import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsImportHistoryQueryKey,
  getGetCandidateAtsImportsQueryKey,
  getGetCandidateAtsVerificationQueryKey,
  refreshCandidateAtsImport,
  type AtsImportedRecord,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  MAX_ATS_REFRESH_BATCH,
  runAtsRefreshBatch,
  type AtsRefreshBatchItem,
} from "@/lib/ats-refresh-batch";
import { WorkflowAtsImportRefresh } from "./WorkflowAtsImportRefresh";
import { WorkflowAtsStage } from "./WorkflowAtsStage";
import { WorkflowAtsCampaign } from "./WorkflowAtsCampaign";

export function WorkflowAtsBatchRefresh({
  jobId,
  workflowId,
  bindingRevision,
  workflowRevision,
  records,
  truncated,
}: {
  jobId: string;
  workflowId: string;
  bindingRevision: number;
  workflowRevision: number;
  records: AtsImportedRecord[];
  truncated: boolean;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<AtsRefreshBatchItem[] | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const lifecycleRef = useRef({ active: false });
  const stopRef = useRef(false);
  const lock = useRef(false);
  const scopeKey = `${jobId}|${workflowId}|${bindingRevision}|${workflowRevision}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;

  useEffect(() => {
    const lifecycle = { active: true };
    lifecycleRef.current = lifecycle;
    stopRef.current = false;
    lock.current = false;
    setSelected(new Set());
    setProgress(null);
    setRunning(false);
    setStopping(false);
    setPending(new Set());
    return () => {
      lifecycle.active = false;
    };
  }, [scopeKey]);

  const onPendingChange = useCallback((recordId: string, p: boolean) => {
    setPending((s) => {
      if (s.has(recordId) === p) return s;
      const n = new Set(s);
      if (p) n.add(recordId);
      else n.delete(recordId);
      return n;
    });
  }, []);

  const visibleSelected = records.filter((r) => selected.has(r.id));
  const singlePending = pending.size > 0;
  const canStart =
    visibleSelected.length >= 1 &&
    visibleSelected.length <= MAX_ATS_REFRESH_BATCH &&
    !running &&
    !singlePending;

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < MAX_ATS_REFRESH_BATCH) n.add(id);
      return n;
    });

  const start = () => {
    if (!canStart || lock.current) return;
    lock.current = true;
    const lifecycle = lifecycleRef.current;
    const startingScope = scopeKey;
    const snapshot = visibleSelected.map((r) => ({ ...r }));
    const b = bindingRevision;
    const w = workflowRevision;
    const jid = jobId;
    const wid = workflowId;
    stopRef.current = false;
    setSelected(new Set());
    setStopping(false);
    setRunning(true);
    const live = () => lifecycle.active && scopeRef.current === startingScope;
    runAtsRefreshBatch({
      records: snapshot,
      expectedBindingRevision: b,
      expectedWorkflowRevision: w,
      shouldStop: () => stopRef.current || !live(),
      onProgress: (items) => {
        if (live()) setProgress(items);
      },
      refresh: async (recordId, input) => {
        try {
          const res = await refreshCandidateAtsImport(jid, wid, recordId, input);
          if (!live()) return res;
          const key = getGetCandidateAtsImportHistoryQueryKey(jid, wid, recordId);
          qc.setQueryData(key, res);
          qc.invalidateQueries({ queryKey: getGetCandidateAtsImportsQueryKey(jid, wid) });
          qc.invalidateQueries({ queryKey: key });
          return res;
        } catch (e) {
          if (!live()) throw e;
          qc.removeQueries({
            queryKey: getGetCandidateAtsImportHistoryQueryKey(jid, wid, recordId),
          });
          qc.invalidateQueries({ queryKey: getGetCandidateAtsVerificationQueryKey(jid, wid) });
          qc.invalidateQueries({ queryKey: getGetCandidateAtsImportsQueryKey(jid, wid) });
          throw e;
        }
      },
    })
      .catch(() => {
        if (live()) setProgress(null);
      })
      .finally(() => {
        if (live()) {
          lock.current = false;
          stopRef.current = false;
          setRunning(false);
          setStopping(false);
        }
      });
  };

  const checked = records.filter((r) => r.lastCheckedAt);
  const avail = checked.filter((r) => r.availability === "available").length;
  const unavail = checked.filter((r) => r.availability === "unavailable").length;
  const never = records.length - checked.length;
  const latest = checked.reduce<number>(
    (m, r) => Math.max(m, Date.parse(r.lastCheckedAt as string) || 0),
    0,
  );
  const scope = truncated
    ? "listed records only (most recent 100, not all imports)"
    : "listed records";
  const saved =
    progress?.filter((p) => p.state === "available" || p.state === "unavailable").length ?? 0;
  const failed = progress?.filter((p) => p.state === "failed").length ?? 0;
  const notStarted = progress?.filter((p) => p.state === "not_started").length ?? 0;

  return (
    <div className="space-y-1.5">
      <div className="space-y-0.5" data-testid={`ats-sync-summary-${workflowId}`}>
        <p className="font-medium">Saved synchronization status</p>
        <p className="text-muted-foreground">
          {scope}: {avail} checked available · {unavail} checked unavailable · {never} never checked
          · latest saved check {latest ? new Date(latest).toLocaleString() : "none"}. Based on saved
          per-record checks, not live or account-wide sync.
        </p>
      </div>
      <div className="space-y-1" data-testid={`ats-batch-${workflowId}`}>
        <p className="text-muted-foreground">
          Select up to {MAX_ATS_REFRESH_BATCH} records for one manual, sequential, read-only
          refresh. This is an operational limit per click. It is not atomic, not resumable after
          leaving this page, and each record is saved as it completes.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canStart}
            onClick={start}
            data-testid={`ats-batch-start-${workflowId}`}
          >
            Refresh {visibleSelected.length || ""} selected from Greenhouse
          </Button>
          {running && (
            <Button
              size="sm"
              variant="outline"
              disabled={stopping}
              onClick={() => {
                stopRef.current = true;
                setStopping(true);
              }}
              data-testid={`ats-batch-stop-${workflowId}`}
            >
              Stop after current
            </Button>
          )}
          <span className="text-muted-foreground" data-testid={`ats-batch-count-${workflowId}`}>
            {visibleSelected.length} selected (max {MAX_ATS_REFRESH_BATCH})
          </span>
        </div>
        {singlePending && !running && (
          <p role="status" className="text-muted-foreground">
            A single-record refresh is running; batch start is disabled until it finishes.
          </p>
        )}
        {running && (
          <p role="status" className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />{" "}
            {stopping ? "Stopping after the current check" : "Refreshing selected records"}
          </p>
        )}
        {progress && (
          <div aria-live="polite" className="space-y-1">
            <p role="status" data-testid={`ats-batch-result-${workflowId}`}>
              {running
                ? "Batch in progress"
                : failed || notStarted
                  ? "Batch stopped"
                  : "Batch complete"}
              : {saved}/{progress.length} checks saved · {failed} failed or unconfirmed ·{" "}
              {notStarted} not started. Progress below lasts only while this page stays open; saved
              checks remain in each record’s history.
            </p>
            <ul className="space-y-0.5" data-testid={`ats-batch-progress-${workflowId}`}>
              {progress.map((p) => (
                <li
                  key={p.recordId}
                  className={`[overflow-wrap:anywhere] ${p.state === "failed" ? "text-destructive" : ""}`}
                  data-testid={`ats-batch-item-${p.recordId}`}
                >
                  Application {p.applicationId} · {p.state.replace("_", " ")}
                  {p.checkedAt ? ` · ${new Date(p.checkedAt).toLocaleString()}` : ""}
                  {p.message ? ` · ${p.message}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ul className="space-y-0.5">
        {records.map((r) => (
          <li key={r.id} className="[overflow-wrap:anywhere]" data-testid={`ats-imported-${r.id}`}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={selected.has(r.id)}
                disabled={running || singlePending}
                onChange={() => toggle(r.id)}
                data-testid={`ats-batch-select-${r.id}`}
              />
              <span>
                Application {r.application.id} · Candidate {r.application.candidateId} · Job{" "}
                {r.job.name} ({r.job.status}) · imported {new Date(r.importedAt).toLocaleString()} ·
                original preview observed {new Date(r.observedAt).toLocaleString()}
              </span>
            </label>
            <WorkflowAtsStage record={r} />
            <WorkflowAtsImportRefresh
              jobId={jobId}
              workflowId={workflowId}
              bindingRevision={bindingRevision}
              workflowRevision={workflowRevision}
              record={r}
              disabled={running || (singlePending && !pending.has(r.id))}
              onPendingChange={onPendingChange}
            />
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="text-muted-foreground">
          Showing the 100 most recent records; older imports are not listed.
        </p>
      )}
      <WorkflowAtsCampaign
        jobId={jobId}
        workflowId={workflowId}
        records={records}
        truncated={truncated}
      />
    </div>
  );
}
