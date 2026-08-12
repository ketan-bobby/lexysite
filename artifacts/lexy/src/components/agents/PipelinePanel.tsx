/**
 * PipelinePanel.tsx — Kanban-style candidate pipeline board.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Renders a horizontal Kanban board where each column is a hiring stage
 * (Sourced → Screening → Interview → Offer → Hired / Rejected).  Recruiters
 * drag candidate cards between columns, or use the inline action menu to
 * advance, reject, schedule, or send outreach in a single click.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  STAGE_COLS       Stage column definitions (key, label, colour tokens)
 *  apiFetch()       Inline fetch helper with JWT auth header
 *  <CandidateCard>  Single card: avatar, name, score badges, action buttons
 *  <StageColumn>    Column wrapper: header count + scrollable card list
 *  <PipelinePanel>  Root component — fetches candidates, wires mutations
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET  /api/candidates?jobId=…         Candidate list for the active job
 *  PATCH /api/candidates/:id            Stage / status update
 *  POST  /api/outreach/send             Quick outreach from card action
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/jobs/[id].tsx        Embedded in the job detail view
 */

import { useState, useRef, useEffect, useMemo, forwardRef } from "react";
import { authHeaders } from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2,
  Github,
  Linkedin,
  Sparkles,
  MapPin,
  Users,
  ArrowRight,
  UserPlus,
  Mail,
  Video,
  ExternalLink,
  Upload,
  FileText,
  Download,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ThumbsUp,
  Calendar,
  MessageSquare,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Plus,
  Trash2,
  Save,
  Check,
  Target,
  DollarSign,
  UserCheck,
  ThumbsDown,
  Play,
  Send,
  Copy,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  RotateCcw,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn, pluralize } from "@/lib/utils";
import { scoreBand, SCORE_BAND_PILL } from "@/lib/score-band";
import { DemoRunBadge } from "./DemoRunBadge";
import { useToast } from "@workspace/react-hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useLocation } from "wouter";
import {
  OutreachDraftCard,
  useJobPendingDrafts,
  type OutreachMessage,
} from "@/components/agents/JobOutreachDrafts";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...opts,
  });
  if (!res.ok) {
    // Surface API-provided error message when present so callers (toasts) can show it
    let message = `API ${res.status}`;
    let code: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
      if (body?.code) code = body.code;
    } catch {
      /* response wasn't JSON, fall back to status */
    }
    const err = new Error(message) as Error & { code?: string };
    if (code) err.code = code;
    throw err;
  }
  return res.json();
}

/* ── Stage config ─────────────────────────────────────────────────────────
 * The one canonical stage list. `boardLane` marks the working lanes rendered as
 * Kanban columns; terminal stages (`terminal`) leave the board entirely (Step 3)
 * — wins live in a slim far-right strip + the Closed drawer, losses in the
 * drawer only. Note the column key "shortlisted" is now labelled "Shortlisted"
 * (one name, one meaning): enrollment in an outreach campaign is a card-level
 * status, not a column name — a candidate can be shortlisted yet blocked from
 * outreach (no-email guardrail), so a column called "Outreach Queued" would be a
 * lie for exactly those rows. */
type StageCol = { key: string; label: string; boardLane: boolean; terminal?: "win" | "loss" };
/* Human-readable labels for the sourcing channel a candidate came from
 * (candidates.source / sourced_candidates.source). Channels not listed here
 * fall back to the generic "AI Sourced" badge. */
const SOURCE_CHANNEL_LABELS: Record<string, string> = {
  pdl: "Talent Database",
  serp: "Web Search",
  github: "GitHub",
  enrichlayer: "LinkedIn Enrich",
  internal: "Internal Pool",
};

const STAGE_COLS: StageCol[] = [
  { key: "sourced", label: "Sourced", boardLane: true },
  { key: "screening", label: "Screening", boardLane: true },
  { key: "verification", label: "Verify", boardLane: true },
  { key: "shortlisted", label: "Shortlisted", boardLane: true },
  { key: "interview", label: "Interview", boardLane: true },
  { key: "interview_scheduled", label: "Scheduled", boardLane: true },
  { key: "interview_completed", label: "Interview Done", boardLane: true },
  { key: "hm_review", label: "HM Review", boardLane: true },
  { key: "offer", label: "Offer", boardLane: true },
  { key: "offer_recommended", label: "Offer Rec'd", boardLane: true },
  { key: "offer_extended", label: "Offer Extended", boardLane: true },
  { key: "offer_accepted", label: "Offer Accepted", boardLane: true },
  { key: "hired", label: "Hired", boardLane: false, terminal: "win" },
  { key: "started", label: "Started", boardLane: false, terminal: "win" },
  { key: "offer_declined", label: "Offer Declined", boardLane: false, terminal: "loss" },
  { key: "rejected", label: "Rejected", boardLane: false, terminal: "loss" },
  { key: "withdrawn", label: "Withdrawn", boardLane: false, terminal: "loss" },
];
/* Working lanes a terminal card can be restored into (drawer "Restore to board"). */
const RESTORE_STAGES = STAGE_COLS.filter((s) => s.boardLane && s.key !== "sourced");

/* ── Three-phase colour system ────────────────────────────────────────────
 * Every stage collapses into one of three phases so the board reads as a
 * funnel instead of a ~14-hue rainbow. Within a phase all column headers are
 * IDENTICAL — the count is the only variable element (0 = muted, >0 = a small
 * tinted pill at full strength). All colours come from existing design tokens.
 *   SOURCING   → neutral (muted text, default border, no tint)
 *   ENGAGEMENT → accent  (brand-accent text + subtle accent tint)
 *   DECISION   → success (signal-green text + subtle green tint)
 * Terminal-negative stages (rejected / offer_declined / withdrawn) are
 * deliberately NOT mapped here — they render neutral with no phase label and
 * leave the column system in a later step. */
type Phase = "sourcing" | "engagement" | "decision";
const STAGE_PHASE: Record<string, Phase> = {
  sourced: "sourcing",
  screening: "sourcing",
  verification: "sourcing",
  shortlisted: "engagement",
  interview: "engagement",
  interview_scheduled: "engagement",
  interview_completed: "engagement",
  hm_review: "decision",
  offer: "decision",
  offer_recommended: "decision",
  offer_extended: "decision",
  offer_accepted: "decision",
  hired: "decision",
  started: "decision",
};
const PHASE_ORDER: Phase[] = ["sourcing", "engagement", "decision"];
/* `strip*` fields are the reduced-intensity phase colours used when an empty
 * column collapses to a slim vertical strip (Step 2). */
type PhaseStyle = {
  label: string;
  text: string;
  header: string;
  pill: string;
  stripText: string;
  stripCount: string;
  stripBg: string;
  stripBorder: string;
};
const PHASE_STYLE: Record<Phase, PhaseStyle> = {
  sourcing: {
    label: "Sourcing",
    text: "text-muted-foreground",
    header: "text-muted-foreground border-border/60",
    pill: "bg-muted text-muted-foreground",
    stripText: "text-muted-foreground/70",
    stripCount: "text-muted-foreground/50",
    stripBg: "bg-muted/30",
    stripBorder: "border-border/40",
  },
  engagement: {
    label: "Engagement",
    text: "text-primary",
    header: "text-primary border-primary/20 bg-primary/5",
    pill: "bg-primary/15 text-primary",
    stripText: "text-primary/60",
    stripCount: "text-primary/50",
    stripBg: "bg-primary/[0.04]",
    stripBorder: "border-primary/15",
  },
  decision: {
    label: "Decision",
    text: "text-signal-green",
    header: "text-signal-green border-signal-green/20 bg-signal-green/5",
    pill: "bg-signal-green/15 text-signal-green",
    stripText: "text-signal-green/60",
    stripCount: "text-signal-green/50",
    stripBg: "bg-signal-green/[0.04]",
    stripBorder: "border-signal-green/15",
  },
};
/* Neutral fallback for terminal-negative / unmapped columns (pre-Step-3). */
const NEUTRAL_COL: Omit<PhaseStyle, "label"> = {
  text: "text-muted-foreground",
  header: "text-muted-foreground border-border/60",
  pill: "bg-muted text-muted-foreground",
  stripText: "text-muted-foreground/70",
  stripCount: "text-muted-foreground/50",
  stripBg: "bg-muted/30",
  stripBorder: "border-border/40",
};

const NBA_LABELS: Record<string, { label: string; color: string }> = {
  advance: {
    label: "Advance",
    color: "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  },
  schedule: {
    label: "Schedule",
    color: "text-blue-700 dark:text-blue-400 bg-blue-500/10 border-blue-500/20",
  },
  recruiter_review: {
    label: "Review",
    color:
      "text-amber-700 dark:text-yellow-400 bg-amber-500/10 dark:bg-yellow-500/10 border-amber-500/20 dark:border-yellow-500/20",
  },
  re_engage: {
    label: "Re-Engage",
    color: "text-orange-700 dark:text-orange-400 bg-orange-500/10 border-orange-500/20",
  },
  manual_verification: {
    label: "Verify",
    color: "text-violet-700 dark:text-violet-400 bg-violet-500/10 border-violet-500/20",
  },
  reject: {
    label: "Reject",
    color: "text-rose-700 dark:text-rose-400 bg-rose-500/10 border-rose-500/20",
  },
  hold: {
    label: "Hold",
    color: "text-slate-600 dark:text-slate-400 bg-slate-500/10 border-slate-500/20",
  },
};

function ScorePill({ score, label = "Match" }: { score: number | null; label?: string }) {
  if (score == null) return null;
  /* Banding comes from the canonical scoreBand() helper — never a local
   * threshold — so this pill agrees with every other match pill in the app. */
  const color = SCORE_BAND_PILL[scoreBand(score)];
  return (
    <span
      title={`${label} score`}
      className={cn(
        "text-[10px] font-bold px-2 py-0.5 rounded-full border whitespace-nowrap",
        color,
      )}
    >
      {label} {score}%
    </span>
  );
}

/* Compact relative-time formatter (no date-fns dependency) → "5h ago". */
function relativeTime(iso?: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/* The single primary stage action rendered in the card footer as a text link
 * ("Advance →"). Every other action lives in the ··· overflow menu. */
function PrimaryLink({
  label,
  icon: Icon,
  onClick,
  disabled,
  loading,
  title,
  tone = "primary",
}: {
  label: string;
  icon?: any;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  loading?: boolean;
  title?: string;
  tone?: "primary" | "success" | "danger";
}) {
  const color =
    tone === "danger"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "success"
        ? "text-signal-green"
        : "text-primary";
  return (
    <button
      type="button"
      title={title}
      disabled={disabled || loading}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 text-[13px] font-semibold whitespace-nowrap transition-opacity disabled:opacity-40 disabled:cursor-default",
        color,
        !(disabled || loading) && "hover:opacity-70",
      )}
    >
      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
      {label}
      {!loading && Icon && <Icon className="w-3.5 h-3.5" />}
    </button>
  );
}

/* ── Live "agent working" detection ──────────────────────────────────────
 * The Screening and Verification agents run fire-and-forget on the backend
 * (the stage-move request returns immediately, then an AI call runs in the
 * background). Nothing on the row says "an agent is mid-run", so we INFER it:
 *   1. the row sits in the screening / verification stage,
 *   2. that stage's result hasn't landed yet (null score / no verdict), and
 *   3. the row was updated recently — the stage move that kicked the agent off.
 * The time window is what makes this safe: a candidate that legitimately ends
 * up with no result (e.g. no résumé, sparse profile) stops showing the spinner
 * after the window instead of spinning forever. These are presentation-only
 * heuristics — they never change what the backend does. */
const AGENT_RUNNING_WINDOW_MS = 45_000;

function withinAgentWindow(row: any): boolean {
  const ts = row?.updatedAt;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) && Date.now() - t < AGENT_RUNNING_WINDOW_MS;
}
function isScreeningRunning(row: any): boolean {
  const score = row?.score ?? row?.candidate?.resumeScreenScore;
  return row?.stage === "screening" && score == null && withinAgentWindow(row);
}
function isVerificationRunning(row: any): boolean {
  const result = row?.verificationResult || row?.candidate?.verificationResult || null;
  const status = row?.verificationStatus || row?.candidate?.verificationStatus || null;
  /* "pending" = the agent ran but returned no clear verdict (a terminal state we
   * surface as a warning, not a spinner). Default/"unverified" + no result during
   * the window means the agent is still working. */
  return row?.stage === "verification" && !result && status !== "pending" && withinAgentWindow(row);
}
function isRowProcessing(row: any): boolean {
  return isScreeningRunning(row) || isVerificationRunning(row);
}

/* Small inline "something is working in the background" indicator (brand cyan). */
function ProcessingPill({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md border bg-primary/10 text-primary border-primary/25">
      <Loader2 className="w-3 h-3 shrink-0 animate-spin" />
      <span className="truncate">{label}</span>
    </div>
  );
}

/* ── Compact action button used in the candidate card footer ──────────
 * One small component instead of repeating identical Button props for
 * every stage-specific action. Uses a colour token to derive both the
 * text and hover-bg classes so the palette stays consistent. */
const ACTION_COLORS: Record<string, string> = {
  primary: "text-primary hover:bg-primary/10",
  amber: "text-amber-400 hover:bg-amber-500/10",
  violet: "text-violet-400 hover:bg-violet-500/10",
  sky: "text-sky-400 hover:bg-sky-500/10",
  emerald: "text-emerald-400 hover:bg-emerald-500/10",
  teal: "text-teal-400 hover:bg-teal-500/10",
  blue: "text-blue-400 hover:bg-blue-500/10",
  fuchsia: "text-fuchsia-400 hover:bg-fuchsia-500/10",
  rose: "text-rose-400 hover:bg-rose-500/10",
  slate: "text-slate-400 hover:bg-slate-500/10",
};
const ActionBtn = forwardRef<
  HTMLButtonElement,
  {
    color?: keyof typeof ACTION_COLORS | string;
    icon?: any;
    loading?: boolean;
    children: React.ReactNode;
    [k: string]: any;
  }
>(function ActionBtn({ color = "primary", icon: Icon, loading = false, children, ...rest }, ref) {
  const cls = ACTION_COLORS[color] ?? ACTION_COLORS.primary;
  return (
    <Button
      ref={ref}
      size="sm"
      variant="ghost"
      className={cn("h-6 text-[10px] gap-1 px-2 font-medium", cls)}
      {...rest}
    >
      {loading ? (
        <Loader2 className="w-2.5 h-2.5 animate-spin" />
      ) : Icon ? (
        <Icon className="w-2.5 h-2.5" />
      ) : null}
      {children}
    </Button>
  );
});

/* ── Candidate Card ───────────────────────────────────────────────────── */
function CandidateCard({
  row,
  jobId,
  onMove,
  draft,
  restoreToBoard,
}: {
  row: any;
  jobId: string;
  onMove: () => void;
  draft?: OutreachMessage;
  restoreToBoard?: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const c = row.candidate;
  const initials = `${c?.firstName?.charAt(0) ?? "?"}${c?.lastName?.charAt(0) ?? ""}`;
  /* Terminal semantics come from the canonical STAGE_COLS `terminal` flag — the
   * single source of truth. Terminal cards (hired/started/rejected/
   * offer_declined/withdrawn) never expose automation-triggering actions
   * (Advance / Reject); they only restore via the no-automation move. */
  const isTerminal = !!STAGE_COLS.find((s) => s.key === row.stage)?.terminal;
  /* Canonical candidate id for the "Send Packet" deep-link to the profile page. */
  const hmCandidateId: string | null = c?.id || row.normalizedCandidateId || null;
  const [detailOpen, setDetailOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [emailEditOpen, setEmailEditOpen] = useState(false);
  const [emailValue, setEmailValue] = useState("");

  /* Real verification verdict — gated on the actual Verification Agent output
   * (row.verificationResult). We only surface a status when the agent has truly
   * run and persisted a result, so the card never shows a fabricated verdict. */
  const verification = row.verificationResult || c?.verificationResult || null;
  const verificationStatus: string | null = row.verificationStatus || c?.verificationStatus || null;

  /* Whether a background agent is currently working this card (drives the
   * inline "working…" spinner so the recruiter sees progress is happening). */
  const screeningRunning = isScreeningRunning(row);
  const verificationRunning = isVerificationRunning(row);

  /* Copy the candidate-facing interview link to the clipboard so the recruiter
   * can paste it into their own email. Same URL shape the candidate receives in
   * the invite email + the /recruiter/interviews page uses. */
  const copyInterviewLink = async (sessionId: string | null | undefined) => {
    if (!sessionId) {
      toast({
        title: "No interview link yet",
        description: "Schedule the interview first — no session exists for this candidate.",
        variant: "destructive",
      });
      return;
    }
    const roomUrl = `${window.location.origin + BASE}/interviews/${sessionId}/room`;
    try {
      await navigator.clipboard.writeText(roomUrl);
      toast({
        title: "Interview link copied!",
        description: "Paste it into your email to the candidate.",
      });
    } catch {
      toast({ title: "Copy this interview link", description: roomUrl });
    }
  };

  /* Advance for application-based candidates */
  const advanceMutation = useMutation({
    mutationFn: async () => {
      if (!row.applicationId) {
        return apiFetch<any>("/applications", {
          method: "POST",
          body: JSON.stringify({ jobId, candidateId: c.id, stage: "applied" }),
        });
      }
      const NEXT: Record<string, string> = {
        applied: "screening",
        screening: "verification",
        verification: "shortlisted",
        shortlisted: "interview_scheduled",
        interview_scheduled: "interview_completed",
        interview_completed: "hm_review",
        hm_review: "offer_recommended",
        offer: "offer_recommended",
        offer_recommended: "offer_extended",
        offer_extended: "offer_accepted",
        offer_accepted: "hired",
        hired: "started",
      };
      return apiFetch(`/applications/${row.applicationId}`, {
        method: "PUT",
        body: JSON.stringify({ stage: NEXT[row.stage] || "screening" }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
      /* Advancing screening → Verify kicks off the Verification Agent on the
       * backend (fire-and-forget). Refetch a few seconds later so the verdict
       * + flags land on the card without a manual refresh. */
      if (row.stage === "screening") {
        toast({
          title: "Running verification…",
          description: "The Verification Agent is checking this candidate.",
        });
        setTimeout(() => qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] }), 6000);
      }
      /* verification → shortlisted ("Outreach Queued") fires the Outreach Agent
       * on the backend (fire-and-forget) to draft a first-touch email held for
       * approval. Point the recruiter at the Approvals queue — otherwise the
       * draft is created silently and is easy to miss. */
      if (row.stage === "verification") {
        toast({
          title: "Drafting outreach email…",
          description:
            "Lexy is writing the first-touch email. It'll wait on this job's Outreach tab for your review before sending.",
          action: (
            <ToastAction
              altText="Review draft"
              onClick={() => setLocation(`/jobs/${jobId}?tab=outreach`)}
            >
              Review draft
            </ToastAction>
          ),
        });
      }
    },
    onError: (err: any) => {
      /* Interview-deleted recovery: the backend blocks Offer when no completed
       * interview session exists. If the session was deleted or errored the
       * candidate would be permanently stuck before Offer. Offer the recruiter
       * an explicit one-click override that re-issues the move with
       * overrideInterviewGate (a deliberate, logged human action). */
      if (err?.code === "INTERVIEW_REQUIRED" && row.applicationId) {
        toast({
          title: "No completed interview on file",
          description:
            "This candidate has no completed interview. You can override and move them to Offer anyway.",
          variant: "destructive",
          action: (
            <ToastAction
              altText="Override and move to Offer"
              onClick={async () => {
                try {
                  await apiFetch(`/applications/${row.applicationId}`, {
                    method: "PUT",
                    body: JSON.stringify({ stage: "offer", overrideInterviewGate: true }),
                  });
                  qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
                  onMove();
                  toast({
                    title: "Moved to Offer",
                    description: "Interview requirement overridden.",
                  });
                } catch (e: any) {
                  toast({
                    title: "Override failed",
                    description: e?.message,
                    variant: "destructive",
                  });
                }
              }}
            >
              Override
            </ToastAction>
          ),
        });
        return;
      }
      toast({ title: "Failed to advance", description: err?.message, variant: "destructive" });
    },
  });

  /* Manual placement — move the candidate to ANY stage WITHOUT triggering that
   * stage's automation (no screening/verification/outreach agents, no interview
   * invite, no rejection email). For candidates who progressed through an
   * off-platform path (e.g. the client ran their own interviews) and just need
   * to be reflected at the right stage. Creates an application first for a
   * sourced-only row so there's a row to carry the stage. */
  const moveWithoutAutomationMutation = useMutation({
    mutationFn: async (targetStage: string) => {
      if (!row.applicationId) {
        return apiFetch(`/applications`, {
          method: "POST",
          body: JSON.stringify({
            jobId,
            candidateId: c.id,
            stage: targetStage,
            skipAutomation: true,
          }),
        });
      }
      return apiFetch(`/applications/${row.applicationId}`, {
        method: "PUT",
        body: JSON.stringify({ stage: targetStage, skipAutomation: true }),
      });
    },
    onSuccess: (_data, targetStage) => {
      const label = STAGE_COLS.find((s) => s.key === targetStage)?.label ?? targetStage;
      toast({
        title: `Moved to ${label}`,
        description: "No automated emails or agents were triggered.",
      });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({ title: "Move failed", description: err?.message, variant: "destructive" }),
  });

  /* Add / fix a missing contact email inline. The backend guardrail refuses to
   * move a candidate into Outreach Queued (and refuses to run outreach) without
   * a real address, so this is the recruiter's one-click remedy right on the
   * card. Uses PUT /candidates/:id (UpdateCandidateBody.email). */
  const addEmailMutation = useMutation({
    mutationFn: (email: string) =>
      apiFetch<any>(`/candidates/${c?.id}`, {
        method: "PUT",
        body: JSON.stringify({ email }),
      }),
    onSuccess: () => {
      toast({ title: "Email added", description: "This candidate can now be messaged." });
      setEmailEditOpen(false);
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({ title: "Couldn't save email", description: err?.message, variant: "destructive" }),
  });

  /* Send to Verify (Screening stage → Verify) */
  const verifyMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/jobs/${jobId}/pipeline/card-action`, {
        method: "POST",
        body: JSON.stringify({ action: "send_to_verify", sourcedId: row.sourcedId }),
      }),
    onSuccess: () => {
      toast({ title: "Candidate sent to Verify" });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: () => toast({ title: "Failed to send to verify", variant: "destructive" }),
  });

  /* Send Outreach (Verify stage → Outreach Sent) */
  const outreachMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/jobs/${jobId}/pipeline/card-action`, {
        method: "POST",
        body: JSON.stringify({ action: "send_outreach", sourcedId: row.sourcedId }),
      }),
    onSuccess: (data) => {
      const sent = data?.messagesSent ?? 0;
      if (data?.pendingApproval) {
        toast({
          title: "Draft ready for approval",
          description:
            "The initial outreach email was drafted. Review and approve it on this job's Outreach tab to send it.",
          action: (
            <ToastAction
              altText="Review draft"
              onClick={() => setLocation(`/jobs/${jobId}?tab=outreach`)}
            >
              Review draft
            </ToastAction>
          ),
        });
      } else {
        toast({
          title: sent > 0 ? "Outreach email sent" : "Outreach queued",
          description:
            sent > 0
              ? `Email delivered to ${c?.email || "candidate"}.`
              : "Candidate moved to Shortlisted.",
        });
      }
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      qc.invalidateQueries({ queryKey: ["ai-queue"] });
      onMove();
    },
    onError: (err: any) => {
      toast({
        title: "Email send failed",
        description:
          err?.message || "Could not deliver outreach email. Check API logs for details.",
        variant: "destructive",
      });
    },
  });

  /* Accept → Schedule Interview (Shortlisted / Outreach Queued stage) */
  const acceptMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/jobs/${jobId}/pipeline/card-action`, {
        method: "POST",
        body: JSON.stringify({ action: "accept_interview", sourcedId: row.sourcedId }),
      }),
    onSuccess: (data) => {
      const canCopy = Boolean(data?.sessionId);
      toast({
        title: "Interview scheduled!",
        description: data.emailOk
          ? "Candidate moved to Scheduled and emailed the interview link. Copy it to send your own email too."
          : "Candidate moved to Scheduled. Copy the interview link to email it to the candidate.",
        action: canCopy ? (
          <ToastAction
            altText="Copy interview link"
            onClick={() => copyInterviewLink(data.sessionId)}
          >
            Copy link
          </ToastAction>
        ) : undefined,
      });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({
        title: "Failed to send interview invite",
        description: err?.message,
        variant: "destructive",
      }),
  });

  /* Generate an interview link on demand — for candidates in the interview
   * stages that don't yet have a session (e.g. manually-placed / application
   * rows). Creates the session server-side, then copies the room URL so the
   * recruiter can paste it into their own email. */
  const generateLinkMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>("/interviews/generate-link", {
        method: "POST",
        body: JSON.stringify({
          jobId,
          candidateId: c?.id || undefined,
          applicationId: row.applicationId || undefined,
        }),
      }),
    onSuccess: async (data) => {
      await copyInterviewLink(data?.sessionId);
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
    },
    onError: (err: any) =>
      toast({
        title: "Couldn't create interview link",
        description: err?.message || "Please try again.",
        variant: "destructive",
      }),
  });

  /* Copy the interview link for any interview-stage card: use the existing
   * session if present, otherwise generate one on demand. */
  const copyOrGenerateLink = () => {
    if (c?.interviewSessionId) {
      copyInterviewLink(c.interviewSessionId);
      return;
    }
    if (!c?.id && !row.applicationId) {
      toast({
        title: "No interview link yet",
        description: "This candidate can't be linked to an interview yet.",
        variant: "destructive",
      });
      return;
    }
    /* Debounce: a rapid double-click can re-enter before the button's
       `loading` disable takes effect on the next render, firing two mints. The
       backend advisory lock dedups it anyway, but don't even send the second. */
    if (generateLinkMutation.isPending) return;
    generateLinkMutation.mutate();
  };

  /* Send to Hiring Manager Review (Interview Done stage → HM Review).
   * Works for both candidate-tracking shapes: sourced rows post `sourcedId`,
   * application rows post `applicationId`. The server endpoint handles both. */
  const sendToHmMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/jobs/${jobId}/pipeline/card-action`, {
        method: "POST",
        body: JSON.stringify({
          action: "send_to_hm",
          sourcedId: row.sourcedId || undefined,
          applicationId: row.applicationId || undefined,
        }),
      }),
    onSuccess: () => {
      toast({ title: "Sent to Hiring Manager", description: "Candidate moved to HM Review." });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({
        title: "Failed to send to hiring manager",
        description: err?.message,
        variant: "destructive",
      }),
  });

  /* ── Offer-stage action mutations ──────────────────────────────────── */
  const extendOfferMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/outcomes/${row.applicationId}/extend-offer`, {
        method: "PUT",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast({ title: "Offer extended", description: "Candidate moved to Offer Extended." });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({ title: "Failed to extend offer", description: err?.message, variant: "destructive" }),
  });

  const acceptOfferMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/outcomes/${row.applicationId}/accept-offer`, {
        method: "PUT",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast({ title: "Offer accepted", description: "Candidate moved to Offer Accepted." });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({
        title: "Failed to mark accepted",
        description: err?.message,
        variant: "destructive",
      }),
  });

  const declineOfferMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/outcomes/${row.applicationId}/decline-offer`, {
        method: "PUT",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast({ title: "Offer declined", description: "Candidate moved to Offer Declined." });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({
        title: "Failed to mark declined",
        description: err?.message,
        variant: "destructive",
      }),
  });

  const hireMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/outcomes/${row.applicationId}/hire`, {
        method: "PUT",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast({ title: "Candidate hired! 🎉", description: "Moved to Hired." });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({ title: "Failed to mark hired", description: err?.message, variant: "destructive" }),
  });

  const startMutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/outcomes/${row.applicationId}/start`, {
        method: "PUT",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast({ title: "Candidate started! 🚀", description: "Moved to Started." });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      onMove();
    },
    onError: (err: any) =>
      toast({ title: "Failed to mark started", description: err?.message, variant: "destructive" }),
  });

  const [replyOpen, setReplyOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const isPending =
    advanceMutation.isPending ||
    verifyMutation.isPending ||
    outreachMutation.isPending ||
    acceptMutation.isPending ||
    sendToHmMutation.isPending ||
    extendOfferMutation.isPending ||
    acceptOfferMutation.isPending ||
    declineOfferMutation.isPending ||
    hireMutation.isPending ||
    startMutation.isPending;

  return (
    <>
      <CandidateDetailDialog
        row={row}
        jobId={jobId}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
      <QuickReplyDialog
        row={row}
        jobId={jobId}
        open={replyOpen}
        onClose={() => setReplyOpen(false)}
      />
      <RejectCandidateDialog
        row={row}
        jobId={jobId}
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
      />
      {draft && (
        <Dialog open={draftOpen} onOpenChange={setDraftOpen}>
          <DialogContent className="max-w-lg" onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <DialogTitle>Outreach draft — approve to send</DialogTitle>
            </DialogHeader>
            <OutreachDraftCard msg={draft} onDone={() => setDraftOpen(false)} />
          </DialogContent>
        </Dialog>
      )}
      <div
        className="group relative bg-card border border-border/60 rounded-xl hover:border-primary/40 hover:shadow-md hover:shadow-black/[0.04] dark:hover:shadow-black/20 transition-all duration-200 cursor-pointer"
        onClick={() => setDetailOpen(true)}
      >
        <div className="p-4 space-y-3">
          {/* ── Header: avatar + name + score + meta ─────────────────────── */}
          <div className="flex items-start gap-2.5">
            <div
              className={cn(
                "w-10 h-10 rounded-full flex items-center justify-center font-semibold text-xs shrink-0",
                c?.source === "manual" || c?.source === "manual_import"
                  ? "bg-violet-500/10 text-violet-600 dark:text-violet-300"
                  : "bg-primary/10 text-primary",
              )}
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              {(() => {
                const name =
                  c?.firstName || c?.lastName
                    ? `${c?.firstName ?? ""} ${c?.lastName ?? ""}`.trim()
                    : c?.email || "Unknown candidate";
                return (
                  <p
                    title={name}
                    className="text-sm font-semibold truncate leading-tight text-foreground"
                  >
                    {name}
                  </p>
                );
              })()}
              {(() => {
                const sub = [c?.currentTitle, c?.location || c?.currentCompany]
                  .filter(Boolean)
                  .join(" · ");
                return sub ? (
                  <p title={sub} className="text-xs text-muted-foreground truncate mt-0.5">
                    {sub}
                  </p>
                ) : null;
              })()}
              {/* Honest location-tier label: only when PDL surfaced this candidate
                from a RELAXED tier (region/country/global). Exact-city & remote
                make no distance claim, so no chip. Grounded — renders only when
                the candidate actually carries the tier from the sourcing run. */}
              {(() => {
                const tier = (c as any)?.locationTier ?? (c as any)?.rawData?.locationTier;
                const label =
                  (c as any)?.locationTierLabel ?? (c as any)?.rawData?.locationTierLabel;
                if (!tier || tier === "city" || tier === "remote" || !label) return null;
                return (
                  <div
                    className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1 min-w-0"
                    title={String(label)}
                  >
                    <MapPin className="w-2.5 h-2.5 shrink-0 opacity-70" />
                    <span className="truncate min-w-0">{String(label)}</span>
                  </div>
                );
              })()}
            </div>

            {/* ── Overflow menu (···) — every secondary action lives here so the
               card face stays airy: interview report, copy link, log reply,
               schedule, send packet, decline offer, external profiles,
               move-to-stage (no automation), and reject. ─────────────────── */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="More actions"
                  className="w-7 h-7 -mr-1.5 -mt-1 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-56"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Restore to board — only in the Closed drawer. Moves a terminal
                  card back into a working lane WITHOUT firing agents or emails
                  (skipAutomation). Leaving a terminal stage never triggers
                  outcome capture, so analytics stay intact. */}
                {restoreToBoard && (
                  <>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger className="text-xs">
                        <RotateCcw className="w-3.5 h-3.5 mr-2" /> Restore to board
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {RESTORE_STAGES.map((st) => {
                          const ph = STAGE_PHASE[st.key];
                          const dot =
                            ph === "engagement"
                              ? "bg-primary"
                              : ph === "decision"
                                ? "bg-signal-green"
                                : "bg-muted-foreground/50";
                          return (
                            <DropdownMenuItem
                              key={st.key}
                              className="text-xs"
                              disabled={moveWithoutAutomationMutation.isPending}
                              onSelect={() => moveWithoutAutomationMutation.mutate(st.key)}
                            >
                              <span className={cn("w-1.5 h-1.5 rounded-full mr-2 shrink-0", dot)} />
                              {st.label}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator />
                  </>
                )}
                {row.candidate?.interviewSessionId && (
                  <DropdownMenuItem
                    className="text-xs"
                    onSelect={() => setLocation(`/interviews/${row.candidate!.interviewSessionId}`)}
                  >
                    <FileText className="w-3.5 h-3.5 mr-2" /> Interview report
                  </DropdownMenuItem>
                )}
                {(row.stage === "interview" || row.stage === "interview_scheduled") &&
                  row.candidate?.interviewSessionId && (
                    <DropdownMenuItem className="text-xs" onSelect={() => copyOrGenerateLink()}>
                      <Copy className="w-3.5 h-3.5 mr-2" /> Copy interview link
                    </DropdownMenuItem>
                  )}
                {row.stage === "shortlisted" && row.sourcedId && (
                  <DropdownMenuItem className="text-xs" onSelect={() => setReplyOpen(true)}>
                    <MessageSquare className="w-3.5 h-3.5 mr-2" /> Log candidate reply
                  </DropdownMenuItem>
                )}
                {/* When a draft occupies the primary slot, keep "Move to interview"
                  (acceptMutation) reachable here so no shortlisted action is lost. */}
                {row.stage === "shortlisted" && row.sourcedId && draft && (
                  <DropdownMenuItem
                    className="text-xs"
                    disabled={isPending}
                    onSelect={() => acceptMutation.mutate()}
                  >
                    <Video className="w-3.5 h-3.5 mr-2" /> Move to interview
                  </DropdownMenuItem>
                )}
                {(row.stage === "interview_completed" || row.stage === "hm_review") && (
                  <DropdownMenuItem className="text-xs" asChild>
                    <a href="/coordinator">
                      <Calendar className="w-3.5 h-3.5 mr-2" /> Schedule interview
                    </a>
                  </DropdownMenuItem>
                )}
                {(row.stage === "interview_completed" || row.stage === "hm_review") &&
                  hmCandidateId && (
                    <DropdownMenuItem
                      className="text-xs"
                      onSelect={() => setLocation(`/candidates/${hmCandidateId}?hmShare=1`)}
                    >
                      <Send className="w-3.5 h-3.5 mr-2" /> Send packet to HM
                    </DropdownMenuItem>
                  )}
                {row.stage === "offer_extended" && row.applicationId && (
                  <DropdownMenuItem
                    className="text-xs"
                    onSelect={() => declineOfferMutation.mutate()}
                  >
                    <ThumbsDown className="w-3.5 h-3.5 mr-2" /> Mark offer declined
                  </DropdownMenuItem>
                )}
                {(c?.githubProfile || c?.linkedinUrl) && <DropdownMenuSeparator />}
                {c?.githubProfile && (
                  <DropdownMenuItem className="text-xs" asChild>
                    <a href={c.githubProfile} target="_blank" rel="noopener noreferrer">
                      <Github className="w-3.5 h-3.5 mr-2" /> GitHub profile
                    </a>
                  </DropdownMenuItem>
                )}
                {c?.linkedinUrl && (
                  <DropdownMenuItem className="text-xs" asChild>
                    <a
                      href={
                        c.linkedinUrl.startsWith("http")
                          ? c.linkedinUrl
                          : `https://${c.linkedinUrl}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Linkedin className="w-3.5 h-3.5 mr-2" /> LinkedIn profile
                    </a>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs">
                  Move to stage
                  <span className="block font-normal text-muted-foreground">
                    No emails or agents triggered
                  </span>
                </DropdownMenuLabel>
                {STAGE_COLS.filter((st) => st.key !== row.stage && st.key !== "sourced").map(
                  (st) => {
                    const ph = STAGE_PHASE[st.key];
                    const dot =
                      ph === "engagement"
                        ? "bg-primary"
                        : ph === "decision"
                          ? "bg-signal-green"
                          : "bg-muted-foreground/50";
                    return (
                      <DropdownMenuItem
                        key={st.key}
                        className="text-xs"
                        onSelect={() => moveWithoutAutomationMutation.mutate(st.key)}
                      >
                        <span className={cn("w-1.5 h-1.5 rounded-full mr-2 shrink-0", dot)} />
                        {st.label}
                      </DropdownMenuItem>
                    );
                  },
                )}
                {!isTerminal && row.stage !== "offer_accepted" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-xs text-rose-600 focus:text-rose-600 dark:text-rose-400 dark:focus:text-rose-400"
                      onSelect={() => setRejectOpen(true)}
                    >
                      <XCircle className="w-3.5 h-3.5 mr-2" /> Reject candidate
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* ── Badges row: match score + exactly ONE provenance badge ────────
             Provenance = HOW the candidate entered (candidates.source, immutable
             to enrichment): agent_simulated → DEMO RUN, manual/manual_import →
             MANUAL, any AI sourcing channel → AI SOURCED. Formal-application
             origins (applied/portal/referral/self) intentionally carry no badge
             for now. Match score reflects the accrued/point-in-time fit. */}
          {(() => {
            const scoreVal = row.score ?? c?.resumeScreenScore;
            const src = (c?.source ?? "").toLowerCase();
            const isApplied = ["applied", "portal", "referral", "self", "self_apply"].includes(src);
            const hasProvenance = !!src && !isApplied;
            if (scoreVal == null && !hasProvenance) return null;
            return (
              <div className="flex items-center gap-1.5 flex-wrap">
                <ScorePill score={scoreVal} />
                {src === "agent_simulated" && <DemoRunBadge size="xs" />}
                {(src === "manual" || src === "manual_import") && (
                  <span className="text-[9px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/20 font-bold tracking-wider uppercase">
                    Manual
                  </span>
                )}
                {hasProvenance &&
                  src !== "agent_simulated" &&
                  src !== "manual" &&
                  src !== "manual_import" && (
                    <span
                      title={
                        SOURCE_CHANNEL_LABELS[src]
                          ? `Found via ${SOURCE_CHANNEL_LABELS[src]} by the AI sourcing agent`
                          : "Surfaced by the AI sourcing agent"
                      }
                      className="inline-flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-bold tracking-wider uppercase"
                    >
                      <Sparkles className="w-2.5 h-2.5" />
                      {SOURCE_CHANNEL_LABELS[src] ?? "AI Sourced"}
                    </span>
                  )}
              </div>
            );
          })()}

          {/* ── Screening in progress — the Screening Agent is running its AI
             evaluation in the background; surface a spinner so the recruiter
             knows work is happening (the score lands on the next refresh). */}
          {screeningRunning && <ProcessingPill label="Screening résumé…" />}

          {/* ── Verification verdict — only after the Verification Agent has
             actually run (real persisted result, never fabricated) ───────── */}
          {verification &&
            (() => {
              const verdict =
                verification.verdict ||
                (verificationStatus === "verified"
                  ? "clear"
                  : verificationStatus === "flagged"
                    ? "flag"
                    : "review");
              const cfg =
                verdict === "clear"
                  ? {
                      label: "Verified",
                      cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/25",
                      Icon: ShieldCheck,
                    }
                  : verdict === "flag"
                    ? {
                        label: "Flagged",
                        cls: "bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25",
                        Icon: ShieldAlert,
                      }
                    : {
                        label: "Needs review",
                        cls: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25",
                        Icon: ShieldQuestion,
                      };
              const score =
                typeof verification.overallScore === "number" ? verification.overallScore : null;
              const flagCount = Array.isArray(verification.riskFlags)
                ? verification.riskFlags.length
                : 0;
              return (
                <div
                  className={cn(
                    "flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md border",
                    cfg.cls,
                  )}
                >
                  <cfg.Icon className="w-3 h-3 shrink-0" />
                  <span className="truncate">{cfg.label}</span>
                  {score != null && <span className="opacity-70 font-medium">· {score}/100</span>}
                  {flagCount > 0 && (
                    <span className="opacity-70 font-medium">· {pluralize(flagCount, "flag")}</span>
                  )}
                </div>
              );
            })()}

          {/* ── Verification in progress — the Verification Agent is running its
             AI identity check in the background; show a spinner instead of the
             "pending" warning until the verdict lands. */}
          {!verification && verificationRunning && <ProcessingPill label="Verifying identity…" />}

          {/* ── Verification pending — candidate sits in the verification stage
             but the agent returned no clear verdict (sparse profile), which
             silently blocks outreach. Surface it so the recruiter knows to act.
             Suppressed while the agent is still actively running (above). */}
          {!verification &&
            !verificationRunning &&
            (verificationStatus === "pending" || row.stage === "verification") && (
              <div className="flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md border bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/25">
                <ShieldQuestion className="w-3 h-3 shrink-0" />
                <span className="truncate">
                  Verification pending — won't auto-advance to outreach
                </span>
              </div>
            )}

          {/* ── Missing email — candidate has only a placeholder address, so no
             outreach/interview email can be delivered. Offer an inline "Add
             email" editor (the backend guardrail blocks Outreach Queued until a
             real address exists) so the recruiter can fix it right on the card. */}
          {row.missingEmail &&
            (emailEditOpen && c?.id ? (
              <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1.5">
                <Input
                  type="email"
                  autoFocus
                  value={emailValue}
                  onChange={(e) => setEmailValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const v = emailValue.trim();
                      if (v) addEmailMutation.mutate(v);
                    }
                    if (e.key === "Escape") setEmailEditOpen(false);
                  }}
                  placeholder="name@company.com"
                  className="h-7 text-[11px] px-2"
                />
                <ActionBtn
                  color="emerald"
                  icon={Check}
                  loading={addEmailMutation.isPending}
                  disabled={addEmailMutation.isPending || !emailValue.trim()}
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    const v = emailValue.trim();
                    if (v) addEmailMutation.mutate(v);
                  }}
                >
                  Save
                </ActionBtn>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEmailEditOpen(false);
                  }}
                  className="text-[10px] text-muted-foreground hover:text-foreground px-1"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!c?.id) return;
                  setEmailValue("");
                  setEmailEditOpen(true);
                }}
                disabled={!c?.id}
                className="w-full flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md border bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/25 hover:bg-rose-500/20 transition-colors disabled:cursor-default disabled:hover:bg-rose-500/10"
                title={
                  c?.id
                    ? "Add a contact email so this candidate can be messaged"
                    : "No contact email on file — can't be messaged until one is added"
                }
              >
                <AlertTriangle className="w-3 h-3 shrink-0" />
                <span className="shrink-0 whitespace-nowrap">No email</span>
                {c?.id && (
                  <span className="ml-auto shrink-0 whitespace-nowrap underline underline-offset-2 decoration-rose-500/40">
                    Add email
                  </span>
                )}
              </button>
            ))}

          {/* ── Outreach draft awaiting approval ─────────────────────────── */}
          {row.stage === "shortlisted" && draft && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setDraftOpen(true);
              }}
              className="w-full flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/25 hover:bg-violet-500/20 transition-colors"
            >
              <Mail className="w-3 h-3 shrink-0" />
              <span className="truncate">Outreach draft ready — review &amp; approve</span>
            </button>
          )}

          {/* ── Skills + AI recommendation: combined inline row ─────────── */}
          {(c?.skills?.length > 0 || (row.nba && NBA_LABELS[row.nba])) && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {row.nba && NBA_LABELS[row.nba] && (
                <span
                  className={cn(
                    "text-[9px] px-2 py-0.5 rounded-full border font-semibold tracking-wide flex items-center gap-1",
                    NBA_LABELS[row.nba].color,
                  )}
                >
                  <span className="w-1 h-1 rounded-full bg-current" />
                  {NBA_LABELS[row.nba].label}
                </span>
              )}
              {(c?.skills || []).slice(0, 3).map((s: string) => (
                <span
                  key={s}
                  className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground max-w-[140px] truncate"
                  title={s}
                >
                  {s}
                </span>
              ))}
              {(c?.skills?.length || 0) > 3 && (
                <span className="text-[11px] text-muted-foreground/70 font-medium px-1">
                  +{c.skills.length - 3}
                </span>
              )}
            </div>
          )}

          {/* ── Recruiter notes / AI quote — single line, italic, subdued ─ */}
          {row.notes && (
            <p className="text-[11px] text-muted-foreground/80 leading-snug line-clamp-2 italic border-l-2 border-border/40 pl-2">
              {row.notes}
            </p>
          )}

          {/* ── Footer: entry provenance + relative time · single primary action.
             Every secondary action lives in the ··· overflow menu above. ──── */}
          <div
            className="flex items-center justify-between gap-2 pt-3 border-t border-border/40"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-xs text-muted-foreground truncate">
              {(() => {
                const ago = relativeTime(row.createdAt);
                const verb = row.sourcedId
                  ? "Sourced"
                  : ["applied", "portal", "referral", "self", "self_apply"].includes(
                        (c?.source ?? "").toLowerCase(),
                      )
                    ? "Applied"
                    : "Added";
                return ago ? `${verb} ${ago}` : verb;
              })()}
            </span>

            {/* Single primary stage action, rendered as a text link ("Advance →"). */}
            <div className="flex items-center gap-1 shrink-0">
              {(() => {
                const s = row.stage;
                /* Gated card: a missing contact email blocks the verification →
                 outreach step. Rather than a dead disabled link, the footer
                 action opens the inline Add-email flow directly. */
                if (row.missingEmail && c?.id && s === "verification")
                  return (
                    <PrimaryLink
                      label="Add email"
                      icon={Mail}
                      onClick={() => {
                        setEmailValue("");
                        setEmailEditOpen(true);
                      }}
                    />
                  );
                if (s === "screening" && row.sourcedId)
                  return (
                    <PrimaryLink
                      label="Verify"
                      icon={ArrowRight}
                      loading={verifyMutation.isPending}
                      disabled={isPending}
                      onClick={() => verifyMutation.mutate()}
                    />
                  );
                if (s === "verification" && row.sourcedId)
                  return (
                    <PrimaryLink
                      label="Outreach"
                      icon={ArrowRight}
                      loading={outreachMutation.isPending}
                      disabled={isPending || row.missingEmail}
                      title={
                        row.missingEmail ? "Add a contact email before running outreach" : undefined
                      }
                      onClick={() => outreachMutation.mutate()}
                    />
                  );
                if (s === "shortlisted" && draft)
                  return (
                    <PrimaryLink
                      label="Review draft"
                      icon={Mail}
                      onClick={() => setDraftOpen(true)}
                    />
                  );
                if (s === "shortlisted" && row.sourcedId)
                  return (
                    <PrimaryLink
                      label="Interview"
                      icon={Video}
                      loading={acceptMutation.isPending}
                      disabled={isPending}
                      onClick={() => acceptMutation.mutate()}
                    />
                  );
                if (
                  (s === "interview" || s === "interview_scheduled") &&
                  (row.sourcedId || row.applicationId || c?.id)
                )
                  return row.candidate?.interviewSessionId ? (
                    <PrimaryLink
                      label="Open interview"
                      icon={ExternalLink}
                      onClick={() =>
                        setLocation(`/interviews/${row.candidate?.interviewSessionId}/room`)
                      }
                    />
                  ) : (
                    <PrimaryLink
                      label="Copy link"
                      icon={Copy}
                      loading={generateLinkMutation.isPending}
                      onClick={() => copyOrGenerateLink()}
                    />
                  );
                if (s === "interview_completed")
                  /* Move the card to HM Review AND open the share dialog on the
                   candidate page so the recruiter is asked for the hiring
                   manager's email — a bare stage move silently sent nothing to
                   anybody (there may be no HM assigned to the work order). */
                  return (
                    <PrimaryLink
                      label="Send to HM"
                      icon={ArrowRight}
                      loading={sendToHmMutation.isPending}
                      disabled={isPending}
                      onClick={() => {
                        sendToHmMutation.mutate();
                        if (hmCandidateId) setLocation(`/candidates/${hmCandidateId}?hmShare=1`);
                      }}
                    />
                  );
                if (
                  (s === "hm_review" || s === "offer" || s === "offer_recommended") &&
                  row.applicationId
                )
                  return (
                    <PrimaryLink
                      label="Extend offer"
                      icon={DollarSign}
                      loading={extendOfferMutation.isPending}
                      disabled={isPending}
                      onClick={() => extendOfferMutation.mutate()}
                    />
                  );
                if (s === "offer_extended" && row.applicationId)
                  return (
                    <PrimaryLink
                      label="Mark accepted"
                      icon={ThumbsUp}
                      tone="success"
                      loading={acceptOfferMutation.isPending}
                      disabled={isPending}
                      onClick={() => acceptOfferMutation.mutate()}
                    />
                  );
                if (s === "offer_accepted" && row.applicationId)
                  return (
                    <PrimaryLink
                      label="Mark hired"
                      icon={UserCheck}
                      tone="success"
                      loading={hireMutation.isPending}
                      disabled={isPending}
                      onClick={() => hireMutation.mutate()}
                    />
                  );
                if (s === "hired" && row.applicationId)
                  return (
                    <PrimaryLink
                      label="Mark started"
                      icon={Play}
                      tone="success"
                      loading={startMutation.isPending}
                      disabled={isPending}
                      onClick={() => startMutation.mutate()}
                    />
                  );
                if (
                  !row.sourcedId &&
                  !isTerminal &&
                  !["offer_extended", "offer_accepted"].includes(s)
                )
                  return (
                    <PrimaryLink
                      label={s === "sourced" ? "Add" : "Advance"}
                      icon={ArrowRight}
                      loading={isPending}
                      disabled={isPending || (row.missingEmail && s === "verification")}
                      title={
                        row.missingEmail && s === "verification"
                          ? "Add a contact email before moving to Shortlisted"
                          : undefined
                      }
                      onClick={() => advanceMutation.mutate()}
                    />
                  );
                /* Drawer terminal cards with no forward action still expose a
                 first-class Restore control (moves back to a working lane). */
                if (restoreToBoard)
                  return (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          disabled={moveWithoutAutomationMutation.isPending}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline disabled:opacity-50"
                        >
                          <RotateCcw className="w-3.5 h-3.5" /> Restore
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenuLabel className="text-xs">
                          Restore to board
                          <span className="block font-normal text-muted-foreground">
                            No emails or agents triggered
                          </span>
                        </DropdownMenuLabel>
                        {RESTORE_STAGES.map((st) => {
                          const ph = STAGE_PHASE[st.key];
                          const dot =
                            ph === "engagement"
                              ? "bg-primary"
                              : ph === "decision"
                                ? "bg-signal-green"
                                : "bg-muted-foreground/50";
                          return (
                            <DropdownMenuItem
                              key={st.key}
                              className="text-xs"
                              onSelect={() => moveWithoutAutomationMutation.mutate(st.key)}
                            >
                              <span className={cn("w-1.5 h-1.5 rounded-full mr-2 shrink-0", dot)} />
                              {st.label}
                            </DropdownMenuItem>
                          );
                        })}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  );
                return null;
              })()}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* ── Reject Candidate Dialog — capture reason + notes, persist audit row,
 * fire the polite candidate-facing email (handled server-side). ─────── */
const REJECTION_REASONS = [
  "Not enough relevant experience",
  "Skills mismatch for this role",
  "Salary expectations out of range",
  "Location / relocation not feasible",
  "Stronger candidates progressed",
  "Did not pass interview",
  "Cultural fit concerns",
  "Visa / work authorization",
  "Candidate withdrew / unresponsive",
  "Other (see notes)",
];

function RejectCandidateDialog({
  row,
  jobId,
  open,
  onClose,
}: {
  row: any;
  jobId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const c = row.candidate || {};
  const candidateName =
    `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email || "this candidate";
  const [reason, setReason] = useState<string>(REJECTION_REASONS[0]);
  const [notes, setNotes] = useState("");

  /* A sourced candidate still in sourced/screening/verification hasn't been
   * contacted yet — outreach is only sent on the verification→shortlisted
   * ("Outreach Queued") transition. In that case rejecting them sends NO email,
   * so the dialog must not mention notifying the candidate. (Mirrors the
   * server-side rule that suppresses the email when no outreach was sent.) */
  const preOutreach =
    !!row.sourcedId && ["sourced", "screening", "verification"].includes(row.stage);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<any>(`/jobs/${jobId}/pipeline/card-action`, {
        method: "POST",
        body: JSON.stringify({
          action: "reject_candidate",
          sourcedId: row.sourcedId ?? undefined,
          applicationId: row.sourcedId ? undefined : (row.applicationId ?? undefined),
          reason,
          notes: notes.trim() || null,
        }),
      }),
    onSuccess: (data: any) => {
      const skipped = preOutreach || data?.emailSkipped === true;
      toast({
        title: "Candidate rejected",
        description: skipped
          ? "The rejection has been recorded."
          : data?.emailOk === false
            ? "Recorded — but the candidate notification email could not be sent."
            : "We've recorded the rejection and sent the candidate a polite notification email.",
      });
      qc.invalidateQueries({ queryKey: ["pipeline", jobId] });
      setNotes("");
      onClose();
    },
    onError: (err: any) =>
      toast({
        title: "Failed to reject candidate",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-rose-400">
            <XCircle className="w-4 h-4" /> Reject {candidateName}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="text-xs text-muted-foreground">
            {preOutreach ? (
              <>
                This candidate hasn't been contacted yet, so no email will be sent. The reason and
                notes you provide here are saved internally for your records.
              </>
            ) : (
              <>
                The candidate will receive a sophisticated, professional email letting them know
                they were not selected — without using blunt language. The reason and notes you
                provide here are saved internally for your records and are{" "}
                <span className="font-semibold">not</span> shared with the candidate.
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Reason for rejection</Label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
            >
              {REJECTION_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Internal notes (optional)</Label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Any additional context for your team — e.g. 'Strong technically but missed the WordPress plugin deep-dive in the final interview.'"
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
            ) : (
              <XCircle className="w-3.5 h-3.5 mr-1.5" />
            )}
            {preOutreach ? "Reject Candidate" : "Reject & Notify Candidate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Quick Reply Dialog — paste a candidate's email reply, AI classifies it ── */
function QuickReplyDialog({
  row,
  jobId,
  open,
  onClose,
}: {
  row: any;
  jobId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const c = row.candidate || {};
  const [text, setText] = useState("");

  const logMutation = useMutation({
    mutationFn: (sentiment: "positive" | "negative" | "do_not_contact") =>
      apiFetch<any>(`/jobs/${jobId}/pipeline/card-action`, {
        method: "POST",
        body: JSON.stringify({
          action: "log_reply",
          sourcedId: row.sourcedId,
          sentiment,
          replyBody: text.trim(),
        }),
      }),
    onSuccess: (data: any) => {
      toast({
        title:
          data.sentiment === "positive"
            ? "Reply logged — moved to Scheduled"
            : data.sentiment === "negative"
              ? "Reply logged — candidate declined"
              : "Marked as Do Not Contact",
        description: data.interviewInvite?.emailOk
          ? "Interview invite email sent to the candidate."
          : undefined,
      });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      qc.invalidateQueries({ queryKey: ["recruiter-inbox"] });
      // DNC may have been set — refresh candidate counts, DNC list, and AI prediction cards
      qc.invalidateQueries({ queryKey: ["/api/candidates"] });
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      qc.invalidateQueries({ queryKey: ["intelligence", "job", jobId] });
      setText("");
      onClose();
    },
    onError: (err: any) =>
      toast({ title: "Failed to log reply", description: err?.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-sky-400" />
            Log reply from {c.firstName} {c.lastName}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Paste what the candidate emailed back. We'll classify it and advance the stage
            automatically.
          </p>
        </DialogHeader>

        <div className="space-y-3">
          <textarea
            className="w-full min-h-[120px] text-sm p-3 rounded border border-border bg-background"
            placeholder='e.g. "Yes, I am interested. When can we talk?"'
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <p className="text-[11px] text-muted-foreground">
            Tip — for production, candidates' email replies can flow in automatically via the
            inbound webhook at <span className="font-mono">/api/webhooks/inbound-email</span>.
          </p>
        </div>

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button
            variant="outline"
            className="text-slate-400 border-slate-500/30 hover:bg-slate-500/10"
            disabled={logMutation.isPending}
            onClick={() => logMutation.mutate("do_not_contact")}
          >
            Do Not Contact
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="text-rose-400 border-rose-500/30 hover:bg-rose-500/10 gap-1"
              disabled={logMutation.isPending || !text.trim()}
              onClick={() => logMutation.mutate("negative")}
            >
              <XCircle className="w-3.5 h-3.5" /> Not interested
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1"
              disabled={logMutation.isPending || !text.trim()}
              onClick={() => logMutation.mutate("positive")}
            >
              {logMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <ThumbsUp className="w-3.5 h-3.5" />
              )}
              Interested → Schedule Interview
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Candidate Detail Dialog (screening + verification breakdown) ────── */
/* ── Rejection details panel ─────────────────────────────────────────────
 * Shown at the top of the candidate detail dialog when stage='rejected'.
 * Pulls the most-recent persisted rejection record (joined with users for
 * the actor's display name) so the recruiter can see WHO rejected, the
 * reason chip, optional notes, originating stage, and the candidate-email
 * delivery status. */
function RejectionDetailsSection({
  candidateId,
  sourcedId,
  applicationId,
  jobId,
  enabled,
}: {
  candidateId?: string | null;
  sourcedId?: string | null;
  applicationId?: string | null;
  jobId?: string | null;
  enabled: boolean;
}) {
  /* The endpoint REQUIRES at least one of the three candidate-shaped IDs.
   * Passing only jobId would trigger a 400 which the UI would mislabel as
   * "no record". Gate the query on having a real identifier instead. */
  const hasIdentifier = Boolean(candidateId || sourcedId || applicationId);
  const params = new URLSearchParams();
  if (candidateId) params.set("candidateId", candidateId);
  if (sourcedId) params.set("sourcedId", sourcedId);
  if (applicationId) params.set("applicationId", applicationId);
  if (jobId) params.set("jobId", jobId);
  const qs = params.toString();

  const { data, isLoading, isError } = useQuery<{ rejection: any | null }>({
    queryKey: ["candidate-rejection", qs],
    queryFn: () => apiFetch(`/candidates/rejection?${qs}`),
    enabled: enabled && hasIdentifier,
  });
  const r = data?.rejection;

  /* Wrapper styling — rose-tinted card that visually separates this from
   * the rest of the (more positive-coloured) screening data below. */
  const wrap = "rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 space-y-2";

  if (isLoading) {
    return (
      <div className={wrap}>
        <div className="flex items-center gap-2 text-xs text-rose-300">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading rejection details…
        </div>
      </div>
    );
  }

  if (!r) {
    /* Distinguish transport/server errors from a genuinely-missing audit row
     * so the user isn't told "no record" when really we couldn't reach the
     * server. Older rejections that pre-date the audit table also land here. */
    return (
      <div className={wrap}>
        <div className="flex items-center gap-2">
          <XCircle className="w-3.5 h-3.5 text-rose-400" />
          <span className="text-xs font-semibold text-rose-300 uppercase tracking-wide">
            Rejected
          </span>
        </div>
        <p className="text-xs text-muted-foreground italic">
          {isError
            ? "Couldn't load the rejection details right now — please try again in a moment."
            : "No detailed rejection record was found. This rejection happened before audit logging was enabled, or via an external integration."}
        </p>
      </div>
    );
  }

  const actor =
    r.actorName ||
    r.actorEmail ||
    (r.rejectedByRole === "system" ? "System / automation" : "Unknown");
  const when = r.createdAt ? new Date(r.createdAt) : null;

  return (
    <div className={wrap}>
      <div className="flex items-center gap-2 flex-wrap">
        <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
        <span className="text-xs font-semibold text-rose-300 uppercase tracking-wide">
          Rejected
        </span>
        {r.fromStage && (
          <span className="text-[10px] px-1.5 py-0.5 rounded border border-rose-500/30 text-rose-300/80 uppercase tracking-wide">
            from {r.fromStage.replace(/_/g, " ")}
          </span>
        )}
        {when && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </span>
        )}
      </div>

      {/* Reason — primary signal */}
      {r.reason ? (
        <div>
          <div className="text-[10px] font-semibold text-rose-300/80 uppercase tracking-wide mb-0.5">
            Reason
          </div>
          <div className="text-sm text-foreground">{r.reason}</div>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic">No reason was provided.</div>
      )}

      {/* Notes — free-form details from the rejector */}
      {r.notes && (
        <div>
          <div className="text-[10px] font-semibold text-rose-300/80 uppercase tracking-wide mb-0.5">
            Notes
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed border-l-2 border-rose-500/30 pl-2 italic whitespace-pre-wrap">
            {r.notes}
          </p>
        </div>
      )}

      {/* Actor + email status — secondary metadata row */}
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground pt-1 border-t border-rose-500/15">
        <span className="flex items-center gap-1">
          <Users className="w-3 h-3 opacity-60" />
          <span className="text-foreground/90">{actor}</span>
          {r.rejectedByRole && (
            <span className="text-muted-foreground/60">
              · {r.rejectedByRole.replace(/_/g, " ")}
            </span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Mail className="w-3 h-3 opacity-60" />
          {r.emailSent ? (
            <span className="text-emerald-400">Candidate notified</span>
          ) : r.emailError ? (
            <span className="text-amber-400" title={r.emailError}>
              Email failed
            </span>
          ) : (
            <span className="text-muted-foreground">No email sent</span>
          )}
        </span>
      </div>
    </div>
  );
}

function CandidateDetailDialog({
  row,
  jobId,
  open,
  onClose,
}: {
  row: any;
  jobId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const c = row.candidate || {};
  /* Same id derivation as the card menu — profile page lives at /candidates/:id. */
  const profileCandidateId: string | null = c?.id || row.normalizedCandidateId || null;
  const screening = row.screeningResult || c.screeningResult || row.candidate?.screeningResult;
  const verification =
    row.verificationResult || c.verificationResult || row.candidate?.verificationResult;
  const verificationStatus = row.verificationStatus || c.verificationStatus;
  const replyStatus = row.replyStatus || c.replyStatus;
  const replyBody = row.replyBody || c.replyBody;
  const [replyText, setReplyText] = useState("");

  /* GDPR audit trail — pull every email/SMS/event we've sent or recorded
   * for this candidate, scoped to this dialog. Includes the AI-drafted
   * confirmation email and any 24h re-engagement nudges. We pass BOTH the
   * sourced ID and the normalized candidate ID because comm events may be
   * recorded under either depending on whether the row has been normalized. */
  const auditIds = [row.normalizedCandidateId, row.candidate?.id, row.sourcedId].filter(
    Boolean,
  ) as string[];
  const auditKey = auditIds.join(",");
  const { data: commEvents = [] } = useQuery<any[]>({
    queryKey: ["comm-events", auditKey],
    queryFn: () => apiFetch(`/communication/events?candidateIds=${encodeURIComponent(auditKey)}`),
    enabled: open && auditIds.length > 0,
  });

  const effectiveJobId = row.jobId || jobId;
  const logReplyMutation = useMutation({
    mutationFn: (sentiment: "positive" | "negative" | "do_not_contact") =>
      apiFetch<any>(`/jobs/${effectiveJobId || ""}/pipeline/card-action`, {
        method: "POST",
        body: JSON.stringify({
          action: "log_reply",
          sourcedId: row.sourcedId,
          sentiment,
          replyBody: replyText,
        }),
      }),
    onSuccess: (data: any) => {
      toast({
        title:
          data.sentiment === "positive"
            ? "Reply logged — moved to Scheduled"
            : data.sentiment === "negative"
              ? "Reply logged — candidate declined"
              : "Marked as Do Not Contact",
      });
      qc.invalidateQueries({ queryKey: ["pipeline-stages"] });
      qc.invalidateQueries({ queryKey: ["recruiter-inbox"] });
      // DNC may have been set — refresh candidate counts, DNC list, and AI prediction cards
      qc.invalidateQueries({ queryKey: ["/api/candidates"] });
      qc.invalidateQueries({ queryKey: ["dnc-list"] });
      if (effectiveJobId)
        qc.invalidateQueries({ queryKey: ["intelligence", "job", effectiveJobId] });
      onClose();
    },
    onError: (err: any) =>
      toast({ title: "Failed to log reply", description: err?.message, variant: "destructive" }),
  });

  const verdictBadge = (verdict?: string) => {
    if (!verdict) return null;
    const map: Record<string, string> = {
      clear: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
      review: "text-amber-400 bg-amber-500/10 border-amber-500/30",
      flag: "text-rose-400 bg-rose-500/10 border-rose-500/30",
      advance: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
      hold: "text-amber-400 bg-amber-500/10 border-amber-500/30",
      reject: "text-rose-400 bg-rose-500/10 border-rose-500/30",
    };
    return (
      <span
        className={cn(
          "text-[10px] px-2 py-0.5 rounded border font-semibold uppercase",
          map[verdict] || "text-muted-foreground border-border",
        )}
      >
        {verdict}
      </span>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {profileCandidateId ? (
              <button
                type="button"
                className="hover:text-primary hover:underline underline-offset-4 transition-colors text-left"
                title="Open candidate profile"
                onClick={() => {
                  onClose();
                  setLocation(`/candidates/${profileCandidateId}`);
                }}
              >
                {c.firstName} {c.lastName}
              </button>
            ) : (
              <span>
                {c.firstName} {c.lastName}
              </span>
            )}
            {(row.score ?? c.resumeScreenScore) != null && (
              <ScorePill score={row.score ?? c.resumeScreenScore} />
            )}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {c.currentTitle}
            {c.currentCompany ? ` · ${c.currentCompany}` : ""}
            {c.location ? ` · ${c.location}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">
            {c.email}
            {c.phone ? ` · ${c.phone}` : ""}
          </p>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          {/* Rejection details — shown FIRST when candidate is rejected so
           * the recruiter immediately sees who/why/when. Persisted via the
           * candidate_rejections audit table; pulled regardless of which ID
           * column was populated (candidate_id / sourced_id / application_id). */}
          {row.stage === "rejected" && (
            <RejectionDetailsSection
              candidateId={row.candidate?.id || row.normalizedCandidateId}
              sourcedId={row.sourcedId}
              applicationId={row.applicationId}
              jobId={jobId || row.jobId}
              enabled={open}
            />
          )}

          {/* Skills */}
          {(c.skills?.length ?? 0) > 0 && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase mb-1.5">
                Skills
              </div>
              <div className="flex flex-wrap gap-1">
                {c.skills.map((s: string) => (
                  <Badge key={s} variant="secondary" className="text-[10px]">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Screening result */}
          {screening ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase">
                  AI Screening
                </div>
                {verdictBadge(screening.recommendation)}
                {screening.score != null && (
                  <span className="text-[10px] text-muted-foreground">
                    score {screening.score}/100
                  </span>
                )}
                {screening.confidence && (
                  <span className="text-[10px] text-muted-foreground">
                    · confidence {screening.confidence}
                  </span>
                )}
              </div>
              {screening.recruiterSummary && (
                <p className="text-xs leading-relaxed italic text-muted-foreground border-l-2 border-primary/30 pl-3">
                  "{screening.recruiterSummary}"
                </p>
              )}
              <div className="grid grid-cols-2 gap-3">
                {screening.strengthAreas?.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-emerald-400 uppercase mb-1">
                      Strengths
                    </div>
                    <ul className="text-xs space-y-0.5">
                      {screening.strengthAreas.map((s: string, i: number) => (
                        <li key={i} className="flex gap-1.5">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0 mt-0.5" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {screening.gapAreas?.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-amber-400 uppercase mb-1">
                      Gaps / Unknowns
                    </div>
                    <ul className="text-xs space-y-0.5">
                      {screening.gapAreas.map((s: string, i: number) => (
                        <li key={i} className="flex gap-1.5">
                          <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                          <span>{s}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              {screening.extractedSkills?.length > 0 && (
                <div className="text-xs">
                  <span className="text-muted-foreground">Detected skills: </span>
                  {screening.extractedSkills.join(", ")}
                </div>
              )}
            </div>
          ) : isScreeningRunning(row) ? (
            <ProcessingPill label="Screening résumé…" />
          ) : (
            <div className="text-xs text-muted-foreground">No AI screening result yet.</div>
          )}

          {/* Verification result */}
          {verification ? (
            <div className="space-y-2 border-t border-border/50 pt-4">
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase">
                  Identity Verification
                </div>
                {verdictBadge(verification.verdict)}
                {verificationStatus && (
                  <span className="text-[10px] text-muted-foreground">
                    · status: {verificationStatus}
                  </span>
                )}
                {verification.overallScore != null && (
                  <span className="text-[10px] text-muted-foreground">
                    · score {verification.overallScore}/100
                  </span>
                )}
              </div>
              {verification.notes && (
                <p className="text-xs leading-relaxed italic text-muted-foreground border-l-2 border-amber-400/30 pl-3">
                  "{verification.notes}"
                </p>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {verification.linkedinMatch && (
                  <div>
                    <span className="text-muted-foreground">LinkedIn: </span>
                    {verification.linkedinMatch}
                  </div>
                )}
                {verification.emailValidity && (
                  <div>
                    <span className="text-muted-foreground">Email: </span>
                    {verification.emailValidity}
                  </div>
                )}
                {verification.resumeConsistency && (
                  <div>
                    <span className="text-muted-foreground">Resume: </span>
                    {verification.resumeConsistency}
                  </div>
                )}
                {verification.profileCompleteness != null && (
                  <div>
                    <span className="text-muted-foreground">Profile completeness: </span>
                    {verification.profileCompleteness}%
                  </div>
                )}
              </div>
              {verification.checksPerformed?.length > 0 && (
                <div className="text-xs">
                  <div className="text-[10px] font-semibold text-muted-foreground uppercase mb-1">
                    Checks performed
                  </div>
                  <ul className="space-y-0.5">
                    {verification.checksPerformed.map((s: string, i: number) => (
                      <li key={i} className="flex gap-1.5">
                        <CheckCircle2 className="w-3 h-3 text-cyan-400 shrink-0 mt-0.5" />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {verification.riskFlags?.length > 0 && (
                <div className="text-xs">
                  <div className="text-[10px] font-semibold text-rose-400 uppercase mb-1">
                    Risk flags
                  </div>
                  <ul className="space-y-0.5">
                    {verification.riskFlags.map((s: string, i: number) => (
                      <li key={i} className="flex gap-1.5">
                        <XCircle className="w-3 h-3 text-rose-400 shrink-0 mt-0.5" />
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground border-t border-border/50 pt-4">
              {isVerificationRunning(row) ? (
                <ProcessingPill label="Verifying identity…" />
              ) : (
                `No identity verification yet. Click "Send to Verify" on the card to run the Verification Agent.`
              )}
            </div>
          )}

          {/* Reply tracking — show existing reply or let recruiter log a new one */}
          {(row.stage === "shortlisted" || row.stage === "interview_scheduled" || replyStatus) && (
            <div className="space-y-2 border-t border-border/50 pt-4">
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase">
                  Candidate Response
                </div>
                {replyStatus && (
                  <span
                    className={cn(
                      "text-[10px] px-2 py-0.5 rounded border font-semibold uppercase",
                      replyStatus === "positive"
                        ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                        : replyStatus === "negative"
                          ? "text-rose-400 bg-rose-500/10 border-rose-500/30"
                          : "text-slate-400 bg-slate-500/10 border-slate-500/30",
                    )}
                  >
                    {replyStatus === "do_not_contact" ? "Do Not Contact" : replyStatus}
                  </span>
                )}
              </div>

              {replyBody && (
                <p className="text-xs leading-relaxed italic text-muted-foreground border-l-2 border-emerald-400/30 pl-3">
                  "{replyBody}"
                </p>
              )}

              {!replyStatus && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Got a reply from this candidate? Log it here. The Inbox at{" "}
                    <span className="font-mono">/outreach/inbox</span> shows all replies grouped by
                    job.
                  </p>
                  <textarea
                    className="w-full min-h-[60px] text-xs p-2 rounded border border-border bg-background"
                    placeholder="Paste candidate's reply here (optional)"
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="gap-1 h-7 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white"
                      disabled={logReplyMutation.isPending}
                      onClick={() => logReplyMutation.mutate("positive")}
                    >
                      <ThumbsUp className="w-3 h-3" /> Interested → Schedule Interview
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1 h-7 text-[11px] text-rose-400 border-rose-500/30 hover:bg-rose-500/10"
                      disabled={logReplyMutation.isPending}
                      onClick={() => logReplyMutation.mutate("negative")}
                    >
                      <XCircle className="w-3 h-3" /> Not Interested
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1 h-7 text-[11px] text-slate-400 border-slate-500/30 hover:bg-slate-500/10"
                      disabled={logReplyMutation.isPending}
                      onClick={() => logReplyMutation.mutate("do_not_contact")}
                    >
                      Do Not Contact
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Communication audit trail (GDPR) — every email/SMS we sent or received */}
          {commEvents.length > 0 && (
            <div className="space-y-2 border-t border-border/50 pt-4">
              <div className="flex items-center gap-2">
                <div className="text-xs font-semibold text-muted-foreground uppercase">
                  Communication Log
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {pluralize(commEvents.length, "event")}
                </span>
              </div>
              <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                {commEvents.map((ev: any) => {
                  const ts = ev.sentAt || ev.createdAt;
                  const tone =
                    ev.status === "failed"
                      ? "border-rose-500/30 bg-rose-500/5"
                      : ev.status === "opened"
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : ev.type === "re_engagement"
                          ? "border-amber-500/30 bg-amber-500/5"
                          : "border-border bg-muted/30";
                  return (
                    <div key={ev.id} className={cn("text-xs p-2 rounded border", tone)}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                          {ev.type.replace(/_/g, " ")}
                        </span>
                        <span className="text-[10px] text-muted-foreground">· {ev.channel}</span>
                        <span className="text-[10px] text-muted-foreground">· {ev.status}</span>
                        <span className="text-[10px] text-muted-foreground ml-auto">
                          {ts ? new Date(ts).toLocaleString() : ""}
                        </span>
                      </div>
                      {ev.subject && <div className="font-medium text-[11px]">{ev.subject}</div>}
                      {ev.body && (
                        <p className="text-[11px] text-muted-foreground whitespace-pre-wrap line-clamp-4 mt-0.5">
                          {ev.body}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Add Candidate Modal ──────────────────────────────────────────────── */
function AddCandidateModal({
  jobId,
  open,
  onClose,
}: {
  jobId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const cvRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    currentTitle: "",
    currentCompany: "",
    location: "",
    skills: "",
    linkedinUrl: "",
    notes: "",
  });
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);

  const handleCvSelect = async (file: File | null) => {
    if (!file) return;
    setCvFile(file);
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append("files", file);
      fd.append("jobId", jobId);
      // Pre-fill only — the candidate row is created when the user clicks
      // "Add to Pipeline" in the modal, not when the CV is selected.
      fd.append("previewOnly", "true");
      const res = await fetch(`${BASE}/api/candidates/parse-cvs`, {
        credentials: "include",
        method: "POST",
        headers: { ...authHeaders() },
        body: fd,
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      const r = (data.results ?? [])[0];
      if (!r || r.error) throw new Error(r?.error ?? "Could not parse CV");
      setForm((f) => ({
        firstName: r.firstName || f.firstName,
        lastName: r.lastName || f.lastName,
        email: r.email || f.email,
        currentTitle: r.currentTitle || f.currentTitle,
        currentCompany: r.currentCompany || f.currentCompany,
        location: r.location || f.location,
        linkedinUrl: r.linkedinUrl || f.linkedinUrl,
        skills: Array.isArray(r.skills) && r.skills.length ? r.skills.join(", ") : f.skills,
        notes: f.notes,
      }));
      toast({ title: "CV parsed — fields pre-filled. Review and submit." });
    } catch (err: any) {
      toast({ title: "Failed to parse CV", description: err.message, variant: "destructive" });
      setCvFile(null);
    } finally {
      setParsing(false);
    }
  };

  const [emailMatch, setEmailMatch] = useState<{
    existing: any;
    proposedChanges: { field: string; label: string; from: any; to: any }[];
  } | null>(null);

  const resetAndClose = () => {
    setForm({
      firstName: "",
      lastName: "",
      email: "",
      currentTitle: "",
      currentCompany: "",
      location: "",
      skills: "",
      linkedinUrl: "",
      notes: "",
    });
    setCvFile(null);
    if (cvRef.current) cvRef.current.value = "";
    setEmailMatch(null);
    onClose();
  };

  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
    // New/updated candidate also bumps the Candidates tab badge + AI predictions panel
    qc.invalidateQueries({ queryKey: ["/api/candidates"] });
    qc.invalidateQueries({ queryKey: ["intelligence", "job", jobId] });
  };

  // Raw fetch (not the throwing apiFetch wrapper) so we can read the 409
  // email_match body and offer to merge into the existing record.
  const postCandidate = async (mergeIntoExisting: boolean) => {
    const res = await fetch(`${BASE}/api/jobs/${jobId}/add-candidate`, {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ ...form, skills: form.skills, mergeIntoExisting }),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const { res, data } = await postCandidate(false);
      if (res.status === 409 && data?.reason === "email_match" && data?.existing) {
        return {
          emailMatch: {
            existing: data.existing,
            proposedChanges: Array.isArray(data.proposedChanges) ? data.proposedChanges : [],
          },
        };
      }
      if (!res.ok) throw new Error(data?.error || `API ${res.status}`);
      return { ok: true };
    },
    onSuccess: (result: any) => {
      if (result?.emailMatch) {
        setEmailMatch(result.emailMatch);
        return;
      }
      toast({ title: `${form.firstName} ${form.lastName} added to pipeline` });
      invalidateAll();
      resetAndClose();
    },
    onError: (err: any) =>
      toast({
        title: "Failed to add candidate",
        description: err?.message || "Could not add candidate.",
        variant: "destructive",
      }),
  });

  const mergeMutation = useMutation({
    mutationFn: async () => {
      const { res, data } = await postCandidate(true);
      if (!res.ok) throw new Error(data?.error || `API ${res.status}`);
      return { ok: true };
    },
    onSuccess: () => {
      toast({ title: `${form.firstName} ${form.lastName}'s record updated and added to pipeline` });
      invalidateAll();
      resetAndClose();
    },
    onError: (err: any) =>
      toast({
        title: "Could not update candidate",
        description: err?.message || "Please try again.",
        variant: "destructive",
      }),
  });

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Candidate</DialogTitle>
          </DialogHeader>

          {/* CV upload (optional, AI-parses to pre-fill the form) */}
          <div
            className={cn(
              "border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-colors",
              cvFile
                ? "border-emerald-500/50 bg-emerald-500/5"
                : "border-border/50 hover:border-primary/40 hover:bg-primary/5",
            )}
            onClick={() => !parsing && cvRef.current?.click()}
          >
            <input
              ref={cvRef}
              type="file"
              accept=".pdf,.docx,.txt"
              className="hidden"
              onChange={(e) => handleCvSelect(e.target.files?.[0] ?? null)}
            />
            {parsing ? (
              <div className="flex items-center justify-center gap-2 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" /> Parsing CV…
              </div>
            ) : cvFile ? (
              <div className="flex items-center justify-center gap-2 text-sm">
                <FileText className="w-4 h-4 text-emerald-400" />
                <span className="font-medium">{cvFile.name}</span>
                <span className="text-xs text-muted-foreground">— click to replace</span>
              </div>
            ) : (
              <div className="space-y-1">
                <Upload className="w-5 h-5 text-muted-foreground/50 mx-auto" />
                <p className="text-sm font-medium">
                  Upload CV / Resume{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  PDF, DOCX, or TXT — AI will pre-fill the fields below
                </p>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">First Name *</Label>
              <Input
                className="h-8 text-sm"
                placeholder="John"
                value={form.firstName}
                onChange={set("firstName")}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Last Name *</Label>
              <Input
                className="h-8 text-sm"
                placeholder="Doe"
                value={form.lastName}
                onChange={set("lastName")}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Email</Label>
              <Input
                className="h-8 text-sm"
                type="email"
                placeholder="john@example.com"
                value={form.email}
                onChange={set("email")}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Current Title</Label>
              <Input
                className="h-8 text-sm"
                placeholder="Senior Developer"
                value={form.currentTitle}
                onChange={set("currentTitle")}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Company</Label>
              <Input
                className="h-8 text-sm"
                placeholder="Acme Corp"
                value={form.currentCompany}
                onChange={set("currentCompany")}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Location</Label>
              <Input
                className="h-8 text-sm"
                placeholder="Buenos Aires, AR"
                value={form.location}
                onChange={set("location")}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">LinkedIn URL</Label>
              <Input
                className="h-8 text-sm"
                placeholder="linkedin.com/in/..."
                value={form.linkedinUrl}
                onChange={set("linkedinUrl")}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">
                Skills <span className="text-muted-foreground">(comma-separated)</span>
              </Label>
              <Input
                className="h-8 text-sm"
                placeholder="Java, Spring Boot, PostgreSQL"
                value={form.skills}
                onChange={set("skills")}
              />
            </div>
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Notes</Label>
              <Input
                className="h-8 text-sm"
                placeholder="Referred by..."
                value={form.notes}
                onChange={set("notes")}
              />
            </div>
          </div>

          <DialogFooter className="mt-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!form.firstName || !form.lastName || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
              ) : (
                <UserPlus className="w-3.5 h-3.5 mr-1.5" />
              )}
              Add to Pipeline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Same-email merge dialog — update the existing record instead of duplicating */}
      <Dialog
        open={!!emailMatch}
        onOpenChange={(o) => {
          if (!o) setEmailMatch(null);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-email-match">
          <DialogHeader>
            <DialogTitle>Candidate already on file</DialogTitle>
          </DialogHeader>
          {emailMatch && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">A candidate with this email already exists:</p>
              <div className="rounded-md border border-border/40 bg-card/40 p-3">
                <div className="font-medium">
                  {emailMatch.existing.firstName} {emailMatch.existing.lastName}
                </div>
                {emailMatch.existing.email && (
                  <div className="text-xs text-muted-foreground">{emailMatch.existing.email}</div>
                )}
                {emailMatch.existing.currentTitle && (
                  <div className="text-xs text-muted-foreground">
                    {emailMatch.existing.currentTitle}
                  </div>
                )}
              </div>
              {emailMatch.proposedChanges.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    The info you entered is newer for these fields. Updating merges them into the
                    existing record (nothing is blanked out):
                  </p>
                  <div className="rounded-md border border-border/40 divide-y divide-border/40">
                    {emailMatch.proposedChanges.map((c) => (
                      <div key={c.field} className="px-3 py-2 text-xs">
                        <div className="font-medium text-foreground">{c.label}</div>
                        <div className="text-muted-foreground line-through">
                          {c.from ? String(c.from) : "—"}
                        </div>
                        <div className="text-emerald-400">{c.to ? String(c.to) : "—"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Your entry doesn't add any newer info, but we can still add this candidate to the
                  role.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEmailMatch(null)}
              disabled={mergeMutation.isPending}
              data-testid="button-email-match-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => mergeMutation.mutate()}
              disabled={mergeMutation.isPending}
              data-testid="button-email-match-merge"
            >
              {mergeMutation.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />
                  Updating…
                </>
              ) : emailMatch && emailMatch.proposedChanges.length > 0 ? (
                "Update existing"
              ) : (
                "Add to role"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ── CSV helpers ──────────────────────────────────────────────────────── */
const CSV_HEADERS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "location",
  "currentTitle",
  "currentCompany",
  "linkedinUrl",
  "githubUrl",
  "skills",
];
const CSV_TEMPLATE =
  CSV_HEADERS.join(",") +
  '\nJane,Doe,jane@example.com,+1-555-0100,"New York, NY",Senior Java Developer,Acme Corp,linkedin.com/in/janedoe,github.com/janedoe,"Java,Spring Boot,PostgreSQL"';

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, "").trim());
  return lines
    .slice(1)
    .filter((l) => l.trim())
    .map((line) => {
      const cols: string[] = [];
      let cur = "",
        inQ = false;
      for (const ch of line) {
        if (ch === '"') {
          inQ = !inQ;
        } else if (ch === "," && !inQ) {
          cols.push(cur.trim());
          cur = "";
        } else {
          cur += ch;
        }
      }
      cols.push(cur.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = cols[i] ?? "";
      });
      return row;
    });
}

/* ── Bulk Upload Modal ────────────────────────────────────────────────── */
function BulkUploadModal({
  jobId,
  open,
  onClose,
}: {
  jobId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<{ created: number; skipped: number; errors: any[] } | null>(
    null,
  );

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const parsed = parseCSV(ev.target?.result as string);
      setRows(parsed);
    };
    reader.readAsText(file);
  };

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<any>("/candidates/bulk-import", {
        method: "POST",
        body: JSON.stringify({ rows, jobId }),
      }),
    onSuccess: (data) => {
      setResult({
        created: data.created ?? 0,
        skipped: data.skipped ?? 0,
        errors: data.errors ?? [],
      });
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      toast({ title: `Imported ${data.created} candidates` });
    },
    onError: () => toast({ title: "Import failed", variant: "destructive" }),
  });

  const reset = () => {
    setRows([]);
    setFileName("");
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };
  const handleClose = () => {
    reset();
    onClose();
  };

  const downloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lexy_candidates_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const previewRows = rows.slice(0, 5);
  const previewCols = ["firstName", "lastName", "email", "currentTitle", "currentCompany"];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-primary" /> Bulk Upload Candidates
          </DialogTitle>
        </DialogHeader>

        {!result ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Upload a CSV file to add multiple candidates to this job's pipeline at once.
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-xs shrink-0"
                onClick={downloadTemplate}
              >
                <Download className="w-3 h-3" /> Download Template
              </Button>
            </div>

            <div
              className="border-2 border-dashed border-border/50 rounded-xl p-8 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleFile}
              />
              {fileName ? (
                <div className="flex items-center justify-center gap-2">
                  <FileText className="w-5 h-5 text-primary" />
                  <span className="text-sm font-medium">{fileName}</span>
                  <Badge variant="outline" className="text-xs">
                    {rows.length} rows
                  </Badge>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-8 h-8 text-muted-foreground/50 mx-auto" />
                  <p className="text-sm font-medium">Click to select CSV file</p>
                  <p className="text-xs text-muted-foreground">
                    firstName, lastName, email are required · up to 500 rows
                  </p>
                </div>
              )}
            </div>

            {rows.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium">
                  Preview (first {Math.min(5, rows.length)} of {rows.length} rows)
                </p>
                <div className="rounded-lg border border-border/50 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border/50 bg-muted/30">
                        {previewCols.map((col) => (
                          <th
                            key={col}
                            className="px-3 py-2 text-left font-medium text-muted-foreground"
                          >
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, i) => (
                        <tr key={i} className="border-b border-border/30 last:border-0">
                          {previewCols.map((col) => (
                            <td key={col} className="px-3 py-2 truncate max-w-[120px]">
                              {row[col] || <span className="text-muted-foreground/40">—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {rows.length > 5 && (
                  <p className="text-xs text-muted-foreground/60 text-right">
                    + {rows.length - 5} more rows
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
                <p className="text-2xl font-bold text-emerald-400">{result.created}</p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
              <div className="rounded-xl border border-yellow-500/25 bg-yellow-500/5 p-4 text-center">
                <AlertTriangle className="w-5 h-5 text-yellow-400 mx-auto mb-1" />
                <p className="text-2xl font-bold text-yellow-400">{result.skipped}</p>
                <p className="text-xs text-muted-foreground">Already existed</p>
              </div>
              <div className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-4 text-center">
                <XCircle className="w-5 h-5 text-rose-400 mx-auto mb-1" />
                <p className="text-2xl font-bold text-rose-400">{result.errors.length}</p>
                <p className="text-xs text-muted-foreground">Errors</p>
              </div>
            </div>
            {result.errors.length > 0 && (
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 space-y-1 max-h-36 overflow-y-auto">
                <p className="text-xs font-medium text-rose-400 mb-2">Rows with errors:</p>
                {result.errors.map((e: any, i: number) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    Row {e.row} ({e.email}): {e.reason}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button
              size="sm"
              disabled={rows.length === 0 || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Importing…
                </>
              ) : (
                <>
                  <Upload className="w-3.5 h-3.5 mr-1.5" /> Import {rows.length} Candidates
                </>
              )}
            </Button>
          )}
          {result && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                reset();
              }}
            >
              Upload Another
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── CV Upload Modal ──────────────────────────────────────────────────── */
function CvUploadModal({
  jobId,
  open,
  onClose,
}: {
  jobId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [parsing, setParsing] = useState(false);
  const [results, setResults] = useState<any[] | null>(null);
  const [dragging, setDragging] = useState(false);

  const addFiles = (newFiles: FileList | null) => {
    if (!newFiles) return;
    const accepted = Array.from(newFiles).filter((f) => {
      const n = f.name.toLowerCase();
      return n.endsWith(".pdf") || n.endsWith(".docx") || n.endsWith(".txt") || n.endsWith(".csv");
    });
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name));
      return [...prev, ...accepted.filter((f) => !existing.has(f.name))];
    });
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const removeFile = (name: string) => setFiles((f) => f.filter((x) => x.name !== name));

  const parse = async () => {
    if (files.length === 0) return;
    setParsing(true);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      fd.append("jobId", jobId);
      const res = await fetch(`${BASE}/api/candidates/parse-cvs`, {
        credentials: "include",
        method: "POST",
        headers: { ...authHeaders() },
        body: fd,
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      setResults(data.results ?? []);
      qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] });
      const ok = (data.results ?? []).filter((r: any) => !r.error).length;
      toast({ title: `${pluralize(ok, "candidate")} parsed and added to pipeline` });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setParsing(false);
    }
  };

  const reset = () => {
    setFiles([]);
    setResults(null);
    if (fileRef.current) fileRef.current.value = "";
  };
  const handleClose = () => {
    reset();
    onClose();
  };

  const successResults = (results ?? []).filter((r: any) => !r.error);
  const errorResults = (results ?? []).filter((r: any) => r.error);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-primary" /> Upload CVs / Resumes
          </DialogTitle>
        </DialogHeader>

        {!results ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Drop PDF, DOCX, TXT resume files, or a CSV roster. AI extracts name, email, title and
              skills from resumes; CSV rows are imported as-is.
            </p>

            <div
              className={cn(
                "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors",
                dragging
                  ? "border-primary bg-primary/10"
                  : "border-border/50 hover:border-primary/40 hover:bg-primary/5",
              )}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt,.csv"
                multiple
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />
              <Upload className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm font-medium">Click or drag &amp; drop CV or CSV files here</p>
              <p className="text-xs text-muted-foreground mt-1">
                PDF, DOCX, TXT, CSV · up to 10 MB each · up to 20 files
              </p>
            </div>

            {files.length > 0 && (
              <div className="space-y-1.5">
                {files.map((f) => (
                  <div
                    key={f.name}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 border border-border/40"
                  >
                    <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs flex-1 truncate">{f.name}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {(f.size / 1024).toFixed(0)} KB
                    </span>
                    <button
                      onClick={() => removeFile(f.name)}
                      aria-label={`Remove file ${f.name}`}
                      className="text-muted-foreground/50 hover:text-rose-400 transition-colors"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-center">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 mx-auto mb-1" />
                <p className="text-2xl font-bold text-emerald-400">{successResults.length}</p>
                <p className="text-xs text-muted-foreground">Imported</p>
              </div>
              <div className="rounded-xl border border-rose-500/25 bg-rose-500/5 p-4 text-center">
                <XCircle className="w-5 h-5 text-rose-400 mx-auto mb-1" />
                <p className="text-2xl font-bold text-rose-400">{errorResults.length}</p>
                <p className="text-xs text-muted-foreground">Failed</p>
              </div>
              <div className="rounded-xl border border-primary/25 bg-primary/5 p-4 text-center">
                <FileText className="w-5 h-5 text-primary mx-auto mb-1" />
                <p className="text-2xl font-bold text-primary">{files.length}</p>
                <p className="text-xs text-muted-foreground">Total files</p>
              </div>
            </div>

            {successResults.length > 0 && (
              <div className="rounded-lg border border-border/50 overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 border-b border-border/50">
                  <p className="text-xs font-medium text-muted-foreground">Parsed candidates</p>
                </div>
                <div className="divide-y divide-border/30 max-h-48 overflow-y-auto">
                  {successResults.map((r: any, i: number) => (
                    <div key={i} className="px-3 py-2.5 flex items-start gap-3">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">
                          {r.firstName} {r.lastName}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {r.currentTitle ?? "—"} {r.currentCompany ? `at ${r.currentCompany}` : ""}
                        </p>
                        {r.email && (
                          <p className="text-[10px] text-muted-foreground/60">{r.email}</p>
                        )}
                        {r.skills?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {r.skills.slice(0, 5).map((s: string, si: number) => (
                              <span
                                key={si}
                                className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
                              >
                                {s}
                              </span>
                            ))}
                            {r.skills.length > 5 && (
                              <span className="text-[9px] text-muted-foreground">
                                +{r.skills.length - 5}
                              </span>
                            )}
                          </div>
                        )}
                        {r.summary && (
                          <p className="text-[10px] text-muted-foreground/60 mt-1 line-clamp-2">
                            {r.summary}
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {errorResults.length > 0 && (
              <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 space-y-1">
                <p className="text-xs font-medium text-rose-400 mb-2">Failed files:</p>
                {errorResults.map((r: any, i: number) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    <span className="font-medium">{r.fileName}</span>: {r.error}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            {results ? "Close" : "Cancel"}
          </Button>
          {!results && (
            <Button size="sm" disabled={files.length === 0 || parsing} onClick={parse}>
              {parsing ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Parsing{" "}
                  {pluralize(files.length, "file")} with AI…
                </>
              ) : (
                <>
                  <FileText className="w-3.5 h-3.5 mr-1.5" /> Parse &amp; Import{" "}
                  {pluralize(files.length, "CV")}
                </>
              )}
            </Button>
          )}
          {results && (
            <Button size="sm" variant="outline" onClick={reset}>
              Upload More
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Interview Setup Modal ────────────────────────────────────────────────
 * Lets recruiters set a couple of literal interview questions OR a general
 * focus/theme direction for THIS job, before candidates reach the interview
 * stage. Writes the `_default` key of the job's interview-direction map, which
 * the pipeline auto-interview (sendInterviewInviteFromReply → ensurePlan) and
 * the live interviewer both honor. */
function InterviewSetupModal({
  jobId,
  open,
  onClose,
}: {
  jobId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [focusDirective, setFocusDirective] = useState("");
  const [customQuestions, setCustomQuestions] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setSaved(false);
    apiFetch<any>(`/jobs/${jobId}/interview-direction`)
      .then((res) => {
        const dir = (res?.interviewDirection ?? {})._default ?? {};
        setFocusDirective(dir.focusDirective ?? "");
        setCustomQuestions(Array.isArray(dir.customQuestions) ? dir.customQuestions : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, jobId]);

  const addQuestion = () => {
    if (draft.trim()) {
      setCustomQuestions((prev) => [...prev, draft.trim()]);
      setDraft("");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(`/jobs/${jobId}/interview-direction`, {
        method: "POST",
        body: JSON.stringify({ type: "_default", focusDirective, customQuestions }),
      });
      setSaved(true);
      toast({ title: "Interview setup saved" });
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      toast({ title: "Failed to save", description: e?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Video className="w-4 h-4" /> Interview Setup
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-1">
          Add a few specific questions or a general direction for this job's interviews. Applies to
          every candidate who reaches the interview stage — both auto-scheduled and manually
          generated links.
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4 py-1">
            {/* Focus / theme direction */}
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Target className="w-3 h-3" /> Focus / Theme Direction
              </Label>
              <Textarea
                placeholder="Optional — overall theme or what to probe for, e.g. “Focus on real-world problem-solving and how they collaborate under pressure.”"
                value={focusDirective}
                onChange={(e) => setFocusDirective(e.target.value)}
                className="min-h-[72px] text-xs resize-none"
              />
            </div>

            {/* Custom questions */}
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Custom Questions
              </Label>
              {customQuestions.length > 0 && (
                <div className="space-y-1">
                  {customQuestions.map((q, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 p-2 rounded-lg bg-cyan-500/5 border border-cyan-500/20"
                    >
                      <span className="text-[9px] text-cyan-400 font-bold mt-0.5 flex-shrink-0">
                        Q{i + 1}
                      </span>
                      <span className="text-[11px] flex-1 leading-relaxed">{q}</span>
                      <button
                        onClick={() => setCustomQuestions((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove question ${i + 1}`}
                        className="text-muted-foreground/40 hover:text-rose-400 transition-colors flex-shrink-0"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  placeholder="Add a question…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addQuestion();
                    }
                  }}
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-2 flex-shrink-0"
                  onClick={addQuestion}
                >
                  <Plus className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" className="gap-1.5" onClick={save} disabled={saving || loading}>
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : saved ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Save className="w-3.5 h-3.5" />
            )}
            {saved ? "Saved!" : "Save Setup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Closed drawer ─────────────────────────────────────────────────────────
 * Terminal candidates leave the working board and live here: a celebratory
 * "Hired" section (wins: hired + started) on top, and a muted "Closed" section
 * (rejected + offer declined) below. Cards reuse <CandidateCard> so every prior
 * action is preserved; `restoreToBoard` adds a Restore control that moves a
 * card back into a working lane via the existing no-automation move (skips
 * agents + emails). Relocating cards here changes nothing about outcome
 * tracking — that fires on the stage-change / outcome endpoints, not on where
 * a card is rendered. */
/* One terminal candidate inside the Closed drawer: a compact state + date
 * caption above the reused card, so recruiters see WHY (Rejected / Withdrawn /
 * Offer Declined / Hired / Started) and WHEN each candidate left the board. */
function TerminalRow({ row, jobId, onMove }: { row: any; jobId: string; onMove: () => void }) {
  const label = STAGE_COLS.find((s) => s.key === row.stage)?.label ?? row.stage;
  const when = relativeTime(row.updatedAt) ?? relativeTime(row.createdAt);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {label}
        </span>
        {when && <span className="text-[10px] text-muted-foreground/60 shrink-0">{when}</span>}
      </div>
      <CandidateCard row={row} jobId={jobId} restoreToBoard draft={undefined} onMove={onMove} />
    </div>
  );
}

function ClosedDrawer({
  jobId,
  open,
  onClose,
  winRows,
  lossRows,
  onMove,
}: {
  jobId: string;
  open: boolean;
  onClose: () => void;
  winRows: any[];
  lossRows: any[];
  onMove: () => void;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Closed candidates</SheetTitle>
          <SheetDescription>
            Wins and closed candidates leave the active board. Use a card's{" "}
            <span className="font-medium text-foreground">Restore to board</span> action to move
            anyone back into a working stage — no emails or agents are triggered.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-8">
          <section>
            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-signal-green mb-3">
              <Check className="w-4 h-4" /> Hired ({winRows.length})
            </h3>
            {winRows.length === 0 ? (
              <p className="text-xs text-muted-foreground/70 border border-dashed border-border/50 rounded-xl px-3 py-6 text-center">
                No hires yet — closed wins will appear here.
              </p>
            ) : (
              <div className="space-y-3">
                {winRows.map((row, i) => (
                  <TerminalRow
                    key={row.applicationId || row.sourcedId || i}
                    row={row}
                    jobId={jobId}
                    onMove={onMove}
                  />
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.12em] text-muted-foreground mb-3">
              <XCircle className="w-4 h-4" /> Closed ({lossRows.length})
            </h3>
            {lossRows.length === 0 ? (
              <p className="text-xs text-muted-foreground/70 border border-dashed border-border/50 rounded-xl px-3 py-6 text-center">
                No rejected or declined candidates.
              </p>
            ) : (
              <div className="space-y-3">
                {lossRows.map((row, i) => (
                  <TerminalRow
                    key={row.applicationId || row.sourcedId || i}
                    row={row}
                    jobId={jobId}
                    onMove={onMove}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── Main Pipeline Panel ──────────────────────────────────────────────── */
export function PipelinePanel({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [cvOpen, setCvOpen] = useState(false);
  const [interviewSetupOpen, setInterviewSetupOpen] = useState(false);
  /* Empty-column collapse (Step 2). `expandAll` overrides collapsing and is
   * persisted; `tempExpanded` holds columns a user clicked open temporarily. */
  const [expandAll, setExpandAll] = useState<boolean>(() => {
    try {
      return localStorage.getItem("lexy.pipeline.expandEmpty") === "1";
    } catch {
      return false;
    }
  });
  const [tempExpanded, setTempExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    try {
      localStorage.setItem("lexy.pipeline.expandEmpty", expandAll ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [expandAll]);

  const { data, isLoading } = useQuery<any>({
    queryKey: ["pipeline-stages", jobId],
    queryFn: () => apiFetch(`/jobs/${jobId}/pipeline-stages`),
    /* Poll faster (3s) while any candidate has a Screening/Verification agent
     * mid-run so results land quickly without a manual refresh; back off to 8s
     * once nothing is processing. */
    refetchInterval: (query: any) => {
      const stages = query.state.data?.stages ?? {};
      const anyRunning = (Object.values(stages).flat() as any[]).some(isRowProcessing);
      return anyRunning ? 3_000 : 8_000;
    },
  });

  /* The server buckets brand-new rows under "applied" (e.g. manually added
   * candidates), but the board has no Applied column — fold that bucket into
   * the Sourced lane so those candidates are never invisible. Each row keeps
   * its real stage ("applied") so advance/actions still work. */
  const stages = useMemo(() => {
    const raw: Record<string, any[]> = data?.stages ?? {};
    if (!raw.applied?.length) return raw;
    return { ...raw, sourced: [...(raw.sourced ?? []), ...raw.applied], applied: [] };
  }, [data]);
  const total: number = data?.total ?? 0;

  /* Pending first-touch outreach drafts for this job, keyed by candidateId, so
   * "Outreach Queued" cards can surface a Review/Approve action inline. */
  const draftsByCandidate = useJobPendingDrafts(jobId);

  /* Auto-collapse any temporarily-expanded empty column when the user clicks
   * away from it — but keep any that meanwhile gained a candidate. */
  useEffect(() => {
    if (tempExpanded.size === 0) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("[data-temp-col]")) return;
      setTempExpanded((prev) => {
        const next = new Set<string>();
        prev.forEach((k) => {
          if ((stages[k]?.length ?? 0) > 0) next.add(k);
        });
        return next.size === prev.size ? prev : next;
      });
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [tempExpanded, stages]);

  /* Only working lanes render as Kanban columns; terminal stages leave the board
   * (wins → far-right strip + Closed drawer, losses → Closed drawer only). */
  const visibleCols = STAGE_COLS.filter((col) => col.boardLane);

  /* Terminal cohorts for the wins strip + Closed drawer, derived straight from
   * the canonical STAGE_COLS `terminal` flag — no page-local stage lists, so a
   * new terminal stage surfaces here automatically. Wins = hired + started
   * (started is a celebratory post-hire terminal, not a working lane); losses =
   * rejected + offer_declined + withdrawn. */
  const winRows: any[] = STAGE_COLS.filter((c) => c.terminal === "win").flatMap(
    (c) => stages[c.key] ?? [],
  );
  const lossRows: any[] = STAGE_COLS.filter((c) => c.terminal === "loss").flatMap(
    (c) => stages[c.key] ?? [],
  );
  const closedCount = winRows.length + lossRows.length;
  const [closedOpen, setClosedOpen] = useState(false);

  /* Render one stage column. Header styling is derived purely from the phase
   * (identical within a phase); the count is the only variable element. */
  const renderColumn = (col: { key: string; label: string }, phase: Phase | null) => {
    const cards: any[] = stages[col.key] ?? [];
    const count = cards.length;
    const ps = phase ? PHASE_STYLE[phase] : NEUTRAL_COL;
    const collapsed = count === 0 && !expandAll && !tempExpanded.has(col.key);

    /* Empty columns collapse to a slim vertical strip so the board isn't
     * screens of "Empty". Click to expand temporarily; a click outside
     * auto-collapses it again while it's still empty. A column that gains its
     * first candidate is no longer empty and so auto-expands on next render. */
    if (collapsed) {
      return (
        <button
          key={col.key}
          type="button"
          onClick={() => setTempExpanded((prev) => new Set(prev).add(col.key))}
          title={`${col.label} — click to expand`}
          aria-label={`${col.label}, 0 candidates — click to expand`}
          className={cn(
            "group shrink-0 w-11 self-stretch flex flex-col items-center gap-1 py-2 rounded-2xl border transition-[background-color,border-color,filter] duration-[250ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none hover:brightness-110",
            ps.stripBg,
            ps.stripBorder,
          )}
        >
          <span className={cn("text-[10px] font-bold leading-none", ps.stripCount)}>0</span>
          <span
            className={cn(
              "mt-1 text-[11px] font-semibold tracking-wide whitespace-nowrap",
              ps.stripText,
            )}
            style={{ writingMode: "vertical-rl" }}
          >
            {col.label}
          </span>
        </button>
      );
    }

    const tempOpen = count === 0 && tempExpanded.has(col.key) && !expandAll;
    return (
      <div
        key={col.key}
        {...(tempOpen ? { "data-temp-col": col.key } : {})}
        className="flex flex-col gap-3 w-[300px] min-w-[300px] max-w-[320px] shrink-0 rounded-2xl bg-slate-500/[0.08] p-2 border border-slate-300/70 shadow-sm dark:bg-transparent dark:p-0 dark:border-0 dark:shadow-none dark:rounded-none transition-[width] duration-[250ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none"
      >
        <div
          className={cn(
            "flex items-center justify-between px-3 py-2 rounded-lg border text-xs font-bold",
            ps.header,
          )}
        >
          <span>{col.label}</span>
          {count > 0 ? (
            <span
              className={cn(
                "inline-flex items-center justify-center min-w-[1.25rem] px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none",
                ps.pill,
              )}
            >
              {count}
            </span>
          ) : (
            <span className="text-[10px] font-semibold text-muted-foreground/40">0</span>
          )}
        </div>
        <div className="space-y-2">
          {cards.map((row: any, i: number) => (
            <CandidateCard
              key={row.applicationId || row.sourcedId || i}
              row={row}
              jobId={jobId}
              draft={
                (row.candidate?.id && draftsByCandidate[row.candidate.id]) ||
                (row.sourcedId && draftsByCandidate[row.sourcedId]) ||
                undefined
              }
              onMove={() => qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] })}
            />
          ))}
          {count === 0 && (
            <div className="border-2 border-dashed border-slate-300/80 rounded-xl h-24 flex items-center justify-center bg-white/60 dark:border dark:border-dashed dark:border-border/40 dark:bg-transparent">
              <p className="text-[10px] text-muted-foreground/60 dark:text-muted-foreground/50">
                Empty
              </p>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header: summary + Add Candidate button */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-4 flex-wrap text-sm text-muted-foreground">
          {isLoading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading pipeline…
            </span>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <Users className="w-4 h-4" /> <strong className="text-foreground">{total}</strong>{" "}
                candidates total
              </span>
              {STAGE_COLS.filter((c) => (stages[c.key]?.length ?? 0) > 0).map((col) => {
                const ph = STAGE_PHASE[col.key];
                return (
                  <span
                    key={col.key}
                    className={cn(
                      "flex items-center gap-1",
                      ph ? PHASE_STYLE[ph].text : "text-muted-foreground",
                    )}
                  >
                    <strong>{stages[col.key]?.length}</strong> {col.label}
                  </span>
                );
              })}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={() => setClosedOpen(true)}
            title="View hired, started, rejected and declined candidates"
          >
            <Check className="w-3.5 h-3.5 text-signal-green" /> Closed · {closedCount}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={() => setExpandAll((v) => !v)}
            title={
              expandAll
                ? "Collapse empty stages into slim strips"
                : "Expand every stage to full width"
            }
          >
            {expandAll ? (
              <>
                <Minimize2 className="w-3.5 h-3.5" /> Collapse empty
              </>
            ) : (
              <>
                <Maximize2 className="w-3.5 h-3.5" /> Expand all
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={() => setInterviewSetupOpen(true)}
          >
            <Video className="w-3.5 h-3.5" /> Interview Setup
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={() => setCvOpen(true)}
          >
            <FileText className="w-3.5 h-3.5" /> Upload CVs
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={() => setBulkOpen(true)}
          >
            <Upload className="w-3.5 h-3.5" /> Bulk Upload
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 shrink-0"
            onClick={() => setAddOpen(true)}
          >
            <UserPlus className="w-3.5 h-3.5" /> Add Candidate
          </Button>
        </div>
      </div>

      {/* Flow hint — the "Set interview questions" step sits before Outreach so
          recruiters can shape every candidate's interview before any go out. */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60 flex-wrap">
        <span>Sourced</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span>Screening</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-amber-400/70">Verify</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <button
          type="button"
          onClick={() => setInterviewSetupOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-full border border-cyan-500/50 bg-cyan-500/15 px-3 py-1 text-xs font-semibold text-cyan-200 shadow-sm hover:bg-cyan-500/25 transition-colors"
          title="Add interview questions or a focus/theme direction for this job before outreach goes out"
        >
          <Video className="w-3.5 h-3.5" /> Set interview questions
        </button>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-violet-400/70">Outreach</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-emerald-400/70">Candidate Accepts</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-emerald-400/70">Interview</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-fuchsia-400/70">HM Review</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-yellow-400/70">Offer Extended</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-lime-400/70">Offer Accepted</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-emerald-400/70">Hired</span>
        <ArrowRight className="w-2.5 h-2.5" />
        <span className="text-green-300/70">Started</span>
      </div>

      {total === 0 && !isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-4 border border-dashed border-border/50 rounded-xl">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Users className="w-8 h-8 text-primary/60" />
          </div>
          <div className="text-center space-y-1">
            <p className="font-semibold">No candidates in pipeline yet</p>
            <p className="text-sm text-muted-foreground max-w-sm">
              Run the <strong>Sourcing</strong> and <strong>Screening</strong> agents from the
              Workflow tab, or add a candidate manually.
            </p>
          </div>
          <Button size="sm" onClick={() => setAddOpen(true)} className="gap-1.5">
            <UserPlus className="w-3.5 h-3.5" /> Add Candidate Manually
          </Button>
        </div>
      ) : (
        /* Kanban board — grouped into the three phases, each under a slim
           phase-label row with a hairline rule spanning its columns. */
        <div className="kanban-scroll flex gap-8 overflow-x-auto pb-2 -mx-1 px-1">
          {PHASE_ORDER.map((phase) => {
            const cols = visibleCols.filter((c) => STAGE_PHASE[c.key] === phase);
            if (cols.length === 0) return null;
            return (
              <div key={phase} className="flex flex-col gap-3">
                <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm">
                  <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {PHASE_STYLE[phase].label}
                  </div>
                  <div className="mt-1 h-px w-full bg-border" />
                </div>
                <div className="flex gap-4">{cols.map((col) => renderColumn(col, phase))}</div>
              </div>
            );
          })}
          {/* Wins strip — a slim, always-collapsed green tally of hires at the
              far right. A recruiter's board ending in a small count of wins is
              good psychology and costs one strip of width; rejections stay in
              the Closed drawer. Opens the drawer. */}
          <div className="flex flex-col gap-3">
            <div
              className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm select-none"
              aria-hidden
            >
              <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-transparent">
                ·
              </div>
              <div className="mt-1 h-px w-full bg-transparent" />
            </div>
            <div className="flex gap-4">
              <button
                type="button"
                onClick={() => setClosedOpen(true)}
                title={`${winRows.length} hired · ${lossRows.length} closed — open drawer`}
                aria-label={`Wins: ${winRows.length} hired. Open the closed-candidates drawer.`}
                className={cn(
                  "group shrink-0 w-11 self-stretch flex flex-col items-center gap-1 py-2 rounded-2xl border transition-[background-color,border-color,filter] duration-[250ms] ease-[cubic-bezier(0.25,0.1,0.25,1)] motion-reduce:transition-none hover:brightness-110",
                  winRows.length > 0
                    ? "bg-signal-green/[0.06] border-signal-green/25"
                    : "bg-muted/30 border-border/40",
                )}
              >
                <span
                  className={cn(
                    "text-[11px] font-bold leading-none",
                    winRows.length > 0 ? "text-signal-green" : "text-muted-foreground/50",
                  )}
                >
                  {winRows.length}
                </span>
                <Check
                  className={cn(
                    "w-3 h-3",
                    winRows.length > 0 ? "text-signal-green" : "text-muted-foreground/40",
                  )}
                />
                <span
                  className={cn(
                    "mt-1 text-[11px] font-semibold tracking-wide whitespace-nowrap",
                    winRows.length > 0 ? "text-signal-green/80" : "text-muted-foreground/60",
                  )}
                  style={{ writingMode: "vertical-rl" }}
                >
                  Hired
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      <ClosedDrawer
        jobId={jobId}
        open={closedOpen}
        onClose={() => setClosedOpen(false)}
        winRows={winRows}
        lossRows={lossRows}
        onMove={() => qc.invalidateQueries({ queryKey: ["pipeline-stages", jobId] })}
      />
      <AddCandidateModal jobId={jobId} open={addOpen} onClose={() => setAddOpen(false)} />
      <BulkUploadModal jobId={jobId} open={bulkOpen} onClose={() => setBulkOpen(false)} />
      <CvUploadModal jobId={jobId} open={cvOpen} onClose={() => setCvOpen(false)} />
      <InterviewSetupModal
        jobId={jobId}
        open={interviewSetupOpen}
        onClose={() => setInterviewSetupOpen(false)}
      />
    </div>
  );
}
