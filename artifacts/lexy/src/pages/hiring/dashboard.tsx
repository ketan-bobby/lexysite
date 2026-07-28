/**
 * pages/hiring/dashboard.tsx — Hiring Manager Dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Default home page for hiring_manager role users after login. Provides an
 * at-a-glance summary of their assigned jobs, upcoming interviews, and
 * candidates awaiting their feedback.
 *
 * ─── Key sections ────────────────────────────────────────────────────────────
 *   KPI Strip          — open jobs, interviewing candidates, completed
 *                        interviews, pending feedback items
 *   Upcoming Interviews — next 5 scheduled sessions with candidate name + job
 *   Awaiting Feedback   — candidates in "interviewing" stage with no HM score
 *   Recent Hires        — last 5 candidates who moved to "hired" in their jobs
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/jobs?assignedHiringManagerId=<userId>
 *   GET /api/interviews?hiringManagerId=<userId>&status=pending
 *   GET /api/candidates?stage=interviewing&needsHmFeedback=true
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   /hiring/dashboard  (default route for hiring_manager role)
 */
import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Briefcase, Users, Video, ChevronRight, Loader2, ArrowRight } from "lucide-react";
import { Link } from "wouter";
import { apiFetch, apiBase } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const stageColors: Record<string, string> = {
  shortlisted:  "bg-blue-500/10 text-blue-400 border-blue-500/25",
  interview:    "bg-violet-500/10 text-violet-400 border-violet-500/25",
  offer:        "bg-amber-500/10 text-amber-400 border-amber-500/25",
  hired:        "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
};

export default function HiringDashboard() {
  const { user } = useAuth();
  const [jobs, setJobs]             = useState<any[]>([]);
  const [candidates, setCandidates] = useState<any[]>([]);
  const [interviews, setInterviews] = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    Promise.all([
      apiFetch(`${apiBase}/jobs`).then(r => r.json()).then((d: any) => setJobs(Array.isArray(d) ? d : d.jobs ?? [])),
      apiFetch(`${apiBase}/candidates`).then(r => r.json()).then((d: any) => setCandidates(Array.isArray(d) ? d : d.candidates ?? [])),
      apiFetch(`${apiBase}/interviews`).then(r => r.json()).then((d: any) => setInterviews(Array.isArray(d) ? d : d.interviews ?? [])),
    ]).finally(() => setLoading(false));
  }, []);

  const activeJobs = jobs.filter((j: any) => j.status === "active");

  const upcomingInterviews = interviews
    .filter((i: any) => i.scheduledAt && new Date(i.scheduledAt) > new Date())
    .sort((a: any, b: any) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
    .slice(0, 5);

  const recentCandidates = [...candidates]
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  const stats = [
    { label: "Open Roles",          value: activeJobs.length,         icon: Briefcase, color: "text-blue-400",   href: "/hiring/jobs"        },
    { label: "Total Candidates",    value: candidates.length,         icon: Users,     color: "text-violet-400", href: "/hiring/candidates"  },
    { label: "Upcoming Interviews", value: upcomingInterviews.length, icon: Video,     color: "text-cyan-400",   href: "/hiring/interviews"  },
  ];

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Welcome back, {user?.name?.split(" ")[0]}</h1>
          <p className="text-muted-foreground text-sm mt-1">Here's what's happening with your hiring pipeline today.</p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {/* Stat cards — all clickable */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {stats.map((s) => (
                <Link key={s.label} href={s.href}>
                  <Card className="cursor-pointer hover:border-primary/40 hover:shadow-md hover:shadow-primary/5 transition-all group">
                    <CardContent className="p-5 flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/15 transition-colors">
                        <s.icon className={`w-6 h-6 ${s.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-2xl font-bold">{s.value}</p>
                        <p className="text-sm text-muted-foreground">{s.label}</p>
                      </div>
                      <ArrowRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Active roles */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center justify-between">
                    Open Roles
                    <Link href="/hiring/jobs">
                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                        View all <ChevronRight className="w-3 h-3" />
                      </Button>
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {activeJobs.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No active roles right now</p>
                  ) : activeJobs.slice(0, 5).map((job: any) => (
                    <Link key={job.id} href={`/jobs/${job.id}`}>
                      <div className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/60 hover:border hover:border-primary/20 transition-all cursor-pointer group border border-transparent">
                        <div className="min-w-0">
                          <p className="text-sm font-medium group-hover:text-primary transition-colors truncate">{job.title}</p>
                          <p className="text-xs text-muted-foreground">{[job.department, job.location].filter(Boolean).join(" · ")}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                          <Badge variant="outline" className="text-emerald-400 border-emerald-500/25 bg-emerald-500/10 text-xs">Active</Badge>
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    </Link>
                  ))}
                </CardContent>
              </Card>

              {/* Upcoming interviews */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-semibold flex items-center justify-between">
                    Upcoming Interviews
                    <Link href="/hiring/interviews">
                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                        View all <ChevronRight className="w-3 h-3" />
                      </Button>
                    </Link>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {upcomingInterviews.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">No upcoming interviews</p>
                  ) : upcomingInterviews.map((iv: any) => (
                    <Link key={iv.id} href="/hiring/interviews">
                      <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 hover:bg-muted/60 hover:border hover:border-primary/20 transition-all cursor-pointer group border border-transparent">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 group-hover:bg-primary/20 transition-colors">
                          <Video className="w-4 h-4 text-primary" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">{iv.candidateName || "Candidate"}</p>
                          <p className="text-xs text-muted-foreground">
                            {iv.scheduledAt
                              ? new Date(iv.scheduledAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                              : "TBD"}
                          </p>
                        </div>
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                      </div>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            </div>

            {/* Recent candidates */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center justify-between">
                  Recent Candidates
                  <Link href="/hiring/candidates">
                    <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                      View all <ChevronRight className="w-3 h-3" />
                    </Button>
                  </Link>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {recentCandidates.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No candidates yet</p>
                ) : (
                  <div className="divide-y divide-border/40">
                    {recentCandidates.map((c: any) => (
                      <Link key={c.id} href="/hiring/candidates">
                        <div className="py-3 flex items-center justify-between cursor-pointer hover:bg-muted/30 rounded-lg px-2 -mx-2 transition-colors group">
                          <div className="min-w-0">
                            <p className="text-sm font-medium group-hover:text-primary transition-colors">{c.firstName} {c.lastName}</p>
                            <p className="text-xs text-muted-foreground truncate">{[c.jobTitle, c.email].filter(Boolean).join(" · ")}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-2">
                            <Badge variant="outline" className={`text-xs ${stageColors[c.currentStage] || "text-muted-foreground"}`}>
                              {c.currentStage?.replace(/_/g, " ") || "Applied"}
                            </Badge>
                            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppLayout>
  );
}
