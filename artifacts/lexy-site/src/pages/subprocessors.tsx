/*
 * Public subprocessor list.
 *
 * THE CANONICAL SOURCE is `legal/subprocessors.md`. The DPA Annex II and
 * this page both consume that file's contents — keep them in sync.
 *
 * Customers may subscribe to change notifications by emailing
 * legal@l3xy.ai. New subprocessors are announced 30 days in advance via
 * email to active customers, per DPA §6.3.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { Database, ArrowLeft } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const LAST_UPDATED = "16 May 2026";

interface Sub {
  vendor: string;
  purpose: string;
  data: string;
  region: string;
}

const SUBPROCESSORS: Sub[] = [
  {
    vendor: "OpenAI, LLC",
    purpose:
      "LLM inference for resume parsing, interview generation, and candidate scoring (zero-retention API; no training on Customer Data)",
    data: "Candidate name, resume text, interview transcripts",
    region: "United States",
  },
  {
    vendor: "Anthropic PBC",
    purpose:
      "LLM inference for long-context interview review and bias-audit reasoning (no training on Customer Data)",
    data: "Candidate name, resume text, interview transcripts",
    region: "United States",
  },
  {
    vendor: "Neon (Databricks Inc.)",
    purpose: "Primary Postgres database hosting (AES-256 at rest, TLS 1.3 in transit)",
    data: "All Customer Personal Data",
    region: "United States (us-east-2)",
  },
  {
    vendor: "Replit, Inc.",
    purpose: "Application hosting, build, and deployment platform",
    data: "All Customer Personal Data",
    region: "United States",
  },
  {
    vendor: "Cloudflare, Inc.",
    purpose: "CDN, DNS, and DDoS protection",
    data: "IP addresses, request metadata",
    region: "Global edge",
  },
  {
    vendor: "Resend, Inc.",
    purpose: "Transactional email delivery (invites, password resets, recruiter digests)",
    data: "Recipient email, subject, body",
    region: "United States",
  },
  {
    vendor: "Stripe, Inc.",
    purpose: "Payment processing for the optional self-serve checkout path",
    data: "Billing contact, tokenised payment method",
    region: "United States",
  },
  {
    vendor: "Sentry (Functional Software Inc.)",
    purpose: "Application error monitoring (PII scrubbed before ingestion)",
    data: "Stack traces, sanitised request metadata",
    region: "United States",
  },
];

export default function Subprocessors() {
  usePageMeta({
    title: 'Subprocessors',
    description: 'The subprocessors L3XY AI uses to deliver its hiring platform.',
    path: '/subprocessors',
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
              <Database className="w-4 h-4" />
            </div>
            <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
              Trust & Security
            </span>
          </div>
          <h1 className="text-4xl font-black mb-2">Subprocessors</h1>
          <p className="text-sm text-muted-foreground mb-10">Last updated: {LAST_UPDATED}</p>

          <p className="text-sm text-muted-foreground mb-10 leading-relaxed">
            A "subprocessor" is a third party that Lexy uses to process Customer Personal Data on
            Lexy's behalf, as defined in our{" "}
            <Link href="/dpa" className="text-primary underline">
              Data Processing Addendum
            </Link>
            . We publish the complete list below. Customers receive 30 days' advance email notice of
            any new subprocessor and may object in writing per DPA §6.3.
          </p>

          <div className="border border-border rounded-2xl overflow-hidden mb-10">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Vendor</th>
                  <th className="text-left px-4 py-3 font-medium">Purpose</th>
                  <th className="text-left px-4 py-3 font-medium">Data categories</th>
                  <th className="text-left px-4 py-3 font-medium">Region</th>
                </tr>
              </thead>
              <tbody>
                {SUBPROCESSORS.map((s) => (
                  <tr key={s.vendor} className="border-t border-border/40 align-top">
                    <td className="px-4 py-3 font-medium whitespace-nowrap">{s.vendor}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.purpose}</td>
                    <td className="px-4 py-3 text-muted-foreground">{s.data}</td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                      {s.region}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="text-lg font-semibold mb-3">Notification subscription</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Customers can subscribe to subprocessor change notifications by emailing{" "}
            <a className="text-primary underline" href="mailto:legal@l3xy.ai">
              legal@l3xy.ai
            </a>{" "}
            with subject line <code>SUBSCRIBE: subprocessor-updates</code>.
          </p>
        </div>
      </main>
    </div>
  );
}
