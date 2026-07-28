/*
 * SiteFooter — shared marketing-site footer.
 *
 * Structure (per brand feedback, "favorite version"):
 *   1. Large CTA band — "Ready to Build Better Hiring?" + trial/demo buttons
 *   2. Footer body on a slightly darker surface (#FAFBFD) with a 1px
 *      top border (#E8EEF5) and generous vertical padding:
 *      brand column (lg logo, punchy tagline, 4 pills) + Product /
 *      Trust / Knowledge columns
 *   3. Subtle "Designed to support" trust strip
 *   4. Sign-off: © + "AI recommends. Humans decide."
 *   5. Final brand statement: "The future of hiring isn't built on
 *      resumes. It's built on evidence."
 *
 * Language rules (legal): never make absolute claims ("bias-free",
 * "eliminates discrimination", "guaranteed", "certified compliant").
 * Use hedged framing: "designed to support…", "provides tools to…".
 * The trust strip is framed with "Designed to support" — no
 * certification claims (SOC 2 explicitly marked "coming").
 */
import { useEffect } from "react";
import { Link } from "wouter";
import { FileCheck, Globe, Lock, ShieldCheck } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

const COLUMNS: { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { label: "For Employers", href: "/employers" },
      { label: "For Candidates", href: "/candidates" },
      { label: "Pricing", href: "/pricing" },
      { label: "Start Free Trial", href: "/start-trial" },
    ],
  },
  {
    heading: "Trust",
    links: [
      { label: "Trust Center", href: "/trust" },
      { label: "Responsible AI", href: "/responsible-ai" },
      { label: "AI Transparency", href: "/ai-transparency" },
      { label: "Fair Hiring", href: "/fair-hiring" },
      { label: "Candidate Rights", href: "/candidate-rights" },
      { label: "Compliance", href: "/compliance" },
    ],
  },
  // Company column — per brand direction the footer intentionally does NOT
  // advertise internal AI documentation (AI System Card, Subprocessors);
  // those pages stay live and are shared directly on request.
  {
    heading: "Company",
    links: [
      { label: "Our Philosophy", href: "/philosophy" },
      { label: "Blog", href: "/blog" },
    ],
  },
  {
    heading: "Trust & Legal",
    links: [
      { label: "Security & Compliance", href: "/security" },
      { label: "Privacy Policy", href: "/privacy" },
      { label: "Terms of Service", href: "/terms" },
      { label: "Data Processing Agreement", href: "/dpa" },
      { label: "Disclaimer", href: "/disclaimer" },
      { label: "Whistleblower Policy", href: "/whistleblower-policy" },
      { label: "Order Form Terms", href: "/order-form-terms" },
      { label: "Prohibited Uses", href: "/prohibited-uses" },
    ],
  },
];

const PILLS = ["45+ Languages", "Evidence-Based", "Enterprise Ready", "Privacy First"];

const TRUST_STRIP: { icon: typeof ShieldCheck; label: string }[] = [
  { icon: ShieldCheck, label: "SOC 2 (coming)" },
  { icon: Lock, label: "GDPR" },
  { icon: FileCheck, label: "CCPA" },
  { icon: Globe, label: "EU AI Act" },
];

export default function SiteFooter() {
  // Vite SPA: the browser's native anchor jump fires before React renders,
  // so honor a #footer hash manually once the footer is mounted.
  useEffect(() => {
    if (window.location.hash === "#footer") {
      document.getElementById("footer")?.scrollIntoView();
    }
  }, []);
  return (
    <footer id="footer">
      {/* CTA band — the loud part, so the footer itself can stay quiet */}
      <div className="border-t border-border/50 px-6 py-20 text-center">
        <h2 className="text-2xl md:text-3xl font-bold text-foreground text-balance">
          Ready to Build Better Hiring?
        </h2>
        <div className="mt-7 flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/start-trial"
            className="inline-flex items-center justify-center rounded-full bg-primary px-7 py-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Start Free Trial
          </Link>
          <Link
            href="/employers?demo=1"
            className="inline-flex items-center justify-center rounded-full border border-border px-7 py-3 text-sm font-semibold text-foreground hover:bg-muted/60 transition-colors"
          >
            Book a Demo
          </Link>
        </div>
      </div>

      {/* Footer body — slightly darker surface, subtle end-of-experience */}
      <div className="bg-[#FAFBFD] border-t border-[#E8EEF5]">
        {/* Links */}
        <div className="px-6 pt-20 md:pt-24 pb-14">
          <div className="max-w-5xl mx-auto grid grid-cols-2 md:grid-cols-6 gap-8">
            <div className="col-span-2">
              <LexyLogo size="lg" />
              <p className="text-sm text-foreground font-medium leading-relaxed mt-5">
                Evidence-based hiring for modern teams.
              </p>
              <p className="text-sm text-muted-foreground leading-relaxed mt-1">
                AI evaluates consistently. Humans decide.
              </p>
              <div className="flex flex-wrap gap-2 mt-5 max-w-[300px]">
                {PILLS.map((pill) => (
                  <span
                    key={pill}
                    className="text-[11px] font-medium text-muted-foreground border border-border/60 bg-white rounded-full px-3 py-1"
                  >
                    {pill}
                  </span>
                ))}
              </div>
            </div>
            {COLUMNS.map((col) => (
              <div key={col.heading}>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-foreground mb-4">
                  {col.heading}
                </h3>
                <ul className="space-y-2">
                  {col.links.map((l) => (
                    <li key={l.href}>
                      <Link
                        href={l.href}
                        className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        {/* Trust strip */}
        <div className="border-t border-[#E8EEF5] px-6 py-6">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
              Designed to support
            </span>
            {TRUST_STRIP.map(({ icon: Icon, label }) => (
              <span
                key={label}
                className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <Icon className="w-3.5 h-3.5 text-muted-foreground/70" aria-hidden="true" />
                {label}
              </span>
            ))}
          </div>
        </div>

        {/* Sign-off */}
        <div className="border-t border-[#E8EEF5] px-6 py-6">
          <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">© 2026 L3XY AI</p>
            <p className="text-xs font-medium text-foreground">
              AI recommends. <span className="text-primary">Humans decide.</span>
            </p>
            <a
              href="mailto:legal@l3xy.ai"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Contact
            </a>
          </div>
        </div>

        {/* Final brand statement */}
        <div className="border-t border-[#E8EEF5] px-6 py-8 text-center">
          <p className="text-sm md:text-base font-medium text-muted-foreground text-balance">
            The future of hiring isn't built on resumes.{" "}
            <span className="text-primary">It's built on evidence.</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
