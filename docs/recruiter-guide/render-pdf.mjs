import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(path.resolve("artifacts/api-server/package.json"));
const puppeteer = require("puppeteer");

const dir = path.dirname(fileURLToPath(import.meta.url));
const logoPath = path.resolve("artifacts/lexy/public/lexy-logo.png");
const logoB64 = `data:image/png;base64,${readFileSync(logoPath).toString("base64")}`;

const html = readFileSync(path.join(dir, "guide.html"), "utf8").replace("LOGO_SRC", logoB64);
const tmpHtml = path.join(dir, ".render.html");
writeFileSync(tmpHtml, html);

function findChromium() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  const { execSync } = require("node:child_process");
  for (const cmd of [
    "command -v chromium",
    "command -v chromium-browser",
    "ls -d /nix/store/*chromium*/bin/chromium 2>/dev/null | head -1",
  ]) {
    try {
      const out = execSync(cmd, { shell: "/bin/bash" }).toString().trim();
      if (out) return out.split("\n")[0];
    } catch {}
  }
  return undefined; // fall back to puppeteer's bundled Chrome if installed
}

const browser = await puppeteer.launch({
  executablePath: findChromium(),
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
try {
  const page = await browser.newPage();
  await page.goto(`file://${tmpHtml}`, { waitUntil: "networkidle0" });
  await page.pdf({
    path: path.join(dir, "Lexy-Recruiter-Guide.pdf"),
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:7.5px;color:#94a3b8;width:100%;padding:0 16mm;display:flex;justify-content:space-between;"><span>Lexy Recruiter Guide</span><span>July 2026</span></div>`,
    footerTemplate: `<div style="font-size:7.5px;color:#94a3b8;width:100%;text-align:center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
  });
  console.log("PDF written");
} finally {
  await browser.close();
  const { unlinkSync } = await import("node:fs");
  try {
    unlinkSync(tmpHtml);
  } catch {}
}
