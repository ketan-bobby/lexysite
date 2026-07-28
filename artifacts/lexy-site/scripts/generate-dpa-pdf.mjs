#!/usr/bin/env node
/**
 * Generates public/lexy-dpa.pdf from legal/dpa.md using md-to-pdf.
 *
 * Run with:   pnpm --filter @workspace/lexy-site dpa:pdf
 *
 * The PDF is checked in to the repo so the public site can serve it as a
 * static asset without requiring a build step on every deploy. Regenerate
 * whenever legal/dpa.md changes and commit the updated PDF.
 */
import { mdToPdf } from "md-to-pdf";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

/* Puppeteer needs a Chrome binary. The Replit sandbox doesn't ship one in
 * puppeteer's default cache path, but the Nix environment provides chromium.
 * Use $PUPPETEER_EXECUTABLE_PATH if set, otherwise probe the PATH for
 * chromium / chromium-browser / google-chrome. Fail loudly if none found. */
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  for (const bin of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
    try {
      const found = execSync(`command -v ${bin}`, { encoding: "utf8" }).trim();
      if (found) { process.env.PUPPETEER_EXECUTABLE_PATH = found; break; }
    } catch { /* not on PATH */ }
  }
}
if (!process.env.PUPPETEER_EXECUTABLE_PATH) {
  console.error("[generate-dpa-pdf] No Chrome/Chromium binary found. Set PUPPETEER_EXECUTABLE_PATH or install chromium.");
  process.exit(1);
}
console.log(`[generate-dpa-pdf] using browser: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = resolve(root, "legal/dpa.md");
const dest = resolve(root, "public/lexy-dpa.pdf");

if (!existsSync(src)) {
  console.error(`[generate-dpa-pdf] source not found: ${src}`);
  process.exit(1);
}

const css = `
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif; color: #0a0a0a; line-height: 1.55; font-size: 10.5pt; }
  h1 { font-size: 22pt; margin: 0 0 4pt 0; }
  h1 + p strong { font-size: 13pt; }
  h2 { font-size: 13pt; margin: 22pt 0 6pt 0; border-bottom: 1px solid #e5e5e5; padding-bottom: 4pt; page-break-after: avoid; }
  h3 { font-size: 11pt; margin: 14pt 0 4pt 0; page-break-after: avoid; }
  p, li { font-size: 10pt; }
  table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt 0; font-size: 9.5pt; }
  th, td { border: 1px solid #d4d4d4; padding: 6pt 8pt; text-align: left; vertical-align: top; }
  th { background: #f5f5f5; font-weight: 600; }
  hr { border: none; border-top: 1px solid #d4d4d4; margin: 18pt 0; }
  code { background: #f5f5f5; padding: 1pt 4pt; border-radius: 3pt; font-size: 9.5pt; }
  ul { padding-left: 18pt; } li { margin: 2pt 0; }
  em { color: #525252; }
`;

console.log(`[generate-dpa-pdf] ${src}  →  ${dest}`);

const result = await mdToPdf(
  { path: src },
  {
    dest,
    css,
    stylesheet_encoding: "utf-8",
    launch_options: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    pdf_options: {
      format: "A4",
      margin: { top: "22mm", right: "18mm", bottom: "22mm", left: "18mm" },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:8pt;color:#888;width:100%;text-align:center;">Lexy Inc. — Data Processing Agreement</div>`,
      footerTemplate: `<div style="font-size:8pt;color:#888;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    },
  },
);

if (!result) {
  console.error("[generate-dpa-pdf] md-to-pdf returned no result");
  process.exit(1);
}

console.log(`[generate-dpa-pdf] wrote ${dest}`);
