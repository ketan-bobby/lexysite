/*
 * Trust Center hub page.
 *
 * Central landing page linking out to every trust, privacy, security, and
 * responsible-AI resource. Keep descriptions factual and hedged — buyers and
 * candidates both read this page.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import {
  ShieldCheck,
  ArrowLeft,
  Brain,
  Eye,
  Scale,
  UserCheck,
  FileCheck,
  Lock,
  Cpu,
  FileText,
  Database,
  Users,
  ClipboardCheck,
  Bell,
} from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const cards = [
  {
    href: "/responsible-ai",
    icon: <Brain className="w-4 h-4" />,
    title: "Responsible AI",
    description:
      "How L3XY is designed so AI assists evaluations while humans make the hiring decisions.",
  },
  {
    href: "/ai-transparency",
    icon: <Eye className="w-4 h-4" />,
    title: "AI Transparency",
    description:
      "A step-by-step look at how candidates are evaluated, from consent to human decision.",
  },
  {
    href: "/fair-hiring",
    icon: <Scale className="w-4 h-4" />,
    title: "Fair Hiring",
    description:
      "Blind evaluation, standardized questions, and monitoring designed to support fairer, more consistent assessments.",
  },
  {
    href: "/candidate-rights",
    icon: <UserCheck className="w-4 h-4" />,
    title: "Candidate Rights",
    description:
      "How candidates can access, export, correct, or delete their data and control AI consent.",
  },
  {
    href: "/compliance",
    icon: <FileCheck className="w-4 h-4" />,
    title: "Compliance",
    description: "The frameworks and regulations L3XY is designed to support compliance with.",
  },
  {
    href: "/privacy",
    icon: <Lock className="w-4 h-4" />,
    title: "Privacy",
    description: "How we collect, use, and protect personal data across candidates and employers.",
  },
  {
    href: "/security",
    icon: <ShieldCheck className="w-4 h-4" />,
    title: "Security",
    description: "Encryption, access controls, tenant isolation, and vulnerability reporting.",
  },
  {
    href: "/trust/ai",
    icon: <Cpu className="w-4 h-4" />,
    title: "AI System Card",
    description:
      "Model-level details: the systems in use, evaluated characteristics, and known limitations.",
  },
  {
    href: "/dpa",
    icon: <FileText className="w-4 h-4" />,
    title: "Data Processing Addendum",
    description: "Our DPA describing how L3XY processes personal data on your behalf.",
  },
  {
    href: "/subprocessors",
    icon: <Database className="w-4 h-4" />,
    title: "Subprocessors",
    description:
      "The current list of vendors that process customer personal data on L3XY's behalf.",
  },
];

const differentiators = [
  {
    icon: <Users className="w-4 h-4" />,
    title: "Human-in-the-loop",
    description:
      "L3XY is designed to support human decision-making — AI cannot write final hiring decisions.",
  },
  {
    icon: <Eye className="w-4 h-4" />,
    title: "Blind Evaluation",
    description:
      "Personal identifiers are designed to be redacted before AI scoring to help focus on evidence.",
  },
  {
    icon: <FileText className="w-4 h-4" />,
    title: "Explainability",
    description: "Every recommendation is built to be backed by structured, reviewable evidence.",
  },
  {
    icon: <UserCheck className="w-4 h-4" />,
    title: "Candidate Consent",
    description:
      "Versioned consent is designed to fail closed before interviews and can be revoked at any time.",
  },
  {
    icon: <ClipboardCheck className="w-4 h-4" />,
    title: "Candidate Control",
    description:
      "Candidates are provided tools to access, export, correct, and delete their own data.",
  },
  {
    icon: <Scale className="w-4 h-4" />,
    title: "Fairness Monitoring",
    description:
      "Adverse-impact analytics are designed to help organizations monitor outcomes over time.",
  },
  {
    icon: <Bell className="w-4 h-4" />,
    title: "Audit Trail",
    description: "Recommendations and decisions are logged to support traceability and review.",
  },
];

export default function Trust() {
  usePageMeta({
    title: "Trust Center",
    description:
      "How L3XY approaches privacy, security, and responsible AI — resources for candidates, employers, and procurement teams.",
    path: "/trust",
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
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Trust Center
            </span>
          </div>
          <h1 className="text-4xl font-black mb-3">Trust Center</h1>
          <p className="text-base text-muted-foreground mb-12 leading-relaxed max-w-2xl">
            How L3XY approaches privacy, security, and responsible AI. Explore how our product is
            designed to support fair, transparent, and accountable hiring — with humans firmly in
            control of every decision.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-16">
            {cards.map((card) => (
              <Link key={card.href} href={card.href}>
                <div className="h-full rounded-2xl border border-border bg-card p-5 cursor-pointer transition-colors hover:border-primary/40">
                  <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center text-primary mb-3">
                    {card.icon}
                  </div>
                  <h2 className="text-base font-semibold text-foreground mb-1.5">{card.title}</h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {card.description}
                  </p>
                </div>
              </Link>
            ))}
          </div>

          <h2 className="text-lg font-semibold text-foreground mb-6">What sets L3XY apart</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {differentiators.map((item) => (
              <div key={item.title} className="rounded-2xl border border-border bg-card p-5">
                <div className="flex items-center gap-2.5 mb-2">
                  <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                    {item.icon}
                  </div>
                  <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
