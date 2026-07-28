/*
 * Public DPA page.
 *
 * The canonical source for the DPA text is legal/dpa.md (which is also
 * compiled into public/lexy-dpa.pdf by scripts/generate-dpa-pdf.mjs).
 * THIS PAGE MUST BE KEPT IN STRUCTURAL AND SUBSTANTIVE SYNC WITH dpa.md.
 *
 * If you edit one, edit the other in the same commit. The PDF is the
 * customer-signable artifact; this page is the public, readable mirror.
 *
 * Draft — pending legal review.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { FileText, ArrowLeft, Download } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const LAST_UPDATED = "16 May 2026";
const CONTACT_EMAIL = "legal@l3xy.ai";
const PDF_URL = `${import.meta.env.BASE_URL}lexy-dpa.pdf`;

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

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold text-foreground mb-2">{title}</h3>
      <div className="space-y-2 text-sm text-muted-foreground leading-relaxed">{children}</div>
    </div>
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

export default function Dpa() {
  usePageMeta({
    title: "Data Processing Agreement",
    description: "L3XY AI data processing agreement for employers and hiring teams.",
    path: "/dpa",
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
          <h1 className="text-4xl font-black mb-2">Data Processing Agreement</h1>
          <p className="text-sm text-muted-foreground mb-6">
            Version 1.0 — last updated: {LAST_UPDATED}
          </p>

          <div className="mb-4 flex flex-col sm:flex-row gap-3">
            <a
              href={PDF_URL}
              download="lexy-dpa.pdf"
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity"
            >
              <Download className="w-4 h-4" /> Download signable PDF
            </a>
            <a
              href={`mailto:${CONTACT_EMAIL}?subject=DPA%20countersignature%20request`}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-border bg-card text-sm font-medium hover:bg-muted transition-colors"
            >
              Request countersignature
            </a>
          </div>

          <p className="text-xs text-muted-foreground mb-12 leading-relaxed">
            The downloadable PDF above is the{" "}
            <strong className="text-foreground">controlling version</strong> of this DPA for
            execution purposes. This web page mirrors the PDF for convenience and accessibility; in
            any conflict between this page and the PDF, the PDF prevails.
          </p>

          <div className="mb-10 rounded-xl border border-border bg-muted/30 p-5 text-sm text-muted-foreground leading-relaxed">
            This DPA forms part of the Master Services Agreement, Subscription Agreement, Order
            Form, or other written or electronic agreement between Lexy Inc. and the Customer for
            the provision of the Lexy AI hiring platform (the &ldquo;
            <strong className="text-foreground">Principal Agreement</strong>&rdquo;). This DPA
            reflects the parties&rsquo; agreement with respect to the Processing of Personal Data by
            Lexy on behalf of Customer.
          </div>

          <Section title="1. Parties">
            <p>
              <strong className="text-foreground">Processor:</strong> Lexy Inc., a Delaware
              corporation (&ldquo;<strong className="text-foreground">Lexy</strong>&rdquo;), with
              notices addressed to{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-primary underline underline-offset-2"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </p>
            <p>
              <strong className="text-foreground">Controller:</strong> The customer entity
              identified in the Principal Agreement (the &ldquo;
              <strong className="text-foreground">Customer</strong>&rdquo;).
            </p>
            <p>
              Together, the &ldquo;<strong className="text-foreground">Parties</strong>&rdquo;;
              each, a &ldquo;<strong className="text-foreground">Party</strong>&rdquo;.
            </p>
          </Section>

          <Section title="2. Definitions">
            <p>
              Capitalised terms not defined here have the meanings given in the Principal Agreement
              or in the GDPR.
            </p>
            <ul className="space-y-1.5">
              <Li>
                <strong className="text-foreground">
                  &ldquo;Applicable Data Protection Law&rdquo;
                </strong>{" "}
                means all laws and regulations applicable to the Processing of Personal Data under
                this DPA, including (as applicable) the EU GDPR, the UK Data Protection Act 2018 and
                UK GDPR, the CCPA as amended by the CPRA, and other US state privacy laws.
              </Li>
              <Li>
                <strong className="text-foreground">&ldquo;Personal Data&rdquo;</strong>,{" "}
                <strong className="text-foreground">&ldquo;Processing&rdquo;</strong>,{" "}
                <strong className="text-foreground">&ldquo;Controller&rdquo;</strong>,{" "}
                <strong className="text-foreground">&ldquo;Processor&rdquo;</strong>,{" "}
                <strong className="text-foreground">&ldquo;Data Subject&rdquo;</strong>, and{" "}
                <strong className="text-foreground">&ldquo;Personal Data Breach&rdquo;</strong> have
                the meanings given in Article 4 of the GDPR.
              </Li>
              <Li>
                <strong className="text-foreground">&ldquo;Customer Personal Data&rdquo;</strong>{" "}
                means Personal Data Processed by Lexy on behalf of Customer under the Principal
                Agreement.
              </Li>
              <Li>
                <strong className="text-foreground">&ldquo;Subprocessor&rdquo;</strong> means any
                third party engaged by Lexy to Process Customer Personal Data.
              </Li>
              <Li>
                <strong className="text-foreground">
                  &ldquo;Standard Contractual Clauses&rdquo;
                </strong>{" "}
                or <strong className="text-foreground">&ldquo;SCCs&rdquo;</strong> means the
                European Commission&rsquo;s standard contractual clauses for the transfer of
                personal data to third countries (Commission Decision 2021/914), and where
                applicable the UK Addendum issued by the ICO.
              </Li>
            </ul>
          </Section>

          <Section title="3. Scope and Roles">
            <p>
              3.1. This DPA applies to all Processing of Customer Personal Data by Lexy in the
              course of providing the Lexy AI hiring platform under the Principal Agreement.
            </p>
            <p>
              3.2. The Parties acknowledge that with respect to Customer Personal Data, Customer is
              the <strong className="text-foreground">Controller</strong> (or in CCPA terms, the{" "}
              <strong className="text-foreground">Business</strong>) and Lexy is the{" "}
              <strong className="text-foreground">Processor</strong> (or{" "}
              <strong className="text-foreground">Service Provider</strong>). For CCPA purposes,
              Lexy will not &ldquo;sell&rdquo; or &ldquo;share&rdquo; Customer Personal Data and
              will not retain, use, or disclose it outside of the direct business relationship
              between Customer and Lexy or otherwise as permitted by the CCPA.
            </p>
            <p>
              3.3. Lexy may also Process certain Personal Data as an independent Controller (for
              example, account administrator contact details and usage telemetry necessary to
              operate the service). This DPA does not govern that independent Controller processing,
              which is described in Lexy&rsquo;s{" "}
              <Link href="/privacy" className="text-primary underline underline-offset-2">
                Privacy Policy
              </Link>
              .
            </p>
          </Section>

          <Section title="4. Details of Processing">
            <p>
              The subject matter, duration, nature and purpose of the Processing, the categories of
              Data Subjects and the types of Personal Data are described in{" "}
              <strong className="text-foreground">Annex A</strong> to this DPA.
            </p>
          </Section>

          <Section title="5. Customer Instructions">
            <p>
              5.1. Lexy will Process Customer Personal Data only on documented instructions from
              Customer, including with regard to international transfers, except where required to
              do so by law applicable to Lexy (in which case Lexy will inform Customer of that legal
              requirement before Processing, unless that law prohibits such notice on important
              grounds of public interest).
            </p>
            <p>
              5.2. The Principal Agreement, the Order Form, this DPA, and Customer&rsquo;s use of
              features and configurations of the Lexy platform together constitute Customer&rsquo;s
              complete and final documented instructions to Lexy. Any additional or alternative
              instructions must be agreed in writing.
            </p>
            <p>
              5.3. Lexy will inform Customer if, in its opinion, an instruction infringes Applicable
              Data Protection Law.
            </p>
          </Section>

          <Section title="6. Lexy's Obligations (GDPR Article 28(3))">
            <p>Lexy will:</p>
            <ul className="space-y-1.5">
              <Li>
                Process Customer Personal Data only on documented instructions from Customer, as set
                out in Section 5;
              </Li>
              <Li>
                ensure that personnel authorised to Process Customer Personal Data are bound by
                appropriate confidentiality undertakings;
              </Li>
              <Li>
                take all measures required pursuant to Article 32 of the GDPR (security of
                Processing), as further described in Section 9 and{" "}
                <strong className="text-foreground">Annex B</strong>;
              </Li>
              <Li>respect the conditions in Sections 7 and 8 for engaging Subprocessors;</Li>
              <Li>
                taking into account the nature of the Processing, assist Customer by appropriate
                technical and organisational measures, insofar as possible, in fulfilling
                Customer&rsquo;s obligation to respond to Data Subject requests under Chapter III of
                the GDPR;
              </Li>
              <Li>
                assist Customer in ensuring compliance with its obligations under Articles 32 to 36
                of the GDPR (security, breach notification, DPIAs, and consultation with supervisory
                authorities);
              </Li>
              <Li>
                at Customer&rsquo;s choice, delete or return all Customer Personal Data after the
                end of the provision of services, as set out in Section 13; and
              </Li>
              <Li>
                make available to Customer all information necessary to demonstrate compliance with
                this Section 6, and allow for and contribute to audits as set out in Section 12.
              </Li>
            </ul>
          </Section>

          <Section title="7. Subprocessors">
            <p>
              7.1. Customer grants Lexy a{" "}
              <strong className="text-foreground">general authorisation</strong> to engage
              Subprocessors to Process Customer Personal Data, subject to the conditions in this
              Section 7. A current list of authorised Subprocessors is set out in{" "}
              <strong className="text-foreground">Annex C</strong> and on Lexy&rsquo;s website at
              l3xy.ai/dpa.
            </p>
            <p>
              7.2. Before engaging any new Subprocessor (or replacing an existing one), Lexy will
              notify Customer at least <strong className="text-foreground">thirty (30) days</strong>{" "}
              in advance by updating Annex C and emailing the account administrator(s) on record.
              Customer may object on reasonable data-protection grounds within fifteen (15) days. If
              the Parties cannot agree on a resolution, Customer may terminate the affected portion
              of the services without penalty within a further fifteen (15) days.
            </p>
            <p>
              7.3. Lexy will impose data protection obligations on each Subprocessor substantially
              equivalent to those in this DPA.
            </p>
            <p>
              7.4. Lexy remains fully liable to Customer for the performance of each
              Subprocessor&rsquo;s obligations.
            </p>
          </Section>

          <Section title="8. International Data Transfers">
            <p>
              8.1. Lexy is established in the United States. Customer acknowledges that Lexy and its
              Subprocessors may Process Customer Personal Data in the United States and other
              jurisdictions outside the EEA, the UK, and Switzerland.
            </p>
            <p>
              8.2. Where Customer Personal Data subject to GDPR or UK GDPR is transferred from the
              EEA, UK, or Switzerland to a country without an adequacy decision, the{" "}
              <strong className="text-foreground">
                EU Standard Contractual Clauses (Module Two: Controller to Processor)
              </strong>{" "}
              are incorporated into this DPA by reference, with:
            </p>
            <ul className="space-y-1.5">
              <Li>
                Clause 7 (Docking clause): <em>included</em>.
              </Li>
              <Li>
                Clause 9 (Subprocessors): Option 2 (general written authorisation), with the 30-day
                notice period in Section 7.2.
              </Li>
              <Li>
                Clause 11 (Redress): optional independent-dispute-resolution language <em>not</em>{" "}
                included.
              </Li>
              <Li>Clause 17 (Governing law): the law of the Republic of Ireland.</Li>
              <Li>Clause 18 (Forum and jurisdiction): the courts of Ireland.</Li>
              <Li>
                Annexes I, II, III: populated by Annexes A, B, and C of this DPA respectively.
              </Li>
            </ul>
            <p>
              8.3. For transfers from the United Kingdom, the{" "}
              <strong className="text-foreground">UK International Data Transfer Addendum</strong>{" "}
              issued by the ICO is incorporated and applies to the SCCs.
            </p>
            <p>
              8.4. For transfers from Switzerland, the SCCs apply with references to GDPR and EU
              supervisory authorities construed as references to the Swiss Federal Act on Data
              Protection and the Swiss Federal Data Protection and Information Commissioner where
              applicable.
            </p>
          </Section>

          <Section title="9. Security">
            <p>
              9.1. Lexy will implement and maintain appropriate technical and organisational
              measures designed to protect Customer Personal Data against accidental or unlawful
              destruction, loss, alteration, unauthorised disclosure of, or access to, Personal
              Data. These are described in <strong className="text-foreground">Annex B</strong>.
            </p>
            <p>
              9.2. Lexy may update Annex B from time to time provided that updated measures do not
              materially decrease the overall level of protection.
            </p>
          </Section>

          <Section title="10. Personal Data Breach">
            <p>
              10.1. Lexy will notify Customer{" "}
              <strong className="text-foreground">without undue delay</strong>, and in any event
              within <strong className="text-foreground">seventy-two (72) hours</strong>, after
              becoming aware of a Personal Data Breach affecting Customer Personal Data.
            </p>
            <p>
              10.2. The notification will, at minimum and to the extent then known: describe the
              nature of the breach (categories and approximate number of Data Subjects and records
              concerned); describe the likely consequences; describe measures taken or proposed to
              mitigate it; and provide a point of contact for further information.
            </p>
            <p>
              10.3. Lexy will reasonably cooperate with Customer in its handling of the breach,
              including assisting with any required notifications to supervisory authorities and
              affected Data Subjects.
            </p>
          </Section>

          <Section title="11. Data Subject Requests">
            <p>
              11.1. Lexy will provide reasonable assistance to enable Customer to respond to
              requests from Data Subjects exercising their rights under Applicable Data Protection
              Law.
            </p>
            <p>
              11.2. If a Data Subject submits a request directly to Lexy concerning Customer
              Personal Data, Lexy will promptly forward the request to Customer and will not respond
              substantively without Customer&rsquo;s instruction, except to confirm receipt and
              identify Customer as the responsible Controller.
            </p>
          </Section>

          <Section title="12. Audits">
            <p>
              12.1. Lexy will make available to Customer all information reasonably necessary to
              demonstrate compliance with this DPA. On Customer&rsquo;s written request not more
              than <strong className="text-foreground">once per twelve (12) months</strong> (except
              where required by a supervisory authority or following a confirmed Personal Data
              Breach), Lexy will provide responses to a reasonable security questionnaire and copies
              of relevant third-party audit reports (such as SOC 2 Type II or ISO 27001
              certifications) where available.
            </p>
            <p>
              12.2. Where the information made available under Section 12.1 is insufficient to
              demonstrate compliance, Customer may, on at least thirty (30) days&rsquo; prior
              written notice and not more than once per twelve (12) months, conduct an on-site audit
              of Lexy&rsquo;s facilities and operations relevant to the Processing of Customer
              Personal Data. The audit will be conducted during normal business hours, with minimal
              disruption to Lexy&rsquo;s operations, subject to confidentiality undertakings, and at
              Customer&rsquo;s expense. Customer may use an independent third-party auditor that is
              not a competitor of Lexy and that is bound by confidentiality obligations no less
              protective than those between the Parties.
            </p>
          </Section>

          <Section title="13. Return and Deletion">
            <p>
              13.1. On termination or expiry of the Principal Agreement, Lexy will, at
              Customer&rsquo;s choice, delete or return all Customer Personal Data to Customer.
            </p>
            <p>
              13.2. Customer may export its Customer Personal Data at any time during the term using
              the export features made available by the Lexy platform.
            </p>
            <p>
              13.3. Unless Customer instructs otherwise in writing, Lexy will delete all Customer
              Personal Data within <strong className="text-foreground">ninety (90) days</strong> of
              termination, subject to Section 13.4.
            </p>
            <p>
              13.4. Lexy may retain Customer Personal Data to the extent required by applicable law,
              in encrypted backups for up to twelve (12) months pending overwrite in the ordinary
              course, or in fully anonymised form.
            </p>
          </Section>

          <Section title="14. Customer Obligations">
            <p>
              14.1. Customer warrants that it has all necessary rights to provide the Customer
              Personal Data to Lexy for the Processing contemplated by this DPA, including having
              obtained any consents and provided any notices required under Applicable Data
              Protection Law.
            </p>
            <p>
              14.2. Customer is solely responsible for the accuracy, quality, and legality of
              Customer Personal Data and the means by which Customer acquired it.
            </p>
            <p>
              14.3. Customer will configure and use the Lexy platform in a manner that complies with
              Applicable Data Protection Law.
            </p>
          </Section>

          <Section title="15. Liability">
            <p>
              The liability of each Party (and each Party&rsquo;s affiliates) arising out of or in
              connection with this DPA, whether in contract, tort, or under any other theory of
              liability, is subject to the exclusions and limitations of liability set out in the
              Principal Agreement. Nothing in this DPA limits or excludes liability that cannot
              lawfully be limited or excluded under Applicable Data Protection Law.
            </p>
          </Section>

          <Section title="16. General">
            <p>
              16.1. <strong className="text-foreground">Order of precedence.</strong> In the event
              of any conflict between this DPA and the Principal Agreement, this DPA prevails with
              respect to the subject matter of this DPA. In the event of any conflict between this
              DPA and the SCCs, the SCCs prevail.
            </p>
            <p>
              16.2. <strong className="text-foreground">Governing law.</strong> Except as otherwise
              provided in the SCCs (which are governed as set out in Section 8.2), this DPA is
              governed by the laws of the State of Delaware, United States, without regard to its
              conflict of laws principles.
            </p>
            <p>
              16.3. <strong className="text-foreground">Severability.</strong> If any provision of
              this DPA is held to be invalid or unenforceable, the remaining provisions remain in
              full force and effect.
            </p>
            <p>
              16.4.{" "}
              <strong className="text-foreground">Counterparts and electronic signature.</strong>{" "}
              This DPA may be executed in counterparts, including by electronic signature, each of
              which is an original and all of which together constitute one instrument.
            </p>
          </Section>

          <Section title="Signatures">
            <p>
              The signable version of this DPA, including this signature block, is available as a
              PDF at the top of this page.
            </p>
            <div className="overflow-x-auto rounded-xl border border-border mt-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-3 font-semibold text-foreground w-1/3">
                      &nbsp;
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-foreground">Customer</th>
                    <th className="text-left px-4 py-3 font-semibold text-foreground">Lexy Inc.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {["Signed by", "Name", "Title", "Date"].map((label) => (
                    <tr key={label}>
                      <td className="px-4 py-3 text-foreground font-medium">{label}</td>
                      <td className="px-4 py-3 text-muted-foreground/40">—</td>
                      <td className="px-4 py-3 text-muted-foreground/40">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="annex-a" title="Annex A — Details of Processing">
            <Sub title="Subject matter">
              <p>
                Provision of the Lexy AI hiring platform, comprising AI-conducted candidate
                interviews, automated candidate assessment and scoring, career profiling, job
                matching, and recruitment workflow automation.
              </p>
            </Sub>
            <Sub title="Duration">
              <p>
                For the term of the Principal Agreement, plus the limited retention period set out
                in Section 13.
              </p>
            </Sub>
            <Sub title="Nature and purpose">
              <p>
                Collection, storage, organisation, structuring, retrieval, consultation, use,
                disclosure (to authorised users within Customer&rsquo;s organisation), transmission,
                alignment, combination, restriction, erasure, and destruction of Customer Personal
                Data, in each case for the purpose of providing the Lexy platform to Customer.
              </p>
            </Sub>
            <Sub title="Categories of Data Subjects">
              <ul className="space-y-1.5">
                <Li>Candidates applying for or being assessed for roles posted by Customer;</Li>
                <Li>Customer&rsquo;s employees and authorised users who use the Lexy platform;</Li>
                <Li>
                  Other individuals whose Personal Data Customer chooses to upload to the platform
                  (e.g. employee referrals).
                </Li>
              </ul>
            </Sub>
            <Sub title="Categories of Personal Data">
              <ul className="space-y-1.5">
                <Li>Identity data: name, email, phone number;</Li>
                <Li>
                  Professional data: CV / résumé content, employment and education history, skills,
                  qualifications;
                </Li>
                <Li>
                  Interview data: audio recordings, video recordings (where enabled), text
                  transcripts, AI-generated assessments and scores;
                </Li>
                <Li>
                  Career profile data: career goals, strengths, preferences, AI-generated insights;
                </Li>
                <Li>
                  Technical data: IP address, browser type, device identifiers, session identifiers;
                </Li>
                <Li>Authentication data: hashed passwords, MFA factors, session tokens.</Li>
              </ul>
            </Sub>
            <Sub title="Special categories of Personal Data">
              <p>
                Lexy does not request special-category data and instructs Customer not to upload it.
                Incidental special-category data may appear in free-text fields (e.g. a CV
                mentioning a disability accommodation). Customer is responsible for ensuring it has
                a lawful basis under Article 9 of the GDPR for any such data.
              </p>
            </Sub>
            <Sub title="Frequency of Processing">
              <p>Continuous, for the term of the Principal Agreement.</p>
            </Sub>
          </Section>

          <Section id="annex-b" title="Annex B — Technical and Organisational Measures">
            <p>Lexy implements the following measures pursuant to Article 32 of the GDPR.</p>
            <Sub title="Encryption">
              <ul className="space-y-1.5">
                <Li>
                  Data in transit encrypted using TLS 1.2 or higher (TLS 1.3 preferred), with strong
                  cipher suites.
                </Li>
                <Li>
                  Data at rest encrypted using AES-256 (or equivalent), with keys managed by the
                  cloud provider&rsquo;s KMS.
                </Li>
              </ul>
            </Sub>
            <Sub title="Access control">
              <ul className="space-y-1.5">
                <Li>
                  Role-based access control (RBAC) limits employee access on a need-to-know basis.
                </Li>
                <Li>
                  Multi-factor authentication required for all employee and administrator access to
                  production systems.
                </Li>
                <Li>All access to production systems is logged and reviewed.</Li>
                <Li>
                  Customer user access governed by per-tenant authentication with tenant-scoped
                  row-level security on the most sensitive resources.
                </Li>
              </ul>
            </Sub>
            <Sub title="Network security">
              <ul className="space-y-1.5">
                <Li>
                  Production systems deployed in private network segments behind a managed load
                  balancer.
                </Li>
                <Li>
                  Public endpoints protected by HTTPS-only, CORS allowlisting, CSRF protection on
                  cookie-authenticated state-changing routes, and per-IP and per-resource rate
                  limiting on authentication-sensitive endpoints.
                </Li>
              </ul>
            </Sub>
            <Sub title="Application security">
              <ul className="space-y-1.5">
                <Li>Passwords hashed using bcrypt with an appropriate work factor.</Li>
                <Li>Input validated using strict schema-based validation.</Li>
                <Li>
                  Dependencies monitored for known vulnerabilities and patched on a regular cadence.
                </Li>
                <Li>Static analysis and code review performed before changes reach production.</Li>
              </ul>
            </Sub>
            <Sub title="Operational security">
              <ul className="space-y-1.5">
                <Li>Production deployments version-controlled and auditable.</Li>
                <Li>
                  Backups taken daily, retained for at least thirty (30) days, encrypted at rest.
                </Li>
                <Li>
                  Logs retained for a minimum of ninety (90) days and reviewed for security events.
                </Li>
              </ul>
            </Sub>
            <Sub title="Incident response">
              <p>
                Lexy maintains a documented incident-response plan with defined roles, escalation
                paths, and notification timelines that support the 72-hour Personal Data Breach
                notification commitment in Section 10.
              </p>
            </Sub>
            <Sub title="Personnel">
              <ul className="space-y-1.5">
                <Li>All employees bound by written confidentiality obligations.</Li>
                <Li>Security and privacy training on hire and annually thereafter.</Li>
                <Li>Access revoked promptly on termination.</Li>
              </ul>
            </Sub>
            <Sub title="Subprocessor management">
              <ul className="space-y-1.5">
                <Li>
                  Subprocessors assessed for security and privacy posture before engagement and
                  reviewed periodically thereafter.
                </Li>
                <Li>
                  Subprocessors bound by written data protection terms substantially equivalent to
                  those in this DPA.
                </Li>
              </ul>
            </Sub>
          </Section>

          <Section id="annex-c" title="Annex C — Authorised Subprocessors">
            <p>
              The current list of authorised Subprocessors is set out below. The list is also
              maintained at l3xy.ai/dpa and will be updated in accordance with Section 7.2.
            </p>
            <div className="overflow-x-auto rounded-xl border border-border mt-2">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-3 font-semibold text-foreground">
                      Subprocessor
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-foreground">Purpose</th>
                    <th className="text-left px-4 py-3 font-semibold text-foreground">Location</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    [
                      "OpenAI, L.L.C.",
                      "LLM inference for resume parsing, interview generation, and candidate scoring (zero-retention API contract; no training on Customer Data)",
                      "United States",
                    ],
                    [
                      "Anthropic PBC",
                      "LLM inference for long-context interview review and bias-audit reasoning (no training on Customer Data)",
                      "United States",
                    ],
                    [
                      "Neon (Databricks Inc.)",
                      "Primary Postgres database hosting (AES-256 at rest, TLS 1.3 in transit)",
                      "United States (us-east-2)",
                    ],
                    [
                      "Replit, Inc.",
                      "Application hosting, build, and deployment platform",
                      "United States",
                    ],
                    ["Cloudflare, Inc.", "CDN, DNS, and DDoS protection", "Global edge"],
                    [
                      "Resend, Inc.",
                      "Transactional email delivery (invites, password resets, recruiter digests)",
                      "United States",
                    ],
                    [
                      "Stripe, Inc.",
                      "Payment processing for the optional self-serve checkout (billing data only; not Candidate data)",
                      "United States",
                    ],
                    [
                      "Sentry (Functional Software Inc.)",
                      "Application error monitoring (PII-scrubbing rules applied before ingestion)",
                      "United States",
                    ],
                  ].map(([name, purpose, loc]) => (
                    <tr key={name}>
                      <td className="px-4 py-3 text-foreground font-medium">{name}</td>
                      <td className="px-4 py-3">{purpose}</td>
                      <td className="px-4 py-3 text-foreground/70">{loc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="Contact">
            <div className="bg-muted/30 border border-border rounded-xl p-5 space-y-1">
              <p>
                <strong className="text-foreground">Lexy Inc.</strong> — a Delaware corporation
              </p>
              <p>
                DPA enquiries and countersignature:{" "}
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
          <p>© 2026 Lexy Inc. All rights reserved.</p>
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
            <Link href="/security" className="hover:text-foreground transition-colors">
              Security
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
