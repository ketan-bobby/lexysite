/*
 * Public Order Form Terms page. Draft — pending legal review.
 * These terms apply to order forms executed with customers and sit
 * underneath the Terms of Service / master agreement.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { FileText, ArrowLeft } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const LAST_UPDATED = "24 July 2026";
const CONTACT_EMAIL = "legal@l3xy.ai";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-4 text-foreground">{title}</h2>
      <div className="space-y-3 text-sm text-muted-foreground leading-relaxed">{children}</div>
    </section>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="text-primary mt-0.5 shrink-0">•</span>
      <span>{children}</span>
    </li>
  );
}

export default function OrderFormTerms() {
  usePageMeta({
    title: "Order Form Terms",
    description: "Standard terms that apply to L3XY AI order forms.",
    path: "/order-form-terms",
  });
  return (
    <div className="min-h-screen text-foreground">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/40 backdrop-blur-xl bg-background/90">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center cursor-pointer gap-2">
              <LexyLogo size="sm" />
            </div>
          </Link>
          <Link href="/">
            <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to Home
            </button>
          </Link>
        </div>
      </nav>

      <main className="pt-28 pb-24 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
              <FileText className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Legal
            </span>
          </div>
          <h1 className="text-4xl font-black mb-2">Order Form Terms</h1>
          <p className="text-sm text-muted-foreground mb-6">Last updated: {LAST_UPDATED}</p>

          <div className="mb-10 rounded-xl border border-border bg-muted/30 p-5 text-sm text-muted-foreground leading-relaxed">
            These standard terms are incorporated by reference into each order form ("Order Form")
            executed between Lexy Inc. ("Lexy") and the customer named on the Order Form
            ("Customer"). Together with the{" "}
            <Link href="/terms" className="text-primary hover:underline">
              Terms of Service
            </Link>{" "}
            (or a mutually executed master agreement) and the{" "}
            <Link href="/dpa" className="text-primary hover:underline">
              Data Processing Agreement
            </Link>
            , they form the agreement governing Customer's subscription.
          </div>

          <Section title="1. Order of Precedence">
            <p>
              If there is a conflict, the following order of precedence applies: (a) the Order Form,
              (b) the Data Processing Agreement, (c) the master agreement or Terms of Service, and
              (d) these Order Form Terms.
            </p>
          </Section>

          <Section title="2. Subscription Term and Renewal">
            <ul className="space-y-2">
              <Li>
                The subscription term is stated on the Order Form and begins on the start date
                listed there.
              </Li>
              <Li>
                Unless the Order Form says otherwise, subscriptions renew for successive terms of
                the same length unless either party gives notice of non-renewal at least 30 days
                before the end of the then-current term.
              </Li>
              <Li>
                Trial or pilot periods, if any, are stated on the Order Form and convert or expire
                as described there.
              </Li>
            </ul>
          </Section>

          <Section title="3. Fees and Payment">
            <ul className="space-y-2">
              <Li>
                Fees, billing frequency, and payment method are stated on the Order Form. Unless
                stated otherwise, invoices are due within 30 days.
              </Li>
              <Li>
                Per-hire or usage-based fees, where applicable, are calculated as described on the
                Order Form and invoiced in arrears.
              </Li>
              <Li>
                Fees are exclusive of taxes; Customer is responsible for applicable taxes other than
                taxes on Lexy's income.
              </Li>
              <Li>
                Late amounts may accrue interest at the lesser of 1.5% per month or the maximum
                permitted by law.
              </Li>
            </ul>
          </Section>

          <Section title="4. Scope of Use">
            <ul className="space-y-2">
              <Li>
                Use is limited to the plan, seat counts, tenants, regions, and usage limits stated
                on the Order Form.
              </Li>
              <Li>
                Use of the platform remains subject to the{" "}
                <Link href="/prohibited-uses" className="text-primary hover:underline">
                  Prohibited Uses
                </Link>{" "}
                policy.
              </Li>
              <Li>
                Affiliates of Customer may use the subscription only if named on the Order Form.
              </Li>
            </ul>
          </Section>

          <Section title="5. Changes">
            <p>
              Changes to plan, seats, or usage limits require a new or amended Order Form signed by
              both parties. Downgrades take effect at the next renewal unless the Order Form states
              otherwise.
            </p>
          </Section>

          <Section title="6. Termination">
            <p>
              Termination rights are as set out in the master agreement or Terms of Service. Unless
              stated otherwise on the Order Form, fees paid are non-refundable and fees committed
              for the current term remain payable.
            </p>
          </Section>

          <Section title="7. Contact">
            <p>
              Questions about an Order Form:{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">
                {CONTACT_EMAIL}
              </a>
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}
