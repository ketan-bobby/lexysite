/**
 * pages/recruiter/anti-ghost/index.tsx — Anti-Ghosting Dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Central command for the anti-ghosting system: lists active ghosting alerts,
 * shows the nurture pool, and lets recruiters configure the nurture sequence
 * and manually trigger scans.
 *
 * ─── Tabs ────────────────────────────────────────────────────────────────────
 *   Alerts        — open ghosting_alerts sorted by risk level (critical /
 *                   high / medium / low). Each alert shows the candidate,
 *                   stage, days-since-last-contact, and recommended action.
 *   Nurture Pool  — candidates currently enrolled in the nurture sequence
 *                   with per-step progress indicators
 *   Pipeline Health — ghosting rate per stage, conversion rates
 *   Config        — nurture sequence step editor (delay, tone, channel)
 *
 * ─── Key interactions ────────────────────────────────────────────────────────
 *   "Resolve" alert     — POST /api/anti-ghost/alerts/:id/resolve
 *   "Add to Nurture"    — POST /api/anti-ghost/nurture-pool
 *   "Scan Now"          — POST /api/anti-ghost/scan
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/anti-ghost
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { formatDistanceToNow, parseISO } from "date-fns";
import {
  Ghost, AlertTriangle, CheckCircle2, Clock, RefreshCw,
  Users, Zap, HeartPulse, ArrowRight, ChevronLeft,
  UserX, Activity, ChevronDown, ChevronUp, Plus,
  CircleAlert, TrendingDown, Hourglass, MapPin, Briefcase,
  Bell, Shield,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@workspace/react-hooks/use-toast";
import { cn, pluralize } from "@/lib/utils";
import { authHeaders } from "@/lib/api";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

async function apiFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(),
    },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || `API ${res.status}`);
  }
  return res.json();
}

// ─── Types ────────────────────────────────────────────────────────────────────
type AlertStatus   = "open" | "acknowledged" | "resolved" | "dismissed";
type AlertSeverity = "low" | "medium" | "high" | "critical";
type AlertType     = "interview_no_show" | "outreach_dropout" | "stale_pipeline" | "offer_limbo" | "interview_stale";

interface JobSummary {
  jobId:      string;
  title:      string;
  status:     string;
  location:   string | null;
  department: string | null;
  openAlerts: number;
  critical:   number;
  high:       number;
  medium:     number;
  healthScore: number;
  byType: Record<string, number>;
}

interface GhostingAlert {
  id:              string;
  type:            AlertType;
  severity:        AlertSeverity;
  status:          AlertStatus;
  candidateId:     string | null;
  candidateName:   string | null;
  description:     string;
  aiRecommendation: string | null;
  suggestedAction: string | null;
  resolvedAt:      string | null;
  createdAt:       string;
}

interface NurturePoolMember {
  id:              string;
  candidateId:     string;
  candidateName:   string | null;
  candidateEmail:  string | null;
  status:          string;
  cadenceDays:     number;
  reason:          string | null;
  lastContactedAt: string | null;
  nextContactAt:   string | null;
  totalTouchpoints: number;
  addedAt:         string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const ALERT_CONFIG: Record<AlertType, { label: string; icon: any; color: string; bgColor: string }> = {
  interview_no_show: { label: "No-Show",        icon: UserX,       color: "text-red-400",    bgColor: "bg-red-500/10 border-red-500/30" },
  outreach_dropout:  { label: "Outreach Ghost",  icon: Ghost,       color: "text-purple-400", bgColor: "bg-purple-500/10 border-purple-500/30" },
  stale_pipeline:    { label: "Stale Pipeline",  icon: TrendingDown, color: "text-orange-400", bgColor: "bg-orange-500/10 border-orange-500/30" },
  offer_limbo:       { label: "Offer Limbo",     icon: Hourglass,   color: "text-yellow-400", bgColor: "bg-yellow-500/10 border-yellow-500/30" },
  interview_stale:   { label: "Interview Stall", icon: Hourglass,   color: "text-amber-400",  bgColor: "bg-amber-500/10 border-amber-500/30" },
};

const SEVERITY_COLORS: Record<AlertSeverity, string> = {
  low:      "bg-slate-500/20 text-slate-400",
  medium:   "bg-orange-500/20 text-orange-400",
  high:     "bg-red-500/20 text-red-400",
  critical: "bg-red-600/30 text-red-300 animate-pulse",
};

const STATUS_COLORS: Record<AlertStatus, string> = {
  open:         "bg-red-500/20 text-red-400",
  acknowledged: "bg-blue-500/20 text-blue-400",
  resolved:     "bg-green-500/20 text-green-400",
  dismissed:    "bg-slate-500/20 text-slate-500",
};

const ACTION_LABEL: Record<string, string> = {
  call:       "📞 Call Candidate",
  nurture:    "🌱 Move to Nurture",
  re_engage:  "📧 Re-Engage",
  close:      "❌ Close Application",
  reschedule: "📅 Reschedule",
};

// Engagement-health bands — a candidate-responsiveness quantity, not match fit.
const HEALTH_STRONG = 85;
const HEALTH_MODERATE = 65;
const HEALTH_WEAK = 40;
function healthColor(score: number) {
  if (score >= HEALTH_STRONG) return "text-emerald-400";
  if (score >= HEALTH_MODERATE) return "text-yellow-400";
  if (score >= HEALTH_WEAK) return "text-orange-400";
  return "text-red-400";
}

function healthLabel(score: number) {
  if (score >= HEALTH_STRONG) return "Healthy";
  if (score >= HEALTH_MODERATE) return "Watch";
  if (score >= HEALTH_WEAK) return "At Risk";
  return "Critical";
}

// ─── Work-order card ──────────────────────────────────────────────────────────
function JobCard({ job, onClick }: { job: JobSummary; onClick: () => void }) {
  const hColor = healthColor(job.healthScore);
  const hLabel = healthLabel(job.healthScore);
  const pct    = job.healthScore;

  return (
    <button
      onClick={onClick}
      className="w-full text-left group"
    >
      <Card className={cn(
        "border transition-all duration-200 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5",
        job.critical > 0 ? "border-red-500/30" : job.high > 0 ? "border-orange-500/20" : "border-border/60",
      )}>
        <CardContent className="p-5">
          <div className="flex items-start gap-4">
            {/* Health ring */}
            <div className="flex flex-col items-center gap-1 shrink-0">
              <span className={cn("text-3xl font-bold tabular-nums", hColor)}>{job.healthScore}</span>
              <span className="text-[10px] text-muted-foreground">/100</span>
              <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", hColor, "border-current")}>
                {hLabel}
              </Badge>
            </div>

            {/* Job info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-base leading-tight group-hover:text-primary transition-colors">
                    {job.title}
                  </h3>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    {job.department && (
                      <span className="flex items-center gap-1">
                        <Briefcase className="w-3 h-3" /> {job.department}
                      </span>
                    )}
                    {job.location && (
                      <span className="flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> {job.location}
                      </span>
                    )}
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors mt-1 shrink-0" />
              </div>

              {/* Health bar */}
              <div className="mt-3 h-1.5 rounded-full bg-white/8 overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all duration-700",
                    pct >= HEALTH_STRONG ? "bg-emerald-400" : pct >= HEALTH_MODERATE ? "bg-yellow-400" : pct >= HEALTH_WEAK ? "bg-orange-400" : "bg-red-400"
                  )}
                  style={{ width: `${pct}%` }}
                />
              </div>

              {/* Alert counts */}
              <div className="flex items-center gap-3 mt-3 flex-wrap">
                {job.openAlerts === 0 ? (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" /> No open alerts
                  </span>
                ) : (
                  <>
                    <span className="text-xs text-muted-foreground font-medium">{pluralize(job.openAlerts, "open alert")}</span>
                    {job.critical > 0 && (
                      <Badge className="text-[10px] px-1.5 py-0.5 bg-red-600/30 text-red-300 animate-pulse">
                        {job.critical} Critical
                      </Badge>
                    )}
                    {job.high > 0 && (
                      <Badge className="text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400">
                        {job.high} High
                      </Badge>
                    )}
                    {job.medium > 0 && (
                      <Badge className="text-[10px] px-1.5 py-0.5 bg-orange-500/20 text-orange-400">
                        {job.medium} Medium
                      </Badge>
                    )}
                  </>
                )}

                {/* Alert type breakdown */}
                {job.openAlerts > 0 && (
                  <div className="flex items-center gap-2 ml-auto">
                    {Object.entries(job.byType).filter(([, n]) => n > 0).map(([type, n]) => {
                      const cfg = ALERT_CONFIG[type as AlertType];
                      if (!cfg) return null;
                      const Icon = cfg.icon;
                      return (
                        <span key={type} className={cn("flex items-center gap-1 text-[10px]", cfg.color)}>
                          <Icon className="w-3 h-3" />{n}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

// ─── Alert card ───────────────────────────────────────────────────────────────
function AlertCard({ alert, onUpdate, onNurture }: {
  alert: GhostingAlert;
  onUpdate: (id: string, status: AlertStatus) => void;
  onNurture: (candidateId: string, candidateName: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const cfg  = ALERT_CONFIG[alert.type] ?? ALERT_CONFIG.stale_pipeline;
  const Icon = cfg.icon;

  return (
    <Card className={`border ${cfg.bgColor} transition-all`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-background/50 flex-shrink-0 mt-0.5">
            <Icon className={`w-4 h-4 ${cfg.color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="font-semibold text-sm">{alert.candidateName ?? "Unknown Candidate"}</span>
              <Badge className={`text-[10px] px-1.5 py-0.5 ${SEVERITY_COLORS[alert.severity]}`}>
                {alert.severity.toUpperCase()}
              </Badge>
              <Badge className={`text-[10px] px-1.5 py-0.5 ${STATUS_COLORS[alert.status]}`}>
                {alert.status}
              </Badge>
              <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                {formatDistanceToNow(parseISO(alert.createdAt), { addSuffix: true })}
              </span>
            </div>
            <Badge variant="outline" className={`text-[10px] mb-2 ${cfg.color}`}>{cfg.label}</Badge>
            <p className="text-xs text-muted-foreground leading-relaxed">{alert.description}</p>

            {expanded && alert.aiRecommendation && (
              <div className="mt-3 p-3 rounded-lg bg-primary/5 border border-primary/20">
                <p className="text-[11px] font-medium text-primary mb-1 flex items-center gap-1">
                  <Zap className="w-3 h-3" /> AI Recommendation
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">{alert.aiRecommendation}</p>
              </div>
            )}

            {alert.status === "open" && (
              <div className="flex gap-2 mt-3 flex-wrap">
                {alert.suggestedAction && (
                  <Button size="sm" className="h-7 text-xs gap-1.5" variant="default">
                    {ACTION_LABEL[alert.suggestedAction] ?? alert.suggestedAction}
                  </Button>
                )}
                {alert.candidateId && (
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
                    onClick={() => onNurture(alert.candidateId!, alert.candidateName ?? "Candidate")}>
                    <Plus className="w-3 h-3" /> Nurture Pool
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-7 text-xs"
                  onClick={() => onUpdate(alert.id, "acknowledged")}>Acknowledge</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground"
                  onClick={() => onUpdate(alert.id, "resolved")}>Resolve</Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground"
                  onClick={() => onUpdate(alert.id, "dismissed")}>Dismiss</Button>
              </div>
            )}
          </div>
          <Button size="sm" variant="ghost" aria-label={expanded ? "Collapse" : "Expand"} aria-expanded={expanded} className="h-7 w-7 p-0 flex-shrink-0"
            onClick={() => setExpanded(v => !v)}>
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Job detail view ──────────────────────────────────────────────────────────
function JobDetailView({ job, onBack }: { job: JobSummary; onBack: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<AlertType | "all">("all");

  const { data: alerts = [], isLoading } = useQuery<GhostingAlert[]>({
    queryKey: ["ghosting-alerts", job.jobId],
    queryFn: () => apiFetch(`/ghosting/alerts?jobId=${job.jobId}`),
    refetchInterval: 30_000,
  });

  const { data: nurturePool = [] } = useQuery<NurturePoolMember[]>({
    queryKey: ["nurture-pool", job.jobId],
    queryFn: () => apiFetch("/nurture-pool"),
  });

  const scanMut = useMutation({
    mutationFn: () => apiFetch("/ghosting/scan", { method: "POST" }),
    onSuccess: (data: any) => {
      toast({ title: `Scan complete — ${data.total} new alert(s)` });
      qc.invalidateQueries({ queryKey: ["ghosting-alerts", job.jobId] });
      qc.invalidateQueries({ queryKey: ["ghosting-jobs"] });
    },
    onError: (err: any) => toast({ title: "Scan failed", description: err.message, variant: "destructive" }),
  });

  const updateAlertMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AlertStatus }) =>
      apiFetch(`/ghosting/alerts/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ghosting-alerts", job.jobId] });
      qc.invalidateQueries({ queryKey: ["ghosting-jobs"] });
    },
  });

  const nurtureMut = useMutation({
    mutationFn: ({ candidateId, reason }: { candidateId: string; reason: string }) =>
      apiFetch("/nurture-pool", { method: "POST", body: JSON.stringify({ candidateId, reason, cadenceDays: 90 }) }),
    onSuccess: () => {
      toast({ title: "Added to nurture pool" });
      qc.invalidateQueries({ queryKey: ["nurture-pool"] });
    },
  });

  const openAlerts    = alerts.filter(a => a.status === "open");
  const filtered      = openAlerts.filter(a => typeFilter === "all" || a.type === typeFilter);
  const resolvedToday = alerts.filter(a => a.status === "resolved" && a.resolvedAt &&
    new Date(a.resolvedAt) > new Date(Date.now() - 86_400_000));

  const hColor = healthColor(job.healthScore);

  return (
    <>
      {/* Back + header */}
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5 text-muted-foreground hover:text-foreground -ml-2">
          <ChevronLeft className="w-4 h-4" /> All Work Orders
        </Button>
      </div>

      <div className="flex flex-col md:flex-row justify-between items-start gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Ghost className="w-5 h-5 text-primary" />
            <h2 className="text-2xl font-bold">{job.title}</h2>
            <Badge variant="outline" className={cn("text-xs ml-1", hColor, "border-current")}>
              {healthLabel(job.healthScore)} · {job.healthScore}/100
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Showing ghosting alerts for this work order only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/recruiter/jobs/${job.jobId}?tab=anti-ghost`}>
            <Button variant="outline" size="sm" className="gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" /> Open Work Order
            </Button>
          </Link>
          <Button size="sm" className="gap-2" onClick={() => scanMut.mutate()} disabled={scanMut.isPending}>
            {scanMut.isPending ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {scanMut.isPending ? "Scanning…" : "Scan Now"}
          </Button>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { label: "Open Alerts",    value: openAlerts.length,     icon: AlertTriangle, color: "text-red-400 bg-red-500/10" },
          { label: "Critical",       value: job.critical,           icon: CircleAlert,   color: "text-red-300 bg-red-600/10" },
          { label: "Nurture Pool",   value: nurturePool.filter(m => m.status === "active").length, icon: Users, color: "text-blue-400 bg-blue-500/10" },
          { label: "Resolved Today", value: resolvedToday.length,   icon: CheckCircle2,  color: "text-emerald-400 bg-emerald-500/10" },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="p-3 flex items-center gap-2">
              <div className={`p-1.5 rounded-lg ${s.color}`}><s.icon className="w-3.5 h-3.5" /></div>
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-xl font-bold">{s.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Type filter pills */}
      <div className="flex flex-wrap gap-2 mb-4">
        {(["all", "interview_no_show", "outreach_dropout", "stale_pipeline", "offer_limbo", "interview_stale"] as const).map(t => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            className={cn(
              "text-xs px-3 py-1.5 rounded-full border transition-all",
              typeFilter === t
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-primary/50",
            )}
          >
            {t === "all" ? "All Types" : ALERT_CONFIG[t].label}
          </button>
        ))}
      </div>

      {/* Alert list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading alerts…
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed border-emerald-500/30">
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-400/50" />
            <p className="font-medium text-sm">No open alerts for this work order</p>
            <p className="text-xs text-muted-foreground">Candidates in this pipeline are all progressing normally.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map(alert => (
            <AlertCard
              key={alert.id}
              alert={alert}
              onUpdate={(id, status) => updateAlertMut.mutate({ id, status })}
              onNurture={(candidateId, candidateName) =>
                nurtureMut.mutate({ candidateId, reason: `Ghosted on ${candidateName}` })}
            />
          ))}
        </div>
      )}
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function AntiGhostPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);

  const { data: jobs = [], isLoading } = useQuery<JobSummary[]>({
    queryKey: ["ghosting-jobs"],
    queryFn: () => apiFetch("/ghosting/jobs"),
    refetchInterval: 60_000,
  });

  const scanMut = useMutation({
    mutationFn: () => apiFetch("/ghosting/scan", { method: "POST" }),
    onSuccess: (data: any) => {
      toast({ title: `Scan complete — ${data.total} new alert(s) found` });
      qc.invalidateQueries({ queryKey: ["ghosting-jobs"] });
    },
    onError: (err: any) => toast({ title: "Scan failed", description: err.message, variant: "destructive" }),
  });

  const totalOpenAlerts = jobs.reduce((sum, j) => sum + j.openAlerts, 0);
  const criticalJobs    = jobs.filter(j => j.critical > 0).length;

  return (
    <AppLayout>
      {selectedJob ? (
        <JobDetailView job={selectedJob} onBack={() => setSelectedJob(null)} />
      ) : (
        <>
          {/* Header */}
          <div className="flex flex-col md:flex-row justify-between items-start gap-4 mb-6">
            <div>
              <button
                onClick={() => window.history.back()}
                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
              <h1 className="page-title flex items-center gap-2">
                <Ghost className="w-6 h-6 text-primary" />
                Anti-Ghost Monitor
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Work orders with the Anti-Ghost agent active — sorted by health score.
              </p>
            </div>
            <Button className="gap-2" onClick={() => scanMut.mutate()} disabled={scanMut.isPending}>
              {scanMut.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {scanMut.isPending ? "Scanning…" : "Run Scan Now"}
            </Button>
          </div>

          {/* Summary strip */}
          {jobs.length > 0 && (
            <div className="grid grid-cols-3 gap-3 mb-6">
              <Card>
                <CardContent className="p-3 flex items-center gap-2">
                  <div className="p-1.5 rounded-lg text-primary bg-primary/10"><Shield className="w-3.5 h-3.5" /></div>
                  <div>
                    <p className="text-xs text-muted-foreground">Monitored</p>
                    <p className="text-xl font-bold">{jobs.length}</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 flex items-center gap-2">
                  <div className="p-1.5 rounded-lg text-red-400 bg-red-500/10"><Bell className="w-3.5 h-3.5" /></div>
                  <div>
                    <p className="text-xs text-muted-foreground">Open Alerts</p>
                    <p className="text-xl font-bold">{totalOpenAlerts}</p>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 flex items-center gap-2">
                  <div className="p-1.5 rounded-lg text-red-300 bg-red-600/10"><CircleAlert className="w-3.5 h-3.5" /></div>
                  <div>
                    <p className="text-xs text-muted-foreground">Critical WOs</p>
                    <p className="text-xl font-bold">{criticalJobs}</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* Work order list */}
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
              <RefreshCw className="w-4 h-4 animate-spin" /> Loading monitored work orders…
            </div>
          ) : jobs.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-16 flex flex-col items-center gap-4 text-center">
                <div className="w-16 h-16 rounded-2xl bg-muted/40 flex items-center justify-center">
                  <Ghost className="w-8 h-8 text-muted-foreground/40" />
                </div>
                <div>
                  <p className="font-semibold text-base">No work orders are being monitored yet</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                    Open a work order, go to the Workflow tab, enable the Anti-Ghost agent, and launch the pipeline.
                  </p>
                </div>
                <Link href="/jobs">
                  <Button variant="outline" className="gap-2 mt-1">
                    <ArrowRight className="w-4 h-4" /> Go to Work Orders
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {jobs.map(job => (
                <JobCard key={job.jobId} job={job} onClick={() => setSelectedJob(job)} />
              ))}
            </div>
          )}
        </>
      )}
    </AppLayout>
  );
}
