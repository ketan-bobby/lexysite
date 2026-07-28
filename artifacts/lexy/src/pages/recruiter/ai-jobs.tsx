/**
 * pages/recruiter/ai-jobs.tsx — AI Job Queue admin dashboard
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * Shows the health of post-interview AI processing. When a candidate finishes
 * an interview, the synchronous /end route no longer runs the LLM inline — it
 * enqueues a `summarize_interview` job into the Postgres-backed `ai_jobs` queue,
 * which a worker drains (grading → summary → intelligence enrichment → match
 * rescore) with retries/backoff. This dashboard lets staff watch that queue and
 * manually retry anything that failed.
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET  /api/admin/ai-jobs/stats
 *   GET  /api/admin/ai-jobs?status=...&limit=...
 *   POST /api/admin/ai-jobs/:jobId/retry
 *
 * ─── Access ──────────────────────────────────────────────────────────────────
 * Staff only (recruiter / tenant_admin / platform_admin). The API gate is the
 * real boundary; the route's role guard is just UX. Non-platform_admin staff
 * only ever see jobs inside their own tenant subtree.
 */
import { useEffect, useState, useCallback } from "react";
import { authHeaders } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Bot, RefreshCw, RotateCcw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

type Stats = { pending: number; processing: number; completed: number; failed: number };

type JobRow = {
  id: string;
  type: string;
  status: "pending" | "processing" | "completed" | "failed";
  retryCount: number;
  maxAttempts: number;
  lastError: string | null;
  priority: number;
  runAt: string | null;
  lockedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  tenantId: string | null;
  interviewSessionId: string | null;
  candidateName: string | null;
  jobTitle: string | null;
};

const STATUS_FILTERS = ["all", "pending", "processing", "completed", "failed"] as const;

function statusColor(status: string): string {
  switch (status) {
    case "completed":  return "bg-emerald-500/15 text-emerald-600 border-emerald-500/30";
    case "processing": return "bg-cyan-500/15 text-cyan-600 border-cyan-500/30";
    case "pending":    return "bg-amber-500/15 text-amber-600 border-amber-500/30";
    case "failed":     return "bg-rose-500/15 text-rose-600 border-rose-500/30";
    default:           return "bg-slate-500/15 text-slate-600 border-slate-500/30";
  }
}

export default function AiJobsDashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<JobRow[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true); setError(null);
    try {
      const auth = { ...authHeaders() };
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter !== "all") params.set("status", statusFilter);
      const [statsRes, listRes] = await Promise.all([
        fetch(`${apiBase}/admin/ai-jobs/stats`, { headers: auth, credentials: "include" }),
        fetch(`${apiBase}/admin/ai-jobs?${params.toString()}`, { headers: auth, credentials: "include" }),
      ]);
      if (!statsRes.ok) throw new Error(`Stats: HTTP ${statsRes.status}`);
      if (!listRes.ok)  throw new Error(`List: HTTP ${listRes.status}`);
      setStats(await statsRes.json());
      setRows(await listRes.json());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [user?.id, statusFilter]);

  useEffect(() => { load(); }, [load]);

  /* Auto-refresh while anything is in flight so the recruiter sees jobs drain
     without manually refreshing. */
  useEffect(() => {
    if (!stats) return;
    if (stats.pending === 0 && stats.processing === 0) return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [stats, load]);

  async function retry(jobId: string) {
    if (!user) return;
    setRetrying((p) => new Set(p).add(jobId));
    try {
      const res = await fetch(`${apiBase}/admin/ai-jobs/${jobId}/retry`, {
        method: "POST",
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error(`Retry failed: HTTP ${res.status}`);
      await load();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setRetrying((p) => { const n = new Set(p); n.delete(jobId); return n; });
    }
  }

  return (
    <AppLayout>
      <div className="px-6 py-6 space-y-6 max-w-[1400px] mx-auto">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title flex items-center gap-2">
              <Bot className="w-6 h-6 text-cyan-500" />
              AI Job Queue
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Post-interview AI processing — grading, summaries, candidate
              intelligence, and match rescoring run asynchronously here so the
              live interview stays fast.
            </p>
          </div>
          <Button onClick={load} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={"w-4 h-4 mr-2 " + (loading ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>

        {/* ── KPI cards ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Pending"    value={stats?.pending ?? "—"}    tone="warn" />
          <KpiCard label="Processing" value={stats?.processing ?? "—"} tone="info" />
          <KpiCard label="Completed"  value={stats?.completed ?? "—"}  tone="ok" />
          <KpiCard label="Failed"     value={stats?.failed ?? "—"}     tone={stats && stats.failed > 0 ? "danger" : "ok"} />
        </div>

        {/* ── Filter bar ───────────────────────────────────────────────── */}
        <Card>
          <CardContent className="pt-6 flex flex-wrap gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Status</label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-700 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* ── Job list ─────────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              Jobs {rows ? <span className="text-muted-foreground font-normal">({rows.length})</span> : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {!rows ? (
              <div className="text-sm text-muted-foreground py-12 text-center">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="text-sm text-muted-foreground py-12 text-center">
                No jobs in this view.
              </div>
            ) : (
              <div className="divide-y">
                {rows.map((r) => (
                  <div key={r.id} className="px-4 py-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <Badge variant="outline" className={statusColor(r.status)}>{r.status}</Badge>
                        <code className="text-xs font-mono text-muted-foreground">{r.type}</code>
                        {r.retryCount > 0 && (
                          <span className="text-xs text-muted-foreground">
                            attempt {r.retryCount}/{r.maxAttempts}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground ml-auto">
                          {r.createdAt ? formatDistanceToNow(new Date(r.createdAt), { addSuffix: true }) : "—"}
                        </span>
                      </div>
                      <div className="text-sm">
                        <span className="font-medium">{r.candidateName ?? "Unknown candidate"}</span>
                        {r.jobTitle && <span className="text-muted-foreground"> · {r.jobTitle}</span>}
                      </div>
                      {r.lastError && (
                        <div className="mt-1 text-xs text-rose-600 font-mono break-all">{r.lastError}</div>
                      )}
                    </div>
                    {(r.status === "failed" || r.status === "pending") && (
                      <Button
                        onClick={() => retry(r.id)}
                        disabled={retrying.has(r.id)}
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                      >
                        {retrying.has(r.id)
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <><RotateCcw className="w-4 h-4 mr-1.5" />Retry</>}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

function KpiCard({ label, value, tone }: { label: string; value: number | string; tone: "ok" | "warn" | "info" | "danger" }) {
  const toneCls =
    tone === "danger" ? "text-rose-600" :
    tone === "warn"   ? "text-amber-600" :
    tone === "info"   ? "text-cyan-600" :
                        "text-emerald-600";
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={"text-2xl font-semibold mt-1 " + toneCls}>{value}</div>
      </CardContent>
    </Card>
  );
}
