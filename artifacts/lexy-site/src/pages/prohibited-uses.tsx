/*
 * Public Prohibited Uses page. Draft — pending legal review.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { ShieldAlert, ArrowLeft } from "lucide-react";
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

export default function ProhibitedUses() {
  usePageMeta({
    title: "Prohibited Uses",
    description: "Uses of the L3XY AI platform that are not permitted.",
    path: "/prohibited-uses",
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
              <ShieldAlert className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Trust &amp; Legal
            </span>
          </div>
          <h1 className="text-4xl font-black mb-2">Prohibited Uses</h1>
          <p className="text-sm text-muted-foreground mb-12">Last updated: {LAST_UPDATED}</p>

          <Section title="1. Overview">
            <p>
              This policy describes uses of the Lexy platform that are not permitted. It applies to
              all users and supplements the{" "}
              <Link href="/terms" className="text-primary hover:underline">
                Terms of Service
              </Link>
              . Violations may result in suspension or termination of access.
            </p>
          </Section>

          <Section title="2. Unlawful Hiring Practices">
            <ul className="space-y-2">
              <Li>
                Using the platform to discriminate against candidates on the basis of race, color,
                religion, sex, national origin, age, disability, sexual orientation, gender
                identity, or any other characteristic protected by applicable law
              </Li>
              <Li>
                Using AI outputs as the sole basis for an employment decision where human review is
                required by law or by our terms
              </Li>
              <Li>
                Circumventing or disabling fairness, bias-mitigation, consent, or audit features of
                the platform
              </Li>
              <Li>
                Collecting or inferring protected characteristics for the purpose of screening
                candidates
              </Li>
            </ul>
          </Section>

          <Section title="3. Data Misuse">
            <ul className="space-y-2">
              <Li>
                Processing candidate personal data without a lawful basis or outside the scope of
                the applicable agreement and privacy notices
              </Li>
              <Li>
                Scraping, bulk-exporting, reselling, or disclosing candidate data to unauthorized
                third parties
              </Li>
              <Li>
                Contacting candidates who have opted out or been placed on a do-not-contact list
              </Li>
              <Li>Uploading data you do not have the right to process</Li>
            </ul>
          </Section>

          <Section title="4. Platform Integrity">
            <ul className="space-y-2">
              <Li>
                Attempting to probe, breach, or circumvent security or tenant-isolation controls
              </Li>
              <Li>
                Manipulating interviews, assessments, or scores — including impersonation, coached
                or fraudulent interview participation, or automated answering
              </Li>
              <Li>Reverse engineering, or using the platform to build a competing product</Li>
              <Li>Introducing malware or interfering with the operation of the service</Li>
              <Li>Excessive automated access outside documented interfaces and rate limits</Li>
            </ul>
          </Section>

          <Section title="5. Misrepresentation">
            <ul className="space-y-2">
              <Li>
                Misrepresenting AI-generated communications as human-authored where disclosure is
                required
              </Li>
              <Li>Creating fake job postings, fake employers, or fake candidate profiles</Li>
              <Li>
                Claiming certifications or compliance statuses on the basis of your use of Lexy that
                Lexy itself does not claim
              </Li>
            </ul>
          </Section>

          <Section title="6. Reporting Violations">
            <p>
              Suspected violations can be reported to{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary hover:underline">
                {CONTACT_EMAIL}
              </a>{" "}
              or through the{" "}
              <Link href="/whistleblower-policy" className="text-primary hover:underline">
                Whistleblower Policy
              </Link>
              . We investigate reports and take proportionate action, which may include suspension,
              termination, and notification of authorities where required.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}
