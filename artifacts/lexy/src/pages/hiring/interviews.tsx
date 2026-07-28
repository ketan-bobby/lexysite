/**
 * pages/hiring/interviews.tsx — Hiring Manager Interview Schedule
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Shows the hiring manager's upcoming and recent interviews: AI-conducted
 * sessions for candidates in their assigned jobs. They can view reports,
 * leave scores, and add calendar notes.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   UpcomingList    — sessions scheduled in the future; "View Details" link
 *   CompletedList   — sessions with reports; "View Report" + score input
 *   FeedbackDialog  — structured scoring: communication, technical, culture_fit
 *                     + free-text notes; saved to interview_reports.hmFeedback
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/interviews?hiringManagerId=<userId>
 *   POST /api/interviews/:id/hm-feedback — save hiring manager feedback
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /hiring/interviews
 */
import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Video, Calendar, Clock, User, Loader2, ArrowRight, Plus, Copy, Check } from "lucide-react";
import { Link } from "wouter";
import { apiFetch, apiBase } from "@/lib/api";
import { format, parseISO, isPast } from "date-fns";

const typeColors: Record<string, string> = {
  technical:  "bg-blue-500/10 text-blue-400 border-blue-500/25",
  behavioral: "bg-violet-500/10 text-violet-400 border-violet-500/25",
  cultural:   "bg-cyan-500/10 text-cyan-400 border-cyan-500/25",
  general:    "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
  final:      "bg-amber-500/10 text-amber-400 border-amber-500/25",
};

const BASE = (import.meta as any).env?.BASE_URL || "/";

export default function HiringInterviews() {
  const { toast } = useToast();
  const [interviews, setInterviews] = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [tab, setTab]               = useState<"upcoming" | "past">("upcoming");

  /* Schedule dialog state */
  const [showSchedule, setShowSchedule] = useState(false);
  const [step, setStep]                 = useState<"form" | "done">("form");
  const [submitting, setSubmitting]     = useState(false);
  const [generatedLink, setGeneratedLink] = useState("");
  const [copied, setCopied]               = useState(false);
  const [jobs, setJobs]                   = useState<any[]>([]);
  const [candidates, setCandidates]       = useState<any[]>([]);
  const [jobId, setJobId]                 = useState("");
  const [candidateId, setCandidateId]     = useState("");
  const [interviewType, setInterviewType] = useState("general");
  const [questionCount, setQuestionCount] = useState("5");

  async function loadInterviews() {
    setLoading(true);
    try {
      const r = await apiFetch(`${apiBase}/interviews`);
      const d: any = await r.json();
      setInterviews(Array.isArray(d) ? d : d.interviews ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadInterviews(); }, []);

  /* Load jobs + candidates when dialog opens */
  useEffect(() => {
    if (!showSchedule) return;
    (async () => {
      try {
        const [jr, cr] = await Promise.all([
          apiFetch(`${apiBase}/jobs`).then(r => r.json()),
          apiFetch(`${apiBase}/candidates?limit=200`).then(r => r.json()),
        ]);
        setJobs(jr.jobs ?? []);
        setCandidates(cr.candidates ?? []);
      } catch {
        toast({ title: "Failed to load form data", variant: "destructive" });
      }
    })();
  }, [showSchedule]);

  function openSchedule() {
    setStep("form");
    setGeneratedLink("");
    setJobId("");
    setCandidateId("");
    setInterviewType("general");
    setQuestionCount("5");
    setShowSchedule(true);
  }

  async function handleSchedule() {
    if (!jobId) { toast({ title: "Please select a job", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const r = await apiFetch(`${apiBase}/interviews/generate-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId,
          candidateId: candidateId || "demo",
          interviewType,
          questionCount: Number(questionCount),
          language: "en-US",
        }),
      });
      const data: any = await r.json();
      if (!r.ok) throw new Error(data.error || "Failed to schedule");
      const url = `${window.location.origin}${BASE}interviews/${data.sessionId}/room`;
      setGeneratedLink(url);
      setStep("done");
      loadInterviews();
    } catch (e: any) {
      toast({ title: "Error scheduling interview", description: e?.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  function handleCopy() {
    navigator.clipboard.writeText(generatedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "Link copied" });
  }

  const getWhen = (i: any) =>
    i.scheduledAt || i.startedAt || i.completedAt || i.createdAt || 0;
  const sorted = [...interviews].sort(
    (a, b) => new Date(getWhen(a)).getTime() - new Date(getWhen(b)).getTime()
  );
  const isPastInterview = (i: any) => {
    const status = (i.status || "").toLowerCase();
    if (status === "completed" || status === "cancelled" || status === "no_show") return true;
    if (status === "scheduled" || status === "in_progress" || status === "pending") return false;
    const when = i.scheduledAt || i.startedAt;
    return !!when && isPast(new Date(when));
  };
  const upcoming = sorted.filter((i: any) => !isPastInterview(i));
  const past     = sorted.filter((i: any) => isPastInterview(i)).reverse();
  const list     = tab === "upcoming" ? upcoming : past;

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Link href="/hiring/dashboard" className="text-sm text-muted-foreground hover:text-primary inline-flex items-center gap-1 mb-3">
              <ArrowRight className="w-4 h-4 rotate-180" /> Back to Dashboard
            </Link>
            <h1 className="text-2xl font-bold">Interviews</h1>
            <p className="text-muted-foreground text-sm mt-1">Interview schedule for your open roles.</p>
          </div>
          <Button onClick={openSchedule} className="gap-2 shadow-md shadow-primary/20">
            <Plus className="w-4 h-4" /> Schedule Interview
          </Button>
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
          <Card><CardContent className="py-16 text-center text-muted-foreground space-y-3">
            <Video className="w-12 h-12 mx-auto opacity-20" />
            <p className="font-medium">No {tab} interviews</p>
            {tab === "upcoming" && (
              <Button onClick={openSchedule} variant="outline" size="sm" className="gap-2 mt-2">
                <Plus className="w-3.5 h-3.5" /> Schedule Interview
              </Button>
            )}
          </CardContent></Card>
        ) : (
          <div className="space-y-3">
            {list.map((iv: any) => (
              <Card key={iv.id} className="hover:border-border/80 transition-colors">
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                    <Video className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-0.5">
                      <p className="font-medium text-sm">{iv.candidateName || "Candidate"}</p>
                      {iv.interviewType && (
                        <Badge variant="outline" className={`text-[10px] ${typeColors[iv.interviewType] || "text-muted-foreground"}`}>
                          {iv.interviewType}
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
                      {iv.totalQuestions && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />{iv.totalQuestions} questions
                        </span>
                      )}
                      {iv.interviewerName && (
                        <span className="flex items-center gap-1">
                          <User className="w-3 h-3" />{iv.interviewerName}
                        </span>
                      )}
                    </div>
                  </div>
                  <Badge variant="outline" className={
                    iv.status === "completed"
                      ? "text-emerald-400 border-emerald-500/25 bg-emerald-500/10"
                      : iv.status === "scheduled"
                      ? "text-blue-400 border-blue-500/25 bg-blue-500/10"
                      : "text-muted-foreground"
                  }>
                    {iv.status || "scheduled"}
                  </Badge>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Schedule Interview Dialog */}
      <Dialog open={showSchedule} onOpenChange={setShowSchedule}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{step === "form" ? "Schedule Interview" : "Interview Link Ready"}</DialogTitle>
          </DialogHeader>

          {step === "form" ? (
            <div className="space-y-4 pt-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Job</Label>
                <Select value={jobId} onValueChange={setJobId}>
                  <SelectTrigger><SelectValue placeholder="Select job" /></SelectTrigger>
                  <SelectContent>
                    {jobs.map(j => <SelectItem key={j.id} value={j.id}>{j.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Candidate (optional)</Label>
                <Select value={candidateId} onValueChange={setCandidateId}>
                  <SelectTrigger><SelectValue placeholder="Demo / anonymous" /></SelectTrigger>
                  <SelectContent>
                    {candidates.map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.firstName} {c.lastName}{c.email ? ` · ${c.email}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Type</Label>
                  <Select value={interviewType} onValueChange={setInterviewType}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="general">General</SelectItem>
                      <SelectItem value="technical">Technical</SelectItem>
                      <SelectItem value="behavioral">Behavioral</SelectItem>
                      <SelectItem value="cultural">Cultural</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Questions</Label>
                  <Select value={questionCount} onValueChange={setQuestionCount}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["3","5","7","10"].map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Button onClick={handleSchedule} disabled={submitting || !jobId} className="w-full gap-2">
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Generate Interview Link
              </Button>
            </div>
          ) : (
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted-foreground">
                Share this link with the candidate. The recruiter who originally added them will be notified.
              </p>
              <div className="flex gap-2 p-2 bg-muted/40 rounded-md border text-xs font-mono break-all">
                {generatedLink}
              </div>
              <div className="flex gap-2">
                <Button onClick={handleCopy} variant="outline" className="flex-1 gap-2">
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <Button onClick={() => setShowSchedule(false)} className="flex-1">Done</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
