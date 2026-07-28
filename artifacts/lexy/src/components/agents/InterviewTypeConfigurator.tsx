/**
 * InterviewTypeConfigurator.tsx — Per-job interview type & question configurator.
 *
 * ── What this file does ───────────────────────────────────────────────────────
 * Provides a UI for recruiters to choose the interview modality for a job
 * (Human-led, AI async video, AI live, or mixed) and configure the question
 * bank, time limits, proctoring settings, and public interview link for that
 * job.  Saving persists the config to the Interview Agent for that job.
 *
 * ── Key sections ──────────────────────────────────────────────────────────────
 *  INTERVIEW_TYPES[]          Type definitions (id, label, icon, description)
 *  <QuestionEditor>           Add / remove / reorder interview questions
 *  <InterviewTypeConfigurator> Root: type selector + per-type settings form
 *
 * ── Data sources ──────────────────────────────────────────────────────────────
 *  GET  /api/interviews/config/:jobId    Load existing interview config
 *  POST /api/interviews/config/:jobId    Save updated config
 *  POST /api/interviews/generate-questions   AI-generate question suggestions
 *
 * ── Used by ───────────────────────────────────────────────────────────────────
 *  components/agents/WorkflowCanvas.tsx  Opened from the Interview agent node
 *  pages/recruiter/jobs/[id].tsx         Job settings — Interview tab
 */

import { useState, useEffect } from "react";
import { authHeaders } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Users, Globe, Cpu, Code2, Plus, Trash2, ExternalLink,
  Copy, Check, Loader2, ChevronRight, FileText, Sparkles,
  Save, Info, ChevronDown, ChevronUp, Play, CheckSquare,
  Square, X, Zap, Target,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

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

type InterviewType = "behavioral" | "cultural" | "technical" | "programming";

interface TypeDef {
  id: InterviewType;
  label: string;
  icon: React.ComponentType<any>;
  color: string;
  bg: string;
  border: string;
  description: string;
  badge: string;
  agentName: string;
}

const TYPES: TypeDef[] = [
  {
    id: "behavioral",
    label: "Behavioral",
    icon: Users,
    color: "#a78bfa",
    bg: "bg-violet-500/10",
    border: "border-violet-500/30",
    description: "STAR-method questions about past experiences, leadership, conflict resolution",
    badge: "STAR Framework",
    agentName: "Behavioral Agent",
  },
  {
    id: "cultural",
    label: "Cultural Fit",
    icon: Globe,
    color: "#22d3ee",
    bg: "bg-cyan-500/10",
    border: "border-cyan-500/30",
    description: "Culture-fit assessment using company values doc and custom recruiter questions",
    badge: "Culture Alignment",
    agentName: "Cultural Agent",
  },
  {
    id: "technical",
    label: "Technical",
    icon: Cpu,
    color: "#4ade80",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    description: "System design, architecture, debugging, and deep domain expertise",
    badge: "Deep Expertise",
    agentName: "Technical Agent",
  },
  {
    id: "programming",
    label: "Programming",
    icon: Code2,
    color: "#fb923c",
    bg: "bg-orange-500/10",
    border: "border-orange-500/30",
    description: "Coding challenges with in-browser editor and AI evaluation of solutions",
    badge: "Code Editor",
    agentName: "Coding Agent",
  },
];

const QUESTION_COUNTS = [3, 5, 7, 10];
const DIFFICULTIES = [
  { value: "easy", label: "Easy" },
  { value: "medium", label: "Medium" },
  { value: "hard", label: "Hard" },
  { value: "mixed", label: "Mixed (Easy → Hard)" },
];
const LANGUAGES = [
  { value: "en-US", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "pt-BR", label: "Portuguese (Brazil)" },
  { value: "pt-PT", label: "Portuguese (Portugal)" },
  { value: "zh", label: "Chinese (Mandarin)" },
  { value: "ja", label: "Japanese" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
  { value: "fil", label: "Filipino" },
  { value: "id", label: "Indonesian" },
  { value: "ms", label: "Malay" },
  { value: "th", label: "Thai" },
  { value: "vi", label: "Vietnamese" },
  { value: "he", label: "Hebrew" },
];

interface AgentConfig {
  questionCount: number;
  difficulty: string;
  language: string;
  candidateId: string;
  culturalDoc: string;
  customQuestions: string[];
  focusDirective: string;
}

const defaultConfig = (): AgentConfig => ({
  questionCount: 5,
  difficulty: "medium",
  language: "en-US",
  candidateId: "demo",
  culturalDoc: "",
  customQuestions: [],
  focusDirective: "",
});

interface AgentResult {
  type: InterviewType;
  data: any;
  url: string;
  copied: boolean;
}

interface AgentError {
  type: InterviewType;
  message: string;
}

export function InterviewTypeConfigurator({
  jobId,
  roleTitle,
  candidates = [],
}: {
  jobId: string;
  roleTitle?: string;
  candidates?: Array<{ id: string; firstName: string; lastName: string }>;
}) {
  const { toast } = useToast();

  /* ── Selection state ─────────────────────────────────────────────────── */
  const [selected, setSelected] = useState<Set<InterviewType>>(new Set());
  const [expanded, setExpanded] = useState<Set<InterviewType>>(new Set());

  /* ── Per-agent configs ───────────────────────────────────────────────── */
  const [configs, setConfigs] = useState<Record<InterviewType, AgentConfig>>({
    behavioral: defaultConfig(),
    cultural: defaultConfig(),
    technical: defaultConfig(),
    programming: defaultConfig(),
  });

  /* ── Per-type custom-question draft + save state ──────────────────────── */
  const [newQuestion, setNewQuestion] = useState<Record<InterviewType, string>>({
    behavioral: "", cultural: "", technical: "", programming: "",
  });
  const [savingDirection, setSavingDirection] = useState<Set<InterviewType>>(new Set());
  const [directionSaved, setDirectionSaved] = useState<Set<InterviewType>>(new Set());

  /* ── Generation state ────────────────────────────────────────────────── */
  const [running, setRunning] = useState<Set<InterviewType>>(new Set());
  const [results, setResults] = useState<AgentResult[]>([]);
  const [errors, setErrors] = useState<AgentError[]>([]);

  /* Load saved cultural config (culture document lives in its own store) */
  useEffect(() => {
    apiFetch<any>(`/interviews/cultural-config/${jobId}`)
      .then(cfg => {
        if (cfg.culturalDoc) {
          setConfigs(prev => ({
            ...prev,
            cultural: { ...prev.cultural, culturalDoc: cfg.culturalDoc || "" },
          }));
        }
      })
      .catch(() => {});
  }, [jobId]);

  /* Load saved per-type interview direction (focus + custom questions). This is
     the durable per-job store that also feeds the pipeline auto-interview. */
  useEffect(() => {
    apiFetch<any>(`/jobs/${jobId}/interview-direction`)
      .then(res => {
        const map = (res?.interviewDirection ?? {}) as Record<string, { focusDirective?: string; customQuestions?: string[] }>;
        setConfigs(prev => {
          const next = { ...prev };
          (["behavioral", "cultural", "technical", "programming"] as InterviewType[]).forEach(type => {
            const dir = map[type];
            if (dir) {
              next[type] = {
                ...next[type],
                focusDirective: dir.focusDirective ?? "",
                customQuestions: Array.isArray(dir.customQuestions) ? dir.customQuestions : [],
              };
            }
          });
          return next;
        });
      })
      .catch(() => {});
  }, [jobId]);

  const patchConfig = (type: InterviewType, patch: Partial<AgentConfig>) => {
    setConfigs(prev => ({ ...prev, [type]: { ...prev[type], ...patch } }));
  };

  const toggleSelect = (type: InterviewType) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
        setExpanded(exp => { const e = new Set(exp); e.delete(type); return e; });
      } else {
        next.add(type);
        setExpanded(exp => new Set(exp).add(type));
      }
      return next;
    });
    setResults([]);
    setErrors([]);
  };

  const toggleExpand = (type: InterviewType) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  };

  const saveDirection = async (type: InterviewType) => {
    const cfg = configs[type];
    setSavingDirection(prev => new Set(prev).add(type));
    try {
      /* Durable per-type direction (focus + custom questions) — feeds both the
         generate-link interview AND the pipeline auto-interview. */
      await apiFetch(`/jobs/${jobId}/interview-direction`, {
        method: "POST",
        body: JSON.stringify({
          type,
          focusDirective: cfg.focusDirective,
          customQuestions: cfg.customQuestions,
        }),
      });
      /* Cultural also persists its culture document in its own store. */
      if (type === "cultural") {
        await apiFetch(`/interviews/cultural-config/${jobId}`, {
          method: "POST",
          body: JSON.stringify({ culturalDoc: cfg.culturalDoc, customQuestions: cfg.customQuestions }),
        });
      }
      setDirectionSaved(prev => new Set(prev).add(type));
      setTimeout(() => setDirectionSaved(prev => { const n = new Set(prev); n.delete(type); return n; }), 2000);
    } catch {
      toast({ title: "Failed to save interview setup", variant: "destructive" });
    } finally {
      setSavingDirection(prev => { const n = new Set(prev); n.delete(type); return n; });
    }
  };

  const runSelectedAgents = async () => {
    if (selected.size === 0) return;
    setResults([]);
    setErrors([]);
    setRunning(new Set(selected));

    const selectedTypes = Array.from(selected);
    const promises = selectedTypes.map(async (type) => {
      const cfg = configs[type];
      const body: any = {
        jobId,
        candidateId: cfg.candidateId,
        interviewType: type,
        questionCount: cfg.questionCount,
        language: cfg.language,
        roleTitle,
      };
      /* Focus + custom questions apply to ALL interview types now. */
      if (cfg.focusDirective.trim()) body.focusDirective = cfg.focusDirective.trim();
      if (cfg.customQuestions.length) body.customQuestions = cfg.customQuestions;
      if (type === "cultural") {
        body.culturalDoc = cfg.culturalDoc;
      }
      if (type === "programming") {
        body.difficulty = cfg.difficulty;
      }
      try {
        const data = await apiFetch<any>("/interviews/generate-link", {
          method: "POST",
          body: JSON.stringify(body),
        });
        return {
          type,
          data,
          url: `${window.location.origin}${BASE}/interviews/${data.sessionId}/room`,
          copied: false,
        } as AgentResult;
      } catch (e: any) {
        throw { type, message: e.message || "Failed to generate" } as AgentError;
      } finally {
        setRunning(prev => { const n = new Set(prev); n.delete(type); return n; });
      }
    });

    const settled = await Promise.allSettled(promises);
    const newResults: AgentResult[] = [];
    const newErrors: AgentError[] = [];
    settled.forEach(r => {
      if (r.status === "fulfilled") newResults.push(r.value);
      else newErrors.push(r.reason as AgentError);
    });
    setResults(newResults);
    setErrors(newErrors);

    if (newErrors.length > 0) {
      toast({ title: `${newErrors.length} agent(s) failed`, variant: "destructive" });
    }
    if (newResults.length > 0) {
      toast({ title: `${newResults.length} interview link(s) generated` });
    }
  };

  const copyLink = (url: string, type: InterviewType) => {
    navigator.clipboard.writeText(url);
    setResults(prev => prev.map(r => r.type === type ? { ...r, copied: true } : r));
    setTimeout(() => {
      setResults(prev => prev.map(r => r.type === type ? { ...r, copied: false } : r));
    }, 2000);
  };

  const selectedTypes = Array.from(selected);
  const anyRunning = running.size > 0;

  return (
    <div className="space-y-5">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center">
            <Zap className="w-5 h-5 text-primary" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold">Interview Coordinator</h3>
              <Badge variant="outline" className="text-[9px] px-1.5 py-0.5 text-muted-foreground border-border/60">
                4 sub-agents
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">Select one or more interview agents to run in parallel</p>
          </div>
        </div>
        {selected.size > 0 && (
          <button
            onClick={() => { setSelected(new Set()); setExpanded(new Set()); setResults([]); setErrors([]); }}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
          >
            <X className="w-3 h-3" /> Clear all
          </button>
        )}
      </div>

      {/* ── 4 Sub-agent selection cards ──────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2.5">
        {TYPES.map(t => {
          const Icon = t.icon;
          const isSelected = selected.has(t.id);
          const isRunning = running.has(t.id);
          const result = results.find(r => r.type === t.id);
          const error = errors.find(e => e.type === t.id);

          return (
            <button
              key={t.id}
              onClick={() => toggleSelect(t.id)}
              className={cn(
                "relative flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-all duration-200 group",
                isSelected
                  ? `${t.bg} ${t.border} shadow-sm`
                  : "border-border/40 bg-card/40 hover:border-border/70 hover:bg-card/60",
              )}
            >
              {/* Selection indicator */}
              <div className={cn(
                "absolute top-2.5 right-2.5 transition-all",
                isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-40",
              )}>
                {isSelected
                  ? <CheckSquare className="w-3.5 h-3.5" style={{ color: t.color }} />
                  : <Square className="w-3.5 h-3.5 text-muted-foreground" />
                }
              </div>

              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                style={{ background: `${t.color}18`, border: `1px solid ${t.color}30` }}
              >
                {isRunning
                  ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: t.color }} />
                  : result
                  ? <Check className="w-4 h-4 text-emerald-400" />
                  : error
                  ? <X className="w-4 h-4 text-rose-400" />
                  : <Icon className="w-4 h-4" style={{ color: t.color }} />
                }
              </div>

              <div className="min-w-0 pr-4">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-bold">{t.label}</span>
                  <span className="text-[9px] font-semibold" style={{ color: t.color }}>
                    {t.badge}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">
                  {t.description}
                </p>
                {result && (
                  <p className="text-[10px] text-emerald-400 mt-1 font-medium">
                    ✓ Link generated
                  </p>
                )}
                {error && (
                  <p className="text-[10px] text-rose-400 mt-1 font-medium">
                    ✗ Failed
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Selected count + run button ────────────────────────────────── */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-primary/5 border border-primary/20">
          <div className="flex items-center gap-2 flex-1">
            <div className="flex gap-1">
              {selectedTypes.map(type => {
                const t = TYPES.find(x => x.id === type)!;
                return (
                  <div key={type} className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: `${t.color}20` }}>
                    <t.icon className="w-2.5 h-2.5" style={{ color: t.color }} />
                  </div>
                );
              })}
            </div>
            <span className="text-xs font-semibold">
              {pluralize(selected.size, "agent")} selected
              {selected.size > 1 && " — will run in parallel"}
            </span>
          </div>
          <Button
            size="sm"
            className="gap-1.5 font-bold h-8 px-4"
            onClick={runSelectedAgents}
            disabled={anyRunning}
          >
            {anyRunning
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Running…</>
              : <><Play className="w-3.5 h-3.5" />Run {selected.size > 1 ? "All" : ""} Agent{selected.size > 1 ? "s" : ""}</>
            }
          </Button>
        </div>
      )}

      {/* ── Per-agent config accordions ───────────────────────────────────── */}
      {selectedTypes.length > 0 && (
        <div className="space-y-2">
          {selectedTypes.map(type => {
            const t = TYPES.find(x => x.id === type)!;
            const cfg = configs[type];
            const isExpanded = expanded.has(type);
            const Icon = t.icon;

            return (
              <div key={type} className={cn("rounded-xl border overflow-hidden transition-all", t.border, t.bg)}>
                {/* Accordion header */}
                <button
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                  onClick={() => toggleExpand(type)}
                >
                  <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: `${t.color}20` }}>
                    <Icon className="w-3.5 h-3.5" style={{ color: t.color }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-bold">{t.agentName} Configuration</span>
                  </div>
                  <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform", isExpanded && "rotate-180")} />
                </button>

                {/* Accordion body */}
                {isExpanded && (
                  <div className="px-4 pb-4 space-y-3 border-t border-white/5">
                    <div className="grid grid-cols-2 gap-3 pt-3">
                      {/* Question count */}
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          {type === "programming" ? "Challenges" : "Questions"}
                        </label>
                        <Select
                          value={String(cfg.questionCount)}
                          onValueChange={v => patchConfig(type, { questionCount: Number(v) })}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {QUESTION_COUNTS.map(n => (
                              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {/* Language */}
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Language</label>
                        <Select
                          value={cfg.language}
                          onValueChange={v => patchConfig(type, { language: v })}
                        >
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

                    {/* Candidate */}
                    {candidates.length > 0 && (
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Candidate</label>
                        <Select
                          value={cfg.candidateId}
                          onValueChange={v => patchConfig(type, { candidateId: v })}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="demo">Demo / Anonymous</SelectItem>
                            {candidates.map(c => (
                              <SelectItem key={c.id} value={c.id}>{c.firstName} {c.lastName}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Programming: difficulty */}
                    {type === "programming" && (
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Difficulty</label>
                        <Select
                          value={cfg.difficulty}
                          onValueChange={v => patchConfig(type, { difficulty: v })}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DIFFICULTIES.map(d => (
                              <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}

                    {/* Cultural: culture document (cultural-only) */}
                    {type === "cultural" && (
                      <div className="space-y-1.5">
                        <Separator className="opacity-20" />
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 pt-1">
                          <FileText className="w-3 h-3" /> Culture Document
                        </label>
                        <Textarea
                          placeholder="Paste company values, mission, culture handbook…"
                          value={cfg.culturalDoc}
                          onChange={e => patchConfig("cultural", { culturalDoc: e.target.value })}
                          className="min-h-[90px] text-xs resize-none font-mono"
                        />
                      </div>
                    )}

                    {/* Interview direction — focus/theme + custom questions (ALL types) */}
                    <div className="space-y-3">
                      <Separator className="opacity-20" />

                      {/* Focus / theme direction */}
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                          <Target className="w-3 h-3" /> Focus / Theme Direction
                        </label>
                        <Textarea
                          placeholder="Optional — overall theme or what to probe for, e.g. “Emphasise hands-on experience with distributed systems and how they handle ambiguity.”"
                          value={cfg.focusDirective}
                          onChange={e => patchConfig(type, { focusDirective: e.target.value })}
                          className="min-h-[64px] text-xs resize-none"
                        />
                      </div>

                      {/* Custom questions repeater */}
                      <div className="space-y-1.5">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Custom Questions
                        </label>
                        {cfg.customQuestions.length > 0 && (
                          <div className="space-y-1">
                            {cfg.customQuestions.map((q, i) => (
                              <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-cyan-500/5 border border-cyan-500/20">
                                <span className="text-[9px] text-cyan-400 font-bold mt-0.5 flex-shrink-0">Q{i + 1}</span>
                                <span className="text-[11px] flex-1 leading-relaxed">{q}</span>
                                <button
                                  onClick={() => patchConfig(type, { customQuestions: cfg.customQuestions.filter((_, j) => j !== i) })}
                                  aria-label={`Remove question ${i + 1}`}
                                  className="text-muted-foreground/40 hover:text-rose-400 transition-colors flex-shrink-0"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <Input
                            placeholder="Add a custom question…"
                            value={newQuestion[type]}
                            onChange={e => setNewQuestion(prev => ({ ...prev, [type]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === "Enter" && newQuestion[type].trim()) {
                                e.preventDefault();
                                patchConfig(type, { customQuestions: [...cfg.customQuestions, newQuestion[type].trim()] });
                                setNewQuestion(prev => ({ ...prev, [type]: "" }));
                              }
                            }}
                            className="h-7 text-xs"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 flex-shrink-0"
                            onClick={() => {
                              if (newQuestion[type].trim()) {
                                patchConfig(type, { customQuestions: [...cfg.customQuestions, newQuestion[type].trim()] });
                                setNewQuestion(prev => ({ ...prev, [type]: "" }));
                              }
                            }}
                          >
                            <Plus className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>

                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => saveDirection(type)}
                        disabled={savingDirection.has(type)}
                        className="gap-1.5 h-7 w-full text-xs"
                      >
                        {savingDirection.has(type) ? <Loader2 className="w-3 h-3 animate-spin" /> : directionSaved.has(type) ? <Check className="w-3 h-3 text-emerald-400" /> : <Save className="w-3 h-3" />}
                        {directionSaved.has(type) ? "Saved!" : "Save Interview Setup"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Results ──────────────────────────────────────────────────────── */}
      {results.length > 0 && (
        <div className="space-y-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-border/40" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-2">
              {pluralize(results.length, "Interview Link")} Generated
            </span>
            <div className="flex-1 h-px bg-border/40" />
          </div>

          {results.map(result => {
            const t = TYPES.find(x => x.id === result.type)!;
            const Icon = t.icon;
            return (
              <div key={result.type} className={cn("rounded-xl border p-3.5 space-y-3", t.bg, t.border)}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${t.color}20` }}>
                      <Icon className="w-3.5 h-3.5" style={{ color: t.color }} />
                    </div>
                    <div>
                      <p className="text-xs font-bold">{result.data.planTitle}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {result.data.questionCount} {result.type === "programming" ? "challenges" : "questions"} · ~{result.data.estimatedMinutes} min · {result.data.langLabel}
                      </p>
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[9px] flex-shrink-0" style={{ color: t.color, borderColor: `${t.color}40` }}>
                    {t.label}
                  </Badge>
                </div>

                <div className="flex gap-2">
                  <code className="flex-1 text-[11px] bg-black/30 rounded-lg px-2.5 py-1.5 font-mono truncate text-primary/70">
                    {result.url}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => copyLink(result.url, result.type)}
                    className="flex-shrink-0 h-7 px-2.5 gap-1 text-xs"
                  >
                    {result.copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  </Button>
                  <a href={result.url} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" variant="outline" className="h-7 px-2">
                      <ExternalLink className="w-3 h-3" />
                    </Button>
                  </a>
                </div>

                {result.data.questions?.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Preview</p>
                    <div className="space-y-0.5 max-h-24 overflow-y-auto">
                      {result.data.questions.slice(0, 4).map((q: any, i: number) => (
                        <div key={q.id} className="flex items-start gap-1.5 text-[10px]">
                          <span className="text-muted-foreground/50 flex-shrink-0 tabular-nums">{i + 1}.</span>
                          <span className="text-muted-foreground line-clamp-1">{q.text ?? q.title}</span>
                        </div>
                      ))}
                      {result.data.questions.length > 4 && (
                        <p className="text-[9px] text-muted-foreground/50 pl-4">+{result.data.questions.length - 4} more</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Errors ───────────────────────────────────────────────────────── */}
      {errors.length > 0 && (
        <div className="space-y-2">
          {errors.map(err => {
            const t = TYPES.find(x => x.id === err.type)!;
            return (
              <div key={err.type} className="flex items-center gap-2.5 p-3 rounded-xl bg-rose-500/5 border border-rose-500/20 text-xs">
                <X className="w-4 h-4 text-rose-400 flex-shrink-0" />
                <span className="font-semibold text-rose-400">{t.label} Agent failed</span>
                <span className="text-muted-foreground">— {err.message}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {selected.size === 0 && results.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-5 text-center">
          <div className="w-10 h-10 rounded-xl bg-muted/30 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-muted-foreground/50" />
          </div>
          <p className="text-xs text-muted-foreground">Select interview agents above to configure and generate links</p>
          <p className="text-[10px] text-muted-foreground/60">You can run multiple agents simultaneously</p>
        </div>
      )}
    </div>
  );
}
