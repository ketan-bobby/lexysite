/**
 * pages/recruiter/engagement.tsx — Candidate Engagement Analytics
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Focused analytics page on candidate engagement signals: email open rates,
 * response rates, portal login rates, interview completion rates, and ghosting
 * rates over time. Uses recharts bar + line charts.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   Engagement Score Overview — rolling 30-day score + trend sparkline
 *   Channel Breakdown         — email / portal / interview engagement side-by-side
 *   Ghosting Rate Timeline    — line chart: ghosting % over time
 *   Top Ghosted Stages        — bar chart: which stages have highest ghosting
 *   Recommendations           — AI-generated suggestions for improving engagement
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/analytics/engagement   — engagement metrics (custom query)
 *   GET /api/analytics/ghosting     — ghosting breakdown
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/engagement
 */
import { authHeaders } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import {
  Users, Activity, Clock, AlertCircle, Mail, TrendingUp,
  Send, RefreshCw, CheckCircle2, MailOpen, Zap, Database,
  Loader2, CalendarClock,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { Link } from "wouter";
import { useToast } from "@workspace/react-hooks/use-toast";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

/* ── Data hooks ────────────────────────────────────────────────────────────── */
function useEngagement() {
  return useQuery<any>({
    queryKey: ["analytics", "engagement"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/analytics/engagement`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to load engagement data");
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function useRunReengagement() {
  const qc = useQueryClient();
  return useMutation<any>({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/engagement/run-reengagement`, {
        method: "POST",
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Run failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["analytics", "engagement"] });
    },
  });
}

function useStatusCheckin() {
  return useQuery<any>({
    queryKey: ["engagement", "status-checkin"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/engagement/linkedin-status`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to load status check-in state");
      return res.json();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

function useRunStatusCheckin() {
  const qc = useQueryClient();
  return useMutation<any>({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/engagement/scan-linkedin`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Run failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["engagement", "status-checkin"] });
      qc.invalidateQueries({ queryKey: ["analytics", "engagement"] });
    },
  });
}

/* ── Stat card ─────────────────────────────────────────────────────────────── */
function StatCard({
  label, value, icon: Icon, color, sub,
}: {
  label: string; value: string | number; icon: any; color: string; sub?: string;
}) {
  return (
    <Card className="border-border/40 bg-card/60">
      <CardContent className="p-5 flex items-center gap-4">
        <div className={cn("p-2.5 rounded-xl shrink-0", color.replace("text-", "bg-").replace("-400", "-500/15"))}>
          <Icon className={cn("w-5 h-5", color)} />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold tabular-nums">{value}</p>
          {sub && <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

/* ── Pool health donut ─────────────────────────────────────────────────────── */
const POOL_COLORS = ["#10b981", "#f59e0b", "#f43f5e"];

function PoolHealthChart({ data }: { data: { active: number; passive: number; inactive: number } }) {
  const chartData = [
    { name: "Active",   value: data.active,   color: POOL_COLORS[0] },
    { name: "Passive",  value: data.passive,  color: POOL_COLORS[1] },
    { name: "Inactive", value: data.inactive, color: POOL_COLORS[2] },
  ].filter(d => d.value > 0);

  if (chartData.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
        No platform pool candidates yet
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Pie
          data={chartData}
          cx="50%"
          cy="50%"
          innerRadius={55}
          outerRadius={80}
          paddingAngle={3}
          dataKey="value"
        >
          {chartData.map((entry, i) => (
            <Cell key={i} fill={entry.color} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
          formatter={(v: any, name: string) => [v, name]}
        />
        <Legend
          formatter={(value) => <span className="text-xs text-muted-foreground">{value}</span>}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

/* ── Re-engagement trend chart ─────────────────────────────────────────────── */
function ReengagementTrend({ trend }: { trend: { label: string; count: number }[] }) {
  const hasData = trend.some(d => d.count > 0);

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={trend} margin={{ top: 4, right: 8, left: -24, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border)/40)" vertical={false} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
          interval={2}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: 12 }}
          formatter={(v: any) => [v, "Emails sent"]}
        />
        <Bar dataKey="count" fill="#8b5cf6" radius={[3, 3, 0, 0]} maxBarSize={24} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Communications by type chart ─────────────────────────────────────────── */
const TYPE_COLORS: Record<string, string> = {
  "re engagement":   "#8b5cf6",
  "follow up":       "#06b6d4",
  "scheduling nudge":"#f59e0b",
  "interview reminder": "#10b981",
  "next steps":      "#3b82f6",
  "status update":   "#6b7280",
};

function CommsByTypeChart({ data }: { data: { type: string; count: number }[] }) {
  if (!data.length) {
    return (
      <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
        No communication events in the last 30 days
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, left: 80, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border)/40)" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="type" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))", textAnchor: "end" }} axisLine={false} tickLine={false} width={80} />
        <Tooltip
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px", fontSize: 12 }}
        />
        <Bar dataKey="count" radius={[0, 3, 3, 0]} maxBarSize={18}>
          {data.map((entry, i) => (
            <Cell key={i} fill={TYPE_COLORS[entry.type.toLowerCase()] ?? "#6b7280"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Status badge ──────────────────────────────────────────────────────────── */
function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; className: string }> = {
    sent:      { label: "Sent",      className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25" },
    delivered: { label: "Delivered", className: "bg-sky-500/10 text-sky-400 border-sky-500/25" },
    opened:    { label: "Opened",    className: "bg-violet-500/10 text-violet-400 border-violet-500/25" },
    failed:    { label: "Failed",    className: "bg-red-500/10 text-red-400 border-red-500/25" },
    pending:   { label: "Pending",   className: "bg-amber-500/10 text-amber-400 border-amber-500/25" },
  };
  const c = cfg[status ?? "pending"] ?? cfg.pending;
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded border font-medium", c.className)}>{c.label}</span>
  );
}

/* ── Main page ─────────────────────────────────────────────────────────────── */
export default function EngagementDashboard() {
  const { toast } = useToast();
  const { user } = useAuth() as any;
  const isPlatformAdmin = user?.role === "platform_admin";
  const { data, isLoading, refetch, isFetching } = useEngagement();
  const reengageMutation = useRunReengagement();
  const { data: checkinData } = useStatusCheckin();
  const checkinMutation = useRunStatusCheckin();
  const lastCheckin = checkinData?.lastScan ?? null;

  async function handleRunStatusCheckin() {
    try {
      const result = await checkinMutation.mutateAsync(undefined as any);
      toast({
        title: "Status check-in run complete",
        description: `${pluralize(result.emailsSent ?? 0, "email")} sent · ${result.skipped ?? 0} skipped`,
      });
    } catch {
      toast({ title: "Status check-in failed", description: "Could not run the status check-in engine.", variant: "destructive" });
    }
  }

  const pool     = data?.poolHealth        ?? { active: 0, passive: 0, inactive: 0, total: 0 };
  const reeng    = data?.reengagementSent  ?? { total: 0, thisMonth: 0, trend: [] };
  const commTypes = data?.commsByType      ?? [];
  const recent   = data?.recentEvents      ?? [];
  const ghost    = data?.ghostingSummary   ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const outreach = data?.outreachSummary   ?? { totalSent: 0, totalReplied: 0, replyRate: 0, campaigns: 0 };

  const needsReEngagement = pool.passive + pool.inactive;

  async function handleRunReengagement() {
    try {
      const result = await reengageMutation.mutateAsync(undefined as any);
      toast({
        title: "Re-engagement run complete",
        description: `${pluralize(result.sent, "email")} sent · ${result.skipped} skipped`,
      });
      refetch();
    } catch {
      toast({ title: "Re-engagement failed", description: "Could not run the re-engagement engine.", variant: "destructive" });
    }
  }

  return (
    <AppLayout>
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-6 h-6 text-violet-400" />
            <h1 className="page-title">Engagement Engine</h1>
          </div>
          <p className="text-muted-foreground">
            Monitor candidate re-engagement, platform pool health, and automated outreach performance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRunReengagement}
            disabled={reengageMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-violet-500/40 bg-violet-500/10 hover:bg-violet-500/20 text-sm font-medium text-violet-300 hover:text-violet-200 transition-all disabled:opacity-50"
          >
            {reengageMutation.isPending
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Send className="w-4 h-4" />}
            {reengageMutation.isPending ? "Running…" : "Run Re-engagement"}
          </button>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border/50 bg-card hover:bg-card/80 text-sm font-medium text-muted-foreground hover:text-foreground transition-all"
          >
            <RefreshCw className={cn("w-4 h-4", isFetching && "animate-spin")} />
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* ── Stat cards ── */}
      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="border-border/30 animate-pulse">
              <CardContent className="p-5 h-20" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <StatCard label="Active in Pool"        value={pool.active}         icon={Activity}      color="text-emerald-400" sub="Updated within 30 days" />
          <StatCard label="Need Re-engagement"    value={needsReEngagement}   icon={Clock}         color="text-amber-400"   sub={`${pool.passive} passive · ${pool.inactive} inactive`} />
          <StatCard label="Re-engagement Emails"  value={reeng.thisMonth}     icon={Mail}          color="text-violet-400"  sub="sent this month" />
          <StatCard label="Outreach Reply Rate"   value={`${outreach.replyRate}%`} icon={TrendingUp} color="text-sky-400" sub={`${outreach.totalReplied} of ${outreach.totalSent} replied`} />
        </div>
      )}

      {/* ── Row 1: Pool health + Re-engagement trend ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">

        {/* Platform Pool Health */}
        <Card className="border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Database className="w-4 h-4 text-sky-400" />
              Platform Pool Health
              <Badge className="ml-auto text-[10px] px-1.5 py-0 h-5 bg-sky-500/10 text-sky-400 border border-sky-500/20">
                {pool.total} total
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <div className="h-48 animate-pulse bg-muted/30 rounded-lg" /> : (
              <>
                <PoolHealthChart data={pool} />
                {/* Legend bars */}
                {pool.total > 0 && (
                  <div className="mt-2 grid grid-cols-3 gap-2 text-center text-[11px]">
                    {[
                      { label: "Active",   value: pool.active,   color: "bg-emerald-400", pct: Math.round(pool.active / pool.total * 100) },
                      { label: "Passive",  value: pool.passive,  color: "bg-amber-400",   pct: Math.round(pool.passive / pool.total * 100) },
                      { label: "Inactive", value: pool.inactive, color: "bg-rose-400",    pct: Math.round(pool.inactive / pool.total * 100) },
                    ].map(({ label, value, color, pct }) => (
                      <div key={label} className="space-y-1">
                        <div className={cn("h-1.5 rounded-full mx-auto w-full max-w-[60px]", color)} style={{ opacity: 0.7 + pct / 300 }} />
                        <p className="font-semibold tabular-nums">{value}</p>
                        <p className="text-muted-foreground">{label} ({pct}%)</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Re-engagement email trend */}
        <Card className="border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Mail className="w-4 h-4 text-violet-400" />
              Re-engagement Emails — Last 14 Days
              <Badge className="ml-auto text-[10px] px-1.5 py-0 h-5 bg-violet-500/10 text-violet-400 border border-violet-500/20">
                {reeng.total} all-time
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <div className="h-48 animate-pulse bg-muted/30 rounded-lg" /> : (
              <ReengagementTrend trend={reeng.trend} />
            )}
            {!isLoading && reeng.total === 0 && (
              <p className="text-center text-xs text-muted-foreground mt-2">
                The re-engagement scheduler runs every 24 hours and sends emails to passive &amp; inactive candidates.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Row 2: Communications by type + Ghosting risks ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">

        {/* Communications by type */}
        <Card className="border-border/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Send className="w-4 h-4 text-cyan-400" />
              Email Types — Last 30 Days
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? <div className="h-48 animate-pulse bg-muted/30 rounded-lg" /> : (
              <CommsByTypeChart data={commTypes} />
            )}
          </CardContent>
        </Card>

        {/* Ghosting risk + Outreach summary */}
        <div className="space-y-4">
          {/* Ghosting risks */}
          <Card className="border-border/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-400" />
                Ghosting Risk Monitor
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <div className="h-20 animate-pulse bg-muted/30 rounded-lg" /> : (
                <div className="grid grid-cols-4 gap-3">
                  {[
                    { label: "Critical", value: ghost.critical, color: "text-red-400", bg: "bg-red-500/10 border-red-500/25" },
                    { label: "High",     value: ghost.high,     color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/25" },
                    { label: "Medium",   value: ghost.medium,   color: "text-amber-400",  bg: "bg-amber-500/10 border-amber-500/25" },
                    { label: "Low",      value: ghost.low,      color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/25" },
                  ].map(({ label, value, color, bg }) => (
                    <div key={label} className={cn("rounded-lg border p-3 text-center", bg)}>
                      <p className={cn("text-xl font-bold tabular-nums", color)}>{value}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3">
                <Link href="/anti-ghost">
                  <span className="text-xs text-primary hover:underline cursor-pointer">
                    View anti-ghosting engine →
                  </span>
                </Link>
              </div>
            </CardContent>
          </Card>

          {/* Outreach summary */}
          <Card className="border-border/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <MailOpen className="w-4 h-4 text-sky-400" />
                Outreach Campaigns
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? <div className="h-20 animate-pulse bg-muted/30 rounded-lg" /> : (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Campaigns",  value: outreach.campaigns,    color: "text-sky-400" },
                    { label: "Emails Sent", value: outreach.totalSent,   color: "text-violet-400" },
                    { label: "Reply Rate", value: `${outreach.replyRate}%`, color: "text-emerald-400" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="text-center">
                      <p className={cn("text-xl font-bold tabular-nums", color)}>{value}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-3">
                <Link href="/outreach">
                  <span className="text-xs text-primary hover:underline cursor-pointer">
                    Manage campaigns →
                  </span>
                </Link>
              </div>
            </CardContent>
          </Card>

          {/* Candidate status check-ins */}
          <Card className="border-border/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <CalendarClock className="w-4 h-4 text-teal-400" />
                Candidate Status Check-ins
                <Badge className="ml-auto text-[10px] px-1.5 py-0 h-5 bg-teal-500/10 text-teal-400 border border-teal-500/20">
                  Runs daily
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Every day, candidates whose profile hasn't been updated in 6+ months get a
                friendly "has anything changed?" email — at most one every 90 days per candidate.
              </p>
              {lastCheckin ? (
                <div className="grid grid-cols-3 gap-3 mb-3">
                  {[
                    { label: "Checked",     value: lastCheckin.scanned ?? 0,    color: "text-teal-400" },
                    { label: "Emails Sent", value: lastCheckin.emailsSent ?? 0, color: "text-violet-400" },
                    { label: "Skipped",     value: lastCheckin.skipped ?? 0,    color: "text-muted-foreground" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="text-center">
                      <p className={cn("text-xl font-bold tabular-nums", color)}>{value}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground mb-3 italic">
                  No run since the last server restart — the next scheduled run happens automatically.
                </p>
              )}
              <div className="flex items-center justify-between">
                {lastCheckin?.ranAt && (
                  <span className="text-[11px] text-muted-foreground">
                    Last run {new Date(lastCheckin.ranAt).toLocaleString()}
                  </span>
                )}
                {isPlatformAdmin && (
                  <button
                    onClick={handleRunStatusCheckin}
                    disabled={checkinMutation.isPending}
                    className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-teal-500/40 bg-teal-500/10 hover:bg-teal-500/20 text-xs font-medium text-teal-300 hover:text-teal-200 transition-all disabled:opacity-50"
                  >
                    {checkinMutation.isPending
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Send className="w-3.5 h-3.5" />}
                    {checkinMutation.isPending ? "Running…" : "Run Now"}
                  </button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Recent re-engagement events ── */}
      <Card className="border-border/40">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Mail className="w-4 h-4 text-violet-400" />
            Recent Re-engagement Emails
            {!isLoading && recent.length > 0 && (
              <Badge className="ml-auto text-[10px] px-1.5 py-0 h-5 bg-muted/50 text-muted-foreground border">
                {recent.length} shown
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-10 bg-muted/30 rounded-lg animate-pulse" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <div className="py-10 text-center">
              <Mail className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No re-engagement emails sent yet.</p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                The scheduler runs automatically every 24 hours and targets passive &amp; inactive platform candidates.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {recent.map((ev: any) => {
                const ts = ev.sentAt ? new Date(ev.sentAt) : null;
                const timeLabel = ts ? ts.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
                return (
                  <div key={ev.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-muted/20 hover:bg-muted/30 transition-colors">
                    <div className="w-7 h-7 rounded-full bg-violet-500/15 border border-violet-500/25 flex items-center justify-center shrink-0">
                      <Mail className="w-3.5 h-3.5 text-violet-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {ev.candidateName}
                      </p>
                      {ev.subject && (
                        <p className="text-xs text-muted-foreground truncate">{ev.subject}</p>
                      )}
                    </div>
                    <StatusBadge status={ev.status} />
                    <span className="text-[10px] text-muted-foreground shrink-0">{timeLabel}</span>
                    {ev.candidateId && (
                      <Link href={`/candidates/${ev.candidateId}`}>
                        <span className="text-[10px] text-primary hover:underline cursor-pointer shrink-0">View →</span>
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </AppLayout>
  );
}
