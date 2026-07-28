/**
 * portal/index.tsx — Candidate portal dashboard (the "home" screen).
 *
 * This page aggregates real-time data from three API endpoints and renders a
 * rich, opinionated view of the candidate's career health:
 *
 *  1. Career Snapshot     — overall score ring, current role, target path.
 *  2. Next Best Actions   — AI-generated priority recommendations from the
 *                           career recommendations engine.
 *  3. Career Paths        — 3 curated paths (achievable → stretch).
 *  4. Skill Gap Radar     — critical skills ranked by career impact.
 *  5. Interview Readiness — communication / technical / problem-solving bars.
 *  6. Opportunities       — top matching open roles from the job index.
 *  7. Recruiter Visibility — profile views, saves, search appearances.
 *  8. Notifications        — unread alert count.
 *
 * All sections fall back to mock data when the API returns nothing, ensuring
 * the page always looks useful during development or first-run.
 */

import { useEffect, useState } from "react";
import { pluralize } from "@/lib/utils";
import { bandBy } from "@/lib/score-band";
import { AppLayout } from "@/components/layout/AppLayout";
import { Link } from "wouter";
import {
  Sparkles, Target, TrendingUp, Briefcase, Brain, CheckCircle2,
  RefreshCw, ArrowRight, Zap, Star, Mic, BarChart2,
  Shield, Eye, ChevronRight, Play, Lightbulb, Search,
  MessageSquare, AlertCircle, BookOpen, Activity, Building2,
  Trophy, FileText, Send, Rocket, Flame, Globe, MapPin, Award, Lock,
} from "lucide-react";
import { apiBase, apiFetch } from "@/lib/api";
import { CandidateOpportunityPriorityList } from "@/components/portal/CandidateConnectionInsightPanel";
import { AiDisclosureBanner } from "@/components/portal/AiDisclosureBanner";

/* ── Engagement: icon name → lucide component (used by Achievements grid) ── */
const ACH_ICON: Record<string, React.ElementType> = {
  trophy: Trophy, sparkles: Sparkles, "file-text": FileText, mic: Mic,
  "check-circle-2": CheckCircle2, shield: Shield, target: Target, send: Send,
  rocket: Rocket, eye: Eye, star: Star, flame: Flame, zap: Zap,
};

/* ── Peer band → color (always positive, no red/discouraging tints) ── */
const BAND_STYLE: Record<string, string> = {
  "Top tier":          "text-amber-300 bg-amber-300/10 border-amber-300/30",
  "Top quarter":       "text-cyan-300 bg-cyan-300/10 border-cyan-300/30",
  "Above average":     "text-emerald-300 bg-emerald-300/10 border-emerald-300/30",
  "On track":          "text-violet-300 bg-violet-300/10 border-violet-300/30",
  "Building momentum": "text-sky-300 bg-sky-300/10 border-sky-300/30",
};

/* ─── helpers ──────────────────────────────────────────────────────────────── */
function ScoreRing({ value, size = 80, stroke = 7, color = "hsl(186 100% 52%)" }: {
  value: number; size?: number; stroke?: number; color?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (value / 100) * c;
  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(220 20% 18%)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color}
        strokeWidth={stroke} strokeDasharray={`${dash} ${c}`} strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.8s ease" }} />
    </svg>
  );
}

function Bar({ value, color = "bg-primary", label }: { value: number; color?: string; label?: string }) {
  return (
    <div className="space-y-1">
      {label && <div className="flex justify-between text-xs text-muted-foreground"><span>{label}</span><span className="font-medium text-foreground">{value}%</span></div>}
      <div className="h-1.5 rounded-full bg-border/50">
        <div className={`h-1.5 rounded-full ${color} transition-all duration-700`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

const VALID_PORTAL_HREFS = new Set([
  "/portal", "/portal/career", "/portal/prep", "/portal/interviews",
  "/portal/applications", "/portal/notifications", "/portal/career/interview",
]);
function safeHref(href?: string | null) {
  return href && VALID_PORTAL_HREFS.has(href) ? href : "/portal/career";
}

function Chip({ label, color = "bg-primary/10 text-primary border-primary/20" }: { label: string; color?: string }) {
  return <span className={`inline-block text-[11px] px-2 py-0.5 rounded-full border font-medium ${color}`}>{label}</span>;
}

function ActionBtn({ label, href, variant = "primary" }: { label: string; href: string; variant?: "primary" | "outline" }) {
  const cls = variant === "primary"
    ? "bg-primary text-primary-foreground hover:bg-primary/90"
    : "border border-border/60 text-foreground hover:bg-muted";
  return (
    <Link href={href} className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${cls}`}>
      {label} <ChevronRight className="w-3 h-3" />
    </Link>
  );
}

function SectionCard({ title, icon: Icon, iconColor = "text-primary", children, action }: {
  title: string; icon: React.ElementType; iconColor?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5 flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 ${iconColor}`} />
          <span className="text-sm font-semibold text-foreground">{title}</span>
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

const recIconMap: Record<string, React.ElementType> = {
  interview: Brain, profile: Sparkles, career: Target,
  learning: TrendingUp, research: Search, goal: Lightbulb,
  prep: BookOpen, refresh: RefreshCw,
};

const impactColors: Record<string, string> = {
  high: "text-violet-400 bg-violet-400/10 border-violet-400/20", // no red on a candidate's own action list
  medium: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  low: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
};


export default function CandidatePortal() {
  const [profile, setProfile] = useState<any>(null);
  const [opportunities, setOpportunities] = useState<any[]>([]);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [dashData, setDashData] = useState<any>(null);
  const [unread, setUnread] = useState(0);
  const [recsLoading, setRecsLoading] = useState(true);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState("");
  const [completingKey, setCompletingKey] = useState<string | null>(null);
  const [activityData, setActivityData] = useState<any>(null);
  const [activityRefreshing, setActivityRefreshing] = useState(false);
  const [engagement, setEngagement] = useState<any>(null);

  useEffect(() => {
    apiFetch(`${apiBase}/portal/engagement`)
      .then(r => r.json()).then(setEngagement).catch(() => {});
    apiFetch(`${apiBase}/portal/career-profile`)
      .then(r => r.json()).then(d => setProfile(d.data)).catch(() => {});
    apiFetch(`${apiBase}/portal/opportunities`)
      .then(r => r.json()).then(d => setOpportunities(d.data ?? [])).catch(() => {});
    apiFetch(`${apiBase}/portal/career-recommendations`)
      .then(r => r.json()).then(d => { setRecommendations(d.data ?? []); setRecsLoading(false); })
      .catch(() => setRecsLoading(false));
    apiFetch(`${apiBase}/portal/dashboard`)
      .then(r => r.json()).then(d => {
        setDashData(d);
        setUnread(d.unreadNotificationCount ?? 0);
      }).catch(() => {});
    apiFetch(`${apiBase}/portal/activity-status`)
      .then(r => r.json()).then(d => setActivityData(d)).catch(() => {});
  }, []);

  async function refreshActivity() {
    setActivityRefreshing(true);
    try {
      const res = await apiFetch(`${apiBase}/portal/refresh-activity`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setActivityData((prev: any) => ({ ...prev, ...data }));
      }
    } finally {
      setActivityRefreshing(false);
    }
  }

  /* "Things have changed" — candidate self-reports a new role/company. Saving
   * feeds the same congratulate/re-engage flow server-side (PUT career-profile
   * detects the change), then refreshes the activity clock. */
  const [changeOpen, setChangeOpen] = useState(false);
  const [changeCompany, setChangeCompany] = useState("");
  const [changeTitle, setChangeTitle] = useState("");
  const [changeSaving, setChangeSaving] = useState(false);
  const [changeSaved, setChangeSaved] = useState(false);

  async function submitSituationChange() {
    if (!changeCompany.trim() && !changeTitle.trim()) return;
    setChangeSaving(true);
    try {
      const body: any = {};
      if (changeCompany.trim()) body.currentCompany = changeCompany.trim();
      if (changeTitle.trim())   body.currentTitle   = changeTitle.trim();
      const res = await apiFetch(`${apiBase}/portal/career-profile`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setChangeSaved(true);
        setChangeOpen(false);
        setActivityData((prev: any) => prev ? {
          ...prev,
          activityStatus: "active", daysSince: 0,
          currentCompany: body.currentCompany ?? prev.currentCompany,
          currentTitle:   body.currentTitle   ?? prev.currentTitle,
        } : prev);
        setTimeout(() => setChangeSaved(false), 5000);
      }
    } finally {
      setChangeSaving(false);
    }
  }

  const p = profile;
  const opps = opportunities;
  const completeness = p?.profileCompleteness ?? 0;
  const readiness = dashData?.prepCompletion ?? 0;
  const overallScore = Math.round((completeness + readiness) / 2);

  async function confirmComplete(recKey: string) {
    setCompletingKey(recKey);
    try {
      await apiFetch(`${apiBase}/portal/recommendations/complete`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recKey, notes: pendingNote || null }),
      });
      setRecommendations(prev => prev.filter(r => r.recKey !== recKey));
      setPendingKey(null); setPendingNote("");
    } finally { setCompletingKey(null); }
  }

  const paths = p?.careerPaths ?? [];
  const pathDiffColor: Record<string, string> = {
    achievable: "text-emerald-400 border-emerald-400/30 bg-emerald-400/8",
    ambitious:  "text-cyan-400 border-cyan-400/30 bg-cyan-400/8",
    stretch:    "text-violet-400 border-violet-400/30 bg-violet-400/8",
  };

  /* ── render ───────────────────────────────────────────────────────────────── */
  return (
    <AppLayout>
      {/* T011a — informed-consent banner for AEDT use. Renders only when
          the candidate's resolved jurisdictions require disclosure and
          they have not yet acknowledged this exact templates+policy
          bundle on this device. */}
      <AiDisclosureBanner />

      {/* ── 1. CAREER SNAPSHOT ─────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border/50 bg-gradient-to-br from-primary/8 via-card to-card p-6 mb-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
          {/* Score ring */}
          <div className="flex items-center gap-5">
            <div className="relative shrink-0">
              <ScoreRing value={overallScore} size={80} />
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-black text-foreground leading-none">{overallScore}</span>
                <span className="text-[9px] text-muted-foreground uppercase tracking-wide">Score</span>
              </div>
              {/* Monthly delta pill — brochure slide 4: "your scores nudged up this month" */}
              {engagement?.skillScoreMonthlyDelta && engagement.skillScoreMonthlyDelta.delta !== 0 && (() => {
                const d = engagement.skillScoreMonthlyDelta.delta as number;
                const up = d > 0;
                return (
                  <div className={`absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap
                    ${up ? "bg-emerald-400/15 text-emerald-300 border-emerald-400/40"
                         : "bg-amber-400/15 text-amber-300 border-amber-400/40"}`}>
                    {up ? "▲" : "▼"} {Math.abs(d)} this month
                  </div>
                );
              })()}
            </div>
            <div>
              <p className="text-xs text-primary font-semibold uppercase tracking-widest mb-1">Career Snapshot</p>
              <h1 className="text-xl font-bold leading-tight">{p?.currentTitle ?? "Your Profile"}</h1>
              <p className="text-sm text-muted-foreground">{p?.currentCompany ?? ""}{p?.yearsExperience ? ` · ${p.yearsExperience} yrs experience` : ""}</p>
              {/* Never a bare low score: below 40 the ring is always paired with
                  the candidate's fastest next win, so the number reads as a
                  starting point rather than a verdict. */}
              {overallScore < 40 && (
                <p className="text-xs text-cyan-400 mt-1.5 font-medium">
                  {recommendations[0]?.label
                    ? <>Your fastest gain: <Link href={safeHref(recommendations[0].href)} className="underline underline-offset-2 hover:text-cyan-300">{recommendations[0].label}</Link></>
                    : <>Your fastest gain: <Link href="/portal/career/interview" className="underline underline-offset-2 hover:text-cyan-300">complete your baseline interview (~10 min)</Link></>}
                </p>
              )}
            </div>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-6 flex-wrap">
            {[
              { label: "Interview Ready", value: readiness, suffix: "%", color: "text-cyan-400" },
              { label: "Profile Complete", value: completeness, suffix: "%", color: "text-violet-400" },
              { label: "Best Role Match", value: opps[0]?._score != null ? opps[0]._score : "—", suffix: opps[0]?._score != null ? "%" : "", color: "text-emerald-400" },
            ].map(({ label, value, suffix, color }) => (
              <div key={label} className="text-center">
                <div className={`text-2xl font-black ${color}`}>{value}{suffix}</div>
                <div className="text-[10px] text-muted-foreground">{label}</div>
              </div>
            ))}
            {unread > 0 && (
              <Link href="/portal/notifications">
                <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-full px-3 py-1 cursor-pointer">
                  <AlertCircle className="w-3 h-3" /> {unread} alerts
                </div>
              </Link>
            )}
          </div>

          {/* Target path */}
          {paths?.[0] && (
            <div className="border-l border-border/40 pl-5 shrink-0 hidden lg:block">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Target Role</p>
              <p className="text-sm font-semibold">{paths[0].title}</p>
              <p className="text-xs text-muted-foreground">{paths[0].timeframe} · {paths[0].salaryRange}</p>
            </div>
          )}
        </div>
      </div>

      {/* ── PLATFORM ACTIVITY BANNER ──────────────────────────────────── */}
      {activityData && (() => {
        const status = activityData.activityStatus as string;
        const days   = activityData.daysSince as number;
        const cos    = activityData.companiesInterested as number;
        const badgeCls =
          status === "active"   ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/25" :
          status === "passive"  ? "bg-amber-400/10 text-amber-400 border-amber-400/25" :
                                  "bg-amber-400/10 text-amber-300 border-amber-400/25"; // never red — inactivity isn't failure
        const dot =
          status === "active"  ? "bg-emerald-400" :
          status === "passive" ? "bg-amber-400" : "bg-amber-300";
        const lastLabel =
          days === 0 ? "Active today" :
          days === 1 ? "Last active yesterday" :
          `Last active ${pluralize(days, "day")} ago`;
        const company = (activityData.currentCompany as string | null) ?? null;
        return (
          <div className="rounded-2xl border border-border/40 bg-card px-5 py-3.5 mb-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4 flex-wrap">
                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1 rounded-full border ${badgeCls}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </span>
                <span className="text-xs text-muted-foreground">{lastLabel}</span>
                {status !== "active" && (
                  <span className="text-xs text-foreground font-medium">
                    {company ? <>Still at <span className="text-cyan-400">{company}</span>? Still looking?</> : "Still looking?"}
                  </span>
                )}
                {cos > 0 && (
                  <span className="flex items-center gap-1.5 text-xs text-cyan-400">
                    <Building2 className="w-3.5 h-3.5" />
                    {pluralize(cos, "company has", "companies have")} your profile
                  </span>
                )}
              </div>
              {status !== "active" && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={refreshActivity}
                    disabled={activityRefreshing}
                    className="flex items-center gap-1.5 text-xs font-semibold px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-60"
                  >
                    {activityRefreshing
                      ? <><div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> Refreshing…</>
                      : <><Activity className="w-3 h-3" /> {company ? "Yes — still there, still looking" : "I'm still looking"}</>
                    }
                  </button>
                  <button
                    onClick={() => { setChangeOpen(v => !v); setChangeCompany(""); setChangeTitle(""); }}
                    className="flex items-center gap-1.5 text-xs font-semibold px-4 py-1.5 rounded-lg border border-border/60 text-foreground hover:bg-muted/40 transition-all"
                  >
                    <Briefcase className="w-3 h-3" /> Things have changed
                  </button>
                </div>
              )}
              {status === "active" && !changeSaved && (
                <span className="text-[10px] text-muted-foreground">Your profile is fully visible to recruiters.</span>
              )}
              {changeSaved && (
                <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Updated — thanks for letting us know!
                </span>
              )}
            </div>
            {changeOpen && (
              <div className="mt-3 pt-3 border-t border-border/40 flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">New company</label>
                  <input
                    value={changeCompany}
                    onChange={e => setChangeCompany(e.target.value)}
                    placeholder={company ?? "Company name"}
                    className="text-xs px-3 py-1.5 rounded-lg bg-background border border-border/60 focus:outline-none focus:border-primary/60 w-44"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">New title</label>
                  <input
                    value={changeTitle}
                    onChange={e => setChangeTitle(e.target.value)}
                    placeholder={(activityData.currentTitle as string | null) ?? "Job title"}
                    className="text-xs px-3 py-1.5 rounded-lg bg-background border border-border/60 focus:outline-none focus:border-primary/60 w-44"
                  />
                </div>
                <button
                  onClick={submitSituationChange}
                  disabled={changeSaving || (!changeCompany.trim() && !changeTitle.trim())}
                  className="flex items-center gap-1.5 text-xs font-semibold px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-50"
                >
                  {changeSaving
                    ? <><div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> Saving…</>
                    : <>Update my situation</>}
                </button>
                <span className="text-[10px] text-muted-foreground pb-1.5">We'll update your profile — no third-party lookups, ever.</span>
              </div>
            )}
          </div>
        );
      })()}

      {/* ── ENGAGEMENT ROW: Peer Percentile · Recruiter Pulse · Achievements ── */}
      {engagement && (() => {
        const peer       = engagement.peer ?? null;
        const pulse      = engagement.recruiterPulse ?? { last24h: 0, last7d: 0, last30d: 0 };
        const earned     = (engagement.achievements ?? []).filter((a: any) => a.earned);
        const locked     = (engagement.achievements ?? []).filter((a: any) => !a.earned);
        const earnedCt   = earned.length;
        const totalCt    = (engagement.achievements ?? []).length;
        const showPulse  = pulse.last24h > 0 || pulse.last7d > 0;
        const bandStyle  = (b: string | null) => (b && BAND_STYLE[b]) || "text-cyan-300 bg-cyan-300/10 border-cyan-300/30";

        return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-5">
            {/* Peer Percentile */}
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Globe className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-semibold">You vs. Your Peers</span>
              </div>
              {peer && (peer.bandCountry || peer.bandGlobal) ? (
                <div className="space-y-3">
                  {peer.bandCountry && (
                    <div className="flex items-center gap-2">
                      <MapPin className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${bandStyle(peer.bandCountry)}`}>
                        {peer.bandCountry}
                      </span>
                      <span className="text-xs text-muted-foreground truncate">
                        in {peer.country ?? "your country"}
                      </span>
                    </div>
                  )}
                  {peer.bandGlobal && (
                    <div className="flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${bandStyle(peer.bandGlobal)}`}>
                        {peer.bandGlobal}
                      </span>
                      <span className="text-xs text-muted-foreground">globally</span>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground pt-1 leading-relaxed">
                    This grows as your profile and practice do — every session moves it.
                  </p>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground py-2">
                  Complete your baseline interview to unlock your peer ranking.
                </div>
              )}
            </div>

            {/* Recruiter Pulse — now identified-company aware */}
            {(() => {
              const viewers: { name: string; count: number; lastViewedAt: string | null }[] =
                engagement.topViewerCompanies ?? [];
              const targets: { name: string; lastViewedAt: string | null; viewCount: number }[] =
                engagement.targetCompanyMatches ?? [];
              return (
                <div className="rounded-2xl border border-border/50 bg-card p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <Eye className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-semibold">Recruiters Viewing You</span>
                    {showPulse && (
                      <span className="ml-auto flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                        <span className="relative flex h-2 w-2">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                        </span>
                        LIVE
                      </span>
                    )}
                  </div>

                  {/* Target-company match — the "ding" moment. */}
                  {targets.length > 0 && (
                    <div className="mb-3 rounded-lg bg-cyan-400/10 border border-cyan-400/30 px-3 py-2">
                      <div className="text-[10px] font-bold tracking-wider text-cyan-300 uppercase mb-0.5">
                        Target company viewed you
                      </div>
                      <div className="text-xs text-foreground font-semibold">
                        {targets.slice(0, 2).map(t => t.name).join(" · ")}
                        {targets.length > 2 ? ` +${targets.length - 2} more` : ""}
                      </div>
                    </div>
                  )}

                  {/* Role-open at target — brochure slide 7: "On open" */}
                  {(engagement.recentRoleOpens ?? []).length > 0 && (
                    <div className="mb-3 rounded-lg bg-violet-400/10 border border-violet-400/30 px-3 py-2">
                      <div className="text-[10px] font-bold tracking-wider text-violet-300 uppercase mb-1">
                        New role at your target
                      </div>
                      {(engagement.recentRoleOpens ?? []).slice(0, 2).map((r: any) => (
                        <div key={`${r.jobId}-${r.at}`} className="text-xs text-foreground">
                          <span className="font-semibold">{r.companyName}</span>
                          <span className="text-muted-foreground"> just opened </span>
                          <span className="font-semibold">{r.roleTitle}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { n: pulse.last24h, l: "Today" },
                      { n: pulse.last7d,  l: "7 days" },
                      { n: pulse.last30d, l: "30 days" },
                    ].map(({ n, l }) => (
                      <div key={l} className="text-center rounded-lg bg-muted/30 border border-border/30 py-2">
                        <div className="text-lg font-black text-emerald-400">{n}</div>
                        <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{l}</div>
                      </div>
                    ))}
                  </div>

                  {/* Anonymized tier breakdown — brochure RecruitersLooking
                      slide promise: "anonymized by company tier." Surfaces
                      the *caliber* of attention even when individual viewer
                      names aren't shown or recognized. */}
                  {(() => {
                    const tiers = (engagement as any).viewerCompaniesByTier;
                    if (!tiers) return null;
                    const total = tiers.tier1.count + tiers.tier2.count + tiers.tier3.count;
                    if (total === 0) return null;
                    return (
                      <div className="mt-3 mb-3 grid grid-cols-3 gap-2">
                        {[
                          { key: "tier1", label: "Tier 1", color: "text-amber-300", border: "border-amber-300/30", bg: "bg-amber-300/5", n: tiers.tier1.count, c: tiers.tier1.companyCount },
                          { key: "tier2", label: "Tier 2", color: "text-cyan-300",  border: "border-cyan-300/30",  bg: "bg-cyan-300/5",  n: tiers.tier2.count, c: tiers.tier2.companyCount },
                          { key: "tier3", label: "Other", color: "text-emerald-300", border: "border-emerald-300/30", bg: "bg-emerald-300/5", n: tiers.tier3.count, c: tiers.tier3.companyCount },
                        ].map(t => (
                          <div key={t.key} className={`text-center rounded-lg border ${t.border} ${t.bg} py-2`}>
                            <div className={`text-base font-black ${t.color}`}>{t.n}</div>
                            <div className="text-[9px] text-muted-foreground uppercase tracking-wide leading-tight">
                              {t.label}<br />
                              <span className="opacity-60">{pluralize(t.c, "co")}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {/* Identified viewer companies — replaces the anonymous count */}
                  {viewers.length > 0 ? (
                    <div className="mt-3 space-y-1.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Top viewers · last 30 days
                      </div>
                      {viewers.slice(0, 3).map(v => (
                        <div key={v.name} className="flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1.5 truncate text-foreground">
                            <Building2 className="w-3 h-3 text-muted-foreground shrink-0" />
                            <span className="truncate">{v.name}</span>
                          </span>
                          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 ml-2">
                            {pluralize(v.count, "view")}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground pt-3 leading-relaxed">
                      {pulse.last7d > 0
                        ? `${pluralize(pulse.last7d, "recruiter")} viewed you this week.`
                        : "No recruiter views yet. Complete your profile to boost visibility."}
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Achievements summary */}
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Award className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-semibold">Achievements</span>
                <span className="ml-auto text-xs text-muted-foreground font-medium">
                  {earnedCt}/{totalCt}
                </span>
              </div>
              <div className="grid grid-cols-5 gap-2 mb-3">
                {(engagement.achievements ?? []).slice(0, 10).map((a: any) => {
                  const Icon = ACH_ICON[a.icon] ?? Trophy;
                  return (
                    <div key={a.code}
                      title={`${a.title} — ${a.description}`}
                      className={`aspect-square rounded-lg border flex items-center justify-center transition-all ${
                        a.earned
                          ? "bg-amber-400/10 border-amber-400/30 text-amber-300"
                          : "bg-muted/20 border-border/30 text-muted-foreground/30"
                      }`}>
                      {a.earned
                        ? <Icon className="w-4 h-4" />
                        : <Lock className="w-3 h-3" />}
                    </div>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {earnedCt === 0
                  ? "Earn your first badge by completing your profile or baseline interview."
                  : earned[0]
                    ? `Latest: ${earned[0].title}. ${locked[0] ? `Up next: ${locked[0].title}.` : "All badges earned 🎉"}`
                    : ""}
              </p>
            </div>
          </div>
        );
      })()}

      {/* ── MAIN GRID ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ── 2. NEXT BEST ACTIONS ─────────── lg:col-span-2 */}
        <div className="lg:col-span-2">
          <SectionCard title="Next Best Actions" icon={Zap} iconColor="text-amber-400"
            action={<Link href="/portal/career"><span className="text-xs text-muted-foreground hover:text-primary cursor-pointer">View all</span></Link>}>
            {recsLoading ? (
              <div className="space-y-2">{[0,1,2].map(i => <div key={i} className="h-14 rounded-xl bg-muted animate-pulse" />)}</div>
            ) : recommendations.length > 0 ? (
              <div className="space-y-2">
                {recommendations.slice(0, 5).map((rec, i) => {
                  const Icon = recIconMap[rec.type] ?? Star;
                  const isCompleting = completingKey === rec.recKey;
                  const isPending = pendingKey === rec.recKey;
                  const impact = rec.priority === "high" ? "high" : rec.priority === "medium" ? "medium" : "low";
                  return (
                    <div key={i} className={`rounded-xl border transition-all ${rec.priority === "high" ? "border-primary/20 bg-primary/5" : "border-border/40"}`}>
                      <div className="flex items-center gap-3 p-3">
                        <div className="p-1.5 rounded-lg bg-muted/60 shrink-0">
                          <Icon className="w-3.5 h-3.5 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{rec.label}</p>
                          {rec.impact && <p className="text-xs text-muted-foreground">{rec.impact}</p>}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${impactColors[impact]}`}>
                            {impact === "high" ? "Priority" : impact === "medium" ? "Important" : "Nice to have"}
                          </span>
                          <ActionBtn label="Do it" href={safeHref(rec.href)} />
                          <button onClick={(e) => { e.preventDefault(); setPendingKey(isPending ? null : rec.recKey); setPendingNote(""); }}
                            disabled={isCompleting}
                            className={`p-1.5 rounded-full transition-colors disabled:opacity-50 ${isPending ? "bg-emerald-500/15 text-emerald-400" : "hover:bg-emerald-500/10 text-muted-foreground hover:text-emerald-400"}`}>
                            {isCompleting ? <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                      {isPending && (
                        <div className="px-3 pb-3 border-t border-border/30 pt-2 space-y-2">
                          <input autoFocus type="text" value={pendingNote} onChange={e => setPendingNote(e.target.value)}
                            onKeyDown={e => { if (e.key === "Enter") confirmComplete(rec.recKey); if (e.key === "Escape") { setPendingKey(null); setPendingNote(""); } }}
                            placeholder="Add evidence or notes (optional)…"
                            className="w-full text-xs bg-background border border-border rounded-lg px-3 py-2 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary" />
                          <div className="flex gap-2">
                            <button onClick={() => confirmComplete(rec.recKey)} disabled={isCompleting}
                              className="flex-1 text-xs font-semibold bg-emerald-500 hover:bg-emerald-400 text-white rounded-lg py-1.5 transition-colors disabled:opacity-50">
                              {isCompleting ? "Saving…" : "Mark complete"}
                            </button>
                            <button onClick={() => { setPendingKey(null); setPendingNote(""); }}
                              className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg hover:bg-muted transition-colors">Cancel</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              /* Fallback smart actions */
              <div className="space-y-2">
                {[
                  { icon: Mic, label: "Complete your baseline interview", impact: "Unlocks AI career paths + recruiter visibility", href: "/portal/career", priority: "high" },
                  { icon: Target, label: "Set your 3-year career goal", impact: "Required to generate personalized path", href: "/portal/career", priority: "high" },
                  { icon: BookOpen, label: "Practice a mock interview", impact: "Improve readiness score by ~15%", href: "/portal/prep", priority: "medium" },
                  { icon: Briefcase, label: "Review matched opportunities", impact: opps.length > 0 ? `${pluralize(opps.length, "role")} matched to your profile` : "Complete your profile to unlock job matches", href: "/portal/career", priority: "medium" },
                ].map((a, i) => (
                  <div key={i} className={`flex items-center gap-3 p-3 rounded-xl border ${a.priority === "high" ? "border-primary/20 bg-primary/5" : "border-border/40"}`}>
                    <div className="p-1.5 rounded-lg bg-muted/60 shrink-0"><a.icon className="w-3.5 h-3.5 text-primary" /></div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{a.label}</p>
                      <p className="text-xs text-muted-foreground">{a.impact}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${a.priority === "high" ? impactColors.high : impactColors.medium}`}>
                        {a.priority === "high" ? "Priority" : "Important"}
                      </span>
                      <ActionBtn label="Go" href={a.href} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </div>

        {/* ── 9. PROFILE STRENGTH ──────────── lg:col-span-1 */}
        <SectionCard title="Profile Strength" icon={Shield} iconColor="text-violet-400"
          action={<ActionBtn label="Improve" href="/portal/career" variant="outline" />}>
          <div className="relative mx-auto" style={{ width: 100, height: 100 }}>
            <ScoreRing value={completeness} size={100} stroke={9} color="hsl(270 80% 65%)" />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-black">{completeness}%</span>
              <span className="text-[9px] text-muted-foreground">Complete</span>
            </div>
          </div>
          <div className="space-y-2.5">
            {[
              { label: "Basic Info",      done: !!p,                                 href: "/portal/career" },
              { label: "Skills",          done: (p?.skills?.length ?? 0) > 0,       href: "/portal/career" },
              { label: "Career Goals",    done: !!p?.careerGoal3yr,                 href: "/portal/career" },
              { label: "AI Interview",    done: !!p?.baselineInterviewCompleted,    href: "/portal/career/interview" },
              { label: "Resume Upload",   done: !!p?.resumeUrl,                     href: "/portal/onboarding/resume" },
              { label: "Verification",    done: false,                              href: "/portal/career" },
            ].map(({ label, done, href }) => (
              <div key={label} className="flex items-center gap-2 text-xs">
                <div className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${done ? "bg-emerald-500/20 text-emerald-400" : "bg-border/50 text-muted-foreground/40"}`}>
                  {done ? <CheckCircle2 className="w-3 h-3" /> : <div className="w-1.5 h-1.5 rounded-full bg-current" />}
                </div>
                <span className={done ? "text-foreground" : "text-muted-foreground"}>{label}</span>
                {!done && (
                  <Link href={href} className="ml-auto text-primary text-[10px] font-medium hover:underline">
                    +add
                  </Link>
                )}
              </div>
            ))}
          </div>
        </SectionCard>

        {/* ── 3. OPPORTUNITIES ─────────────── lg:col-span-1 */}
        <SectionCard title="Matched Opportunities" icon={Briefcase} iconColor="text-emerald-400"
          action={<ActionBtn label="All" href="/portal/career" variant="outline" />}>
          <div className="space-y-2.5">
            {opps.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground text-xs space-y-2">
                <Briefcase className="w-8 h-8 mx-auto opacity-30" />
                <p>No matched opportunities yet.</p>
                <p className="opacity-70">Complete your profile to unlock job matches.</p>
              </div>
            ) : opps.slice(0, 4).map((job: any, i: number) => {
              const score = job._score;
              // _score is a normalised 0-100% match — banded by the canonical lib
              const matchColor = bandBy(score, { strong: "text-emerald-400", good: "text-cyan-400", fair: "text-amber-400" });
              return (
                <Link key={job.id ?? i} href={job.id ? `/careers/${job.id}` : "/portal/career"} className="flex items-center justify-between gap-3 p-3 rounded-xl border border-border/40 hover:border-primary/30 transition-all group cursor-pointer">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{job.title}</p>
                    <p className="text-xs text-muted-foreground truncate">{job.company ?? job.department ?? ""}{job.location ? ` · ${job.location}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {score != null && <span className={`text-sm font-bold ${matchColor}`}>{score}%</span>}
                    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors" />
                  </div>
                </Link>
              );
            })}
          </div>
          <Link href="/portal/career" className="block w-full text-xs text-center text-muted-foreground hover:text-primary py-1.5 transition-colors">
            View all matches <ArrowRight className="inline w-3 h-3" />
          </Link>
        </SectionCard>

        {/* ── OPPORTUNITY PRIORITY LIST (Candidate Connection Engine) ─────── */}
        {p?.candidateId && (
          <div className="lg:col-span-3">
            <CandidateOpportunityPriorityList
              candidateId={p.candidateId}
              opportunities={opps.map((o: any) => ({
                id: o.id,
                title: o.title ?? o.jobTitle ?? "Opportunity",
                company: o.company ?? null,
                department: o.department ?? null,
              }))}
            />
          </div>
        )}

        {/* ── 6. INTERVIEW PERFORMANCE ─────── lg:col-span-2 */}
        <div className="lg:col-span-2">
          {(() => {
            const sessions = Array.isArray(dashData?.completedInterviews) ? dashData.completedInterviews.length : 0;
            const baselineDone = !!p?.baselineInterviewCompleted;
            return (
              <SectionCard title="Interview Performance" icon={MessageSquare} iconColor="text-cyan-400"
                action={<ActionBtn label="Practice now" href="/portal/prep" />}>
                {sessions === 0 && !baselineDone ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                    <div className="p-3 bg-cyan-400/10 rounded-2xl">
                      <Mic className="w-8 h-8 text-cyan-400 opacity-60" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">No practice sessions yet</p>
                      <p className="text-xs text-muted-foreground mt-1">Complete a practice interview to see your performance scores.</p>
                    </div>
                    <ActionBtn label="Start practicing" href="/portal/prep" />
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-4 p-3 rounded-xl bg-muted/20 border border-border/30">
                      <div className="p-2 bg-cyan-400/10 rounded-xl">
                        <BarChart2 className="w-5 h-5 text-cyan-400" />
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-semibold">{pluralize(sessions, "session")} completed</p>
                        <p className="text-xs text-muted-foreground">Keep practising to build a full performance profile.</p>
                      </div>
                      {baselineDone && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border text-emerald-400 bg-emerald-400/10 border-emerald-400/20">
                          AI Interview Done
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground p-3 rounded-xl bg-muted/20 border border-border/30">
                      <Star className="w-3.5 h-3.5 text-primary" /> Detailed scores unlock after 3+ practice sessions.
                    </div>
                  </div>
                )}
              </SectionCard>
            );
          })()}
        </div>

        {/* ── 5. SKILL GAPS ────────────────── lg:col-span-1 */}
        <SectionCard title="Skill Gaps" icon={TrendingUp} iconColor="text-amber-400"
          action={<ActionBtn label="Practice" href="/portal/prep" variant="outline" />}>
          {!p?.growthAreas?.length ? (
            <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
              <TrendingUp className="w-7 h-7 text-amber-400 opacity-30" />
              <p className="text-xs text-muted-foreground">Skill gaps will appear here after your AI career interview.</p>
              <ActionBtn label="Start interview" href="/portal/career/interview" variant="outline" />
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {p.growthAreas.slice(0, 4).map((skill: string, i: number) => (
                  <div key={skill} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-foreground">{skill}</span>
                      {/* Growth framing, not deficit framing — and no red on a
                          candidate's own gap list (ordering is by list position,
                          not measured severity). */}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${i === 0 ? "text-violet-400" : i === 1 ? "text-cyan-400" : "text-muted-foreground"}`}>
                        {i === 0 ? "Biggest lever" : i === 1 ? "High impact" : "Worth adding"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="pt-1 border-t border-border/30 text-xs text-muted-foreground">
                Go to <Link href="/portal/career" className="text-primary hover:underline">Career Hub</Link> for detailed gap analysis.
              </div>
            </>
          )}
        </SectionCard>

        {/* ── 4. CAREER PATH ───────────────── lg:col-span-2 */}
        <div className="lg:col-span-2">
          <SectionCard title="Career Path" icon={Target} iconColor="text-primary"
            action={<ActionBtn label="Full plan" href="/portal/career" variant="outline" />}>
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-5 top-5 bottom-5 w-px bg-border/40" />
              <div className="space-y-4">
                {/* Current position */}
                <div className="flex items-center gap-4 relative">
                  <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center shrink-0 z-10 shadow-lg shadow-primary/30">
                    <Star className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 p-3 rounded-xl border border-primary/20 bg-primary/5">
                    <p className="text-xs text-primary font-semibold uppercase tracking-wide">Now</p>
                    <p className="text-sm font-semibold">{p.currentTitle ?? "Current Role"}</p>
                  </div>
                </div>

                {/* Path steps */}
                {paths.slice(0, 3).map((path: any, i: number) => {
                  const pathColors = ["text-emerald-400 bg-emerald-400/10 border-emerald-400/20", "text-cyan-400 bg-cyan-400/10 border-cyan-400/20", "text-violet-400 bg-violet-400/10 border-violet-400/20"];
                  const ringColors = ["bg-emerald-500/20 text-emerald-400", "bg-cyan-500/20 text-cyan-400", "bg-violet-500/20 text-violet-400"];
                  return (
                    <div key={i} className="flex items-center gap-4 relative">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 z-10 ${ringColors[i]}`}>
                        <span className="text-xs font-bold">{i + 1}</span>
                      </div>
                      <div className="flex-1 p-3 rounded-xl border border-border/40 hover:border-primary/20 transition-all">
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <p className="text-sm font-semibold">{path.title}</p>
                            <p className="text-xs text-muted-foreground">{path.timeframe}{path.salaryRange ? ` · ${path.salaryRange}` : ""}</p>
                          </div>
                          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${pathColors[i]}`}>
                            {path.difficulty?.charAt(0).toUpperCase() + path.difficulty?.slice(1)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </SectionCard>
        </div>

        {/* ── 7. PRACTICE ENGINE ───────────── lg:col-span-1 */}
        <SectionCard title="Practice Engine" icon={Play} iconColor="text-primary"
          action={<ActionBtn label="Start" href="/portal/prep" />}>
          <div className="space-y-3">
            {[
              { label: "Mock Interview", desc: "Full recruiter-style screen", icon: Mic, href: "/portal/prep?mode=mock" },
              { label: "Behavioural Q&A", desc: "STAR method practice", icon: MessageSquare, href: "/portal/prep?mode=behavioral" },
              { label: "Leadership Q&A", desc: "Strategy & management questions", icon: Brain, href: "/portal/prep?mode=leadership" },
            ].map((s, i) => (
              <Link key={i} href={s.href}>
                <div className="flex items-center gap-3 p-3 rounded-xl border border-border/40 hover:border-primary/20 cursor-pointer transition-all group">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 bg-primary/10 text-primary group-hover:bg-primary/20">
                    <s.icon className="w-3 h-3" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{s.label}</p>
                    <p className="text-[10px] text-muted-foreground">{s.desc}</p>
                  </div>
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
                </div>
              </Link>
            ))}
          </div>
          {dashData?.prepCompletion != null && (
            <Bar value={dashData.prepCompletion} label="Overall readiness" color="bg-primary" />
          )}
        </SectionCard>

        {/* ── 8. VISIBILITY STATUS ─────────── lg:col-span-1 */}
        <SectionCard title="Platform Visibility" icon={Eye} iconColor="text-cyan-400">
          {!activityData ? (
            <div className="space-y-3 animate-pulse">
              {[0,1,2].map(i => <div key={i} className="h-10 rounded-xl bg-muted" />)}
            </div>
          ) : (() => {
            const status = activityData.activityStatus as string;
            const days   = activityData.daysSince as number;
            const cos    = activityData.companiesInterested as number;
            const statusColor =
              status === "active"  ? "text-emerald-400" :
              status === "passive" ? "text-amber-400"   : "text-amber-300"; // never red — inactivity isn't failure
            const statusBg =
              status === "active"  ? "bg-emerald-400/10 border-emerald-400/20" :
              status === "passive" ? "bg-amber-400/10 border-amber-400/20"     : "bg-amber-400/10 border-amber-400/20";
            const dot =
              status === "active"  ? "bg-emerald-400" :
              status === "passive" ? "bg-amber-400"   : "bg-amber-300";
            return (
              <div className="space-y-4">
                {/* Status */}
                <div className={`flex items-center justify-between p-3 rounded-xl border ${statusBg}`}>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${dot}`} />
                    <span className={`text-sm font-semibold ${statusColor}`}>
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {days === 0 ? "Today" : `${days}d ago`}
                  </span>
                </div>

                {/* Company count */}
                <div className="flex items-center gap-3 p-3 rounded-xl border border-border/40">
                  <div className="p-1.5 rounded-lg bg-cyan-400/10 shrink-0">
                    <Building2 className="w-3.5 h-3.5 text-cyan-400" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{cos}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {cos === 1 ? "company has your profile" : "companies have your profile"}
                    </p>
                  </div>
                </div>

                {/* Status message */}
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {status === "active"
                    ? "Your profile is fully visible and being matched to live roles."
                    : status === "passive"
                    ? "You're approaching inactive status. Confirm you're still looking to stay visible."
                    : "Your profile has low visibility. Click below to restore your Active status."}
                </p>

                {/* Refresh CTA */}
                <button
                  onClick={refreshActivity}
                  disabled={activityRefreshing || status === "active"}
                  className={`w-full flex items-center justify-center gap-2 text-xs font-semibold py-2 rounded-lg transition-all
                    ${status === "active"
                      ? "bg-muted text-muted-foreground cursor-default"
                      : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60"}`}
                >
                  {activityRefreshing
                    ? <><div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> Refreshing…</>
                    : status === "active"
                    ? <><Eye className="w-3 h-3" /> Fully visible</>
                    : <><Activity className="w-3 h-3" /> I'm still looking</>
                  }
                </button>
              </div>
            );
          })()}
        </SectionCard>

        {/* ── 10. AI INSIGHTS ──────────────── lg:col-span-1 */}
        <SectionCard title="AI Insights" icon={Brain} iconColor="text-violet-400"
          action={<ActionBtn label="Full Hub" href="/portal/career" />}>
          {!p ? (
            <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
              <Brain className="w-7 h-7 text-violet-400 opacity-30" />
              <p className="text-xs text-muted-foreground">AI insights will appear after completing your career interview.</p>
              <ActionBtn label="Start interview" href="/portal/career/interview" variant="outline" />
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {p.strengthAreas?.[0] && (
                  <div className="flex items-start gap-3 p-3 rounded-xl border border-border/40">
                    <div className="p-1.5 rounded-lg shrink-0 text-amber-400 bg-amber-400/10">
                      <Lightbulb className="w-3.5 h-3.5" />
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Your <span className="text-foreground font-medium">{p.strengthAreas[0]}</span> is identified as a core strength.
                    </p>
                  </div>
                )}
                {p.growthAreas?.[0] && (
                  <div className="flex items-start gap-3 p-3 rounded-xl border border-border/40">
                    <div className="p-1.5 rounded-lg shrink-0 text-primary bg-primary/10">
                      <Target className="w-3.5 h-3.5" />
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Developing <span className="text-foreground font-medium">{p.growthAreas[0]}</span> is your highest-impact next step.
                    </p>
                  </div>
                )}
                {p.careerPaths?.[0] && (
                  <div className="flex items-start gap-3 p-3 rounded-xl border border-border/40">
                    <div className="p-1.5 rounded-lg shrink-0 text-emerald-400 bg-emerald-400/10">
                      <TrendingUp className="w-3.5 h-3.5" />
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Your nearest target: <span className="text-foreground font-medium">{p.careerPaths[0].title}</span>
                      {p.careerPaths[0].timeframe ? ` in ${p.careerPaths[0].timeframe}` : ""}.
                    </p>
                  </div>
                )}
                {!p.strengthAreas?.[0] && !p.growthAreas?.[0] && !p.careerPaths?.[0] && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    Complete your AI career interview to get personalised insights.
                  </p>
                )}
              </div>
              {p.skills?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/30">
                  {p.skills.slice(0, 4).map((s: string) => (
                    <Chip key={s} label={s} />
                  ))}
                </div>
              )}
            </>
          )}
        </SectionCard>
      </div>
    </AppLayout>
  );
}
