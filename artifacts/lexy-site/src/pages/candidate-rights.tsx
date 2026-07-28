/*
 * Candidate Rights page.
 *
 * Candidate-facing, warm, plain-language explanation of the controls
 * candidates have over their own data.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import {
  UserCheck,
  ArrowLeft,
  Trash2,
  Download,
  ShieldOff,
  FileText,
  Pencil,
  BellOff,
  Mail,
} from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const PRIVACY_EMAIL = "privacy@l3xy.ai";

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

export default function CandidateRights() {
  usePageMeta({
    title: "Candidate Rights",
    description:
      "How candidates can access, export, correct, or delete their data, withdraw AI consent, and control communication preferences with L3XY.",
    path: "/candidate-rights",
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
              <UserCheck className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Candidate Rights
            </span>
          </div>
          <h1 className="text-4xl font-black mb-4">Candidate Rights</h1>

          <p className="text-sm text-muted-foreground mb-12 leading-relaxed">
            Your data is yours. When you interview with an organization that uses L3XY, you stay in
            control of your information. Here is what you can do — and how to do it. If you ever
            have a question, you can reach us directly at{" "}
            <a className="text-primary underline" href={`mailto:${PRIVACY_EMAIL}`}>
              {PRIVACY_EMAIL}
            </a>
            .
          </p>

          <Section title="Request deletion of your data" icon={<Trash2 className="w-4 h-4" />}>
            <p>
              You can ask us to delete your data. When you do, we run an erasure cascade that
              removes your associated records, so your information does not linger behind the
              scenes. If you would prefer to talk to a person, email{" "}
              <a className="text-primary underline" href={`mailto:${PRIVACY_EMAIL}`}>
                {PRIVACY_EMAIL}
              </a>{" "}
              and we will help.
            </p>
          </Section>

          <Section title="Export your data" icon={<Download className="w-4 h-4" />}>
            <p>
              Want a copy of your information? You can request a data export. This gives you a
              portable copy of the data we hold about you, so you always know what has been
              collected.
            </p>
          </Section>

          <Section title="Withdraw AI consent at any time" icon={<ShieldOff className="w-4 h-4" />}>
            <p>
              Consent is never a one-way door. You can withdraw your consent to an AI-assisted
              interview at any time — even in the middle of one. Our consent is designed to fail
              closed, which means if you have not agreed, or you change your mind, the AI interview
              simply does not go ahead.
            </p>
          </Section>

          <Section title="View your interview profile" icon={<FileText className="w-4 h-4" />}>
            <p>
              You can view the interview profile built from your responses, so you can see the
              evidence gathered during your interview rather than wondering what is behind the
              scenes.
            </p>
          </Section>

          <Section title="Request corrections" icon={<Pencil className="w-4 h-4" />}>
            <p>
              If something about your information is wrong or out of date, you can ask us to correct
              it. Just let us know what needs updating and we will take care of it.
            </p>
          </Section>

          <Section
            title="Control your communication preferences"
            icon={<BellOff className="w-4 h-4" />}
          >
            <p>
              You decide how and whether you hear from us. You can set your communication
              preferences, including a do-not-contact option if you would rather not receive
              outreach.
            </p>
          </Section>

          <Section title="Get in touch" icon={<Mail className="w-4 h-4" />}>
            <ul className="space-y-1.5">
              <Li>
                For any of the requests above, email{" "}
                <a className="text-primary underline" href={`mailto:${PRIVACY_EMAIL}`}>
                  {PRIVACY_EMAIL}
                </a>
                . A real person will help you.
              </Li>
              <Li>
                To learn how we protect your information, see our{" "}
                <Link href="/privacy" className="text-primary underline">
                  Privacy Policy
                </Link>{" "}
                and{" "}
                <Link href="/security" className="text-primary underline">
                  Security
                </Link>{" "}
                pages.
              </Li>
            </ul>
          </Section>
        </div>
      </main>
    </div>
  );
}
