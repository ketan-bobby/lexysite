/**
 * components/ui-custom/ConnectionStrengthBadge.tsx — Employer-Side Connection Score UI
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Recruiter-facing badges and panels that surface the employer-side Connection
 * Engine score for a candidate. Shows a colour-coded label (Cold / Warming /
 * Engaged / High Intent), a score bar, and the top behavioural signals that
 * drove the score.
 *
 * ─── Components exported ────────────────────────────────────────────────────
 *   useConnectionScore()        — React Query hook: GET /api/connection-score/:id
 *   ConnectionStrengthBadge     — compact inline badge with label + icon
 *   ConnectionStrengthPanel     — full card: score bar + signal list
 *
 * ─── Feature flag ────────────────────────────────────────────────────────────
 * All components render null when VITE_ENABLE_CONNECTION_ENGINE !== "true".
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   pages/recruiter/candidates/[id].tsx  — candidate profile page
 *   pages/recruiter/pipeline.tsx         — pipeline Kanban cards
 */

import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Zap, Flame, Snowflake, TrendingUp, Activity } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiBase, apiFetch } from "@/lib/api";

const ENABLED = import.meta.env.VITE_ENABLE_CONNECTION_ENGINE === "true";

// ─── Types ────────────────────────────────────────────────────────────────────
interface ConnectionScoreData {
  candidateId: string;
  jobId: string | null;
  score: number;
  label: "Cold" | "Warming" | "Engaged" | "High Intent";
  topSignals: string[];
  lastCalculatedAt: string | null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useConnectionScore(candidateId: string, jobId?: string) {
  return useQuery<ConnectionScoreData>({
    queryKey: ["connection-score", candidateId, jobId],
    queryFn: async () => {
      const url = `${apiBase}/connection-score/${candidateId}${jobId ? `?jobId=${jobId}` : ""}`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error("Failed to fetch connection score");
      return res.json();
    },
    enabled: ENABLED && !!candidateId,
    staleTime: 30_000,
  });
}

// ─── Label config ─────────────────────────────────────────────────────────────
const LABEL_CONFIG = {
  Cold:        { color: "text-slate-400",  bg: "bg-slate-500/10 border-slate-500/25",  icon: Snowflake },
  Warming:     { color: "text-amber-400",  bg: "bg-amber-500/10 border-amber-500/25",  icon: Flame },
  Engaged:     { color: "text-emerald-400",bg: "bg-emerald-500/10 border-emerald-500/25", icon: Zap },
  "High Intent":{ color: "text-violet-400",bg: "bg-violet-500/10 border-violet-500/25",  icon: TrendingUp },
} as const;

// ─── Signal display names ─────────────────────────────────────────────────────
const SIGNAL_LABELS: Record<string, string> = {
  replied_to_outreach:   "Replied to outreach",
  response_within_24h:   "Responded within 24 h",
  accepted_intro:        "Accepted intro",
  booked_interview:      "Booked interview",
  completed_interview:   "Completed interview",
  viewed_opportunity:    "Viewed opportunity",
  multiple_interactions: "Multiple interactions",
  no_show:               "No-show",
  declined_role:         "Declined role",
};

// ─── Inline badge (compact) ───────────────────────────────────────────────────
export function ConnectionStrengthBadge({
  candidateId,
  jobId,
}: {
  candidateId: string;
  jobId?: string;
}) {
  const { data, isLoading } = useConnectionScore(candidateId, jobId);

  if (!ENABLED || isLoading || !data) return null;

  const cfg = LABEL_CONFIG[data.label] ?? LABEL_CONFIG.Cold;
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
      {data.score} · {data.label}
    </span>
  );
}

// ─── Full panel (for candidate detail page) ───────────────────────────────────
export function ConnectionStrengthPanel({
  candidateId,
  jobId,
}: {
  candidateId: string;
  jobId?: string;
}) {
  const { data, isLoading, isError } = useConnectionScore(candidateId, jobId);

  if (!ENABLED) return null;

  const score = data?.score ?? 0;
  const label = data?.label ?? "Cold";
  const cfg = LABEL_CONFIG[label] ?? LABEL_CONFIG.Cold;
  const Icon = cfg.icon;

  return (
    <Card className="shadow-sm border-border/40">
      <div className={cn("h-2 rounded-t-lg", label === "Cold" ? "bg-slate-500/40" : label === "Warming" ? "bg-amber-500/60" : label === "Engaged" ? "bg-emerald-500/70" : "bg-violet-500/80")} />
      <CardHeader className="pb-2 flex flex-row items-center gap-2">
        <Activity className="w-4 h-4 text-muted-foreground" />
        <CardTitle className="text-base">Connection Strength</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pb-5">
        {isLoading ? (
          <div className="text-sm text-muted-foreground animate-pulse">Calculating…</div>
        ) : isError ? (
          <div className="text-sm text-muted-foreground">Couldn’t load connection strength. Try refreshing.</div>
        ) : (
          <>
            <div className="flex items-end gap-2">
              <span className={cn("text-5xl font-black tabular-nums font-display", cfg.color)}>
                {score}
              </span>
              <span className={cn("mb-1 inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full border", cfg.bg, cfg.color)}>
                <Icon className="w-3 h-3" />{label}
              </span>
            </div>

            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className={cn("h-full rounded-full transition-all duration-700", label === "Cold" ? "bg-slate-400" : label === "Warming" ? "bg-amber-400" : label === "Engaged" ? "bg-emerald-400" : "bg-violet-500")}
                style={{ width: `${score}%` }}
              />
            </div>

            {(data?.topSignals ?? []).length > 0 && (
              <div className="space-y-1.5 pt-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Top Signals</p>
                {(data?.topSignals ?? []).map((sig) => (
                  <div key={sig} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
                    {SIGNAL_LABELS[sig] ?? sig}
                  </div>
                ))}
              </div>
            )}

            {(data?.topSignals ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">No engagement signals recorded yet.</p>
            )}

            {/* TODO: future blended scoring — combine with fit score + interview score */}
          </>
        )}
      </CardContent>
    </Card>
  );
}
