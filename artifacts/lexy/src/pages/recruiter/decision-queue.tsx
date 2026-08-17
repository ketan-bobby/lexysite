/**
 * pages/recruiter/decision-queue.tsx — Recruiter Decision Queue
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * A prioritised queue of candidates that require human attention before the
 * AI can continue processing them. Acts as the "human-in-the-loop" checkpoint
 * for the Intelligence Agent when a decision policy requires recruiter approval.
 *
 * ─── Queue entry types ───────────────────────────────────────────────────────
 *   approval_required     — AI recommends "advance" but the policy requires
 *                           human sign-off before moving the candidate
 *   manual_review         — AI confidence is below the policy threshold;
 *                           recruiter must make the call
 *   low_confidence        — AI scored the candidate but couldn't decide;
 *                           human tie-breaker needed
 *   high_risk_high_fit    — candidate looks great but has risk flags (e.g.
 *                           duplicate profile, verification issues)
 *
 * ─── Decision actions ────────────────────────────────────────────────────────
 *   "Advance"  — POST /api/intelligence/:candidateId/:jobId/decision { action: "advance" }
 *   "Hold"     — POST /api/intelligence/… { action: "hold" }
 *   "Reject"   — POST /api/intelligence/… { action: "reject" }
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *   GET /api/intelligence/pending-decisions — queue rows sorted by priority score
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/decision-queue
 *   - Trust/fraud exceptions
 *   - Candidates pending recruiter override
 */

import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { bandBy } from "@/lib/score-band";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OverrideDialog } from "@/components/intelligence/OverrideDialog";
import { SignalCoveragePanel } from "@/components/intelligence/SignalCoveragePanel";
import { Link, useSearch } from "wouter";
import { useAgentRun, useRunDetail } from "@/lib/agent-runs";
import {
  Brain,
  Lock,
  Star,
  AlertTriangle,
  Zap,
  ShieldAlert,
  Clock,
  Search,
  RefreshCw,
  ChevronRight,
  ArrowUpRight,
  Filter,
  CheckCircle2,
  Inbox,
  UserCheck,
  Play,
  Loader2,
  TrendingUp,
  Sparkles,
  Briefcase,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isTrustGated, TRUST_GATE_LABEL } from "@/lib/trust-gate";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/* ── Types ──────────────────────────────────────────────────────────────── */
interface IntelligenceRecord {
  id: string;
  jobId: string;
  candidateId: string;
  fitScore: number | null;
  qualityScore: number | null;
  trustScore: number | null;
  conversionScore: number | null;
  hireProbability: number | null;
  nextBestAction: string | null;
  topStrengths: string[] | null;
  topRisks: string[] | null;
  lastUpdated: string | null;
  candidateFirstName: string | null;
  candidateLastName: string | null;
  candidateEmail: string | null;
  candidateTitle: string | null;
  candidateCompany: string | null;
  jobTitle: string | null;
  jobDepartment: string | null;
  confidence?: number | null;
  requiresApproval?: boolean;
  policyApplied?: boolean;
  signalsJson?: any;
  overridesJson?: string | null;
}

/* ── Queue Categories ───────────────────────────────────────────────────── */
type CategoryKey = "approval" | "review" | "trust" | "low_confidence" | "high_fit_risk" | "all";

interface Category {
  key: CategoryKey;
  label: string;
  description: string;
  icon: React.ElementType;
  color: string;
  filter: (r: IntelligenceRecord) => boolean;
  urgencyLabel: string;
}

// Triage-lane thresholds — business rules that route records into review lanes,
// NOT display colour bands. Named so a lane's cutoff can't silently drift.
const TRUST_EXCEPTION_MAX = 50; // trust below this = a verification-exception lane
const HIGH_FIT_TRIAGE_MIN = 70; // strong fit that still needs human judgement
const OFFSETTING_RISK_TRUST_MAX = 60; // trust below this offsets an otherwise high fit
const LOW_CONFIDENCE_MAX = 55; // decisions below this lack signal coverage

const CATEGORIES: Category[] = [
  {
    key: "approval",
    label: "Needs Approval",
    description: "AI decisions gated by tenant policy requiring recruiter sign-off",
    icon: Lock,
    color: "#facc15",
    urgencyLabel: "Critical",
    filter: (r) => !!r.requiresApproval || r.nextBestAction === "recruiter_review",
  },
  {
    key: "trust",
    label: "Trust Exceptions",
    description: "Candidates with verification flags, low trust scores, or proctoring issues",
    icon: ShieldAlert,
    color: "#fb7185",
    urgencyLabel: "High",
    filter: (r) =>
      (r.trustScore ?? 100) < TRUST_EXCEPTION_MAX || r.nextBestAction === "manual_verification",
  },
  {
    key: "high_fit_risk",
    label: "High Fit / High Risk",
    description: "Strong candidates with offsetting risk signals that need human judgement",
    icon: Zap,
    color: "#fb923c",
    urgencyLabel: "High",
    filter: (r) =>
      (r.fitScore ?? 0) >= HIGH_FIT_TRIAGE_MIN &&
      (r.trustScore ?? 100) < OFFSETTING_RISK_TRUST_MAX &&
      r.nextBestAction !== "reject",
  },
  {
    key: "review",
    label: "Manual Review",
    description: "AI recommended recruiter review — mixed or borderline signals",
    icon: Star,
    color: "#a78bfa",
    urgencyLabel: "Medium",
    filter: (r) => r.nextBestAction === "recruiter_review",
  },
  {
    key: "low_confidence",
    label: "Low Confidence",
    description: "Decisions where signal coverage or freshness is insufficient",
    icon: AlertTriangle,
    color: "#94a3b8",
    urgencyLabel: "Low",
    filter: (r) => (r.confidence ?? 100) < LOW_CONFIDENCE_MAX && r.nextBestAction !== "reject",
  },
];

/* ── Color helpers ──────────────────────────────────────────────────────── */
const ACTION_CONFIG: Record<string, { label: string; hex: string }> = {
  advance: { label: "Advance", hex: "#4ade80" },
  schedule: { label: "Schedule", hex: "#22d3ee" },
  recruiter_review: { label: "Review", hex: "#facc15" },
  re_engage: { label: "Re-engage", hex: "#fb923c" },
  manual_verification: { label: "Verify", hex: "#a78bfa" },
  reject: { label: "Reject", hex: "#fb7185" },
  hold: { label: "Hold", hex: "#94a3b8" },
};

function scoreHex(score: number | null): string {
  if (score == null) return "#64748b";
  return bandBy(score, { strong: "#4ade80", good: "#facc15", fair: "#fb7185" });
}

/* ── Queue Item Card ────────────────────────────────────────────────────── */
function QueueCard({
  record,
  categoryColor,
}: {
  record: IntelligenceRecord;
  categoryColor: string;
}) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const queryClient = useQueryClient();

  const name =
    [record.candidateFirstName, record.candidateLastName].filter(Boolean).join(" ") ||
    "Unknown Candidate";
  const action = record.nextBestAction ? ACTION_CONFIG[record.nextBestAction] : null;
  const hp = record.hireProbability ?? 0;
  const hpHex = scoreHex(hp);
  // Trust gate: below the advance threshold (or unverified), the gate status —
  // not the hire % — must be the loudest element on the card.
  const gated = isTrustGated(record.trustScore);
  /* Similar-hire transparency: badge only when the score genuinely came from
   * the embedding strategy (kNN vs this tenant's REAL successful hires) —
   * never for the LLM-vs-ICP fallback. */
  const simAnalytics = record.signalsJson?.analytics ?? {};
  const patternMatched = simAnalytics.similarHireSource === "embedding";

  const triggerMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence/trigger-action`, {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ jobId: record.jobId, candidateId: record.candidateId }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["intelligence", "all"] });
    },
  });

  return (
    <Card className="border-border/50 hover:border-primary/30 transition-all duration-200 overflow-hidden">
      <div
        className="h-0.5 w-full"
        style={{ background: categoryColor, boxShadow: `0 0 8px ${categoryColor}55` }}
      />
      <CardContent className="p-4">
        <div className="flex items-start gap-4">
          {/* Hire Probability — demoted behind the trust gate when unverified */}
          {gated ? (
            <div className="flex-shrink-0 w-20 text-center pt-0.5">
              <p className="text-[11px] font-black uppercase tracking-wide leading-tight text-amber-400">
                {TRUST_GATE_LABEL}
              </p>
              <p className="text-[10px] text-muted-foreground mt-1 tabular-nums leading-tight">
                {hp}% if verified
              </p>
            </div>
          ) : (
            <div className="flex-shrink-0 w-14 text-center pt-0.5">
              <p className="text-2xl font-black tabular-nums leading-none" style={{ color: hpHex }}>
                {hp}%
              </p>
              <p className="text-[9px] text-muted-foreground mt-0.5 leading-tight">Hire Prob.</p>
            </div>
          )}

          {/* Main content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
              <div>
                <Link
                  href={`/candidates/${record.candidateId}`}
                  className="font-bold text-sm hover:text-primary transition-colors"
                >
                  {name}
                </Link>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  {record.candidateTitle && (
                    <span className="text-xs text-muted-foreground truncate">
                      {record.candidateTitle}
                    </span>
                  )}
                  {record.candidateCompany && (
                    <span className="text-xs text-muted-foreground">
                      · {record.candidateCompany}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {record.jobTitle && (
                  <Badge variant="outline" className="text-xs">
                    {record.jobTitle}
                  </Badge>
                )}
                {action && (
                  <Badge
                    variant="outline"
                    className="text-xs"
                    style={{
                      color: action.hex,
                      borderColor: `${action.hex}40`,
                      backgroundColor: `${action.hex}15`,
                    }}
                  >
                    {action.label}
                  </Badge>
                )}
                {record.requiresApproval && (
                  <Badge
                    variant="outline"
                    className="text-xs text-amber-400 border-amber-500/30 gap-1"
                  >
                    <Lock className="w-2.5 h-2.5" /> Blocked
                  </Badge>
                )}
              </div>
            </div>

            {/* Mini score row + stability + signal coverage */}
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div className="flex gap-4">
                {[
                  { label: "Fit", value: record.fitScore, icon: TrendingUp },
                  { label: "Quality", value: record.qualityScore, icon: ArrowUpRight },
                  { label: "Trust", value: record.trustScore, icon: CheckCircle2 },
                  { label: "Conv.", value: record.conversionScore, icon: Zap },
                ].map(({ label, value, icon: Icon }) => (
                  <div key={label} className="flex items-center gap-1">
                    <span className="text-[9px] text-muted-foreground uppercase">{label}</span>
                    <span
                      className="text-xs font-bold tabular-nums"
                      style={{ color: scoreHex(value) }}
                    >
                      {value ?? "—"}
                    </span>
                  </div>
                ))}
                {patternMatched && (
                  <Badge
                    className="text-[9px] bg-violet-500/15 text-violet-300 border border-violet-500/30"
                    title={`Fit informed by similarity to ${simAnalytics.similarHireExemplarCount ?? "your"} real successful hires in this role family`}
                  >
                    <Sparkles className="w-2.5 h-2.5 mr-1" /> Matched to past hires
                  </Badge>
                )}
              </div>
              {(() => {
                const overrides = (() => {
                  try {
                    return JSON.parse(record.overridesJson ?? "[]");
                  } catch {
                    return [];
                  }
                })();
                const isUnstable = overrides.length >= 2;
                const signals = record.signalsJson ?? {};
                const sf = [
                  {
                    agent: "screening",
                    present: !!signals.screening,
                    decay: null,
                    lastUpdated: null,
                  },
                  {
                    agent: "interview",
                    present: !!signals.interview,
                    decay: null,
                    lastUpdated: null,
                  },
                  {
                    agent: "verification",
                    present: !!signals.verification,
                    decay: null,
                    lastUpdated: null,
                  },
                ];
                return (
                  <div className="flex items-center gap-3">
                    {isUnstable && (
                      <span className="text-[10px] font-semibold text-violet-400 flex items-center gap-1">
                        <AlertTriangle className="w-2.5 h-2.5" /> Unstable
                      </span>
                    )}
                    <SignalCoveragePanel mode="mini" signalFreshness={sf} />
                  </div>
                );
              })()}
            </div>

            {/* Risks */}
            {(record.topRisks?.length ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground flex items-start gap-1.5 mb-3">
                <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0 text-amber-400" />
                {record.topRisks![0]}
              </p>
            )}

            {/* Actions */}
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1.5"
                onClick={() => triggerMutation.mutate()}
                disabled={triggerMutation.isPending}
              >
                {triggerMutation.isPending ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Play className="w-3 h-3" />
                )}
                Execute Action
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1.5 text-muted-foreground"
                onClick={() => setOverrideOpen(true)}
              >
                <UserCheck className="w-3 h-3" /> Override
              </Button>
              <Link href={`/candidates/${record.candidateId}`}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1 text-muted-foreground hover:text-primary"
                >
                  View Profile <ChevronRight className="w-3 h-3" />
                </Button>
              </Link>
              <span className="ml-auto text-[10px] text-muted-foreground">
                {record.lastUpdated ? new Date(record.lastUpdated).toLocaleDateString() : "—"}
              </span>
            </div>
          </div>
        </div>
      </CardContent>

      <OverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        jobId={record.jobId}
        candidateId={record.candidateId}
        currentDecision={record.nextBestAction ?? "hold"}
        candidateName={name}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["intelligence", "all"] })}
      />
    </Card>
  );
}

/* ── Main Page ──────────────────────────────────────────────────────────── */
export default function DecisionQueue() {
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("approval");
  const [search, setSearch] = useState("");

  // Optional `?run=<id>` deep-link from a completed sourcing run's "Review
  // shortlist" button: narrows the queue to just that run's new candidates.
  const searchParams = useSearch();
  const runId = useMemo(() => new URLSearchParams(searchParams).get("run"), [searchParams]);
  // Optional `?job=<id>` deep-link from a work order: a PERMANENT, revisitable
  // shortlist of every AI-scored candidate on that job (unlike ?run=, which is
  // scoped to one sourcing run's additions).
  const jobParam = useMemo(() => new URLSearchParams(searchParams).get("job"), [searchParams]);
  const { events: runEvents, isRunning: runIsRunning } = useAgentRun(runId);
  const runDetail = useRunDetail(runId).data;
  const runCandidateIds = useMemo<Set<string> | null>(() => {
    if (!runId) return null;
    // Prefer the shortlist event carrying the most ids: `step_completed` on a
    // full run, or the last cumulative `step_progress` on a cancelled/partial
    // run (both are cumulative, so max-length picks the complete set either way).
    let best: string[] | null = null;
    for (const e of runEvents) {
      if (e.stepName === "shortlist" && Array.isArray(e.payload?.candidateIds)) {
        const ids = e.payload.candidateIds as string[];
        if (!best || ids.length > best.length) best = ids;
      }
    }
    return best ? new Set<string>(best) : null;
  }, [runId, runEvents]);
  // Until the run's shortlist ids resolve, the run filter is still loading.
  const runShortlistLoading = !!runId && runCandidateIds == null;

  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = useQuery<{
    data: IntelligenceRecord[];
  }>({
    queryKey: ["intelligence", "all"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const records = useMemo(() => {
    const all = data?.data ?? [];
    if (jobParam) return all.filter((r) => r.jobId === jobParam);
    if (!runId) return all;
    // Strict: a run deep-link must never fall back to the full queue. Until the
    // shortlist ids resolve, show nothing rather than unrelated candidates.
    if (!runCandidateIds) return [];
    return all.filter((r) => runCandidateIds.has(r.candidateId));
  }, [data, runId, runCandidateIds, jobParam]);

  const jobTitle = jobParam ? (records[0]?.jobTitle ?? null) : null;

  // Count each category
  // In run view, prepend a "Run Shortlist" tab that shows EVERY candidate the
  // run added — healthy candidates (nextBestAction "schedule"/"advance") match
  // none of the attention lanes, so without this tab a successful run renders
  // as a contradictory "8 candidates … Queue Clear".
  const visibleCategories = useMemo<Category[]>(
    () =>
      runId || jobParam
        ? [
            {
              key: "shortlist" as CategoryKey,
              label: runId ? "Run Shortlist" : "Full Shortlist",
              description: runId
                ? "Every candidate this sourcing run added, with the AI's recommended next step"
                : "Every AI-scored candidate on this work order, with the AI's recommended next step",
              icon: Sparkles,
              color: "#22d3ee",
              urgencyLabel: "Info",
              filter: () => true,
            },
            ...CATEGORIES,
          ]
        : CATEGORIES,
    [runId, jobParam],
  );

  // Deep-linking into a run should land on the full shortlist, not an empty
  // "Needs Approval" lane; leaving run view must drop the run-only tab.
  useEffect(() => {
    setActiveCategory(runId || jobParam ? ("shortlist" as CategoryKey) : "approval");
  }, [runId, jobParam]);

  const categoryCounts = useMemo(
    () =>
      Object.fromEntries(
        visibleCategories.map((cat) => [cat.key, records.filter(cat.filter).length]),
      ),
    [records, visibleCategories],
  );

  const activeRecords = useMemo(() => {
    const cat = visibleCategories.find((c) => c.key === activeCategory);
    if (!cat) return records;
    let filtered = records.filter(cat.filter);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter((r) =>
        [
          r.candidateFirstName,
          r.candidateLastName,
          r.candidateEmail,
          r.jobTitle,
          r.candidateTitle,
          r.candidateCompany,
        ]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    // Sort by hire probability desc, then requiresApproval first
    return filtered.sort((a, b) => {
      if (a.requiresApproval && !b.requiresApproval) return -1;
      if (!a.requiresApproval && b.requiresApproval) return 1;
      return (b.hireProbability ?? 0) - (a.hireProbability ?? 0);
    });
  }, [records, activeCategory, search]);

  /* Scoring transparency (learned weights + similar-hire activation). One
   * aggregate call — booleans and sample sizes only, never weights. */
  const { data: scoringStatus } = useQuery<{
    learnedScoring: { active: boolean; maxSampleSize: number; minSamples: number };
    similarHire: { active: boolean; minExemplars: number };
  }>({
    queryKey: ["intelligence", "scoring-status"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence/scoring-status`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    staleTime: 300_000,
  });

  const totalQueue = CATEGORIES.reduce((s, cat) => s + (categoryCounts[cat.key] ?? 0), 0);
  const activeCat = visibleCategories.find((c) => c.key === activeCategory) ?? visibleCategories[0];

  return (
    <AppLayout>
      {/* ── Page header ────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <Inbox className="w-7 h-7 text-primary" />
            Decision Queue
          </h1>
          <p className="text-muted-foreground mt-1">
            {totalQueue === 0
              ? "All clear — no candidates need attention right now."
              : `${totalQueue} candidates need your attention.`}
          </p>
          {(scoringStatus?.learnedScoring.active || scoringStatus?.similarHire.active) && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {scoringStatus.learnedScoring.active && (
                <Badge
                  className="text-[10px] bg-primary/15 text-primary border border-primary/30"
                  title={`Score weights learned from ${scoringStatus.learnedScoring.maxSampleSize} of your own hiring outcomes (replaces the generic defaults)`}
                >
                  <Sparkles className="w-3 h-3 mr-1" /> Learned scoring active — trained on{" "}
                  {scoringStatus.learnedScoring.maxSampleSize} outcomes
                </Badge>
              )}
              {scoringStatus.similarHire.active && (
                <Badge
                  className="text-[10px] bg-violet-500/15 text-violet-300 border border-violet-500/30"
                  title="Fit scores can use similarity to your real successful hires; cards using it show a 'Matched to past hires' badge"
                >
                  <Sparkles className="w-3 h-3 mr-1" /> Similar-hire signal enabled
                </Badge>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dataUpdatedAt > 0 && (
            <span className="text-xs text-muted-foreground">
              Updated {new Date(dataUpdatedAt).toLocaleTimeString()}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1.5"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Run-shortlist filter banner (from a completed sourcing run) ───── */}
      {runId && (
        <div className="flex items-center gap-3 mb-6 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
          <Sparkles className="w-4 h-4 text-primary shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground truncate">
              Showing this run's shortlist
              {runDetail?.jobTitle ? ` for ${runDetail.jobTitle}` : ""}
              {runCandidateIds
                ? ` — ${runCandidateIds.size} candidate${runCandidateIds.size === 1 ? "" : "s"}`
                : ""}
            </p>
            <p className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
              {runShortlistLoading ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                  {runIsRunning
                    ? "Sourcing is still running — the shortlist will appear here."
                    : "Loading this run's shortlist…"}
                </>
              ) : (
                "Filtered to the candidates this sourcing run added to your pipeline."
              )}
            </p>
          </div>
          {runDetail?.workOrderId && (
            <Link href={`/jobs/${runDetail.workOrderId}?tab=candidates`}>
              <Button size="sm" variant="outline" className="gap-1.5 shrink-0">
                <Briefcase className="w-3.5 h-3.5" /> View all in work order
              </Button>
            </Link>
          )}
          <Link href="/decision-queue">
            <Button size="sm" variant="ghost" className="gap-1.5 shrink-0">
              <X className="w-3.5 h-3.5" /> Clear
            </Button>
          </Link>
        </div>
      )}

      {/* ── Work-order filter banner (permanent, revisitable job shortlist) ── */}
      {jobParam && !runId && (
        <div className="flex items-center gap-3 mb-6 rounded-xl border border-primary/25 bg-primary/5 px-4 py-3">
          <Briefcase className="w-4 h-4 text-primary shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground truncate">
              Work order shortlist{jobTitle ? ` — ${jobTitle}` : ""}
              {` — ${records.length} candidate${records.length === 1 ? "" : "s"}`}
            </p>
            <p className="text-xs text-muted-foreground truncate">
              Every AI-scored candidate on this work order. Come back anytime — this view doesn't
              expire.
            </p>
          </div>
          <Link href={`/jobs/${jobParam}?tab=candidates`}>
            <Button size="sm" variant="outline" className="gap-1.5 shrink-0">
              <Briefcase className="w-3.5 h-3.5" /> Open work order
            </Button>
          </Link>
          <Link href="/decision-queue">
            <Button size="sm" variant="ghost" className="gap-1.5 shrink-0">
              <X className="w-3.5 h-3.5" /> Clear
            </Button>
          </Link>
        </div>
      )}

      {/* ── Category tabs ───────────────────────────────────────────────── */}
      <div className="flex gap-2 flex-wrap mb-6">
        {visibleCategories.map((cat) => {
          const count = categoryCounts[cat.key] ?? 0;
          const isActive = activeCategory === cat.key;
          return (
            <button
              key={cat.key}
              type="button"
              onClick={() => setActiveCategory(cat.key)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all",
                isActive
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border/50 text-muted-foreground hover:text-foreground hover:border-border",
              )}
            >
              <cat.icon className="w-4 h-4" style={{ color: isActive ? cat.color : undefined }} />
              <span>{cat.label}</span>
              {count > 0 && (
                <span
                  className="w-5 h-5 rounded-full text-[10px] font-black flex items-center justify-center"
                  style={{
                    background: isActive ? cat.color : "rgba(255,255,255,0.1)",
                    color: isActive ? "#000" : "inherit",
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Active category description + search ────────────────────────── */}
      <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <activeCat.icon className="w-4 h-4" style={{ color: activeCat.color }} />
          <span className="text-sm text-muted-foreground">{activeCat.description}</span>
          <Badge
            variant="outline"
            className="text-xs"
            style={{
              color: activeCat.color,
              borderColor: `${activeCat.color}40`,
              backgroundColor: `${activeCat.color}15`,
            }}
          >
            {activeCat.urgencyLabel}
          </Badge>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search candidates…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-8 text-sm w-56"
          />
        </div>
      </div>

      {/* ── Queue items ─────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <Brain className="w-10 h-10 text-primary animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading decision queue…</p>
        </div>
      ) : activeRecords.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <CheckCircle2 className="w-8 h-8 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Queue Clear</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {search ? `No results for "${search}"` : `No candidates in this category right now.`}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {activeRecords.map((record) => (
            <QueueCard key={record.id} record={record} categoryColor={activeCat.color} />
          ))}
        </div>
      )}
    </AppLayout>
  );
}
