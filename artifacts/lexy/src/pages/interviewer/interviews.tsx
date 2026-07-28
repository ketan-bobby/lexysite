/**
 * pages/interviewer/interviews.tsx — Interviewer Interview Queue
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Dashboard for the "interviewer" role — internal employees who conduct
 * in-person or video interviews as a second stage after the AI interview.
 * Shows their assigned candidate interviews, allows them to record scores,
 * and leave structured feedback.
 *
 * ─── Tabs ────────────────────────────────────────────────────────────────────
 *   My Queue      — assigned candidates awaiting interview (status=pending)
 *   Completed     — candidates who have been interviewed by this interviewer
 *
 * ─── Feedback form ───────────────────────────────────────────────────────────
 * Per-candidate structured scoring dialog:
 *   technical_score    — 1–5 rating
 *   communication      — 1–5 rating
 *   culture_fit        — 1–5 rating
 *   recommendation     — "advance" | "hold" | "reject"
 *   notes              — free-text interview notes
 * Saved via POST /api/interviews/:id/interviewer-feedback.
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/interviews?interviewerId=<userId>
 *   POST /api/interviews/:id/interviewer-feedback
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /interviewer/interviews  (default route for interviewer role)
 */
import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Video, Calendar, Clock, Star, ChevronRight, Loader2, User } from "lucide-react";
import { apiFetch, apiBase } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { format, parseISO, isPast } from "date-fns";
import { useToast } from "@workspace/react-hooks/use-toast";

const typeColors: Record<string, string> = {
  technical:  "bg-blue-500/10 text-blue-400 border-blue-500/25",
  behavioral: "bg-violet-500/10 text-violet-400 border-violet-500/25",
  cultural:   "bg-cyan-500/10 text-cyan-400 border-cyan-500/25",
  final:      "bg-amber-500/10 text-amber-400 border-amber-500/25",
};

interface FeedbackData {
  rating: number;
  notes: string;
}

export default function InterviewerInterviews() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [interviews, setInterviews] = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState<"upcoming" | "past">("upcoming");
  const [feedbackModal, setFeedbackModal] = useState<any | null>(null);
  const [feedback, setFeedback]     = useState<FeedbackData>({ rating: 0, notes: "" });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    apiFetch(`${apiBase}/interviews`)
      .then((d: any) => {
        const all = Array.isArray(d) ? d : d.interviews ?? [];
        // Filter to only interviews assigned to this interviewer
        const mine = all.filter((iv: any) =>
          iv.interviewerId === user?.id || iv.interviewerName === user?.name
        );
        setInterviews(mine);
      })
      .finally(() => setLoading(false));
  }, [user?.id]);

  const sorted = [...interviews].sort((a, b) =>
    new Date(a.scheduledAt || 0).getTime() - new Date(b.scheduledAt || 0).getTime()
  );
  const upcoming = sorted.filter((i: any) => i.scheduledAt && !isPast(new Date(i.scheduledAt)));
  const past     = sorted.filter((i: any) => !i.scheduledAt || isPast(new Date(i.scheduledAt))).reverse();
  const list     = tab === "upcoming" ? upcoming : past;

  async function submitFeedback() {
    if (!feedbackModal) return;
    if (feedback.rating === 0) {
      toast({ title: "Please select a rating", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch(`${apiBase}/interviews/${feedbackModal.id}/feedback`, {
        method: "POST",
        // Explicit Content-Type: without it the browser sends text/plain and
        // express.json() leaves req.body empty → validation rejects.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(feedback),
      });
      toast({ title: "Feedback submitted" });
      setInterviews(prev => prev.map(iv =>
        iv.id === feedbackModal.id ? { ...iv, feedbackRating: feedback.rating, feedbackNotes: feedback.notes } : iv
      ));
      setFeedbackModal(null);
      setFeedback({ rating: 0, notes: "" });
    } catch {
      toast({ title: "Failed to submit feedback", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  function openFeedback(iv: any) {
    setFeedbackModal(iv);
    setFeedback({ rating: iv.feedbackRating ?? 0, notes: iv.feedbackNotes ?? "" });
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">My Interviews</h1>
          <p className="text-muted-foreground text-sm mt-1">Interviews you've been assigned to conduct.</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 bg-muted/40 rounded-lg w-fit">
          {(["upcoming", "past"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all capitalize ${
                tab === t ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t} {t === "upcoming" ? `(${upcoming.length})` : `(${past.length})`}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : list.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center text-muted-foreground">
              <Video className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p className="font-medium">No {tab} interviews assigned to you</p>
              <p className="text-sm mt-1">A recruiter will notify you when you're scheduled for an interview.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {list.map((iv: any) => {
              const hasFeedback = iv.feedbackRating > 0;
              const isCompleted = iv.status === "completed" || (iv.scheduledAt && isPast(new Date(iv.scheduledAt)));
              return (
                <Card key={iv.id} className="hover:border-border/80 transition-colors">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                        <Video className="w-5 h-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <p className="font-medium text-sm">{iv.candidateName || "Candidate"}</p>
                          {iv.type && (
                            <Badge variant="outline" className={`text-[10px] ${typeColors[iv.type] || "text-muted-foreground"}`}>
                              {iv.type}
                            </Badge>
                          )}
                          {hasFeedback && (
                            <Badge variant="outline" className="text-emerald-400 border-emerald-500/25 bg-emerald-500/10 text-[10px]">
                              Feedback submitted
                            </Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                          {iv.scheduledAt && (
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {format(parseISO(iv.scheduledAt), "EEE, MMM d · h:mm a")}
                            </span>
                          )}
                          {iv.durationMinutes && (
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />{iv.durationMinutes} min
                            </span>
                          )}
                        </div>
                        {hasFeedback && (
                          <div className="mt-2 flex items-center gap-1">
                            {[1,2,3,4,5].map(n => (
                              <Star key={n} className={`w-3.5 h-3.5 ${n <= iv.feedbackRating ? "text-amber-400 fill-amber-400" : "text-muted-foreground"}`} />
                            ))}
                            {iv.feedbackNotes && <span className="text-xs text-muted-foreground ml-2 truncate">{iv.feedbackNotes}</span>}
                          </div>
                        )}
                      </div>
                      {isCompleted && !hasFeedback && (
                        <Button size="sm" variant="outline" className="gap-1.5 shrink-0" onClick={() => openFeedback(iv)}>
                          <Star className="w-3.5 h-3.5" /> Add Feedback
                        </Button>
                      )}
                      {isCompleted && hasFeedback && (
                        <Button size="sm" variant="ghost" className="gap-1.5 shrink-0 text-muted-foreground" onClick={() => openFeedback(iv)}>
                          Edit
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Feedback modal */}
      <Dialog open={!!feedbackModal} onOpenChange={(open) => !open && setFeedbackModal(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Submit Interview Feedback</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <p className="text-sm font-medium mb-1">Candidate</p>
              <p className="text-sm text-muted-foreground">{feedbackModal?.candidateName}</p>
            </div>
            <div>
              <Label className="mb-2 block">Overall Rating</Label>
              <div className="flex items-center gap-2">
                {[1,2,3,4,5].map(n => (
                  <button key={n} type="button" aria-label={`Rate ${n} of 5`} aria-pressed={feedback.rating === n} onClick={() => setFeedback(f => ({ ...f, rating: n }))}>
                    <Star className={`w-7 h-7 transition-colors ${n <= feedback.rating ? "text-amber-400 fill-amber-400" : "text-muted-foreground hover:text-amber-300"}`} />
                  </button>
                ))}
                <span className="text-sm text-muted-foreground ml-2">
                  {["", "Poor", "Fair", "Good", "Great", "Exceptional"][feedback.rating]}
                </span>
              </div>
            </div>
            <div>
              <Label htmlFor="notes" className="mb-2 block">Notes</Label>
              <Textarea
                id="notes"
                placeholder="Share your observations about this candidate…"
                value={feedback.notes}
                onChange={(e) => setFeedback(f => ({ ...f, notes: e.target.value }))}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFeedbackModal(null)}>Cancel</Button>
            <Button onClick={submitFeedback} disabled={submitting}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Submit Feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
