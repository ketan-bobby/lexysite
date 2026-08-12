/**
 * lib/agent-runs.ts — client for the Agent Run event model
 *
 * A source-agnostic subscription to a sourcing run's event stream. The UI never
 * needs to know whether the events came from the real pipeline or from a
 * simulated demo run — it just polls `/agent-runs/:id/events?after=<seq>` every
 * 2s (the stack has no WebSocket) and appends what it hasn't seen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useToast } from "@workspace/react-hooks/use-toast";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  return res.json();
}

export type RunEventType =
  | "step_started"
  | "step_progress"
  | "step_completed"
  | "run_completed"
  | "run_failed";

export interface RunEvent {
  id: string;
  seq: number;
  type: RunEventType;
  stepName: string | null;
  message: string;
  count: number | null;
  payload: any;
  timestamp: string;
}

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

export interface StartRunResult {
  runId: string;
  /** True when a run was already in progress and we resolved its id instead of starting a new one. */
  alreadyRunning: boolean;
}

/**
 * Start a sourcing run for a work order. By default this is a REAL run (the
 * server sources from live providers and scores against the ICP); pass
 * `simulated: true` for an explicit demo run with persona data ("Demo run"
 * badge). Handles the backend's duplicate-run guard (409 `run_in_progress`) by
 * returning the existing run's id with `alreadyRunning: true` rather than
 * throwing — so callers can just open it. Other errors (e.g. `not_approved`,
 * `INTERNAL_REVIEW_REQUIRED`) throw with the server message.
 */
export async function startSourcingRun(
  workOrderId: string,
  opts?: { shortlistSize?: number; simulated?: boolean },
): Promise<StartRunResult> {
  const res = await fetch(`${BASE}/api/agent-runs/simulate`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      workOrderId,
      ...(opts?.shortlistSize ? { shortlistSize: opts.shortlistSize } : {}),
      ...(opts?.simulated ? { simulated: true } : {}),
    }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}) as any);
    if (body?.code === "run_in_progress" && body?.runId) {
      return { runId: body.runId, alreadyRunning: true };
    }
    const err = new Error(body?.error || "Could not start sourcing run");
    (err as any).code = body?.code;
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text || res.statusText}`);
  }
  const data = (await res.json()) as { runId: string };
  return { runId: data.runId, alreadyRunning: false };
}

/** Start an EXPLICITLY simulated (demo) sourcing run; returns the run id to poll. */
export async function startSimulatedRun(
  workOrderId: string,
  shortlistSize?: number,
): Promise<string> {
  const { runId } = await startSourcingRun(workOrderId, { shortlistSize, simulated: true });
  return runId;
}

/** Cancel an in-flight run. Idempotent server-side; returns the resulting status. */
export async function cancelRun(runId: string): Promise<AgentRunStatus> {
  const data = await api<{ status: AgentRunStatus }>(`/agent-runs/${runId}/cancel`, {
    method: "POST",
  });
  return data.status;
}

/** Run metadata enriched by the server (job title, client name, etc.). */
export interface RunDetail {
  id: string;
  workOrderId: string | null;
  status: AgentRunStatus;
  isSimulated: boolean;
  agentType: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  error: string | null;
  summary: Record<string, any> | null;
  jobTitle: string | null;
  clientName: string | null;
  workOrderNumber: string | null;
}

/**
 * One-shot fetch of a run's metadata (title, client, timestamps) for the run
 * view header. The live event stream is owned by `useAgentRun`; this only
 * supplies the surrounding chrome. Cached briefly since the header is stable.
 */
export function useRunDetail(runId: string | null) {
  return useQuery<RunDetail>({
    queryKey: ["agent-run-detail", runId],
    enabled: !!runId,
    staleTime: 30_000,
    queryFn: async () => {
      const { run } = await api<{ run: RunDetail }>(`/agent-runs/${runId}`);
      return run;
    },
  });
}

/**
 * Shared "Source Candidates" trigger used by work-order cards, the detail page,
 * and the dashboard quick-action pill. Starts (or resolves an in-progress) run,
 * refreshes the dashboard header's live-agent count, toasts the outcome, and —
 * unless `navigateToRun` is false — opens the run view at `/sourcing?run=<id>`.
 */
export function useSourcingTrigger() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const trigger = useCallback(
    async (workOrderId: string, opts?: { navigateToRun?: boolean }): Promise<string | null> => {
      setPendingId(workOrderId);
      try {
        const { runId, alreadyRunning } = await startSourcingRun(workOrderId);
        // Header status ("System Active — N agents running") reads the dashboard
        // summary's agentsOnline; refresh it so the state flips immediately.
        queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] });
        if (alreadyRunning) {
          toast({
            title: "A sourcing run is already in progress",
            description: "Opening the run that's already underway.",
          });
        } else {
          toast({
            title: "Sourcing run started",
            description: "Watch the candidates come in live.",
          });
        }
        if (opts?.navigateToRun !== false) navigate(`/runs/${runId}`);
        return runId;
      } catch (err: any) {
        /* Legacy safety net — the server no longer blocks on internal review
         * (advisory since 2026-08-12), so surface it as a tip, not an error. */
        if (err?.code === "INTERNAL_REVIEW_REQUIRED") {
          toast({
            title: "Tip: check your internal talent too",
            description:
              "The internal search on the Sourcing page is free and may already have a fit.",
          });
          return null;
        }
        toast({
          title: "Couldn't start sourcing run",
          description: err?.message || "Please try again.",
          variant: "destructive",
        });
        return null;
      } finally {
        setPendingId(null);
      }
    },
    [toast, navigate, queryClient],
  );

  return { trigger, pendingId, isPending: pendingId !== null };
}

/**
 * Refresh every surface that a completed run changes, so results land without a
 * manual refresh: the dashboard funnel/KPIs/recommended-actions, the candidate
 * pipeline, the work-order list + detail counts, the decision queue, and the
 * run-history list. Called from any onDone that observes a run reach a terminal
 * status (the run view and the dashboard takeover).
 */
export function invalidateRunAffectedQueries(qc: QueryClient) {
  const keys: readonly (readonly unknown[])[] = [
    ["agent-run-detail"],
    ["agent-runs"], // run-history lists
    ["dashboard-summary"],
    ["dashboard-activity"],
    ["dashboard-actions"], // Recommended Actions panel
    ["analytics-funnel"], // dashboard pipeline funnel
    ["intelligence"], // decision queue + dashboard intelligence
    ["pipeline-stages"], // work-order pipeline board
    ["/api/analytics/overview"], // KPI stat cards (codegen key)
    ["/api/candidates"], // candidate lists (codegen key)
  ];
  for (const key of keys) qc.invalidateQueries({ queryKey: key as unknown[] });
  // Jobs family: list (`/api/jobs`), detail (`/api/jobs/:id`), icp, etc. all use
  // URL-string keys — a plain prefix won't match the detail keys, so match any
  // query whose first key segment starts with "/api/jobs".
  qc.invalidateQueries({
    predicate: (q) =>
      typeof q.queryKey?.[0] === "string" && (q.queryKey[0] as string).startsWith("/api/jobs"),
  });
}

/** One run's summary row for the work-order run-history list. */
export interface RunHistoryItem {
  id: string;
  status: AgentRunStatus;
  agentType: string;
  isSimulated: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  summary: Record<string, any> | null;
  error: string | null;
}

/**
 * Past sourcing runs for a work order (newest first), for the run-history list
 * on the work-order detail page. Each row links to its now-static run view for
 * audit. Invalidated by `invalidateRunAffectedQueries` when a run completes.
 */
export function useRunHistory(workOrderId: string | null) {
  return useQuery<RunHistoryItem[]>({
    queryKey: ["agent-runs", workOrderId],
    enabled: !!workOrderId,
    queryFn: async () => {
      const { runs } = await api<{ runs: RunHistoryItem[] }>(
        `/agent-runs?workOrderId=${encodeURIComponent(workOrderId!)}`,
      );
      return runs;
    },
  });
}

export interface UseAgentRunResult {
  events: RunEvent[];
  status: AgentRunStatus;
  summary: Record<string, any>;
  isRunning: boolean;
}

/**
 * Subscribe to a run by polling. Accumulates events across polls, tracking the
 * last seen `seq`, and stops once the run reaches a terminal status. Resets
 * cleanly whenever `runId` changes (or clears to null).
 */
export function useAgentRun(runId: string | null, onDone?: () => void): UseAgentRunResult {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<AgentRunStatus>("running");
  const [summary, setSummary] = useState<Record<string, any>>({});
  const lastSeq = useRef(0);
  const doneRef = useRef(false);

  useEffect(() => {
    setEvents([]);
    setStatus("running");
    setSummary({});
    lastSeq.current = 0;
    doneRef.current = false;
    if (!runId) return;

    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const data = await api<{
          status: AgentRunStatus;
          summary: Record<string, any>;
          events: RunEvent[];
        }>(`/agent-runs/${runId}/events?after=${lastSeq.current}`);
        if (!active) return;
        if (data.events.length > 0) {
          lastSeq.current = data.events[data.events.length - 1].seq;
          setEvents((prev) => [...prev, ...data.events]);
        }
        setStatus(data.status);
        setSummary(data.summary || {});
        if (TERMINAL_STATUSES.has(data.status)) {
          if (!doneRef.current) {
            doneRef.current = true;
            onDone?.();
          }
          return; // stop polling
        }
      } catch {
        /* transient — keep polling */
      }
      if (active) timer = setTimeout(poll, 2000);
    };

    poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
    // onDone intentionally excluded — it's a stable page callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return { events, status, summary, isRunning: !TERMINAL_STATUSES.has(status) };
}
