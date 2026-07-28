/*
 * pages/ai-system-card.tsx — Public AI System Card (T011l)
 *
 * Renders `docs/AI_SYSTEM_CARD.md` (imported at build time as raw text)
 * at the stable URL /trust/ai. This page is the canonical public
 * disclosure of what the Lexy AI does, how it is constrained, what
 * data it ingests, what it does not infer, and where appeals go.
 *
 * The recruiter portal's /portal/aedt-notice page, the public footer,
 * and outbound disclosure emails all link here, so the URL must
 * remain stable. The markdown source is mastered in /docs so the
 * legal/compliance team can edit it without touching React.
 *
 * Renderer is intentionally tiny — there is no markdown dependency
 * elsewhere in the project, and adding one for a single page is not
 * worth the bundle weight. Supported markdown: `#`/`##`/`###`
 * headings, `*`/`-` bullets, blank-line paragraphs. Inline `**bold**`
 * and `[text](url)` links are honoured. Anything more elaborate
 * should be added when the doc actually needs it.
 */
import { Link } from "wouter";
import { usePageMeta } from "@/lib/seo";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — `?raw` is a Vite-native suffix; no type shim needed for one call site.
import systemCard from "../../../../docs/AI_SYSTEM_CARD.md?raw";
import { ShieldCheck, ArrowLeft } from "lucide-react";
import LexyLogo from "@/components/LexyLogo";

/* Inline `**bold**` + `[text](url)` → React nodes. Keeps the rest as
 * plain strings. Intentionally narrow; if the markdown grows we
 * should adopt react-markdown rather than extend this. */
function renderInline(line: string, keyBase: string): React.ReactNode[] {
  // First split links: [text](url)
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = linkRe.exec(line)) !== null) {
    if (m.index > last) nodes.push(boldify(line.slice(last, m.index), `${keyBase}-${idx++}`));
    nodes.push(
      <a
        key={`${keyBase}-${idx++}`}
        href={m[2]}
        className="text-primary underline underline-offset-2"
        target={m[2].startsWith("http") ? "_blank" : undefined}
        rel="noreferrer"
      >
        {m[1]}
      </a>,
    );
    last = linkRe.lastIndex;
  }
  if (last < line.length) nodes.push(boldify(line.slice(last), `${keyBase}-${idx++}`));
  return nodes;
}

function boldify(text: string, key: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <span key={key}>
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? (
          <strong key={`${key}-${i}`}>{p.slice(2, -2)}</strong>
        ) : (
          <span key={`${key}-${i}`}>{p}</span>
        ),
      )}
    </span>
  );
}

function renderMarkdown(src: string): React.ReactNode[] {
  const lines = src.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let bulletBuf: string[] = [];
  let paraBuf: string[] = [];
  const flushBullets = () => {
    if (!bulletBuf.length) return;
    out.push(
      <ul key={`ul-${out.length}`} className="space-y-1.5 mb-4 text-muted-foreground">
        {bulletBuf.map((b, i) => (
          <li key={i} className="flex gap-2 text-sm leading-relaxed">
            <span className="text-primary mt-0.5 shrink-0">•</span>
            <span>{renderInline(b, `li-${out.length}-${i}`)}</span>
          </li>
        ))}
      </ul>,
    );
    bulletBuf = [];
  };
  let tableBuf: string[] = [];
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf
      .filter((r) => !/^\|[\s:-]+\|?[\s|:-]*$/.test(r))
      .map((r) =>
        r
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim()),
      );
    const [header, ...body] = rows;
    out.push(
      <div key={`tbl-${out.length}`} className="overflow-x-auto mb-4">
        <table className="w-full text-sm border border-border/60 rounded-lg">
          {header && (
            <thead>
              <tr>
                {header.map((c, i) => (
                  <th
                    key={i}
                    className="text-left font-semibold text-foreground px-3 py-2 border-b border-border/60 bg-muted/40"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {body.map((cells, ri) => (
              <tr key={ri} className="border-b border-border/40 last:border-b-0">
                {cells.map((c, ci) => (
                  <td key={ci} className="px-3 py-2 text-muted-foreground align-top">
                    {renderInline(c, `td-${out.length}-${ri}-${ci}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>,
    );
    tableBuf = [];
  };
  const flushPara = () => {
    if (!paraBuf.length) return;
    out.push(
      <p key={`p-${out.length}`} className="text-sm text-muted-foreground leading-relaxed mb-4">
        {renderInline(paraBuf.join(" "), `p-${out.length}`)}
      </p>,
    );
    paraBuf = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushBullets();
      flushPara();
      flushTable();
      continue;
    }
    if (line.trim().startsWith("|")) {
      flushBullets();
      flushPara();
      tableBuf.push(line.trim());
      continue;
    }
    flushTable();
    if (line.startsWith("### ")) {
      flushBullets();
      flushPara();
      out.push(
        <h3 key={`h3-${out.length}`} className="text-base font-semibold mt-6 mb-2 text-foreground">
          {line.slice(4)}
        </h3>,
      );
    } else if (line.startsWith("## ")) {
      flushBullets();
      flushPara();
      out.push(
        <h2 key={`h2-${out.length}`} className="text-xl font-semibold mt-8 mb-3 text-foreground">
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith("# ")) {
      flushBullets();
      flushPara();
      out.push(
        <h1 key={`h1-${out.length}`} className="text-3xl font-semibold mb-4 text-foreground">
          {line.slice(2)}
        </h1>,
      );
    } else if (/^[*-]\s+/.test(line)) {
      flushPara();
      bulletBuf.push(line.replace(/^[*-]\s+/, ""));
    } else {
      flushBullets();
      paraBuf.push(line);
    }
  }
  flushBullets();
  flushPara();
  return out;
}

export default function AiSystemCard() {
  usePageMeta({
    title: "AI System Card — How L3XY's AI Works",
    description:
      "Transparency into how L3XY's AI interview and scoring systems work: models, safeguards, fairness measures, and human oversight.",
    path: "/ai-system-card",
  });
  return (
    <div className="min-h-screen text-foreground">
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-border/40 backdrop-blur-xl bg-background/90">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center cursor-pointer gap-2">
              <LexyLogo size="sm" />
            </div>
          </Link>
          <Link href="/">
            <button className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> Back to Home
            </button>
          </Link>
        </div>
      </nav>

      <main className="max-w-3xl mx-auto px-6 pt-24 pb-20">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <span className="text-xs text-muted-foreground font-medium uppercase tracking-widest">
            AI System Card · Public Disclosure
          </span>
        </div>

        <article className="prose-invert">{renderMarkdown(systemCard)}</article>

        <div className="mt-12 rounded-xl border border-border/50 bg-card/40 p-5 text-xs text-muted-foreground">
          Source of truth:{" "}
          <a href="https://github.com/" className="text-primary underline underline-offset-2">
            docs/AI_SYSTEM_CARD.md
          </a>{" "}
          in the Lexy repository. Change requests should be filed via legal@l3xy.ai. This page is
          rebuilt automatically on every deploy.
        </div>
      </main>
    </div>
  );
}
