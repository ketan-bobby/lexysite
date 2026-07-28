import SiteFooter from "@/components/SiteFooter";
/*
 * employers.tsx — Public "for employers" marketing landing page.
 *
 * Largely static marketing content (hero, broken-process section, the four
 * intelligence layers, the AI agent roster, how-it-works steps, and a demo
 * video). The one interactive piece is <DemoModal>, which posts a lead to
 * /api/public/sales-lead. Content arrays (intelligenceLayers, agents,
 * howItWorks, etc.) drive the repeated card sections.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Zap,
  Users,
  TrendingUp,
  Shield,
  Search,
  ClipboardCheck,
  Mic,
  Eye,
  BadgeCheck,
  Mail,
  Bell,
  Calendar,
  BarChart3,
  ArrowRight,
  Sparkles,
  CheckCircle,
  Target,
  Layers,
  LayoutDashboard,
  Timer,
  Frown,
  Crosshair,
  Scale,
  Bot,
  MessageCircle,
  CalendarCheck,
  Activity,
  Volume2,
  X,
  Loader2,
} from "lucide-react";

// API server is mounted by the platform proxy at /api/* (see api-server
// artifact.toml paths=["/api"]). Calling it without a host prefix avoids the
// stale /api-server proxy alias.
const API = "";

function DemoModal({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState({ fullName: "", email: "", phone: "", company: "" });
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!consent) {
      setError("Please accept the privacy notice to continue.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/public/sales-lead`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Submission failed");
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative my-auto w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto bg-card border border-border rounded-3xl p-6 sm:p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {success ? (
          <div className="text-center py-8">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-5">
              <CheckCircle className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-2xl font-semibold mb-3">We'll be in touch!</h3>
            <p className="text-muted-foreground leading-relaxed">
              Thanks for your interest. A member of our team will reach out within one business day.
            </p>
            <button
              onClick={onClose}
              className="mt-8 px-6 py-2.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="mb-7">
              <h3 className="text-2xl font-semibold mb-1.5">Book a Demo</h3>
              <p className="text-sm text-muted-foreground">
                Tell us a bit about yourself and we'll be in touch.
              </p>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Full Name *
                </label>
                <input
                  type="text"
                  required
                  value={form.fullName}
                  onChange={set("fullName")}
                  placeholder="Jane Smith"
                  className="w-full px-4 py-3 rounded-xl bg-background border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Work Email *
                </label>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={set("email")}
                  placeholder="jane@company.com"
                  className="w-full px-4 py-3 rounded-xl bg-background border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Phone Number
                </label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={set("phone")}
                  placeholder="+1 (555) 000-0000"
                  className="w-full px-4 py-3 rounded-xl bg-background border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Company Name
                </label>
                <input
                  type="text"
                  value={form.company}
                  onChange={set("company")}
                  placeholder="Acme Corp"
                  className="w-full px-4 py-3 rounded-xl bg-background border border-border text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary transition-colors"
                />
              </div>

              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 accent-primary w-4 h-4 shrink-0"
                />
                <span className="text-xs text-muted-foreground leading-relaxed">
                  I agree that Lexy may use my details to contact me about the demo and related
                  services. View our{" "}
                  <Link
                    href="/privacy"
                    className="text-primary underline underline-offset-2 hover:text-primary/80 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Privacy Policy
                  </Link>
                  . You can unsubscribe at any time.
                </span>
              </label>

              {error && <p className="text-sm text-primary">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60 mt-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {loading ? "Submitting…" : "Request a Demo"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

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

function Nav({ onBookDemo }: { onBookDemo: () => void }) {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 backdrop-blur-xl bg-background/80">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/">
          <div className="flex items-center cursor-pointer">
            <LexyLogo size="md" />
          </div>
        </Link>
        <div className="hidden md:flex items-center gap-8 text-sm text-muted-foreground whitespace-nowrap">
          <a href="#how-it-works" className="hover:text-foreground transition-colors">
            How It Works
          </a>
          <a href="#why-lexy" className="hover:text-foreground transition-colors">
            Why L3XY
          </a>
          <Link href="/candidates" className="hover:text-foreground transition-colors">
            Candidates
          </Link>
          <Link href="/blog" className="hover:text-foreground transition-colors">
            Hiring Intelligence
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/start-trial">
            <button className="px-4 py-2 rounded-lg text-sm font-medium border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap">
              Start Trial
            </button>
          </Link>
          <button
            onClick={onBookDemo}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Book a Demo
          </button>
        </div>
      </div>
    </nav>
  );
}

const intelligenceLayers = [
  {
    icon: Target,
    title: "Define Success Before You Hire",
    desc: "Transform job descriptions into structured success criteria that define what great looks like before hiring begins.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Users,
    title: "Build Evidence, Not Profiles",
    desc: "Capture structured interview evidence, competencies, behavioral signals, and recruiter observations—all connected in one place.",
    color: "text-violet-600",
    bg: "bg-violet-600/10",
    border: "border-violet-600/20",
  },
  {
    icon: Brain,
    title: "Recruiters Decide. Evidence Leads.",
    desc: "Every recommendation is transparent, explainable, and always remains under recruiter control.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: Zap,
    title: "Keep Great Candidates Engaged",
    desc: "Automate outreach, schedule interviews, and reduce ghosting — so strong candidates stay engaged and move through the pipeline.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
];

const agents = [
  {
    icon: Target,
    name: "ICP Agent",
    desc: "Creates structured Ideal Candidate Profiles from job descriptions.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Search,
    name: "Sourcing Agent",
    desc: "Finds candidates from ATS data, public profiles, GitHub, PDL, SERP APIs, and open sources.",
    color: "text-violet-600",
    bg: "bg-violet-600/10",
    border: "border-violet-600/20",
  },
  {
    icon: ClipboardCheck,
    name: "Screening Agent",
    desc: "Evaluates candidate profiles and matches them against job requirements.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: Mic,
    name: "AI Interview Agent",
    desc: "Conducts AI-powered interviews, asks follow-ups, and scores responses.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
  {
    icon: Eye,
    name: "Proctoring Agent",
    desc: "Detects suspicious behavior and ensures interview integrity.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: BadgeCheck,
    name: "Verification Agent",
    desc: "Validates candidate identity and profile accuracy.",
    color: "text-violet-600",
    bg: "bg-violet-600/10",
    border: "border-violet-600/20",
  },
  {
    icon: Mail,
    name: "Outreach Agent",
    desc: "Runs personalized outreach campaigns and improves response rates.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: Bell,
    name: "Anti-Ghosting Agent",
    desc: "Reduces candidate drop-off by triggering timely follow-ups.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
  {
    icon: Calendar,
    name: "Scheduling Agent",
    desc: "Automates interview scheduling and reminders.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: BarChart3,
    name: "Analytics Agent",
    desc: "Tracks performance, hiring metrics, and decision quality.",
    color: "text-violet-600",
    bg: "bg-violet-600/10",
    border: "border-violet-600/20",
  },
];

const howItWorks = [
  {
    num: "01",
    title: "Define your hiring needs",
    desc: "Lexy converts job descriptions into structured Ideal Candidate Profiles automatically.",
  },
  {
    num: "02",
    title: "Source candidates automatically",
    desc: "Lexy pulls candidates from multiple data sources and builds a unified talent pool.",
  },
  {
    num: "03",
    title: "Screen and interview candidates",
    desc: "AI agents evaluate candidates through structured screening and AI-powered interviews.",
  },
  {
    num: "04",
    title: "Predict hiring outcomes",
    desc: "Lexy generates fit scores, trust scores, conversion scores, and hiring confidence for every candidate.",
  },
  {
    num: "05",
    title: "Automate outreach and scheduling",
    desc: "Candidates are automatically engaged, scheduled, and moved through the pipeline.",
  },
  {
    num: "06",
    title: "Improve hiring over time",
    desc: "Lexy learns from outcomes, recruiter feedback, and hiring decisions to get smarter.",
  },
];

const benefits = [
  "Evaluate candidates through structured interviews—not keyword filters.",
  "Understand how candidates think, communicate, and solve problems.",
  "Make hiring decisions backed by structured evidence.",
  "Keep great candidates engaged throughout the hiring process.",
];

const differentiators = [
  {
    icon: Brain,
    title: "Stop hiring based on resumes",
    desc: "Lexy evaluates real capability through structured interviews—so every hiring decision starts with evidence, not keywords.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Zap,
    title: "Stop manually screening candidates",
    desc: "Lexy's AI agents screen, interview, and follow up automatically—so recruiters spend their time making decisions, not managing tasks.",
    color: "text-violet-600",
    bg: "bg-violet-600/10",
    border: "border-violet-600/20",
  },
  {
    icon: Layers,
    title: "Stop stitching together tools",
    desc: "One connected hiring intelligence platform replaces fragmented sourcing, interviews, outreach, and decision support.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: TrendingUp,
    title: "Stop relying on dashboards without decisions",
    desc: "Lexy doesn't just track your pipeline — Lexy recommends the next best action—and explains why.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
];

const stats = [
  { value: "45+", label: "Languages" },
  { value: "3×", label: "Faster hiring" },
  { value: "80%", label: "Less manual screening" },
  { value: "100%", label: "Human-validated AI recommendations" },
];

function EmployerVideoPlayer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };

  return (
    <section className="py-8 px-6 border-t border-border/50">
      <div className="flex flex-col items-center gap-5">
        <div
          style={{
            width: "500px",
            height: "500px",
            maxWidth: "90vw",
            maxHeight: "90vw",
            borderRadius: "50%",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <video
            ref={videoRef}
            src={`${import.meta.env.BASE_URL}lexy-employer-demo.mp4`}
            autoPlay
            muted
            loop
            playsInline
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center 10%",
              display: "block",
            }}
          />
        </div>
        <button
          onClick={toggleMute}
          className="flex items-center gap-2.5 px-6 py-3 rounded-full border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-all text-sm font-medium"
        >
          <Volume2 className="w-4 h-4" />
          {muted ? "Tap to Unmute" : "Mute"}
        </button>
      </div>
    </section>
  );
}

export default function Employers() {
  usePageMeta({
    title: "AI Hiring Platform for Employers — Verified Hiring Signals",
    description:
      "Replace resume keyword screening with verified hiring signals. Structured AI interviews, capability-based matching, and evidence-based hiring decisions in one connected system.",
    path: "/employers",
  });
  const [showDemo, setShowDemo] = useState(false);
  const openDemo = () => setShowDemo(true);

  // Footer/pricing "Book a Demo" CTAs deep-link here with ?demo=1 — open the
  // modal on arrival and strip the param so refresh/back doesn't re-open it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("demo")) {
      setShowDemo(true);
      params.delete("demo");
      const rest = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (rest ? `?${rest}` : "") + window.location.hash,
      );
    }
  }, []);

  return (
    <div className="min-h-screen mesh-bg">
      {showDemo && <DemoModal onClose={() => setShowDemo(false)} />}
      <Nav onBookDemo={openDemo} />

      {/* Hero */}
      <section className="pt-40 pb-24 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-widest mb-8">
            <Sparkles className="w-3 h-3" />
            Interview-Based Hiring
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.1] mb-6">
            Stop screening resumes.
            <br />
            <span className="gradient-text text-glow">Start hiring based on real signals.</span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-3xl mx-auto mb-4 leading-relaxed">
            Every interview becomes structured evidence your recruiters validate, creating
            proprietary hiring intelligence your organization owns.
          </p>

          <p className="text-base font-semibold text-primary mb-10">
            See how candidates think, communicate, and perform — before you hire them.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={openDemo}
              className="flex items-center gap-2 px-6 py-3.5 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary"
            >
              See Hiring Intelligence
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={openDemo}
              className="flex items-center gap-2 px-6 py-3.5 rounded-xl text-base font-medium border border-border hover:border-primary/40 transition-colors text-muted-foreground hover:text-foreground"
            >
              Book a Demo
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mt-20 pt-12 border-t border-border/50">
            {stats.map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-3xl font-semibold text-emerald-600 mb-1">{s.value}</div>
                <div className="text-sm text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Video */}
      <EmployerVideoPlayer />

      {/* Problem Section */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
              Hiring breaks when <span className="gradient-text">evidence is missing.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Most hiring decisions are based on resumes, fragmented interviews, and subjective
              opinions. The result is slower hiring, inconsistent evaluations, and missed talent.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                Icon: Timer,
                title: "Decisions take too long",
                desc: "Top candidates drop off while your team screens, schedules, and follows up.",
                color: "text-primary",
                bg: "bg-primary/10",
                border: "border-primary/20",
              },
              {
                Icon: Frown,
                title: "Great candidates disappear",
                desc: "Slow, inconsistent processes lead to disengagement and ghosting.",
                color: "text-violet-600",
                bg: "bg-violet-600/10",
                border: "border-violet-600/20",
              },
              {
                Icon: Crosshair,
                title: "Resumes hide great talent",
                desc: "Strong candidates get overlooked because signals are weak or delayed.",
                color: "text-emerald-600",
                bg: "bg-emerald-600/10",
                border: "border-emerald-600/20",
              },
              {
                Icon: Scale,
                title: "Hiring decisions are inconsistent",
                desc: "Different interviewers, different standards — no reliable way to compare candidates.",
                color: "text-amber-600",
                bg: "bg-amber-600/10",
                border: "border-amber-600/20",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="p-6 rounded-2xl border border-border bg-card card-hover"
              >
                <div
                  className={`w-10 h-10 rounded-xl ${item.bg} flex items-center justify-center mb-4`}
                >
                  <item.Icon className={`w-5 h-5 ${item.color}`} />
                </div>
                <h3 className="font-semibold text-base mb-2">{item.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
          <div className="text-center mt-10 space-y-2">
            <p className="text-base font-semibold text-foreground/90">
              Lexy replaces opinions with structured evidence—so your team hires faster and with
              greater confidence.
            </p>
          </div>
        </div>
      </section>

      {/* Four Layers */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Hiring doesn't end with interviews.
              <br />
              <span className="gradient-text">Intelligence begins there.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Every interview, recruiter review, and hiring decision contributes to a growing body
              of hiring intelligence—so every future hire starts smarter than the last.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {intelligenceLayers.map((layer) => {
              const Icon = layer.icon;
              return (
                <div
                  key={layer.title}
                  className="p-8 rounded-2xl border border-border bg-card card-hover"
                >
                  <div
                    className={`w-12 h-12 rounded-xl ${layer.bg} flex items-center justify-center mb-5`}
                  >
                    <Icon className={`w-6 h-6 ${layer.color}`} />
                  </div>
                  <h3 className="font-semibold text-lg mb-3">{layer.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{layer.desc}</p>
                </div>
              );
            })}
          </div>
          <p className="text-center mt-10 text-base font-semibold gradient-text">
            Every validated hiring decision strengthens your organization's hiring intelligence for
            the next role.
          </p>
        </div>
      </section>

      {/* Benefits SEO block */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
            <div>
              <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
                Hire faster — <span className="gradient-text">with real signals, not resumes</span>
              </h2>
              <p className="text-muted-foreground text-lg mb-8 leading-relaxed">
                Lexy replaces resume screening with structured interviews that generate evidence—not
                assumptions—helping recruiters make faster, more confident hiring decisions.
              </p>
              <ul className="space-y-4">
                {benefits.map((b) => (
                  <li key={b} className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
                    <span className="text-muted-foreground">{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="p-8 rounded-3xl border border-primary/20 bg-primary/5 self-center">
              <div className="space-y-4">
                {[
                  { label: "Role Alignment", value: "94%", w: "94%", color: "bg-primary" },
                  {
                    label: "Communication Evidence",
                    value: "Strong",
                    w: "88%",
                    color: "bg-primary",
                  },
                  { label: "Problem Solving", value: "High", w: "82%", color: "bg-primary" },
                  {
                    label: "Leadership Behaviors",
                    value: "Emerging",
                    w: "55%",
                    color: "bg-primary",
                  },
                  {
                    label: "Recruiter Recommendation",
                    value: "Advance",
                    w: "85%",
                    color: "bg-primary",
                  },
                ].map((score) => (
                  <div key={score.label}>
                    <div className="flex justify-between text-sm mb-2">
                      <span className="text-muted-foreground">{score.label}</span>
                      <span className="font-semibold text-foreground">{score.value}</span>
                    </div>
                    <div className="h-2 rounded-full bg-black/10">
                      <div
                        className={`h-2 rounded-full ${score.color}`}
                        style={{ width: score.w }}
                      />
                    </div>
                  </div>
                ))}
                <div className="mt-5 pt-4 border-t border-border/50 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Recruiter Validation</span>
                  <span className="text-xs font-semibold px-3 py-1 rounded-full bg-emerald-600/10 text-emerald-600 border border-emerald-600/20">
                    ✓ Recruiter Approved
                  </span>
                </div>
                <p className="text-xs text-muted-foreground/60 text-center pt-1">
                  Every candidate measured the same way — clear, comparable signals
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Hiring Flow */}
      <section id="how-it-works" className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Evidence becomes <span className="gradient-text">intelligence.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Instead of losing hiring knowledge after every interview, Lexy captures, validates,
              and compounds it into hiring intelligence your organization owns.
            </p>
          </div>

          <div className="relative lg:pb-16">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-0">
              {[
                {
                  step: "01",
                  label: "Define Success",
                  desc: "Create structured success criteria before hiring begins",
                  color: "text-primary",
                  bg: "bg-primary/10",
                  border: "border-primary/20",
                },
                {
                  step: "02",
                  label: "Generate Evidence",
                  desc: "Interview candidates and generate structured signals",
                  color: "text-violet-600",
                  bg: "bg-violet-600/10",
                  border: "border-violet-600/20",
                },
                {
                  step: "03",
                  label: "Recruiter Validation",
                  desc: "Human recruiters review, validate, and decide",
                  color: "text-emerald-600",
                  bg: "bg-emerald-600/10",
                  border: "border-emerald-600/20",
                },
                {
                  step: "04",
                  label: "Build Hiring Intelligence",
                  desc: "Every validated hiring decision becomes organizational knowledge",
                  color: "text-amber-600",
                  bg: "bg-amber-600/10",
                  border: "border-amber-600/20",
                },
              ].map((item, i, arr) => (
                <div key={item.step} className="flex items-stretch">
                  <div className="flex-1 p-7 rounded-2xl border border-border bg-card card-hover">
                    <div
                      className={`text-xs font-semibold tracking-widest uppercase mb-3 ${item.color}`}
                    >
                      {item.step}
                    </div>
                    <h3 className="font-semibold text-base mb-2">{item.label}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                  </div>
                  {i < arr.length - 1 && (
                    <div className="hidden lg:flex items-center px-2 text-muted-foreground/30">
                      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                        <path
                          d="M4 10h12M12 5l5 5-5 5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <svg
              className="hidden lg:block absolute left-0 right-0 bottom-0 w-full h-14 text-primary/40"
              viewBox="0 0 1000 60"
              preserveAspectRatio="none"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M878 0 C878 48, 122 48, 122 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="6 6"
              />
              <path
                d="M114 20 L122 6 L130 20"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
              />
            </svg>
          </div>
          <div className="mt-10 flex items-center justify-center gap-3 text-muted-foreground">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" className="text-primary">
              <path
                d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66M17.66 6.34H21V3M6.34 17.66H3V21"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-sm font-medium">
              Every validated decision feeds back into defining success —{" "}
              <strong className="font-semibold text-foreground">a flywheel, not a pipeline.</strong>
            </span>
          </div>
        </div>
      </section>

      {/* Dashboard Section */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div className="p-8 rounded-3xl border border-border/50 bg-card order-2 lg:order-1">
              <div className="flex items-center gap-3 mb-6">
                <LayoutDashboard className="w-5 h-5 text-primary" />
                <span className="text-sm font-medium text-muted-foreground">Hiring Dashboard</span>
              </div>
              <ul className="divide-y divide-border/50">
                {[
                  { label: "Role Alignment", value: "94%" },
                  { label: "Communication", value: "Strong" },
                  { label: "Problem Solving", value: "High" },
                  { label: "Leadership", value: "Emerging" },
                ].map((row) => (
                  <li key={row.label} className="flex items-center justify-between py-3">
                    <span className="text-sm text-muted-foreground">{row.label}</span>
                    <span className="text-sm font-semibold text-foreground">{row.value}</span>
                  </li>
                ))}
                <li className="flex items-center justify-between py-3">
                  <span className="text-sm text-muted-foreground">Recruiter Validation</span>
                  <span className="text-sm font-semibold text-emerald-600 flex items-center gap-1">
                    <CheckCircle className="w-4 h-4" /> Complete
                  </span>
                </li>
                <li className="flex items-center justify-between py-3">
                  <span className="text-sm text-muted-foreground">Recommendation</span>
                  <span className="text-xs font-semibold px-3 py-1 rounded-full bg-amber-600/10 text-amber-600 border border-amber-600/20">
                    Recruiter Review Awaiting
                  </span>
                </li>
              </ul>
            </div>
            <div className="order-1 lg:order-2">
              <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
                Everything you need to make the right hiring decision —{" "}
                <span className="gradient-text">in one place</span>
              </h2>
              <p className="text-muted-foreground text-lg leading-relaxed mb-4">
                Lexy gives every recruiter a complete view of candidate evidence, hiring risks, and
                next-best actions—so every decision is faster, clearer, and backed by structured
                signals.
              </p>
              <p className="text-base font-semibold text-foreground/80">
                No resume reviews. No guesswork. Just clear decisions.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Why Lexy */}
      <section id="why-lexy" className="py-24 px-6 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Traditional hiring is broken.
              <br />
              <span className="gradient-text">Here's what replaces it.</span>
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {differentiators.map((d) => {
              const Icon = d.icon;
              return (
                <div
                  key={d.title}
                  className="p-8 rounded-2xl border border-border bg-card card-hover"
                >
                  <div
                    className={`w-12 h-12 rounded-xl ${d.bg} flex items-center justify-center mb-5`}
                  >
                    <Icon className={`w-6 h-6 ${d.color}`} />
                  </div>
                  <h3 className="font-semibold text-lg mb-3">{d.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">{d.desc}</p>
                </div>
              );
            })}
          </div>
          <div className="text-center mt-12 space-y-3">
            <p className="text-base font-semibold text-foreground/90">
              Most hiring tools track the process.{" "}
              <span className="gradient-text">Lexy drives the decision.</span>
            </p>
            <p className="text-sm font-medium text-primary tracking-wide">
              Structured Evidence. Human Validation. Compounding Hiring Intelligence.
            </p>
          </div>
        </div>
      </section>

      {/* Candidate Experience */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
            The Best Candidates Don't Wait.
            <br />
            <span className="gradient-text">Your Process Shouldn't Either.</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-12 leading-relaxed">
            Top candidates drop off when hiring is slow, unclear, or fragmented. Lexy fixes the
            experience end-to-end — so you engage faster, reduce ghosting, and convert better
            candidates.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
            {[
              {
                Icon: Bot,
                label: "Clear Candidate Signals — From Day One",
                sub: "Profiles built from interviews, not resumes.",
                color: "text-primary",
                bg: "bg-primary/10",
                border: "border-primary/20",
              },
              {
                Icon: MessageCircle,
                label: "No More Candidate Drop-Off",
                sub: "Fast, consistent communication at every step.",
                color: "text-violet-600",
                bg: "bg-violet-600/10",
                border: "border-violet-600/20",
              },
              {
                Icon: CalendarCheck,
                label: "Faster Interviews. Zero Friction.",
                sub: "Scheduling handled automatically — no back-and-forth.",
                color: "text-emerald-600",
                bg: "bg-emerald-600/10",
                border: "border-emerald-600/20",
              },
              {
                Icon: Activity,
                label: "Keep Candidates Engaged — Always",
                sub: "Real-time updates so no one is left in the dark.",
                color: "text-amber-600",
                bg: "bg-amber-600/10",
                border: "border-amber-600/20",
              },
            ].map((item) => (
              <div
                key={item.label}
                className="p-6 rounded-2xl border border-border bg-card card-hover text-center"
              >
                <div
                  className={`w-10 h-10 rounded-xl ${item.bg} flex items-center justify-center mx-auto mb-4`}
                >
                  <item.Icon className={`w-5 h-5 ${item.color}`} />
                </div>
                <p className="text-sm font-semibold mb-1">{item.label}</p>
                <p className="text-xs text-muted-foreground leading-relaxed">{item.sub}</p>
              </div>
            ))}
          </div>
          <p className="text-base font-semibold text-foreground/80 mt-10 max-w-2xl mx-auto">
            The best candidates aren't rejecting your offer —<br />
            <span className="gradient-text">they're dropping off before you get there.</span>
          </p>
        </div>
      </section>

      {/* CTA */}
      <section id="cta" className="py-24 px-6 border-t border-border/50">
        <div className="max-w-3xl mx-auto text-center">
          <div className="p-12 rounded-3xl border border-primary/20 bg-primary/5 glow-primary">
            <Sparkles className="w-10 h-10 text-primary mx-auto mb-6" />
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Make Faster Hiring Decisions —<br />
              <span className="gradient-text">With Real Candidate Signals</span>
            </h2>
            <p className="text-muted-foreground text-lg mb-4 max-w-xl mx-auto leading-relaxed">
              Lexy replaces resume screening and manual workflows with real candidate evaluation —
              so your team moves faster, hires better, and makes confident decisions.
            </p>
            <p className="text-sm text-muted-foreground/60 mb-8">
              Built for teams that want to move from screening to decision-making.
            </p>
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={openDemo}
                className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105"
              >
                Book a Demo
                <ArrowRight className="w-5 h-5" />
              </button>
              <p className="text-xs text-muted-foreground/50">See it in action in 15 minutes.</p>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
