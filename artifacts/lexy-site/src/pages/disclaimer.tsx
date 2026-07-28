/*
 * Public Disclaimer page. Draft — pending legal review.
 * Language rules: hedged framing only, no absolute claims.
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

export default function Disclaimer() {
  usePageMeta({
    title: "Disclaimer",
    description: "L3XY AI website and platform disclaimer.",
    path: "/disclaimer",
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
          <h1 className="text-4xl font-black mb-2">Disclaimer</h1>
          <p className="text-sm text-muted-foreground mb-12">Last updated: {LAST_UPDATED}</p>

          <Section title="1. General Information">
            <p>
              The content on this website and within the Lexy platform is provided for general
              informational purposes only. While we work to keep information accurate and current,
              we make no representations or warranties, express or implied, about the completeness,
              accuracy, reliability, or availability of the website, the platform, or any content.
            </p>
          </Section>

          <Section title="2. Not Professional Advice">
            <p>
              Nothing on this website constitutes legal, compliance, employment, or other
              professional advice. Hiring decisions are subject to laws that vary by jurisdiction.
              You should consult qualified counsel before relying on any content here for compliance
              or employment-law purposes.
            </p>
          </Section>

          <Section title="3. AI-Assisted Outputs">
            <p>
              Lexy provides AI-assisted evaluations, summaries, and recommendations that are
              designed to support — not replace — human decision-making. AI outputs may contain
              errors or omissions and should always be reviewed by a qualified person before any
              decision affecting a candidate is made. Lexy does not make hiring decisions; customers
              and their authorized personnel do.
            </p>
          </Section>

          <Section title="4. No Guarantee of Outcomes">
            <p>
              We do not guarantee hiring outcomes, candidate quality, time-to-hire improvements, or
              any specific results from using the platform. Illustrative metrics on this site
              reflect particular contexts and may not be representative of your results.
            </p>
          </Section>

          <Section title="5. Third-Party Links and Services">
            <p>
              This website and platform may reference or link to third-party websites and services.
              We do not control and are not responsible for their content, policies, or practices.
            </p>
          </Section>

          <Section title="6. Limitation of Liability">
            <p>
              To the maximum extent permitted by law, Lexy Inc. shall not be liable for any loss or
              damage arising from reliance on information on this website. Use of the platform
              itself is governed by the{" "}
              <Link href="/terms" className="text-primary hover:underline">
                Terms of Service
              </Link>{" "}
              and any applicable order form.
            </p>
          </Section>

          <Section title="7. Contact">
            <p>
              Questions about this disclaimer:{" "}
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
