/**
 * pages/recruiter/dashboard.tsx — Recruiter Home Dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The landing page after recruiter login. Shows a concise at-a-glance view
 * of pipeline health, recent AI activity, and action items that need attention.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   KPI Cards          — open jobs, active candidates, interviews this week,
 *                        offers outstanding
 *   Recent Candidates  — last 5 candidates added to the pipeline
 *   Active Jobs        — top 3 jobs by candidate volume with stage breakdown
 *   AI Activity Feed   — last 10 agent actions (sourced N, screened N, etc.)
 *   Action Items       — decision queue count, unread inbox count, pending
 *                        interview invites, ghosting alerts
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useGetAnalyticsOverview() — headline KPIs
 *   useListJobs()             — top jobs
 *   useListCandidates()       — recent candidates
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/dashboard  (default route for recruiter role)
 */
import { AppLayout } from "@/components/layout/AppLayout";
import { bandBy } from "@/lib/score-band";
import { useState, useEffect } from "react";
import { useGetAnalyticsOverview, useGetHiringFunnel, getGetHiringFunnelQueryKey, useListJobs, useListCandidates } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Briefcase, Users, Video, Award, Clock, ArrowUpRight, Plus, BarChart3, Zap, Bot, TrendingUp, Send, Sparkles, Loader2 } from "lucide-react";
import { useSourcingTrigger } from "@/lib/agent-runs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";
import { cn, pluralize } from "@/lib/utils";
import { apiFetch, apiBase } from "@/lib/api";
import { EvidenceBadge } from "@/components/ui-custom/EvidenceBadge";
import { getEvidence } from "@/lib/evidence";
import { isTrustGated, TRUST_GATE_LABEL } from "@/lib/trust-gate";
import { AICommandCenter } from "@/components/ai-os/AICommandCenter";
import { AgentActivityFeed } from "@/components/ai-os/AgentActivityFeed";
import { RecommendedActions } from "@/components/ai-os/RecommendedActions";
import { PipelineFunnel } from "@/components/ai-os/PipelineFunnel";
import { MorningReport } from "@/components/ai-os/MorningReport";


/** Animate a number from 0 -> target over `duration` ms (ease-out), after
 *  `delay` ms. Honors prefers-reduced-motion by jumping straight to target. */
function useCountUp(target: number, duration = 350, delay = 0) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(target);
      return;
    }
    let raf = 0;
    let startTs: number | null = null;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    const step = (ts: number) => {
      if (startTs === null) startTs = ts;
      const p = Math.min((ts - startTs) / duration, 1);
      setDisplay(Math.round(easeOut(p) * target));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    const timer = window.setTimeout(() => { raf = requestAnimationFrame(step); }, delay);
    return () => { window.clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [target, duration, delay]);
  return display;
}

interface KpiCardProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  colorCls: string;
  trend?: string;
  trendUp?: boolean;
  href?: string;
  index?: number;
  zeroLink?: { label: string; href: string };
}

function KpiCard({ label, value, icon, colorCls, trend, trendUp, href, index = 0, zeroLink }: KpiCardProps) {
  const isNumeric = typeof value === "number";
  const counted = useCountUp(isNumeric ? (value as number) : 0, 350, index * 100);
  const isZero = isNumeric && (value as number) === 0;
  const showZeroLink = isZero && !!zeroLink;
  const inner = (
    <div
      className="elevated relative rounded-xl border border-border p-6 bg-card cursor-pointer hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-lg transition-all overflow-hidden group"
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-primary/3 to-transparent" />
      <div className="relative">
        {/* Row 1 — icon + label only */}
        <div className="flex items-center gap-3 mb-3">
          <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center border border-white/10", colorCls)}>
            {icon}
          </div>
          <p className="stat-label leading-tight">{label}</p>
        </div>
        {/* Row 2 — the stat number */}
        <p className="stat-number">{isNumeric ? counted : value}</p>
        {/* Row 3 — single footer line: accent micro-link when the stat is 0,
            otherwise the plain sublabel. Reserve height so all four cards align. */}
        <div className="mt-2 min-h-[16px]">
          {showZeroLink ? (
            <Link href={zeroLink!.href}>
              <span className="text-primary text-xs font-medium hover:underline cursor-pointer">
                {zeroLink!.label}
              </span>
            </Link>
          ) : trend ? (
            <span className={cn("text-[11px] font-semibold", trendUp ? "text-signal-green" : "text-muted-foreground")}>
              {trend}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
  return href && !showZeroLink ? <Link href={href}>{inner}</Link> : inner;
}

export default function Dashboard() {
  const { trigger: triggerSourcing, isPending: sourcingPending } = useSourcingTrigger();
  const { data: analytics, isLoading: analyticsLoading } = useGetAnalyticsOverview();
  const { data: jobsData } = useListJobs({ limit: 4 });
  const { data: candidatesData } = useListCandidates({ limit: 5 });

  const { data: funnelRaw } = useGetHiringFunnel(undefined, {
    query: { queryKey: getGetHiringFunnelQueryKey(), refetchInterval: 30_000 },
  });

  const { data: dashData } = useQuery({
    queryKey: ["dashboard-summary"],
    queryFn: () => apiFetch(`${apiBase}/analytics/dashboard`).then(r => r.json()),
    refetchInterval: 30_000,
  });

  /* Accrued intelligence — the source of truth for a candidate's headline
   * score whenever a record exists. We map hireProbability by candidateId so
   * the "Hire-Ready Candidates" widget shows the SAME number (and label) the
   * candidates list and candidate detail page render, instead of the
   * point-in-time talentMatchScore. Falls back to talentMatchScore for
   * candidates the intelligence engine hasn't analysed yet. */
  const { data: intelData } = useQuery({
    queryKey: ["intelligence", "all"],
    queryFn: () => apiFetch(`${apiBase}/intelligence`).then(r => r.json()),
    refetchInterval: 30_000,
  });
  // Keep the BEST (highest hireProbability) record per candidate — matches the
  // best-per-candidate semantics of the candidates list/detail surfaces. A plain
  // Map(...entries) would be last-write-wins, and /api/intelligence is ordered
  // hireProbability DESC, so a candidate with multiple rows would otherwise be
  // pinned to their lowest score and drift from the other surfaces.
  const hireProbByCandidate = new Map<string, number>();
  // Keep the evidence (confidence + signal count) from the SAME best record so
  // the headline number can be labeled honestly instead of standing alone.
  const evidenceByCandidate = new Map<string, { confidence: number | null; signalCount: number | null }>();
  // Trust from the SAME best record — drives the gate badge on the widget.
  const trustByCandidate = new Map<string, number | null>();
  for (const r of ((intelData?.data ?? []) as any[])) {
    if (r.hireProbability == null) continue;
    const prev = hireProbByCandidate.get(r.candidateId);
    if (prev == null || r.hireProbability > prev) {
      hireProbByCandidate.set(r.candidateId, r.hireProbability);
      trustByCandidate.set(r.candidateId, r.trustScore ?? null);
      evidenceByCandidate.set(r.candidateId, {
        confidence: r.confidence ?? null,
        signalCount: r.signalCount ?? null,
      });
    }
  }

  const funnelData = (funnelRaw?.stages ?? []).map((s: any) => ({
    name: s.stage,
    value: s.count,
  }));

  return (
    <AppLayout>
      {/* Header — the Morning Report replaces the old status headline. */}
      <div className="flex flex-col md:flex-row justify-between items-start gap-4 mb-6">
        <MorningReport agentCount={Number((dashData as any)?.agentsOnline ?? 0)} />
        <div className="flex gap-3 shrink-0">
          <Link href="/jobs">
            <Button variant="outline" className="gap-2">
              <Briefcase className="w-4 h-4" /> Work Orders
            </Button>
          </Link>
          <Link href="/jobs">
            <Button className="gap-2 shadow-md shadow-primary/20">
              <Plus className="w-4 h-4" /> New Work Order
            </Button>
          </Link>
        </div>
      </div>

      {/* AI Command Center */}
      <AICommandCenter className="mb-6" />

      {/* Intelligence KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KpiCard
          index={0}
          label="Roles in Motion"
          value={analyticsLoading ? "—" : (analytics?.activeJobs ?? 0)}
          icon={<Briefcase className="w-4 h-4" />}
          colorCls="bg-accent text-accent-foreground"
          trend={analytics?.totalJobs ? pluralize(analytics.totalJobs, "total job") : undefined}
          href="/jobs"
        />
        <KpiCard
          index={1}
          label="Total Candidates"
          value={analyticsLoading ? "—" : (analytics?.totalCandidates ?? 0)}
          icon={<Users className="w-4 h-4" />}
          colorCls="bg-accent text-accent-foreground"
          trend={analyticsLoading ? undefined : `${(analytics as any)?.candidatesInPipeline ?? 0} in pipelines · visible candidates`}
          href="/candidates"
        />
        <KpiCard
          index={2}
          label="AI Interview Sessions"
          value={analyticsLoading ? "—" : (analytics?.interviewsCompleted ?? 0)}
          icon={<Video className="w-4 h-4" />}
          colorCls="bg-accent text-accent-foreground"
          trend={analyticsLoading ? undefined : "completed AI voice interviews"}
          href="/interviews"
          zeroLink={{ label: "Run your first interview →", href: "/interviews" }}
        />
        <KpiCard
          index={3}
          label="Offers & Hires"
          value={analyticsLoading ? "—" : ((analytics?.offersExtended ?? 0) + (analytics?.hires ?? 0))}
          icon={<Award className="w-4 h-4" />}
          colorCls="bg-accent text-accent-foreground"
          trend={analytics?.hires ? pluralize(analytics.hires, "hire") : undefined}
          trendUp={!!analytics?.hires}
          href="/analytics"
          zeroLink={{ label: "Review shortlist →", href: "/candidates" }}
        />
      </div>

      {/* AI Pipeline Funnel — promoted above the fold, directly below the KPI strip */}
      <PipelineFunnel stages={funnelData} className="mb-6" />

      {/* Main 3-col layout */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        {/* Left 2/3 */}
        <div className="lg:col-span-2 space-y-6">

          {/* Recommended Actions */}
          <RecommendedActions maxItems={4} />

          {/* Recent rows */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

            {/* Recent Candidates */}
            <Card className="border-border/50">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle>Hire-Ready Candidates</CardTitle>
                <Link href="/candidates" className="text-xs font-medium text-primary hover:opacity-80">View all</Link>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/20">
                  {candidatesData?.candidates?.slice(0, 5).map(c => {
                    // Accrued hireProbability wins; fall back to point-in-time match.
                    const hp = hireProbByCandidate.get(c.id);
                    const headline = hp ?? c.talentMatchScore ?? 0;
                    const headlineLabel = hp != null ? "Hire" : "Match";
                    // Evidence band only applies to the outcome-calibrated hire
                    // probability — not the point-in-time talent-match fallback.
                    const ev = hp != null ? evidenceByCandidate.get(c.id) : undefined;
                    const muted = ev ? getEvidence(ev.confidence, ev.signalCount).insufficient : false;
                    // Trust gate applies only to intelligence-scored candidates —
                    // gated ones lead with the badge, % demoted to secondary.
                    const gated = hp != null && isTrustGated(trustByCandidate.get(c.id) ?? null);
                    return (
                    <Link key={c.id} href={`/candidates/${c.id}`}>
                      <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 transition-colors group cursor-pointer">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-xs shrink-0 border border-primary/15">
                          {c.firstName.charAt(0)}{c.lastName.charAt(0)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-xs group-hover:text-primary transition-colors">{c.firstName} {c.lastName}</p>
                          <p className="text-[10px] text-muted-foreground truncate">{c.currentTitle || "Candidate"}</p>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {gated ? (
                            <>
                              <Badge variant="outline" className="text-[10px] font-bold bg-amber-500/10 text-amber-400 border-amber-500/30">
                                {TRUST_GATE_LABEL}
                              </Badge>
                              <span className="text-[9px] text-muted-foreground tabular-nums">{headline}% if verified</span>
                            </>
                          ) : (
                          <Badge variant="outline" className={cn(
                            "text-[10px]",
                            muted ? "bg-muted text-muted-foreground border-border/40" :
                            bandBy(headline, {
                              strong: "bg-signal-green/10 text-signal-green border-signal-green/20",
                              good: "bg-signal-amber/10 text-signal-amber border-signal-amber/20",
                              fair: "bg-muted text-muted-foreground",
                            })
                          )}>
                            {headline}% {headlineLabel}
                          </Badge>
                          )}
                          {ev && (
                            <EvidenceBadge confidence={ev.confidence} signalCount={ev.signalCount} showSignals={false} />
                          )}
                        </div>
                      </div>
                    </Link>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            {/* Active Work Orders */}
            <Card className="border-border/50">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle>Active Work Orders</CardTitle>
                <Link href="/jobs" className="text-xs font-medium text-primary hover:opacity-80">View all</Link>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border/20">
                  {jobsData?.jobs?.slice(0, 4).map(job => {
                    const canSource = ["active", "published"].includes((job as any).status);
                    return (
                    <Link key={job.id} href={`/jobs/${job.id}`}>
                      <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/20 transition-colors cursor-pointer group">
                        <div className="w-8 h-8 rounded-lg bg-accent text-accent-foreground flex items-center justify-center shrink-0 border border-border">
                          <Briefcase className="w-3.5 h-3.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-xs group-hover:text-primary transition-colors truncate">{job.title}</p>
                          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span>{job.department}</span>
                            <span>·</span>
                            <span className="flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />{pluralize(job.applicationCount, "app")}</span>
                          </div>
                        </div>
                        {canSource && (
                          <button
                            type="button"
                            disabled={sourcingPending}
                            title="Source Candidates"
                            aria-label="Source Candidates"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); triggerSourcing(job.id); }}
                            className="shrink-0 inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-md border border-primary/30 text-primary bg-primary/5 opacity-0 group-hover:opacity-100 hover:bg-primary/10 transition-all disabled:opacity-60"
                          >
                            {sourcingPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                            Source
                          </button>
                        )}
                        <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </Link>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="flex flex-col gap-6">

          {/* Agent Activity Feed */}
          <AgentActivityFeed compact />

          {/* AI Insights */}
          <Card className="border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-[15px]">
                <Bot className="w-4 h-4 text-primary" /> AI Insights
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {(analytics?.totalApplications ?? 0) > 0 ? (
                <div className="p-3 rounded-xl bg-primary/5 border border-primary/15">
                  <h4 className="font-bold text-xs mb-1 text-primary">Pipeline Active</h4>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {pluralize(analytics!.totalApplications, "formal application")} across{" "}
                    {pluralize(analytics!.activeJobs, "active role")}.
                    {(analytics!.hires ?? 0) > 0 && ` ${pluralize(analytics!.hires, "hire")} recorded.`}
                  </p>
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-muted/20 border border-border/30">
                  <h4 className="font-bold text-xs mb-1 text-muted-foreground">No Pipeline Data Yet</h4>
                  <p className="text-xs text-muted-foreground/70 leading-relaxed">Run agents on your jobs to generate insights.</p>
                </div>
              )}
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold">Interviews Completed</span>
                  <span className="font-black text-sm">{analytics?.interviewsCompleted ?? 0}</span>
                </div>
                <div className="w-full bg-muted/40 rounded-full h-1.5">
                  <div className="bg-primary h-1.5 rounded-full transition-all"
                    style={{ width: `${Math.min(100, ((analytics?.interviewsCompleted ?? 0) / Math.max(1, analytics?.totalApplications ?? 1)) * 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold">Offer Rate</span>
                  <span className="font-black text-sm text-signal-green">
                    {analytics?.totalApplications
                      ? `${Math.round(((analytics.offersExtended ?? 0) / analytics.totalApplications) * 100)}%`
                      : "0%"}
                  </span>
                </div>
                <div className="w-full bg-muted/40 rounded-full h-1.5">
                  <div className="bg-signal-green h-1.5 rounded-full transition-all"
                    style={{ width: analytics?.totalApplications
                      ? `${Math.min(100, Math.round(((analytics.offersExtended ?? 0) / analytics.totalApplications) * 100))}%`
                      : "0%" }} />
                </div>
              </div>
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold">Outreach Reply Rate</span>
                  <span className="font-black text-sm text-primary">{dashData?.outreachReplyRate ?? 0}%</span>
                </div>
                <div className="w-full bg-muted/40 rounded-full h-1.5">
                  <div className="bg-primary h-1.5 rounded-full transition-all"
                    style={{ width: `${dashData?.outreachReplyRate ?? 0}%` }} />
                </div>
              </div>
              <Link href="/analytics">
                <Button variant="ghost" className="w-full text-primary text-xs gap-2 mt-1">
                  Full Intelligence Report <TrendingUp className="w-3.5 h-3.5" />
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Quick Actions strip */}
          <Card className="border-border/50">
            <CardContent className="pt-4 space-y-2">
              {[
                { icon: Send,    label: "Launch Outreach",   href: "/outreach",     cls: "text-primary" },
                { icon: Zap,     label: "Agent Hub",         href: "/agents",       cls: "text-primary" },
                { icon: Users,   label: "Talent Match",      href: "/talent-match", cls: "text-primary" },
                { icon: BarChart3, label: "Analytics",       href: "/analytics",    cls: "text-primary" },
              ].map(({ icon: Icon, label, href, cls }) => (
                <Link key={href} href={href}>
                  <div className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/30 transition-colors cursor-pointer group">
                    <Icon className={cn("w-4 h-4 flex-shrink-0", cls)} />
                    <span className="text-xs font-semibold group-hover:text-primary transition-colors">{label}</span>
                    <ArrowUpRight className="w-3 h-3 text-muted-foreground/40 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer brand */}
      <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground/25 font-medium tracking-widest uppercase">
        <Bot className="w-3 h-3" />
        Powered by QOR · L3XY Agent Runtime v2 · AI Hiring OS
      </div>
    </AppLayout>
  );
}
