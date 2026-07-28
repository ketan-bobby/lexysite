/**
 * pages/recruiter/analytics.tsx — Hiring Analytics Dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Tenant-level analytics: pipeline conversion rates, time-to-hire, source
 * attribution, outreach performance, and AI agent activity. Uses recharts
 * for bar/funnel charts and stat cards for headline KPIs.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   KPI Strip         — total candidates, active jobs, interview rate,
 *                       offer rate, time-to-hire (days)
 *   Hiring Funnel     — bar chart: candidates per stage
 *   Source Quality    — horizontal bar: hires by source channel
 *   AI Agent Activity — heatmap / bar: sourcing runs, screenings, messages sent
 *   Outreach Stats    — sent / opened / replied / interested / DNC rates
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useGetAnalyticsOverview() — GET /api/analytics/overview
 *   useGetHiringFunnel()      — GET /api/analytics/funnel
 *   useQuery(learning/source-quality)    — source breakdown
 *   useQuery(learning/score-correlation) — AI score vs outcome
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/analytics
 */
import { authHeaders } from "@/lib/api";
import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useGetAnalyticsOverview, useGetHiringFunnel } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { bandBy } from "@/lib/score-band";
import { useToast } from "@workspace/react-hooks/use-toast";
import { StatCard } from "@/components/ui-custom/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, PieChart, Pie, Cell, Legend, ScatterChart, Scatter,
  RadarChart, PolarGrid, PolarAngleAxis, Radar, ComposedChart, Area,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  Briefcase, Users, Video, Clock, TrendingUp, Award, BarChart3,
  PieChart as PieIcon, Activity, Brain, Target, Shield, Zap,
  AlertTriangle, CheckCircle2, UserCheck, ArrowUpRight, Lightbulb,
  RefreshCw, Loader2, Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const COLORS = ["hsl(239,84%,67%)", "hsl(160,84%,39%)", "hsl(30,80%,55%)", "hsl(280,65%,60%)", "hsl(340,75%,55%)", "hsl(200,80%,55%)"];

/* ── Overview data hooks ──────────────────────────────────────────────────── */
// Source hire-rate band (a hire-rate %; own cutoffs, not the 0–100 match/fit band).
const HIRE_RATE_STRONG = 30, HIRE_RATE_MODERATE = 15;
function useHiringTrend() {
  return useQuery({
    queryKey: ["analytics", "trend"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/analytics/trend`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

function useScoreDistribution() {
  return useQuery({
    queryKey: ["analytics", "score-distribution"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/analytics/score-distribution`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

/* ── Calibration hooks ────────────────────────────────────────────────────── */
function useLearningInsights() {
  return useQuery({
    queryKey: ["learning", "insights"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence/outcomes/learning`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

/* Aggregate diversity for sourcing-equity. Always k-anonymised server-side
 * (small buckets collapsed to "not_enough_data"). NEVER joins individual
 * demographics into the recruiter UI. */
function useDiversity() {
  return useQuery({
    queryKey: ["analytics", "diversity"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/analytics/diversity`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

function useSourceQuality() {
  return useQuery({
    queryKey: ["learning", "source-quality"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/learning/source-quality`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

function useScoreCorrelation() {
  return useQuery({
    queryKey: ["learning", "score-correlation"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/learning/score-correlation`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

function useAgentCoverage() {
  return useQuery({
    queryKey: ["learning", "agent-coverage"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/learning/agent-coverage`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

function useRecommendations() {
  return useQuery({
    queryKey: ["learning", "recommendations"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/learning/recommendations`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

function usePredictedVsActual() {
  return useQuery({
    queryKey: ["learning", "predicted-vs-actual"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/learning/predicted-vs-actual`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
    staleTime: 60_000,
  });
}

/* ── Metric card ──────────────────────────────────────────────────────────── */
function MetricCard({
  label, value, sub, icon: Icon, color = "#22d3ee",
}: {
  label: string; value: string | number; sub?: string;
  icon: React.ElementType; color?: string;
}) {
  return (
    <Card className="border-border/50 overflow-hidden">
      <div className="h-0.5 w-full" style={{ background: color, boxShadow: `0 0 8px ${color}66` }} />
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: `${color}18`, border: `1px solid ${color}44` }}>
            <Icon className="w-4 h-4" style={{ color }} />
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">{label}</p>
            <p className="text-xl font-black" style={{ color }}>{value}</p>
            {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Diversity helpers ────────────────────────────────────────────────────── */
function prettyBucket(label: string): string {
  if (label === "not_enough_data") return "Not enough data";
  if (label === "prefer_not_to_say") return "Prefer not to say";
  if (label === "protected_veteran") return "Protected veteran";
  if (label === "not_veteran") return "Not a veteran";
  if (label === "non_binary") return "Non-binary";
  if (label === "self_describe") return "Self-described";
  return label.charAt(0).toUpperCase() + label.slice(1).replace(/_/g, " ");
}

function DiversityBuckets({ title, buckets, total }: { title: string; buckets: Array<{ label: string; count: number }>; total: number }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{title}</div>
      {buckets.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No responses yet.</p>
      ) : (
        <div className="space-y-1.5">
          {buckets.map((b) => {
            const pct = total > 0 ? Math.round((b.count / total) * 100) : 0;
            const isAnon = b.label === "not_enough_data";
            return (
              <div key={b.label} className={isAnon ? "opacity-60" : ""}>
                <div className="flex items-center justify-between text-xs">
                  <span>{prettyBucket(b.label)}</span>
                  <span className="text-muted-foreground">{isAnon ? `~${b.count}` : `${b.count} · ${pct}%`}</span>
                </div>
                <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mt-0.5">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${pct}%`, background: isAnon ? "hsl(var(--muted-foreground))" : "hsl(var(--primary))" }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Calibration tab ──────────────────────────────────────────────────────── */
function CalibrationTab() {
  const { data: insights, isLoading: loadingInsights } = useLearningInsights();
  const { data: sourceData } = useSourceQuality();
  const { data: correlationData } = useScoreCorrelation();
  const { data: coverageData } = useAgentCoverage();
  const { data: recsData } = useRecommendations();
  const { data: predictedData } = usePredictedVsActual();
  const { data: diversityData } = useDiversity();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [appliedRecs, setAppliedRecs] = useState<Set<number>>(new Set());

  const applyMutation = useMutation({
    mutationFn: async ({ rec, idx }: { rec: any; idx: number }) => {
      const title = (rec.title ?? "").toLowerCase();
      let policyUpdate: Record<string, any> = {};
      let description = "";

      if (title.includes("override") || title.includes("threshold")) {
        policyUpdate = { advanceThreshold: 75, scheduleThreshold: 60 };
        description = "Lowered advance threshold to 75 and schedule threshold to 60 to reduce override pressure.";
      } else if (title.includes("screening") || title.includes("coverage") || title.includes("interview")) {
        policyUpdate = { lowConfidenceAction: "hold" };
        description = "Policy updated: candidates with missing screening/interview signals will be held automatically.";
      } else if (title.includes("source") || title.includes("quality")) {
        description = "Recommendation logged. Prioritize referral and LinkedIn sources when sourcing new candidates for this role.";
      } else {
        description = "Recommendation applied. Monitor the pipeline over the next 7 days for improvement.";
      }

      if (Object.keys(policyUpdate).length > 0) {
        const res = await fetch(`${BASE}/api/intelligence/policies/demo`, {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ policyJson: policyUpdate, label: `Applied from recommendation: ${rec.title}` }),
        });
        if (!res.ok) throw new Error("Policy update failed");
      }

      return { idx, description };
    },
    onSuccess: ({ idx, description }) => {
      setAppliedRecs(prev => new Set([...prev, idx]));
      queryClient.invalidateQueries({ queryKey: ["learning"] });
      toast({ title: "Recommendation applied", description });
    },
    onError: () => {
      toast({ title: "Failed to apply recommendation", variant: "destructive" });
    },
  });

  const learning = insights?.data;
  const sources  = (sourceData?.data ?? []) as any[];
  const corr     = correlationData?.data;
  const coverage = (coverageData?.data ?? []) as any[];
  const recs     = (recsData?.data?.recommendations ?? []) as any[];
  const pvActual = predictedData?.data;

  const corrEntries = corr?.correlations
    ? Object.entries(corr.correlations as Record<string, { r: number; label: string }>)
        .sort((a, b) => Math.abs((b[1] as any).r) - Math.abs((a[1] as any).r))
        .map(([key, v]) => ({ dimension: (v as any).label, r: (v as any).r, absR: Math.abs((v as any).r) }))
    : [];

  const overrideRate = learning?.overrideRate ?? 0;

  const NEON = {
    green: "#4ade80", cyan: "#22d3ee", yellow: "#facc15",
    orange: "#fb923c", purple: "#a78bfa", pink: "#fb7185",
  };

  const priorityColor: Record<string, string> = {
    high: "#fb7185", medium: "#facc15", low: "#22d3ee",
  };

  if (loadingInsights) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground">
        <Brain className="w-5 h-5 animate-pulse text-primary" />
        <span>Loading calibration data…</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── KPI row ──────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Model Precision"
          value={learning?.precisionScore != null ? `${Math.round(learning.precisionScore * 100)}%` : "—"}
          sub="Predicted hires that were hired"
          icon={Target}
          color={NEON.green}
        />
        <MetricCard
          label="Recall"
          value={learning?.recallScore != null ? `${Math.round(learning.recallScore * 100)}%` : "—"}
          sub="Actual hires that were predicted"
          icon={CheckCircle2}
          color={NEON.cyan}
        />
        <MetricCard
          label="Calibration Drift"
          value={learning?.calibrationDrift != null ? `${(learning.calibrationDrift * 100).toFixed(1)}%` : "—"}
          sub="Avg gap between predicted & actual"
          icon={Activity}
          color={learning?.calibrationDrift > 0.1 ? NEON.orange : NEON.green}
        />
        <MetricCard
          label="Override Rate"
          value={`${Math.round((overrideRate ?? 0) * 100)}%`}
          sub="Recruiter overrides AI decisions"
          icon={UserCheck}
          color={overrideRate > 0.2 ? NEON.yellow : NEON.green}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Score-Outcome Correlation ──────────────────────────────────── */}
        {corrEntries.length > 0 ? (
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                <TrendingUp className="w-4 h-4 text-primary" />
                Score Correlation with Hire Outcomes
                {corr?.sampleSize > 0 && (
                  <Badge variant="outline" className="text-xs ml-auto">{corr.sampleSize} outcomes</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={corrEntries} layout="vertical" margin={{ left: 20, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                  <XAxis type="number" domain={[-1, 1]} axisLine={false} tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <YAxis type="category" dataKey="dimension" axisLine={false} tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} width={100} />
                  <Tooltip
                    contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))", background: "hsl(var(--card))" }}
                    formatter={(v: any) => [`r = ${v.toFixed(3)}`, "Pearson r"]}
                  />
                  <Bar dataKey="r" radius={[0, 4, 4, 0]} maxBarSize={20}
                    fill={NEON.cyan}
                    label={{ position: "right", fontSize: 10, fill: "hsl(var(--muted-foreground))", formatter: (v: number) => v.toFixed(2) }}
                  />
                </BarChart>
              </ResponsiveContainer>
              {corr?.strongestPredictor && (
                <p className="text-xs text-muted-foreground mt-2 text-center">
                  Strongest predictor: <span className="text-primary font-semibold">{corr.strongestPredictor}</span>
                </p>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/50 flex items-center justify-center min-h-[240px]">
            <div className="text-center p-6">
              <TrendingUp className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Score correlation will appear once outcome data is recorded.</p>
            </div>
          </Card>
        )}

        {/* ── Source Quality ────────────────────────────────────────────── */}
        {sources.length > 0 ? (
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                <PieIcon className="w-4 h-4 text-primary" /> Source Quality by Outcome
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {sources.slice(0, 5).map((src: any) => (
                  <div key={src.source} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium capitalize">{src.source.replace(/_/g, " ")}</span>
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <span>{src.total} candidates</span>
                        <span className="font-bold" style={{ color: (src.hireRate ?? 0) >= HIRE_RATE_STRONG ? NEON.green : (src.hireRate ?? 0) >= HIRE_RATE_MODERATE ? NEON.yellow : NEON.pink }}>
                          {src.hireRate != null ? `${src.hireRate}% hired` : "No outcomes"}
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{
                          width: `${src.avgHireProbability}%`,
                          background: src.avgHireProbability >= HIRE_PROB_STRONG ? NEON.green : src.avgHireProbability >= HIRE_PROB_MODERATE ? NEON.yellow : NEON.pink,
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
                <PieIcon className="w-4 h-4 text-primary" /> Source Quality by Outcome
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-center min-h-[160px]">
                <p className="text-sm text-muted-foreground text-center">Source quality data will appear once candidates enter the pipeline.</p>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* ── Sourcing Diversity (aggregate, k-anonymity ≥ 5) ─────────────────
            Aggregate ONLY. The server collapses any bucket with fewer than
            5 candidates into "Not enough data" so individuals can never be
            re-identified. Individual demographic records are never exposed
            in any recruiter UI by design. */}
      <Card className="border-border/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PieIcon className="w-5 h-5 text-primary" /> Sourcing Diversity
            <Badge variant="outline" className="ml-2 text-[10px] uppercase tracking-wider">
              Aggregate · k ≥ {(diversityData?.kThreshold ?? 5)}
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground pt-1">
            Voluntary candidate self-identification, anonymised. Small buckets are collapsed to <em>Not enough data</em> to protect individual privacy. Used for sourcing equity only — never for hiring decisions.
          </p>
          <p className="text-[11px] text-muted-foreground/70 pt-1">
            Population: all candidates in scope with disclosed demographics (candidate-level, not filtered by application entry type).
            {(diversityData?.total ?? 0) > 0 && (
              <> {diversityData?.total} of these have self-identified.</>
            )}
          </p>
        </CardHeader>
        <CardContent>
          {(diversityData?.total ?? 0) < (diversityData?.kThreshold ?? 5) ? (
            <div className="text-center py-10 text-sm text-muted-foreground border border-dashed border-border/60 rounded-lg">
              Not enough candidates have completed voluntary self-identification yet.
              <br />
              Aggregate diversity reporting unlocks at {(diversityData?.kThreshold ?? 5)} disclosures.
            </div>
          ) : (
            <div className="space-y-6">
              <div className="text-xs text-muted-foreground">
                Based on {diversityData?.total} candidates who chose to self-identify.
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <DiversityBuckets title="Gender" buckets={diversityData?.gender ?? []} total={diversityData?.total ?? 0} />
                <DiversityBuckets title="Race / Ethnicity" buckets={diversityData?.raceEthnicity ?? []} total={diversityData?.total ?? 0} />
                <DiversityBuckets title="Veteran status" buckets={diversityData?.veteranStatus ?? []} total={diversityData?.total ?? 0} />
                <DiversityBuckets title="Disability status" buckets={diversityData?.disabilityStatus ?? []} total={diversityData?.total ?? 0} />
              </div>
              {(diversityData?.bySource?.length ?? 0) > 0 && (
                <div className="pt-4 border-t border-border/40">
                  <p className="text-sm font-semibold mb-3">Gender mix by sourcing channel</p>
                  <div className="space-y-2">
                    {(diversityData?.bySource ?? []).slice(0, 6).map((s: any) => (
                      <div key={s.source} className="flex items-center justify-between text-xs">
                        <span className="font-medium capitalize">{String(s.source).replace(/_/g, " ")}</span>
                        <div className="flex gap-2 text-muted-foreground">
                          <span>{s.total} disclosed</span>
                          <span className="text-foreground/80">
                            {(s.gender ?? []).map((g: any) => `${prettyBucket(g.label)} ${g.count}`).join(" · ")}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Agent Coverage Impact ─────────────────────────────────────────── */}
      {coverage.length > 0 && (
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
              <Brain className="w-4 h-4 text-primary" /> Agent Signal Coverage & Impact
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
              {coverage.slice(0, 9).map((agent: any) => {
                const cov = agent.coverageRate;
                const covHex = cov >= COVERAGE_STRONG ? NEON.green : cov >= COVERAGE_MODERATE ? NEON.yellow : NEON.pink;
                return (
                  <div key={agent.agent} className="p-3 rounded-xl bg-white/3 border border-white/8 space-y-2">
                    <p className="text-xs font-semibold capitalize">{agent.agent.replace(/([A-Z])/g, ' $1')}</p>
                    <div className="flex items-end justify-between">
                      <span className="text-xl font-black tabular-nums" style={{ color: covHex }}>{cov}%</span>
                      {agent.impact != null && (
                        <span className={cn("text-xs font-bold", agent.impact > 0 ? "text-emerald-400" : "text-rose-400")}>
                          {agent.impact > 0 ? "+" : ""}{agent.impact}hp
                        </span>
                      )}
                    </div>
                    <div className="h-1 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${cov}%`, background: covHex }} />
                    </div>
                    <p className="text-[10px] text-muted-foreground">{agent.countWith}/{agent.countWith + agent.countWithout} covered</p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Override Quality ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
              <UserCheck className="w-4 h-4 text-primary" /> Override & Outcome Rates
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {learning ? (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 rounded-xl bg-white/3 border border-white/8 text-center">
                    <p className="text-2xl font-black" style={{ color: overrideRate > 0.2 ? NEON.yellow : NEON.green }}>
                      {Math.round(overrideRate * 100)}%
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-1">Override Rate</p>
                  </div>
                  <div className="p-3 rounded-xl bg-white/3 border border-white/8 text-center">
                    <p className="text-2xl font-black" style={{ color: (learning.overrideAccuracyRate ?? 0) > 0.7 ? NEON.green : NEON.yellow }}>
                      {learning.overrideAccuracyRate != null ? `${Math.round(learning.overrideAccuracyRate * 100)}%` : "—"}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-1">Override Accuracy</p>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Total outcomes analyzed</span>
                    <span className="font-bold">{learning.totalOutcomes ?? 0}</span>
                  </div>
                  {learning.byOutcome && Object.entries(learning.byOutcome as Record<string, number>).map(([outcome, count]) => (
                    <div key={outcome} className="flex justify-between items-center text-xs">
                      <span className="text-muted-foreground capitalize">{outcome.replace(/_/g, " ")}</span>
                      <Badge variant="outline" className="text-xs">{String(count)}</Badge>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center min-h-[120px]">
                <p className="text-sm text-muted-foreground">No outcome data yet.</p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Closed-Loop Recommendations ──────────────────────────────── */}
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
              <Lightbulb className="w-4 h-4 text-primary" /> Learning Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recs.length === 0 ? (
              <div className="flex items-center justify-center min-h-[120px]">
                <p className="text-sm text-muted-foreground text-center">
                  Recommendations appear after candidates enter the pipeline.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {recs.slice(0, 5).map((rec: any, i: number) => {
                  const applied = appliedRecs.has(i);
                  const isApplying = applyMutation.isPending && (applyMutation.variables as any)?.idx === i;
                  return (
                    <div key={i} className={cn(
                      "p-3 rounded-xl border space-y-2 transition-all",
                      applied ? "bg-emerald-500/5 border-emerald-500/20" : "bg-white/3 border-white/8",
                    )}>
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold">{rec.title}</p>
                        <Badge
                          variant="outline"
                          className="text-[10px] shrink-0"
                          style={{ color: priorityColor[rec.priority], borderColor: `${priorityColor[rec.priority]}40` }}
                        >
                          {rec.priority}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground">{rec.description}</p>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-start gap-1.5 text-[11px] text-primary">
                          <ArrowUpRight className="w-3 h-3 mt-0.5 shrink-0" />
                          {rec.suggestedAction}
                        </div>
                        {applied ? (
                          <span className="text-[10px] text-emerald-400 flex items-center gap-1 shrink-0">
                            <CheckCircle2 className="w-3 h-3" /> Applied
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 text-[10px] shrink-0 gap-1 border-primary/30 text-primary hover:bg-primary/10"
                            onClick={() => applyMutation.mutate({ rec, idx: i })}
                            disabled={isApplying}
                          >
                            {isApplying ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Wrench className="w-2.5 h-2.5" />}
                            Apply
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ── Main Analytics Page ──────────────────────────────────────────────────── */
/* ── Outcome label coverage ───────────────────────────────────────────────── */
type Coverage = {
  hires: number;
  hiresWithQuality: number;
  qualityCoveragePct: number;
  avgHireQualityScore: number | null;
  pulse30Sent: number;
  pulse30Responded: number;
  pulse90Sent: number;
  pulse90Responded: number;
  outcomes: { hired: number; rejected: number; withdrawn: number; ghosted: number };
};

function useOutcomeCoverage() {
  return useQuery<Coverage>({
    queryKey: ["outcomes", "coverage"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/outcomes/coverage`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to load coverage");
      return res.json();
    },
  });
}

function OutcomeCoverageCard() {
  const { data, isLoading } = useOutcomeCoverage();
  const pulsesSent = (data?.pulse30Sent ?? 0) + (data?.pulse90Sent ?? 0);
  const pulsesResponded = (data?.pulse30Responded ?? 0) + (data?.pulse90Responded ?? 0);
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="w-5 h-5 text-primary" /> Outcome Label Coverage
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <p className="text-2xl font-bold">{data?.hires ?? 0}</p>
                <p className="text-xs text-muted-foreground">Hires labeled</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{data?.qualityCoveragePct ?? 0}%</p>
                <p className="text-xs text-muted-foreground">
                  Hires with quality data ({data?.hiresWithQuality ?? 0}/{data?.hires ?? 0})
                </p>
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {data?.avgHireQualityScore != null ? data.avgHireQualityScore : "—"}
                </p>
                <p className="text-xs text-muted-foreground">Avg quality of hire (0–100)</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{pulsesResponded}/{pulsesSent}</p>
                <p className="text-xs text-muted-foreground">Pulses responded / sent</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">Hired {data?.outcomes.hired ?? 0}</Badge>
              <Badge variant="secondary">Rejected {data?.outcomes.rejected ?? 0}</Badge>
              <Badge variant="secondary">Withdrawn {data?.outcomes.withdrawn ?? 0}</Badge>
              <Badge variant="secondary">Ghosted {data?.outcomes.ghosted ?? 0}</Badge>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Team Performance ─────────────────────────────────────────────────────── */
interface RecruiterRow {
  recruiterId: string; name: string; email: string; role: string;
  candidatesManaged: number; submitted: number; interviews: number;
  hmInterviews: number; offers: number; hires: number; placementsValue: number;
  avgTimeToSubmitDays: number | null;
  sla: { firstReviewDays: number | null; reviewToSubmitDays: number | null };
  aging: { over24h: number; over3d: number; staleReqs: number };
  workload: { openReqs: number; inPipeline: number; awaitingReview: number };
  conversion: { submitToHm: number | null; hmToOffer: number | null; offerToHire: number | null; overallHire: number | null };
  productivityScore: number | null;
  trendPct: number | null;
  rank: number;
}
interface PerformanceResponse {
  scope: string; selfRecruiterId: string; cohortSize: number; generatedAt: string;
  team: {
    recruitersActive: number; totalCandidates: number; totalSubmitted: number;
    totalInterviews: number; totalOffers: number; totalHires: number; placementsValue: number;
    avgTimeToSubmitDays: number | null; avgProductivityScore: number | null;
    avgSubmitToHm: number | null; avgHmToOffer: number | null; avgOfferToHire: number | null;
  };
  recruiters: RecruiterRow[];
}

function useRecruiterPerformance() {
  return useQuery<PerformanceResponse>({
    queryKey: ["analytics", "recruiter-performance"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/analytics/recruiter-performance`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to load recruiter performance");
      return res.json();
    },
    staleTime: 60_000,
  });
}

/* Format helpers: render null as an em-dash, never a fake 0. */
const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${Math.round(v)}%`);
const fmtDays = (v: number | null | undefined) => (v == null ? "—" : `${v}d`);
const fmtScore = (v: number | null | undefined) => (v == null ? "—" : String(Math.round(v)));
const fmtMoney = (v: number | null | undefined) =>
  v == null || v === 0 ? "—" : `$${Math.round(v).toLocaleString()}`;

// Source hire-probability band — a predicted-outcome quantity, not match fit;
// any equality with a match cutoff is coincidental, not a dependency.
const HIRE_PROB_STRONG = 70;
const HIRE_PROB_MODERATE = 55;
// Agent signal-coverage band — a data-completeness quantity, not a score.
const COVERAGE_STRONG = 70;
const COVERAGE_MODERATE = 40;

function scoreColor(score: number | null): string {
  if (score == null) return "text-muted-foreground";
  return bandBy(score, { strong: "text-emerald-400", good: "text-amber-400", fair: "text-rose-400" });
}

function TeamPerformanceTab() {
  const { data, isLoading, isError } = useRecruiterPerformance();
  const isSelfView = data?.scope === "self";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[300px] text-muted-foreground gap-2">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading team performance…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center h-[300px] text-muted-foreground gap-3">
        <AlertTriangle className="w-10 h-10 opacity-30" />
        <p className="text-sm">Could not load team performance right now.</p>
      </div>
    );
  }

  const team = data!.team;
  const rows = data!.recruiters;
  const self = rows.find(r => r.recruiterId === data!.selfRecruiterId) ?? null;

  /* Benchmark deltas for the self-view (you vs team average). */
  const benchmark = isSelfView && self
    ? [
        { label: "Productivity Score", you: self.productivityScore, team: team.avgProductivityScore, fmt: fmtScore, higherBetter: true },
        { label: "Time to Submit", you: self.avgTimeToSubmitDays, team: team.avgTimeToSubmitDays, fmt: fmtDays, higherBetter: false },
        { label: "Submit → HM", you: self.conversion.submitToHm, team: team.avgSubmitToHm, fmt: fmtPct, higherBetter: true },
        { label: "HM → Offer", you: self.conversion.hmToOffer, team: team.avgHmToOffer, fmt: fmtPct, higherBetter: true },
        { label: "Offer → Hire", you: self.conversion.offerToHire, team: team.avgOfferToHire, fmt: fmtPct, higherBetter: true },
      ]
    : [];

  /* Leaderboard chart data (admins only). */
  const leaderboardData = rows
    .filter(r => r.productivityScore != null)
    .slice(0, 12)
    .map(r => ({ name: r.name.split(" ")[0], score: r.productivityScore }));

  return (
    <>
      {/* Exec cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {isSelfView ? (
          <>
            <StatCard
              title="Your Productivity"
              value={fmtScore(self?.productivityScore)}
              icon={<Zap className="w-5 h-5" />}
              description={self?.rank ? `Rank #${self.rank} of ${data!.cohortSize}` : "No ranking yet"}
              glowColor="bg-amber-500/40"
              trend={self?.trendPct != null ? { value: self.trendPct, isPositive: self.trendPct >= 0 } : undefined}
            />
            <StatCard title="Candidates Managed" value={self?.candidatesManaged ?? 0} icon={<Users className="w-5 h-5" />} />
            <StatCard title="Submitted to HM" value={self?.submitted ?? 0} icon={<UserCheck className="w-5 h-5" />} />
            <StatCard title="Hires" value={self?.hires ?? 0} icon={<Award className="w-5 h-5" />} description={fmtMoney(self?.placementsValue) + " placed"} />
          </>
        ) : (
          <>
            <StatCard title="Active Recruiters" value={team.recruitersActive} icon={<Users className="w-5 h-5" />} description={`${data!.cohortSize} in scope`} />
            <StatCard title="Total Submitted" value={team.totalSubmitted} icon={<UserCheck className="w-5 h-5" />} />
            <StatCard title="Placements" value={team.totalHires} icon={<Award className="w-5 h-5" />} description={fmtMoney(team.placementsValue) + " placed"} glowColor="bg-emerald-500/40" />
            <StatCard title="Avg Productivity" value={fmtScore(team.avgProductivityScore)} icon={<Zap className="w-5 h-5" />} glowColor="bg-amber-500/40" />
          </>
        )}
      </div>

      {/* Benchmark (self-view) */}
      {isSelfView && self && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Target className="w-5 h-5 text-primary" /> You vs Team Average</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {benchmark.map(b => {
                const beats = b.you != null && b.team != null
                  ? (b.higherBetter ? b.you >= b.team : b.you <= b.team)
                  : null;
                return (
                  <div key={b.label} className="rounded-xl border border-border/50 bg-muted/20 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{b.label}</p>
                    <div className="mt-2 flex items-baseline gap-2">
                      <span className={cn("text-2xl font-bold", beats === null ? "text-foreground" : beats ? "text-emerald-400" : "text-rose-400")}>
                        {b.fmt(b.you)}
                      </span>
                      {beats !== null && (beats
                        ? <ArrowUpRight className="w-4 h-4 text-emerald-400" />
                        : <ArrowUpRight className="w-4 h-4 text-rose-400 rotate-90" />)}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Team avg {b.fmt(b.team)}</p>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Leaderboard chart (admins) */}
      {!isSelfView && leaderboardData.length > 0 && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><BarChart3 className="w-5 h-5 text-primary" /> Productivity Leaderboard</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={Math.max(220, leaderboardData.length * 34)}>
              <BarChart data={leaderboardData} layout="vertical" margin={{ top: 4, right: 24, left: 12, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
                <XAxis type="number" domain={[0, 100]} axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                <YAxis type="category" dataKey="name" width={80} axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))" }} />
                <Bar dataKey="score" radius={[0, 6, 6, 0]} maxBarSize={26}>
                  {leaderboardData.map((d, i) => (
                    <Cell key={i} fill={bandBy(d.score ?? 0, { strong: "hsl(160,84%,39%)", good: "hsl(30,80%,55%)", fair: "hsl(340,75%,55%)" })} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Recruiter detail table */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-primary" />
            {isSelfView ? "Your Performance" : "Recruiter Performance"}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-[200px] text-muted-foreground gap-3">
              <Users className="w-10 h-10 opacity-30" />
              <p className="text-sm">No recruiter activity in scope yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {!isSelfView && <TableHead className="w-10">#</TableHead>}
                    <TableHead>Recruiter</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                    <TableHead className="text-right">Candidates</TableHead>
                    <TableHead className="text-right">Submitted</TableHead>
                    <TableHead className="text-right">Interviews</TableHead>
                    <TableHead className="text-right">Offers</TableHead>
                    <TableHead className="text-right">Hires</TableHead>
                    <TableHead className="text-right">Time→Submit</TableHead>
                    <TableHead className="text-right">Submit→HM</TableHead>
                    <TableHead className="text-right">Offer→Hire</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(r => (
                    <TableRow key={r.recruiterId} className={r.recruiterId === data!.selfRecruiterId ? "bg-primary/5" : undefined}>
                      {!isSelfView && <TableCell className="text-muted-foreground tabular-nums">{r.rank}</TableCell>}
                      <TableCell>
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">{r.role === "recruiter_admin" ? "Recruiter Admin" : "Recruiter"}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <span className={cn("font-bold tabular-nums", scoreColor(r.productivityScore))}>{fmtScore(r.productivityScore)}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.candidatesManaged}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.submitted}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.interviews}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.offers}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.hires}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtDays(r.avgTimeToSubmitDays)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtPct(r.conversion.submitToHm)}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtPct(r.conversion.offerToHire)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* SLA & aging alerts + workload */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><AlertTriangle className="w-5 h-5 text-amber-400" /> Speed & Aging Alerts</CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No data yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recruiter</TableHead>
                    <TableHead className="text-right">First Review</TableHead>
                    <TableHead className="text-right">&gt;24h</TableHead>
                    <TableHead className="text-right">&gt;3d</TableHead>
                    <TableHead className="text-right">Stale Reqs</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(r => (
                    <TableRow key={r.recruiterId} className={r.recruiterId === data!.selfRecruiterId ? "bg-primary/5" : undefined}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{fmtDays(r.sla.firstReviewDays)}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", r.aging.over24h > 0 ? "text-amber-400" : "text-muted-foreground")}>{r.aging.over24h}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", r.aging.over3d > 0 ? "text-rose-400" : "text-muted-foreground")}>{r.aging.over3d}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", r.aging.staleReqs > 0 ? "text-rose-400" : "text-muted-foreground")}>{r.aging.staleReqs}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Activity className="w-5 h-5 text-primary" /> Workload & Capacity</CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No data yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recruiter</TableHead>
                    <TableHead className="text-right">Open Reqs</TableHead>
                    <TableHead className="text-right">In Pipeline</TableHead>
                    <TableHead className="text-right">Awaiting Review</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(r => (
                    <TableRow key={r.recruiterId} className={r.recruiterId === data!.selfRecruiterId ? "bg-primary/5" : undefined}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.workload.openReqs}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.workload.inPipeline}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", r.workload.awaitingReview > 0 ? "text-amber-400" : "text-muted-foreground")}>{r.workload.awaitingReview}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quality of hire — labeled placeholder (data accrues over time) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Shield className="w-5 h-5 text-primary" /> Quality of Hire (180 / 365-day)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Clock className="w-5 h-5 opacity-50 shrink-0" />
            <p>Long-horizon retention and quality-of-hire signals (180 &amp; 365-day) accrue as placements mature. They will populate here once hires reach those milestones.</p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

export default function Analytics() {
  const { data: overview } = useGetAnalyticsOverview();
  const { data: funnelData } = useGetHiringFunnel({});
  const { data: trendData } = useHiringTrend();
  const { data: scoreData } = useScoreDistribution();
  const [activeTab, setActiveTab] = useState<"overview" | "team" | "calibration">("overview");

  // Transform real API data into chart-ready arrays
  const funnelChartData = (funnelData?.stages ?? []).map((s: any) => ({
    name: s.stage, value: s.count,
  }));

  const sourceChartData = (overview?.topSources ?? []).map((s: any) => ({
    name: s.source || "Other", value: s.count,
  }));

  const trendChartData: any[] = trendData?.trend ?? [];

  const scoreChartData: any[] = scoreData?.distribution ?? [];

  const hasNoData = funnelChartData.every((d: any) => d.value === 0);

  return (
    <AppLayout>
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="page-title">Analytics</h1>
          <p className="text-muted-foreground mt-1">Hiring performance, AI calibration, and closed-loop learning.</p>
        </div>
        <div className="flex gap-1 bg-muted/30 p-1 rounded-xl border border-border/50">
          {(["overview", "team", "calibration"] as const).map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-1.5 rounded-lg text-sm font-medium transition-all capitalize",
                activeTab === tab ? "bg-primary/20 text-primary border border-primary/30" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab === "calibration" ? "AI Calibration" : tab === "team" ? "Team Performance" : "Overview"}
            </button>
          ))}
        </div>
      </div>

      {activeTab === "overview" ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <StatCard title="Active Work Orders" value={overview?.activeJobs ?? 0} icon={<Briefcase className="w-5 h-5" />} />
            <StatCard title="Total Candidates" value={overview?.totalCandidates ?? 0} icon={<Users className="w-5 h-5" />} />
            <StatCard title="Interviews Done" value={overview?.interviewsCompleted ?? 0} icon={<Clock className="w-5 h-5" />} />
            <StatCard title="Total Applications" value={overview?.totalApplications ?? 0} icon={<Award className="w-5 h-5" />} />
          </div>

          <OutcomeCoverageCard />


          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
            <Card className="lg:col-span-2">
              <CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="w-5 h-5 text-primary" /> Hiring Funnel</CardTitle></CardHeader>
              <CardContent>
                {hasNoData ? (
                  <div className="flex flex-col items-center justify-center h-[280px] text-muted-foreground gap-3">
                    <BarChart3 className="w-10 h-10 opacity-30" />
                    <p className="text-sm">No pipeline data yet. Add candidates to jobs to see the funnel.</p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={funnelChartData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))" }} />
                      <Bar dataKey="value" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} maxBarSize={56} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><PieIcon className="w-5 h-5 text-primary" /> Candidate Sources</CardTitle></CardHeader>
              <CardContent>
                {sourceChartData.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-[280px] text-muted-foreground gap-3">
                    <PieIcon className="w-10 h-10 opacity-30" />
                    <p className="text-sm text-center">Source data appears once candidates are added.</p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie data={sourceChartData} cx="50%" cy="45%" innerRadius={55} outerRadius={90} paddingAngle={3} dataKey="value">
                        {sourceChartData.map((_: any, i: number) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="w-5 h-5 text-primary" /> Hiring Trend (6 months)</CardTitle></CardHeader>
              <CardContent>
                {trendChartData.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-[220px] text-muted-foreground gap-3">
                    <Activity className="w-10 h-10 opacity-30" />
                    <p className="text-sm">Trend data loads as activity builds.</p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={trendChartData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))" }} />
                      <Line type="monotone" dataKey="hires" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ fill: "hsl(var(--primary))", strokeWidth: 0, r: 4 }} name="Hires" />
                      <Line type="monotone" dataKey="interviews" stroke="hsl(160,84%,39%)" strokeWidth={2} dot={{ fill: "hsl(160,84%,39%)", strokeWidth: 0, r: 4 }} name="Interviews" />
                      <Line type="monotone" dataKey="applications" stroke="hsl(30,80%,55%)" strokeWidth={2} dot={{ fill: "hsl(30,80%,55%)", strokeWidth: 0, r: 4 }} name="Applications" />
                      <Legend />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-5 h-5 text-primary" /> Interview Score Distribution
                  {scoreData?.total > 0 && (
                    <Badge variant="outline" className="text-xs ml-auto">{scoreData.total} interviews</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!scoreData?.total ? (
                  <div className="flex flex-col items-center justify-center h-[220px] text-muted-foreground gap-3">
                    <TrendingUp className="w-10 h-10 opacity-30" />
                    <p className="text-sm">Score distribution appears after interviews are completed.</p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={scoreChartData} margin={{ top: 10, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="range" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
                      <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid hsl(var(--border))" }} />
                      <Bar dataKey="count" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} maxBarSize={48} name="Candidates" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : activeTab === "team" ? (
        <TeamPerformanceTab />
      ) : (
        <CalibrationTab />
      )}
    </AppLayout>
  );
}
