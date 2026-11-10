/** Offline rendering only. No running application or provider calls. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import puppeteer from "puppeteer";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "generated-artifacts/lexy-it-handoff-2026-11-05");
const md = new MarkdownIt({ html: false, linkify: false, typographer: true });
const escape = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const css = `
*{box-sizing:border-box}body{margin:0;background:#edf1f5;color:#1b2d42;font:15px/1.6 Arial,sans-serif}
header{background:#102338;color:#fff;padding:30px max(24px,calc((100vw - 1020px)/2));border-bottom:6px solid #087f8c}
header strong{font-size:29px;letter-spacing:.4px}header p{margin:5px 0;color:#d1e3ef}
main{max-width:1100px;margin:26px auto;background:white;padding:45px 54px}
h1{font-size:33px;line-height:1.2;color:#102338;margin-top:0}h2{font-size:23px;border-bottom:2px solid #087f8c;padding-bottom:8px;margin-top:40px}
h3{font-size:18px;color:#066f7b;margin-top:28px}h4{font-size:15px;color:#102338;border-top:1px solid #bdced9;padding-top:15px}
p,li{overflow-wrap:anywhere}a{color:#075d98}code{font-family:Consolas,monospace;background:#f0f4f7;font-size:.88em;overflow-wrap:anywhere}
pre{white-space:pre-wrap;background:#f0f4f7;padding:15px;border-left:3px solid #087f8c;font-size:12px}
table{width:100%;border-collapse:collapse;margin:18px 0;table-layout:fixed;font-size:12px;line-height:1.45}
th,td{padding:9px;border:1px solid #c5d1dc;vertical-align:top;overflow-wrap:anywhere}th{background:#102338;color:white;text-align:left}
tr:nth-child(even) td{background:#f4f7fa}blockquote{margin:20px 0;padding:12px 18px;border-left:4px solid #087f8c;background:#eaf5f7}
footer{max-width:1100px;margin:20px auto 40px;font-size:12px;color:#4c6175;padding:0 24px}
@page{size:A4;margin:18mm 14mm 19mm}
@media print{body{background:white;font-size:10px;line-height:1.5}header{padding:8px 0 12px;background:white;color:#102338;border-bottom:3px solid #087f8c}header p{color:#50667c;font-size:9px}header strong{font-size:17px}main{padding:15px 0 0;margin:0;max-width:none}h1{font-size:27px}h2{font-size:19px;break-before:auto;margin-top:26px}h3{font-size:14px}h4{font-size:12px}h1,h2,h3,h4{break-after:avoid}table{font-size:8.2px;line-height:1.35}thead{display:table-header-group}tr{break-inside:avoid}th,td{padding:6px}pre{font-size:8px}footer{display:none}a{color:#174a7e;text-decoration:none}}
`;
const executablePath = execFileSync(
  "bash",
  ["-c", "command -v chromium || command -v chromium-browser || command -v google-chrome"],
  { encoding: "utf8" },
).trim();
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => (/^https?:/.test(req.url()) ? req.abort() : req.continue()));
  for (const base of ["Lexy-System-Documentation", "Lexy-IT-Test-Plan", "Lexy-Code-Handover"]) {
    const source = await fs.readFile(path.join(out, `${base}.md`), "utf8");
    const title =
      base === "Lexy-System-Documentation"
        ? "Lexy · System Documentation"
        : base === "Lexy-Code-Handover"
          ? "Lexy · Code Handover"
          : "Lexy · IT Acceptance Test Plan";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>${css}</style></head><body><header><strong>Lexy</strong><p>Internal IT handoff · Updated November 10, 2026 · Development-first</p></header><main>${md.render(source)}</main><footer>As-built documentation and unexecuted manual acceptance plan. No production approval. Keep test evidence private.</footer></body></html>`;
    await fs.writeFile(path.join(out, `${base}.html`), html);
    await page.setContent(html, { waitUntil: "load" });
    await page.emulateMediaType("print");
    await page.pdf({
      path: path.join(out, `${base}.pdf`),
      format: "A4",
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font:8px Arial;color:#536477;padding:0 14mm;display:flex;justify-content:space-between"><span>${escape(title)} · Internal · Updated 2026-11-10</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      margin: { top: "18mm", bottom: "19mm", left: "14mm", right: "14mm" },
    });
    if (base === "Lexy-System-Documentation") {
      await page.emulateMediaType("screen");
      await page.setViewport({ width: 1280, height: 960 });
      await page.screenshot({ path: path.join(out, "Documentation-preview.png") });
    }
  }
} finally {
  await browser.close();
}
// A closed, explicit output directory only; never package the workspace or .env.
execFileSync(
  "python",
  [
    "-c",
    `
from pathlib import Path
import zipfile
out = Path(${JSON.stringify(out)})
target = out / "Lexy-IT-Handoff.zip"
with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
    for p in sorted(out.iterdir()):
        if p.is_file() and p != target and p.name != "Documentation-preview.png":
            archive.write(p, p.name)
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
print("Packaged", target.name)
`,
  ],
  { stdio: "inherit" },
);
process.stdout.write("Rendered both self-contained HTML/PDF documents and the shareable ZIP.\n");
