/**
 * pages/recruiter/candidates/[id].tsx — Candidate Detail Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Full 360° view of a single candidate. Aggregates data from six API
 * endpoints and presents them across multiple tabs. Primary page for a
 * recruiter to make a stage-advance or rejection decision.
 *
 * ─── Tabs ────────────────────────────────────────────────────────────────────
 *   Overview        — AI summary, fit score ring, key strengths/gaps,
 *                     recommended next action
 *   Timeline        — chronological feed of all communication events
 *                     (emails sent/received, stage changes, notes)
 *   Interviews      — list of interview sessions with status + link to report
 *   Verification    — identity check status, risk flags, resume consistency
 *   Intelligence    — detailed AI scoring breakdown (6 dimensions)
 *   Outreach        — active enrollment status + message history
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useGetCandidate()             — core candidate row
 *   useGetVerificationStatus()    — verification_records
 *   useGetResumeScreen()          — latest resume_screens row
 *   useListInterviews()           — interview sessions for this candidate
 *   useListCommunicationEvents()  — communication_events timeline
 *   useQuery(intelligence)        — candidate_job_intelligence scores
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/candidates/:id
 */
import { authHeaders } from "@/lib/api";
import { useRoute, useLocation, Link } from "wouter";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { bandBy } from "@/lib/score-band";
import {
  useGetCandidate, useGetVerificationStatus, useGetResumeScreen,
  useListInterviews, useListCommunicationEvents
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CandidateIntelligenceCard } from "@/components/intelligence/CandidateIntelligenceCard";
import { ScoreBadge, VerificationBadge } from "@/components/ui-custom/Badges";
import {
  Mail, Phone, MapPin, Linkedin, Github, Download, Briefcase,
  Calendar, ShieldCheck, AlertTriangle, Brain, Layers, Video,
  CheckCircle2, XCircle, AlertCircle, Clock, ScanFace, Bot,
  ArrowRight, MessageSquare, Send, Activity, UserPlus, UserCheck, Copy, ExternalLink, Loader2,
  Target, Sparkles, FileText, TrendingUp, ChevronDown, ChevronUp, Building, Building2, Globe, Share2, Star, Pencil,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { ResumeUploader } from "@/components/ui-custom/ResumeUploader";
import { useToast } from "@workspace/react-hooks/use-toast";
import { ShareModal } from "@/components/share/ShareModal";
import { PushToClientModal } from "@/components/share/PushToClientModal";
import { extractInsight } from "@/lib/share-engine";
import { trackShareEvent } from "@/lib/share-analytics";
import CandidateTimeline from "@/components/candidates/CandidateTimeline";
import { generateEvaluationPdf, type EvaluationPdfData } from "@/lib/evaluation-pdf";
import {
  downloadEvaluationReportPdf,
  getEvaluationReportPdfBase64,
  type EvaluationReportPdfData,
} from "@/lib/evaluation-report-pdf";
import type { Evaluation, EvaluationGetResponse, RecommendationBand } from "@/lib/evaluation-types";
import { CandidateEvaluationReport } from "@/components/recruiter/CandidateEvaluationReport";
import { SendToHiringManagerModal, type HmIncludeOpts } from "@/components/share/SendToHiringManagerModal";
// ── Connection Engine (additive import) ───────────────────────────────────────
import { ConnectionStrengthBadge, ConnectionStrengthPanel, useConnectionScore } from "@/components/ui-custom/ConnectionStrengthBadge";

// Verification risk-score cutoff (INVERTED: above = high risk; own cutoff, not the match band).
const VERIFY_RISK_HIGH_MAX = 50;
function AgentBadge({ name, icon: Icon, color }: { name: string; icon: any; color: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border", color)}>
      <Icon className="w-2.5 h-2.5" />{name}
    </span>
  );
}

function ResumeScreenTab({ resumeScreen, candidateId, resumeUrl }: { resumeScreen: any; candidateId: string; resumeUrl?: string | null }) {
  const score = resumeScreen?.screeningScore || 0;
  const scoreColor = bandBy(score, { strong: "text-green-600", good: "text-yellow-600", fair: "text-red-600" });
  const scoreBg = bandBy(score, { strong: "from-green-500/20 to-green-500/5", good: "from-yellow-500/20 to-yellow-500/5", fair: "from-red-500/20 to-red-500/5" });

  return (
    <div className="space-y-6">
      {/* ── Resume File Upload ───────────────────────────────────────── */}
      <Card className="border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Layers className="w-4 h-4 text-primary" /> Resume File
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ResumeUploader candidateId={candidateId} resumeUrl={resumeUrl} />
        </CardContent>
      </Card>

      {/* ── Screening Results ────────────────────────────────────────── */}
      {!resumeScreen ? (
        <Card className="border-dashed">
          <CardContent className="py-14 text-center">
            <Layers className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <h3 className="font-bold mb-1">Resume not yet screened</h3>
            <p className="text-sm text-muted-foreground">
              {resumeUrl
                ? "The Screening Agent will analyse this resume on the next run."
                : "Upload a resume above — the Screening Agent will run automatically."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center gap-2 p-3 bg-cyan-500/5 border border-cyan-500/20 rounded-xl">
            <Bot className="w-4 h-4 text-cyan-500" />
            <span className="text-xs font-medium text-cyan-700">Screening Agent</span>
            <span className="text-xs text-muted-foreground ml-1">· Ran automatically on application received</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500 ml-auto" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className={`bg-gradient-to-br ${scoreBg} border-border/40`}>
              <CardContent className="p-5 text-center">
                <div className={cn("text-5xl font-black mb-1", scoreColor)}>{score}</div>
                <div className="text-xs text-muted-foreground">Resume Match Score</div>
              </CardContent>
            </Card>
            <Card className="border-border/40 md:col-span-2">
              <CardContent className="p-5">
                <h4 className="font-semibold text-sm mb-2">AI Recruiter Summary</h4>
                <p className="text-sm text-muted-foreground leading-relaxed">{resumeScreen.recruiterSummary || "No summary generated."}</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="border-border/40">
              <CardContent className="p-5">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-green-500" />Matched Skills
                </h4>
                <div className="flex flex-wrap gap-2">
                  {(resumeScreen.extractedSkills || []).map((s: string) => (
                    <Badge key={s} className="bg-green-500/10 text-green-700 border-green-500/20 text-xs">{s}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card className="border-border/40">
              <CardContent className="p-5">
                <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                  <XCircle className="w-4 h-4 text-red-400" />Missing Skills
                </h4>
                <div className="flex flex-wrap gap-2">
                  {(resumeScreen.missingSkills || []).map((s: string) => (
                    <Badge key={s} variant="outline" className="border-red-300 text-red-500 text-xs">{s}</Badge>
                  ))}
                  {(!resumeScreen.missingSkills || resumeScreen.missingSkills.length === 0) && (
                    <span className="text-sm text-muted-foreground">None identified</span>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {resumeScreen.workHistory && resumeScreen.workHistory.length > 0 && (
            <Card className="border-border/40">
              <CardContent className="p-5">
                <h4 className="font-semibold text-sm mb-4">Work History (AI Extracted)</h4>
                <div className="space-y-3">
                  {resumeScreen.workHistory.map((w: any, i: number) => (
                    <div key={i} className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg">
                      <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                        <Briefcase className="w-4 h-4" />
                      </div>
                      <div>
                        <div className="font-semibold text-sm">{w.title}</div>
                        <div className="text-xs text-muted-foreground">{w.company} · {w.startDate} – {w.current ? "Present" : w.endDate}</div>
                      </div>
                      {w.current && <Badge className="ml-auto text-xs bg-green-500/10 text-green-600 border-green-500/20">Current</Badge>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function InterviewsTab({ candidateId }: { candidateId: string }) {
  const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [, navigate] = useLocation();
  const { data: interviews, isLoading: sessionsLoading } = useListInterviews({ candidateId });

  const { data: careerProfile, isLoading: careerLoading } = useQuery<any>({
    queryKey: ["career-profile", candidateId],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/candidates/${candidateId}/career-profile`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { exists: false };
      return res.json();
    },
    staleTime: 60_000,
  });

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);

  async function loadCareerRecording() {
    if (videoUrl || videoLoading) return;
    setVideoLoading(true);
    setVideoError(null);
    try {
      const res = await fetch(`${BASE_URL}/api/candidates/${candidateId}/career-recording`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      setVideoUrl(URL.createObjectURL(blob));
    } catch (e: any) {
      setVideoError(e?.message ?? "Failed to load recording");
    } finally {
      setVideoLoading(false);
    }
  }

  const isLoading = sessionsLoading || careerLoading;
  if (isLoading) return <div className="py-12 text-center text-muted-foreground">Loading interviews...</div>;

  const hasCareerInterview = careerProfile?.exists && careerProfile?.baselineInterviewCompleted;
  const hasScheduledInterviews = interviews && interviews.length > 0;
  /* Candidate started the career interview but closed it before enough footage
   * existed (<10s). No recording is surfaced, but recruiters should see why. */
  const careerAbandonedEarly = careerProfile?.exists
    && !careerProfile?.baselineInterviewCompleted
    && careerProfile?.recordingStatus === "abandoned_early";

  if (!hasCareerInterview && !hasScheduledInterviews && !careerAbandonedEarly) return (
    <Card className="border-dashed">
      <CardContent className="py-16 text-center">
        <Video className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
        <h3 className="font-bold mb-1">No interviews yet</h3>
        <p className="text-sm text-muted-foreground mb-4">AI Video Interview sessions will appear here once scheduled.</p>
        <Button size="sm" className="gap-2" onClick={() => navigate(`/interviews?candidateId=${encodeURIComponent(candidateId)}&schedule=1`)}><Video className="w-4 h-4" />Schedule AI Interview</Button>
      </CardContent>
    </Card>
  );

  const qualityScore = careerProfile?.interviewQualityScore ?? 0;
  // Interview-quality band — a performance quantity, not match fit.
  const QUALITY_STRONG = 70, QUALITY_MODERATE = 50;
  const qualityColor = qualityScore >= QUALITY_STRONG ? "text-emerald-400" : qualityScore >= QUALITY_MODERATE ? "text-amber-400" : "text-red-400";

  return (
    <div className="space-y-4">
      {/* ── Career interview ended early ── */}
      {careerAbandonedEarly && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-amber-300">Interview ended before 10 seconds</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              The candidate started the career interview but closed it almost immediately, so no recording was captured.
            </p>
          </div>
        </div>
      )}

      {/* ── Portal Career Interview ── */}
      {hasCareerInterview && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 p-3 bg-violet-500/5 border border-violet-500/20 rounded-xl">
            <Sparkles className="w-4 h-4 text-violet-400" />
            <span className="text-xs font-medium text-violet-400">Portal Career Interview</span>
            <span className="text-xs text-muted-foreground ml-1">· Candidate-initiated AI career conversation</span>
          </div>

          <Card className="border-violet-500/20">
            <CardContent className="p-5 space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-violet-500/10 text-violet-400">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm">Career Intelligence Interview</span>
                      <Badge className="bg-green-500/10 text-green-600 border-green-500/20 text-xs">Completed</Badge>
                      {qualityScore >= 70 && (
                        <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 text-xs flex items-center gap-1">
                          <Star className="w-2.5 h-2.5 fill-emerald-400" /> Interview Ready
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                      {careerProfile.interviewLanguage && (
                        <span className="flex items-center gap-1"><Globe className="w-3 h-3" />{careerProfile.interviewLanguage}</span>
                      )}
                      {careerProfile.recordingDurationSec && (
                        <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{Math.round(careerProfile.recordingDurationSec / 60)} min</span>
                      )}
                      <span className="flex items-center gap-1.5">
                        Interview Quality:
                        <span className={cn("font-semibold tabular-nums", qualityColor)}>{qualityScore}</span>
                      </span>
                    </div>
                    {careerProfile.aiSummary && (
                      <p className="text-xs text-muted-foreground mt-2 leading-relaxed line-clamp-2">{careerProfile.aiSummary}</p>
                    )}
                  </div>
                </div>
              </div>

              {/* Inline recording player */}
              {careerProfile.recordingUrl && (
                <div className="border-t border-border/40 pt-4">
                  <div className="flex items-center gap-2 mb-3 text-xs font-medium text-muted-foreground">
                    <Video className="w-3.5 h-3.5 text-red-400" /> Interview Recording
                  </div>
                  {videoUrl ? (
                    <video
                      src={videoUrl}
                      controls
                      className="w-full rounded-lg border border-border/40 bg-black"
                      style={{ maxHeight: "360px" }}
                    />
                  ) : (
                    <div className="flex items-center gap-3 p-4 rounded-lg border border-border/40 bg-muted/20">
                      <Video className="w-8 h-8 text-muted-foreground/30 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">Recording available</p>
                        <p className="text-xs text-muted-foreground">Screen recording captured during the career interview</p>
                        {videoError && <p className="text-xs text-red-400 mt-1">{videoError}</p>}
                      </div>
                      <Button size="sm" variant="outline" onClick={loadCareerRecording} disabled={videoLoading} className="shrink-0 gap-2">
                        {videoLoading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Loading…</> : <><Video className="w-3.5 h-3.5" />Watch</>}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Scheduled AI Interviews ── */}
      {hasScheduledInterviews && (
        <div className="space-y-3">
          {hasCareerInterview && (
            <div className="flex items-center gap-2 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
              <Bot className="w-4 h-4 text-emerald-500" />
              <span className="text-xs font-medium text-emerald-700">AI Video Interview Agent</span>
              <span className="text-xs text-muted-foreground ml-1">· Scheduled sessions</span>
            </div>
          )}
          {!hasCareerInterview && (
            <div className="flex items-center gap-2 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
              <Bot className="w-4 h-4 text-emerald-500" />
              <span className="text-xs font-medium text-emerald-700">AI Video Interview Agent</span>
              <span className="text-xs text-muted-foreground ml-1">· Generative AI conducts and evaluates sessions</span>
            </div>
          )}

          <div className="space-y-3">
            {(interviews as any[]).map((interview: any) => {
              const isCompleted = interview.status === "completed";
              const isLive = interview.status === "in_progress";
              return (
                <Card key={interview.id} className={cn("border-border/40", isLive && "border-blue-400/40 bg-blue-500/5")}>
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex items-start gap-4">
                        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                          isLive ? "bg-blue-500/10 text-blue-500" : "bg-emerald-500/10 text-emerald-500"
                        )}>
                          <Video className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-sm">Technical Screen</span>
                            {isLive && <Badge className="bg-blue-500 text-white text-xs animate-pulse">Live</Badge>}
                            {isCompleted && <Badge className="bg-green-500/10 text-green-600 border-green-500/20 text-xs">Completed</Badge>}
                          </div>
                          <div className="flex items-center gap-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1"><Calendar className="w-3 h-3" />{formatDate(interview.createdAt)}</span>
                            <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{interview.totalQuestions} questions</span>
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            <AgentBadge name="AI Interviewer" icon={Brain} color="text-emerald-600 bg-emerald-500/10 border-emerald-500/20" />
                            <AgentBadge name="Proctoring" icon={ScanFace} color="text-rose-600 bg-rose-500/10 border-rose-500/20" />
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {isCompleted && interview.score && <ScoreBadge score={interview.score} />}
                        <Link href={`/interviews/${interview.id}`}>
                          <Button size="sm" variant={isLive ? "default" : "outline"} className="gap-1 text-xs">
                            {isLive ? <><Activity className="w-3 h-3" />Join Live</> : <><ArrowRight className="w-3 h-3" />View Report</>}
                          </Button>
                        </Link>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const EVENT_ICON_MAP: Record<string, { icon: any; color: string }> = {
  sourcing:   { icon: UserPlus,    color: "bg-cyan-500/10 text-cyan-500" },
  screening:  { icon: Layers,      color: "bg-violet-500/10 text-violet-500" },
  icp:        { icon: Brain,       color: "bg-violet-500/10 text-violet-500" },
  pipeline:   { icon: Briefcase,   color: "bg-orange-500/10 text-orange-500" },
  interview:  { icon: Video,       color: "bg-emerald-500/10 text-emerald-500" },
  outreach:   { icon: Send,        color: "bg-orange-500/10 text-orange-500" },
  reply:      { icon: MessageSquare, color: "bg-green-500/10 text-green-500" },
  verification: { icon: ShieldCheck, color: "bg-green-500/10 text-green-500" },
};

const BASE_CANDIDATE = import.meta.env.BASE_URL.replace(/\/$/, "");

function ActivityTab({ candidateId }: { candidateId: string }) {
  const { data: commEventsData } = useListCommunicationEvents({ candidateId });

  const { data: agentEventsData, isLoading } = useQuery({
    queryKey: ["agent-events", candidateId],
    queryFn: async () => {
      const res = await fetch(`${BASE_CANDIDATE}/api/agents/events/candidate/${candidateId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { events: [] };
      return res.json();
    },
    staleTime: 30_000,
    enabled: !!candidateId,
  });

  const agentEvents: any[] = agentEventsData?.events ?? [];
  const commEvents: any[] = commEventsData || [];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 p-3 bg-muted/40 border border-border/40 rounded-xl">
        <Activity className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs font-medium">Agent & Communication Timeline</span>
        <span className="text-xs text-muted-foreground ml-1">· Automated events from all agents</span>
        {agentEvents.length > 0 && (
          <Badge variant="outline" className="text-xs ml-auto">{agentEvents.length} events</Badge>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading timeline…</span>
        </div>
      ) : agentEvents.length === 0 && commEvents.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <Activity className="w-10 h-10 text-muted-foreground/30 mx-auto" />
          <p className="text-sm text-muted-foreground">No agent activity yet for this candidate.</p>
          <p className="text-xs text-muted-foreground">Events will appear as agents process this candidate through the pipeline.</p>
        </div>
      ) : (
        <div className="relative space-y-0 pl-4">
          <div className="absolute left-4 top-4 bottom-4 w-px bg-border/60" />

          {agentEvents.map((ev: any) => {
            const { icon: Icon, color } = EVENT_ICON_MAP[ev.type] || { icon: Bot, color: "bg-primary/10 text-primary" };
            const ts = ev.timestamp ? new Date(ev.timestamp) : null;
            const timeLabel = ts ? formatDate(ts.toISOString()) : "";
            return (
              <div key={ev.id} className="relative flex items-start gap-4 pb-6 last:pb-0">
                <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0 z-10 border-2 border-background", color)}>
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0 pt-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{ev.label}</span>
                    <Badge variant="secondary" className="text-xs shrink-0">{ev.result}</Badge>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-muted-foreground font-medium">{ev.agent}</span>
                    {timeLabel && <span className="text-[11px] text-muted-foreground">· {timeLabel}</span>}
                  </div>
                </div>
              </div>
            );
          })}

          {commEvents.slice(0, 3).map((ev: any, i: number) => (
            <div key={`comm-${i}`} className="relative flex items-start gap-4 pb-6 last:pb-0">
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 z-10 border-2 border-background">
                <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0 pt-1">
                <span className="text-sm font-medium capitalize">{ev.type?.replace("_", " ") || "Message"}</span>
                <div className="text-xs text-muted-foreground mt-0.5">{formatDate(ev.sentAt)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Career Profile Tab ─────────────────────────────────────────────────── */
function CareerProfileTab({ candidateId, onShare }: { candidateId: string; onShare?: () => void }) {
  const [showFullTranscript, setShowFullTranscript] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

  const { data: profile, isLoading } = useQuery<any>({
    queryKey: ["career-profile", candidateId],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/candidates/${candidateId}/career-profile`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch career profile");
      return res.json();
    },
    staleTime: 60_000,
  });

  async function loadVideo() {
    if (videoUrl || videoLoading) return;
    setVideoLoading(true);
    setVideoError(null);
    try {
      const res = await fetch(`${BASE_URL}/api/candidates/${candidateId}/career-recording`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      setVideoUrl(URL.createObjectURL(blob));
    } catch (e: any) {
      setVideoError(e?.message ?? "Failed to load recording");
    } finally {
      setVideoLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => (
          <Card key={i} className="animate-pulse">
            <CardContent className="p-6 space-y-3">
              <div className="h-4 bg-muted rounded w-1/3" />
              <div className="h-3 bg-muted rounded w-full" />
              <div className="h-3 bg-muted rounded w-3/4" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!profile?.exists) {
    return (
      <Card className="border-border/30 border-dashed">
        <CardContent className="p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
            <FileText className="w-8 h-8 text-muted-foreground/40" />
          </div>
          <h3 className="font-semibold text-foreground mb-2">No career profile yet</h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
            This candidate hasn't completed their portal career interview. Once they do, you'll see their
            career goals, motivations, AI analysis, and the complete interview transcript here.
          </p>
          <div className="mt-6 grid grid-cols-2 gap-2 max-w-xs mx-auto text-xs text-muted-foreground/60">
            {["Career goals (3yr & 5yr)", "Motivations & values", "Target roles & industries", "AI interview transcript"].map(item => (
              <div key={item} className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 flex-shrink-0" />
                {item}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const completeness = profile.profileCompleteness ?? 0;
  // Profile-completeness band — a data-completeness quantity, not match fit.
  const COMPLETENESS_STRONG = 80, COMPLETENESS_MODERATE = 50;
  const completeColor = completeness >= COMPLETENESS_STRONG ? "text-emerald-400" : completeness >= COMPLETENESS_MODERATE ? "text-amber-400" : "text-red-400";
  const qualityScore = profile.interviewQualityScore ?? 0;
  // Interview-quality band — a performance quantity, not match fit.
  const QUALITY_STRONG = 70, QUALITY_MODERATE = 50;
  const qualityColor = qualityScore >= QUALITY_STRONG ? "text-emerald-400" : qualityScore >= QUALITY_MODERATE ? "text-amber-400" : "text-red-400";
  // Interview-ready gate — combines quality + completeness minimums.
  const INTERVIEW_READY_QUALITY_MIN = 70, INTERVIEW_READY_COMPLETENESS_MIN = 60;
  const isInterviewReady = profile.baselineInterviewCompleted && qualityScore >= INTERVIEW_READY_QUALITY_MIN && completeness >= INTERVIEW_READY_COMPLETENESS_MIN;

  const transcriptLines = (profile.transcriptEnglish ?? "").split("\n").filter(Boolean);
  const previewLines = transcriptLines.slice(0, 12);
  const hasMore = transcriptLines.length > 12;

  return (
    <div className="space-y-6">
      {/* ── Score dashboard ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {/* Profile Completeness */}
        <Card>
          <CardContent className="p-5 text-center">
            <div className="relative inline-flex items-center justify-center w-20 h-20 mb-2">
              <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
                <circle cx="40" cy="40" r="34" fill="none"
                  stroke="currentColor" strokeWidth="6"
                  strokeDasharray={2 * Math.PI * 34}
                  strokeDashoffset={2 * Math.PI * 34 * (1 - completeness / 100)}
                  strokeLinecap="round"
                  className={completeColor}
                />
              </svg>
              <span className={cn("absolute text-lg font-bold tabular-nums", completeColor)}>{completeness}%</span>
            </div>
            <div className="text-xs font-medium text-muted-foreground">Profile Completeness</div>
          </CardContent>
        </Card>

        {/* Interview Quality Score */}
        <Card>
          <CardContent className="p-5 text-center">
            <div className="relative inline-flex items-center justify-center w-20 h-20 mb-2">
              <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="6" />
                <circle cx="40" cy="40" r="34" fill="none"
                  stroke="currentColor" strokeWidth="6"
                  strokeDasharray={2 * Math.PI * 34}
                  strokeDashoffset={2 * Math.PI * 34 * (1 - qualityScore / 100)}
                  strokeLinecap="round"
                  className={qualityColor}
                />
              </svg>
              <span className={cn("absolute text-lg font-bold tabular-nums", qualityColor)}>{qualityScore}</span>
            </div>
            <div className="text-xs font-medium text-muted-foreground">Interview Quality</div>
            {profile.recordingDurationSec && (
              <div className="text-[10px] text-muted-foreground/50 mt-0.5">{Math.round(profile.recordingDurationSec / 60)} min session</div>
            )}
          </CardContent>
        </Card>

        {/* Interview Status */}
        <Card>
          <CardContent className="p-5 space-y-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="font-semibold text-sm">Portal Interview</span>
            </div>
            <div className="flex items-center gap-2">
              {profile.baselineInterviewCompleted
                ? <><CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" /><span className="text-sm text-emerald-400 font-medium">Interview completed</span></>
                : <><Clock className="w-4 h-4 text-amber-400 flex-shrink-0" /><span className="text-sm text-amber-400">Not yet completed</span></>
              }
            </div>
            {profile.interviewLanguage && (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Globe className="w-3.5 h-3.5" />
                <span className="capitalize">{profile.interviewLanguage}</span>
              </div>
            )}
            {profile.aiSummary && (
              <p className="text-xs text-muted-foreground leading-relaxed border-t border-border/40 pt-2 line-clamp-4">
                {profile.aiSummary}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Interview Ready banner ── */}
      {isInterviewReady && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/25">
          <div className="w-9 h-9 rounded-full bg-emerald-500/20 flex items-center justify-center shrink-0">
            <Star className="w-4 h-4 text-emerald-400 fill-emerald-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-emerald-400 text-sm">Interview Ready</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Strong interview quality and complete profile — this candidate is ready to be presented to clients.
            </div>
          </div>
          {onShare && (
            <Button
              size="sm"
              onClick={onShare}
              className="shrink-0 gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white border-0"
            >
              <Share2 className="w-3.5 h-3.5" /> Push to Client
            </Button>
          )}
        </div>
      )}

      {/* ── Interview Recording (shown prominently before other profile data) ── */}
      {profile.recordingUrl && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Video className="w-4 h-4 text-red-400" /> Career Interview Recording
              {profile.recordingDurationSec && (
                <Badge variant="outline" className="text-[10px]">{Math.round(profile.recordingDurationSec / 60)} min</Badge>
              )}
              <div className="ml-auto flex items-center gap-2">
                {onShare && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onShare}
                    className="gap-1.5 text-xs border-violet-500/30 text-violet-400 hover:bg-violet-500/10"
                  >
                    <Share2 className="w-3 h-3" /> Share with Client
                  </Button>
                )}
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {videoUrl ? (
              <video
                src={videoUrl}
                controls
                className="w-full rounded-lg border border-border/40 bg-black"
                style={{ maxHeight: "420px" }}
              />
            ) : (
              <div className="flex flex-col items-center justify-center gap-3 py-8 rounded-lg border border-border/40 bg-muted/20">
                <Video className="w-10 h-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">Screen recording captured during the AI interview</p>
                {videoError && <p className="text-xs text-red-400">{videoError}</p>}
                <Button size="sm" variant="outline" onClick={loadVideo} disabled={videoLoading} className="gap-2">
                  {videoLoading ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading recording…</> : <><Video className="w-3.5 h-3.5" /> Watch Recording</>}
                </Button>
                <p className="text-xs text-muted-foreground/60">
                  {videoLoading ? "Downloading from S3 — may take a moment for long recordings" : "Click to stream the full interview video"}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Career Goals */}
      {(profile.careerGoal3yr || profile.careerGoal5yr) && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Target className="w-4 h-4 text-primary" /> Career Goals</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {profile.careerGoal3yr && (
              <div>
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">3-Year Goal</div>
                <p className="text-sm leading-relaxed">{profile.careerGoal3yr}</p>
              </div>
            )}
            {profile.careerGoal5yr && (
              <div className="border-t border-border/40 pt-4">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">5-Year Goal</div>
                <p className="text-sm leading-relaxed">{profile.careerGoal5yr}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Strengths & Growth */}
      {(profile.strengthAreas?.length > 0 || profile.growthAreas?.length > 0) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {profile.strengthAreas?.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base text-emerald-400"><TrendingUp className="w-4 h-4" /> Strength Areas</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {(profile.strengthAreas as string[]).map((s, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 flex-shrink-0" />{s}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          {profile.growthAreas?.length > 0 && (
            <Card>
              <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base text-amber-400"><AlertCircle className="w-4 h-4" /> Growth Areas</CardTitle></CardHeader>
              <CardContent>
                <div className="space-y-1.5">
                  {(profile.growthAreas as string[]).map((g, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <ArrowRight className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />{g}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Work Preferences */}
      {(profile.motivations?.length > 0 || profile.preferredWorkStyle || profile.preferredTeamSize || profile.desiredSalaryRange) && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Briefcase className="w-4 h-4 text-primary" /> Work Preferences</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {profile.preferredWorkStyle && (
                <div><div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Work Style</div><div className="text-sm font-medium">{profile.preferredWorkStyle}</div></div>
              )}
              {profile.preferredTeamSize && (
                <div><div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Team Size</div><div className="text-sm font-medium">{profile.preferredTeamSize}</div></div>
              )}
              {profile.desiredSalaryRange && (
                <div><div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Target Salary</div><div className="text-sm font-medium">{profile.desiredSalaryRange}</div></div>
              )}
              {profile.motivations?.length > 0 && (
                <div className="col-span-full">
                  <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-2">Motivations</div>
                  <div className="flex flex-wrap gap-2">
                    {(profile.motivations as string[]).map((m, i) => (
                      <Badge key={i} variant="secondary" className="bg-primary/10 text-primary text-xs">{m}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Target Preferences */}
      {(profile.preferredRoles?.length > 0 || profile.targetIndustries?.length > 0 || profile.targetCompanies?.length > 0) && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Building className="w-4 h-4 text-primary" /> Target Preferences</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {profile.preferredRoles?.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-2">Preferred Roles</div>
                <div className="flex flex-wrap gap-1.5">{(profile.preferredRoles as string[]).map((r, i) => <Badge key={i} variant="outline" className="text-xs">{r}</Badge>)}</div>
              </div>
            )}
            {profile.targetIndustries?.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-2">Target Industries</div>
                <div className="flex flex-wrap gap-1.5">{(profile.targetIndustries as string[]).map((ind, i) => <Badge key={i} variant="outline" className="text-xs">{ind}</Badge>)}</div>
              </div>
            )}
            {profile.targetCompanies?.length > 0 && (
              <div>
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-2">Dream Companies</div>
                <div className="flex flex-wrap gap-1.5">{(profile.targetCompanies as string[]).map((c, i) => <Badge key={i} variant="outline" className="text-xs">{c}</Badge>)}</div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Interview Transcript */}
      {profile.transcriptEnglish && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="w-4 h-4 text-primary" /> Career Interview Transcript
              <Badge variant="outline" className="text-[10px] ml-auto">English</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted/30 rounded-xl p-4 border border-border/40 font-mono text-xs leading-relaxed space-y-2 max-h-96 overflow-y-auto">
              {(showFullTranscript ? transcriptLines : previewLines).map((line: string, i: number) => (
                <div key={i} className={cn(
                  "leading-relaxed",
                  line.match(/^(LEXY|Q\d+)/i) ? "text-primary font-semibold" : "text-foreground/80 pl-4",
                )}>{line}</div>
              ))}
            </div>
            {hasMore && (
              <button onClick={() => setShowFullTranscript(v => !v)}
                className="mt-3 flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors font-medium">
                {showFullTranscript
                  ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</>
                  : <><ChevronDown className="w-3.5 h-3.5" /> Show full transcript ({transcriptLines.length} lines)</>
                }
              </button>
            )}
          </CardContent>
        </Card>
      )}

      {/* AI Analysis */}
      {profile.analysisEnglish && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="w-4 h-4 text-violet-400" /> AI Career Analysis</CardTitle></CardHeader>
          <CardContent>
            <div className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">{profile.analysisEnglish}</div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function CandidateProfile() {
  const [, params] = useRoute("/candidates/:id");
  const [, navigate] = useLocation();
  const candidateId = params?.id || "";

  /* Smart back: return to the page the recruiter actually came from (job board,
     search, dashboard, etc.) instead of always jumping to the Candidates list.
     Falls back to the Candidates list on a fresh load with no in-app history. */
  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      window.history.back();
    } else {
      navigate("/candidates");
    }
  };
  const { toast } = useToast();
  const { user } = useAuth() as any;

  /* Tier-1 addiction-loop wiring: tell the API that this recruiter (tenant)
     just opened the candidate. Server records the event with viewer_tenant_id
     so the portal can render "Stripe just viewed you", and the market-event
     emitter can fire target-company / view-burst alerts. Best-effort —
     swallowed errors must never block the UI from rendering. */
  useEffect(() => {
    if (!candidateId || !user?.tenantId) return;
    fetch(`${BASE}/api/recruiter/view-candidate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ candidateId, viewerTenantId: user.tenantId }),
    }).catch(() => { /* best-effort — telemetry only */ });
  }, [candidateId, user?.tenantId]);

  /* Fire a RECRUITER_REVIEWED lifecycle event when this profile is opened.
   * Best-effort — never blocks the UI. Server infers jobId from the most
   * recent application when none is available in the URL. */
  useEffect(() => {
    if (!candidateId || !user?.id) return;
    const params = new URLSearchParams(window.location.search);
    const jobId = params.get("jobId") ?? undefined;
    fetch(`${BASE}/api/candidates/${candidateId}/reviewed`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(jobId ? { jobId } : {}),
    }).catch(() => { /* best-effort */ });
  }, [candidateId, user?.id]);

  const [inviteOpen, setInviteOpen]     = useState(false);
  const [inviteToken, setInviteToken]   = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [messageOpen, setMessageOpen]   = useState(false);
  const [messageSubject, setMessageSubject] = useState("");
  const [messageBody, setMessageBody]   = useState("");
  const [messageLoading, setMessageLoading] = useState(false);
  const [shareOpen, setShareOpen]           = useState(false);
  const [pushToClientOpen, setPushToClientOpen] = useState(false);
  const [hmShareOpen, setHmShareOpen]       = useState(false);
  const [editOpen, setEditOpen]             = useState(false);
  const [editSaving, setEditSaving]         = useState(false);
  const [editForm, setEditForm] = useState({
    firstName: "", lastName: "", email: "", phone: "", location: "",
    currentTitle: "", currentCompany: "", linkedinUrl: "", githubUrl: "",
  });

  /* Seed the edit form from the loaded candidate whenever the dialog opens. */
  const openEditDialog = () => {
    if (!candidate) return;
    setEditForm({
      firstName: candidate.firstName ?? "",
      lastName: candidate.lastName ?? "",
      email: candidate.email ?? "",
      phone: candidate.phone ?? "",
      location: candidate.location ?? "",
      currentTitle: candidate.currentTitle ?? "",
      currentCompany: candidate.currentCompany ?? "",
      linkedinUrl: candidate.linkedinUrl ?? "",
      githubUrl: candidate.githubUrl ?? "",
    });
    setEditOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editForm.firstName.trim() || !editForm.lastName.trim()) {
      toast({ title: "Name required", description: "First and last name are required.", variant: "destructive" });
      return;
    }
    if (!editForm.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editForm.email.trim())) {
      toast({ title: "Invalid email", description: "Please enter a valid email address.", variant: "destructive" });
      return;
    }
    setEditSaving(true);
    try {
      const res = await fetch(`${BASE}/api/candidates/${candidateId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          firstName: editForm.firstName.trim(),
          lastName: editForm.lastName.trim(),
          email: editForm.email.trim(),
          phone: editForm.phone.trim() || null,
          location: editForm.location.trim() || null,
          currentTitle: editForm.currentTitle.trim() || null,
          currentCompany: editForm.currentCompany.trim() || null,
          linkedinUrl: editForm.linkedinUrl.trim() || null,
          githubUrl: editForm.githubUrl.trim() || null,
        }),
      });
      if (!res.ok) {
        const msg = res.status === 403 ? "You don't have permission to edit this candidate."
          : res.status === 401 ? "Your session expired — please sign in again."
          : "Could not save changes. Please try again.";
        throw new Error(msg);
      }
      await refetchCandidate();
      setEditOpen(false);
      toast({ title: "Profile updated", description: "Candidate details were saved." });
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message || "Could not save changes.", variant: "destructive" });
    } finally {
      setEditSaving(false);
    }
  };

  /* Deep-link: the pipeline "Send Packet" button navigates here with ?hmShare=1
     so it can reuse this page's fully-loaded evaluation-data builder. Auto-open
     the composer once, then strip the param so a refresh doesn't reopen it. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("hmShare") === "1") {
      setHmShareOpen(true);
      params.delete("hmShare");
      const qs = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
    }
  }, []);

  const { data: candidate, isLoading: cLoading, refetch: refetchCandidate } = useGetCandidate(candidateId);

  // Real talent-match records for this candidate (joined with job titles).
  const { data: matchesData } = useQuery<{
    matches: Array<{ id: string; jobId: string; jobTitle: string | null; fitScore: number; jobStatus: string | null }>;
  }>({
    queryKey: [`/api/talent-matches/by-candidate/${candidateId}`],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/talent-matches/by-candidate/${candidateId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { matches: [] };
      return res.json();
    },
    enabled: !!candidateId,
    staleTime: 60_000,
  });
  const matchedRoles = matchesData?.matches ?? [];
  /* Some matched roles (e.g. a candidate linked to a job but not yet scored)
     have a null fitScore — exclude those from the "best fit" headline so an
     unscored role doesn't drag the number to 0%. */
  const scoredRoles = matchedRoles.filter(m => m.fitScore != null);
  const overallTalentMatch = scoredRoles.length > 0
    ? Math.max(...scoredRoles.map(m => m.fitScore as number))
    : (candidate?.talentMatchScore ?? null);

  // Connection strength (employer-side engagement score)
  const connEnabled = import.meta.env.VITE_ENABLE_CONNECTION_ENGINE === "true";
  const { data: connScore } = useConnectionScore(candidateId);
  const connLabelStyles: Record<string, { color: string; bg: string }> = {
    Cold:        { color: "text-slate-400",   bg: "bg-slate-500/10 border-slate-500/25" },
    Warming:     { color: "text-amber-400",   bg: "bg-amber-500/10 border-amber-500/25" },
    Engaged:     { color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/25" },
    "High Intent":{ color: "text-violet-400", bg: "bg-violet-500/10 border-violet-500/25" },
  };
  const connStyle = connLabelStyles[connScore?.label ?? "Cold"] ?? connLabelStyles.Cold;
  const connSignalLabels: Record<string, string> = {
    replied_to_outreach:   "Replied to outreach",
    response_within_24h:   "Responded within 24 h",
    accepted_intro:        "Accepted intro",
    booked_interview:      "Booked interview",
    completed_interview:   "Completed interview",
    viewed_opportunity:    "Viewed opportunity",
    multiple_interactions: "Multiple interactions",
    no_show:               "No-show",
    declined_role:         "Declined role",
  };

  // Load intelligence signals lazily — used only by the Share Engine
  const { data: intelligenceData } = useQuery<{
    data: Array<{
      jobId: string;
      jobTitle?: string | null;
      hireProbability: number | null;
      fitScore?: number | null;
      qualityScore?: number | null;
      trustScore?: number | null;
      conversionScore?: number | null;
      signalsJson?: any;
    }>;
  }>({
    queryKey: ["intelligence", "candidate", candidateId, "share"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence/candidate/${candidateId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { data: [] };
      return res.json();
    },
    enabled: shareOpen,
  });
  const { data: verification } = useGetVerificationStatus(candidateId);
  const { data: resumeScreen } = useGetResumeScreen(candidateId);
  const { data: evalInterviews } = useListInterviews({ candidateId });

  /* The structured client-facing evaluation (Evaluation tab). Downloads and
     the hiring-manager attachment always use the structured report when an
     evaluation exists for the candidate's primary role — approved reports are
     final; unapproved ones carry a DRAFT notice on every page. If none exists
     yet, the download button generates one on the fly. */
  const evalJobId = scoredRoles[0]?.jobId ?? matchedRoles[0]?.jobId ?? null;
  const { data: structuredEvalRes, refetch: refetchStructuredEval } = useQuery<EvaluationGetResponse>({
    queryKey: ["evaluation", evalJobId, candidateId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/evaluations/${evalJobId}/${candidateId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { evaluation: null };
      return res.json();
    },
    enabled: !!evalJobId && !!candidateId,
  });
  const structuredEvaluation = structuredEvalRes?.evaluation ?? null;

  const fallbackBandLabel = (b: RecommendationBand) =>
    b
      .split("_")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");

  const buildReportPdfData = (ev: Evaluation): EvaluationReportPdfData => ({
    candidateName: `${candidate!.firstName ?? ""} ${candidate!.lastName ?? ""}`.trim(),
    jobTitle: scoredRoles[0]?.jobTitle ?? matchedRoles[0]?.jobTitle ?? null,
    companyName: null,
    content: ev.content,
    recommendationBand: ev.recommendationBand,
    bandLabel: fallbackBandLabel(ev.recommendationBand),
    confidence: ev.confidence,
    preparedBy: user?.companyName ?? user?.tenantName ?? null,
    approvedAt: ev.approvedAt,
    isDraft: ev.approvalState !== "approved",
  });

  /* Ensure a structured evaluation exists, generating one on demand. */
  const ensureStructuredEvaluation = async (): Promise<Evaluation | null> => {
    if (structuredEvaluation) return structuredEvaluation;
    if (!evalJobId) return null;
    try {
      const res = await fetch(`${BASE}/api/evaluations/generate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ jobId: evalJobId, candidateId }),
      });
      if (!res.ok) return null;
      const body = (await res.json().catch(() => null)) as { evaluation?: Evaluation } | null;
      void refetchStructuredEval();
      return body?.evaluation ?? null;
    } catch {
      return null; // network/abort — caller falls back to the legacy PDF
    }
  };

  /* Build a client-ready AI evaluation PDF from the data already loaded on
     this page (talent match + resume screen + interviews + verification) and
     trigger a download. Recruiters forward this to their client (the employer). */
  /* Assemble the evaluation-PDF payload from data already loaded on this page.
     `opts` lets the hiring-manager share omit contact details / recruiter notes
     per the recruiter's per-send toggles; the download path includes everything. */
  const buildEvaluationData = (
    opts: HmIncludeOpts = { includeContact: true, includeResume: true, includeNotes: true },
  ): EvaluationPdfData => {
    const best = scoredRoles.length
      ? scoredRoles.reduce((a, b) => ((b.fitScore ?? 0) > (a.fitScore ?? 0) ? b : a))
      : null;
    return {
      candidate: {
        firstName: candidate!.firstName,
        lastName: candidate!.lastName,
        currentTitle: candidate!.currentTitle,
        currentCompany: candidate!.currentCompany,
        location: candidate!.location,
        email: opts.includeContact ? candidate!.email : null,
        skills: candidate!.skills,
        verificationStatus: candidate!.verificationStatus,
      },
      bestRole: best ? { jobTitle: best.jobTitle, fitScore: best.fitScore } : null,
      allRoles: scoredRoles.map((m) => ({ jobTitle: m.jobTitle, fitScore: m.fitScore })),
      resumeScreen: resumeScreen
        ? {
            screeningScore: (resumeScreen as any).screeningScore,
            recruiterSummary: opts.includeNotes ? (resumeScreen as any).recruiterSummary : null,
            extractedSkills: (resumeScreen as any).extractedSkills,
            missingSkills: (resumeScreen as any).missingSkills,
          }
        : null,
      interviews: ((evalInterviews as any[]) ?? []).map((i) => ({
        status: i.status,
        score: i.score,
        totalQuestions: i.totalQuestions,
        createdAt: i.createdAt,
        overallScore: i.overallScore ?? null,
        recommendation: i.recommendation ?? null,
        summary: i.recruiterSummary ?? null,
        strengths: i.strengths ?? null,
        weaknesses: i.weaknesses ?? null,
      })),
      verification: verification
        ? {
            status: (verification as any).status,
            identityVerified: (verification as any).identityVerified,
          }
        : null,
      preparedBy: user?.companyName ?? user?.tenantName ?? null,
    };
  };

  const handleDownloadEvaluation = async () => {
    if (!candidate) return;
    /* Why we fell back to the legacy PDF — surfaced in a toast so a stale
       build / failing generate endpoint is diagnosable instead of silent. */
    let fallbackReason = "This candidate has no linked role to evaluate against.";
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
              : "A DRAFT evaluation report has been downloaded — review and approve it in the Evaluation tab.",
        });
        return;
      } catch {
        fallbackReason = "The structured report could not be built in this browser.";
      }
    } else if (evalJobId) {
      fallbackReason =
        "Evaluation generation failed on the server (check the API server logs / AI key).";
    }
    // Structured generation unavailable (e.g. no linked role) — legacy summary.
    await generateEvaluationPdf(buildEvaluationData());
    toast({
      title: "Legacy report downloaded",
      description: `Structured evaluation unavailable — ${fallbackReason}`,
      variant: "destructive",
    });
  };

  // Career profile — used by Overview + Career Profile tabs
  const { data: careerProfile } = useQuery<any>({
    queryKey: ["career-profile", candidateId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/candidates/${candidateId}/career-profile`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { exists: false };
      return res.json();
    },
    staleTime: 60_000,
    enabled: !!candidateId,
  });
  const cp = careerProfile?.exists ? careerProfile : null;

  // Merge skills: prefer career profile skills if candidate record is empty
  const displaySkills: string[] = (candidate?.skills?.length ? candidate.skills : (cp?.skills ?? [])) as string[];

  /* Hiring-manager shares + their decisions, surfaced back on the candidate page. */
  const { data: hmSharesData } = useQuery<{ shares: Array<{
    id: string; recipientEmail: string; recipientName: string | null; status: string;
    decision: "advance" | "interview" | "pass" | null; decisionComment: string | null;
    decidedByName: string | null; decidedAt: string | null; viewedAt: string | null;
    viewCount: number; createdAt: string; expiresAt: string;
  }> }>({
    queryKey: ["hm-shares", candidateId, hmShareOpen],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/hm-share?candidateId=${candidateId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) return { shares: [] };
      return res.json();
    },
    enabled: !!candidateId,
    staleTime: 30_000,
  });
  const hmShares = hmSharesData?.shares ?? [];

  const handleInvite = async () => {
    setInviteLoading(true);
    try {
      const res = await fetch(`${BASE}/api/invites/generate`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ candidateId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to generate invite");
      setInviteToken(data.token);
      setInviteOpen(true);
      if (data.emailSent) {
        toast({ title: "Invite sent", description: `Portal invite emailed to ${data.email}.` });
      } else {
        toast({
          title: "Invite created",
          description: "Email could not be sent — copy the link below to share it manually.",
          variant: "destructive",
        });
      }
    } catch (err: any) {
      toast({ title: "Invite failed", description: err.message, variant: "destructive" });
    } finally {
      setInviteLoading(false);
    }
  };

  const handleSendMessage = async () => {
    if (!messageSubject.trim() || !messageBody.trim()) {
      toast({ title: "Missing fields", description: "Add a subject and a message.", variant: "destructive" });
      return;
    }
    setMessageLoading(true);
    try {
      const res = await fetch(`${BASE}/api/candidates/${candidateId}/message`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ subject: messageSubject.trim(), body: messageBody.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to send message");
      toast({ title: "Message sent", description: `Emailed to ${data.email}.` });
      setMessageOpen(false);
      setMessageSubject("");
      setMessageBody("");
    } catch (err: any) {
      toast({ title: "Message failed", description: err.message, variant: "destructive" });
    } finally {
      setMessageLoading(false);
    }
  };

  const inviteUrl = inviteToken ? `${window.location.origin}${BASE}/accept-invite?token=${inviteToken}` : "";

  const copyInviteLink = () => {
    navigator.clipboard.writeText(inviteUrl);
    toast({ title: "Link copied", description: "Invite link copied to clipboard." });
  };

  if (cLoading) return <AppLayout><div className="p-8 text-center animate-pulse">Loading profile...</div></AppLayout>;
  if (!candidate) return <AppLayout><div className="p-8 text-center">Candidate not found</div></AppLayout>;

  return (
    <AppLayout>
      <div className="mb-4">
        <button onClick={handleBack} className="text-sm text-muted-foreground hover:text-primary inline-flex items-center gap-1">
          <ArrowRight className="w-4 h-4 rotate-180" /> Back
        </button>
      </div>
      <div className="bg-card rounded-2xl p-6 md:p-8 shadow-sm border border-border/50 mb-6 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-bl-full -z-10" />

        <div className="flex flex-col md:flex-row gap-6 md:gap-8 items-start md:items-center relative z-10">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-3xl font-display font-bold text-white shadow-xl shadow-primary/20 shrink-0">
            {candidate.firstName.charAt(0)}{candidate.lastName.charAt(0)}
          </div>

          <div className="flex-1 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="page-title">{candidate.firstName} {candidate.lastName}</h1>
              <VerificationBadge status={candidate.verificationStatus} />
              <Badge variant="outline" className="capitalize bg-muted">{candidate.source || "Direct"}</Badge>
              {connEnabled && <ConnectionStrengthBadge candidateId={candidateId} />}
            </div>

            <p className="text-lg font-medium text-muted-foreground">
              {candidate.currentTitle || "Professional"} {candidate.currentCompany ? `at ${candidate.currentCompany}` : ""}
            </p>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5"><MapPin className="w-4 h-4" />{candidate.location || "Unknown location"}</span>
              <span className="flex items-center gap-1.5"><Mail className="w-4 h-4" />{candidate.email}</span>
              {candidate.phone && <span className="flex items-center gap-1.5"><Phone className="w-4 h-4" />{candidate.phone}</span>}
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <AgentBadge name="Screening Agent" icon={Layers} color="text-cyan-600 bg-cyan-500/10 border-cyan-500/20" />
              <AgentBadge name="ICP Matched" icon={Brain} color="text-violet-600 bg-violet-500/10 border-violet-500/20" />
              <AgentBadge name="Shortlisted" icon={Send} color="text-orange-600 bg-orange-500/10 border-orange-500/20" />
            </div>
          </div>

          <div className="flex md:flex-col gap-3 w-full md:w-auto shrink-0 md:pl-8 md:border-l border-border/50">
            <Button
              className="w-full hover-elevate active-elevate-2 shadow-md"
              size="lg"
              onClick={() => setMessageOpen(true)}
            >
              <Mail className="w-4 h-4 mr-2" />Message
            </Button>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={openEditDialog}
            >
              <Pencil className="w-4 h-4" />
              Edit Profile
            </Button>
            {candidate.hasPortalAccess ? (
              <Button
                variant="outline"
                className="w-full gap-2 border-green-500/40 text-green-400 cursor-default hover:bg-green-500/5"
                disabled
              >
                <UserCheck className="w-4 h-4" />
                Portal Active
              </Button>
            ) : (
              <Button
                variant="outline"
                className="w-full gap-2 border-primary/30 text-primary hover:bg-primary/10"
                onClick={handleInvite}
                disabled={inviteLoading}
              >
                {inviteLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                Invite to Portal
              </Button>
            )}
            <div className="flex gap-2 w-full">
              {candidate.linkedinUrl && (
                <Button variant="outline" className="flex-1 hover-elevate" asChild>
                  <a href={candidate.linkedinUrl} target="_blank" rel="noopener noreferrer" aria-label="View LinkedIn profile"><Linkedin className="w-4 h-4" /></a>
                </Button>
              )}
              {candidate.githubUrl && (
                <Button variant="outline" className="flex-1 hover-elevate" asChild>
                  <a href={candidate.githubUrl} target="_blank" rel="noopener noreferrer" aria-label="View GitHub profile"><Github className="w-4 h-4" /></a>
                </Button>
              )}
            </div>
            <ResumeUploader candidateId={candidateId} resumeUrl={candidate.resumeUrl} compact />
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2 border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:border-violet-400/50 transition-all"
              onClick={() => {
                trackShareEvent("share_clicked", { candidateId });
                setShareOpen(true);
              }}
            >
              <Share2 className="w-3.5 h-3.5" />
              Share Profile
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2 border-sky-500/30 text-sky-400 hover:bg-sky-500/10 hover:border-sky-400/50 transition-all"
              onClick={() => setPushToClientOpen(true)}
            >
              <Building2 className="w-3.5 h-3.5" />
              Push to Client
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 hover:border-emerald-400/50 transition-all"
              onClick={handleDownloadEvaluation}
            >
              <Download className="w-3.5 h-3.5" />
              Download Evaluation
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="w-full gap-2 border-violet-500/30 text-violet-400 hover:bg-violet-500/10 hover:border-violet-400/50 transition-all"
              onClick={() => setHmShareOpen(true)}
            >
              <Mail className="w-3.5 h-3.5" />
              Send to Hiring Manager
            </Button>
          </div>
        </div>

        {/* ── Connection Strength stat strip ── */}
        {connEnabled && connScore && (
          <div className="mt-5 pt-4 border-t border-border/30 flex flex-wrap items-center gap-x-8 gap-y-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Connection Strength</p>
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-muted-foreground" />
                <span className={cn("text-2xl font-black tabular-nums leading-none", connStyle.color)}>
                  {connScore.score}
                </span>
                <span className={cn("text-[11px] font-semibold px-2 py-0.5 rounded-full border", connStyle.bg, connStyle.color)}>
                  {connScore.label}
                </span>
              </div>
            </div>
            {(connScore.topSignals ?? []).length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Signals</p>
                <div className="flex flex-wrap gap-1.5">
                  {connScore.topSignals.map(sig => (
                    <span
                      key={sig}
                      className="text-[10px] font-medium text-muted-foreground bg-muted/60 border border-border/40 px-2 py-0.5 rounded-full"
                    >
                      {connSignalLabels[sig] ?? sig}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <div className="w-full overflow-x-auto mb-8">
          <TabsList className="min-w-max h-auto p-1 bg-muted/50 rounded-xl gap-0.5">
            <TabsTrigger value="overview" className="rounded-lg py-2.5 px-4">Overview</TabsTrigger>
            <TabsTrigger value="career" className="rounded-lg py-2.5 px-4 flex items-center gap-1.5">
              <Sparkles className="w-3 h-3" /> Career Profile
            </TabsTrigger>
            <TabsTrigger value="resume" className="rounded-lg py-2.5 px-4">Resume Screen</TabsTrigger>
            <TabsTrigger value="interviews" className="rounded-lg py-2.5 px-4">Interviews</TabsTrigger>
            <TabsTrigger value="verification" className="rounded-lg py-2.5 px-4">Verification</TabsTrigger>
            <TabsTrigger value="evaluation" className="rounded-lg py-2.5 px-4 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5" /> Evaluation
            </TabsTrigger>
            <TabsTrigger value="intelligence" className="rounded-lg py-2.5 px-4 flex items-center gap-1.5">
              <Brain className="w-3.5 h-3.5" /> Intelligence
            </TabsTrigger>
            <TabsTrigger value="activity" className="rounded-lg py-2.5 px-4 flex items-center gap-1.5">
              <Activity className="w-3 h-3" /> Engagement
            </TabsTrigger>
            <TabsTrigger value="timeline" className="rounded-lg py-2.5 px-4 flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> Timeline
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          {/* ── Hiring-manager share decisions ── */}
          {hmShares.length > 0 && (
            <Card className="shadow-sm border-violet-500/20">
              <div className="h-1 bg-gradient-to-r from-violet-500 to-primary rounded-t-lg" />
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Mail className="w-4 h-4 text-violet-400" />
                  Hiring Manager Reviews
                  <Badge className="ml-auto bg-violet-500/10 text-violet-400 border-violet-500/20 text-xs font-normal">
                    {hmShares.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {hmShares.map((s) => {
                  const decided = s.decision
                    ? { advance: "Advanced", interview: "Requested interview", pass: "Passed" }[s.decision]
                    : null;
                  const decisionColor = s.decision === "advance" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                    : s.decision === "interview" ? "text-sky-400 bg-sky-500/10 border-sky-500/20"
                    : s.decision === "pass" ? "text-rose-400 bg-rose-500/10 border-rose-500/20"
                    : "text-muted-foreground bg-muted/40 border-border/40";
                  const statusLabel = s.decision ? decided
                    : s.status === "viewed" ? "Viewed"
                    : s.status === "expired" ? "Expired" : "Sent";
                  return (
                    <div key={s.id} className="flex items-start justify-between gap-3 p-3 rounded-lg border border-border/40 bg-muted/20">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">
                          {s.recipientName || s.recipientEmail}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{s.recipientEmail}</p>
                        {s.decisionComment && (
                          <p className="text-xs text-muted-foreground mt-1 italic">“{s.decisionComment}”{s.decidedByName ? ` — ${s.decidedByName}` : ""}</p>
                        )}
                      </div>
                      <span className={cn("text-[11px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap shrink-0", decisionColor)}>
                        {statusLabel}
                      </span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* ── Career Snapshot (from AI interview) ── */}
          {cp && (
            <Card className="shadow-sm border-violet-500/20">
              <div className="h-1 bg-gradient-to-r from-violet-500 to-primary rounded-t-lg" />
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="w-4 h-4 text-violet-400" />
                  Career Snapshot
                  <Badge className="ml-auto bg-violet-500/10 text-violet-400 border-violet-500/20 text-xs font-normal">
                    From Career Interview
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Bio + role/company/exp */}
                <div className="flex flex-col md:flex-row gap-5">
                  {cp.bio && (
                    <p className="flex-1 text-sm text-muted-foreground leading-relaxed italic border-l-2 border-violet-500/30 pl-3">
                      "{cp.bio}"
                    </p>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-1 gap-3 md:w-52 shrink-0 text-sm">
                    {(cp.currentTitle || cp.currentCompany) && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-0.5">Current Role</p>
                        <p className="font-medium">{[cp.currentTitle, cp.currentCompany].filter(Boolean).join(" · ")}</p>
                      </div>
                    )}
                    {cp.yearsExperience != null && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-0.5">Experience</p>
                        <p className="font-medium">{cp.yearsExperience} yrs</p>
                      </div>
                    )}
                    {cp.education && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-0.5">Education</p>
                        <p className="font-medium text-xs leading-snug">{cp.education}</p>
                      </div>
                    )}
                    {cp.location && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-0.5">Location</p>
                        <p className="font-medium">{cp.location}</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Goals + targets */}
                {(cp.careerGoal3yr || cp.careerGoal5yr || (cp.targetIndustries?.length > 0) || (cp.preferredRoles?.length > 0)) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-border/40">
                    {cp.careerGoal3yr && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 flex items-center gap-1">
                          <Target className="w-3 h-3" /> 3-Year Goal
                        </p>
                        <p className="text-sm leading-relaxed">{cp.careerGoal3yr}</p>
                      </div>
                    )}
                    {cp.careerGoal5yr && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 flex items-center gap-1">
                          <TrendingUp className="w-3 h-3" /> 5-Year Goal
                        </p>
                        <p className="text-sm leading-relaxed">{cp.careerGoal5yr}</p>
                      </div>
                    )}
                    {cp.targetIndustries?.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 flex items-center gap-1">
                          <Building className="w-3 h-3" /> Target Industries
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {cp.targetIndustries.map((ind: string) => (
                            <Badge key={ind} variant="outline" className="text-xs">{ind}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {cp.preferredRoles?.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1 flex items-center gap-1">
                          <FileText className="w-3 h-3" /> Preferred Roles
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {cp.preferredRoles.map((r: string) => (
                            <Badge key={r} variant="outline" className="text-xs">{r}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Strengths + Growth */}
                {(cp.strengthAreas?.length > 0 || cp.growthAreas?.length > 0) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-border/40">
                    {cp.strengthAreas?.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-emerald-500 font-semibold mb-1">Strength Areas</p>
                        <div className="flex flex-wrap gap-1">
                          {cp.strengthAreas.map((s: string) => (
                            <Badge key={s} className="text-xs bg-emerald-500/10 text-emerald-600 border-emerald-500/20">{s}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {cp.growthAreas?.length > 0 && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wider text-amber-500 font-semibold mb-1">Growth Areas</p>
                        <div className="flex flex-wrap gap-1">
                          {cp.growthAreas.map((g: string) => (
                            <Badge key={g} className="text-xs bg-amber-500/10 text-amber-600 border-amber-500/20">{g}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              <Card className="shadow-sm">
                <CardHeader><CardTitle>Skills & Expertise</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2">
                    {displaySkills.length > 0
                      ? displaySkills.map((skill: string, i: number) => (
                          <Badge key={i} variant="secondary" className="px-3 py-1 text-sm bg-primary/10 text-primary hover:bg-primary/20">{skill}</Badge>
                        ))
                      : <p className="text-muted-foreground text-sm">No skills listed</p>}
                  </div>
                </CardContent>
              </Card>

              {resumeScreen?.workHistory && resumeScreen.workHistory.length > 0 && (
                <Card className="shadow-sm">
                  <CardHeader><CardTitle>Experience Timeline</CardTitle></CardHeader>
                  <CardContent>
                    <div className="space-y-6 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent">
                      {resumeScreen.workHistory.map((work: any, idx: number) => (
                        <div key={idx} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                          <div className="flex items-center justify-center w-10 h-10 rounded-full border-4 border-background bg-primary/20 text-primary shadow shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 z-10">
                            <Briefcase className="w-4 h-4" />
                          </div>
                          <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] bg-card p-4 rounded-xl border shadow-sm hover-elevate">
                            <div className="flex items-center justify-between space-x-2 mb-1">
                              <div className="font-bold text-foreground">{work.title}</div>
                              <time className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">{work.startDate || "?"} - {work.current ? "Present" : (work.endDate || "?")}</time>
                            </div>
                            <div className="text-sm font-medium text-muted-foreground">{work.company}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>

            <div className="space-y-6">
              <Card className="shadow-sm border-primary/20">
                <div className="h-2 bg-gradient-to-r from-primary to-accent" />
                <CardHeader className="pb-2"><CardTitle className="text-lg">Talent Match</CardTitle></CardHeader>
                <CardContent className="text-center pt-2 pb-6">
                  <div className="text-6xl font-bold text-primary mb-2 font-display">{overallTalentMatch != null ? `${overallTalentMatch}%` : "—"}</div>
                  <p className="text-sm text-muted-foreground">
                    {matchedRoles.length > 0 ? "Best fit across matched roles" : "No roles matched yet"}
                  </p>
                  <div className="mt-6 pt-4 border-t text-left">
                    <p className="text-sm font-medium mb-2">Matched Roles:</p>
                    {matchedRoles.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-2">
                        Run Talent Match from a Work Order to score this candidate against open roles.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {matchedRoles.map(m => (
                          <Link key={m.id} href={`/jobs/${m.jobId}`}>
                            <div className="flex justify-between items-center text-sm p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors cursor-pointer">
                              <span className="truncate">{m.jobTitle ?? "Untitled role"}</span>
                              {m.fitScore != null
                                ? <ScoreBadge score={Math.round(m.fitScore)} />
                                : <span className="text-xs text-muted-foreground shrink-0">Not scored</span>}
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card className="shadow-sm">
                <CardHeader><CardTitle className="text-lg">Contact Info</CardTitle></CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div>
                    <p className="text-muted-foreground mb-1">Email</p>
                    <p className="font-medium truncate">{candidate.email}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">Phone</p>
                    <p className="font-medium">{candidate.phone || "N/A"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground mb-1">Timezone</p>
                    <p className="font-medium">{candidate.timezone || "N/A"}</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="career" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <CareerProfileTab candidateId={candidateId} onShare={() => setPushToClientOpen(true)} />
        </TabsContent>

        <TabsContent value="resume" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <ResumeScreenTab resumeScreen={resumeScreen} candidateId={candidateId} resumeUrl={candidate.resumeUrl} />
        </TabsContent>

        <TabsContent value="interviews" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <InterviewsTab candidateId={candidateId} />
        </TabsContent>

        <TabsContent value="verification" className="space-y-6">
          <div className="flex items-center gap-2 p-3 bg-green-500/5 border border-green-500/20 rounded-xl">
            <Bot className="w-4 h-4 text-green-500" />
            <span className="text-xs font-medium text-green-700">Verification Agent</span>
            <span className="text-xs text-muted-foreground ml-1">· Digital identity checks run automatically after interview stage</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card className="lg:col-span-1 shadow-sm h-max">
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-primary" />Status Overview</CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 text-center">
                <div className="relative w-32 h-32 mx-auto flex items-center justify-center">
                  <svg className="w-full h-full transform -rotate-90">
                    <circle cx="64" cy="64" r="60" className="stroke-muted fill-none" strokeWidth="8" />
                    <circle cx="64" cy="64" r="60" className={`fill-none stroke-current ${verification?.riskScore && verification.riskScore > VERIFY_RISK_HIGH_MAX ? "text-destructive" : "text-green-500"}`} strokeWidth="8" strokeDasharray={377} strokeDashoffset={377 - (377 * (verification?.riskScore || 0)) / 100} />
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
                    <span className="text-3xl font-bold leading-none">{verification?.riskScore || 0}</span>
                    <span className="text-[10px] uppercase text-muted-foreground font-semibold mt-1">Risk Score</span>
                  </div>
                </div>
                <VerificationBadge status={verification?.status || "unverified"} className="text-sm px-4 py-1" />

                {/* Work-authorisation screening data the candidate self-reported
                    during portal onboarding. We surface it here because it's
                    a hard hiring filter. These fields are SEPARATE from voluntary
                    demographics (race/gender/etc.) which are intentionally never
                    shown on this page — only aggregated on the diversity
                    analytics dashboard with k≥5 anonymity. */}
                <div className="pt-6 border-t space-y-2 text-left">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Work Authorization</p>
                  {(candidate as any)?.screeningCompletedAt ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant={(candidate as any).workAuthorized ? "default" : "destructive"} className="text-xs">
                        {(candidate as any).workAuthorized ? "Authorized to work" : "Not authorized"}
                      </Badge>
                      <Badge variant={(candidate as any).requiresSponsorship ? "destructive" : "secondary"} className="text-xs">
                        {(candidate as any).requiresSponsorship ? "Needs sponsorship" : "No sponsorship needed"}
                      </Badge>
                      {(candidate as any).sponsorshipCountry && (
                        <Badge variant="outline" className="text-xs">{(candidate as any).sponsorshipCountry}</Badge>
                      )}
                      {(candidate as any).sponsorshipNotes && (
                        <p className="text-xs text-muted-foreground italic w-full pt-1">"{(candidate as any).sponsorshipNotes}"</p>
                      )}
                      {((candidate as any).workAuthSource === "baseline_interview" || (candidate as any).workAuthSource === "job_interview") && (
                        <p className="text-[11px] text-muted-foreground w-full pt-1">
                          Captured during {(candidate as any).workAuthSource === "job_interview" ? "the job interview" : "the candidate interview"} · not part of interview scoring
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">Candidate hasn't completed screening yet.</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4 text-left pt-6 border-t">
                  <div>
                    <p className="text-xs text-muted-foreground">Identity Check</p>
                    <p className="font-semibold text-sm">{verification?.identityVerified ? "Verified" : "Unverified"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Duplicate Profile</p>
                    <p className="font-semibold text-sm">{verification?.duplicateDetected ? "Detected" : "Clear"}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="lg:col-span-2 shadow-sm">
              <CardHeader><CardTitle>Risk Flags</CardTitle></CardHeader>
              <CardContent>
                {!verification?.flags || verification.flags.length === 0 ? (
                  <div className="text-center py-12 bg-muted/20 rounded-xl border border-dashed">
                    <ShieldCheck className="w-12 h-12 text-green-500 mx-auto mb-3 opacity-50" />
                    <h3 className="font-bold">No risk flags detected</h3>
                    <p className="text-sm text-muted-foreground mt-1">Candidate profile appears clean and consistent.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {verification.flags.map((flag: any, idx: number) => (
                      <div key={idx} className="flex gap-4 p-4 rounded-xl border border-destructive/20 bg-destructive/5">
                        <AlertTriangle className="w-6 h-6 text-destructive shrink-0 mt-0.5" />
                        <div>
                          <h4 className="font-bold text-destructive capitalize mb-1">{flag.type?.replace(/_/g, " ") || "Flag"}</h4>
                          <p className="text-sm text-muted-foreground mb-2">{flag.description}</p>
                          {flag.detectedAt && (
                            <Badge variant="outline" className="bg-white text-xs">{formatDate(flag.detectedAt)}</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="intelligence" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <IntelligenceTab candidateId={candidateId} candidateName={candidate ? `${candidate.firstName} ${candidate.lastName}` : undefined} />
        </TabsContent>

        <TabsContent value="activity" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1">
              <ConnectionStrengthPanel candidateId={candidateId} />
            </div>
            <div className="lg:col-span-2">
              <ActivityTab candidateId={candidateId} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="timeline" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <Card className="shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="w-4 h-4 text-primary" /> Hiring Timeline
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Every recorded event for this candidate, newest first.
              </p>
            </CardHeader>
            <CardContent className="pt-0">
              <CandidateTimeline candidateId={candidateId} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="evaluation" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          {(() => {
            const evalRole = scoredRoles[0] ?? matchedRoles[0];
            const evalJobId = evalRole?.jobId ?? null;
            if (!evalJobId) {
              return (
                <Card className="shadow-sm">
                  <CardContent className="py-12 text-center text-muted-foreground">
                    <FileText className="w-8 h-8 mx-auto mb-3 text-muted-foreground/40" />
                    <p className="text-sm">
                      Link this candidate to a role to generate a client-facing evaluation.
                    </p>
                  </CardContent>
                </Card>
              );
            }
            return (
              <CandidateEvaluationReport
                jobId={evalJobId}
                candidateId={candidateId}
                candidateName={`${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim()}
                jobTitle={evalRole?.jobTitle ?? null}
              />
            );
          })()}
        </TabsContent>
      </Tabs>

      {/* ── Push to Client Modal ─────────────────────────────────────────── */}
      {candidate && (
        <PushToClientModal
          open={pushToClientOpen}
          onClose={() => setPushToClientOpen(false)}
          candidateId={candidateId}
          candidateName={`${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim()}
        />
      )}

      {candidate && (
        <SendToHiringManagerModal
          open={hmShareOpen}
          onOpenChange={setHmShareOpen}
          candidateId={candidateId}
          candidateName={`${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim()}
          jobId={evalJobId}
          buildPdfData={buildEvaluationData}
          getApprovedReportPdf={async () => {
            try {
              const ev = await ensureStructuredEvaluation();
              return ev ? await getEvaluationReportPdfBase64(buildReportPdfData(ev)) : null;
            } catch {
              return null; // modal falls back to the legacy attachment
            }
          }}
        />
      )}

      {shareOpen && (() => {
        const intel = intelligenceData?.data?.[0];
        const scores = {
          hireProbability:   intel?.hireProbability   ?? null,
          fitScore:          intel?.fitScore          ?? null,
          qualityScore:      intel?.qualityScore      ?? null,
          trustScore:        intel?.trustScore        ?? null,
          conversionScore:   intel?.conversionScore   ?? null,
          talentMatchScore:  candidate?.talentMatchScore ?? null,
        };
        const sigs = (intel?.signalsJson ?? {}) as any;
        const insight = extractInsight(scores, sigs, `${candidate?.firstName} ${candidate?.lastName}`);
        const jobTitle = intel
          ? (intel.jobTitle ?? undefined)
          : (candidate?.currentTitle ?? undefined);
        return (
          <ShareModal
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            insight={insight}
            candidateName={`${candidate?.firstName} ${candidate?.lastName}`}
            jobTitle={jobTitle}
          />
        );
      })()}

      {/* ── Invite to Portal Dialog ──────────────────────────────────────── */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="w-5 h-5 text-primary" /> Portal invite created
            </DialogTitle>
            <DialogDescription>
              Share this link with {candidate?.firstName} so they can access their candidate portal.
              The link expires in 7 days.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-xl border border-border/60">
              <code className="text-xs text-muted-foreground flex-1 break-all">{inviteUrl}</code>
            </div>
            <div className="flex gap-2">
              <Button className="flex-1 gap-2" onClick={copyInviteLink}>
                <Copy className="w-4 h-4" /> Copy link
              </Button>
              <a href={inviteUrl} target="_blank" rel="noopener noreferrer" className="flex-1">
                <Button variant="outline" className="w-full gap-2">
                  <ExternalLink className="w-4 h-4" /> Preview
                </Button>
              </a>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              The candidate will be logged in automatically when they click the link.
              Each link can only be used once.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Message Dialog ───────────────────────────────────────────────── */}
      <Dialog open={messageOpen} onOpenChange={(o) => { if (!messageLoading) setMessageOpen(o); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-primary" /> Message {candidate?.firstName}
            </DialogTitle>
            <DialogDescription>
              Send an email directly to {candidate?.email || "this candidate"}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="message-subject">Subject</Label>
              <Input
                id="message-subject"
                value={messageSubject}
                onChange={(e) => setMessageSubject(e.target.value)}
                placeholder="Quick question about your application"
                maxLength={200}
                disabled={messageLoading}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="message-body">Message</Label>
              <Textarea
                id="message-body"
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
                placeholder={`Hi ${candidate?.firstName ?? "there"},\n\n`}
                rows={7}
                maxLength={5000}
                disabled={messageLoading}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMessageOpen(false)} disabled={messageLoading}>
              Cancel
            </Button>
            <Button onClick={handleSendMessage} disabled={messageLoading} className="gap-2">
              {messageLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Send message
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Profile Dialog ──────────────────────────────────────────── */}
      <Dialog open={editOpen} onOpenChange={(o) => { if (!editSaving) setEditOpen(o); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-primary" /> Edit candidate profile
            </DialogTitle>
            <DialogDescription>
              Update {candidate?.firstName}'s details. Changes are saved to their record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-first">First name</Label>
                <Input id="edit-first" value={editForm.firstName} disabled={editSaving}
                  onChange={(e) => setEditForm((f) => ({ ...f, firstName: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-last">Last name</Label>
                <Input id="edit-last" value={editForm.lastName} disabled={editSaving}
                  onChange={(e) => setEditForm((f) => ({ ...f, lastName: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-email">Email</Label>
              <Input id="edit-email" type="email" value={editForm.email} disabled={editSaving}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-phone">Phone</Label>
                <Input id="edit-phone" value={editForm.phone} disabled={editSaving}
                  onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-location">Location</Label>
                <Input id="edit-location" value={editForm.location} disabled={editSaving}
                  onChange={(e) => setEditForm((f) => ({ ...f, location: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit-title">Current title</Label>
                <Input id="edit-title" value={editForm.currentTitle} disabled={editSaving}
                  onChange={(e) => setEditForm((f) => ({ ...f, currentTitle: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit-company">Current company</Label>
                <Input id="edit-company" value={editForm.currentCompany} disabled={editSaving}
                  onChange={(e) => setEditForm((f) => ({ ...f, currentCompany: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-linkedin">LinkedIn URL</Label>
              <Input id="edit-linkedin" value={editForm.linkedinUrl} disabled={editSaving}
                placeholder="https://linkedin.com/in/…"
                onChange={(e) => setEditForm((f) => ({ ...f, linkedinUrl: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-github">GitHub URL</Label>
              <Input id="edit-github" value={editForm.githubUrl} disabled={editSaving}
                placeholder="https://github.com/…"
                onChange={(e) => setEditForm((f) => ({ ...f, githubUrl: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={editSaving}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={editSaving} className="gap-2">
              {editSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}

/* ── Intelligence Tab ────────────────────────────────────────────────────── */
function IntelligenceTab({ candidateId, candidateName }: { candidateId: string; candidateName?: string }) {
  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ data: Array<{ jobId: string; jobTitle?: string | null; hireProbability: number | null; nextBestAction: string | null }> }>({
    queryKey: ["intelligence", "candidate", candidateId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/intelligence/candidate/${candidateId}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json();
    },
  });

  const records = data?.data ?? [];
  const effectiveJobId = selectedJobId ?? records[0]?.jobId ?? null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-muted-foreground">
        <Brain className="w-5 h-5 animate-pulse text-primary" />
        <span className="text-sm">Loading intelligence…</span>
      </div>
    );
  }

  if (records.length === 0) {
    return (
      <div className="text-center py-16 space-y-3">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto">
          <Brain className="w-8 h-8 text-primary opacity-40" />
        </div>
        <p className="font-semibold">No intelligence data yet</p>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          Intelligence records are created when this candidate is added to a Work Order and the engine runs.
          Go to a Work Order's Intelligence tab to activate it.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-4">
      {/* Job selector if multiple records */}
      {records.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">Viewing intelligence for:</span>
          {records.map(r => (
            <button
              key={r.jobId}
              type="button"
              onClick={() => setSelectedJobId(r.jobId)}
              className={`px-3 py-1 rounded-full border text-xs font-medium transition-all ${
                r.jobId === effectiveJobId
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border/50 text-muted-foreground hover:border-border"
              }`}
            >
              Job {r.jobId.slice(0, 6)}
              {r.hireProbability != null && (
                <span className="ml-1.5 opacity-70">{r.hireProbability}%</span>
              )}
            </button>
          ))}
        </div>
      )}

      {effectiveJobId && (
        <CandidateIntelligenceCard
          jobId={effectiveJobId}
          candidateId={candidateId}
          candidateName={candidateName}
        />
      )}
    </div>
  );
}
