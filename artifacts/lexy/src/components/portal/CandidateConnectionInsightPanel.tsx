/**
 * components/portal/CandidateConnectionInsightPanel.tsx — Candidate Hiring Momentum UI
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Renders the candidate-facing view of the Connection Engine: a set of
 * supportive, encouraging widgets that show the candidate how actively they
 * are engaging and what their best next action is.
 *
 * ─── Components exported ────────────────────────────────────────────────────
 *   CandidateConnectionStrengthBadge  — compact inline badge (Cold/Warming/Engaged/High Intent)
 *   CandidateHiringMomentumCard       — momentum score card with label + visual bar
 *   CandidateNextBestActionCard       — recommended next step in plain language
 *   CandidateOpportunityPriorityList  — list of opportunities with per-opportunity insight
 *   CandidateConnectionInsightPanel   — full panel combining all of the above
 *
 * ─── Feature flag ────────────────────────────────────────────────────────────
 * All components silently render null when
 * VITE_ENABLE_CANDIDATE_CONNECTION_ENGINE !== "true", so the portal
 * continues to work unchanged when the feature is off.
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 * Fetches from GET /api/candidate-connection-insights/:candidateId (optional
 * ?jobId query param). Data is written by candidateConnectionEngine.ts server-side.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   pages/portal/index.tsx            — candidate dashboard home
 *   pages/portal/applications.tsx     — per-application insight strip
 */

import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { apiFetch, apiBase } from "@/lib/api";
import {
  Zap, Flame, Snowflake, TrendingUp, ArrowRight,
  Lightbulb, BarChart2, Target, Sparkles, Activity,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const ENABLED = import.meta.env.VITE_ENABLE_CANDIDATE_CONNECTION_ENGINE === "true";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ConnectionInsight {
  candidateId: string;
  jobId?: string | null;
  connectionStrengthScore: number;
  connectionStrengthLabel: "Cold" | "Warming" | "Engaged" | "High Intent";
  hiringMomentumScore: number | null;
  hiringMomentumLabel: "Low" | "Medium" | "High" | "Very High" | null;
  nextBestAction: string;
  topSignals: string[];
  updatedAt?: string | null;
}

// ─── Label configs ────────────────────────────────────────────────────────────

const STRENGTH_CONFIG = {
  Cold:        { color: "text-slate-400",  bg: "bg-slate-500/10 border-slate-500/25",   bar: "bg-slate-400",   icon: Snowflake, phrase: "Just getting started" },
  Warming:     { color: "text-amber-400",  bg: "bg-amber-500/10 border-amber-500/25",   bar: "bg-amber-400",   icon: Flame,     phrase: "Building momentum" },
  Engaged:     { color: "text-emerald-400",bg: "bg-emerald-500/10 border-emerald-500/25",bar: "bg-emerald-400", icon: Zap,       phrase: "Strong engagement" },
  "High Intent":{ color: "text-violet-400",bg: "bg-violet-500/10 border-violet-500/25",  bar: "bg-violet-500",  icon: TrendingUp,phrase: "You're in a great position" },
} as const;

const MOMENTUM_CONFIG = {
  Low:       { color: "text-slate-400",   bg: "bg-slate-500/10 border-slate-500/25",  dot: "bg-slate-400" },
  Medium:    { color: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/25",  dot: "bg-amber-400" },
  High:      { color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/25",dot: "bg-emerald-400" },
  "Very High":{ color: "text-violet-400", bg: "bg-violet-500/10 border-violet-500/25",  dot: "bg-violet-400" },
} as const;

const SIGNAL_LABELS: Record<string, string> = {
  viewed_opportunity:      "Viewed this opportunity",
  replied_to_message:      "Replied to recruiter",
  responded_quickly:       "Quick response time",
  completed_profile:       "Profile completed",
  completed_ai_interview:  "Completed AI interview",
  booked_interview:        "Interview booked",
  completed_interview:     "Interview completed",
  accepted_intro:          "Accepted intro",
  followed_up:             "Sent a follow-up",
  no_show:                 "Missed a session",
  declined_role:           "Declined role",
  long_silence:            "Inactive period",
};

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useJobInsight(candidateId: string, jobId: string) {
  return useQuery<ConnectionInsight>({
    queryKey: ["candidate-connection-insight", candidateId, jobId],
    queryFn: async () => {
      const res = await apiFetch(
        `${apiBase}/candidate/connection-insight/${candidateId}/${jobId}`
      );
      if (!res.ok) throw new Error("Failed to fetch insight");
      return res.json();
    },
    enabled: ENABLED && !!candidateId && !!jobId,
    staleTime: 60_000,
  });
}

function useAllInsights(candidateId: string) {
  return useQuery<{ candidateId: string; insights: ConnectionInsight[] }>({
    queryKey: ["candidate-connection-insights", candidateId],
    queryFn: async () => {
      const res = await apiFetch(
        `${apiBase}/candidate/connection-insights/${candidateId}`
      );
      if (!res.ok) throw new Error("Failed to fetch insights");
      return res.json();
    },
    enabled: ENABLED && !!candidateId,
    staleTime: 60_000,
  });
}

// ─── CandidateConnectionStrengthBadge ────────────────────────────────────────
// Compact inline badge — use wherever a score label is needed.
export function CandidateConnectionStrengthBadge({
  candidateId,
  jobId,
}: {
  candidateId: string;
  jobId: string;
}) {
  const { data, isLoading } = useJobInsight(candidateId, jobId);

  if (!ENABLED || isLoading || !data || data.connectionStrengthScore === 0) return null;

  const cfg = STRENGTH_CONFIG[data.connectionStrengthLabel] ?? STRENGTH_CONFIG.Cold;
  const Icon = cfg.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border",
        cfg.bg,
        cfg.color,
      )}
    >
      <Icon className="w-2.5 h-2.5" />
      {data.connectionStrengthLabel} · {Math.round(data.connectionStrengthScore)}
    </span>
  );
}

// ─── CandidateHiringMomentumCard ──────────────────────────────────────────────
export function CandidateHiringMomentumCard({ insight }: { insight: ConnectionInsight }) {
  if (!ENABLED || !insight.hiringMomentumLabel) return null;

  const cfg = MOMENTUM_CONFIG[insight.hiringMomentumLabel] ?? MOMENTUM_CONFIG.Low;

  return (
    <div className={cn("flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium", cfg.bg, cfg.color)}>
      <span className={cn("w-2 h-2 rounded-full", cfg.dot)} />
      <BarChart2 className="w-3.5 h-3.5" />
      <span>Hiring momentum: <strong>{insight.hiringMomentumLabel}</strong></span>
      {insight.hiringMomentumScore != null && (
        <span className="ml-auto opacity-70 tabular-nums">{Math.round(insight.hiringMomentumScore)}%</span>
      )}
    </div>
  );
}

// ─── CandidateNextBestActionCard ──────────────────────────────────────────────
export function CandidateNextBestActionCard({ insight }: { insight: ConnectionInsight }) {
  if (!ENABLED || !insight.nextBestAction) return null;

  return (
    <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-primary/5 border border-primary/20">
      <Lightbulb className="w-4 h-4 text-primary mt-0.5 shrink-0" />
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-primary/70 mb-0.5">
          Recommended next step
        </p>
        <p className="text-sm text-foreground leading-relaxed">{insight.nextBestAction}</p>
      </div>
    </div>
  );
}

// ─── CandidateConnectionInsightPanel ─────────────────────────────────────────
// Full panel: connection strength + momentum + action + signals.
// Drop this into any candidate-side page.
export function CandidateConnectionInsightPanel({
  candidateId,
  jobId,
  jobTitle,
}: {
  candidateId: string;
  jobId: string;
  jobTitle?: string;
}) {
  const { data: insight, isLoading } = useJobInsight(candidateId, jobId);

  if (!ENABLED) return null;

  const score = insight?.connectionStrengthScore ?? 0;
  const label = insight?.connectionStrengthLabel ?? "Cold";
  const cfg = STRENGTH_CONFIG[label] ?? STRENGTH_CONFIG.Cold;
  const Icon = cfg.icon;

  return (
    <Card className="border-border/40 shadow-sm overflow-hidden">
      {/* colour accent bar */}
      <div className={cn(
        "h-1.5",
        label === "Cold" ? "bg-slate-500/40" :
        label === "Warming" ? "bg-amber-400/60" :
        label === "Engaged" ? "bg-emerald-400/70" :
        "bg-violet-500/80"
      )} />
      <CardHeader className="pb-2 pt-4 flex flex-row items-center gap-2">
        <Activity className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-sm font-semibold">
          Your hiring momentum {jobTitle ? `· ${jobTitle}` : ""}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pb-5">
        {isLoading ? (
          <div className="text-xs text-muted-foreground animate-pulse py-2">Loading your insights…</div>
        ) : (
          <>
            {/* Score ring + label */}
            <div className="flex items-end gap-3">
              <div className="relative">
                <span className={cn("text-5xl font-black tabular-nums font-display", cfg.color)}>
                  {Math.round(score)}
                </span>
                <span className="text-xs text-muted-foreground ml-1">/100</span>
              </div>
              <div className="mb-1">
                <span className={cn("inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border", cfg.bg, cfg.color)}>
                  <Icon className="w-3 h-3" />{label}
                </span>
                <p className={cn("text-[10px] mt-0.5 font-medium", cfg.color)}>{cfg.phrase}</p>
              </div>
            </div>

            {/* Progress bar */}
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-700", cfg.bar)}
                style={{ width: `${score}%` }}
              />
            </div>

            {/* Momentum indicator */}
            {insight && <CandidateHiringMomentumCard insight={insight} />}

            {/* Next best action */}
            {insight && <CandidateNextBestActionCard insight={insight} />}

            {/* Top signals */}
            {(insight?.topSignals ?? []).length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Your engagement signals
                </p>
                {(insight?.topSignals ?? []).map((sig: string) => (
                  <div key={sig} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles className="w-3 h-3 text-primary/60 shrink-0" />
                    {SIGNAL_LABELS[sig] ?? sig}
                  </div>
                ))}
              </div>
            )}

            {(insight?.topSignals ?? []).length === 0 && score === 0 && (
              <p className="text-xs text-muted-foreground">
                No engagement recorded yet — start by viewing the job details or reaching out.
              </p>
            )}

            <p className="text-[10px] text-muted-foreground/60 pt-1">
              This is guidance only. It does not affect employer decisions.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─── CandidateOpportunityPriorityList ────────────────────────────────────────
// Shows all opportunities ranked by connection strength with insights.
export function CandidateOpportunityPriorityList({
  candidateId,
  opportunities,
}: {
  candidateId: string;
  opportunities: Array<{
    id: string;
    title: string;
    company?: string | null;
    department?: string | null;
  }>;
}) {
  const { data, isLoading } = useAllInsights(candidateId);

  if (!ENABLED) return null;
  if (isLoading) return (
    <div className="text-xs text-muted-foreground animate-pulse py-4 text-center">
      Loading opportunity insights…
    </div>
  );

  // Build a map of jobId → insight
  const insightMap = new Map(
    (data?.insights ?? []).map(i => [i.jobId ?? "", i])
  );

  // Sort opportunities: highest connection strength first
  const sorted = [...opportunities].sort((a, b) => {
    const aScore = insightMap.get(a.id)?.connectionStrengthScore ?? 0;
    const bScore = insightMap.get(b.id)?.connectionStrengthScore ?? 0;
    return bScore - aScore;
  });

  if (sorted.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <Target className="w-4 h-4 text-primary" />
        <p className="text-sm font-semibold">Opportunity priority</p>
        <span className="text-[10px] text-muted-foreground ml-auto">Highest momentum first</span>
      </div>
      {sorted.map((opp) => {
        const insight = insightMap.get(opp.id);
        const score = insight?.connectionStrengthScore ?? 0;
        const label = (insight?.connectionStrengthLabel ?? "Cold") as keyof typeof STRENGTH_CONFIG;
        const cfg = STRENGTH_CONFIG[label] ?? STRENGTH_CONFIG.Cold;
        const Icon = cfg.icon;

        return (
          <div
            key={opp.id}
            className="flex items-start gap-3 p-3 rounded-lg border border-border/40 bg-card/50 hover:border-primary/30 transition-all"
          >
            <div className={cn("mt-1 p-1.5 rounded-md", cfg.bg)}>
              <Icon className={cn("w-3.5 h-3.5", cfg.color)} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium truncate">{opp.title}</span>
                {opp.company && (
                  <span className="text-xs text-muted-foreground">· {opp.company}</span>
                )}
                <span className={cn("ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0", cfg.bg, cfg.color)}>
                  {label}
                </span>
              </div>
              {insight?.hiringMomentumLabel && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Momentum: {insight.hiringMomentumLabel}
                  {insight.hiringMomentumScore != null && ` · ${Math.round(insight.hiringMomentumScore)}%`}
                </p>
              )}
              {insight?.nextBestAction && (
                <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1.5">
                  <ArrowRight className="w-3 h-3 shrink-0 mt-0.5 text-primary/60" />
                  {insight.nextBestAction}
                </p>
              )}
              {!insight && (
                <p className="text-xs text-muted-foreground mt-1">
                  Engage with this opportunity to see your momentum.
                </p>
              )}
            </div>
          </div>
        );
      })}
      <p className="text-[10px] text-muted-foreground/60 pt-1">
        Priority order is based on your engagement, not employer decisions.
      </p>
    </div>
  );
}
