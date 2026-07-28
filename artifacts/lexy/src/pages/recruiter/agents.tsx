/**
 * pages/recruiter/agents.tsx — AI Agents Control Panel
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Shows the status, configuration, and recent activity of each of Lexy's
 * 10 AI agents. Allows recruiters to trigger manual agent runs, adjust agent
 * parameters, and view the last run's log/result for each agent.
 *
 * ─── Agents shown ────────────────────────────────────────────────────────────
 *   ICP Agent             — generates Ideal Candidate Profiles
 *   Sourcing Agent        — finds candidates from LinkedIn/GitHub/etc
 *   Screening Agent       — scores and ranks sourced candidates
 *   Outreach Agent        — generates personalised outreach emails
 *   Conversation Agent    — classifies and drafts replies to candidate emails
 *   Interview Agent       — conducts AI interviews, generates reports
 *   Anti-Ghost Agent      — detects and mitigates candidate ghosting
 *   Verification Agent    — identity + resume consistency checks
 *   Intelligence Agent    — makes stage-advance / reject recommendations
 *   Digest Agent          — sends daily recruiter digest emails
 *
 * ─── Key interactions ────────────────────────────────────────────────────────
 *   "Run Now" CTA      — POST /api/agents/:agent/trigger
 *   "Configure" link   — opens a side panel with agent-specific settings
 *   Status indicator   — idle / running / error (polled every 10 s)
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/agents
 */
import { useState, useEffect } from "react";
import { authHeaders } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Bot, Brain, Video, Search, Shield, Send, Bell, Calendar, BarChart3,
  Zap, CheckCircle2, Clock, Play, AlertCircle, Activity, RefreshCw,
  Eye, Cpu, Layers, Users, Camera, Mic, Monitor, ScanFace, ArrowLeft,
  ChevronDown, ChevronUp, ArrowRight, Wrench, ListChecks, Sparkles,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const AGENT_TAB: Record<string, string> = {
  icp:           "icp",
  sourcing:      "candidates",
  screening:     "candidates",
  interview:     "candidates",
  proctoring:    "candidates",
  outreach:      "outreach",
  "anti-ghosting":"outreach",
  verification:  "candidates",
  scheduling:    "pipeline",
  analytics:     "intelligence",
};

/* ── Launch transition overlay ──────────────────────────────────────────── */
function LaunchOverlay({ agentLabel, icon: Icon, color, onDone }: {
  agentLabel: string;
  icon: React.ElementType;
  color: string;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<"enter" | "run" | "exit">("enter");

  useEffect(() => {
    const t1 = setTimeout(() => setPhase("run"),  400);
    const t2 = setTimeout(() => setPhase("exit"), 1800);
    const t3 = setTimeout(() => onDone(),         2300);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  return (
    <div className={cn(
      "fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/95 backdrop-blur-xl transition-all duration-500",
      phase === "exit" ? "opacity-0 scale-105" : "opacity-100 scale-100",
    )}>
      <div className="flex flex-col items-center gap-6">
        <div className={cn(
          "w-24 h-24 rounded-3xl flex items-center justify-center transition-all duration-700 shadow-2xl",
          color,
          phase === "run" ? "scale-110 shadow-primary/40" : "scale-100",
        )}>
          {phase === "run"
            ? <Cpu className="w-12 h-12 animate-pulse" />
            : <Icon className="w-12 h-12" />
          }
        </div>
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-bold tracking-tight">
            {phase === "run" ? "Agent Running" : "Launching Agent"}
          </h2>
          <p className="text-muted-foreground text-sm">{agentLabel}</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="w-4 h-4 animate-spin text-primary" />
          <span>{phase === "run" ? "Navigating to results…" : "Starting up…"}</span>
        </div>
        <div className="flex gap-1 mt-2">
          {[0,1,2].map(i => (
            <div key={i} className="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
      ...(opts?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

const AGENT_META: Record<string, {
  icon: React.ElementType;
  color: string;
  label: string;
  description: string;
  needsCandidate: boolean;
  order: number;
}> = {
  icp:            { icon: Brain,    color: "text-violet-500 bg-violet-500/10",  label: "ICP Agent",        description: "Extracts skills, requirements and disqualifiers from the job description.",          needsCandidate: false, order: 1 },
  sourcing:       { icon: Search,   color: "text-blue-500 bg-blue-500/10",      label: "Sourcing Agent",   description: "Ranks your existing candidates against the ICP and surfaces the best matches.",        needsCandidate: false, order: 2 },
  screening:      { icon: Layers,   color: "text-cyan-500 bg-cyan-500/10",      label: "Screening Agent",  description: "Reads resumes and produces a scored recruiter summary for each candidate.",             needsCandidate: true,  order: 3 },
  interview:      { icon: Video,    color: "text-emerald-500 bg-emerald-500/10",label: "Interview Agent",  description: "Conducts a structured AI video interview and evaluates STAR responses.",               needsCandidate: true,  order: 4 },
  proctoring:     { icon: ScanFace, color: "text-rose-500 bg-rose-500/10",      label: "Proctoring Agent", description: "Monitors interview sessions for integrity: gaze, multiple faces, audio anomalies.",   needsCandidate: true,  order: 5 },
  outreach:       { icon: Send,     color: "text-orange-500 bg-orange-500/10",  label: "Outreach Agent",   description: "Writes personalised outreach messages and attaches interview links.",                  needsCandidate: true,  order: 6 },
  "anti-ghosting":{ icon: Bell,     color: "text-yellow-500 bg-yellow-500/10",  label: "Anti-Ghosting",    description: "Detects candidate silence and triggers smart follow-up sequences.",                   needsCandidate: true,  order: 7 },
  verification:   { icon: Shield,   color: "text-green-500 bg-green-500/10",    label: "Verification",     description: "Validates credentials, LinkedIn consistency and identity signals.",                   needsCandidate: true,  order: 8 },
  scheduling:     { icon: Calendar, color: "text-indigo-500 bg-indigo-500/10",  label: "Scheduling Agent", description: "Generates calendar links and manages interview rescheduling.",                        needsCandidate: true,  order: 9 },
  analytics:      { icon: BarChart3,color: "text-purple-500 bg-purple-500/10",  label: "Analytics Agent",  description: "Identifies pipeline bottlenecks and conversion anomalies across all open roles.",      needsCandidate: false, order: 10 },
};

const PIPELINE_ORDER = Object.entries(AGENT_META).sort((a, b) => a[1].order - b[1].order).map(([id]) => id);

function StatusBadge({ status }: { status: string }) {
  if (status === "running")   return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20 animate-pulse gap-1"><Activity className="w-3 h-3" />Running</Badge>;
  if (status === "completed") return <Badge className="bg-green-500/10 text-green-500 border-green-500/20 gap-1"><CheckCircle2 className="w-3 h-3" />Done</Badge>;
  if (status === "failed")    return <Badge className="bg-red-500/10 text-red-500 border-red-500/20 gap-1"><AlertCircle className="w-3 h-3" />Failed</Badge>;
  if (status === "interrupted") return <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20 gap-1"><AlertCircle className="w-3 h-3" />Interrupted</Badge>;
  return <Badge variant="outline" className="text-muted-foreground gap-1"><Clock className="w-3 h-3" />Idle</Badge>;
}

function formatDuration(ms?: number) {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function timeAgo(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000)   return "just now";
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
  if (d < 86400000)return `${Math.round(d / 3600000)}h ago`;
  return `${Math.round(d / 86400000)}d ago`;
}

/* ── Agent card with inline context picker ─────────────────────────────── */
function AgentCard({ agent, jobs }: { agent: any; jobs: any[] }) {
  const meta = AGENT_META[agent.id] || { icon: Bot, color: "text-primary bg-primary/10", label: agent.name, needsCandidate: false };
  const Icon = meta.icon;
  const isRunning = agent.status === "running";
  const [open, setOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState("");
  const [candidateId, setCandidateId] = useState("");
  const [running, setRunning] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const handleRun = async () => {
    if (!selectedJob) { toast({ title: "Select a job first", variant: "destructive" }); return; }
    setRunning(true);
    try {
      await apiFetch(`/agents/${agent.id}/run`, {
        method: "POST",
        body: JSON.stringify({ jobId: selectedJob, ...(candidateId ? { candidateId } : {}), manual: true }),
      });
      setOpen(false);
      setOverlay(true);
    } catch {
      toast({ title: "Failed to start agent", variant: "destructive" });
      setRunning(false);
    }
  };

  if (overlay) {
    const tab = AGENT_TAB[agent.id] || "intelligence";
    return (
      <LaunchOverlay
        agentLabel={meta.label}
        icon={Icon}
        color={meta.color}
        onDone={() => navigate(`/jobs/${selectedJob}?tab=${tab}`)}
      />
    );
  }

  return (
    <Card className={cn("border-border/40 transition-all", isRunning && "border-blue-500/30 bg-blue-500/5", open && "border-primary/40")}>
      <CardContent className="p-5">
        <div className="flex items-start gap-4">
          <div className={cn("w-11 h-11 rounded-xl flex items-center justify-center shrink-0", meta.color)}>
            {isRunning ? <Cpu className="w-5 h-5 animate-pulse" /> : <Icon className="w-5 h-5" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="font-bold text-sm">{meta.label}</h3>
              <StatusBadge status={agent.status} />
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed mb-3">{meta.description}</p>

            <div className="flex flex-wrap gap-1 mb-3">
              {(agent.capabilities || []).slice(0, 3).map((cap: string) => (
                <Badge key={cap} variant="secondary" className="text-[10px] px-1.5 py-0">{cap}</Badge>
              ))}
              {(agent.capabilities || []).length > 3 && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">+{agent.capabilities.length - 3}</Badge>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Zap className="w-3 h-3" />{agent.totalRuns} runs</span>
                <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-green-500" />{agent.successRate}%</span>
                {agent.lastRun && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{timeAgo(agent.lastRun.startedAt)}</span>}
              </div>
              <Button
                size="sm"
                variant={open ? "default" : "outline"}
                className="text-xs h-7 gap-1 shrink-0"
                disabled={isRunning}
                onClick={() => setOpen(v => !v)}
              >
                {open ? <ChevronUp className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                {isRunning ? "Running" : open ? "Cancel" : "Run"}
              </Button>
            </div>
          </div>
        </div>

        {/* Inline context panel */}
        {open && (
          <div className="mt-4 pt-4 border-t border-border/40 space-y-3">
            <p className="text-xs font-medium text-muted-foreground">Select context to run this agent</p>
            <div className="grid grid-cols-1 gap-2">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Job <span className="text-red-500">*</span></label>
                <Select value={selectedJob} onValueChange={setSelectedJob}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Choose a job..." />
                  </SelectTrigger>
                  <SelectContent>
                    {jobs.length === 0 && <SelectItem value="_none" disabled>No jobs found</SelectItem>}
                    {jobs.map((j: any) => (
                      <SelectItem key={j.id} value={j.id} className="text-xs">{j.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {meta.needsCandidate && (
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">Candidate ID <span className="text-muted-foreground">(optional)</span></label>
                  <input
                    className="w-full h-8 px-3 text-xs rounded-md border border-input bg-background"
                    placeholder="e.g. uuid of candidate..."
                    value={candidateId}
                    onChange={e => setCandidateId(e.target.value)}
                  />
                </div>
              )}
            </div>
            <Button size="sm" className="w-full gap-2" onClick={handleRun} disabled={running || !selectedJob}>
              {running ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {running ? "Starting…" : `Run ${meta.label}`}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ── Pipeline Builder ──────────────────────────────────────────────────── */
function PipelineBuilder({ jobs }: { jobs: any[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set(["icp", "sourcing", "screening"]));
  const [jobId, setJobId] = useState("");
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<any>(null);
  const { toast } = useToast();

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleRun = async () => {
    if (!jobId) { toast({ title: "Select a job first", variant: "destructive" }); return; }
    if (selected.size === 0) { toast({ title: "Select at least one agent", variant: "destructive" }); return; }
    setRunning(true);
    setLastResult(null);
    try {
      const result: any = await apiFetch("/agents/run-selection", {
        method: "POST",
        body: JSON.stringify({ agentIds: Array.from(selected), jobId }),
      });
      setLastResult(result);
      toast({ title: "Pipeline started", description: result.message });
    } catch {
      toast({ title: "Failed to start pipeline", variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  const orderedSelected = PIPELINE_ORDER.filter(id => selected.has(id));

  return (
    <div className="space-y-5">
      <Card className="border-border/40">
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
              <ListChecks className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-semibold text-sm">Custom Pipeline</h3>
              <p className="text-xs text-muted-foreground">Pick the agents you want to run — they'll execute in the correct dependency order automatically.</p>
            </div>
          </div>

          {/* Job selector */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Run against job <span className="text-red-500">*</span></label>
            <Select value={jobId} onValueChange={setJobId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select a job..." />
              </SelectTrigger>
              <SelectContent>
                {jobs.length === 0 && <SelectItem value="_none" disabled>No jobs yet</SelectItem>}
                {jobs.map((j: any) => (
                  <SelectItem key={j.id} value={j.id}>{j.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Agent toggles */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground block mb-2">Select agents to include</label>
            {PIPELINE_ORDER.map((id, i) => {
              const meta = AGENT_META[id];
              const Icon = meta.icon;
              const isSelected = selected.has(id);
              return (
                <button
                  key={id}
                  onClick={() => toggle(id)}
                  className={cn(
                    "w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all",
                    isSelected
                      ? "border-primary/40 bg-primary/5"
                      : "border-border/40 hover:border-border/80 opacity-60 hover:opacity-80",
                  )}
                >
                  <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold", isSelected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                    {i + 1}
                  </div>
                  <div className={cn("w-7 h-7 rounded-md flex items-center justify-center shrink-0", meta.color)}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-xs">{meta.label}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{meta.description}</div>
                  </div>
                  <div className={cn("w-4 h-4 rounded-sm border-2 shrink-0 flex items-center justify-center",
                    isSelected ? "bg-primary border-primary" : "border-border/60"
                  )}>
                    {isSelected && <CheckCircle2 className="w-3 h-3 text-primary-foreground" />}
                  </div>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Execution preview + run button */}
      <Card className="border-border/40">
        <CardContent className="p-5 space-y-4">
          <h4 className="text-sm font-semibold">Execution order</h4>
          {orderedSelected.length === 0 ? (
            <p className="text-xs text-muted-foreground">No agents selected yet.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {orderedSelected.map((id, i) => {
                const meta = AGENT_META[id];
                const Icon = meta.icon;
                return (
                  <div key={id} className="flex items-center gap-1.5">
                    <div className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium", meta.color, "border-current/20")}>
                      <Icon className="w-3 h-3" />
                      {meta.label}
                    </div>
                    {i < orderedSelected.length - 1 && <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />}
                  </div>
                );
              })}
            </div>
          )}

          <Button
            className="w-full gap-2"
            onClick={handleRun}
            disabled={running || selected.size === 0 || !jobId}
          >
            {running ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {running ? "Starting pipeline…" : `Run ${pluralize(selected.size, "selected agent")}`}
          </Button>

          {lastResult && (
            <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium text-green-600">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Pipeline started
              </div>
              <p className="text-xs text-muted-foreground">{lastResult.message}</p>
              <p className="text-xs text-muted-foreground font-mono">Run ID: {lastResult.runId}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Proctoring panel ──────────────────────────────────────────────────── */
function ProctoringPanel() {
  const { data: report } = useQuery<any>({
    queryKey: ["proctoring", "sess_001"],
    queryFn: () => apiFetch("/agents/proctoring/sess_001"),
  });

  if (!report) return <div className="p-8 text-center text-muted-foreground">Loading proctoring report...</div>;

  const checks = [
    { key: "facePresent",      label: "Face Presence",  icon: Camera,  detail: `${report.checks.facePresent.pct}% frames` },
    { key: "multiplePersons",  label: "Single Person",  icon: Users,   detail: `Max ${report.checks.multiplePersons.maxDetected} detected` },
    { key: "gazeOnCamera",     label: "Gaze Direction", icon: Eye,     detail: `${report.checks.gazeOnCamera.pct}% on camera` },
    { key: "tabSwitches",      label: "Tab Switching",  icon: Monitor, detail: `${report.checks.tabSwitches.count} switches` },
    { key: "audioAnomalies",   label: "Audio Integrity",icon: Mic,     detail: `${report.checks.audioAnomalies.count} anomaly` },
    { key: "screenSharing",    label: "Screen Sharing", icon: Monitor, detail: report.checks.screenSharing.active ? "Active" : "Not detected" },
  ];

  // Proctoring risk-score bands (INVERTED: lower = safer; own cutoffs, not the match band).
  const RISK_LOW_MAX = 20, RISK_MED_MAX = 50;
  const riskColor = report.riskScore < RISK_LOW_MAX ? "text-green-500" : report.riskScore < RISK_MED_MAX ? "text-yellow-500" : "text-red-500";
  const riskBg   = report.riskScore < RISK_LOW_MAX ? "from-green-500/20 to-green-500/5" : report.riskScore < RISK_MED_MAX ? "from-yellow-500/20 to-yellow-500/5" : "from-red-500/20 to-red-500/5";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className={`bg-gradient-to-br ${riskBg} border-border/40`}>
          <CardContent className="p-6 text-center">
            <div className={cn("text-5xl font-black mb-1", riskColor)}>{report.riskScore}</div>
            <div className="text-sm text-muted-foreground mb-3">Risk Score</div>
            <Badge className={cn("text-xs", report.riskScore < RISK_LOW_MAX ? "bg-green-500/20 text-green-600" : "bg-yellow-500/20 text-yellow-600")}>
              {report.verdict.replace("_", " ").toUpperCase()}
            </Badge>
          </CardContent>
        </Card>
        <Card className="border-border/40 md:col-span-2">
          <CardContent className="p-6 space-y-4">
            <h4 className="font-semibold text-sm">Integrity Checks</h4>
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
                    {passed ? <CheckCircle2 className="w-4 h-4 text-green-500 ml-auto shrink-0" /> : <AlertCircle className="w-4 h-4 text-red-500 ml-auto shrink-0" />}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
      {report.flags.length > 0 && (
        <Card className="border-yellow-500/20 bg-yellow-500/5">
          <CardContent className="p-5">
            <h4 className="font-semibold text-sm mb-3 flex items-center gap-2"><AlertCircle className="w-4 h-4 text-yellow-500" />Flagged Events ({report.flags.length})</h4>
            <div className="space-y-2">
              {report.flags.map((flag: any, i: number) => (
                <div key={i} className="flex items-start gap-3 text-sm p-3 bg-background/60 rounded-lg border border-border/40">
                  <Badge variant="outline" className="font-mono text-xs shrink-0 mt-0.5">{flag.timestamp}</Badge>
                  <div><span className="font-medium capitalize">{flag.type.replace("_", " ")}</span><span className="text-muted-foreground ml-2">{flag.detail}</span></div>
                  <Badge className={cn("ml-auto shrink-0 text-xs", flag.severity === "low" ? "bg-yellow-500/10 text-yellow-600" : "bg-red-500/10 text-red-600")}>{flag.severity}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
      <Card className="border-border/40">
        <CardContent className="p-5">
          <h4 className="font-semibold text-sm mb-2">Agent Assessment</h4>
          <p className="text-sm text-muted-foreground leading-relaxed">{report.notes}</p>
        </CardContent>
      </Card>
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────────────────── */
export default function AgentHub() {
  const { data, isLoading, refetch } = useQuery<any>({
    queryKey: ["agents"],
    queryFn: () => apiFetch("/agents"),
    refetchInterval: 15000,
  });
  const { data: jobsData } = useQuery<any>({
    queryKey: ["jobs-list"],
    queryFn: () => apiFetch("/jobs"),
  });
  const [activeTab, setActiveTab] = useState("overview");

  const agents = data?.agents || [];
  const recentRuns = data?.recentRuns || [];
  const jobs = jobsData?.jobs || jobsData || [];

  const activeCount = agents.filter((a: any) => a.status === "running").length;
  const totalRuns   = agents.reduce((s: number, a: any) => s + a.totalRuns, 0);
  const avgSuccess  = agents.length ? Math.round(agents.reduce((s: number, a: any) => s + a.successRate, 0) / agents.length) : 0;

  return (
    <AppLayout>
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <Button variant="ghost" size="icon" aria-label="Go back" className="mt-0.5 h-8 w-8 shrink-0" onClick={() => window.history.back()}>
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="page-title flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
                  <Bot className="w-5 h-5" />
                </div>
                Agent Hub
              </h1>
              <p className="text-muted-foreground mt-1">Run agents individually or build a custom pipeline — you're in control.</p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
            <RefreshCw className="w-4 h-4" />Refresh
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total Agents",  value: agents.length, icon: Bot,          color: "text-primary" },
            { label: "Active Now",    value: activeCount,   icon: Activity,      color: "text-blue-500" },
            { label: "Total Runs",    value: totalRuns,     icon: Zap,           color: "text-violet-500" },
            { label: "Avg Success",   value: `${avgSuccess}%`, icon: CheckCircle2, color: "text-green-500" },
          ].map(stat => (
            <Card key={stat.label} className="border-border/40">
              <CardContent className="p-4 flex items-center gap-3">
                <div className={cn("w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center", stat.color)}>
                  <stat.icon className="w-5 h-5" />
                </div>
                <div>
                  <div className="text-xl font-bold">{isLoading ? "—" : stat.value}</div>
                  <div className="text-xs text-muted-foreground">{stat.label}</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="bg-muted/50">
            <TabsTrigger value="overview" className="gap-1.5"><Wrench className="w-3.5 h-3.5" />Individual Agents</TabsTrigger>
            <TabsTrigger value="pipeline" className="gap-1.5"><ListChecks className="w-3.5 h-3.5" />Pipeline Builder</TabsTrigger>
            <TabsTrigger value="proctoring" className="gap-1.5"><ScanFace className="w-3.5 h-3.5" />Proctoring</TabsTrigger>
            <TabsTrigger value="activity">Activity Log</TabsTrigger>
          </TabsList>

          {/* Individual agents */}
          <TabsContent value="overview" className="mt-4">
            <p className="text-sm text-muted-foreground mb-4">Click <strong>Run</strong> on any agent to choose which job (and optionally candidate) to run it against.</p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {isLoading
                ? Array.from({ length: 10 }).map((_, i) => (
                    <Card key={i} className="border-border/40 animate-pulse"><CardContent className="p-5 h-40" /></Card>
                  ))
                : agents.map((agent: any) => <AgentCard key={agent.id} agent={agent} jobs={jobs} />)
              }
            </div>
          </TabsContent>

          {/* Pipeline builder */}
          <TabsContent value="pipeline" className="mt-4">
            <p className="text-sm text-muted-foreground mb-4">Choose which agents to chain together and run them as a custom sequence against a specific job.</p>
            <PipelineBuilder jobs={jobs} />
          </TabsContent>

          {/* Proctoring */}
          <TabsContent value="proctoring" className="mt-4">
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-rose-500/5 border border-rose-500/20 rounded-xl">
                <div className="w-10 h-10 rounded-xl bg-rose-500/10 text-rose-500 flex items-center justify-center">
                  <ScanFace className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-sm">Proctoring Agent</div>
                  <div className="text-xs text-muted-foreground">Real-time AI monitoring — face presence, gaze tracking, audio integrity, and behavioural signals during video interviews</div>
                </div>
                <Badge className="ml-auto bg-rose-500/10 text-rose-500 border-rose-500/20 shrink-0">Session: sess_001</Badge>
              </div>
              <ProctoringPanel />
            </div>
          </TabsContent>

          {/* Activity log */}
          <TabsContent value="activity" className="mt-4">
            <Card className="border-border/40">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Recent Agent Activity</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-8 text-center text-muted-foreground">Loading...</div>
                ) : recentRuns.length === 0 ? (
                  <div className="p-8 text-center text-muted-foreground">No activity yet</div>
                ) : (
                  <div className="divide-y divide-border/40">
                    {recentRuns.map((run: any) => {
                      const meta = AGENT_META[run.agentId] || { icon: Bot, color: "text-primary bg-primary/10", label: run.agentId };
                      const Icon = meta.icon;
                      return (
                        <div key={run.id} className="flex items-center gap-4 px-5 py-3 hover:bg-muted/30 transition-colors">
                          <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0", meta.color)}>
                            <Icon className="w-4 h-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{meta.label}</span>
                              <StatusBadge status={run.status} />
                            </div>
                            <div className="text-xs text-muted-foreground mt-0.5">
                              Triggered by {run.triggeredByUser ?? run.triggeredBy} · {timeAgo(run.startedAt)}
                              {run.durationMs ? ` · ${formatDuration(run.durationMs)}` : ""}
                            </div>
                          </div>
                          {run.output && (
                            <div className="text-xs text-muted-foreground hidden md:block text-right">
                              {Object.entries(run.output).slice(0, 2).map(([k, v]) => (
                                <div key={k}><span className="text-foreground font-medium">{String(v)}</span> {k.replace(/([A-Z])/g, " $1").toLowerCase()}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
