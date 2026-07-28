/*
 * Public security overview page.
 *
 * Linked from the homepage footer. Procurement and security-review teams
 * land here first when evaluating Lexy. Keep it factual, current, and
 * specific — vague marketing claims get flagged by buyers.
 *
 * If you change a control (encryption, auth provider, backups, etc.),
 * update this page in the same commit.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { ShieldCheck, ArrowLeft, Lock, Database, KeyRound, Mail, FileText } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const LAST_UPDATED = "16 May 2026";
const SECURITY_EMAIL = "security@l3xy.ai";

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
          {icon}
        </div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      </div>
      <div className="space-y-3 text-sm text-muted-foreground leading-relaxed pl-9">{children}</div>
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

export default function Security() {
  usePageMeta({
    title: 'Security & Compliance',
    description: 'How L3XY protects candidate and employer data: encryption, access controls, compliance, and responsible AI practices.',
    path: '/security',
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
              Trust & Security
            </span>
          </div>
          <h1 className="text-4xl font-black mb-2">Security at Lexy</h1>
          <p className="text-sm text-muted-foreground mb-12">Last updated: {LAST_UPDATED}</p>

          <p className="text-sm text-muted-foreground mb-12 leading-relaxed">
            Lexy is built for enterprise hiring teams. Candidate data is some of the most sensitive
            personal information a company handles, and we treat it that way. This page summarises
            how we protect it. If you need our DPA, subprocessor list, or evidence for a security
            questionnaire, contact us at{" "}
            <a className="text-primary underline" href={`mailto:${SECURITY_EMAIL}`}>
              {SECURITY_EMAIL}
            </a>
            .
          </p>

          <Section title="Encryption" icon={<Lock className="w-4 h-4" />}>
            <ul className="space-y-1.5">
              <Li>
                <strong>In transit:</strong> TLS 1.3 is enforced for all external traffic (web, API,
                database connections). Lexy redirects all HTTP to HTTPS at the edge.
              </Li>
              <Li>
                <strong>At rest:</strong> the primary Postgres database (Neon, US-East) is encrypted
                with AES-256. Object storage (resumes, recordings) is encrypted at rest by the
                provider.
              </Li>
              <Li>
                <strong>Secrets:</strong> environment secrets are stored in Replit's managed secret
                store; engineers do not have shell access to production secrets in plaintext.
              </Li>
            </ul>
          </Section>

          <Section title="Authentication and access" icon={<KeyRound className="w-4 h-4" />}>
            <ul className="space-y-1.5">
              <Li>
                <strong>Customer auth:</strong> email + password with rate-limited login,
                password-strength enforcement, and step-up email OTP for sensitive interview
                re-binds. SAML / SSO is on the short-term roadmap for enterprise plans.
              </Li>
              <Li>
                <strong>Role-based access:</strong> every API endpoint enforces role checks
                (platform_admin / tenant_admin / recruiter / hiring_manager / interviewer /
                candidate). Sensitive operations (billing changes, deletion fulfilment) are
                platform_admin-only.
              </Li>
              <Li>
                <strong>Internal access:</strong> production access is restricted to a small named
                set of engineers, gated by SSO + 2FA, and logged.
              </Li>
            </ul>
          </Section>

          <Section title="Data handling" icon={<Database className="w-4 h-4" />}>
            <ul className="space-y-1.5">
              <Li>
                <strong>Tenant isolation:</strong> every data row carries a tenant identifier and
                every query is scoped to the caller's tenant. Cross-tenant access is impossible via
                the API.
              </Li>
              <Li>
                <strong>Demographics decoupling:</strong> voluntary candidate self-identification
                data is stored in a separate table that the recruiter UI never joins into the
                candidate detail view. Only aggregate, k-anonymised (≥ 5 per bucket) views are
                surfaced.
              </Li>
              <Li>
                <strong>AI model providers:</strong> Lexy's inference calls run on a zero-retention
                contract with OpenAI and Anthropic — customer data is never used to train their
                models.
              </Li>
              <Li>
                <strong>Right to erasure:</strong> candidates can request deletion under IL AIVI,
                GDPR, or CCPA via their portal. Requests are honoured within statutory windows (see
                our{" "}
                <Link href="/dpa" className="text-primary underline">
                  DPA
                </Link>
                ).
              </Li>
              <Li>
                <strong>Backups:</strong> point-in-time recovery is enabled on the primary database
                with a 14-day window. Restore drills are performed quarterly.
              </Li>
            </ul>
          </Section>

          <Section title="AI governance" icon={<FileText className="w-4 h-4" />}>
            <ul className="space-y-1.5">
              <Li>
                Lexy is a high-risk AI system under EU AI Act Annex III §4. We publish an AI System
                Card describing the models in use, evaluated characteristics, known limitations, and
                human-oversight design.
              </Li>
              <Li>
                Every AI-driven recommendation is logged in an auditor-reproducible decision-log
                table (NYC Local Law 144 readiness; the auditor-facing CSV export is available on
                request).
              </Li>
              <Li>
                The interview agent is prompted to refuse questions about race, ethnicity, age,
                religion, sexual orientation, disability, gender identity, or family status.
              </Li>
              <Li>
                The recruiter, not the AI, makes the hiring decision. There is no AI-only
                auto-reject path.
              </Li>
            </ul>
          </Section>

          <Section title="Subprocessors and vendors" icon={<Database className="w-4 h-4" />}>
            <p>
              The current list of subprocessors that process customer personal data on Lexy's behalf
              is published at{" "}
              <Link href="/subprocessors" className="text-primary underline">
                /subprocessors
              </Link>
              . Customers receive 30-day advance notice of any new subprocessor and may object in
              writing per our DPA.
            </p>
          </Section>

          <Section title="Compliance" icon={<ShieldCheck className="w-4 h-4" />}>
            <ul className="space-y-1.5">
              <Li>
                <strong>SOC 2 Type 1:</strong> in progress; target attestation Q3 2026.
              </Li>
              <Li>
                <strong>GDPR / UK GDPR / CCPA / CPRA:</strong> covered by our Privacy Policy and
                DPA.
              </Li>
              <Li>
                <strong>IL AIVI Act:</strong> in-product consent capture; retention and deletion
                handled per statutory clock.
              </Li>
              <Li>
                <strong>NYC Local Law 144:</strong> Lexy provides the bias-audit data export
                customers need to commission their annual independent audit.
              </Li>
            </ul>
          </Section>

          <Section title="Reporting a vulnerability" icon={<Mail className="w-4 h-4" />}>
            <p>
              We welcome reports from security researchers. Email{" "}
              <a className="text-primary underline" href={`mailto:${SECURITY_EMAIL}`}>
                {SECURITY_EMAIL}
              </a>{" "}
              with a description and reproduction steps. We commit to acknowledge within 2 business
              days. We do not currently run a paid bug-bounty programme, but we do publicly credit
              researchers who report responsibly.
            </p>
          </Section>

          <div className="border-t border-border pt-8 mt-12 text-sm text-muted-foreground">
            <p>
              Need something for a vendor security review? Email{" "}
              <a className="text-primary underline" href={`mailto:${SECURITY_EMAIL}`}>
                {SECURITY_EMAIL}
              </a>{" "}
              and we'll respond with the relevant artefacts (DPA, subprocessor list, SOC 2 report
              when available, completed SIG Lite, etc.).
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
