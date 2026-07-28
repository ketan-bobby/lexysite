import SiteFooter from "@/components/SiteFooter";
/*
 * candidates.tsx — Public "for candidates" marketing landing page.
 *
 * Mostly static marketing content (hero, problem/solution sections, value
 * cards, how-it-works steps, and a looping demo video player). The primary
 * CTA points candidates at /career-register in the main app. Content arrays
 * (coreCards, steps, benefits, etc.) drive the repeated card/list sections.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { useRef, useState } from "react";
import {
  Sparkles,
  ArrowRight,
  ArrowLeft,
  User,
  Mic,
  Target,
  TrendingUp,
  ChevronRight,
  Star,
  Zap,
  Brain,
  BarChart3,
  MessageSquare,
  CheckCircle,
  Briefcase,
  Volume2,
  Rocket,
  Eye,
  ShieldCheck,
  TrendingDown,
  AlertCircle,
} from "lucide-react";

// Base URL of the main Lexy app (candidate portal / career registration).
// In this workspace the app is served at the domain root, so "" (root-relative
// links) works. On a standalone marketing-site deployment where the app lives
// on another domain, set VITE_MAIN_APP_URL (e.g. "https://app.l3xy.ai").
const MAIN_APP = import.meta.env.VITE_MAIN_APP_URL || "https://app.l3xy.ai";

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

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 backdrop-blur-xl bg-background/80">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link href="/">
          <div className="flex items-center hover:opacity-80 transition-opacity cursor-pointer">
            <LexyLogo size="md" />
          </div>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/">
            <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" /> Back to overview
            </button>
          </Link>
          <a href={`${MAIN_APP}/career-register`}>
            <button className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              Start My AI Interview
            </button>
          </a>
        </div>
      </div>
    </nav>
  );
}

const coreCards = [
  {
    icon: User,
    title: "Build Your Lexy Hiring Profile",
    desc: "Know exactly what employers see — a living profile built on how you perform, not what you list.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Mic,
    title: "Practice Before It Counts",
    desc: "Walk into interviews with confidence — practice real scenarios until you're ready.",
    color: "text-violet-600",
    bg: "bg-violet-600/10",
    border: "border-violet-600/20",
  },
  {
    icon: Target,
    title: "Find Roles You Can Actually Win",
    desc: "Stop wasting time on the wrong jobs — see opportunities that match your actual ability.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: TrendingUp,
    title: "Know Your Next Best Move",
    desc: "Understand your next moves, skill gaps, and how to move forward faster.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
];

const steps = [
  {
    num: "01",
    title: "Prove what you can actually do",
    desc: "Start with a short AI interview that evaluates how you think, communicate, and solve problems.",
  },
  {
    num: "02",
    title: "Know where you stand",
    desc: "Lexy builds your career identity based on real signals — not resumes or keywords.",
  },
  {
    num: "03",
    title: "Improve before it matters",
    desc: "Practice, get feedback, and increase your chances before your next real interview.",
  },
  {
    num: "04",
    title: "Find roles you can actually win",
    desc: "Get matched to opportunities where your skills, readiness, and strengths truly align.",
  },
];

const benefits = [
  {
    icon: Star,
    title: "A Profile That Grows With You",
    desc: "Your career profile evolves as you interview, learn, and explore new opportunities.",
  },
  {
    icon: MessageSquare,
    title: "Interview Coaching Built In",
    desc: "Improve your communication, structure, and confidence with every practice session.",
  },
  {
    icon: Brain,
    title: "Career Direction, Not Guesswork",
    desc: "Understand what roles you can target now and what you need to improve.",
  },
  {
    icon: BarChart3,
    title: "Better Visibility Into Opportunities",
    desc: "Get access to roles aligned with your skills and aspirations.",
  },
];

const seoPoints = [
  "Complete a structured interview that measures how you think, communicate, and solve problems",
  "Build a hiring profile based on evidence",
  "Discover your strengths, gaps, and employability",
  "Match with opportunities aligned to your abilities",
];

const careerInsights = [
  "Know which roles you're most likely to land",
  "See exactly what separates you from your next promotion",
  "Know the few skills that will have the biggest impact",
  "Apply where your strengths actually match the role",
];

const interviewFeatures = [
  "Role-specific mock interviews",
  "Behavioral and technical questions",
  "Instant feedback on answers",
  "Readiness insights",
];

const readinessFeatures = [
  {
    title: "Role-specific interviews",
    desc: "Not generic practice — real scenarios based on the roles you want.",
  },
  {
    title: "Real performance",
    desc: "Behavioral and technical signals, not rehearsed answers.",
  },
  {
    title: "Actionable feedback",
    desc: "Understand exactly what to improve — immediately.",
  },
  { title: "Progress over time", desc: "See how close you are to getting hired." },
];

function LexyVideoPlayer() {
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
        {/* Circle crop */}
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
            src={`${import.meta.env.BASE_URL}lexy-demo.mp4`}
            autoPlay
            muted
            loop
            playsInline
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "center 48%",
              display: "block",
            }}
          />
        </div>

        {/* Unmute toggle */}
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

export default function Candidates() {
  usePageMeta({
    title: "Get Hired for What You Can Actually Do",
    description:
      "Complete one AI interview and build a living candidate profile. Show employers verified proof of your skills — not just a resume.",
    path: "/candidates",
  });
  return (
    <div className="min-h-screen mesh-bg">
      <Nav />

      {/* ── HERO ──────────────────────────────────────────────────────────── */}
      <section className="pt-40 pb-28 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-8">
            <Sparkles className="w-3 h-3" /> Interview-Based Hiring
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.1] mb-6 text-balance">
            Get hired for what you can do —{" "}
            <span className="gradient-text text-glow">not just what your resume says.</span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            Skip resume filters. Show what you can actually do—and get matched to opportunities
            based on evidence, not keywords.
          </p>

          <p className="text-sm text-muted-foreground max-w-2xl mx-auto -mt-6 mb-10">
            Every candidate is evaluated using the same structured interview process.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-7 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary">
                Start My AI Interview
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-7 py-4 rounded-xl text-base font-medium border border-border hover:border-primary/40 transition-colors text-muted-foreground hover:text-foreground">
                <Mic className="w-5 h-5" /> Practice Before You Apply
              </button>
            </a>
          </div>

          <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
            <p>Takes 10 minutes. Changes how you get hired.</p>
            <p>See your strengths, gaps, and best-fit roles instantly.</p>
          </div>
        </div>
      </section>

      {/* ── HIRING IS CHANGING ────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          {/* Headline */}
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-widest mb-6">
              <AlertCircle className="w-3 h-3" /> The Landscape Has Shifted
            </div>
            <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-6">
              The Hiring Game Has Changed —{" "}
              <span className="gradient-text">Most Candidates Don't Realize It</span>
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              Most candidates are invisible in today's hiring process.
            </p>
          </div>

          {/* Problem grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-12">
            <div className="p-7 rounded-2xl border border-border/50 bg-card space-y-4">
              <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <TrendingDown className="w-4 h-4 text-primary" />
              </div>
              <h3 className="text-lg font-semibold">Your Resume Is Not Getting You Seen</h3>
              <p className="text-muted-foreground leading-relaxed text-sm">
                Your resume opens the door—but employers increasingly make decisions based on
                interviews, communication, and demonstrated capability.
              </p>
            </div>
            <div className="p-7 rounded-2xl border border-border/50 bg-card space-y-4">
              <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <AlertCircle className="w-4 h-4 text-primary" />
              </div>
              <h3 className="text-lg font-semibold">Applying More Is Making It Worse</h3>
              <p className="text-muted-foreground leading-relaxed text-sm">
                Sending more applications doesn't automatically improve your chances. Standing out
                does.
              </p>
            </div>
          </div>

          {/* Bold callout */}
          <div className="text-center p-10 rounded-3xl border border-primary/20 bg-gradient-to-br from-primary/5 to-transparent mb-16">
            <p className="text-2xl sm:text-3xl font-semibold leading-snug">
              Applying to more jobs isn't the answer.
            </p>
            <p className="text-2xl sm:text-3xl font-semibold leading-snug mt-1">
              <span className="gradient-text">Standing out is.</span>
            </p>
            <p className="text-lg text-muted-foreground mt-5 font-medium">
              Being prepared is what actually gets you hired.
            </p>
            <p className="text-lg text-muted-foreground mt-2 font-medium">
              The goal isn't to apply to more jobs. It's to become the candidate employers remember.
            </p>
          </div>

          {/* Stay Ahead section */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center mb-20">
            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary/50 text-[10px] font-medium uppercase tracking-widest mb-5">
                <Zap className="w-2.5 h-2.5" /> Stay Ahead With Lexy
              </div>
              <h3 className="text-2xl sm:text-3xl font-semibold mb-4">
                Know where you stand —{" "}
                <span className="gradient-text">and how to actually get hired.</span>
              </h3>
              <p className="text-primary font-semibold mb-3">
                Most platforms help you apply. Lexy helps you get hired.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                Stop guessing. See your strengths, fix your gaps, and focus only on roles you can
                actually land.
              </p>
            </div>
            <ul className="space-y-4">
              {[
                {
                  icon: Eye,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Know exactly how employers see you",
                },
                {
                  icon: Target,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Improve the skills employers actually reward",
                },
                {
                  icon: Mic,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Practice before the interview counts",
                },
                {
                  icon: TrendingUp,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Receive actionable feedback after every interview",
                },
                {
                  icon: Briefcase,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Apply only where you're likely to succeed",
                },
              ].map(({ icon: Icon, color, bg, text }) => (
                <li key={text} className="flex items-center gap-4">
                  <div
                    className={`w-9 h-9 rounded-xl border flex items-center justify-center shrink-0 ${bg}`}
                  >
                    <Icon className={`w-4 h-4 ${color}`} />
                  </div>
                  <span className="text-sm font-medium text-foreground/90">{text}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground/50 mt-5 text-right italic">
              No more applying blindly. No more wasted effort.
            </p>
          </div>

          {/* Manifesto block */}
          <div className="relative p-10 sm:p-14 rounded-3xl border border-border/40 bg-card overflow-hidden mb-16">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-primary/5 pointer-events-none" />
            <div className="relative">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-widest mb-6">
                <Brain className="w-3 h-3" /> Real Hiring Signals
              </div>
              <h3 className="text-3xl sm:text-4xl lg:text-5xl font-semibold mb-6 leading-snug">
                Getting hired isn't about applying more.{" "}
                <span className="gradient-text">It's about being ready.</span>
              </h3>
              <div className="space-y-4 max-w-2xl">
                <p className="text-muted-foreground leading-relaxed">Know your strengths.</p>
                <p className="text-muted-foreground leading-relaxed">Improve your weak spots.</p>
                <p className="text-muted-foreground leading-relaxed">
                  Walk into every interview prepared.
                </p>
                <p className="text-muted-foreground leading-relaxed">
                  Your first interview isn't your final score. Every interview makes your profile
                  stronger.
                </p>
                <p className="text-muted-foreground leading-relaxed">
                  You need to know where you stand — and how to improve.
                </p>
                <p className="text-foreground/80 leading-relaxed font-medium">
                  You need real feedback, clear signals, and a system that actually moves you
                  forward.
                </p>
                <p className="text-lg font-semibold text-primary">That's what Lexy gives you.</p>
                <p className="text-xs text-muted-foreground/60 italic pt-1">
                  Built on real interview signals — not resumes or guesswork.
                </p>
              </div>
            </div>
          </div>

          {/* Move Forward closer */}
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-widest mb-8">
              <Rocket className="w-3 h-3" /> Move Forward With Confidence
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-10">
              {[
                {
                  icon: ShieldCheck,
                  color: "text-violet-600",
                  bg: "bg-violet-600/10 border-violet-600/20",
                  label: "Know exactly where you stand",
                },
                {
                  icon: TrendingUp,
                  color: "text-emerald-600",
                  bg: "bg-emerald-600/10 border-emerald-600/20",
                  label: "Improve what actually gets you hired",
                },
                {
                  icon: Rocket,
                  color: "text-amber-600",
                  bg: "bg-amber-600/10 border-amber-600/20",
                  label: "Unlock opportunities you can actually land",
                },
              ].map(({ icon: Icon, color, bg, label }) => (
                <div
                  key={label}
                  className="p-6 rounded-2xl border border-border bg-card flex flex-col items-center gap-3 text-center"
                >
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${bg}`}>
                    <Icon className={`w-5 h-5 ${color}`} />
                  </div>
                  <p className="font-semibold text-sm">{label}</p>
                </div>
              ))}
            </div>
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary mx-auto">
                Start My AI Interview
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
            <p className="text-xs text-muted-foreground mt-3">
              Free to start. No credit card required.
            </p>
          </div>
        </div>
      </section>

      {/* ── SECTION 2 — POSITIONING ───────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
            Your Resume Doesn't Tell Your Story. <span className="gradient-text">Lexy Does.</span>
          </h2>
          <div className="space-y-4 max-w-2xl mx-auto">
            <p className="text-lg text-muted-foreground leading-relaxed">
              Your resume tells employers where you've been. Lexy shows them what you're capable of.
            </p>
            <p className="text-lg text-muted-foreground leading-relaxed">
              How you think. How you communicate. How you perform. Not keywords. Not formatting.
              Just evidence.
            </p>
            <p className="text-lg font-semibold text-primary">
              This is what companies actually hire for.
            </p>
          </div>
        </div>
      </section>

      {/* ── VIDEO DEMO ────────────────────────────────────────────────────── */}
      <LexyVideoPlayer />

      {/* ── SECTION 3 — CORE VALUE ────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Your Competitive Advantage <span className="gradient-text">Starts Here</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Everything is designed to help you become the candidate employers choose.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {coreCards.map((c) => {
              const Icon = c.icon;
              return (
                <div
                  key={c.title}
                  className="p-6 rounded-2xl border border-border bg-card card-hover"
                >
                  <div
                    className={`w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center mb-4`}
                  >
                    <Icon className={`w-5 h-5 ${c.color}`} />
                  </div>
                  <h3 className="font-semibold text-base mb-2">{c.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{c.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── SECTION 4 — HOW IT WORKS ──────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              How You Get Ahead <span className="gradient-text">With Lexy</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Everything starts with one thing: showing what you can actually do.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {steps.map((step) => (
              <div
                key={step.num}
                className="p-6 rounded-2xl border border-border/60 bg-card card-hover flex flex-col gap-4"
              >
                <div className="w-10 h-10 rounded-xl bg-primary text-primary-foreground flex items-center justify-center text-sm font-semibold shrink-0">
                  {step.num}
                </div>
                <div>
                  <h3 className="font-semibold text-base mb-2 text-foreground">{step.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-12">
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary mx-auto">
                Start My AI Interview
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
          </div>
        </div>
      </section>

      {/* ── SECTION 4b — DASHBOARD PREVIEW ───────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          {/* Heading */}
          <div className="text-center mb-14">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-medium tracking-widest text-primary/60 uppercase mb-4">
              <BarChart3 className="w-3 h-3" /> Your Career Command Centre
            </span>
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Your career dashboard.{" "}
              <span className="gradient-text">Built from real interviews—not resumes.</span>
            </h2>
            <div className="space-y-3 max-w-2xl mx-auto">
              <p className="text-lg text-muted-foreground">
                Know your strengths, uncover your gaps, and discover the roles you're ready to win.
              </p>
              <p className="text-lg text-muted-foreground">
                No guesswork. No blind applying. Just clarity on how to move forward.
              </p>
              <p className="text-lg text-muted-foreground">
                Walk into every interview knowing exactly where you stand.
              </p>
              <p className="text-base font-semibold text-primary">
                This is what hiring looks like when it's built around you.
              </p>
            </div>
          </div>

          {/* Dashboard screenshot */}
          <div className="rounded-2xl overflow-hidden shadow-2xl shadow-primary/10 border border-border/30">
            <img
              src={`${import.meta.env.BASE_URL}dashboard-preview-v2.png`}
              alt="Lexy Candidate Intelligence Dashboard — showing career score, next best actions, profile strength, and interview performance"
              className="w-full block"
              style={{ imageRendering: "auto" }}
            />
          </div>

          {/* CTA below mockup */}
          <div className="text-center mt-10">
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary mx-auto">
                Start My AI Interview
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
            <p className="text-xs text-muted-foreground mt-3">
              Free to start. No credit card required.
            </p>
          </div>
        </div>
      </section>

      {/* ── SECTION 5 — SEO BLOCK ─────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4 leading-tight">
              This isn't interview prep.
              <br />
              <span className="gradient-text">It's your hiring advantage.</span>
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              Most interview tools help you practice. Lexy helps you demonstrate what employers
              actually hire for.
            </p>
          </div>

          <div className="p-8 rounded-2xl border border-border/60 bg-card text-center">
            <p className="text-muted-foreground mb-5 font-medium">What Lexy actually gives you:</p>
            <ul className="space-y-3 mb-8 inline-flex flex-col items-start">
              {seoPoints.map((pt) => (
                <li key={pt} className="flex items-center gap-3 text-sm text-foreground/80">
                  <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                  {pt}
                </li>
              ))}
            </ul>
            <div className="pt-5 border-t border-border/50 text-primary font-semibold text-lg sm:text-xl leading-relaxed">
              You stop applying blindly — and start getting real traction.
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION 6 — CAREER PATH ───────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl sm:text-4xl font-semibold mb-5 leading-tight">
                See what roles you're actually ready for
                <br />
                <span className="gradient-text">— right now</span>
              </h2>
              <p className="text-lg text-muted-foreground leading-relaxed mb-3">
                Lexy shows you which roles you're truly ready for — and what's holding you back.
              </p>
              <p className="text-base font-semibold text-foreground/80 mb-8">
                No more guessing where you stand.
              </p>
              <ul className="space-y-3">
                {careerInsights.map((insight) => (
                  <li key={insight} className="flex items-center gap-3 text-sm">
                    <ChevronRight className="w-4 h-4 text-violet-600 shrink-0" />
                    {insight}
                  </li>
                ))}
              </ul>
            </div>
            <div className="p-8 rounded-3xl border border-primary/20 bg-primary/5 glow-primary">
              <div className="space-y-4">
                {[
                  { role: "Senior Engineer", prob: 88, color: "bg-primary" },
                  { role: "Engineering Manager", prob: 71, color: "bg-primary" },
                  { role: "Staff Engineer", prob: 64, color: "bg-primary" },
                  { role: "Principal Architect", prob: 42, color: "bg-primary" },
                ].map((r) => (
                  <div key={r.role}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium">{r.role}</span>
                      <span className="text-xs text-primary">{r.prob}% match</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-border/50">
                      <div
                        className={`h-1.5 rounded-full ${r.color}`}
                        style={{ width: `${r.prob}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground/60 mt-6 text-center italic font-bold">
                Based on your actual interview performance — not your resume
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION 8 — INTERVIEW PREP ────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-amber-600/30 bg-amber-600/10 text-amber-600 text-xs font-medium mb-6">
            <Zap className="w-3 h-3" /> Readiness Engine
          </div>
          <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
            Get better before it counts — <span className="gradient-text">with real signals</span>
          </h2>
          <p className="text-lg text-muted-foreground mb-10 max-w-xl mx-auto">
            Every interaction improves your readiness — not just your confidence.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10 text-left">
            {readinessFeatures.map((f) => (
              <div key={f.title} className="p-5 rounded-xl border border-border/50 bg-card">
                <h3 className="font-semibold text-sm text-foreground mb-1">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>

          <a href={`${MAIN_APP}/career-register`}>
            <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary mx-auto">
              Start My AI Interview
              <ArrowRight className="w-5 h-5" />
            </button>
          </a>
        </div>
      </section>

      {/* ── SECTION 9 — FINAL CTA ─────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-3xl mx-auto text-center">
          <div className="p-14 rounded-3xl border border-primary/20 bg-primary/5 glow-primary">
            <Sparkles className="w-10 h-10 text-primary mx-auto mb-6" />
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Your Resume Is Static.
              <br />
              <span className="gradient-text">Your Career Isn't.</span>
            </h2>
            <p className="text-lg text-muted-foreground mb-10 max-w-xl mx-auto leading-relaxed">
              See where you stand, understand what to improve, and move toward roles you can
              actually get.
            </p>
            <p className="text-base font-semibold text-foreground mb-3">
              One interview can change how employers see you.
            </p>
            <p className="text-sm text-muted-foreground mb-6">
              Join thousands of candidates building evidence-based hiring profiles.
            </p>
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary mx-auto mb-4">
                Start My AI Interview
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
            <p className="text-xs text-muted-foreground mb-1">
              Takes 10 minutes. No resume required.
            </p>
            <p className="text-xs text-muted-foreground mb-6">Free to start. No credit card.</p>
            <p className="text-sm text-primary/70 italic mb-8">
              Know where you stand before your next interview.
            </p>
            <p className="text-xl sm:text-2xl font-semibold text-foreground max-w-2xl mx-auto leading-snug">
              Your resume tells employers where you've been.{" "}
              <span className="gradient-text">Lexy shows them what you're capable of.</span>
            </p>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
