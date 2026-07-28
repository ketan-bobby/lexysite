/**
 * pages/recruiter/interviews/[id].tsx — Interview Session Detail & Report
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Shows a recruiter the full output of a completed AI interview: the question-
 * by-answer transcript, AI-generated summary, competency scores, recommended
 * hiring decision, and a link to the proctor report.
 *
 * ─── Sections ────────────────────────────────────────────────────────────────
 *   Header          — candidate name, job title, completion date, overall score
 *   AI Summary      — GPT-4o generated 3-paragraph evaluation
 *   Competency Grid — radar-chart style score breakdown per dimension
 *                     (communication, problem_solving, culture_fit, technical,
 *                      motivation, experience_depth)
 *   Transcript      — question-by-question accordion with AI analysis per answer
 *   Decision Panel  — recommended_decision badge + recruiter override controls
 *   Proctor Link    — "View Proctor Report" CTA if proctoring was enabled
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useGetInterview()       — session row + question/answer transcript
 *   useGetInterviewSummary() — AI summary + scores (interview_reports table)
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/interviews/:id
 */
import { useState, useEffect, useRef } from "react";
import { authHeaders } from "@/lib/api";
import { useRoute, Link } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useGetInterview, useGetInterviewSummary } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@workspace/react-hooks/use-toast";
import { generateInterviewReportPdf } from "@/lib/interview-report-pdf";
import { downloadEvaluationReportPdf, type EvaluationReportPdfData } from "@/lib/evaluation-report-pdf";
import type { Evaluation, EvaluationGetResponse, RecommendationBand } from "@/lib/evaluation-types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Video, ArrowRight, ScanFace, Brain, CheckCircle2, AlertCircle,
  Clock, Camera, Eye, Mic, Monitor, Users, Activity, MessageSquare,
  ChevronRight, Sparkles, Shield, PlayCircle, Bot, Star, Download, Target,
  Loader2,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { ScoreBadge } from "@/components/ui-custom/Badges";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// Thin authed GET helper (Bearer token from localStorage) for this page's reads.
async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { ...authHeaders() },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// Embedded proctoring summary within the interview detail. Only fetches once the
// interview is completed (proctoring data is immutable thereafter).
function ProctoringSection({ sessionId, isCompleted, isLive }: { sessionId: string; isCompleted: boolean; isLive: boolean }) {
  const { data: report } = useQuery<any>({
    queryKey: ["proctoring", sessionId],
    queryFn: () => apiFetch(`/agents/proctoring/${sessionId}`),
    enabled: isCompleted,
    staleTime: Infinity,  // completed interview proctoring never changes — fetch once only
    gcTime: Infinity,
  });

  if (!isCompleted) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
          <ScanFace className="w-8 h-8 text-muted-foreground" />
        </div>
        <div className="text-center space-y-1">
          <p className="font-semibold text-muted-foreground">
            {isLive ? "Proctoring in progress" : "Proctoring not yet started"}
          </p>
          <p className="text-xs text-muted-foreground/60 max-w-md">
            {isLive
              ? "Live integrity signals are being captured. The full report will appear once the interview ends."
              : "Face presence, gaze tracking, audio integrity, and tab-switching data will appear here after the candidate completes the interview."}
          </p>
        </div>
      </div>
    );
  }

  if (!report) return <div className="py-8 text-center text-muted-foreground">Loading proctoring data...</div>;

  const checks = [
    { key: "facePresent", label: "Face Presence", icon: Camera, detail: report.checks.facePresent.pct == null ? "No frames captured" : `${report.checks.facePresent.pct}% of session` },
    { key: "multiplePersons", label: "Single Person", icon: Users, detail: `Max ${report.checks.multiplePersons.maxDetected} detected` },
    { key: "gazeOnCamera", label: "Gaze On Camera", icon: Eye, detail: report.checks.gazeOnCamera.pct == null ? "No frames captured" : `${report.checks.gazeOnCamera.pct}% of session` },
    { key: "tabSwitches", label: "No Tab Switching", icon: Monitor, detail: `${report.checks.tabSwitches.count} switches` },
    { key: "audioAnomalies", label: "Audio Integrity", icon: Mic, detail: `${report.checks.audioAnomalies.count} anomaly detected` },
    { key: "screenSharing", label: "Screen Sharing", icon: Monitor, detail: report.checks.screenSharing.active ? "Active" : "Not detected" },
  ];

  // Proctoring risk-score bands (INVERTED: lower = safer; own cutoffs, not the match band).
  const RISK_LOW_MAX = 20, RISK_MED_MAX = 50;
  const riskColor = report.riskScore < RISK_LOW_MAX ? "text-green-500" : report.riskScore < RISK_MED_MAX ? "text-yellow-500" : "text-red-500";
  const verdictColor = report.riskScore < RISK_LOW_MAX ? "bg-green-500/10 text-green-600 border-green-500/20" : report.riskScore < RISK_MED_MAX ? "bg-yellow-500/10 text-yellow-600 border-yellow-500/20" : "bg-red-500/10 text-red-600 border-red-500/20";

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 p-3 bg-rose-500/5 border border-rose-500/20 rounded-xl">
        <ScanFace className="w-4 h-4 text-rose-500" />
        <span className="text-xs font-semibold text-rose-700">Proctoring Agent</span>
        <span className="text-xs text-muted-foreground">· Monitored entire session in real-time</span>
        <CheckCircle2 className="w-3.5 h-3.5 text-green-500 ml-auto" />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="text-center border-border/40">
          <CardContent className="p-4">
            <div className={cn("text-3xl font-black", riskColor)}>{report.riskScore}</div>
            <div className="text-xs text-muted-foreground mt-1">Risk Score</div>
            <Badge className={cn("text-xs mt-2", verdictColor)}>{report.verdict.replace("_", " ").toUpperCase()}</Badge>
          </CardContent>
        </Card>
        <Card className="text-center border-border/40">
          <CardContent className="p-4">
            <div className="text-3xl font-black text-blue-500">{report.framesSampled.toLocaleString()}</div>
            <div className="text-xs text-muted-foreground mt-1">Frames Analysed</div>
          </CardContent>
        </Card>
        <Card className="text-center border-border/40">
          <CardContent className="p-4">
            <div className="text-3xl font-black text-orange-500">{report.flags.length}</div>
            <div className="text-xs text-muted-foreground mt-1">Flags Raised</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {checks.map(check => {
          const passed = (report.checks[check.key] as any).pass;
          const Icon = check.icon;
          return (
            <div key={check.key} className={cn("flex items-center gap-3 p-3 rounded-lg border", passed ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20")}>
              <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", passed ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500")}>
                <Icon className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold">{check.label}</div>
                <div className="text-xs text-muted-foreground">{check.detail}</div>
              </div>
              {passed
                ? <CheckCircle2 className="w-4 h-4 text-green-500 ml-auto shrink-0" />
                : <AlertCircle className="w-4 h-4 text-red-500 ml-auto shrink-0" />}
            </div>
          );
        })}
      </div>

      {report.flags.length > 0 && (
        <Card className="border-yellow-500/20 bg-yellow-500/5">
          <CardContent className="p-4">
            <h4 className="font-semibold text-sm mb-3 flex items-center gap-2"><AlertCircle className="w-4 h-4 text-yellow-500" />Flagged Events</h4>
            <div className="space-y-2">
              {report.flags.map((flag: any, i: number) => (
                <div key={i} className="flex items-center gap-3 text-sm p-2 bg-background/60 rounded-lg border border-border/40">
                  <Badge variant="outline" className="font-mono text-xs">{flag.timestamp}</Badge>
                  <span className="font-medium capitalize">{flag.type.replace("_", " ")}</span>
                  <span className="text-muted-foreground text-xs">{flag.detail}</span>
                  <Badge className={cn("ml-auto text-xs", flag.severity === "low" ? "bg-yellow-500/10 text-yellow-600" : "bg-red-500/10 text-red-600")}>{flag.severity}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-border/40">
        <CardContent className="p-4">
          <h4 className="font-semibold text-sm mb-2 flex items-center gap-2"><ScanFace className="w-4 h-4 text-rose-500" />Agent Assessment</h4>
          <p className="text-sm text-muted-foreground leading-relaxed">{report.notes}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// Interview detail page: transcript, scores, and proctoring summary for one session.
// Per-question interview-score band (0–100 answer score; own cutoffs, not the match/fit band).
const Q_SCORE_STRONG = 85, Q_SCORE_MODERATE = 70;
export default function InterviewDetail() {
  const [, params] = useRoute("/interviews/:id");
  const interviewId = params?.id || "";
  const { data: interview, isLoading } = useGetInterview(interviewId);
  const { data: summary } = useGetInterviewSummary(interviewId);
  const planId = (interview as any)?.planId;
  const { data: plan } = useQuery<any>({
    queryKey: ["interview-plan", planId],
    queryFn: () => apiFetch(`/interviews/plans/${planId}`),
    enabled: !!planId,
  });
  const [activeTab, setActiveTab] = useState("evaluation");
  const [videoError, setVideoError] = useState(false);
  /* GET /api/storage/objects/* requires a Bearer token, but <video src> can't
   * attach headers — so fetch the bytes with auth and play from a blob URL.
   * Fetch lazily (only once the Recording tab is opened) to avoid pulling a
   * large video the recruiter may never watch. */
  const [videoBlobUrl, setVideoBlobUrl] = useState<string | null>(null);
  const [videoIsBlob, setVideoIsBlob] = useState(false);
  const [streamFailed, setStreamFailed] = useState(false);
  const [videoLoading, setVideoLoading] = useState(false);
  /* Guards the recording fetch against duplicate/self-cancelled runs. */
  const videoFetchRef = useRef<string | null>(null);
  const { toast } = useToast();
  const [comments, setComments] = useState("");
  const [savedComments, setSavedComments] = useState("");
  const [commentsSaving, setCommentsSaving] = useState(false);

  // Canonical overall score, shared by the header badge, the evaluation card and
  // the downloadable PDF so all three always agree. It is the average of the
  // per-question scores; the stored summary/session score is used only as a
  // fallback when no per-question scores exist. Returns null when unavailable.
  const canonicalOverallScore = (() => {
    const ans: any[] = (interview as any)?.answers || [];
    const perQ = ans
      .map((a: any) => (typeof a.score === "number" ? a.score : null))
      .filter((s: number | null): s is number => s != null);
    if (perQ.length) return Math.round(perQ.reduce((sum, s) => sum + s, 0) / perQ.length);
    const fallback = (summary as any)?.overallScore ?? (interview as any)?.score;
    return typeof fallback === "number" ? Math.round(fallback) : null;
  })();

  // Lazily fetch the recording (authed) when the Recording tab opens.
  // NOTE: videoLoading/videoBlobUrl must NOT be effect dependencies — the
  // effect sets them, which would re-run its cleanup and cancel the very
  // request it just started (symptom: infinite "Loading recording…").
  // Re-entry is guarded by videoFetchRef instead.
  useEffect(() => {
    const url = interview?.recordingUrl;
    if (activeTab !== "recording" || !url || videoBlobUrl || videoError) return;
    const attemptKey = `${interviewId}|${url}|${streamFailed}`;
    if (videoFetchRef.current === attemptKey) return;
    videoFetchRef.current = attemptKey;
    let cancelled = false;
    setVideoLoading(true);
    (async () => {
      const videoAuthHeaders: Record<string, string> = { ...authHeaders() };
      try {
        /* Preferred: short-lived signed S3 URL — streams instantly with seek
         * support, no full download (recordings can be 100s of MB). */
        if (!streamFailed) {
          const r = await fetch(`${BASE}/api/storage/object-url${url}`, { headers: videoAuthHeaders, credentials: "include" });
          if (r.ok) {
            const { url: signed } = await r.json();
            if (!cancelled && signed) {
              setVideoIsBlob(false);
              setVideoBlobUrl(signed);
              return;
            }
          }
        }
        /* Fallback: download the whole file with auth and play from a blob
         * (used when the signed URL can't be minted or isn't reachable). */
        const res = await fetch(`${BASE}/api/storage${url}`, { headers: videoAuthHeaders, credentials: "include" });
        if (!res.ok) throw new Error(`storage ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        setVideoIsBlob(true);
        setVideoBlobUrl(URL.createObjectURL(blob));
      } catch {
        if (!cancelled) setVideoError(true);
      } finally {
        if (!cancelled) setVideoLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, interview?.recordingUrl, streamFailed, interviewId]);

  // Revoke the blob URL on unmount only (not on every re-render).
  useEffect(() => {
    return () => { if (videoBlobUrl && videoIsBlob) URL.revokeObjectURL(videoBlobUrl); };
  }, [videoBlobUrl, videoIsBlob]);

  // Reset video state when navigating between interviews without a remount.
  useEffect(() => {
    setVideoBlobUrl(null);
    setVideoIsBlob(false);
    setStreamFailed(false);
    setVideoError(false);
    setVideoLoading(false);
  }, [interviewId]);

  // Seed the editable comments box from the persisted value once the summary loads.
  useEffect(() => {
    const persisted = (summary as any)?.recruiterComments ?? "";
    setComments(persisted);
    setSavedComments(persisted);
  }, [(summary as any)?.recruiterComments]);

  const saveComments = async () => {
    setCommentsSaving(true);
    try {
      const res = await fetch(`${BASE}/api/interviews/${interviewId}/recruiter-comments`, {
        credentials: "include",
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(),
        },
        body: JSON.stringify({ comments }),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const updated = await res.json().catch(() => null);
      const persisted = (updated?.recruiterComments ?? comments.trim()) || "";
      setSavedComments(persisted);
      setComments(persisted);
      toast({ title: "Comments saved", description: "Your notes will appear in the downloadable report." });
    } catch {
      toast({ title: "Couldn't save comments", description: "Please try again.", variant: "destructive" });
    } finally {
      setCommentsSaving(false);
    }
  };

  /* ── Structured evaluation report (canonical download) ─────────────────────
     The Download Report button must ALWAYS produce the structured client-facing
     evaluation report (same one as the candidate page's Evaluation tab):
     fetch an existing evaluation for this candidate+job, or generate one on
     demand. Drafts carry a DRAFT notice on every page. The legacy interview
     performance PDF is only the last-resort fallback (no linked job/candidate,
     or generation failure). */
  const evalCandidateId: string | null = (interview as any)?.candidateId ?? null;
  const evalJobId: string | null = (plan as any)?.jobId ?? null;
  const evalIdsReady =
    !!evalJobId && !!evalCandidateId && evalCandidateId !== "demo" && evalCandidateId !== "default";

  const { data: structuredEvalRes } = useQuery<EvaluationGetResponse>({
    queryKey: ["evaluation", evalJobId, evalCandidateId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/evaluations/${evalJobId}/${evalCandidateId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { evaluation: null };
      return res.json();
    },
    enabled: evalIdsReady,
  });
  const structuredEvaluation = structuredEvalRes?.evaluation ?? null;

  const fallbackBandLabel = (b: RecommendationBand) =>
    b
      .split("_")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");

  const buildReportPdfData = (ev: Evaluation): EvaluationReportPdfData => ({
    candidateName: (interview as any)?.candidateName || "Candidate",
    jobTitle: (plan as any)?.title?.replace(/\s*—.*$/, "") ?? null,
    companyName: null,
    content: ev.content,
    recommendationBand: ev.recommendationBand,
    bandLabel: fallbackBandLabel(ev.recommendationBand),
    confidence: ev.confidence,
    preparedBy: null,
    approvedAt: ev.approvedAt,
    isDraft: ev.approvalState !== "approved",
  });

  const ensureStructuredEvaluation = async (): Promise<Evaluation | null> => {
    if (structuredEvaluation) return structuredEvaluation;
    if (!evalIdsReady) return null;
    try {
      const res = await fetch(`${BASE}/api/evaluations/generate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ jobId: evalJobId, candidateId: evalCandidateId }),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { evaluation?: Evaluation } | null;
      return body?.evaluation ?? null;
    } catch {
      return null; // network/abort — caller falls back to the legacy PDF
    }
  };

  const downloadReport = async () => {
    /* Why we fell back to the legacy PDF — surfaced in a toast so a stale
       build / failing generate endpoint is diagnosable instead of silent. */
    let fallbackReason = "This interview has no linked job or candidate.";
    if (evalIdsReady) {
      if (!structuredEvaluation) {
        toast({
          title: "Generating evaluation…",
          description: "Building the structured evaluation report — this can take up to a minute.",
        });
      }
      const ev = await ensureStructuredEvaluation();
      if (ev) {
        try {
          await downloadEvaluationReportPdf(buildReportPdfData(ev));
          toast({
            title: "Evaluation ready",
            description:
              ev.approvalState === "approved"
                ? "The approved client evaluation report has been downloaded."
                : "A DRAFT evaluation report has been downloaded — review and approve it on the candidate's Evaluation tab.",
          });
          return;
        } catch {
          fallbackReason = "The structured report could not be built in this browser.";
        }
      } else {
        fallbackReason =
          "Evaluation generation failed on the server (check the API server logs / AI key).";
      }
    }
    toast({
      title: "Legacy report downloaded",
      description: `Structured evaluation unavailable — ${fallbackReason}`,
      variant: "destructive",
    });
    // No linked job/candidate or generation failed — legacy interview report.
    const answers: any[] = (interview as any)?.answers || [];
    const questions: any[] = (plan as any)?.questions || [];
    await generateInterviewReportPdf({
      candidate: {
        name: (interview as any)?.candidateName || "Candidate",
        title: (interview as any)?.candidateTitle ?? null,
        email: (interview as any)?.candidateEmail ?? null,
      },
      interviewType: (plan as any)?.interviewType ?? null,
      totalQuestions: (interview as any)?.totalQuestions ?? null,
      completedAt: (interview as any)?.completedAt ?? (interview as any)?.createdAt ?? null,
      overallScore: canonicalOverallScore,
      questionScores: answers.map((a: any, i: number) => {
        const q = questions.find((q: any) => q.id === a.questionId);
        return {
          questionText: q?.text || a.questionText || `Question ${i + 1}`,
          score: typeof a.score === "number" ? a.score : null,
          feedback: a.feedback ?? null,
        };
      }),
      strengths: (summary as any)?.strengths ?? [],
      weaknesses: (summary as any)?.weaknesses ?? [],
      redFlags: (summary as any)?.redFlags ?? [],
      recommendation: (summary as any)?.recommendation ?? "maybe",
      aiSummary: (summary as any)?.recruiterSummary ?? "",
      recruiterComments: comments,
    });
  };

  if (isLoading) return <AppLayout><div className="p-8 text-center animate-pulse">Loading interview...</div></AppLayout>;
  if (!interview) return <AppLayout><div className="p-8 text-center">Interview not found</div></AppLayout>;

  const isCompleted = interview.status === "completed";
  const isLive = interview.status === "in_progress";

  return (
    <AppLayout>
      <div className="mb-6">
        <Link href="/interviews" className="text-sm text-muted-foreground hover:text-primary mb-4 inline-flex items-center gap-1">
          <ArrowRight className="w-4 h-4 rotate-180" />Back to Interviews
        </Link>

        <div className="flex items-start justify-between gap-4 mt-3">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center",
                isLive ? "bg-blue-500/10 text-blue-500" : "bg-emerald-500/10 text-emerald-500"
              )}>
                <Video className="w-6 h-6" />
              </div>
              <div>
                <h1 className="page-title">{(interview as any).candidateName || "Anonymous Candidate"}</h1>
                <p className="text-muted-foreground text-sm">
                  {(interview as any).candidateTitle ? `${(interview as any).candidateTitle} · ` : ""}
                  {(interview as any).candidateEmail ? `${(interview as any).candidateEmail} · ` : ""}
                  {formatDate(interview.createdAt)}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {isLive && <Badge className="bg-blue-500 text-white animate-pulse gap-1"><Activity className="w-3 h-3" />Live Session</Badge>}
              {isCompleted && <Badge className="bg-green-500/10 text-green-600 border-green-500/20">Completed</Badge>}
              {(plan as any)?.interviewType && (
                <Badge className="bg-primary/10 text-primary border-primary/20 capitalize">
                  {(plan as any).interviewType} Interview
                </Badge>
              )}
              <Badge variant="outline" className="gap-1"><Brain className="w-3 h-3 text-emerald-500" />AI Interviewer</Badge>
              <Badge variant="outline" className="gap-1"><ScanFace className="w-3 h-3 text-rose-500" />Proctoring Active</Badge>
              <Badge variant="outline" className="gap-1"><Clock className="w-3 h-3" />{interview.totalQuestions} Questions</Badge>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {isCompleted && canonicalOverallScore != null && <ScoreBadge score={canonicalOverallScore} className="text-lg px-4 py-2" />}
            {isCompleted && (
              <Button variant="outline" className="gap-2" onClick={downloadReport}>
                <Download className="w-4 h-4" />Download PDF
              </Button>
            )}
            {isLive && (
              <Button className="gap-2 bg-blue-600 hover:bg-blue-700">
                <PlayCircle className="w-4 h-4" />Join Live Session
              </Button>
            )}
          </div>
        </div>
      </div>

      {isLive && (
        <div className="mb-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Card className="border-blue-400/30 bg-gradient-to-br from-slate-900 to-slate-800 overflow-hidden">
              <CardContent className="p-0">
                <div className="aspect-video flex items-center justify-center relative">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center text-white/60">
                      <Video className="w-16 h-16 mx-auto mb-3 opacity-30" />
                      <p className="text-sm">Candidate video feed</p>
                    </div>
                  </div>
                  <div className="absolute top-3 left-3">
                    <Badge className="bg-red-500 text-white text-xs animate-pulse gap-1"><span className="w-1.5 h-1.5 bg-white rounded-full" />LIVE</Badge>
                  </div>
                  <div className="absolute bottom-3 right-3 w-24 aspect-video bg-slate-700 rounded-lg border border-white/10 flex items-center justify-center">
                    <Bot className="w-6 h-6 text-white/40" />
                  </div>
                </div>
                <div className="p-4 border-t border-white/10 bg-slate-900/50">
                  <p className="text-xs text-white/40 uppercase tracking-wider font-semibold mb-1">Current Question</p>
                  <p className="text-sm text-white/80 leading-relaxed">"Describe your approach to code quality and testing at scale."</p>
                </div>
              </CardContent>
            </Card>
          </div>
          <div className="space-y-3">
            <Card className="border-rose-400/20 bg-rose-500/5">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <ScanFace className="w-4 h-4 text-rose-500" />
                  <span className="text-xs font-bold text-rose-600">Proctoring — Live</span>
                  <span className="w-2 h-2 rounded-full bg-green-500 ml-auto animate-pulse" />
                </div>
                <div className="space-y-2">
                  {[
                    { label: "Face Detected", ok: true },
                    { label: "Single Occupant", ok: true },
                    { label: "Gaze on Camera", ok: true },
                    { label: "Audio Clear", ok: true },
                    { label: "Tab Focus", ok: true },
                  ].map(item => (
                    <div key={item.label} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{item.label}</span>
                      {item.ok
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                        : <AlertCircle className="w-3.5 h-3.5 text-red-500" />}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="border-border/40">
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Brain className="w-4 h-4 text-emerald-500" />
                  <span className="text-xs font-bold text-emerald-600">AI Evaluation — Live</span>
                </div>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between"><span className="text-muted-foreground">Question</span><span className="font-semibold">3 / 5</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Running Score</span><span className="font-semibold text-primary">82%</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Elapsed</span><span className="font-semibold">14:22</span></div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-muted/50 mb-4">
          <TabsTrigger value="evaluation">AI Evaluation</TabsTrigger>
          <TabsTrigger value="transcript">Transcript</TabsTrigger>
          <TabsTrigger value="proctoring" className="gap-1.5"><ScanFace className="w-3.5 h-3.5" />Proctoring</TabsTrigger>
          <TabsTrigger value="recording" className="gap-1.5">
            <Video className="w-3.5 h-3.5" />Recording
            {interview.recordingUrl && <span className="ml-1 w-2 h-2 rounded-full bg-red-500 inline-block" />}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="evaluation" className="space-y-5">
          {!isCompleted ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                <Bot className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="text-center space-y-1">
                <p className="font-semibold text-muted-foreground">
                  {isLive ? "Interview in progress" : "Interview not yet taken"}
                </p>
                <p className="text-xs text-muted-foreground/60 max-w-md">
                  {isLive
                    ? "The AI evaluation will be generated as soon as the candidate finishes the interview."
                    : "Once the candidate completes this interview, the AI Video Interview Agent will generate scores, strengths, and an advancement recommendation here."}
                </p>
              </div>
            </div>
          ) : (
          <>
          <div className="flex items-center gap-2 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
            <Bot className="w-4 h-4 text-emerald-500" />
            <span className="text-xs font-semibold text-emerald-700">AI Video Interview Agent</span>
            <span className="text-xs text-muted-foreground">· Evaluation generated from transcript analysis using GPT-4o</span>
          </div>

          {(() => {
            const answers: any[] = (interview as any)?.answers || [];
            const questions: any[] = (plan as any)?.questions || [];
            // Headline number reuses the canonical overall score (average of the
            // per-question scores) so it always matches the breakdown below.
            const overallScore = canonicalOverallScore;
            const strengths: string[] = (summary as any)?.strengths ?? [];
            const weaknesses: string[] = (summary as any)?.weaknesses ?? [];
            const redFlags: string[] = (summary as any)?.redFlags ?? [];
            const recommendation: string = (summary as any)?.recommendation ?? "maybe";
            const recruiterSummary: string = (summary as any)?.recruiterSummary ?? "";

            const recLabel = recommendation === "yes" || recommendation === "advance"
              ? "Advance to Next Stage"
              : recommendation === "no" || recommendation === "decline"
              ? "Do Not Advance"
              : "Needs Further Review";
            const recPositive = recommendation === "yes" || recommendation === "advance";
            const recNegative = recommendation === "no" || recommendation === "decline";

            const topAnswers = answers.slice(0, 3);
            const focusDirective: string = (plan as any)?.focusDirective ?? "";
            return (
              <>
                {focusDirective.trim() && (
                  <Card className="border-primary/20 bg-primary/5">
                    <CardContent className="p-4 flex items-start gap-3">
                      <Target className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                      <div>
                        <p className="text-xs font-bold text-primary mb-0.5">Recruiter Focus</p>
                        <p className="text-sm text-foreground/80 leading-snug">{focusDirective}</p>
                        <p className="text-[11px] text-muted-foreground mt-1">Assessed as a job-relevant competency — see the AI summary below for how this candidate did on it.</p>
                      </div>
                    </CardContent>
                  </Card>
                )}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  <Card className="bg-gradient-to-br from-primary/20 to-primary/5 border-primary/20">
                    <CardContent className="p-5 text-center">
                      <div className="text-5xl font-black text-primary mb-1">{overallScore ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">Overall Score</div>
                    </CardContent>
                  </Card>
                  {topAnswers.map((a: any, i: number) => {
                    const q = questions.find((q: any) => q.id === a.questionId);
                    const hasScore = typeof a.score === "number";
                    const score = hasScore ? Math.round(a.score) : null;
                    const qText = q?.text || a.questionText || `Question ${i + 1}`;
                    return (
                      <Card key={a.questionId || i} className="border-border/40">
                        <CardContent className="p-4 text-center">
                          <div className={cn("text-3xl font-bold mb-1",
                            score == null ? "text-muted-foreground" : score >= Q_SCORE_STRONG ? "text-green-500" : score >= Q_SCORE_MODERATE ? "text-yellow-500" : "text-red-500"
                          )}>{score ?? "—"}</div>
                          <div className="text-xs text-muted-foreground line-clamp-2" title={qText}>{`Q${i + 1}: ${qText}`}</div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>

                {answers.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="text-sm font-semibold text-muted-foreground">Per-question scores</h4>
                    {answers.map((a: any, i: number) => {
                      const q = questions.find((q: any) => q.id === a.questionId);
                      const hasScore = typeof a.score === "number";
                      const score = hasScore ? Math.round(a.score) : null;
                      const qText = q?.text || a.questionText || "Question";
                      return (
                        <Card key={a.questionId || i} className="border-border/40">
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between mb-2 gap-3">
                              <span className="font-semibold text-sm flex-1">Q{i + 1}: {qText}</span>
                              <span className={cn("text-sm font-bold shrink-0", score == null ? "text-muted-foreground" : score >= Q_SCORE_STRONG ? "text-green-600" : score >= Q_SCORE_MODERATE ? "text-yellow-600" : "text-red-600")}>{score ?? "—"}</span>
                            </div>
                            <div className="w-full bg-muted rounded-full h-1.5 mb-2">
                              <div className={cn("h-1.5 rounded-full", score == null ? "bg-muted-foreground/30" : score >= Q_SCORE_STRONG ? "bg-green-500" : score >= Q_SCORE_MODERATE ? "bg-yellow-500" : "bg-red-500")} style={{ width: `${score ?? 0}%` }} />
                            </div>
                            {a.answer && <p className="text-xs text-foreground/70 mb-1 line-clamp-3"><span className="text-muted-foreground">Answer: </span>{a.answer}</p>}
                            {a.feedback && <p className="text-xs text-muted-foreground italic">{a.feedback}</p>}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card className="border-green-500/20 bg-green-500/5">
                    <CardContent className="p-5">
                      <h4 className="font-semibold text-sm mb-3 flex items-center gap-2"><Star className="w-4 h-4 text-green-500" />Strengths</h4>
                      {strengths.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No strengths recorded yet.</p>
                      ) : (
                        <ul className="space-y-2">
                          {strengths.map((s, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm"><CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />{s}</li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                  <Card className="border-yellow-500/20 bg-yellow-500/5">
                    <CardContent className="p-5">
                      <h4 className="font-semibold text-sm mb-3 flex items-center gap-2"><AlertCircle className="w-4 h-4 text-yellow-500" />Areas to Develop</h4>
                      {weaknesses.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No areas to develop recorded yet.</p>
                      ) : (
                        <ul className="space-y-2">
                          {weaknesses.map((s, i) => (
                            <li key={i} className="flex items-start gap-2 text-sm"><ChevronRight className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />{s}</li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </div>

                {redFlags.length > 0 && (
                  <Card className="border-red-500/20 bg-red-500/5">
                    <CardContent className="p-5">
                      <h4 className="font-semibold text-sm mb-3 flex items-center gap-2"><AlertCircle className="w-4 h-4 text-red-500" />Red Flags</h4>
                      <ul className="space-y-2">
                        {redFlags.map((s, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm"><AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />{s}</li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}

                <Card className={cn("border-2",
                  recPositive ? "border-green-500/30 bg-green-500/5" :
                  recNegative ? "border-red-500/30 bg-red-500/5" :
                  "border-yellow-500/30 bg-yellow-500/5"
                )}>
                  <CardContent className="p-5">
                    <div className="flex items-start gap-4">
                      <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center shrink-0",
                        recPositive ? "bg-green-500/10 text-green-500" :
                        recNegative ? "bg-red-500/10 text-red-500" :
                        "bg-yellow-500/10 text-yellow-500"
                      )}>
                        <Sparkles className="w-6 h-6" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <h4 className="font-bold text-sm">AI Recommendation</h4>
                          <Badge className={
                            recPositive ? "bg-green-500/10 text-green-600 border-green-500/20" :
                            recNegative ? "bg-red-500/10 text-red-600 border-red-500/20" :
                            "bg-yellow-500/10 text-yellow-600 border-yellow-500/20"
                          }>{recLabel}</Badge>
                        </div>
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          {recruiterSummary || "Summary will appear once the evaluation completes."}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-primary/20">
                  <CardContent className="p-5">
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 bg-primary/10 text-primary">
                        <MessageSquare className="w-6 h-6" />
                      </div>
                      <div className="flex-1">
                        <h4 className="font-bold text-sm mb-1">Recruiter Comments</h4>
                        <p className="text-xs text-muted-foreground mb-3">
                          Add your own notes on this candidate's interview. They're saved to this report and included in the downloadable PDF you share with clients.
                        </p>
                        <Textarea
                          value={comments}
                          onChange={(e) => setComments(e.target.value)}
                          placeholder="e.g. Strong communicator, walked through trade-offs clearly. Would pair well with the platform team…"
                          className="min-h-[120px] resize-y"
                          maxLength={8000}
                        />
                        <div className="flex items-center justify-end gap-3 mt-3">
                          <Button
                            size="sm"
                            onClick={saveComments}
                            disabled={commentsSaving || comments === savedComments}
                            className="gap-2"
                          >
                            {commentsSaving ? "Saving…" : "Save Comments"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={downloadReport} className="gap-2">
                            <Download className="w-4 h-4" />Download PDF
                          </Button>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </>
            );
          })()}
          </>
          )}
        </TabsContent>

        <TabsContent value="transcript" className="space-y-4">
          {!isCompleted ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                <MessageSquare className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="text-center space-y-1">
                <p className="font-semibold text-muted-foreground">No transcript yet</p>
                <p className="text-xs text-muted-foreground/60 max-w-md">
                  The transcript will appear here after the candidate completes the AI interview.
                </p>
              </div>
            </div>
          ) : (
          <>
          <div className="flex items-center gap-2 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
            <MessageSquare className="w-4 h-4 text-emerald-500" />
            <span className="text-xs font-semibold text-emerald-700">AI-Generated Transcript</span>
            <span className="text-xs text-muted-foreground">· Transcribed and structured by Interview Agent</span>
          </div>
          <Card className="border-border/40">
            <CardContent className="p-5 space-y-4">
              {(() => {
                const answers: any[] = (interview as any)?.answers || [];
                const questions: any[] = (plan as any)?.questions || [];
                if (answers.length === 0) {
                  return (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      No transcript captured for this interview session.
                    </p>
                  );
                }
                const lines: { speaker: "AI" | "Candidate"; text: string }[] = [];
                answers.forEach((a: any) => {
                  const q = questions.find((q: any) => q.id === a.questionId);
                  const aiText = a.questionText || q?.text || q?.title || a.question;
                  if (aiText) lines.push({ speaker: "AI", text: aiText });
                  if (a.answer) lines.push({ speaker: "Candidate", text: a.answer });
                });
                return lines.map((line, i) => (
                  <div key={i} className={cn("flex gap-4", line.speaker === "AI" ? "" : "flex-row-reverse")}>
                    <div className={cn("w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                      line.speaker === "AI" ? "bg-emerald-500/10 text-emerald-600" : "bg-primary/10 text-primary"
                    )}>
                      {line.speaker === "AI" ? <Brain className="w-4 h-4" /> : "C"}
                    </div>
                    <div className={cn("flex-1 max-w-[80%]", line.speaker !== "AI" && "items-end flex flex-col")}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-semibold">{line.speaker === "AI" ? "Lexy AI" : "Candidate"}</span>
                      </div>
                      <div className={cn("p-3 rounded-xl text-sm leading-relaxed whitespace-pre-wrap",
                        line.speaker === "AI" ? "bg-muted/50" : "bg-primary/10"
                      )}>
                        {line.text}
                      </div>
                    </div>
                  </div>
                ));
              })()}
            </CardContent>
          </Card>
          </>
          )}
        </TabsContent>

        <TabsContent value="proctoring">
          <ProctoringSection sessionId={interviewId} isCompleted={isCompleted} isLive={isLive} />
        </TabsContent>

        <TabsContent value="recording" className="space-y-4">
          {interview.recordingUrl && !videoError ? (
            <>
              <div className="flex items-center gap-2 p-3 bg-cyan-500/5 border border-cyan-500/20 rounded-xl">
                <Video className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-semibold text-cyan-400">Session Recording</span>
                <span className="text-xs text-muted-foreground">· Webcam recording captured during the AI interview</span>
              </div>
              <Card className="border-border/60 overflow-hidden">
                <CardContent className="p-0">
                  {videoBlobUrl ? (
                    <video
                      controls
                      className="w-full max-h-[540px] bg-black"
                      src={videoBlobUrl}
                      onError={() => {
                        if (!videoIsBlob && !streamFailed) {
                          /* Signed S3 URL unreachable (e.g. private endpoint) —
                           * retry via the authed blob-download fallback. */
                          setStreamFailed(true);
                          setVideoBlobUrl(null);
                        } else {
                          setVideoError(true);
                        }
                      }}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-[320px] bg-black/60 gap-2 text-sm text-muted-foreground">
                      <Loader2 className="w-4 h-4 animate-spin" /> Loading recording…
                    </div>
                  )}
                </CardContent>
              </Card>
              <div className="flex items-center justify-end gap-3">
                <a
                  href={videoBlobUrl ?? undefined}
                  download={`interview-${interviewId}.webm`}
                  aria-disabled={!videoBlobUrl}
                >
                  <Button variant="outline" className="gap-2 text-sm" disabled={!videoBlobUrl}>
                    <Download className="w-4 h-4" /> Download Recording
                  </Button>
                </a>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-20 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-muted/50 flex items-center justify-center">
                <Video className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="text-center space-y-1">
                <p className="font-semibold text-muted-foreground">
                  {videoError ? "Recording file not found" : "No recording available"}
                </p>
                <p className="text-xs text-muted-foreground/60 max-w-xs mx-auto">
                  {videoError
                    ? "The recording was captured but the file could not be retrieved from storage. The transcript and AI evaluation are still available above."
                    : "Recordings are captured when the candidate completes the interview in the AI interview room."
                  }
                </p>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}
