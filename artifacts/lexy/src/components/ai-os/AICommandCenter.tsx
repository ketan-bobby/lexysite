/**
 * AICommandCenter.tsx — Global AI command bar widget for the recruiter dashboard.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Renders a prominent search-style input with rotating placeholder prompts
 * ("Find 10 senior Java developers in Bangalore…", etc.) that acts as the
 * central AI entry point.  Below the input, six quick-action shortcut buttons
 * navigate to the most common recruiter workflows (Source, Interviews, Outreach,
 * Talent Match, Analytics, Agents).
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  PLACEHOLDER_MESSAGES[]   Rotating example prompts shown in the input
 *  QUICK_ACTIONS[]          Grid of shortcut buttons with icons and hrefs
 *  <AICommandCenter>        Root: command input + quick-action grid + active
 *                           agent count summary from /api/agents/status
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET /api/agents/status   Fetched to display the "N agents active" badge
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/index.tsx   Dashboard hero section
 */

import { useState, useRef } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, apiBase } from "@/lib/api";
import { useSourcingTrigger } from "@/lib/agent-runs";
import {
  Sparkles, Search, Users, Video, Send, Star, Zap,
  BarChart3, ArrowRight, Command, Cpu, Loader2, Briefcase,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";

const PILL_CLASS = cn(
  "group flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md border border-border text-foreground",
  "transition-all hover:border-primary hover:bg-primary/10 hover:scale-105 active:scale-95 disabled:opacity-60 disabled:hover:scale-100",
);

const PLACEHOLDER_MESSAGES = [
  "Find 10 senior Java developers in Bangalore…",
  "Launch AI outreach for shortlisted candidates…",
  "Screen all applicants for the DevOps Work Order…",
  "Rank candidates by ICP match for Acme Corp…",
  "Run AI interviews for 5 flagged candidates…",
  "Generate hiring insights for Q2 pipeline…",
];

// Quick-action pills are neutral by default and shift to the brand accent on hover.
const QUICK_ACTIONS = [
  { label: "Source Candidates",      icon: Search,   href: "/sourcing" },
  { label: "Run AI Interviews",      icon: Video,    href: "/interviews" },
  { label: "Launch Outreach",        icon: Send,     href: "/outreach" },
  { label: "Match to Roles",         icon: Star,     href: "/talent-match" },
  { label: "Generate Insights",      icon: BarChart3, href: "/analytics" },
  { label: "Agents Dashboard",       icon: Zap,      href: "/agents" },
];

interface Props {
  className?: string;
}

export function AICommandCenter({ className }: Props) {
  const [query, setQuery] = useState("");
  const [placeholderIdx] = useState(() => Math.floor(Math.random() * PLACEHOLDER_MESSAGES.length));
  const inputRef = useRef<HTMLInputElement>(null);


  /* Quick-action "something waiting" dots — driven by real state, not an
   * onboarding hint. Source Candidates → sourced candidates ready for screening;
   * Run AI Interviews → completed interviews awaiting review (both come from the
   * dashboard's recommendedActions, which only include an entry when its count
   * is > 0). Launch Outreach → unanswered inbox replies. Zero state = no dot. */
  const { data: dashData } = useQuery<{ recommendedActions?: any[]; agentsOnline?: number }>({
    queryKey: ["dashboard-summary"],
    queryFn: () => apiFetch(`${apiBase}/analytics/dashboard`).then(r => r.json()),
    refetchInterval: 30_000,
  });
  // "Agents online" mirrors the dashboard header — the count of in-flight agent
  // runs. Zero → idle; >0 → work happening right now.
  const onlineCount = Number(dashData?.agentsOnline ?? 0);
  const { data: inboxData } = useQuery<any[]>({
    queryKey: ["outreach-inbox"],
    queryFn: () => apiFetch(`${apiBase}/outreach/inbox`).then(r => r.json()),
    refetchInterval: 30_000,
  });
  const recActions = dashData?.recommendedActions ?? [];
  const sourcedAction = recActions.find((a: any) => a?.id === "sourced");
  const interviewsAction = recActions.find((a: any) => a?.id === "interviews");
  const unreadReplies = Array.isArray(inboxData) ? inboxData.filter((i: any) => !i?.isRead).length : 0;
  const PILL_SIGNAL: Record<string, { active: boolean; tooltip: string }> = {
    "Source Candidates": {
      active: !!sourcedAction,
      tooltip: sourcedAction?.label ?? "New sourced candidates ready for screening",
    },
    "Run AI Interviews": {
      active: !!interviewsAction,
      tooltip: interviewsAction?.label ?? "Completed AI interviews to review",
    },
    "Launch Outreach": {
      active: unreadReplies > 0,
      tooltip: `${pluralize(unreadReplies, "new outreach reply", "new outreach replies")} waiting`,
    },
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setQuery("");
  };

  return (
    <div className={cn("cmd-center-frame", className)}>
      <div className="cmd-center-panel relative overflow-hidden">
      {/* Top shimmer line */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

      <div className="p-5">
        {/* Header label */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center">
              <Cpu className="w-3.5 h-3.5 text-primary" />
            </div>
            <div>
              <span className="text-[10px] font-black tracking-widest text-primary uppercase">L3XY Agent Runtime</span>
              <span className="text-[10px] text-muted-foreground ml-2">· AI Command Center</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {onlineCount > 0 ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-signal-green opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-signal-green" />
                </span>
                <span className="text-[10px] text-signal-green font-semibold">{onlineCount} Agents Online</span>
              </>
            ) : (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-muted-foreground" />
                </span>
                <span className="text-[10px] text-muted-foreground font-semibold">0 Agents Online</span>
              </>
            )}
          </div>
        </div>

        {/* Command input */}
        <form onSubmit={handleSubmit} className="relative mb-4">
          <div className="cmd-input-wrap relative overflow-hidden flex items-center gap-3 rounded-xl border border-border/60 bg-muted/20 px-4 py-3 transition-all">
            <Command className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={PLACEHOLDER_MESSAGES[placeholderIdx]}
              className="relative z-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50 font-medium"
            />
            {query.trim() && (
              <Button type="submit" size="sm" className="h-7 gap-1.5 text-xs px-3">
                Run <ArrowRight className="w-3 h-3" />
              </Button>
            )}
            {!query.trim() && (
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground/40 font-mono hidden sm:flex">
                <kbd className="px-1.5 py-0.5 rounded border border-border/40 bg-muted/30">⌘</kbd>
                <kbd className="px-1.5 py-0.5 rounded border border-border/40 bg-muted/30">K</kbd>
              </div>
            )}
          </div>
        </form>

        {/* Quick action chips */}
        <div className="flex flex-wrap gap-2">
          {QUICK_ACTIONS.map(({ label, icon: Icon, href }) => {
            const signal = PILL_SIGNAL[label];
            return (
              <div key={label} className="relative inline-block">
                {label === "Source Candidates" ? (
                  <SourceCandidatesPill />
                ) : (
                <Link href={href}>
                  <button className={cn(
                    "group flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md border border-border text-foreground",
                    "transition-all hover:border-primary hover:bg-primary/10 hover:scale-105 active:scale-95",
                  )}>
                    <Icon className="w-3 h-3 text-muted-foreground transition-colors group-hover:text-primary" />
                    {label}
                  </button>
                </Link>
                )}
                {signal?.active && (
                  <span
                    title={signal.tooltip}
                    aria-label={signal.tooltip}
                    className="absolute -top-1 -right-1 z-30 flex h-3 w-3"
                  >
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
                    <span className="relative inline-flex h-3 w-3 rounded-full bg-primary ring-2 ring-card" />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </div>
  );
}

/**
 * "Source Candidates" quick action. Unlike the other pills (plain links), this
 * one *does* something: it starts a sourcing run. With exactly one active work
 * order it runs immediately; with several it opens a picker; with none it falls
 * back to the sourcing page so the recruiter can pick a role manually.
 */
function SourceCandidatesPill() {
  const { trigger, isPending } = useSourcingTrigger();
  const [open, setOpen] = useState(false);
  const { data: jobsResp } = useQuery<{ jobs?: any[] } | any[]>({
    queryKey: ["active-work-orders"],
    queryFn: () => apiFetch(`${apiBase}/jobs`).then(r => r.json()),
    refetchInterval: 60_000,
  });
  const allJobs: any[] = Array.isArray(jobsResp) ? jobsResp : (jobsResp?.jobs ?? []);
  const activeJobs = allJobs.filter((j: any) => ["active", "published"].includes(j?.status));

  const inner = (
    <button className={PILL_CLASS} disabled={isPending}>
      {isPending
        ? <Loader2 className="w-3 h-3 animate-spin text-primary" />
        : <Search className="w-3 h-3 text-muted-foreground transition-colors group-hover:text-primary" />}
      Source Candidates
    </button>
  );

  // No live roles → send them to the sourcing page to choose one manually.
  if (activeJobs.length === 0) {
    return <Link href="/sourcing">{inner}</Link>;
  }

  // Exactly one → run it straight away.
  if (activeJobs.length === 1) {
    return (
      <button
        type="button"
        className={PILL_CLASS}
        disabled={isPending}
        onClick={() => trigger(activeJobs[0].id)}
      >
        {isPending
          ? <Loader2 className="w-3 h-3 animate-spin text-primary" />
          : <Search className="w-3 h-3 text-muted-foreground transition-colors group-hover:text-primary" />}
        Source Candidates
      </button>
    );
  }

  // Several → let the recruiter pick which work order to source.
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{inner}</PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1.5">
        <p className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Source for which work order?
        </p>
        <div className="max-h-64 overflow-y-auto">
          {activeJobs.map((j: any) => (
            <button
              key={j.id}
              type="button"
              disabled={isPending}
              onClick={() => { setOpen(false); trigger(j.id); }}
              className="w-full flex items-center gap-2 text-left px-2 py-2 rounded-md text-sm hover:bg-primary/10 transition-colors disabled:opacity-60"
            >
              <Briefcase className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <span className="flex-1 min-w-0 truncate">{j.title || "Untitled role"}</span>
              {j.workOrderNumber && (
                <span className="text-[10px] font-mono text-muted-foreground shrink-0">{j.workOrderNumber}</span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
