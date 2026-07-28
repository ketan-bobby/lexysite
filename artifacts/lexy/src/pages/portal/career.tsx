/**
 * career.tsx — Career Command Centre (the candidate's main career hub).
 *
 * This is the largest and most data-rich page in the candidate portal. It shows
 * everything the AI has learned about the candidate and what they should do next.
 *
 * ── Sections (rendered as a tabbed / scrollable dashboard) ──
 *  1. Career Score         — Composite profile + interview readiness score.
 *  2. Career Paths         — 3 AI-generated paths from current role to target.
 *  3. Next Best Actions    — Prioritised recommended actions (linked to portal pages).
 *  4. Skill Gap Analysis   — Skills ranked by career-impact score.
 *  5. Strengths Map        — Identified hard + soft strengths.
 *  6. Recruiter Visibility — How visible the candidate is in search / saves.
 *  7. Interview Analysis   — Transcript, communication analysis, AI feedback.
 *  8. Resume Upload        — Drag-and-drop resume parser that enriches the profile.
 *  9. Top Opportunities    — Matched open roles from the public job index.
 *
 * ── Key patterns ──
 *  - All data comes from `GET /portal/career-profile` which returns the full
 *    `candidate_career_profiles` row including resume_parsed_profile and
 *    analysis JSON blobs.
 *  - Interview transcript / analysis is read from the same profile endpoint
 *    (fields: transcript_english, analysis_english, interview_language).
 *  - `buildNextActions()` is a pure function that derives recommended actions
 *    from the profile data — it runs on every render so it stays current.
 *  - Resume uploads go through the storage/uploads/file endpoint then trigger
 *    a separate parse call; both steps use apiFetch for auth.
 *
 * ── Do NOT modify ──
 *  - src/components/intelligence/ — AI pipeline visualisations.
 *  - src/pages/recruiter/candidates/index.tsx — candidate list (separate product).
 */

import { useEffect, useState, useRef, useCallback } from "react";
import { pluralize } from "@/lib/utils";
import { scoreBand, bandBy } from "@/lib/score-band";
import { AppLayout } from "@/components/layout/AppLayout";
import { AiDisclosureBanner } from "@/components/portal/AiDisclosureBanner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Link, useLocation } from "wouter";
import {
  Sparkles, Target, TrendingUp, Building2, MapPin, Briefcase,
  GraduationCap, Star, ChevronRight, ArrowRight, BarChart2,
  Clock, Zap, Award, Lightbulb, RefreshCw, CheckCircle2,
  FileText, Upload, Loader2, Rocket, AlertCircle, Globe, Languages,
  ScrollText, Brain, Flame, Trophy, Eye, Users, TrendingDown,
  Plus, Lock, Unlock, ChevronUp, ChevronDown, Activity, ShieldCheck,
  Bolt, BookOpen, Mic, Video, BarChart, Calendar,
  MessageSquare, Bell, Info, ExternalLink, UserPlus,
} from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

/* ─── Types ─────────────────────────────────────────────────────────────── */
interface CareerPath {
  title: string;
  description: string;
  timeframe: string;
  targetRole: string;
  targetCompanyType: string;
  milestones: string[];
  keySkillsNeeded: string[];
  salaryRange: string;
  difficulty: "achievable" | "ambitious" | "stretch";
  fit: "high" | "medium" | "speculative";
}

interface CareerProfile {
  id: string;
  candidateId: string;
  currentTitle?: string;
  currentCompany?: string;
  yearsExperience?: number;
  bio?: string;
  skills?: string[];
  education?: string;
  careerGoal3yr?: string;
  careerGoal5yr?: string;
  targetCompanies?: string[];
  targetIndustries?: string[];
  preferredRoles?: string[];
  preferredWorkStyle?: string;
  motivations?: string[];
  careerPaths?: CareerPath[];
  aiSummary?: string;
  strengthAreas?: string[];
  growthAreas?: string[];
  baselineInterviewCompleted?: boolean;
  profileCompleteness?: number;
  interviewLanguage?: string;
  transcriptEnglish?: string;
  transcriptNative?: string;
  analysisEnglish?: string;
  analysisNative?: string;
  resumeUrl?: string;
  recordingUrl?: string;
  recordingDurationSec?: number;
}

interface Opportunity {
  id: string;
  title: string;
  company?: string;
  department?: string;
  location?: string;
  workType?: string;
  employmentType?: string;
  salaryMin?: number;
  salaryMax?: number;
  _score?: number;
  isExternal?: boolean;
  sourceUrl?: string;
  sourceDomain?: string;
  status?: string;
  isFuture?: boolean;
}

interface ReadinessBreakdownItem {
  factor: string;
  description: string;
  earned: number;
  max: number;
  tip?: string;
}

interface ProgressData {
  readinessScore: number;
  readinessBreakdown?: ReadinessBreakdownItem[];
  readinessDelta: number | null;
  profileDelta: number | null;
  streak: { current: number; longest: number; totalSessions: number; lastActivityAt: string | null };
  weeklyStats: { practiceSessionsThisWeek: number; opportunitiesUnlocked: number; recruiterViewsThisWeek: number; profileImproved: boolean };
}

interface BenchmarkData {
  available: boolean;
  count: number;
  threshold?: number;
  showPercentiles?: boolean;
  averages?: {
    readiness: number;
    profileCompleteness: number;
    p25: number | null;
    p75: number | null;
  };
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
const difficultyConfig = {
  achievable: { label: "Most Realistic", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" },
  ambitious:  { label: "High Growth",    color: "text-cyan-400 bg-cyan-400/10 border-cyan-400/20" },
  stretch:    { label: "Stretch Path",   color: "text-violet-400 bg-violet-400/10 border-violet-400/20" },
};
const fitConfig = {
  high:        { label: "High Fit",  color: "text-emerald-400" },
  medium:      { label: "Good Fit",  color: "text-cyan-400" },
  speculative: { label: "Bold Move", color: "text-violet-400" },
};

function pathReadiness(profile: CareerProfile, path: CareerPath): number {
  let score = 0;
  if (profile.baselineInterviewCompleted) score += 30;
  if ((profile.skills?.length ?? 0) > 3) score += 20;
  const missing = path.keySkillsNeeded?.length ?? 0;
  score += Math.max(0, 30 - missing * 6);
  if (path.difficulty === "achievable") score += 20;
  else if (path.difficulty === "ambitious") score += 10;
  return Math.min(95, score);
}

function computeProfileConfidence(profile: CareerProfile, completeness: number): { level: "High" | "Medium" | "Low"; score: number; missing: string[] } {
  const missing: string[] = [];
  let score = 0;
  // Profile-completeness gates feeding the confidence score (a self-assessment
  // readiness quantity, distinct from match fit).
  const COMPLETENESS_FULL = 70;
  const COMPLETENESS_PARTIAL = 40;
  if (profile.baselineInterviewCompleted) score += 35; else missing.push("Complete baseline interview");
  if (completeness >= COMPLETENESS_FULL) score += 25; else if (completeness >= COMPLETENESS_PARTIAL) score += 12; else missing.push("Improve profile completeness");
  if ((profile.skills?.length ?? 0) >= 5) score += 15; else missing.push("Add more skills");
  if (profile.careerGoal3yr) score += 10; else missing.push("Set 3-year goal");
  if ((profile.careerPaths?.length ?? 0) > 0) score += 15; else missing.push("Generate career paths");
  // Confidence level band — its own thresholds; any match-cutoff equality is coincidental.
  const CONFIDENCE_HIGH = 70;
  const CONFIDENCE_MEDIUM = 40;
  const level = score >= CONFIDENCE_HIGH ? "High" : score >= CONFIDENCE_MEDIUM ? "Medium" : "Low";
  return { level, score, missing };
}

function computeNextBestActions(profile: CareerProfile, completeness: number, opportunities: Opportunity[]): Array<{
  id: string; title: string; description: string; outcome: string; time: string; impact: "high" | "medium" | "low";
  currentVal?: number; projectedVal?: number; rolesUnlocked?: number; icon: any; href?: string;
}> {
  const actions = [];
  if (!profile.baselineInterviewCompleted) {
    actions.push({
      id: "baseline",
      title: "Complete your baseline career interview",
      description: "A 10-minute AI conversation that maps your background, goals, and strengths.",
      outcome: "Unlock personalised career paths and increase your readiness score",
      time: "10 min",
      impact: "high" as const,
      currentVal: 0,
      projectedVal: 65,
      icon: Mic,
      href: "/portal/career/interview",
    });
  }
  if (completeness < 70) {
    actions.push({
      id: "profile",
      title: "Strengthen your profile",
      description: "Add your current role, education, and key skills to unlock recruiter visibility.",
      outcome: `Increase profile strength from ${completeness}% to 85%+, appear in more recruiter searches`,
      time: "5 min",
      impact: "high" as const,
      currentVal: completeness,
      projectedVal: Math.min(100, completeness + 20),
      icon: ShieldCheck,
      href: "/portal/career",
    });
  }
  if ((profile.growthAreas?.length ?? 0) > 0) {
    const gap = profile.growthAreas![0];
    actions.push({
      id: "skill-gap",
      title: `Close your top skill gap: ${gap}`,
      description: "Practice with AI-powered exercises targeting this specific gap.",
      outcome: "Improve your role fit and readiness score for your target career paths",
      time: "15 min",
      impact: "medium" as const,
      icon: BookOpen,
      href: "/portal/prep",
    });
  }
  if (profile.baselineInterviewCompleted) {
    actions.push({
      id: "mock",
      title: "Run a mock interview",
      description: "Simulate a real recruiter screen to sharpen your communication.",
      outcome: "Increase interview readiness score by ~8%, build confidence",
      time: "20 min",
      impact: "medium" as const,
      icon: Video,
      href: "/portal/prep?mode=mock",
    });
  }
  return actions;
}

/* ─── Circular Score Ring ────────────────────────────────────────────────── */
function ScoreRing({ value, size = 64, color = "hsl(var(--primary))", label, sublabel, delta }: {
  value: number; size?: number; color?: string; label: string; sublabel?: string; delta?: number | null;
}) {
  const r = (size / 2) - 6;
  const circ = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center text-center gap-1.5">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="currentColor" strokeWidth="5" className="text-border" />
          <circle cx={size/2} cy={size/2} r={r} fill="none" strokeWidth="5"
            stroke={color}
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - value / 100)}
            strokeLinecap="round"
            className="transition-all duration-700"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-bold" style={{ color }}>{value}%</span>
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold">{label}</p>
        {sublabel && <p className="text-[10px] text-muted-foreground">{sublabel}</p>}
        {delta !== null && delta !== undefined && (
          /* Negative deltas are amber (never red) and carry a normalising note —
             a dip on a vulnerable user's own progress ring must not read as failure. */
          <p className={`text-[10px] font-medium mt-0.5 ${delta >= 0 ? "text-emerald-400" : "text-amber-400"}`}>
            {delta >= 0
              ? `+${delta}% since last session`
              : `${delta}% since last session — dips are normal while practising`}
          </p>
        )}
      </div>
    </div>
  );
}

/* ─── Delta Chip ─────────────────────────────────────────────────────────── */
function DeltaChip({ value, suffix = "%" }: { value: number | null; suffix?: string }) {
  if (value === null || value === 0) return null;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
      value > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-amber-500/15 text-amber-400"
    }`}>
      {value > 0 ? <ChevronUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
      {value > 0 ? "+" : ""}{value}{suffix}
    </span>
  );
}

/* ─── Urgency Chip ───────────────────────────────────────────────────────── */
const urgencySignals = [
  { label: "High Demand", color: "text-orange-400 bg-orange-400/10 border-orange-400/20" },
  { label: "Top Match", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20" },
  { label: "Shortlist Likely", color: "text-cyan-400 bg-cyan-400/10 border-cyan-400/20" },
  { label: "Trending Role", color: "text-violet-400 bg-violet-400/10 border-violet-400/20" },
];
function getUrgencySignal(opp: Opportunity, index: number) {
  // _score is 0-100 normalised; the canonical STRONG band is a genuinely strong match
  if (scoreBand(opp._score ?? 0) === "strong") return urgencySignals[1]; // "Top Match"
  return urgencySignals[index % urgencySignals.length];
}

// Readiness-ring sublabel band — an interview-preparedness quantity, not match fit.
const READINESS_READY = 80;
const READINESS_BUILDING = 50;
function readinessSublabel(v: number): string {
  return v >= READINESS_READY ? "Interview ready" : v >= READINESS_BUILDING ? "Building up" : "Getting started";
}

/* ─── Weekly Summary ─────────────────────────────────────────────────────── */
function WeeklySummary({ progress, readiness, completeness }: { progress: ProgressData | null; readiness: number; completeness: number }) {
  const stats = progress?.weeklyStats;
  const streak = progress?.streak;

  const items = [
    { label: "Readiness", value: `${readiness}%`, delta: progress?.readinessDelta, icon: Target, color: "text-primary" },
    { label: "Practice Sessions", value: String(stats?.practiceSessionsThisWeek ?? 0), delta: null, icon: Brain, color: "text-violet-400" },
    { label: "Roles Unlocked", value: String(stats?.opportunitiesUnlocked ?? 0), delta: null, icon: Unlock, color: "text-emerald-400" },
    { label: "Day Streak", value: String(streak?.current ?? 0), delta: null, icon: Flame, color: "text-orange-400" },
    { label: "Profile Strength", value: `${completeness}%`, delta: progress?.profileDelta, icon: ShieldCheck, color: "text-cyan-400" },
  ];

  return (
    <Card className="border-primary/20 bg-gradient-to-r from-primary/5 via-background to-background mb-6">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">Your Week at a Glance</span>
          <Badge variant="outline" className="text-[10px] border-primary/30 text-primary ml-auto">Weekly Summary</Badge>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {items.map(({ label, value, delta, icon: Icon, color }) => (
            <div key={label} className="text-center">
              <div className={`flex items-center justify-center gap-1 text-base font-bold ${color}`}>
                {value}
                {delta !== null && delta !== undefined && delta !== 0 && (
                  <DeltaChip value={delta} />
                )}
              </div>
              <div className="flex items-center justify-center gap-1 mt-0.5">
                <Icon className={`w-3 h-3 ${color}`} />
                <p className="text-[10px] text-muted-foreground">{label}</p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Next Best Action Brain ─────────────────────────────────────────────── */
function NextBestActionPanel({ actions }: { actions: ReturnType<typeof computeNextBestActions> }) {
  const [, navigate] = useLocation();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const visible = actions.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;
  const [primary, ...secondary] = visible;
  const Icon = primary.icon;
  const impactColors: Record<string, string> = {
    // No red on a candidate's own action list — high impact is an opportunity,
    // not an alarm.
    high: "bg-violet-500/10 text-violet-400 border-violet-400/20",
    medium: "bg-amber-500/10 text-amber-400 border-amber-400/20",
    low: "bg-blue-500/10 text-blue-400 border-blue-400/20",
  };

  return (
    <div className="space-y-3 mb-6">
      <div className="flex items-center gap-2">
        <Bolt className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold">Your Next Best Action</h2>
      </div>

      {/* Dominant action */}
      <Card className="border-primary/30 bg-gradient-to-br from-primary/8 to-background relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-bl-full -z-0" />
        <CardContent className="p-5 relative z-10">
          <div className="flex flex-col sm:flex-row sm:items-start gap-4">
            <div className="flex items-start gap-3 flex-1">
              <div className="p-2.5 bg-primary/15 rounded-xl text-primary shrink-0 mt-0.5">
                <Icon className="w-5 h-5" />
              </div>
              <div className="space-y-1 flex-1">
                <div className="mb-1">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    Most Important Right Now
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-sm">{primary.title}</p>
                  <Badge variant="outline" className={`text-[10px] ${impactColors[primary.impact]}`}>
                    {primary.impact.charAt(0).toUpperCase() + primary.impact.slice(1)} Impact
                  </Badge>
                  <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />{primary.time}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{primary.description}</p>
                {/* Before/After impact */}
                {primary.currentVal !== undefined && primary.projectedVal !== undefined && (
                  <div className="flex items-center gap-2 mt-2 p-2 bg-background/60 rounded-lg border border-border/40 text-xs">
                    <span className="text-muted-foreground">Readiness</span>
                    <span className="font-semibold">{primary.currentVal}%</span>
                    <ArrowRight className="w-3 h-3 text-primary" />
                    <span className="font-semibold text-primary">{primary.projectedVal}%</span>
                    {primary.rolesUnlocked && (
                      <>
                        <span className="text-muted-foreground ml-2">·</span>
                        <Unlock className="w-3 h-3 text-emerald-400" />
                        <span className="text-emerald-400 font-medium">Unlock {pluralize(primary.rolesUnlocked, "role")}</span>
                      </>
                    )}
                  </div>
                )}
                <p className="text-xs text-primary font-medium mt-1.5">→ {primary.outcome}</p>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              {primary.href ? (
                <Button size="sm" className="gap-1.5 text-xs whitespace-nowrap" onClick={() => navigate(primary.href!)}>
                  Start Now <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              ) : (
                <Button size="sm" className="gap-1.5 text-xs whitespace-nowrap">
                  Take Action <ArrowRight className="w-3.5 h-3.5" />
                </Button>
              )}
              <Button size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={() => setDismissed(d => new Set([...d, primary.id]))}>
                Skip
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Secondary actions */}
      {secondary.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {secondary.map(action => {
            const AIcon = action.icon;
            return (
              <div
                key={action.id}
                className="flex items-start gap-3 p-3 bg-card border border-border/40 rounded-xl hover:border-primary/25 transition-all cursor-pointer group"
                onClick={() => action.href && navigate(action.href)}
              >
                <div className="p-1.5 bg-muted rounded-lg text-muted-foreground group-hover:text-primary group-hover:bg-primary/10 transition-all shrink-0">
                  <AIcon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{action.title}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{action.time} · {action.impact} impact</p>
                </div>
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-all" />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Career Path Card ───────────────────────────────────────────────────── */
function PathCard({ path, index, profile, canUnlock }: { path: CareerPath; index: number; profile: CareerProfile; canUnlock?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [roadmapLockMsg, setRoadmapLockMsg] = useState(false);
  const diff = difficultyConfig[path.difficulty] ?? difficultyConfig.achievable;
  const fit  = fitConfig[path.fit] ?? fitConfig.medium;
  const icons = [Target, TrendingUp, Zap];
  const Icon  = icons[index] ?? Target;
  const readiness = pathReadiness(profile, path);
  const missing   = path.keySkillsNeeded?.length ?? 0;
  // Career-path readiness band — a preparedness quantity, not match fit.
  const PATH_READINESS_STRONG = 70;
  const PATH_READINESS_MODERATE = 40;
  const readinessColor = readiness >= PATH_READINESS_STRONG ? "text-emerald-400" : readiness >= PATH_READINESS_MODERATE ? "text-amber-400" : "text-sky-400"; // low = early, not alarming

  return (
    <Card className="border-border/50 hover:border-primary/30 transition-all duration-200 hover-elevate">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg text-primary">
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <CardTitle className="text-base">{path.title}</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">{path.timeframe} · {path.targetRole}</p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <Badge variant="outline" className={`text-xs ${diff.color}`}>{diff.label}</Badge>
            <span className={`text-xs font-medium ${fit.color}`}>{fit.label}</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{path.description}</p>

        {/* Readiness for this path */}
        <div className="p-3 bg-muted/30 rounded-xl border border-border/30 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground font-medium">You are {readiness}% ready for this path</span>
            <span className={`font-bold ${readinessColor}`}>{readiness}%</span>
          </div>
          <Progress value={readiness} className="h-1.5" />
          {missing > 0 && (
            <p className="text-[10px] text-muted-foreground">{pluralize(missing, "skill")} to develop · est. {path.timeframe}</p>
          )}
          {path.keySkillsNeeded?.[0] && readiness < 90 && (
            <p className="text-[10px] text-amber-400 flex items-center gap-1">
              <TrendingUp className="w-3 h-3 shrink-0" />
              Improve <strong>{path.keySkillsNeeded[0]}</strong> to increase readiness
            </p>
          )}
        </div>

        {path.salaryRange && (
          <div className="flex items-center gap-2 text-sm">
            <BarChart2 className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-emerald-400 font-medium">{path.salaryRange}</span>
            <span className="text-muted-foreground">target compensation</span>
          </div>
        )}

        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
        >
          {expanded ? "Hide" : "Show"} milestones & skills
          <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        {expanded && (
          <div className="mt-1 space-y-3 border-t border-border/30 pt-3">
            {path.milestones?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Key Milestones</p>
                <div className="space-y-1.5">
                  {path.milestones.map((m, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="w-5 h-5 rounded-full bg-primary/10 text-primary text-[10px] flex items-center justify-center font-bold shrink-0 mt-0.5">{i + 1}</div>
                      <span className="text-sm text-muted-foreground">{m}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {path.keySkillsNeeded?.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide mb-2">Skills to Develop</p>
                <div className="flex flex-wrap gap-1.5">
                  {path.keySkillsNeeded.map((s, i) => (
                    <Badge key={i} variant="outline" className="text-xs border-amber-400/30 text-amber-400 gap-1">
                      <Plus className="w-2.5 h-2.5" />{s}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {path.targetCompanyType && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Building2 className="w-3.5 h-3.5" />
                <span>Best suited for: <span className="text-foreground">{path.targetCompanyType}</span></span>
              </div>
            )}
          </div>
        )}

        {/* 5C — Locked detailed roadmap (first path only) */}
        {index === 0 && (
          <div className="pt-2 border-t border-border/30">
            {canUnlock ? (
              <button
                onClick={() => setExpanded(true)}
                className="w-full flex items-center justify-center gap-2 text-xs text-emerald-400 hover:text-emerald-300 font-medium py-1.5 transition-colors"
              >
                <Unlock className="w-3.5 h-3.5" />Unlock detailed roadmap
              </button>
            ) : (
              <div>
                <button
                  onClick={() => setRoadmapLockMsg(v => !v)}
                  className="w-full flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground font-medium py-1.5 transition-colors"
                >
                  <Lock className="w-3.5 h-3.5" />Unlock detailed roadmap
                </button>
                {roadmapLockMsg && (
                  <div className="mt-2 flex items-center gap-2 p-2.5 bg-muted/40 rounded-xl border border-border/30 text-xs text-muted-foreground">
                    <Lock className="w-3 h-3 shrink-0 text-amber-400" />
                    Upload your resume or complete 1 prep session to unlock the full step-by-step roadmap.
                    <Link href="/portal/prep">
                      <span className="text-primary underline ml-1 whitespace-nowrap">Start prep</span>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Skill → prep-mode mapper ───────────────────────────────────────────── */
function skillToPrepMode(skill: string): string {
  const s = skill.toLowerCase();
  if (/leader|manag|strateg|director|vp |chief|president|c-suite|workforce|planning|execut/.test(s)) return "leadership";
  if (/ai\b|machine learn|llm|nlp|data scien|generative|artificial intel/.test(s)) return "ai_strategy";
  if (/software|engineer|coding|backend|frontend|fullstack|developer|programm|typescript|react|python|java\b/.test(s)) return "technical";
  if (/hr\b|people|talent|recruit|human resource/.test(s)) return "behavioral";
  if (/entrepreneur|startup|founder|venture/.test(s)) return "behavioral";
  if (/marketing|growth|brand|content|campaign/.test(s)) return "behavioral";
  return "mock"; // default: full mock interview
}

/* ─── Skill Gap Action Card ──────────────────────────────────────────────── */
function SkillGapCard({ gap }: { gap: string }) {
  const mode = skillToPrepMode(gap);
  const modeLabel: Record<string, string> = {
    leadership: "Leadership Q&A",
    ai_strategy: "AI & Innovation Q&A",
    technical: "Technical Q&A",
    behavioral: "Behavioural Q&A",
    mock: "Mock Interview",
  };
  return (
    <div className="p-3 bg-card border border-amber-400/20 rounded-xl hover:border-amber-400/40 transition-all group">
      <div className="flex items-start gap-3">
        <div className="p-1.5 bg-amber-400/10 rounded-lg shrink-0">
          <Target className="w-3.5 h-3.5 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-xs font-semibold">{gap}</p>
          <p className="text-[10px] text-amber-400/80 font-medium flex items-center gap-1">
            <Star className="w-2.5 h-2.5 shrink-0" />This is a high-impact skill for your target path
          </p>
          <p className="text-[11px] text-muted-foreground">
            Practise {modeLabel[mode] ?? "interview questions"} to build confidence in this area.
          </p>
          <Link href={`/portal/prep?mode=${mode}`}>
            <Button size="sm" variant="outline" className="w-full text-[10px] h-7 gap-1 border-amber-400/30 text-amber-400 hover:bg-amber-400/10">
              <Zap className="w-2.5 h-2.5" /> Practice this skill
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ─── Practice Engine Card ───────────────────────────────────────────────── */
function PracticeEngine({ profile, progress }: { profile: CareerProfile; progress: ProgressData | null }) {
  const streak = progress?.streak;
  const sessions = streak?.totalSessions ?? 0;
  const currentStreak = streak?.current ?? 0;

  // Practice-session COUNT tiers (a session tally, not the 0–100 match/fit band).
  const SESSIONS_ADVANCED = 10, SESSIONS_INTERMEDIATE = 4;
  const level = sessions >= SESSIONS_ADVANCED ? "Advanced" : sessions >= SESSIONS_INTERMEDIATE ? "Intermediate" : "Beginner";
  const levelColor = sessions >= SESSIONS_ADVANCED ? "text-violet-400" : sessions >= SESSIONS_INTERMEDIATE ? "text-cyan-400" : "text-muted-foreground";

  const badges = [];
  if (currentStreak >= 3) badges.push({ label: "3-Day Streak", icon: Flame, color: "text-orange-400" });
  if (sessions >= 1) badges.push({ label: "First Session", icon: Trophy, color: "text-yellow-400" });
  if (sessions >= 5) badges.push({ label: "Consistent", icon: Award, color: "text-cyan-400" });
  if (profile.baselineInterviewCompleted) badges.push({ label: "Interviewed", icon: CheckCircle2, color: "text-emerald-400" });

  const practiceTypes = [
    { label: "Mock Interview", desc: "Simulated recruiter screen", time: "20 min", icon: Mic, href: "/portal/prep" },
    { label: "Communication", desc: "STAR storytelling practice", time: "10 min", icon: MessageSquare, href: "/portal/prep" },
    { label: "Technical Depth", desc: "Role-specific Q&A drill", time: "15 min", icon: Brain, href: "/portal/prep" },
  ];

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-400" />
            Practice Engine
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={`text-[10px] ${levelColor} border-current/20`}>{level}</Badge>
            {currentStreak > 0 && (
              <span className="text-[10px] font-bold text-orange-400 flex items-center gap-0.5">
                <Flame className="w-3 h-3" />{currentStreak}d
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Streak progress */}
        <div className="flex items-center gap-3 p-2.5 bg-orange-400/5 border border-orange-400/15 rounded-xl">
          <Flame className="w-4 h-4 text-orange-400 shrink-0" />
          <div className="flex-1">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium">{currentStreak} day streak</span>
              <span className="text-[10px] text-muted-foreground">{sessions} total sessions</span>
            </div>
            <Progress value={Math.min(100, (sessions / 10) * 100)} className="h-1" />
          </div>
        </div>

        {/* Badges */}
        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {badges.map(({ label, icon: Icon, color }) => (
              <div key={label} className="flex items-center gap-1 px-2 py-1 bg-muted/40 rounded-full border border-border/30">
                <Icon className={`w-3 h-3 ${color}`} />
                <span className="text-[10px] font-medium">{label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Practice types */}
        <div className="space-y-2">
          {practiceTypes.map(({ label, desc, time, icon: Icon, href }) => (
            <Link key={label} href={href}>
              <div className="flex items-center gap-3 p-2.5 bg-muted/20 hover:bg-muted/40 border border-border/30 hover:border-primary/25 rounded-xl transition-all cursor-pointer group">
                <div className="p-1.5 bg-muted rounded-lg text-muted-foreground group-hover:text-primary transition-colors">
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">{label}</p>
                  <p className="text-[10px] text-muted-foreground">{desc}</p>
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0">{time}</span>
                <ChevronRight className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-all" />
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── Recruiter Visibility Card ──────────────────────────────────────────── */
function RecruiterVisibility({ completeness, profile }: { completeness: number; profile: CareerProfile }) {
  const visibilityScore = Math.min(100, Math.round(
    completeness * 0.5 +
    (profile.baselineInterviewCompleted ? 25 : 0) +
    ((profile.skills?.length ?? 0) >= 5 ? 15 : 5) +
    ((profile.careerPaths?.length ?? 0) > 0 ? 10 : 0)
  ));
  // Profile discoverability band — a visibility quantity, not match fit.
  const VISIBILITY_STRONG = 70;
  const VISIBILITY_MODERATE = 40;
  const visColor  = visibilityScore >= VISIBILITY_STRONG ? "text-emerald-400" : visibilityScore >= VISIBILITY_MODERATE ? "text-amber-400" : "text-sky-400"; // low = room to grow, not alarming

  const visLabel = visibilityScore >= VISIBILITY_STRONG ? "Strong discoverability" : visibilityScore >= VISIBILITY_MODERATE ? "Moderate discoverability" : "Low discoverability";

  const boosters = [];
  if (!profile.baselineInterviewCompleted) boosters.push("Complete interview (+25 visibility)");
  if (completeness < 70) boosters.push("Improve profile to 70%+ (+15 visibility)");
  if ((profile.skills?.length ?? 0) < 5) boosters.push("Add 5+ skills (+10 visibility)");

  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Eye className="w-4 h-4 text-cyan-400" />
            Recruiter Visibility
          </CardTitle>
          <span className={`text-sm font-bold ${visColor}`}>{visibilityScore}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={visibilityScore} className="h-1.5" />
        <p className={`text-[11px] font-medium ${visColor}`}>{visLabel}</p>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Your visibility score is based on profile completeness, skills added, career paths set, and interview completion. A higher score means your profile is more likely to appear in recruiter searches.
        </p>

        {boosters.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-semibold">Boost your visibility</p>
            {boosters.map(b => (
              <div key={b} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <Plus className="w-3 h-3 text-primary shrink-0" />{b}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Profile Confidence ─────────────────────────────────────────────────── */
function ProfileConfidenceCard({ profile, completeness }: { profile: CareerProfile; completeness: number }) {
  const conf = computeProfileConfidence(profile, completeness);
  const levelColors: Record<string, string> = {
    High:   "text-emerald-400 border-emerald-400/20 bg-emerald-400/10",
    Medium: "text-amber-400 border-amber-400/20 bg-amber-400/10",
    Low:    "text-amber-300 border-amber-400/20 bg-amber-400/10", // never red on a candidate's own confidence band
  };
  return (
    <Card className="border-border/50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-primary" />
            Profile Confidence
          </CardTitle>
          <Badge variant="outline" className={`text-xs ${levelColors[conf.level]}`}>{conf.level}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Progress value={conf.score} className="h-1.5" />
        <p className="text-[10px] text-muted-foreground">
          {conf.level === "High"
            ? "Your profile appears highly trustworthy to recruiters."
            : conf.level === "Medium"
            ? "Improve a few areas to increase recruiter confidence."
            : "Complete key actions below to build recruiter trust."}
        </p>
        {conf.missing.length > 0 && (
          <div className="space-y-1.5">
            {conf.missing.slice(0, 3).map(m => (
              <div key={m} className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <AlertCircle className="w-3 h-3 text-amber-400 shrink-0" />{m}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Readiness Breakdown Panel ──────────────────────────────────────────── */
function ReadinessBreakdownPanel({
  breakdown, score, onRecomputed,
}: {
  breakdown: ReadinessBreakdownItem[];
  score: number;
  onRecomputed?: (updatedData: any) => void;
}) {
  const [open, setOpen] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputeMsg, setRecomputeMsg] = useState<string | null>(null);
  const totalMax = breakdown.reduce((s, b) => s + b.max, 0);
  const missing = breakdown.filter(b => b.earned < b.max);

  async function handleRecompute() {
    setRecomputing(true);
    setRecomputeMsg(null);
    try {
      const res = await apiFetch(`${apiBase}/portal/career-profile/recompute`, { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        setRecomputeMsg(json.missingFields?.length === 0
          ? "Profile refreshed — all fields are now populated."
          : `Profile refreshed. ${json.missingFields?.length ?? 0} field(s) still need the career interview.`
        );
        onRecomputed?.(json.data);
        // Reload progress to get new breakdown
        apiFetch(`${apiBase}/portal/career-progress`).then(r => r.json())
          .then(updated => { onRecomputed?.(updated); })
          .catch(() => {});
      } else {
        setRecomputeMsg(json.error ?? "Could not refresh profile.");
      }
    } catch {
      setRecomputeMsg("Could not refresh profile.");
    } finally {
      setRecomputing(false);
    }
  }

  return (
    <Card className="border-border/50">
      <button
        className="w-full text-left"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Info className="w-4 h-4 text-primary" />
              Readiness Score Breakdown
            </CardTitle>
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-primary">{score}/{totalMax}</span>
              {open
                ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
                : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
            </div>
          </div>
          {!open && missing.length > 0 && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Tap to see what's contributing and how to improve your score.
            </p>
          )}
        </CardHeader>
      </button>

      {open && (
        <CardContent className="space-y-3 pt-0">
          {/* Factor rows */}
          <div className="space-y-2.5">
            {breakdown.map(item => {
              const pct = Math.round((item.earned / item.max) * 100);
              const full = item.earned >= item.max;
              return (
                <div key={item.factor} className="space-y-1">
                  <div className="flex items-center justify-between text-[11px]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {full
                        ? <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                        : <AlertCircle className="w-3 h-3 text-amber-400/80 shrink-0" />}
                      <span className="font-medium truncate">{item.factor}</span>
                    </div>
                    <span className={`font-semibold shrink-0 ml-2 ${full ? "text-emerald-400" : "text-muted-foreground"}`}>
                      {item.earned}/{item.max}
                    </span>
                  </div>
                  <Progress value={pct} className="h-1" />
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    {item.description}
                    {item.tip && !full && (
                      <> — {item.tip.toLowerCase().includes("redo") || item.tip.toLowerCase().includes("career interview") ? (
                        <Link href="/portal/career/interview" className="text-primary/80 underline underline-offset-2 hover:text-primary transition-colors">
                          {item.tip}
                        </Link>
                      ) : (
                        <span className="text-primary/80">{item.tip}</span>
                      )}</>
                    )}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Why scores vary note */}
          <div className="rounded-lg bg-muted/40 border border-border/40 px-3 py-2.5 text-[10px] text-muted-foreground leading-relaxed">
            <span className="font-semibold text-foreground/70">Why does my score change?</span>{" "}
            Your readiness score is based on what the AI extracted from your interview — number of skills, strength areas,
            career goals, and more. Each time you complete a new interview session, the AI re-analyses your answers
            and may extract slightly different data, which can shift the score up or down. To maximise your score,
            give detailed answers covering skills, goals, motivations, and target roles.
          </div>

          {/* Recompute button — refreshes resume fallbacks without a new interview */}
          {missing.length > 0 && (
            <div className="pt-1 space-y-1.5">
              <button
                onClick={handleRecompute}
                disabled={recomputing}
                className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${recomputing ? "animate-spin" : ""}`} />
                {recomputing ? "Refreshing profile data…" : "Refresh profile data from resume"}
              </button>
              {recomputeMsg && (
                <p className="text-[10px] text-emerald-400/90 leading-relaxed">{recomputeMsg}</p>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/* ─── Future Role Target Card ────────────────────────────────────────────── */
function FutureRoleCard({ path, index, profile, completeness }: {
  path: CareerPath;
  index: number;
  profile: CareerProfile;
  completeness: number;
}) {
  const readiness = pathReadiness(profile, path);
  const icons     = [Target, TrendingUp, Zap];
  const Icon      = icons[index % 3];
  const diff      = difficultyConfig[path.difficulty] ?? difficultyConfig.achievable;

  // Career-path readiness band (a path-progress %; own cutoffs, not the match/fit band).
  const READINESS_STRONG = 70, READINESS_MODERATE = 45;
  const readinessColor =
    readiness >= READINESS_STRONG ? "text-violet-400" :
    readiness >= READINESS_MODERATE ? "text-cyan-400" :
    "text-amber-400";

  const progressColor =
    readiness >= READINESS_STRONG ? "bg-violet-500" :
    readiness >= READINESS_MODERATE ? "bg-cyan-500" :
    "bg-amber-500";

  const timeLabel = path.timeframe ?? "3 years";

  // Readiness → motivational-message tiers (advisory-copy cutoffs; distinct from the colour band above).
  const MSG_ON_TRACK = 80, MSG_REACHABLE = 60, MSG_STRETCH = 40;
  const motivationalMessage = (() => {
    if (readiness >= MSG_ON_TRACK) return `You're well on track — keep building momentum and you'll be ready within ${timeLabel}.`;
    if (readiness >= MSG_REACHABLE) return `At your current rate, you could qualify for this role in ${timeLabel}. Focus on your skill gaps to accelerate.`;
    if (readiness >= MSG_STRETCH) return `Build your top missing skills and this role becomes reachable within ${timeLabel}.`;
    return `This is your stretch target — start with the core skills below and you'll be on the path in no time.`;
  })();

  // Check if the candidate's stated goal directly references this path
  const goalText = index === 0 ? profile.careerGoal3yr : profile.careerGoal5yr;
  const goalSnippet = goalText
    ? String(goalText).split(" ").slice(0, 12).join(" ") + (String(goalText).split(" ").length > 12 ? "…" : "")
    : null;

  const topSkills = path.keySkillsNeeded?.slice(0, 3) ?? [];

  return (
    <Card className="border-violet-500/15 bg-gradient-to-br from-violet-500/5 via-transparent to-transparent hover:border-violet-500/30 transition-all">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-violet-500/15 flex items-center justify-center shrink-0 mt-0.5">
            <Icon className="w-4 h-4 text-violet-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-sm text-foreground">{path.targetRole}</p>
              <Badge variant="outline" className="text-[10px] border-violet-500/30 text-violet-400 gap-1">
                <Clock className="w-2.5 h-2.5" />
                In {timeLabel}
              </Badge>
              <Badge variant="outline" className={`text-[10px] ${diff.color}`}>{diff.label}</Badge>
            </div>
            {goalSnippet && (
              <p className="text-[10px] text-muted-foreground mt-0.5 italic">
                Your goal: "{goalSnippet}"
              </p>
            )}
            {path.targetCompanyType && (
              <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground">
                <Building2 className="w-3 h-3" />
                {path.targetCompanyType}
                {path.salaryRange && <><span>·</span><span className="text-violet-400 font-medium">{path.salaryRange}</span></>}
              </div>
            )}
          </div>
        </div>

        {/* Readiness progress */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-muted-foreground font-medium">Readiness toward this role</span>
            <span className={`font-bold tabular-nums ${readinessColor}`}>{readiness}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ${progressColor}`}
              style={{ width: `${readiness}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground leading-snug">{motivationalMessage}</p>
        </div>

        {/* Skills to build */}
        {topSkills.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-0.5">
            <span className="text-[10px] text-muted-foreground self-center mr-0.5">Build:</span>
            {topSkills.map((skill, i) => (
              <Badge key={i} variant="outline" className="text-[9px] px-1.5 py-0 border-violet-500/25 text-violet-400 gap-0.5">
                <Plus className="w-2 h-2" />
                {skill}
              </Badge>
            ))}
            {(path.keySkillsNeeded?.length ?? 0) > 3 && (
              <span className="text-[9px] text-muted-foreground self-center">+{(path.keySkillsNeeded?.length ?? 0) - 3} more</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Opportunity Card with Urgency ──────────────────────────────────────── */
function OpportunityCard({ opp, index, profile }: { opp: Opportunity; index: number; profile: CareerProfile }) {
  const isFuture   = opp.isFuture ?? false;
  const urgency    = isFuture ? { label: "Coming Soon", color: "text-amber-400 border-amber-400/30" } : getUrgencySignal(opp, index);
  const score      = opp._score ?? 0;
  const matchLabel = bandBy<string | null>(score, { strong: "Strong match", good: "Relevant role", fair: null });
  const missingActions = !isFuture && index === 0 && !profile.baselineInterviewCompleted ? ["Complete baseline interview to improve fit"] : [];
  const [recruiterSent, setRecruiterSent]         = useState(false);
  const [interestState, setInterestState]         = useState<"idle" | "loading" | "done" | "already">("idle");

  function track(extra?: { recruiterRequested?: boolean }) {
    apiFetch(`${apiBase}/portal/track-click`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId:      opp.isExternal ? undefined : opp.id,
        jobTitle:   opp.title,
        company:    opp.company,
        sourceUrl:  opp.isExternal ? opp.sourceUrl : `${window.location.origin}/careers/${opp.id}`,
        isExternal: opp.isExternal ?? false,
        ...extra,
      }),
    }).catch(() => {});
  }

  function handleView() {
    track();
    if (opp.isExternal && opp.sourceUrl) {
      window.open(opp.sourceUrl, "_blank", "noopener,noreferrer");
    }
  }

  function handleRecruiterRequest() {
    track({ recruiterRequested: true });
    setRecruiterSent(true);
  }

  async function handleExpressInterest() {
    if (interestState !== "idle") return;
    setInterestState("loading");
    try {
      const res = await apiFetch(`${apiBase}/portal/express-interest/${opp.id}`, { method: "POST" });
      const data = await res.json();
      setInterestState(data.alreadyRegistered ? "already" : "done");
    } catch {
      setInterestState("idle");
    }
  }

  return (
    <Card className={`transition-all hover-elevate group ${isFuture ? "hover:border-amber-400/30 border-amber-400/10 bg-amber-400/3" : "hover:border-emerald-400/30"}`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-semibold text-sm">{opp.title}</p>
              <Badge variant="outline" className={`text-[10px] ${urgency.color}`}>{urgency.label}</Badge>
              {matchLabel && !isFuture && (
                <Badge className="text-[10px] bg-emerald-500/10 text-emerald-400 border-emerald-400/20">
                  {matchLabel}
                </Badge>
              )}
              {matchLabel && isFuture && (
                <Badge className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-400/20">
                  {matchLabel}
                </Badge>
              )}
              {opp.isExternal && (
                <Badge variant="outline" className="text-[10px] text-sky-400 border-sky-400/30 gap-1">
                  <ExternalLink className="w-2.5 h-2.5" />
                  {opp.sourceDomain ?? "External"}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {opp.company    && <span className="font-medium text-foreground/70">{opp.company}</span>}
              {opp.department && <span>{opp.department}</span>}
              {opp.location   && <><span>·</span><span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{opp.location}</span></>}
              {opp.workType   && <><span>·</span><span className="capitalize">{opp.workType}</span></>}
            </div>
            {(opp.salaryMin || opp.salaryMax) && (
              <p className={`text-xs ${isFuture ? "text-amber-400" : "text-emerald-400"}`}>
                {opp.salaryMin && opp.salaryMax
                  ? `$${(opp.salaryMin / 1000).toFixed(0)}k – $${(opp.salaryMax / 1000).toFixed(0)}k`
                  : opp.salaryMin ? `From $${(opp.salaryMin / 1000).toFixed(0)}k`
                  : `Up to $${(opp.salaryMax! / 1000).toFixed(0)}k`}
              </p>
            )}
            {isFuture && (
              <p className="text-[10px] text-amber-400/70 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                This role is not yet open — express interest to get notified when it launches.
              </p>
            )}
            {missingActions.length > 0 && (
              <p className="text-[10px] text-amber-400 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />{missingActions[0]}
              </p>
            )}
          </div>

          {/* CTA button */}
          {isFuture ? (
            interestState === "done" ? (
              <div className="shrink-0 flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Registered
              </div>
            ) : interestState === "already" ? (
              <div className="shrink-0 flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Already registered
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5 text-xs border-amber-400/30 text-amber-400 hover:bg-amber-400/10"
                onClick={handleExpressInterest}
                disabled={interestState === "loading"}
              >
                {interestState === "loading" ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Bell className="w-3 h-3" />
                )}
                Notify me
              </Button>
            )
          ) : opp.isExternal ? (
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5 text-xs border-sky-400/30 text-sky-400 hover:bg-sky-400/10"
              onClick={handleView}
            >
              View <ExternalLink className="w-3 h-3" />
            </Button>
          ) : (
            <Link href={`/careers/${opp.id}`}>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5 text-xs border-emerald-400/30 text-emerald-400 hover:bg-emerald-400/10"
                onClick={() => track()}
              >
                View <ArrowRight className="w-3 h-3" />
              </Button>
            </Link>
          )}
        </div>

        {opp.isExternal && !isFuture && (
          <div className="border-t border-border/40 pt-2.5 flex items-center justify-between gap-2">
            {recruiterSent ? (
              <p className="text-[11px] text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5" />
                A Lexy recruiter will reach out shortly to help with this role.
              </p>
            ) : (
              <>
                <p className="text-[11px] text-muted-foreground">
                  Want a recruiter to help you land this role?
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px] gap-1.5 text-emerald-400 hover:bg-emerald-400/10 shrink-0"
                  onClick={handleRecruiterRequest}
                >
                  <UserPlus className="w-3 h-3" />
                  Ask a recruiter
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Transcript helpers ─────────────────────────────────────────────────── */
interface TranscriptTurn { speaker: "lexy" | "candidate"; index: number; text: string; }

function parseTranscript(raw: string): { meta: Record<string, string>; turns: TranscriptTurn[] } {
  const lines = raw.split("\n");
  const meta: Record<string, string> = {};
  const turns: TranscriptTurn[] = [];

  for (const line of lines) {
    // Strip markdown bold/italic markers before matching
    const trimmed = line.trim().replace(/^\*{1,2}|\*{1,2}$/g, "").trim();
    if (!trimmed) continue;

    const metaMatch = trimmed.match(/^(Interview Language|Date|Duration)[:\s]+(.+)$/i);
    if (metaMatch) { meta[metaMatch[1]] = metaMatch[2].trim(); continue; }

    // Match Q-lines: Q1. / Q1: / Q1) / Q1 — optionally followed by LEXY... label
    // Push the turn even when the text is on the next line (qMatch[2] empty) so
    // the continuation logic below can append to it.
    const qMatch = trimmed.match(/^Q(\d+)[.:\s)]+(?:LEXY[^:]*)?:?\s*(.*)/i);
    if (qMatch) {
      turns.push({ speaker: "lexy", index: parseInt(qMatch[1]), text: qMatch[2]?.replace(/\*{1,2}/g, "").trim() ?? "" });
      continue;
    }

    // Match A-lines: A1. / A1: / A1) / A1 — optionally followed by CANDIDATE label
    const aMatch = trimmed.match(/^A(\d+)[.:\s)]+(?:CANDIDATE[^:]*)?:?\s*(.*)/i);
    if (aMatch) {
      turns.push({ speaker: "candidate", index: parseInt(aMatch[1]), text: aMatch[2]?.replace(/\*{1,2}/g, "").trim() ?? "" });
      continue;
    }

    // Also handle numbered exchanges like [1] LEXY: or [2] CANDIDATE:
    const bracketQ = trimmed.match(/^\[(\d+)\]\s*LEXY[^:]*:\s*(.*)/i);
    if (bracketQ) {
      turns.push({ speaker: "lexy", index: parseInt(bracketQ[1]), text: bracketQ[2].replace(/\*{1,2}/g, "").trim() });
      continue;
    }
    const bracketA = trimmed.match(/^\[(\d+)\]\s*CANDIDATE[^:]*:\s*(.*)/i);
    if (bracketA) {
      turns.push({ speaker: "candidate", index: parseInt(bracketA[1]), text: bracketA[2].replace(/\*{1,2}/g, "").trim() });
      continue;
    }

    // Skip pure separator / header lines — they shouldn't become turn text
    if (/^[-=*]{2,}$/.test(trimmed) || trimmed.startsWith("**CAREER INTERVIEW") || trimmed.startsWith("CAREER INTERVIEW")) continue;

    if (turns.length > 0) {
      const cleaned = trimmed.replace(/\*{1,2}/g, "").trim();
      if (cleaned) {
        turns[turns.length - 1].text = (turns[turns.length - 1].text
          ? turns[turns.length - 1].text + " " + cleaned
          : cleaned);
      }
    }
  }
  return { meta, turns };
}

/* ── Extract Executive Summary from full analysis text ───────────────────── */
interface ExecSummary {
  overview: string[];           // Body paragraphs from the overview
  headline: string | null;      // "Hiring Manager Headline" line
  extras: string[];             // Any other sub-heading body lines in section 1
}

function extractExecSummary(analysis: string | null | undefined): ExecSummary | null {
  if (!analysis) return null;
  const lines = analysis.split("\n").map(l => l.trim()).filter(Boolean);

  // Find the first main section (EXECUTIVE SUMMARY / section 1)
  let inSection = false;
  const result: ExecSummary = { overview: [], headline: null, extras: [] };
  let currentSubheading = "";

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    const isMainHeader = t.startsWith("##") || /^\*\*\d+\.\s+[A-Z]/.test(t) || /^\d+\.\s+[A-Z][A-Z\s&()/–-]{3,}$/.test(t);

    if (isMainHeader) {
      if (inSection) break; // hit section 2+ — stop
      inSection = true;
      continue;
    }
    if (!inSection) continue;

    // Sub-heading line: **Label:** or **Label:**
    const subMatch = t.match(/^\*\*([^*]+)\*\*:?\s*(.*)/);
    if (subMatch) {
      currentSubheading = subMatch[1].trim().toLowerCase();
      const rest = subMatch[2].trim();
      if (currentSubheading.includes("headline")) {
        result.headline = rest || null;
      } else if (currentSubheading.includes("overview")) {
        if (rest) result.overview.push(rest);
      } else {
        if (rest) result.extras.push(rest);
      }
      continue;
    }

    // Regular text line — append to active sub-heading
    if (currentSubheading.includes("headline")) {
      result.headline = (result.headline ? result.headline + " " : "") + t;
    } else if (currentSubheading.includes("overview") || currentSubheading === "") {
      result.overview.push(t);
    } else {
      result.extras.push(t);
    }
  }

  if (!result.overview.length && !result.headline) return null;
  return result;
}

interface AnalysisSection { title: string; lines: Array<{ type: "subheading" | "body" | "bullet"; text: string }>; }

function parseAnalysis(raw: string): AnalysisSection[] {
  const sections: AnalysisSection[] = [];
  let current: AnalysisSection | null = null;

  // A "main section header" is: ##, or a line that is ENTIRELY **N. TITLE** or plain ALL-CAPS heading
  const isMainHeader = (t: string) =>
    t.startsWith("##") ||
    /^\*\*\d+\.\s+[A-Z]/.test(t) ||          // **1. EXECUTIVE SUMMARY**
    /^\d+\.\s+[A-Z][A-Z\s&()/–-]{3,}$/.test(t) || // 1. EXECUTIVE SUMMARY (plain)
    /^[A-Z][A-Z\s&()/–-]{5,}$/.test(t);       // ALL CAPS standalone line

  // A "sub-heading" is **Word Word:** at start of line (inline bold label)
  const isSubheading = (t: string) =>
    /^\*\*[^*]+\*\*:?$/.test(t) ||
    /^\*\*[^*]+:\*\*/.test(t);

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;

    if (isMainHeader(t)) {
      if (current) sections.push(current);
      current = {
        title: t.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/^\d+\.\s*/, "").trim(),
        lines: [],
      };
    } else if (t.startsWith("- ") || t.startsWith("• ") || t.startsWith("* ")) {
      if (!current) current = { title: "Overview", lines: [] };
      current.lines.push({ type: "bullet", text: t.replace(/^[-•*]\s*/, "") });
    } else if (isSubheading(t)) {
      if (!current) current = { title: "Overview", lines: [] };
      current.lines.push({ type: "subheading", text: t.replace(/\*\*/g, "").replace(/:$/, "") });
    } else {
      if (!current) current = { title: "Overview", lines: [] };
      current.lines.push({ type: "body", text: t });
    }
  }
  if (current) sections.push(current);
  return sections.filter(s => s.title || s.lines.length > 0);
}

function renderBold(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**")
      ? <strong key={i} className="text-foreground/90 font-semibold">{p.slice(2, -2)}</strong>
      : p
  );
}

const SECTION_ICONS: Record<string, React.ReactNode> = {
  "SKILL": <Star className="w-4 h-4" />,
  "STRENGTH": <Award className="w-4 h-4" />,
  "GROWTH": <TrendingUp className="w-4 h-4" />,
  "CAREER": <Target className="w-4 h-4" />,
  "GOAL": <Rocket className="w-4 h-4" />,
  "EDUCATION": <GraduationCap className="w-4 h-4" />,
  "EXPERIENCE": <Briefcase className="w-4 h-4" />,
  "RECOMMENDATION": <Lightbulb className="w-4 h-4" />,
  "SUMMARY": <ScrollText className="w-4 h-4" />,
  "OVERVIEW": <Brain className="w-4 h-4" />,
};
function sectionIcon(title: string) {
  const key = Object.keys(SECTION_ICONS).find(k => title.toUpperCase().includes(k));
  return key ? SECTION_ICONS[key] : <FileText className="w-4 h-4" />;
}
const SECTION_COLORS = [
  "from-cyan-500/10 border-cyan-500/20",
  "from-violet-500/10 border-violet-500/20",
  "from-emerald-500/10 border-emerald-500/20",
  "from-amber-500/10 border-amber-500/20",
  "from-rose-500/10 border-rose-500/20",
  "from-blue-500/10 border-blue-500/20",
];

/* ─── Recording Player ───────────────────────────────────────────────────── */
function RecordingPlayer({ durationSec }: { durationSec?: number }) {
  const [blobUrl, setBlobUrl]     = useState<string | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [expanded, setExpanded]   = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  async function loadVideo() {
    if (blobUrl) { setExpanded(true); return; }
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`${apiBase}/portal/career-interview/my-recording`);
      if (!res.ok) throw new Error("Recording not available");
      const blob = await res.blob();
      setBlobUrl(URL.createObjectURL(blob));
      setExpanded(true);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load recording");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, [blobUrl]);

  const fmt = (s: number) => `${Math.floor(s / 60)}m ${s % 60}s`;

  return (
    <div className="rounded-2xl border border-border/50 bg-card/60 overflow-hidden">
      <button
        className="w-full flex items-center gap-4 px-5 py-4 hover:bg-muted/30 transition-colors text-left"
        onClick={() => expanded ? setExpanded(false) : loadVideo()}
        disabled={loading}
      >
        <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
          {loading
            ? <Loader2 className="w-4 h-4 text-primary animate-spin" />
            : <Video className="w-4 h-4 text-primary" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">Interview Recording</p>
          <p className="text-xs text-muted-foreground">
            {durationSec ? fmt(durationSec) : "Your screen + audio recording"} · Click to {expanded ? "hide" : "watch"}
          </p>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
      </button>

      {error && (
        <div className="px-5 pb-4 text-xs text-destructive flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {expanded && blobUrl && (
        <div className="px-5 pb-5">
          <video
            ref={videoRef}
            src={blobUrl}
            controls
            className="w-full rounded-xl border border-border/40 bg-black max-h-[480px]"
          />
        </div>
      )}
    </div>
  );
}

/* ─── Improvement tips for transcript turns (heuristic, no AI call) ─────── */
const IMPROVEMENT_TIPS = [
  "Try using the STAR method (Situation, Task, Action, Result) to give your answer more structure.",
  "Consider quantifying your impact — specific numbers and metrics make answers more memorable to recruiters.",
  "Showing self-awareness about a challenge you overcame can turn a weakness into a strength signal.",
  "Follow up your statement with a concrete example from a real project or team situation.",
  "Highlight the outcome, not just the activity — recruiters care about what changed because of your action.",
  "Adding context about why you made a specific decision shows strategic thinking.",
];

/* ─── Transcript Panel ───────────────────────────────────────────────────── */
function TranscriptAnalysisPanel({ profile, hasDonePrepSession }: { profile: CareerProfile; hasDonePrepSession: boolean }) {
  const hasTranscript = !!profile.transcriptEnglish;
  const [activeTab, setActiveTab] = useState<"transcript" | "analysis">(hasTranscript ? "transcript" : "analysis");
  const [langMode, setLangMode]   = useState<"en" | "native">("en");
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenError, setRegenError]         = useState<string | null>(null);
  const [regenDone, setRegenDone]           = useState(false);
  const [expandedTips, setExpandedTips]     = useState<Set<number>>(new Set());
  const fullAnalysisRef = useRef<HTMLDivElement>(null);

  function scrollToFullAnalysis() {
    setActiveTab("analysis");
    setTimeout(() => {
      fullAnalysisRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  async function regenerateTranscript() {
    setIsRegenerating(true);
    setRegenError(null);
    try {
      const resp = await apiFetch(`${apiBase}/portal/career-interview/regenerate-transcript`, { method: "POST" });
      if (!resp.ok) throw new Error("Failed");
      setRegenDone(true);
      window.location.reload();
    } catch {
      setRegenError("Could not regenerate transcript. Please try again.");
    } finally {
      setIsRegenerating(false);
    }
  }

  const isNonEnglish = !!profile.interviewLanguage && !profile.interviewLanguage.startsWith("en");
  const hasNative    = isNonEnglish && (profile.transcriptNative || profile.analysisNative);
  const transcriptRaw = langMode === "native" && profile.transcriptNative ? profile.transcriptNative : profile.transcriptEnglish;
  const analysisRaw   = langMode === "native" && profile.analysisNative ? profile.analysisNative : profile.analysisEnglish;

  const { meta, turns } = transcriptRaw ? parseTranscript(transcriptRaw) : { meta: {}, turns: [] };
  const analysisSections = analysisRaw ? parseAnalysis(analysisRaw) : [];

  const langLabel = profile.interviewLanguage
    ? profile.interviewLanguage.charAt(0).toUpperCase() + profile.interviewLanguage.slice(1)
    : "English";

  return (
    <div className="mt-8 space-y-4">
      {/* Header row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/15 flex items-center justify-center">
            <ScrollText className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold leading-tight">Interview Transcript & Analysis</h2>
            <p className="text-xs text-muted-foreground">
              {turns.length > 0 ? `${turns.filter(t => t.speaker === "lexy").length} questions · ` : ""}
              {langLabel} interview
              {meta["Date"] && meta["Date"] !== "[Today's Date]" ? ` · ${meta["Date"]}` : ""}
            </p>
          </div>
        </div>
        {hasNative && (
          <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-1">
            <Button size="sm" variant={langMode === "en" ? "default" : "ghost"} className="h-7 px-3 text-xs gap-1.5" onClick={() => setLangMode("en")}>
              <Languages className="w-3 h-3" /> English
            </Button>
            <Button size="sm" variant={langMode === "native" ? "default" : "ghost"} className="h-7 px-3 text-xs gap-1.5" onClick={() => setLangMode("native")}>
              <Globe className="w-3 h-3" /> Native
            </Button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/30 rounded-xl p-1 w-fit">
        {(["transcript", "analysis"] as const).map(tab => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
              activeTab === tab
                ? "bg-card text-foreground shadow-sm border border-border/50"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab === "transcript"
              ? <MessageSquare className="w-3.5 h-3.5" />
              : <Brain className="w-3.5 h-3.5" />}
            {tab === "transcript" ? "Transcript" : "Career Analysis"}
            {tab === "transcript" && turns.length > 0 && (
              <span className="text-[10px] bg-primary/15 text-primary rounded-full px-1.5 py-0.5 font-semibold">
                {turns.length}
              </span>
            )}
            {tab === "analysis" && analysisSections.length > 0 && (
              <span className="text-[10px] bg-violet-500/15 text-violet-400 rounded-full px-1.5 py-0.5 font-semibold">
                {analysisSections.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── TRANSCRIPT TAB ── */}
      {activeTab === "transcript" && (
        <div className="space-y-3">
          {turns.length === 0 && (
            <div className="text-center py-16 text-muted-foreground/50">
              <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
              {hasTranscript ? (
                <p className="text-sm">Transcript could not be parsed.</p>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm">Transcript was not generated for this interview.</p>
                  {regenError && <p className="text-xs text-red-400">{regenError}</p>}
                  {regenDone ? (
                    <p className="text-xs text-emerald-400">Transcript regenerated — reloading…</p>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={regenerateTranscript}
                      disabled={isRegenerating}
                      className="gap-2"
                    >
                      {isRegenerating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      {isRegenerating ? "Generating…" : "Regenerate transcript"}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {turns.map((turn, i) => (
            turn.speaker === "lexy" ? (
              /* Lexy bubble — left */
              <div key={i} className="flex items-start gap-3 max-w-3xl">
                <div className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary to-cyan-600 flex items-center justify-center shadow-md shadow-primary/20">
                  <Sparkles className="w-3.5 h-3.5 text-black" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-primary">L3xy AI</span>
                    <span className="text-[10px] text-muted-foreground/50 bg-muted/40 rounded px-1.5 py-0.5">Q{turn.index}</span>
                  </div>
                  <div className="bg-primary/8 border border-primary/15 rounded-2xl rounded-tl-sm px-4 py-3">
                    <p className="text-sm text-foreground leading-relaxed">{turn.text}</p>
                  </div>
                </div>
              </div>
            ) : (
              /* Candidate bubble — right */
              <div key={i} className="space-y-1.5 max-w-3xl ml-auto">
                <div className="flex items-start gap-3 flex-row-reverse">
                  <div className="shrink-0 w-8 h-8 rounded-full bg-muted flex items-center justify-center border border-border/50">
                    <span className="text-xs font-bold text-muted-foreground">
                      {(profile.currentTitle?.[0] ?? "C").toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1 justify-end">
                      <span className="text-[10px] text-muted-foreground/50 bg-muted/40 rounded px-1.5 py-0.5">A{turn.index}</span>
                      <span className="text-xs font-semibold text-muted-foreground">You</span>
                    </div>
                    <div className="bg-card border border-border/40 rounded-2xl rounded-tr-sm px-4 py-3">
                      <p className="text-sm text-foreground/90 leading-relaxed">{turn.text}</p>
                    </div>
                  </div>
                </div>
                {/* "How to improve" expandable tip */}
                <div className="ml-11 mr-11">
                  <button
                    onClick={() => setExpandedTips(prev => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    })}
                    className="text-[10px] text-muted-foreground/60 hover:text-primary transition-colors flex items-center gap-1"
                  >
                    <Lightbulb className="w-3 h-3" />
                    {expandedTips.has(i) ? "Hide" : "Interview coaching tip"}
                    <ChevronRight className={`w-3 h-3 transition-transform ${expandedTips.has(i) ? "rotate-90" : ""}`} />
                  </button>
                  {expandedTips.has(i) && (
                    <div className="mt-1.5 space-y-1.5">
                      <div className="p-2.5 bg-primary/5 border border-primary/15 rounded-xl text-xs text-muted-foreground leading-relaxed">
                        <p className="font-medium text-foreground/80 mb-1 flex items-center gap-1.5">
                          <Lightbulb className="w-3 h-3 text-primary" />General guidance to strengthen answers like this
                        </p>
                        {IMPROVEMENT_TIPS[turn.index % IMPROVEMENT_TIPS.length]}
                      </div>
                      {!hasDonePrepSession && (
                        <div className="p-2.5 bg-muted/40 border border-border/30 rounded-xl flex items-center gap-2 text-xs text-muted-foreground">
                          <Lock className="w-3 h-3 text-amber-400 shrink-0" />
                          <span>Detailed answer feedback available after 1 practice session</span>
                          <Link href="/portal/prep" className="ml-auto shrink-0">
                            <span className="text-primary underline whitespace-nowrap">Start prep</span>
                          </Link>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          ))}
        </div>
      )}

      {/* ── CAREER ANALYSIS TAB ── */}
      {activeTab === "analysis" && (
        <div className="space-y-4">
          {analysisSections.length === 0 && (
            <div className="text-center py-16 text-muted-foreground/50">
              <Brain className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Analysis is being generated…</p>
            </div>
          )}
          {analysisSections.length > 0 && (
            <div ref={fullAnalysisRef} className="space-y-4">
              {analysisSections.map((section, i) => (
                <div key={i} className={`rounded-2xl border bg-gradient-to-br to-card p-5 ${SECTION_COLORS[i % SECTION_COLORS.length]}`}>
                  {/* Section header */}
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-7 h-7 rounded-lg bg-background/60 flex items-center justify-center text-primary">
                      {sectionIcon(section.title)}
                    </div>
                    <h3 className="text-sm font-bold uppercase tracking-wide text-foreground/90">
                      {section.title}
                    </h3>
                  </div>
                  {/* Section body lines */}
                  <div className="space-y-2">
                    {section.lines.map((line, j) => {
                      if (line.type === "subheading") {
                        return (
                          <p key={j} className="text-sm font-semibold text-primary/80 mt-3 mb-0.5 first:mt-0">
                            {line.text}
                          </p>
                        );
                      }
                      if (line.type === "bullet") {
                        return (
                          <div key={j} className="flex items-start gap-2 text-sm text-muted-foreground">
                            <CheckCircle2 className="w-3.5 h-3.5 text-primary/70 mt-0.5 shrink-0" />
                            <span className="leading-relaxed">{renderBold(line.text)}</span>
                          </div>
                        );
                      }
                      return (
                        <p key={j} className="text-sm text-muted-foreground leading-relaxed">
                          {renderBold(line.text)}
                        </p>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Raw fallback if parser produced nothing useful */}
          {analysisSections.length === 0 && analysisRaw && (
            <Card className="border-border/50">
              <CardContent className="p-6">
                <pre className="whitespace-pre-wrap font-sans text-sm text-muted-foreground leading-relaxed">{analysisRaw}</pre>
              </CardContent>
            </Card>
          )}

          {/* 5B — Detailed answer feedback (locked until 1 prep session) */}
          <div className="rounded-2xl border border-border/50 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 bg-muted/30 border-b border-border/40">
              <p className="text-sm font-semibold flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-primary" />Detailed Answer Feedback
              </p>
              {hasDonePrepSession ? null : (
                <Badge variant="outline" className="text-[10px] border-border/40 text-muted-foreground gap-1">
                  <Lock className="w-2.5 h-2.5" />Locked
                </Badge>
              )}
            </div>
            {hasDonePrepSession ? (
              /* Unlocked — pull real feedback from existing AI analysis sections */
              (() => {
                const FEEDBACK_KEYWORDS = ["COMMUNICATION", "RECOMMENDATION", "GROWTH", "INTERVIEW", "SKILL", "STRENGTH", "IMPROVEMENT"];
                const feedbackSections = analysisSections.filter(s =>
                  FEEDBACK_KEYWORDS.some(k => s.title.toUpperCase().includes(k))
                ).slice(0, 3);

                if (feedbackSections.length === 0 && !analysisRaw) {
                  return (
                    <div className="p-5">
                      <p className="text-xs text-muted-foreground">
                        Detailed feedback will appear after more interview analysis is available.
                      </p>
                    </div>
                  );
                }

                if (feedbackSections.length === 0) {
                  return (
                    <div className="p-5 space-y-2">
                      <p className="text-xs text-muted-foreground">
                        Your interview analysis is available in the Career Analysis tab. Review it for in-depth feedback on your communication and growth areas.
                      </p>
                      <button
                        onClick={scrollToFullAnalysis}
                        className="text-xs text-primary underline"
                      >
                        View full analysis →
                      </button>
                    </div>
                  );
                }

                return (
                  <div className="p-5 space-y-4">
                    {feedbackSections.map((section, i) => (
                      <div key={i} className="space-y-2">
                        <p className="text-xs font-bold uppercase tracking-wide text-primary/70">{section.title}</p>
                        <div className="space-y-1.5">
                          {section.lines.slice(0, 4).map((line, j) => (
                            line.type === "bullet" ? (
                              <div key={j} className="flex items-start gap-2 text-xs text-muted-foreground">
                                <CheckCircle2 className="w-3 h-3 text-primary/60 shrink-0 mt-0.5" />
                                <span>{renderBold(line.text)}</span>
                              </div>
                            ) : (
                              <p key={j} className="text-xs text-muted-foreground leading-relaxed">{renderBold(line.text)}</p>
                            )
                          ))}
                        </div>
                      </div>
                    ))}
                    <button
                      onClick={scrollToFullAnalysis}
                      className="text-xs text-primary underline"
                    >
                      View full career analysis →
                    </button>
                  </div>
                );
              })()
            ) : (
              <div className="p-5 space-y-3">
                <div className="blur-sm select-none pointer-events-none space-y-2" aria-hidden>
                  {analysisSections.slice(0, 1).flatMap(s => s.lines.slice(0, 2)).length > 0
                    ? analysisSections.slice(0, 1).flatMap(s => s.lines.slice(0, 2)).map((line, i) => (
                        <p key={i} className="text-sm text-muted-foreground">{line.text.slice(0, 80)}…</p>
                      ))
                    : <>
                        <p className="text-sm text-muted-foreground">Your communication patterns show strong potential in…</p>
                        <p className="text-sm text-muted-foreground">Key growth area identified in your interview responses…</p>
                      </>
                  }
                </div>
                <div className="flex items-center gap-2 p-2.5 bg-muted/40 border border-border/30 rounded-xl text-xs text-muted-foreground">
                  <Lock className="w-3 h-3 text-amber-400 shrink-0" />
                  Complete 1 practice session to unlock per-answer feedback
                  <Link href="/portal/prep" className="ml-auto shrink-0">
                    <Button size="sm" className="h-6 text-[10px] px-2">Start Prep</Button>
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main Page ──────────────────────────────────────────────────────────── */
export default function CareerHub() {
  const [profile, setProfile]           = useState<CareerProfile | null>(null);
  const [loading, setLoading]           = useState(true);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [matchedCount, setMatchedCount] = useState<number>(0);
  const [futureCount, setFutureCount]   = useState<number>(0);
  const [oppsNoProfile, setOppsNoProfile] = useState(false);
  const [oppsNoMatches, setOppsNoMatches] = useState(false);
  const [progress, setProgress]         = useState<ProgressData | null>(null);
  const [resumeUploading, setResumeUploading] = useState(false);
  const [resumeUploaded, setResumeUploaded]   = useState(false);
  const [resumeError, setResumeError]         = useState<string | null>(null);
  const [benchmarkData, setBenchmarkData]     = useState<BenchmarkData | null>(null);
  const [engagement, setEngagement]           = useState<any>(null);
  const resumeFileRef = useRef<HTMLInputElement>(null);

  /* Per-skill engagement data (sparkline). Loaded once on mount. */
  useEffect(() => {
    apiFetch(`${apiBase}/portal/engagement`)
      .then(r => r.json()).then(setEngagement).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      apiFetch(`${apiBase}/portal/career-profile`).then(r => r.json()),
      apiFetch(`${apiBase}/portal/opportunities`).then(r => r.json()).catch(() => ({ data: [] })),
      apiFetch(`${apiBase}/portal/career-progress`).then(r => r.json()).catch(() => null),
      apiFetch(`${apiBase}/portal/career-benchmark`).then(r => r.json()).catch(() => null),
    ]).then(async ([profileRes, oppsRes, progressRes, benchmarkRes]) => {
      const profileData = profileRes.data;
      setProfile(profileData);
      if (profileData?.resumeUrl) setResumeUploaded(true);

      /* If a resume is stored in S3 but hasn't been parsed yet, auto-parse it now
         so the Opportunity Engine can use the candidate's actual resume data. */
      if (profileData?.resumeUrl && !profileData?.resumeParsedProfile) {
        apiFetch(`${apiBase}/portal/career-profile/resume/parse-existing`, { method: "POST" })
          .then(r => r.json())
          .then(parsed => {
            if (parsed.ok && parsed.profile) {
              /* Re-fetch opportunities now that the resume is parsed */
              apiFetch(`${apiBase}/portal/opportunities`).then(r => r.json())
                .then(refreshed => {
                  setOpportunities(refreshed.data ?? []);
                  setMatchedCount(refreshed.matchedCount ?? 0);
                  setFutureCount(refreshed.futureCount ?? 0);
                  setOppsNoProfile(!!refreshed.noProfile);
                  setOppsNoMatches(!!refreshed.noMatches);
                })
                .catch(() => {});
            }
          })
          .catch(() => {});
      }

      setOpportunities(oppsRes.data ?? []);
      setMatchedCount(oppsRes.matchedCount ?? (oppsRes.data ?? []).filter((o: Opportunity) => !o.isFuture && (o._score ?? 0) > 0).length);
      setFutureCount(oppsRes.futureCount ?? (oppsRes.data ?? []).filter((o: Opportunity) => o.isFuture).length);
      setOppsNoProfile(!!oppsRes.noProfile);
      setOppsNoMatches(!!oppsRes.noMatches);
      if (progressRes && !progressRes.error) setProgress(progressRes);
      if (benchmarkRes && !benchmarkRes.error) setBenchmarkData(benchmarkRes);
      setLoading(false);
    }).catch(() => setLoading(false));

    apiFetch(`${apiBase}/portal/activity-ping`, { method: "POST" }).catch(() => {});
  }, []);

  async function handleResumeFile(file: File) {
    const allowed = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    if (!allowed.includes(file.type)) { setResumeError("PDF or Word only (.pdf, .doc, .docx)"); return; }
    if (file.size > 10 * 1024 * 1024) { setResumeError("Max 10 MB"); return; }
    setResumeError(null);
    setResumeUploading(true);
    try {
      /* 1. Upload file to S3 */
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await apiFetch(`${BASE}/api/storage/uploads/file`, {
        method: "POST", body: formData,
      });
      if (!uploadRes.ok) throw new Error();
      const { objectPath } = await uploadRes.json();
      if (!objectPath) throw new Error();

      /* 2. Save the S3 path to the candidate record */
      const saveRes = await apiFetch(`${BASE}/api/portal/career-profile/resume`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeObjectPath: objectPath }),
      });
      if (!saveRes.ok) throw new Error();
      setResumeUploaded(true);

      /* 3. Parse the resume immediately (send the file directly for speed) */
      const parseFormData = new FormData();
      parseFormData.append("file", file);
      const parseRes = await apiFetch(`${apiBase}/portal/career-profile/resume/parse`, {
        method: "POST", body: parseFormData,
      });
      const parseData = await parseRes.json();
      if (parseData.ok && parseData.profile) {
        /* Refresh opportunities now that the resume is parsed */
        const refreshed = await apiFetch(`${apiBase}/portal/opportunities`).then(r => r.json()).catch(() => null);
        if (refreshed) {
          setOpportunities(refreshed.data ?? []);
          setMatchedCount(refreshed.matchedCount ?? 0);
          setFutureCount(refreshed.futureCount ?? 0);
          setOppsNoProfile(!!refreshed.noProfile);
          setOppsNoMatches(!!refreshed.noMatches);
        }
      }
    } catch {
      setResumeError("Upload failed — try again.");
    } finally {
      setResumeUploading(false);
    }
  }

  const completeness  = profile?.profileCompleteness ?? 0;
  const paths: CareerPath[] = (profile?.careerPaths as CareerPath[]) ?? [];
  const strengths: string[] = (profile?.strengthAreas as string[]) ?? [];
  const growthAreas: string[] = (profile?.growthAreas as string[]) ?? [];
  const motivations: string[] = (profile?.motivations as string[]) ?? [];
  const targetCos: string[]   = (profile?.targetCompanies as string[]) ?? [];
  const industries: string[]  = (profile?.targetIndustries as string[]) ?? [];
  const skills: string[]      = (profile?.skills as string[]) ?? [];

  const readinessScore = progress?.readinessScore ?? (profile?.baselineInterviewCompleted ? Math.min(100, Math.max(30, Math.round(
    30 +
    Math.min(20, skills.length * 2) +
    Math.min(10, Math.round((profile?.yearsExperience ?? 0) * 0.5)) +
    (profile?.careerGoal3yr ? 8 : 0) +
    (profile?.careerGoal5yr ? 4 : 0) +
    (((profile?.preferredRoles as string[]) ?? []).length > 0 ? 5 : 0) +
    Math.min(10, strengths.length * 2) +
    Math.min(6, growthAreas.length * 2) +
    (paths.length > 0 ? 4 : 0) +
    (profile?.aiSummary ? 3 : 0)
  ))) : 0);

  const nextBestActions = profile ? computeNextBestActions(profile, completeness, opportunities) : [];
  const hasDonePrepSession = (progress?.streak?.totalSessions ?? 0) > 0 || (progress?.weeklyStats?.practiceSessionsThisWeek ?? 0) > 0;

  if (loading) {
    return (
      <AppLayout>
        {/* T011n — disclosure banner must render on every /portal/career
            branch, including the loading skeleton, so a first-time
            candidate cannot dismiss the page before seeing the notice. */}
        <AiDisclosureBanner />
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin w-8 h-8 border-4 border-primary border-t-transparent rounded-full" />
        </div>
      </AppLayout>
    );
  }

  if (!profile || !profile.baselineInterviewCompleted) {
    return (
      <AppLayout>
        {/* T011n — banner on the pre-interview onboarding screen too;
            this is the very first surface a brand-new candidate sees,
            so any AI-use disclosure has to appear here as well. */}
        <AiDisclosureBanner />
        <div className="flex items-center justify-center min-h-[80vh] px-4">
          <div className="max-w-lg w-full text-center space-y-10">
            {/* Icon */}
            <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto ring-1 ring-primary/20">
              <Sparkles className="w-8 h-8 text-primary" />
            </div>

            {/* Headline + subtext */}
            <div className="space-y-3">
              <h1 className="text-4xl font-bold tracking-tight leading-tight">
                Turn Your Experience Into{" "}
                <span className="text-primary">Real Opportunities</span>
              </h1>
              <p className="text-muted-foreground text-base leading-relaxed">
                In 10 minutes, Lexy analyzes how you think, what you're good at,
                and where you actually have a chance of getting hired.
              </p>
            </div>

            {/* Feature cards */}
            <div className="flex flex-col gap-3 text-left">
              {[
                { icon: Zap,       title: "Know your real strengths",          desc: "See exactly where you outperform other candidates." },
                { icon: Briefcase, title: "See roles you can actually land",   desc: "Matched to real openings based on your signal, not just your CV." },
                { icon: Brain,     title: "Understand what's holding you back", desc: "Get a clear gap analysis so you know what to work on first." },
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title} className="flex items-start gap-4 p-4 bg-card border border-border/50 rounded-xl text-left">
                  <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Icon className="w-4 h-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* CTA */}
            <div className="flex flex-col items-center gap-5">
              <Link href="/portal/career/interview" className="w-full">
                <Button size="lg" className="w-full gap-2 shadow-lg shadow-primary/20 text-base h-12">
                  <Sparkles className="w-4 h-4" />Start My AI Interview
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
              <p className="text-sm text-muted-foreground">No resume required · Upload one to speed things up</p>
            </div>

            {/* Proof */}
            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground/40 pt-2">
              <Globe className="w-3 h-3" />
              <span>Used by candidates across 25+ countries</span>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      {/* T011 — AI disclosure banner. /portal redirects here so this is the
          real candidate landing surface; mounting it on portal/index alone
          left the banner on a dead route. The banner self-suppresses when
          /portal/disclosures/active returns shouldDisplay=false. */}
      <AiDisclosureBanner />
      {/* Header */}
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Career Command Centre</h1>
          <p className="text-muted-foreground mt-1">
            {profile.currentTitle
              ? `${profile.currentTitle}${profile.currentCompany ? ` at ${profile.currentCompany}` : ""}`
              : "Your AI-powered career growth engine"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {progress?.streak?.current && progress.streak.current > 0 ? (
            <Badge variant="outline" className="gap-1.5 border-orange-400/30 text-orange-400">
              <Flame className="w-3.5 h-3.5" />{progress.streak.current} day streak
            </Badge>
          ) : null}
          <Link href="/portal/career/interview">
            <Button variant="outline" size="sm" className="gap-2">
              <RefreshCw className="w-3.5 h-3.5" />Retake Interview
            </Button>
          </Link>
        </div>
      </div>

      {/* Inactivity banner — shown if last activity > 5 days ago */}
      {(() => {
        const lastAt = progress?.streak?.lastActivityAt;
        const daysInactive = lastAt
          ? Math.floor((Date.now() - new Date(lastAt).getTime()) / 86400000)
          : null;
        if (daysInactive === null || daysInactive < 5) return null;
        return (
          <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-amber-500/8 border border-amber-400/25 rounded-xl">
            <Bell className="w-4 h-4 text-amber-400 shrink-0" />
            <p className="text-sm text-foreground flex-1">
              You haven't improved your profile in a few days. Want to increase your readiness score?
            </p>
            <Link href="/portal/career/interview">
              <Button size="sm" variant="outline" className="shrink-0 text-xs border-amber-400/40 text-amber-400 hover:bg-amber-400/10 whitespace-nowrap">
                Continue Improving
              </Button>
            </Link>
          </div>
        );
      })()}

      {/* Weekly Summary */}
      <WeeklySummary progress={progress} readiness={readinessScore} completeness={completeness} />

      {/* Next Best Action Brain */}
      {nextBestActions.length > 0 && <NextBestActionPanel actions={nextBestActions} />}

      {/* Intelligence Score Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <Card className="sm:col-span-1 bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-4 flex justify-center">
            <ScoreRing
              value={readinessScore}
              color="hsl(var(--primary))"
              label="Readiness"
              sublabel={readinessSublabel(readinessScore)}
              delta={progress?.readinessDelta}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex justify-center">
            <ScoreRing
              value={completeness}
              color="hsl(210 80% 60%)"
              label="Profile"
              sublabel="completeness"
              delta={progress?.profileDelta}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col items-center text-center gap-2">
            <div className="w-16 h-16 rounded-full flex items-center justify-center bg-amber-400/10 border-2 border-amber-400/20">
              <span className="text-2xl font-black text-amber-400">{growthAreas.length}</span>
            </div>
            <div>
              <p className="text-xs font-semibold">Skill Gaps</p>
              <p className="text-[10px] text-muted-foreground">{growthAreas.length === 0 ? "None identified" : "to develop"}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex flex-col items-center text-center gap-2">
            <div className="w-16 h-16 rounded-full flex items-center justify-center bg-emerald-400/10 border-2 border-emerald-400/20">
              <span className="text-2xl font-black text-emerald-400">{matchedCount}</span>
            </div>
            <div>
              <p className="text-xs font-semibold">Opportunities</p>
              <p className="text-[10px] text-muted-foreground">
                {matchedCount === 0 ? "No strong matches yet" : matchedCount === 1 ? "role matched for you" : "roles matched for you"}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Per-Skill Improvement Sparklines ──────────────────────────────
         Renders a tiny SVG trend chart per tracked skill, sourced from
         /portal/engagement.skillScores. Only shows when at least one skill
         has 2+ data points (otherwise a sparkline tells you nothing). */}
      {engagement?.skillScores && engagement.skillScores.length > 0 && (() => {
        const ranked = (engagement.skillScores as any[])
          .filter(s => Array.isArray(s.history) && s.history.length >= 2)
          .map(s => {
            const scores: number[] = s.history.map((p: any) => p.score);
            const first = scores[0];
            const last  = scores[scores.length - 1];
            return { skill: s.skill, scores, first, last, delta: last - first };
          })
          .sort((a, b) => b.delta - a.delta)
          .slice(0, 8);

        if (ranked.length === 0) return null;

        return (
          <Card className="mb-8">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-cyan-400" />
                Skill Improvement Over Time
              </CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {ranked.map(({ skill, scores, first, last, delta }) => {
                const min = Math.min(...scores);
                const max = Math.max(...scores);
                const span = Math.max(1, max - min);
                const W = 120, H = 32;
                const pts = scores.map((v, i) => {
                  const x = (i / (scores.length - 1)) * W;
                  const y = H - ((v - min) / span) * H;
                  return `${x.toFixed(1)},${y.toFixed(1)}`;
                }).join(" ");
                const trendColor = delta > 0 ? "text-emerald-400" : delta < 0 ? "text-amber-400" : "text-muted-foreground";
                const strokeColor = delta >= 0 ? "hsl(160 84% 55%)" : "hsl(40 90% 60%)";
                return (
                  <div key={skill} className="rounded-xl border border-border/40 bg-muted/10 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold truncate" title={skill}>{skill}</p>
                      <span className={`text-[10px] font-bold ${trendColor}`}>
                        {delta > 0 ? "+" : ""}{delta}
                      </span>
                    </div>
                    <svg width={W} height={H} className="block">
                      <polyline
                        fill="none" stroke={strokeColor} strokeWidth="2"
                        strokeLinecap="round" strokeLinejoin="round"
                        points={pts}
                      />
                    </svg>
                    <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
                      <span>{first}</span>
                      <span className="font-medium text-foreground">{last}</span>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })()}

      {/* Readiness Score Breakdown — visible when breakdown data exists */}
      {progress?.readinessBreakdown && progress.readinessBreakdown.length > 0 && (
        <ReadinessBreakdownPanel
          breakdown={progress.readinessBreakdown}
          score={readinessScore}
          onRecomputed={(updated) => {
            // Updated data may be a progress object (from career-progress reload)
            // or a raw profile row (from the recompute endpoint) — handle both.
            if (updated?.readinessBreakdown) {
              setProgress(updated);
            }
          }}
        />
      )}

      {/* "You're Close" motivational nudge — top career path + top 2 missing skills */}
      {paths.length > 0 && (() => {
        const topPath = paths[0];
        const missing = topPath.keySkillsNeeded?.slice(0, 2) ?? [];
        const trend = (progress?.readinessDelta ?? 0) > 0
          ? "Improving"
          : (progress?.readinessDelta ?? 0) < 0
          ? "Rebuilding"
          : "No change yet";
        const trendColor = trend === "Improving" ? "text-emerald-400" : trend === "Rebuilding" ? "text-amber-400" : "text-muted-foreground";
        if (missing.length === 0) return null;
        return (
          <div className="mb-6 flex flex-col sm:flex-row sm:items-center gap-3 p-4 bg-primary/5 border border-primary/20 rounded-xl">
            <Rocket className="w-5 h-5 text-primary shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-foreground">
                You're <span className="text-primary">{pluralize(missing.length, "improvement")}</span> away from being ready for{" "}
                <span className="text-primary">{topPath.targetRole}</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Focus on: {missing.join(" and ")} · Trend: <span className={trendColor}>{trend}</span>
              </p>
            </div>
          </div>
        );
      })()}

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left Column */}
        <div className="lg:col-span-1 space-y-4">
          {(profile.aiSummary || profile.analysisEnglish) && (() => {
            const exec = extractExecSummary(profile.analysisEnglish);
            return (
              <Card className="overflow-hidden">
                <CardHeader className="pb-3 border-b border-border/40">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary" />AI Career Narrative
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {/* Hiring manager headline — prominent banner */}
                  {exec?.headline && (
                    <div className="px-5 py-3 bg-primary/8 border-b border-primary/10">
                      <p className="text-xs font-semibold text-primary/70 uppercase tracking-wider mb-1">Hiring Manager View</p>
                      <p className="text-sm font-medium text-foreground leading-snug">
                        "{exec.headline.replace(/^"|"$/g, "")}"
                      </p>
                    </div>
                  )}
                  {/* Executive overview paragraphs */}
                  <div className="px-5 py-4 space-y-2.5">
                    {exec?.overview && exec.overview.length > 0 ? (
                      exec.overview.map((para, i) => (
                        <p key={i} className="text-sm text-muted-foreground leading-relaxed">
                          {para}
                        </p>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground leading-relaxed italic">
                        "{profile.aiSummary}"
                      </p>
                    )}
                    {/* Extra context lines from exec summary */}
                    {exec?.extras && exec.extras.length > 0 && (
                      <div className="pt-1 space-y-1">
                        {exec.extras.map((e, i) => (
                          <p key={i} className="text-xs text-muted-foreground/80 leading-relaxed">{e}</p>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          {/* Profile Confidence */}
          <ProfileConfidenceCard profile={profile} completeness={completeness} />

          {/* Recruiter Visibility */}
          <RecruiterVisibility completeness={completeness} profile={profile} />

          {/* Strengths & Growth */}
          {(strengths.length > 0 || growthAreas.length > 0) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Award className="w-4 h-4 text-primary" />Self-Assessment
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {strengths.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wide mb-2">Core Strengths</p>
                    <div className="space-y-1">
                      {strengths.map((s, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                          <span className="text-sm">{s}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {growthAreas.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide mb-2">Skill Gaps → Outcomes</p>
                    <div className="space-y-2">
                      {growthAreas.map((g, i) => (
                        <SkillGapCard key={i} gap={g} />
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Goals */}
          {(profile.careerGoal3yr || profile.careerGoal5yr) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Target className="w-4 h-4 text-primary" />Career Goals
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {profile.careerGoal3yr && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">3-Year Goal</p>
                    <p className="text-sm">{profile.careerGoal3yr}</p>
                  </div>
                )}
                {profile.careerGoal5yr && (
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">5-Year Vision</p>
                    <p className="text-sm">{profile.careerGoal5yr}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Background */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-primary" />Background
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {profile.yearsExperience && (
                <div className="flex items-center gap-2">
                  <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{profile.yearsExperience} years experience</span>
                </div>
              )}
              {profile.education && (
                <div className="flex items-center gap-2">
                  <GraduationCap className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">{profile.education}</span>
                </div>
              )}
              {profile.preferredWorkStyle && (
                <div className="flex items-center gap-2">
                  <MapPin className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground capitalize">{profile.preferredWorkStyle}</span>
                </div>
              )}
              {skills.length > 0 && (
                <div className="pt-1">
                  <p className="text-xs text-muted-foreground mb-1.5">Skills</p>
                  <div className="flex flex-wrap gap-1">
                    {skills.slice(0, 8).map((s, i) => (
                      <Badge key={i} variant="secondary" className="text-xs">{s}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Target companies */}
          {(targetCos.length > 0 || industries.length > 0) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-primary" />Dream Companies
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {targetCos.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {targetCos.map((c, i) => (
                      <Badge key={i} variant="outline" className="text-xs border-primary/30 text-primary">{c}</Badge>
                    ))}
                  </div>
                )}
                {industries.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">Target Industries</p>
                    <div className="flex flex-wrap gap-1">
                      {industries.map((ind, i) => (
                        <Badge key={i} variant="secondary" className="text-xs">{ind}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Motivations */}
          {motivations.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Lightbulb className="w-4 h-4 text-primary" />What Drives You
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-1.5">
                  {motivations.map((m, i) => (
                    <Badge key={i} className="text-xs bg-primary/10 text-primary border-primary/20">{m}</Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Resume Upload */}
          <Card className="border-dashed border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />Resume
              </CardTitle>
            </CardHeader>
            <CardContent>
              <input
                ref={resumeFileRef} type="file" accept=".pdf,.doc,.docx" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleResumeFile(f); }}
              />
              {resumeUploaded ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    Resume on file
                  </div>
                  <Button size="sm" variant="ghost" className="w-full gap-2 text-xs text-muted-foreground"
                    onClick={() => resumeFileRef.current?.click()} disabled={resumeUploading}>
                    {resumeUploading
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…</>
                      : <><Upload className="w-3.5 h-3.5" />Replace resume</>}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Improve your profile accuracy with your resume — auto-fills experience and boosts match quality.</p>
                  {resumeError && (
                    <p className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />{resumeError}
                    </p>
                  )}
                  <Button size="sm" variant="outline" className="w-full gap-2 text-xs"
                    onClick={() => resumeFileRef.current?.click()} disabled={resumeUploading}>
                    {resumeUploading
                      ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Uploading…</>
                      : <><Upload className="w-3.5 h-3.5" />Improve profile accuracy with resume</>}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column */}
        <div className="lg:col-span-2 space-y-6">

          {/* Career Trajectory */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary" />Career Trajectory
              </h2>
              <Badge variant="outline" className="text-xs border-primary/30 text-primary">{paths.length} paths identified</Badge>
            </div>
            {paths.length > 0 ? (
              <div className="space-y-3">
                {paths.map((path, i) => (
                  <PathCard
                    key={i}
                    path={path}
                    index={i}
                    profile={profile}
                    canUnlock={resumeUploaded || hasDonePrepSession}
                  />
                ))}
              </div>
            ) : (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center py-12 text-center gap-4">
                  <TrendingUp className="w-12 h-12 text-muted-foreground/30" />
                  <div>
                    <p className="font-medium text-muted-foreground">No career paths yet</p>
                    <p className="text-sm text-muted-foreground/60">Complete your baseline interview to get 3 personalised paths</p>
                  </div>
                  <Link href="/portal/career/interview">
                    <Button size="sm" className="gap-2"><Sparkles className="w-3.5 h-3.5" />Start Interview</Button>
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Practice Engine */}
          <PracticeEngine profile={profile} progress={progress} />

          {/* 5A — Benchmark Comparison (real DB-driven, locked until prep + sufficient data) */}
          <Card className={`border-border/50 relative overflow-hidden ${hasDonePrepSession ? "" : "opacity-90"}`}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart className="w-4 h-4 text-violet-400" />
                  How You Compare to Other Candidates
                </CardTitle>
                {!hasDonePrepSession && (
                  <Badge variant="outline" className="text-[10px] border-border/40 text-muted-foreground gap-1">
                    <Lock className="w-2.5 h-2.5" />Locked
                  </Badge>
                )}
                {hasDonePrepSession && benchmarkData?.available && (
                  <Badge variant="outline" className="text-[10px] border-violet-400/30 text-violet-400">
                    {pluralize(benchmarkData.count, "candidate")}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!hasDonePrepSession ? (
                /* Locked state */
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    See how your readiness and profile completeness compare to other candidates across the platform.
                  </p>
                  <div className="space-y-2 opacity-40 pointer-events-none select-none" aria-hidden>
                    {["Overall Readiness", "Profile Completeness"].map(label => (
                      <div key={label} className="space-y-1">
                        <div className="flex justify-between text-xs"><span>{label}</span><span>—%</span></div>
                        <div className="h-1.5 bg-muted rounded-full" />
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 p-2.5 bg-muted/40 rounded-xl border border-border/30 text-xs text-muted-foreground">
                    <Lock className="w-3 h-3 shrink-0 text-amber-400" />
                    Complete 1 prep session to unlock
                    <Link href="/portal/prep" className="ml-auto shrink-0">
                      <Button size="sm" className="h-6 text-[10px] px-2">Start Prep Session</Button>
                    </Link>
                  </div>
                </div>
              ) : benchmarkData === null ? (
                /* Loading */
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : !benchmarkData.available ? (
                /* Not enough data yet */
                <div className="space-y-2 py-2">
                  <div className="flex items-center gap-2 p-3 bg-muted/30 rounded-xl border border-border/30 text-xs text-muted-foreground">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                    <span>
                      Benchmark comparison is not available yet. We're still building enough comparison data.
                      {" "}({benchmarkData.count}/{benchmarkData.threshold} candidates needed)
                    </span>
                  </div>
                </div>
              ) : !benchmarkData.averages ? null : (
                /* Real aggregate data */
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Based on anonymised data from {benchmarkData.count} completed interviews.
                    {benchmarkData.showPercentiles ? " Percentile ranges shown." : " Showing broad averages."}
                  </p>
                  <div className="space-y-3">
                    {/* Readiness comparison */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Overall Readiness</span>
                        <span className="font-medium">
                          You: <span className="text-primary">{readinessScore}%</span>
                          {" · "}Avg: {benchmarkData.averages.readiness}%
                          {benchmarkData.showPercentiles && benchmarkData.averages.p25 !== null && (
                            <span className="text-muted-foreground"> (P25–P75: {benchmarkData.averages.p25}–{benchmarkData.averages.p75})</span>
                          )}
                        </span>
                      </div>
                      <div className="relative h-2 bg-muted rounded-full overflow-hidden">
                        {/* Average marker */}
                        <div
                          className="absolute inset-y-0 left-0 bg-muted-foreground/30 rounded-full"
                          style={{ width: `${benchmarkData.averages.readiness}%` }}
                        />
                        {/* Your score */}
                        <div
                          className={`absolute inset-y-0 left-0 rounded-full transition-all ${readinessScore >= benchmarkData.averages.readiness ? "bg-emerald-400" : "bg-amber-400"}`}
                          style={{ width: `${Math.min(100, readinessScore)}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        {readinessScore > benchmarkData.averages.readiness
                          ? `You are ${Math.round(readinessScore - benchmarkData.averages.readiness)}% above the average`
                          : readinessScore === benchmarkData.averages.readiness
                          ? "You are at the average"
                          : `You are ${Math.round(benchmarkData.averages.readiness - readinessScore)}% below the average`}
                      </p>
                    </div>

                    {/* Profile completeness comparison */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">Profile Completeness</span>
                        <span className="font-medium">
                          You: <span className="text-primary">{completeness}%</span>
                          {" · "}Avg: {benchmarkData.averages.profileCompleteness}%
                        </span>
                      </div>
                      <div className="relative h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className="absolute inset-y-0 left-0 bg-muted-foreground/30 rounded-full"
                          style={{ width: `${benchmarkData.averages.profileCompleteness}%` }}
                        />
                        <div
                          className={`absolute inset-y-0 left-0 rounded-full transition-all ${completeness >= benchmarkData.averages.profileCompleteness ? "bg-cyan-400" : "bg-amber-400"}`}
                          style={{ width: `${Math.min(100, completeness)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground/60">All data is anonymised and aggregated. No individual candidate data is exposed.</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Opportunity Engine */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Rocket className="w-5 h-5 text-emerald-400" />Opportunity Engine
              </h2>
              <div className="flex items-center gap-1.5">
                {matchedCount > 0 && (
                  <Badge variant="outline" className="text-xs border-emerald-400/30 text-emerald-400">
                    {matchedCount} now hiring
                  </Badge>
                )}
                {futureCount > 0 && (
                  <Badge variant="outline" className="text-xs border-amber-400/30 text-amber-400">
                    {futureCount} coming soon
                  </Badge>
                )}
                {matchedCount === 0 && futureCount === 0 && opportunities.length > 0 && (
                  <Badge variant="outline" className="text-xs border-emerald-400/30 text-emerald-400">{opportunities.length} available</Badge>
                )}
              </div>
            </div>
            {/* Current open opportunities */}
            {opportunities.length > 0 && (
              <div className="space-y-3">
                {opportunities.map((opp, i) => (
                  <OpportunityCard key={opp.id} opp={opp} index={i} profile={profile} />
                ))}
                <div className="text-center pt-1">
                  <Link href="/careers">
                    <Button variant="ghost" size="sm" className="gap-1.5 text-xs text-muted-foreground">
                      Browse all open roles <ChevronRight className="w-3.5 h-3.5" />
                    </Button>
                  </Link>
                </div>
              </div>
            )}

            {/* No-profile prompt */}
            {oppsNoProfile && paths.length === 0 && (
              <Card className="border-dashed border-emerald-400/20">
                <CardContent className="flex flex-col items-center justify-center py-8 text-center gap-3">
                  <Rocket className="w-10 h-10 text-muted-foreground/30" />
                  <div>
                    <p className="font-medium text-foreground text-sm">Complete your profile to unlock matched roles</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      Tell us about your skills and career goals — we'll surface roles that actually fit.
                    </p>
                  </div>
                  <Link href="/portal/career/interview">
                    <Button size="sm" className="gap-1.5 text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-400/30 hover:bg-emerald-500/25">
                      <Rocket className="w-3.5 h-3.5" />Start career interview
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            )}

            {/* No matches but has profile */}
            {oppsNoMatches && opportunities.length === 0 && paths.length === 0 && (
              <Card className="border-dashed border-emerald-400/20">
                <CardContent className="flex flex-col items-center justify-center py-8 text-center gap-3">
                  <Rocket className="w-10 h-10 text-muted-foreground/30" />
                  <div>
                    <p className="font-medium text-foreground text-sm">No current openings match your profile</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">
                      We're constantly adding new roles. Browse all open positions or check back soon.
                    </p>
                  </div>
                  <Link href="/careers">
                    <Button size="sm" variant="outline" className="gap-1.5 text-xs border-emerald-400/30 text-emerald-400 hover:bg-emerald-400/10">
                      <Briefcase className="w-3.5 h-3.5" />Browse all open roles
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            )}

            {/* Fallback — no opportunities, no profile, no paths */}
            {!oppsNoProfile && !oppsNoMatches && opportunities.length === 0 && paths.length === 0 && (
              <Card className="border-dashed border-emerald-400/20">
                <CardContent className="flex flex-col items-center justify-center py-8 text-center gap-3">
                  <Rocket className="w-10 h-10 text-muted-foreground/30" />
                  <div>
                    <p className="font-medium text-muted-foreground text-sm">No open roles right now</p>
                    <p className="text-xs text-muted-foreground/60 mt-0.5">We'll surface matched opportunities as they become available</p>
                  </div>
                  <Link href="/careers">
                    <Button size="sm" variant="outline" className="gap-1.5 text-xs">
                      <Briefcase className="w-3.5 h-3.5" />Explore all roles
                    </Button>
                  </Link>
                </CardContent>
              </Card>
            )}

            {/* Future Role Targets — always shown when career paths exist */}
            {paths.length > 0 && (
              <div className="mt-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="flex-1 h-px bg-border/40" />
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest px-2 flex items-center gap-1.5">
                    <TrendingUp className="w-3 h-3 text-violet-400" />
                    Your Career Trajectory
                  </span>
                  <div className="flex-1 h-px bg-border/40" />
                </div>
                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                  Based on your goals and career interview, here are the roles you're building toward — and how close you are to qualifying for each one.
                </p>
                <div className="space-y-3">
                  {paths.slice(0, 3).map((path, i) => (
                    <FutureRoleCard
                      key={i}
                      path={path}
                      index={i}
                      profile={profile}
                      completeness={completeness}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Recording player — shown whenever the interview is done and a recording exists */}
      {profile.baselineInterviewCompleted && profile.recordingUrl && (
        <div className="mt-6">
          <RecordingPlayer durationSec={profile.recordingDurationSec} />
        </div>
      )}

      {/* Transcript & Analysis */}
      {profile.baselineInterviewCompleted && (profile.transcriptEnglish || profile.analysisEnglish) && (
        <TranscriptAnalysisPanel profile={profile} hasDonePrepSession={hasDonePrepSession} />
      )}
    </AppLayout>
  );
}
