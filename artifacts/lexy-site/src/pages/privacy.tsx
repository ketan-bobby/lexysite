/*
 * Privacy Policy — draft, pending legal review.
 *
 * Entity: Lexy Inc. (Delaware, USA). Single contact mailbox for privacy,
 * DSAR, and DPO-equivalent requests: legal@l3xy.ai. GDPR (EU/UK candidates),
 * CCPA / CPRA (California residents), and US state privacy laws covered.
 *
 * If you change the entity or contact mailbox, update src/pages/terms.tsx
 * and legal/dpa.md (and regenerate the DPA PDF).
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const LAST_UPDATED = "16 May 2026";
const CONTROLLER = "Lexy Inc.";
const CONTACT_EMAIL = "legal@l3xy.ai";
const DPO_EMAIL = "legal@l3xy.ai";

function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mb-10">
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

export default function Privacy() {
  usePageMeta({
    title: 'Privacy Policy',
    description: 'L3XY AI privacy policy — how we collect, use, and protect personal data across our hiring platform.',
    path: '/privacy',
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
              <ShieldCheck className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Legal
            </span>
          </div>
          <h1 className="text-4xl font-black mb-2">Privacy Policy</h1>
          <p className="text-sm text-muted-foreground mb-12">Last updated: {LAST_UPDATED}</p>

          <Section title="1. Who We Are">
            <p>
              <strong className="text-foreground">{CONTROLLER}</strong> ("Lexy", "we", "us", or
              "our") is a Delaware corporation and the data controller (or, under the CCPA, the
              business) responsible for your personal data when you use the Lexy AI Hiring Platform
              and the career portal at l3xy.ai ("the Platform").
            </p>
            <p>
              For privacy enquiries, data-subject access requests (DSARs), data-deletion requests,
              and any matter that would otherwise be directed to a Data Protection Officer, contact
              us at{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-primary underline underline-offset-2"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
            <p>
              Where employers (our business customers) upload or generate personal data about
              candidates through the Platform, those employers act as the controller (or business)
              of that data and Lexy acts as their processor (or service provider). Candidates should
              direct requests concerning data uploaded by a specific employer to that employer in
              the first instance; we will assist as required by law.
            </p>
          </Section>

          <Section title="2. Personal Data We Collect">
            <p>
              Depending on how you use the Platform, we may collect the following categories of
              personal data:
            </p>
            <p className="font-medium text-foreground mt-2">For Candidates:</p>
            <ul className="space-y-1.5">
              <Li>Identity data: first name, last name, email address, phone number</Li>
              <Li>
                Professional data: CV/résumé content, employment history, qualifications, skills,
                languages
              </Li>
              <Li>
                Interview data: audio/video recordings, text transcripts, AI-generated assessments
              </Li>
              <Li>
                Career profile data: career goals, strengths, preferences, and insights generated by
                our AI
              </Li>
              <Li>
                Technical data: IP address, browser type, device identifiers, session identifiers
              </Li>
            </ul>
            <p className="font-medium text-foreground mt-2">For Employers / Business Users:</p>
            <ul className="space-y-1.5">
              <Li>Identity data: name, job title, work email address, phone number</Li>
              <Li>Company data: company name, industry, size, hiring requirements</Li>
              <Li>Usage data: job postings, candidate interactions, platform analytics</Li>
              <Li>
                Billing data: invoicing details (payment card data is processed by our payment
                provider and not stored by us)
              </Li>
            </ul>
          </Section>

          <Section title="3. How We Use Your Personal Data">
            <p>
              We process your personal data for the following purposes and on the following legal
              bases:
            </p>
            <div className="overflow-x-auto rounded-xl border border-border mt-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-3 font-semibold text-foreground">Purpose</th>
                    <th className="text-left px-4 py-3 font-semibold text-foreground">
                      Legal Basis (GDPR Art. 6)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    ["Create and manage your account", "Performance of a contract (6(1)(b))"],
                    [
                      "Conduct AI-powered career interviews and generate career insights",
                      "Performance of a contract (6(1)(b)) / Consent (6(1)(a))",
                    ],
                    [
                      "Match candidates to job opportunities",
                      "Legitimate interests (6(1)(f)) — improving hiring outcomes",
                    ],
                    [
                      "Send transactional emails (account confirmations, interview links)",
                      "Performance of a contract (6(1)(b))",
                    ],
                    [
                      "Provide employer analytics and reporting",
                      "Performance of a contract (6(1)(b))",
                    ],
                    [
                      "Improve and train our AI models (anonymised data only)",
                      "Legitimate interests (6(1)(f)) — with opt-out available",
                    ],
                    ["Comply with legal obligations", "Legal obligation (6(1)(c))"],
                    ["Send marketing communications (employers only, opt-in)", "Consent (6(1)(a))"],
                    ["Fraud prevention and platform security", "Legitimate interests (6(1)(f))"],
                  ].map(([purpose, basis]) => (
                    <tr key={purpose}>
                      <td className="px-4 py-3">{purpose}</td>
                      <td className="px-4 py-3 text-foreground/70">{basis}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="4. AI Processing and Automated Decision-Making">
            <p>
              Lexy uses artificial intelligence to conduct interviews, generate career assessments,
              score candidates, and make hiring recommendations. Pursuant to Article 22 of the GDPR,
              you have the right{" "}
              <strong className="text-foreground">
                not to be subject to a decision based solely on automated processing
              </strong>{" "}
              that produces legal or similarly significant effects concerning you.
            </p>
            <p>
              All AI-generated assessments and hiring recommendations are reviewed by human
              recruiters before any employment decision is made. You may request a human review of
              any AI-generated assessment at any time by contacting us at{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-primary underline underline-offset-2"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </Section>

          <Section title="5. Data Sharing and Recipients">
            <p>We share personal data only with the following categories of recipients:</p>
            <ul className="space-y-1.5">
              <Li>
                <strong className="text-foreground">Employer clients:</strong> Candidate profiles
                and assessments are shared with the employer that initiated the hiring process, or
                the employer whose job you applied to.
              </Li>
              <Li>
                <strong className="text-foreground">AI service providers:</strong> OpenAI and
                Microsoft Azure are used to power interview conversations, speech recognition, and
                career insights. These providers process data on our behalf under data processing
                agreements.
              </Li>
              <Li>
                <strong className="text-foreground">Cloud infrastructure:</strong> Our servers are
                hosted on Amazon Web Services in the United States by default, with optional EU / UK
                regional residency available to business customers on request as set out in Section
                6.
              </Li>
              <Li>
                <strong className="text-foreground">Analytics providers:</strong> Aggregated,
                anonymised usage data only — with your cookie consent.
              </Li>
              <Li>
                <strong className="text-foreground">Legal and regulatory bodies:</strong> Where
                required by law or court order.
              </Li>
            </ul>
            <p>We do not sell your personal data to third parties.</p>
          </Section>

          <Section title="6. International Data Transfers">
            <p>
              Lexy is established in the United States and primarily processes personal data on
              cloud infrastructure located in the United States. Where personal data subject to the
              GDPR or UK GDPR is transferred from the European Economic Area, the United Kingdom, or
              Switzerland to the United States or another country that has not received an adequacy
              decision, we rely on the European Commission's Standard Contractual Clauses (Module
              Two: Controller to Processor) and, for UK transfers, the UK International Data
              Transfer Addendum issued by the ICO. We conduct transfer impact assessments where
              required.
            </p>
            <p>
              Employers with EU / UK / Swiss data-residency requirements can request that Customer
              Personal Data be processed in a specific cloud region; we will accommodate such
              requests where commercially feasible under the Order Form.
            </p>
          </Section>

          <Section title="7. Data Retention">
            <ul className="space-y-1.5">
              <Li>
                <strong className="text-foreground">Candidate accounts:</strong> Retained for 3
                years from your last active session, then deleted or anonymised.
              </Li>
              <Li>
                <strong className="text-foreground">Interview recordings:</strong> Retained for 12
                months unless the employer requests earlier deletion.
              </Li>
              <Li>
                <strong className="text-foreground">Employer accounts:</strong> Retained for the
                duration of the contract plus 7 years for legal/tax purposes.
              </Li>
              <Li>
                <strong className="text-foreground">Demo request data:</strong> Retained for 12
                months from submission.
              </Li>
              <Li>
                <strong className="text-foreground">Marketing data:</strong> Until you withdraw
                consent or unsubscribe.
              </Li>
            </ul>
          </Section>

          <Section id="cookies" title="8. Cookies and Tracking">
            <p>We use the following types of cookies:</p>
            <ul className="space-y-1.5">
              <Li>
                <strong className="text-foreground">Strictly necessary cookies:</strong> Required
                for the Platform to function (session management, authentication, security). These
                cannot be disabled.
              </Li>
              <Li>
                <strong className="text-foreground">Analytics cookies:</strong> Help us understand
                how visitors use our site (e.g. page views, bounce rate). Only set with your
                consent.
              </Li>
              <Li>
                <strong className="text-foreground">Preference cookies:</strong> Remember your
                settings (e.g. language, cookie consent choice).
              </Li>
            </ul>
            <p>
              You can withdraw cookie consent at any time by clearing your browser's local storage
              or contacting us.
            </p>
          </Section>

          <Section title="9. Your Rights Under GDPR">
            <p>As a data subject under the GDPR, you have the following rights:</p>
            <ul className="space-y-1.5">
              <Li>
                <strong className="text-foreground">Right of access (Art. 15):</strong> Request a
                copy of the personal data we hold about you.
              </Li>
              <Li>
                <strong className="text-foreground">Right to rectification (Art. 16):</strong> Ask
                us to correct inaccurate or incomplete data.
              </Li>
              <Li>
                <strong className="text-foreground">Right to erasure (Art. 17):</strong> Request
                deletion of your personal data ("right to be forgotten").
              </Li>
              <Li>
                <strong className="text-foreground">Right to restriction (Art. 18):</strong> Ask us
                to restrict processing of your data in certain circumstances.
              </Li>
              <Li>
                <strong className="text-foreground">Right to data portability (Art. 20):</strong>{" "}
                Receive your data in a structured, machine-readable format.
              </Li>
              <Li>
                <strong className="text-foreground">Right to object (Art. 21):</strong> Object to
                processing based on legitimate interests or for direct marketing.
              </Li>
              <Li>
                <strong className="text-foreground">Right to withdraw consent:</strong> Where
                processing is based on consent, withdraw it at any time without affecting prior
                lawful processing.
              </Li>
              <Li>
                <strong className="text-foreground">
                  Right not to be subject to automated decisions (Art. 22):
                </strong>{" "}
                Request human review of AI-generated decisions.
              </Li>
            </ul>
            <p>
              To exercise any of these rights, contact us at{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-primary underline underline-offset-2"
              >
                {CONTACT_EMAIL}
              </a>
              . We will respond within 30 days. You also have the right to lodge a complaint with
              your local supervisory authority — in the EU, your national Data Protection Authority;
              in the UK, the Information Commissioner's Office (ICO).
            </p>
          </Section>

          <Section title="9a. Your Rights Under US State Privacy Laws (CCPA / CPRA and others)">
            <p>
              If you are a California resident, the California Consumer Privacy Act ("CCPA"), as
              amended by the California Privacy Rights Act ("CPRA"), gives you the following rights
              with respect to personal information we collect as a business:
            </p>
            <ul className="space-y-1.5">
              <Li>
                <strong className="text-foreground">Right to know:</strong> request the categories
                and specific pieces of personal information we have collected about you, the
                sources, the purposes, and the categories of third parties with whom we share it.
              </Li>
              <Li>
                <strong className="text-foreground">Right to delete:</strong> request deletion of
                personal information we have collected about you, subject to certain legal
                exceptions.
              </Li>
              <Li>
                <strong className="text-foreground">Right to correct:</strong> request correction of
                inaccurate personal information.
              </Li>
              <Li>
                <strong className="text-foreground">
                  Right to limit use of sensitive personal information:
                </strong>{" "}
                direct us to limit our use and disclosure of sensitive personal information to those
                purposes permitted by the CCPA.
              </Li>
              <Li>
                <strong className="text-foreground">Right to opt out of sale or sharing:</strong> we{" "}
                <strong className="text-foreground">do not sell or share</strong> your personal
                information for cross-context behavioural advertising, and we have not done so in
                the preceding twelve (12) months.
              </Li>
              <Li>
                <strong className="text-foreground">Right to non-discrimination:</strong> we will
                not discriminate against you for exercising any of these rights.
              </Li>
            </ul>
            <p>
              To exercise any of these rights, contact us at{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-primary underline underline-offset-2"
              >
                {CONTACT_EMAIL}
              </a>
              . We will verify your request before responding. You may also designate an authorised
              agent to make a request on your behalf, subject to verification.
            </p>
            <p>
              Residents of other US states with comprehensive privacy laws (including Colorado,
              Connecticut, Utah, Virginia, Oregon, Texas, Montana, and others) have similar rights
              of access, correction, deletion, portability, and opt-out of targeted advertising or
              profiling that produces legal or similarly significant effects. The same contact
              address applies. We respond within the timeframe required by the applicable state law.
            </p>
          </Section>

          <Section title="10. Data Security">
            <p>
              We implement appropriate technical and organisational measures to protect your
              personal data, including:
            </p>
            <ul className="space-y-1.5">
              <Li>Encryption of data in transit (TLS 1.3) and at rest (AES-256)</Li>
              <Li>bcrypt hashing of all passwords</Li>
              <Li>Role-based access controls (RBAC) limiting internal access to personal data</Li>
              <Li>Regular security assessments and penetration testing</Li>
              <Li>Incident response procedures with 72-hour breach notification capability</Li>
            </ul>
          </Section>

          <Section title="11. Children's Privacy">
            <p>
              The Platform is not directed at children under 16 years of age. We do not knowingly
              collect personal data from children under 16. If you believe we have inadvertently
              collected such data, please contact us immediately.
            </p>
          </Section>

          <Section title="12. Changes to This Policy">
            <p>
              We may update this Privacy Policy from time to time. We will notify you of material
              changes via email (for registered users) or a prominent notice on the Platform at
              least 30 days before the changes take effect. Your continued use of the Platform after
              that date constitutes acceptance.
            </p>
          </Section>

          <Section title="13. Contact Us">
            <p>For any privacy-related questions, requests, or complaints:</p>
            <div className="bg-muted/30 border border-border rounded-xl p-5 mt-2 space-y-1">
              <p>
                <strong className="text-foreground">{CONTROLLER}</strong> — a Delaware corporation
              </p>
              <p>
                Privacy, DSAR, and data-deletion requests:{" "}
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
          <p>© 2026 {CONTROLLER} All rights reserved.</p>
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
