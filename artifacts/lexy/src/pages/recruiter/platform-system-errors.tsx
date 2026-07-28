/**
 * pages/recruiter/platform-system-errors.tsx — Platform Admin "System Errors" Page
 *
 * ─── What this page does ────────────────────────────────────────────────────
 * The self-hosted "Sentry dashboard". Lists every runtime error the api-server
 * captured into the `system_errors` table — Express 5xx/4xx, uncaught
 * exceptions, and unhandled promise rejections — with summary counts grouped
 * by route and by source so a platform admin can spot a spike at a glance.
 *
 * ─── Data sources ────────────────────────────────────────────────────────────
 *   GET /api/admin/system-errors/summary?sinceMinutes=N
 *   GET /api/admin/system-errors?sinceMinutes=N&source=...&routePath=...&limit=200
 *
 * ─── Access ──────────────────────────────────────────────────────────────────
 * platform_admin only — non-admins are redirected to /dashboard. The API gate
 * is the actual boundary; this client guard is just UX.
 */
import { authHeaders } from "@/lib/api";
import { useEffect, useState, useCallback } from "react";
import { Redirect } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, AlertTriangle, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

type Summary = {
  windowMinutes: number;
  total: number;
  bySource: { source: string; count: number }[];
  byRoute: { routePath: string | null; count: number; lastSeen: string | null }[];
};

type ErrorRow = {
  id: string;
  occurredAt: string;
  source: string;
  statusCode: number | null;
  method: string | null;
  routePath: string | null;
  errorName: string | null;
  message: string;
  stack: string | null;
  tenantId: string | null;
  userId: string | null;
  requestId: string | null;
  extra: Record<string, unknown> | null;
};

const WINDOWS: { label: string; minutes: number }[] = [
  { label: "Last 15 min",  minutes: 15 },
  { label: "Last hour",    minutes: 60 },
  { label: "Last 6 hours", minutes: 360 },
  { label: "Last 24 hrs",  minutes: 1440 },
  { label: "Last 7 days",  minutes: 10080 },
];

const SOURCES = ["all", "express", "uncaughtException", "unhandledRejection", "scheduler", "manual"] as const;

// Badge colours per error source (uncaught/unhandled are the most severe).
function sourceColor(source: string): string {
  switch (source) {
    case "uncaughtException":  return "bg-rose-500/15 text-rose-600 border-rose-500/30";
    case "unhandledRejection": return "bg-orange-500/15 text-orange-600 border-orange-500/30";
    case "express":            return "bg-amber-500/15 text-amber-600 border-amber-500/30";
    case "scheduler":          return "bg-cyan-500/15 text-cyan-600 border-cyan-500/30";
    default:                   return "bg-slate-500/15 text-slate-600 border-slate-500/30";
  }
}

// Badge colours by HTTP status class (5xx red, 4xx amber, else green/grey).
function statusColor(status: number | null): string {
  if (status == null) return "bg-slate-500/15 text-slate-600 border-slate-500/30";
  if (status >= 500)  return "bg-rose-500/15 text-rose-600 border-rose-500/30";
  if (status >= 400)  return "bg-amber-500/15 text-amber-600 border-amber-500/30";
  return "bg-emerald-500/15 text-emerald-600 border-emerald-500/30";
}

export default function PlatformSystemErrors() {
  const { user } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<ErrorRow[] | null>(null);
  const [windowMin, setWindowMin] = useState(60);
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [routeFilter, setRouteFilter] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Fetch summary + detail rows in parallel for the current time window/filters.
  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true); setError(null);
    try {
      const sumUrl = `${apiBase}/admin/system-errors/summary?sinceMinutes=${windowMin}`;
      const params = new URLSearchParams({ sinceMinutes: String(windowMin), limit: "200" });
      if (sourceFilter !== "all") params.set("source", sourceFilter);
      if (routeFilter.trim())     params.set("routePath", routeFilter.trim());
      const listUrl = `${apiBase}/admin/system-errors?${params.toString()}`;
      const [sumRes, listRes] = await Promise.all([
        fetch(sumUrl,  { credentials: "include", headers: { ...authHeaders() } }),
        fetch(listUrl, { credentials: "include", headers: { ...authHeaders() } }),
      ]);
      if (!sumRes.ok)  throw new Error(`Summary: HTTP ${sumRes.status}`);
      if (!listRes.ok) throw new Error(`List: HTTP ${listRes.status}`);
      setSummary(await sumRes.json());
      setRows(await listRes.json());
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [user, windowMin, sourceFilter, routeFilter]);

  useEffect(() => { load(); }, [load]);

  if (user && user.role !== "platform_admin") return <Redirect to="/dashboard" />;
  if (!user) {
    return <AppLayout><div className="flex items-center justify-center h-64 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" />Loading…</div></AppLayout>;
  }

  // Toggle a row's expanded state (shows stack trace + extra context).
  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <AppLayout>
      <div className="px-6 py-6 space-y-6 max-w-[1400px] mx-auto">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title flex items-center gap-2">
              <AlertTriangle className="w-6 h-6 text-amber-500" />
              System Errors
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Captured runtime errors from the API server — Express handler errors,
              uncaught exceptions, and unhandled promise rejections.
            </p>
          </div>
          <Button onClick={load} disabled={loading} variant="outline" size="sm">
            <RefreshCw className={"w-4 h-4 mr-2 " + (loading ? "animate-spin" : "")} />
            Refresh
          </Button>
        </div>

        {/* ── Filter bar ───────────────────────────────────────────────── */}
        <Card>
          <CardContent className="pt-6 flex flex-wrap gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Time window</label>
              <Select value={String(windowMin)} onValueChange={(v) => setWindowMin(Number(v))}>
                <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {WINDOWS.map((w) => (
                    <SelectItem key={w.minutes} value={String(w.minutes)}>{w.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Source</label>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 flex-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground">Route path (exact)</label>
              <input
                type="text"
                value={routeFilter}
                onChange={(e) => setRouteFilter(e.target.value)}
                placeholder="/api/jobs"
                className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              />
            </div>
          </CardContent>
        </Card>

        {error && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-700 px-4 py-3 text-sm">
            {error}
          </div>
        )}

        {/* ── KPI cards ────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard
            label="Total errors"
            value={summary?.total ?? "—"}
            tone={summary && summary.total > 0 ? "warn" : "ok"}
          />
          <KpiCard
            label="Express 5xx"
            value={(rows ?? []).filter((r) => r.source === "express" && (r.statusCode ?? 0) >= 500).length}
            tone={(rows ?? []).some((r) => r.source === "express" && (r.statusCode ?? 0) >= 500) ? "danger" : "ok"}
          />
          <KpiCard
            label="Uncaught exceptions"
            value={(summary?.bySource ?? []).find((s) => s.source === "uncaughtException")?.count ?? 0}
            tone={(summary?.bySource ?? []).some((s) => s.source === "uncaughtException" && s.count > 0) ? "danger" : "ok"}
          />
          <KpiCard
            label="Unhandled rejections"
            value={(summary?.bySource ?? []).find((s) => s.source === "unhandledRejection")?.count ?? 0}
            tone={(summary?.bySource ?? []).some((s) => s.source === "unhandledRejection" && s.count > 0) ? "warn" : "ok"}
          />
        </div>

        {/* ── Top routes ───────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top failing routes</CardTitle>
          </CardHeader>
          <CardContent>
            {!summary ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…
              </div>
            ) : summary.byRoute.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No route-bound errors in this window. 
              </div>
            ) : (
              <div className="space-y-1.5">
                {summary.byRoute.slice(0, 10).map((r) => (
                  <button
                    key={r.routePath ?? "_null"}
                    onClick={() => setRouteFilter(r.routePath ?? "")}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-md hover:bg-muted text-left"
                  >
                    <code className="text-xs font-mono">{r.routePath ?? "(no route)"}</code>
                    <div className="flex items-center gap-3 text-xs">
                      {r.lastSeen && (
                        <span className="text-muted-foreground">
                          last {formatDistanceToNow(new Date(r.lastSeen), { addSuffix: true })}
                        </span>
                      )}
                      <Badge variant="outline">{r.count}</Badge>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Error list ───────────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-base">
              Recent errors {rows ? <span className="text-muted-foreground font-normal">({rows.length})</span> : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {!rows ? (
              <div className="text-sm text-muted-foreground py-12 text-center">
                <Loader2 className="w-4 h-4 animate-spin inline mr-2" />Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="text-sm text-muted-foreground py-12 text-center">
                No errors captured in this window — looking good.
              </div>
            ) : (
              <div className="divide-y">
                {rows.map((r) => {
                  const isOpen = expanded.has(r.id);
                  return (
                    <div key={r.id} className="px-4 py-3">
                      <button
                        onClick={() => toggleExpanded(r.id)}
                        className="w-full flex items-start gap-3 text-left"
                      >
                        <span className="mt-1 text-muted-foreground">
                          {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-1">
                            <Badge variant="outline" className={sourceColor(r.source)}>{r.source}</Badge>
                            {r.statusCode != null && (
                              <Badge variant="outline" className={statusColor(r.statusCode)}>{r.statusCode}</Badge>
                            )}
                            {r.method && r.routePath && (
                              <code className="text-xs font-mono text-muted-foreground">
                                {r.method} {r.routePath}
                              </code>
                            )}
                            <span className="text-xs text-muted-foreground ml-auto">
                              {formatDistanceToNow(new Date(r.occurredAt), { addSuffix: true })}
                            </span>
                          </div>
                          <div className="text-sm">
                            <span className="font-medium">{r.errorName ?? "Error"}:</span>{" "}
                            <span className="text-foreground/80">{r.message}</span>
                          </div>
                        </div>
                      </button>

                      {isOpen && (
                        <div className="ml-7 mt-3 space-y-2 text-xs">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-muted-foreground">
                            <Meta label="Tenant"    value={r.tenantId} />
                            <Meta label="User"      value={r.userId} />
                            <Meta label="Request"   value={r.requestId} />
                            <Meta label="Occurred"  value={new Date(r.occurredAt).toLocaleString()} />
                          </div>
                          {r.stack && (
                            <pre className="bg-muted/50 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-snug max-h-[400px]">
                              {r.stack}
                            </pre>
                          )}
                          {r.extra && Object.keys(r.extra).length > 0 && (
                            <details>
                              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                                extra
                              </summary>
                              <pre className="bg-muted/50 rounded-md p-3 mt-1 overflow-x-auto font-mono text-[11px]">
                                {JSON.stringify(r.extra, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

function KpiCard({ label, value, tone }: { label: string; value: number | string; tone: "ok" | "warn" | "danger" }) {
  const toneCls =
    tone === "danger" ? "text-rose-600" :
    tone === "warn"   ? "text-amber-600" :
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

function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide">{label}</div>
      <div className="font-mono text-foreground/90 truncate" title={value ?? ""}>{value ?? "—"}</div>
    </div>
  );
}
