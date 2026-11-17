import SiteFooter from "@/components/SiteFooter";
import ProductCapabilities from "@/components/ProductCapabilities";
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
              <h3 className="text-2xl font-semibold mb-1.5">Request a Demo</h3>
              <p className="text-sm text-muted-foreground">
                Leave your details and our team will contact you to arrange a time.
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
      src={`${import.meta.env.BASE_URL}lexy-ai-logo-navy-blue.png`}
      alt="L3xy AI"
      className={`${cls} w-auto object-contain select-none`}
      draggable={false}
    />
  );
}

function Nav({ onBookDemo }: { onBookDemo: () => void }) {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-slate-200 bg-white">
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
          <a href="#integrations" className="hover:text-foreground transition-colors">
            Integrations
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
              Guided Trial
            </button>
          </Link>
          <button
            onClick={onBookDemo}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Request a Demo
          </button>
        </div>
      </div>
    </nav>
  );
}

const intelligenceLayers = [
  {
    icon: Target,
    title: "Agree what good looks like first",
    desc: "Lexy turns your job description into clear success criteria and interview questions. Your team edits and approves them before any candidate is assessed.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Users,
    title: "Collect evidence, not impressions",
    desc: "Interview answers, scores against each criterion, and recruiter notes sit together for every candidate, so comparisons are like for like.",
    color: "text-navy",
    bg: "bg-navy/10",
    border: "border-navy/20",
  },
  {
    icon: Brain,
    title: "Recommendations you can question",
    desc: "Every recommendation shows its reasons. Recruiters can disagree, add context, and make a different call.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: Zap,
    title: "Fewer candidates left waiting",
    desc: "Reviewed invitations, follow-ups and scheduling from your offered times help candidates keep moving instead of going quiet.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
];

const agents = [
  {
    icon: Target,
    name: "Role profile",
    desc: "Drafts an ideal candidate profile and success criteria from your job description, for your team to edit.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Search,
    name: "Sourcing",
    desc: "Looks for potential candidates in the sources enabled for your workspace, alongside the applicants you bring.",
    color: "text-navy",
    bg: "bg-navy/10",
    border: "border-navy/20",
  },
  {
    icon: ClipboardCheck,
    name: "Screening",
    desc: "Reads resumes against the role, with personal details hidden, and explains how each one lines up.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: Mic,
    name: "Interviewer",
    desc: "Runs structured interviews, asks follow-up questions, and scores answers against your criteria.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
  {
    icon: Eye,
    name: "Interview integrity",
    desc: "Flags unusual interview behaviour for a person to look at. A flag is never a decision on its own.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: BadgeCheck,
    name: "Profile checks",
    desc: "Points out details in a candidate's profile that may need a closer look, so your team can follow up.",
    color: "text-navy",
    bg: "bg-navy/10",
    border: "border-navy/20",
  },
  {
    icon: Mail,
    name: "Outreach",
    desc: "Drafts engagement and interview campaigns. Your team reviews and approves them before they are sent.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: Bell,
    name: "Follow-up",
    desc: "Suggests timely reminders when a candidate has not replied, within the limits you set.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
  {
    icon: Calendar,
    name: "Scheduling",
    desc: "Lets candidates choose from the interview times your team offered, and sends reminders.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: BarChart3,
    name: "Reporting",
    desc: "Shows where candidates are in each role and how your process is running.",
    color: "text-navy",
    bg: "bg-navy/10",
    border: "border-navy/20",
  },
];

const howItWorks = [
  {
    num: "01",
    title: "Set up the role",
    desc: "Lexy drafts success criteria and interview questions from your job description. You approve them.",
  },
  {
    num: "02",
    title: "Find or bring candidates",
    desc: "Source new candidates, upload your own applicants, or bring selected candidates across from a connected ATS.",
  },
  {
    num: "03",
    title: "Invite, after review",
    desc: "Lexy prepares engagement and interview campaigns. Your team reviews them before anything is sent.",
  },
  {
    num: "04",
    title: "Interview consistently",
    desc: "Candidates take a structured interview and book any live conversations from the times you offered.",
  },
  {
    num: "05",
    title: "Review the evidence and decide",
    desc: "Recruiters and hiring managers see answers, scores and reasons, then decide who moves forward.",
  },
  {
    num: "06",
    title: "Make the offer your way",
    desc: "Offers are prepared, approved and sent by your HR team. Lexy does not send offers on its own.",
  },
];

const benefits = [
  "Every candidate for a role answers the same core questions.",
  "Scores come with the answers and reasons behind them.",
  "Recruiters review outreach before it reaches candidates.",
  "Hiring managers decide, with the evidence in front of them.",
];

const differentiators = [
  {
    icon: Brain,
    title: "Fair comparisons",
    desc: "Structured interviews give every candidate the same chance to show what they can do, and give your team comparable evidence.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Zap,
    title: "Less admin for recruiters",
    desc: "Lexy drafts, screens, interviews and schedules. Recruiters spend their time reviewing evidence and talking to people.",
    color: "text-navy",
    bg: "bg-navy/10",
    border: "border-navy/20",
  },
  {
    icon: Layers,
    title: "Fits around your ATS",
    desc: "Run Lexy on its own, or connect Zoho Recruit or Greenhouse so your ATS stays the system of record.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: TrendingUp,
    title: "Clear next steps",
    desc: "For each candidate, Lexy suggests what to do next and explains why. Your team chooses whether to follow it.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
];

const stats = [
  { value: "Source", label: "or bring your own applicants" },
  { value: "Interview", label: "with the same structure for all" },
  { value: "Review", label: "answers, scores and reasons" },
  { value: "Decide", label: "people make the call" },
];

const integrations = [
  {
    name: "Zoho Recruit",
    available: [
      "Bring selected candidates into Lexy for your team to review",
      "Run Lexy interviews for those candidates",
      "Send progress and approved assessment results back to Zoho Recruit",
    ],
    later:
      "Steps that would move candidates between stages inside Zoho Recruit stay switched off until they are set up and approved with your team.",
  },
  {
    name: "Greenhouse",
    available: [
      "Review the controlled employer-owned handoff workflow with our team",
      "Plan how Greenhouse remains your system of record",
    ],
    later:
      "Connected Greenhouse workflows require additional configuration and acceptance before activation. Connected financial offers are not available; your team manages offers in your own process.",
  },
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
    title: "Lexy for Employers | Your AI Hiring Team, Run by Your Recruiters",
    description:
      "Source or bring applicants, send reviewed interview campaigns, run structured interviews and review evidence, while your people make every decision. Works on its own or with Zoho Recruit or Greenhouse.",
    path: "/employers",
  });
  const [showDemo, setShowDemo] = useState(false);
  const openDemo = () => setShowDemo(true);

  // Footer/pricing demo-request CTAs deep-link here with ?demo=1 — open the
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
      <section className="hero-navy pt-40 pb-24 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-widest mb-8">
            <Sparkles className="w-3 h-3" />
            For Employers
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.1] mb-6">
            Your AI hiring team.
            <br />
            <span className="gradient-text text-glow">Your people make the calls.</span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-3xl mx-auto mb-4 leading-relaxed">
            Lexy finds and screens candidates, sends interview invitations your team has approved,
            runs structured interviews and lays out the evidence. Recruiters and hiring managers
            decide. HR owns the offer.
          </p>

          <p className="text-base font-semibold text-primary mb-10">
            Use it on its own, or ask about selected ATS-connected workflows.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/start-trial">
              <button className="flex items-center gap-2 px-6 py-3.5 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary">
                Request a Guided Trial
                <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
            <button
              onClick={openDemo}
              className="flex items-center gap-2 px-6 py-3.5 rounded-xl text-base font-medium border border-border hover:border-primary/40 transition-colors text-muted-foreground hover:text-foreground"
            >
              Request a Demo
            </button>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mt-20 pt-12 border-t border-border/50">
            {stats.map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-2xl sm:text-3xl font-semibold text-emerald-600 mb-1">{s.value}</div>
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
              Where hiring weeks <span className="gradient-text">actually go.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Much of a recruiter's week goes on work that has to be done but does not need their
              judgement. That leaves less time for the decisions that do.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {[
              {
                Icon: Timer,
                title: "Admin crowds out judgement",
                desc: "Screening, chasing replies and booking calls take hours that could go on candidates.",
                color: "text-primary",
                bg: "bg-primary/10",
                border: "border-primary/20",
              },
              {
                Icon: Frown,
                title: "Candidates go quiet",
                desc: "Long gaps between messages make good people lose interest.",
                color: "text-navy",
                bg: "bg-navy/10",
                border: "border-navy/20",
              },
              {
                Icon: Crosshair,
                title: "Resumes only say so much",
                desc: "A well-formatted CV is not the same as being good at the job.",
                color: "text-emerald-600",
                bg: "bg-emerald-600/10",
                border: "border-emerald-600/20",
              },
              {
                Icon: Scale,
                title: "Interviews are hard to compare",
                desc: "Different interviewers ask different questions, so decisions rest on uneven notes.",
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
              Lexy takes on the repetitive steps and gives your team consistent evidence to decide
              with.
            </p>
          </div>
        </div>
      </section>

      {/* Four Layers */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Clear criteria in.
              <br />
              <span className="gradient-text">Comparable evidence out.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Your team sets the standard for each role. Lexy applies it the same way to every
              candidate and shows its working.
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
            Lexy recommends. Your people decide.
          </p>
        </div>
      </section>

      {/* Benefits SEO block */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-start">
            <div>
              <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
                What a reviewer <span className="gradient-text">sees for each candidate</span>
              </h2>
              <p className="text-muted-foreground text-lg mb-8 leading-relaxed">
                Instead of a stack of CVs and scattered notes, your team gets one consistent view of
                each candidate's interview, with the reasoning written out.
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
            <div className="marketing-panel p-8 rounded-3xl self-center">
              <div className="space-y-4">
                {[
                  { label: "Role criteria met", value: "Most", w: "84%", color: "bg-primary" },
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
                    label: "Lexy suggestion",
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
                  <span className="text-xs text-muted-foreground">Decision</span>
                  <span className="text-xs font-semibold px-3 py-1 rounded-full bg-emerald-600/10 text-emerald-600 border border-emerald-600/20">
                    Recruiter to decide
                  </span>
                </div>
                <p className="text-xs text-muted-foreground/60 text-center pt-1">
                  Illustrative example. Every score links back to the answer behind it.
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
              The employer journey, <span className="gradient-text">step by step.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              From the job description to the offer, with your team in charge at each step.
            </p>
          </div>

          <div className="relative">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-y-4">
              {howItWorks
                .map((h, idx) => ({
                  step: h.num,
                  label: h.title,
                  desc: h.desc,
                  color: ["text-primary", "text-navy", "text-emerald-600"][idx % 3],
                }))
                .map((item, i, arr) => (
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
                  {i < arr.length - 1 && (i + 1) % 3 !== 0 && (
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
              Lexy does the legwork at each step —{" "}
              <strong className="font-semibold text-foreground">people approve, decide and offer.</strong>
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
                  { label: "Role criteria", value: "Mostly met" },
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
                  <span className="text-sm text-muted-foreground">Recruiter notes</span>
                  <span className="text-sm font-semibold text-emerald-600 flex items-center gap-1">
                    <CheckCircle className="w-4 h-4" /> Added
                  </span>
                </li>
                <li className="flex items-center justify-between py-3">
                  <span className="text-sm text-muted-foreground">Decision</span>
                  <span className="text-xs font-semibold px-3 py-1 rounded-full bg-amber-600/10 text-amber-600 border border-amber-600/20">
                    Awaiting hiring manager
                  </span>
                </li>
              </ul>
            </div>
            <div className="order-1 lg:order-2">
              <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
                One place to review each candidate —{" "}
                <span className="gradient-text">and decide together</span>
              </h2>
              <p className="text-muted-foreground text-lg leading-relaxed mb-4">
                Recruiters and hiring managers see the interview evidence, anything flagged for a
                closer look, and Lexy's suggested next step with its reasons. Then they decide.
              </p>
              <p className="text-base font-semibold text-foreground/80">
                Illustrative example. Your criteria and wording will differ.
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
              Meet your <span className="gradient-text">AI hiring team.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Each specialist handles one part of the work. None of them makes a hiring decision.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-16">
            {agents.map((a) => {
              const Icon = a.icon;
              return (
                <div key={a.name} className="p-5 rounded-2xl border border-border bg-card card-hover">
                  <div
                    className={`w-10 h-10 rounded-xl ${a.bg} flex items-center justify-center mb-3`}
                  >
                    <Icon className={`w-5 h-5 ${a.color}`} />
                  </div>
                  <h3 className="font-semibold text-sm mb-1.5">{a.name}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{a.desc}</p>
                </div>
              );
            })}
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
              Lexy does the legwork.{" "}
              <span className="gradient-text">Your people make the decisions.</span>
            </p>
            <p className="text-sm font-medium text-primary tracking-wide">
              Reviewed outreach. Structured interviews. Human decisions. HR-owned offers.
            </p>
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section id="integrations" className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              On its own, <span className="gradient-text">or with your ATS.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Run your hiring workflow in Lexy, or discuss an ATS-connected setup.
              Our initial focus is Zoho Recruit and Greenhouse, with different capabilities and
              readiness for each. We review setup and acceptance requirements with your team
              before activating a connected workflow.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {integrations.map((it) => (
              <div key={it.name} className="p-8 rounded-2xl border border-border bg-card card-hover">
                <h3 className="font-semibold text-lg mb-4">{it.name}</h3>
                <p className="text-xs font-semibold uppercase tracking-widest text-primary/70 mb-3">
                  What the connection covers
                </p>
                <ul className="space-y-2.5 mb-6">
                  {it.available.map((a) => (
                    <li key={a} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                      <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                      {a}
                    </li>
                  ))}
                </ul>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                  Good to know
                </p>
                <p className="text-sm text-muted-foreground leading-relaxed">{it.later}</p>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-muted-foreground mt-8 max-w-2xl mx-auto">
            Using a different ATS? Lexy works on its own, and you can upload your applicants
            directly. Tell us what you use when you request a trial.
          </p>
        </div>
      </section>

      <ProductCapabilities audience="employers" />

      {/* Candidate Experience */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
            A better experience
            <br />
            <span className="gradient-text">for the people you interview.</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-12 leading-relaxed">
            Candidates notice when a process is clear and respectful. Lexy helps you keep in touch,
            keep interviews consistent, and keep scheduling simple.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
            {[
              {
                Icon: Bot,
                label: "The same questions for everyone",
                sub: "Each candidate gets a fair, structured interview.",
                color: "text-primary",
                bg: "bg-primary/10",
                border: "border-primary/20",
              },
              {
                Icon: MessageCircle,
                label: "Messages your team approved",
                sub: "Invitations and follow-ups are reviewed before sending.",
                color: "text-navy",
                bg: "bg-navy/10",
                border: "border-navy/20",
              },
              {
                Icon: CalendarCheck,
                label: "Times that actually work",
                sub: "Candidates pick from slots your team offered.",
                color: "text-emerald-600",
                bg: "bg-emerald-600/10",
                border: "border-emerald-600/20",
              },
              {
                Icon: Activity,
                label: "Clear next steps",
                sub: "Candidates know where they stand in your process.",
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
            Employer interviews are separate from Lexy's candidate coaching.<br />
            <span className="gradient-text">A candidate's private practice is never part of your assessment.</span>
          </p>
        </div>
      </section>

      {/* CTA */}
      <section id="cta" className="py-24 px-6 border-t border-border/50">
        <div className="max-w-3xl mx-auto text-center">
          <div className="marketing-panel p-12 rounded-3xl">
            <Sparkles className="w-10 h-10 text-primary mx-auto mb-6" />
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Try your AI hiring team<br />
              <span className="gradient-text">on one of your real roles</span>
            </h2>
            <p className="text-muted-foreground text-lg mb-4 max-w-xl mx-auto leading-relaxed">
              Request a guided trial and we will review your request, then set up a workspace
              around a role you are hiring for. Prefer a conversation first? Request a demo.
            </p>
            <p className="text-sm text-muted-foreground/60 mb-8">
              Trial requests are reviewed by our team. Plans and prices are on the pricing page.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Link href="/start-trial">
                <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105">
                  Request a Guided Trial
                  <ArrowRight className="w-5 h-5" />
                </button>
              </Link>
              <button
                onClick={openDemo}
                className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-medium border border-border hover:border-primary/40 transition-colors text-muted-foreground hover:text-foreground"
              >
                Request a Demo
              </button>
            </div>
            <p className="text-xs text-muted-foreground mt-4">
              Looking for your next role instead?{" "}
              <Link href="/candidates" className="text-primary underline underline-offset-2">
                See Lexy for candidates
              </Link>
            </p>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
