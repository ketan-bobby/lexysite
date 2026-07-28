/* Build branded PDFs from the 9 engineering markdown docs.
 * Brand: electric cyan (hsl 186 100% 52%) on deep-navy (#050c18).
 * Usage: node docs/engineering/build-pdfs.cjs
 */
const puppeteer = require("puppeteer");
const MarkdownIt = require("markdown-it");
const fs = require("fs");
const path = require("path");

const CHROME =
  "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

const DIR = path.join(__dirname);
const OUT = path.join(DIR, "pdf");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const DOCS = [
  ["01-product-overview.md", "Product Overview & North Star", "01"],
  ["02-architecture-overview.md", "Architecture Overview", "02"],
  ["03-developer-onboarding.md", "Developer Onboarding Guide", "03"],
  ["04-system-design-decisions.md", "System Design & Key Decisions", "04"],
  ["05-api-documentation.md", "API Documentation", "05"],
  ["06-engineering-principles.md", "Engineering Principles & Ways of Working", "06"],
  ["07-roadmap.md", "Roadmap", "07"],
  ["08-changelog.md", "Release Summaries / Changelog", "08"],
  ["09-tech-debt-backlog.md", "Known Technical Debt & Backlog", "09"],
];

const CSS = `
  :root{
    --cyan: hsl(186 100% 52%);
    --cyan-soft: hsl(186 100% 52% / 0.14);
    --cyan-line: hsl(186 100% 52% / 0.30);
    --bg: #050c18;
    --bg-2: #0a1626;
    --card: #0d1b2c;
    --ink: #e7eef6;
    --muted: #9fb3c8;
    --line: #16283d;
    --code-bg: #07101d;
  }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:var(--bg); }
  body{
    font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color:var(--ink); font-size:10.5pt; line-height:1.62;
    -webkit-print-color-adjust:exact; print-color-adjust:exact;
  }
  .wrap{ padding: 0 16mm 18mm; }

  /* Cover */
  .cover{
    height: 247mm; display:flex; flex-direction:column; justify-content:space-between;
    padding: 26mm 18mm; position:relative; overflow:hidden;
    background:
      radial-gradient(1200px 520px at 78% -8%, hsl(186 100% 52% / 0.22), transparent 60%),
      radial-gradient(900px 480px at -10% 108%, hsl(186 100% 52% / 0.10), transparent 55%),
      linear-gradient(160deg, #061021 0%, #050c18 60%);
    page-break-after: always;
  }
  .cover .brand{ display:flex; align-items:center; gap:11px; font-weight:800; letter-spacing:.12em; }
  .cover .dot{ width:13px; height:13px; border-radius:50%; background:var(--cyan);
    box-shadow:0 0 18px hsl(186 100% 52% / 0.9), 0 0 40px hsl(186 100% 52% / 0.5); }
  .cover .brand .name{ font-size:15pt; color:var(--ink); }
  .cover .kicker{ color:var(--cyan); font-size:10.5pt; letter-spacing:.34em; text-transform:uppercase; font-weight:700; margin-bottom:14px; }
  .cover h1{ font-size:40pt; line-height:1.05; margin:0; font-weight:800; letter-spacing:-0.02em; }
  .cover h1 .num{ display:block; font-size:13pt; color:var(--muted); letter-spacing:.3em; font-weight:700; margin-bottom:18px; }
  .cover .rule{ width:120px; height:4px; background:var(--cyan); border-radius:3px; margin:22px 0 0;
    box-shadow:0 0 16px hsl(186 100% 52% / 0.7); }
  .cover .meta{ color:var(--muted); font-size:9.5pt; }
  .cover .meta b{ color:var(--ink); }
  .cover .setline{ color:var(--cyan); font-weight:700; letter-spacing:.06em; }

  /* Headings */
  h1,h2,h3,h4{ color:var(--ink); line-height:1.25; font-weight:750; }
  h1{ font-size:21pt; margin:0 0 6px; }
  h2{ font-size:15pt; margin:24px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  h2::before{ content:""; display:inline-block; width:10px; height:10px; margin-right:9px;
    background:var(--cyan); border-radius:2px; transform:translateY(0); box-shadow:0 0 10px hsl(186 100% 52% / 0.7); }
  h3{ font-size:12pt; margin:18px 0 6px; color:#cfe9f2; }
  h4{ font-size:10.5pt; margin:14px 0 4px; color:var(--cyan); letter-spacing:.02em; }

  p{ margin:8px 0; }
  a{ color:var(--cyan); text-decoration:none; }
  strong,b{ color:#ffffff; }
  em{ color:#cfe1ee; }
  hr{ border:0; border-top:1px solid var(--line); margin:20px 0; }

  ul,ol{ margin:8px 0 8px 2px; padding-left:20px; }
  li{ margin:4px 0; }
  ul li::marker{ color:var(--cyan); }
  ol li::marker{ color:var(--cyan); font-weight:700; }

  blockquote{
    margin:12px 0; padding:10px 14px; border-left:3px solid var(--cyan);
    background:var(--cyan-soft); border-radius:0 8px 8px 0; color:#dceaf3;
  }
  blockquote p{ margin:4px 0; }

  code{ font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size:9pt;
    background:var(--code-bg); color:#7fe9ff; padding:1.5px 5px; border-radius:5px; border:1px solid var(--line); }
  pre{ background:var(--code-bg); border:1px solid var(--line); border-left:3px solid var(--cyan);
    border-radius:9px; padding:12px 14px; overflow:auto; margin:12px 0; }
  pre code{ background:none; border:0; padding:0; color:#bfe9f6; font-size:8.6pt; line-height:1.5; }

  table{ width:100%; border-collapse:collapse; margin:12px 0; font-size:9pt;
    border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  thead th{ background:linear-gradient(180deg, #102338, #0c1a2b); color:var(--cyan);
    text-align:left; font-weight:700; letter-spacing:.02em; }
  th,td{ padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  td:first-child{ color:#dbeaf4; }
  tbody tr:nth-child(even){ background:#0a1525; }
  tbody tr:last-child td{ border-bottom:0; }

  .doc-tag{ display:inline-block; margin:0 0 14px; padding:4px 12px; font-size:8pt; font-weight:700;
    letter-spacing:.16em; text-transform:uppercase; color:var(--cyan);
    background:var(--cyan-soft); border:1px solid var(--cyan-line); border-radius:999px; }
  h2,h3,table,pre,blockquote{ break-inside: avoid; }
`;

function headerFooter(title) {
  const common = `font-family:ui-sans-serif,Arial,sans-serif; font-size:7.5pt; color:#6f8398; width:100%; padding:0 16mm;`;
  return {
    headerTemplate: `<div style="${common}; display:flex; justify-content:space-between; align-items:center;">
        <span style="letter-spacing:.18em; text-transform:uppercase; color:#00d8f5; font-weight:700;">LEXY · ENGINEERING</span>
        <span>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>
      </div>`,
    footerTemplate: `<div style="${common}; display:flex; justify-content:space-between; align-items:center;">
        <span>Lexy — AI Hiring Platform · Internal Engineering Documentation</span>
        <span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`,
  };
}

function cover(title, num) {
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return `<section class="cover">
    <div class="brand"><span class="dot"></span><span class="name">LEXY</span></div>
    <div>
      <div class="kicker">Engineering Documentation</div>
      <h1><span class="num">DOCUMENT ${num} / 09</span>${title.replace(/&/g, "&amp;")}</h1>
      <div class="rule"></div>
    </div>
    <div class="meta">
      <div class="setline">AI Hiring Platform · Intelligence-First</div>
      <div style="margin-top:8px;">Generated <b>${date}</b> · Confidential — internal use</div>
    </div>
  </section>`;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  for (const [file, title, num] of DOCS) {
    const raw = fs.readFileSync(path.join(DIR, file), "utf8");
    // Drop the first H1 + the leading blockquote meta (cover already shows them).
    const body = md.render(raw);
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <style>${CSS}</style></head>
      <body>${cover(title, num)}
        <div class="wrap"><span class="doc-tag">Doc ${num} of 09 · Lexy Engineering</span>${body}</div>
      </body></html>`;
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const hf = headerFooter(title);
    const outPath = path.join(OUT, file.replace(/\.md$/, ".pdf"));
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: hf.headerTemplate,
      footerTemplate: hf.footerTemplate,
      margin: { top: "16mm", bottom: "16mm", left: "0mm", right: "0mm" },
    });
    await page.close();
    console.log("built", outPath);
  }
  await browser.close();
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
