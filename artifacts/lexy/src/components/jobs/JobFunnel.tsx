/**
 * JobFunnel — per-job hiring funnel with unique-candidate counts + conversion %.
 * Fetches from GET /api/jobs/:jobId/funnel and renders a stepped bar chart.
 */
import { authHeaders } from "@/lib/api";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { TrendingDown, TrendingUp, AlertCircle, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface FunnelStage {
  eventType: string;
  label: string;
  count: number;
  conversionPct: number | null;
}

interface FunnelData {
  jobId: string;
  stages: FunnelStage[];
}

// Stage-to-stage conversion bands — a funnel-throughput quantity, not match fit.
const CONVERSION_STRONG = 70;
const CONVERSION_MODERATE = 40;
const CONVERSION_TREND_UP_MIN = 50; // arrow points up at/above this conversion
function getBarColor(conversionPct: number | null, isFirst: boolean) {
  if (isFirst) return "bg-indigo-500";
  if (conversionPct == null) return "bg-muted";
  if (conversionPct >= CONVERSION_STRONG) return "bg-emerald-500";
  if (conversionPct >= CONVERSION_MODERATE) return "bg-amber-500";
  return "bg-red-400";
}

function ConversionBadge({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const color = pct >= CONVERSION_STRONG ? "text-emerald-600 bg-emerald-50 border-emerald-200"
    : pct >= CONVERSION_MODERATE ? "text-amber-600 bg-amber-50 border-amber-200"
    : "text-red-600 bg-red-50 border-red-200";
  const Icon = pct >= CONVERSION_TREND_UP_MIN ? TrendingUp : TrendingDown;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium border rounded-full px-2 py-0.5", color)}>
      <Icon size={11} />
      {pct}%
    </span>
  );
}

export default function JobFunnel({
  jobId,
}: {
  jobId: string;
}) {
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    fetch(`${BASE}/api/jobs/${jobId}/funnel`, {
      credentials: "include",
      headers: { ...authHeaders() },
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: FunnelData) => setData(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [jobId]);

  if (loading) {
    return (
      <div className="space-y-3 p-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-6 flex-1 rounded" />
            <Skeleton className="h-5 w-12 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
        <AlertCircle size={20} />
        <p className="text-sm">Failed to load funnel: {error}</p>
      </div>
    );
  }

  if (!data) return null;

  const maxCount = Math.max(...data.stages.map(s => s.count), 1);
  const activeStages = data.stages.filter(s => s.count > 0);

  if (activeStages.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-muted-foreground">
        <BarChart3 size={24} />
        <p className="text-sm font-medium">No funnel data yet</p>
        <p className="text-xs text-center max-w-xs">
          Funnel stages populate as candidates move through the hiring pipeline
          (invites, interviews, offers, hire).
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {data.stages.map((stage, i) => {
        const widthPct = maxCount > 0 ? Math.max((stage.count / maxCount) * 100, stage.count > 0 ? 4 : 0) : 0;
        const barColor = getBarColor(stage.conversionPct, i === 0);
        return (
          <div key={stage.eventType} className="flex items-center gap-3 group">
            {/* label */}
            <div className="w-44 shrink-0 text-right">
              <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors truncate block">
                {stage.label}
              </span>
            </div>
            {/* bar */}
            <div className="flex-1 flex items-center gap-2">
              <div className="flex-1 h-7 bg-muted/40 rounded-lg overflow-hidden">
                <div
                  className={cn("h-full rounded-lg transition-all duration-500 ease-out flex items-center px-2", barColor)}
                  style={{ width: `${widthPct}%`, minWidth: stage.count > 0 ? 32 : 0 }}
                >
                  {stage.count > 0 && (
                    <span className="text-white text-xs font-bold tabular-nums">{stage.count}</span>
                  )}
                </div>
              </div>
              {i > 0 && <ConversionBadge pct={stage.conversionPct} />}
              {i === 0 && stage.count > 0 && (
                <Badge variant="secondary" className="text-xs">{stage.count} invited</Badge>
              )}
            </div>
          </div>
        );
      })}

      {/* summary row */}
      {data.stages[0]?.count > 0 && data.stages[data.stages.length - 1]?.count > 0 && (
        <div className="mt-4 pt-4 border-t flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Overall conversion (Invited → Started)</span>
          <span className="font-bold tabular-nums">
            {Math.round((data.stages[data.stages.length - 1].count / data.stages[0].count) * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}
