/**
 * RunStepStream — the live step feed for a sourcing agent run.
 *
 * Renders the run's stages as an ordered list of rows. A row appears the moment
 * its `step_started` event arrives; its count updates live (counting up) on
 * `step_progress`; it flips to a success check with the final count on
 * `step_completed`. The active row shows a pulsing indicator. New rows fade +
 * rise 6px on mount (via `.run-row-in`, which respects prefers-reduced-motion).
 *
 * Source-agnostic and theme-aware — real and simulated runs render identically,
 * using design tokens only (success = `signal-green`, no hardcoded hex).
 *
 * Two modes:
 *   default  — the full stream on the /runs/:id page; auto-scrolls to the newest
 *              row unless the user has scrolled up.
 *   compact  — the dashboard Agent Activity takeover; shows the most recent rows
 *              in a denser layout with no scroll container.
 */
import { useEffect, useRef, useState } from "react";
import type { RunEvent } from "@/lib/agent-runs";
import { cn } from "@/lib/utils";
import {
  FileSearch, Search, Filter, BarChart3, Star,
  CheckCircle2, Loader2,
} from "lucide-react";

const STAGES: { key: string; label: string; icon: any }[] = [
  { key: "analyzing", label: "Analyzing requirements", icon: FileSearch },
  { key: "searching", label: "Searching candidate pools", icon: Search },
  { key: "screening", label: "Screening against requirements", icon: Filter },
  { key: "ranking", label: "Ranking candidates", icon: BarChart3 },
  { key: "shortlist", label: "Building shortlist", icon: Star },
];

type StageState = "active" | "done";

interface StageRow {
  key: string;
  label: string;
  icon: any;
  state: StageState;
  count: number | null;
  message: string;
  timestamp: string;
  firstSeq: number;
}

/**
 * Fold the flat event stream into per-stage rows, in the order each stage first
 * started. Only stages that have started are returned (a row "appears" on
 * step_started). A stage is "done" once it has a step_completed/run_completed.
 */
function stageRows(events: RunEvent[]): StageRow[] {
  const rows: StageRow[] = [];
  for (const stage of STAGES) {
    const forStage = events.filter((e) => e.stepName === stage.key);
    if (forStage.length === 0) continue;
    const latest = forStage[forStage.length - 1];
    const done = forStage.some((e) => e.type === "step_completed" || e.type === "run_completed");
    rows.push({
      key: stage.key,
      label: stage.label,
      icon: stage.icon,
      state: done ? "done" : "active",
      count: typeof latest.count === "number" ? latest.count : null,
      message: latest.message,
      timestamp: latest.timestamp,
      firstSeq: forStage[0].seq,
    });
  }
  return rows.sort((a, b) => a.firstSeq - b.firstSeq);
}

/** Animate a displayed integer toward `target` over ~500ms (requestAnimationFrame). */
function useCountUp(target: number | null): number | null {
  const [value, setValue] = useState<number | null>(target);
  const fromRef = useRef<number>(target ?? 0);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (target == null) { setValue(null); return; }
    const from = fromRef.current;
    const to = target;
    if (from === to) { setValue(to); return; }

    // Respect reduced motion: jump straight to the value.
    const reduce = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { fromRef.current = to; setValue(to); return; }

    const start = performance.now();
    const dur = 500;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(from + (to - from) * eased);
      setValue(current);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target]);

  return value;
}

function fmtTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function StageRowView({ row, compact }: { row: StageRow; compact?: boolean }) {
  const count = useCountUp(row.count);
  const Icon = row.icon;
  const done = row.state === "done";

  return (
    <li
      className={cn(
        "run-row-in flex items-start gap-3",
        compact ? "px-4 py-2.5" : "rounded-xl border border-border bg-card px-4 py-3 shadow-sm dark:shadow-none",
      )}
    >
      <div className="mt-0.5 shrink-0">
        {done ? (
          <CheckCircle2 className="w-4 h-4 text-signal-green" />
        ) : (
          <span className="relative inline-flex w-4 h-4 items-center justify-center">
            <Loader2 className="w-4 h-4 text-primary animate-spin" />
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span className={cn("font-medium truncate", compact ? "text-xs" : "text-sm", "text-foreground")}>
            {row.label}
          </span>
          {count != null && (
            <span
              className={cn(
                "ml-auto shrink-0 font-semibold tabular-nums rounded px-1.5 py-0.5",
                compact ? "text-[10px]" : "text-[11px]",
                done ? "bg-signal-green/10 text-signal-green" : "bg-muted text-muted-foreground",
              )}
            >
              {count}
            </span>
          )}
        </div>
        {!compact && (
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-[11px] text-muted-foreground truncate flex-1 min-w-0">{row.message}</p>
            <time className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">{fmtTime(row.timestamp)}</time>
          </div>
        )}
        {compact && (
          <span className="text-[10px] text-muted-foreground/60 truncate block">{row.message}</span>
        )}
      </div>
    </li>
  );
}

export function RunStepStream({
  events,
  compact = false,
  maxRows,
}: {
  events: RunEvent[];
  compact?: boolean;
  /** Cap the number of rows shown (compact panels); shows the most recent. */
  maxRows?: number;
}) {
  const rows = stageRows(events);
  const shown = maxRows != null ? rows.slice(-maxRows) : rows;

  // Auto-scroll to the newest row unless the user has scrolled up. Only the
  // full (non-compact) stream owns a scroll container.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stuckToBottom = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  useEffect(() => {
    if (compact) return;
    const el = scrollRef.current;
    if (el && stuckToBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, compact]);

  if (compact) {
    return (
      <ul className="divide-y divide-border/20">
        {shown.map((row) => (
          <StageRowView key={row.key} row={row} compact />
        ))}
      </ul>
    );
  }

  return (
    <div ref={scrollRef} onScroll={onScroll} className="max-h-[60vh] overflow-y-auto pr-1">
      <ol className="space-y-3">
        {shown.map((row) => (
          <StageRowView key={row.key} row={row} />
        ))}
      </ol>
    </div>
  );
}
