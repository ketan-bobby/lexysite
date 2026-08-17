/**
 * intelligence.ts — Hiring Intelligence Engine (v3)
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * This is the core scoring and decision engine for every candidate–job pair.
 * It receives raw "signals" from multiple AI agents (screening, interview,
 * proctoring, outreach, verification, etc.), calculates four composite scores,
 * rolls them into a single hire probability, then picks the Next Best Action
 * the recruiter or platform automation should take.
 *
 * ─── Data flow ──────────────────────────────────────────────────────────────
 *  Agent signals (AgentSignals)
 *       ↓
 *  Signal timestamps (SignalTimestamps) → Decay multipliers (per half-life)
 *       ↓
 *  computeScores()
 *    ├─ fitScore        (skill match 45% · experience 30% · ICP pattern 25%)
 *    ├─ qualityScore    (screening 40/60% · interview 40% · sourcing 20/40%)
 *    ├─ trustScore      (verification 50% · proctoring integrity 30% · fraud 20%)
 *    └─ conversionScore (outreach 30% · ghosting resistance 30% · scheduling 40%)
 *       ↓
 *  hireProbability = fit×35% + quality×25% + trust×20% + conversion×20%
 *       ↓
 *  decideNextAction() — waterfall rule engine → NextBestAction
 *    reject → manual_verification → advance → re_engage → schedule
 *    → recruiter_review → hold
 *       ↓
 *  Tenant policy gates — advanceThreshold, lowTrustThreshold, requireApproval
 *       ↓
 *  computeStageProbs() — nextStageSuccess, offerProbability, offerAcceptance, dropoff
 *       ↓
 *  upsertIntelligence() — merged signals written to candidate_job_intelligence table
 *
 * ─── Key design principles ───────────────────────────────────────────────────
 * • Signals are ADDITIVE — new agent data is merged over existing signals, never
 *   replaces the whole row. This means any agent can fire independently at any time.
 * • Timestamps decay — time-sensitive signals (engagement, ghosting, scheduling)
 *   use exponential half-life decay so stale data auto-reduces in weight.
 * • Confidence is a first-class output — every result carries a 0–100 confidence
 *   score and a breakdown (completeness, freshness, critical coverage) so the UI
 *   can show recruiters how much to trust the recommendation.
 * • Policy is tenant-configurable — thresholds, automation gates, and stage rules
 *   come from the tenant policy engine (policies.ts), not hardcoded values.
 * • Human overrides are tracked — when a recruiter overrides the engine's decision,
 *   the original recommendation + recruiter decision + reason are stored in
 *   overridesJson so the learning layer can measure recruiter accuracy over time.
 *
 * ─── v3 changes ──────────────────────────────────────────────────────────────
 *   1. Tenant Policy Layer — configurable thresholds, automation gates, stage rules
 *   2. Separated Decision vs Workflow Action — DecisionResult.decision + .workflowAction + .targetStage
 *   3. Improved Confidence Scoring — completeness + freshness + critical coverage + caps
 *   4. Signal Recency Decay — time-sensitive signals decay by exponential half-life
 *   5. Human Override Tracking — stored in overridesJson for learning layer analysis
 *   6. Stage-Aware Prediction — nextStageSuccess, offerProbability, offerAcceptance, dropoff
 */

import { db } from "@workspace/db";
import { candidateJobIntelligenceTable, candidatesTable } from "@workspace/db";
import { rankWithStaleness } from "./staleness.js";
import { eq, and, isNotNull, desc } from "drizzle-orm";
import { restrictToCompliantCandidates } from "./compliance-scope.js";
import { classBRead, CLASS_B_READ_EXEMPTION } from "./class-b-read";
import { intelTenantScope, type TenantScope } from "./class-b-access";
import { logger } from "./logger";
import { type ScoringConfig, BUILTIN_LIVE_CONFIG } from "./scoring-config";
import { getEffectiveScoringConfig } from "./learned-scoring";
import {
  getPolicy,
  describePolicyApplication,
  DEFAULT_POLICY,
  type TenantPolicy,
  type PolicyApplication,
} from "./policies";

/* ── Agent Signal Types ───────────────────────────────────────────────────── */

export interface AgentSignals {
  icp?: {
    requiredSkills?: string[];
    preferredSkills?: string[];
    disqualifiers?: string[];
    weightedAttributes?: Record<string, number>;
    mustHaves?: string[];
    seniority?: string;
    yearsExperienceMin?: number;
    yearsExperienceMax?: number;
  };
  sourcing?: {
    sourceType?: string;
    sourceConfidence?: number;
    profileCompleteness?: number;
    passiveCandidateScore?: number;
  };
  screening?: {
    resumeMatchScore?: number;
    skillMatchScore?: number;
    gapFlags?: string[];
    experienceScore?: number;
    recommendation?: string;
    score?: number;
    strengthAreas?: string[];
    gapAreas?: string[];
  };
  interview?: {
    communicationScore?: number;
    technicalDepthScore?: number;
    behavioralScore?: number;
    answerQualityScore?: number;
    interviewScore?: number;
    overallScore?: number;
    strengths?: string[];
    weaknesses?: string[];
    redFlags?: string[];
    recommendation?: string;
  };
  proctoring?: {
    fraudRiskScore?: number;
    gazeAnomalyFlag?: boolean;
    multipleFacesFlag?: boolean;
    integrityScore?: number;
    riskScore?: number;
  };
  outreach?: {
    openRate?: number;
    replyRate?: number;
    positiveReplyScore?: number;
    bestMessageVariant?: string;
  };
  antiGhosting?: {
    ghostingRiskScore?: number;
    engagementDecayScore?: number;
    reengagementSuccessRate?: number;
  };
  verification?: {
    identityConfidence?: number;
    linkedinMatchScore?: number;
    resumeConsistencyScore?: number;
    emailValidity?: boolean;
    verdict?: string;
  };
  scheduling?: {
    schedulingFrictionScore?: number;
    rescheduleCount?: number;
    noShowRisk?: number;
  };
  analytics?: {
    stageConversionBenchmark?: number;
    sourceQualityBenchmark?: number;
    similarHirePatternScore?: number;
    /* Provenance for recruiter-facing transparency: which strategy produced
     * similarHirePatternScore — "embedding" = kNN vs the tenant's real
     * successful hires; "fallback" = LLM-vs-ICP. */
    similarHireSource?: "embedding" | "fallback";
    similarHireExemplarCount?: number;
  };
}

export interface SignalTimestamps {
  icp?: string;
  sourcing?: string;
  screening?: string;
  interview?: string;
  proctoring?: string;
  outreach?: string;
  antiGhosting?: string;
  verification?: string;
  scheduling?: string;
  analytics?: string;
}

/* ── Decision / Action Types ─────────────────────────────────────────────── */

export type NextBestAction =
  | "advance"
  | "schedule"
  | "recruiter_review"
  | "re_engage"
  | "manual_verification"
  | "reject"
  | "hold";

export type WorkflowAction =
  | "move_to_offer"
  | "create_interview_schedule"
  | "send_reengagement_message"
  | "flag_for_verification"
  | "create_recruiter_task"
  | "close_application"
  | "pause_pipeline"
  | "await_approval";

export type PipelineStage =
  | "sourced"
  | "screening"
  | "interview"
  | "verification"
  | "offer"
  | "hired"
  | "rejected"
  | "on_hold"
  | "re_engaging";

export type ActionPriority = "critical" | "high" | "medium" | "low";

/* ── Confidence breakdown ─────────────────────────────────────────────────── */

export interface ConfidenceBreakdown {
  completeness: number; // 0–40: proportion of agent signals present
  freshness: number; // 0–30: how recent are time-sensitive signals
  criticalCoverage: number; // 0–30: critical signals (screening, verification, interview)
  total: number; // clamped 0–100
  caps: string[]; // reasons why confidence was capped
  signalCount: number; // how many agent signal groups actually back this score
}

/* ── Stage Predictions ─────────────────────────────────────────────────────── */

export interface StageProbs {
  nextStageSuccessProbability: number;
  offerProbability: number;
  offerAcceptanceProbability: number;
  dropoffProbability: number;
}

/* ── Decision Result ──────────────────────────────────────────────────────── */

export interface DecisionResult {
  // What the engine recommends
  decision: NextBestAction;
  // What should actually happen in the pipeline (separated from the signal decision)
  workflowAction: WorkflowAction;
  // Which pipeline stage this maps to
  targetStage: PipelineStage;
  // Which agent to trigger (if any)
  agentTrigger?: { agentId: string; reason: string };
  // Priority
  priority: ActionPriority;
  // Confidence with full breakdown
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
  // Explanation
  reasoning: string;
  factors: { supporting: string[]; blocking: string[] };
  why_selected: string;
  explanation: {
    fitScore: { increased: string[]; decreased: string[]; action: string };
    qualityScore: { increased: string[]; decreased: string[]; action: string };
    trustScore: { increased: string[]; decreased: string[]; action: string };
    conversionScore: { increased: string[]; decreased: string[]; action: string };
    why_selected: string;
    strengths: string[];
    risks: string[];
  };
  suggestedMessage?: string;
  // Policy
  policyApplied: boolean;
  policyOverrides: string[];
  requiresApproval: boolean;
}

/* ── Override Record ──────────────────────────────────────────────────────── */

export interface OverrideRecord {
  id: string;
  overriddenAt: string;
  originalDecision: NextBestAction;
  recruiterDecision: NextBestAction;
  recruiterReason: string;
  recruiterId?: string;
  finalOutcome?: string;
}

/* ── Intelligence Result ──────────────────────────────────────────────────── */

export interface CompositeScores {
  fitScore: number;
  qualityScore: number;
  trustScore: number;
  conversionScore: number;
  hireProbability: number;
}

export interface IntelligenceResult extends CompositeScores {
  nextBestAction: NextBestAction;
  decisionResult: DecisionResult;
  stageProbs: StageProbs;
  topStrengths: string[];
  topRisks: string[];
  explanationJson: DecisionResult["explanation"];
}

/* ── Outcome / Learning Types ─────────────────────────────────────────────── */

export type HiringOutcome =
  | "hired"
  | "rejected"
  | "ghosted"
  | "no_show"
  | "offer_accepted"
  | "offer_declined";

export interface LearningInsights {
  totalOutcomes: number;
  byOutcome: Record<string, number>;
  avgHireProbabilityAtHire: number | null;
  avgHireProbabilityAtReject: number | null;
  precisionScore: number | null;
  recallScore: number | null;
  calibrationDrift: number | null;
  overrideRate: number | null; // how often recruiters override the engine
  overrideAccuracyRate: number | null; // how often recruiter overrides led to better outcomes
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Clamp a numeric score to the 0–100 range and round to the nearest integer. */
function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/**
 * Weighted average over a list of (value, weight) pairs.
 * Pairs where `value` is undefined are skipped — the remaining weights are
 * re-normalised automatically, so missing signals don't drag the score to 0.
 * Returns 50 (neutral) when no pairs have a defined value.
 *
 * Example:
 *   weight([80, 0.45], [undefined, 0.30], [70, 0.25])
 *   → (80×0.45 + 70×0.25) / (0.45 + 0.25) = 76.4 → 76
 */
function weight(...pairs: [number | undefined, number][]): number {
  let score = 0;
  let totalWeight = 0;
  for (const [value, w] of pairs) {
    if (value !== undefined && w > 0) {
      score += value * w;
      totalWeight += w;
    }
  }
  return totalWeight > 0 ? score / totalWeight : 50;
}

/* ── Signal Recency Decay ─────────────────────────────────────────────────── */

/**
 * Half-lives in hours for each agent's signals.
 * Time-sensitive signals (engagement, ghosting) decay much faster than
 * structural signals (screening, verification).
 */
const SIGNAL_HALF_LIVES: Partial<Record<keyof AgentSignals, number>> = {
  outreach: 48, // engagement decays fast — 48h half-life
  antiGhosting: 24, // ghosting risk is extremely time-sensitive — 24h
  scheduling: 72, // friction/no-show risk — 72h
  interview: 168, // interview data — 7 days
  screening: 720, // resume/skill match — 30 days
  verification: 720, // identity data — 30 days
  proctoring: 720, // integrity flags are sticky
  sourcing: 720, // profile quality — 30 days
  analytics: 336, // pipeline benchmarks — 14 days
  icp: 8760, // role definition — 1 year
};

/**
 * Returns a decay multiplier [0.1, 1.0] for a signal type based on age.
 * Uses exponential decay: factor = 0.5 ^ (age_hours / half_life)
 */
export function decayFactor(agentKey: keyof AgentSignals, timestamps: SignalTimestamps): number {
  const halfLifeHours = SIGNAL_HALF_LIVES[agentKey];
  if (!halfLifeHours) return 1;

  const ts = timestamps[agentKey as keyof SignalTimestamps];
  if (!ts) return 0.85; // slight freshness penalty when no timestamp recorded

  const ageHours = (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60);
  if (ageHours < 0) return 1; // future timestamp (just recorded) — full weight
  return Math.max(0.1, Math.pow(0.5, ageHours / halfLifeHours));
}

/* ── Confidence Scoring ───────────────────────────────────────────────────── */

export function computeConfidence(
  signals: AgentSignals,
  timestamps: SignalTimestamps,
): ConfidenceBreakdown {
  const allAgents: (keyof AgentSignals)[] = [
    "screening",
    "sourcing",
    "interview",
    "proctoring",
    "outreach",
    "antiGhosting",
    "verification",
    "scheduling",
    "analytics",
  ];

  // 1. Signal Completeness (0–40)
  const present = allAgents.filter(
    (k) => signals[k] !== undefined && Object.keys(signals[k]!).length > 0,
  ).length;
  const completeness = Math.round((present / allAgents.length) * 40);

  // 2. Signal Freshness (0–30)
  // Weighted average decay factor for time-sensitive signals
  const timeSensitive: (keyof AgentSignals)[] = ["outreach", "antiGhosting", "scheduling"];
  const freshnessPairs = timeSensitive.map((k) => ({
    present: signals[k] !== undefined,
    decay: decayFactor(k, timestamps),
  }));
  const presentPairs = freshnessPairs.filter((p) => p.present);
  const avgDecay =
    presentPairs.length > 0
      ? presentPairs.reduce((s, p) => s + p.decay, 0) / presentPairs.length
      : 1.0; // no time-sensitive signals → no freshness penalty
  const freshness = Math.round(avgDecay * 30);

  // 3. Critical Signal Coverage (0–30)
  // screening = 15pts (fundamental fit data without which nothing is reliable)
  // verification = 8pts (trust data critical for hire decisions)
  // interview = 7pts (quality data that elevates confidence significantly)
  const critScreening = signals.screening ? 15 : 0;
  const critVerification = signals.verification ? 8 : 0;
  const critInterview = signals.interview ? 7 : 0;
  const criticalCoverage = critScreening + critVerification + critInterview;

  // Base total
  let total = completeness + freshness + criticalCoverage;

  // Apply caps for missing critical signals
  const caps: string[] = [];
  if (!signals.screening) {
    total = Math.min(total, 50);
    caps.push("Capped at 50% — no screening data (fundamental fit signals missing)");
  }
  if (!signals.verification && total > 80) {
    total = Math.min(total, 80);
    caps.push("Capped at 80% — no verification data (trust signals unconfirmed)");
  }
  if (!signals.interview && total > 85) {
    total = Math.min(total, 85);
    caps.push("Capped at 85% — no interview data (quality signals incomplete)");
  }

  return {
    completeness,
    freshness,
    criticalCoverage,
    total: clamp(total),
    caps,
    signalCount: present,
  };
}

/* ── Stage Probability Predictions ───────────────────────────────────────── */

export function computeStageProbs(scores: CompositeScores, signals: AgentSignals): StageProbs {
  const { fitScore, qualityScore, trustScore, conversionScore, hireProbability } = scores;

  // next_stage_success: can this candidate clear the next gate?
  // Driven by quality (can they perform?) + fit (is this the right role?) + trust (no red flags?)
  const nextStageSuccess = clamp(weight([qualityScore, 0.5], [fitScore, 0.3], [trustScore, 0.2]));

  // offer_probability: will this candidate receive an offer?
  // High hireProbability is necessary but trust must also be solid
  const offerProbability = clamp(hireProbability * 0.8 + Math.min(trustScore, 100) * 0.2);

  // offer_acceptance_probability: will they say yes?
  // Highly driven by engagement (are they still interested?) and positive reply signals
  const posReply = signals.outreach?.positiveReplyScore;
  const offerAcceptanceProbability = clamp(
    weight(
      [conversionScore, 0.55],
      [posReply, 0.25],
      [fitScore, 0.2], // if role fits them well, they're more likely to accept
    ),
  );

  // dropoff_probability: will they ghost or drop before completing the process?
  // Driven by ghosting risk + no-show risk + inverse of conversion
  const ghostingRisk =
    signals.antiGhosting?.ghostingRiskScore ?? Math.max(0, 100 - conversionScore);
  const noShowRisk = signals.scheduling?.noShowRisk ?? 30; // default low
  const dropoffProbability = clamp(
    weight([ghostingRisk, 0.5], [noShowRisk, 0.25], [100 - conversionScore, 0.25]),
  );

  return {
    nextStageSuccessProbability: nextStageSuccess,
    offerProbability,
    offerAcceptanceProbability,
    dropoffProbability,
  };
}

/* ── Decision → Workflow Mapping ────────────────────────────────────────────*/

function toWorkflowAction(decision: NextBestAction, policy: TenantPolicy): WorkflowAction {
  if (policy.requireRecruiterApproval && decision === "advance") return "await_approval";
  const map: Record<NextBestAction, WorkflowAction> = {
    advance: "move_to_offer",
    schedule: "create_interview_schedule",
    re_engage: "send_reengagement_message",
    manual_verification: "flag_for_verification",
    recruiter_review: "create_recruiter_task",
    reject: "close_application",
    hold: "pause_pipeline",
  };
  return map[decision];
}

function toTargetStage(decision: NextBestAction): PipelineStage {
  const map: Record<NextBestAction, PipelineStage> = {
    advance: "offer",
    schedule: "interview",
    re_engage: "re_engaging",
    manual_verification: "verification",
    recruiter_review: "screening",
    reject: "rejected",
    hold: "on_hold",
  };
  return map[decision];
}

/* ── Decision Engine ──────────────────────────────────────────────────────── */

export function decideNextAction(
  scores: CompositeScores,
  signals: AgentSignals,
  timestamps: SignalTimestamps = {},
  policy: TenantPolicy = DEFAULT_POLICY,
): DecisionResult {
  const { fitScore, qualityScore, trustScore, conversionScore, hireProbability } = scores;

  const confidenceBreakdown = computeConfidence(signals, timestamps);
  const confidence = confidenceBreakdown.total;

  const v = signals.verification;
  const ag = signals.antiGhosting;
  const s = signals.scheduling;
  const p = signals.proctoring;

  // ── Helper to assemble a full DecisionResult ──────────────────────────────
  function makeDecision(
    signalDecision: NextBestAction,
    priority: ActionPriority,
    reasoning: string,
    supporting: string[],
    blocking: string[],
    why_selected: string,
    suggestedMessage?: string,
    agentTrigger?: { agentId: string; reason: string },
    explanation?: Partial<DecisionResult["explanation"]>,
  ): DecisionResult {
    // Apply policy: can the signal decision be overridden?
    let finalDecision = signalDecision;

    // Policy override: low-trust candidate should reject not verify?
    if (
      signalDecision === "manual_verification" &&
      policy.lowTrustAction === "reject" &&
      trustScore < policy.lowTrustThreshold
    ) {
      finalDecision = "reject";
    }
    // Policy override: advance threshold raised?
    if (signalDecision === "advance" && hireProbability < policy.advanceThreshold) {
      finalDecision = "schedule";
    }
    // Policy override: schedule threshold raised?
    if (signalDecision === "schedule" && hireProbability < policy.scheduleThreshold) {
      finalDecision = "recruiter_review";
    }

    const { policyApplied, policyOverrides } = describePolicyApplication(
      signalDecision,
      finalDecision,
      policy,
      { trustScore, conversionScore, requiresApproval: policy.requireRecruiterApproval },
    );

    const requiresApproval = policy.requireRecruiterApproval && finalDecision === "advance";

    const workflowAction = toWorkflowAction(finalDecision, policy);
    const targetStage = toTargetStage(finalDecision);

    return {
      decision: finalDecision,
      workflowAction,
      targetStage,
      agentTrigger:
        !policy.allowAutoOutreach && agentTrigger?.agentId === "outreach"
          ? undefined
          : agentTrigger,
      priority,
      confidence,
      confidenceBreakdown,
      reasoning,
      factors: { supporting: supporting.filter(Boolean), blocking: blocking.filter(Boolean) },
      why_selected,
      explanation: {
        fitScore: { increased: [], decreased: [], action: "" },
        qualityScore: { increased: [], decreased: [], action: "" },
        trustScore: { increased: [], decreased: [], action: "" },
        conversionScore: { increased: [], decreased: [], action: "" },
        why_selected,
        strengths: supporting.slice(0, 3),
        risks: blocking.slice(0, 3),
        ...(explanation ?? {}),
      },
      suggestedMessage,
      policyApplied,
      policyOverrides,
      requiresApproval,
    };
  }

  // ── REJECT — hard disqualifiers ──────────────────────────────────────────
  if (v?.verdict === "flag" && hireProbability < 50) {
    return makeDecision(
      "reject",
      "critical",
      "Identity verification failed alongside low hire probability.",
      [
        "Verification returned a 'flag' verdict — identity signals mismatch",
        `Hire probability (${hireProbability}%) is below the 50% minimum threshold`,
      ],
      ["Successful re-verification could reverse this decision"],
      `Because identity verification explicitly failed and hire probability sits at ${hireProbability}%, continuing would carry significant legal and operational risk.`,
      "Thank you for your application. After careful review of your profile we are unable to move forward at this time.",
    );
  }

  if (qualityScore < policy.rejectMinQuality || fitScore < policy.rejectMinFit) {
    return makeDecision(
      "reject",
      "high",
      "Candidate does not meet minimum quality or fit thresholds.",
      [
        qualityScore < policy.rejectMinQuality
          ? `Quality score (${qualityScore}) below minimum (${policy.rejectMinQuality})`
          : "",
        fitScore < policy.rejectMinFit
          ? `Fit score (${fitScore}) indicates fundamental role mismatch`
          : "",
      ],
      ["Evidence of directly relevant experience or skills could change this"],
      `Because quality score is ${qualityScore}/100 and fit score is ${fitScore}/100 — both below policy minimums — advancing would consume pipeline resources without a reasonable chance of success.`,
      "Thank you for applying. After reviewing your profile we are not moving forward at this time.",
    );
  }

  // ── MANUAL VERIFICATION — trust gap on a promising candidate ─────────────
  if (hireProbability >= 55 && trustScore < policy.lowTrustThreshold) {
    return makeDecision(
      "manual_verification",
      "high",
      `Candidate shows strong potential (${hireProbability}%) but trust signals require human review.`,
      [
        `Hire probability (${hireProbability}%) indicates genuine potential`,
        `Trust score (${trustScore}) is below the ${policy.lowTrustThreshold}-point safety threshold`,
        v?.verdict === "review" ? "Verification flagged for manual review" : "",
        p?.multipleFacesFlag ? "Multiple faces detected during interview" : "",
      ],
      ["Successful manual verification would unlock advancement"],
      `Because this candidate shows strong potential at ${hireProbability}% hire probability but has trust signals that need resolution (trust: ${trustScore}), a recruiter must manually verify identity before proceeding.`,
      "We're completing a brief verification step before moving forward. We'll be in touch within 24 hours.",
      { agentId: "verification", reason: "Re-run verification to resolve identity discrepancies" },
    );
  }

  // ── ADVANCE — top-tier candidate ─────────────────────────────────────────
  if (hireProbability >= policy.advanceThreshold && fitScore >= 70 && trustScore >= 65) {
    return makeDecision(
      "advance",
      "critical",
      `Exceptional candidate — ${hireProbability}% hire probability with strong scores across all dimensions.`,
      [
        `Hire probability ${hireProbability}% — top of pipeline (threshold: ${policy.advanceThreshold}%)`,
        `Fit score ${fitScore} confirms strong role alignment`,
        `Trust score ${trustScore} — identity and integrity verified`,
        qualityScore >= 70 ? `Quality score ${qualityScore} — high-calibre candidate` : "",
        conversionScore >= 60 ? "High conversion likelihood — candidate is actively engaged" : "",
      ],
      [],
      `Because this candidate ranks in the top tier with ${hireProbability}% hire probability, ${fitScore} fit score, and ${trustScore} trust score — all above advancement thresholds — the system recommends advancing immediately to preserve momentum.`,
      "Great news — we'd love to move you to the next stage of our process. Expect a message from our team shortly.",
      {
        agentId: "outreach",
        reason: "Send an advance/offer-stage message to the candidate immediately",
      },
    );
  }

  // ── RE-ENGAGE — engagement collapsing ────────────────────────────────────
  const ghostRisk = ag?.ghostingRiskScore ?? 0;
  const decayedConversionIsLow = conversionScore < policy.reengageConversionThreshold;
  const ghostingIsHigh = ghostRisk >= 70;
  const engagementDecayed = (ag?.engagementDecayScore ?? 0) >= 70;

  if (decayedConversionIsLow || ghostingIsHigh || engagementDecayed) {
    // Apply freshness: if the ghosting signal is old, lower the urgency
    const ghostDecay = decayFactor("antiGhosting", timestamps);
    const urgentGhostSignal = ghostRisk >= 70 && ghostDecay > 0.5;
    return makeDecision(
      "re_engage",
      urgentGhostSignal ? "high" : "medium",
      "Candidate engagement is declining — intervention needed to prevent drop-off.",
      [
        decayedConversionIsLow
          ? `Conversion score (${conversionScore}) is critically low (threshold: ${policy.reengageConversionThreshold})`
          : "",
        ghostingIsHigh ? `Ghosting risk score (${ghostRisk}) indicates high abandonment risk` : "",
        engagementDecayed ? "Engagement decay detected across interactions" : "",
      ],
      [
        "A positive reply or scheduled step would reset the ghosting clock",
        ghostDecay < 0.5
          ? `Note: ghosting signal is ${Math.round((1 - ghostDecay) * 100)}% decayed — may be less urgent`
          : "",
      ],
      `Because conversion signals show the candidate is disengaging (conversion: ${conversionScore}, ghosting risk: ${ghostRisk}), an immediate re-engagement message is needed before the opportunity is lost.`,
      "Hi! We wanted to follow up on your application — we're still very interested and would love to keep the conversation going. Are you still available?",
      {
        agentId: "anti-ghosting",
        reason: "Trigger re-engagement sequence to prevent candidate from going cold",
      },
    );
  }

  // ── SCHEDULE — strong candidate, needs next validation step ──────────────
  if (hireProbability >= policy.scheduleThreshold && qualityScore >= 58) {
    return makeDecision(
      "schedule",
      "high",
      `Strong candidate (${hireProbability}%) — schedule next interview or call.`,
      [
        `Hire probability (${hireProbability}%) above scheduling threshold (${policy.scheduleThreshold}%)`,
        `Quality score (${qualityScore}) indicates high-calibre candidate`,
        fitScore >= 60 ? `Fit score (${fitScore}) confirms reasonable role alignment` : "",
        conversionScore >= 50 ? "Candidate is responsive and engaged" : "",
      ],
      [
        trustScore < 60 ? `Trust score (${trustScore}) should be confirmed before offer stage` : "",
        fitScore < 60 ? "Fit alignment could be strengthened through interview" : "",
      ],
      `Because the candidate demonstrates strong potential at ${hireProbability}% hire probability and ${qualityScore} quality score, the next step is a structured interview or call to validate role fit before advancing.`,
      "We'd love to schedule a conversation to learn more about your experience. Please find a time that works using the link below.",
      {
        agentId: "scheduling",
        reason: "Generate interview link and calendar invite for this candidate",
      },
    );
  }

  // ── RECRUITER REVIEW — mixed signals, needs human judgement ──────────────
  if (hireProbability >= 45) {
    const mixedSignals: string[] = [];
    if (fitScore >= 60 && qualityScore < 50) mixedSignals.push("High fit but low quality");
    if (qualityScore >= 60 && fitScore < 50) mixedSignals.push("High quality but low role fit");
    if (trustScore < 55) mixedSignals.push("Trust signals unresolved");
    if (conversionScore < 50) mixedSignals.push("Conversion signals weak");

    return makeDecision(
      "recruiter_review",
      "medium",
      "Mixed signals require human judgment before the next automated step.",
      [
        `Hire probability (${hireProbability}%) above hold threshold`,
        "Candidate has potential but signals are contradictory",
        ...mixedSignals,
      ],
      [
        "Clarifying the dominant concern would unlock a clear automated path",
        "Interview performance or verification could resolve ambiguity",
      ],
      `Because the candidate sits at ${hireProbability}% hire probability with conflicting signals (${mixedSignals.length > 0 ? mixedSignals.join("; ") : "scores vary across dimensions"}), an automated decision would carry too much uncertainty.`,
    );
  }

  // ── HOLD ──────────────────────────────────────────────────────────────────
  return makeDecision(
    "hold",
    "low",
    `Candidate does not yet meet thresholds for any active step — monitor pipeline.`,
    [
      `Hire probability (${hireProbability}%) is below the recruiter review threshold (45%)`,
      confidenceBreakdown.total < 50
        ? "Limited signal coverage — more agent data needed"
        : "Scores are below action thresholds across dimensions",
    ],
    [
      "New agent signals (screening, interview, verification) could move this candidate",
      "A stronger sourcing profile or updated resume could unlock reconsideration",
    ],
    `Because the candidate's hire probability is ${hireProbability}% and does not meet the minimum threshold for any active recruiting step, they are placed on hold pending additional signals.`,
  );
}

/* ── Scoring Engine ───────────────────────────────────────────────────────── */

/**
 * Primary entry point for the intelligence engine.
 * Loads the tenant's policy (with role/stage overrides if provided),
 * then delegates to computeScores() which does all the heavy lifting.
 * Use this when you have a tenantId and want policy-aware scoring.
 * Use computeScores() directly when you already have a policy object (e.g. in tests).
 */
export async function computeIntelligence(
  signals: AgentSignals,
  timestamps: SignalTimestamps = {},
  tenantId = "demo",
  roleId?: string,
  stage?: string,
): Promise<IntelligenceResult> {
  const policy = await getPolicy(tenantId, roleId, stage);
  const config = await getEffectiveScoringConfig(tenantId);
  return computeScores(signals, timestamps, policy, config);
}

export function computeScores(
  signals: AgentSignals,
  timestamps: SignalTimestamps = {},
  policy: TenantPolicy = DEFAULT_POLICY,
  config: ScoringConfig = BUILTIN_LIVE_CONFIG,
): IntelligenceResult {
  const {
    icp,
    sourcing,
    screening,
    interview,
    proctoring,
    outreach,
    antiGhosting,
    verification,
    scheduling,
    analytics,
  } = signals;
  const w = config.weights;

  // Pre-compute decay factors for time-sensitive conversion signals
  const outreachDecay = decayFactor("outreach", timestamps);
  const ghostingDecay = decayFactor("antiGhosting", timestamps);
  const schedulingDecay = decayFactor("scheduling", timestamps);

  /* ── FIT SCORE ────────────────────────────────────────────────────────────
   * How well does the candidate match the role requirements?
   * Weights: skills 45% · experience 30% · ICP pattern match 25%
   */
  const fitIncreased: string[] = [];
  const fitDecreased: string[] = [];

  const screeningMatchScore =
    screening?.skillMatchScore ?? screening?.resumeMatchScore ?? screening?.score;
  const experienceScore = screening?.experienceScore;
  const icpAlignmentScore = analytics?.similarHirePatternScore;

  const fitScore = clamp(
    weight(
      [screeningMatchScore, w.fit.skills],
      [experienceScore, w.fit.experience],
      [icpAlignmentScore, w.fit.icp],
    ),
  );

  if ((screeningMatchScore ?? 0) >= 75)
    fitIncreased.push("Strong skill alignment with role requirements");
  if ((screeningMatchScore ?? 0) < 50)
    fitDecreased.push("Skill gaps identified against ICP requirements");
  if ((experienceScore ?? 0) >= 70) fitIncreased.push("Experience level matches role expectations");
  if ((experienceScore ?? 0) < 40) fitDecreased.push("Experience level below minimum threshold");
  if (icp?.disqualifiers?.length && (screening?.gapFlags?.length ?? 0) > 0)
    fitDecreased.push(`${screening!.gapFlags!.length} disqualifier(s) flagged from ICP`);
  if (screening?.strengthAreas && screening.strengthAreas.length >= 3)
    fitIncreased.push(`Strong in: ${screening.strengthAreas.slice(0, 3).join(", ")}`);
  if (screening?.gapAreas && screening.gapAreas.length >= 2)
    fitDecreased.push(`Gaps in: ${screening.gapAreas.slice(0, 2).join(", ")}`);

  /* ── QUALITY SCORE ────────────────────────────────────────────────────────
   * What is the caliber of this candidate?
   * Weights shift when interview data exists: screening 40% · interview 40% · sourcing 20%
   * Without interview: screening 60% · sourcing 40%
   */
  const qualIncreased: string[] = [];
  const qualDecreased: string[] = [];

  const interviewComposite = interview
    ? weight(
        [interview.communicationScore, w.interviewComposite.communication],
        [interview.technicalDepthScore, w.interviewComposite.technicalDepth],
        [interview.behavioralScore, w.interviewComposite.behavioral],
        [interview.answerQualityScore, w.interviewComposite.answerQuality],
      )
    : undefined;

  const interviewSignal =
    interviewComposite ?? interview?.interviewScore ?? interview?.overallScore;
  const sourceQuality = sourcing?.sourceConfidence ?? sourcing?.profileCompleteness;

  const qualityScore = interview
    ? clamp(
        weight(
          [screening?.score ?? screeningMatchScore, w.quality.withInterview.screening],
          [interviewSignal, w.quality.withInterview.interview],
          [sourceQuality, w.quality.withInterview.sourcing],
        ),
      )
    : clamp(
        weight(
          [screening?.score ?? screeningMatchScore, w.quality.withoutInterview.screening],
          [sourceQuality, w.quality.withoutInterview.sourcing],
        ),
      );

  if ((screening?.score ?? 0) >= 75) qualIncreased.push("High resume screening score");
  if ((screening?.score ?? 0) < 50) qualDecreased.push("Below-average resume screening result");
  if (interview) {
    if ((interview.technicalDepthScore ?? interviewSignal ?? 0) >= 75)
      qualIncreased.push("Strong technical depth demonstrated in interview");
    if ((interview.technicalDepthScore ?? interviewSignal ?? 0) < 50)
      qualDecreased.push("Technical depth below expectations in interview");
    if ((interview.communicationScore ?? 0) >= 75)
      qualIncreased.push("Excellent communication skills observed");
    if ((interview.behavioralScore ?? 0) >= 75)
      qualIncreased.push("Strong behavioral indicators — good culture fit");
    if (interview.redFlags?.length)
      qualDecreased.push(`Interview red flags: ${interview.redFlags.slice(0, 2).join(", ")}`);
    if (interview.recommendation === "yes")
      qualIncreased.push("Interviewer recommendation: advance");
    if (interview.recommendation === "no")
      qualDecreased.push("Interviewer recommendation: do not advance");
  }
  if ((sourceQuality ?? 0) >= 80)
    qualIncreased.push("High-quality sourcing — verified platform profile");
  if ((sourcing?.profileCompleteness ?? 0) < 50) qualDecreased.push("Incomplete sourcing profile");

  /* ── TRUST SCORE ──────────────────────────────────────────────────────────
   * Can we trust this candidate's identity and information?
   * Weights: verification 50% · proctoring integrity 30% · fraud inverse 20%
   */
  const trustIncreased: string[] = [];
  const trustDecreased: string[] = [];

  const integrityScore =
    proctoring?.integrityScore ??
    (proctoring?.riskScore !== undefined ? 100 - proctoring.riskScore : undefined);
  const fraudInverse =
    proctoring?.fraudRiskScore !== undefined ? 100 - proctoring.fraudRiskScore : undefined;
  const verificationComposite = verification
    ? weight(
        [verification.identityConfidence, w.verificationComposite.identity],
        [verification.linkedinMatchScore, w.verificationComposite.linkedin],
        [verification.resumeConsistencyScore, w.verificationComposite.resumeConsistency],
      )
    : undefined;

  const trustScore = clamp(
    weight(
      [verificationComposite, w.trust.verification],
      [integrityScore, w.trust.integrity],
      [fraudInverse, w.trust.fraud],
    ),
  );

  if (verification?.verdict === "clear")
    trustIncreased.push("Identity verification passed — all signals clear");
  if (verification?.verdict === "review")
    trustDecreased.push("Verification flagged for manual review");
  if (verification?.verdict === "flag")
    trustDecreased.push("Verification failed — identity signals mismatch");
  if ((verification?.linkedinMatchScore ?? 0) >= 80)
    trustIncreased.push("LinkedIn profile matches resume data");
  if ((verification?.resumeConsistencyScore ?? 0) < 60)
    trustDecreased.push("Resume inconsistencies detected");
  if (proctoring?.multipleFacesFlag)
    trustDecreased.push("Multiple faces detected during video interview");
  if (proctoring?.gazeAnomalyFlag) trustDecreased.push("Gaze anomalies detected during interview");
  if ((integrityScore ?? 50) >= 80)
    trustIncreased.push("High interview integrity score — no anomalies");
  if (verification?.emailValidity === false)
    trustDecreased.push("Email address could not be validated");

  /* ── CONVERSION SCORE ─────────────────────────────────────────────────────
   * How likely is this candidate to complete the hiring process?
   * Decay-weighted: outreach, ghosting, and scheduling signals all decay over time.
   * Weights: outreach 30% · ghosting resistance 30% · scheduling ease 25% · no-show safety 15%
   */
  const convIncreased: string[] = [];
  const convDecreased: string[] = [];

  // Apply decay to each time-sensitive signal before weighting
  const ghostingResistance =
    antiGhosting?.ghostingRiskScore !== undefined
      ? (100 - antiGhosting.ghostingRiskScore) * ghostingDecay
      : undefined;
  const schedulingEase =
    scheduling?.schedulingFrictionScore !== undefined
      ? (100 - scheduling.schedulingFrictionScore) * schedulingDecay
      : undefined;
  const noShowSafety =
    scheduling?.noShowRisk !== undefined
      ? (100 - scheduling.noShowRisk) * schedulingDecay
      : undefined;

  const outreachComposite = outreach
    ? weight(
        [outreach.openRate, w.outreachComposite.openRate],
        [outreach.replyRate, w.outreachComposite.replyRate],
        [outreach.positiveReplyScore, w.outreachComposite.positiveReply],
      ) * outreachDecay
    : undefined;

  const conversionScore = clamp(
    weight(
      [outreachComposite, w.conversion.outreach],
      [ghostingResistance, w.conversion.ghostingResistance],
      [schedulingEase, w.conversion.scheduling],
      [noShowSafety, w.conversion.noShow],
    ),
  );

  if ((outreach?.replyRate ?? 0) >= 70)
    convIncreased.push("High outreach reply rate — candidate is responsive");
  if ((outreach?.replyRate ?? 0) < 30)
    convDecreased.push("Low reply rate — candidate not engaging with outreach");
  if ((antiGhosting?.ghostingRiskScore ?? 0) >= 70)
    convDecreased.push("High ghosting risk — engagement declining");
  if ((antiGhosting?.ghostingRiskScore ?? 0) < 30)
    convIncreased.push("Low ghosting risk — candidate actively engaged");
  if ((scheduling?.rescheduleCount ?? 0) >= 2)
    convDecreased.push(`Rescheduled ${scheduling!.rescheduleCount} times`);
  if ((scheduling?.rescheduleCount ?? 0) === 0 && scheduling)
    convIncreased.push("No reschedules — reliable scheduling behavior");
  if (outreachDecay < 0.6 && outreach)
    convDecreased.push(
      `Outreach data is ${Math.round((1 - outreachDecay) * 100)}% decayed — engagement signal is stale`,
    );
  if (ghostingDecay < 0.5 && antiGhosting)
    convDecreased.push(
      `Ghosting signal is ${Math.round((1 - ghostingDecay) * 100)}% decayed — re-check engagement`,
    );

  /* ── HIRE PROBABILITY ─────────────────────────────────────────────────────
   * Fit 35% · Quality 25% · Trust 20% · Conversion 20%
   */
  const hireProbability = clamp(
    fitScore * w.hireProbability.fit +
      qualityScore * w.hireProbability.quality +
      trustScore * w.hireProbability.trust +
      conversionScore * w.hireProbability.conversion,
  );

  const compositeScores: CompositeScores = {
    fitScore,
    qualityScore,
    trustScore,
    conversionScore,
    hireProbability,
  };

  /* ── STAGE PREDICTIONS ───────────────────────────────────────────────────*/
  const stageProbs = computeStageProbs(compositeScores, signals);

  /* ── DECISION ENGINE ─────────────────────────────────────────────────────*/
  const decisionResult = decideNextAction(compositeScores, signals, timestamps, policy);

  // Inject per-dimension explanation into decisionResult
  decisionResult.explanation.fitScore = {
    increased: fitIncreased,
    decreased: fitDecreased,
    action: `Fit: ${fitScore >= 70 ? "strong" : fitScore >= 50 ? "moderate" : "weak"} match`,
  };
  decisionResult.explanation.qualityScore = {
    increased: qualIncreased,
    decreased: qualDecreased,
    action: `Quality drives ${qualityScore >= 70 ? "strong" : qualityScore >= 50 ? "moderate" : "weak"} confidence`,
  };
  decisionResult.explanation.trustScore = {
    increased: trustIncreased,
    decreased: trustDecreased,
    action:
      trustScore >= 70 ? "Identity and integrity verified" : "Additional verification recommended",
  };
  decisionResult.explanation.conversionScore = {
    increased: convIncreased,
    decreased: convDecreased,
    action:
      conversionScore >= 70 ? "Strong conversion likelihood" : "Re-engage to prevent drop-off",
  };

  const nextBestAction = decisionResult.decision;

  /* ── TOP STRENGTHS & RISKS ───────────────────────────────────────────────*/
  const allStrengths = [
    ...fitIncreased,
    ...qualIncreased,
    ...trustIncreased,
    ...convIncreased,
    ...(interview?.strengths ?? []).slice(0, 2),
    ...decisionResult.factors.supporting.slice(0, 1),
  ];
  const allRisks = [
    ...fitDecreased,
    ...qualDecreased,
    ...trustDecreased,
    ...convDecreased,
    ...(interview?.weaknesses ?? []).slice(0, 1),
    ...(interview?.redFlags ?? []).slice(0, 1),
    ...decisionResult.factors.blocking.slice(0, 1),
    ...decisionResult.confidenceBreakdown.caps.slice(0, 1),
  ];

  const topStrengths = [...new Set(allStrengths)].slice(0, 5);
  const topRisks = [...new Set(allRisks)].slice(0, 5);

  decisionResult.explanation.strengths = topStrengths;
  decisionResult.explanation.risks = topRisks;
  decisionResult.explanation.why_selected = decisionResult.why_selected;

  return {
    fitScore,
    qualityScore,
    trustScore,
    conversionScore,
    hireProbability,
    nextBestAction,
    decisionResult,
    stageProbs,
    topStrengths,
    topRisks,
    explanationJson: decisionResult.explanation,
  };
}

/* ── Persistence ──────────────────────────────────────────────────────────── */

/**
 * Merge new agent signals into the existing intelligence row for a candidate–job pair,
 * recompute all scores, and persist the result to `candidate_job_intelligence`.
 *
 * Signal merging strategy:
 *   • Existing signals that are NOT in `newSignals` are preserved untouched.
 *   • Keys that ARE in `newSignals` fully replace their previous value.
 *   • The signal's timestamp is updated to `now` whenever it is replaced,
 *     so the decay clock resets on every new data point from that agent.
 *
 * This means agents are completely independent — any agent can call upsertIntelligence
 * at any time without needing to know what other agents have already contributed.
 */
export async function upsertIntelligence(
  tenantId: string,
  jobId: string,
  candidateId: string,
  newSignals: AgentSignals,
): Promise<IntelligenceResult> {
  // Defensive guard: candidateId MUST reference a real candidates row.
  // Callers occasionally pass a sourced_candidates.id by mistake when no
  // normalised record exists yet — that produces orphan intelligence rows
  // that surface in the UI as "Unknown" candidates. Guard here so the
  // intelligence layer is the single source of truth on referential integrity
  // rather than relying on every caller to do the right thing.
  if (!candidateId) {
    throw new Error("upsertIntelligence: candidateId is required");
  }
  const [candidateRow] = await db
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId))
    .limit(1);
  if (!candidateRow) {
    throw new Error(`upsertIntelligence: candidate ${candidateId} not found in candidates table`);
  }

  const existing = await db
    .select({
      id: candidateJobIntelligenceTable.id,
      signalsJson: candidateJobIntelligenceTable.signalsJson,
      signalTimestampsJson: candidateJobIntelligenceTable.signalTimestampsJson,
    })
    .from(candidateJobIntelligenceTable)
    .where(
      and(
        eq(candidateJobIntelligenceTable.jobId, jobId),
        eq(candidateJobIntelligenceTable.candidateId, candidateId),
      ),
    )
    .limit(1);

  // Merge signals
  const mergedSignals: AgentSignals = {
    ...((existing[0]?.signalsJson as AgentSignals) ?? {}),
    ...Object.fromEntries(Object.entries(newSignals).filter(([, v]) => v !== undefined)),
  };

  // Merge + update timestamps for agents that provided new signals now
  const existingTs: SignalTimestamps =
    (existing[0]?.signalTimestampsJson as SignalTimestamps) ?? {};
  const now = new Date().toISOString();
  const updatedTs: SignalTimestamps = { ...existingTs };
  for (const agentKey of Object.keys(newSignals) as (keyof AgentSignals)[]) {
    if (newSignals[agentKey] !== undefined) {
      (updatedTs as any)[agentKey] = now;
    }
  }

  const policy = await getPolicy(tenantId);
  const config = await getEffectiveScoringConfig(tenantId);
  const finalResult = computeScores(mergedSignals, updatedTs, policy, config);

  const payload = {
    tenantId,
    jobId,
    candidateId,
    fitScore: finalResult.fitScore,
    qualityScore: finalResult.qualityScore,
    trustScore: finalResult.trustScore,
    conversionScore: finalResult.conversionScore,
    hireProbability: finalResult.hireProbability,
    nextBestAction: finalResult.nextBestAction,
    topStrengths: finalResult.topStrengths,
    topRisks: finalResult.topRisks,
    explanationJson: finalResult.explanationJson,
    signalsJson: mergedSignals,
    signalTimestampsJson: updatedTs,
    stageProbsJson: finalResult.stageProbs,
    modelVersion: config.version,
    lastUpdated: new Date(),
  };

  if (existing.length > 0) {
    await db
      .update(candidateJobIntelligenceTable)
      .set(payload)
      .where(
        and(
          eq(candidateJobIntelligenceTable.jobId, jobId),
          eq(candidateJobIntelligenceTable.candidateId, candidateId),
        ),
      );
  } else {
    await db.insert(candidateJobIntelligenceTable).values(payload);
  }

  logger.info(
    {
      jobId,
      candidateId,
      hireProbability: finalResult.hireProbability,
      decision: finalResult.decisionResult.decision,
      workflowAction: finalResult.decisionResult.workflowAction,
      targetStage: finalResult.decisionResult.targetStage,
      confidence: finalResult.decisionResult.confidence,
      policyApplied: finalResult.decisionResult.policyApplied,
    },
    "Intelligence upserted",
  );

  return finalResult;
}

/* ── Interview Signal Injector ────────────────────────────────────────────── */

export async function upsertIntelligenceFromInterviewSession(
  sessionId: string,
  sessionData: {
    tenantId: string;
    jobId: string;
    candidateId: string;
    answers: Array<{ questionId: string; answer: string; score: number | null; feedback?: string }>;
    overallScore: number;
    strengths?: string[];
    weaknesses?: string[];
    redFlags?: string[];
    recommendation?: string;
  },
): Promise<IntelligenceResult | null> {
  try {
    const {
      tenantId,
      jobId,
      candidateId,
      answers,
      overallScore,
      strengths,
      weaknesses,
      redFlags,
      recommendation,
    } = sessionData;

    // Average only over answers that were actually scored; never substitute a
    // flattering default for an unscored/failed answer. Fall back to the
    // holistic overallScore when nothing was graded numerically.
    const scores = answers.map((a) => a.score).filter((v): v is number => typeof v === "number");
    const avgScore =
      scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : overallScore;

    const interviewSignals: AgentSignals["interview"] = {
      interviewScore: clamp(avgScore),
      overallScore: clamp(overallScore),
      communicationScore: clamp(avgScore * 0.95 + Math.random() * 5),
      technicalDepthScore: clamp(avgScore * 0.9 + Math.random() * 10),
      behavioralScore: clamp(avgScore * 1.0 + (Math.random() * 5 - 2)),
      answerQualityScore: clamp(avgScore),
      strengths: strengths ?? [],
      weaknesses: weaknesses ?? [],
      redFlags: redFlags ?? [],
      recommendation,
    };

    const result = await upsertIntelligence(tenantId, jobId, candidateId, {
      interview: interviewSignals,
    });
    logger.info(
      { sessionId, candidateId, jobId, interviewScore: avgScore },
      "Intelligence updated from interview session",
    );
    return result;
  } catch (err) {
    logger.error({ err, sessionId }, "Failed to upsert intelligence from interview session");
    return null;
  }
}

/* ── Human Override Tracking ─────────────────────────────────────────────── */

export async function recordOverride(
  jobId: string,
  candidateId: string,
  originalDecision: NextBestAction,
  recruiterDecision: NextBestAction,
  recruiterReason: string,
  recruiterId?: string,
): Promise<void> {
  const rows = await db
    .select({
      id: candidateJobIntelligenceTable.id,
      overridesJson: candidateJobIntelligenceTable.overridesJson,
    })
    .from(candidateJobIntelligenceTable)
    .where(
      and(
        eq(candidateJobIntelligenceTable.jobId, jobId),
        eq(candidateJobIntelligenceTable.candidateId, candidateId),
      ),
    )
    .limit(1);

  if (rows.length === 0) return;

  const existing: OverrideRecord[] = (rows[0].overridesJson as OverrideRecord[]) ?? [];
  const newOverride: OverrideRecord = {
    id: crypto.randomUUID(),
    overriddenAt: new Date().toISOString(),
    originalDecision,
    recruiterDecision,
    recruiterReason,
    recruiterId,
  };

  await db
    .update(candidateJobIntelligenceTable)
    .set({ overridesJson: [...existing, newOverride] })
    .where(eq(candidateJobIntelligenceTable.id, rows[0].id));

  logger.info(
    { jobId, candidateId, originalDecision, recruiterDecision, recruiterReason },
    "Human override recorded",
  );
}

/* ── Outcome Tracking ────────────────────────────────────────────────────── */

export async function recordOutcome(
  jobId: string,
  candidateId: string,
  outcome: HiringOutcome,
): Promise<void> {
  await db
    .update(candidateJobIntelligenceTable)
    .set({ outcome, outcomeAt: new Date() })
    .where(
      and(
        eq(candidateJobIntelligenceTable.jobId, jobId),
        eq(candidateJobIntelligenceTable.candidateId, candidateId),
      ),
    );
  logger.info({ jobId, candidateId, outcome }, "Hiring outcome recorded");
}

/* ── Learning Layer ──────────────────────────────────────────────────────── */

export async function getLearningInsights(): Promise<LearningInsights> {
  /* INTENTIONALLY cross-tenant: pools hiring outcomes across ALL tenants to
     compute aggregate learning metrics (precision/recall/calibration/override
     rates). Returns ONLY aggregates — never per-candidate PII — and every
     serving surface is gated to platform_admin. Tenant-scoping would defeat it. */
  classBRead(CLASS_B_READ_EXEMPTION.CROSS_TENANT_MODEL_TRAINING);
  const rows = await db
    .select({
      outcome: candidateJobIntelligenceTable.outcome,
      nextBestAction: candidateJobIntelligenceTable.nextBestAction,
      hireProbability: candidateJobIntelligenceTable.hireProbability,
      overridesJson: candidateJobIntelligenceTable.overridesJson,
    })
    .from(candidateJobIntelligenceTable)
    .where(isNotNull(candidateJobIntelligenceTable.outcome))
    .orderBy(desc(candidateJobIntelligenceTable.outcomeAt));

  if (rows.length === 0) {
    return {
      totalOutcomes: 0,
      byOutcome: {},
      avgHireProbabilityAtHire: null,
      avgHireProbabilityAtReject: null,
      precisionScore: null,
      recallScore: null,
      calibrationDrift: null,
      overrideRate: null,
      overrideAccuracyRate: null,
    };
  }

  const byOutcome: Record<string, number> = {};
  for (const row of rows) {
    if (row.outcome) byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
  }

  const hiredRows = rows.filter((r) => r.outcome === "hired" || r.outcome === "offer_accepted");
  const rejectedRows = rows.filter((r) => r.outcome === "rejected");

  const avgHireProbabilityAtHire =
    hiredRows.length > 0
      ? Math.round(hiredRows.reduce((s, r) => s + (r.hireProbability ?? 50), 0) / hiredRows.length)
      : null;
  const avgHireProbabilityAtReject =
    rejectedRows.length > 0
      ? Math.round(
          rejectedRows.reduce((s, r) => s + (r.hireProbability ?? 50), 0) / rejectedRows.length,
        )
      : null;

  const truePositives = rows.filter(
    (r) =>
      r.nextBestAction === "advance" && (r.outcome === "hired" || r.outcome === "offer_accepted"),
  ).length;
  const advancedTotal = rows.filter((r) => r.nextBestAction === "advance").length;
  const precisionScore =
    advancedTotal > 0 ? Math.round((truePositives / advancedTotal) * 100) : null;
  const recallScore =
    hiredRows.length > 0 ? Math.round((truePositives / hiredRows.length) * 100) : null;

  const meanPredicted = rows.reduce((s, r) => s + (r.hireProbability ?? 50), 0) / rows.length;
  const actualHireRate = (hiredRows.length / rows.length) * 100;
  const calibrationDrift = Math.round(Math.abs(meanPredicted - actualHireRate));

  // Override analytics
  const rowsWithOverrides = rows.filter(
    (r) => Array.isArray(r.overridesJson) && (r.overridesJson as OverrideRecord[]).length > 0,
  );
  const overrideRate =
    rows.length > 0 ? Math.round((rowsWithOverrides.length / rows.length) * 100) : null;

  // Override accuracy: recruiter overrode to advance and outcome was hired
  let overrideHireSuccess = 0;
  let overrideTotal = 0;
  for (const row of rowsWithOverrides) {
    const overrides = row.overridesJson as OverrideRecord[];
    for (const ov of overrides) {
      if (ov.recruiterDecision === "advance") {
        overrideTotal++;
        if (row.outcome === "hired" || row.outcome === "offer_accepted") overrideHireSuccess++;
      }
    }
  }
  const overrideAccuracyRate =
    overrideTotal > 0 ? Math.round((overrideHireSuccess / overrideTotal) * 100) : null;

  return {
    totalOutcomes: rows.length,
    byOutcome,
    avgHireProbabilityAtHire,
    avgHireProbabilityAtReject,
    precisionScore,
    recallScore,
    calibrationDrift,
    overrideRate,
    overrideAccuracyRate,
  };
}

/* ── Query Helpers ────────────────────────────────────────────────────────── */

export async function getIntelligenceForJob(jobId: string, scope: TenantScope) {
  const rows = await db
    .select({
      intel: candidateJobIntelligenceTable,
      candidateUpdatedAt: candidatesTable.updatedAt,
    })
    .from(candidateJobIntelligenceTable)
    .leftJoin(candidatesTable, eq(candidatesTable.id, candidateJobIntelligenceTable.candidateId))
    // Tenant: filter-in-SQL via intelTenantScope so out-of-scope rows are never
    // read (defense-in-depth — the caller also gates the jobId upstream). Pass
    // getDataScopeTenantIds(user); null = platform_admin (all rows).
    // Compliance: never surface GDPR-erased / do-not-contact candidates.
    .where(
      and(
        intelTenantScope(scope),
        eq(candidateJobIntelligenceTable.jobId, jobId),
        restrictToCompliantCandidates(candidateJobIntelligenceTable.candidateId),
      ),
    )
    .orderBy(desc(candidateJobIntelligenceTable.hireProbability));

  /* Staleness-adjusted RANKING (lib/staleness.ts): read-time demotion of
     inactive candidates on the per-job intelligence panel — stored scores
     untouched; only ordering + transparency fields reflect recency. */
  return rankWithStaleness(
    rows,
    (r) => Number(r.intel.hireProbability ?? 0),
    (r) => r.candidateUpdatedAt,
  ).map((x) => ({
    ...x.item.intel,
    rankScore: x.rankScore,
    stalenessMultiplier: x.stalenessMultiplier,
    daysInactive: x.daysInactive,
  }));
}

export async function getIntelligenceForPair(
  jobId: string,
  candidateId: string,
  scope: TenantScope,
) {
  const rows = await db
    .select()
    .from(candidateJobIntelligenceTable)
    // Tenant: filter-in-SQL via intelTenantScope — an out-of-scope pair is never
    // read (not fetch-then-drop). Pass getDataScopeTenantIds(user); null =
    // platform_admin (all rows), [] = fail-closed (no rows).
    .where(
      and(
        intelTenantScope(scope),
        eq(candidateJobIntelligenceTable.jobId, jobId),
        eq(candidateJobIntelligenceTable.candidateId, candidateId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
