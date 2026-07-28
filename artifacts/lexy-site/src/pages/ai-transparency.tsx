/*
 * AI Transparency page.
 *
 * Walks through how L3XY evaluates candidates, step by step. Keep it factual
 * and hedged, and always reinforce that humans make the final decisions.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { Eye, ArrowLeft, ShieldAlert, Cpu } from "lucide-react";
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

const steps = [
  {
    n: 1,
    title: "Candidate provides consent",
    body: "Before any AI-assisted interview begins, the candidate reviews and provides versioned consent. Consent is designed to fail closed — if it is missing or withdrawn, the interview does not proceed. Candidates can revoke consent at any time, including mid-interview.",
  },
  {
    n: 2,
    title: "AI conducts a structured interview",
    body: "The interview follows a standardized structure so candidates for the same role are asked comparable questions. A fairness directive is included in every AI prompt instructing the system to exclude protected characteristics.",
  },
  {
    n: 3,
    title: "Interview becomes structured evidence",
    body: "Responses are organized into structured evidence tied to the role's competencies. Personally identifying information is redacted before scoring, an approach commonly called blind evaluation.",
  },
  {
    n: 4,
    title: "Evidence is scored consistently",
    body: "The evidence is evaluated against consistent scoring rubrics, which is designed to support fairer and more consistent comparisons between candidates.",
  },
  {
    n: 5,
    title: "Recruiters review recommendations",
    body: "Recruiters review the AI's recommendations alongside the underlying evidence. Recommendations are built to be explainable so reviewers can question or override them using their own judgment.",
  },
  {
    n: 6,
    title: "Humans make hiring decisions",
    body: "People make the final call. Adverse decisions require a recruiter attestation before they are recorded, and every recommendation and decision is captured in an audit trail.",
  },
];

export default function AITransparency() {
  usePageMeta({
    title: "AI Transparency",
    description:
      "A step-by-step look at how L3XY evaluates candidates, from consent through to human hiring decisions.",
    path: "/ai-transparency",
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
              <Eye className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              AI Transparency
            </span>
          </div>
          <h1 className="text-4xl font-black mb-4">AI Transparency</h1>

          <p className="text-sm text-muted-foreground mb-12 leading-relaxed">
            We believe candidates and employers should understand how AI is used in the hiring
            process. Here is how L3XY evaluates candidates, from the first consent screen to the
            final human decision.
          </p>

          <Section title="How L3XY evaluates candidates" icon={<Cpu className="w-4 h-4" />}>
            <ol className="space-y-4 not-prose">
              {steps.map((step) => (
                <li key={step.n} className="flex gap-4">
                  <div className="w-7 h-7 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-primary text-sm font-semibold">
                    {step.n}
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-foreground mb-1">{step.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          <div className="rounded-2xl border border-primary/40 bg-primary/5 p-5 my-10">
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                <ShieldAlert className="w-4 h-4" />
              </div>
              <p className="text-sm text-foreground leading-relaxed">
                L3XY never automatically rejects candidates. Final hiring decisions always remain
                with your organization.
              </p>
            </div>
          </div>

          <div className="border-t border-border pt-8 mt-12 text-sm text-muted-foreground">
            <ul className="space-y-1.5">
              <Li>
                For model-level details, including the systems in use and their known limitations,
                see the{" "}
                <Link href="/trust/ai" className="text-primary underline">
                  AI System Card
                </Link>
                .
              </Li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
