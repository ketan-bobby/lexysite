/**
 * pages/portal/aedt-notice.tsx — NYC Local Law 144 candidate notice
 *
 * Under 6 RCNY § 5-300, an employer using an Automated Employment
 * Decision Tool (AEDT) for a position in NYC must give candidates a
 * notice (a) no less than 10 business days before the AEDT is used,
 * (b) describing the job qualifications and characteristics the AEDT
 * uses, (c) explaining alternative selection processes and accommodations
 * available, and (d) linking to the most recent independent bias audit
 * summary.
 *
 * This page is the customer-facing notice template. Customers using
 * Lexy for NYC roles flag the job (`jobs.aedt_enabled`) and link this
 * page in their job posting. The schema field
 * `jobs.aedt_notice_published_at` is intended to be set by the recruiter
 * UI ("Publish AEDT notice") when the customer first surfaces the
 * notice to candidates, so the auditor has a verifiable 10-business-day
 * clock — that recruiter-side publish action is a follow-up.
 */
import { ScrollText, ExternalLink } from "lucide-react";
import { BackToHome } from "@/components/layout/BackToHome";

export default function AedtNotice() {
  return (
    <div className="min-h-screen text-foreground py-12 px-6">
      <div className="max-w-3xl mx-auto">
        <BackToHome to="/portal/career" />
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <ScrollText className="w-5 h-5" />
          </div>
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
            NYC Local Law 144 — Candidate Notice
          </span>
        </div>
        <h1 className="text-3xl font-bold mb-2">Automated Employment Decision Tool — disclosure</h1>
        <p className="text-sm text-muted-foreground mb-10">
          Issued under the NYC Department of Consumer and Worker Protection rules implementing
          New York City Local Law 144 of 2021.
        </p>

        <div className="space-y-8 text-sm">
          <Section title="What is being used">
            <p>
              This employer uses Lexy ("the AEDT") to assist in screening candidates. Lexy is an AI
              system that conducts a structured video / voice interview and produces a summary of
              the conversation for the employer's recruiting team. The summary may include a score
              or ranking. A human recruiter makes the actual hiring decision.
            </p>
          </Section>

          <Section title="Job qualifications and characteristics the AEDT considers">
            <ul className="space-y-1.5">
              <Li>Role-relevant skills, knowledge, and experience as expressed in your resume.</Li>
              <Li>Role-relevant skills, knowledge, and experience as expressed in your interview answers.</Li>
              <Li>Clarity and structure of your spoken answers.</Li>
              <Li>Demonstrated reasoning on the questions asked.</Li>
            </ul>
            <p className="mt-3">
              Lexy does not use, infer, or evaluate race, ethnicity, age, religion, sexual orientation,
              disability, gender identity, accent, or facial expressions.
            </p>
          </Section>

          <Section title="Data collected">
            <ul className="space-y-1.5">
              <Li>Your resume / CV and the information you provide on your candidate profile.</Li>
              <Li>The audio (and, if you opt in, video) of the interview and a written transcript.</Li>
              <Li>Voluntary self-identification information, if you choose to provide it.</Li>
            </ul>
            <p className="mt-3">
              The data is stored by Lexy on the employer's behalf and is used solely for the
              purpose of evaluating you for this role.
            </p>
          </Section>

          <Section title="Alternative selection process and accommodations">
            <p>
              You may request an alternative selection process or a reasonable accommodation,
              including a non-AI interview, by contacting the recruiter at the employer or by
              emailing <a className="text-primary underline" href="mailto:accommodations@l3xy.ai">accommodations@l3xy.ai</a>.
              Requesting an alternative will not adversely affect your application.
            </p>
          </Section>

          <Section title="Bias audit">
            <p>
              The most recent independent bias audit summary, conducted in accordance with
              6 RCNY § 5-301, will be posted at{" "}
              <span className="text-muted-foreground italic">{"<employer publishes link>"}</span>{" "}
              and is available on request from the employer.
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              The customer using Lexy is responsible for commissioning the annual independent
              bias audit. Lexy provides the audit-ready data export needed for the auditor.
            </p>
          </Section>

          <Section title="Your rights">
            <ul className="space-y-1.5">
              <Li>To request deletion of your data under the Illinois AIVI Act (within 30 days),
                  GDPR, or CCPA — visit <a href="/portal/deletion-request" className="text-primary underline">Request deletion</a>.</Li>
              <Li>To withdraw consent for the AI interview at any time before or during the interview.</Li>
              <Li>To receive a copy of the data the AEDT used to evaluate you, on request.</Li>
            </ul>
          </Section>

          <Section title="Questions">
            <p>
              Questions about how Lexy works, what it evaluates, or your rights under NYC Local Law
              144 can be sent to <a className="text-primary underline" href="mailto:legal@l3xy.ai">legal@l3xy.ai</a>.
              See also the Lexy AI System Card.
              <a href="https://github.com" className="inline-flex items-center gap-1 text-primary underline ml-1">
                <ExternalLink className="w-3 h-3" /> system card
              </a>
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold mb-3">{title}</h2>
      <div className="text-muted-foreground leading-relaxed space-y-2">{children}</div>
    </section>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return <li className="flex gap-2"><span className="text-primary mt-0.5 shrink-0">•</span><span>{children}</span></li>;
}
