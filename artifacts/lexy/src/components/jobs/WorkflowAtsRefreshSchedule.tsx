import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsImportsQueryKey,
  getGetCandidateAtsRefreshScheduleQueryKey,
  useControlCandidateAtsRefreshSchedule,
  useGetCandidateAtsRefreshSchedule,
  type AtsImportedRecord,
  type AtsScheduleState,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { errText } from "./workflow-shared";

const INTERVALS = [
  { v: 60, l: "Hourly" },
  { v: 360, l: "Every 6 hours" },
  { v: 1440, l: "Daily" },
] as const;

const statusOf = (e: unknown): number | null =>
  typeof e === "object" && e !== null && "status" in e
    ? Number((e as { status: unknown }).status)
    : null;
const fmt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "none");

export function WorkflowAtsRefreshSchedule({
  jobId,
  workflowId,
  bindingRevision,
  workflowRevision,
  records,
  recordsUnavailable,
}: {
  jobId: string;
  workflowId: string;
  bindingRevision: number;
  workflowRevision: number;
  records: AtsImportedRecord[];
  recordsUnavailable: boolean;
}) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsRefreshScheduleQueryKey(jobId, workflowId);
  const q = useGetCandidateAtsRefreshSchedule(jobId, workflowId, {
    query: {
      queryKey: key,
      refetchInterval: (query) => (query.state.error ? false : 15000),
      staleTime: 0,
      gcTime: 0,
      retry: false,
    },
  });
  const m = useControlCandidateAtsRefreshSchedule({ mutation: { retry: false, gcTime: 0 } });
  const resetRef = useRef(m.reset);
  resetRef.current = m.reset;
  const mounted = useRef(true);
  const lock = useRef(false);
  const inited = useRef(false);
  const reviewedRevision = useRef<number | null>(null);
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [interval, setIntervalMin] = useState<number>(1440);
  const [ack, setAck] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resetRef.current();
    };
  }, []);

  const forbidden = statusOf(q.error) === 403;
  const state: AtsScheduleState | undefined = q.isError ? undefined : q.data;
  const schedule = state?.schedule ?? null;

  const loadFrom = (s: AtsScheduleState | undefined) => {
    setIds(new Set(s?.schedule?.recordIds ?? []));
    setIntervalMin(s?.schedule?.intervalMinutes ?? 1440);
    setAck(false);
  };
  useEffect(() => {
    if (!inited.current && state) {
      inited.current = true;
      reviewedRevision.current = state.schedule?.revision ?? 0;
      loadFrom(state);
    } else if (state && reviewedRevision.current !== (state.schedule?.revision ?? 0)) {
      reviewedRevision.current = state.schedule?.revision ?? 0;
      setAck(false);
      setConflict(true);
    }
  }, [state]);

  const send = (action: "enable" | "pause") => {
    if (lock.current || !state) return;
    lock.current = true;
    setError(null);
    setMsg(null);
    const data =
      action === "pause"
        ? {
            action,
            expectedScheduleRevision: schedule?.revision ?? 0,
            expectedWorkflowRevision: workflowRevision,
            expectedBindingRevision: bindingRevision,
          }
        : {
            action,
            expectedScheduleRevision: schedule?.revision ?? 0,
            expectedWorkflowRevision: workflowRevision,
            expectedBindingRevision: bindingRevision,
            recordIds: Array.from(ids),
            intervalMinutes: interval as 60 | 360 | 1440,
            acknowledgeReadOnly: true as const,
          };
    m.mutate(
      { jobId, workflowId, data },
      {
        onSuccess: (res) => {
          lock.current = false;
          if (!mounted.current) return;
          reviewedRevision.current = res.schedule?.revision ?? 0;
          qc.setQueryData(key, res);
          qc.invalidateQueries({ queryKey: key });
          qc.invalidateQueries({ queryKey: getGetCandidateAtsImportsQueryKey(jobId, workflowId) });
          setAck(false);
          setMsg(
            action === "pause"
              ? "Schedule paused. A check already reading may still finish; no further checks will be saved."
              : "Schedule saved. The first check runs after the chosen interval, found by a worker scan about once a minute, so timing is approximate.",
          );
        },
        onError: (e) => {
          lock.current = false;
          if (!mounted.current) return;
          qc.invalidateQueries({ queryKey: key });
          setAck(false);
          if (statusOf(e) === 409) setConflict(true);
          else setError(errText(e));
        },
      },
    );
  };

  const toggle = (id: string) =>
    setIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < 10) n.add(id);
      return n;
    });

  const busy = m.isPending;
  const canEnable =
    !!state && ids.size >= 1 && ids.size <= 10 && ack && !busy && !conflict && !recordsUnavailable;

  return (
    <div
      className="space-y-1.5 border-t border-border pt-2"
      data-testid={`ats-schedule-${workflowId}`}
    >
      <p className="font-medium">Scheduled refresh</p>
      {q.isLoading && (
        <p role="status" className="text-muted-foreground">
          Loading schedule
        </p>
      )}
      {forbidden && (
        <p className="text-muted-foreground" data-testid={`ats-schedule-forbidden-${workflowId}`}>
          Scheduled refresh can only be viewed and managed by an employer admin.
        </p>
      )}
      {q.isError && !forbidden && (
        <div role="alert" className="text-destructive">
          Could not load the schedule.{" "}
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {state && (
        <>
          <p className="text-muted-foreground">
            Optional. An employer admin can choose up to 10 listed imported records to be checked
            automatically and read-only. Only those saved records are read; nothing is ingested
            account-wide, and no stages, messages or offers are changed. Each record check is saved
            independently, not atomically. Unavailable means not returned, not proof of deletion.
          </p>
          <p data-testid={`ats-schedule-status-${workflowId}`}>
            Status: {schedule ? schedule.status : "not scheduled"}
            {schedule && (
              <>
                {" "}
                · every {schedule.intervalMinutes} min · {schedule.recordIds.length} record(s) ·
                next due {fmt(schedule.nextRunAt)} · saved {fmt(schedule.updatedAt)}
              </>
            )}
          </p>
          {schedule?.blockedReason && (
            <p role="alert" className="text-destructive [overflow-wrap:anywhere]">
              Blocked: {schedule.blockedReason}
            </p>
          )}
          {conflict && (
            <div role="alert" className="space-y-1 text-destructive">
              <p>
                The saved schedule or its revisions changed since you opened this form. Your edits
                are kept and nothing was resubmitted.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setConflict(false)}>
                  Keep my edits and review latest
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    loadFrom(state);
                    setConflict(false);
                  }}
                >
                  Load latest saved settings
                </Button>
              </div>
            </div>
          )}
          <fieldset className="space-y-1" disabled={busy}>
            <legend className="text-muted-foreground">Records to check (1 to 10)</legend>
            {recordsUnavailable && (
              <p className="text-muted-foreground">Imported records are not available right now.</p>
            )}
            {!recordsUnavailable && records.length === 0 && (
              <p className="text-muted-foreground">Import records first to schedule checks.</p>
            )}
            <ul className="space-y-0.5">
              {records.map((r) => (
                <li key={r.id}>
                  <label className="flex items-start gap-2 [overflow-wrap:anywhere]">
                    <input
                      type="checkbox"
                      checked={ids.has(r.id)}
                      onChange={() => toggle(r.id)}
                      data-testid={`ats-schedule-select-${r.id}`}
                    />
                    <span>
                      Application {r.application.id} · Candidate {r.application.candidateId}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor={`ats-schedule-interval-${workflowId}`}>Interval</label>
              <select
                id={`ats-schedule-interval-${workflowId}`}
                className="rounded-md border border-border bg-background px-2 py-1"
                value={interval}
                onChange={(e) => setIntervalMin(Number(e.target.value))}
                data-testid={`ats-schedule-interval-${workflowId}`}
              >
                {INTERVALS.map((i) => (
                  <option key={i.v} value={i.v}>
                    {i.l}
                  </option>
                ))}
              </select>
              <span className="text-muted-foreground">{ids.size} selected</span>
            </div>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                data-testid={`ats-schedule-ack-${workflowId}`}
              />
              <span>
                I understand scheduled read-only Greenhouse requests will repeat automatically for
                these records, and will never send messages or change stages or offers.
              </span>
            </label>
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canEnable}
              onClick={() => send("enable")}
              data-testid={`ats-schedule-enable-${workflowId}`}
            >
              {schedule?.status === "enabled" ? "Save and reapprove" : "Enable schedule"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !schedule || schedule.status !== "enabled"}
              onClick={() => send("pause")}
              data-testid={`ats-schedule-pause-${workflowId}`}
            >
              Pause schedule
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => loadFrom(state)}>
              Load latest saved settings
            </Button>
          </div>
          {busy && (
            <p role="status" className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="text-destructive"
              data-testid={`ats-schedule-error-${workflowId}`}
            >
              Schedule update failed. {error}
            </p>
          )}
          {msg && <p role="status">{msg}</p>}
          <div className="space-y-0.5" data-testid={`ats-schedule-runs-${workflowId}`}>
            <p className="font-medium">Recent scheduled runs</p>
            {state.runs.length === 0 && (
              <p className="text-muted-foreground">No scheduled runs yet.</p>
            )}
            {state.runs.map((run) => (
              <div key={run.id} className="[overflow-wrap:anywhere]">
                <p>
                  {run.status} · started {fmt(run.startedAt)} · finished {fmt(run.finishedAt)}
                  {run.message ? ` · ${run.message}` : ""}
                </p>
                {(run.status === "interrupted" ||
                  run.items.some((i) => i.status === "unconfirmed")) && (
                  <p className="text-muted-foreground">
                    Outcome uncertain. Inspect each record history before approving again; nothing
                    is retried automatically, and a check may still have been saved.
                  </p>
                )}
                <ul className="space-y-0.5 pl-3">
                  {run.items.map((i) => (
                    <li key={i.recordId}>
                      Record {i.recordId} · {i.status.replace("_", " ")}
                      {i.checkedAt ? ` · ${fmt(i.checkedAt)}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
