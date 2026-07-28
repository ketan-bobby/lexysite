/**
 * pages/admin/transcription-health.tsx — STT (speech-to-text) ops dashboard
 *
 * Visualizes the per-request transcription quality we already instrument on the
 * api-server (GET /interviews/transcribe/metrics):
 *   - the rolling window the alert scheduler evaluates (so a fired alert can be
 *     visually confirmed at a glance, with the trip thresholds shown inline)
 *   - cumulative-since-boot totals (empty-transcript rate, provider mix, format
 *     breakdown)
 *   - persisted day-by-day history that survives restarts
 *
 * Platform-admin only (gated by ProtectedRoute in App.tsx). The numbers refresh
 * periodically so an on-call engineer can keep this open while investigating.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  RefreshCw,
  Server,
  Timer,
} from "lucide-react";
import {
  BarChart,
  Bar,
  Line,
  LineChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { apiBase, apiFetch } from "@/lib/api";
import { BackToHome } from "@/components/layout/BackToHome";

interface ProviderStat {
  requests: number;
  empty: number;
  emptyRate: number;
  avgLatencyMs: number;
}
interface Metrics {
  since: string;
  totals: { requests: number; empty: number; emptyRate: number };
  byProvider: Record<string, ProviderStat>;
  byFormat: Record<string, number>;
  window: {
    windowMin: number;
    requests: number;
    empty: number;
    emptyRate: number;
    avgLatencyMs: number;
  };
  alertConfig: {
    intervalMin: number;
    windowMin: number;
    minSample: number;
    emptyRateThreshold: number;
    latencyMsThreshold: number;
    cooldownMin: number;
  };
  history: {
    since: string;
    days: number;
    daily: Array<{
      day: string;
      requests: number;
      empty: number;
      emptyRate: number;
      avgLatencyMs: number;
    }>;
    byLanguage?: Array<{
      language: string;
      requests: number;
      empty: number;
      emptyRate: number;
      avgLatencyMs: number;
    }>;
  };
}

const REFRESH_MS = 15_000;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const ms = (n: number) => `${Math.round(n).toLocaleString()}ms`;

export default function TranscriptionHealth() {
  const [data, setData] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const load = () => {
    setLoading(true);
    apiFetch(`${apiBase}/interviews/transcribe/metrics`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: Metrics) => {
        setData(j);
        setError(null);
        setUpdatedAt(new Date());
      })
      .catch((e: any) => setError(e?.message ?? "Failed to load metrics"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  /* Does the live rolling window breach what the alert scheduler watches?
     Mirrors stt-alert-scheduler.tick(): only meaningful once min-sample met. */
  const breach = useMemo(() => {
    if (!data) return null;
    const { window: w, alertConfig: c } = data;
    if (w.requests < c.minSample) return { state: "insufficient" as const };
    const reasons: string[] = [];
    if (w.emptyRate >= c.emptyRateThreshold)
      reasons.push(`empty rate ${pct(w.emptyRate)} ≥ ${pct(c.emptyRateThreshold)}`);
    if (w.avgLatencyMs >= c.latencyMsThreshold)
      reasons.push(`avg latency ${ms(w.avgLatencyMs)} ≥ ${ms(c.latencyMsThreshold)}`);
    return reasons.length
      ? { state: "alerting" as const, reasons }
      : { state: "healthy" as const };
  }, [data]);

  const providerRows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byProvider)
      .map(([name, s]) => ({ name, ...s }))
      .filter((r) => r.requests > 0 || r.name !== "none")
      .sort((a, b) => b.requests - a.requests);
  }, [data]);

  const formatRows = useMemo(() => {
    if (!data) return [];
    return Object.entries(data.byFormat)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [data]);

  return (
    <div className="min-h-screen text-foreground py-10 px-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <BackToHome to="/platform" />

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Activity className="w-6 h-6 text-primary" /> Transcription Health
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Speech-to-text quality for live mobile interviews — the same signals
              the automatic alerts watch.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {updatedAt && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                Updated {updatedAt.toLocaleTimeString()} · auto every{" "}
                {REFRESH_MS / 1000}s
              </span>
            )}
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={cn("w-4 h-4 mr-2", loading && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>

        {error && (
          <Card className="border-destructive/50">
            <CardContent className="py-4 text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Couldn't load metrics: {error}
            </CardContent>
          </Card>
        )}

        {!data && loading && (
          <div className="text-sm text-muted-foreground py-12 text-center">
            Loading transcription metrics…
          </div>
        )}

        {data && (
          <>
            {/* ── Alert-window banner ─────────────────────────────────────── */}
            <Card
              className={cn(
                "border-2",
                breach?.state === "alerting"
                  ? "border-destructive/60 bg-destructive/5"
                  : breach?.state === "healthy"
                    ? "border-emerald-500/40 bg-emerald-500/5"
                    : "border-border/50",
              )}
            >
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-primary" />
                    Rolling window — last {data.window.windowMin} min
                  </span>
                  {breach?.state === "alerting" && (
                    <Badge variant="destructive" className="gap-1">
                      <AlertTriangle className="w-3 h-3" /> Alerting
                    </Badge>
                  )}
                  {breach?.state === "healthy" && (
                    <Badge className="gap-1 bg-emerald-500/15 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/15">
                      <CheckCircle2 className="w-3 h-3" /> Healthy
                    </Badge>
                  )}
                  {breach?.state === "insufficient" && (
                    <Badge variant="secondary" className="gap-1">
                      Low traffic
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <WindowStat
                    label="Empty rate"
                    value={pct(data.window.emptyRate)}
                    sub={`trips ≥ ${pct(data.alertConfig.emptyRateThreshold)}`}
                    bad={data.window.emptyRate >= data.alertConfig.emptyRateThreshold}
                  />
                  <WindowStat
                    label="Avg latency"
                    value={ms(data.window.avgLatencyMs)}
                    sub={`trips ≥ ${ms(data.alertConfig.latencyMsThreshold)}`}
                    bad={
                      data.window.avgLatencyMs >= data.alertConfig.latencyMsThreshold
                    }
                  />
                  <WindowStat label="Requests" value={`${data.window.requests}`} sub={`min sample ${data.alertConfig.minSample}`} />
                  <WindowStat label="Empty" value={`${data.window.empty}`} sub="transcripts" />
                </div>
                {breach?.state === "alerting" && (
                  <div className="text-sm text-destructive flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>Would fire an alert: {breach.reasons.join("; ")}</span>
                  </div>
                )}
                {breach?.state === "insufficient" && (
                  <p className="text-xs text-muted-foreground">
                    Fewer than {data.alertConfig.minSample} requests in the window —
                    the scheduler stays quiet until there's enough traffic to judge.
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Scheduler checks every {data.alertConfig.intervalMin} min ·
                  cooldown {data.alertConfig.cooldownMin} min between emails.
                </p>
              </CardContent>
            </Card>

            {/* ── Cumulative totals ───────────────────────────────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard
                icon={Activity}
                label="Total requests"
                value={data.totals.requests.toLocaleString()}
                sub={`since ${new Date(data.since).toLocaleString()}`}
              />
              <StatCard
                icon={AlertTriangle}
                label="Empty-transcript rate"
                value={pct(data.totals.emptyRate)}
                sub={`${data.totals.empty.toLocaleString()} empty of ${data.totals.requests.toLocaleString()}`}
              />
              <StatCard
                icon={Timer}
                label="Window avg latency"
                value={ms(data.window.avgLatencyMs)}
                sub={`last ${data.window.windowMin} min`}
              />
            </div>

            {/* ── Provider mix & format breakdown ─────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="border-border/50">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Server className="w-4 h-4 text-primary" /> Provider mix
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {providerRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-6 text-center">
                      No transcription requests yet.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-4 gap-2 text-[11px] uppercase tracking-wide text-muted-foreground px-2">
                        <span>Provider</span>
                        <span className="text-right">Requests</span>
                        <span className="text-right">Empty</span>
                        <span className="text-right">Avg latency</span>
                      </div>
                      {providerRows.map((p) => (
                        <div
                          key={p.name}
                          className="grid grid-cols-4 gap-2 items-center text-sm bg-muted/20 rounded-lg px-2 py-2"
                        >
                          <span className="font-medium capitalize">{p.name}</span>
                          <span className="text-right">{p.requests.toLocaleString()}</span>
                          <span
                            className={cn(
                              "text-right",
                              p.emptyRate >= data.alertConfig.emptyRateThreshold &&
                                "text-destructive font-semibold",
                            )}
                          >
                            {pct(p.emptyRate)}
                          </span>
                          <span className="text-right">{ms(p.avgLatencyMs)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card className="border-border/50">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <BarChart3 className="w-4 h-4 text-primary" /> Audio format breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {formatRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-6 text-center">
                      No formats recorded yet.
                    </p>
                  ) : (
                    <div className="h-[200px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={formatRows}
                          layout="vertical"
                          margin={{ top: 5, right: 10, left: 10, bottom: 5 }}
                        >
                          <CartesianGrid
                            strokeDasharray="3 3"
                            horizontal={false}
                            stroke="rgba(255,255,255,0.05)"
                          />
                          <XAxis
                            type="number"
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                            allowDecimals={false}
                          />
                          <YAxis
                            type="category"
                            dataKey="name"
                            width={110}
                            axisLine={false}
                            tickLine={false}
                            tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                          />
                          <Tooltip
                            cursor={{ fill: "rgba(255,255,255,0.03)" }}
                            contentStyle={{
                              background: "hsl(var(--card))",
                              border: "1px solid hsl(var(--border))",
                              borderRadius: 8,
                              fontSize: 12,
                            }}
                          />
                          <Bar
                            dataKey="value"
                            radius={[0, 4, 4, 0]}
                            maxBarSize={26}
                            fill="hsl(var(--primary))"
                          />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* ── Per-language breakdown (EU AI Act Art. 15 accuracy watch) ── */}
            <Card className="border-border/50" data-testid="stt-language-breakdown">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <BarChart3 className="w-4 h-4 text-primary" /> Per-language accuracy ·
                  last {data.history.days} days
                </CardTitle>
              </CardHeader>
              <CardContent>
                {!data.history.byLanguage || data.history.byLanguage.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No per-language history yet.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-4 gap-2 text-[11px] uppercase tracking-wide text-muted-foreground px-2">
                      <span>Language</span>
                      <span className="text-right">Requests</span>
                      <span className="text-right">Empty rate</span>
                      <span className="text-right">Avg latency</span>
                    </div>
                    {data.history.byLanguage.map((l) => (
                      <div
                        key={l.language}
                        className="grid grid-cols-4 gap-2 items-center text-sm bg-muted/20 rounded-lg px-2 py-2"
                      >
                        <span className="font-medium">{l.language}</span>
                        <span className="text-right">{l.requests.toLocaleString()}</span>
                        <span
                          className={cn(
                            "text-right",
                            l.emptyRate >= data.alertConfig.emptyRateThreshold &&
                              "text-destructive font-semibold",
                          )}
                        >
                          {pct(l.emptyRate)}
                        </span>
                        <span className="text-right">{ms(l.avgLatencyMs)}</span>
                      </div>
                    ))}
                    <p className="text-[11px] text-muted-foreground pt-1">
                      A materially higher empty rate for one language signals degraded
                      recognition accuracy for those candidates (EU AI Act Art. 15 monitoring).
                      "unknown" rows predate language tracking.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* ── Daily history (survives restarts) ───────────────────────── */}
            <Card className="border-border/50">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Activity className="w-4 h-4 text-primary" /> Daily trend ·
                  last {data.history.days} days
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.history.daily.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No persisted history yet.
                  </p>
                ) : (
                  <div className="h-[240px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart
                        data={data.history.daily.map((d) => ({
                          ...d,
                          emptyPct: Math.round(d.emptyRate * 1000) / 10,
                        }))}
                        margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
                      >
                        <CartesianGrid
                          strokeDasharray="3 3"
                          vertical={false}
                          stroke="rgba(255,255,255,0.05)"
                        />
                        <XAxis
                          dataKey="day"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                        />
                        <YAxis
                          yAxisId="left"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                          unit="%"
                        />
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          axisLine={false}
                          tickLine={false}
                          tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }}
                          unit="ms"
                        />
                        <Tooltip
                          contentStyle={{
                            background: "hsl(var(--card))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Line
                          yAxisId="left"
                          type="monotone"
                          dataKey="emptyPct"
                          name="Empty %"
                          stroke="hsl(var(--destructive))"
                          strokeWidth={2}
                          dot={false}
                        />
                        <Line
                          yAxisId="right"
                          type="monotone"
                          dataKey="avgLatencyMs"
                          name="Avg latency (ms)"
                          stroke="hsl(var(--primary))"
                          strokeWidth={2}
                          dot={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function WindowStat({
  label,
  value,
  sub,
  bad,
}: {
  label: string;
  value: string;
  sub?: string;
  bad?: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/20 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-xl font-bold", bad && "text-destructive")}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="border-border/50">
      <CardContent className="py-4">
        <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wide">
          <Icon className="w-4 h-4 text-primary" /> {label}
        </div>
        <p className="text-2xl font-bold mt-1">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}
