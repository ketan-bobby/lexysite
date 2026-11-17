import SiteFooter from "@/components/SiteFooter";
/*
 * home.tsx — Public homepage for the marketing site.
 *
 * Routes the two audiences (employers vs. candidates) to their dedicated
 * pages. Mostly static marketing content driven by the data arrays below.
 * Copy rule: describe what Lexy does in plain language; no outcome
 * statistics, no "verified"/predictive claims, no instant-activation claims.
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { useState, useRef, useEffect } from "react";
import {
  Sparkles,
  Brain,
  Globe,
  Users,
  TrendingUp,
  CheckCircle,
  ArrowRight,
  Shield,
  Target,
  Layers,
  Lock,
  Mail,
  Mic,
  ShieldCheck,
  FileSearch,
  Send,
  CalendarCheck,
  FileDown,
  BookOpen,
  Plug,
  Briefcase,
} from "lucide-react";

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
    <nav aria-label="Main navigation" className="fixed top-0 left-0 right-0 z-50 border-b border-slate-200 bg-white">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-18 flex items-center justify-between gap-4">
        <Link href="/" aria-label="Lexy home" className="flex items-center shrink-0">
          <LexyLogo size="md" />
        </Link>
        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-navy">
          <Link href="/employers" className="hover:text-foreground transition-colors">
            For Employers
          </Link>
          <Link href="/candidates" className="hover:text-foreground transition-colors">
            For Candidates
          </Link>
          <Link href="/pricing" className="hover:text-foreground transition-colors">
            Pricing
          </Link>
          <Link href="/blog" className="hover:text-foreground transition-colors">
            Blog
          </Link>
        </div>
        <div className="flex items-center gap-4 text-sm font-semibold">
          <Link href="/employers" className="md:hidden text-navy hover:text-primary">
            Employers
          </Link>
          <Link href="/candidates" className="md:hidden text-navy hover:text-primary">
            Candidates
          </Link>
          <Link href="/employers?demo=1" className="hidden sm:inline-flex items-center px-5 py-2.5 rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors">
            Request a Demo
          </Link>
        </div>
      </div>
    </nav>
  );
}

const pillars = [
  { value: "Employers", label: "An AI hiring team, run by your recruiters" },
  { value: "Candidates", label: "A private AI career coach" },
  { value: "People", label: "Make every hiring decision" },
];

/* --- Hover micro-demos for the capability cards --- */

function WaveformDemo() {
  return (
    <div className="flex items-center gap-3 w-full">
      <div className="flex items-end gap-[3px] h-6 shrink-0">
        {[0.4, 0.8, 0.55, 1, 0.65, 0.9, 0.5, 0.75, 0.35, 0.85, 0.6, 0.45].map((h, i) => (
          <span
            key={i}
            className="wave-bar w-[3px] rounded-full bg-primary/70"
            style={{ height: `${h * 100}%`, animationDelay: `${i * 0.07}s` }}
          />
        ))}
      </div>
      <div className="min-w-0 space-y-0.5">
        <p className="demo-fade text-[11px] text-muted-foreground italic truncate">
          "Tell me about a project you led…"
        </p>
        <p
          className="demo-fade text-[11px] text-foreground/70 truncate"
          style={{ animationDelay: "0.35s" }}
        >
          "I led a 6-person team migrating our…"
        </p>
        <p
          className="demo-fade text-[11px] text-muted-foreground italic truncate"
          style={{ animationDelay: "0.7s" }}
        >
          "What was the hardest tradeoff?"
        </p>
      </div>
    </div>
  );
}

function RedactionDemo() {
  return (
    <div className="space-y-1.5 w-full max-w-[220px]">
      {[
        ["w-16", "w-24"],
        ["w-12", "w-32"],
        ["w-20", "w-16"],
      ].map(([a, b], i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className={`demo-fade h-2 ${a} rounded-sm bg-foreground/70`}
            style={{ animationDelay: `${i * 0.12}s` }}
          />
          <span className={`h-2 ${b} rounded-sm bg-muted-foreground/20`} />
        </div>
      ))}
    </div>
  );
}

function DecisionDemo({ hovered }: { hovered: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!hovered) {
      setDone(false);
      return;
    }
    const t = setTimeout(() => setDone(true), 800);
    return () => clearTimeout(t);
  }, [hovered]);
  return (
    <div className="flex items-center gap-3 w-full">
      <span
        className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-full border-2 transition-colors duration-500 ${
          done
            ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
            : "border-muted-foreground/30 bg-muted-foreground/5 text-muted-foreground/50"
        }`}
      >
        <ShieldCheck className="w-4 h-4" />
      </span>
      <div className="space-y-0.5">
        {["Evidence reviewed", "Notes added", "Decision by recruiter"].map((t, i) => (
          <div
            key={t}
            className="demo-fade flex items-center gap-1.5 text-[11px] text-muted-foreground"
            style={{ animationDelay: `${0.15 + i * 0.25}s` }}
          >
            <CheckCircle className="w-3 h-3 text-emerald-600" />
            {t}
          </div>
        ))}
      </div>
    </div>
  );
}

function OutreachDemo() {
  return (
    <div className="space-y-1.5">
      <div className="demo-fade flex items-center gap-1.5 text-xs text-muted-foreground">
        <Send className="w-3 h-3 text-navy" />
        Draft ready for your review
      </div>
      <div
        className="demo-fade flex items-center gap-1.5 text-xs text-muted-foreground"
        style={{ animationDelay: "0.25s" }}
      >
        <CheckCircle className="w-3 h-3 text-emerald-600" />
        Approved by recruiter, then sent
      </div>
    </div>
  );
}

function SlotsDemo() {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {["Tue 10:00", "Tue 14:30", "Thu 09:00"].map((s, i) => (
        <span
          key={s}
          className="demo-fade px-2 py-1 rounded-md border border-primary/30 bg-primary/5 text-[11px] text-primary"
          style={{ animationDelay: `${i * 0.18}s` }}
        >
          {s}
        </span>
      ))}
      <span className="demo-fade text-[10px] text-muted-foreground" style={{ animationDelay: "0.6s" }}>
        Only times you offered
      </span>
    </div>
  );
}

function ReportDemo() {
  return (
    <div className="flex items-center gap-3 w-full">
      <div className="relative w-8 h-10 shrink-0">
        {[2, 1, 0].map((i) => (
          <span
            key={i}
            className="demo-fade absolute inset-0 rounded-[3px] border border-border bg-card shadow-sm"
            style={{
              animationDelay: `${i * 0.15}s`,
              transform: `translate(${i * 3}px, ${-i * 3}px)`,
            }}
          >
            <span className="block mt-1.5 mx-1 h-[2px] rounded bg-muted-foreground/30" />
            <span className="block mt-1 mx-1 h-[2px] w-2/3 rounded bg-muted-foreground/20" />
          </span>
        ))}
      </div>
      <div className="space-y-1 min-w-0">
        <span
          className="demo-fade inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md bg-emerald-600/10 text-emerald-700 text-[10px] font-medium"
          style={{ animationDelay: "0.5s" }}
        >
          <FileDown className="demo-icon w-3 h-3" />
          Report ready
        </span>
        <div
          className="demo-fade text-[11px] text-muted-foreground"
          style={{ animationDelay: "0.65s" }}
        >
          Answers, scores and reasons, side by side
        </div>
      </div>
    </div>
  );
}

const capabilityDemos: Record<string, (hovered: boolean) => React.ReactElement> = {
  "Structured interviews": () => <WaveformDemo />,
  "Resume screening with details hidden": () => <RedactionDemo />,
  "Reviewed outreach and follow-up": () => <OutreachDemo />,
  "Scheduling from your offered slots": () => <SlotsDemo />,
  "Evaluation evidence": () => <ReportDemo />,
  "Human decisions": (hovered) => <DecisionDemo hovered={hovered} />,
};

function CapabilityCard({
  c,
  featured = false,
}: {
  c: (typeof capabilityGroups)[number]["items"][number];
  featured?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!featured || !cardRef.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setAutoPlay(true);
          observer.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, [featured]);
  const active = hovered || autoPlay;
  const Icon = c.icon;
  const demo = capabilityDemos[c.title];
  return (
    <div
      ref={cardRef}
      className={`group p-6 rounded-2xl border border-border bg-card card-hover ${
        featured ? "featured-card" : ""
      } ${autoPlay ? "demo-active" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className={`w-11 h-11 rounded-xl ${c.bg} flex items-center justify-center mb-4`}>
        <Icon className={`demo-icon w-5 h-5 ${c.color}`} />
      </div>
      <h3 className="font-semibold text-base mb-2">{c.title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{c.desc}</p>
      {demo && (
        <div className="demo-area mt-4 h-12 flex items-center overflow-hidden">{demo(active)}</div>
      )}
    </div>
  );
}

const capabilityGroups = [
  {
    stage: "Find and engage",
    items: [
      {
        icon: FileSearch,
        title: "Resume screening with details hidden",
        desc: "Bring your own applicants or source new ones. Lexy reads resumes against the role with personal details hidden, so reviewers start from skills and experience.",
        color: "text-navy",
        bg: "bg-navy/5",
      },
      {
        icon: Send,
        title: "Reviewed outreach and follow-up",
        desc: "Lexy drafts engagement and interview invitations. Your team reviews and approves a campaign before anything goes out.",
        color: "text-primary",
        bg: "bg-primary/5",
      },
      {
        icon: CalendarCheck,
        title: "Scheduling from your offered slots",
        desc: "Candidates pick from the times your team made available. Lexy does not book time you did not offer.",
        color: "text-emerald-600",
        bg: "bg-emerald-600/5",
      },
    ],
  },
  {
    stage: "Interview and decide",
    items: [
      {
        icon: Mic,
        title: "Structured interviews",
        desc: "Every candidate for a role gets the same core questions, with follow-ups that dig into their real answers.",
        color: "text-primary",
        bg: "bg-primary/5",
      },
      {
        icon: FileDown,
        title: "Evaluation evidence",
        desc: "See what each candidate said, how it was scored against the role, and why, in a report you can share with hiring managers.",
        color: "text-navy",
        bg: "bg-navy/5",
      },
      {
        icon: ShieldCheck,
        title: "Human decisions",
        desc: "Lexy recommends. Recruiters and hiring managers decide who advances, who is declined, and who receives an offer.",
        color: "text-emerald-600",
        bg: "bg-emerald-600/5",
      },
    ],
  },
];

const LANGS = [
  "English",
  "हिन्दी",
  "తెలుగు",
  "தமிழ்",
  "বাংলা",
  "मराठी",
  "ಕನ್ನಡ",
  "Español",
  "Français",
  "Deutsch",
  "日本語",
  "中文",
  "العربية",
  "Português",
];

function LanguageStrip() {
  const [activeLang, setActiveLang] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setActiveLang((prev) => (prev + 1) % LANGS.length);
    }, 2500);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="py-16 px-6 border-t border-border/50">
      <div className="max-w-4xl mx-auto text-center">
        <Globe className="w-8 h-8 text-primary mx-auto mb-4" />
        <h3 className="text-2xl sm:text-3xl font-semibold mb-3">
          Interview in the language{" "}
          <span className="gradient-text">people actually work in.</span>
        </h3>
        <p className="text-muted-foreground mb-6 text-base max-w-xl mx-auto">
          Lexy supports interviews and coaching in many languages, using the same structured
          approach for each. Language options depend on your setup, so ask us which ones are
          enabled for your roles.
        </p>

        <div className="flex flex-wrap justify-center gap-2">
          {LANGS.map((lang, i) => (
            <span
              key={lang}
              className={`px-3 py-1.5 rounded-full text-xs border transition-all duration-700 ${
                i === activeLang
                  ? "border-primary/60 bg-primary/10 text-primary scale-105"
                  : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
              }`}
            >
              {lang}
            </span>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-6">A sample, not a complete list.</p>
      </div>
    </section>
  );
}

function NewsletterSignup() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setErrorMsg("Please enter a valid email address.");
      setStatus("error");
      return;
    }
    setStatus("loading");
    setErrorMsg("");
    try {
      // API server is mounted by the platform proxy at /api/* — root-relative,
      // same convention as pricing/start-trial/signup-success/employers.
      const res = await fetch(`/api/newsletter/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed }),
      });
      if (res.ok) {
        setStatus("success");
        setEmail("");
      } else {
        const body = await res.json().catch(() => ({}));
        setErrorMsg(body?.error ?? "Something went wrong. Please try again.");
        setStatus("error");
      }
    } catch {
      setErrorMsg("Could not connect. Please check your connection and try again.");
      setStatus("error");
    }
  }

  return (
    <section className="py-20 px-6 border-t border-border/50">
      <div className="max-w-2xl mx-auto text-center">
        <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-5">
          <Mail className="w-6 h-6 text-primary" />
        </div>
        <h2 className="text-2xl sm:text-3xl font-semibold mb-3">
          Notes on hiring and careers. <span className="gradient-text">Written for both sides.</span>
        </h2>
        <p className="text-muted-foreground text-base mb-8 max-w-lg mx-auto leading-relaxed">
          Stay updated with new hiring research, AI interview insights, global hiring trends, and
          product releases. No noise. No spam.
        </p>

        {status === "success" ? (
          <div className="inline-flex items-center gap-2 px-6 py-3.5 rounded-xl bg-emerald-600/10 border border-emerald-600/30 text-emerald-600 text-sm font-medium">
            <CheckCircle className="w-4 h-4" />
            You're on the list — we'll be in touch soon.
          </div>
        ) : (
          <form onSubmit={handleSubmit} noValidate>
            <div className="flex flex-col sm:flex-row gap-3 max-w-md mx-auto">
              <input
                ref={inputRef}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (status === "error") setStatus("idle");
                }}
                placeholder="Enter your email"
                className="flex-1 px-4 py-3 rounded-xl border border-border/60 bg-card text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 transition"
                disabled={status === "loading"}
              />
              <button
                type="submit"
                disabled={status === "loading"}
                className="px-6 py-3 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {status === "loading" ? "Subscribing…" : "Join the Newsletter"}
              </button>
            </div>
            {status === "error" && <p className="mt-3 text-xs text-primary">{errorMsg}</p>}
          </form>
        )}

        <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-6">
          {[
            "Practical AI hiring insights",
            "Global hiring & compliance updates",
            "Product updates and release notes",
          ].map((item) => (
            <span
              key={item}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <CheckCircle className="w-3.5 h-3.5 text-emerald-600 flex-shrink-0" />
              {item}
            </span>
          ))}
        </div>

        <p className="text-xs text-muted-foreground/50 mt-5">
          No spam. Unsubscribe anytime. For hiring teams and candidates alike.
        </p>
      </div>
    </section>
  );
}

export default function Home() {
  usePageMeta({
    title: "L3XY AI | Your AI Hiring Team. Your AI Career Coach.",
    description:
      "Lexy gives employers an AI hiring team for sourcing, interviews and evidence while people make every decision, and gives candidates a private AI career coach for practice, learning and progress.",
    path: "/",
  });
  return (
    <div className="min-h-screen mesh-bg">
      <Nav />

      {/* Hero */}
      <section className="hero-navy pt-40 pb-24 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-8">
            <Sparkles className="w-3 h-3" />
            For employers hiring • For candidates growing
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.1] mb-6">
            Your AI hiring team.
            <br />
            <span className="gradient-text text-glow">Your AI career coach.</span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            Employers use Lexy to find applicants, run structured interviews and review clear
            evidence, while their own people make every hiring decision. Candidates use Lexy to
            understand where they stand, practise, learn and find relevant roles, in private.
          </p>

          {/* Split CTA — both audiences, equal weight */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto mb-4">
            <Link href="/employers">
              <button className="w-full flex items-center justify-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary">
                I'm hiring: see Lexy for employers
                <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
            <Link href="/candidates">
              <button className="w-full flex items-center justify-center gap-2 px-8 py-4 rounded-xl text-base font-semibold border border-primary/40 text-primary hover:bg-primary/10 transition-all hover:scale-105">
                I'm a candidate: meet my career coach
                <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
          </div>
          <p className="text-sm sm:text-base font-medium text-muted-foreground">
            Use Lexy on its own, or explore selected ATS-connected workflows with our team.
          </p>

          {/* Pillars */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-20 pt-12 border-t border-border/50">
            {pillars.map((s) => (
              <div key={s.value} className="text-center">
                <div className="text-3xl font-semibold text-navy mb-1">{s.value}</div>
                <div className="text-sm text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Dual platform */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-4">Which side are you on today?</h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-12 leading-relaxed">
            Lexy has two separate experiences. What a candidate does with their coach stays with
            the candidate.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="marketing-panel p-8 rounded-3xl text-left">
              <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center mb-5">
                <Users className="w-6 h-6 text-white" />
              </div>
              <p className="text-xs font-semibold text-primary tracking-widest uppercase mb-2">
                For employers
              </p>
              <h3 className="font-semibold text-xl mb-3 text-foreground">
                An AI hiring team your recruiters direct
              </h3>
              <ul className="space-y-2 mb-6">
                {[
                  "Source candidates, or bring the applicants you already have",
                  "Send interview invitations your team has reviewed",
                  "Run the same structured interview for every candidate",
                  "Compare evidence, then decide yourselves",
                  "Schedule only into times you offered",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    {t}
                  </li>
                ))}
              </ul>
              <Link href="/employers">
                <button className="flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary/80 transition-colors">
                  See the employer journey <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
            </div>

            <div className="marketing-panel p-8 rounded-3xl text-left">
              <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center mb-5">
                <TrendingUp className="w-6 h-6 text-white" />
              </div>
              <p className="text-xs font-semibold text-primary tracking-widest uppercase mb-2">
                For candidates
              </p>
              <h3 className="font-semibold text-xl mb-3 text-foreground">
                A private AI career coach
              </h3>
              <ul className="space-y-2 mb-6">
                {[
                  "Build a career profile in your own words",
                  "Get baseline insights on strengths and gaps",
                  "Practise interviews and get specific feedback",
                  "Follow available learning paths and track progress",
                  "Find relevant roles, and choose who you are introduced to",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    {t}
                  </li>
                ))}
              </ul>
              <Link href="/candidates">
                <button className="flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary/80 transition-colors">
                  See the candidate journey <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
            Two sides of the same frustration.
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-12 text-left">
            <div className="marketing-panel p-8 rounded-2xl card-hover">
              <div className="w-11 h-11 rounded-xl bg-background/60 flex items-center justify-center mb-5">
                <Briefcase className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-semibold text-lg mb-3">Recruiters run out of hours</h3>
              <p className="text-muted-foreground leading-relaxed">
                Screening, chasing replies, booking calls and writing up interviews eat the week.
                Interviewers ask different questions, so candidates are hard to compare fairly.
              </p>
            </div>
            <div className="marketing-panel p-8 rounded-2xl card-hover">
              <div className="w-11 h-11 rounded-xl bg-background/60 flex items-center justify-center mb-5">
                <Target className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-semibold text-lg mb-3">Candidates prepare in the dark</h3>
              <p className="text-muted-foreground leading-relaxed">
                Most people get little honest feedback. They are not sure which skills to work on,
                how they come across in interviews, or which roles are a sensible next step.
              </p>
            </div>
          </div>
          <p className="text-base font-semibold text-foreground/80 mt-10">
            Lexy takes on the repetitive work for employers
            <br />
            <span className="gradient-text">and gives candidates a coach in their corner.</span>
          </p>
        </div>
      </section>

      {/* Employer capabilities */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-6">
              <Layers className="w-3 h-3" />
              The employer side
            </div>
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              What your AI hiring team does.{" "}
              <span className="gradient-text">What your people still decide.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Lexy handles the structured, repetitive steps. Anything that reaches a candidate is
              reviewed by your team first, and decisions always stay with people.
            </p>
          </div>
          <div className="space-y-14">
            {capabilityGroups.map((group) => (
              <div key={group.stage}>
                <div className="flex items-center gap-4 mb-6">
                  <h3 className="text-xl font-semibold gradient-text">{group.stage}</h3>
                  <div className="flex-1 h-px bg-border/60" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
                  {group.items.map((c) => (
                    <CapabilityCard
                      key={c.title}
                      c={c}
                      featured={c.title === "Structured interviews"}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-center mt-12 text-base font-semibold text-foreground/80">
            Offers stay with you.{" "}
            <span className="gradient-text">
              Your HR team prepares, approves and sends them.
            </span>
          </p>
          <div className="flex justify-center mt-8">
            <Link href="/employers">
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary">
                See the full employer journey
                <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* Standalone or ATS-connected */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-6">
              <Plug className="w-3 h-3" />
              Two ways to run it
            </div>
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Use Lexy on its own, <span className="gradient-text">or next to your ATS.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              You do not need to replace the systems you rely on. Pick the setup that fits how
              your team already hires.
            </p>
          </div>
          <div className="rounded-3xl border border-border overflow-hidden">
            <div className="grid grid-cols-2 bg-muted/40 border-b border-border">
              <div className="px-4 sm:px-6 py-4 text-sm font-semibold text-foreground">
                Lexy on its own
              </div>
              <div className="px-4 sm:px-6 py-4 text-sm font-semibold text-primary border-l border-border bg-primary/15">
                Lexy with Zoho Recruit or Greenhouse
              </div>
            </div>
            {[
              [
                "Post roles and keep candidates in Lexy",
                "Your ATS stays your system of record",
              ],
              [
                "Source candidates or upload your own applicants",
                "Bring selected candidates across for interviews",
              ],
              [
                "Interviews, evidence and decisions all in one place",
                "Interview results and progress can go back to your ATS",
              ],
              [
                "Ready once your workspace is set up",
                "Connected with your team, then switched on after you confirm it works",
              ],
            ].map(([left, right], i, arr) => (
              <div
                key={left}
                className={`grid grid-cols-2 ${i < arr.length - 1 ? "border-b border-border/60" : ""}`}
              >
                <div className="px-4 sm:px-6 py-4 flex items-start gap-2.5 text-sm text-muted-foreground">
                  <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                  {left}
                </div>
                <div className="px-4 sm:px-6 py-4 flex items-start gap-2.5 text-sm font-medium text-foreground border-l border-border bg-card">
                  <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                  {right}
                </div>
              </div>
            ))}
          </div>
          <p className="text-center text-sm text-muted-foreground mt-6 max-w-2xl mx-auto">
            We are focusing on Zoho Recruit and Greenhouse. Available workflows and readiness differ;
            setup and acceptance checks are required before activation. Details
            are on the{" "}
            <Link href="/employers" className="text-primary underline underline-offset-2">
              employer page
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Candidate side */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div className="marketing-panel p-8 rounded-3xl order-2 self-center">
              <p className="text-xs font-semibold text-primary/80 uppercase tracking-widest mb-4">
                Your coach helps you:
              </p>
              <ul className="space-y-3 mb-6">
                {[
                  { icon: Brain, t: "See a baseline of your strengths and gaps" },
                  { icon: Mic, t: "Practise interviews for the roles you want" },
                  { icon: BookOpen, t: "Work through available learning paths" },
                  { icon: TrendingUp, t: "Track progress over time" },
                  { icon: Target, t: "Find roles that look like a sensible next step" },
                ].map(({ icon: Icon, t }) => (
                  <li key={t} className="flex items-start gap-3">
                    <Icon className="w-4 h-4 text-primary flex-shrink-0 mt-0.5" />
                    <span className="text-sm text-muted-foreground">{t}</span>
                  </li>
                ))}
              </ul>
              <div className="border-t border-border/40 pt-5 flex items-start gap-3">
                <Lock className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">
                  Your coaching, practice and learning stay private. They are not shared with
                  employers as assessments or scores.
                </p>
              </div>
            </div>
            <div className="order-1">
              <h2 className="text-4xl sm:text-5xl font-semibold mb-6 leading-tight">
                A coach that is <span className="gradient-text">on your side.</span>
              </h2>
              <p className="text-muted-foreground text-xl mb-8 leading-relaxed">
                Lexy helps you prepare for the job you want next. When an opportunity fits, you
                decide whether an employer is introduced to you.
              </p>
              <Link href="/candidates">
                <button className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold border border-primary/40 text-primary hover:bg-primary/10 transition-colors mb-6">
                  See how the career coach works <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Principles */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
            The ground rules, for both sides
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-12">
            One company, two experiences, kept deliberately apart.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-10">
            {[
              {
                icon: Shield,
                title: "People decide",
                text: "Lexy recommends. Recruiters and hiring managers make every hiring decision, and HR owns every offer.",
                color: "text-navy",
              },
              {
                icon: Lock,
                title: "Coaching stays private",
                text: "A candidate's practice, baseline and learning are for them. Employer interviews are a separate process.",
                color: "text-emerald-600",
              },
              {
                icon: Users,
                title: "Introductions need consent",
                text: "Candidates choose whether to be introduced to an employer. Nothing is shared just because a role looks relevant.",
                color: "text-amber-600",
              },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.title}
                  className="p-7 rounded-2xl border border-border bg-card card-hover text-left"
                >
                  <Icon className={`w-8 h-8 ${item.color} mb-4`} />
                  <p className={`text-sm font-semibold ${item.color} mb-2`}>{item.title}</p>
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.text}</p>
                </div>
              );
            })}
          </div>
          <p className="text-sm text-muted-foreground">
            More detail in our{" "}
            <Link href="/responsible-ai" className="text-primary underline underline-offset-2">
              Responsible AI
            </Link>{" "}
            and{" "}
            <Link href="/candidate-rights" className="text-primary underline underline-offset-2">
              Candidate Rights
            </Link>{" "}
            pages.
          </p>
        </div>
      </section>

      <LanguageStrip />

      <NewsletterSignup />

      {/* Final CTA */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-3xl mx-auto text-center">
          <div className="marketing-panel p-12 rounded-3xl">
            <Sparkles className="w-10 h-10 text-primary mx-auto mb-6" />
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Start where you are.
            </h2>
            <p className="text-muted-foreground text-lg mb-8">
              Hiring teams can request a guided trial, set up around one of their roles.
              Candidates can create a career profile and start with their coach.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-5">
              <Link href="/start-trial">
                <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105">
                  Request an employer trial
                  <ArrowRight className="w-5 h-5" />
                </button>
              </Link>
              <Link href="/candidates">
                <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-medium border border-border hover:border-primary/40 transition-colors text-muted-foreground hover:text-foreground">
                  Explore the career coach
                  <ArrowRight className="w-5 h-5" />
                </button>
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">
              We review every trial request and set up your workspace with you.
            </p>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
