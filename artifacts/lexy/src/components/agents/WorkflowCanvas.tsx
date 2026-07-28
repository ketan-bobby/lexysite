/**
 * WorkflowCanvas.tsx — Visual AI-agent workflow designer.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Renders an interactive node graph of all Lexy AI agents (ICP, Sourcing,
 * Screening, Interview, Verification, Outreach, Anti-Ghost, etc.).  Each node
 * shows live run-state, lets the recruiter toggle the agent on/off, and opens
 * an inline config drawer when clicked.  Edges between nodes visualise the
 * automated handoff sequence.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  AGENTS[]             Static node definitions (id, label, icon, colour, grid position)
 *  <AgentNode>          Individual node card with status ring and click handler
 *  <ConfigDrawer>       Side-panel that loads agent-specific settings
 *  <WorkflowCanvas>     Root: SVG edge layer + positioned agent nodes + drawer
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET /api/agents/status     Live enable/disable state per agent per job
 *  PATCH /api/agents/:id      Toggle or reconfigure an agent
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  pages/recruiter/agents.tsx           Full-page workflow view
 *  components/agents/AgentPanel.tsx     Embedded in the agent dashboard tab
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { authHeaders } from "@/lib/api";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Brain, Search, Layers, Video, ScanFace, Send, Bell,
  Shield, Calendar, BarChart3, CheckCircle2,
  Zap, ChevronRight, Cpu, AlertTriangle,
  Info, ExternalLink, Loader2, MessageSquare, Globe, Code2, Terminal,
  Settings2, FileText, Plus, Trash2, Save, Check, X, CloudCheck,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { InterviewTypeConfigurator } from "./InterviewTypeConfigurator";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

// Proctoring integrity-score bands — a session-integrity quantity, not match fit;
// its own cutoffs, so any equality with a match band is coincidental.
const INTEGRITY_STRONG = 85;
const INTEGRITY_MODERATE = 60;

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

/* Layout follows canonical AGENT_ORDER (1→9). Row 0 renders left→right with
 * steps 1-5; row 1 is reversed at render time (see [...row1].reverse() in the
 * render block) so the strip snakes top-right → bottom-right → bottom-left,
 * with steps 6-9 reading right→left along the bottom.
 *
 * Analytics is intentionally NOT in this list — it's a results dashboard,
 * not a runnable agent, and lives in the Intelligence tab. */
const AGENTS = [
  // Row 0 — steps 1-5 (left → right)
  { id: "icp",           label: "ICP",          icon: Brain,    color: "#8b5cf6", bg: "bg-violet-500/15",  border: "border-violet-500/40",  glow: "shadow-violet-500/30",  row: 0 },
  { id: "sourcing",      label: "Sourcing",     icon: Search,   color: "#3b82f6", bg: "bg-blue-500/15",    border: "border-blue-500/40",    glow: "shadow-blue-500/30",    row: 0 },
  { id: "screening",     label: "Screening",    icon: Layers,   color: "#06b6d4", bg: "bg-cyan-500/15",    border: "border-cyan-500/40",    glow: "shadow-cyan-500/30",    row: 0 },
  { id: "verification",  label: "Verify",       icon: Shield,   color: "#22c55e", bg: "bg-green-500/15",   border: "border-green-500/40",   glow: "shadow-green-500/30",   row: 0 },
  { id: "outreach",      label: "Outreach",     icon: Send,     color: "#f97316", bg: "bg-orange-500/15",  border: "border-orange-500/40",  glow: "shadow-orange-500/30",  row: 0 },
  // Row 1 — steps 6-9. Listed in execution order; rendered reversed so
  // step 6 (Schedule) sits under step 5 (Outreach) and step 9 (Anti-Ghost)
  // ends the strip on the bottom-left.
  { id: "scheduling",    label: "Schedule",     icon: Calendar, color: "#6366f1", bg: "bg-indigo-500/15",  border: "border-indigo-500/40",  glow: "shadow-indigo-500/30",  row: 1 },
  { id: "interview",     label: "Interview",    icon: Video,    color: "#10b981", bg: "bg-emerald-500/15", border: "border-emerald-500/40", glow: "shadow-emerald-500/30", row: 1 },
  { id: "proctoring",    label: "Proctoring",   icon: ScanFace, color: "#f43f5e", bg: "bg-rose-500/15",    border: "border-rose-500/40",    glow: "shadow-rose-500/30",    row: 1 },
  { id: "anti-ghosting", label: "Anti-Ghost",   icon: Bell,     color: "#eab308", bg: "bg-yellow-500/15",  border: "border-yellow-500/40",  glow: "shadow-yellow-500/30",  row: 1 },
];

const INTERVIEW_SUBS = [
  { id: "behavioral",  label: "Behavioral",  icon: MessageSquare, color: "#10b981", bg: "bg-emerald-500/15", border: "border-emerald-500/40" },
  { id: "cultural",    label: "Cultural",    icon: Globe,         color: "#0ea5e9", bg: "bg-sky-500/15",     border: "border-sky-500/40"     },
  { id: "technical",   label: "Technical",   icon: Code2,         color: "#8b5cf6", bg: "bg-violet-500/15",  border: "border-violet-500/40"  },
  { id: "programming", label: "Programming", icon: Terminal,      color: "#f97316", bg: "bg-orange-500/15",  border: "border-orange-500/40"  },
];

const DIFFICULTIES = ["easy", "medium", "hard", "mixed"];
const LANGUAGES = [
  { value: "en-US", label: "English" }, { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },     { value: "de", label: "German" },
  { value: "pt-BR", label: "Portuguese (Brazil)" }, { value: "pt-PT", label: "Portuguese (Portugal)" }, { value: "zh", label: "Chinese" },
  { value: "ja", label: "Japanese" },   { value: "ar", label: "Arabic" },
];

const AGENT_TAB: Record<string, string> = {
  icp: "icp", sourcing: "pipeline", screening: "pipeline",
  interview: "candidates", proctoring: "candidates", outreach: "outreach",
  "anti-ghosting": "outreach", verification: "candidates",
  scheduling: "pipeline",
};

function NodeStatus({ status }: { status?: string }) {
  if (status === "running")   return <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse shadow-[0_0_6px_2px] shadow-blue-400/60" />;
  if (status === "completed") return <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_2px] shadow-emerald-400/60" />;
  if (status === "failed")    return <div className="w-2 h-2 rounded-full bg-red-400" />;
  return <div className="w-2 h-2 rounded-full bg-white/10" />;
}

function ConnectorArrow({ enabled, className }: { enabled: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center w-8 shrink-0", className)}>
      <div className={cn("flex items-center gap-0 transition-all duration-300", enabled ? "opacity-100" : "opacity-20")}>
        <div className={cn("h-px w-4 transition-colors duration-300", enabled ? "bg-primary/60" : "bg-white/20")} />
        <ChevronRight className={cn("w-3 h-3 -ml-1 transition-colors duration-300", enabled ? "text-primary/60" : "text-white/20")} />
      </div>
    </div>
  );
}

/* ── Per-sub-type config state shape ───────────────────────────────────── */
interface SubConfig {
  questionCount: number;
  language: string;
  difficulty: string;
  culturalDoc: string;
  customQuestions: string[];
}

function defaultSubConfig(): SubConfig {
  return { questionCount: 5, language: "en-US", difficulty: "medium", culturalDoc: "", customQuestions: [] };
}

/* ── Inline config panel (appears below sub-nodes when gear is clicked) ── */
function SubConfigPanel({
  subId,
  config,
  onChange,
  onSaveCultural,
  saving,
  saved,
  onClose,
}: {
  subId: string;
  config: SubConfig;
  onChange: (patch: Partial<SubConfig>) => void;
  onSaveCultural: () => void;
  saving: boolean;
  saved: boolean;
  onClose: () => void;
}) {
  const [newQ, setNewQ] = useState("");
  const sub = INTERVIEW_SUBS.find(s => s.id === subId)!;

  const addQuestion = () => {
    const q = newQ.trim();
    if (!q) return;
    onChange({ customQuestions: [...config.customQuestions, q] });
    setNewQ("");
  };

  const removeQuestion = (i: number) => {
    onChange({ customQuestions: config.customQuestions.filter((_, idx) => idx !== i) });
  };

  return (
    <div
      className="animate-in fade-in slide-in-from-top-2 duration-200 rounded-xl border p-4 space-y-4 mt-3"
      style={{ borderColor: `${sub.color}30`, background: `${sub.color}08` }}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <sub.icon className="w-4 h-4" style={{ color: sub.color }} />
          <span className="text-xs font-bold">{sub.label} Configuration</span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Common: question count + language */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {subId === "programming" ? "Challenges" : "Questions"}
          </label>
          <Select
            value={String(config.questionCount)}
            onValueChange={v => onChange({ questionCount: Number(v) })}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[3, 5, 7, 10].map(n => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Language</label>
          <Select value={config.language} onValueChange={v => onChange({ language: v })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map(l => (
                <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Programming: difficulty */}
      {subId === "programming" && (
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Difficulty</label>
          <Select value={config.difficulty} onValueChange={v => onChange({ difficulty: v })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIFFICULTIES.map(d => (
                <SelectItem key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Cultural: culture doc + custom questions */}
      {subId === "cultural" && (
        <>
          <Separator className="opacity-20" />

          {/* Culture document */}
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <FileText className="w-3 h-3" /> Company Culture Document
            </label>
            <Textarea
              placeholder="Paste your company values, mission statement, culture handbook, or any cultural context the AI should use when crafting interview questions…"
              value={config.culturalDoc}
              onChange={e => onChange({ culturalDoc: e.target.value })}
              className="min-h-[110px] text-xs resize-none font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              The AI will use this to generate culturally aligned questions specific to your company.
            </p>
          </div>

          {/* Custom questions */}
          <div className="space-y-2">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Mandatory Custom Questions
            </label>
            <p className="text-[10px] text-muted-foreground -mt-1">
              These questions will always be included in the interview, alongside the AI-generated ones.
            </p>

            {config.customQuestions.length > 0 && (
              <div className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1">
                {config.customQuestions.map((q, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 p-2.5 rounded-lg border text-xs"
                    style={{ borderColor: `${sub.color}25`, background: `${sub.color}08` }}
                  >
                    <span className="font-bold flex-shrink-0 mt-0.5" style={{ color: sub.color }}>
                      Q{i + 1}
                    </span>
                    <span className="flex-1 text-foreground/90 leading-relaxed">{q}</span>
                    <button
                      onClick={() => removeQuestion(i)}
                      aria-label={`Remove question ${i + 1}`}
                      className="flex-shrink-0 text-muted-foreground hover:text-rose-400 transition-colors mt-0.5"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add question */}
            <div className="flex gap-2">
              <Input
                value={newQ}
                onChange={e => setNewQ(e.target.value)}
                onKeyDown={e => e.key === "Enter" && addQuestion()}
                placeholder="Type a custom question and press Enter…"
                className="h-8 text-xs flex-1"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={addQuestion}
                disabled={!newQ.trim()}
                className="h-8 px-3 gap-1"
              >
                <Plus className="w-3 h-3" /> Add
              </Button>
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end pt-1">
            <Button
              size="sm"
              onClick={onSaveCultural}
              disabled={saving}
              className="gap-1.5 h-8 px-4"
              style={{ background: sub.color, color: "#000" }}
            >
              {saving ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…</>
              ) : saved ? (
                <><Check className="w-3.5 h-3.5" /> Saved!</>
              ) : (
                <><Save className="w-3.5 h-3.5" /> Save Cultural Config</>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function WorkflowCanvas({ jobId, roleTitle }: { jobId: string; roleTitle?: string }) {
  const [enabled, setEnabled]       = useState<Set<string>>(new Set());
  const [configLoaded, setConfigLoaded] = useState(false);
  /* IMPORTANT: start with NO interview sub-types selected.
   * Pre-selecting all 4 made clicking "Cultural" silently toggle it OFF
   * (since it was already on), which surprised recruiters who expected
   * "click Cultural ⇒ run Cultural". Now selection is purely opt-in. */
  const [interviewTypes, setInterviewTypes] = useState<Set<string>>(new Set());
  const [openConfig, setOpenConfig] = useState<string | null>(null);

  /* Per-sub-type configuration */
  const [subConfigs, setSubConfigs] = useState<Record<string, SubConfig>>({
    behavioral: defaultSubConfig(),
    cultural:   defaultSubConfig(),
    technical:  defaultSubConfig(),
    programming: defaultSubConfig(),
  });
  const [savingCultural, setSavingCultural] = useState(false);
  const [culturalSaved, setCulturalSaved]   = useState(false);

  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched]   = useState(false);
  const [, navigate] = useLocation();
  const { toast }    = useToast();

  /* Auto-save state */
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Pipeline settings */
  const [targetCandidates, setTargetCandidates] = useState(5);
  const [autoRun, setAutoRun] = useState(false);

  /* Load saved config (agents + settings + cultural) on mount */
  useEffect(() => {
    Promise.all([
      apiFetch<{ agentIds: string[]; autoRun: boolean; targetCandidates: number; interviewTypes?: string[] }>(`/jobs/${jobId}/pipeline-config`),
      apiFetch<any>(`/interviews/cultural-config/${jobId}`),
    ]).then(([pipelineCfg, culturalCfg]) => {
      if (pipelineCfg.agentIds?.length) {
        // Heal historically-saved configs that violate the dependency graph
        // (e.g. Verify selected without Screening) AND strip legacy entries
        // for agents that are no longer part of the runnable pipeline (e.g.
        // "analytics", which moved to the Intelligence tab as a dashboard).
        const known = new Set(AGENTS.map(a => a.id));
        const filtered = pipelineCfg.agentIds.filter(id => known.has(id));
        const healed = new Set(filtered);
        for (const id of filtered) {
          for (const dep of collectPrereqs(id)) healed.add(dep);
        }
        setEnabled(healed);
        if (healed.size !== pipelineCfg.agentIds.length) {
          // Persist the healed set so the next save doesn't re-write the bad one.
          saveConfig(healed, pipelineCfg.targetCandidates ?? 5, pipelineCfg.autoRun ?? false);
        }
      }
      if (typeof pipelineCfg.targetCandidates === "number") setTargetCandidates(pipelineCfg.targetCandidates);
      if (typeof pipelineCfg.autoRun === "boolean") setAutoRun(pipelineCfg.autoRun);
      /* Restore the recruiter's previously-saved interview sub-type
       * selection so navigating away and back doesn't lose it. */
      if (Array.isArray(pipelineCfg.interviewTypes)) {
        setInterviewTypes(new Set(pipelineCfg.interviewTypes));
      }
      if (culturalCfg.culturalDoc || culturalCfg.customQuestions?.length) {
        setSubConfigs(prev => ({
          ...prev,
          cultural: {
            ...prev.cultural,
            culturalDoc: culturalCfg.culturalDoc || "",
            customQuestions: culturalCfg.customQuestions || [],
          },
        }));
      }
    }).catch(() => {}).finally(() => setConfigLoaded(true));
  }, [jobId]);

  /* Debounced auto-save — agents + settings + interview-type selection together */
  const saveConfig = useCallback((
    ids: Set<string>,
    target?: number,
    ar?: boolean,
    iTypes?: Set<string>,
  ) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus("saving");
    saveTimer.current = setTimeout(async () => {
      try {
        await apiFetch(`/jobs/${jobId}/pipeline-config`, {
          method: "POST",
          body: JSON.stringify({
            agentIds: Array.from(ids),
            targetCandidates: target,
            autoRun: ar,
            ...(iTypes !== undefined ? { interviewTypes: Array.from(iTypes) } : {}),
          }),
        });
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch {
        setSaveStatus("idle");
      }
    }, 600);
  }, [jobId]);

  const { data: agentsData, refetch } = useQuery<any>({
    queryKey: ["/api/agents"],
    queryFn: () => apiFetch("/agents"),
    refetchInterval: launching ? 2000 : 5000,
  });

  /* Pipeline status — polls viable count and running state */
  const { data: pipelineStatus, refetch: refetchStatus } = useQuery<{
    status: string;
    currentStage: string | null;
    autoRun: boolean;
    targetCandidates: number;
    viableCount: number;
    targetMet: boolean;
    activeRun: any;
  }>({
    queryKey: ["pipeline-status", jobId],
    queryFn: () => apiFetch(`/jobs/${jobId}/pipeline-status`),
    refetchInterval: (q) => {
      const d: any = q.state.data;
      const active = d?.status === "running" || launching;
      // Only poll fast when the tab is actually visible — avoids hammering
      // the backend for hidden/background tabs.
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      if (!visible) return active ? 5000 : 15000;
      return active ? 1000 : 5000;
    },
    refetchIntervalInBackground: false,
    enabled: !!jobId,
  });

  const isRunning    = pipelineStatus?.status === "running";
  const targetMet    = pipelineStatus?.targetMet ?? false;
  const viableCount  = pipelineStatus?.viableCount ?? 0;
  const progressPct  = Math.min(100, Math.round((viableCount / targetCandidates) * 100));


  const agents    = agentsData?.agents || [];
  const getAgent  = (id: string) => agents.find((a: any) => a.id === id);

  /* Agent prerequisites — enforced on toggle so the recruiter can't pick
   * Verify without Screening (etc.). Each entry lists the upstream agent(s)
   * that must run before this one. Mirrors the canonical AGENT_ORDER in
   * artifacts/api-server/src/routes/agents.ts and the gating logic the
   * orchestrator applies inside _runVerification, _runOutreach, etc. */
  const AGENT_DEPS: Record<string, string[]> = {
    icp:           [],
    sourcing:      ["icp"],
    screening:     ["sourcing"],
    verification:  ["screening"],
    outreach:      ["screening"],
    scheduling:    ["outreach"],
    interview:     ["scheduling"],
    proctoring:    ["interview"],
    "anti-ghosting": ["outreach"],
  };

  const AGENT_LABEL = Object.fromEntries(AGENTS.map(a => [a.id, a.label])) as Record<string, string>;

  const collectPrereqs = (id: string, acc: Set<string> = new Set()): Set<string> => {
    for (const dep of AGENT_DEPS[id] ?? []) {
      if (!acc.has(dep)) {
        acc.add(dep);
        collectPrereqs(dep, acc);
      }
    }
    return acc;
  };

  const collectDependents = (id: string, allEnabled: Set<string>, visited: Set<string> = new Set()): Set<string> => {
    const out = new Set<string>();
    if (visited.has(id)) return out;
    visited.add(id);
    for (const [agent, deps] of Object.entries(AGENT_DEPS)) {
      if (deps.includes(id) && allEnabled.has(agent)) {
        out.add(agent);
        for (const d of collectDependents(agent, allEnabled, visited)) out.add(d);
      }
    }
    return out;
  };

  // Canonical execution order — kept in sync with backend AGENT_ORDER and
  // EXEC_ORDER in the live strip. Used to display prerequisite names in
  // pipeline order ("ICP → Sourcing → Screening") instead of insertion order.
  const EXEC_ORDER_LOCAL: Record<string, number> = {
    icp: 1, sourcing: 2, screening: 3, verification: 4, outreach: 5,
    scheduling: 6, interview: 7, proctoring: 8, "anti-ghosting": 9,
  };
  const sortByOrder = (ids: string[]) =>
    [...ids].sort((a, b) => (EXEC_ORDER_LOCAL[a] ?? 99) - (EXEC_ORDER_LOCAL[b] ?? 99));

  const toggle = (id: string) => {
    setEnabled(prev => {
      const next = new Set(prev);
      const wasOn = next.has(id);

      if (wasOn) {
        // Turning OFF — also disable anything that depends on this agent.
        next.delete(id);
        const dependents = collectDependents(id, prev);
        if (dependents.size > 0) {
          for (const d of dependents) next.delete(d);
          toast({
            title: `Also disabled ${pluralize(dependents.size, "dependent agent")}`,
            description: `${sortByOrder([...dependents]).map(d => AGENT_LABEL[d] ?? d).join(", ")} need${dependents.size > 1 ? "" : "s"} ${AGENT_LABEL[id] ?? id} to run first.`,
          });
        }
      } else {
        // Turning ON — pull in any missing prerequisites.
        next.add(id);
        const missing = [...collectPrereqs(id)].filter(p => !prev.has(p));
        if (missing.length > 0) {
          for (const p of missing) next.add(p);
          toast({
            title: `Auto-added ${pluralize(missing.length, "required step")}`,
            description: `${AGENT_LABEL[id] ?? id} needs ${sortByOrder(missing).map(m => AGENT_LABEL[m] ?? m).join(" → ")} to run first.`,
          });
        }
      }

      if (configLoaded) saveConfig(next, targetCandidates, autoRun);
      return next;
    });
  };

  const handleTargetChange = (val: number) => {
    setTargetCandidates(val);
    if (configLoaded) saveConfig(enabled, val, autoRun);
  };

  const handleAutoRunChange = (val: boolean) => {
    setAutoRun(val);
    if (configLoaded) saveConfig(enabled, targetCandidates, val);
  };

  const handleStop = async () => {
    try {
      await apiFetch(`/jobs/${jobId}/pipeline-stop`, { method: "POST" });
      setAutoRun(false);
      refetchStatus();
      toast({ title: "Auto-run stopped" });
    } catch {
      toast({ title: "Failed to stop pipeline", variant: "destructive" });
    }
  };

  const toggleInterviewType = (id: string) => {
    const isCurrentlyOn = interviewTypes.has(id);
    /* Single-select semantics: clicking a sub-type makes it THE active
     * type, clicking the active one again clears the selection. This
     * matches the orchestrator (which runs exactly one interview type per
     * run) and avoids silently honoring only the first of multiple chips. */
    const next = new Set<string>();
    if (!isCurrentlyOn) next.add(id);
    setInterviewTypes(next);
    if (configLoaded) saveConfig(enabled, targetCandidates, autoRun, next);
    /* Auto-open config when enabling, auto-close when disabling */
    setOpenConfig(isCurrentlyOn ? null : id);
  };

  const patchSubConfig = (id: string, patch: Partial<SubConfig>) => {
    setSubConfigs(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  };

  const saveCulturalConfig = async () => {
    const cfg = subConfigs.cultural;
    setSavingCultural(true);
    try {
      await apiFetch(`/interviews/cultural-config/${jobId}`, {
        method: "POST",
        body: JSON.stringify({ culturalDoc: cfg.culturalDoc, customQuestions: cfg.customQuestions }),
      });
      setCulturalSaved(true);
      setTimeout(() => setCulturalSaved(false), 2500);
      toast({ title: "Cultural config saved" });
    } catch {
      toast({ title: "Failed to save cultural config", variant: "destructive" });
    } finally {
      setSavingCultural(false);
    }
  };

  const enabledList = AGENTS.filter(a => enabled.has(a.id));
  const lastEnabled = enabledList[enabledList.length - 1];
  const firstTab    = lastEnabled ? (AGENT_TAB[lastEnabled.id] || "intelligence") : "intelligence";

  const handleLaunch = async () => {
    if (enabled.size === 0) { toast({ title: "Select at least one agent", variant: "destructive" }); return; }
    /* Cancel any pending debounced autosave so it can't race past the
     * launch-time POST below and overwrite the freshly persisted config
     * (e.g. the recruiter's chosen interview type) right as the run starts. */
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    setLaunching(true);
    try {
      // Save settings first so autoRun + target + interview-type selection
      // are persisted before the run starts.
      await apiFetch(`/jobs/${jobId}/pipeline-config`, {
        method: "POST",
        body: JSON.stringify({
          agentIds: Array.from(enabled),
          autoRun,
          targetCandidates,
          interviewTypes: Array.from(interviewTypes),
        }),
      });
      await apiFetch("/agents/run-selection", {
        method: "POST",
        body: JSON.stringify({ agentIds: Array.from(enabled), jobId }),
      });
      setLaunched(true);
      refetchStatus();
      setTimeout(() => { navigate(`/jobs/${jobId}?tab=${firstTab}`); setLaunched(false); setLaunching(false); }, 2200);
    } catch {
      toast({ title: "Failed to launch pipeline", variant: "destructive" });
      setLaunching(false);
    }
  };

  const row0 = AGENTS.filter(a => a.row === 0);
  const row1 = AGENTS.filter(a => a.row === 1);

  const interviewOn = enabled.has("interview");

  if (launched) {
    return (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background/95 backdrop-blur-xl animate-in fade-in duration-300">
        <div className="flex flex-col items-center gap-6">
          <div className="w-24 h-24 rounded-3xl bg-primary/20 flex items-center justify-center shadow-2xl shadow-primary/30 animate-pulse">
            <Cpu className="w-12 h-12 text-primary" />
          </div>
          <div className="text-center">
            <h2 className="text-2xl font-bold">Pipeline Launched</h2>
            <p className="text-muted-foreground mt-1 text-sm">{enabled.size} agents running in sequence…</p>
          </div>
          <div className="flex gap-1">
            {[0,1,2].map(i => (
              <div key={i} className="w-2 h-2 rounded-full bg-primary animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold">Hiring Pipeline</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isRunning
                ? `Running${pipelineStatus?.currentStage ? ` — ${pipelineStatus.currentStage}` : ""}…`
                : "Select agents, set your target, then launch."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {saveStatus === "saving" && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" /> Saving…
              </span>
            )}
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                <Check className="w-3 h-3" /> Saved
              </span>
            )}
            {isRunning && (
              <Button size="sm" variant="outline" onClick={handleStop} className="gap-1.5 border-red-500/40 text-red-400 hover:bg-red-500/10">
                <X className="w-3.5 h-3.5" /> Stop
              </Button>
            )}
          </div>
        </div>

        {/* Settings row: target candidates + auto-run toggle + progress */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Target + auto-run */}
          <div className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/3 px-4 py-3">
            <div className="flex-1 space-y-0.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Target Candidates</p>
              <p className="text-[11px] text-muted-foreground/70">Stop when this many viable candidates are found</p>
            </div>
            <Select
              value={String(targetCandidates)}
              onValueChange={v => handleTargetChange(Number(v))}
            >
              <SelectTrigger className="w-20 h-8 text-sm font-bold">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[3, 5, 10, 15, 20, 25, 50].map(n => (
                  <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Auto-run toggle */}
          <div
            className={cn(
              "flex items-center gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-all duration-200",
              autoRun ? "border-primary/40 bg-primary/8" : "border-white/8 bg-white/3",
            )}
            onClick={() => handleAutoRunChange(!autoRun)}
          >
            <div className="flex-1 space-y-0.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Auto-Run Mode</p>
              <p className="text-[11px] text-muted-foreground/70">
                {autoRun ? "Pipeline will re-run automatically until target is met" : "Pipeline runs once and stops"}
              </p>
            </div>
            <div className={cn(
              "w-10 h-6 rounded-full relative transition-colors duration-200 flex-shrink-0",
              autoRun ? "bg-primary" : "bg-white/10",
            )}>
              <div className={cn(
                "absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-all duration-200",
                autoRun ? "left-5" : "left-1",
              )} />
            </div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="rounded-xl border border-white/8 bg-white/3 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground font-medium">Viable Candidates Found</span>
            <span className={cn("font-bold tabular-nums", targetMet ? "text-emerald-400" : "text-foreground")}>
              {viableCount} <span className="text-muted-foreground font-normal">of {targetCandidates}</span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-white/8 overflow-hidden">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-700",
                targetMet ? "bg-emerald-400" : isRunning ? "bg-primary animate-pulse" : "bg-primary/60",
              )}
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {targetMet && (
            <p className="text-[11px] text-emerald-400 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Target reached — pipeline will stop automatically
            </p>
          )}
          {isRunning && !targetMet && (
            <p className="text-[11px] text-primary/80 flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Searching for candidates…
            </p>
          )}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
            <span>{enabled.size} of {AGENTS.length} agents selected</span>
            <span>{progressPct}% complete</span>
          </div>
        </div>
      </div>

      {/* Canvas */}
      <div className="rounded-2xl border border-white/5 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-8 overflow-x-auto">
        <div className="min-w-[720px] space-y-4">

          {/* Row 1 */}
          <div className="flex items-start justify-center gap-0">
            {row0.map((agent, i) => {
              const isOn        = enabled.has(agent.id);
              const status      = getAgent(agent.id)?.status;
              const Icon        = agent.icon;
              const isFirst     = i === 0;
              const prevOn      = i > 0 ? enabled.has(row0[i - 1].id) : false;
              const isInterview = agent.id === "interview";

              return (
                <div key={agent.id} className="flex items-start">
                  {!isFirst && <ConnectorArrow enabled={isOn && prevOn} className="h-[96px]" />}

                  <div className="flex flex-col items-center">
                    {/* Main node */}
                    <button
                      onClick={() => toggle(agent.id)}
                      className={cn(
                        "relative flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-300 w-[104px] group",
                        isOn ? `${agent.bg} ${agent.border} shadow-lg ${agent.glow}` : "bg-white/3 border-white/10 opacity-40 hover:opacity-60",
                      )}
                    >
                      <div className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-slate-800 border border-white/10 flex items-center justify-center text-[9px] font-bold text-muted-foreground">
                        {AGENTS.indexOf(agent) + 1}
                      </div>
                      <div className="absolute top-2 right-2">
                        <NodeStatus status={isOn ? status : undefined} />
                      </div>
                      <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300", isOn ? agent.bg : "bg-white/5")}>
                        <Icon className="w-5 h-5" style={{ color: isOn ? agent.color : undefined }} />
                      </div>
                      <span className="text-xs font-semibold text-center leading-tight" style={{ color: isOn ? agent.color : undefined }}>
                        {agent.label}
                      </span>
                      {isOn && status === "completed" && (
                        <CheckCircle2 className="w-3 h-3 text-emerald-400 absolute -bottom-1.5 left-1/2 -translate-x-1/2" />
                      )}
                    </button>

                    {/* ── Interview sub-nodes ──────────────────────────────── */}
                    {isInterview && isOn && (
                      <div className="flex flex-col items-center animate-in fade-in slide-in-from-top-2 duration-300 mt-1">
                        {/* Vertical stem */}
                        <div className="w-px h-5 bg-emerald-500/40" />

                        {/* Sub-node row */}
                        <div className="relative flex items-start">
                          {/* Horizontal connector bar */}
                          <div className="absolute top-0 left-[35px] right-[35px] h-px bg-emerald-500/25" />

                          <div className="flex gap-1.5">
                            {INTERVIEW_SUBS.map((sub) => {
                              const SubIcon  = sub.icon;
                              const subOn    = interviewTypes.has(sub.id);
                              const isConfig = openConfig === sub.id;

                              return (
                                <div key={sub.id} className="flex flex-col items-center">
                                  {/* Vertical drop */}
                                  <div className={cn("w-px h-3 transition-colors duration-200", subOn ? "bg-emerald-500/35" : "bg-white/10")} />

                                  {/* Sub-node button */}
                                  <button
                                    onClick={(e) => { e.stopPropagation(); toggleInterviewType(sub.id); }}
                                    title={`Toggle ${sub.label}`}
                                    className={cn(
                                      "relative flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 w-[70px] transition-all duration-200 focus:outline-none",
                                      subOn
                                        ? `${sub.bg} ${sub.border} shadow-md hover:brightness-110`
                                        : "bg-white/3 border-white/10 opacity-40 hover:opacity-70",
                                    )}
                                  >
                                    <SubIcon className="w-3.5 h-3.5" style={{ color: subOn ? sub.color : undefined }} />
                                    <span className="text-[9px] font-semibold leading-tight text-center" style={{ color: subOn ? sub.color : undefined }}>
                                      {sub.label}
                                    </span>

                                    {/* Settings gear — only shows when sub-node is on */}
                                    {subOn && (
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setOpenConfig(prev => prev === sub.id ? null : sub.id);
                                        }}
                                        title="Configure"
                                        className={cn(
                                          "absolute -bottom-2 left-1/2 -translate-x-1/2 w-4 h-4 rounded-full flex items-center justify-center transition-all duration-200",
                                          isConfig
                                            ? "bg-white/20 text-white"
                                            : "bg-slate-800 border border-white/20 text-muted-foreground hover:text-white hover:border-white/40",
                                        )}
                                        style={isConfig ? { background: `${sub.color}40`, borderColor: sub.color } : undefined}
                                      >
                                        <Settings2 className="w-2.5 h-2.5" />
                                      </button>
                                    )}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>

                        {/* ── Inline config panel ─────────────────────────── */}
                        {openConfig && interviewTypes.has(openConfig) && (
                          <div className="w-[360px] mt-4">
                            <SubConfigPanel
                              subId={openConfig}
                              config={subConfigs[openConfig]}
                              onChange={(patch) => patchSubConfig(openConfig, patch)}
                              onSaveCultural={saveCulturalConfig}
                              saving={savingCultural}
                              saved={culturalSaved}
                              onClose={() => setOpenConfig(null)}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Bend connector row 1 → row 2 */}
          <div className={cn("flex items-center justify-between px-[52px]", interviewOn && "mt-6")}>
            <div className="flex-1" />
            <div className="flex flex-col items-end pr-[3px]">
              <div className={cn("w-px h-5 transition-colors duration-300", enabled.has("proctoring") ? "bg-primary/40" : "bg-white/10")} />
              <div className={cn("w-[calc(5*104px+4*32px-52px)] h-px transition-colors duration-300", (enabled.has("proctoring") || enabled.has("outreach")) ? "bg-primary/20" : "bg-white/5")} />
              <div className={cn("w-px h-5 transition-colors duration-300", enabled.has("outreach") ? "bg-primary/40" : "bg-white/10")} />
            </div>
          </div>

          {/* Row 2 (reversed) */}
          <div className="flex items-center justify-center gap-0">
            {[...row1].reverse().map((agent, ri) => {
              const i         = row1.length - 1 - ri;
              const isOn      = enabled.has(agent.id);
              const status    = getAgent(agent.id)?.status;
              const Icon      = agent.icon;
              const isLast    = ri === row1.length - 1;
              const nextAgent = row1[i + 1];
              const nextOn    = nextAgent ? enabled.has(nextAgent.id) : false;
              return (
                <div key={agent.id} className="flex items-center">
                  {!isLast && <ConnectorArrow enabled={isOn && nextOn} />}
                  <button
                    onClick={() => toggle(agent.id)}
                    className={cn(
                      "relative flex flex-col items-center gap-2 p-4 rounded-2xl border-2 transition-all duration-300 w-[104px] group",
                      isOn ? `${agent.bg} ${agent.border} shadow-lg ${agent.glow}` : "bg-white/3 border-white/10 opacity-40 hover:opacity-60",
                    )}
                  >
                    <div className="absolute -top-2 -left-2 w-5 h-5 rounded-full bg-slate-800 border border-white/10 flex items-center justify-center text-[9px] font-bold text-muted-foreground">
                      {AGENTS.indexOf(agent) + 1}
                    </div>
                    <div className="absolute top-2 right-2">
                      <NodeStatus status={isOn ? status : undefined} />
                    </div>
                    <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center transition-all duration-300", isOn ? agent.bg : "bg-white/5")}>
                      <Icon className="w-5 h-5" style={{ color: isOn ? agent.color : undefined }} />
                    </div>
                    <span className="text-xs font-semibold text-center leading-tight" style={{ color: isOn ? agent.color : undefined }}>
                      {agent.label}
                    </span>
                    {isOn && status === "completed" && (
                      <CheckCircle2 className="w-3 h-3 text-emerald-400 absolute -bottom-1.5 left-1/2 -translate-x-1/2" />
                    )}
                  </button>
                  {isLast && <ConnectorArrow enabled={false} />}
                </div>
              );
            })}
          </div>

        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-muted-foreground">
        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_2px] shadow-emerald-400/60" /> Done</div>
        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" /> Running</div>
        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-white/10" /> Idle</div>
        <div className="flex items-center gap-2 ml-auto"><span>Click any agent node to toggle it on or off</span></div>
      </div>

      {/* Active flow summary — live-status aware while running.
          Chips are ordered by the canonical execution order (which the
          backend uses to schedule agents), NOT by the AGENTS visual array.
          That keeps the running chip moving smoothly left → right —
          e.g. Verify executes between Screening and Outreach, even though
          it sits in the second visual row of the canvas. */}
      {enabled.size > 0 && (() => {
        const liveStages = (pipelineStatus?.activeRun?.stages as Array<{ agentId: string; status: string }> | undefined) ?? [];
        const statusOf   = (id: string) => liveStages.find(s => s.agentId === id)?.status as ("pending" | "running" | "completed" | "failed" | undefined);

        // Canonical pipeline-execution order — must mirror AGENT_ORDER in
        // artifacts/api-server/src/routes/agents.ts.
        const EXEC_ORDER: Record<string, number> = {
          icp: 1, sourcing: 2, screening: 3, verification: 4, outreach: 5,
          scheduling: 6, interview: 7, proctoring: 8, "anti-ghosting": 9,
        };

        // While a run is in flight, prefer the actual stage order the backend
        // recorded — that's the source of truth and stays correct even if
        // EXEC_ORDER drifts. Otherwise fall back to the canonical map.
        const liveOrder = liveStages.map(s => s.agentId);
        const flowAgents = AGENTS
          .filter(a => enabled.has(a.id))
          .sort((a, b) => {
            const ai = liveOrder.indexOf(a.id);
            const bi = liveOrder.indexOf(b.id);
            // Both in live order → use live order (canonical truth from backend).
            if (ai !== -1 && bi !== -1) return ai - bi;
            // Only one in live order → that one comes first; the missing one
            // is part of the enabled set but not the active run, so keep it
            // visually after the live chips.
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            // Neither in live order → fall back to canonical execution order.
            return (EXEC_ORDER[a.id] ?? 99) - (EXEC_ORDER[b.id] ?? 99);
          });
        const runningIdx = flowAgents.findIndex(a => statusOf(a.id) === "running");
        const completed  = flowAgents.filter(a => statusOf(a.id) === "completed").length;
        const total      = liveStages.length || flowAgents.length;
        return (
          <div className={cn(
            "rounded-xl border p-4 transition-colors",
            isRunning ? "bg-primary/8 border-primary/30" : "bg-primary/5 border-primary/20",
          )}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-muted-foreground shrink-0 mr-1">
                {isRunning ? "Live:" : "Flow:"}
              </span>
              {flowAgents.map((a, i, arr) => {
                const st = statusOf(a.id);
                const isDone    = st === "completed";
                const isRunNow  = st === "running";
                const isFailed  = st === "failed";
                const isPending = isRunning && !st || st === "pending";
                return (
                  <div key={a.id} className="flex items-center gap-2">
                    <div className={cn(
                      "flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-semibold transition-all duration-300",
                      isRunNow  && "border-primary bg-primary/20 text-primary shadow-md shadow-primary/30 scale-[1.08] animate-pulse",
                      isDone    && "border-emerald-500/50 bg-emerald-500/15 text-emerald-300",
                      isFailed  && "border-red-500/50 bg-red-500/15 text-red-300",
                      isPending && "border-white/10 bg-white/3 text-muted-foreground/60",
                      !isRunning && "border-transparent",
                    )}
                      style={!isRunning ? { background: `${a.color}22`, color: a.color, borderColor: `${a.color}44` } : undefined}
                    >
                      {isRunNow && <Loader2 className="w-3 h-3 animate-spin" />}
                      {isDone   && <Check className="w-3 h-3" />}
                      {isFailed && <X className="w-3 h-3" />}
                      <span>{a.label}</span>
                    </div>
                    {a.id === "interview" && interviewTypes.size > 0 && (
                      <span className="text-[10px] text-emerald-400/70">
                        ({INTERVIEW_SUBS.filter(s => interviewTypes.has(s.id)).map(s => s.label).join(", ")})
                      </span>
                    )}
                    {i < arr.length - 1 && (
                      <ChevronRight className={cn(
                        "w-3 h-3 transition-colors duration-300",
                        isRunning && (isDone || (isRunNow && i < runningIdx + 1)) ? "text-primary" : "text-muted-foreground/40",
                      )} />
                    )}
                  </div>
                );
              })}
              {isRunning && total > 0 && (
                <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                  {completed}/{total} done
                </span>
              )}
            </div>
            {isRunning && total > 0 && (
              <div className="mt-3 h-1 w-full rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-primary/70 to-primary transition-all duration-700 ease-out"
                  style={{ width: `${Math.round(((completed + (runningIdx >= 0 ? 0.5 : 0)) / total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        );
      })()}

      {/* ── Launch Button ─────────────────────────────────────────────────── */}
      <Button
        size="lg"
        onClick={handleLaunch}
        disabled={launching || enabled.size === 0 || (isRunning && !autoRun)}
        className={cn(
          "w-full gap-2 py-6 text-base font-bold transition-all duration-300",
          enabled.size > 0 && !isRunning
            ? "shadow-xl shadow-primary/30 hover:shadow-primary/50 hover:scale-[1.01]"
            : "opacity-50",
        )}
      >
        {launching
          ? <><Cpu className="w-5 h-5 animate-spin" /> Launching…</>
          : isRunning
            ? <><Loader2 className="w-5 h-5 animate-spin" /> Running — {pipelineStatus?.currentStage ?? "pipeline in progress"}…</>
            : targetMet
              ? <><CheckCircle2 className="w-5 h-5" /> Target Met — Pipeline Complete</>
              : enabled.size === 0
                ? <><Zap className="w-5 h-5" /> Select agents above to launch</>
                : <><Zap className="w-5 h-5" /> Launch Pipeline — {pluralize(enabled.size, "agent")} selected</>}
      </Button>

      {/* ── Proctoring Results ───────────────────────────────────────────── */}
      {(() => {
        const recentRuns: any[] = agentsData?.recentRuns ?? [];
        const procRun = recentRuns
          .filter(r => r.agentId === "proctoring" && r.status === "completed" && r.input?.jobId === jobId)
          .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];

        const out      = procRun?.output;
        const sessions: any[] = out?.sessions ?? [];
        const verdict: string = out?.overallVerdict ?? out?.verdict ?? "low_risk";
        const avgScore: number = out?.averageIntegrityScore ?? out?.integrityScore ?? 100;
        const highRisk: number = out?.highRiskCount ?? 0;
        const reviewed: number = out?.sessionsReviewed ?? sessions.length;

        const verdictColor = verdict === "high_risk"
          ? "text-rose-400 border-rose-500/30 bg-rose-500/10"
          : verdict === "medium_risk"
          ? "text-yellow-400 border-yellow-500/30 bg-yellow-500/10"
          : "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
        const scoreColor = avgScore >= INTEGRITY_STRONG ? "text-emerald-400" : avgScore >= INTEGRITY_MODERATE ? "text-yellow-400" : "text-rose-400";

        return (
          <>
            <Separator />
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-rose-500/10 border border-rose-500/30 flex items-center justify-center flex-shrink-0">
                  <ScanFace className="w-4 h-4 text-rose-400" />
                </div>
                <div className="flex-1">
                  <h3 className="text-base font-bold">Proctoring Results</h3>
                  <p className="text-xs text-muted-foreground">
                    {procRun
                      ? `Last analysed ${new Date(procRun.startedAt).toLocaleString()} · ${pluralize(reviewed, "session")} reviewed`
                      : "Proctoring runs automatically during AI video interviews — results appear here once candidates complete their sessions"}
                  </p>
                </div>
                {procRun && (
                  <Badge variant="outline" className={cn("text-xs font-semibold shrink-0", verdictColor)}>
                    {verdict === "high_risk" ? <AlertTriangle className="w-3 h-3 mr-1" /> : verdict === "medium_risk" ? <Info className="w-3 h-3 mr-1" /> : <CheckCircle2 className="w-3 h-3 mr-1" />}
                    {verdict.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                  </Badge>
                )}
              </div>

              {out && (
                <>
                  <div className="grid grid-cols-3 gap-3">
                    <Card className="border-border/40 bg-card/60"><CardContent className="py-3 text-center">
                      <p className={cn("text-2xl font-bold tabular-nums", scoreColor)}>{avgScore}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Avg Integrity Score</p>
                    </CardContent></Card>
                    <Card className="border-border/40 bg-card/60"><CardContent className="py-3 text-center">
                      <p className="text-2xl font-bold tabular-nums">{reviewed}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">Sessions Reviewed</p>
                    </CardContent></Card>
                    <Card className="border-border/40 bg-card/60"><CardContent className="py-3 text-center">
                      <p className={cn("text-2xl font-bold tabular-nums", highRisk > 0 ? "text-rose-400" : "text-emerald-400")}>{highRisk}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">High-Risk Sessions</p>
                    </CardContent></Card>
                  </div>

                  {sessions.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Session Breakdown</p>
                      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                        {sessions.map((s: any) => {
                          const trust: string  = s.trustLevel ?? s.verdict ?? "low_risk";
                          const sc: number     = s.integrityScore ?? 100;
                          const rowColor = trust === "high_risk" ? "border-rose-500/20 bg-rose-500/5" : trust === "medium_risk" ? "border-yellow-500/20 bg-yellow-500/5" : "border-emerald-500/10 bg-card/40";
                          const scoreCol = sc >= INTEGRITY_STRONG ? "text-emerald-400" : sc >= INTEGRITY_MODERATE ? "text-yellow-400" : "text-rose-400";
                          const scoreBorder = sc >= INTEGRITY_STRONG ? "border-emerald-500/30 bg-emerald-500/10" : sc >= INTEGRITY_MODERATE ? "border-yellow-500/30 bg-yellow-500/10" : "border-rose-500/30 bg-rose-500/10";
                          return (
                            <div key={s.sessionId} className={cn("rounded-lg border p-3 flex items-start gap-3", rowColor)}>
                              <div className={cn("w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-sm font-bold border", scoreCol, scoreBorder)}>{sc}</div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                                  <span className="text-xs font-mono text-muted-foreground">{s.sessionId?.slice(0, 8)}…</span>
                                  <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", trust === "high_risk" ? "text-rose-400 border-rose-500/30" : trust === "medium_risk" ? "text-yellow-400 border-yellow-500/30" : "text-emerald-400 border-emerald-500/30")}>
                                    {trust.replace(/_/g, " ")}
                                  </Badge>
                                </div>
                                <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">{s.notes}</p>
                                {(s.flags ?? []).length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1.5">
                                    {s.flags.map((f: string) => (
                                      <span key={f} className="text-[9px] bg-rose-500/10 text-rose-400 border border-rose-500/20 rounded px-1.5 py-0.5 font-mono">{f}</span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <a href={`${BASE}/interviews/${s.sessionId}/proctor-report`} target="_blank" rel="noopener noreferrer" className="flex-shrink-0 text-muted-foreground hover:text-primary transition-colors mt-1" title="View full report">
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        );
      })()}

      {/* ── Interview Generator ──────────────────────────────────────────── */}
      <div className="mt-2">
        <InterviewTypeConfigurator jobId={jobId} roleTitle={roleTitle} />
      </div>
    </div>
  );
}
