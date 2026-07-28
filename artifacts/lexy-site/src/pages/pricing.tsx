import SiteFooter from "@/components/SiteFooter";
/*
 * pricing.tsx — Public pricing / plan-comparison page.
 *
 * Renders the three plan tiers, a feature-comparison matrix, and an FAQ.
 * Crucially, NO monetary amounts are ever shown: pricing is region- and
 * contract-specific, so every CTA routes to sales. The plan catalog is fetched
 * from /api/plans (with a hardcoded FALLBACK_PLANS) only to keep the feature
 * and limit lists in sync with the server — the returned price fields are
 * deliberately ignored.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { useEffect, useState } from "react";
import { Check, X, Sparkles, Mail, Zap, TrendingUp, Building2, ChevronDown } from "lucide-react";

// API server is mounted by the platform proxy at /api/* (see api-server
// artifact.toml paths=["/api"]). Calling it without a host prefix avoids the
// stale /api-server proxy alias.
const API = "";

function LexyLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "h-12" : size === "sm" ? "h-7" : "h-9";
  return (
    <img
      src={`${import.meta.env.BASE_URL}lexy-ai-logo.png`}
      alt="L3xy AI"
      className={`${cls} w-auto object-contain select-none`}
      draggable={false}
    />
  );
}

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 backdrop-blur-xl bg-background/80">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/">
          <LexyLogo size="md" />
        </Link>
        <div className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
          <Link href="/employers" className="hover:text-foreground transition-colors">
            Employers
          </Link>
          <Link href="/candidates" className="hover:text-foreground transition-colors">
            Candidates
          </Link>
          <Link href="/pricing" className="text-foreground transition-colors">
            Pricing
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/employers?demo=1"
            className="px-4 py-2 rounded-lg text-sm font-medium border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground transition-colors"
          >
            Book a Demo
          </Link>
          <Link
            href="/employers"
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Start Free Trial
          </Link>
        </div>
      </div>
    </nav>
  );
}

interface PlanLimits {
  maxOpenJobs: number;
  maxInterviewsPerMonth: number;
  maxStaffSeats: number;
  maxSubClients: number;
  maxCandidateDbSearchesPerMonth: number;
  maxAiGenerationsPerMonth?: number;
  maxOutreachMessagesPerMonth?: number;
}

interface PlanFeatures {
  livingTalentGraph: boolean;
  candidateDatabaseSearch: boolean;
  culturalInterviews: boolean;
  programmingInterviews: boolean;
  outreachConversationAgent: boolean;
  antiGhost: boolean;
  whiteLabel: boolean;
  integrations: boolean;
  partnerProgram: boolean;
  sso: boolean;
  scim: boolean;
  customDataRetention: boolean;
  dedicatedCsm: boolean;
}

/** The API returns regional pricing fields too — they're intentionally not
 *  modeled here because this page never renders any monetary amount. All
 *  commercial conversations route through sales. */
interface PlanPackage {
  code: "starter" | "growth" | "enterprise";
  name: string;
  tagline: string;
  limits: PlanLimits;
  features: PlanFeatures;
}

const FALLBACK_PLANS: PlanPackage[] = [
  {
    code: "starter",
    name: "Starter",
    tagline: "For solo recruiters and small in-house TA teams.",

    limits: {
      maxOpenJobs: 5,
      maxInterviewsPerMonth: 100,
      maxStaffSeats: 3,
      maxSubClients: 0,
      maxCandidateDbSearchesPerMonth: 250,
    },
    features: {
      livingTalentGraph: true,
      candidateDatabaseSearch: false,
      culturalInterviews: true,
      programmingInterviews: true,
      outreachConversationAgent: true,
      antiGhost: true,
      whiteLabel: false,
      integrations: false,
      partnerProgram: false,
      sso: false,
      scim: false,
      customDataRetention: false,
      dedicatedCsm: false,
    },
  },
  {
    code: "growth",
    name: "Growth",
    tagline: "For scaling teams and staffing agencies.",

    limits: {
      maxOpenJobs: 25,
      maxInterviewsPerMonth: 500,
      maxStaffSeats: 10,
      maxSubClients: 10,
      maxCandidateDbSearchesPerMonth: 2500,
    },
    features: {
      livingTalentGraph: true,
      candidateDatabaseSearch: true,
      culturalInterviews: true,
      programmingInterviews: true,
      outreachConversationAgent: true,
      antiGhost: true,
      whiteLabel: true,
      integrations: true,
      partnerProgram: true,
      sso: false,
      scim: false,
      customDataRetention: false,
      dedicatedCsm: false,
    },
  },
  {
    code: "enterprise",
    name: "Enterprise",
    tagline: "For large recruiting orgs with custom needs.",

    limits: {
      maxOpenJobs: -1,
      maxInterviewsPerMonth: -1,
      maxStaffSeats: -1,
      maxSubClients: -1,
      maxCandidateDbSearchesPerMonth: -1,
    },
    features: {
      livingTalentGraph: true,
      candidateDatabaseSearch: true,
      culturalInterviews: true,
      programmingInterviews: true,
      outreachConversationAgent: true,
      antiGhost: true,
      whiteLabel: true,
      integrations: true,
      partnerProgram: true,
      sso: true,
      scim: true,
      customDataRetention: true,
      dedicatedCsm: true,
    },
  },
];

const PLAN_META: Record<
  string,
  { icon: typeof Zap; gradient: string; accent: string; popular?: boolean }
> = {
  starter: {
    icon: Zap,
    gradient: "from-black/[0.02] via-transparent to-transparent",
    accent: "text-violet-600",
  },
  growth: {
    icon: TrendingUp,
    gradient: "from-primary/[0.08] via-primary/[0.02] to-transparent",
    accent: "text-primary",
    popular: true,
  },
  enterprise: {
    icon: Building2,
    gradient: "from-black/[0.02] via-transparent to-transparent",
    accent: "text-emerald-600",
  },
};

const fmtLimit = (n: number) => (n === -1 ? "Unlimited" : n.toLocaleString());

const FEATURE_ROWS: { key: keyof PlanFeatures; label: string }[] = [
  { key: "livingTalentGraph", label: "Living Talent Graph" },
  { key: "candidateDatabaseSearch", label: "Candidate database search" },
  { key: "culturalInterviews", label: "Cultural interviews" },
  { key: "programmingInterviews", label: "Programming interviews" },
  { key: "outreachConversationAgent", label: "Outreach Conversation Agent" },
  { key: "antiGhost", label: "Anti-ghost re-engagement" },
  { key: "whiteLabel", label: "White-label branding" },
  { key: "integrations", label: "ATS / HRIS integrations" },
  { key: "partnerProgram", label: "Partner / referral program" },
  { key: "sso", label: "SSO (SAML / OIDC)" },
  { key: "scim", label: "SCIM provisioning" },
  { key: "customDataRetention", label: "Custom data retention" },
  { key: "dedicatedCsm", label: "Dedicated CSM" },
];

const FAQS = [
  {
    q: "Why do you charge a per-hire fee on top of the subscription?",
    a: "The subscription covers the platform — interviews, the Living Talent Graph, integrations. The per-hire fee aligns us with your outcome: we only win when you actually hire someone. It's still a fraction of what an agency or contingent recruiter charges.",
  },
  {
    q: "What counts as an interview?",
    a: "One completed candidate session — cultural, technical, or coding. Drop-offs and incompletes don't count toward your monthly limit.",
  },
  {
    q: "Can I switch plans?",
    a: "Yes, anytime. Upgrades take effect immediately and we prorate. Downgrades take effect at the end of the current billing cycle.",
  },
  {
    q: "Is there a free trial?",
    a: "Yes. The 14-day demo gives you one open job and twenty interview sessions — enough to evaluate the product on a real role.",
  },
  {
    q: "Do you charge for candidates?",
    a: "Never. Candidates use Lexy for free, forever. We only charge employers.",
  },
  {
    q: "Why don't you show prices?",
    a: "We price each region separately to reflect local purchasing power, currencies, and team size. Talk to sales and we'll send a tailored quote — usually within one business day.",
  },
  {
    q: "How do extra seats work?",
    a: "Each plan includes a fixed number of recruiter / hiring-manager seats (3 on Starter, 10 on Growth). You can invite more — additional seats are billed monthly at the per-seat rate for your region. Seats are added and removed prorated within the billing period.",
  },
];

function PlanCard({ plan }: { plan: PlanPackage }) {
  const meta = PLAN_META[plan.code] ?? PLAN_META.starter;
  const Icon = meta.icon;

  /* Headline prices intentionally not rendered on the public site: rates
     differ per region and per contract, so every commercial conversation
     is routed through sales. The card surfaces the *value* — included
     limits + feature set — and a single "Contact Sales" CTA. The free
     trial sits at the top of the page as a separate, no-price entry. */

  return (
    <div
      className={`relative rounded-3xl border ${meta.popular ? "border-primary/40" : "border-border"} bg-card flex flex-col ${meta.popular ? "md:-mt-4 md:mb-0" : ""}`}
    >
      {meta.popular && (
        <div className="absolute top-4 right-4 px-3 py-1 rounded-full bg-primary text-primary-foreground text-[11px] font-semibold uppercase tracking-wider flex items-center gap-1 z-10">
          <Sparkles className="w-3 h-3" /> Most Popular
        </div>
      )}

      <div
        className={`absolute inset-0 rounded-3xl bg-gradient-to-b ${meta.gradient} pointer-events-none overflow-hidden`}
      />

      <div className="relative p-8 flex flex-col flex-1">
        <div
          className={`w-11 h-11 rounded-xl bg-black/5 border border-black/10 flex items-center justify-center mb-5 ${meta.accent}`}
        >
          <Icon className="w-5 h-5" />
        </div>

        <h3 className="text-2xl font-semibold mb-2">{plan.name}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-6 min-h-[2.5rem]">
          {plan.tagline}
        </p>

        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight">Custom pricing</span>
        </div>
        <p className="text-xs text-muted-foreground mb-7">
          Tailored to your region, team size, and hiring volume.
        </p>

        <a
          href={`mailto:sales@l3xy.io?subject=${encodeURIComponent(`${plan.name} plan inquiry`)}`}
          className={`w-full py-3 rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2 cursor-pointer ${meta.popular ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-black/5 border border-border text-foreground hover:bg-black/10"}`}
        >
          <Mail className="w-4 h-4" /> Contact Sales
        </a>

        <div className="mt-8 pt-7 border-t border-border/60 space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Open jobs</span>
            <span className="font-medium">{fmtLimit(plan.limits.maxOpenJobs)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Interviews / mo</span>
            <span className="font-medium">{fmtLimit(plan.limits.maxInterviewsPerMonth)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Included recruiter seats</span>
            <span className="font-medium">{fmtLimit(plan.limits.maxStaffSeats)}</span>
          </div>
          {plan.limits.maxSubClients > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Sub-clients</span>
              <span className="font-medium">{fmtLimit(plan.limits.maxSubClients)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Pricing() {
  usePageMeta({
    title: "Pricing",
    description:
      "Simple, transparent pricing for the L3XY AI hiring platform. Start free — no implementation delays, live in minutes.",
    path: "/pricing",
  });
  const [plans, setPlans] = useState<PlanPackage[]>(FALLBACK_PLANS);
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  // Fetch the plan catalog once so feature/limit lists stay in sync with the
  // server. We pass region=us purely to satisfy the endpoint contract — the UI
  // never renders any of the returned monetary fields.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/api/plans?region=us`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled && Array.isArray(data?.plans) && data.plans.length > 0) {
          const order: Record<string, number> = { starter: 0, growth: 1, enterprise: 2 };
          const sorted = [...data.plans].sort(
            (a: PlanPackage, b: PlanPackage) => (order[a.code] ?? 99) - (order[b.code] ?? 99),
          );
          setPlans(sorted);
        }
      } catch {
        // keep fallback
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen text-foreground">
      <Nav />

      {/* Hero */}
      <section className="relative pt-32 pb-12 px-6 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/20 rounded-full blur-[120px]" />
        </div>
        <div className="relative max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-black/5 text-xs text-muted-foreground mb-6">
            <Sparkles className="w-3 h-3 text-primary" /> Simple, outcome-aligned pricing
          </div>
          <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight mb-6">
            Pricing that <span className="gradient-text">pays for itself.</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed mb-6">
            One subscription unlocks the full platform. A small per-hire fee keeps us aligned with
            the outcome you actually care about: hires that stick. Candidates use Lexy free,
            forever.
          </p>
          <p className="text-sm text-muted-foreground/80 max-w-xl mx-auto">
            Pricing is tailored per region and team size — talk to sales for a quote.
          </p>
        </div>
      </section>

      {/* Plans */}
      <section className="px-6 pb-20">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-3 gap-6">
            {plans.map((p) => (
              <PlanCard key={p.code} plan={p} />
            ))}
          </div>

          <p className="text-center text-xs text-muted-foreground mt-8 max-w-2xl mx-auto">
            Every contract is custom-fit to your region, team size, and hiring volume. VAT / GST
            added at checkout where applicable. Per-hire fee triggers only when an offer is accepted
            through the platform.
          </p>
        </div>
      </section>

      {/* Comparison */}
      <section className="px-6 py-20 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-3">Compare features</h2>
            <p className="text-muted-foreground">Everything in the platform, line by line.</p>
          </div>

          <div className="rounded-2xl border border-border overflow-hidden overflow-x-auto">
            <div className="min-w-[640px]">
              <div className="grid grid-cols-[1.7fr_1fr_1fr_1fr] bg-black/[0.03] text-xs uppercase tracking-wider text-muted-foreground">
                <div className="px-5 py-4">Feature</div>
                {plans.map((p) => (
                  <div key={p.code} className="px-5 py-4 text-center font-semibold text-foreground">
                    {p.name}
                  </div>
                ))}
              </div>
              {FEATURE_ROWS.map((row, i) => (
                <div
                  key={row.key}
                  className={`grid grid-cols-[1.7fr_1fr_1fr_1fr] text-sm ${i % 2 === 0 ? "bg-transparent" : "bg-black/[0.015]"} border-t border-border/40`}
                >
                  <div className="px-5 py-3.5 text-muted-foreground">{row.label}</div>
                  {plans.map((p) => (
                    <div key={p.code} className="px-5 py-3.5 flex justify-center">
                      {p.features[row.key] ? (
                        <Check className="w-4 h-4 text-emerald-600" />
                      ) : (
                        <X className="w-4 h-4 text-muted-foreground/30" />
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="px-6 py-20 border-t border-border/50">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-3">Common questions</h2>
          </div>
          <div className="space-y-3">
            {FAQS.map((f, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                className="w-full text-left rounded-2xl border border-border bg-card hover:border-primary/30 transition-colors p-5 cursor-pointer"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="font-semibold text-base">{f.q}</span>
                  <ChevronDown
                    className={`w-4 h-4 text-muted-foreground shrink-0 transition-transform ${openFaq === i ? "rotate-180" : ""}`}
                  />
                </div>
                {openFaq === i && (
                  <p className="text-sm text-muted-foreground leading-relaxed mt-3">{f.a}</p>
                )}
              </button>
            ))}
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
