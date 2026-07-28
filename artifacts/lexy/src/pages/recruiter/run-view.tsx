/**
 * run-view.tsx — the live sourcing run view (`/runs/:id`), the centerpiece of
 * the agent-run experience.
 *
 * Header: agent icon, "Sourcing candidates for <job title>", client name, a
 * ticking elapsed time, a status badge, and a Cancel button while running.
 * Body: the live step stream (RunStepStream). Footer: a terminal state —
 *   completed → "Shortlist ready — N candidates" + Review shortlist / View work order
 *   failed    → plain-language reason + Retry
 *   cancelled → neutral note + Run again
 *
 * Theme-aware, tokens only (success = signal-green). The event stream comes from
 * `useAgentRun` (2s polling); the surrounding chrome from `useRunDetail`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAgentRun, useRunDetail, cancelRun, startSourcingRun,
  invalidateRunAffectedQueries,
} from "@/lib/agent-runs";
import { RunStepStream } from "@/components/agents/RunStepStream";
import { DemoRunBadge } from "@/components/agents/DemoRunBadge";
import { Button } from "@/components/ui/button";
import { useToast } from "@workspace/react-hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Bot, Loader2, CheckCircle2, XCircle, Ban, ArrowLeft,
  Users, Briefcase, RotateCcw,
} from "lucide-react";

/** Format elapsed milliseconds as m:ss (or h:mm:ss past an hour). */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function StatusBadge({ status }: { status: string }) {
  const cfg =
    status === "completed"
      ? { label: "Completed", cls: "bg-signal-green/10 text-signal-green border-signal-green/25", Icon: CheckCircle2, spin: false }
      : status === "failed"
        ? { label: "Failed", cls: "bg-destructive/10 text-destructive border-destructive/25", Icon: XCircle, spin: false }
        : status === "cancelled"
          ? { label: "Cancelled", cls: "bg-muted text-muted-foreground border-border", Icon: Ban, spin: false }
          : { label: "Running", cls: "bg-primary/10 text-primary border-primary/25", Icon: Loader2, spin: true };
  const { Icon } = cfg;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", cfg.cls)}>
      <Icon className={cn("w-3.5 h-3.5", cfg.spin && "animate-spin")} />
      {cfg.label}
    </span>
  );
}

export default function RunView() {
  const [, params] = useRoute("/runs/:id");
  const runId = params?.id ?? null;
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: detail } = useRunDetail(runId);
  const onDone = useMemo(
    () => () => {
      // A run just reached a terminal status — refresh every surface its results
      // land on (funnel, KPIs, recommended actions, pipeline, work-order counts,
      // decision queue, run history) so they update without a manual refresh.
      invalidateRunAffectedQueries(queryClient);
    },
    [queryClient],
  );
  const { events, status, summary, isRunning } = useAgentRun(runId, onDone);

  // Prefer the live polled status (fresh) but fall back to the one-shot detail.
  const effectiveStatus = isRunning ? "running" : status;
  const isSimulated = detail?.isSimulated ?? false;
  const jobTitle = detail?.jobTitle ?? null;
  const clientName = detail?.clientName ?? null;
  const workOrderId = detail?.workOrderId ?? null;

  // ── Ticking elapsed time ──────────────────────────────────────────────────
  const startMs = detail?.startedAt ? new Date(detail.startedAt).getTime() : null;
  const [now, setNow] = useState(() => Date.now());
  const frozenElapsed = useRef<number | null>(null);
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);
  useEffect(() => {
    // Freeze the elapsed clock at completion using completedAt when available.
    if (!isRunning && startMs != null && detail?.completedAt) {
      frozenElapsed.current = new Date(detail.completedAt).getTime() - startMs;
    }
  }, [isRunning, startMs, detail?.completedAt]);
  const elapsedMs = startMs == null
    ? 0
    : isRunning
      ? now - startMs
      : frozenElapsed.current ?? (now - startMs);

  // ── Cancel ────────────────────────────────────────────────────────────────
  const [cancelling, setCancelling] = useState(false);
  const handleCancel = async () => {
    if (!runId) return;
    setCancelling(true);
    try {
      await cancelRun(runId);
      toast({ title: "Sourcing run cancelled" });
      onDone();
    } catch (err: any) {
      toast({ title: "Couldn't cancel the run", description: err?.message, variant: "destructive" });
    } finally {
      setCancelling(false);
    }
  };

  // ── Retry / run again ──────────────────────────────────────────────────────
  const [retrying, setRetrying] = useState(false);
  const handleRetry = async () => {
    if (!workOrderId) return;
    setRetrying(true);
    try {
      const { runId: newId } = await startSourcingRun(workOrderId);
      queryClient.invalidateQueries({ queryKey: ["dashboard-summary"] });
      navigate(`/runs/${newId}`);
    } catch (err: any) {
      toast({ title: "Couldn't start a new run", description: err?.message, variant: "destructive" });
    } finally {
      setRetrying(false);
    }
  };

  const shortlistCount =
    (typeof summary.shortlisted === "number" ? summary.shortlisted : null) ??
    (events.find((e) => e.type === "run_completed")?.count ?? null);
  const failMessage = events.find((e) => e.type === "run_failed")?.message
    ?? detail?.error
    ?? "The sourcing run couldn't be completed.";

  if (!runId) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link
        href="/dashboard"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-4"
      >
        <ArrowLeft className="w-3.5 h-3.5" /> Back to dashboard
      </Link>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-card p-5 shadow-sm dark:shadow-none mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Bot className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-lg font-bold text-foreground truncate">
                  {jobTitle ? `Sourcing candidates for ${jobTitle}` : "Sourcing candidates"}
                </h1>
                {isSimulated && <DemoRunBadge />}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {clientName ? <span>{clientName}</span> : <span>Sourcing agent</span>}
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                <span className="tabular-nums">{fmtElapsed(elapsedMs)} elapsed</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={effectiveStatus} />
            {isRunning && (
              <Button variant="outline" size="sm" onClick={handleCancel} disabled={cancelling}>
                {cancelling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Cancel"}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Step stream ────────────────────────────────────────────────────── */}
      {events.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Starting the sourcing run…
        </div>
      ) : (
        <RunStepStream events={events} />
      )}

      {/* ── Terminal states ────────────────────────────────────────────────── */}
      {effectiveStatus === "completed" && (
        <div className="mt-5 rounded-2xl border border-signal-green/30 bg-signal-green/5 p-5">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 className="w-5 h-5 text-signal-green" />
            <h2 className="text-base font-bold text-foreground">
              Shortlist ready{shortlistCount != null ? ` — ${shortlistCount} candidate${shortlistCount === 1 ? "" : "s"}` : ""}
            </h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate(`/decision-queue?run=${runId}`)} className="gap-1.5">
              <Users className="w-4 h-4" /> Review shortlist
            </Button>
            {workOrderId && (
              <Button variant="outline" onClick={() => navigate(`/jobs/${workOrderId}`)} className="gap-1.5">
                <Briefcase className="w-4 h-4" /> View work order
              </Button>
            )}
          </div>
        </div>
      )}

      {effectiveStatus === "failed" && (
        <div className="mt-5 rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
          <div className="flex items-center gap-2 mb-2">
            <XCircle className="w-5 h-5 text-destructive" />
            <h2 className="text-base font-bold text-foreground">Sourcing run failed</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-3">{failMessage}</p>
          {workOrderId && (
            <Button onClick={handleRetry} disabled={retrying} className="gap-1.5">
              {retrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Retry
            </Button>
          )}
        </div>
      )}

      {effectiveStatus === "cancelled" && (
        <div className="mt-5 rounded-2xl border border-border bg-muted/30 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Ban className="w-5 h-5 text-muted-foreground" />
            <h2 className="text-base font-bold text-foreground">Run cancelled</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-3">
            You cancelled this sourcing run. Any candidates found before cancelling were not added.
          </p>
          {workOrderId && (
            <Button variant="outline" onClick={handleRetry} disabled={retrying} className="gap-1.5">
              {retrying ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />} Run again
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
