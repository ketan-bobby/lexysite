/*
 * Responsible AI overview page.
 *
 * Describes the principles behind how L3XY uses AI in hiring. Keep claims
 * hedged and grounded in real implemented features.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import {
  Brain,
  ArrowLeft,
  Users,
  FileText,
  Scale,
  ClipboardCheck,
  Activity,
  UserCheck,
} from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

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

export default function ResponsibleAI() {
  usePageMeta({
    title: "Responsible AI",
    description:
      "How L3XY is designed so AI assists evaluations while humans make the hiring decisions — with evidence, oversight, and monitoring.",
    path: "/responsible-ai",
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
              <Brain className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Responsible AI
            </span>
          </div>
          <h1 className="text-4xl font-black mb-4 leading-tight">
            AI That Assists Decisions. Humans Make Them.
          </h1>

          <p className="text-sm text-muted-foreground mb-12 leading-relaxed">
            L3XY is built to help organizations run more structured, consistent, and reviewable
            hiring processes. AI does the heavy lifting of gathering and organizing evidence — but
            people stay in control of every outcome. These are the principles that shape how our
            product is designed.
          </p>

          <Section title="AI recommends, humans decide" icon={<Users className="w-4 h-4" />}>
            <p>
              L3XY is designed to support human decision-making, not replace it. The AI can surface
              recommendations and organize evidence, but it cannot write a final hiring decision.
              Adverse decisions require a recruiter attestation before they can be recorded, so a
              person is always accountable for the outcome.
            </p>
          </Section>

          <Section
            title="Every recommendation is backed by evidence"
            icon={<FileText className="w-4 h-4" />}
          >
            <p>
              Recommendations are built to be explainable. Each one is tied to structured evidence
              drawn from the interview, so reviewers can see why a result was produced rather than
              trusting an opaque score. This is designed to help recruiters review, question, and
              override the AI where their judgment differs.
            </p>
          </Section>

          <Section
            title="Protected characteristics are excluded by design"
            icon={<Scale className="w-4 h-4" />}
          >
            <p>
              Before scoring, personally identifying information is redacted so evaluations focus on
              demonstrated evidence — an approach commonly called blind evaluation. A fairness
              directive is included in every AI prompt instructing the system to exclude protected
              characteristics such as race, age, gender, religion, disability, and related
              attributes. Together these are designed to support fairer and more consistent
              evaluations.
            </p>
          </Section>

          <Section
            title="Every decision can be audited"
            icon={<ClipboardCheck className="w-4 h-4" />}
          >
            <p>
              Recommendations and decisions are recorded in an audit trail designed to support
              traceability and review. This provides tools to reconstruct how a candidate progressed
              through the process and who made each decision. Retention schedulers manage logs and
              speech data over time in line with configured policies.
            </p>
          </Section>

          <Section
            title="Fairness is continuously monitored"
            icon={<Activity className="w-4 h-4" />}
          >
            <p>
              L3XY provides adverse-impact (4/5ths) monitoring analytics designed to help
              organizations observe selection outcomes across groups over time. Demographic data
              used for this analysis is voluntary, self-reported, and decoupled from candidate
              profiles. These tools are built to help teams identify patterns worth reviewing — not
              to replace human judgment.
            </p>
          </Section>

          <Section
            title="Candidates control their own data"
            icon={<UserCheck className="w-4 h-4" />}
          >
            <p>
              Candidates provide versioned consent that is designed to fail closed before interviews
              and can be revoked at any time, including mid-interview. L3XY provides tools for
              candidates to export their data and to request deletion, which triggers an erasure
              cascade across associated records. Learn more on our{" "}
              <Link href="/candidate-rights" className="text-primary underline">
                Candidate Rights
              </Link>{" "}
              page.
            </p>
          </Section>

          <div className="border-t border-border pt-8 mt-12 text-sm text-muted-foreground">
            <ul className="space-y-1.5">
              <Li>
                Explore the{" "}
                <Link href="/ai-transparency" className="text-primary underline">
                  AI Transparency
                </Link>{" "}
                flow to see how evaluations work end to end.
              </Li>
              <Li>
                Read the{" "}
                <Link href="/trust/ai" className="text-primary underline">
                  AI System Card
                </Link>{" "}
                for model-level details and known limitations.
              </Li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
