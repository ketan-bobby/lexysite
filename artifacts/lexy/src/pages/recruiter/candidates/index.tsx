/**
 * pages/recruiter/candidates/index.tsx — Recruiter Candidates List
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Master list of all candidates visible to the recruiter's tenant. Supports
 * multi-column search, stage/score filtering, CSV export, and bulk actions
 * (invite to portal, add to outreach campaign, archive).
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   FilterBar    — search box + stage tabs (All / Sourced / Screening /
 *                  Interviewing / Offered / Hired / Rejected)
 *   CandidateRow — name, current role, fit score badge, stage badge, last
 *                  activity timestamp, quick-action menu
 *   BulkBar      — appears when ≥1 row is selected; exposes bulk actions
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 * useListCandidates() from @workspace/api-client-react →
 *   GET /api/candidates?tenantId=…&stage=…&search=…
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/candidates  (registered in App.tsx)
 */
import { authHeaders } from "@/lib/api";
import { useState, useMemo, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListCandidates } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Search, Brain, Zap, TrendingUp, Users, ArrowRight,
  ChevronUp, Linkedin, AlertCircle, Clock,
  CheckCircle2, Star, RefreshCw, MessageSquare, Calendar, ArrowLeft,
  Database, Building2, X, HelpCircle, Briefcase, Activity, Sparkles, Loader2,
  ChevronLeft, ChevronRight, ShieldAlert,
} from "lucide-react";
import { Link } from "wouter";
import { cn, pluralize } from "@/lib/utils";
import { displayScore, scoreBarWidth } from "@/lib/score-display";
import { isTrustGated, TRUST_GATE_LABEL } from "@/lib/trust-gate";
import { EvidenceBadge } from "@/components/ui-custom/EvidenceBadge";
import { getEvidence } from "@/lib/evidence";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/* ─── Types ──────────────────────────────────────────────────────────────── */
interface IntelligenceRecord {
  id: string;
  jobId: string;
  candidateId: string;
  fitScore: number | null;
  qualityScore: number | null;
  trustScore: number | null;
  conversionScore: number | null;
  hireProbability: number | null;
  confidence: number | null;
  signalCount: number | null;
  nextBestAction: string | null;
  topStrengths: string[];
  topRisks: string[];
  candidateFirstName: string | null;
  candidateLastName: string | null;
  candidateEmail: string | null;
  candidateTitle: string | null;
  candidateCompany: string | null;
  candidateLinkedin: string | null;
  jobTitle: string | null;
  jobDepartment: string | null;
}

type PoolFilter = "all" | "platform" | "tenant";

/* ─── Action Config ──────────────────────────────────────────────────────── */
const ACTION_CONFIG: Record<string, { label: string; icon: any; color: string; bg: string }> = {
  advance:         { label: "Advance",       icon: ChevronUp,       color: "text-emerald-400", bg: "bg-emerald-500/15 border-emerald-500/30" },
  hold:            { label: "Hold",           icon: Clock,           color: "text-amber-400",   bg: "bg-amber-500/15 border-amber-500/30" },
  nurture:         { label: "Nurture",        icon: MessageSquare,   color: "text-cyan-400",    bg: "bg-cyan-500/15 border-cyan-500/30" },
  schedule:        { label: "Schedule",       icon: Calendar,        color: "text-violet-400",  bg: "bg-violet-500/15 border-violet-500/30" },
  reject:          { label: "Reject",         icon: AlertCircle,     color: "text-red-400",     bg: "bg-red-500/15 border-red-500/30" },
  review_manually: { label: "Review",         icon: Star,            color: "text-orange-400",  bg: "bg-orange-500/15 border-orange-500/30" },
  make_offer:      { label: "Make Offer",    icon: CheckCircle2,    color: "text-violet-400",  bg: "bg-violet-500/15 border-violet-500/30" },
  verify:          { label: "Verify",        icon: RefreshCw,       color: "text-blue-400",    bg: "bg-blue-500/15 border-blue-500/30" },
};

/* ─── Pool Badge ─────────────────────────────────────────────────────────── */
function PoolBadge({ pool }: { pool?: string }) {
  if (pool !== "platform") return null;
  return (
    <Badge className="text-[9px] px-1.5 py-0 h-4 bg-sky-500/15 text-sky-400 border border-sky-500/25 font-medium gap-0.5 flex items-center">
      <Database className="w-2.5 h-2.5" />
      Platform Pool
    </Badge>
  );
}

/* ─── Activity Badge ─────────────────────────────────────────────────────── */
type ActivityStatus = "active" | "passive" | "inactive";

const ACTIVITY_CONFIG: Record<ActivityStatus, { label: string; color: string; bg: string; dot: string }> = {
  active:   { label: "Active",   color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/25", dot: "bg-emerald-400" },
  passive:  { label: "Passive",  color: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/25",   dot: "bg-amber-400" },
  inactive: { label: "Inactive", color: "text-rose-400",    bg: "bg-rose-500/10 border-rose-500/25",     dot: "bg-rose-400" },
};

function ActivityBadge({ status, lastActiveAt }: { status?: ActivityStatus; lastActiveAt?: string }) {
  if (!status) return null;
  const cfg = ACTIVITY_CONFIG[status];
  const daysAgo = lastActiveAt
    ? Math.floor((Date.now() - new Date(lastActiveAt).getTime()) / 86_400_000)
    : null;
  const timeLabel = daysAgo === null ? "" : daysAgo === 0 ? "today" : `${daysAgo}d ago`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1 text-[9px] px-1.5 py-0 h-4 rounded-full border font-medium cursor-default", cfg.color, cfg.bg)}>
            <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", cfg.dot)} />
            {cfg.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {status === "active" && "Updated within the last 30 days"}
          {status === "passive" && "Last active 30–90 days ago"}
          {status === "inactive" && "No activity in over 90 days"}
          {timeLabel && <span className="text-muted-foreground ml-1">({timeLabel})</span>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/* ─── Hooks ─────────────────────────────────────────────────────────────── */
function useIntelligence() {
  return useQuery<{ data: IntelligenceRecord[] }>({
    queryKey: ["intelligence", "all"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/intelligence`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch intelligence");
      return res.json();
    },
    refetchInterval: 30_000,
  });
}

/* The candidate list behind the Morning Report "needs contact details" door.
 * Server-authoritative so it reconciles 1:1 with the door's count (includes
 * in-pipeline candidates that aren't scored yet — those have no intelligence
 * row and would otherwise be dropped). Only fetched when the blocked view is
 * active. */
type BlockedCandidate = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  currentTitle: string | null;
  currentCompany: string | null;
  location: string | null;
  pool: string | null;
};
function useBlockedCandidates(enabled: boolean) {
  return useQuery<{ candidates: BlockedCandidate[] }>({
    queryKey: ["blocked-candidates"],
    enabled,
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/analytics/blocked-candidates`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch blocked candidates");
      return res.json();
    },
    refetchInterval: 30_000,
  });
}

/* ─── Score Bar ─────────────────────────────────────────────────────────── */
function ScoreBar({ label, value, color }: { label: string; value: number | null; color: string }) {
  /* Canonical null-vs-number rendering (@/lib/score-display) — a missing score
     shows "—", never a fabricated 0/50, so this card matches the detail view. */
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{label}</span>
        <span className={cn("text-[11px] font-bold tabular-nums", color)}>{displayScore(value)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-700", color.replace("text-", "bg-"))}
          style={{ width: `${scoreBarWidth(value)}%` }}
        />
      </div>
    </div>
  );
}

/* ─── Hire Probability Ring ─────────────────────────────────────────────── */
// Hire-probability GAUGE — 5 buckets for a richer ring than the 3-band match/fit
// scale, so it keeps its own cutoffs rather than the canonical strong/good/fair.
const HP_RING_B1 = 80, HP_RING_B2 = 60, HP_RING_B3 = 40, HP_RING_B4 = 20;
function ProbabilityRing({ value, insufficient }: { value: number | null; insufficient?: boolean }) {
  const v = value ?? 0;
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (v / 100) * circumference;
  // When the score rests on too little evidence, drop the confident colour
  // coding and render the ring/number in a neutral grey so a thin-data estimate
  // doesn't read as a firm prediction.
  const color = insufficient
    ? "#94a3b8"
    : v >= HP_RING_B1 ? "#10b981" :
      v >= HP_RING_B2 ? "#06b6d4" :
      v >= HP_RING_B3 ? "#f59e0b" :
      v >= HP_RING_B4 ? "#f97316" : "#ef4444";

  return (
    <div className="relative flex items-center justify-center w-16 h-16 flex-shrink-0">
      <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="5" />
        <circle
          cx="32" cy="32" r={radius} fill="none"
          stroke={color} strokeWidth="5"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.8s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {/* When evidence is too thin, never show a precise-looking percent. */}
        <span className="text-sm font-extrabold tabular-nums leading-none" style={{ color }}>
          {insufficient ? "—" : `${v}%`}
        </span>
        <span className="text-[8px] text-muted-foreground leading-none mt-0.5">Hire</span>
      </div>
    </div>
  );
}

/* ─── Assign to Job Modal ────────────────────────────────────────────────── */
function AssignToJobModal({
  candidateId,
  candidateName,
  open,
  onClose,
  onSuccess,
}: {
  candidateId: string;
  candidateName: string;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [notes, setNotes] = useState("");
  const [jobSearch, setJobSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedJobId(""); setNotes(""); setDone(false);
      setError(null); setJobSearch("");
      return;
    }
    setJobsLoading(true);
    fetch(`${API_BASE}/api/jobs`, {
      credentials: "include",
      headers: { ...authHeaders() },
    })
      .then(r => r.json())
      // Allow adding candidates to any non-closed WO — including draft and pending_approval —
      // so recruiters can start building a pipeline before the TA has approved the role.
      .then(d => setJobs((d.jobs ?? d).filter((j: any) => j.status !== "closed" && j.status !== "archived")))
      .catch(() => setJobs([]))
      .finally(() => setJobsLoading(false));
  }, [open]);

  const visibleJobs = jobSearch.trim()
    ? jobs.filter(j =>
        `${j.title ?? ""} ${j.location ?? ""} ${j.department ?? ""}`.toLowerCase()
          .includes(jobSearch.toLowerCase())
      )
    : jobs;

  async function handleAssign() {
    if (!selectedJobId) return;
    setSubmitting(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/applications`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ candidateId, jobId: selectedJobId, notes: notes || undefined }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `Server error ${res.status}`);
      }
      setDone(true);
      onSuccess();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const selectedJob = jobs.find(j => j.id === selectedJobId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-md bg-card border border-border/60 rounded-xl shadow-2xl z-10 overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-border/40">
          <div>
            <h2 className="font-semibold text-foreground flex items-center gap-2">
              <Briefcase className="w-4 h-4 text-primary" />
              Assign to Work Order
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Adding <span className="font-medium text-foreground">{candidateName}</span> to a job pipeline will trigger AI scoring automatically.
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground transition-colors ml-4 mt-0.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {done ? (
          /* Success state */
          <div className="p-8 text-center">
            <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-7 h-7 text-emerald-400" />
            </div>
            <h3 className="font-semibold text-foreground">Candidate Assigned</h3>
            <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
              <span className="text-foreground font-medium">{candidateName}</span> has been added to{" "}
              <span className="text-foreground font-medium">{selectedJob?.title ?? "the job"}</span>.
              The AI Screening agent is running now — they'll appear in your intelligence view shortly.
            </p>
            <button
              onClick={onClose}
              className="mt-6 w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            {/* Job search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-3.5 h-3.5" />
              <input
                placeholder="Search jobs…"
                className="w-full pl-9 pr-3 py-2 text-sm bg-background border border-border/50 rounded-lg outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground"
                value={jobSearch}
                onChange={e => setJobSearch(e.target.value)}
              />
            </div>

            {/* Job list */}
            <div className="space-y-1.5 max-h-52 overflow-y-auto pr-0.5">
              {jobsLoading ? (
                [1, 2, 3].map(i => (
                  <div key={i} className="h-14 bg-muted/30 rounded-lg animate-pulse" />
                ))
              ) : visibleJobs.length === 0 ? (
                <div className="text-center py-6 text-sm text-muted-foreground">
                  {jobSearch ? "No jobs match your search" : "No active jobs found"}
                </div>
              ) : (
                visibleJobs.map(job => (
                  <button
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 rounded-lg border transition-all",
                      selectedJobId === job.id
                        ? "border-primary/50 bg-primary/10"
                        : "border-border/40 hover:border-border/70 hover:bg-muted/20"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium text-sm text-foreground truncate">{job.title}</div>
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {[job.department, job.location].filter(Boolean).join(" · ") || "No details"}
                        </div>
                      </div>
                      {selectedJobId === job.id && (
                        <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>

            {/* Notes */}
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">Notes (optional)</label>
              <textarea
                className="w-full px-3 py-2 text-sm bg-background border border-border/50 rounded-lg outline-none focus:border-primary/50 text-foreground placeholder:text-muted-foreground resize-none"
                rows={2}
                placeholder="Any context about this candidate for the hiring team…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            {error && (
              <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 rounded-lg border border-border/50 text-sm text-muted-foreground hover:text-foreground hover:border-border/70 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleAssign}
                disabled={!selectedJobId || submitting}
                className="flex-1 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                {submitting ? (
                  <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Assigning…</>
                ) : (
                  <><Zap className="w-3.5 h-3.5" /> Assign &amp; Run AI</>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Intelligence Card ─────────────────────────────────────────────────── */
function BrainCard({
  record, pool, activityStatus, lastActiveAt, internalCandidateId, onAssign,
}: {
  record: IntelligenceRecord;
  pool?: string;
  activityStatus?: ActivityStatus;
  lastActiveAt?: string;
  /* When set, this platform-pool candidate already exists as an internal
     row in the caller's tenant — show the "Already in your DB" badge with
     a link to the internal record. */
  internalCandidateId?: string;
  onAssign?: (candidateId: string, candidateName: string) => void;
}) {
  const action = ACTION_CONFIG[record.nextBestAction ?? ""] ?? ACTION_CONFIG["hold"];
  const ActionIcon = action.icon;

  const name = [record.candidateFirstName, record.candidateLastName].filter(Boolean).join(" ") || "Unknown";
  const initials = name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2);

  return (
    <Card className="border-border/40 bg-card/80 backdrop-blur hover:border-primary/30 transition-all duration-200 group">
      <CardContent className="p-5">
        {/* Header row */}
        <div className="flex items-start gap-3 mb-4">
          <Avatar className="h-10 w-10 border border-border/40 flex-shrink-0">
            <AvatarFallback className="bg-primary/10 text-primary font-bold text-sm">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <Link href={`/candidates/${record.candidateId}`}>
              <span className="font-semibold text-foreground hover:text-primary transition-colors cursor-pointer text-sm leading-tight block truncate">
                {name}
              </span>
            </Link>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {record.candidateTitle || "No title"} {record.candidateCompany ? `· ${record.candidateCompany}` : ""}
            </div>
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-primary/20 text-primary/80 font-normal truncate max-w-[140px]">
                {record.jobTitle || "Unassigned"}
              </Badge>
              <PoolBadge pool={pool} />
              {pool === "platform" && (
                <ActivityBadge status={activityStatus} lastActiveAt={lastActiveAt} />
              )}
              {pool === "platform" && internalCandidateId && (
                <Link href={`/candidates/${internalCandidateId}`}>
                  <Badge className="text-[9px] px-1.5 py-0 h-4 bg-violet-500/15 text-violet-300 border border-violet-500/30 font-medium hover:bg-violet-500/25 cursor-pointer transition-colors">
                    Already in your DB
                  </Badge>
                </Link>
              )}
            </div>
          </div>
          {/* Trust-gated candidates lead with the gate status; the percentage
              is demoted to secondary text (see @/lib/trust-gate). */}
          {isTrustGated(record.trustScore) ? (
            <div className="flex flex-col items-end gap-1 flex-shrink-0 max-w-[110px] text-right">
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/40 leading-tight">
                <ShieldAlert className="w-3 h-3 shrink-0" /> {TRUST_GATE_LABEL}
              </span>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {record.hireProbability != null && !getEvidence(record.confidence, record.signalCount).insufficient
                  ? `${record.hireProbability}% if verified`
                  : "score pending"}
              </span>
            </div>
          ) : (
            <ProbabilityRing
              value={record.hireProbability}
              insufficient={getEvidence(record.confidence, record.signalCount).insufficient}
            />
          )}
        </div>

        {/* Evidence band — signal count + confidence, visible inline (not hover-only) */}
        <div className="mb-4">
          <EvidenceBadge confidence={record.confidence} signalCount={record.signalCount} />
        </div>

        {/* Score bars */}
        <div className="space-y-2 mb-4">
          <ScoreBar label="Fit"        value={record.fitScore}        color="text-cyan-400" />
          <ScoreBar label="Quality"    value={record.qualityScore}    color="text-violet-400" />
          <ScoreBar label="Trust"      value={record.trustScore}      color="text-emerald-400" />
          <ScoreBar label="Conversion" value={record.conversionScore} color="text-amber-400" />
        </div>

        {/* Next Best Action + profile links + assign */}
        <div className="flex items-center justify-between">
          <div className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border", action.bg, action.color)}>
            <ActionIcon className="w-3 h-3" />
            {action.label}
          </div>
          <div className="flex items-center gap-2">
            {onAssign && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={e => { e.preventDefault(); onAssign(record.candidateId, name); }}
                      aria-label="Assign to another job"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-primary"
                    >
                      <Briefcase className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top"><p className="text-xs">Assign to another job</p></TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
            {record.candidateLinkedin && (
              <a href={record.candidateLinkedin} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                <Linkedin className="w-3.5 h-3.5 text-muted-foreground hover:text-[#0A66C2] transition-colors" />
              </a>
            )}
            <Link href={`/candidates/${record.candidateId}`}>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground hover:text-primary transition-colors cursor-pointer opacity-0 group-hover:opacity-100" />
            </Link>
          </div>
        </div>

        {/* Strengths / Risks */}
        {(record.topStrengths?.length > 0 || record.topRisks?.length > 0) && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex flex-wrap gap-1 mt-3 cursor-default">
                  {record.topStrengths.slice(0, 3).map((s, i) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {s}
                    </span>
                  ))}
                  {record.topRisks && record.topRisks.length > 0 && record.topRisks.slice(0, 1).map((r, i) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/20">
                      ⚠ {r}
                    </span>
                  ))}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-xs">
                <div className="text-xs space-y-1">
                  {record.topStrengths.map((s, i) => <div key={i} className="text-emerald-400">✓ {s}</div>)}
                  {record.topRisks?.map((r, i) => <div key={i} className="text-red-400">⚠ {r}</div>)}
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Empty-state Candidate Card ────────────────────────────────────────── */
function PendingCard({
  candidate, onAssign,
}: {
  candidate: any;
  onAssign?: (candidateId: string, candidateName: string) => void;
}) {
  const initials = `${candidate.firstName?.[0] ?? ""}${candidate.lastName?.[0] ?? ""}`.toUpperCase();
  const name = `${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim() || "Unknown";
  const isPlatform = candidate.pool === "platform";
  return (
    <Card className="border-border/40 bg-card/60 hover:bg-card hover:border-primary/30 hover:shadow-md transition-all group relative">
      <CardContent className="p-5">
        <div className="flex items-center gap-3 mb-4">
          <Avatar className="h-10 w-10 border border-border/40 flex-shrink-0">
            <AvatarFallback className="bg-muted text-muted-foreground font-bold text-sm">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <Link href={`/candidates/${candidate.id}`}>
              <span className="font-semibold text-foreground hover:text-primary transition-colors text-sm leading-tight block truncate cursor-pointer">
                {name}
              </span>
            </Link>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {candidate.currentTitle || "No title"} {candidate.currentCompany ? `· ${candidate.currentCompany}` : ""}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
              <PoolBadge pool={candidate.pool} />
              {isPlatform && (
                <ActivityBadge status={candidate.activityStatus as ActivityStatus} lastActiveAt={candidate.lastActiveAt} />
              )}
              {isPlatform && (candidate as any).alreadyInTenantDb && (candidate as any).internalCandidateId && (
                <Link href={`/candidates/${(candidate as any).internalCandidateId}`}>
                  <Badge className="text-[9px] px-1.5 py-0 h-4 bg-violet-500/15 text-violet-300 border border-violet-500/30 font-medium hover:bg-violet-500/25 cursor-pointer transition-colors">
                    Already in your DB
                  </Badge>
                </Link>
              )}
              {candidate.location && !isPlatform && (
                <span className="text-[10px] text-muted-foreground/60">{candidate.location}</span>
              )}
            </div>
          </div>
          <div className="w-8 h-8 flex items-center justify-center text-muted-foreground/40 group-hover:text-primary/40 transition-colors">
            <Brain className="w-5 h-5" />
          </div>
        </div>

        <div className="space-y-2.5">
          <div className="text-center py-1">
            <div className="text-xs text-muted-foreground">Not yet matched to a job</div>
          </div>
          {onAssign ? (
            <button
              onClick={e => { e.preventDefault(); onAssign(candidate.id, name); }}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/50 text-primary text-xs font-semibold transition-all"
            >
              <Briefcase className="w-3.5 h-3.5" />
              Assign to Work Order
            </button>
          ) : (
            <div className="text-center text-[10px] text-muted-foreground/60">
              Click to view profile · assign to a job to run AI scoring
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Boolean Search Engine ──────────────────────────────────────────────── */
/**
 * Parses a recruiter search string into OR-groups of AND-terms plus exclusions.
 * Syntax:
 *   "React London"          → both must match (implicit AND)
 *   "React OR Vue"          → either must match
 *   "React AND London"      → both must match (explicit AND)
 *   "-junior"  / "NOT junior" → must NOT contain "junior"
 *   '"product manager"'     → exact phrase must match
 */
interface ParsedQuery {
  orGroups: string[][];
  excluded:  string[];
}

function parseBooleanQuery(raw: string): ParsedQuery | null {
  const q = raw.trim();
  if (!q) return null;

  const excluded: string[] = [];
  const phrases:  string[] = [];

  // 1. Lift quoted phrases into a placeholder array
  let rest = q.replace(/"([^"]+)"/g, (_, p) => {
    const idx = phrases.length;
    phrases.push(p.toLowerCase());
    return `__P${idx}__`;
  });

  // 2. Extract NOT exclusions
  rest = rest.replace(/\bNOT\s+(\S+)/gi, (_, w) => {
    excluded.push(resolveToken(w, phrases));
    return ' ';
  });
  rest = rest.replace(/(?<!\S)-(\S+)/g, (_, w) => {
    excluded.push(resolveToken(w, phrases));
    return ' ';
  });

  // 3. Split by OR → create OR-groups; within each group split by AND or spaces → required terms
  const orGroups = rest
    .split(/\s+OR\s+/i)
    .map(part =>
      part
        .split(/\s+AND\s+|\s+/i)
        .map(w => resolveToken(w.trim(), phrases))
        .filter(Boolean)
    )
    .filter(g => g.length > 0);

  return { orGroups, excluded };
}

function resolveToken(tok: string, phrases: string[]): string {
  const m = tok.match(/^__P(\d+)__$/);
  return m ? (phrases[parseInt(m[1])] ?? '') : tok.toLowerCase();
}

function matchesBooleanQuery(text: string, query: ParsedQuery): boolean {
  if (query.excluded.some(ex => text.includes(ex))) return false;
  if (query.orGroups.length === 0) return true;
  return query.orGroups.some(group => group.every(term => text.includes(term)));
}

/** Build a single lowercase searchable string from all candidate+intel fields. */
function buildSearchText(
  fields: (string | null | undefined)[],
  skills?: (string | null | undefined)[] | null,
): string {
  return [
    ...fields,
    ...(skills ?? []),
  ].filter(Boolean).join(' ').toLowerCase();
}

/* ─── Pool Filter Tabs ───────────────────────────────────────────────────── */
const POOL_TABS: { key: PoolFilter; label: string; icon: any }[] = [
  { key: "all",      label: "All Candidates", icon: Users },
  { key: "tenant",   label: "My Pipeline",    icon: Building2 },
  { key: "platform", label: "Platform Pool",  icon: Database },
];

type ActivityFilter = "all" | "active" | "passive" | "inactive";

/* ─── NL Search Result type ─────────────────────────────────────────────── */
interface NlResult {
  interpretation: string;
  filters: {
    skills: string[];
    locations: string[];
    countries: string[];
    activityStatus: string | null;
    maxDaysSinceActive: number | null;
    experienceLevel: string | null;
    keywords: string[];
    pool: string | null;
  };
  candidates: any[];
}

/* ─── Main Page ─────────────────────────────────────────────────────────── */
export default function CandidatesList() {
  const [search, setSearch] = useState("");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");

  /* NL / AI Search */
  const [nlLoading, setNlLoading] = useState(false);
  const [nlResult, setNlResult] = useState<NlResult | null>(null);
  const [nlError, setNlError] = useState<string | null>(null);

  async function runNlSearch(q: string) {
    if (!q.trim()) return;
    setNlLoading(true);
    setNlError(null);
    setNlResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/candidates/nl-search`, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data: NlResult = await res.json();
      setNlResult(data);
    } catch (e: any) {
      setNlError(e.message ?? "Search failed");
    } finally {
      setNlLoading(false);
    }
  }

  function clearNlSearch() {
    setNlResult(null);
    setNlError(null);
    setSearch("");
  }

  /* Assign-to-job modal state (shared across all cards) */
  const [assignModal, setAssignModal] = useState<{ candidateId: string; candidateName: string } | null>(null);
  const openAssign = (candidateId: string, candidateName: string) =>
    setAssignModal({ candidateId, candidateName });
  const closeAssign = () => setAssignModal(null);

  /* Initialise pool filter from ?pool= URL param (e.g. platform admin link) */
  const initialPool = useMemo<PoolFilter>(() => {
    const p = new URLSearchParams(window.location.search).get("pool");
    if (p === "platform" || p === "tenant") return p;
    return "all";
  }, []);
  const [poolFilter, setPoolFilter] = useState<PoolFilter>(initialPool);

  /* Blocked-work door from the dashboard Morning Report: ?flag=blocked narrows
   * the list to candidates with a non-deliverable email (empty or a placeholder
   * domain) — the same "blocked from outreach" set the report counts. Mirrors
   * lib/real-email.ts PLACEHOLDER_DOMAINS on the server. */
  const [blockedOnly, setBlockedOnly] = useState(
    () => new URLSearchParams(window.location.search).get("flag") === "blocked",
  );
  const isNonDeliverableEmail = (email?: string | null): boolean => {
    const e = (email ?? "").trim().toLowerCase();
    if (!e) return true;
    return ["@unknown.local", "@import.local"].some((s) => e.endsWith(s));
  };

  /* Sync if the URL params change (e.g. back/forward navigation) */
  useEffect(() => {
    const onPop = () => {
      const q = new URLSearchParams(window.location.search);
      const p = q.get("pool");
      if (p === "platform" || p === "tenant") setPoolFilter(p);
      else setPoolFilter("all");
      setBlockedOnly(q.get("flag") === "blocked");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /* Drop the blocked-work door: clear the filter and strip ?flag=blocked from
   * the URL so a refresh / back doesn't re-apply it. */
  const clearBlockedFilter = () => {
    setBlockedOnly(false);
    const q = new URLSearchParams(window.location.search);
    q.delete("flag");
    const qs = q.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
  };

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: intelData, isLoading: intelLoading, refetch: refetchIntel, isFetching: intelFetching } = useIntelligence();
  const { data: candidateData, isLoading: candidateLoading } = useListCandidates({});
  const blockedView = blockedOnly && poolFilter !== "platform";
  const { data: blockedData, isLoading: blockedLoading } = useBlockedCandidates(blockedView);

  const handleRefresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["intelligence"] }),
      queryClient.invalidateQueries({ queryKey: ["candidates"] }),
      queryClient.invalidateQueries({ queryKey: ["blocked-candidates"] }),
      refetchIntel(),
    ]);
    toast({ title: "Refreshed", description: "Intelligence data updated." });
  };

  const records       = intelData?.data ?? [];
  const allCandidates = candidateData?.candidates ?? [];

  /* Pool lookup map: candidateId → pool */
  const poolMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of allCandidates) {
      m.set(c.id, (c as any).pool ?? "tenant");
    }
    return m;
  }, [allCandidates]);

  /* Cross-pool dedup hint: candidateId (platform row) → internal candidate id
     in the caller's own tenant pool. Driven by `alreadyInTenantDb` flag the
     /candidates endpoint sets when a platform candidate's email matches one
     the recruiter already owns. Used to render the "Already in your DB" pill
     on BrainCard / PendingCard so recruiters don't waste outreach on someone
     they already have internally. */
  const dedupMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of allCandidates) {
      if ((c as any).alreadyInTenantDb && (c as any).internalCandidateId) {
        m.set(c.id, (c as any).internalCandidateId as string);
      }
    }
    return m;
  }, [allCandidates]);

  /* Activity lookup map: candidateId → {activityStatus, lastActiveAt} */
  const activityMap = useMemo(() => {
    const m = new Map<string, { activityStatus?: ActivityStatus; lastActiveAt?: string }>();
    for (const c of allCandidates) {
      if ((c as any).pool === "platform") {
        m.set(c.id, {
          activityStatus: (c as any).activityStatus as ActivityStatus | undefined,
          lastActiveAt:   (c as any).lastActiveAt as string | undefined,
        });
      }
    }
    return m;
  }, [allCandidates]);

  /* Meta lookup: candidateId → {location, skills, timezone, company} */
  const metaMap = useMemo(() => {
    const m = new Map<string, { location?: string; skills?: string[]; timezone?: string; company?: string }>();
    for (const c of allCandidates) {
      m.set(c.id, {
        location:  (c as any).location   ?? undefined,
        skills:    Array.isArray((c as any).skills) ? (c as any).skills : [],
        timezone:  (c as any).timezone   ?? undefined,
        company:   (c as any).currentCompany ?? undefined,
      });
    }
    return m;
  }, [allCandidates]);

  /* Resolve a candidate's real email by id — IntelligenceRecord has no email
   * field, so the blocked door must read it from the raw candidate list. */
  const emailByCandidateId = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const c of allCandidates) m.set(c.id, (c as any).email ?? null);
    return m;
  }, [allCandidates]);

  /* Deduplicate: best (highest hire_probability) record per candidate */
  const bestPerCandidate = useMemo(() => {
    const map = new Map<string, IntelligenceRecord>();
    for (const r of records) {
      const existing = map.get(r.candidateId);
      if (!existing || (r.hireProbability ?? 0) > (existing.hireProbability ?? 0)) {
        map.set(r.candidateId, r);
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.hireProbability ?? 0) - (a.hireProbability ?? 0));
  }, [records]);

  /* Candidates that have no intelligence data */
  const analyzedIds = useMemo(
    () => new Set(bestPerCandidate.map(r => r.candidateId)),
    [bestPerCandidate],
  );
  const pending = allCandidates.filter(c => !analyzedIds.has(c.id));

  /* Server-authoritative blocked set (Morning Report "needs contact details"
   * door). Reconciles 1:1 with the door's count — crucially it includes
   * in-pipeline candidates with no intelligence row (unscored), which the intel
   * + pending lists below would otherwise drop. */
  const blockedCandidates = blockedData?.candidates ?? [];
  const blockedIdSet = useMemo(
    () => new Set(blockedCandidates.map(c => c.id)),
    [blockedCandidates],
  );

  /* Apply pool filter */
  const poolFilteredIntel = useMemo(() => {
    if (poolFilter === "all") return bestPerCandidate;
    return bestPerCandidate.filter(r => (poolMap.get(r.candidateId) ?? "tenant") === poolFilter);
  }, [bestPerCandidate, poolFilter, poolMap]);

  const poolFilteredPending = useMemo(() => {
    if (poolFilter === "all") return pending;
    return pending.filter(c => ((c as any).pool ?? "tenant") === poolFilter);
  }, [pending, poolFilter]);

  /* Apply activity filter (only meaningful when poolFilter === "platform") */
  const activityFilteredIntel = useMemo(() => {
    if (poolFilter !== "platform" || activityFilter === "all") return poolFilteredIntel;
    return poolFilteredIntel.filter(r => {
      const act = activityMap.get(r.candidateId);
      return act?.activityStatus === activityFilter;
    });
  }, [poolFilteredIntel, activityFilter, poolFilter, activityMap]);

  const activityFilteredPending = useMemo(() => {
    if (poolFilter !== "platform" || activityFilter === "all") return poolFilteredPending;
    return poolFilteredPending.filter(c => (c as any).activityStatus === activityFilter);
  }, [poolFilteredPending, activityFilter, poolFilter]);

  /* Parse boolean query once, reuse for both lists */
  const parsedQuery = useMemo(() => parseBooleanQuery(search), [search]);

  /* Filter by search — covers name, role, job, company, location, country, skills, timezone */
  const filtered = useMemo(() => {
    let base = activityFilteredIntel;
    if (blockedView) base = base.filter(r => blockedIdSet.has(r.candidateId));
    else if (blockedOnly) base = base.filter(r => isNonDeliverableEmail(emailByCandidateId.get(r.candidateId)));
    if (!parsedQuery) return base;
    return base.filter(r => {
      const meta = metaMap.get(r.candidateId) ?? {};
      const text = buildSearchText(
        [
          r.candidateFirstName,
          r.candidateLastName,
          r.candidateEmail,
          r.candidateTitle,
          r.candidateCompany,
          r.jobTitle,
          r.jobDepartment,
          meta.location,
          meta.timezone,
          meta.company,
        ],
        meta.skills,
      );
      return matchesBooleanQuery(text, parsedQuery);
    });
  }, [activityFilteredIntel, parsedQuery, metaMap, blockedOnly, blockedView, blockedIdSet]);

  const filteredPending = useMemo(() => {
    /* Blocked door: show the UNSCORED half of the server-authoritative blocked
     * set (in-pipeline, non-deliverable email, but no intelligence row yet) as
     * pending cards. The scored half flows through `filtered` above; together
     * they reconcile 1:1 with the Morning Report door's count. */
    let base: any[];
    if (blockedView) {
      base = blockedCandidates.filter(c => !analyzedIds.has(c.id));
    } else if (blockedOnly) {
      return [];
    } else {
      base = activityFilteredPending;
    }
    if (!parsedQuery) return base;
    return base.filter(c => {
      const meta = metaMap.get(c.id) ?? {};
      const text = buildSearchText(
        [
          (c as any).firstName,
          (c as any).lastName,
          (c as any).email,
          (c as any).currentTitle,
          (c as any).currentCompany,
          meta.location,
          meta.timezone,
          meta.company,
        ],
        meta.skills,
      );
      return matchesBooleanQuery(text, parsedQuery);
    });
  }, [activityFilteredPending, parsedQuery, metaMap, blockedOnly, blockedView, blockedCandidates, analyzedIds]);

  /* Stats — always scoped to the active pool filter */
  const platformCandidates = allCandidates.filter(c => (c as any).pool === "platform");
  const platformCount  = platformCandidates.length;
  const platformActive   = platformCandidates.filter(c => (c as any).activityStatus === "active").length;
  const platformPassive  = platformCandidates.filter(c => (c as any).activityStatus === "passive").length;
  const platformInactive = platformCandidates.filter(c => (c as any).activityStatus === "inactive").length;

  const activeAnalyzed = poolFilteredIntel.length;
  const activeAvgHire  = activeAnalyzed
    ? Math.round(poolFilteredIntel.reduce((s, r) => s + (r.hireProbability ?? 0), 0) / activeAnalyzed)
    : 0;
  const activeTopAction = poolFilteredIntel.filter(
    r => r.nextBestAction === "advance" || r.nextBestAction === "make_offer"
  ).length;
  /* 4th stat changes contextually */
  const fourthStat = poolFilter === "all"
    ? { label: "Platform Pool", value: platformCount, icon: Database, color: "text-sky-400" }
    : poolFilter === "platform"
    ? { label: "Total in Pool",  value: poolFilteredIntel.length + poolFilteredPending.length, icon: Users, color: "text-sky-400" }
    : { label: "Platform Pool", value: platformCount, icon: Database, color: "text-sky-400" };

  const isLoading = intelLoading || candidateLoading || (blockedView && blockedLoading);

  /* ── Client-side pagination (applied only to the standard grid, not NL search) */
  const PAGE_SIZE = 24;
  const [candidatePage, setCandidatePage] = useState(1);

  /* Reset to page 1 whenever any filter or search changes */
  useEffect(() => { setCandidatePage(1); }, [search, poolFilter, activityFilter, nlResult]);

  /* Combine both lists, slice for current page, then split back for rendering */
  const combinedForPage = useMemo(() => [
    ...filtered.map(r   => ({ kind: "intel"   as const, r })),
    ...filteredPending.map(c => ({ kind: "pending" as const, c })),
  ], [filtered, filteredPending]);

  const totalCandidates = combinedForPage.length;
  const totalPages      = Math.max(1, Math.ceil(totalCandidates / PAGE_SIZE));
  const pagedCombined   = combinedForPage.slice((candidatePage - 1) * PAGE_SIZE, candidatePage * PAGE_SIZE);
  const pagedFiltered   = pagedCombined.filter(x => x.kind === "intel").map(x => (x as any).r   as IntelligenceRecord);
  const pagedPending    = pagedCombined.filter(x => x.kind === "pending").map(x => (x as any).c as any);

  return (
    <AppLayout>
      {/* Page header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <button
            onClick={() => window.history.back()}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <div className="flex items-center gap-2 mb-1">
            {poolFilter === "platform"
              ? <Database className="w-6 h-6 text-sky-400" />
              : blockedOnly
              ? <AlertCircle className="w-6 h-6 text-amber-400" />
              : <Brain className="w-6 h-6 text-primary" />
            }
            <h1 className="page-title">
              {poolFilter === "platform"
                ? "Platform Candidate Pool"
                : blockedOnly
                ? "Candidates Needing Contact Details"
                : "Hiring Brain"}
            </h1>
          </div>
          <p className="text-muted-foreground">
            {poolFilter === "platform"
              ? "Candidates who self-registered on the Lexy platform and consented to be discovered by tenants."
              : blockedOnly
              ? "These candidates are in your pipeline but have no reachable email yet — add contact details to start outreach."
              : "AI-powered intelligence scores for every candidate in your pipeline."
            }
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={handleRefresh}
          disabled={intelFetching}
        >
          <RefreshCw className={cn("w-4 h-4", intelFetching && "animate-spin")} />
          {intelFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* Blocked-work door banner (from the dashboard Morning Report) */}
      {blockedOnly && poolFilter !== "platform" && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm text-amber-200">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>Showing only candidates with no reachable email. Add contact details to unblock outreach.</span>
          </div>
          <button
            onClick={clearBlockedFilter}
            className="text-xs font-medium text-amber-200/80 hover:text-amber-100 underline underline-offset-2 whitespace-nowrap"
          >
            Show all candidates
          </button>
        </div>
      )}

      {/* Stats strip — scoped to active pool filter */}
      {poolFilter === "platform" ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: "Total in Pool", value: platformCount,   icon: Users,     color: "text-sky-400" },
            { label: "Active",        value: platformActive,  icon: Activity,  color: "text-emerald-400" },
            { label: "Passive",       value: platformPassive, icon: Clock,     color: "text-amber-400" },
            { label: "Inactive",      value: platformInactive,icon: AlertCircle, color: "text-rose-400" },
          ].map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="border-border/40 bg-card/60">
              <CardContent className="p-4 flex items-center gap-3">
                <Icon className={cn("w-5 h-5 flex-shrink-0", color)} />
                <div>
                  <div className="text-xl font-bold tabular-nums">{value}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {[
            { label: "Analyzed",        value: activeAnalyzed,        icon: Brain,      color: "text-primary"       },
            { label: "Avg. Hire Prob",  value: `${activeAvgHire}%`,   icon: TrendingUp, color: "text-emerald-400"   },
            { label: "Advance / Offer", value: activeTopAction,       icon: Zap,        color: "text-cyan-400"      },
            fourthStat,
          ].map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="border-border/40 bg-card/60">
              <CardContent className="p-4 flex items-center gap-3">
                <Icon className={cn("w-5 h-5 flex-shrink-0", color)} />
                <div>
                  <div className="text-xl font-bold tabular-nums">{value}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Pool filter tabs */}
      <div className="flex items-center gap-2 mb-3">
        {POOL_TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => { setPoolFilter(key); setActivityFilter("all"); if (key === "platform") clearBlockedFilter(); }}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all border",
              poolFilter === key
                ? key === "platform"
                  ? "bg-sky-500/15 text-sky-300 border-sky-500/30"
                  : "bg-primary/10 text-primary border-primary/25"
                : "text-muted-foreground border-border/40 hover:text-foreground hover:border-border/70 hover:bg-muted/20"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
            {key === "platform" && platformCount > 0 && (
              <span className={cn(
                "text-[10px] px-1.5 py-0 rounded-full font-bold",
                poolFilter === "platform" ? "bg-sky-500/20 text-sky-300" : "bg-muted text-muted-foreground"
              )}>
                {platformCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Activity filter — only shown for Platform Pool view */}
      {poolFilter === "platform" && (
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-3.5 h-3.5 text-muted-foreground/50" />
          {(["all", "active", "passive", "inactive"] as ActivityFilter[]).map(key => {
            const counts: Record<ActivityFilter, number | string> = {
              all: platformCount,
              active: platformActive,
              passive: platformPassive,
              inactive: platformInactive,
            };
            const colors: Record<ActivityFilter, string> = {
              all: "bg-sky-500/15 text-sky-300 border-sky-500/30",
              active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
              passive: "bg-amber-500/15 text-amber-300 border-amber-500/30",
              inactive: "bg-rose-500/15 text-rose-300 border-rose-500/30",
            };
            const labels: Record<ActivityFilter, string> = { all: "All", active: "Active", passive: "Passive", inactive: "Inactive" };
            return (
              <button
                key={key}
                onClick={() => setActivityFilter(key)}
                className={cn(
                  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all border",
                  activityFilter === key
                    ? colors[key]
                    : "text-muted-foreground border-border/40 hover:text-foreground hover:border-border/60 hover:bg-muted/20"
                )}
              >
                {labels[key]}
                <span className={cn(
                  "text-[10px] px-1 rounded font-bold tabular-nums",
                  activityFilter === key ? "bg-white/10" : "text-muted-foreground"
                )}>
                  {counts[key]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search */}
      <Card className="mb-6 border-border/40">
        <div className="p-4">
          {/* Search input row */}
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              {nlLoading
                ? <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 text-violet-400 w-4 h-4 animate-spin" />
                : nlResult
                ? <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 text-violet-400 w-4 h-4" />
                : <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4" />
              }
              <Input
                placeholder={`Ask in plain English — e.g. "find React developers in UK active in last 30 days"`}
                className={cn(
                  "pl-10 pr-16 bg-background border-border/50 transition-colors",
                  nlResult && "border-violet-500/40 bg-violet-500/5",
                  nlLoading && "border-violet-500/40",
                )}
                value={search}
                onChange={e => {
                  setSearch(e.target.value);
                  if (nlResult) { setNlResult(null); setNlError(null); }
                }}
                onKeyDown={e => {
                  if (e.key === "Enter" && search.trim()) {
                    runNlSearch(search.trim());
                  }
                }}
                disabled={nlLoading}
              />
              {/* Clear button */}
              {(search || nlResult) && !nlLoading && (
                <button
                  onClick={clearNlSearch}
                  aria-label="Clear search"
                  className="absolute right-9 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              {/* Boolean search help tooltip */}
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button aria-label="Search syntax help" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                      <HelpCircle className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" align="end" className="max-w-xs p-0 text-left">
                    <div className="p-3 space-y-2">
                      <div className="text-xs font-semibold text-foreground mb-1 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-violet-400" />
                        AI natural language search
                      </div>
                      <div className="text-xs text-muted-foreground leading-relaxed">
                        Type a sentence and press <span className="font-mono bg-muted px-1 rounded text-foreground">Enter</span> to search with AI:
                      </div>
                      <div className="space-y-1 text-xs text-muted-foreground/80">
                        <div className="italic">"find React developers in the UK active last 30 days"</div>
                        <div className="italic">"senior Python engineers in Germany"</div>
                        <div className="italic">"platform pool candidates with AWS skills"</div>
                      </div>
                      <div className="pt-1 border-t border-border/40 text-[10px] text-muted-foreground">
                        Also supports boolean: React AND London · -junior · "product manager"
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            {/* Search button */}
            <Button
              size="sm"
              variant={nlResult ? "default" : "outline"}
              className={cn(
                "gap-1.5 px-3 shrink-0 transition-all",
                nlResult && "bg-violet-600 hover:bg-violet-700 border-violet-600",
              )}
              onClick={() => search.trim() ? runNlSearch(search.trim()) : undefined}
              disabled={nlLoading || !search.trim()}
            >
              {nlLoading
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Sparkles className="w-3.5 h-3.5" />
              }
              {nlLoading ? "Searching…" : "AI Search"}
            </Button>
          </div>

          {/* NL Interpretation banner */}
          {nlResult && (
            <div className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-violet-500/10 border border-violet-500/25">
              <Sparkles className="w-3.5 h-3.5 text-violet-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-violet-300 leading-relaxed">{nlResult.interpretation}</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {nlResult.filters.skills.map(s => (
                    <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/20 font-medium">{s}</span>
                  ))}
                  {[...nlResult.filters.locations, ...nlResult.filters.countries].map(l => (
                    <span key={l} className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/20 font-medium">{l}</span>
                  ))}
                  {nlResult.filters.activityStatus && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/20 font-medium">{nlResult.filters.activityStatus}</span>
                  )}
                  {nlResult.filters.maxDaysSinceActive && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/20 font-medium">last {nlResult.filters.maxDaysSinceActive}d</span>
                  )}
                  {nlResult.filters.keywords.map(k => (
                    <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/40 font-medium">{k}</span>
                  ))}
                </div>
              </div>
              <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                {pluralize(nlResult.candidates.length, "result")}
              </span>
            </div>
          )}

          {/* NL Error */}
          {nlError && (
            <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-lg bg-destructive/10 border border-destructive/25">
              <AlertCircle className="w-3.5 h-3.5 text-destructive flex-shrink-0" />
              <span className="text-xs text-destructive">{nlError}</span>
            </div>
          )}

          {/* Boolean search tokens (only when NOT in NL mode) */}
          {!nlResult && parsedQuery && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {parsedQuery.orGroups.flatMap(group => group).map((term, i) => (
                <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 text-primary text-xs font-medium">
                  {term}
                </span>
              ))}
              {parsedQuery.excluded.map((term, i) => (
                <span key={`ex-${i}`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-destructive/10 text-destructive text-xs font-medium">
                  −{term}
                </span>
              ))}
              <span className="text-xs text-muted-foreground ml-1">
                {pluralize(filtered.length + filteredPending.length, "result")}
              </span>
            </div>
          )}
        </div>
      </Card>

      {/* NL Search loading skeleton */}
      {nlLoading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="border-violet-500/20 animate-pulse">
              <CardContent className="p-5 space-y-3">
                <div className="flex gap-3">
                  <div className="w-10 h-10 rounded-full bg-violet-500/10" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-violet-500/10 rounded w-3/4" />
                    <div className="h-2 bg-violet-500/10 rounded w-1/2" />
                  </div>
                </div>
                <div className="space-y-2">
                  {[1,2].map(n => <div key={n} className="h-2 bg-violet-500/10 rounded" />)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* NL Search results */}
      {!nlLoading && nlResult && (
        nlResult.candidates.length === 0 ? (
          <Card className="border-border/30 border-dashed">
            <CardContent className="p-16 text-center">
              <Sparkles className="w-12 h-12 text-violet-400/30 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-muted-foreground mb-2">No matching candidates</h3>
              <p className="text-sm text-muted-foreground/60 max-w-sm mx-auto">
                Try rephrasing your search — for example, broaden the location, remove the time filter, or check the skill name.
              </p>
              <button onClick={clearNlSearch} className="mt-4 text-xs text-violet-400 hover:text-violet-300 underline underline-offset-2">
                Clear AI search
              </button>
            </CardContent>
          </Card>
        ) : (() => {
          /* Split NL results into those with intel records and those without */
          const nlWithIntel = nlResult.candidates
            .map(c => ({ c, rec: bestPerCandidate.find(r => r.candidateId === c.id) }))
            .filter(({ rec }) => rec != null) as { c: any; rec: IntelligenceRecord }[];
          const nlPending = nlResult.candidates.filter(c => !analyzedIds.has(c.id));

          return (
            <>
              {nlWithIntel.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
                  {nlWithIntel.map(({ c, rec }) => (
                    <BrainCard
                      key={rec.id}
                      record={rec}
                      pool={c.pool}
                      activityStatus={c.activityStatus}
                      lastActiveAt={c.lastActiveAt}
                      internalCandidateId={c.alreadyInTenantDb ? c.internalCandidateId : undefined}
                      onAssign={openAssign}
                    />
                  ))}
                </div>
              )}
              {nlPending.length > 0 && (
                <div className="mt-4">
                  <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    Unmatched ({nlPending.length})
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {nlPending.map(c => (
                      <PendingCard key={c.id} candidate={c} onAssign={openAssign} />
                    ))}
                  </div>
                </div>
              )}
            </>
          );
        })()
      )}

      {/* Standard intelligence grid (shown when NOT in NL mode) */}
      {!nlLoading && !nlResult && (
        isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Card key={i} className="border-border/30 animate-pulse">
                <CardContent className="p-5 space-y-3">
                  <div className="flex gap-3">
                    <div className="w-10 h-10 rounded-full bg-muted" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-muted rounded w-3/4" />
                      <div className="h-2 bg-muted rounded w-1/2" />
                    </div>
                    <div className="w-16 h-16 rounded-full bg-muted" />
                  </div>
                  <div className="space-y-2">
                    {[1,2,3,4].map(n => <div key={n} className="h-2 bg-muted rounded" />)}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : totalCandidates > 0 ? (
          <>
            {pagedFiltered.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
                {pagedFiltered.map(r => {
                  const act = activityMap.get(r.candidateId);
                  return (
                    <BrainCard
                      key={r.id}
                      record={r}
                      pool={poolMap.get(r.candidateId)}
                      activityStatus={act?.activityStatus}
                      lastActiveAt={act?.lastActiveAt}
                      internalCandidateId={dedupMap.get(r.candidateId)}
                      onAssign={openAssign}
                    />
                  );
                })}
              </div>
            )}
            {pagedPending.length > 0 && (
              <div className="mt-4">
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Clock className="w-4 h-4" />
                  Unmatched ({filteredPending.length})
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {pagedPending.map(c => (
                    <PendingCard key={c.id} candidate={c} onAssign={openAssign} />
                  ))}
                </div>
              </div>
            )}

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-8 pt-4 border-t border-border/40">
                <span className="text-xs text-muted-foreground">
                  Page {candidatePage} of {totalPages} · {totalCandidates} candidates
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    disabled={candidatePage <= 1}
                    aria-label="Previous page"
                    onClick={() => { setCandidatePage(p => Math.max(1, p - 1)); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(p => p === 1 || p === totalPages || Math.abs(p - candidatePage) <= 1)
                    .reduce<(number | "…")[]>((acc, p, i, arr) => {
                      if (i > 0 && (p as number) - (arr[i - 1] as number) > 1) acc.push("…");
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((p, i) =>
                      p === "…" ? (
                        <span key={`e${i}`} className="text-xs text-muted-foreground px-1.5">…</span>
                      ) : (
                        <Button
                          key={p}
                          variant={candidatePage === p ? "default" : "outline"}
                          size="sm"
                          className="h-8 w-8 p-0 text-xs"
                          onClick={() => { setCandidatePage(p as number); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                        >
                          {p}
                        </Button>
                      )
                    )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 w-8 p-0"
                    disabled={candidatePage >= totalPages}
                    aria-label="Next page"
                    onClick={() => { setCandidatePage(p => Math.min(totalPages, p + 1)); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        ) : (
          <Card className="border-border/30 border-dashed">
            <CardContent className="p-16 text-center">
              {poolFilter === "platform" && !search ? (
                <>
                  <Database className="w-12 h-12 text-sky-400/30 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-muted-foreground mb-2">
                    No candidates in the platform pool yet
                  </h3>
                  <p className="text-sm text-muted-foreground/60 max-w-md mx-auto">
                    Candidates appear here automatically once they <strong className="text-muted-foreground">self-register via the Lexy candidate portal</strong> (the public website) and complete their baseline career interview. Their pool is set to <code className="text-sky-400 text-xs bg-sky-500/10 px-1.5 py-0.5 rounded">platform</code> and they become discoverable by any tenant with database access.
                  </p>
                  <p className="text-xs text-muted-foreground/40 mt-4">
                    You can test this by logging in as the demo candidate: <span className="font-mono">omar.farouq@gmail.com</span>
                  </p>
                </>
              ) : (
                <>
                  <Brain className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
                  <h3 className="text-lg font-semibold text-muted-foreground mb-2">
                    {search
                      ? "No matching candidates"
                      : poolFilter === "tenant"
                      ? "No candidates in your pipeline yet"
                      : "No intelligence data yet"}
                  </h3>
                  <p className="text-sm text-muted-foreground/60 max-w-sm mx-auto">
                    {search
                      ? "Try a different search query."
                      : "Run the Screening or Sourcing agent on a job to generate intelligence scores."}
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        )
      )}

      {/* Assign to Job modal — single shared instance */}
      <AssignToJobModal
        candidateId={assignModal?.candidateId ?? ""}
        candidateName={assignModal?.candidateName ?? ""}
        open={!!assignModal}
        onClose={closeAssign}
        onSuccess={() => {
          refetchIntel();
          setTimeout(closeAssign, 1800);
        }}
      />
    </AppLayout>
  );
}
