/**
 * components/intelligence/ExecutiveJobView.tsx — Hiring-Leader Job Summary
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * A high-level executive dashboard for a single job requisition. Intended for
 * hiring managers and executives who need a quick read on pipeline health
 * without diving into individual candidate cards.
 *
 * ─── Sections rendered ───────────────────────────────────────────────────────
 *   Decision funnel     — decision-ready / blocked / missing-signal candidate counts
 *   Source performance  — breakdown of candidates by sourcing channel
 *   Pipeline bottlenecks— which agents are holding the most candidates
 *   Forecast outcomes   — predicted hires, time-to-fill, and fill probability
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/intelligence/job/:jobId/executive  — aggregated job-level intel
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/intelligence/IntelligencePanel.tsx  — executive tab
 *   pages/recruiter/jobs/[id].tsx                  — job detail page
 */

import { useQuery } from "@tanstack/react-query";
import { authHeaders } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import {
  CheckCircle2, Lock, Signal, Brain, TrendingUp, Users, Target, Zap,
  ArrowUpRight, AlertTriangle, Clock, BarChart3, Loader2, ChevronRight,
  Medal, ShieldX, UserMinus, TrendingDown, Gauge, Trophy, Flame, Activity,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { bandBy } from "@/lib/score-band";
import { isTrustGated, TRUST_GATE_LABEL } from "@/lib/trust-gate";
import { SignalCoveragePanel } from "./SignalCoveragePanel";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const NEON = {
  green: "#4ade80", cyan: "#22d3ee", yellow: "#facc15",
  orange: "#fb923c", purple: "#a78bfa", pink: "#fb7185", slate: "#94a3b8",
};

const ACTION_LABELS: Record<string, { label: string; hex: string }> = {
  advance:             { label: "Advance",    hex: NEON.green  },
  schedule:            { label: "Schedule",   hex: NEON.cyan   },
  recruiter_review:    { label: "Review",     hex: NEON.yellow },
  re_engage:           { label: "Re-engage",  hex: NEON.orange },
  manual_verification: { label: "Verify",     hex: NEON.purple },
  reject:              { label: "Reject",     hex: NEON.pink   },
  hold:                { label: "Hold",       hex: NEON.slate  },
};

function KPIBrick({
  label, value, sub, hex, icon: Icon,
}: { label: string; value: string | number; sub?: string; hex: string; icon: any }) {
  return (
    <Card className="border-border/50 overflow-hidden">
      <div className="h-0.5 w-full" style={{ background: hex, boxShadow: `0 0 8px ${hex}66` }} />
      <CardContent className="p-4 flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${hex}18`, border: `1px solid ${hex}44` }}>
          <Icon className="w-4 h-4" style={{ color: hex }} />
        </div>
        <div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</p>
          <p className="text-2xl font-black" style={{ color: hex }}>{value}</p>
          {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

// Executive job-view thresholds — pipeline-level aggregate quantities, each with
// its own cutoffs (distinct from the per-candidate canonical match band); any
// equality between them is coincidental, not a dependency.
const HP_READY_MIN = 60;       // per-candidate hp gate to count as "ready to advance"
const DECISION_CONF_MIN = 35;  // below this, a decision is treated as "insufficient signal"
const TRUST_BLOCK_MAX = 50;    // trust below this blocks the candidate
const TRUST_RISK_MAX = 60;     // trust below this counts toward pipeline trust-risk
const DROPOFF_RISK_MIN = 50;   // drop-off prob above this = at-risk
const CONF_STRONG = 70;        // aggregate / AI-confidence band (pipeline, avg, per-card)
const CONF_MODERATE = 50;
const COVERAGE_STRONG = 70;    // critical-coverage band
const COVERAGE_MODERATE = 40;
const FRESH_STRONG = 70;       // signal-freshness band
const FRESH_MODERATE = 40;
const FRESH_DECAY_MIN = 60;    // a single signal counts as "fresh" at/above this decay
const AVG_HP_STRONG = 70;      // per-source AVERAGE hp band (looser than per-candidate canonical)
const AVG_HP_MODERATE = 50;
const GAP_HIGH = 70;           // agent-gap % (inverted: higher = worse)
const GAP_MODERATE = 40;

function CandidateRow({ name, hp, action, blocked, candidateId, jobId, gated }: {
  name: string; hp: number; action: string; blocked: boolean; candidateId: string; jobId: string; gated?: boolean;
}) {
  const hpHex = bandBy(hp, { strong: NEON.green, good: NEON.yellow, fair: NEON.pink });
  const actionCfg = ACTION_LABELS[action] ?? { label: action, hex: NEON.slate };
  return (
    <div className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold shrink-0">
          {name.split(" ").map(n => n[0]).slice(0, 2).join("")}
        </div>
        <span className="text-sm font-medium truncate">{name}</span>
        {blocked && <Lock className="w-3 h-3 text-amber-400 shrink-0" />}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {gated ? (
          <span className="flex flex-col items-end leading-tight">
            <span className="text-[10px] font-black uppercase tracking-wide text-amber-400">{TRUST_GATE_LABEL}</span>
            <span className="text-[10px] text-muted-foreground tabular-nums">{hp}% if verified</span>
          </span>
        ) : (
          <span className="text-sm font-black tabular-nums" style={{ color: hpHex }}>{hp}%</span>
        )}
        <Badge variant="outline" className="text-[10px]" style={{ color: actionCfg.hex, borderColor: `${actionCfg.hex}40` }}>
          {actionCfg.label}
        </Badge>
        <Link href={`/candidates/${candidateId}`}>
          <ChevronRight className="w-4 h-4 text-muted-foreground hover:text-primary transition-colors" />
        </Link>
      </div>
    </div>
  );
}

export function ExecutiveJobView({ jobId }: { jobId: string }) {
  const { data, isLoading } = useQuery<{ data: any[] }>({
    queryKey: ["intelligence-job-executive", jobId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence/job/${jobId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20 gap-3 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin text-primary" />
        <span className="text-sm">Loading executive view…</span>
      </div>
    );
  }

  const records: any[] = data?.data ?? [];

  if (records.length === 0) {
    return (
      <div className="text-center py-20 space-y-3">
        <Brain className="w-10 h-10 mx-auto text-primary opacity-30" />
        <p className="text-sm text-muted-foreground">No intelligence data for this job yet.</p>
        <p className="text-xs text-muted-foreground">Run the intelligence engine from the Intelligence tab to generate scores.</p>
      </div>
    );
  }

  /* ── Classify candidates ─────────────────────────────────────────────── */
  const ready: any[]   = [];
  const blocked: any[] = [];
  const missing: any[] = [];

  for (const rec of records) {
    const dr = rec.decisionResult;
    const hp = rec.hireProbability ?? 0;
    const action = dr?.decision ?? "hold";
    const conf = dr?.confidence ?? 0;
    const requiresApproval = dr?.requiresApproval ?? false;
    const trust = rec.scores?.trustScore ?? 100;
    const name = `${rec.candidateFirstName ?? ""} ${rec.candidateLastName ?? ""}`.trim() || "Unknown";

    if (!dr || conf < DECISION_CONF_MIN) {
      missing.push({ ...rec, _name: name });
    } else if (requiresApproval || trust < TRUST_BLOCK_MAX) {
      blocked.push({ ...rec, _name: name, _reason: requiresApproval ? "Policy approval required" : `Trust score: ${trust}/100` });
    } else if (["advance", "schedule"].includes(action) && hp >= HP_READY_MIN) {
      ready.push({ ...rec, _name: name });
    } else {
      blocked.push({ ...rec, _name: name, _reason: `Action: ${ACTION_LABELS[action]?.label ?? action}` });
    }
  }

  /* ── Avg hire probability ────────────────────────────────────────────── */
  const withHP = records.filter(r => r.hireProbability != null);
  const avgHP = withHP.length > 0 ? Math.round(withHP.reduce((s, r) => s + r.hireProbability, 0) / withHP.length) : null;

  /* ── Source breakdown ────────────────────────────────────────────────── */
  const sourceMap: Record<string, { total: number; hpSum: number }> = {};
  for (const rec of records) {
    const src = rec.source ?? "unknown";
    if (!sourceMap[src]) sourceMap[src] = { total: 0, hpSum: 0 };
    sourceMap[src].total++;
    sourceMap[src].hpSum += rec.hireProbability ?? 0;
  }
  const sources = Object.entries(sourceMap)
    .map(([src, v]) => ({ src, count: v.total, avgHP: Math.round(v.hpSum / v.total) }))
    .sort((a, b) => b.avgHP - a.avgHP);

  /* ── Bottleneck agents ───────────────────────────────────────────────── */
  const agentMissing: Record<string, number> = {};
  for (const rec of records) {
    if (!rec.signalFreshness) continue;
    for (const sig of rec.signalFreshness) {
      if (!sig.present) agentMissing[sig.agent] = (agentMissing[sig.agent] ?? 0) + 1;
    }
  }
  const bottlenecks = Object.entries(agentMissing)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([agent, count]) => ({ agent, count, pct: Math.round((count / records.length) * 100) }));

  /* ── Forecasts ───────────────────────────────────────────────────────── */
  const projectedHires = ready.length > 0 ? `${Math.max(1, Math.round(ready.length * 0.6))}–${ready.length}` : "0";
  const atRisk = records.filter(r => (r.stageProbs?.dropoffProbability ?? 0) > DROPOFF_RISK_MIN).length;
  const weeksToHire = ready.length >= 1 ? "2–3 weeks" : blocked.length >= 2 ? "4–6 weeks" : "6+ weeks";

  /* ── Job-level confidence ────────────────────────────────────────────── */
  const allRecordSignals: any[][] = records.map((r: any) => r.signalFreshness ?? []);
  const withConf = records.filter((r: any) => r.decisionResult?.confidence != null);
  const avgConf  = withConf.length > 0
    ? Math.round(withConf.reduce((s: number, r: any) => s + (r.decisionResult?.confidence ?? 0), 0) / withConf.length)
    : null;
  const screCount  = allRecordSignals.filter(sf => sf.some((s: any) => s.agent === "screening"    && s.present)).length;
  const intCount   = allRecordSignals.filter(sf => sf.some((s: any) => s.agent === "interview"    && s.present)).length;
  const verCount   = allRecordSignals.filter(sf => sf.some((s: any) => s.agent === "verification" && s.present)).length;
  const critCovPct = records.length > 0 ? Math.round(((screCount + intCount + verCount) / (records.length * 3)) * 100) : 0;
  const freshPct   = allRecordSignals.length > 0
    ? Math.round(allRecordSignals.filter(sf => sf.some((s: any) => s.present && (s.decay ?? 100) >= FRESH_DECAY_MIN)).length / allRecordSignals.length * 100)
    : 0;
  const sigCovPct  = records.length > 0 ? Math.round((allRecordSignals.filter(sf => sf.filter((s: any) => s.present).length >= 3).length / records.length) * 100) : 0;
  const pipelineConf = avgConf != null ? Math.round((avgConf * 0.5) + (critCovPct * 0.3) + (freshPct * 0.2)) : null;

  /* ── Top 3 candidates by HP × confidence ────────────────────────────── */
  const top3 = [...records]
    .filter((r: any) => r.hireProbability != null)
    .map((r: any) => ({
      ...r,
      _score: (r.hireProbability ?? 0) * ((r.decisionResult?.confidence ?? 50) / 100),
      _name: `${r.candidateFirstName ?? ""} ${r.candidateLastName ?? ""}`.trim() || "Unknown",
    }))
    .sort((a: any, b: any) => b._score - a._score)
    .slice(0, 3);

  /* ── Pipeline risks ──────────────────────────────────────────────────── */
  const highDropoff    = records.filter((r: any) => (r.stageProbs?.dropoffProbability ?? 0) > DROPOFF_RISK_MIN).length;
  const lowResponse    = records.filter((r: any) => r.decisionResult?.decision === "re_engage").length;
  const trustRiskCount = records.filter((r: any) => (r.scores?.trustScore ?? 100) < TRUST_RISK_MAX).length;
  const missingCluster = records.filter((r: any) => (r.signalFreshness ?? []).filter((s: any) => s.present).length < 3).length;
  const unstableCount  = records.filter((r: any) => (r.overrides?.length ?? 0) >= 2).length;
  const hasRisks = highDropoff > 0 || lowResponse > 0 || trustRiskCount > 0 || missingCluster > 0 || unstableCount > 0;

  return (
    <div className="space-y-6">
      {/* ── Pipeline Confidence Banner ───────────────────────────────────── */}
      {pipelineConf != null && (
        <div className="rounded-2xl border p-4 flex items-center gap-5"
          style={{ background: `${pipelineConf >= CONF_STRONG ? NEON.green : pipelineConf >= CONF_MODERATE ? NEON.yellow : NEON.pink}08`, borderColor: `${pipelineConf >= CONF_STRONG ? NEON.green : pipelineConf >= CONF_MODERATE ? NEON.yellow : NEON.pink}30` }}>
          <div className="relative shrink-0" style={{ width: 72, height: 72 }}>
            <svg width={72} height={72} style={{ transform: "rotate(-90deg)" }}>
              <circle cx={36} cy={36} r={29} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={6} />
              <circle cx={36} cy={36} r={29} fill="none"
                stroke={pipelineConf >= CONF_STRONG ? NEON.green : pipelineConf >= CONF_MODERATE ? NEON.yellow : NEON.pink}
                strokeWidth={6}
                strokeDasharray={`${(pipelineConf / 100) * (2 * Math.PI * 29)} ${2 * Math.PI * 29}`}
                strokeLinecap="round"
                style={{ filter: `drop-shadow(0 0 6px ${pipelineConf >= CONF_STRONG ? NEON.green : pipelineConf >= CONF_MODERATE ? NEON.yellow : NEON.pink}88)`, transition: "stroke-dasharray 0.8s ease" }} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-black tabular-nums"
                style={{ color: pipelineConf >= CONF_STRONG ? NEON.green : pipelineConf >= CONF_MODERATE ? NEON.yellow : NEON.pink }}>
                {pipelineConf}
              </span>
              <span className="text-[9px] text-muted-foreground">%</span>
            </div>
          </div>
          <div className="flex-1 min-w-0 space-y-1.5">
            <p className="text-sm font-bold flex items-center gap-2">
              <Gauge className="w-4 h-4 text-primary" /> Pipeline Intelligence Confidence
            </p>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Avg AI Confidence", value: `${avgConf ?? 0}%`, hex: avgConf != null && avgConf >= CONF_STRONG ? NEON.green : NEON.yellow },
                { label: "Critical Coverage",  value: `${critCovPct}%`,  hex: critCovPct >= COVERAGE_STRONG ? NEON.green : critCovPct >= COVERAGE_MODERATE ? NEON.yellow : NEON.pink },
                { label: "Signal Freshness",   value: `${freshPct}%`,    hex: freshPct >= FRESH_STRONG ? NEON.green : freshPct >= FRESH_MODERATE ? NEON.yellow : NEON.pink },
              ].map(m => (
                <div key={m.label}>
                  <p className="text-[10px] text-muted-foreground">{m.label}</p>
                  <p className="text-sm font-black tabular-nums" style={{ color: m.hex }}>{m.value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPIBrick label="Decision Ready" value={ready.length}   sub="HP ≥ 60%, action clear" hex={NEON.green}  icon={CheckCircle2} />
        <KPIBrick label="Blocked"        value={blocked.length} sub="Policy gate or trust"   hex={NEON.yellow} icon={Lock}         />
        <KPIBrick label="Missing Signal" value={missing.length} sub="No intel data yet"      hex={NEON.slate}  icon={Signal}       />
        <KPIBrick label="Avg Hire Prob"  value={avgHP != null ? `${avgHP}%` : "—"} sub={`${records.length} candidates scored`} hex={NEON.cyan} icon={Target} />
      </div>

      {/* ── Top 3 Candidates Spotlight ───────────────────────────────────── */}
      {top3.length > 0 && (
        <Card className="border-primary/20 overflow-hidden">
          <div className="h-0.5 w-full" style={{ background: `linear-gradient(to right, ${NEON.green}, ${NEON.cyan})` }} />
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-primary">
              <Trophy className="w-4 h-4" /> Top Candidates — Ranked by Hire Probability × Confidence
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {top3.map((r: any, i: number) => {
                const medals = [
                  { icon: Trophy, hex: "#facc15", label: "1st" },
                  { icon: Medal,  hex: "#94a3b8", label: "2nd" },
                  { icon: Medal,  hex: "#fb923c", label: "3rd" },
                ];
                const m = medals[i];
                const hp = Math.round(r.hireProbability ?? 0);
                const conf = Math.round(r.decisionResult?.confidence ?? 0);
                const gated = isTrustGated(r.scores?.trustScore ?? null);
                const hpHex = bandBy(hp, { strong: NEON.green, good: NEON.yellow, fair: NEON.pink });
                const actionCfg = ACTION_LABELS[r.decisionResult?.decision ?? "hold"] ?? { label: "Hold", hex: NEON.slate };
                return (
                  <div key={r.candidateId} className="rounded-xl border p-3 space-y-2.5 relative"
                    style={{ borderColor: `${m.hex}40`, background: `${m.hex}06` }}>
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0"
                        style={{ background: `${m.hex}25`, border: `1px solid ${m.hex}50` }}>
                        <m.icon className="w-3 h-3" style={{ color: m.hex }} />
                      </div>
                      <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: m.hex }}>{m.label} Place</span>
                    </div>
                    <div>
                      <p className="font-bold text-sm truncate">{r._name}</p>
                      <p className="text-[10px] text-muted-foreground">{r.candidateTitle || r.candidateCompany || "Candidate"}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        {gated ? (
                          <>
                            <p className="text-[10px] font-black uppercase tracking-wide text-amber-400 leading-tight">{TRUST_GATE_LABEL}</p>
                            <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">{hp}% if verified</p>
                          </>
                        ) : (
                          <>
                            <p className="text-[9px] text-muted-foreground">Hire Prob.</p>
                            <p className="text-lg font-black tabular-nums" style={{ color: hpHex }}>{hp}%</p>
                          </>
                        )}
                      </div>
                      <div>
                        <p className="text-[9px] text-muted-foreground">Confidence</p>
                        <p className="text-lg font-black tabular-nums" style={{ color: conf >= CONF_STRONG ? NEON.cyan : conf >= CONF_MODERATE ? NEON.yellow : NEON.slate }}>{conf}%</p>
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className="text-[10px]"
                        style={{ color: actionCfg.hex, borderColor: `${actionCfg.hex}40` }}>
                        {actionCfg.label}
                      </Badge>
                      <Link href={`/candidates/${r.candidateId}`}>
                        <ChevronRight className="w-4 h-4 text-muted-foreground hover:text-primary transition-colors" />
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Pipeline Risk Indicators ─────────────────────────────────────── */}
      {hasRisks && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/3 p-4 space-y-3">
          <p className="text-sm font-bold flex items-center gap-2 text-red-400">
            <AlertTriangle className="w-4 h-4" /> Pipeline Risk Indicators
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {highDropoff > 0 && (
              <div className="flex items-start gap-2 p-2.5 rounded-xl bg-red-500/8 border border-red-500/20">
                <TrendingDown className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-red-400">{highDropoff} Drop-off Risk</p>
                  <p className="text-[10px] text-muted-foreground">Dropoff probability &gt;50%</p>
                </div>
              </div>
            )}
            {lowResponse > 0 && (
              <div className="flex items-start gap-2 p-2.5 rounded-xl bg-amber-500/8 border border-amber-500/20">
                <UserMinus className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-amber-400">{lowResponse} Low Response</p>
                  <p className="text-[10px] text-muted-foreground">Awaiting re-engagement</p>
                </div>
              </div>
            )}
            {trustRiskCount > 0 && (
              <div className="flex items-start gap-2 p-2.5 rounded-xl bg-pink-500/8 border border-pink-500/20">
                <ShieldX className="w-3.5 h-3.5 text-pink-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-pink-400">{trustRiskCount} Trust Risk</p>
                  <p className="text-[10px] text-muted-foreground">Trust score &lt;60</p>
                </div>
              </div>
            )}
            {missingCluster > 0 && (
              <div className="flex items-start gap-2 p-2.5 rounded-xl bg-slate-500/8 border border-slate-500/20">
                <Signal className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-slate-400">{missingCluster} Missing Signals</p>
                  <p className="text-[10px] text-muted-foreground">Fewer than 3 agents fired</p>
                </div>
              </div>
            )}
            {unstableCount > 0 && (
              <div className="flex items-start gap-2 p-2.5 rounded-xl bg-violet-500/8 border border-violet-500/20">
                <Activity className="w-3.5 h-3.5 text-violet-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-violet-400">{unstableCount} Unstable Decisions</p>
                  <p className="text-[10px] text-muted-foreground">2+ recruiter overrides</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Candidate groupings ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Decision ready */}
        <Card className="border-emerald-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2" style={{ color: NEON.green }}>
              <CheckCircle2 className="w-4 h-4" /> Decision-Ready Candidates
            </CardTitle>
          </CardHeader>
          <CardContent>
            {ready.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No candidates ready to advance yet.</p>
            ) : (
              ready.slice(0, 6).map(r => (
                <CandidateRow
                  key={r.candidateId}
                  name={r._name}
                  hp={Math.round(r.hireProbability ?? 0)}
                  action={r.decisionResult?.decision ?? "hold"}
                  blocked={false}
                  candidateId={r.candidateId}
                  jobId={jobId}
                  gated={isTrustGated(r.scores?.trustScore ?? null)}
                />
              ))
            )}
          </CardContent>
        </Card>

        {/* Blocked */}
        <Card className="border-amber-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2" style={{ color: NEON.yellow }}>
              <Lock className="w-4 h-4" /> Blocked Candidates
            </CardTitle>
          </CardHeader>
          <CardContent>
            {blocked.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No blocked candidates.</p>
            ) : (
              blocked.slice(0, 6).map(r => (
                <div key={r.candidateId}>
                  <CandidateRow
                    name={r._name}
                    hp={Math.round(r.hireProbability ?? 0)}
                    action={r.decisionResult?.decision ?? "hold"}
                    blocked
                    candidateId={r.candidateId}
                    jobId={jobId}
                    gated={isTrustGated(r.scores?.trustScore ?? null)}
                  />
                  <p className="text-[10px] text-amber-400 pl-10 -mt-1 mb-1">{r._reason}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Signal Coverage + Bottlenecks ───────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Source performance */}
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
              <BarChart3 className="w-4 h-4 text-primary" /> Best-Performing Sources
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {sources.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No source data.</p>
            ) : (
              sources.map(s => {
                const hpHex = s.avgHP >= AVG_HP_STRONG ? NEON.green : s.avgHP >= AVG_HP_MODERATE ? NEON.yellow : NEON.pink;
                return (
                  <div key={s.src} className="space-y-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-medium capitalize">{s.src.replace(/_/g, " ")}</span>
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <span>{s.count} candidates</span>
                        <span className="font-black tabular-nums" style={{ color: hpHex }}>{s.avgHP}% avg HP</span>
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${s.avgHP}%`, background: hpHex }} />
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* Signal Coverage */}
        <Card className="border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
              <Signal className="w-4 h-4 text-primary" /> Critical Signal Coverage
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <SignalCoveragePanel mode="job" recordSignals={allRecordSignals} />
            <div className="pt-2 border-t border-white/5 text-xs text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              {screCount + intCount + verCount} of {records.length * 3} critical signal slots filled across {pluralize(records.length, "candidate")}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Biggest Agent Signal Gaps ─────────────────────────────────────── */}
      <Card className="border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
            <AlertTriangle className="w-4 h-4 text-primary" /> Biggest Agent Signal Gaps
          </CardTitle>
        </CardHeader>
        <CardContent>
          {bottlenecks.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No agent gap data.</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {bottlenecks.map(b => {
                const pctHex = b.pct >= GAP_HIGH ? NEON.pink : b.pct >= GAP_MODERATE ? NEON.yellow : NEON.green;
                return (
                  <div key={b.agent} className="space-y-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="font-medium capitalize">{b.agent.replace(/([A-Z])/g, ' $1')}</span>
                      <span className="font-black tabular-nums" style={{ color: pctHex }}>{b.pct}% missing</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${b.pct}%`, background: pctHex }} />
                    </div>
                    <p className="text-[10px] text-muted-foreground">{b.count} of {records.length} have no {b.agent} signal</p>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Forecasted outcomes ──────────────────────────────────────────── */}
      <Card className="border-primary/20 bg-primary/3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2 text-primary">
            <TrendingUp className="w-4 h-4" /> Forecasted Outcomes
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="p-3 rounded-xl bg-white/3 border border-white/8 text-center">
              <p className="text-xl font-black" style={{ color: NEON.green }}>{projectedHires}</p>
              <p className="text-[10px] text-muted-foreground mt-1">Projected Hires</p>
            </div>
            <div className="p-3 rounded-xl bg-white/3 border border-white/8 text-center">
              <p className="text-xl font-black" style={{ color: NEON.cyan }}>{weeksToHire}</p>
              <p className="text-[10px] text-muted-foreground mt-1">Est. Time to Hire</p>
            </div>
            <div className="p-3 rounded-xl bg-white/3 border border-white/8 text-center">
              <p className="text-xl font-black" style={{ color: atRisk > 0 ? NEON.orange : NEON.green }}>{atRisk}</p>
              <p className="text-[10px] text-muted-foreground mt-1">At-Risk Candidates</p>
            </div>
            <div className="p-3 rounded-xl bg-white/3 border border-white/8 text-center">
              <p className="text-xl font-black" style={{ color: NEON.purple }}>{records.length}</p>
              <p className="text-[10px] text-muted-foreground mt-1">Total Scored</p>
            </div>
          </div>
          {atRisk > 0 && (
            <div className="mt-3 flex items-start gap-2 text-xs text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              {pluralize(atRisk, "candidate is", "candidates are")} showing drop-off risk above 50%. Prioritize outreach now.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
