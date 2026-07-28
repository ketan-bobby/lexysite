/**
 * RunHistoryPanel — the audit list of past sourcing runs for a work order.
 *
 * Lives on the work-order detail page. Each row shows the run's status, when it
 * started (relative), how long it took, and how many candidates it shortlisted,
 * linking to its now-static run view for audit. Theme-aware, tokens only
 * (success = signal-green).
 */
import { Link } from "wouter";
import { useRunHistory, type RunHistoryItem, type AgentRunStatus } from "@/lib/agent-runs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DemoRunBadge } from "@/components/agents/DemoRunBadge";
import { cn } from "@/lib/utils";
import {
  History, CheckCircle2, XCircle, Ban, Loader2, ArrowRight, Users, Clock,
} from "lucide-react";

function statusConfig(status: AgentRunStatus) {
  switch (status) {
    case "completed":
      return { label: "Completed", cls: "bg-signal-green/10 text-signal-green border-signal-green/25", Icon: CheckCircle2, spin: false };
    case "failed":
      return { label: "Failed", cls: "bg-destructive/10 text-destructive border-destructive/25", Icon: XCircle, spin: false };
    case "cancelled":
      return { label: "Cancelled", cls: "bg-muted text-muted-foreground border-border", Icon: Ban, spin: false };
    default:
      return { label: "Running", cls: "bg-primary/10 text-primary border-primary/25", Icon: Loader2, spin: true };
  }
}

function fmtDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt) return null;
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtRelative(ts: string): string {
  try {
    const then = new Date(ts).getTime();
    const diff = Date.now() - then;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString();
  } catch {
    return "";
  }
}

function RunHistoryRow({ run }: { run: RunHistoryItem }) {
  const cfg = statusConfig(run.status);
  const { Icon } = cfg;
  const duration = fmtDuration(run.startedAt, run.completedAt);
  const shortlisted = typeof run.summary?.shortlisted === "number" ? run.summary.shortlisted : null;

  return (
    <Link href={`/runs/${run.id}`}>
      <div className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:border-primary/40 hover:bg-hover/40 transition-colors cursor-pointer">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold shrink-0", cfg.cls)}>
          <Icon className={cn("w-3.5 h-3.5", cfg.spin && "animate-spin")} />
          {cfg.label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">Sourcing run</span>
            {run.isSimulated && <DemoRunBadge />}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
            <span>{fmtRelative(run.startedAt ?? run.createdAt)}</span>
            {duration && (
              <span className="inline-flex items-center gap-1">
                <Clock className="w-3 h-3" /> {duration}
              </span>
            )}
            <span
              className={cn(
                "inline-flex items-center gap-1",
                run.status === "completed" && (shortlisted ?? 0) > 0 && "text-signal-green font-medium",
              )}
            >
              <Users className="w-3 h-3" /> {shortlisted ?? 0} shortlisted
            </span>
            {run.status === "failed" && run.error && (
              <span className="truncate text-destructive/80 max-w-[220px]">{run.error}</span>
            )}
          </div>
        </div>
        <ArrowRight className="w-4 h-4 text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all shrink-0" />
      </div>
    </Link>
  );
}

export function RunHistoryPanel({ workOrderId }: { workOrderId: string }) {
  const { data: runs, isLoading } = useRunHistory(workOrderId);

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="w-4 h-4 text-primary" /> Sourcing run history
        </CardTitle>
        <CardDescription>
          Past sourcing runs for this work order. Open any run for a full audit of what it did.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading run history…
          </div>
        ) : !runs || runs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <History className="w-8 h-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No sourcing runs yet.</p>
            <p className="text-xs text-muted-foreground/70 mt-0.5">
              Run the sourcing agent on this work order to build a history.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {runs.map((run) => (
              <RunHistoryRow key={run.id} run={run} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
