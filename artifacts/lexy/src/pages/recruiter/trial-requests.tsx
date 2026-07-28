/**
 * pages/recruiter/trial-requests.tsx — Inbound Trial Request Inbox
 *
 * Platform-admin-only view of submissions from the public /start-trial form
 * on lexy-site. Lists every row in pending_trial_signups (most recent first)
 * so staff can follow up with prospects, track conversion, and see which
 * requests verified their email vs. expired.
 *
 * Route: /platform/trial-requests  (platform_admin only)
 * Data:  GET /api/plans/start-trial/list
 */
import { authHeaders } from "@/lib/api";
import { useMemo, useState } from "react";
import { pluralize } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Mail, Building2, Clock, CheckCircle2, AlertCircle, RefreshCw, Search, Inbox,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type TrialRequest = {
  id: string;
  name: string;
  email: string;
  company: string;
  requestIp: string | null;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  createdTenantId: string | null;
  planCode: string | null;
  region: string | null;
  role: string | null;
  teamSize: string | null;
  hiringFocus: string | null;
  status: "pending" | "verified" | "expired";
};

// Fetches the list of inbound trial signups (platform_admin only). Cached 30s
// to keep the inbox responsive without hammering the API on tab switches.
function useTrialRequests() {
  return useQuery({
    queryKey: ["trial-requests"],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/plans/start-trial/list`, {
        credentials: "include",
        headers: { ...authHeaders() },
      });
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      return res.json() as Promise<{ items: TrialRequest[]; count: number }>;
    },
    staleTime: 30_000,
  });
}

// Visual config (label, badge classes, icon) per trial-request lifecycle status.
const statusCfg: Record<TrialRequest["status"], { label: string; cls: string; icon: any }> = {
  pending:  { label: "Pending verification", cls: "bg-amber-500/10 text-amber-300 border-amber-500/20", icon: Clock },
  verified: { label: "Verified · Tenant created", cls: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20", icon: CheckCircle2 },
  expired:  { label: "Link expired",          cls: "bg-rose-500/10 text-rose-300 border-rose-500/20",      icon: AlertCircle },
};

// Compact relative-time formatter (just now / Nm / Nh / Nd, else a date).
function relTime(iso: string) {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function TrialRequests() {
  const { data, isLoading, isError, refetch, isFetching } = useTrialRequests();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | TrialRequest["status"]>("all");

  const items = data?.items ?? [];
  // Tally per-status counts once for the clickable KPI strip filters.
  const counts = useMemo(() => {
    const by = { all: items.length, pending: 0, verified: 0, expired: 0 };
    for (const i of items) by[i.status]++;
    return by;
  }, [items]);

  // Apply the active status tab + free-text search (name/email/company).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (statusFilter !== "all" && i.status !== statusFilter) return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        i.email.toLowerCase().includes(q) ||
        i.company.toLowerCase().includes(q)
      );
    });
  }, [items, query, statusFilter]);

  return (
    <AppLayout>
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Inbox className="w-5 h-5 text-primary" />
              <h1 className="page-title">Trial requests</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              People who submitted the public trial-request form on l3xy.ai/start-trial.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* KPI strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { key: "all" as const,      label: "Total",       value: counts.all,      icon: Mail,           cls: "text-foreground"     },
            { key: "pending" as const,  label: "Pending",     value: counts.pending,  icon: Clock,          cls: "text-amber-300"      },
            { key: "verified" as const, label: "Verified",    value: counts.verified, icon: CheckCircle2,   cls: "text-emerald-300"    },
            { key: "expired" as const,  label: "Expired",     value: counts.expired,  icon: AlertCircle,    cls: "text-rose-300"       },
          ].map((k) => {
            const Icon = k.icon;
            const active = statusFilter === k.key;
            return (
              <button
                key={k.key}
                type="button"
                onClick={() => setStatusFilter(k.key)}
                className={`text-left rounded-lg border p-4 transition-colors ${
                  active ? "border-primary/60 bg-primary/5" : "border-border hover:border-border/80 bg-card/40"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted-foreground">{k.label}</span>
                  <Icon className={`w-4 h-4 ${k.cls}`} />
                </div>
                <div className={`text-2xl font-semibold ${k.cls}`}>{k.value}</div>
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search name, email, or company…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {pluralize(filtered.length, "request")}
              {statusFilter !== "all" && (
                <span className="text-muted-foreground font-normal"> · {statusFilter}</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="py-10 text-center text-sm text-muted-foreground">Loading…</div>
            ) : isError ? (
              <div className="py-10 text-center text-sm text-rose-400">
                Failed to load trial requests.
              </div>
            ) : filtered.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {items.length === 0
                  ? "No trial requests yet — submissions to /start-trial will appear here."
                  : "No requests match your filters."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Contact</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Role / Team</TableHead>
                      <TableHead>Hiring focus</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Submitted</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((r) => {
                      const cfg = statusCfg[r.status];
                      const StatusIcon = cfg.icon;
                      return (
                        <TableRow key={r.id}>
                          <TableCell>
                            <div className="font-medium">{r.name}</div>
                            <div className="text-xs text-muted-foreground">{r.email}</div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                              <span>{r.company}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">{r.role || <span className="text-muted-foreground">—</span>}</div>
                            <div className="text-xs text-muted-foreground">{r.teamSize || ""}</div>
                          </TableCell>
                          <TableCell className="max-w-[260px]">
                            <div className="text-sm truncate" title={r.hiringFocus || ""}>
                              {r.hiringFocus || <span className="text-muted-foreground">—</span>}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cfg.cls}>
                              <StatusIcon className="w-3 h-3 mr-1" />
                              {cfg.label}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="text-sm">{relTime(r.createdAt)}</div>
                            <div className="text-xs text-muted-foreground">
                              {new Date(r.createdAt).toLocaleString()}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <a
                              href={`mailto:${r.email}?subject=${encodeURIComponent(
                                "Following up on your L3xy trial request",
                              )}&body=${encodeURIComponent(`Hi ${r.name.split(" ")[0]},\n\nThanks for requesting a trial of L3xy. `)}`}
                              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                            >
                              <Mail className="w-3.5 h-3.5" />
                              Email
                            </a>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
