import { usePageMeta } from "@/lib/seo";
import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ArrowRight, BookOpen, FlaskConical } from "lucide-react";
import { articles, CATEGORIES, FEATURED_SLUG, FORMAT_META, LEVEL_META } from "@/content/articles";

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
        </div>
      </div>
    </nav>
  );
}

export default function Blog() {
  usePageMeta({
    title: "L3XY Hiring Intelligence — AI Hiring Insights & Research",
    description:
      "Research, hiring trends, AI interview insights, and product updates from the team building L3XY. Guides on structured interviews, evidence-based hiring, and skills-based hiring.",
    path: "/blog",
  });
  const [activeCategory, setActiveCategory] = useState<(typeof CATEGORIES)[number]>("All");
  const featured = articles.find((a) => a.slug === FEATURED_SLUG);
  const pool =
    activeCategory === "All" ? articles.filter((a) => a.slug !== FEATURED_SLUG) : articles;
  const visiblePosts =
    activeCategory === "All" ? pool : pool.filter((p) => p.category === activeCategory);
  return (
    <div className="min-h-screen app-bg text-foreground">
      <Nav />

      <section className="pt-32 pb-16 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20 mb-6">
            <BookOpen className="w-3.5 h-3.5" />
            The L3XY Blog
          </div>
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight leading-[1.1] mb-4">
            L3XY <span className="gradient-text">Hiring Intelligence</span>
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl leading-relaxed">
            Ideas, research, and practical guidance on evidence-based hiring — for employers who
            want better decisions and candidates who want a fairer shot.
          </p>

          <div className="flex flex-wrap gap-2 mt-8">
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-4 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                  activeCategory === cat
                    ? "border-primary/60 bg-primary/10 text-primary"
                    : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </section>

      {featured && activeCategory === "All" && (
        <section className="pb-12 px-6">
          <div className="max-w-6xl mx-auto">
            <Link href={`/blog/${featured.slug}`}>
              <article className="relative overflow-hidden rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card p-8 md:p-12 hover:border-primary/60 transition-colors cursor-pointer">
                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-semibold tracking-widest uppercase bg-primary text-primary-foreground mb-5">
                  <FlaskConical className="w-3.5 h-3.5" />
                  Featured Research
                </div>
                <h2 className="text-2xl md:text-4xl font-semibold tracking-tight leading-[1.15] mb-4 max-w-3xl">
                  {featured.title}
                </h2>
                <p className="text-muted-foreground leading-relaxed mb-6 max-w-2xl">
                  Original research from L3XY analyzing thousands of interview signals.
                </p>
                <div className="flex flex-wrap items-center gap-4">
                  <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-semibold">
                    Read Research <ArrowRight className="w-4 h-4" />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {FORMAT_META[featured.format ?? "guide"].icon}{" "}
                    {FORMAT_META[featured.format ?? "guide"].label} •{" "}
                    {featured.readTime.replace(" read", "")}
                  </span>
                </div>
              </article>
            </Link>
          </div>
        </section>
      )}

      <section className="pb-24 px-6">
        <div className="max-w-6xl mx-auto grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {visiblePosts.map((post) => (
            <Link key={post.slug} href={`/blog/${post.slug}`}>
              <article className="rounded-2xl border border-border bg-card p-6 flex flex-col h-full hover:border-primary/40 transition-colors cursor-pointer">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-primary">{post.category}</span>
                  <span
                    className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${LEVEL_META[post.level ?? "intermediate"].className}`}
                  >
                    {LEVEL_META[post.level ?? "intermediate"].label}
                  </span>
                </div>
                <h2 className="text-lg font-semibold leading-snug mb-3">{post.title}</h2>
                <p className="text-sm text-muted-foreground leading-relaxed mb-6 flex-1">
                  {post.excerpt}
                </p>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    {FORMAT_META[post.format ?? "guide"].icon}{" "}
                    {FORMAT_META[post.format ?? "guide"].label} •{" "}
                    {post.readTime.replace(" read", "")}
                  </span>
                  <span className="flex items-center gap-1 text-primary font-medium">
                    Read article <ArrowRight className="w-3.5 h-3.5" />
                  </span>
                </div>
              </article>
            </Link>
          ))}
        </div>
      </section>

      <section className="pb-24 px-6">
        <div className="max-w-3xl mx-auto text-center rounded-2xl border border-border bg-card p-10">
          <h2 className="text-2xl font-semibold mb-3">Hire on evidence, not claims.</h2>
          <p className="text-muted-foreground mb-8">
            L3XY runs structured AI interviews that turn every candidate into verified hiring
            signals.
          </p>
          <Link href="/start-trial">
            <button className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 transition-colors mx-auto">
              See How L3XY Works
              <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
        </div>
      </section>
    </div>
  );
}
