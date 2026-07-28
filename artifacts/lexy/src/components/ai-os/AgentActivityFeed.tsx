/**
 * AgentActivityFeed.tsx — Real-time agent activity log widget.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Polls the API for recent agent actions and renders a chronological feed of
 * cards — each showing the agent name, action description, optional metadata
 * (e.g. candidate name), status pill (Running / Done / Pending / Failed), and a
 * relative time stamp ("2 min ago").  A compact prop switches to a condensed
 * list used in sidebar widgets.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  STATUS_CFG        Label, badge class, and dot colour per status value
 *  ICON_MAP          Maps icon-name strings from the API to lucide components
 *  <FeedItem>        Single activity row
 *  <AgentActivityFeed> Root: polls /api/agents/activity, maps items to FeedItems
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET /api/agents/activity   Returns FeedItem[] (polled every 15 s)
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/index.tsx        Dashboard right-hand activity column
 *  pages/recruiter/agents.tsx       Agent page activity section
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Activity, Search, Video, Send, Zap, Shield,
  CheckCircle2, Loader2, Clock, AlertTriangle, Star,
  Calendar, Brain, ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch, apiBase } from "@/lib/api";
import { useAgentRun, invalidateRunAffectedQueries, type RunEvent } from "@/lib/agent-runs";

type Status = "running" | "completed" | "pending" | "flagged";

interface FeedItem {
  id: string;
  agent: string;
  action: string;
  meta?: string | null;
  status: Status;
  ago: string;
  icon: string;
  color: string;
}

const ICON_MAP: Record<string, React.ElementType> = {
  Search, Video, Send, Zap, Shield, CheckCircle2, AlertTriangle, Star, Calendar, Brain, Activity,
};

const STATUS_CFG: Record<Status, { label: string; cls: string; dot: string; icon: string }> = {
  running:   { label: "Running",   cls: "bg-primary/10 text-primary border-primary/25",            dot: "bg-primary animate-pulse", icon: "text-primary" },
  completed: { label: "Done",      cls: "bg-signal-green/10 text-signal-green border-signal-green/25", dot: "bg-signal-green",       icon: "text-signal-green" },
  pending:   { label: "Pending",   cls: "bg-signal-amber/10 text-signal-amber border-signal-amber/25", dot: "bg-signal-amber",       icon: "text-signal-amber" },
  flagged:   { label: "Failed",    cls: "bg-destructive/10 text-destructive border-destructive/25", dot: "bg-destructive",          icon: "text-destructive" },
};

interface Props {
  compact?: boolean;
  className?: string;
}

interface ActiveRun {
  id: string;
  workOrderId: string | null;
  jobTitle: string | null;
}

function useAgentActivity() {
  return useQuery<{ feed: FeedItem[]; activeRun: ActiveRun | null }>({
    queryKey: ["dashboard-activity"],
    queryFn: () =>
      apiFetch(`${apiBase}/analytics/dashboard`)
        .then((r) => r.json())
        .then((d) => ({ feed: d.agentActivity ?? [], activeRun: d.activeRun ?? null })),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

function fmtEventTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * A single event line in the dashboard takeover. A terminal or completed event
 * shows a green check; anything still in flight shows the spinner.
 */
function TakeoverEventRow({ event, live }: { event: RunEvent; live: boolean }) {
  const done = event.type === "step_completed" || event.type === "run_completed";
  const failed = event.type === "run_failed";
  return (
    <li className="run-row-in flex items-start gap-2.5 px-4 py-2.5">
      <span className="mt-0.5 shrink-0">
        {failed ? (
          <AlertTriangle className="w-3.5 h-3.5 text-destructive" />
        ) : done ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-signal-green" />
        ) : live ? (
          <Loader2 className="w-3.5 h-3.5 text-primary animate-spin" />
        ) : (
          <Clock className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs text-foreground truncate flex-1 min-w-0">{event.message}</span>
          {typeof event.count === "number" && (
            <span
              className={cn(
                "shrink-0 text-[10px] font-semibold tabular-nums rounded px-1.5 py-0.5",
                done ? "bg-signal-green/10 text-signal-green" : "bg-muted text-muted-foreground",
              )}
            >
              {event.count}
            </span>
          )}
        </div>
        <time className="text-[10px] text-muted-foreground/50 tabular-nums">{fmtEventTime(event.timestamp)}</time>
      </div>
    </li>
  );
}

/**
 * Live takeover: when a run is in flight, the panel replaces the empty/skeleton
 * state with the run's three most recent events (chronological), the exact
 * moment the empty state promised. Theme-aware, tokens only.
 */
function LiveRunTakeover({ activeRun }: { activeRun: ActiveRun }) {
  const qc = useQueryClient();
  // When the watched run finishes while the user is on the dashboard, refresh
  // the funnel / KPIs / recommended actions / pipeline so results land live.
  const { events, isRunning } = useAgentRun(activeRun.id, () => invalidateRunAffectedQueries(qc));
  const recent = events.slice(-3);
  const lastSeq = events.length > 0 ? events[events.length - 1].seq : -1;
  return (
    <div>
      {recent.length === 0 ? (
        <div className="flex items-center gap-2 px-4 py-6 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          Sourcing{activeRun.jobTitle ? ` for ${activeRun.jobTitle}` : ""} — starting…
        </div>
      ) : (
        <ul className="divide-y divide-border/20">
          {recent.map((ev) => (
            <TakeoverEventRow key={ev.seq} event={ev} live={isRunning && ev.seq === lastSeq} />
          ))}
        </ul>
      )}
      <Link
        href={`/runs/${activeRun.id}`}
        className="flex items-center justify-end gap-1 px-4 py-2.5 text-xs font-semibold text-primary hover:underline border-t border-border/20"
      >
        View run <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </div>
  );
}

export function AgentActivityFeed({ compact = false, className }: Props) {
  const { data, isLoading } = useAgentActivity();
  const feed = data?.feed ?? [];
  const activeRun = data?.activeRun ?? null;
  const displayed = compact ? feed.slice(0, 5) : feed;
  const isEmptyState = !isLoading && displayed.length === 0 && !activeRun;

  return (
    <Card className={cn("border-border/50", isEmptyState ? "overflow-visible relative" : "overflow-hidden", className)}>
      <CardHeader className="pb-3 border-b border-border/30">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            Agent Activity
          </span>
          {(feed.length > 0 || activeRun) && (
            <div className="flex items-center gap-1.5">
              <span className="status-dot status-dot--green status-dot--pulse" />
              <span className="text-[10px] text-signal-green font-semibold">Live</span>
            </div>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {activeRun ? (
          <LiveRunTakeover activeRun={activeRun} />
        ) : isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground text-xs">
            Loading activity…
          </div>
        ) : displayed.length === 0 ? (
          <div className="px-4 py-6">
            {/* Floating "preview chip" — illustrative, styled like a real feed
                card, breaking the card's top-right edge so it reads as a hint of
                what will appear once agents run. Marked "Preview" so it's never
                mistaken for real data. */}
            <div
              aria-hidden="true"
              className="preview-chip absolute z-20 pointer-events-none"
              style={{
                top: "0px",
                right: "0px",
                transform: "translateY(-30%) rotate(-2deg)",
                ["--chip-to" as any]: "translateY(-30%) rotate(-2deg)",
                ["--chip-from" as any]: "translateY(calc(-30% + 6px)) rotate(-2deg)",
                animationDelay: "0ms",
                borderWidth: "1px",
                borderStyle: "solid",
                borderRadius: "10px",
                boxShadow: "0 4px 12px rgba(15,23,42,0.08)",
                padding: "10px 14px",
              }}
            >
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-signal-green" />
                <span className="text-[13px] font-medium">
                  12 candidates sourced
                </span>
              </div>
              <div className="text-[10px] uppercase tracking-wide mt-0.5" style={{ color: "hsl(var(--muted))" }}>
                Preview
              </div>
            </div>
            {/* Skeleton rows hint at what the feed looks like once it's live,
                stacked cleanly with the caption on its own line below. */}
            <div className="flex flex-col gap-[10px]" aria-hidden="true">
              {[62, 82, 44].map((w, i) => (
                <div key={i} className="h-4 rounded-md skeleton-shimmer" style={{ width: `${w}%` }} />
              ))}
            </div>
            <p className="mt-3 text-xs font-semibold text-muted-foreground">
              Agent activity will stream here
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/20">
            {displayed.map((item) => {
              const Icon = ICON_MAP[item.icon] ?? Activity;
              const st = STATUS_CFG[item.status];
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-3 px-4 py-3 transition-all hover:bg-muted/10"
                >
                  <div className={cn(
                    "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                    item.status === "running" ? "bg-primary/10" : "bg-muted/40",
                  )}>
                    {item.status === "running" ? (
                      <Loader2 className={cn("w-3.5 h-3.5 animate-spin", st.icon)} />
                    ) : (
                      <Icon className={cn("w-3.5 h-3.5", st.icon)} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-bold text-foreground leading-tight">{item.action}</span>
                      <div className={cn("w-1.5 h-1.5 rounded-full shrink-0", st.dot)} />
                    </div>
                    {item.meta && (
                      <span className="text-[10px] text-muted-foreground/60">{item.meta}</span>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <Badge variant="outline" className={cn("text-[9px] px-1.5 py-0.5 h-4", st.cls)}>
                      {st.label}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground/50 flex items-center gap-0.5">
                      <Clock className="w-2.5 h-2.5" />{item.ago}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
