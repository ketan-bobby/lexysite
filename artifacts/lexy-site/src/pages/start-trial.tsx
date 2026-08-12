/*
 * start-trial.tsx — Free-trial request form.
 *
 * Collects qualification details and posts them to /api/plans/start-trial,
 * which sends a verification email (no credit card, no price). Includes a
 * hidden honeypot field for basic bot filtering and handles 429 rate-limit
 * responses explicitly. Extra context fields (role, team size, hiring focus)
 * are accepted as metadata-only by the server.
 */
import { usePageMeta } from "@/lib/seo";
import { useState } from "react";
import { Link } from "wouter";
import { Loader2, CheckCircle2, ArrowRight, Mail, Shield } from "lucide-react";

const API = "";

function LexyLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const cls = size === "lg" ? "h-12" : size === "sm" ? "h-7" : "h-9";
  return (
    <img
      src={`${import.meta.env.BASE_URL}lexy-ai-logo.png`}
      alt="L3xy AI"
      className={`${cls} w-auto object-contain select-none`}
      draggable={false}
    />
  );
}

type Status = "idle" | "submitting" | "submitted" | "error";

export default function StartTrial() {
  usePageMeta({
    title: "Start Your Free Trial",
    description: "Start your free L3XY AI trial — no implementation delays, live in minutes.",
    path: "/start-trial",
  });
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [teamSize, setTeamSize] = useState("");
  const [hiringFocus, setHiringFocus] = useState("");
  const [honeypot, setHoneypot] = useState(""); // bot trap
  const [status, setStatus] = useState<Status>("idle");
  const [serverMessage, setServerMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage("");

    if (!name.trim() || !email.trim() || !company.trim()) {
      setErrorMessage("Name, work email, and company are required.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setErrorMessage("Please enter a valid work email address.");
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch(`${API}/api/plans/start-trial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          company: company.trim(),
          honeypot,
          // Extra context fields are accepted as metadata-only by the server
          // (it ignores unknown fields). Captured for future enrichment.
          role: role.trim() || undefined,
          teamSize: teamSize || undefined,
          hiringFocus: hiringFocus.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));

      if (res.status === 429) {
        setStatus("error");
        setErrorMessage(
          data?.message ||
            "Too many requests from your network. Please try again in a little while.",
        );
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(
          data?.message || "Something went wrong. Please try again or email sales@l3xy.io.",
        );
        return;
      }

      setStatus("submitted");
      setServerMessage(
        data?.message ||
          "Thanks — if you don't already have an L3xy account, we just sent a verification link to your inbox. The link is valid for 24 hours.",
      );
    } catch (err) {
      setStatus("error");
      setErrorMessage("Network error. Please check your connection and try again.");
    }
  }

  return (
    <div className="min-h-screen text-foreground">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 backdrop-blur-xl bg-background/80">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <LexyLogo size="md" />
          </Link>
          <div className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <Link href="/employers" className="hover:text-foreground transition-colors">
              Employers
            </Link>
            <Link href="/candidates" className="hover:text-foreground transition-colors">
              Candidates
            </Link>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="mailto:sales@l3xy.io?subject=L3xy%20-%20Talk%20to%20Sales"
              className="px-4 py-2 rounded-lg text-sm font-medium border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground transition-colors"
            >
              Talk to Sales
            </a>
          </div>
        </div>
      </nav>

      <main className="pt-32 pb-24 px-6">
        <div className="max-w-5xl mx-auto grid lg:grid-cols-[1.1fr_1fr] gap-16">
          {/* Left column — pitch */}
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20 mb-6">
              <Mail className="w-3.5 h-3.5" />
              Experience Lexy
            </div>
            <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1] mb-6">
              See your <span className="text-primary">hiring intelligence</span> before you buy.
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed mb-8">
              Tell us a little about your hiring and we'll set you up with a guided trial. We review
              every request personally so we can tailor the workspace, sample candidates, and
              onboarding to the way your team actually hires.
            </p>

            <ul className="space-y-4 mb-10">
              {[
                "Personalized workspace built around one of your live roles",
                "Watch interviews become structured hiring intelligence",
                "Human-reviewed recommendations—not black-box AI",
                "See exactly why every candidate is recommended",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm text-muted-foreground">
                  <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <div className="flex items-start gap-3 p-4 rounded-lg border border-border/60 bg-card/40 text-xs text-muted-foreground">
              <Shield className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <span>
                We treat your information confidentially and use it only to follow up about your
                trial. Read our{" "}
                <Link href="/privacy" className="text-primary hover:underline">
                  privacy policy
                </Link>
                .
              </span>
            </div>
          </div>

          {/* Right column — form */}
          <div className="lg:pt-2">
            <div className="rounded-2xl border border-border bg-card/60 backdrop-blur p-6 md:p-8 shadow-xl">
              {status === "submitted" ? (
                <div className="text-center py-6">
                  <div className="w-14 h-14 rounded-full bg-primary/15 flex items-center justify-center mx-auto mb-4">
                    <CheckCircle2 className="w-7 h-7 text-primary" />
                  </div>
                  <h2 className="text-xl font-semibold mb-3">Thanks — we got it.</h2>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-6">
                    {serverMessage}
                  </p>
                  <Link
                    href="/"
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    Back to homepage <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-5" noValidate>
                  <div>
                    <h2 className="text-xl font-semibold mb-1">Request your trial</h2>
                    <p className="text-sm text-muted-foreground">
                      A few quick details and we'll be in touch within one business day.
                    </p>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Full name" required>
                      <input
                        type="text"
                        autoComplete="name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className={inputCls}
                        placeholder="Alex Martinez"
                      />
                    </Field>
                    <Field label="Work email" required>
                      <input
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={inputCls}
                        placeholder="alex@company.com"
                      />
                    </Field>
                  </div>

                  <Field label="Company" required>
                    <input
                      type="text"
                      autoComplete="organization"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      className={inputCls}
                      placeholder="Acme, Inc."
                    />
                  </Field>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Your role">
                      <input
                        type="text"
                        autoComplete="organization-title"
                        value={role}
                        onChange={(e) => setRole(e.target.value)}
                        className={inputCls}
                        placeholder="Head of Talent"
                      />
                    </Field>
                    <Field label="Team size">
                      <select
                        value={teamSize}
                        onChange={(e) => setTeamSize(e.target.value)}
                        className={inputCls}
                      >
                        <option value="">Select…</option>
                        <option value="1-10">1–10</option>
                        <option value="11-50">11–50</option>
                        <option value="51-200">51–200</option>
                        <option value="201-1000">201–1,000</option>
                        <option value="1000+">1,000+</option>
                      </select>
                    </Field>
                  </div>

                  <Field label="What roles are you hiring for?">
                    <textarea
                      rows={3}
                      value={hiringFocus}
                      onChange={(e) => setHiringFocus(e.target.value)}
                      className={`${inputCls} resize-none`}
                      placeholder="e.g. 4 backend engineers, 2 sales reps, ongoing support hires…"
                    />
                  </Field>

                  {/* Honeypot — hidden from users, bots fill it */}
                  <input
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={honeypot}
                    onChange={(e) => setHoneypot(e.target.value)}
                    className="hidden"
                    aria-hidden="true"
                  />

                  {errorMessage && (
                    <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
                      {errorMessage}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={status === "submitting"}
                    className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {status === "submitting" ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Sending…
                      </>
                    ) : (
                      <>
                        Request my trial
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>

                  <p className="text-xs text-muted-foreground text-center">
                    Already have an account?{" "}
                    <a href="/login" className="text-primary hover:underline">
                      Sign in
                    </a>
                  </p>
                </form>
              )}
            </div>

            <div className="mt-6">
              <p className="text-xs font-medium text-muted-foreground/70 tracking-widest uppercase text-center mb-3">
                Enterprise-ready
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {["GDPR", "EU AI Act", "Human-in-the-loop", "Explainable AI"].map((badge) => (
                  <span
                    key={badge}
                    className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-border bg-card text-xs font-medium text-muted-foreground"
                  >
                    <Shield className="w-3 h-3 text-primary" />
                    {badge}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

const inputCls =
  "w-full px-3 py-2.5 rounded-md bg-background border border-border text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/40 transition-colors";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-muted-foreground mb-1.5">
        {label}
        {required && <span className="text-primary ml-0.5">*</span>}
      </span>
      {children}
    </label>
  );
}
