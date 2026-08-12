/**
 * pages/recruiter/interviews/index.tsx — Interviews Dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Gives a recruiter a cross-job view of all interview sessions. Shows pending
 * invites, live sessions, completed sessions, and abandoned sessions in tabs.
 * Also surfaces AI interview report highlights in cards.
 *
 * ─── Tabs ────────────────────────────────────────────────────────────────────
 *   Pending    — sessions whose invite was sent but not yet started
 *   Live       — sessions currently in progress (status="in_progress")
 *   Completed  — sessions with a summary report (status="completed")
 *   Abandoned  — sessions that timed out or were abandoned
 *
 * ─── Actions ─────────────────────────────────────────────────────────────────
 *   "Send Reminder" — re-sends the interview invite email
 *   "View Report"   — navigates to /recruiter/interviews/:id
 *   "Cancel"        — marks the session as cancelled
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *   useListInterviews() — GET /api/interviews?tenantId=…
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/interviews
 */
import { useState, useEffect } from "react";
import { authHeaders } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { useListInterviews } from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Video, Calendar, Clock, PlayCircle, FileText, ScanFace, Brain,
  Activity, Bot, Plus, Globe, Mic, Cloud, Copy, Check,
  ExternalLink, ChevronRight, ArrowLeft, Users, Link2, Briefcase,
  Target, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { ScoreBadge } from "@/components/ui-custom/Badges";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useToast } from "@workspace/react-hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

interface LanguageOption {
  code: string; label: string; nativeName: string; family: string;
  speechProvider: "deepgram" | "azure"; llmProvider: "openai" | "azure";
  region: "indian" | "global"; ready: boolean; deepgramReady: boolean; azureReady: boolean;
}
interface LangGroup { key: string; heading: string; icon: "deepgram" | "azure"; langs: LanguageOption[]; }

// Bucket the flat language list into provider-aware groups (Deepgram English/
// Spanish, Azure Indian/other) for the language picker; drops empty buckets.
function groupLanguages(languages: LanguageOption[]): LangGroup[] {
  const english = languages.filter(l => l.family === "english");
  const spanish = languages.filter(l => l.family === "spanish");
  const indian  = languages.filter(l => l.region === "indian");
  const other   = languages.filter(l => l.speechProvider === "azure" && l.region === "global");
  const groups: LangGroup[] = [
    { key: "english", heading: "English variants — Deepgram", icon: "deepgram", langs: english },
    { key: "spanish", heading: "Spanish variants — Deepgram", icon: "deepgram", langs: spanish },
    { key: "indian",  heading: "Indian languages — Azure",    icon: "azure",    langs: indian  },
    { key: "other",   heading: "Other global languages — Azure", icon: "azure", langs: other   },
  ];
  return groups.filter(g => g.langs.length > 0);
}

// Section header inside the language dropdown showing the provider icon.
function GroupHeading({ heading, icon }: { heading: string; icon: "deepgram" | "azure" }) {
  return (
    <div className="px-2 py-1.5 mt-1 first:mt-0 text-[10px] font-bold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5 border-t first:border-t-0 border-border/40">
      {icon === "deepgram" ? <Mic className="w-3 h-3 text-violet-500" /> : <Cloud className="w-3 h-3 text-blue-500" />}
      {heading}
    </div>
  );
}

// A single language option in the picker.
function LangItem({ lang }: { lang: LanguageOption }) {
  const isDeepgram = lang.speechProvider === "deepgram";
  return (
    <SelectItem value={lang.code}>
      <span className="flex items-center gap-2">
        {isDeepgram ? <Mic className="w-3 h-3 text-violet-500 shrink-0" /> : <Cloud className="w-3 h-3 text-blue-500 shrink-0" />}
        <span>{lang.label}</span>
        <span className="text-muted-foreground text-[11px]">{lang.nativeName}</span>
      </span>
    </SelectItem>
  );
}

export default function InterviewsDashboard() {
  const { data: interviews, isLoading } = useListInterviews();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  /* Dialog state */
  const [showSchedule, setShowSchedule] = useState(false);
  const [step, setStep] = useState<"form" | "done">("form");
  const [generatedLink, setGeneratedLink] = useState("");
  const [generatedId, setGeneratedId] = useState("");
  const [emailedTo, setEmailedTo] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedCardId, setCopiedCardId] = useState<string | null>(null);

  /* Form state */
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [selectedJobId,       setSelectedJobId]       = useState("");
  const [selectedLanguage,    setSelectedLanguage]    = useState("en-US");
  const [selectedType,        setSelectedType]        = useState("general");
  const [questionCount,       setQuestionCount]       = useState("5");
  const [focusDirective,      setFocusDirective]      = useState("");
  const [customQuestions,     setCustomQuestions]     = useState<string[]>([]);

  /* Data */
  const { data: languages = [] } = useQuery<LanguageOption[]>({
    queryKey: ["interview-languages"],
    queryFn: () => apiFetch("/interviews/languages"),
  });
  const { data: jobs = [] } = useQuery<any[]>({
    queryKey: ["jobs-for-interview"],
    queryFn: async () => {
      const data = await apiFetch<any>("/jobs");
      return data.jobs ?? [];
    },
  });
  const { data: candidatesData } = useQuery<any>({
    queryKey: ["candidates-for-interview"],
    queryFn: () => apiFetch("/candidates?limit=100"),
  });
  const candidates: any[] = candidatesData?.candidates ?? [];
  const groups = groupLanguages(languages);
  const selectedLangMeta = languages.find(l => l.code === selectedLanguage);

  /* Generate interview link — creates a session and returns the magic-link URL
     the candidate uses to enter the room. */
  const scheduleMutation = useMutation({
    mutationFn: async () => {
      return apiFetch<any>("/interviews/generate-link", {
        method: "POST",
        body: JSON.stringify({
          jobId:           selectedJobId,
          candidateId:     selectedCandidateId || "demo",
          interviewType:   selectedType,
          questionCount:   Number(questionCount),
          language:        selectedLanguage,
          focusDirective:  focusDirective.trim() || undefined,
          customQuestions: customQuestions.map(q => q.trim()).filter(Boolean),
        }),
      });
    },
    onSuccess: (data) => {
      const baseUrl = window.location.origin + BASE;
      const roomUrl = `${baseUrl}/interviews/${data.sessionId}/room`;
      setGeneratedLink(roomUrl);
      setGeneratedId(data.sessionId);
      setEmailedTo(data.emailSent ? (data.emailedTo ?? null) : null);
      setStep("done");
      queryClient.invalidateQueries({ queryKey: ["listInterviews"] });
    },
    onError: () => toast({ title: "Error", description: "Could not generate interview link.", variant: "destructive" }),
  });

  const handleCopy = () => {
    navigator.clipboard.writeText(generatedLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    toast({ title: "Link copied!", description: "Share this link with the candidate." });
  };

  /* Copy a card's candidate-facing interview link without triggering the card's
     navigation (the button lives inside the <Link> wrapper). */
  const copyInterviewLink = (id: string) => {
    const roomUrl = `${window.location.origin + BASE}/interviews/${id}/room`;
    navigator.clipboard.writeText(roomUrl);
    setCopiedCardId(id);
    setTimeout(() => setCopiedCardId((cur) => (cur === id ? null : cur)), 2000);
    toast({ title: "Link copied!", description: "Share this interview link with the candidate." });
  };

  const openSchedule = () => {
    setStep("form");
    setGeneratedLink("");
    setGeneratedId("");
    setSelectedCandidateId("");
    setSelectedJobId("");
    setShowSchedule(true);
  };

  /* Deep-link: another page (e.g. the candidate profile "Schedule AI Interview"
     button) can open this dialog with a candidate pre-selected by navigating to
     /interviews?candidateId=…&schedule=1. We honour it once on mount, then strip
     the query string so a refresh doesn't reopen the dialog. */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("schedule") !== "1") return;
    setStep("form");
    setGeneratedLink("");
    setGeneratedId("");
    setSelectedCandidateId(params.get("candidateId") ?? "");
    setSelectedJobId(params.get("jobId") ?? "");
    setShowSchedule(true);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  /* Filters — client (tenant) and work order dropdowns narrow every tab and
   * the stat cards. Options derive from the visible (already server-scoped)
   * sessions, so each user only sees their own clients/work orders. */
  const [clientFilter, setClientFilter] = useState("all");
  const [jobFilter, setJobFilter] = useState("all");
  const clientOptions = Array.from(
    new Map((interviews ?? []).filter((i: any) => i.tenantId && i.clientName).map((i: any) => [i.tenantId, i.clientName])).entries(),
  ).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const jobOptions = Array.from(
    new Map(
      (interviews ?? [])
        .filter((i: any) => i.jobId && i.jobTitle && (clientFilter === "all" || i.tenantId === clientFilter))
        .map((i: any) => [i.jobId, i.jobTitle]),
    ).entries(),
  ).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const visible = (interviews ?? []).filter(
    (i: any) =>
      (clientFilter === "all" || i.tenantId === clientFilter) &&
      (jobFilter === "all" || i.jobId === jobFilter),
  );
  const inProgress = visible.filter(i => i.status === "in_progress");
  const scheduled  = visible.filter(i => i.status === "scheduled");
  const completed  = visible.filter(i => i.status === "completed");

  /* Interview card */
  const renderCard = (interview: any) => {
    const isLive      = interview.status === "in_progress";
    const isCompleted = interview.status === "completed";
    const langCode    = interview.language === "pt" ? "pt-BR" : interview.language;
    const langMeta    = languages.find((l: LanguageOption) => l.code === langCode);
    return (
      <Link key={interview.id} href={`/interviews/${interview.id}`}>
        <Card className={cn(
          "overflow-hidden shadow-sm border-border/60 hover:border-primary/30 transition-all cursor-pointer group hover:-translate-y-0.5",
          isLive && "border-blue-400/40 bg-blue-500/3"
        )}>
          <CardContent className="p-0">
            <div className="p-5 border-b flex justify-between items-start bg-card">
              <div className="flex gap-4">
                <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center shrink-0",
                  isLive ? "bg-blue-500/10 text-blue-500" : "bg-emerald-500/10 text-emerald-500"
                )}>
                  {isLive ? <Activity className="w-6 h-6 animate-pulse" /> : <Video className="w-6 h-6" />}
                </div>
                <div>
                  <h3 className="font-bold text-base leading-tight mb-1 group-hover:text-primary transition-colors">
                    {interview.candidateName
                      ? interview.candidateName
                      : interview.candidateId && interview.candidateId !== "demo"
                        ? `Candidate · ${interview.candidateId.substring(0, 8)}…`
                        : "Demo / Anonymous Candidate"}
                  </h3>
                  <p className="text-xs text-muted-foreground font-medium mb-2 flex items-center gap-1.5 flex-wrap">
                    <span className="inline-flex items-center gap-1">
                      <Briefcase className="w-3 h-3" />
                      {interview.jobTitle || "No work order"}
                    </span>
                    <span className="opacity-50">·</span>
                    <span>
                      {interview.interviewType
                        ? interview.interviewType.charAt(0).toUpperCase() + interview.interviewType.slice(1) + " Interview"
                        : "AI Interview"}
                    </span>
                  </p>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                      <Brain className="w-2.5 h-2.5" />AI Interviewer
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-500/10 text-rose-600 border border-rose-500/20">
                      <ScanFace className="w-2.5 h-2.5" />Proctored
                    </span>
                    {langMeta && (
                      <span className={cn("inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border",
                        langMeta.speechProvider === "deepgram"
                          ? "bg-violet-500/10 text-violet-600 border-violet-500/20"
                          : "bg-blue-500/10 text-blue-600 border-blue-500/20"
                      )}>
                        {langMeta.speechProvider === "deepgram" ? <Mic className="w-2.5 h-2.5" /> : <Cloud className="w-2.5 h-2.5" />}
                        {langMeta.nativeName}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-2">
                {isCompleted && interview.score && <ScoreBadge score={interview.score} className="text-sm px-3 py-1" />}
                {isLive && <Badge className="bg-blue-500 text-white animate-pulse gap-1"><span className="w-1.5 h-1.5 bg-white rounded-full" />Live</Badge>}
                {interview.status === "scheduled" && <Badge variant="outline" className="text-xs">Scheduled</Badge>}
                <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-primary transition-colors mt-1" />
              </div>
            </div>
            <div className="p-4 bg-muted/20 flex items-center justify-between">
              <div className="text-sm text-muted-foreground flex gap-4">
                <span className="flex items-center gap-1.5"><Calendar className="w-4 h-4" />{formatDate(interview.createdAt)}</span>
                <span className="flex items-center gap-1.5"><Clock className="w-4 h-4" />{interview.totalQuestions} questions</span>
              </div>
              <div className="flex items-center gap-4">
                {!isCompleted && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); copyInterviewLink(interview.id); }}
                    className="text-xs font-semibold text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
                    title="Copy the candidate's interview link"
                  >
                    {copiedCardId === interview.id
                      ? <><Check className="w-3.5 h-3.5 text-emerald-500" />Copied!</>
                      : <><Copy className="w-3.5 h-3.5" />Copy link</>}
                  </button>
                )}
                <span className="text-xs font-semibold text-primary flex items-center gap-1">
                  {isCompleted ? <><FileText className="w-3.5 h-3.5" />View Report</> :
                   isLive      ? <><PlayCircle className="w-3.5 h-3.5" />Join Live</> :
                                 <><PlayCircle className="w-3.5 h-3.5" />Open</>}
                  <ArrowLeft className="w-3 h-3 rotate-180" />
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </Link>
    );
  };

  const EmptyState = ({ msg }: { msg: string }) => (
    <div className="text-center py-20 text-muted-foreground bg-card border border-dashed rounded-xl space-y-3">
      <Video className="w-12 h-12 mx-auto opacity-20" />
      <p className="font-medium">{msg}</p>
      <Button onClick={openSchedule} variant="outline" size="sm" className="gap-2 mt-2">
        <Plus className="w-3.5 h-3.5" /> Schedule Interview
      </Button>
    </div>
  );

  return (
    <AppLayout>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <Link href="/jobs">
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2 mb-2">
              <ArrowLeft className="w-4 h-4" /> Back to Jobs
            </Button>
          </Link>
          <h1 className="page-title flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-500 flex items-center justify-center">
              <Video className="w-5 h-5" />
            </div>
            AI Interviews
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">Generative AI conducts, evaluates, and proctors every session autonomously</p>
        </div>
        <Button onClick={openSchedule} className="gap-2 shadow-md shadow-primary/20">
          <Plus className="w-4 h-4" /> Schedule Interview
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Total Sessions", value: visible.length, color: "text-primary"    },
          { label: "In Progress",    value: inProgress.length,       color: "text-blue-500"   },
          { label: "Scheduled",      value: scheduled.length,        color: "text-yellow-500" },
          { label: "Completed",      value: completed.length,        color: "text-green-500"  },
        ].map(stat => (
          <Card key={stat.label} className="border-border/40">
            <CardContent className="p-4 text-center">
              <div className={cn("text-3xl font-bold", stat.color)}>{stat.value}</div>
              <div className="text-xs text-muted-foreground mt-1">{stat.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {isLoading ? (
        <div className="text-center py-20">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full mx-auto" />
        </div>
      ) : (
        <Tabs defaultValue="all">
          <div className="flex flex-col md:flex-row md:items-center gap-3 mb-6">
            <TabsList className="bg-muted/50 p-1">
              <TabsTrigger value="all">All ({visible.length})</TabsTrigger>
              <TabsTrigger value="active" className="text-blue-400 data-[state=active]:text-blue-500">Live ({inProgress.length})</TabsTrigger>
              <TabsTrigger value="scheduled">Scheduled ({scheduled.length})</TabsTrigger>
              <TabsTrigger value="completed">Completed ({completed.length})</TabsTrigger>
            </TabsList>
            <div className="flex items-center gap-2 md:ml-auto">
              <Select value={clientFilter} onValueChange={(v) => { setClientFilter(v); setJobFilter("all"); }}>
                <SelectTrigger className="w-[190px] h-9">
                  <SelectValue placeholder="All clients" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All clients</SelectItem>
                  {clientOptions.map(([id, name]) => (
                    <SelectItem key={String(id)} value={String(id)}>{String(name)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={jobFilter} onValueChange={setJobFilter}>
                <SelectTrigger className="w-[210px] h-9">
                  <SelectValue placeholder="All work orders" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All work orders</SelectItem>
                  {jobOptions.map(([id, title]) => (
                    <SelectItem key={String(id)} value={String(id)}>{String(title)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <TabsContent value="all">
            {visible.length
              ? <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{visible.map(renderCard)}</div>
              : <EmptyState msg={clientFilter !== "all" || jobFilter !== "all" ? "No interviews match these filters." : "No interviews yet — schedule your first one."} />}
          </TabsContent>
          <TabsContent value="active">
            {inProgress.length
              ? <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{inProgress.map(renderCard)}</div>
              : <EmptyState msg="No live sessions right now." />}
          </TabsContent>
          <TabsContent value="scheduled">
            {scheduled.length
              ? <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{scheduled.map(renderCard)}</div>
              : <EmptyState msg="No scheduled sessions." />}
          </TabsContent>
          <TabsContent value="completed">
            {completed.length
              ? <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{completed.map(renderCard)}</div>
              : <EmptyState msg="No completed sessions yet." />}
          </TabsContent>
        </Tabs>
      )}

      {/* ── Schedule Interview Dialog ───────────────────────────────────────── */}
      <Dialog open={showSchedule} onOpenChange={(open) => { setShowSchedule(open); if (!open) { setStep("form"); setFocusDirective(""); setCustomQuestions([]); } }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Video className="w-5 h-5 text-emerald-500" />
              {step === "form" ? "Schedule Interview" : "Interview Link Ready"}
            </DialogTitle>
          </DialogHeader>

          {step === "form" && (
            <>
              <div className="space-y-4 py-2">

                {/* Candidate picker */}
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5"><Users className="w-3.5 h-3.5" />Candidate</Label>
                  <Select value={selectedCandidateId} onValueChange={setSelectedCandidateId}>
                    <SelectTrigger>
                      <SelectValue placeholder={candidates.length ? "Select a candidate…" : "Loading candidates…"} />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      <SelectItem value="demo">
                        <span className="flex items-center gap-2 text-muted-foreground italic">Anonymous / Demo candidate</span>
                      </SelectItem>
                      {candidates.map((c: any) => (
                        <SelectItem key={c.id} value={c.id}>
                          <span className="flex items-center gap-2">
                            <span className="font-medium">{c.firstName} {c.lastName}</span>
                            {c.currentTitle && <span className="text-muted-foreground text-xs">· {c.currentTitle}</span>}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Work order */}
                <div className="space-y-1.5">
                  <Label>Work Order</Label>
                  <Select value={selectedJobId} onValueChange={setSelectedJobId}>
                    <SelectTrigger>
                      <SelectValue placeholder={jobs.length ? "Select a work order…" : "Loading…"} />
                    </SelectTrigger>
                    <SelectContent>
                      {jobs.map((j: any) => (
                        <SelectItem key={j.id} value={j.id}>{j.title}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Interview type + Question count — side by side */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>Interview Type</Label>
                    <Select value={selectedType} onValueChange={setSelectedType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["general", "technical", "behavioral", "cultural", "competency"].map(t => (
                          <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Questions</Label>
                    <Select value={questionCount} onValueChange={setQuestionCount}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {["3", "5", "7", "10"].map(n => (
                          <SelectItem key={n} value={n}>{n} (~{Number(n) * 8} min)</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* Language */}
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5"><Globe className="w-3.5 h-3.5" />Interview Language</Label>
                  <Select value={selectedLanguage} onValueChange={setSelectedLanguage}>
                    <SelectTrigger>
                      <SelectValue>
                        {selectedLangMeta && (
                          <span className="flex items-center gap-2">
                            {selectedLangMeta.speechProvider === "deepgram"
                              ? <Mic className="w-3 h-3 text-violet-500" />
                              : <Cloud className="w-3 h-3 text-blue-500" />}
                            {selectedLangMeta.label}
                          </span>
                        )}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {groups.map(group => (
                        <div key={group.key}>
                          <GroupHeading heading={group.heading} icon={group.icon} />
                          {group.langs.map(lang => <LangItem key={lang.code} lang={lang} />)}
                        </div>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Interview focus — free-form direction for what to assess */}
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5"><Target className="w-3.5 h-3.5" />Interview Focus <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  <Textarea
                    value={focusDirective}
                    onChange={(e) => setFocusDirective(e.target.value)}
                    placeholder="e.g. Assess the candidate's ability to build rapport with clients and communicate with energy."
                    rows={2}
                    maxLength={2000}
                    className="resize-none text-sm"
                  />
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Steers the questions, the live interviewer, and the scoring. Phrase it as a job-relevant skill — Lexy interprets it as a competency and keeps the interview fair.
                  </p>
                </div>

                {/* Custom questions — recruiter-authored, asked verbatim */}
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5"><FileText className="w-3.5 h-3.5" />Your Own Questions <span className="text-muted-foreground font-normal">(optional)</span></Label>
                  {customQuestions.length > 0 && (
                    <div className="space-y-2">
                      {customQuestions.map((q, i) => (
                        <div key={i} className="flex items-start gap-2">
                          <Input
                            value={q}
                            onChange={(e) => setCustomQuestions(prev => prev.map((v, idx) => idx === i ? e.target.value : v))}
                            placeholder={`Custom question ${i + 1}`}
                            className="text-sm"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="shrink-0 h-9 w-9 text-muted-foreground hover:text-destructive"
                            aria-label={`Remove custom question ${i + 1}`}
                            onClick={() => setCustomQuestions(prev => prev.filter((_, idx) => idx !== i))}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setCustomQuestions(prev => [...prev, ""])}
                  >
                    <Plus className="w-3.5 h-3.5" /> Add a question
                  </Button>
                  {customQuestions.filter(q => q.trim()).length > 0 && (
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      These are asked verbatim and counted toward the {questionCount} total — Lexy generates the rest. If you add more than {questionCount}, all of yours are still asked.
                    </p>
                  )}
                </div>
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" onClick={() => setShowSchedule(false)}>Cancel</Button>
                <Button
                  onClick={() => {
                    if (!selectedJobId) {
                      toast({ title: "Select a work order", description: "Choose a work order so Lexy can tailor the interview questions.", variant: "destructive" });
                      return;
                    }
                    scheduleMutation.mutate();
                  }}
                  disabled={scheduleMutation.isPending}
                  className="gap-2"
                >
                  {scheduleMutation.isPending
                    ? <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />Generating questions…</>
                    : <><Link2 className="w-3.5 h-3.5" />Generate Interview Link</>}
                </Button>
              </DialogFooter>
            </>
          )}

          {step === "done" && (
            <div className="space-y-5 py-2">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
                <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
                  <Check className="w-4 h-4 text-emerald-500" />
                </div>
                <div>
                  <p className="text-sm font-bold text-emerald-400">
                    {emailedTo ? "Interview sent to candidate!" : "Interview link generated!"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {emailedTo
                      ? <>AI questions are ready and we emailed the link to <span className="font-medium text-foreground">{emailedTo}</span>.</>
                      : "AI questions are ready. Share this link with the candidate."}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Interview Link</Label>
                <div className="flex gap-2">
                  <Input value={generatedLink} readOnly className="font-mono text-xs bg-muted/40" />
                  <Button size="icon" variant="outline" onClick={handleCopy} aria-label="Copy interview link" className="shrink-0">
                    {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {emailedTo
                    ? "We've emailed this link to the candidate. You can also copy it to share another way."
                    : "Send this URL to the candidate — they can start the interview immediately, no account required."}
                </p>
              </div>

              <div className="flex gap-3">
                <Button onClick={handleCopy} variant="outline" className="flex-1 gap-2">
                  {copied ? <><Check className="w-4 h-4 text-emerald-500" />Copied!</> : <><Copy className="w-4 h-4" />Copy Link</>}
                </Button>
                <Button
                  onClick={() => { setShowSchedule(false); navigate(`/interviews/${generatedId}`); }}
                  className="flex-1 gap-2"
                >
                  <ExternalLink className="w-4 h-4" /> Open Session
                </Button>
              </div>
              <Button
                variant="ghost"
                className="w-full text-xs text-muted-foreground"
                onClick={() => { setStep("form"); setGeneratedLink(""); }}
              >
                Schedule another interview
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
