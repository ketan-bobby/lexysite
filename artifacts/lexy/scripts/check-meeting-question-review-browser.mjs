import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";

// Runs the real panel in a local Vite/Puppeteer browser. All API traffic is intercepted.
const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "src/test-fixtures/meeting-question-review-browser.tsx");
mkdirSync(path.dirname(fixture), { recursive: true });
writeFileSync(
  fixture,
  `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {MeetingNotesPanel} from "@/components/meeting-notes-panel";
import "@/index.css";
function Harness(){
 const [qc] = useState(()=>new QueryClient({defaultOptions:{queries:{retry:false}}}));
 window.refetchReview=()=>qc.invalidateQueries({queryKey:["meeting-note","job-review","candidate-review","review-note"]});
 return <QueryClientProvider client={qc}><main style={{maxWidth:1100,margin:"24px auto",padding:"0 16px"}}><MeetingNotesPanel candidateId="candidate-review" jobId="job-review"/></main></QueryClientProvider>;
}
createRoot(document.getElementById("root")).render(<Harness/>);
`,
);
const server = await createServer({
  configFile: false,
  root,
  base: "/",
  cacheDir: mkdtempSync(path.join(tmpdir(), "question-review-vite-")),
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: [fixture] },
  resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
  logLevel: "error",
});
let browser;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  assert.ok(ok, `${name}${detail ? `: ${detail}` : ""}`);
};
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const tid = (id) => `[data-testid="${id}"]`;
const stamp = "2026-03-01T12:00:00.000Z";
const transcript =
  "We launched the new onboarding flow in May and reduced setup time by half. The team learned to prioritize clear ownership.";
const hash = "a".repeat(64);
const makeNote = (o = {}) => ({
  id: "review-note",
  jobId: "job-review",
  candidateId: "candidate-review",
  title: "Synthetic interview",
  language: "en",
  status: "completed",
  consentAt: stamp,
  consentStatement: "Synthetic consent statement for browser testing only.",
  plannedQuestions: "  Tell me about a launch  \n\n What did the team learn?  ",
  originalName: "synthetic.wav",
  mimeType: "audio/wav",
  byteSize: 844,
  createdAt: stamp,
  updatedAt: stamp,
  canRetry: false,
  transcript,
  summary: "PRIVATE synthetic summary",
  transcriptHash: hash,
  questionReview: null,
  error: null,
  processingStartedAt: null,
  ...o,
});
let current = makeNote(),
  puts = [],
  getCount = 0,
  detailStatus = 200,
  putStatus = 200;
let putResponseOverride = null,
  unexpected = [],
  pageErrors = [];
let downloadStatus = 200;
const downloadText =
  "LEXY — PRIVATE STAFF MEETING NOTES\nSAVED SOURCE NOTES ONLY\nதமிழ் transcript fixture";
const downloads = mkdtempSync(path.join(tmpdir(), "meeting-notes-download-"));
let revisionCounter = 0;
const makeReview = (entries) => ({
  revision: `00000000-0000-4000-8000-${String(++revisionCounter).padStart(12, "0")}`,
  sourceHash: current.transcriptHash,
  reviewedBy: "staff-synthetic",
  reviewedAt: stamp,
  entries,
});
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const html = await server.transformIndexHtml(
    "/__questionreview",
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/test-fixtures/meeting-question-review-browser.tsx"></script></body></html>',
  );
  let executablePath = puppeteer.executablePath();
  if (!existsSync(executablePath))
    executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    pipe: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();
  await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
  await page.setViewport({ width: 1200, height: 1100 });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const u = new URL(req.url()),
      p = u.pathname,
      method = req.method();
    const json = (body, status = 200) =>
      req.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
    try {
      if (u.hostname === "fonts.googleapis.com")
        return req.respond({ status: 200, contentType: "text/css", body: "" });
      assert.equal(u.origin, origin, "external request blocked");
      if (p === "/__questionreview")
        return req.respond({ status: 200, contentType: "text/html", body: html });
      if (
        p.startsWith("/src/") ||
        p.startsWith("/node_modules/") ||
        p.startsWith("/@vite/") ||
        p.startsWith("/@id/") ||
        p.startsWith("/@fs/") ||
        p === "/favicon.ico"
      )
        return req.continue();
      if (
        p ===
          "/api/jobs/job-review/candidates/candidate-review/meeting-notes/review-note/notes-export" &&
        method === "GET"
      ) {
        if (downloadStatus !== 200)
          return json({ error: "Synthetic notes download failure" }, downloadStatus);
        return req.respond({
          status: 200,
          contentType: "text/plain; charset=utf-8",
          headers: {
            "content-disposition": 'attachment; filename="meeting-notes-review-note.txt"',
            "cache-control": "no-store",
          },
          body: downloadText,
        });
      }
      const m = p.match(
        /^\/api\/jobs\/job-review\/candidates\/candidate-review\/meeting-notes(?:\/([^/]+))?(?:\/question-review)?$/,
      );
      if (!m) {
        unexpected.push(`${method} ${p}`);
        return json({ error: "blocked" }, 404);
      }
      const id = m[1];
      if (method === "GET" && !id) return json([current]);
      if (method === "GET" && id) {
        getCount++;
        if (detailStatus !== 200)
          return json({ error: `private detail unavailable (${detailStatus})` }, detailStatus);
        return json(current);
      }
      if (method === "PUT" && id && p.endsWith("/question-review")) {
        const body = JSON.parse(req.postData() || "{}");
        puts.push(body);
        if (putStatus !== 200)
          return json({ error: `synthetic PUT failure (${putStatus})` }, putStatus);
        if (putResponseOverride) return json(putResponseOverride, 409);
        const entries = body.entries.map((e) => {
          if (e.status === "not_covered") return { ...e, evidenceStart: null, evidenceEnd: null };
          const start = current.transcript.indexOf(e.excerpt);
          return { ...e, evidenceStart: start, evidenceEnd: start + e.excerpt.length };
        });
        current = { ...current, questionReview: entries.length ? makeReview(entries) : null };
        return json(current);
      }
      unexpected.push(`${method} ${p}`);
      return json({ error: "blocked" }, 404);
    } catch (e) {
      pageErrors.push(`interceptor ${e.message}`);
      return json({ error: "fixture failure" }, 500);
    }
  });
  await page.goto(`${origin}/__questionreview`);
  await page.waitForSelector(tid("button-select-meeting-note-review-note"));
  await page.locator(tid("button-select-meeting-note-review-note")).click();
  await page.waitForSelector(tid("section-question-review"));
  const pageUrl = page.url();
  downloadStatus = 503;
  await page.locator(tid("button-download-meeting-notes")).click();
  await page.waitForFunction(() =>
    document.body.innerText.includes("Synthetic notes download failure"),
  );
  check(
    "notes download failure is explicit and the browser stays on the review page",
    page.url() === pageUrl && !existsSync(path.join(downloads, "meeting-notes-review-note.txt")),
  );
  downloadStatus = 200;
  await page.locator(tid("button-download-meeting-notes")).click();
  const downloadedFile = path.join(downloads, "meeting-notes-review-note.txt");
  for (let attempt = 0; attempt < 100 && !existsSync(downloadedFile); attempt++) await wait(100);
  check(
    "saved notes download as a UTF-8 text file without opening another page",
    existsSync(downloadedFile) &&
      readFileSync(downloadedFile, "utf8") === downloadText &&
      page.url() === pageUrl &&
      (await browser.pages()).length === 2,
  );
  downloadStatus = 403;
  detailStatus = 403;
  await page.locator(tid("button-download-meeting-notes")).click();
  await page.waitForSelector(tid("text-meeting-access-lost"));
  check(
    "notes-download access denial immediately hides cached private source and review",
    !(await page.$(tid("section-question-review"))) &&
      !(await page.evaluate(() => document.body.innerText)).includes("PRIVATE synthetic summary"),
  );
  downloadStatus = 200;
  detailStatus = 200;
  await page.locator(tid("button-retry-meeting-access")).click();
  await page.waitForSelector(tid("section-question-review"));
  const initialRows = [
    await page.$$eval(tid("row-review-question-0"), (e) => e.length),
    await page.$$eval(tid("row-review-question-1"), (e) => e.length),
  ];
  const initialCount = await page
    .$eval(tid("text-review-count"), (e) => e.innerText)
    .catch(() => "missing");
  const questionText = await page.$$eval(
    `${tid("section-question-review")} li p:first-child`,
    (els) => els.map((e) => e.innerText),
  );
  check(
    "completed two-question note starts unreviewed and questions are trimmed/nonempty",
    initialRows[0] === 1 &&
      initialRows[1] === 1 &&
      initialCount === "0/2 reviewed" &&
      questionText[0] === "1. Tell me about a launch" &&
      questionText[1] === "2. What did the team learn?" &&
      current.transcriptHash.length === 64 &&
      current.questionReview === null,
  );
  await page.select(tid("select-review-status-0"), "covered");
  await page.locator(tid("input-review-excerpt-0")).fill("invented quote from an interview");
  check(
    "invented excerpt is rejected and Save is disabled",
    (await page.$eval(tid("text-review-error-0"), (e) => e.innerText)).includes(
      "not found verbatim",
    ) && (await page.$eval(tid("button-review-save"), (e) => e.disabled)),
  );
  const exact = "We launched the new onboarding flow in May";
  await page.locator(tid("input-review-excerpt-0")).fill(exact);
  await page.locator(tid("button-review-save")).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="text-review-count"]')?.innerText === "1/2 reviewed",
  );
  const savedBody = puts.at(-1);
  check(
    "unique exact excerpt saves only reviewed entry, with full-replacement request body and no inferred attribution",
    savedBody.sourceHash === hash &&
      savedBody.previousRevision === null &&
      savedBody.entries.length === 1 &&
      savedBody.entries[0].questionIndex === 0 &&
      savedBody.entries[0].status === "covered" &&
      savedBody.entries[0].excerpt === exact &&
      savedBody.entries[0].note === "" &&
      Object.keys(savedBody).sort().join(",") === "entries,previousRevision,sourceHash" &&
      Object.keys(savedBody.entries[0]).sort().join(",") === "excerpt,note,questionIndex,status" &&
      current.questionReview.entries[0].evidenceStart === transcript.indexOf(exact) &&
      current.questionReview.entries[0].evidenceEnd === transcript.indexOf(exact) + exact.length &&
      current.questionReview.entries.length === 1,
  );
  await page.screenshot({ path: "/tmp/meeting-question-review-saved.png", fullPage: true });
  await page.reload();
  await page.waitForSelector(tid("button-select-meeting-note-review-note"));
  await page.locator(tid("button-select-meeting-note-review-note")).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="text-review-count"]')?.innerText === "1/2 reviewed",
  );
  check(
    "saved review count and entry survive remount/refetch",
    current.questionReview.entries.length === 1 &&
      (await page.$eval(tid("text-review-saved"), (e) => e.innerText)).includes("1 saved"),
  );
  // Another actor revises the server while the local draft is dirty.
  await page.select(tid("select-review-status-1"), "not_covered");
  const changedEntries = [
    {
      questionIndex: 0,
      status: "partial",
      excerpt: exact,
      note: "External revision",
      evidenceStart: 0,
      evidenceEnd: exact.length,
    },
  ];
  current = { ...current, questionReview: makeReview(changedEntries) };
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("review-refetch")));
  // Expose a narrow refetch hook through the already-loaded page to preserve the real QueryClient.
  await page.evaluate(() => window.refetchReview?.());
  await page.waitForSelector(tid("alert-review-stale"));
  check(
    "external revision preserves dirty local edits and blocks save",
    (await page.$eval(tid("select-review-status-1"), (e) => e.value)) === "not_covered" &&
      (await page.$eval(tid("button-review-save"), (e) => e.disabled)),
  );
  await page.locator(tid("button-review-reload")).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="select-review-status-0"]')?.value === "partial",
  );
  check(
    "explicit discard adopts latest server revision",
    (await page.$eval(tid("select-review-status-0"), (e) => e.value)) === "partial" &&
      (await page.$eval(tid("select-review-status-1"), (e) => e.value)) === "",
  );
  // Force a 409; the component must retain the draft and not retry the PUT itself.
  await page.select(tid("select-review-status-1"), "not_covered");
  const beforeConflict = puts.length;
  putStatus = 409;
  await page.locator(tid("button-review-save")).click();
  await page.waitForSelector(tid("alert-review-conflict"));
  check(
    "409 preserves edits and does not automatically resubmit",
    puts.length === beforeConflict + 1 &&
      (await page.$eval(tid("select-review-status-1"), (e) => e.value)) === "not_covered" &&
      (await page.$eval(tid("alert-review-conflict"), (e) => e.innerText)).includes(
        "Your edits are kept",
      ),
  );
  putStatus = 200;
  current = { ...current, questionReview: makeReview(changedEntries) };
  await page.locator(tid("button-review-refetch")).click();
  await page.waitForSelector(tid("alert-review-stale"));
  await page.locator(tid("button-review-reload")).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="alert-review-stale"]'));
  check(
    "manual refetch after 409 followed by explicit discard loads latest",
    (await page.$eval(tid("select-review-status-0"), (e) => e.value)) === "partial" &&
      (await page.$eval(tid("select-review-status-1"), (e) => e.value)) === "",
  );
  // Save a not-covered row; it intentionally needs no excerpt.
  await page.select(tid("select-review-status-1"), "not_covered");
  await page.locator(tid("button-review-save")).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="text-review-count"]')?.innerText === "2/2 reviewed",
  );
  check(
    "not-covered status saves without an excerpt",
    puts
      .at(-1)
      .entries.some(
        (e) => e.questionIndex === 1 && e.status === "not_covered" && e.excerpt === "",
      ) && !(await page.$(tid("text-review-error-1"))),
  );
  // Clear is a confirmed full replacement using current revision.
  const revisionToClear = current.questionReview.revision,
    beforeClear = puts.length;
  await page.locator(tid("button-review-clear")).click();
  await page.waitForSelector(tid("button-review-clear-confirm"));
  check("clear requires confirmation before sending", puts.length === beforeClear);
  await page.locator(tid("button-review-clear-confirm")).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="text-review-count"]')?.innerText === "0/2 reviewed",
  );
  check(
    "confirmed clear sends empty entries with current revision",
    puts.at(-1).entries.length === 0 &&
      puts.at(-1).previousRevision === revisionToClear &&
      current.questionReview === null,
  );
  // Establish a saved private success, then deny the subsequent review PUT and detail GET.
  await page.select(tid("select-review-status-0"), "covered");
  await page.locator(tid("input-review-excerpt-0")).fill(exact);
  await page.locator(tid("button-review-save")).click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="text-review-count"]')?.innerText === "1/2 reviewed",
  );
  await page.select(tid("select-review-status-1"), "not_covered");
  putStatus = 403;
  detailStatus = 403;
  await page.locator(tid("button-review-save")).click();
  await page.waitForSelector(tid("button-retry-meeting-access"));
  const privateHidden = await page.evaluate(
    () =>
      !document.body.innerText.includes("PRIVATE synthetic summary") &&
      !document.body.innerText.includes("We launched the new onboarding flow") &&
      !document.querySelector('[data-testid="section-question-review"]'),
  );
  check(
    "403 PUT plus 403 detail immediately hides cached transcript, summary and review form",
    privateHidden,
  );
  detailStatus = 200;
  await page.locator(tid("button-retry-meeting-access")).click();
  await page.waitForSelector(tid("section-question-review"));
  check(
    "successful explicit retry restores fresh private note",
    (await page.evaluate(() => document.body.innerText.includes("PRIVATE synthetic summary"))) &&
      (await page.$(tid("section-question-review"))),
  );
  // A subsequent detail 404 must likewise suppress previously loaded review and private text.
  detailStatus = 404;
  await page.evaluate(() => window.refetchReview?.());
  await page.waitForSelector(tid("button-retry-meeting-detail"));
  check(
    "404 detail read hides previously saved review and private note data",
    !(await page.evaluate(
      () =>
        document.body.innerText.includes("PRIVATE synthetic summary") ||
        document.querySelector('[data-testid="section-question-review"]'),
    )),
  );
  // Locked processing state and absent questions are checked by refetching fixture data through hooks.
  current = makeNote({
    status: "processing",
    processingStartedAt: stamp,
    transcript: null,
    summary: null,
    transcriptHash: null,
  });
  detailStatus = 200;
  await page.locator(tid("button-retry-meeting-detail")).click();
  await page.waitForSelector(tid("text-review-unavailable"));
  check(
    "processing note reports review unavailable",
    (await page.$eval(tid("text-review-unavailable"), (e) => e.innerText)).includes(
      "once processing finishes",
    ),
  );
  current = makeNote({ transcript: null, summary: null, transcriptHash: null });
  await page.evaluate(() => window.refetchReview?.());
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid="text-review-unavailable"]')
      ?.innerText.includes("No transcript is available"),
  );
  check(
    "completed note with unavailable/new transcript source does not expose the review form",
    !!(await page.$(tid("text-review-unavailable"))) && !(await page.$(tid("button-review-save"))),
  );
  current = makeNote({ plannedQuestions: " \n \n", transcriptHash: hash });
  await page.evaluate(() => window.refetchReview?.());
  await page.waitForSelector(tid("text-review-no-questions"));
  check("no-questions state is explicit", !!(await page.$(tid("text-review-no-questions"))));
  await page.setViewport({ width: 390, height: 844 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  await page.screenshot({ path: "/tmp/meeting-question-review-browser.png", fullPage: true });
  check(
    "390px viewport has no horizontal overflow",
    !overflow,
    `${await page.evaluate(() => document.documentElement.scrollWidth)} / ${await page.evaluate(() => document.documentElement.clientWidth)}`,
  );
  check(
    "no unexpected network requests or uncaught page errors",
    unexpected.length === 0 && pageErrors.length === 0,
    [...unexpected, ...pageErrors].join("; "),
  );
  console.log(
    "SCREENSHOTS /tmp/meeting-question-review-saved.png /tmp/meeting-question-review-browser.png",
  );
} catch (e) {
  console.error(e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await server.close();
  rmSync(fixture, { force: true });
  rmSync(downloads, { recursive: true, force: true });
}
