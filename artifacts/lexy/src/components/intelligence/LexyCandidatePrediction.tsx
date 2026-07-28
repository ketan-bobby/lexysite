/**
 * components/intelligence/LexyCandidatePrediction.tsx — "Lexy Says" Hire Prediction
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Renders the "Lexy says" prediction surface — a plain-language summary of
 * the intelligence engine's prediction for whether this candidate will advance.
 * Answers four questions the recruiter cares about most:
 *
 *   1. Will this candidate likely move forward?  → Hire likelihood %
 *   2. At what stage might they drop off?        → Predicted failure risk
 *   3. What is driving the score?                → Up/down signal explanations
 *   4. How confident are we?                     → High / medium / low confidence
 *
 * ─── Design notes ────────────────────────────────────────────────────────────
 * Makes zero extra API calls — derives everything from the LexyCandidatePredictionData
 * prop passed by the parent. The parent fetches once from the intelligence endpoint
 * and shares the result across all sub-components.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/intelligence/CandidateIntelligenceCard.tsx
 */

import { useState } from "react";
import { useTheme } from "next-themes";
import { Brain, TrendingUp, TrendingDown, ShieldAlert, AlertCircle, CheckCircle2, Sparkles, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { bandBy } from "@/lib/score-band";
import { intelBandBy } from "@/lib/intelligence-bands";
import { displayScore } from "@/lib/score-display";
import { isTrustGated, TRUST_GATE_LABEL, TRUST_GATE_LABEL_LONG } from "@/lib/trust-gate";

/* ── Types ─────────────────────────────────────────────────────────────────── */
export interface LexyCandidatePredictionData {
  hireProbability: number | null;
  /* Raw stored dimension scores — null means "no signal yet" and must render
     as "—" (see @/lib/score-display), never a fabricated neutral value. */
  scores: {
    fitScore: number | null;
    qualityScore: number | null;
    trustScore: number | null;
    conversionScore: number | null;
    hireProbability: number | null;
  };
  stageProbs: {
    nextStageSuccessProbability: number;
    offerProbability: number;
    offerAcceptanceProbability: number;
    dropoffProbability: number;
  };
  decisionResult: {
    decision: string;
    confidence: number;
    reasoning: string;
    factors: { supporting: string[]; blocking: string[] };
    why_selected: string;
    explanation: { strengths: string[]; risks: string[] };
  };
  topStrengths?: string[] | null;
  topRisks?: string[] | null;
}

/* ── Derivation helpers ────────────────────────────────────────────────────── */

// ── Prediction thresholds (documented; distinct quantities, not the match band) ──
const PRED_CONF_HIGH = 72;      // decision-confidence label cutoffs (own scale)
const PRED_CONF_MEDIUM = 45;
const NARR_TRUST_MAX = 50;      // narrative-reason trust floor
const NARR_QUALITY_MAX = 45;    // narrative-reason quality floor
const NARR_FIT_MAX = 50;        // narrative-reason fit floor
const NARR_DROPOFF_MIN = 65;    // narrative-reason drop-off ceiling
const NARR_OFFER_MIN = 65;      // narrative-reason offer-prob trigger
const NARR_CONVERSION_MAX = 50; // narrative-reason conversion floor
// Stage-probability bands — positive metrics (higher better) & drop-off (inverted).
const STAGEPROB_POS_STRONG = 65;
const STAGEPROB_POS_MODERATE = 45;
const STAGEPROB_DROP_GOOD_MAX = 30;
const STAGEPROB_DROP_MODERATE_MAX = 50;

function deriveConfidenceLabel(score: number): "high" | "medium" | "low" {
  if (score >= PRED_CONF_HIGH) return "high";
  if (score >= PRED_CONF_MEDIUM) return "medium";
  return "low";
}

function derivePredictedRisk(
  data: LexyCandidatePredictionData,
): string {
  const { scores, stageProbs, decisionResult } = data;
  /* Narrative logic only: treat an UNKNOWN dimension as neutral-50 so a missing
     signal never trips a "below threshold" risk sentence. Display paths must
     keep the raw null (rendered as "—"). */
  const trustScore      = scores.trustScore      ?? 50;
  const qualityScore    = scores.qualityScore    ?? 50;
  const fitScore        = scores.fitScore        ?? 50;
  const conversionScore = scores.conversionScore ?? 50;
  const { dropoffProbability, offerProbability } = stageProbs;
  const { decision } = decisionResult;

  // Hard disqualifiers first
  if (decision === "reject")              return "fundamental skill or fit mismatch — unlikely to clear screening";
  if (decision === "manual_verification") return "identity verification challenge — trust signals need resolution before proceeding";

  // Stage-specific risks
  if (trustScore < NARR_TRUST_MAX)      return "identity verification stage — trust signals are below the required threshold";
  if (dropoffProbability > NARR_DROPOFF_MIN) return "candidate dropout risk — engagement may fade before the process completes";
  if (qualityScore < NARR_QUALITY_MAX)    return "technical or competency interview — current quality signals suggest performance risk";
  if (fitScore < NARR_FIT_MAX)        return "hiring manager review — role fit and domain depth may not fully align";
  if (decision === "re_engage") return "candidate disengagement — ghosting or slow response risk is elevated";
  if (offerProbability > NARR_OFFER_MIN && conversionScore < NARR_CONVERSION_MAX)
    return "offer acceptance — candidate may decline if competing offers are present";

  // Use top risk if available
  const topRisk = data.topRisks?.[0] ?? decisionResult.factors.blocking?.[0];
  if (topRisk) return topRisk.charAt(0).toLowerCase() + topRisk.slice(1);

  return "no significant failure point identified at current confidence level";
}

function deriveWhySignals(data: LexyCandidatePredictionData): { text: string; positive: boolean }[] {
  const signals: { text: string; positive: boolean }[] = [];

  // Positive signals — strengths first
  const strengths: string[] = [
    ...(data.topStrengths ?? []),
    ...(data.decisionResult.explanation?.strengths ?? []),
    ...(data.decisionResult.factors.supporting ?? []),
  ];

  // Negative signals — risks
  const risks: string[] = [
    ...(data.topRisks ?? []),
    ...(data.decisionResult.explanation?.risks ?? []),
    ...(data.decisionResult.factors.blocking ?? []),
  ];

  // Deduplicate and take top 2 positive + 2 negative
  const seen = new Set<string>();
  for (const s of strengths) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    const clean = s.charAt(0).toUpperCase() + s.slice(1);
    signals.push({ text: clean, positive: true });
    if (signals.filter(x => x.positive).length >= 3) break;
  }
  for (const r of risks) {
    if (!r || seen.has(r)) continue;
    seen.add(r);
    const clean = r.charAt(0).toUpperCase() + r.slice(1);
    signals.push({ text: clean, positive: false });
    if (signals.filter(x => !x.positive).length >= 2) break;
  }

  return signals;
}

/* ── Colour palette ────────────────────────────────────────────────────────── */
function hireLikelihoodPalette(hp: number) {
  return bandBy(hp, {
    strong: { hex: "#4ade80", bg: "rgba(74,222,128,0.08)", border: "rgba(74,222,128,0.25)", label: "Strong" },
    good:   { hex: "#facc15", bg: "rgba(250,204,21,0.08)",  border: "rgba(250,204,21,0.25)",  label: "Moderate" },
    fair:   { hex: "#fb7185", bg: "rgba(251,113,133,0.08)", border: "rgba(251,113,133,0.25)", label: "Weak" },
  });
}

const CONFIDENCE_CONFIG = {
  high:   { color: "text-emerald-700 dark:text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/25", dot: "bg-emerald-400" },
  medium: { color: "text-amber-700 dark:text-amber-400",   bg: "bg-amber-400/10 border-amber-400/25",     dot: "bg-amber-400"   },
  low:    { color: "text-rose-700 dark:text-rose-400",    bg: "bg-rose-400/10 border-rose-400/25",        dot: "bg-rose-400"    },
};

/* Darker hire-likelihood hex for light mode (neon washes out on white). */
function hireLikelihoodInk(hp: number): string {
  // Darker hire-likelihood hex for light mode — same canonical match band.
  return bandBy(hp, { strong: "#047857", good: "#a16207", fair: "#be123c" });
}

/* ── Progress bar ──────────────────────────────────────────────────────────── */
function HireBar({ value, hex }: { value: number; hex: string }) {
  return (
    <div className="h-2 w-full rounded-full bg-white/5 overflow-hidden">
      <div
        className="h-full rounded-full transition-all duration-700"
        style={{ width: `${value}%`, background: hex, boxShadow: `0 0 6px ${hex}55` }}
      />
    </div>
  );
}

/* ── Compact inline variant (for pipeline / list views) ─────────────────────── */
export function LexyCandidatePredictionInline({ data }: { data: LexyCandidatePredictionData }) {
  const { resolvedTheme } = useTheme();
  const light = resolvedTheme === "light";
  const hp = data.hireProbability ?? 0;
  const { hex: neonHex, label } = hireLikelihoodPalette(hp);
  const hex = light ? hireLikelihoodInk(hp) : neonHex;
  const confidenceLabel = deriveConfidenceLabel(data.decisionResult.confidence);
  const risk = derivePredictedRisk(data);
  const confCfg = CONFIDENCE_CONFIG[confidenceLabel];

  const gated = isTrustGated(data.scores.trustScore);

  return (
    <div className="flex items-center gap-3 text-xs flex-wrap">
      {/* Trust-gated: gate status leads, percentage demoted to secondary. */}
      {gated ? (
        <span className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold uppercase tracking-wide text-[10px] bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/40">
            <ShieldAlert className="w-3 h-3" /> {TRUST_GATE_LABEL}
          </span>
          <span className="text-[10px] text-muted-foreground/70">{hp}% if verified</span>
        </span>
      ) : (
        <span className="flex items-center gap-1 text-body dark:text-muted-foreground">
          <Brain className="w-3 h-3" />
          <span className="font-semibold" style={{ color: hex }}>{hp}%</span>
          <span className="text-body dark:text-muted-foreground/60">{label}</span>
        </span>
      )}
      <span className="text-muted-foreground/40">·</span>
      <span className="text-body dark:text-muted-foreground/70 truncate max-w-[200px]">Risk: {risk}</span>
      <span className="text-muted-foreground/40">·</span>
      <span className={cn("capitalize font-medium", confCfg.color)}>{confidenceLabel} confidence</span>
    </div>
  );
}

/* ── Main card component ───────────────────────────────────────────────────── */
interface LexyCandidatePredictionProps {
  data: LexyCandidatePredictionData;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  /** "full" = standalone card. "embedded" = no outer card, no padding (for embedding inside another card) */
  mode?: "full" | "embedded";
}

export function LexyCandidatePrediction({
  data,
  onRefresh,
  isRefreshing,
  mode = "full",
}: LexyCandidatePredictionProps) {
  const [showBreakdown, setShowBreakdown] = useState(false);

  const hp             = data.hireProbability ?? 0;
  const palette        = hireLikelihoodPalette(hp);
  const confidenceScore = data.decisionResult.confidence;
  const confidenceLabel = deriveConfidenceLabel(confidenceScore);
  const confCfg        = CONFIDENCE_CONFIG[confidenceLabel];
  const risk           = derivePredictedRisk(data);
  const signals        = deriveWhySignals(data);
  const { scores, stageProbs } = data;
  const gated          = isTrustGated(scores.trustScore);

  const inner = (
    <div className="space-y-5">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          {/* Lexy avatar */}
          <div
            className="w-8 h-8 rounded-xl flex items-center justify-center"
            style={{ background: `${palette.hex}18`, border: `1px solid ${palette.hex}35` }}
          >
            <Brain className="w-4 h-4" style={{ color: palette.hex }} />
          </div>
          <div>
            <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground leading-none">Lexy Prediction</p>
            <p className="text-[10px] text-muted-foreground/50 leading-none mt-0.5">AI hiring intelligence</p>
          </div>
        </div>
        {onRefresh && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 text-[10px] text-muted-foreground hover:text-foreground px-2"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={cn("w-3 h-3", isRefreshing && "animate-spin")} />
            Refresh
          </Button>
        )}
      </div>

      {/* ── The 4 answers ─────────────────────────────────────────────── */}
      <div className="space-y-4">

        {/* 1. Hire likelihood — or, when trust-gated, the gate status leads.
            RULE (see @/lib/trust-gate): the percentage is never the loudest
            element on a gated candidate's card. */}
        {gated ? (
          <div className="space-y-2">
            <div className="flex items-start justify-between gap-3 rounded-xl px-3.5 py-3 border border-amber-500/40 bg-amber-500/10">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/40 flex items-center justify-center shrink-0">
                  <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-black uppercase tracking-wide text-amber-600 dark:text-amber-400 leading-tight">
                    {TRUST_GATE_LABEL_LONG}
                  </p>
                  <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                    Trust {displayScore(scores.trustScore)} is below the advance threshold — a recruiter must verify before this candidate can move forward.
                  </p>
                </div>
              </div>
              <div className="text-right shrink-0">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground/70 leading-none">Hire likelihood</p>
                <p className="text-sm font-bold tabular-nums text-muted-foreground mt-1">{hp}%</p>
                <p className="text-[9px] text-muted-foreground/60 leading-none mt-0.5">pending verification</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Hire likelihood</span>
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="text-[10px] px-2 py-0 h-5"
                  style={{ color: palette.hex, borderColor: `${palette.hex}40`, background: `${palette.hex}12` }}
                >
                  {palette.label}
                </Badge>
                <span className="text-2xl font-black tabular-nums leading-none" style={{ color: palette.hex }}>
                  {hp}%
                </span>
              </div>
            </div>
            <HireBar value={hp} hex={palette.hex} />
          </div>
        )}

        {/* 2. Predicted risk */}
        <div className="flex gap-3 items-start">
          <div className="w-5 h-5 rounded-md bg-rose-400/10 border border-rose-400/25 flex items-center justify-center shrink-0 mt-0.5">
            <AlertCircle className="w-3 h-3 text-rose-400" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Predicted risk</p>
            <p className="text-sm text-foreground leading-snug capitalize-first">{risk}</p>
          </div>
        </div>

        {/* 3. Confidence */}
        <div className="flex gap-3 items-start">
          <div className={cn("w-5 h-5 rounded-md border flex items-center justify-center shrink-0 mt-0.5", confCfg.bg)}>
            <ShieldAlert className={cn("w-3 h-3", confCfg.color)} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Confidence</p>
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn("text-sm font-bold capitalize", confCfg.color)}>{confidenceLabel}</span>
              <span className="text-xs text-muted-foreground">— {confidenceScore}/100 signal coverage</span>
            </div>
          </div>
        </div>

        {/* 4. Why */}
        {signals.length > 0 && (
          <div className="flex gap-3 items-start">
            <div className="w-5 h-5 rounded-md bg-cyan-400/10 border border-cyan-400/25 flex items-center justify-center shrink-0 mt-0.5">
              <Sparkles className="w-3 h-3 text-cyan-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Why</p>
              <div className="space-y-1">
                {signals.map((sig, i) => (
                  <div key={i} className="flex items-start gap-1.5">
                    {sig.positive
                      ? <TrendingUp className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
                      : <TrendingDown className="w-3 h-3 text-rose-400 shrink-0 mt-0.5" />
                    }
                    <span className="text-xs text-muted-foreground leading-snug">{sig.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Stage probabilities breakdown (expandable) ───────────────────── */}
      <div>
        <button
          type="button"
          onClick={() => setShowBreakdown(b => !b)}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {showBreakdown ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {showBreakdown ? "Hide" : "Show"} stage breakdown
        </button>

        {showBreakdown && (
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[
              { label: "Clears next stage",  value: stageProbs.nextStageSuccessProbability, positive: true  },
              { label: "Reaches offer",      value: stageProbs.offerProbability,            positive: true  },
              { label: "Accepts offer",      value: stageProbs.offerAcceptanceProbability,  positive: true  },
              { label: "Drops off",          value: stageProbs.dropoffProbability,          positive: false },
            ].map(item => {
              const hex = item.positive
                ? item.value >= STAGEPROB_POS_STRONG ? "#4ade80" : item.value >= STAGEPROB_POS_MODERATE ? "#facc15" : "#fb7185"
                : item.value <= STAGEPROB_DROP_GOOD_MAX ? "#4ade80" : item.value <= STAGEPROB_DROP_MODERATE_MAX ? "#facc15" : "#fb7185";
              return (
                <div key={item.label} className="p-2.5 rounded-lg bg-white/3 border border-white/8 space-y-1.5">
                  <p className="text-[10px] text-muted-foreground leading-tight">{item.label}</p>
                  <p className="text-lg font-black tabular-nums leading-none" style={{ color: hex }}>{item.value}%</p>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Dimension scores row (compact) ──────────────────────────────── */}
      <div className="grid grid-cols-4 gap-2 pt-1 border-t border-border/30">
        {([
          { key: "fitScore",        label: "Fit"        },
          { key: "qualityScore",    label: "Quality"    },
          { key: "trustScore",      label: "Trust"      },
          { key: "conversionScore", label: "Conversion" },
        ] as const).map(dim => {
          const val = scores[dim.key];
          // Intelligence dimension mix — shared INTELLIGENCE band (see intelligence-bands.ts).
          const hex = val == null
            ? "#64748b"
            : intelBandBy(val, { strong: "#4ade80", moderate: "#facc15", weak: "#fb7185" });
          return (
            <div key={dim.key} className="text-center space-y-0.5">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wider">{dim.label}</p>
              <p className="text-base font-black tabular-nums leading-none" style={{ color: hex }}>{displayScore(val)}</p>
            </div>
          );
        })}
      </div>
    </div>
  );

  if (mode === "embedded") return inner;

  return (
    <div
      className="rounded-2xl border p-5"
      style={{ background: palette.bg, borderColor: palette.border }}
    >
      {inner}
    </div>
  );
}
