/**
 * IntelligencePanel.tsx — Full AI intelligence panel for a candidate×job pair.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * The primary recruiter-facing surface for Lexy's scoring engine output.
 * Displays four composite scores (Fit, Quality, Verification, Conversion), a hire-
 * probability gauge, stage-transition probabilities, top strengths / risks, the
 * next-best-action recommendation, and the AI explanation for each score change.
 * Includes a "Recalculate" trigger and embeds the LexyCandidatePredictionInline
 * component for the plain-language hiring prediction summary.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  IntelligenceRecord   TypeScript interface for the API response shape
 *  <ScoreRing>          SVG circular gauge for a single score
 *  <SignalExplainer>    Expandable section showing what drove each score
 *  <IntelligencePanel>  Root: fetches record, renders all sub-components,
 *                       wires the recalculate mutation
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET  /api/intelligence/:candidateId/:jobId    Load intelligence record
 *  POST /api/intelligence/:candidateId/:jobId/recalculate   Force refresh
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/candidates/[id].tsx    Candidate profile intelligence tab
 */

import { useState } from "react";
import { useTheme } from "next-themes";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authHeaders } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Brain, TrendingUp, Shield, Zap, Target, ChevronRight,
  ArrowUpRight, ArrowDownRight, CheckCircle2, AlertTriangle,
  RefreshCw, Sparkles, Info
} from "lucide-react";
import { LexyCandidatePredictionInline } from "./LexyCandidatePrediction";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import { Link } from "wouter";
import { cn, pluralize } from "@/lib/utils";
import { bandBy } from "@/lib/score-band";
import { displayScore, scoreBarWidth } from "@/lib/score-display";
import { intelBandBy } from "@/lib/intelligence-bands";

/* ── Types ────────────────────────────────────────────────────────────────── */
interface IntelligenceRecord {
  id: string;
  candidateId: string;
  jobId: string;
  tenantId: string;
  fitScore: number | null;
  qualityScore: number | null;
  trustScore: number | null;
  conversionScore: number | null;
  hireProbability: number | null;
  nextBestAction: string | null;
  topStrengths: string[] | null;
  topRisks: string[] | null;
  explanationJson: Record<string, { increased: string[]; decreased: string[]; action: string }> | null;
  signalsJson: Record<string, any> | null;
  outcome: string | null;
  lastUpdated: string;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */
const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/* Refined electric palette — vivid but not blinding (dark mode) */
const NEON = {
  green:  "#4ade80",   // emerald-400  — strong scores / advance
  cyan:   "#22d3ee",   // cyan-400     — schedule / primary accent
  yellow: "#facc15",   // yellow-400   — review
  orange: "#fb923c",   // orange-400   — re-engage
  purple: "#a78bfa",   // violet-400   — verification
  pink:   "#fb7185",   // rose-400     — reject
  slate:  "#94a3b8",   // slate-400    — hold
};

/* Darker, WCAG-legible variants for light mode — the neon tones wash out on
   a white surface, so light mode swaps in the 700-level equivalents. Dark mode
   keeps NEON unchanged. */
const INK = {
  green:  "#047857",   // emerald-700
  cyan:   "#0e7490",   // cyan-700
  yellow: "#a16207",   // yellow-700
  orange: "#c2410c",   // orange-700
  purple: "#6d28d9",   // violet-700
  pink:   "#be123c",   // rose-700
  slate:  "#475569",   // slate-600
};

type Palette = typeof NEON;
type PaletteKey = keyof Palette;

function usePalette(): Palette {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "light" ? INK : NEON;
}

const ACTION_CONFIG: Record<string, { label: string; key: PaletteKey }> = {
  advance:             { label: "Advance",    key: "green"  },
  schedule:            { label: "Schedule",   key: "cyan"   },
  recruiter_review:    { label: "Review",     key: "yellow" },
  re_engage:           { label: "Re-engage",  key: "orange" },
  manual_verification: { label: "Verify",     key: "purple" },
  reject:              { label: "Reject",     key: "pink"   },
  hold:                { label: "Hold",       key: "slate"  },
};

function scoreHex(score: number | null, pal: Palette): string {
  if (score == null) return pal === NEON ? "#64748b" : pal.slate;
  // Generic intelligence-dimension colorizer — banded on the shared INTELLIGENCE
  // convention (see intelligence-bands.ts); its 75/55 equality with the canonical
  // match band is coincidental, not a dependency.
  return intelBandBy(score, { strong: pal.green, moderate: pal.yellow, weak: pal.pink });
}

function ScoreBar({ label, score, icon: Icon, tooltip }: {
  label: string; score: number | null; icon: any; tooltip: string;
}) {
  const pal = usePalette();
  const hex = scoreHex(score, pal);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="space-y-1.5 cursor-default">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider" style={{ color: hex, opacity: 0.75 }}>
                <Icon className="w-3.5 h-3.5" /> {label}
              </span>
              <span className="text-base font-black tabular-nums" style={{ color: hex }}>
                {displayScore(score)}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${scoreBarWidth(score)}%`, backgroundColor: hex }}
              />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs text-xs">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* ── Candidate Row ────────────────────────────────────────────────────────── */
function CandidateIntelligenceRow({
  record, candidateName, rank,
}: {
  record: IntelligenceRecord;
  candidateName?: string;
  rank: number;
}) {
  const pal = usePalette();
  const action = record.nextBestAction ? ACTION_CONFIG[record.nextBestAction] : null;
  const actionHex = action ? pal[action.key] : null;
  const hp = record.hireProbability;

  return (
    <div className="group border border-border rounded-xl bg-card hover:border-primary/40 transition-all duration-200 overflow-hidden">
      {/* Top strip colored by hire probability — neon glow */}
      <div
        className="h-1 w-full"
        style={{
          background:
            hp == null ? "transparent"
            : bandBy(hp, {
                strong: "linear-gradient(to right, #4ade80, #22d3ee)",
                good: "linear-gradient(to right, #facc15, #fb923c)",
                fair: "linear-gradient(to right, #fb7185, #fb923c)",
              }),
          boxShadow:
            hp == null ? "none"
            : bandBy(hp, {
                strong: "0 0 8px #4ade8055",
                good: "0 0 8px #facc1555",
                fair: "0 0 8px #fb718555",
              }),
        }}
      />

      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          {/* Rank + Candidate */}
          <div className="flex items-center gap-4 flex-1 min-w-0">
            <div
              className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-xs font-black"
              style={
                rank === 1 ? { backgroundColor: `${pal.green}22`, border: `1px solid ${pal.green}66`, color: pal.green, boxShadow: `0 0 10px ${pal.green}44` }
                : rank === 2 ? { backgroundColor: `${pal.cyan}18`, border: `1px solid ${pal.cyan}55`, color: pal.cyan }
                : rank === 3 ? { backgroundColor: `${pal.purple}18`, border: `1px solid ${pal.purple}55`, color: pal.purple }
                : pal === NEON
                  ? { backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "#64748b" }
                  : { backgroundColor: "rgba(100,116,139,0.12)", border: "1px solid rgba(100,116,139,0.25)", color: pal.slate }
              }
            >
              #{rank}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <Link href={`/candidates/${record.candidateId}`} className="font-bold text-base hover:text-primary transition-colors truncate">
                  {candidateName ?? `Candidate ${record.candidateId.slice(0, 6)}`}
                </Link>
                {action && actionHex && (
                  <span
                    className="text-xs font-bold px-2.5 py-0.5 rounded-full border"
                    style={{
                      color: actionHex,
                      backgroundColor: `${actionHex}15`,
                      borderColor: `${actionHex}40`,
                    }}
                  >
                    {action.label}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Last updated {new Date(record.lastUpdated).toLocaleDateString()}</p>
            </div>
          </div>

          {/* Hire Probability */}
          <div className="flex-shrink-0 text-right">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-0.5">Hire Prob.</p>
            <p
              className="text-4xl font-black tabular-nums"
              style={{
                color: scoreHex(hp, pal),
              }}
            >
              {hp != null ? `${hp}%` : "—"}
            </p>
          </div>
        </div>

        {/* Score Bars */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 mt-5">
          <ScoreBar
            label="Fit"
            score={record.fitScore}
            icon={Target}
            tooltip="Alignment between the candidate's skills, experience, and the ICP requirements"
          />
          <ScoreBar
            label="Quality"
            score={record.qualityScore}
            icon={TrendingUp}
            tooltip="Caliber of the candidate based on screening results and interview performance"
          />
          <ScoreBar
            label="Verification"
            score={record.trustScore}
            icon={Shield}
            tooltip="Identity verification (50%), interview proctoring integrity (30%), and fraud signals (20%)"
          />
          <ScoreBar
            label="Conversion"
            score={record.conversionScore}
            icon={Zap}
            tooltip="Likelihood to complete the hiring process without ghosting or dropping out"
          />
        </div>

        {/* Strengths & Risks */}
        {((record.topStrengths?.length ?? 0) > 0 || (record.topRisks?.length ?? 0) > 0) && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(record.topStrengths?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-bold uppercase tracking-wider flex items-center gap-1" style={{ color: pal.green }}>
                  <ArrowUpRight className="w-3 h-3" /> Strengths
                </p>
                <ul className="space-y-1">
                  {record.topStrengths!.slice(0, 3).map((s, i) => (
                    <li key={i} className="text-xs text-body dark:text-muted-foreground flex items-start gap-1.5">
                      <CheckCircle2 className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: pal.green }} />
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(record.topRisks?.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-bold uppercase tracking-wider flex items-center gap-1" style={{ color: pal.orange }}>
                  <ArrowDownRight className="w-3 h-3" /> Risks
                </p>
                <ul className="space-y-1">
                  {record.topRisks!.slice(0, 3).map((r, i) => (
                    <li key={i} className="text-xs text-body dark:text-muted-foreground flex items-start gap-1.5">
                      <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: pal.yellow }} />
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Lexy inline prediction */}
        <div className="mt-4 px-3 py-2.5 rounded-xl bg-white/3 border border-white/8">
          <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-2 flex items-center gap-1">
            <Brain className="w-3 h-3 text-primary" /> Lexy says
          </p>
          <LexyCandidatePredictionInline
            data={{
              hireProbability: record.hireProbability,
              /* RAW nullable scores — the prediction widget renders "—" for
                 unknown dimensions (same rule as the score bars above), never
                 a fabricated neutral 50 that would contradict this very card. */
              scores: {
                fitScore:        record.fitScore,
                qualityScore:    record.qualityScore,
                trustScore:      record.trustScore,
                conversionScore: record.conversionScore,
                hireProbability: record.hireProbability,
              },
              stageProbs: {
                nextStageSuccessProbability: Math.round(((record.fitScore ?? 50) * 0.4 + (record.qualityScore ?? 50) * 0.6)),
                offerProbability:            record.hireProbability ?? 50,
                offerAcceptanceProbability:  record.conversionScore ?? 50,
                dropoffProbability:          Math.max(0, 100 - (record.conversionScore ?? 50)),
              },
              decisionResult: {
                decision:    record.nextBestAction ?? "hold",
                confidence:  record.topStrengths?.length ? 55 : 35,
                reasoning:   "",
                factors: {
                  supporting: record.topStrengths ?? [],
                  blocking:   record.topRisks     ?? [],
                },
                why_selected: "",
                explanation: {
                  strengths: record.topStrengths ?? [],
                  risks:     record.topRisks     ?? [],
                },
              },
              topStrengths: record.topStrengths,
              topRisks:     record.topRisks,
            }}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-border/50">
          <div className="flex items-center gap-2">
            {record.explanationJson && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="View score explanation" className="h-7 w-7">
                      <Info className="w-3.5 h-3.5 text-muted-foreground" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-sm text-xs space-y-2 p-3">
                    {Object.entries(record.explanationJson).map(([key, val]) => (
                      <div key={key}>
                        <p className="font-semibold capitalize mb-1">{key.replace("Score","")}</p>
                        <p className="text-muted-foreground">{val.action}</p>
                      </div>
                    ))}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
          <Link href={`/candidates/${record.candidateId}`}>
            <Button size="sm" variant="ghost" className="text-xs h-7 gap-1 group-hover:text-primary">
              View Profile <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ── Intelligence Summary Bar ─────────────────────────────────────────────── */
function SummaryBar({ records }: { records: IntelligenceRecord[] }) {
  const actions = records.map(r => r.nextBestAction).filter(Boolean) as string[];
  const actionCounts = actions.reduce((acc, a) => { acc[a] = (acc[a] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  const avgHp = records.reduce((s, r) => s + (r.hireProbability ?? 0), 0) / Math.max(records.length, 1);
  // "Ready to advance" gate — a hire-probability count cutoff, not a colour band.
  const READY_HP_MIN = 65;
  const ready = records.filter(r => (r.hireProbability ?? 0) >= READY_HP_MIN).length;
  const pal = usePalette();

  const kpis = [
    { label: "Avg Hire Prob.", value: `${Math.round(avgHp)}%`, dot: scoreHex(avgHp, pal), icon: Brain },
    { label: "Ready to Advance", value: String(ready),          dot: null, icon: CheckCircle2 },
    { label: "Total Ranked",     value: String(records.length), dot: null, icon: Target },
    {
      label: "Top Action",
      value: Object.entries(actionCounts).sort((a,b)=>b[1]-a[1])[0]?.[0]?.replace(/_/g," ") ?? "—",
      dot: null,
      icon: Zap,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {kpis.map(({ label, value, dot, icon: Icon }) => (
        <Card key={label} className="bg-card border-border/60">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 bg-muted border border-border">
                <Icon className="w-4 h-4 text-muted-foreground" />
              </div>
              <div>
                <p className="text-xs text-body dark:text-muted-foreground uppercase tracking-wider font-semibold">{label}</p>
                <p className="text-xl font-black capitalize text-foreground flex items-center gap-1.5">
                  {dot && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dot }} />}
                  {value}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* ── Main Panel ───────────────────────────────────────────────────────────── */
export function IntelligencePanel({
  jobId,
  candidates,
}: {
  jobId: string;
  candidates?: Array<{ id: string; firstName: string; lastName: string }>;
}) {
  const queryClient = useQueryClient();
  const pal = usePalette();
  const [activating, setActivating] = useState(false);
  const [activationProgress, setActivationProgress] = useState<{ done: number; total: number; current: string }>({ done: 0, total: 0, current: "" });

  const { data, isLoading } = useQuery({
    queryKey: ["intelligence", "job", jobId],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/intelligence/job/${jobId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json() as Promise<{ data: IntelligenceRecord[] }>;
    },
    refetchInterval: activating ? 3_000 : 30_000,
  });

  const computeOne = async (candidateId: string) => {
    const res = await fetch(`${API_BASE}/api/intelligence/compute`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ tenantId: "demo", jobId, candidateId, signals: {} }),
    });
    return res.json();
  };

  const handleActivateAll = async () => {
    if (!candidates?.length) return;
    setActivating(true);
    setActivationProgress({ done: 0, total: candidates.length, current: candidates[0].firstName });

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      setActivationProgress({ done: i, total: candidates.length, current: `${c.firstName} ${c.lastName}` });
      await computeOne(c.id);
      setActivationProgress({ done: i + 1, total: candidates.length, current: c.firstName });
    }

    await queryClient.invalidateQueries({ queryKey: ["intelligence", "job", jobId] });
    setActivating(false);
  };

  const records = data?.data ?? [];
  const candidateMap = Object.fromEntries((candidates ?? []).map(c => [c.id, `${c.firstName} ${c.lastName}`]));
  const hasCandidates = (candidates?.length ?? 0) > 0;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <div className="relative">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Brain className="w-8 h-8 text-primary animate-pulse" />
          </div>
          <div className="absolute -inset-2 rounded-3xl border-2 border-primary/20 animate-ping" />
        </div>
        <p className="text-sm text-muted-foreground">Loading intelligence records...</p>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="space-y-6 animate-in fade-in duration-500">
        {/* Activation card */}
        <Card className="border-primary/20 bg-gradient-to-br from-primary/5 via-card to-card overflow-hidden">
          <div className="h-1 w-full bg-gradient-to-r from-primary via-cyan-400 to-primary bg-[length:200%_100%] animate-[shimmer_2s_linear_infinite]" />
          <CardContent className="py-10 text-center">
            <div className="relative inline-flex mb-6">
              <div className="w-20 h-20 bg-primary/10 rounded-2xl border border-primary/25 flex items-center justify-center">
                <Brain className={cn("w-10 h-10 text-primary", activating && "animate-pulse")} />
              </div>
              {activating && (
                <div className="absolute -inset-2 rounded-3xl border-2 border-primary/30 animate-ping" />
              )}
            </div>

            {!activating ? (
              <>
                <h3 className="text-2xl font-bold mb-2">Intelligence Engine Ready</h3>
                <p className="text-muted-foreground max-w-sm mx-auto mb-8 text-sm leading-relaxed">
                  {hasCandidates
                    ? `Click below to run all ${candidates!.length} candidates through the Intelligence Engine. It scores each candidate on Fit, Quality, Verification, and Conversion — then tells you exactly what to do next.`
                    : "Add candidates to this work order first, then activate the Intelligence Engine to rank them automatically."}
                </p>

                {hasCandidates ? (
                  <div className="space-y-4">
                    <Button
                      size="lg"
                      onClick={handleActivateAll}
                      className="font-bold px-8 shadow-lg shadow-primary/20 hover-elevate gap-2"
                    >
                      <Brain className="w-5 h-5" />
                      Activate Intelligence Engine
                      <span className="ml-1 text-xs opacity-75 font-normal">({candidates!.length} candidates)</span>
                    </Button>

                    <div className="pt-2">
                      <p className="text-xs text-muted-foreground mb-3">Or run individually:</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        {candidates!.map(c => (
                          <Button
                            key={c.id}
                            size="sm"
                            variant="outline"
                            onClick={() => computeOne(c.id).then(() => queryClient.invalidateQueries({ queryKey: ["intelligence", "job", jobId] }))}
                            className="text-xs h-7 gap-1.5"
                          >
                            <Sparkles className="w-3 h-3" />
                            {c.firstName} {c.lastName}
                          </Button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap justify-center gap-2 mt-2">
                    {["Screening", "Interview", "Verification", "Proctoring", "Outreach", "Anti-Ghosting", "Scheduling"].map(a => (
                      <span key={a} className="px-3 py-1 rounded-full bg-primary/10 text-primary border border-primary/20 text-xs font-medium">{a}</span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              /* Running state */
              <div className="space-y-6 max-w-sm mx-auto">
                <div>
                  <h3 className="text-2xl font-bold mb-1">Running Intelligence Engine</h3>
                  <p className="text-sm text-muted-foreground">
                    Processing <span className="text-primary font-medium">{activationProgress.current}</span>
                  </p>
                </div>

                {/* Progress bar */}
                <div className="space-y-2">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{activationProgress.done} of {activationProgress.total} candidates</span>
                    <span>{Math.round((activationProgress.done / activationProgress.total) * 100)}%</span>
                  </div>
                  <div className="h-2 w-full rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${(activationProgress.done / activationProgress.total) * 100}%`,
                        background: `linear-gradient(to right, ${NEON.green}, ${NEON.cyan})`,
                        boxShadow: `0 0 10px ${NEON.cyan}88`,
                      }}
                    />
                  </div>
                </div>

                {/* Agent steps */}
                <div className="grid grid-cols-4 gap-2">
                  {["Fit", "Quality", "Verification", "Conversion"].map((step, i) => (
                    <div key={step} className="text-center">
                      <div className={cn(
                        "w-8 h-8 rounded-lg mx-auto mb-1 flex items-center justify-center text-xs font-bold border",
                        i < 2 ? "bg-primary/20 border-primary/40 text-primary" : "bg-muted border-border text-muted-foreground"
                      )}>
                        {i < 2 ? "✓" : "…"}
                      </div>
                      <p className="text-xs text-muted-foreground">{step}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* How it works */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { icon: Target, label: "Fit Score", desc: "ICP alignment, skills match, experience level" },
            { icon: TrendingUp, label: "Quality Score", desc: "Screening results, interview performance" },
            { icon: Shield, label: "Verification Score", desc: "Identity verification, proctoring integrity, fraud signals" },
            { icon: Zap, label: "Conversion Score", desc: "Outreach engagement, ghosting risk, scheduling" },
          ].map(({ icon: Icon, label, desc }) => (
            <Card key={label} className="bg-card/50 border-border/50">
              <CardContent className="p-4">
                <Icon className="w-5 h-5 text-primary mb-2" />
                <p className="text-sm font-semibold mb-1">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Brain className="w-5 h-5 text-primary" /> Hiring Intelligence
          </h3>
          <p className="text-sm text-body dark:text-muted-foreground">{pluralize(records.length, "candidate")} ranked by hire probability</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleActivateAll}
          disabled={activating || !hasCandidates}
          className="gap-1.5"
          title={hasCandidates ? "Re-run AI scoring for all candidates on this role" : "No candidates to score"}
        >
          <RefreshCw className={cn("w-3.5 h-3.5", activating && "animate-spin")} />
          {activating
            ? `Refreshing ${activationProgress.done}/${activationProgress.total}…`
            : "Refresh"}
        </Button>
      </div>

      {/* Summary */}
      <SummaryBar records={records} />

      {/* Score Legend */}
      <div className="flex items-center gap-5 text-xs font-semibold">
        <span className="flex items-center gap-1.5" style={{ color: pal.green }}>
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: pal.green, boxShadow: `0 0 6px ${pal.green}` }} /> ≥75 Strong
        </span>
        <span className="flex items-center gap-1.5" style={{ color: pal.yellow }}>
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: pal.yellow, boxShadow: `0 0 6px ${pal.yellow}` }} /> 55–74 Moderate
        </span>
        <span className="flex items-center gap-1.5" style={{ color: pal.pink }}>
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: pal.pink, boxShadow: `0 0 6px ${pal.pink}` }} /> &lt;55 Weak
        </span>
      </div>

      {/* Ranked Candidates */}
      <div className="space-y-4">
        {records.map((rec, i) => (
          <CandidateIntelligenceRow
            key={rec.id}
            record={rec}
            candidateName={candidateMap[rec.candidateId]}
            rank={i + 1}
          />
        ))}
      </div>
    </div>
  );
}
