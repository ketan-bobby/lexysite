import SiteFooter from "@/components/SiteFooter";
import ProductCapabilities from "@/components/ProductCapabilities";
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
  BookOpen,
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
      src={`${import.meta.env.BASE_URL}lexy-ai-logo-navy-blue.png`}
      alt="L3xy AI"
      className={`${cls} w-auto object-contain select-none`}
      draggable={false}
    />
  );
}

function Nav() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
        <Link href="/" className="shrink-0">
          <div className="flex items-center hover:opacity-80 transition-opacity cursor-pointer">
            <LexyLogo size="md" />
          </div>
        </Link>
        <div className="flex items-center gap-3 sm:gap-4">
          <Link href="/employers" className="text-xs sm:text-sm whitespace-nowrap text-muted-foreground hover:text-foreground transition-colors">
            Employers
          </Link>
          <Link href="/" className="hidden sm:block">
            <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" /> <span className="hidden sm:inline">Overview</span>
            </button>
          </Link>
          <a href={`${MAIN_APP}/career-register`}>
            <button className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              <span className="sm:hidden">Get Started</span>
              <span className="hidden sm:inline">Create My Career Profile</span>
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
    title: "Career profile",
    desc: "Tell Lexy about your experience, goals and the kind of work you want next. It becomes the starting point for your coaching.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Brain,
    title: "Baseline insights",
    desc: "A first read on your strengths and the gaps worth working on, so you know where to start.",
    color: "text-navy",
    bg: "bg-navy/10",
    border: "border-navy/20",
  },
  {
    icon: Mic,
    title: "Interview practice",
    desc: "Practise answering the kinds of questions asked for the roles you want, and get specific feedback.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
  {
    icon: BookOpen,
    title: "Learning paths",
    desc: "Work through the learning paths available to you, matched to the gaps your coach found.",
    color: "text-amber-600",
    bg: "bg-amber-600/10",
    border: "border-amber-600/20",
  },
];

const steps = [
  {
    num: "01",
    title: "Build your career profile",
    desc: "Add your experience, goals and the roles you are aiming for.",
  },
  {
    num: "02",
    title: "Get your baseline",
    desc: "Your coach gives you a first view of your strengths and what to work on.",
  },
  {
    num: "03",
    title: "Practise and learn",
    desc: "Run practice interviews and follow learning paths. Watch your progress over time.",
  },
  {
    num: "04",
    title: "Explore relevant roles",
    desc: "See opportunities that fit where you are heading. You choose whether to be introduced.",
  },
];

const privacyPoints = [
  "Your baseline, practice sessions and learning progress are for you",
  "They are not shared with employers as assessment or matching scores",
  "Employers only hear about you if you approve an introduction",
  "A job interview an employer asks you to take is a separate process",
];

const careerInsights = [
  "Which strengths come through most clearly",
  "Which gaps are worth working on first",
  "How your practice answers are improving",
  "Which kinds of roles fit your direction",
];

const readinessFeatures = [
  {
    title: "Practice for your target roles",
    desc: "Questions shaped around the kind of role you are preparing for, not a generic list.",
  },
  {
    title: "Specific feedback",
    desc: "Notes on structure, clarity and examples, so you know what to change next time.",
  },
  {
    title: "Learning that follows the feedback",
    desc: "Move from a gap your coach spotted to an available learning path that covers it.",
  },
  {
    title: "Progress you can see",
    desc: "Compare your sessions over time and see where you have improved.",
  },
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
    title: "Lexy for Candidates | Your Private AI Career Coach",
    description:
      "Build a career profile, get baseline insights, practise interviews, follow learning paths, track progress and find relevant roles. Your coaching stays private, and you choose any employer introduction.",
    path: "/candidates",
  });
  return (
    <div className="min-h-screen mesh-bg">
      <Nav />

      {/* ── HERO ──────────────────────────────────────────────────────────── */}
      <section className="hero-navy pt-40 pb-28 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-8">
            <Sparkles className="w-3 h-3" /> For Candidates
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.1] mb-6 text-balance">
            Your AI career coach.{" "}
            <span className="gradient-text text-glow">Private, practical, on your side.</span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            Build a career profile, see where you stand, practise interviews, learn what is
            missing and track your progress. When a relevant role comes up, you decide whether
            an employer hears about you.
          </p>

          <p className="text-sm text-muted-foreground max-w-2xl mx-auto -mt-6 mb-10">
            Your coaching is private. It is not shared with employers as an assessment.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-8">
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-7 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary">
                Create My Career Profile
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-7 py-4 rounded-xl text-base font-medium border border-border hover:border-primary/40 transition-colors text-muted-foreground hover:text-foreground">
                <Mic className="w-5 h-5" /> Start With Interview Practice
              </button>
            </a>
          </div>

          <div className="flex flex-col items-center gap-1 text-sm text-muted-foreground">
            <p>Start with your profile, then work at your own pace.</p>
          </div>
        </div>
      </section>

      {/* ── HIRING IS CHANGING ────────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          {/* Headline */}
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-widest mb-6">
              <AlertCircle className="w-3 h-3" /> Why a coach helps
            </div>
            <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-6">
              Job hunting gives you very little{" "}
              <span className="gradient-text">honest feedback.</span>
            </h2>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
              You apply, you interview, and you rarely learn what to do differently. A coach changes that.
            </p>
          </div>

          {/* Problem grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-12">
            <div className="p-7 rounded-2xl border border-border/50 bg-card space-y-4">
              <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <TrendingDown className="w-4 h-4 text-primary" />
              </div>
              <h3 className="text-lg font-semibold">You rarely hear why</h3>
              <p className="text-muted-foreground leading-relaxed text-sm">
                Rejections usually arrive without reasons, so it is hard to know whether to work on
                your answers, your skills, or the roles you target.
              </p>
            </div>
            <div className="p-7 rounded-2xl border border-border/50 bg-card space-y-4">
              <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <AlertCircle className="w-4 h-4 text-primary" />
              </div>
              <h3 className="text-lg font-semibold">More applications is not a plan</h3>
              <p className="text-muted-foreground leading-relaxed text-sm">
                Sending more of the same application rarely helps. Preparing better for the right roles
                usually does.
              </p>
            </div>
          </div>

          {/* Bold callout */}
          <div className="marketing-panel text-center p-10 rounded-3xl mb-16">
            <p className="text-2xl sm:text-3xl font-semibold leading-snug">
              Applying to more jobs isn't the answer.
            </p>
            <p className="text-2xl sm:text-3xl font-semibold leading-snug mt-1">
              <span className="gradient-text">Knowing what to work on is.</span>
            </p>
            <p className="text-lg text-muted-foreground mt-5 font-medium">
              Lexy helps you see where you stand and what to do next.
            </p>
            <p className="text-lg text-muted-foreground mt-2 font-medium">
              No promises of jobs or salaries. Just steady, practical preparation.
            </p>
          </div>

          {/* Stay Ahead section */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center mb-20">
            <div>
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary/50 text-[10px] font-medium uppercase tracking-widest mb-5">
                <Zap className="w-2.5 h-2.5" /> What your coach does
              </div>
              <h3 className="text-2xl sm:text-3xl font-semibold mb-4">
                Know where you stand —{" "}
                <span className="gradient-text">and what to do next.</span>
              </h3>
              <p className="text-primary font-semibold mb-3">
                Lexy helps you prepare, not just apply.
              </p>
              <p className="text-muted-foreground leading-relaxed">
                See your strengths, work on your gaps, and focus on roles that make sense for where you
                want to go.
              </p>
            </div>
            <ul className="space-y-4">
              {[
                {
                  icon: Eye,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "See a baseline of your strengths and gaps",
                },
                {
                  icon: Target,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Follow available learning paths for your gaps",
                },
                {
                  icon: Mic,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Practise interviews for the roles you want",
                },
                {
                  icon: TrendingUp,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Get specific feedback after each practice session",
                },
                {
                  icon: Briefcase,
                  color: "text-primary",
                  bg: "bg-primary/10 border-primary/20",
                  text: "Explore relevant roles and choose your introductions",
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
              Your practice and progress stay private.
            </p>
          </div>

          {/* Manifesto block */}
          <div className="relative p-10 sm:p-14 rounded-3xl border border-border/40 bg-card overflow-hidden mb-16">
            <div className="relative">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-widest mb-6">
                <Brain className="w-3 h-3" /> How coaching works
              </div>
              <h3 className="text-3xl sm:text-4xl lg:text-5xl font-semibold mb-6 leading-snug">
                Your first baseline is a starting point.{" "}
                <span className="gradient-text">Not a verdict.</span>
              </h3>
              <div className="space-y-4 max-w-2xl">
                <p className="text-muted-foreground leading-relaxed">
                  Your coach starts with what you tell it and a short baseline.
                </p>
                <p className="text-muted-foreground leading-relaxed">
                  It points out what is working and the few things worth practising first.
                </p>
                <p className="text-muted-foreground leading-relaxed">
                  You practise, follow learning paths, and come back to see what has changed.
                </p>
                <p className="text-foreground/80 leading-relaxed font-medium">
                  All of it is for you. None of it is sent to employers as a score.
                </p>
                <p className="text-lg font-semibold text-primary">Preparation you control.</p>
              </div>
            </div>
          </div>

          {/* Move Forward closer */}
          <div className="text-center">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-semibold uppercase tracking-widest mb-8">
              <Rocket className="w-3 h-3" /> Where it leads
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-10">
              {[
                {
                  icon: ShieldCheck,
                  color: "text-navy",
                  bg: "bg-navy/10 border-navy/20",
                  label: "A clearer picture of where you stand",
                },
                {
                  icon: TrendingUp,
                  color: "text-emerald-600",
                  bg: "bg-emerald-600/10 border-emerald-600/20",
                  label: "Steady progress on the skills you chose",
                },
                {
                  icon: Rocket,
                  color: "text-amber-600",
                  bg: "bg-amber-600/10 border-amber-600/20",
                  label: "Relevant roles, introduced only with your consent",
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
                Create My Career Profile
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
            <p className="text-xs text-muted-foreground mt-3">
              Ask us what is currently enabled for candidates in your region.
            </p>
          </div>
        </div>
      </section>

      {/* ── SECTION 2 — POSITIONING ───────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
            Private coaching. <span className="gradient-text">Separate from employer interviews.</span>
          </h2>
          <div className="space-y-4 max-w-2xl mx-auto">
            <p className="text-lg text-muted-foreground leading-relaxed">
              Some employers use Lexy to run their own job interviews. Those are a separate process,
              run by the employer, for a specific role.
            </p>
            <ul className="space-y-3 text-left inline-flex flex-col">
              {privacyPoints.map((pt) => (
                <li key={pt} className="flex items-start gap-3 text-base text-muted-foreground">
                  <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                  {pt}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <ProductCapabilities audience="candidates" />

      {/* ── VIDEO DEMO ────────────────────────────────────────────────────── */}
      <LexyVideoPlayer />

      {/* ── SECTION 3 — CORE VALUE ────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              What your career coach <span className="gradient-text">includes</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Four parts that work together, plus progress tracking and relevant roles.
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
              How it works, <span className="gradient-text">step by step</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Start with your profile. Everything else builds from there.
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
                Create My Career Profile
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
              <BarChart3 className="w-3 h-3" /> Your progress
            </span>
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Your career dashboard.{" "}
              <span className="gradient-text">Everything in one place.</span>
            </h2>
            <div className="space-y-3 max-w-2xl mx-auto">
              <p className="text-lg text-muted-foreground">
                Your baseline, practice sessions, learning and suggested next steps, side by side.
              </p>
              <p className="text-base font-semibold text-primary">
                Visible to you. Not to employers.
              </p>
            </div>
          </div>

          {/* Dashboard screenshot */}
          <div className="rounded-2xl overflow-hidden shadow-2xl shadow-primary/10 border border-border/30">
            <img
              src={`${import.meta.env.BASE_URL}dashboard-preview-v2.png`}
              alt="Example of the Lexy candidate dashboard showing progress, practice results and suggested next steps"
              className="w-full block"
              style={{ imageRendering: "auto" }}
            />
          </div>

          {/* CTA below mockup */}
          <div className="text-center mt-10">
            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary mx-auto">
                Create My Career Profile
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
            <p className="text-xs text-muted-foreground mt-3">
              Ask us what is currently enabled for candidates in your region.
            </p>
          </div>
        </div>
      </section>

      {/* ── SECTION 5 — SEO BLOCK ─────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-10">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4 leading-tight">
              Relevant opportunities,
              <br />
              <span className="gradient-text">on your terms.</span>
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              As your profile develops, Lexy can show roles that fit your direction. Nothing is
              shared with an employer unless you approve the introduction.
            </p>
          </div>

          <div className="p-8 rounded-2xl border border-border/60 bg-card text-center">
            <p className="text-muted-foreground mb-5 font-medium">How discovery works:</p>
            <ul className="space-y-3 mb-8 inline-flex flex-col items-start">
              {["You see roles that look relevant to your profile and goals", "You decide which employers you want to be introduced to", "Employers then run their own hiring process, including any interview", "Lexy does not promise interviews, jobs or salaries"].map((pt) => (
                <li key={pt} className="flex items-center gap-3 text-sm text-foreground/80">
                  <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
                  {pt}
                </li>
              ))}
            </ul>
            <div className="pt-5 border-t border-border/50 text-primary font-semibold text-lg sm:text-xl leading-relaxed">
              You choose. Every time.
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
                See your progress
                <br />
                <span className="gradient-text">over time</span>
              </h2>
              <p className="text-lg text-muted-foreground leading-relaxed mb-3">
                Your coach keeps track of what you have practised and learned, so improvement is something you can see.
              </p>
              <p className="text-base font-semibold text-foreground/80 mb-8">
                Progress tracking covers:
              </p>
              <ul className="space-y-3">
                {careerInsights.map((insight) => (
                  <li key={insight} className="flex items-center gap-3 text-sm">
                    <ChevronRight className="w-4 h-4 text-navy shrink-0" />
                    {insight}
                  </li>
                ))}
              </ul>
            </div>
            <div className="marketing-panel p-8 rounded-3xl">
              <div className="space-y-4">
                {[
                  { role: "Structuring answers", prob: 72, color: "bg-primary" },
                  { role: "Using specific examples", prob: 58, color: "bg-primary" },
                  { role: "Stakeholder communication", prob: 64, color: "bg-primary" },
                  { role: "Learning path progress", prob: 40, color: "bg-primary" },
                ].map((r) => (
                  <div key={r.role}>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm font-medium">{r.role}</span>
                      <span className="text-xs text-primary">{r.prob}%</span>
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
                Illustrative example of private practice progress
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── SECTION 8 — INTERVIEW PREP ────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-amber-600/30 bg-amber-600/10 text-amber-600 text-xs font-medium mb-6">
            <Zap className="w-3 h-3" /> Practice and learning
          </div>
          <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
            Practise, learn, <span className="gradient-text">repeat</span>
          </h2>
          <p className="text-lg text-muted-foreground mb-10 max-w-xl mx-auto">
            Feedback tells you what to work on. Learning paths help you work on it.
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
              Create My Career Profile
              <ArrowRight className="w-5 h-5" />
            </button>
          </a>
        </div>
      </section>

      {/* ── SECTION 9 — FINAL CTA ─────────────────────────────────────────── */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-3xl mx-auto text-center">
          <div className="marketing-panel p-14 rounded-3xl">
            <Sparkles className="w-10 h-10 text-primary mx-auto mb-6" />
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Your next role starts
              <br />
              <span className="gradient-text">with knowing where you stand.</span>
            </h2>
            <p className="text-lg text-muted-foreground mb-10 max-w-xl mx-auto leading-relaxed">
              Create your career profile, get your baseline, and start practising with a coach that
              works for you.
            </p>

            <a href={`${MAIN_APP}/career-register`}>
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary mx-auto mb-4">
                Create My Career Profile
                <ArrowRight className="w-5 h-5" />
              </button>
            </a>
            <p className="text-xs text-muted-foreground mb-8">
              Learning paths and features can vary. Ask us what is currently enabled for you.
            </p>
            <p className="text-xl sm:text-2xl font-semibold text-foreground max-w-2xl mx-auto leading-snug">
              Your coaching stays yours.{" "}
              <span className="gradient-text">Your introductions are your choice.</span>
            </p>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
