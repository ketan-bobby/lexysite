/**
 * Badges.tsx — Shared semantic badge components.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Exports four colour-coded badge variants used across recruiter and portal
 * views to surface candidate signal states at a glance:
 *
 *  ScoreBadge          Numeric % match/fit score → colour via the canonical
 *                       score band (bandBy from @/lib/score-band: ≥75 strong,
 *                       55–74 good, <55 fair). No local cutoffs live here.
 *  RecommendationBadge AI recommendation enum
 *                       (strong_yes / yes / maybe / no / strong_no)
 *  VerificationBadge   Identity check state (verified / pending / flagged / unverified)
 *  RiskBadge           Dropout / integrity risk level (critical / high / medium / low)
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  components/agents/PipelinePanel.tsx            Candidate cards
 *  components/intelligence/CandidateIntelligenceCard.tsx
 *  pages/recruiter/candidates/[id].tsx            Profile header
 *  pages/recruiter/decision-queue.tsx             Decision queue rows
 */

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { bandBy } from "@/lib/score-band";

export function ScoreBadge({ score, className }: { score?: number | null, className?: string }) {
  if (score == null) return <Badge variant="outline" className={cn("text-muted-foreground", className)}>N/A</Badge>;
  
  const colorClass = bandBy(score, {
    strong: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
    good: "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
    fair: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
  });
    
  return (
    <Badge variant="outline" className={cn(colorClass, className)}>
      {score}%
    </Badge>
  );
}

export function RecommendationBadge({ rec, className }: { rec: string, className?: string }) {
  const config: Record<string, { label: string, color: string }> = {
    strong_yes: { label: "Strong Yes", color: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800" },
    yes: { label: "Yes", color: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800" },
    maybe: { label: "Maybe", color: "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800" },
    no: { label: "No", color: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800" },
    strong_no: { label: "Strong No", color: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800" },
  };
  
  const { label, color } = config[rec] || { label: rec, color: "bg-gray-100 text-gray-800" };
  
  return <Badge variant="outline" className={cn(color, className)}>{label}</Badge>;
}

export function VerificationBadge({ status, className }: { status: string, className?: string }) {
  const config: Record<string, string> = {
    verified: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800",
    flagged: "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
    pending: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800",
    unverified: "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700",
  };
  
  const color = config[status] || config.unverified;
  
  return <Badge variant="outline" className={cn("uppercase text-[10px] tracking-wider font-bold", color, className)}>{status}</Badge>;
}

export function RiskBadge({ level, className }: { level: string, className?: string }) {
  const config: Record<string, string> = {
    critical: "bg-red-100 text-red-800 border-red-200 animate-pulse dark:bg-red-900/30 dark:text-red-400 dark:border-red-800",
    high: "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800",
    medium: "bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-800",
    low: "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800",
  };
  
  const color = config[level] || config.low;
  
  return <Badge variant="outline" className={cn("uppercase text-[10px] tracking-wider font-bold", color, className)}>{level}</Badge>;
}
