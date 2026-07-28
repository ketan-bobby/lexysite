/*
 * Compliance page.
 *
 * Lists the frameworks L3XY is designed to support compliance with. Never
 * claim certification — always hedge, and be honest that formal audits are
 * commissioned separately.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { FileCheck, ArrowLeft, ClipboardCheck, Lock, Briefcase, Landmark } from "lucide-react";
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

export default function Compliance() {
  usePageMeta({
    title: "Compliance",
    description:
      "The AI governance, privacy, employment, and EU AI Act frameworks L3XY is designed to support compliance with.",
    path: "/compliance",
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
              <FileCheck className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Compliance
            </span>
          </div>
          <h1 className="text-4xl font-black mb-4">Compliance</h1>

          <p className="text-sm text-muted-foreground mb-12 leading-relaxed">
            L3XY is built to help organizations meet their obligations across AI governance,
            privacy, and employment law. The frameworks below describe what our product is designed
            to support compliance with — they are not claims of certification. Responsibility for
            compliance in any given jurisdiction rests with the organizations that use L3XY, and we
            provide tools to support them.
          </p>

          <Section title="AI Governance" icon={<ClipboardCheck className="w-4 h-4" />}>
            <p>L3XY is designed to support compliance with AI governance expectations through:</p>
            <ul className="space-y-1.5">
              <Li>
                <strong>Human oversight:</strong> AI cannot write final decisions, and adverse
                decisions require a recruiter attestation.
              </Li>
              <Li>
                <strong>Audit logging:</strong> recommendations and decisions are recorded in an
                audit trail designed to support review.
              </Li>
              <Li>
                <strong>Explainable recommendations:</strong> each recommendation is built to be
                backed by structured, reviewable evidence.
              </Li>
              <Li>
                <strong>Decision traceability:</strong> the process is designed so outcomes can be
                reconstructed and attributed.
              </Li>
            </ul>
          </Section>

          <Section title="Privacy" icon={<Lock className="w-4 h-4" />}>
            <p>L3XY is designed to support compliance with privacy regulations including:</p>
            <ul className="space-y-1.5">
              <Li>
                <strong>GDPR:</strong> tools for consent, data export, and a right-to-delete erasure
                cascade.
              </Li>
              <Li>
                <strong>CCPA / CPRA:</strong> tools to support access, deletion, and communication
                preferences.
              </Li>
              <Li>
                <strong>Illinois BIPA:</strong> retention schedulers for logs and speech data
                aligned to configured policies.
              </Li>
            </ul>
          </Section>

          <Section title="Employment" icon={<Briefcase className="w-4 h-4" />}>
            <p>
              L3XY is designed to support compliance with employment-related frameworks including:
            </p>
            <ul className="space-y-1.5">
              <Li>
                <strong>EEOC guidance:</strong> blind evaluation, standardized questions, and
                consistent rubrics designed to support fairer assessments.
              </Li>
              <Li>
                <strong>NYC Local Law 144:</strong> adverse-impact (4/5ths) monitoring analytics and
                audit-ready data exports.
              </Li>
              <Li>
                <strong>Illinois AI Video Interview Act:</strong> in-product, versioned consent
                capture that is designed to fail closed.
              </Li>
              <Li>
                <strong>Colorado AI Act:</strong> human oversight, documentation, and monitoring
                designed to support obligations for consequential decisions.
              </Li>
            </ul>
          </Section>

          <Section title="EU AI Act" icon={<Landmark className="w-4 h-4" />}>
            <p>L3XY is designed to support compliance with the EU AI Act through:</p>
            <ul className="space-y-1.5">
              <Li>
                <strong>Annex IV technical documentation:</strong> maintained to describe the system
                and its design.
              </Li>
              <Li>
                <strong>AI System Card:</strong> published details on the systems in use, evaluated
                characteristics, and known limitations — see the{" "}
                <Link href="/trust/ai" className="text-primary underline">
                  AI System Card
                </Link>
                .
              </Li>
              <Li>
                <strong>Post-market monitoring:</strong> analytics and audit trails designed to
                support ongoing monitoring of system behavior.
              </Li>
            </ul>
          </Section>

          <div className="border-t border-border pt-8 mt-12 text-sm text-muted-foreground">
            <p>
              A note on audits and certifications: formal third-party audits and certifications are
              commissioned separately by customers or by L3XY, and are not represented on this page.
              This page describes product capabilities designed to support compliance — it does not
              claim that L3XY is certified or that any particular audit has been completed. For our{" "}
              <Link href="/dpa" className="text-primary underline">
                DPA
              </Link>
              ,{" "}
              <Link href="/subprocessors" className="text-primary underline">
                subprocessor list
              </Link>
              , or evidence for a review, please contact us.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
