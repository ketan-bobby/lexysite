/**
 * components/intelligence/DecisionAuditTrail.tsx — Decision Transparency Timeline
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Renders a vertical step timeline showing exactly how each hiring decision
 * was reached, so recruiters and auditors can understand what was automated
 * vs what a human decided.
 *
 * ─── Timeline steps ──────────────────────────────────────────────────────────
 *   1. AI Scored      — the intelligence engine calculated the initial score
 *   2. Policy Check   — the decision-policy engine applied hiring rules
 *   3. Override       — displayed only if a recruiter manually overrode the decision
 *   4. Final Decision — the resulting outcome (advance / hold / reject)
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   components/intelligence/CandidateIntelligenceCard.tsx
 */

import { Brain, Lock, UserCheck, CheckCircle2, XCircle, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { intelBandBy } from "@/lib/intelligence-bands";

interface Override {
  id: string;
  overriddenAt: string;
  originalDecision: string;
  recruiterDecision: string;
  recruiterReason: string;
}

interface DecisionResult {
  decision: string;
  confidence: number;
  policyApplied: boolean;
  requiresApproval: boolean;
  policyOverrides?: string[];
}

interface DecisionAuditTrailProps {
  dr: DecisionResult;
  overrides: Override[];
  compact?: boolean;
}

const DECISION_LABELS: Record<string, string> = {
  advance: "Advance", schedule: "Schedule", recruiter_review: "Manual Review",
  re_engage: "Re-engage", manual_verification: "Verify", reject: "Reject", hold: "Hold",
};

const DECISION_COLORS: Record<string, string> = {
  advance: "#4ade80", schedule: "#22d3ee", recruiter_review: "#facc15",
  re_engage: "#fb923c", manual_verification: "#a78bfa", reject: "#fb7185", hold: "#94a3b8",
};

function confidenceLabel(c: number): { label: string; hex: string } {
  // Decision confidence is an intelligence sub-score (see intelligence-bands.ts),
  // banded on the shared INTELLIGENCE convention — its 75/55 equality with the
  // canonical match band is coincidental, not a dependency.
  return intelBandBy(c, {
    strong:   { label: "High confidence",   hex: "#4ade80" },
    moderate: { label: "Medium confidence", hex: "#facc15" },
    weak:     { label: "Low confidence",    hex: "#fb7185" },
  });
}

interface StepProps {
  icon: React.ElementType;
  iconHex: string;
  title: string;
  sub?: string;
  badge?: { label: string; hex: string };
  isLast?: boolean;
  dim?: boolean;
}

function Step({ icon: Icon, iconHex, title, sub, badge, isLast, dim }: StepProps) {
  return (
    <div className={cn("flex gap-3", isLast ? "" : "pb-4")}>
      <div className="flex flex-col items-center">
        <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 border"
          style={{ background: `${iconHex}15`, borderColor: `${iconHex}40` }}>
          <Icon className="w-3.5 h-3.5" style={{ color: iconHex }} />
        </div>
        {!isLast && <div className="w-px flex-1 mt-1.5" style={{ background: `${iconHex}25` }} />}
      </div>
      <div className={cn("flex-1 min-w-0 pt-1", dim && "opacity-50")}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold">{title}</span>
          {badge && (
            <Badge variant="outline" className="text-[10px] h-4 px-1.5"
              style={{ color: badge.hex, borderColor: `${badge.hex}40` }}>
              {badge.label}
            </Badge>
          )}
        </div>
        {sub && <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{sub}</p>}
      </div>
    </div>
  );
}

export function DecisionAuditTrail({ dr, overrides, compact }: DecisionAuditTrailProps) {
  const confInfo   = confidenceLabel(dr.confidence);
  const latestOverride = overrides.at(-1);
  const finalDecision  = latestOverride ? latestOverride.recruiterDecision : dr.decision;
  const finalHex       = DECISION_COLORS[finalDecision] ?? "#94a3b8";
  const finalLabel     = DECISION_LABELS[finalDecision] ?? finalDecision;
  const policyBlocked  = dr.requiresApproval;

  const steps: StepProps[] = [
    {
      icon: Brain,
      iconHex: "#22d3ee",
      title: "AI Scored",
      sub: `Hiring Brain computed scores and selected "${DECISION_LABELS[dr.decision] ?? dr.decision}" as next best action.`,
      badge: { label: `${dr.confidence}% confidence · ${confInfo.label}`, hex: confInfo.hex },
    },
    {
      icon: policyBlocked ? Lock : CheckCircle2,
      iconHex: policyBlocked ? "#fb923c" : "#4ade80",
      title: policyBlocked ? "Policy Gate — Approval Required" : "Policy Check — Passed",
      sub: policyBlocked
        ? "Tenant policy requires recruiter approval before this action can proceed."
        : dr.policyApplied
          ? "Policy rules adjusted the recommendation to comply with tenant settings."
          : "No policy restrictions apply to this candidate.",
      badge: policyBlocked
        ? { label: "Blocked", hex: "#fb923c" }
        : { label: "Auto-approved", hex: "#4ade80" },
    },
  ];

  if (overrides.length > 0) {
    overrides.forEach((ov, i) => {
      steps.push({
        icon: UserCheck,
        iconHex: "#a78bfa",
        title: `Recruiter Override #${i + 1}`,
        sub: `Changed "${DECISION_LABELS[ov.originalDecision] ?? ov.originalDecision}" → "${DECISION_LABELS[ov.recruiterDecision] ?? ov.recruiterDecision}". Reason: ${ov.recruiterReason || "Not specified"}.`,
        badge: { label: new Date(ov.overriddenAt).toLocaleDateString(), hex: "#a78bfa" },
      });
    });
  }

  steps.push({
    icon: finalLabel === "Reject" ? XCircle : CheckCircle2,
    iconHex: finalHex,
    title: `Final: ${finalLabel}`,
    sub: overrides.length > 0
      ? "Human override applied — this is the recruiter's final decision."
      : policyBlocked
        ? "Awaiting recruiter approval to proceed."
        : "AI recommendation confirmed — no overrides applied.",
    badge: { label: overrides.length > 0 ? "Human Decision" : "AI Decision", hex: overrides.length > 0 ? "#a78bfa" : "#22d3ee" },
    isLast: true,
  });

  return (
    <div className={cn("space-y-0", compact && "text-[11px]")}>
      {steps.map((step, i) => (
        <Step key={i} {...step} isLast={i === steps.length - 1} />
      ))}
    </div>
  );
}
