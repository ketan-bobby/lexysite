/**
 * applications.tsx — Candidate portal "My Applications" page.
 *
 * Fetches all applications for the logged-in candidate and renders:
 *  - A status badge (current stage)
 *  - An AI match-score badge when available
 *  - A visual pipeline tracker showing each stage as done / active / pending
 *  - A link to the public job detail page for each application
 */

import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Briefcase, MapPin, Clock, ChevronRight, AlertCircle, Loader2, Scale, CheckCircle2 } from "lucide-react";
import { formatDistanceToNow, parseISO } from "date-fns";
import { apiBase, apiFetch } from "@/lib/api";
import { Link } from "wouter";
import { CandidateConnectionInsightPanel } from "@/components/portal/CandidateConnectionInsightPanel";

/* ─── Types ─────────────────────────────────────────────────────────────── */

/** A single stage node in the application pipeline. */
interface AppStage {
  name: string;
  status: "done" | "active" | "pending";
  completedAt: string | null;
}

/** One application record returned by the API. */
interface Application {
  id: string;
  jobId: string;
  jobTitle: string;
  department?: string;
  location: string;
  workType: string;
  appliedAt: string;
  currentStage: string;
  matchScore?: number | null;
  /** Array of pipeline stages, or "rejected" when the application is closed. */
  stages: AppStage[] | "rejected";
  status: "active" | "closed";
}

/* ─── Stage label map ────────────────────────────────────────────────────── */

/** Human-readable labels for internal stage slugs. */
const STAGE_LABEL: Record<string, string> = {
  sourced:              "Sourced",
  applied:              "Applied",
  shortlisted:          "Shortlisted",
  phone_screen:         "Phone Screen",
  verification:         "Verification",
  screening:            "Screening",
  interview:            "Interview",
  interview_scheduled:  "Interview Scheduled",
  interview_completed:  "Interview Completed",
  hm_review:            "Hiring Manager Review",
  assessment:           "Assessment",
  offer:                "Offer",
  hired:                "Hired",
  rejected:             "Not Progressed",
  withdrawn:            "Withdrawn",
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */

/**
 * Returns Tailwind classes for the pipeline stage dot based on its status.
 * done = filled primary, active = bordered primary, pending = muted border.
 */
const stageColor = (status: string) =>
  ({
    done:     "bg-primary border-primary text-white",
    active:   "bg-card border-primary",
    pending:  "bg-card border-border",
    rejected: "bg-card border-destructive/40",
  }[status] ?? "bg-card border-border");

/* ─── Page component ────────────────────────────────────────────────────── */

export default function PortalApplications() {
  const [applications, setApplications] = useState<Application[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);

  /* ── Human-review (appeal) dialog state ──────────────────────────────── */
  const [appealApp, setAppealApp] = useState<Application | null>(null);
  const [appealReason, setAppealReason] = useState("");
  const [appealSubmitting, setAppealSubmitting] = useState(false);
  const [appealError, setAppealError] = useState<string | null>(null);
  /** Application ids for which an appeal was filed this session. */
  const [appealedIds, setAppealedIds] = useState<Set<string>>(new Set());

  const submitAppeal = async () => {
    if (!appealApp || appealReason.trim().length < 8) return;
    setAppealSubmitting(true);
    setAppealError(null);
    try {
      const r = await apiFetch(`${apiBase}/appeals/${appealApp.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: appealReason.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error ?? `HTTP ${r.status}`);
      }
      setAppealedIds(prev => new Set(prev).add(appealApp.id));
      setAppealApp(null);
      setAppealReason("");
    } catch (e: any) {
      setAppealError(e?.message ?? "Could not submit your request. Please try again.");
    } finally {
      setAppealSubmitting(false);
    }
  };

  /* Fetch applications and candidateId on mount. */
  useEffect(() => {
    apiFetch(`${apiBase}/portal/applications`)
      .then(r => r.json())
      .then(res => {
        setApplications(res.data ?? []);
        setLoading(false);
      })
      .catch(() => {
        setError("Unable to load applications. Please try again.");
        setLoading(false);
      });

    apiFetch(`${apiBase}/portal/candidate/me`)
      .then(r => r.json())
      .then(res => { if (res.data?.id) setCandidateId(res.data.id); })
      .catch(() => {});
  }, []);

  return (
    <AppLayout>
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My Applications</h1>
        <p className="text-muted-foreground mt-1">
          Track the status of all your active applications.
        </p>
      </div>

      {/* Loading spinner */}
      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Error state */}
      {error && (
        <Card className="border-destructive/30">
          <CardContent className="flex items-center gap-3 py-6 text-destructive">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!loading && !error && applications.length === 0 && (
        <Card className="border-dashed border-border/50">
          <CardContent className="flex flex-col items-center justify-center py-20 gap-3 text-center">
            <Briefcase className="w-10 h-10 text-muted-foreground/40" />
            <p className="font-medium text-muted-foreground">No applications yet</p>
            <p className="text-sm text-muted-foreground/60 max-w-xs">
              Once you apply to roles through the Opportunity Engine, they'll appear here
              with real-time status tracking.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Application cards */}
      {!loading && !error && applications.length > 0 && (
        <div className="space-y-6">
          {applications.map(app => {
            const stages = app.stages === "rejected" ? null : app.stages;
            const badgeLabel = STAGE_LABEL[app.currentStage] ?? app.currentStage;
            const isRejected = app.stages === "rejected" || app.status === "closed";

            return (
              <Card key={app.id} className="hover-elevate border-border/60">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between">
                    {/* Job details */}
                    <div>
                      <CardTitle className="text-xl mb-1">{app.jobTitle}</CardTitle>
                      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                        {app.department && (
                          <span className="flex items-center gap-1">
                            <Briefcase className="w-3.5 h-3.5" /> {app.department}
                          </span>
                        )}
                        {app.location && (
                          <span className="flex items-center gap-1">
                            <MapPin className="w-3.5 h-3.5" /> {app.location}
                            {app.workType && ` (${app.workType.replace("_", " ")})`}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          Applied {formatDistanceToNow(parseISO(app.appliedAt), { addSuffix: true })}
                        </span>
                      </div>
                    </div>

                    {/* Badges + action */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* Stage badge — red for rejected, green for offer/hired, blue otherwise */}
                      <Badge
                        className={
                          isRejected
                            ? "bg-red-100 text-red-700 border-red-200 text-xs"
                            : app.currentStage === "hired" || app.currentStage === "offer"
                            ? "bg-emerald-100 text-emerald-700 border-emerald-200 text-xs"
                            : "bg-blue-100 text-blue-700 border-blue-200 text-xs"
                        }
                      >
                        {badgeLabel}
                      </Badge>

                      {/* AI match score (0–1 from API, displayed as %) */}
                      {app.matchScore != null && (
                        <Badge variant="outline" className="text-xs border-primary/30 text-primary">
                          {Math.round(app.matchScore * 100)}% match
                        </Badge>
                      )}

                      {/* Link to public job detail page */}
                      <Link href={`/careers/${app.jobId}`}>
                        <Button size="sm" variant="ghost" className="gap-1.5 text-xs">
                          Details <ChevronRight className="w-3.5 h-3.5" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </CardHeader>

                <CardContent>
                  {isRejected ? (
                    /* Rejected / closed — no pipeline; offer a human review */
                    <div className="py-4 px-3 rounded-lg bg-muted/30 text-sm text-muted-foreground">
                      <p>This application is no longer active.</p>
                      {appealedIds.has(app.id) ? (
                        <p className="mt-3 flex items-center gap-2 text-emerald-600">
                          <CheckCircle2 className="w-4 h-4" />
                          Human review requested — a reviewer will respond by email.
                        </p>
                      ) : (
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            onClick={() => { setAppealApp(app); setAppealReason(""); setAppealError(null); }}
                          >
                            <Scale className="w-3.5 h-3.5" /> Request human review
                          </Button>
                          <span className="text-xs text-muted-foreground/70">
                            If AI-assisted screening was used, you can ask a human reviewer to
                            re-examine this decision.
                          </span>
                        </div>
                      )}
                    </div>
                  ) : stages ? (
                    /* ── Pipeline tracker ──────────────────────────────────── */
                    <div className="relative py-6">
                      {/* Full-width background track line */}
                      <div className="absolute top-[22px] left-3 right-3 h-0.5 bg-border" />

                      {/* Primary-coloured progress fill up to the active stage */}
                      {(() => {
                        const activeIdx = stages.findIndex(s => s.status === "active");
                        const doneCount = activeIdx >= 0 ? activeIdx : stages.length;
                        const pct = stages.length > 1
                          ? (doneCount / (stages.length - 1)) * 100
                          : 0;
                        return (
                          <div
                            className="absolute top-[22px] left-3 h-0.5 bg-primary"
                            style={{ width: `${pct}%` }}
                          />
                        );
                      })()}

                      {/* Stage dots + labels */}
                      <div className="relative flex justify-between">
                        {stages.map((stage, i) => (
                          <div key={i} className="flex flex-col items-center gap-2">
                            {/* Stage dot */}
                            <div className={`w-6 h-6 rounded-full border-2 z-10 flex items-center justify-center shadow-sm ${stageColor(stage.status)}`}>
                              {stage.status === "done" && (
                                <span className="text-[8px] font-bold text-white">✓</span>
                              )}
                              {stage.status === "active" && (
                                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                              )}
                            </div>

                            {/* Stage label */}
                            <span className={`text-[10px] font-medium text-center leading-tight max-w-[60px] ${
                              stage.status === "active"  ? "text-primary font-bold" :
                              stage.status === "done"    ? "text-muted-foreground" :
                                                           "text-muted-foreground/40"
                            }`}>
                              {stage.name}
                            </span>

                            {/* Completion timestamp */}
                            {stage.completedAt && (
                              <span className="text-[9px] text-muted-foreground/60">
                                {formatDistanceToNow(parseISO(stage.completedAt), { addSuffix: true })}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {/* ── Candidate Connection Insight (active applications only) ─ */}
                  {candidateId && app.status === "active" && (
                    <div className="mt-4 pt-4 border-t border-border/40">
                      <CandidateConnectionInsightPanel
                        candidateId={candidateId}
                        jobId={app.jobId}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Request human review dialog ─────────────────────────────────── */}
      <Dialog open={!!appealApp} onOpenChange={(v) => { if (!v) setAppealApp(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Request a human review</DialogTitle>
            <DialogDescription>
              A human reviewer will re-examine the decision on your application
              {appealApp ? <> for <strong>{appealApp.jobTitle}</strong></> : null}, including any
              AI-assisted screening involved, and respond to you by email.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Textarea
              value={appealReason}
              onChange={(e) => setAppealReason(e.target.value)}
              placeholder="Tell us why you believe this decision should be reviewed (required, at least a sentence)…"
              className="resize-none h-28 text-sm"
              maxLength={4000}
            />
            {appealError && <p className="text-sm text-destructive">{appealError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAppealApp(null)}>Cancel</Button>
            <Button onClick={submitAppeal} disabled={appealReason.trim().length < 8 || appealSubmitting}>
              {appealSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Submit request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
