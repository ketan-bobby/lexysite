/*
 * Terms of Service — draft, pending legal review.
 *
 * Entity: Lexy Inc. (Delaware, USA). Governing law: Delaware.
 * Contact: legal@l3xy.ai for all legal / privacy / DPA matters.
 *
 * If you change the entity, jurisdiction, or governing law here, update
 * src/pages/privacy.tsx and legal/dpa.md (and regenerate the DPA PDF).
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { FileText, ArrowLeft } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const LAST_UPDATED = "16 May 2026";
const CONTACT_EMAIL = "legal@l3xy.ai";
const ENTITY = "Lexy Inc.";

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

export default function Terms() {
  usePageMeta({
    title: 'Terms of Service',
    description: 'The terms governing use of the L3XY AI hiring platform.',
    path: '/terms',
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
          <h1 className="text-4xl font-black mb-2">Terms of Service</h1>
          <p className="text-sm text-muted-foreground mb-12">Last updated: {LAST_UPDATED}</p>

          <Section title="1. Acceptance of Terms">
            <p>
              By accessing or using the Lexy AI Platform ("the Platform"), you agree to be bound by
              these Terms of Service ("Terms"). If you do not agree to these Terms, you may not
              access or use the Platform.
            </p>
            <p>
              These Terms apply to all users of the Platform, including candidates, employers, and
              recruitment agencies. If you are accessing the Platform on behalf of a company, you
              represent that you have authority to bind that company to these Terms.
            </p>
          </Section>

          <Section title="2. Description of Service">
            <p>Lexy provides an AI-powered hiring platform that includes:</p>
            <ul className="space-y-1.5">
              <Li>AI-conducted candidate interviews via voice and text</Li>
              <Li>Automated candidate assessment and scoring</Li>
              <Li>Career profiling and personalised career insights for candidates</Li>
              <Li>Job matching and candidate sourcing tools for employers</Li>
              <Li>Recruitment workflow automation and analytics</Li>
            </ul>
          </Section>

          <Section title="3. User Accounts">
            <p>
              You are responsible for maintaining the confidentiality of your account credentials.
              You must notify us immediately of any unauthorised access to your account at{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-primary underline underline-offset-2"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
            <p>
              You must provide accurate, current, and complete information when creating an account.
              You may not create an account using a false identity or impersonate another person.
            </p>
          </Section>

          <Section title="4. Acceptable Use">
            <p>You agree not to:</p>
            <ul className="space-y-1.5">
              <Li>
                Use the Platform for any unlawful purpose or in violation of applicable employment,
                discrimination, or data protection laws
              </Li>
              <Li>Upload or transmit false, misleading, or fraudulent information</Li>
              <Li>
                Discriminate against candidates based on protected characteristics (race, color,
                religion, sex, sexual orientation, gender identity, national origin, age,
                disability, veteran status, or any other protected class under federal, state, or
                local law)
              </Li>
              <Li>
                Attempt to reverse-engineer, decompile, or extract the source code of our AI models
                or platform
              </Li>
              <Li>Use automated means to scrape, crawl, or extract data from the Platform</Li>
              <Li>Resell or redistribute access to the Platform without our written consent</Li>
              <Li>Interfere with the security, integrity, or performance of the Platform</Li>
            </ul>
          </Section>

          <Section title="5. AI-Generated Content and Decisions">
            <p>
              The Platform uses artificial intelligence to generate candidate assessments, career
              insights, and hiring recommendations. You acknowledge that:
            </p>
            <ul className="space-y-1.5">
              <Li>
                AI-generated outputs are advisory in nature and should not be used as the sole basis
                for employment decisions
              </Li>
              <Li>
                Human review is required before making any final hiring decision based on AI
                assessments
              </Li>
              <Li>
                Lexy does not guarantee the accuracy or completeness of AI-generated assessments
              </Li>
              <Li>
                You remain solely responsible for all hiring decisions made using the Platform,
                including compliance with all applicable employment laws (including but not limited
                to Title VII, the ADA, the ADEA, state fair-employment laws, and emerging
                AI-in-hiring laws such as NYC Local Law 144 and the EU AI Act)
              </Li>
            </ul>
          </Section>

          <Section title="6. Data Processing">
            <p>
              By using the Platform, you agree to our{" "}
              <Link href="/privacy" className="text-primary underline underline-offset-2">
                Privacy Policy
              </Link>
              , which explains how we collect, use, and protect personal data.
            </p>
            <p>
              Employer clients who process candidate personal data through the Platform act as data
              controllers (or, for CCPA purposes, businesses). Lexy acts as a data processor (or
              service provider) on your behalf. Our{" "}
              <Link href="/dpa" className="text-primary underline underline-offset-2">
                Data Processing Agreement
              </Link>{" "}
              is incorporated into the contract between Lexy and employer clients by reference.
            </p>
          </Section>

          <Section title="7. Intellectual Property">
            <p>
              The Platform, including all software, AI models, designs, and content, is the
              exclusive property of {ENTITY} and is protected by copyright, trademark, and other
              intellectual property laws.
            </p>
            <p>
              You retain ownership of content you upload to the Platform (e.g. CVs, job
              descriptions). You grant Lexy a limited, non-exclusive, worldwide licence to use this
              content solely to provide the service. We may use fully anonymised, aggregated data to
              improve our AI models.
            </p>
          </Section>

          <Section title="8. Subscription and Payment">
            <p>
              Employer access to the Platform is provided on a subscription basis. Subscription fees
              are set out in your order form. All fees are exclusive of sales tax, VAT, and other
              applicable taxes.
            </p>
            <p>
              Candidate access is provided free of charge. We reserve the right to introduce paid
              features for candidates with reasonable notice.
            </p>
          </Section>

          <Section title="9. Disclaimers and Limitation of Liability">
            <p>
              The Platform is provided "as is" and "as available" without warranties of any kind,
              express or implied, including but not limited to warranties of merchantability,
              fitness for a particular purpose, or non-infringement.
            </p>
            <p>
              To the maximum extent permitted by law, Lexy's total liability to you for any claims
              arising out of or relating to these Terms shall not exceed the greater of (a) the fees
              you paid to Lexy in the 3 months preceding the claim, or (b) US$100.
            </p>
            <p>
              Lexy shall not be liable for any indirect, incidental, special, consequential, or
              punitive damages, including loss of profits, data, or goodwill.
            </p>
          </Section>

          <Section title="10. Termination">
            <p>
              Either party may terminate access to the Platform at any time. Upon termination, your
              right to use the Platform ceases. We will delete or return your personal data in
              accordance with our Privacy Policy and any applicable DPA.
            </p>
            <p>
              We reserve the right to suspend or terminate your access for violation of these Terms,
              with or without notice.
            </p>
          </Section>

          <Section title="11. Governing Law and Dispute Resolution">
            <p>
              These Terms are governed by the laws of the State of Delaware, United States, without
              regard to its conflict of laws principles. Any disputes arising out of or in
              connection with these Terms shall be subject to the exclusive jurisdiction of the
              state and federal courts located in New Castle County, Delaware, and you consent to
              the personal jurisdiction of those courts.
            </p>
            <p>
              We encourage you to contact us first to resolve any dispute informally at{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-primary underline underline-offset-2"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </Section>

          <Section title="12. Changes to These Terms">
            <p>
              We may update these Terms from time to time. We will notify registered users of
              material changes by email or prominent notice on the Platform at least 30 days before
              they take effect. Continued use of the Platform after that date constitutes
              acceptance.
            </p>
          </Section>

          <Section title="13. Contact">
            <div className="bg-muted/30 border border-border rounded-xl p-5 space-y-1">
              <p>
                <strong className="text-foreground">{ENTITY}</strong> — a Delaware corporation
              </p>
              <p>
                Legal enquiries:{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-primary underline underline-offset-2"
                >
                  {CONTACT_EMAIL}
                </a>
              </p>
            </div>
          </Section>
        </div>
      </main>

      <footer className="border-t border-border/40 py-8 px-6">
        <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>© 2026 {ENTITY} All rights reserved.</p>
          <div className="flex items-center gap-4">
            <Link href="/privacy" className="hover:text-foreground transition-colors">
              Privacy Policy
            </Link>
            <Link href="/terms" className="hover:text-foreground transition-colors">
              Terms of Service
            </Link>
            <Link href="/dpa" className="hover:text-foreground transition-colors">
              DPA
            </Link>
            <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-foreground transition-colors">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
