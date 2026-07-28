/**
 * pages/signup.tsx — Contact Sales (formerly self-serve Stripe checkout)
 *
 * We don't show plan rates publicly: pricing differs by region and contract,
 * so this page now collects qualification info and routes the inquiry to
 * sales via a pre-filled mailto. The free trial lives on /start-trial — that
 * flow is no-price (demo plan) and is unaffected.
 *
 * What was removed (intentionally):
 *   • Stripe self-serve checkout (`/api/public/signup-checkout`)
 *   • Headline monthly price, per-seat price, per-hire fee
 *   • Region picker + regional pricing fetch + USD-fallback disclaimer
 *   • "Order summary" sidebar that quoted /mo rates
 *
 * The Stripe Checkout backend in routes/billing.ts is kept intact so sales
 * can send a customer a direct Checkout link after a manual quote.
 */
import { usePageMeta } from "@/lib/seo";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Mail, Sparkles, Check } from "lucide-react";

type PlanCode = "starter" | "growth" | "enterprise";

const PLAN_INFO: Record<PlanCode, { name: string; tagline: string; perks: string[] }> = {
  starter: {
    name: "Starter",
    tagline: "For solo recruiters and small in-house TA teams.",
    perks: [
      "5 open jobs",
      "100 interviews / month",
      "3 included recruiter seats",
      "Cultural + programming interviews",
    ],
  },
  growth: {
    name: "Growth",
    tagline: "For scaling teams and staffing agencies.",
    perks: [
      "25 open jobs",
      "500 interviews / month",
      "10 included recruiter seats",
      "Candidate DB + Outreach",
      "White-label branding",
    ],
  },
  enterprise: {
    name: "Enterprise",
    tagline: "For large recruiting orgs with custom needs.",
    perks: ["Unlimited everything", "SSO + SCIM", "Dedicated CSM", "Custom data retention"],
  },
};

function readPlanFromUrl(): PlanCode {
  if (typeof window === "undefined") return "starter";
  const p = new URLSearchParams(window.location.search).get("plan");
  return p === "growth" ? "growth" : p === "enterprise" ? "enterprise" : "starter";
}

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

export default function Signup() {
  usePageMeta({
    title: "Sign Up",
    description: "Create your L3XY AI account and start hiring with verified signals.",
    path: "/signup",
  });
  const [plan, setPlan] = useState<PlanCode>(() => readPlanFromUrl());
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [notes, setNotes] = useState("");

  // Keep the URL plan param in sync if the user clicks the plan tiles.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("plan", plan);
    window.history.replaceState({}, "", url.toString());
  }, [plan]);

  const meta = PLAN_INFO[plan];

  function buildMailto(): string {
    const subject = `${meta.name} plan inquiry${company ? ` — ${company}` : ""}`;
    const body = [
      `Hi Lexy sales team,`,
      ``,
      `I'd like to discuss the ${meta.name} plan.`,
      ``,
      `Name: ${name || "(not provided)"}`,
      `Email: ${email || "(not provided)"}`,
      `Company: ${company || "(not provided)"}`,
      `Team size: ${teamSize || "(not provided)"}`,
      ``,
      `Notes:`,
      notes || "(none)",
    ].join("\n");
    return `mailto:sales@l3xy.io?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    window.location.href = buildMailto();
  }

  return (
    <div className="min-h-screen text-foreground">
      <nav className="border-b border-border/50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <Link href="/">
            <LexyLogo size="md" />
          </Link>
          <div className="hidden sm:block text-sm text-muted-foreground">
            Already have an account?{" "}
            <a href="/login" className="text-primary hover:underline">
              Sign in
            </a>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-12 md:py-16">
        <div className="grid md:grid-cols-[1.2fr_1fr] gap-10 lg:gap-16">
          <section>
            <h1 className="text-3xl md:text-4xl font-semibold tracking-tight mb-3">
              Talk to sales
            </h1>
            <p className="text-muted-foreground mb-8 max-w-md">
              Pricing is tailored per region, team size, and hiring volume. Tell us a bit about your
              team and we'll send a quote — usually within one business day. Want to try first?{" "}
              <Link href="/start-trial" className="text-primary hover:underline">
                Start the 14-day free trial
              </Link>
              .
            </p>

            {/* Plan selector — purely informational, no prices. */}
            <div className="mb-8">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">
                Which plan are you interested in?
              </p>
              <div className="grid grid-cols-3 gap-3">
                {(["starter", "growth", "enterprise"] as PlanCode[]).map((code) => {
                  const active = plan === code;
                  return (
                    <button
                      key={code}
                      type="button"
                      onClick={() => setPlan(code)}
                      className={`text-left rounded-xl border px-4 py-3 transition-colors cursor-pointer ${active ? "border-primary bg-primary/10" : "border-border bg-black/5 hover:bg-black/10"}`}
                    >
                      <div className="flex items-baseline justify-between mb-1">
                        <span className="text-sm font-semibold">{PLAN_INFO[code].name}</span>
                        {code === "growth" && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary flex items-center gap-1">
                            <Sparkles className="w-3 h-3" /> Popular
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">Custom quote</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <Field label="Your full name">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  autoComplete="name"
                  className="w-full bg-black/5 border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary/50 transition-colors"
                  placeholder="Jane Recruiter"
                />
              </Field>
              <Field label="Work email">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  className="w-full bg-black/5 border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary/50 transition-colors"
                  placeholder="jane@yourcompany.com"
                />
              </Field>
              <Field label="Company">
                <input
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  required
                  autoComplete="organization"
                  className="w-full bg-black/5 border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary/50 transition-colors"
                  placeholder="Acme Talent"
                />
              </Field>
              <Field label="Team size" hint="Recruiters and hiring managers who'd use Lexy.">
                <select
                  value={teamSize}
                  onChange={(e) => setTeamSize(e.target.value)}
                  required
                  className="w-full bg-black/5 border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary/50 transition-colors"
                >
                  <option value="">Select…</option>
                  <option value="1-3">1–3 people</option>
                  <option value="4-10">4–10 people</option>
                  <option value="11-25">11–25 people</option>
                  <option value="26-100">26–100 people</option>
                  <option value="100+">100+ people</option>
                </select>
              </Field>
              <Field label="Anything else?" hint="Region, hiring volume, must-have features, etc.">
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={4}
                  className="w-full bg-black/5 border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-primary/50 transition-colors"
                  placeholder="We hire ~30 engineers / quarter across India and the UK, looking for cultural interviews + ATS integration."
                />
              </Field>

              <button
                type="submit"
                className="w-full py-3 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                <Mail className="w-4 h-4" /> Send inquiry <ArrowRight className="w-4 h-4" />
              </button>

              <p className="text-xs text-muted-foreground text-center">
                This opens your email client with the details pre-filled. Or email{" "}
                <a href="mailto:sales@l3xy.io" className="text-primary hover:underline">
                  sales@l3xy.io
                </a>{" "}
                directly.
              </p>
            </form>
          </section>

          {/* Plan summary — value props, no prices. */}
          <aside className="md:sticky md:top-8 self-start">
            <div className="rounded-2xl border border-border bg-card p-6">
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
                What's included
              </p>
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-lg font-semibold">{meta.name}</span>
                <span className="text-sm font-medium text-muted-foreground">Custom quote</span>
              </div>
              <p className="text-sm text-muted-foreground mb-5">{meta.tagline}</p>

              <div className="border-t border-border pt-5 mb-5 space-y-2.5">
                {meta.perks.map((p) => (
                  <div key={p} className="flex items-start gap-2 text-sm">
                    <Check className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" />
                    <span>{p}</span>
                  </div>
                ))}
              </div>

              <div className="rounded-xl bg-primary/5 border border-primary/20 px-4 py-3 text-sm">
                <p className="font-semibold mb-1 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-primary" /> Try before you buy
                </p>
                <p className="text-muted-foreground text-xs leading-relaxed">
                  Our 14-day demo lets you run one real role end-to-end before any conversation
                  about pricing.{" "}
                  <Link href="/start-trial" className="text-primary hover:underline">
                    Start the trial →
                  </Link>
                </p>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground mt-1.5">{hint}</span>}
    </label>
  );
}
