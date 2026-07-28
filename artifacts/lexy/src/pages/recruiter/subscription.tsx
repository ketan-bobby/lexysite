/**
 * pages/recruiter/subscription.tsx — Tenant Admin "Subscription" Page
 *
 * Where tenant admins (and any user really, but the menu link is only shown
 * to tenant_admin) come to:
 *   • See their current plan, what's included, and when it expires
 *   • See live credit usage vs limits (jobs, interviews, candidate-DB
 *     searches, AI generations, outreach messages)
 *   • Manage payment methods / cancel via the Stripe customer portal
 *   • Reach sales to discuss plan changes (the Stripe Checkout backend in
 *     routes/billing.ts is left intact for sales-issued direct checkout
 *     links, but this UI deliberately never surfaces self-serve upgrade
 *     buttons or headline prices — rates differ per region and per
 *     contract, so every commercial conversation is sales-led)
 */
import { authHeaders } from "@/lib/api";
import { useEffect, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CreditCard, Zap, AlertTriangle, CheckCircle2, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { format, parseISO, formatDistanceToNow } from "date-fns";

const apiBase = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

type CreditKind = "interview" | "candidate_db_search" | "ai_generation" | "outreach_message";
type CreditUsage = { current: number; limit: number; periodLabel: string };
// We intentionally don't model regional pricing in the UI type — the API still
// returns it (for sales-issued checkout flows), but this page never renders
// monetary amounts.
type Plan = {
  code: string; name: string; tagline: string;
  expiresAfterDays: number;
  publiclyVisible: boolean; selfServe: boolean;
  limits: Record<string, number>; features: Record<string, boolean>;
};
type Meter = { current: number; limit: number };
type UsageResponse = {
  tenant: {
    id: string; name: string; plan: string; region?: string; createdAt: string;
    /** Sales-led cadence on the contract. No customer-facing toggle. */
    billingTerm?: "monthly" | "annual";
  };
  plan: Plan;
  planExpired: boolean;
  expiresAt: string | null;
  usage: {
    openJobs: Meter;
    interviews: Meter;
    staffSeats: Meter;
    subClients: Meter;
  };
};
type CreditsResponse = {
  plan: Plan;
  planExpired: boolean;
  planActivatedAt: string;
  expiresAt: string | null;
  byKind: Record<CreditKind, CreditUsage>;
};
/** Manual / sales-led billing read-out from GET /billing/me/subscriptions.
 *  When paidThroughAt is non-null the tenant is on a contract; the date is
 *  the authoritative expiry and the in-app message says "managed by your
 *  account team." When null the tenant is on a trial/demo and the usual
 *  plan-expiry math applies (which is what `usage.expiresAt` reflects). */
type ManualBilling = {
  plan: string;
  status: "active" | "suspended" | "trial";
  billingTerm: "monthly" | "annual";
  paidThroughAt: string | null;
  planActivatedAt: string | null;
};

// Thin fetch wrapper: cookie session + JSON content type (dev-only Bearer via authHeaders).
function authedFetch(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init.headers as any) },
  });
}

const planAccent: Record<string, string> = {
  demo:       "border-amber-400/40 bg-amber-500/5",
  starter:    "border-slate-400/30 bg-slate-500/5",
  growth:     "border-cyan-500/40 bg-cyan-500/5",
  enterprise: "border-purple-500/40 bg-purple-500/5",
};

const creditDisplay: Record<CreditKind, { label: string; icon: any }> = {
  interview:           { label: "Interview sessions",         icon: CheckCircle2 },
  candidate_db_search: { label: "Candidate-DB searches",      icon: Zap          },
  ai_generation:       { label: "AI generations",             icon: Sparkles     },
  outreach_message:    { label: "Outreach messages",          icon: ExternalLink },
};

// Tenant-admin subscription page: current plan, live credit usage, billing portal.
export default function Subscription() {
  const { user } = useAuth() as any;
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [credits, setCredits] = useState<CreditsResponse | null>(null);
  const [manualBilling, setManualBilling] = useState<ManualBilling | null>(null);
  const [allPlans, setAllPlans] = useState<Plan[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        // Step 1: load usage so we know the tenant's region.
        const [usageRes, creditsRes, billingRes] = await Promise.all([
          authedFetch(`${apiBase}/plans/me/usage`).then((r) => r.json()),
          authedFetch(`${apiBase}/credits/me/usage`).then((r) => r.json()),
          // Manual-billing read-out; safe to fail silently — the page is
          // useful without it. The endpoint requires resolveUser so a 401
          // here just means the session expired and the usage call will
          // surface the real error.
          authedFetch(`${apiBase}/billing/me/subscriptions`).then((r) => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (cancelled) return;
        setUsage(usageRes);
        setCredits(creditsRes);
        setManualBilling(billingRes?.manualBilling ?? null);
        // Step 2: load the plan catalog with regional pricing applied so
        // upgrade prices reflect what the tenant will actually be charged.
        const region = usageRes?.tenant?.region ?? "us";
        const plansRes = await fetch(`${apiBase}/plans?region=${encodeURIComponent(region)}`).then((r) => r.json());
        if (!cancelled) setAllPlans(plansRes?.plans ?? []);
      } catch (e) {
        if (!cancelled) setErrorMsg(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  /**
   * Navigate the user to a Stripe-hosted page. Stripe Checkout and the Stripe
   * Customer Portal both set X-Frame-Options: DENY, so a same-frame redirect
   * fails silently when the app is being viewed inside an iframe (e.g. the
   * Replit canvas preview, or any embed). We:
   *   1. Try to break out of any parent frame to a top-level navigation.
   *   2. If cross-origin frame access throws, fall back to opening a new tab.
   *   3. As a last resort (popup blocked), do a same-frame redirect.
   */
  function navigateToStripe(url: string) {
    try {
      if (window.top && window.top !== window.self) {
        window.top.location.href = url;
        return;
      }
    } catch {
      // Cross-origin top access blocked — fall through to window.open
    }
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win) window.location.href = url;
  }

  async function openPortal() {
    setBusy("portal"); setErrorMsg(null);
    try {
      const r = await authedFetch(`${apiBase}/billing/portal-link`, {
        method: "POST",
        body: JSON.stringify({ returnUrl: window.location.href }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || "Portal failed");
      navigateToStripe(j.url);
    } catch (e: any) {
      setErrorMsg(e.message);
    } finally { setBusy(null); }
  }

  if (!usage || !credits) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center h-64 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading subscription…
        </div>
      </AppLayout>
    );
  }

  const expiresIn = usage.expiresAt
    ? formatDistanceToNow(parseISO(usage.expiresAt), { addSuffix: true })
    : null;

  const includedSeats = usage.plan.limits.maxStaffSeats;
  const billingTerm = usage.tenant.billingTerm ?? "monthly";

  /* Threshold banner — surfaces any meter that's >=80% used so tenant_admins
   * know they're about to be gated, BEFORE the failing-action 402 fires.
   * 100% means already gated (red). 80–99% means warning (amber). We
   * include all four headline meters + every credit kind. Unlimited (-1)
   * meters are skipped. */
  type ThresholdRow = { label: string; current: number; limit: number; pct: number };
  const allMeters: Array<{ label: string; meter: Meter }> = [
    { label: "Open jobs",           meter: usage.usage.openJobs   },
    { label: "Interview sessions",  meter: usage.usage.interviews },
    { label: "Team seats",          meter: usage.usage.staffSeats },
    { label: "Sub-clients",         meter: usage.usage.subClients },
    ...(Object.entries(credits.byKind) as [CreditKind, CreditUsage][]).map(([k, u]) => ({
      label: creditDisplay[k].label,
      meter: { current: u.current, limit: u.limit },
    })),
  ];
  const thresholds: ThresholdRow[] = allMeters
    .filter(({ meter }) => meter.limit !== -1 && meter.limit > 0 && meter.current / meter.limit >= 0.8)
    .map(({ label, meter }) => ({
      label,
      current: meter.current,
      limit: meter.limit,
      pct: Math.min(100, Math.round((meter.current / meter.limit) * 100)),
    }))
    .sort((a, b) => b.pct - a.pct);
  const anyAtCap     = thresholds.some((t) => t.pct >= 100);
  const anyApproaching = thresholds.some((t) => t.pct < 100);

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Heading */}
        <div className="flex items-start md:items-center justify-between flex-col md:flex-row gap-4">
          <div>
            <h1 className="page-title flex items-center gap-2">
              <CreditCard className="w-7 h-7 text-primary" /> Subscription
            </h1>
            <p className="text-muted-foreground mt-1">
              Your current plan, usage this period, and billing.
            </p>
          </div>
          <Button variant="outline" disabled={busy === "portal"} onClick={openPortal}>
            {busy === "portal" ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ExternalLink className="w-4 h-4 mr-2" />}
            Manage billing
          </Button>
        </div>

        {errorMsg && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {errorMsg}
          </div>
        )}

        {usage.planExpired && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            Your {usage.plan.name} plan has expired. Upgrade below to keep posting jobs and running interviews.
          </div>
        )}

        {!usage.planExpired && thresholds.length > 0 && (
          <div className={
            "rounded-lg border px-4 py-3 text-sm " +
            (anyAtCap
              ? "border-destructive/50 bg-destructive/10 text-destructive"
              : "border-amber-500/40 bg-amber-500/10")
          }>
            <div className="flex items-start gap-2">
              <AlertTriangle className={`w-4 h-4 mt-0.5 ${anyAtCap ? "text-destructive" : "text-amber-500"}`} />
              <div className="space-y-1">
                <div className="font-medium">
                  {anyAtCap
                    ? `You've hit a plan limit on ${usage.plan.name}.`
                    : `You're approaching a plan limit on ${usage.plan.name}.`}
                </div>
                <ul className="text-xs space-y-0.5 opacity-90">
                  {thresholds.slice(0, 5).map((t) => (
                    <li key={t.label}>
                      <span className="font-medium">{t.label}</span> — {t.current} / {t.limit} ({t.pct}%)
                    </li>
                  ))}
                </ul>
                <div className="text-xs opacity-80 pt-1">
                  {anyAtCap
                    ? "New actions will be blocked until you upgrade. "
                    : (anyApproaching ? "You'll be blocked once you hit the cap. " : "")}
                  <a className="underline" href="mailto:sales@l3xy.io?subject=Plan%20upgrade%20inquiry">Contact sales</a> to discuss a larger plan.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Current plan card */}
        <Card className={`border ${planAccent[usage.plan.code] ?? "border-border"}`}>
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle className="text-xl">{usage.plan.name}</CardTitle>
                <p className="text-sm text-muted-foreground mt-1">{usage.plan.tagline}</p>
              </div>
              <div className="text-right flex flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="capitalize">{usage.plan.code}</Badge>
                  {/* Sales-led billing cadence — read-only badge. Tenants
                      can't switch this themselves; sales sets it on contract
                      signing (see schema/tenants.ts → billingTerm). */}
                  <Badge variant={billingTerm === "annual" ? "default" : "outline"} className="capitalize">
                    {billingTerm === "annual" ? "Billed annually" : "Billed monthly"}
                  </Badge>
                </div>
                {/* Manual-billing override beats demo-trial expiry math.
                    When sales has set paid_through_at on the tenant, show
                    THAT as the expiry and label the relationship as
                    sales-managed so the user knows not to look for a
                    self-serve renew button. */}
                {manualBilling?.paidThroughAt ? (
                  <div className="text-xs text-muted-foreground mt-1 text-right">
                    <p>Paid through {format(parseISO(manualBilling.paidThroughAt), "MMM d, yyyy")}</p>
                    <p className="text-[10px] opacity-70">Managed by your account team — contact sales to renew or change plan.</p>
                  </div>
                ) : usage.expiresAt && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Expires {expiresIn} ({format(parseISO(usage.expiresAt), "MMM d, yyyy")})
                  </p>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Pricing intentionally not shown in-app: rates vary by region and
                contract, so we route every commercial conversation through
                sales rather than surfacing a headline number here. */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <Stat label="Open jobs"     value={`${usage.usage.openJobs.current} / ${fmtLimit(usage.usage.openJobs.limit)}`} />
              <Stat label="Interviews"     value={`${usage.usage.interviews.current} / ${fmtLimit(usage.usage.interviews.limit)}`} />
              <Stat
                label="Team seats"
                value={`${usage.usage.staffSeats.current} / ${fmtLimit(usage.usage.staffSeats.limit)}`}
                subtext={includedSeats === -1
                  ? "Unlimited on your plan"
                  : "Includes active members + pending invites"}
              />
              <Stat
                label="Sub-clients"
                value={`${usage.usage.subClients.current} / ${fmtLimit(usage.usage.subClients.limit)}`}
                subtext={usage.usage.subClients.limit === 0
                  ? "Not included on this plan"
                  : "Agency-only — counts child tenants"}
              />
            </div>
          </CardContent>
        </Card>

        {/* Credit meters */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Credit usage ({Object.values(credits.byKind)[0]?.periodLabel ?? "this period"})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(Object.entries(credits.byKind) as [CreditKind, CreditUsage][]).map(([kind, u]) => {
              const Icon = creditDisplay[kind].icon;
              const pct = u.limit === -1 ? 0 : Math.min(100, (u.current / Math.max(u.limit, 1)) * 100);
              const overshoot = u.limit !== -1 && u.current >= u.limit;
              return (
                <div key={kind}>
                  <div className="flex items-center justify-between text-sm mb-1.5">
                    <div className="flex items-center gap-2"><Icon className="w-4 h-4 text-muted-foreground" />{creditDisplay[kind].label}</div>
                    <div className={overshoot ? "text-destructive font-medium" : "text-muted-foreground"}>
                      {u.current} / {fmtLimit(u.limit)}
                    </div>
                  </div>
                  {u.limit !== -1 && <Progress value={pct} className={overshoot ? "[&>div]:bg-destructive" : ""} />}
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Other plans / upgrade
            ────────────────────────────────────────────────────────────────
            We deliberately don't render headline prices on plan upgrade
            cards: pricing differs per region and per contract, so every
            upgrade is sales-led. We surface what each plan *includes*
            (limits + features) — the commercial conversation happens via
            sales@l3xy.io. The Stripe Checkout flow in routes/billing.ts is
            kept for the rare case where sales sends a customer back to a
            direct checkout link. */}
        <div>
          <h2 className="text-lg font-semibold mb-3">Available plans</h2>
          <div className="grid md:grid-cols-3 gap-4">
            {allPlans.map((p) => (
              <Card key={p.code} className={`border ${p.code === usage.plan.code ? "border-primary/60" : "border-border"}`}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    {p.code === usage.plan.code && <Badge>Current</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{p.tagline}</p>
                </CardHeader>
                <CardContent>
                  <ul className="text-xs space-y-1 text-muted-foreground mb-4">
                    <li>{fmtLimit(p.limits.maxOpenJobs)} open jobs</li>
                    <li>{fmtLimit(p.limits.maxInterviewsPerMonth)} interviews/mo</li>
                    <li>{fmtLimit(p.limits.maxCandidateDbSearchesPerMonth)} DB searches/mo</li>
                    <li>{fmtLimit(p.limits.maxStaffSeats)} included seats</li>
                  </ul>
                  {p.code !== usage.plan.code && (
                    <Button
                      className="w-full gap-2"
                      variant="outline"
                      onClick={() => window.location.assign(`mailto:sales@l3xy.io?subject=${encodeURIComponent(`${p.name} plan inquiry`)}`)}
                    >
                      <ExternalLink className="w-4 h-4" /> Contact Sales
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}

function Stat({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold mt-0.5">{value}</p>
      {subtext && <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{subtext}</p>}
    </div>
  );
}

function fmtLimit(n: number) { return n === -1 ? "Unlimited" : String(n); }
