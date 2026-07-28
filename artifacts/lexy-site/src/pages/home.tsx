import SiteFooter from "@/components/SiteFooter";
/*
 * home.tsx — Public homepage for the marketing site.
 *
 * The top-level landing page that splits the two audiences (employers vs.
 * candidates) and routes each to its dedicated page. Mostly static marketing
 * content driven by the data arrays below (stats, unifiedFeatures, FAQ, etc.).
 */
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { useState, useRef, useEffect } from "react";
import {
  Sparkles,
  Brain,
  Globe,
  Zap,
  Users,
  TrendingUp,
  CheckCircle,
  ArrowRight,
  Shield,
  Target,
  Layers,
  Wrench,
  FileX,
  ChevronDown,
  ChevronUp,
  Mail,
  Mic,
  ShieldCheck,
  FileSearch,
  Send,
  Radar,
  FileDown,
} from "lucide-react";

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
        <div className="flex items-center">
          <LexyLogo size="md" />
        </div>
        <div className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
          <Link href="/employers" className="hover:text-foreground transition-colors">
            Employers
          </Link>
          <Link href="/candidates" className="hover:text-foreground transition-colors">
            Candidates
          </Link>
          <Link href="/start-trial" className="hover:text-foreground transition-colors">
            How It Works
          </Link>
          <Link href="/blog" className="hover:text-foreground transition-colors">
            Hiring Intelligence
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/start-trial">
            <button className="px-4 py-2 rounded-lg text-sm font-medium border border-border hover:border-primary/40 text-muted-foreground hover:text-foreground transition-colors">
              Hire Talent
            </button>
          </Link>
          <Link href="/candidates">
            <button className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              Get Hired
            </button>
          </Link>
        </div>
      </div>
    </nav>
  );
}

const stats = [
  { value: "10", label: "Specialized agents" },
  { value: "45+", label: "Languages" },
  { value: "Evidence-based", label: "Hiring" },
];

const unifiedFeatures = [
  {
    icon: Target,
    title: "Evaluate Candidates Through Real Interviews",
    desc: "Structured AI interviews capture how candidates think, communicate, and solve problems — not just what's on a resume.",
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
  },
  {
    icon: Brain,
    title: "Turn Interviews Into a Verified Career Profile",
    desc: "Every response builds a dynamic profile based on actual performance — not keywords or formatting.",
    color: "text-violet-600",
    bg: "bg-violet-600/10",
    border: "border-violet-600/20",
  },
  {
    icon: Layers,
    title: "Match Talent Based on Proven Capability",
    desc: "Shared interview signals power faster, more accurate hiring decisions for both candidates and teams.",
    color: "text-emerald-600",
    bg: "bg-emerald-600/10",
    border: "border-emerald-600/20",
  },
];

const howItWorks = [
  {
    num: "01",
    title: "Define What Success Looks Like — Upfront",
    desc: "Companies set clear role expectations. Candidates define goals and strengths — before the interview starts.",
  },
  {
    num: "02",
    title: "Capture Verified Signals",
    desc: "AI evaluates how candidates think, communicate, and solve problems — building a consistent performance profile.",
  },
  {
    num: "03",
    title: "Match Using Verified Signals",
    desc: "Profiles are matched using validated signals, skills, and readiness — not resume keywords.",
  },
  {
    num: "04",
    title: "Make Defensible Hiring Decisions",
    desc: "Structured scoring and signals guide decisions and next steps — for every candidate.",
  },
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

function ChecksDemo({ hovered }: { hovered: boolean }) {
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    if (!hovered) {
      setVerified(false);
      return;
    }
    const t = setTimeout(() => setVerified(true), 800);
    return () => clearTimeout(t);
  }, [hovered]);
  return (
    <div className="flex items-center gap-3 w-full">
      <span
        className={`shrink-0 flex items-center justify-center w-8 h-8 rounded-full border-2 transition-colors duration-500 ${
          verified
            ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
            : "border-muted-foreground/30 bg-muted-foreground/5 text-muted-foreground/50"
        }`}
      >
        <ShieldCheck className="w-4 h-4" />
      </span>
      <div className="space-y-0.5">
        {["Identity verified", "Work history matches", "No red flags"].map((t, i) => (
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

function useCountUp(hovered: boolean, from: number, to: number, ms = 900) {
  const [value, setValue] = useState(from);
  useEffect(() => {
    if (!hovered) {
      setValue(from);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min((now - start) / ms, 1);
      setValue(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hovered, from, to, ms]);
  return value;
}

function FitScoreDemo({ hovered }: { hovered: boolean }) {
  const score = useCountUp(hovered, 72, 94);
  const candidates = [
    { name: "A. Sharma", fit: 94 },
    { name: "J. Chen", fit: 87 },
    { name: "M. Okafor", fit: 79 },
  ];
  return (
    <div className="flex items-center gap-3 w-full">
      <div className="shrink-0 flex items-center gap-2 w-[110px]">
        <span className="text-lg font-bold text-primary tabular-nums w-8">{score}</span>
        <div className="flex-1 h-2 rounded-full bg-muted-foreground/15 overflow-hidden">
          <div className="grow-bar h-full rounded-full bg-primary" style={{ width: "94%" }} />
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-[3px]">
        {candidates.map((p, i) => (
          <div
            key={p.name}
            className="demo-fade flex items-center justify-between text-[10px] rounded bg-muted-foreground/10 px-1.5 py-[2px]"
            style={{ animationDelay: `${0.2 + i * 0.2}s` }}
          >
            <span className="text-muted-foreground truncate">{p.name}</span>
            <span className="font-semibold text-primary tabular-nums ml-2">{p.fit}</span>
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
        <Send className="w-3 h-3 text-violet-600" />
        Personalized draft ready
      </div>
      <div
        className="demo-fade flex items-center gap-1.5 text-xs text-muted-foreground"
        style={{ animationDelay: "0.25s" }}
      >
        <CheckCircle className="w-3 h-3 text-emerald-600" />
        Approved &amp; sent
      </div>
    </div>
  );
}

function RadarDemo() {
  return (
    <div className="flex items-center gap-3">
      <span className="relative flex h-4 w-4">
        <span className="group-hover:animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500/60" />
        <span className="relative inline-flex rounded-full h-4 w-4 bg-emerald-500/80" />
      </span>
      <span className="demo-fade text-xs text-muted-foreground">
        Job change detected — re-engage now
      </span>
    </div>
  );
}

function ScoreBarsDemo({ hovered }: { hovered: boolean }) {
  const confidence = useCountUp(hovered, 0, 91);
  return (
    <div className="flex items-center gap-4 w-full">
      <div className="flex items-end gap-2 h-9 shrink-0">
        {[0.5, 0.7, 0.9, 0.6, 1].map((h, i) => (
          <span
            key={i}
            className="rise-bar w-4 rounded-t bg-primary/70"
            style={{ height: `${h * 100}%`, animationDelay: `${i * 0.08}s` }}
          />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
          <span>Hiring Confidence</span>
          <span className="font-semibold text-primary tabular-nums">{confidence}%</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted-foreground/15 overflow-hidden">
          <div className="grow-bar h-full rounded-full bg-primary" style={{ width: "91%" }} />
        </div>
      </div>
    </div>
  );
}

function TrendDemo() {
  return (
    <div className="flex items-center gap-3 w-full">
      <svg width="90" height="32" viewBox="0 0 90 32" fill="none" className="shrink-0">
        <path
          className="draw-line"
          d="M2 28 C20 26 30 24 44 18 S 74 8 88 4"
          stroke="hsl(262 83% 58%)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="110"
          strokeDashoffset="110"
        />
      </svg>
      <div className="space-y-1 min-w-0">
        <div className="demo-fade text-[11px] text-muted-foreground">Acceptance forecast ↑</div>
        <span
          className="demo-fade inline-flex items-center gap-1 px-1.5 py-[2px] rounded-md bg-emerald-600/10 text-emerald-700 text-[10px] font-medium"
          style={{ animationDelay: "0.7s" }}
        >
          <CheckCircle className="w-3 h-3" />
          Offer Accepted
        </span>
      </div>
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
          PDF ready
        </span>
        <div
          className="demo-fade text-[11px] text-muted-foreground"
          style={{ animationDelay: "0.65s" }}
        >
          Branded evaluation report — one click
        </div>
      </div>
    </div>
  );
}

const capabilityDemos: Record<string, (hovered: boolean) => React.ReactElement> = {
  "AI Interviews": () => <WaveformDemo />,
  "Blind Resume Screening": () => <RedactionDemo />,
  "Candidate Verification": (hovered) => <ChecksDemo hovered={hovered} />,
  "Capability Matching": (hovered) => <FitScoreDemo hovered={hovered} />,
  "AI Outreach": () => <OutreachDemo />,
  "Career Intelligence": () => <RadarDemo />,
  "Hiring Intelligence": (hovered) => <ScoreBarsDemo hovered={hovered} />,
  "Predictive Outcome Analytics": () => <TrendDemo />,
  "Decision Reports": () => <ReportDemo />,
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
    stage: "Evaluate",
    items: [
      {
        icon: Mic,
        title: "AI Interviews",
        desc: "Adaptive, two-way voice interviews that listen, transcribe live, and ask smart follow-ups — in 45+ languages, with built-in proctoring and integrity reports.",
        color: "text-primary",
        bg: "bg-primary/5",
      },
      {
        icon: FileSearch,
        title: "Blind Resume Screening",
        desc: "Parse PDF and DOCX resumes and score them on skills and experience alone — with personal details redacted for fairness.",
        color: "text-violet-600",
        bg: "bg-violet-600/5",
      },
      {
        icon: ShieldCheck,
        title: "Candidate Verification",
        desc: "Automatically cross-check identity and work history against public signals to flag fraud and inconsistencies with a clear risk score.",
        color: "text-emerald-600",
        bg: "bg-emerald-600/5",
      },
    ],
  },
  {
    stage: "Discover",
    items: [
      {
        icon: Target,
        title: "Capability Matching",
        desc: "Rank candidates against every role with a 0–100 fit score built from skills, history, and real interview performance.",
        color: "text-primary",
        bg: "bg-primary/5",
      },
      {
        icon: Send,
        title: "AI Outreach",
        desc: "Generate personalized, on-brand outreach and run multi-stage nurture sequences — with approval controls and frequency limits.",
        color: "text-violet-600",
        bg: "bg-violet-600/5",
      },
      {
        icon: Radar,
        title: "Career Intelligence",
        desc: "Detect job changes, track engagement with a live connection-strength score, and re-engage talent at exactly the right moment.",
        color: "text-emerald-600",
        bg: "bg-emerald-600/5",
      },
    ],
  },
  {
    stage: "Decide",
    items: [
      {
        icon: Brain,
        title: "Hiring Intelligence",
        desc: "Structured scoring, consistent evaluation, and fairness guardrails turn every interview into evidence you can act on.",
        color: "text-primary",
        bg: "bg-primary/5",
      },
      {
        icon: TrendingUp,
        title: "Predictive Outcome Analytics",
        desc: "Track offers from extended to accepted to start date — and turn every outcome into predictive intelligence that sharpens future hiring decisions.",
        color: "text-violet-600",
        bg: "bg-violet-600/5",
      },
      {
        icon: FileDown,
        title: "Decision Reports",
        desc: "Export polished, branded PDF evaluation reports to share with hiring managers and clients in a single click.",
        color: "text-emerald-600",
        bg: "bg-emerald-600/5",
      },
    ],
  },
];

const LANGS_VISIBLE = [
  "🇺🇸 English",
  "🇮🇳 हिन्दी",
  "🇮🇳 తెలుగు",
  "🇮🇳 தமிழ்",
  "🇮🇳 বাংলা",
  "🇮🇳 मराठी",
  "🇮🇳 ಕನ್ನಡ",
  "🇮🇳 ગુજરાતી",
  "🇮🇳 ਪੰਜਾਬੀ",
  "🇮🇳 മലയാളം",
  "🇲🇽 Español",
  "🇫🇷 Français",
  "🇩🇪 Deutsch",
  "🇯🇵 日本語",
  "🇨🇳 中文",
  "🇸🇦 العربية",
  "🇧🇷 Português",
  "🇷🇺 Русский",
  "🇰🇷 한국어",
];

const LANGS_EXTRA = [
  "🇮🇳 ଓଡ଼ିଆ",
  "🇮🇳 অসমীয়া",
  "🇮🇳 संस्कृत",
  "🇮🇳 سنڌي",
  "🇹🇷 Türkçe",
  "🇮🇩 Bahasa Indonesia",
  "🇻🇳 Tiếng Việt",
  "🇹🇭 ภาษาไทย",
  "🇵🇱 Polski",
  "🇳🇱 Nederlands",
  "🇸🇪 Svenska",
  "🇺🇦 Українська",
  "🇮🇱 עברית",
  "🇮🇷 فارسی",
];

function LanguageStrip() {
  const [expanded, setExpanded] = useState(false);
  const [activeLang, setActiveLang] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setActiveLang((prev) => (prev + 1) % LANGS_VISIBLE.length);
    }, 2500);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="py-16 px-6 border-t border-border/50">
      <div className="max-w-4xl mx-auto text-center">
        <Globe className="w-8 h-8 text-primary mx-auto mb-4" />
        <h3 className="text-2xl sm:text-3xl font-semibold mb-3">
          Talent Has No Language Barrier.{" "}
          <span className="gradient-text">Hiring Shouldn't Either.</span>
        </h3>
        <p className="text-muted-foreground mb-2 text-base max-w-xl mx-auto">
          Every candidate is evaluated the same way — regardless of language.
        </p>
        <p className="text-muted-foreground mb-4 text-sm">
          Hire globally without changing how you evaluate talent.
        </p>
        <p className="text-sm font-medium text-foreground/60 mb-6 max-w-lg mx-auto italic">
          The same candidate, evaluated the same way — anywhere in the world.
        </p>
        <p className="text-xs font-semibold text-primary/70 uppercase tracking-widest mb-4">
          45+ languages. One consistent evaluation standard.
        </p>

        <div className="flex flex-wrap justify-center gap-2 mb-4">
          {LANGS_VISIBLE.map((lang, i) => (
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
          {expanded &&
            LANGS_EXTRA.map((lang) => (
              <span
                key={lang}
                className="px-3 py-1.5 rounded-full text-xs border border-primary/30 bg-primary/5 text-primary/80 hover:border-primary/60 hover:text-primary transition-colors animate-in fade-in duration-300"
              >
                {lang}
              </span>
            ))}
        </div>

        <button
          onClick={() => setExpanded((e) => !e)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-medium border border-border/60 text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all"
        >
          {expanded ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5" /> +{LANGS_EXTRA.length} more languages
            </>
          )}
        </button>
        <div className="mt-6">
          <span className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium border border-primary/30 bg-primary/5 text-primary/80">
            🌍 Used across global hiring teams
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-6 max-w-lg mx-auto">
          Real capability isn't tied to language —{" "}
          <span className="gradient-text font-semibold">and neither is how we evaluate it.</span>
        </p>
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
          Hiring Is Changing Weekly. <span className="gradient-text">Don't Fall Behind.</span>
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
            "Weekly AI hiring insights",
            "Global hiring & compliance updates",
            "New product features before everyone else",
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
    title: "L3XY AI | Get Hired for What You Can Do, Not Your Resume",
    description:
      "AI-powered interviews that turn real candidate ability into verified hiring signals. Employers hire with evidence. Candidates get hired for what they can actually do.",
    path: "/",
  });
  return (
    <div className="min-h-screen mesh-bg">
      <Nav />

      {/* Hero */}
      <section className="pt-40 pb-24 px-6">
        <div className="max-w-5xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-8">
            <Sparkles className="w-3 h-3" />
            Hiring Intelligence • Skills-Based Hiring • 45+ Languages
          </div>

          <h1 className="text-5xl sm:text-6xl lg:text-7xl font-semibold tracking-tight leading-[1.1] mb-6">
            Make Better Hiring Decisions.
            <br />
            <span className="gradient-text text-glow">Not Just Faster Ones.</span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            L3XY replaces resume screening with structured interviews, hiring intelligence, and
            evidence-based candidate evaluation.
          </p>

          {/* Split CTA */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-4">
            <Link href="/candidates">
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary">
                Get Hired
                <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
            <Link href="/employers">
              <button className="flex items-center gap-2 px-6 py-3.5 rounded-xl text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
                Hire Better
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </Link>
          </div>
          <p className="text-base sm:text-lg font-medium text-muted-foreground">
            No resume required · 10-minute AI interview · Trusted evaluation
          </p>

          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-20 pt-12 border-t border-border/50">
            {stats.map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-3xl font-semibold text-violet-600 mb-1">{s.value}</div>
                <div className="text-sm text-muted-foreground">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section 2 — Dual platform */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-4">One system. Two ways to win.</h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-12 leading-relaxed">
            Built on real interview signals — not resumes. Choose how you want to use L3xy.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Hiring side */}
            <div className="p-8 rounded-3xl border border-primary/20 bg-primary/5 text-left">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-5">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <p className="text-xs font-semibold text-primary/70 tracking-widest uppercase mb-2">
                For hiring teams
              </p>
              <h3 className="font-semibold text-xl mb-3 text-foreground">
                Make Confident Hiring Decisions
              </h3>
              <p className="text-muted-foreground mb-6 leading-relaxed">
                Evaluate candidates through structured AI interviews, validated signals, and real
                performance — not just resumes.
              </p>
              <Link href="/employers">
                <button className="flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary/80 transition-colors">
                  See How It Works <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
            </div>

            {/* Career side */}
            <div className="p-8 rounded-3xl border border-primary/20 bg-primary/5 text-left">
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-5">
                <TrendingUp className="w-6 h-6 text-primary" />
              </div>
              <p className="text-xs font-semibold text-primary/70 tracking-widest uppercase mb-2">
                For candidates
              </p>
              <h3 className="font-semibold text-xl mb-3 text-foreground">
                Get Hired for What You Can Actually Do
              </h3>
              <p className="text-muted-foreground mb-6 leading-relaxed">
                Build your profile through real interviews — not resumes — and get matched to roles
                that fit.
              </p>
              <Link href="/candidates">
                <button className="flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary/80 transition-colors">
                  Start Your Interview <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Section 3 — Problem */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
            Hiring Is Broken.
            <br />
            <span className="gradient-text">So Is How We Evaluate People.</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-12 text-left">
            <div className="p-8 rounded-2xl border border-primary/20 bg-primary/5 card-hover">
              <div className="w-11 h-11 rounded-xl bg-background/60 flex items-center justify-center mb-5">
                <Wrench className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-semibold text-lg mb-3">
                Hiring Decisions Are Built on Incomplete Signals
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                Hiring decisions rely on resumes, fragmented tools, and inconsistent evaluation —
                not real performance.
              </p>
            </div>
            <div className="p-8 rounded-2xl border border-primary/20 bg-primary/5 card-hover">
              <div className="w-11 h-11 rounded-xl bg-background/60 flex items-center justify-center mb-5">
                <FileX className="w-5 h-5 text-primary" />
              </div>
              <h3 className="font-semibold text-lg mb-3">
                Resumes Don't Show What Actually Matters
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                They miss how candidates think, communicate, solve problems, and perform in real
                situations.
              </p>
            </div>
          </div>
          <p className="text-base font-semibold text-foreground/80 mt-10">
            The problem isn't hiring volume. It's how we evaluate people.
            <br />
            <span className="gradient-text">Resumes summarize. Interviews reveal.</span>
          </p>
        </div>
      </section>

      {/* Section 4 — Unified solution */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              One System. One Standard of Evaluation.
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Every candidate is evaluated the same way — through real interview performance, not
              resumes.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {unifiedFeatures.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.title}
                  className="p-7 rounded-2xl border border-border bg-card card-hover"
                >
                  <div
                    className={`w-11 h-11 rounded-xl ${f.bg} flex items-center justify-center mb-4`}
                  >
                    <Icon className={`w-5 h-5 ${f.color}`} />
                  </div>
                  <h3 className="font-semibold text-base mb-2">{f.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              );
            })}
          </div>
          <p className="text-center mt-10 text-base font-semibold text-foreground/80">
            One system. One standard.{" "}
            <span className="gradient-text">Better decisions on both sides.</span>
          </p>
        </div>
      </section>

      {/* Section 4b — Full platform capabilities */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-xs font-medium mb-6">
              <Layers className="w-3 h-3" />
              The complete platform
            </div>
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Everything You Need to Hire Better.{" "}
              <span className="gradient-text">One Connected Platform.</span>
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              From first outreach to first day, every capability works together on the same signals
              — no stitched-together point tools.
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
                    <CapabilityCard key={c.title} c={c} featured={c.title === "AI Interviews"} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-center mt-12 text-base font-semibold text-foreground/80">
            One connected platform.{" "}
            <span className="gradient-text">Not a dozen disconnected tools.</span>
          </p>
          <div className="flex justify-center mt-8">
            <Link href="/start-trial">
              <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105 glow-primary">
                Explore the Full Platform
                <ArrowRight className="w-4 h-4" />
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* Section 5 — Employer side detail */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-3xl sm:text-4xl font-semibold mb-6 leading-tight">
                Hire Faster —
                <br />
                <span className="gradient-text text-4xl sm:text-5xl font-bold">
                  Verified Signals.
                </span>
                <br />
                <span className="text-muted-foreground text-2xl sm:text-3xl font-medium">
                  Not Resume Guesswork.
                </span>
              </h2>
              <p className="text-muted-foreground text-lg mb-8 leading-relaxed">
                Every candidate is evaluated through structured AI interviews, verified signals, and
                consistent scoring — giving every hiring manager comparable evidence instead of
                resume guesswork.
              </p>
              <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
                Signals are verified through structured interviews, behavioral evidence, consistency
                checks, and identity verification — not self-reported resumes.
              </p>
              <ul className="space-y-4 mb-8">
                {[
                  "Evaluate candidates through structured interviews — not keyword filters.",
                  "Measure how candidates think, communicate, and solve problems.",
                  "Generate objective, comparable hiring evidence.",
                  "Reduce candidate drop-off with guided interview experiences.",
                  "Hire faster without sacrificing decision quality.",
                ].map((b) => (
                  <li key={b} className="flex items-center gap-3">
                    <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                    <span className="text-muted-foreground">{b}</span>
                  </li>
                ))}
              </ul>
              <Link href="/employers">
                <button className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold border border-primary/40 text-primary hover:bg-primary/10 transition-colors">
                  See L3XY in Action <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
            </div>
            <div className="p-8 rounded-3xl border border-primary/20 bg-primary/5 space-y-4 self-center">
              {[
                { label: "🎯 Capability Match", value: "94", w: "94%" },
                { label: "🛡 Evidence Confidence", value: "91", w: "91%" },
                { label: "💬 Communication", value: "88", w: "88%" },
                { label: "🧩 Problem Solving", value: "92", w: "92%" },
              ].map((s) => (
                <div key={s.label}>
                  <div className="flex justify-between text-sm mb-2">
                    <span className="text-muted-foreground">{s.label}</span>
                    <span className="font-semibold text-foreground">{s.value}</span>
                  </div>
                  <div className="h-2 rounded-full bg-black/10">
                    <div className="h-2 rounded-full bg-primary" style={{ width: s.w }} />
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground text-center pt-4 border-t border-border/50">
                Every candidate is measured against the same structured framework — making hiring
                more consistent, fair, and defensible.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Section 6 — Candidate side detail */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
            <div className="p-8 rounded-3xl border border-primary/20 bg-primary/5 order-2 self-center">
              <p className="text-xs font-semibold text-primary/80 uppercase tracking-widest mb-4">
                Most candidates struggle because:
              </p>
              <ul className="space-y-3 mb-6">
                {[
                  "Resumes don't reflect how you actually perform",
                  "You don't know what hiring teams really evaluate",
                  "You apply without feedback or clear direction",
                  "You prepare for interviews without knowing what matters",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <span className="text-primary mt-0.5 flex-shrink-0">✕</span>
                    <span className="text-sm text-muted-foreground">{item}</span>
                  </li>
                ))}
              </ul>
              <div className="border-t border-border/40 pt-5">
                <p className="text-xs font-semibold text-primary/80 uppercase tracking-widest mb-4">
                  L3xy changes how you get evaluated:
                </p>
                <ul className="space-y-3">
                  {[
                    "Real interviews that show how you think and perform",
                    "A career profile built from your actual strengths",
                    "Clear visibility into what you're good at — and what to improve",
                    "Opportunities matched to your real capability",
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-3">
                      <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                      <span className="text-sm text-muted-foreground">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="order-1">
              <h2 className="text-4xl sm:text-5xl font-semibold mb-6 leading-tight">
                Get Hired For <span className="gradient-text">What You Can Actually Do.</span>
              </h2>
              <p className="text-muted-foreground text-xl mb-8 leading-relaxed">
                Your resume tells employers where you've been. L3XY shows them what you can actually
                do.
              </p>
              <Link href="/candidates">
                <button className="flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold border border-primary/40 text-primary hover:bg-primary/10 transition-colors mb-6">
                  Start My Interview <ArrowRight className="w-4 h-4" />
                </button>
              </Link>
              <p className="text-sm font-semibold text-foreground/70">
                Walk into every interview knowing exactly where you stand.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Section 7 — Bridge */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-semibold mb-6">
            One Platform. Better Hiring. Better Careers.
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto mb-12">
            Candidates prove what they can do. Employers hire using the same verified signals.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-3 mb-12">
            {["Candidate", "Verified Signals", "Employer", "Better Hiring"].map((step, i) => (
              <div key={step} className="flex flex-col sm:flex-row items-center gap-2 sm:gap-3">
                {i > 0 && <ArrowRight className="w-4 h-4 text-primary/50 rotate-90 sm:rotate-0" />}
                <span
                  className={`px-4 py-2 rounded-full text-sm font-semibold border ${
                    step === "Verified Signals"
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border bg-card text-foreground/80"
                  }`}
                >
                  {step}
                </span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-10 relative">
            <div className="hidden sm:block absolute top-1/2 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/25 to-transparent -z-10" />
            {[
              {
                icon: Shield,
                title: "Candidates Build Evidence",
                text: "Real interviews create verified career signals that go beyond resumes.",
                color: "text-violet-600",
                bg: "bg-violet-600/10",
                border: "border-violet-600/20",
              },
              {
                icon: Brain,
                title: "Companies Hire With Evidence",
                text: "Hiring decisions are based on the same structured signals — not guesswork.",
                color: "text-emerald-600",
                bg: "bg-emerald-600/10",
                border: "border-emerald-600/20",
              },
              {
                icon: Zap,
                title: "Everyone Wins",
                text: "Better candidates. Better hiring decisions. Better long-term outcomes.",
                color: "text-amber-600",
                bg: "bg-amber-600/10",
                border: "border-amber-600/20",
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
          <p className="text-sm font-semibold text-foreground/60">
            One interview. One set of verified signals.{" "}
            <span className="gradient-text">Better decisions for everyone.</span>
          </p>
        </div>
      </section>

      {/* Section 8 — How it works */}
      <section id="how-it-works" className="py-24 px-6 border-t border-border/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-4">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              How Hiring Actually Works — <span className="gradient-text">With Real Signals</span>
            </h2>
            <p className="text-muted-foreground text-base">
              From interview to decision — in one consistent system
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mt-12">
            {howItWorks.map((step, i) => (
              <div key={step.num} className="relative">
                {i < howItWorks.length - 1 && (
                  <>
                    <div className="hidden lg:flex absolute top-8 -translate-y-1/2 left-full translate-x-1/2 z-20 items-center justify-center w-6 h-6 rounded-full bg-background border border-primary/30">
                      <ArrowRight className="w-3 h-3 text-primary" />
                    </div>
                    <div className="flex lg:hidden justify-center py-1">
                      <ArrowRight className="w-4 h-4 text-primary/50 rotate-90 absolute -bottom-5" />
                    </div>
                  </>
                )}
                <div className="p-6 rounded-2xl border border-border/50 bg-card h-full card-hover">
                  <div className="text-4xl font-black text-primary/20 mb-4 leading-none">
                    {step.num}
                  </div>
                  <h3 className="font-semibold text-sm mb-2">{step.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-center gap-2 mt-8">
            <svg
              className="w-5 h-5 text-primary/60"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12a9 9 0 1 0 9-9" />
              <path d="M3 4v8h8" />
            </svg>
            <p className="text-sm text-muted-foreground italic">
              Every interview strengthens the hiring intelligence behind the next one.
            </p>
          </div>
          <p className="text-center text-sm font-semibold text-foreground/60 mt-8">
            No resumes. No guesswork.{" "}
            <span className="gradient-text">
              Just real, comparable signals driving every decision.
            </span>
          </p>
        </div>
      </section>

      {/* Why L3XY Wins */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              Why <span className="gradient-text">L3XY</span> Wins
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Traditional tools filter resumes. L3XY builds hiring evidence.
            </p>
          </div>
          <div className="rounded-3xl border border-border overflow-hidden">
            <div className="grid grid-cols-2 bg-muted/40 border-b border-border">
              <div className="px-6 py-4 text-sm font-semibold text-muted-foreground">
                Traditional ATS
              </div>
              <div className="px-6 py-4 text-sm font-semibold text-primary border-l border-border bg-primary/15">
                L3XY
              </div>
            </div>
            {[
              ["Resume keyword screening", "Verified hiring signals"],
              ["Keyword-based matching", "Capability-based matching"],
              ["Multiple disconnected tools", "One connected hiring system"],
              ["Static candidate profiles", "Living candidate profiles"],
              ["Gut-feel hiring decisions", "Evidence-based decisions"],
            ].map(([left, right], i, arr) => (
              <div
                key={left}
                className={`grid grid-cols-2 ${i < arr.length - 1 ? "border-b border-border/60" : ""}`}
              >
                <div className="px-6 py-4 flex items-center gap-2.5 text-sm text-muted-foreground">
                  <span className="text-muted-foreground/50 flex-shrink-0">✕</span>
                  {left}
                </div>
                <div className="px-6 py-4 flex items-center gap-2.5 text-sm font-medium text-foreground border-l border-border bg-primary/10">
                  <CheckCircle className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                  {right}
                </div>
              </div>
            ))}
          </div>
          <p className="text-center text-lg sm:text-xl font-medium mt-10">
            Don't hire based on what candidates wrote.{" "}
            <span className="gradient-text font-semibold">Hire based on what they proved.</span>
          </p>
        </div>
      </section>

      {/* Language badge strip */}
      <LanguageStrip />

      {/* Newsletter signup */}
      <NewsletterSignup />

      {/* Final CTA */}
      <section className="py-24 px-6 border-t border-border/50">
        <div className="max-w-3xl mx-auto text-center">
          <div className="p-12 rounded-3xl border border-primary/20 bg-primary/5 glow-primary">
            <Sparkles className="w-10 h-10 text-primary mx-auto mb-6" />
            <h2 className="text-3xl sm:text-4xl font-semibold mb-4">
              From Guesswork to <span className="gradient-text">Hiring Confidence.</span>
              <span className="block mt-1">Powered by Real Signals.</span>
            </h2>
            <p className="text-muted-foreground text-lg mb-8">
              Structured AI interviews, verified signals, and predictive hiring intelligence — so
              every hiring decision is backed by evidence.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-5">
              <Link href="/employers">
                <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-all hover:scale-105">
                  Start Hiring with Confidence
                  <ArrowRight className="w-5 h-5" />
                </button>
              </Link>
              <Link href="/candidates">
                <button className="flex items-center gap-2 px-8 py-4 rounded-xl text-base font-medium border border-border hover:border-primary/40 transition-colors text-muted-foreground hover:text-foreground">
                  Build My Career Profile
                  <ArrowRight className="w-5 h-5" />
                </button>
              </Link>
            </div>
            <p className="text-xs text-muted-foreground mb-6">
              No implementation delays. Live in minutes.
            </p>
            <p className="text-sm font-semibold text-foreground/60 border-t border-border/30 pt-6">
              Most platforms track hiring.{" "}
              <span className="gradient-text">L3XY improves hiring.</span>
            </p>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
