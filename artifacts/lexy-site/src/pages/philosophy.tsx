import { useEffect, useRef, useState } from "react";
import { usePageMeta } from "@/lib/seo";
import { Link } from "wouter";
import { motion, useInView, useReducedMotion, useScroll, useTransform } from "framer-motion";
import {
  ArrowLeft,
  Compass,
  Users,
  ShieldCheck,
  Globe2,
  Scale,
  Lock,
  TrendingUp,
  Sparkles,
} from "lucide-react";
import LexyLogo from "@/components/LexyLogo";
import SiteFooter from "@/components/SiteFooter";

/*
 * Typewriter — types out `text` character-by-character once the element
 * scrolls into view, with a blinking caret while typing. Respects
 * prefers-reduced-motion (renders instantly) and keeps the full text
 * available to screen readers / SEO via aria-label.
 */
function Typewriter({
  text,
  className,
  speed = 55,
  startDelay = 0,
  keepCaret = false,
}: {
  text: string;
  className?: string;
  speed?: number;
  startDelay?: number;
  keepCaret?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  const reduceMotion = useReducedMotion();
  const [count, setCount] = useState(0);
  const done = count >= text.length;

  useEffect(() => {
    if (!inView || reduceMotion) return;
    let i = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (cancelled) return;
      i += 1;
      setCount(i);
      if (i >= text.length) return;
      // Slight human jitter per keystroke, tiny pause after spaces
      const jitter = speed * (0.7 + Math.random() * 0.6) + (text[i - 1] === " " ? speed * 0.5 : 0);
      timer = setTimeout(tick, jitter);
    };
    timer = setTimeout(tick, startDelay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inView, reduceMotion, text, speed, startDelay]);

  const visible = reduceMotion ? text : text.slice(0, count);

  return (
    <span ref={ref} className={className} aria-label={text} role="text">
      <span aria-hidden="true">{visible}</span>
      {!reduceMotion && (keepCaret || !done) && (
        <span
          aria-hidden="true"
          className={`inline-block w-[0.08em] min-w-[2px] h-[0.9em] bg-primary align-[-0.08em] ml-[0.06em] ${
            inView ? "animate-caret-blink" : "opacity-0"
          }`}
        />
      )}
    </span>
  );
}

const FADE_UP = {
  hidden: { opacity: 0, y: 40 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.8, ease: [0.16, 1, 0.3, 1] as const } },
};

function Section({
  title,
  icon,
  children,
  index,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  index: number;
}) {
  return (
    <motion.section
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-100px" }}
      variants={FADE_UP}
      className="grid grid-cols-1 md:grid-cols-12 gap-8 md:gap-16 py-16 md:py-24 border-t border-border/40"
    >
      <div className="md:col-span-5 flex flex-col md:sticky md:top-32 h-fit">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
            {icon}
          </div>
          <span className="text-primary font-mono text-sm font-bold tracking-widest">0{index}</span>
        </div>
        <h2 className="text-3xl md:text-4xl font-bold text-foreground leading-tight tracking-tight">
          <Typewriter text={title} speed={50} />
        </h2>
      </div>
      <div className="md:col-span-7 space-y-6 text-lg md:text-xl text-muted-foreground leading-relaxed font-medium">
        {children}
      </div>
    </motion.section>
  );
}

function Emphasis({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-foreground font-semibold text-xl md:text-2xl mt-8 mb-4 border-l-4 border-primary pl-6 py-1">
      {children}
    </p>
  );
}

export default function Philosophy() {
  usePageMeta({
    title: "Our Philosophy",
    description:
      "Technology changes. People don't. Why Lexy is built to amplify human potential — AI that helps people accomplish extraordinary things together.",
    path: "/philosophy",
  });

  const { scrollYProgress } = useScroll();
  const y = useTransform(scrollYProgress, [0, 1], ["0%", "20%"]);
  const opacity = useTransform(scrollYProgress, [0, 0.2], [1, 0]);

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/20 selection:text-primary">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/10 bg-background/80 backdrop-blur-2xl">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center cursor-pointer gap-2 hover:opacity-80 transition-opacity">
              <LexyLogo size="md" />
            </div>
          </Link>
          <Link href="/">
            <button className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors bg-muted/30 px-4 py-2 rounded-full hover:bg-muted/50">
              <ArrowLeft className="w-4 h-4" /> Back to Home
            </button>
          </Link>
        </div>
      </nav>

      <main>
        {/* Hero Section */}
        <section className="relative pt-40 pb-24 md:pt-52 md:pb-40 px-6 overflow-hidden flex items-center min-h-[90vh]">
          {/* Background Elements */}
          <div className="absolute inset-0 pointer-events-none mesh-bg opacity-40" />
          <motion.div
            style={{ y, opacity }}
            className="absolute top-1/4 right-0 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[120px] pointer-events-none"
          />

          <div className="max-w-5xl mx-auto relative z-10">
            <motion.div
              initial="hidden"
              animate="visible"
              variants={{
                hidden: { opacity: 0 },
                visible: { opacity: 1, transition: { staggerChildren: 0.15 } },
              }}
            >
              <motion.div variants={FADE_UP} className="flex items-center gap-3 mb-8">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shadow-[0_0_30px_rgba(0,113,227,0.2)]">
                  <Compass className="w-5 h-5" />
                </div>
                <span className="text-sm text-primary font-bold uppercase tracking-[0.2em]">
                  Our Philosophy
                </span>
              </motion.div>

              <motion.h1
                variants={FADE_UP}
                className="text-5xl md:text-7xl lg:text-[5.5rem] font-black leading-[1.05] tracking-tight mb-12 text-balance"
              >
                <Typewriter text="Technology changes." speed={90} startDelay={300} />
                <br />
                <Typewriter
                  text="People don't."
                  speed={90}
                  startDelay={300 + 90 * 19 + 600}
                  keepCaret
                  className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-blue-400"
                />
              </motion.h1>

              <motion.div
                variants={FADE_UP}
                className="max-w-3xl space-y-6 text-xl md:text-2xl text-muted-foreground font-medium leading-relaxed"
              >
                <p>
                  Every breakthrough in technology has promised to replace human work. The internet.
                  Cloud computing. Automation. Artificial intelligence.
                </p>
                <p>We believe the future is different.</p>
                <div className="text-2xl md:text-3xl text-foreground font-bold mt-8 mb-4 border-l-4 border-primary pl-6 py-2">
                  The future isn't AI replacing people. It's AI helping people achieve what was
                  previously impossible.
                </div>
                <p>That belief is the foundation of Lexy.</p>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* Manifesto Sections */}
        <section className="px-6 pb-32">
          <div className="max-w-5xl mx-auto">
            <Section
              index={1}
              title="AI Should Amplify Human Potential"
              icon={<Users className="w-6 h-6" />}
            >
              <p>We don't believe great hiring decisions should be made by algorithms alone.</p>
              <p>Hiring is ultimately about people. Judgment. Experience. Empathy. Trust.</p>
              <p>
                Artificial intelligence can analyze more information than any human ever could. It
                can identify patterns, surface insights, eliminate repetitive work, and accelerate
                decisions.
              </p>
              <Emphasis>But accountability should always belong to people.</Emphasis>
              <p>
                Lexy exists to make recruiters, hiring managers, and business leaders dramatically
                more capable — not less important. Every recommendation Lexy makes is designed to
                support human decision-making, never replace it.
              </p>
            </Section>

            <Section
              index={2}
              title="Humans Stay In Control"
              icon={<ShieldCheck className="w-6 h-6" />}
            >
              <p>Automation should remove administrative work, not human responsibility.</p>
              <p>Every organization deserves to know:</p>
              <ul className="space-y-4 my-6 bg-muted/20 p-8 rounded-2xl border border-border/50">
                <li className="flex gap-4 items-start">
                  <span className="text-primary font-bold text-xl leading-none">•</span>
                  <span className="text-foreground">Why a recommendation was made.</span>
                </li>
                <li className="flex gap-4 items-start">
                  <span className="text-primary font-bold text-xl leading-none">•</span>
                  <span className="text-foreground">What information was considered.</span>
                </li>
                <li className="flex gap-4 items-start">
                  <span className="text-primary font-bold text-xl leading-none">•</span>
                  <span className="text-foreground">Where uncertainty exists.</span>
                </li>
                <li className="flex gap-4 items-start">
                  <span className="text-primary font-bold text-xl leading-none">•</span>
                  <span className="text-foreground">When human review is required.</span>
                </li>
              </ul>
              <Emphasis>We believe explainability is not a feature. It is a requirement.</Emphasis>
              <p>
                The most important decisions in a company should always have a human accountable for
                the outcome.
              </p>
            </Section>

            <Section
              index={3}
              title="Trust Is Our Competitive Advantage"
              icon={<ShieldCheck className="w-6 h-6" />}
            >
              <p>AI will only become part of everyday work if people trust it.</p>
              <p>
                That trust cannot be earned through marketing. It is earned through transparency,
                consistency, security, and responsible design.
              </p>
              <p>We design every capability with a simple question:</p>
              <Emphasis>Would we trust this to help hire someone into our own company?</Emphasis>
              <p>If the answer isn't yes, we don't build it.</p>
            </Section>

            <Section
              index={4}
              title="Global Work Requires Global Responsibility"
              icon={<Globe2 className="w-6 h-6" />}
            >
              <p>Hiring across borders is more than finding talent.</p>
              <p>
                It means navigating employment laws, payroll, compliance, culture, language, and
                local expectations.
              </p>
              <Emphasis>AI should make global hiring easier — not riskier.</Emphasis>
              <p>
                Lexy is built to help organizations make informed decisions while respecting local
                regulations, human rights, and the unique realities of every market.
              </p>
            </Section>

            <Section
              index={5}
              title="AI Should Reduce Bias, Not Hide It"
              icon={<Scale className="w-6 h-6" />}
            >
              <p>Artificial intelligence is not inherently fair.</p>
              <p>It learns from human data, and human data contains human bias.</p>
              <Emphasis>
                That is why fairness cannot be assumed. It must be intentionally designed,
                continuously evaluated, and transparently measured.
              </Emphasis>
              <p>
                We believe responsible AI means constantly questioning our own systems, improving
                them, and giving organizations the visibility needed to make informed decisions.
              </p>
            </Section>

            <Section index={6} title="Privacy Is Not Optional" icon={<Lock className="w-6 h-6" />}>
              <p>The future of work depends on trust.</p>
              <p>
                Candidates deserve dignity. Customers deserve control. Data deserves protection.
              </p>
              <p>
                We build Lexy so organizations understand how AI is used, what information is
                analyzed, and where human oversight exists.
              </p>
              <Emphasis>
                Privacy, security, and governance are not features added after the product is built.
                They are part of the architecture from day one.
              </Emphasis>
            </Section>

            <Section
              index={7}
              title="Progress Over Perfection"
              icon={<TrendingUp className="w-6 h-6" />}
            >
              <p>Artificial intelligence will continue to evolve. So will we.</p>
              <p>We will continue learning, improving, and listening to customers.</p>
              <Emphasis>
                Our responsibility is not to build an AI that knows everything. Our responsibility
                is to build one that helps people make better decisions every day.
              </Emphasis>
            </Section>

            <Section
              index={8}
              title="The Future We Believe In"
              icon={<Sparkles className="w-6 h-6" />}
            >
              <p>
                We believe every recruiter should have the capabilities of an entire research team.
              </p>
              <p>Every hiring manager should have better information before making decisions.</p>
              <p>Every organization should be able to hire globally with confidence.</p>
              <p>
                And every candidate deserves a hiring experience that is faster, more transparent,
                and more human.
              </p>
              <Emphasis>
                Technology should never replace humanity. It should give humanity more time to do
                what only people can do.
              </Emphasis>
            </Section>

            {/* Conclusion */}
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-100px" }}
              variants={FADE_UP}
              className="mt-24 rounded-[2rem] bg-primary relative overflow-hidden"
            >
              <div className="absolute inset-0 mesh-bg opacity-20 mix-blend-overlay" />
              <div className="absolute inset-0 bg-gradient-to-br from-primary via-primary to-blue-600 opacity-90" />
              <div className="relative px-8 py-20 md:py-32 text-center max-w-4xl mx-auto flex flex-col items-center justify-center">
                <LexyLogo size="lg" />
                <p className="mt-12 text-2xl md:text-4xl lg:text-5xl font-black text-white leading-tight tracking-tight text-balance">
                  That's why we built Lexy. Not to replace people.{" "}
                  <span className="text-white/70 block mt-2">
                    To help people accomplish extraordinary things together.
                  </span>
                </p>
              </div>
            </motion.div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
