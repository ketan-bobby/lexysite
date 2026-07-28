/**
 * AgentPanel.tsx — AI agent dashboard panel for recruiters.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Renders the full agent management surface: a grid of all Lexy AI agents
 * (ICP, Sourcing, Screening, Interview, Proctoring, Verification, Outreach,
 * Anti-Ghost, Scheduling, Analytics) with their current enable/disable state,
 * last-run timestamp, activity progress bars, and a "Run now" trigger button.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  AGENT_DEFS[]         Static agent metadata (id, name, description, icon, colour)
 *  <AgentCard>          Individual agent tile with status, progress, and controls
 *  <AgentPanel>         Root: loads agent statuses, handles toggle/run mutations,
 *                       shows aggregate pipeline health summary at the top
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET  /api/agents/status          All agent states for the current tenant
 *  POST /api/agents/:id/run         Trigger an immediate agent run
 *  PATCH /api/agents/:id/toggle     Enable / disable an agent
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/agents.tsx       Full-page agent management view
 */

import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sparkles, Search, FileText, Video, Shield, BadgeCheck,
  Mail, Bell, Calendar, BarChart2, Play, Loader2, CheckCircle2,
  XCircle, Clock, RefreshCw, ExternalLink, Copy, Check,
  Zap, Link2, MessageSquare, AlertTriangle, Info,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { Link } from "wouter";
import { authHeaders as sharedAuthHeaders } from "@/lib/api";

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// Proctoring integrity-score bands — a session-integrity quantity, not match fit;
// its own cutoffs, so any equality with a match band is coincidental.
const INTEGRITY_STRONG = 85;
const INTEGRITY_MODERATE = 60;

/* ── Agent definitions ────────────────────────────────────────────────────── */
const AGENT_DEFS = [
  { id: "icp",          name: "ICP Agent",           desc: "Builds the Ideal Candidate Profile from the job description",    icon: Sparkles,    color: "#22d3ee" },
  { id: "sourcing",     name: "Sourcing Agent",       desc: "Searches talent pools and LinkedIn matching the ICP",            icon: Search,      color: "#a78bfa" },
  { id: "screening",    name: "Screening Agent",      desc: "Scores resumes against requirements",                            icon: FileText,    color: "#4ade80" },
  { id: "interview",    name: "Interview Agent",      desc: "Generates AI video interviews and evaluates responses",          icon: Video,       color: "#fb923c" },
  { id: "proctoring",   name: "Proctoring Agent",     desc: "Monitors interview integrity with biometrics",                   icon: Shield,      color: "#facc15" },
  { id: "verification", name: "Verification Agent",   desc: "Identity checks and credential validation",                     icon: BadgeCheck,  color: "#4ade80" },
  { id: "outreach",     name: "Outreach Agent",       desc: "Personalized messaging and drip campaigns",                     icon: Mail,        color: "#22d3ee" },
  { id: "anti-ghosting",name: "Anti-Ghosting Agent",  desc: "Re-engagement nudges and dropout prevention",                   icon: Bell,        color: "#fb7185" },
  { id: "scheduling",   name: "Scheduling Agent",     desc: "Calendar coordination and interview scheduling",                 icon: Calendar,    color: "#a78bfa" },
  { id: "analytics",    name: "Analytics Agent",      desc: "Pipeline insights and bottleneck detection",                    icon: BarChart2,   color: "#facc15" },
] as const;

type AgentId = typeof AGENT_DEFS[number]["id"];
type AgentStatusType = "idle" | "running" | "completed" | "failed";

const INTERVIEW_TYPES = [
  { value: "general",    label: "General" },
  { value: "technical",  label: "Technical" },
  { value: "behavioral", label: "Behavioral" },
  { value: "competency", label: "Competency" },
];

const QUESTION_COUNTS = [3, 5, 7, 10];

interface GeneratedLink {
  sessionId: string;
  planTitle: string;
  questionCount: number;
  estimatedMinutes: number;
  interviewType: string;
  langLabel: string;
  questions: Array<{ id: string; text: string; category: string; order: number }>;
}

/* ── Status helpers ───────────────────────────────────────────────────────── */
function StatusBadge({ status }: { status: string }) {
  if (status === "running") return (
    <Badge className="bg-cyan-500/10 text-cyan-400 border-cyan-500/30 flex items-center gap-1 text-xs">
      <Loader2 className="w-3 h-3 animate-spin" /> Running
    </Badge>
  );
  if (status === "completed") return (
    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 flex items-center gap-1 text-xs">
      <CheckCircle2 className="w-3 h-3" /> Completed
    </Badge>
  );
  if (status === "failed") return (
    <Badge className="bg-rose-500/10 text-rose-400 border-rose-500/30 flex items-center gap-1 text-xs">
      <XCircle className="w-3 h-3" /> Failed
    </Badge>
  );
  return (
    <Badge variant="outline" className="text-xs text-muted-foreground">
      <Clock className="w-3 h-3 mr-1" /> Ready
    </Badge>
  );
}

/* ── Main Component ───────────────────────────────────────────────────────── */
export function AgentPanel({
  jobId,
  candidates,
}: {
  jobId: string;
  candidates: Array<{ id: string; firstName: string; lastName: string }>;
}) {
  const queryClient = useQueryClient();

  const [runningAll, setRunningAll]   = useState(false);
  const [progress, setProgress]       = useState({ done: 0, total: 0, current: "" });
  const [runningSet, setRunningSet]   = useState<Set<string>>(new Set());
  const [doneSet, setDoneSet]         = useState<Set<string>>(new Set());
  const [failedSet, setFailedSet]     = useState<Set<string>>(new Set());

  const [selectedCandidate, setSelectedCandidate] = useState<string>(candidates[0]?.id ?? "");
  const [interviewType,     setInterviewType]      = useState("general");
  const [questionCount,     setQuestionCount]      = useState(5);
  const [generating,        setGenerating]         = useState(false);
  const [generatedLink,     setGeneratedLink]      = useState<GeneratedLink | null>(null);
  const [copied,            setCopied]             = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/agents`, {
        headers: { ...sharedAuthHeaders() },
        credentials: "include",
      });
      return res.json() as Promise<{ agents: any[]; recentRuns: any[]; events: any[] }>;
    },
    refetchInterval: 5_000,
  });

  const agentStatusMap = Object.fromEntries(
    (data?.agents ?? []).map((a: any) => [a.id, a])
  );

  const anyServerRunning = Object.values(agentStatusMap).some((a: any) => a.status === "running");

  const authHeaders = { ...sharedAuthHeaders(), "Content-Type": "application/json" };

  const runAgent = async (agentId: string) => {
    setRunningSet(s => new Set(s).add(agentId));
    setDoneSet(s => { const n = new Set(s); n.delete(agentId); return n; });
    setFailedSet(s => { const n = new Set(s); n.delete(agentId); return n; });
    try {
      const resp = await fetch(`${API_BASE}/api/agents/${agentId}/run`, {
        credentials: "include",
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ jobId }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as any).error || `HTTP ${resp.status}`);
      }
      if (resp.status !== 202) {
        setDoneSet(s => new Set(s).add(agentId));
        setRunningSet(s => { const n = new Set(s); n.delete(agentId); return n; });
        queryClient.invalidateQueries({ queryKey: ["agents"] });
      }
      // 202: agent is running async — keep in runningSet; poll will clear it
    } catch {
      setFailedSet(s => new Set(s).add(agentId));
      setRunningSet(s => { const n = new Set(s); n.delete(agentId); return n; });
    }
  };

  // Transition async-running agents to done/failed once the orchestrator confirms
  useEffect(() => {
    if (!data || runningSet.size === 0) return;
    const recentRuns: any[] = data.recentRuns ?? [];
    const toComplete: string[] = [];
    const toFail: string[] = [];
    runningSet.forEach(agentId => {
      const latestRun = recentRuns.find((r: any) => r.agentId === agentId);
      if (latestRun?.status === "completed") toComplete.push(agentId);
      else if (latestRun?.status === "failed") toFail.push(agentId);
    });
    if (toComplete.length > 0) {
      setDoneSet(s => { const n = new Set(s); toComplete.forEach(id => n.add(id)); return n; });
      setRunningSet(s => { const n = new Set(s); toComplete.forEach(id => n.delete(id)); return n; });
    }
    if (toFail.length > 0) {
      setFailedSet(s => { const n = new Set(s); toFail.forEach(id => n.add(id)); return n; });
      setRunningSet(s => { const n = new Set(s); toFail.forEach(id => n.delete(id)); return n; });
    }
    if (toComplete.length + toFail.length > 0) {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    }
  }, [data]);

  const handleRunAll = async () => {
    setRunningAll(true);
    setDoneSet(new Set());
    setFailedSet(new Set());
    const agents = [...AGENT_DEFS];
    setProgress({ done: 0, total: agents.length, current: agents[0].name });
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      setProgress({ done: i, total: agents.length, current: agent.name });
      await runAgent(agent.id);
      setProgress({ done: i + 1, total: agents.length, current: agent.name });
    }
    setRunningAll(false);
    queryClient.invalidateQueries({ queryKey: ["agents"] });
  };

  const handleGenerateLink = async () => {
    setGenerating(true);
    setGeneratedLink(null);
    try {
      const body: any = { jobId, interviewType, questionCount, language: "en" };
      if (selectedCandidate) body.candidateId = selectedCandidate;
      const res = await fetch(`${API_BASE}/api/interviews/generate-link`, {
        credentials: "include",
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.reason || data?.error || `Failed to generate link (${res.status})`);
      setGeneratedLink(data);
    } finally {
      setGenerating(false);
    }
  };

  const interviewUrl = generatedLink
    ? `${window.location.origin}${API_BASE}/interviews/${generatedLink.sessionId}/room`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(interviewUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const localStatus = (id: string): AgentStatusType => {
    // Server is authoritative for "running" — always reflects reality
    if (agentStatusMap[id]?.status === "running") return "running";
    // Optimistic local state for run-just-triggered (before first poll back)
    if (runningSet.has(id)) return "running";
    if (doneSet.has(id)) return "completed";
    if (failedSet.has(id)) return "failed";
    return (agentStatusMap[id]?.status ?? "idle") as AgentStatusType;
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" /> AI Agent Pipeline
          </h3>
          <p className="text-sm text-muted-foreground mt-0.5">10 specialized agents powering the full hiring workflow</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["agents"] })}
            className="gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
          <Button
            size="sm"
            disabled={runningAll}
            onClick={handleRunAll}
            className="gap-1.5 font-semibold"
          >
            {runningAll ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Running All…</>
            ) : (
              <><Zap className="w-3.5 h-3.5" /> Run All Agents</>
            )}
          </Button>
        </div>
      </div>

      {/* ── Run-all progress ───────────────────────────────────────────────── */}
      {runningAll && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="py-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span className="font-medium flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
                Running <span className="text-primary font-bold">{progress.current}</span>
              </span>
              <span className="text-muted-foreground">{progress.done} / {progress.total}</span>
            </div>
            <Progress value={(progress.done / Math.max(progress.total, 1)) * 100} className="h-2" />
          </CardContent>
        </Card>
      )}

      {/* ── Agent Grid ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {AGENT_DEFS.map((def) => {
          const Icon = def.icon;
          const status = localStatus(def.id);
          const agentData = agentStatusMap[def.id];
          const isRunning = status === "running";

          return (
            <div
              key={def.id}
              className={cn(
                "border rounded-xl p-4 bg-card flex items-start gap-4 transition-all duration-200",
                isRunning  ? "border-cyan-500/40 bg-cyan-500/5 shadow-sm shadow-cyan-500/10" :
                status === "completed" ? "border-emerald-500/30 bg-emerald-500/5" :
                status === "failed" ? "border-rose-500/30 bg-rose-500/5" :
                "border-border hover:border-border/80"
              )}
            >
              <div
                className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5",
                  isRunning && "animate-pulse"
                )}
                style={{ backgroundColor: `${def.color}18`, border: `1px solid ${def.color}40` }}
              >
                <Icon className="w-5 h-5" style={{ color: def.color }} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span className="font-semibold text-sm">{def.name}</span>
                  <StatusBadge status={status} />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">{def.desc}</p>
                {agentData?.lastRun && (
                  <p className="text-[10px] text-muted-foreground/60 mt-1.5">
                    Last run: {new Date(agentData.lastRun).toLocaleString()} · {Math.round(agentData.avgDuration / 1000)}s avg
                  </p>
                )}
              </div>

              <Button
                size="sm"
                variant={status === "completed" ? "outline" : "ghost"}
                disabled={isRunning || runningAll}
                onClick={() => runAgent(def.id)}
                className="flex-shrink-0 h-8 w-8 p-0"
                title={`Run ${def.name}`}
              >
                {isRunning
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <Play className="w-3.5 h-3.5" />
                }
              </Button>
            </div>
          );
        })}
      </div>

      {/* ── Proctoring Results ──────────────────────────────────────────────── */}
      {(() => {
        const recentRuns: any[] = data?.recentRuns ?? [];
        const procRun = recentRuns
          .filter(r => r.agentId === "proctoring" && r.status === "completed" && r.input?.jobId === jobId)
          .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];

        if (!procRun?.output) return null;
        const out = procRun.output;
        const sessions: any[] = out.sessions ?? [];
        const verdict: string = out.overallVerdict ?? out.verdict ?? "low_risk";
        const avgScore: number = out.averageIntegrityScore ?? out.integrityScore ?? 100;
        const highRisk: number = out.highRiskCount ?? 0;
        const reviewed: number = out.sessionsReviewed ?? sessions.length;

        const verdictColor = verdict === "high_risk" ? "text-rose-400 border-rose-500/30 bg-rose-500/10"
          : verdict === "medium_risk" ? "text-yellow-400 border-yellow-500/30 bg-yellow-500/10"
          : "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
        const scoreColor = avgScore >= INTEGRITY_STRONG ? "text-emerald-400" : avgScore >= INTEGRITY_MODERATE ? "text-yellow-400" : "text-rose-400";

        return (
          <>
            <Separator />
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center">
                  <Shield className="w-4 h-4 text-yellow-400" />
                </div>
                <div className="flex-1">
                  <h3 className="text-base font-bold">Proctoring Results</h3>
                  <p className="text-xs text-muted-foreground">
                    Last run {new Date(procRun.startedAt).toLocaleString()} · {pluralize(reviewed, "session")} analysed
                  </p>
                </div>
                <Badge variant="outline" className={cn("text-xs font-semibold", verdictColor)}>
                  {verdict === "high_risk" ? <AlertTriangle className="w-3 h-3 mr-1" /> : verdict === "medium_risk" ? <Info className="w-3 h-3 mr-1" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                  {verdict.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase())}
                </Badge>
              </div>

              {/* Summary bar */}
              <div className="grid grid-cols-3 gap-3">
                <Card className="border-border/40 bg-card/60">
                  <CardContent className="py-3 text-center">
                    <p className={cn("text-2xl font-bold tabular-nums", scoreColor)}>{avgScore}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Avg Integrity Score</p>
                  </CardContent>
                </Card>
                <Card className="border-border/40 bg-card/60">
                  <CardContent className="py-3 text-center">
                    <p className="text-2xl font-bold tabular-nums">{reviewed}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Sessions Reviewed</p>
                  </CardContent>
                </Card>
                <Card className="border-border/40 bg-card/60">
                  <CardContent className="py-3 text-center">
                    <p className={cn("text-2xl font-bold tabular-nums", highRisk > 0 ? "text-rose-400" : "text-emerald-400")}>{highRisk}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">High-Risk Sessions</p>
                  </CardContent>
                </Card>
              </div>

              {/* Per-session list */}
              {sessions.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Session Breakdown</p>
                  <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                    {sessions.map((s: any) => {
                      const trust: string = s.trustLevel ?? s.verdict ?? "low_risk";
                      const sc: number = s.integrityScore ?? 100;
                      const rowColor = trust === "high_risk" ? "border-rose-500/20 bg-rose-500/5"
                        : trust === "medium_risk" ? "border-yellow-500/20 bg-yellow-500/5"
                        : "border-emerald-500/10 bg-emerald-500/3";
                      const scoreCol = sc >= INTEGRITY_STRONG ? "text-emerald-400" : sc >= INTEGRITY_MODERATE ? "text-yellow-400" : "text-rose-400";
                      return (
                        <div key={s.sessionId} className={cn("rounded-lg border p-3 flex items-start gap-3", rowColor)}>
                          {/* Score circle */}
                          <div className={cn("w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold border", scoreCol,
                            sc >= INTEGRITY_STRONG ? "border-emerald-500/30 bg-emerald-500/10" : sc >= INTEGRITY_MODERATE ? "border-yellow-500/30 bg-yellow-500/10" : "border-rose-500/30 bg-rose-500/10"
                          )}>
                            {sc}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-xs font-mono text-muted-foreground truncate">{s.sessionId?.slice(0, 8)}…</span>
                              <Badge variant="outline" className={cn("text-[10px] h-4 px-1",
                                trust === "high_risk" ? "text-rose-400 border-rose-500/30" : trust === "medium_risk" ? "text-yellow-400 border-yellow-500/30" : "text-emerald-400 border-emerald-500/30"
                              )}>
                                {trust.replace("_", " ")}
                              </Badge>
                              <span className="text-[10px] text-muted-foreground/60 ml-auto">{s.totalEvents ?? 0} events · {s.framesSampled ?? 0} snapshots</span>
                            </div>
                            <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{s.notes}</p>
                            {(s.flags ?? []).length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {s.flags.map((f: string) => (
                                  <span key={f} className="text-[9px] bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded px-1.5 py-0.5 font-mono">
                                    {f}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <a
                            href={`${API_BASE}/interviews/${s.sessionId}/proctor-report`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-shrink-0 text-muted-foreground hover:text-primary transition-colors"
                            title="View full report"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </>
        );
      })()}

      <Separator />

      {/* ── Interview Link Generator ────────────────────────────────────────── */}
      <div className="space-y-5">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-orange-500/10 border border-orange-500/30 flex items-center justify-center">
            <Link2 className="w-4 h-4 text-orange-400" />
          </div>
          <div>
            <h3 className="text-base font-bold">Interview Link Generator</h3>
            <p className="text-xs text-muted-foreground">Generate an AI interview link for a candidate — test or share</p>
          </div>
        </div>

        <Card className="border-border/60">
          <CardContent className="pt-5 space-y-4">
            {/* Config row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Candidate */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Candidate</label>
                <Select value={selectedCandidate} onValueChange={setSelectedCandidate}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select candidate" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="demo">Demo / Anonymous</SelectItem>
                    {candidates.map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.firstName} {c.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Interview type */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Interview Type</label>
                <Select value={interviewType} onValueChange={setInterviewType}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVIEW_TYPES.map(t => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Question count */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Questions</label>
                <Select value={String(questionCount)} onValueChange={v => setQuestionCount(Number(v))}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUESTION_COUNTS.map(n => (
                      <SelectItem key={n} value={String(n)}>{n} questions (~{n * 8} min)</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button
              onClick={handleGenerateLink}
              disabled={generating}
              className="w-full gap-2 font-semibold"
            >
              {generating ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Generating interview with AI…</>
              ) : (
                <><Sparkles className="w-4 h-4" /> Generate Interview Link</>
              )}
            </Button>

            {/* Generated result */}
            {generatedLink && (
              <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
                  <div className="flex items-center gap-2 text-emerald-400 text-sm font-semibold">
                    <CheckCircle2 className="w-4 h-4" />
                    Interview ready — {generatedLink.planTitle}
                  </div>
                  <div className="flex gap-2 text-xs text-muted-foreground flex-wrap">
                    <span className="bg-muted px-2 py-0.5 rounded">{generatedLink.questionCount} questions</span>
                    <span className="bg-muted px-2 py-0.5 rounded">~{generatedLink.estimatedMinutes} min</span>
                    <span className="bg-muted px-2 py-0.5 rounded capitalize">{generatedLink.interviewType}</span>
                    <span className="bg-muted px-2 py-0.5 rounded">{generatedLink.langLabel}</span>
                  </div>

                  {/* Copyable link */}
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-card border border-border rounded-lg px-3 py-2 text-xs font-mono text-muted-foreground truncate">
                      {interviewUrl}
                    </div>
                    <Button size="sm" variant="outline" onClick={handleCopy} className="flex-shrink-0 gap-1.5 h-8">
                      {copied ? <><Check className="w-3.5 h-3.5 text-emerald-400" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
                    </Button>
                    <Link href={`/interviews/${generatedLink.sessionId}/room`}>
                      <Button size="sm" className="flex-shrink-0 gap-1.5 h-8">
                        <ExternalLink className="w-3.5 h-3.5" /> Test Interview
                      </Button>
                    </Link>
                  </div>
                </div>

                {/* Question preview */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <MessageSquare className="w-3 h-3" /> AI-Generated Questions Preview
                  </p>
                  <div className="space-y-2">
                    {generatedLink.questions.map((q, i) => (
                      <div key={q.id} className="flex gap-3 p-3 rounded-lg bg-card border border-border/50">
                        <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/15 text-primary text-[10px] font-black flex items-center justify-center">
                          {i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground leading-relaxed">{q.text}</p>
                          <Badge variant="outline" className="mt-1.5 text-[10px] capitalize">{q.category}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
