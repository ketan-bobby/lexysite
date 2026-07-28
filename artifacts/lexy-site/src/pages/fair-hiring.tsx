/*
 * Fair Hiring by Design page.
 *
 * Describes the product features designed to support fairer, more consistent
 * evaluations. Never claim to eliminate bias — always hedge.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import {
  Scale,
  ArrowLeft,
  EyeOff,
  Ban,
  ListChecks,
  Ruler,
  UserCheck,
  Activity,
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

export default function FairHiring() {
  usePageMeta({
    title: "Fair Hiring by Design",
    description:
      "Blind evaluation, standardized questions, consistent rubrics, human oversight, and adverse-impact monitoring designed to support fairer, more consistent evaluations.",
    path: "/fair-hiring",
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
              <Scale className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Fair Hiring
            </span>
          </div>
          <h1 className="text-4xl font-black mb-4">Fair Hiring by Design</h1>

          <p className="text-sm text-muted-foreground mb-12 leading-relaxed">
            No process can promise perfectly fair outcomes, but structure helps. L3XY is designed to
            support fairer and more consistent evaluations by focusing on demonstrated evidence,
            standardizing how candidates are assessed, keeping humans accountable, and giving teams
            tools to monitor outcomes over time.
          </p>

          <Section title="Blind evaluation" icon={<EyeOff className="w-4 h-4" />}>
            <p>
              Personally identifying information is redacted before AI scoring so evaluations focus
              on what a candidate demonstrated rather than who they are. This blind-evaluation
              approach is designed to support fairer and more consistent evaluations.
            </p>
          </Section>

          <Section
            title="Protected characteristics excluded from every AI prompt"
            icon={<Ban className="w-4 h-4" />}
          >
            <p>
              A fairness directive is included in every AI prompt instructing the system to exclude
              protected characteristics such as race, ethnicity, age, religion, sexual orientation,
              disability, gender identity, and family status. This is built to help keep evaluations
              tied to role-relevant evidence.
            </p>
          </Section>

          <Section
            title="Standardized interview questions"
            icon={<ListChecks className="w-4 h-4" />}
          >
            <p>
              Candidates for the same role are asked comparable, structured questions. Standardizing
              questions is designed to reduce variability between interviews and support more
              consistent comparisons.
            </p>
          </Section>

          <Section title="Consistent scoring rubrics" icon={<Ruler className="w-4 h-4" />}>
            <p>
              Evidence is evaluated against consistent scoring rubrics tied to role competencies.
              Applying the same rubric across candidates is designed to support fairer and more
              consistent evaluations.
            </p>
          </Section>

          <Section
            title="Human oversight of every adverse decision"
            icon={<UserCheck className="w-4 h-4" />}
          >
            <p>
              L3XY is designed to support human decision-making. The AI cannot write final
              decisions, and adverse decisions require a recruiter attestation before they can be
              recorded — so a person is always accountable for the outcome.
            </p>
          </Section>

          <Section
            title="Adverse impact monitoring (4/5ths analysis)"
            icon={<Activity className="w-4 h-4" />}
          >
            <p>
              L3XY provides adverse-impact (4/5ths) monitoring analytics designed to help
              organizations observe selection outcomes across groups over time. This analysis draws
              on voluntary, self-reported demographic data that is decoupled from candidate
              profiles, and is built to help teams identify patterns worth reviewing.
            </p>
          </Section>

          <div className="border-t border-border pt-8 mt-12 text-sm text-muted-foreground">
            <ul className="space-y-1.5">
              <Li>
                Learn how the full evaluation flow works on our{" "}
                <Link href="/ai-transparency" className="text-primary underline">
                  AI Transparency
                </Link>{" "}
                page.
              </Li>
              <Li>
                See the frameworks we are designed to support on our{" "}
                <Link href="/compliance" className="text-primary underline">
                  Compliance
                </Link>{" "}
                page.
              </Li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
