/* Build the EU AI Act counsel briefing pack PDFs.
 * Usage: node docs/legal/build-lawyer-pack.cjs
 */
const puppeteer = require("puppeteer");
const MarkdownIt = require("markdown-it");
const fs = require("fs");
const path = require("path");

const CHROME = "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";

const DOCS_DIR = path.join(__dirname, "..");
const OUT = path.join(__dirname, "lawyer-pack");
fs.mkdirSync(OUT, { recursive: true });

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const DOCS = [
  [
    path.join(__dirname, "EU_AI_ACT_LAWYER_BRIEFING.md"),
    "EU AI Act — Counsel Briefing",
    "Factual system description for external legal counsel",
  ],
  [
    path.join(DOCS_DIR, "ANNEX_IV_TECHNICAL_DOCUMENTATION.md"),
    "Annex IV Technical Documentation",
    "Working skeleton — Regulation (EU) 2024/1689",
  ],
  [path.join(DOCS_DIR, "AI_SYSTEM_CARD.md"), "AI System Card", "Model inventory & intended use"],
  [
    path.join(DOCS_DIR, "AI_GOVERNANCE_ARCHITECTURE.md"),
    "AI Governance Architecture",
    "Oversight & decision-enforcement design",
  ],
  [path.join(DOCS_DIR, "PII_HANDLING.md"), "PII Handling", "Data-protection measures"],
  [
    path.join(DOCS_DIR, "RUNBOOK_APPEAL_HANDLING.md"),
    "Appeal Handling Runbook",
    "Operational procedure — human review requests",
  ],
  [
    path.join(DOCS_DIR, "RUNBOOK_DATA_DELETION.md"),
    "Data Deletion Runbook",
    "Operational procedure — GDPR erasure",
  ],
];

const CSS = `
  :root{
    --cyan: hsl(186 100% 52%); --cyan-soft: hsl(186 100% 52% / 0.14);
    --cyan-line: hsl(186 100% 52% / 0.30); --bg:#050c18; --bg-2:#0a1626;
    --ink:#e7eef6; --muted:#9fb3c8; --line:#16283d; --code-bg:#07101d;
  }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:var(--bg); }
  body{ font-family: ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    color:var(--ink); font-size:10pt; line-height:1.6;
    -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .wrap{ padding: 0 14mm 16mm; }
  .cover{ height:247mm; display:flex; flex-direction:column; justify-content:space-between;
    padding:26mm 18mm; position:relative; overflow:hidden;
    background: radial-gradient(1200px 520px at 78% -8%, hsl(186 100% 52% / 0.22), transparent 60%),
      radial-gradient(900px 480px at -10% 108%, hsl(186 100% 52% / 0.10), transparent 55%),
      linear-gradient(160deg,#061021 0%,#050c18 60%);
    page-break-after: always; }
  .cover .tag{ color:var(--cyan); font-weight:700; letter-spacing:.22em; text-transform:uppercase; font-size:9pt; }
  .cover h1{ font-size:30pt; line-height:1.1; margin:8mm 0 3mm; }
  .cover .sub{ color:var(--muted); font-size:13pt; }
  .cover .rule{ height:3px; width:56mm; background:var(--cyan); border-radius:2px; margin:6mm 0; }
  .cover .meta{ color:var(--muted); font-size:9.5pt; }
  .cover .brand{ position:absolute; top:18mm; right:18mm; color:var(--cyan); font-weight:800; letter-spacing:.14em; }
  h1,h2,h3,h4{ color:#fff; line-height:1.25; }
  h1{ font-size:18pt; margin:10mm 0 3mm; border-bottom:2px solid var(--cyan-line); padding-bottom:2mm; }
  h2{ font-size:14pt; margin:8mm 0 2mm; color:var(--cyan); }
  h3{ font-size:11.5pt; margin:5mm 0 1.5mm; }
  a{ color:var(--cyan); text-decoration:none; }
  strong{ color:#fff; } em{ color:var(--muted); }
  blockquote{ margin:3mm 0; padding:3mm 4mm; border-left:3px solid var(--cyan);
    background:var(--cyan-soft); border-radius:0 6px 6px 0; }
  blockquote p{ margin:1mm 0; }
  code{ background:var(--code-bg); color:#bfe9f5; padding:0 3px; border-radius:3px; font-size:8.6pt;
    font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  pre{ background:var(--code-bg); border:1px solid var(--line); border-radius:8px; padding:3.5mm 4mm; overflow:auto; }
  pre code{ background:none; padding:0; color:#cfeefb; line-height:1.5; }
  table{ width:100%; border-collapse:collapse; margin:3mm 0; font-size:8.6pt; }
  th,td{ border:1px solid var(--line); padding:2mm 2.5mm; text-align:left; vertical-align:top; }
  th{ background:var(--bg-2); color:var(--cyan); font-weight:700; }
  tr:nth-child(even) td{ background:rgba(255,255,255,0.015); }
  hr{ border:none; border-top:1px solid var(--line); margin:6mm 0; }
  ul,ol{ padding-left:6mm; } li{ margin:1mm 0; }
`;

function coverHtml(title, sub) {
  return `
  <div class="cover">
    <div class="brand">LEXY · LEGAL</div>
    <div><div class="tag">Privileged &amp; Confidential — prepared for counsel</div></div>
    <div>
      <div class="tag">EU AI Act pack</div>
      <h1>${title}</h1>
      <div class="rule"></div>
      <div class="sub">${sub}</div>
    </div>
    <div class="meta">
      Lexy AI Hiring Platform · Generated ${new Date().toISOString().slice(0, 10)}<br/>
      Factual description of the system as built. Not legal advice; assumptions flagged for counsel.
    </div>
  </div>`;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  for (const [srcPath, title, sub] of DOCS) {
    const source = fs.readFileSync(srcPath, "utf8");
    const body = md.render(source.replace(/^#\s.*\n/, ""));
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
      <body>${coverHtml(title, sub)}<div class="wrap">${body}</div></body></html>`;
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const outPath = path.join(OUT, path.basename(srcPath).replace(/\.md$/, ".pdf"));
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    await page.close();
    console.log("wrote", outPath);
  }
  await browser.close();

  const memo = path.join(__dirname, "ai-consent-jurisdiction-memo.pdf");
  if (fs.existsSync(memo)) {
    fs.copyFileSync(memo, path.join(OUT, "ai-consent-jurisdiction-memo.pdf"));
    console.log("copied ai-consent-jurisdiction-memo.pdf");
  }
})();
