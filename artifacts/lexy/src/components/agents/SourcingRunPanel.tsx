/**
 * SourcingRunPanel — live view of a sourcing agent run.
 *
 * Subscribes to a run via `useAgentRun` (2s polling) and renders its progress as
 * an ordered list of stages (Analyzing → Searching → Screening → Ranking →
 * Shortlist) plus a terminal summary. Fully theme-aware (light + dark) using
 * design tokens.
 *
 * The panel is source-agnostic: real and simulated runs render identically. When
 * `isSimulated` is set it shows a "Demo run" badge.
 */
import { useAgentRun, type RunEvent } from "@/lib/agent-runs";
import { DemoRunBadge } from "./DemoRunBadge";
import { cn } from "@/lib/utils";
import {
  FileSearch, Search, Filter, BarChart3, Star,
  CheckCircle2, Loader2, XCircle, Circle,
} from "lucide-react";

const STAGES: { key: string; label: string; icon: any }[] = [
  { key: "analyzing", label: "Analyzing requirements", icon: FileSearch },
  { key: "searching", label: "Searching candidate pools", icon: Search },
  { key: "screening", label: "Screening against requirements", icon: Filter },
  { key: "ranking", label: "Ranking candidates", icon: BarChart3 },
  { key: "shortlist", label: "Building shortlist", icon: Star },
];

type StageState = "pending" | "active" | "done";

function stageStateFor(key: string, events: RunEvent[]): { state: StageState; latest?: RunEvent } {
  const forStage = events.filter((e) => e.stepName === key);
  if (forStage.length === 0) return { state: "pending" };
  const latest = forStage[forStage.length - 1];
  const done = forStage.some((e) => e.type === "step_completed" || e.type === "run_completed");
  return { state: done ? "done" : "active", latest };
}

export function SourcingRunPanel({
  runId,
  isSimulated,
  onDone,
}: {
  runId: string | null;
  isSimulated?: boolean;
  onDone?: () => void;
}) {
  const { events, status, summary, isRunning } = useAgentRun(runId, onDone);
  if (!runId) return null;

  const failed = status === "failed";
  const failEvent = events.find((e) => e.type === "run_failed");

  return (
    <div className="rounded-xl border border-border bg-card p-5 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">Sourcing run</h3>
          {isSimulated && <DemoRunBadge />}
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {isRunning ? (
            <><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /><span className="text-primary font-medium">Running</span></>
          ) : failed ? (
            <><XCircle className="w-3.5 h-3.5 text-destructive" /><span className="text-destructive font-medium">Failed</span></>
          ) : (
            <><CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /><span className="text-emerald-600 dark:text-emerald-400 font-medium">Completed</span></>
          )}
        </div>
      </div>

      {/* Stage list */}
      <ol className="space-y-3">
        {STAGES.map((stage) => {
          const { state, latest } = stageStateFor(stage.key, events);
          const Icon = stage.icon;
          return (
            <li key={stage.key} className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0">
                {state === "done" ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                ) : state === "active" ? (
                  <Loader2 className="w-4 h-4 text-primary animate-spin" />
                ) : (
                  <Circle className="w-4 h-4 text-muted-foreground/40" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Icon className={cn("w-3.5 h-3.5 shrink-0", state === "pending" ? "text-muted-foreground/40" : "text-muted-foreground")} />
                  <span className={cn("text-sm font-medium truncate", state === "pending" ? "text-muted-foreground/60" : "text-foreground")}>
                    {stage.label}
                  </span>
                  {typeof latest?.count === "number" && state !== "pending" && (
                    <span className="ml-auto shrink-0 text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                      {latest.count}
                    </span>
                  )}
                </div>
                {latest?.message && state !== "pending" && (
                  <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{latest.message}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Terminal summary */}
      {!isRunning && !failed && (
        <div className="mt-4 pt-4 border-t border-border flex flex-wrap gap-4 text-xs">
          {typeof summary.found === "number" && (
            <span className="text-muted-foreground">Sourced: <strong className="text-foreground">{summary.found}</strong></span>
          )}
          {typeof summary.screened === "number" && (
            <span className="text-muted-foreground">Passed screening: <strong className="text-foreground">{summary.screened}</strong></span>
          )}
          {typeof summary.shortlisted === "number" && (
            <span className="text-muted-foreground">Shortlisted: <strong className="text-emerald-600 dark:text-emerald-400">{summary.shortlisted}</strong></span>
          )}
        </div>
      )}

      {failed && failEvent && (
        <div className="mt-4 pt-4 border-t border-border text-xs text-destructive">{failEvent.message}</div>
      )}
    </div>
  );
}
