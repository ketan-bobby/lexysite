/*
 * Public Whistleblower Policy page. Draft — pending legal review.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { Megaphone, ArrowLeft } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const LAST_UPDATED = "24 July 2026";
const REPORT_EMAIL = "ethics@l3xy.ai";
const LEGAL_EMAIL = "legal@l3xy.ai";

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

export default function WhistleblowerPolicy() {
  usePageMeta({
    title: "Whistleblower Policy",
    description:
      "How to report suspected misconduct relating to L3XY AI, and the protections available to reporters.",
    path: "/whistleblower-policy",
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
              <Megaphone className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Trust &amp; Legal
            </span>
          </div>
          <h1 className="text-4xl font-black mb-2">Whistleblower Policy</h1>
          <p className="text-sm text-muted-foreground mb-12">Last updated: {LAST_UPDATED}</p>

          <Section title="1. Purpose">
            <p>
              Lexy is committed to lawful and ethical conduct. This policy explains how employees,
              contractors, customers, candidates, and other third parties can report suspected
              misconduct in good faith, and the protections available to those who do.
            </p>
          </Section>

          <Section title="2. What to Report">
            <ul className="space-y-2">
              <Li>
                Suspected violations of law or regulation, including employment and
                anti-discrimination laws
              </Li>
              <Li>Misuse of candidate personal data or breaches of privacy commitments</Li>
              <Li>
                Manipulation or misuse of AI evaluation systems, including attempts to bias outcomes
              </Li>
              <Li>Fraud, bribery, corruption, or financial irregularities</Li>
              <Li>Serious safety, security, or ethical concerns relating to the platform</Li>
            </ul>
          </Section>

          <Section title="3. How to Report">
            <p>
              Reports can be made by email to{" "}
              <a href={`mailto:${REPORT_EMAIL}`} className="text-primary hover:underline">
                {REPORT_EMAIL}
              </a>
              . Reports may be made anonymously where local law permits. Please include enough
              detail for us to investigate: what happened, when, who was involved, and any
              supporting evidence.
            </p>
          </Section>

          <Section title="4. No Retaliation">
            <p>
              We prohibit retaliation of any kind against anyone who reports a concern in good faith
              or participates in an investigation. This includes dismissal, demotion, harassment, or
              any other adverse treatment. Retaliation is itself a violation of this policy and
              grounds for disciplinary action.
            </p>
          </Section>

          <Section title="5. Confidentiality">
            <p>
              We treat reports confidentially to the fullest extent possible consistent with a fair
              and thorough investigation and applicable law. Identities of reporters are disclosed
              only on a need-to-know basis.
            </p>
          </Section>

          <Section title="6. Investigation Process">
            <p>
              Reports are reviewed promptly by personnel independent of the subject matter where
              practicable. Where a report is substantiated, we take appropriate corrective action.
              Reporters will receive acknowledgement of receipt and, where appropriate and lawful,
              information about the outcome.
            </p>
          </Section>

          <Section title="7. External Reporting">
            <p>
              Nothing in this policy limits any person's right to report suspected violations to a
              government agency or regulator, or to make disclosures protected under applicable
              whistleblower laws (including the EU Whistleblower Directive where it applies).
            </p>
          </Section>

          <Section title="8. Contact">
            <p>
              Questions about this policy:{" "}
              <a href={`mailto:${LEGAL_EMAIL}`} className="text-primary hover:underline">
                {LEGAL_EMAIL}
              </a>
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}
