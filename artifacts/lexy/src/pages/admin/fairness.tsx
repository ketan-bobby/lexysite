/**
 * pages/admin/fairness.tsx — Fairness & Adverse-Impact Dashboard (Task #21)
 *
 * Admin-only (platform_admin / tenant_admin) compliance view of the EEOC
 * four-fifths (80%) rule across the hiring funnel. Reads the aggregate
 * /analytics/adverse-impact endpoint — it NEVER touches an individual
 * candidate's self-identification record. For each protected attribute the
 * candidate voluntarily disclosed and each funnel milestone, it shows every
 * group's selection rate and its impact ratio vs. the most-selected group,
 * flagging any ratio below 0.80. Groups below the statistical-validity sample
 * floor render as "insufficient data" rather than a fabricated ratio.
 */
import { authHeaders } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { Redirect } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@workspace/react-hooks/use-toast";
import {
  Scale, AlertTriangle, ShieldCheck, Download, Info, Loader2, CheckCircle2,
} from "lucide-react";
import { cn, pluralize } from "@/lib/utils";
import { useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type PopulationKey = "formal" | "sourced";

type Group = {
  group: string;
  appliedN: number;
  reachedN: number;
  selectionRate: number;
  insufficientData: boolean;
  impactRatio: number | null;
  flagged: boolean;
  isReference: boolean;
};
type Milestone = {
  milestone: string;
  label: string;
  insufficientData: boolean;
  referenceGroup: string | null;
  groups: Group[];
};
type Attribute = { key: string; label: string; milestones: Milestone[] };
type Population = { key: PopulationKey; label: string; entryTypes: string[]; definition: string };
type DemographicCoverage = {
  totalUnits: number;
  withDemographics: number;
  disclosedPercent: number;
  missingPercent: number;
  sufficient: boolean;
  message: string;
};
type AdverseImpact = {
  generatedAt: string;
  thresholds: { minGroupN: number; fourFifths: number };
  scope: { jobId: string | null };
  population: Population;
  demographicCoverage: DemographicCoverage;
  milestones: { key: string; label: string }[];
  attributes: Attribute[];
  anyFlagged: boolean;
  totalAnalyzed: number;
};

/* Humanise stored enum-ish group keys (e.g. "protected_veteran" → "Protected veteran"). */
function prettyGroup(g: string): string {
  return g.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function useAdverseImpact(population: PopulationKey) {
  return useQuery<AdverseImpact>({
    queryKey: ["analytics", "adverse-impact", population],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/analytics/adverse-impact?population=${population}`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      return res.json();
    },
    staleTime: 60_000,
  });
}

function GroupRow({ g }: { g: Group }) {
  const ratioPct = g.impactRatio != null ? Math.round(g.impactRatio * 100) : null;
  return (
    <tr className="border-b border-white/5 last:border-0">
      <td className="py-2 pr-3 text-sm font-medium text-foreground">
        {prettyGroup(g.group)}
        {g.isReference && (
          <span className="ml-2 text-[10px] uppercase tracking-wide text-primary/80">reference</span>
        )}
      </td>
      <td className="py-2 px-3 text-sm text-muted-foreground tabular-nums">{g.appliedN}</td>
      <td className="py-2 px-3 text-sm text-muted-foreground tabular-nums">{g.reachedN}</td>
      <td className="py-2 px-3 text-sm text-muted-foreground tabular-nums">
        {g.insufficientData ? "—" : `${Math.round(g.selectionRate * 100)}%`}
      </td>
      <td className="py-2 px-3 text-sm tabular-nums">
        {g.insufficientData || ratioPct == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className={cn(g.flagged ? "text-red-400 font-semibold" : "text-foreground")}>
            {ratioPct}%
          </span>
        )}
      </td>
      <td className="py-2 pl-3 text-right">
        {g.insufficientData ? (
          <Badge variant="outline" className="text-[10px] text-muted-foreground border-white/10">
            Insufficient data
          </Badge>
        ) : g.flagged ? (
          <Badge className="text-[10px] bg-red-500/15 text-red-300 border border-red-500/30">
            Below 4/5ths
          </Badge>
        ) : g.isReference ? (
          <Badge variant="outline" className="text-[10px] text-primary/80 border-primary/30">
            Reference
          </Badge>
        ) : (
          <Badge className="text-[10px] bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            Pass
          </Badge>
        )}
      </td>
    </tr>
  );
}

function MilestoneBlock({ m }: { m: Milestone }) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-semibold text-foreground">{m.label}</h4>
        {m.groups.some((g) => g.flagged) ? (
          <span className="inline-flex items-center gap-1 text-xs text-red-300">
            <AlertTriangle className="w-3.5 h-3.5" /> Adverse impact
          </span>
        ) : m.insufficientData ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Info className="w-3.5 h-3.5" /> Insufficient data
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-300">
            <CheckCircle2 className="w-3.5 h-3.5" /> Within 4/5ths
          </span>
        )}
      </div>
      {m.groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">No disclosed applicants reached this stage.</p>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground/70 border-b border-white/5">
              <th className="py-1.5 pr-3 font-medium">Group</th>
              <th className="py-1.5 px-3 font-medium">Applied</th>
              <th className="py-1.5 px-3 font-medium">Reached</th>
              <th className="py-1.5 px-3 font-medium">Selection rate</th>
              <th className="py-1.5 px-3 font-medium">Impact ratio</th>
              <th className="py-1.5 pl-3 font-medium text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {m.groups.map((g) => (
              <GroupRow key={g.group} g={g} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function FairnessDashboard() {
  const { user } = useAuth() as any;
  const { toast } = useToast();
  const [population, setPopulation] = useState<PopulationKey>("formal");
  const { data, isLoading, isError } = useAdverseImpact(population);

  if (user && !["platform_admin", "tenant_admin"].includes(user.role)) {
    return <Redirect to="/dashboard" />;
  }

  async function downloadAedt() {
    try {
      const res = await fetch(`${BASE}/api/analytics/aedt-export`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `aedt-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Export failed", description: err?.message ?? "Could not download AEDT export.", variant: "destructive" });
    }
  }

  const hasData = !!data && data.totalAnalyzed > 0 && data.attributes.length > 0;

  return (
    <AppLayout>
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
              <Scale className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Fairness & Adverse Impact</h1>
              <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
                EEOC four-fifths (80%) rule monitoring across the hiring funnel, computed from
                voluntary self-identification only. Individual disclosures are never shown — this
                view is aggregate and gated by a minimum sample size for statistical validity.
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={downloadAedt} className="shrink-0">
            <Download className="w-4 h-4 mr-2" /> AEDT export
          </Button>
        </div>

        {/* Population toggle — the two distinct views. The FORMAL view is the
            legally-recognised applicant pool (4/5ths); SOURCING is a separate
            top-of-funnel equity audit and is NOT a formal adverse-impact report. */}
        <div className="flex flex-wrap items-center gap-2">
          {([
            { key: "formal" as const, label: "Adverse Impact (formal applicants)" },
            { key: "sourced" as const, label: "Sourcing Fairness (sourced prospects)" },
          ]).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setPopulation(opt.key)}
              className={cn(
                "px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors",
                population === opt.key
                  ? "bg-primary/15 text-primary border-primary/40"
                  : "bg-white/[0.02] text-muted-foreground border-white/10 hover:text-foreground",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Population definition + entry_type filter footer — printed on EVERY
            report so it can never be read out of context. */}
        {data?.population && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
              Population: {data.population.label}
              <span className="ml-2 font-mono normal-case text-[10px] text-muted-foreground">
                entry_type ∈ {"{"}{data.population.entryTypes.join(", ")}{"}"}
              </span>
            </p>
            <p className="text-xs text-muted-foreground mt-1">{data.population.definition}</p>
          </div>
        )}

        {/* Honest demographic-coverage disclosure — states exactly how much of the
            population self-identified and, when below threshold, that no ratios
            can be computed rather than fabricating an all-clear. */}
        {data?.demographicCoverage && (
          <div className={cn(
            "rounded-xl border p-4 flex items-start gap-3",
            data.demographicCoverage.sufficient
              ? "border-white/10 bg-white/[0.02]"
              : "border-amber-500/30 bg-amber-500/10",
          )}>
            <Info className={cn("w-4 h-4 shrink-0 mt-0.5", data.demographicCoverage.sufficient ? "text-muted-foreground" : "text-amber-400")} />
            <p className={cn("text-xs", data.demographicCoverage.sufficient ? "text-muted-foreground" : "text-amber-200/90")}>
              {data.demographicCoverage.message}
            </p>
          </div>
        )}

        {/* States */}
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Computing impact ratios…
          </div>
        ) : isError ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground">
              Could not load fairness analytics. Please try again.
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Alert / all-clear banner */}
            {data?.anyFlagged ? (
              <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-red-200">Potential adverse impact detected</p>
                  <p className="text-sm text-red-200/80 mt-0.5">
                    One or more groups have a selection rate below 80% of the most-selected group at a
                    funnel stage. Review the flagged rows below; this warrants a human compliance review
                    of the affected stage and selection criteria.
                  </p>
                </div>
              </div>
            ) : hasData ? (
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4 flex items-start gap-3">
                <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-emerald-200">No adverse impact flagged</p>
                  <p className="text-sm text-emerald-200/80 mt-0.5">
                    All groups with a sufficient sample are within the four-fifths threshold at every
                    measured stage.
                  </p>
                </div>
              </div>
            ) : null}

            {/* Thresholds note */}
            {data && (
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <Info className="w-3.5 h-3.5" />
                Analysing {pluralize(data.totalAnalyzed, "disclosed application")}.
                Impact ratios require at least {data.thresholds.minGroupN} applicants per group; smaller
                groups are shown as "insufficient data". Generated {new Date(data.generatedAt).toLocaleString()}.
              </p>
            )}

            {/* Empty state */}
            {!hasData ? (
              <Card>
                <CardContent className="py-16 text-center">
                  <Info className="w-8 h-8 text-muted-foreground/50 mx-auto mb-3" />
                  <p className="text-sm font-medium text-foreground">Not enough data yet</p>
                  <p className="text-sm text-muted-foreground mt-1 max-w-md mx-auto">
                    Adverse-impact analysis needs candidates who have voluntarily self-identified and
                    moved through the funnel. As disclosures and outcomes accumulate, ratios will appear
                    here per attribute and stage.
                  </p>
                </CardContent>
              </Card>
            ) : (
              data!.attributes.map((attr) => (
                <Card key={attr.key}>
                  <CardHeader>
                    <CardTitle className="text-base">{attr.label}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {attr.milestones.map((m) => (
                      <MilestoneBlock key={m.milestone} m={m} />
                    ))}
                  </CardContent>
                </Card>
              ))
            )}
          </>
        )}
      </div>
    </AppLayout>
  );
}
