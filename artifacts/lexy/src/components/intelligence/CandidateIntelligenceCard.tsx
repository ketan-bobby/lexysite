/**
 * components/intelligence/CandidateIntelligenceCard.tsx — Full AI Intelligence Card
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * The primary recruiter-facing intelligence surface for a candidate×job pair.
 * Combines every intelligence sub-component into one scrollable card and adds
 * recruiter-feedback and override flows on top.
 *
 * ─── Sections rendered ───────────────────────────────────────────────────────
 *   Next Step Banner         — action-oriented guidance (advance / hold / review)
 *   Why-Not-Now explanation  — plain-language reason when a candidate is held
 *   Hire likelihood          — LexyCandidatePrediction score surface
 *   Signal coverage          — SignalCoveragePanel (screening / interview / verify)
 *   Stage probabilities      — per-stage advance likelihood bars
 *   Recruiter playbook       — AI-generated next actions
 *   Decision audit trail     — DecisionAuditTrail timeline
 *   Override controls        — OverrideDialog trigger + override history list
 *   Inline feedback          — thumbs up/down recruiter signal for model learning
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/intelligence/:candidateId/:jobId   — main intelligence object
 *   POST /api/intelligence/feedback             — inline feedback submit
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/intelligence/IntelligencePanel.tsx
 *   pages/recruiter/candidates/[id].tsx
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authHeaders } from "@/lib/api";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OverrideDialog } from "./OverrideDialog";
import { SignalCoveragePanel } from "./SignalCoveragePanel";
import { DecisionAuditTrail } from "./DecisionAuditTrail";
import { LexyCandidatePrediction } from "./LexyCandidatePrediction";
import {
  Brain, Target, TrendingUp, Shield, Zap, ArrowUpRight, ArrowDownRight,
  CheckCircle2, AlertTriangle, Clock, RefreshCw, ChevronRight, Loader2,
  Lock, History, Play, UserCheck, Activity, Sparkles, Signal,
  ListChecks, BarChart3, ArrowRight, ThumbsUp, ThumbsDown,
  CalendarPlus, Send, Eye, ShieldAlert, XCircle, PauseCircle,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { bandBy } from "@/lib/score-band";
import { INTELLIGENCE_BANDS, intelBandBy } from "@/lib/intelligence-bands";
import { displayScore, scoreBarWidth } from "@/lib/score-display";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/* ── Palette ─────────────────────────────────────────────────────────────── */
const NEON = {
  green:  "#4ade80",
  cyan:   "#22d3ee",
  yellow: "#facc15",
  orange: "#fb923c",
  purple: "#a78bfa",
  pink:   "#fb7185",
  slate:  "#94a3b8",
  blue:   "#60a5fa",
};

/* ── Action config ────────────────────────────────────────────────────────── */
const ACTION_CONFIG: Record<string, {
  label: string; hex: string; workflowLabel: string; urgency: string;
  bannerTitle: string; icon: any;
}> = {
  advance:             { label: "Advance",    hex: NEON.green,  workflowLabel: "Move to Offer",         urgency: "critical", bannerTitle: "Advance to Next Stage",    icon: ArrowUpRight  },
  schedule:            { label: "Schedule",   hex: NEON.cyan,   workflowLabel: "Create Schedule",       urgency: "high",     bannerTitle: "Schedule Interview",       icon: CalendarPlus  },
  recruiter_review:    { label: "Review",     hex: NEON.yellow, workflowLabel: "Recruiter Task",        urgency: "medium",   bannerTitle: "Manual Review Required",   icon: Eye           },
  re_engage:           { label: "Re-engage",  hex: NEON.orange, workflowLabel: "Send Re-engagement",    urgency: "high",     bannerTitle: "Re-engage Candidate Now",  icon: Send          },
  manual_verification: { label: "Verify",     hex: NEON.purple, workflowLabel: "Flag for Verification", urgency: "high",     bannerTitle: "Trigger Verification",     icon: ShieldAlert   },
  reject:              { label: "Reject",     hex: NEON.pink,   workflowLabel: "Close Application",     urgency: "low",      bannerTitle: "Close Application",        icon: XCircle       },
  hold:                { label: "Hold",       hex: NEON.slate,  workflowLabel: "Pause Pipeline",        urgency: "low",      bannerTitle: "Hold — Awaiting Signals",  icon: PauseCircle   },
};

/* ── Playbooks ────────────────────────────────────────────────────────────── */
const PLAYBOOKS: Record<string, { title: string; steps: string[]; tip: string }> = {
  advance: {
    title: "Ready to Advance — Act within 24h",
    steps: [
      "Prepare offer package (salary, equity, start date)",
      "Schedule offer call with the candidate",
      "Draft personalized offer letter using their key motivators",
      "Brief the hiring manager on the candidate profile",
      "Set offer expiry (48–72h) to maintain urgency",
    ],
    tip: "Top candidates receive 2.3 offers on average. Speed is your biggest competitive advantage.",
  },
  schedule: {
    title: "Book Interview — Respond within 2h",
    steps: [
      "Send calendar availability link within 2 business hours",
      "Prepare structured interview guide aligned to ICP",
      "Brief the interview panel on strengths and gaps to probe",
      "Confirm the interview slot 24h beforehand",
      "Prepare technical or role-based assessment if required",
    ],
    tip: "Response time under 2h increases show rates by 40% compared to 24h+ delays.",
  },
  recruiter_review: {
    title: "Human Decision Required",
    steps: [
      "Review all 4 dimension scores and their explanations",
      "Read the screening report and interview transcript if available",
      "Check verification and proctoring flags",
      "Compare the profile against ICP requirements manually",
      "Make a go/no-go decision and log your reasoning as an override",
    ],
    tip: "Your override gets recorded and improves future AI recommendations for similar profiles.",
  },
  re_engage: {
    title: "Re-engage Before They Go Cold",
    steps: [
      "Review the candidate's last touchpoint date",
      "Send a warm, personalized re-engagement message now",
      "Offer flexible meeting options to reduce friction",
      "Consider switching channels (email → LinkedIn → SMS)",
      "Set a 48h follow-up if no response received",
    ],
    tip: "Ghosting risk doubles every 72h without contact. Act now.",
  },
  manual_verification: {
    title: "Resolve Trust Signals Before Proceeding",
    steps: [
      "Review the verification report flags in detail",
      "Contact the candidate to clarify flagged information",
      "Cross-reference LinkedIn against resume claims",
      "Consider a background check if trust score stays below threshold",
      "Record the verification outcome and update the trust status",
    ],
    tip: "Verification issues are often innocent — a quick call resolves 70% of flags.",
  },
  reject: {
    title: "Close Application Professionally",
    steps: [
      "Confirm the rejection reasoning is accurate",
      "Send a professional rejection within 24h of the decision",
      "Log the rejection reason for pipeline analytics",
      "Consider whether a future role might be a better fit",
      "Archive the candidate for potential future reconsideration",
    ],
    tip: "A timely, respectful rejection protects your employer brand more than silence does.",
  },
  hold: {
    title: "Monitor for New Signals",
    steps: [
      "Identify which agent signals are missing or stale",
      "Trigger the relevant agents to collect more data",
      "Set a 7-day review reminder",
      "Monitor for new signals from outreach or scheduling agents",
    ],
    tip: "Hold decisions often resolve themselves once screening or interview data arrives.",
  },
};

/* ── Types ───────────────────────────────────────────────────────────────── */
interface IntelligenceDecision {
  jobId: string;
  candidateId: string;
  hireProbability: number | null;
  /* Raw stored dimension scores from /decision — null = "no signal yet",
     rendered as "—" (@/lib/score-display), never a fabricated neutral 50. */
  scores: { fitScore: number | null; qualityScore: number | null; trustScore: number | null; conversionScore: number | null; hireProbability: number | null };
  stageProbs: { nextStageSuccessProbability: number; offerProbability: number; offerAcceptanceProbability: number; dropoffProbability: number };
  decisionResult: {
    decision: string; workflowAction: string; targetStage: string; priority: string;
    confidence: number;
    confidenceBreakdown: { completeness: number; freshness: number; criticalCoverage: number; total: number; caps: string[] };
    reasoning: string; factors: { supporting: string[]; blocking: string[] };
    why_selected: string; explanation: { strengths: string[]; risks: string[] };
    suggestedMessage?: string; policyApplied: boolean; policyOverrides: string[];
    requiresApproval: boolean; agentTrigger?: { agentId: string; reason: string };
  };
  signalFreshness: Array<{ agent: string; present: boolean; decay: number | null; lastUpdated: string | null }>;
  overrides: Array<{ id: string; overriddenAt: string; originalDecision: string; recruiterDecision: string; recruiterReason: string }>;
  lastUpdated: string;
}

// ── Non-band numeric thresholds (documented; distinct quantities, not colour bands) ──
const TRUST_BLOCKER_MAX = 60;        // trust below this raises a hard blocker
const DROPOFF_RISK_MIN = 50;         // drop-off prob above this = engagement-risk blocker
const DROPOFF_PILL_ELEVATED = 40;    // drop-off prob above this tints the pill
const STALE_DECAY_MAX = 50;          // signal decay below this = "stale"
const CRITICAL_STALE_DECAY_MAX = 40; // critical-agent decay below this = "critically stale"
// Signal-freshness band — a decay quantity with its own cutoffs, not a score band.
const FRESH_STRONG = 80;
const FRESH_MODERATE = 50;

/* ── Sub-components ──────────────────────────────────────────────────────── */
function ScoreRing({ score, size = 64 }: { score: number | null; size?: number }) {
  const s = score ?? 0;
  // Headline candidate score — the canonical match band.
  const hex = bandBy(s, { strong: NEON.green, good: NEON.yellow, fair: NEON.pink });
  const r = (size / 2) - 5;
  const circumference = 2 * Math.PI * r;
  const dash = (s / 100) * circumference;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={5} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={hex} strokeWidth={5}
          strokeDasharray={`${dash} ${circumference - dash}`} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 5px ${hex}88)`, transition: "stroke-dasharray 0.8s ease" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-black tabular-nums leading-none" style={{ color: hex }}>{score != null ? `${score}` : "—"}</span>
        <span className="text-[9px] text-muted-foreground leading-none mt-0.5">%</span>
      </div>
    </div>
  );
}

function DimBar({ label, score, icon: Icon }: { label: string; score: number | null; icon: any }) {
  const w = scoreBarWidth(score);
  // Intelligence dimension — shared INTELLIGENCE band (see intelligence-bands.ts).
  // Unknown (null) renders "—" in neutral slate, never a fabricated 0/50.
  const hex = score == null
    ? "#64748b"
    : intelBandBy(score, { strong: NEON.green, moderate: NEON.yellow, weak: NEON.pink });
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Icon className="w-3 h-3" /> {label}
        </span>
        <span className="text-sm font-black tabular-nums" style={{ color: hex }}>{displayScore(score)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${w}%`, background: hex, boxShadow: w >= INTELLIGENCE_BANDS.moderate ? `0 0 6px ${hex}66` : "none" }} />
      </div>
    </div>
  );
}

function StageProbPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-white/3 border border-white/8">
      <span className="text-xs text-muted-foreground text-center leading-tight">{label}</span>
      <span className="text-xl font-black tabular-nums" style={{ color }}>{value}%</span>
    </div>
  );
}

function ConfidenceBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-xs font-bold tabular-nums" style={{ color }}>{value}/{max}</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${(value / max) * 100}%`, background: color }} />
      </div>
    </div>
  );
}

/* ── Next Step Banner ────────────────────────────────────────────────────── */
function NextStepBanner({
  dr, actionCfg,
}: {
  dr: IntelligenceDecision["decisionResult"];
  actionCfg: typeof ACTION_CONFIG[string];
}) {
  const hex = actionCfg.hex;
  const IconComp = actionCfg.icon;
  const urgencyColors: Record<string, string> = {
    critical: "#fb7185", high: "#fb923c", medium: "#facc15", low: "#94a3b8",
  };
  const urgencyHex = urgencyColors[actionCfg.urgency] ?? NEON.slate;

  return (
    <div
      className="rounded-2xl p-4 border"
      style={{ background: `${hex}10`, borderColor: `${hex}30` }}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: `${hex}20`, border: `1px solid ${hex}40` }}
        >
          <IconComp className="w-5 h-5" style={{ color: hex }} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-sm font-bold tracking-wide" style={{ color: hex }}>
              {actionCfg.bannerTitle}
            </span>
            <Badge
              variant="outline"
              className="text-[10px] px-2 py-0.5"
              style={{ color: `${NEON.cyan}`, borderColor: `${NEON.cyan}30`, background: `${NEON.cyan}10` }}
            >
              {dr.confidence}% confidence
            </Badge>
            <Badge
              variant="outline"
              className="text-[10px] px-2 py-0.5 capitalize"
              style={{ color: urgencyHex, borderColor: `${urgencyHex}30`, background: `${urgencyHex}10` }}
            >
              {actionCfg.urgency} priority
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{dr.why_selected}</p>

          {/* Blocker row */}
          {dr.requiresApproval && (
            <div className="flex items-center gap-1.5 mt-2 text-xs" style={{ color: NEON.yellow }}>
              <Lock className="w-3 h-3 shrink-0" />
              Policy gate active — recruiter approval required before execution.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Why-Not-Now Explanation ─────────────────────────────────────────────── */
function WhyNotNow({
  dr, scores, stageProbs, signalFreshness,
}: {
  dr: IntelligenceDecision["decisionResult"];
  scores: IntelligenceDecision["scores"];
  stageProbs: IntelligenceDecision["stageProbs"];
  signalFreshness: IntelligenceDecision["signalFreshness"];
}) {
  const notAdvancing = dr.decision !== "advance" && dr.decision !== "schedule";
  if (!notAdvancing) return null;

  const blockers: Array<{ icon: any; text: string; hex: string; severity: "high" | "medium" | "low" }> = [];

  if (dr.requiresApproval) {
    blockers.push({ icon: Lock, text: "Policy approval required before this action can execute", hex: NEON.yellow, severity: "high" });
  }
  if ((scores.trustScore ?? 100) < TRUST_BLOCKER_MAX) {
    blockers.push({ icon: Shield, text: `Trust score is ${scores.trustScore}/100 — verification or proctoring flagged an issue`, hex: NEON.pink, severity: "high" });
  }
  if (dr.confidence < INTELLIGENCE_BANDS.moderate) {
    blockers.push({ icon: Activity, text: `Decision confidence is only ${dr.confidence}% — not enough agent signals to be certain`, hex: NEON.orange, severity: "medium" });
  }
  const missingCritical = signalFreshness.filter(s => !s.present && ["screening", "interview", "verification"].includes(s.agent));
  if (missingCritical.length > 0) {
    const names = missingCritical.map(s => s.agent).join(", ");
    blockers.push({ icon: Signal, text: `Missing critical signals: ${names}`, hex: NEON.slate, severity: "medium" });
  }
  if (stageProbs?.dropoffProbability > DROPOFF_RISK_MIN) {
    blockers.push({ icon: AlertTriangle, text: `High drop-off risk (${stageProbs.dropoffProbability}%) — candidate may disengage if not acted on quickly`, hex: NEON.orange, severity: "medium" });
  }
  const staleCritical = signalFreshness.filter(s => s.present && (s.decay ?? 100) < CRITICAL_STALE_DECAY_MAX && ["interview", "screening"].includes(s.agent));
  if (staleCritical.length > 0) {
    blockers.push({ icon: Clock, text: `Key signals are stale — ${staleCritical.map(s => s.agent).join(", ")} data may no longer reflect current state`, hex: NEON.slate, severity: "low" });
  }

  if (blockers.length === 0) {
    blockers.push({ icon: AlertTriangle, text: "Candidate does not yet meet the threshold for automatic advancement based on current signals", hex: NEON.slate, severity: "low" });
  }

  return (
    <Card className="border-border/50 bg-muted/20">
      <CardContent className="p-4 space-y-2.5">
        <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5" /> What's preventing advancement
        </p>
        {blockers.map((b, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <div
              className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 mt-0.5"
              style={{ background: `${b.hex}15`, border: `1px solid ${b.hex}30` }}
            >
              <b.icon className="w-3 h-3" style={{ color: b.hex }} />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{b.text}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ── Inline Feedback ─────────────────────────────────────────────────────── */
function InlineFeedback({
  jobId, candidateId,
}: {
  jobId: string; candidateId: string;
}) {
  const [rating, setRating] = useState<"positive" | "negative" | null>(null);
  const { toast } = useToast();

  const sendFeedback = async (r: "positive" | "negative") => {
    setRating(r);
    try {
      await fetch(`${BASE}/api/intelligence/${jobId}/${candidateId}/feedback`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ rating: r }),
      });
    } catch {
      /* silent — feedback loss is acceptable */
    }
    if (r === "negative") {
      toast({ title: "Thanks for the feedback", description: "Your input helps the engine calibrate future recommendations." });
    }
  };

  if (rating) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
        {rating === "positive"
          ? <><ThumbsUp className="w-3.5 h-3.5 text-emerald-400" /> Glad it was helpful!</>
          : <><ThumbsDown className="w-3.5 h-3.5 text-amber-400" /> Noted — we'll improve this.</>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-1">
      <span className="text-xs text-muted-foreground">Was this recommendation helpful?</span>
      <button
        type="button"
        onClick={() => sendFeedback("positive")}
        className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
      >
        <ThumbsUp className="w-3.5 h-3.5" /> Yes
      </button>
      <button
        type="button"
        onClick={() => sendFeedback("negative")}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-amber-400 transition-colors"
      >
        <ThumbsDown className="w-3.5 h-3.5" /> Not really
      </button>
    </div>
  );
}

/* ── Main Component ──────────────────────────────────────────────────────── */
export function CandidateIntelligenceCard({
  jobId, candidateId, candidateName, jobTitle,
}: {
  jobId: string; candidateId: string; candidateName?: string; jobTitle?: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [executed, setExecuted] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    playbook: true, signals: false, overrides: false, auditTrail: false,
  });

  const toggle = (key: string) => setExpanded(e => ({ ...e, [key]: !e[key] }));

  const { data, isLoading, refetch, isFetching } = useQuery<{ data: IntelligenceDecision }>({
    queryKey: ["intelligence-decision", jobId, candidateId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence/${jobId}/${candidateId}/decision`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch intelligence");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const triggerMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence/trigger-action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ jobId, candidateId }),
      });
      return res.json();
    },
    onSuccess: (d) => {
      if (d.triggered) {
        toast({ title: "Action triggered", description: `${d.agentId} agent has been dispatched.` });
      } else {
        toast({ title: "Action blocked", description: d.message ?? d.blocked, variant: "destructive" });
      }
      setExecuted(true);
      queryClient.invalidateQueries({ queryKey: ["intelligence-decision", jobId, candidateId] });
    },
    onError: () => toast({ title: "Failed to trigger action", variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground">
        <Brain className="w-5 h-5 animate-pulse text-primary" />
        <span className="text-sm">Loading intelligence…</span>
      </div>
    );
  }

  if (!data?.data) {
    return (
      <div className="text-center py-12 space-y-3">
        <Brain className="w-8 h-8 mx-auto text-primary opacity-40" />
        <p className="text-sm text-muted-foreground">No intelligence data yet for this candidate-job pair.</p>
        <Button size="sm" variant="outline" onClick={() => refetch()} className="gap-2">
          <Sparkles className="w-3.5 h-3.5" /> Run Intelligence Engine
        </Button>
      </div>
    );
  }

  const d = data.data;
  const dr = d.decisionResult;
  const actionCfg = ACTION_CONFIG[dr.decision] ?? { label: dr.decision, hex: NEON.slate, workflowLabel: "—", urgency: "low", bannerTitle: dr.decision, icon: Activity };
  const playbook = PLAYBOOKS[dr.decision];
  const hp = d.hireProbability ?? 0;
  const hpHex = bandBy(hp, { strong: NEON.green, good: NEON.yellow, fair: NEON.pink });

  const presentSignals = d.signalFreshness.filter(s => s.present);
  const staleSignals   = d.signalFreshness.filter(s => s.present && (s.decay ?? 100) < STALE_DECAY_MAX);
  const criticalStale  = d.signalFreshness.filter(s => ["screening", "interview", "verification"].includes(s.agent) && s.present && (s.decay ?? 100) < CRITICAL_STALE_DECAY_MAX);
  const isUnstable     = d.overrides.length >= 2;

  return (
    <div className="space-y-4">
      {/* ── 0. Lexy Prediction — plain-language 4-question summary ──────── */}
      <LexyCandidatePrediction
        data={{
          hireProbability: d.hireProbability,
          scores: d.scores,
          stageProbs: d.stageProbs,
          decisionResult: dr,
          topStrengths: (d as any).topStrengths ?? dr.explanation?.strengths,
          topRisks:     (d as any).topRisks     ?? dr.explanation?.risks,
        }}
        onRefresh={() => refetch()}
        isRefreshing={isFetching}
      />

      {/* ── 1. Next Step Banner ─────────────────────────────────────────── */}
      <NextStepBanner dr={dr} actionCfg={actionCfg} />

      {/* ── 1b. Stability + Freshness Warnings ──────────────────────────── */}
      {(isUnstable || criticalStale.length > 0) && (
        <div className="space-y-2">
          {isUnstable && (
            <div className="flex items-start gap-2.5 rounded-xl px-3 py-2.5 border border-violet-500/30 bg-violet-500/8">
              <Activity className="w-3.5 h-3.5 text-violet-400 mt-0.5 shrink-0" />
              <div className="space-y-0.5">
                <p className="text-xs font-semibold text-violet-400">Unstable Decision — {d.overrides.length} Overrides Logged</p>
                <p className="text-[10px] text-muted-foreground">This candidate's recommendation has changed {d.overrides.length} times. Review the Decision Audit Trail below for context.</p>
              </div>
            </div>
          )}
          {criticalStale.length > 0 && (
            <div className="flex items-start gap-2.5 rounded-xl px-3 py-2.5 border border-amber-500/30 bg-amber-500/8">
              <Clock className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p className="text-xs font-semibold text-amber-400">Stale Critical Signals Detected</p>
                <div className="flex items-center gap-3 flex-wrap">
                  {criticalStale.map(s => (
                    <span key={s.agent} className="text-[10px] text-amber-400/80">
                      {s.agent.charAt(0).toUpperCase() + s.agent.slice(1)}: {s.decay}% fresh
                      {s.lastUpdated && ` · ${new Date(s.lastUpdated).toLocaleDateString()}`}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground">Re-running the relevant agents will improve decision accuracy.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 2. Why-Not-Now ──────────────────────────────────────────────── */}
      <WhyNotNow dr={dr} scores={d.scores} stageProbs={d.stageProbs} signalFreshness={d.signalFreshness} />

      {/* ── 3. Score Ring + Dimensions ──────────────────────────────────── */}
      <Card className="border-border/50 overflow-hidden">
        <div className="h-0.5 w-full"
          style={{ background: `linear-gradient(to right, ${hpHex}99, ${actionCfg.hex}99)`, boxShadow: `0 0 10px ${hpHex}44` }} />
        <CardContent className="p-5">
          <div className="flex items-start gap-5">
            <ScoreRing score={hp} size={72} />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Hire Probability</p>
                  {candidateName && <p className="font-bold text-sm">{candidateName}</p>}
                  {jobTitle && <p className="text-xs text-muted-foreground">{jobTitle}</p>}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  <span className="text-xs font-bold px-2.5 py-1 rounded-full border"
                    style={{ color: actionCfg.hex, backgroundColor: `${actionCfg.hex}15`, borderColor: `${actionCfg.hex}40` }}>
                    {actionCfg.label}
                  </span>
                  {dr.requiresApproval && (
                    <Badge className="text-xs bg-amber-500/15 text-amber-400 border-amber-500/30 border gap-1">
                      <Lock className="w-2.5 h-2.5" /> Approval Required
                    </Badge>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                <DimBar label="Fit"        score={d.scores.fitScore}        icon={Target} />
                <DimBar label="Quality"    score={d.scores.qualityScore}    icon={TrendingUp} />
                <DimBar label="Trust"      score={d.scores.trustScore}      icon={Shield} />
                <DimBar label="Conversion" score={d.scores.conversionScore} icon={Zap} />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── 4. Stage Predictions ────────────────────────────────────────── */}
      {d.stageProbs && (
        <Card className="border-border/50">
          <CardHeader className="pb-2 pt-4 px-5">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
              <BarChart3 className="w-4 h-4" /> Stage Predictions
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StageProbPill label="Next Stage Pass" value={d.stageProbs.nextStageSuccessProbability} color={NEON.cyan} />
              <StageProbPill label="Offer Probability" value={d.stageProbs.offerProbability} color={NEON.green} />
              <StageProbPill label="Offer Acceptance" value={d.stageProbs.offerAcceptanceProbability} color={NEON.purple} />
              <StageProbPill label="Drop-off Risk" value={d.stageProbs.dropoffProbability}
                color={d.stageProbs.dropoffProbability > DROPOFF_PILL_ELEVATED ? NEON.pink : NEON.slate} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 5. Strengths & Risks ────────────────────────────────────────── */}
      {(dr.explanation.strengths.length > 0 || dr.explanation.risks.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {dr.explanation.strengths.length > 0 && (
            <Card className="border-emerald-500/15 bg-emerald-500/3">
              <CardContent className="p-4 space-y-2">
                <p className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5" style={{ color: NEON.green }}>
                  <ArrowUpRight className="w-3.5 h-3.5" /> Strengths
                </p>
                <ul className="space-y-1.5">
                  {dr.explanation.strengths.slice(0, 4).map((s, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" style={{ color: NEON.green }} /> {s}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {dr.explanation.risks.length > 0 && (
            <Card className="border-amber-500/15 bg-amber-500/3">
              <CardContent className="p-4 space-y-2">
                <p className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5" style={{ color: NEON.orange }}>
                  <ArrowDownRight className="w-3.5 h-3.5" /> Risks
                </p>
                <ul className="space-y-1.5">
                  {dr.explanation.risks.slice(0, 4).map((r, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                      <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" style={{ color: NEON.yellow }} /> {r}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── 6. Action Playbook ──────────────────────────────────────────── */}
      {playbook && (
        <Card className="border-border/50">
          <button type="button" className="w-full flex items-center justify-between px-5 py-4" onClick={() => toggle("playbook")}>
            <span className="flex items-center gap-2 text-sm font-semibold">
              <ListChecks className="w-4 h-4 text-primary" /> Action Playbook
              <Badge variant="outline" className="text-xs ml-1" style={{ color: actionCfg.hex, borderColor: `${actionCfg.hex}40` }}>
                {actionCfg.workflowLabel}
              </Badge>
            </span>
            <ChevronRight className={cn("w-4 h-4 text-muted-foreground transition-transform", expanded.playbook && "rotate-90")} />
          </button>
          {expanded.playbook && (
            <CardContent className="px-5 pb-5 space-y-3">
              <p className="text-sm font-semibold" style={{ color: actionCfg.hex }}>{playbook.title}</p>
              <ol className="space-y-2">
                {playbook.steps.map((step, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black mt-0.5"
                      style={{ background: `${actionCfg.hex}20`, color: actionCfg.hex, border: `1px solid ${actionCfg.hex}40` }}>
                      {i + 1}
                    </span>
                    <span className="text-sm text-muted-foreground leading-snug">{step}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-3 p-3 rounded-lg bg-white/3 border border-white/8 flex items-start gap-2">
                <Sparkles className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                <p className="text-xs text-muted-foreground">{playbook.tip}</p>
              </div>
              {dr.suggestedMessage && (
                <div className="p-3 rounded-lg bg-primary/5 border border-primary/15">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-primary mb-1">Suggested Message</p>
                  <p className="text-xs text-muted-foreground italic">"{dr.suggestedMessage}"</p>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* ── 7. Confidence Breakdown ─────────────────────────────────────── */}
      <Card className="border-border/50">
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-semibold flex items-center gap-2">
              <Activity className="w-4 h-4 text-primary" /> Confidence Breakdown
            </span>
            <span className="text-sm font-black tabular-nums"
              style={{ color: intelBandBy(dr.confidence, { strong: NEON.green, moderate: NEON.yellow, weak: NEON.pink }) }}>
              {dr.confidence}%
            </span>
          </div>
          <ConfidenceBar label="Signal completeness" value={dr.confidenceBreakdown.completeness} max={40} color={NEON.cyan} />
          <ConfidenceBar label="Signal freshness"    value={dr.confidenceBreakdown.freshness}    max={30} color={NEON.purple} />
          <ConfidenceBar label="Critical coverage"   value={dr.confidenceBreakdown.criticalCoverage} max={30} color={NEON.green} />
          {dr.confidenceBreakdown.caps.length > 0 && (
            <div className="space-y-1 pt-1">
              {dr.confidenceBreakdown.caps.map((cap, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-amber-400">
                  <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {cap}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 8. Policy Gate ──────────────────────────────────────────────── */}
      {(dr.policyApplied || dr.requiresApproval) && (
        <Card className="border-amber-500/20 bg-amber-500/3">
          <CardContent className="p-4 space-y-2">
            <p className="text-sm font-semibold flex items-center gap-2" style={{ color: NEON.yellow }}>
              <Lock className="w-4 h-4" /> Policy Gate Active
            </p>
            {dr.requiresApproval && (
              <div className="flex items-start gap-2 text-xs text-amber-400">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                Recruiter approval required before this action executes.
              </div>
            )}
            {dr.policyOverrides.map((ov, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                <ChevronRight className="w-3 h-3 mt-0.5 shrink-0 text-amber-400" /> {ov}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* ── 8b. Decision Audit Trail ─────────────────────────────────────── */}
      <Card className="border-border/50">
        <button type="button" className="w-full flex items-center justify-between px-5 py-4" onClick={() => toggle("auditTrail")}>
          <span className="flex items-center gap-2 text-sm font-semibold">
            <History className="w-4 h-4 text-primary" /> Decision Audit Trail
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 text-primary border-primary/30">
              {d.overrides.length > 0 ? pluralize(d.overrides.length, "override") : "AI-only"}
            </Badge>
          </span>
          <ChevronRight className={cn("w-4 h-4 text-muted-foreground transition-transform", expanded.auditTrail && "rotate-90")} />
        </button>
        {expanded.auditTrail && (
          <CardContent className="px-5 pb-5">
            <DecisionAuditTrail dr={dr} overrides={d.overrides} />
          </CardContent>
        )}
      </Card>

      {/* ── 9. Signal Coverage ──────────────────────────────────────────── */}
      <Card className="border-border/50">
        <button type="button" className="w-full flex items-center justify-between px-5 py-4" onClick={() => toggle("signals")}>
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Signal className="w-4 h-4 text-primary" /> Signal Coverage
            <span className="text-xs text-muted-foreground font-normal">
              {presentSignals.length}/9 agents active
              {staleSignals.length > 0 && <span className="text-amber-400 ml-1">· {staleSignals.length} stale</span>}
            </span>
          </span>
          <ChevronRight className={cn("w-4 h-4 text-muted-foreground transition-transform", expanded.signals && "rotate-90")} />
        </button>
        {expanded.signals && (
          <CardContent className="px-5 pb-5 space-y-4">
            {/* Critical signals summary */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Critical Signals</p>
              <SignalCoveragePanel mode="candidate" signalFreshness={d.signalFreshness} />
            </div>
            {/* All agent signals */}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">All Agents</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {d.signalFreshness.map(sig => {
                const fresh = !sig.present ? null : (sig.decay ?? 100);
                const freshHex = fresh == null ? NEON.slate : fresh >= FRESH_STRONG ? NEON.green : fresh >= FRESH_MODERATE ? NEON.yellow : NEON.pink;
                return (
                  <div key={sig.agent} className="flex items-center gap-2 p-2 rounded-lg bg-white/3 border border-white/8">
                    <div className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: freshHex, boxShadow: sig.present ? `0 0 5px ${freshHex}88` : "none" }} />
                    <div className="min-w-0">
                      <p className="text-xs font-medium capitalize truncate">{sig.agent.replace(/([A-Z])/g, ' $1')}</p>
                      <p className="text-[10px] text-muted-foreground">{!sig.present ? "No data" : `${fresh}% fresh`}</p>
                    </div>
                  </div>
                );
              })}
            </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* ── 10. Override History ────────────────────────────────────────── */}
      {d.overrides.length > 0 && (
        <Card className="border-border/50">
          <button type="button" className="w-full flex items-center justify-between px-5 py-4" onClick={() => toggle("overrides")}>
            <span className="flex items-center gap-2 text-sm font-semibold">
              <History className="w-4 h-4 text-primary" /> Override History
              <Badge variant="outline" className="text-xs">{d.overrides.length}</Badge>
            </span>
            <ChevronRight className={cn("w-4 h-4 text-muted-foreground transition-transform", expanded.overrides && "rotate-90")} />
          </button>
          {expanded.overrides && (
            <CardContent className="px-5 pb-5 space-y-3">
              {d.overrides.map((ov) => (
                <div key={ov.id} className="p-3 rounded-lg bg-white/3 border border-white/8 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="text-xs">{ov.originalDecision.replace(/_/g, " ")}</Badge>
                    <ArrowRight className="w-3 h-3 text-muted-foreground" />
                    <Badge variant="outline" className="text-xs text-primary border-primary/30">{ov.recruiterDecision.replace(/_/g, " ")}</Badge>
                    <span className="text-[10px] text-muted-foreground ml-auto">{new Date(ov.overriddenAt).toLocaleDateString()}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">"{ov.recruiterReason}"</p>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {/* ── 11. Action Buttons ──────────────────────────────────────────── */}
      <div className="flex gap-2 flex-wrap">
        <Button
          className="flex-1 gap-2"
          onClick={() => triggerMutation.mutate()}
          disabled={triggerMutation.isPending}
          style={{ background: `${actionCfg.hex}25`, borderColor: `${actionCfg.hex}50`, color: actionCfg.hex }}
          variant="outline"
        >
          {triggerMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Execute: {actionCfg.workflowLabel}
        </Button>
        <Button variant="outline" className="gap-2" onClick={() => setOverrideOpen(true)}>
          <UserCheck className="w-4 h-4" /> Override
        </Button>
        <Button variant="ghost" size="icon" onClick={() => refetch()} disabled={isFetching} title="Refresh" aria-label="Refresh intelligence">
          <RefreshCw className={cn("w-4 h-4", isFetching && "animate-spin")} />
        </Button>
      </div>

      {/* ── 12. Inline Feedback ─────────────────────────────────────────── */}
      {(executed || triggerMutation.isSuccess) && (
        <InlineFeedback jobId={jobId} candidateId={candidateId} />
      )}

      {/* ── Supporting/Blocking factors ─────────────────────────────────── */}
      {(dr.factors.supporting.length > 0 || dr.factors.blocking.length > 0) && (
        <div className="text-xs text-muted-foreground space-y-1 pt-1">
          {dr.factors.supporting.slice(0, 2).map((f, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0 text-emerald-400" /> {f}
            </div>
          ))}
          {dr.factors.blocking.slice(0, 2).map((f, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-400" /> {f}
            </div>
          ))}
        </div>
      )}

      {/* Override dialog */}
      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        jobId={jobId}
        candidateId={candidateId}
        currentDecision={dr.decision}
        candidateName={candidateName}
        onSuccess={() => refetch()}
      />
    </div>
  );
}
