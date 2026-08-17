/**
 * pages/admin/network-prior.tsx — Network-Effect Scoring Prior (admin)
 *
 * Shows admins the cross-customer "meta-prior": the anonymized hiring prior
 * learned from aggregate statistics pooled across all customers. Displays the
 * activation gates, the currently active prior (version, pooled sample size,
 * contributing-tenant count, weight vector) and the version history. Platform
 * admins can trigger a training run or deactivate the prior (reverting every
 * tenant's cold-start to the static builtin). No candidate-level data is ever
 * shown — the API surface is aggregate-only by design.
 */
import { authHeaders } from "@/lib/api";
import { AppLayout } from "@/components/layout/AppLayout";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@workspace/react-hooks/use-toast";
import { Network, Loader2, Play, PowerOff, ShieldCheck, Info } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type PriorWeights = { fit: number; quality: number; trust: number; conversion: number };

type GlobalPriorStatus = {
  gate: {
    minTenants: number;
    minTotalSamples: number;
    minTenantSamples: number;
    shrinkageK: number;
  };
  active: {
    version: string;
    sampleSize: number;
    contributingTenants: number;
    prior: PriorWeights | null;
  } | null;
  usingGlobalPrior: boolean;
  versions: Array<{
    version: string;
    sampleSize: number;
    contributingTenants: number;
    isActive: boolean;
    notes: string | null;
    createdAt: string;
  }>;
};

const WEIGHT_LABELS: Array<{ key: keyof PriorWeights; label: string }> = [
  { key: "fit", label: "Fit" },
  { key: "quality", label: "Quality" },
  { key: "trust", label: "Trust" },
  { key: "conversion", label: "Conversion" },
];

export default function NetworkPriorAdmin() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isPlatformAdmin = user?.role === "platform_admin";

  const { data, isLoading } = useQuery<{ data: GlobalPriorStatus }>({
    queryKey: ["learning", "global-prior"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/learning/global-prior`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });
  const status = data?.data;

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["learning", "global-prior"] });

  const trainMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/learning/global-prior/train`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Training failed");
      return res.json();
    },
    onSuccess: (r) => {
      const s = r?.data?.status ?? "done";
      toast({
        title: s === "promoted" ? "New prior activated" : "Training run recorded",
        description:
          s === "promoted"
            ? "The refreshed network prior beat the baseline and is now live."
            : `Result: ${s.replaceAll("_", " ")} — the current behavior is unchanged.`,
      });
      invalidate();
    },
    onError: () => toast({ title: "Training failed", variant: "destructive" }),
  });

  const deactivateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/learning/global-prior/deactivate`, {
        method: "POST",
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error("Deactivation failed");
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Network prior deactivated",
        description: "All tenants revert to the built-in default prior.",
      });
      invalidate();
    },
    onError: () => toast({ title: "Deactivation failed", variant: "destructive" }),
  });

  return (
    <AppLayout>
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <Network className="w-7 h-7 text-primary" />
            Network-Effect Scoring Prior
          </h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            The cross-customer hiring prior: anonymous, aggregate-only statistics pooled across all
            customers give new or thin-data tenants a smarter starting point. No candidate or
            customer identities ever cross a tenant boundary.
          </p>
        </div>
        {isPlatformAdmin && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => trainMutation.mutate()}
              disabled={trainMutation.isPending}
              className="gap-1.5"
            >
              {trainMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              Train now
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => deactivateMutation.mutate()}
              disabled={deactivateMutation.isPending || !status?.usingGlobalPrior}
              className="gap-1.5"
            >
              {deactivateMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <PowerOff className="w-4 h-4" />
              )}
              Deactivate
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : !status ? (
        <p className="text-muted-foreground">Could not load the prior status.</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Active prior */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="w-4 h-4 text-primary" /> Current status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                {status.usingGlobalPrior ? (
                  <Badge className="bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    Active
                  </Badge>
                ) : (
                  <Badge variant="outline">Inactive — using built-in default</Badge>
                )}
                {status.active && (
                  <span className="text-xs text-muted-foreground font-mono">
                    {status.active.version}
                  </span>
                )}
              </div>
              {status.active && (
                <>
                  <div className="text-sm text-muted-foreground">
                    Learned from <b className="text-foreground">{status.active.sampleSize}</b>{" "}
                    pooled hiring outcomes across{" "}
                    <b className="text-foreground">{status.active.contributingTenants}</b>{" "}
                    customers.
                  </div>
                  {status.active.prior && (
                    <div className="grid grid-cols-4 gap-2 pt-1">
                      {WEIGHT_LABELS.map(({ key, label }) => (
                        <div key={key} className="rounded-md border border-border p-2 text-center">
                          <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
                          <div className="text-sm font-bold tabular-nums">
                            {Math.round((status.active!.prior![key] ?? 0) * 100)}%
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-1">
                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  A refresh runs automatically after new hiring outcomes arrive. A refreshed prior
                  only goes live when it beats the current baseline on every customer&apos;s own
                  data — otherwise it is recorded and ignored.
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Gates */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activation gates</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="text-sm space-y-2 text-muted-foreground">
                <li>
                  ≥ <b className="text-foreground">{status.gate.minTenants}</b> contributing
                  customers
                </li>
                <li>
                  ≥ <b className="text-foreground">{status.gate.minTotalSamples}</b> pooled labeled
                  outcomes
                </li>
                <li>
                  ≥ <b className="text-foreground">{status.gate.minTenantSamples}</b> outcomes per
                  contributing customer
                </li>
                <li>
                  Shrinkage K = <b className="text-foreground">{status.gate.shrinkageK}</b> (stays
                  near the default until real volume accrues)
                </li>
              </ul>
            </CardContent>
          </Card>

          {/* Version history */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Version history</CardTitle>
            </CardHeader>
            <CardContent>
              {status.versions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No training runs recorded yet.</p>
              ) : (
                <div className="space-y-2">
                  {status.versions.map((v) => (
                    <div
                      key={v.version}
                      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 flex-wrap"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        {v.isActive ? (
                          <Badge className="bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
                            Active
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="shrink-0">
                            Recorded
                          </Badge>
                        )}
                        <span className="text-xs font-mono truncate">{v.version}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {v.sampleSize} outcomes · {v.contributingTenants} customers ·{" "}
                        {new Date(v.createdAt).toLocaleString()}
                        {v.notes ? ` · ${v.notes}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </AppLayout>
  );
}
