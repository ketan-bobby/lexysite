/**
 * pages/recruiter/interviews/proctor-report.tsx — Interview Proctoring Report
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Detailed integrity report for a completed AI interview session. Shows all
 * proctoring events captured during the session to help the recruiter assess
 * whether the interview was conducted in good faith.
 *
 * ─── Proctoring events shown ─────────────────────────────────────────────────
 *   Tab Switches        — candidate left the interview tab (timestamp + count)
 *   Copy Attempts       — Ctrl+C / right-click detected during the session
 *   Camera Loss         — camera feed was lost (e.g. closed laptop)
 *   Face Not Detected   — AI face detection lost the candidate from frame
 *   MouseLeave          — mouse left the browser window
 *   Browser Blur        — window lost focus
 *   Full Screen Exit    — if fullscreen mode was required
 *
 * ─── Risk scoring ────────────────────────────────────────────────────────────
 * Each event type has a risk weight. The overall integrity score is 100 minus
 * the weighted sum of events, floored at 0. Badge colours:
 *   ≥ 80  → ShieldCheck (green) — Low Risk
 *   50–79 → ShieldAlert (amber) — Moderate Risk
 *   < 50  → ShieldX (red)      — High Risk
 *
 * ─── Data source ─────────────────────────────────────────────────────────────
 *   GET /api/interviews/:sessionId/proctor-report
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/interviews/:id/proctor-report
 */
import { useEffect, useState } from "react";
import { authHeaders } from "@/lib/api";
import { useRoute, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ArrowLeft, ShieldCheck, ShieldAlert, ShieldX,
  Eye, EyeOff, Copy, Clipboard, MousePointerClick,
  Camera, AlertTriangle, CheckCircle2, Loader2,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...opts,
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

interface ProctorReport {
  sessionId: string;
  integrityScore: number;
  totalEvents: number;
  tabSwitches: number;
  copyEvents: number;
  pasteEvents: number;
  noFaceEvents: number;
  multiFace: number;
  suspicious: number;
  violations: string[];
  trustLevel: "high" | "medium" | "low";
  events: ProctorEvent[];
}

interface ProctorEvent {
  type: string;
  detail: string | null;
  ts: string;
  faceCount?: number | null;
  faceVisible?: boolean | null;
  suspiciousActivity?: string | null;
  visionNotes?: string | null;
  visionError?: string;
}

// Circular SVG gauge for the integrity score; colour shifts green→amber→red.
// Proctoring integrity-score band (0–100 integrity; own cutoffs, not the match/fit band).
const PROCTOR_STRONG = 85, PROCTOR_MODERATE = 60;
function ScoreRing({ score }: { score: number }) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  // Dash offset draws only the arc proportional to score (0 = empty, full circ = 0%).
  const progress = circ - (score / 100) * circ;
  const color = score >= PROCTOR_STRONG ? "#10b981" : score >= PROCTOR_MODERATE ? "#f59e0b" : "#ef4444";
  return (
    <div className="relative w-32 h-32 mx-auto">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="10"
          strokeDasharray={circ} strokeDashoffset={progress}
          strokeLinecap="round" style={{ transition: "stroke-dashoffset 1s ease" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-black" style={{ color }}>{score}</span>
        <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">/ 100</span>
      </div>
    </div>
  );
}

// High/Medium/Low trust pill derived from the overall integrity level.
function TrustBadge({ level }: { level: string }) {
  if (level === "high") return (
    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-sm px-4 py-1.5 font-bold gap-1.5">
      <ShieldCheck className="w-4 h-4" /> High Trust
    </Badge>
  );
  if (level === "medium") return (
    <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-sm px-4 py-1.5 font-bold gap-1.5">
      <ShieldAlert className="w-4 h-4" /> Medium Trust
    </Badge>
  );
  return (
    <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-sm px-4 py-1.5 font-bold gap-1.5">
      <ShieldX className="w-4 h-4" /> Low Trust
    </Badge>
  );
}

// Display metadata (label, icon, colours) per proctoring event type.
const EVENT_META: Record<string, { label: string; icon: React.ReactNode; color: string; bg: string }> = {
  tab_switch:  { label: "Tab Switch",  icon: <Eye className="w-3.5 h-3.5" />,             color: "text-red-400",    bg: "bg-red-500/10 border-red-500/20" },
  copy:        { label: "Copy",        icon: <Copy className="w-3.5 h-3.5" />,             color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
  paste:       { label: "Paste",       icon: <Clipboard className="w-3.5 h-3.5" />,        color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
  right_click: { label: "Right-click", icon: <MousePointerClick className="w-3.5 h-3.5" />,color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
  snapshot:    { label: "Face Check",  icon: <Camera className="w-3.5 h-3.5" />,           color: "text-sky-400",    bg: "bg-sky-500/10 border-sky-500/20" },
};

// Renders one proctoring event; face-check snapshots get extra OK/anomaly badges.
function EventRow({ ev }: { ev: ProctorEvent }) {
  const meta = EVENT_META[ev.type] ?? { label: ev.type, icon: <AlertTriangle className="w-3.5 h-3.5" />, color: "text-muted-foreground", bg: "bg-muted/20 border-border/30" };
  const time = new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const isSnap = ev.type === "snapshot";
  const snapOk = isSnap && ev.faceVisible === true && !ev.suspiciousActivity;
  const snapBad = isSnap && (ev.faceVisible === false || ev.suspiciousActivity);

  return (
    <div className={cn("flex items-start gap-3 p-3 rounded-xl border text-sm", meta.bg)}>
      <div className={cn("mt-0.5 shrink-0", meta.color)}>{meta.icon}</div>
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("font-semibold", meta.color)}>{meta.label}</span>
          <span className="text-muted-foreground text-xs">{time}</span>
          {isSnap && snapOk  && <span className="text-[10px] bg-emerald-500/15 text-emerald-400 rounded-full px-2 py-0.5 font-semibold">✓ Face detected</span>}
          {isSnap && snapBad && <span className="text-[10px] bg-red-500/15 text-red-400 rounded-full px-2 py-0.5 font-semibold">⚠ Anomaly</span>}
        </div>
        {ev.detail && <p className="text-muted-foreground text-xs leading-relaxed">{ev.detail}</p>}
        {isSnap && ev.visionNotes && <p className="text-xs text-sky-300/80 italic">{ev.visionNotes}</p>}
        {isSnap && ev.suspiciousActivity && <p className="text-xs text-red-400 font-medium">⚠ {ev.suspiciousActivity}</p>}
        {isSnap && ev.visionError && <p className="text-xs text-muted-foreground/50 italic">{ev.visionError}</p>}
      </div>
      {isSnap && typeof ev.faceCount === "number" && (
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          <span className="font-semibold">{ev.faceCount}</span> face{ev.faceCount !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

// Summary tile for an event-type count; turns red when a flagged count is > 0.
function StatCard({ icon, label, value, flagged }: { icon: React.ReactNode; label: string; value: number; flagged?: boolean }) {
  return (
    <div className={cn(
      "rounded-2xl border p-4 flex flex-col items-center gap-2 text-center",
      flagged && value > 0 ? "bg-red-500/5 border-red-500/20" : "bg-card/50 border-border/40"
    )}>
      <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center", flagged && value > 0 ? "bg-red-500/15 text-red-400" : "bg-muted/40 text-muted-foreground")}>
        {icon}
      </div>
      <div className={cn("text-2xl font-black", flagged && value > 0 ? "text-red-400" : "text-foreground")}>{value}</div>
      <div className="text-[11px] text-muted-foreground font-medium uppercase tracking-wider leading-tight">{label}</div>
    </div>
  );
}

// Full proctoring report page: integrity score, trust level, event timeline + stats.
export default function ProctoringReport() {
  const [, params] = useRoute("/interviews/:id/proctor-report");
  const [, navigate] = useLocation();
  const sessionId = params?.id ?? "";

  const [report, setReport] = useState<ProctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    apiFetch<ProctorReport>(`/interviews/${sessionId}/proctor-report`)
      .then(r => { setReport(r); setLoading(false); })
      .catch(() => { setError("Failed to load proctoring report."); setLoading(false); });
  }, [sessionId]);

  if (loading) return (
    <div className="flex items-center justify-center h-screen bg-background">
      <Loader2 className="w-8 h-8 animate-spin text-primary" />
    </div>
  );

  if (error || !report) return (
    <div className="flex flex-col items-center justify-center h-screen bg-background gap-3">
      <ShieldX className="w-12 h-12 text-muted-foreground" />
      <p className="text-muted-foreground">{error ?? "Report not found."}</p>
    </div>
  );

  const filterTypes = ["all", "tab_switch", "copy", "paste", "right_click", "snapshot"];
  const filtered = filter === "all" ? report.events : report.events.filter(e => e.type === filter);
  const violations = report.violations.length > 0 ? report.violations : null;

  return (
    <div className="min-h-screen text-foreground">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur border-b border-border/40">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center gap-4">
          <button onClick={() => navigate(`/interviews/${sessionId}`)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-bold">Proctoring Report</h1>
            <p className="text-xs text-muted-foreground font-mono">{sessionId}</p>
          </div>
          <TrustBadge level={report.trustLevel} />
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">

        {/* Score + summary */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
          <div className="md:col-span-1 flex flex-col items-center gap-3">
            <ScoreRing score={report.integrityScore} />
            <p className="text-sm font-semibold text-muted-foreground">Integrity Score</p>
          </div>
          <div className="md:col-span-2 space-y-4">
            {violations ? (
              <div className="bg-red-500/8 border border-red-500/20 rounded-2xl p-4 space-y-2">
                <div className="flex items-center gap-2 text-red-400 font-semibold text-sm">
                  <AlertTriangle className="w-4 h-4" /> Violations Detected
                </div>
                <ul className="space-y-1">
                  {violations.map((v, i) => (
                    <li key={i} className="text-sm text-red-300 flex items-center gap-2">
                      <span className="w-1 h-1 rounded-full bg-red-400 shrink-0" />
                      {v.charAt(0).toUpperCase() + v.slice(1)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="bg-emerald-500/8 border border-emerald-500/20 rounded-2xl p-4 flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <p className="text-sm text-emerald-300 font-medium">No violations detected. Session appears clean.</p>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{report.totalEvents}</span> proctoring events captured
              during this session.
            </p>
          </div>
        </div>

        {/* Stats grid */}
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-4">Signal Breakdown</h2>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
            <StatCard icon={<Eye className="w-4 h-4" />}             label="Tab Switches"  value={report.tabSwitches}  flagged />
            <StatCard icon={<Copy className="w-4 h-4" />}            label="Copy Attempts" value={report.copyEvents}   flagged />
            <StatCard icon={<Clipboard className="w-4 h-4" />}       label="Pastes"        value={report.pasteEvents}  flagged />
            <StatCard icon={<EyeOff className="w-4 h-4" />}          label="No Face"       value={report.noFaceEvents} flagged />
            <StatCard icon={<Camera className="w-4 h-4" />}          label="Multi-Face"    value={report.multiFace}    flagged />
            <StatCard icon={<AlertTriangle className="w-4 h-4" />}   label="Suspicious"    value={report.suspicious}   flagged />
          </div>
        </div>

        {/* Event timeline */}
        <div>
          <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Event Timeline</h2>
            <div className="flex gap-1.5 flex-wrap">
              {filterTypes.map(t => (
                <button key={t} onClick={() => setFilter(t)}
                  className={cn(
                    "text-[11px] font-semibold px-3 py-1 rounded-full border transition-colors capitalize",
                    filter === t
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-muted/20 text-muted-foreground border-border/40 hover:border-primary/40"
                  )}>
                  {t === "all" ? `All (${report.events.length})` : (EVENT_META[t]?.label ?? t)}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">No events of this type.</div>
          ) : (
            <div className="space-y-2">
              {filtered.map((ev, i) => <EventRow key={i} ev={ev} />)}
            </div>
          )}
        </div>

        {/* Session info */}
        <Card className="border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Session Info</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Session ID</span>
              <span className="font-mono text-xs">{report.sessionId}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Total Events</span>
              <span className="font-semibold">{report.totalEvents}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Integrity Score</span>
              <span className={cn("font-bold",
                report.integrityScore >= PROCTOR_STRONG ? "text-emerald-400" :
                report.integrityScore >= PROCTOR_MODERATE ? "text-yellow-400" : "text-red-400"
              )}>{report.integrityScore}/100</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Trust Level</span>
              <TrustBadge level={report.trustLevel} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
