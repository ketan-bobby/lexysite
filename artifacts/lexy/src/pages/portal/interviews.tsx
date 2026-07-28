/**
 * interviews.tsx — Candidate portal "My Interviews" page.
 *
 * Fetches all interviews for the logged-in candidate from the API and
 * splits them into two tabs:
 *
 *  - Upcoming  — scheduled interviews whose time is still in the future
 *                (status: pending / confirmed).
 *  - Completed — past interviews that have concluded (with optional score
 *                + AI feedback).
 *
 * The candidate sees upcoming scheduled interviews and completed interviews
 * (recruiter screenings included), plus their own mock/practice sessions and
 * career baseline. RESULTS (score + feedback) are only shown for the candidate's
 * own interviews — recruiter scheduled/screening interviews show the interview
 * happened but withhold their results.
 */

import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { apiBase, apiFetch } from "@/lib/api";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Video, Calendar, Clock, Play, FileText, Star, AlertCircle, Loader2,
} from "lucide-react";
import { format, parseISO, isFuture } from "date-fns";

/* ─── Types ─────────────────────────────────────────────────────────────── */

/** Unified interview record returned by the API. */
interface Interview {
  id: string;
  jobTitle: string;
  department?: string | null;
  location?: string | null;
  type: string;
  status: string;
  scheduledAt: string;
  duration?: number | null;
  score?: number | null;
  feedback?: string | null;
  /**
   * "schedule" = recruiter-scheduled · "session" = recruiter AI screening
   * (results withheld) · "mock" = candidate's own practice · "baseline" =
   * candidate's career baseline. Results show only for "mock" / "baseline".
   */
  source: "schedule" | "session" | "mock" | "baseline";
}

/* ─── Type labels + colour maps ─────────────────────────────────────────── */

/** Human-readable display names for interview type slugs. */
const TYPE_LABELS: Record<string, string> = {
  technical:                      "Technical",
  behavioral:                     "Behavioral",
  portfolio:                      "Portfolio",
  culture_fit:                    "Culture Fit",
  ai_interview:                   "AI Interview",
  mock:                           "Mock / Practice",
  "AI Screening Interview":       "AI Screening",
  "Technical Interview - Round 2":"Technical Round 2",
};
const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

/** Tailwind colour classes for each interview type badge. */
const TYPE_COLORS: Record<string, string> = {
  technical:                      "bg-orange-100 text-orange-700 border-orange-200",
  behavioral:                     "bg-blue-100 text-blue-700 border-blue-200",
  portfolio:                      "bg-purple-100 text-purple-700 border-purple-200",
  culture_fit:                    "bg-green-100 text-green-700 border-green-200",
  ai_interview:                   "bg-cyan-100 text-cyan-700 border-cyan-200",
  mock:                           "bg-violet-100 text-violet-700 border-violet-200",
  "AI Screening Interview":       "bg-cyan-100 text-cyan-700 border-cyan-200",
  "Technical Interview - Round 2":"bg-orange-100 text-orange-700 border-orange-200",
};
const typeColor = (t: string) => TYPE_COLORS[t] ?? "bg-slate-100 text-slate-700 border-slate-200";

/* ─── Sub-components ─────────────────────────────────────────────────────── */

/**
 * Displays a numeric interview score (0–100) with a 5-star visual gauge.
 * Colour thresholds: ≥80 green, ≥65 cyan primary, else amber.
 */
// Interview-performance score band (0–100 interview result; own cutoffs, not the match/fit band).
const INTERVIEW_SCORE_STRONG = 80, INTERVIEW_SCORE_MODERATE = 65;
function ScoreGauge({ score }: { score: number }) {
  const color =
    score >= INTERVIEW_SCORE_STRONG ? "text-emerald-400" :
    score >= INTERVIEW_SCORE_MODERATE ? "text-primary"     :
                  "text-amber-400";

  return (
    <div className="flex items-center gap-2">
      <div className={`text-2xl font-black ${color}`}>{score}</div>
      <div>
        <div className="flex gap-0.5">
          {[1, 2, 3, 4, 5].map(i => (
            <Star
              key={i}
              className={`w-3 h-3 ${score >= i * 20 ? "fill-yellow-400 text-yellow-400" : "fill-muted text-muted"}`}
            />
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground">Score</p>
      </div>
    </div>
  );
}

/** Generic empty-state card shown when a tab has no interviews. */
function EmptyState({ message }: { message: string }) {
  return (
    <Card className="border-dashed border-border/50">
      <CardContent className="flex flex-col items-center justify-center py-16 gap-2 text-center">
        <Video className="w-8 h-8 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

/* ─── Page component ─────────────────────────────────────────────────────── */

export default function PortalInterviews() {
  const [scheduled, setScheduled] = useState<Interview[]>([]);
  const [completed, setCompleted] = useState<Interview[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  /* Fetch interviews on mount and split into upcoming vs completed. */
  useEffect(() => {
    apiFetch(`${apiBase}/portal/interviews`)
      .then(r => r.json())
      .then(res => {
        if (res.error) { setError(res.error); setLoading(false); return; }

        const allScheduled: Interview[] = res.data?.scheduled ?? [];
        const allCompleted: Interview[] = res.data?.completed ?? [];

        /* Upcoming = future time OR pending/confirmed status */
        const upcoming = allScheduled.filter(
          iv => isFuture(parseISO(iv.scheduledAt)) || iv.status === "pending" || iv.status === "confirmed"
        );

        /* Past scheduled sessions get merged into the completed tab */
        const pastScheduled = allScheduled.filter(
          iv => !isFuture(parseISO(iv.scheduledAt)) && iv.status !== "pending" && iv.status !== "confirmed"
        );

        setScheduled(upcoming);
        setCompleted(
          [...pastScheduled, ...allCompleted].sort(
            (a, b) => b.scheduledAt.localeCompare(a.scheduledAt)
          )
        );
        setLoading(false);
      })
      .catch(() => {
        setError("Unable to load interviews. Please try again.");
        setLoading(false);
      });
  }, []);

  return (
    <AppLayout>
      {/* Page header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My Interviews</h1>
        <p className="text-muted-foreground mt-1">
          View upcoming interviews and review your past performance.
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

      {/* Tabbed content (only rendered once data is ready) */}
      {!loading && !error && (
        <Tabs defaultValue="upcoming">
          <TabsList className="mb-6">
            <TabsTrigger value="upcoming" className="gap-2">
              <Calendar className="w-4 h-4" /> Upcoming
              {scheduled.length > 0 && (
                <Badge className="bg-primary/10 text-primary border-0 h-5 px-1.5 text-[10px]">
                  {scheduled.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="completed" className="gap-2">
              <FileText className="w-4 h-4" /> Completed
            </TabsTrigger>
          </TabsList>

          {/* ── Upcoming tab ───────────────────────────────────────────── */}
          <TabsContent value="upcoming">
            {scheduled.length === 0 ? (
              <EmptyState message="No upcoming interviews scheduled." />
            ) : (
              <div className="space-y-4">
                {scheduled.map(iv => (
                  <Card key={iv.id} className="hover-elevate border-primary/20">
                    <CardContent className="p-6">
                      <div className="flex items-center justify-between gap-4 flex-wrap">
                        {/* Interview info */}
                        <div className="flex items-center gap-4">
                          <div className="p-3 bg-primary text-white rounded-xl shadow-lg shadow-primary/20">
                            <Video className="w-6 h-6" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-bold text-lg">{iv.jobTitle}</h3>
                              <Badge className={`text-[10px] border ${typeColor(iv.type)}`}>
                                {typeLabel(iv.type)}
                              </Badge>
                            </div>
                            {iv.department && (
                              <p className="text-sm text-muted-foreground">{iv.department}</p>
                            )}
                            <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {format(parseISO(iv.scheduledAt), "EEEE, MMM d 'at' h:mm a")}
                              </span>
                              {iv.duration && (
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" />{iv.duration} minutes
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Actions: prep or join */}
                        <div className="flex gap-2">
                          <Link href="/portal/prep">
                            <Button variant="outline" className="gap-1.5">
                              Prep <Star className="w-3.5 h-3.5" />
                            </Button>
                          </Link>
                          <Link href={`/interviews/${iv.id}/room`}>
                            <Button className="gap-1.5 shadow-md shadow-primary/20">
                              <Play className="w-3.5 h-3.5" /> Join Interview
                            </Button>
                          </Link>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ── Completed tab ──────────────────────────────────────────── */}
          <TabsContent value="completed">
            {completed.length === 0 ? (
              <EmptyState message="No completed interviews yet." />
            ) : (
              <div className="space-y-4">
                {completed.map(iv => (
                  <Card key={iv.id} className="hover-elevate">
                    <CardContent className="p-6">
                      <div className="flex items-start justify-between gap-4">
                        {/* Interview info */}
                        <div className="flex items-center gap-4">
                          <div className="p-3 bg-muted text-muted-foreground rounded-xl">
                            <Video className="w-6 h-6" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-bold">{iv.jobTitle}</h3>
                              <Badge className={`text-[10px] border ${typeColor(iv.type)}`}>
                                {typeLabel(iv.type)}
                              </Badge>
                            </div>
                            {iv.department && (
                              <p className="text-sm text-muted-foreground">{iv.department}</p>
                            )}
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {format(parseISO(iv.scheduledAt), "MMMM d, yyyy")}
                            </p>
                          </div>
                        </div>

                        {/* Score gauge + results link — only for the candidate's
                            OWN interviews (mock/baseline). Recruiter screenings
                            withhold their results. */}
                        <div className="flex items-center gap-6">
                          {(iv.source === "mock" || iv.source === "baseline") ? (
                            <>
                              {iv.score != null && (
                                <div className="flex flex-col items-end gap-1">
                                  <ScoreGauge score={iv.score} />
                                  {/* Never a bare low number: a sub-threshold score is
                                      always paired with a growth-framed path forward. */}
                                  {iv.score < INTERVIEW_SCORE_MODERATE && (
                                    <p className="text-[10px] text-muted-foreground max-w-[200px] text-right leading-snug">
                                      Every interview is practice — your feedback shows exactly where the next points come from.
                                    </p>
                                  )}
                                </div>
                              )}
                              <Link href="/portal/career">
                                <Button
                                  variant={iv.score != null && iv.score < INTERVIEW_SCORE_MODERATE ? "default" : "outline"}
                                  className="gap-1.5"
                                >
                                  <FileText className="w-3.5 h-3.5" /> View Results
                                </Button>
                              </Link>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">
                              Results shared with the recruiter
                            </span>
                          )}
                        </div>
                      </div>

                      {/* AI feedback (shown when available) */}
                      {iv.feedback && (
                        <div className="mt-4 p-3 bg-muted/40 border border-border/40 rounded-xl">
                          <p className="text-xs font-semibold text-muted-foreground mb-1">Feedback</p>
                          <p className="text-sm text-muted-foreground leading-relaxed">{iv.feedback}</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </AppLayout>
  );
}
