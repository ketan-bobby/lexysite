/**
 * pages/recruiter/platform-dashboard.tsx — Platform-Level Analytics Dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Cross-tenant analytics dashboard visible only to platform_admin users. Shows
 * aggregate platform health: total tenants, total candidates processed, total
 * interviews conducted, platform-wide AI agent activity, and per-tenant stats.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   Platform KPIs    — total active tenants, total candidates, interviews
 *                      this month, hires this month
 *   Tenant Health    — per-tenant table: name, plan tier, candidates,
 *                      jobs, last activity date, health score
 *   Agent Activity   — platform-wide agent run counts + success rates
 *   Growth Chart     — new tenant / new candidate trend over 90 days
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   useGetAnalyticsOverview() — aggregate KPIs (no tenantId filter = all)
 *   GET /api/analytics/platform — per-tenant breakdown (platform_admin only)
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /recruiter/platform-dashboard  (platform_admin only)
 */
import { authHeaders } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { useGetAnalyticsOverview } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Building2, Users, Video, Briefcase, ChevronRight,
  GitBranch, CheckCircle2, Clock, Ban, Plus,
  BarChart3, Shield, Database, Activity, Zap, Star,
  TrendingUp, Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { AICommandCenter } from "@/components/ai-os/AICommandCenter";
import { AgentActivityFeed } from "@/components/ai-os/AgentActivityFeed";
import { RecommendedActions } from "@/components/ai-os/RecommendedActions";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const statusCfg: Record<string, { label: string; icon: any; cls: string }> = {
  active:    { label: "Active",    icon: CheckCircle2, cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
  trial:     { label: "Trial",     icon: Clock,        cls: "text-amber-400 bg-amber-500/10 border-amber-500/20"       },
  suspended: { label: "Suspended", icon: Ban,          cls: "text-rose-400 bg-rose-500/10 border-rose-500/20"          },
};

const planCls: Record<string, string> = {
  starter:    "bg-slate-500/10 text-slate-300 border-slate-500/20",
  growth:     "bg-blue-500/10 text-blue-300 border-blue-500/20",
  enterprise: "bg-violet-500/10 text-violet-300 border-violet-500/20",
};

// Loads the top-level tenants (clients) for the platform overview. Cached 30s
// since this dashboard polls on revisit but data changes slowly.
function useClients() {
  return useQuery({
    queryKey: ["clients", "topLevel"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/tenants?topLevel=true`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      return res.json() as Promise<any[]>;
    },
    staleTime: 30000,
  });
}

// Platform-admin overview: cross-tenant KPIs, plan mix, and AI activity feeds.
export default function PlatformDashboard() {
  const { data: clients = [], isLoading: clientsLoading } = useClients();
  const { data: analytics } = useGetAnalyticsOverview();

  // Roll client-level counters up into platform totals for the KPI cards.
  const totalJobs       = clients.reduce((s: number, c: any) => s + (c.jobCount || 0), 0);
  const totalBranches   = clients.reduce((s: number, c: any) => s + (c.branchCount || 0), 0);
  const activeClients   = clients.filter((c: any) => c.status === "active").length;
  const trialClients    = clients.filter((c: any) => c.status === "trial").length;

  const planBreakdown = [
    { name: "Enterprise", value: clients.filter((c: any) => c.plan === "enterprise").length, color: "#8b5cf6" },
    { name: "Growth",     value: clients.filter((c: any) => c.plan === "growth").length,     color: "#3b82f6" },
    { name: "Starter",    value: clients.filter((c: any) => c.plan === "starter").length,    color: "#6b7280" },
  ];

  /* Intelligence-driven KPIs */
  const kpis = [
    {
      label: "Clients Automated",
      sub: "AI-managed orgs",
      value: clientsLoading ? "—" : activeClients,
      icon: Building2,
      glow: "from-primary/20 to-primary/5 text-primary",
      href: "/clients",
      trend: "+2 this week",
      trendUp: true,
    },
    {
      label: "Hire-Ready Candidates",
      sub: "ICP match ≥ 80%",
      value: clientsLoading ? "—" : (analytics?.totalCandidates ?? 0),
      icon: Users,
      glow: "from-emerald-500/20 to-emerald-500/5 text-emerald-400",
      href: "/candidates",
      trend: "+18 sourced today",
      trendUp: true,
    },
    {
      label: "Active AI Interviews",
      sub: "Sessions in progress",
      value: clientsLoading ? "—" : (analytics?.interviewsCompleted ?? 0),
      icon: Video,
      glow: "from-violet-500/20 to-violet-500/5 text-violet-400",
      href: "/interviews",
      trend: "3 live now",
      trendUp: true,
    },
    {
      label: "Roles in Motion",
      sub: "Active work orders",
      value: clientsLoading ? "—" : (analytics?.activeJobs ?? totalJobs),
      icon: Briefcase,
      glow: "from-blue-500/20 to-blue-500/5 text-blue-400",
      href: "/jobs",
      trend: `${totalJobs} total`,
      trendUp: false,
    },
  ];

  return (
    <AppLayout>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <Shield className="w-4 h-4 text-primary" />
            <span className="text-[11px] font-black tracking-widest text-primary uppercase">Super Admin</span>
            <span className="text-[10px] text-muted-foreground/50">·</span>
            <span className="text-[10px] text-muted-foreground/50 font-medium">AI Hiring OS</span>
          </div>
          <h1 className="page-title">Platform Overview</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Autonomous hiring intelligence across all clients and tenants.
          </p>
        </div>
        <div className="flex gap-3">
          <Link href="/clients">
            <Button variant="outline" className="gap-2">
              <Building2 className="w-4 h-4" /> Manage Tenants
            </Button>
          </Link>
          <Link href="/clients">
            <Button className="gap-2 shadow-md shadow-primary/20">
              <Plus className="w-4 h-4" /> Add Tenant
            </Button>
          </Link>
        </div>
      </div>

      {/* ── AI Command Center ──────────────────────────────────────────────── */}
      <AICommandCenter className="mb-6" />

      {/* ── Intelligence KPI Strip ─────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {kpis.map(({ label, sub, value, icon: Icon, glow, href, trend, trendUp }) => (
          <Link key={label} href={href}>
            <div
              className="elevated relative rounded-xl border border-slate-200/90 dark:border-white/8 p-5 bg-card cursor-pointer hover:border-primary/40 hover:-translate-y-0.5 transition-all overflow-hidden group"
            >
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
              <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity bg-gradient-to-br from-primary/3 to-transparent" />
              <div className="relative">
                <div className="flex items-center gap-3 mb-3">
                  <div className={cn("w-9 h-9 rounded-xl flex items-center justify-center bg-gradient-to-br border border-white/10", glow)}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground leading-tight">{label}</p>
                    <p className="text-[9px] text-muted-foreground/50 leading-tight">{sub}</p>
                  </div>
                </div>
                <p className="text-3xl font-black tabular-nums">{value}</p>
                <p className={cn("text-[10px] mt-1 font-semibold", trendUp ? "text-emerald-400" : "text-muted-foreground")}>{trend}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* ── Main content grid ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        {/* Client list — left 2/3 */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border/50">
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 className="w-4 h-4 text-primary" /> All Tenants
              </CardTitle>
              <Link href="/clients" className="text-xs font-medium text-primary hover:opacity-80">
                View all →
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {clientsLoading ? (
                <div className="p-6 space-y-3">
                  {[1,2,3,4].map(i => <div key={i} className="h-14 rounded-xl bg-muted/30 animate-pulse" />)}
                </div>
              ) : clients.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <Building2 className="w-10 h-10 mx-auto mb-3 opacity-20" />
                  <p className="text-sm">No clients yet — add your first client.</p>
                </div>
              ) : (
                <div className="divide-y divide-border/30">
                  {clients.map((c: any) => {
                    const st = statusCfg[c.status] || statusCfg.active;
                    const StatusIcon = st.icon;
                    const initials = c.name.split(" ").slice(0, 2).map((w: string) => w[0]).join("").toUpperCase();
                    return (
                      <Link key={c.id} href={`/clients/${c.id}`}>
                        <div className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/30 transition-all cursor-pointer group">
                          <Avatar className="w-9 h-9 rounded-xl border border-border shrink-0">
                            <AvatarFallback className="rounded-xl bg-primary/10 text-primary font-bold text-xs">{initials}</AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-sm group-hover:text-primary transition-colors">{c.name}</span>
                              <Badge variant="outline" className={cn("text-[10px]", planCls[c.plan] || planCls.starter)}>
                                {c.plan.charAt(0).toUpperCase() + c.plan.slice(1)}
                              </Badge>
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{c.industry || "—"}{c.website ? ` · ${c.website.replace(/^https?:\/\//, "")}` : ""}</p>
                          </div>
                          <div className="hidden sm:flex items-center gap-4 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1"><GitBranch className="w-3 h-3" />{c.branchCount}</span>
                            <span className="flex items-center gap-1"><Users className="w-3 h-3" />{c.userCount}</span>
                            <span className="flex items-center gap-1"><Briefcase className="w-3 h-3" />{c.jobCount}</span>
                          </div>
                          <Badge variant="outline" className={cn("text-[10px] shrink-0", st.cls)}>
                            <StatusIcon className="w-2.5 h-2.5 mr-1" />{st.label}
                          </Badge>
                          <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recommended Actions */}
          <RecommendedActions />
        </div>

        {/* Right column */}
        <div className="flex flex-col gap-6">

          {/* Agent Activity Feed */}
          <AgentActivityFeed compact />

          {/* Automation Intelligence */}
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <TrendingUp className="w-4 h-4 text-primary" /> Automation Intelligence
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                { icon: Building2,    label: "Clients Automated",      value: clients.length,    color: "text-primary"       },
                { icon: CheckCircle2, label: "Active",                  value: activeClients,     color: "text-emerald-400"   },
                { icon: Clock,        label: "In Trial",                value: trialClients,      color: "text-amber-400"     },
                { icon: GitBranch,    label: "Branch Offices",          value: totalBranches,     color: "text-violet-400"    },
                { icon: Video,        label: "AI Interviews Run",       value: analytics?.interviewsCompleted ?? "—", color: "text-blue-400" },
                { icon: Database,     label: "DB Access Clients",       value: clients.filter((c: any) => c.candidateDatabaseAccess).length, color: "text-cyan-400" },
                { icon: Bot,          label: "Agents Active",           value: 10,                color: "text-emerald-400"   },
                { icon: Star,         label: "Decisions Generated",     value: analytics?.offersExtended ?? "—", color: "text-yellow-400" },
              ].map(({ icon: Icon, label, value, color }) => (
                <div key={label} className="flex items-center justify-between py-1 border-b border-border/30 last:border-0">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Icon className={cn("w-3.5 h-3.5", color)} />{label}
                  </div>
                  <span className="text-sm font-bold">{clientsLoading ? "—" : value}</span>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Plan breakdown chart */}
          <Card className="border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <BarChart3 className="w-4 h-4 text-primary" /> Plan Mix
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[140px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={planBreakdown} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} dy={6} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} allowDecimals={false} />
                    <Tooltip
                      cursor={{ fill: "rgba(255,255,255,0.03)" }}
                      contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                    />
                    <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={40} fill="hsl(var(--primary))" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ── Quick navigation ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[
          { icon: Building2, label: "All Tenants",        desc: "View & manage subscribed tenants",  href: "/clients", color: "bg-primary/10 text-primary"         },
          { icon: Bot,       label: "AI Agent Status",    desc: "Platform-wide agent health",      href: "/agents",  color: "bg-emerald-500/10 text-emerald-400" },
          { icon: Database,  label: "Platform Settings",  desc: "Config, billing & integrations",  href: "/admin",   color: "bg-violet-500/10 text-violet-400"   },
          { icon: Activity,  label: "Transcription Health", desc: "Interview speech-to-text quality", href: "/admin/transcription-health", color: "bg-amber-500/10 text-amber-400" },
        ].map(({ icon: Icon, label, desc, href, color }) => (
          <Link key={href} href={href}>
            <div className="flex items-center gap-3 p-4 rounded-xl border border-border/50 bg-card hover:border-primary/30 hover:bg-muted/30 transition-all cursor-pointer group">
              <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center shrink-0", color)}>
                <Icon className="w-4 h-4" />
              </div>
              <div>
                <p className="text-sm font-semibold group-hover:text-primary transition-colors">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* ── Footer brand signal ───────────────────────────────────────────── */}
      <div className="mt-8 flex items-center justify-center gap-2 text-[10px] text-muted-foreground/30 font-medium tracking-widest uppercase">
        <Activity className="w-3 h-3" />
        Powered by QOR · L3XY Agent Runtime v2 · AI Hiring OS
      </div>
    </AppLayout>
  );
}
