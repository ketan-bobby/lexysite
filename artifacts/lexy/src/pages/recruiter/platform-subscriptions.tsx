/**
 * pages/recruiter/platform-subscriptions.tsx — Platform Admin "Subscriptions" Page
 *
 * Bird's-eye view across every tenant on the platform:
 *   • Current plan + status, expiry, region, partner
 *   • Live usage (open jobs / interviews) vs the plan's limits
 *   • Quick actions: change plan, suspend, view tenant detail
 *
 * Read-only by default; the inline plan-change dropdown PATCHes
 * /api/plans/admin/tenants/:id/plan and refetches.
 *
 * Access: platform_admin only — non-admins are redirected to /dashboard.
 */
import { authHeaders } from "@/lib/api";
import { useEffect, useState } from "react";
import { Redirect } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Loader2, AlertTriangle, Zap, TrendingUp } from "lucide-react";
import { format, parseISO, formatDistanceToNow } from "date-fns";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

type Row = {
  tenant: { id: string; name: string; slug: string; plan: string; status: string; region: string; country: string | null; billingTerm: string; paidThroughAt: string | null; partnerId: string | null; contactEmail: string | null; planActivatedAt: string; createdAt: string };
  plan:   { code: string; name: string; priceUsdPerMonth: number; expiresAfterDays: number };
  planExpired: boolean;
  expiresAt: string | null;
  usage: { openJobs: { current: number; limit: number }; interviews: { current: number; limit: number } };
};

type BillingTerm = "monthly" | "quarterly" | "annual";

const statusBadge: Record<string, string> = {
  active:    "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  trial:     "bg-sky-500/15 text-sky-600 border-sky-500/30",
  past_due:  "bg-amber-500/15 text-amber-600 border-amber-500/30",
  suspended: "bg-destructive/15 text-destructive border-destructive/30",
};

const statusLabel: Record<string, string> = {
  active: "Active", trial: "Trial", past_due: "Past due", suspended: "Suspended",
};

const planColor: Record<string, string> = {
  demo:       "bg-amber-500/15 text-amber-600 border-amber-500/30",
  starter:    "bg-slate-500/15 text-slate-600 border-slate-500/30",
  growth:     "bg-cyan-500/15 text-cyan-600 border-cyan-500/30",
  enterprise: "bg-purple-500/15 text-purple-600 border-purple-500/30",
};

// Platform-admin cross-tenant subscriptions table with inline plan changes.
export default function PlatformSubscriptions() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState("");
  const [planFilter, setPlanFilter] = useState<string>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // (Re)fetch the full tenant roster; called on mount and after a plan change.
  function load() {
    fetch(`${apiBase}/plans/admin/tenants`, { credentials: "include", headers: { ...authHeaders() } })
      .then((r) => r.json())
      .then((j) => setRows(j.tenants ?? []))
      .catch((e) => setError(String(e)));
  }
  useEffect(() => { if (user) load(); /* eslint-disable-next-line */ }, [user]);

  // Client-side guard (real enforcement is the API gate): non-admins bounce home.
  if (user && user.role !== "platform_admin") return <Redirect to="/dashboard" />;
  if (!rows) return <AppLayout><div className="flex items-center justify-center h-64 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" />Loading…</div></AppLayout>;

  const filtered = rows.filter((r) =>
    (planFilter === "all" || r.tenant.plan === planFilter) &&
    (filter === "" || r.tenant.name.toLowerCase().includes(filter.toLowerCase()) || (r.tenant.contactEmail ?? "").toLowerCase().includes(filter.toLowerCase()))
  );

  // Aggregate KPI strip; mrrCents is a headline figure (regional contract pricing
  // is not modelled here — sales owns true revenue).
  const totals = {
    tenants: rows.length,
    demo:    rows.filter((r) => r.tenant.plan === "demo").length,
    paid:    rows.filter((r) => r.tenant.plan !== "demo").length,
    expired: rows.filter((r) => r.planExpired).length,
    mrrCents: rows.reduce((s, r) => s + (r.plan.priceUsdPerMonth > 0 ? r.plan.priceUsdPerMonth * 100 : 0), 0),
  };

  // PATCH a tenant onto a new plan, then refetch so the table reflects it.
  async function changePlan(tenantId: string, planCode: string) {
    setBusy(tenantId); setError(null);
    try {
      const r = await fetch(`${apiBase}/plans/admin/tenants/${tenantId}/plan`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ planCode }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }

  // Record an externally-collected payment: extends paid_through by one term
  // and flips the tenant back to active. The single external input to the
  // manual-billing lifecycle (no in-system payment processing).
  async function recordPayment(tenantId: string, term: BillingTerm) {
    setBusy(tenantId); setError(null);
    try {
      const r = await fetch(`${apiBase}/tenants/${tenantId}/record-payment`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ term }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <div>
          <h1 className="page-title flex items-center gap-2">
            <TrendingUp className="w-7 h-7 text-primary" /> Subscriptions
          </h1>
          <p className="text-muted-foreground mt-1">
            Every tenant's plan, expiry, and live usage. Change plans inline or open a tenant for full detail.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <KpiCard label="Total tenants"  value={String(totals.tenants)} />
          <KpiCard label="Paid"           value={String(totals.paid)} />
          <KpiCard label="On demo"        value={String(totals.demo)} />
          <KpiCard label="Expired"        value={String(totals.expired)} accent={totals.expired > 0 ? "destructive" : undefined} />
          <KpiCard label="MRR (headline)" value={`$${(totals.mrrCents / 100).toLocaleString()}`} />
        </div>

        {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base">Tenants</CardTitle>
            <div className="flex items-center gap-2">
              <Input placeholder="Search name / email" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />
              <Select value={planFilter} onValueChange={setPlanFilter}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All plans</SelectItem>
                  <SelectItem value="demo">Demo</SelectItem>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="growth">Growth</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                  <tr>
                    <th className="text-left py-2 pr-3">Tenant</th>
                    <th className="text-left py-2 pr-3">Plan</th>
                    <th className="text-left py-2 pr-3">Status</th>
                    <th className="text-left py-2 pr-3">Open jobs</th>
                    <th className="text-left py-2 pr-3">Interviews</th>
                    <th className="text-left py-2 pr-3">Region</th>
                    <th className="text-left py-2 pr-3">Country</th>
                    <th className="text-left py-2 pr-3">Paid through</th>
                    <th className="text-left py-2 pr-3">Change plan</th>
                    <th className="text-left py-2">Record payment</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.tenant.id} className="border-b border-border/40 hover:bg-muted/30">
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2">
                          <Building2 className="w-4 h-4 text-muted-foreground" />
                          <div>
                            <p className="font-medium">{r.tenant.name}</p>
                            <p className="text-xs text-muted-foreground">{r.tenant.contactEmail ?? r.tenant.slug}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 pr-3">
                        <Badge className={planColor[r.tenant.plan] ?? ""} variant="outline">{r.plan.name}</Badge>
                      </td>
                      <td className="py-3 pr-3">
                        {r.tenant.status === "suspended"
                          ? <Badge variant="outline" className={`gap-1 ${statusBadge.suspended}`}><AlertTriangle className="w-3 h-3" />Suspended</Badge>
                          : <Badge variant="outline" className={statusBadge[r.tenant.status] ?? "capitalize"}>{statusLabel[r.tenant.status] ?? r.tenant.status}</Badge>}
                      </td>
                      <td className="py-3 pr-3">{r.usage.openJobs.current} / {r.usage.openJobs.limit === -1 ? "∞" : r.usage.openJobs.limit}</td>
                      <td className="py-3 pr-3">{r.usage.interviews.current} / {r.usage.interviews.limit === -1 ? "∞" : r.usage.interviews.limit}</td>
                      <td className="py-3 pr-3 uppercase text-xs">{r.tenant.region}</td>
                      <td className="py-3 pr-3 uppercase text-xs">{r.tenant.country ?? <span className="text-muted-foreground normal-case">pending</span>}</td>
                      <td className="py-3 pr-3 text-xs text-muted-foreground">
                        {r.tenant.paidThroughAt
                          ? <>{formatDistanceToNow(parseISO(r.tenant.paidThroughAt), { addSuffix: true })}<br /><span className="opacity-60">{format(parseISO(r.tenant.paidThroughAt), "MMM d, yyyy")}</span></>
                          : r.expiresAt
                            ? <>{formatDistanceToNow(parseISO(r.expiresAt), { addSuffix: true })}<br /><span className="opacity-60">trial · {format(parseISO(r.expiresAt), "MMM d, yyyy")}</span></>
                            : "—"}
                      </td>
                      <td className="py-3 pr-3">
                        <Select disabled={busy === r.tenant.id} value={r.tenant.plan} onValueChange={(v) => changePlan(r.tenant.id, v)}>
                          <SelectTrigger className="w-32 h-8 text-xs">
                            {busy === r.tenant.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <SelectValue />}
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="demo">Demo</SelectItem>
                            <SelectItem value="starter">Starter</SelectItem>
                            <SelectItem value="growth">Growth</SelectItem>
                            <SelectItem value="enterprise">Enterprise</SelectItem>
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="py-3">
                        {r.tenant.plan === "demo"
                          ? <span className="text-xs text-muted-foreground">—</span>
                          : <RecordPaymentControl
                              disabled={busy === r.tenant.id}
                              busy={busy === r.tenant.id}
                              defaultTerm={(["monthly", "quarterly", "annual"].includes(r.tenant.billingTerm) ? r.tenant.billingTerm : "monthly") as BillingTerm}
                              onRecord={(term) => recordPayment(r.tenant.id, term)}
                            />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0 && <p className="text-center text-muted-foreground py-8">No tenants match.</p>}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}

// Per-row record-payment control: pick a term, then confirm. Records an
// externally-collected payment (ACH today — no in-system processing).
function RecordPaymentControl({ defaultTerm, busy, disabled, onRecord }: {
  defaultTerm: BillingTerm;
  busy: boolean;
  disabled: boolean;
  onRecord: (term: BillingTerm) => void;
}) {
  const [term, setTerm] = useState<BillingTerm>(defaultTerm);
  return (
    <div className="flex items-center gap-1.5">
      <Select value={term} onValueChange={(v) => setTerm(v as BillingTerm)} disabled={disabled}>
        <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="monthly">Monthly</SelectItem>
          <SelectItem value="quarterly">Quarterly</SelectItem>
          <SelectItem value="annual">Annual</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={disabled} onClick={() => onRecord(term)}>
        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : "Record"}
      </Button>
    </div>
  );
}

function KpiCard({ label, value, accent }: { label: string; value: string; accent?: "destructive" }) {
  return (
    <div className={`rounded-lg border p-4 ${accent === "destructive" ? "border-destructive/40 bg-destructive/5" : "border-border bg-card"}`}>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}
