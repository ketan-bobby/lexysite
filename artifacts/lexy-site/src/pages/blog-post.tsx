import { usePageMeta } from "@/lib/seo";
import { Link, useParams } from "wouter";
import { ArrowLeft, ArrowRight, BookOpen, Check, Clock, Download } from "lucide-react";
import {
  getArticle,
  getCluster,
  articles,
  DOWNLOADS,
  FORMAT_META,
  LEVEL_META,
} from "@/content/articles";
import React from "react";

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
          <Link href="/blog">
            <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" /> All articles
            </button>
          </Link>
        </div>
      </div>
    </nav>
  );
}

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return part;
  });
}

function ArticleBody({ body }: { body: string }) {
  const blocks: React.ReactElement[] = [];
  const lines = body.split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, i) => (
      <li key={i} className="leading-relaxed">
        {renderInline(item)}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={key++} className="list-decimal pl-6 space-y-2 text-muted-foreground">
          {items}
        </ol>
      ) : (
        <ul key={key++} className="list-disc pl-6 space-y-2 text-muted-foreground">
          {items}
        </ul>
      ),
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (line.startsWith("## ")) {
      flushList();
      blocks.push(
        <h2 key={key++} className="text-2xl font-semibold tracking-tight mt-10 mb-4">
          {renderInline(line.slice(3))}
        </h2>,
      );
    } else if (/^- /.test(line)) {
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(line.slice(2));
    } else if (/^\d+\.\s/.test(line)) {
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(line.replace(/^\d+\.\s/, ""));
    } else {
      flushList();
      blocks.push(
        <p key={key++} className="text-muted-foreground leading-relaxed mb-5">
          {renderInline(line)}
        </p>,
      );
    }
  }
  flushList();
  return <div>{blocks}</div>;
}

function ToolkitGate() {
  const [email, setEmail] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = React.useState("");
  const zipUrl = `${import.meta.env.BASE_URL}downloads/l3xy-complete-hiring-toolkit.zip`;

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
      const res = await fetch(`/api/newsletter/subscribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, source: "blog-toolkit" }),
      });
      if (res.ok) {
        setStatus("success");
        const a = document.createElement("a");
        a.href = zipUrl;
        a.download = "l3xy-complete-hiring-toolkit.zip";
        document.body.appendChild(a);
        a.click();
        a.remove();
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
    <div className="mt-8 rounded-2xl border border-primary/40 bg-card p-6">
      <div className="text-[11px] font-semibold tracking-widest uppercase text-primary mb-1">
        Premium
      </div>
      <h3 className="text-lg font-semibold tracking-tight mb-1">Complete Hiring Toolkit (ZIP)</h3>
      <p className="text-sm text-muted-foreground mb-4">
        All 8 L3XY templates in one download — scorecard, rubric, competency matrix, question bank,
        checklists, and rollout plan. We'll also send you new research as we publish it.
      </p>
      {status === "success" ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full bg-emerald-600/10 border border-emerald-600/30 text-emerald-600 text-sm font-medium px-4 py-2">
            <Check className="w-4 h-4" /> You're on the list — your download has started.
          </span>
          <a
            href={zipUrl}
            download
            className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
          >
            <Download className="w-4 h-4" /> Download again
          </a>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate className="flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (status === "error") setStatus("idle");
            }}
            placeholder="Work email"
            className="flex-1 rounded-xl border border-border bg-background px-4 py-2.5 text-sm outline-none focus:border-primary/60"
          />
          <button
            type="submit"
            disabled={status === "loading"}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary text-primary-foreground px-5 py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {status === "loading" ? "Sending…" : "Get the toolkit"}
            <Download className="w-4 h-4" />
          </button>
        </form>
      )}
      {status === "error" && errorMsg && <p className="mt-2 text-xs text-red-600">{errorMsg}</p>}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Requires email. No spam — unsubscribe anytime.
      </p>
    </div>
  );
}

export default function BlogPost() {
  const params = useParams<{ slug: string }>();
  const article = getArticle(params.slug ?? "");

  usePageMeta(
    article
      ? {
          title: article.title,
          description: article.excerpt,
          path: `/blog/${article.slug}`,
        }
      : {
          title: "Article Not Found",
          description: "This article could not be found.",
          path: "/blog",
          noIndex: true,
        },
  );

  if (!article) {
    return (
      <div className="min-h-screen app-bg text-foreground">
        <Nav />
        <section className="pt-40 pb-24 px-6 text-center">
          <h1 className="text-3xl font-semibold mb-4">Article not found</h1>
          <p className="text-muted-foreground mb-8">
            The article you're looking for doesn't exist or has moved.
          </p>
          <Link href="/blog">
            <button className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">
              Browse all articles <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
        </section>
      </div>
    );
  }

  const related = articles
    .filter((a) => a.category === article.category && a.slug !== article.slug)
    .slice(0, 3);
  const cluster = getCluster(article.slug);
  const clusterArticles = cluster
    ? cluster.slugs.map((s) => articles.find((a) => a.slug === s)).filter((a) => a !== undefined)
    : [];
  const fmt = FORMAT_META[article.format ?? "guide"];

  return (
    <div className="min-h-screen app-bg text-foreground">
      <Nav />

      <article className="pt-32 pb-16 px-6">
        <div className="max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium bg-primary/10 text-primary border border-primary/20 mb-6">
            <BookOpen className="w-3.5 h-3.5" />
            {article.category}
          </div>
          <h1 className="text-3xl md:text-5xl font-semibold tracking-tight leading-[1.15] mb-4">
            {article.title}
          </h1>
          <p className="text-lg text-muted-foreground leading-relaxed mb-4">{article.excerpt}</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mb-10">
            <span>
              {fmt.icon} {fmt.label}
            </span>
            <span className="text-border">•</span>
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" />
              {article.readTime}
            </span>
            <span className="text-border">•</span>
            <span
              className={`px-2.5 py-0.5 rounded-full border font-semibold ${LEVEL_META[article.level ?? "intermediate"].className}`}
            >
              {LEVEL_META[article.level ?? "intermediate"].label}
            </span>
          </div>
          <div className="border-t border-border pt-10">
            <ArticleBody body={article.body} />
          </div>

          {article.downloads && article.downloads.length > 0 && (
            <div className="mt-12 rounded-3xl border border-primary/20 bg-primary/5 p-8">
              <div className="flex items-center gap-2 mb-1">
                <Download className="w-5 h-5 text-primary" />
                <h2 className="text-xl font-semibold tracking-tight">Downloads</h2>
              </div>
              <div className="text-[11px] font-semibold tracking-widest uppercase text-primary mt-5 mb-1">
                Free
              </div>
              <p className="text-sm text-muted-foreground mb-4">
                Ready-to-use templates from this article. No email required.
              </p>
              <div className="grid sm:grid-cols-2 gap-3">
                {article.downloads.map((key) => {
                  const asset = DOWNLOADS[key];
                  if (!asset) return null;
                  return (
                    <a
                      key={key}
                      href={`${import.meta.env.BASE_URL}downloads/${asset.file}`}
                      download
                      className="group flex items-start gap-3 rounded-2xl border border-border bg-card p-4 hover:border-primary/50 transition-colors"
                    >
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                        <Check className="w-3 h-3" />
                      </span>
                      <span>
                        <span className="block text-sm font-semibold text-foreground group-hover:text-primary transition-colors">
                          {asset.label}
                        </span>
                        <span className="block text-xs text-muted-foreground mt-0.5">
                          {asset.description}
                        </span>
                        <span className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary">
                          <Download className="w-3 h-3" /> Download PDF
                        </span>
                      </span>
                    </a>
                  );
                })}
              </div>
              <ToolkitGate />
            </div>
          )}
        </div>
      </article>

      {cluster && clusterArticles.length > 1 && (
        <section className="pb-16 px-6">
          <div className="max-w-3xl mx-auto rounded-3xl border border-border bg-card p-8">
            <div className="text-[11px] font-semibold tracking-widest uppercase text-primary mb-1">
              Topic series
            </div>
            <h2 className="text-xl font-semibold tracking-tight mb-6">
              {cluster.name}: read the full series
            </h2>
            <ol className="space-y-2">
              {clusterArticles.map((item, i) => {
                const current = item.slug === article.slug;
                return (
                  <li key={item.slug}>
                    {current ? (
                      <div className="flex items-start gap-3 rounded-xl bg-primary/10 border border-primary/30 px-4 py-3">
                        <span className="text-xs font-semibold text-primary mt-0.5">{i + 1}</span>
                        <span className="text-sm font-semibold text-foreground">
                          {item.title}
                          <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-primary">
                            You're here
                          </span>
                        </span>
                      </div>
                    ) : (
                      <Link href={`/blog/${item.slug}`}>
                        <div className="group flex items-start gap-3 rounded-xl border border-transparent hover:border-border hover:bg-muted-bg px-4 py-3 transition-colors cursor-pointer">
                          <span className="text-xs font-semibold text-muted-foreground mt-0.5">
                            {i + 1}
                          </span>
                          <span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors">
                            {item.title}
                          </span>
                        </div>
                      </Link>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </section>
      )}

      {!cluster && related.length > 0 && (
        <section className="pb-16 px-6">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-xl font-semibold tracking-tight mb-6">
              More on {article.category}
            </h2>
            <div className="grid md:grid-cols-3 gap-4">
              {related.map((rel) => (
                <Link key={rel.slug} href={`/blog/${rel.slug}`}>
                  <div className="rounded-2xl border border-border bg-card p-5 h-full flex flex-col hover:border-primary/40 transition-colors cursor-pointer">
                    <h3 className="text-sm font-semibold leading-snug mb-2">{rel.title}</h3>
                    <div className="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="w-3 h-3" />
                      {rel.readTime}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      <section className="pb-24 px-6">
        <div className="max-w-3xl mx-auto rounded-3xl border border-primary/20 bg-primary/5 p-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight mb-3">
            Hire on <span className="gradient-text">evidence</span>, not claims.
          </h2>
          <p className="text-muted-foreground mb-6">
            L3XY runs structured AI interviews that turn every candidate into verified hiring
            signals.
          </p>
          <Link href="/start-trial">
            <button className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity">
              Start free trial <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
        </div>
      </section>
    </div>
  );
}
