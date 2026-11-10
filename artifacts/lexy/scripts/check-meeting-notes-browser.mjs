import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";

// The real panel/client runs in a local Vite harness. Every API request is intercepted;
// nothing reaches an application server, account, storage provider, or AI provider.
const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "src/test-fixtures/meeting-notes-browser.tsx");
mkdirSync(path.dirname(fixture), { recursive: true });
writeFileSync(
  fixture,
  `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MeetingNotesPanel } from "@/components/meeting-notes-panel";
import { AuthProvider } from "@/lib/auth-context";
import "@/index.css";
const nativeFetch = window.fetch.bind(window);
window.fetch = (url, init) => {
  if (init?.body instanceof FormData) window.uploadContract =
    [...init.body.entries()].map(([key,value]) => [key, value instanceof File
      ? {name:value.name,type:value.type,size:value.size} : value]);
  return nativeFetch(url, init);
};
function Harness() {
  const [ctx, setCtx] = useState({ candidateId: "cand-a", jobId: null });
  const [qc] = useState(() => new QueryClient({defaultOptions:{queries:{retry:false}}}));
  window.setContext = setCtx;
  window.refetchNote = (job,candidate,id) => qc.invalidateQueries({queryKey:["meeting-note",job,candidate,id]});
  return <QueryClientProvider client={qc}>
    <AuthProvider>
    <main style={{maxWidth:1100,margin:"24px auto",padding:"0 16px"}}>
      <MeetingNotesPanel {...ctx} />
    </main>
    </AuthProvider>
  </QueryClientProvider>;
}
createRoot(document.getElementById("root")).render(<Harness/>);
`,
);
const server = await createServer({
  configFile: false,
  root,
  base: "/",
  cacheDir: mkdtempSync(path.join(tmpdir(), "lexy-meeting-vite-")),
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: [fixture] },
  resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
  logLevel: "error",
});
let browser;
const errors = [],
  unexpected = [];
const testRoot = mkdtempSync(path.join(tmpdir(), "meeting-notes-"));
const fixtureWav = path.join(testRoot, "synthetic.wav");
const wav = Buffer.alloc(844);
wav.write("RIFF", 0);
wav.writeUInt32LE(836, 4);
wav.write("WAVE", 8);
wav.write("fmt ", 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(800, 40);
writeFileSync(fixtureWav, wav);
const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const selector = (id) => `[data-testid="${id}"]`;
const stamp = "2026-01-01T00:00:00.000Z";
const note = (overrides = {}) => ({
  id: "note-a",
  jobId: "job-a",
  candidateId: "cand-a",
  title: "Synthetic interview",
  language: "en",
  status: "uploaded",
  consentAt: stamp,
  consentStatement: "All participants agreed to recording and AI transcription at the beginning.",
  plannedQuestions: "Role experience",
  originalName: "synthetic.wav",
  mimeType: "audio/wav",
  byteSize: 844,
  createdAt: stamp,
  updatedAt: stamp,
  canRetry: false,
  transcript: null,
  summary: null,
  error: null,
  processingStartedAt: null,
  ...overrides,
});
let current = null;
let listReads = 0,
  detailReads = 0,
  uploads = [],
  processes = [],
  downloads = [],
  deletes = [];
let uploadStatus = 0,
  processStatus = 0,
  deleteStatus = 0;
let zoomAppointmentReads = 0,
  zoomPreviews = [],
  zoomImports = [],
  zoomPreviewStatus = 0,
  zoomImportStatus = 0;
const ZOOM_TOKEN = "opaque.synthetic.review-token";
let speakerPuts = [],
  speakerPutStatus = 0;
let hideDetailsStatus = 0,
  processStarted = false,
  processReads = 0;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const html = await server.transformIndexHtml(
    "/__meetingnotes",
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/src/test-fixtures/meeting-notes-browser.tsx"></script></body></html>`,
  );
  let executablePath = puppeteer.executablePath();
  if (!existsSync(executablePath))
    executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    pipe: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000 });
  page.on("pageerror", (e) => errors.push(e.message));
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
      // Native audio controls can request embedded icons. These data images
      // never contact a host; do not mistake them for an external API call.
      if (u.protocol === "data:" && req.resourceType() === "image") return req.continue();
      assert.equal(u.origin, origin, "external request blocked");
      if (p === "/__meetingnotes")
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
      if (p === "/api/auth/me" && method === "GET")
        return json({
          id: "fixture-staff",
          tenantId: "fixture-employer",
          role: "tenant_admin",
          name: "Synthetic Staff",
          email: "staff@example.invalid",
        });
      // Attendance is a separate panel with its own dedicated browser suite.
      // Model its exact empty read contract here; keep every write default-denied.
      if (/^\/api\/jobs\/[^/]+\/candidates\/[^/]+\/meeting-assistant$/.test(p) && method === "GET")
        return json({
          workspaceAuthorized: false,
          webhookConfigured: false,
          canAuthorizeWorkspace: false,
          connections: [],
          appointments: [],
          attempts: [],
        });
      if (
        /^\/api\/jobs\/[^/]+\/candidates\/[^/]+\/meeting-notes\/native-google-meet\/appointments$/.test(
          p,
        ) &&
        method === "GET"
      )
        return json([]);
      const z = p.match(
        /^\/api\/jobs\/([^/]+)\/candidates\/([^/]+)\/meeting-notes\/native-zoom\/(appointments|preview|import)$/,
      );
      if (z) {
        const [, , , action] = z;
        if (action === "appointments" && method === "GET") {
          zoomAppointmentReads++;
          return json([{ scheduleId: "sched-1", scheduledAt: stamp, durationMinutes: 30 }]);
        }
        if (action === "preview" && method === "POST") {
          zoomPreviews.push(JSON.parse(req.postData() || "{}"));
          if (zoomPreviewStatus) return json({ error: "Synthetic denial" }, zoomPreviewStatus);
          return json({
            scheduleId: "sched-1",
            recordedAt: "2026-01-01T00:02:00.000Z",
            files: [
              {
                id: "file-mp4",
                format: "MP4",
                kind: "shared_screen_with_speaker_view",
                bytes: 4200000,
                start: "2026-01-01T00:02:00.000Z",
                end: "2026-01-01T00:12:30.000Z",
                eligible: true,
                unavailableReason: null,
                reviewToken: ZOOM_TOKEN,
              },
              {
                id: "file-big",
                format: "M4A",
                kind: "audio_only",
                bytes: 61000000,
                start: "2026-01-01T00:02:00.000Z",
                end: "2026-01-01T00:40:00.000Z",
                eligible: false,
                unavailableReason: "Longer than 60 minutes",
                reviewToken: null,
              },
            ],
          });
        }
        if (action === "import" && method === "POST") {
          zoomImports.push(req.postData() || "");
          if (zoomImportStatus) return json({ error: "Review expired" }, zoomImportStatus);
          current = note({
            id: "note-z",
            title: "Synthetic Zoom import",
            nativeSource: {
              provider: "zoom",
              scheduleId: "sched-1",
              meetingId: "m-1",
              meetingUuid: "u-1",
              fileId: "file-mp4",
              hostUserId: "h-1",
              recordingStart: "2026-01-01T00:02:00.000Z",
              recordingEnd: "2026-01-01T00:12:30.000Z",
            },
          });
          return json(current, 201);
        }
        unexpected.push(`${method} ${p}`);
        return json({ error: "blocked" }, 404);
      }
      const m = p.match(
        /^\/api\/jobs\/([^/]+)\/candidates\/([^/]+)\/meeting-notes(?:\/([^/]+))?(?:\/(process|recording|speaker-review))?$/,
      );
      if (!m) {
        unexpected.push(`${method} ${p}`);
        return json({ error: "blocked" }, 404);
      }
      const [, job, candidate, id, suffix] = m;
      if (method === "GET" && !id) {
        listReads++;
        return json(job === "job-a" && candidate === "cand-a" && current ? [current] : []);
      }
      if (method === "POST" && !id) {
        const form = req.postData() || "";
        uploads.push({ headers: req.headers(), form });
        current = note();
        uploadStatus = 201;
        return json(current, 201);
      }
      if (method === "GET" && id && !suffix) {
        detailReads++;
        if (job !== "job-a" || candidate !== "cand-a" || !current)
          return json({ error: "not found" }, 404);
        if (hideDetailsStatus)
          return json({ error: "private detail unavailable" }, hideDetailsStatus);
        if (processStarted && processReads >= 1) {
          const speakerMode = processes.at(-1)?.body.includes('"separateSpeakers":true');
          current = note({
            status: "completed",
            transcript: "Synthetic transcript: project delivery discussion.",
            summary: "Synthetic summary: candidate discussed project delivery.",
            speakerEvidence: speakerMode
              ? {
                  revision: "00000000-0000-4000-8000-000000000001",
                  generatedAt: stamp,
                  provider: "deepgram",
                  model: "nova-2",
                  segments: [
                    { speaker: 0, start: 0.4, end: 3.2, text: "Synthetic segment alpha." },
                    { speaker: 1, start: 65.1, end: 68.9, text: "Synthetic segment beta." },
                  ],
                }
              : null,
          });
          processStarted = false;
        }
        if (processStarted) processReads++;
        return json(current);
      }
      if (method === "POST" && suffix === "process") {
        const body = req.postData() ?? "";
        processes.push({ path: p, body });
        current = note({ status: "processing", processingStartedAt: stamp });
        processStarted = true;
        processReads = 0;
        processStatus = 202;
        return json(current, 202);
      }
      if (method === "PUT" && suffix === "speaker-review") {
        const body = JSON.parse(req.postData() || "{}");
        speakerPuts.push(body);
        const ev = current?.speakerEvidence;
        if (!ev) return json({ error: "not found" }, 404);
        if (speakerPutStatus) return json({ error: "Stale speaker source" }, speakerPutStatus);
        if (
          body.confirm !== true ||
          body.sourceRevision !== ev.revision ||
          body.previousRevision !== (ev.review?.revision ?? null)
        )
          return json({ error: "Stale speaker source" }, 409);
        const rev = `00000000-0000-4000-8000-0000000001${String(speakerPuts.length).padStart(2, "0")}`;
        current = {
          ...current,
          speakerEvidence: {
            ...ev,
            review: {
              revision: rev,
              reviewedBy: "staff@synthetic.test",
              reviewedAt: stamp,
              labels: body.labels,
            },
          },
        };
        return json(current);
      }
      if (method === "GET" && suffix === "recording") {
        downloads.push(p);
        return req.respond({ status: 200, contentType: "audio/wav", body: wav });
      }
      if (method === "DELETE" && id && !suffix) {
        deletes.push(p);
        current = null;
        deleteStatus = 204;
        return req.respond({ status: 204, body: "" });
      }
      unexpected.push(`${method} ${p}`);
      return json({ error: "blocked" }, 404);
    } catch (e) {
      errors.push(`interceptor ${req.url().slice(0, 160)} ${e.message}`);
      return json({ error: "fixture failure" }, 500);
    }
  });
  await page.goto(`${origin}/__meetingnotes`);
  await wait(1200);
  await page.waitForFunction(() =>
    document.body.innerText.includes("No job context for meeting notes"),
  );
  record(
    "no-job renders without issuing requests",
    !listReads && !detailReads && !uploads.length && !processes.length,
  );
  await page.evaluate(() => window.setContext({ candidateId: "cand-a", jobId: null }));
  await page.waitForFunction(() =>
    document.body.innerText.includes("No job context for meeting notes"),
  );
  record("no job has no meeting-notes API requests", listReads === 0 && detailReads === 0);
  await page.evaluate(() => window.setContext({ candidateId: "cand-a", jobId: "job-a" }));
  await page.waitForSelector(selector("button-capture-start"));
  await page.evaluate(() => {
    window.captureFixture = { mode: "ok", calls: 0, streams: [], contexts: [] };
    window.captureEvents = [];
    window.captureAllContexts = [];
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args);
        window.captureAllContexts.push(this);
      }
      close() {
        window.captureEvents.push({
          closeAt: performance.now(),
          time: this.currentTime,
          stack: new Error().stack,
        });
        return super.close();
      }
    };
    const NativeRecorder = window.MediaRecorder;
    window.MediaRecorder = class extends NativeRecorder {
      constructor(...args) {
        super(...args);
        window.captureEvents.push({ createdAt: performance.now() });
        this.addEventListener("dataavailable", (event) =>
          window.captureEvents.push({ size: event.data.size }),
        );
        this.addEventListener("stop", () => window.captureEvents.push({ stopped: true }));
      }
      start(...args) {
        window.captureEvents.push({ startAt: performance.now() });
        return super.start(...args);
      }
      stop() {
        window.captureEvents.push({ stopAt: performance.now() });
        return super.stop();
      }
    };
    const nativeUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const audio = async () => {
      // Chromium's fake-device flag guarantees a synthetic device here, not
      // access to a real microphone. Avoid cross-AudioContext fixture sources.
      const stream = await nativeUserMedia({ audio: true });
      window.captureFixture.streams.push(stream);
      return stream;
    };
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        window.captureFixture.calls++;
        return window.captureFixture.mode === "no-audio" ? new MediaStream() : audio();
      },
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: audio,
    });
  });
  record(
    "live capture requires consent before requesting devices",
    (await page.$eval(selector("button-capture-start"), (el) => el.disabled)) &&
      (await page.evaluate(() => window.captureFixture.calls)) === 0,
  );
  await page.locator(selector("checkbox-capture-consent")).click();
  await page
    .locator(selector("input-capture-consent-statement"))
    .fill("Both participants agreed before this synthetic test.");
  await page.evaluate(() => {
    window.captureFixture.mode = "no-audio";
  });
  await page.locator(selector("button-capture-start")).click();
  await page.waitForFunction(() => document.body.innerText.includes("No meeting audio was shared"));
  record(
    "missing shared audio fails visibly without uploading",
    uploads.length === 0 && processes.length === 0,
  );
  await page.evaluate(() => {
    window.captureFixture.mode = "ok";
  });
  await page.locator(selector("button-capture-start")).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="status-capture"]')?.textContent.includes("Recording"),
  );
  record(
    "recording disables upload and file selection without any automatic send",
    (await page.$eval(selector("button-upload-meeting"), (el) => el.disabled)) &&
      (await page.$eval(selector("input-meeting-file"), (el) => el.matches(":disabled"))) &&
      uploads.length === 0 &&
      processes.length === 0,
  );
  await wait(1300);
  await page.locator(selector("button-capture-stop")).click();
  try {
    await page.waitForSelector(selector("audio-capture-preview"), { timeout: 10000 });
  } catch (error) {
    record(
      "capture finalization diagnostics",
      false,
      await page.$eval(selector("panel-meeting-live-capture"), (el) => el.innerText),
    );
    record(
      "synthetic audio diagnostics",
      false,
      JSON.stringify(
        await page.evaluate(() => ({
          events: window.captureEvents,
          contexts: window.captureAllContexts.map((context) => ({
            state: context.state,
            time: context.currentTime,
          })),
          tracks: window.captureFixture.streams.map((stream) =>
            stream
              .getTracks()
              .map((track) => ({ kind: track.kind, state: track.readyState, muted: track.muted })),
          ),
        })),
      ),
    );
    throw error;
  }
  const capturePreview = await page.$eval(selector("audio-capture-preview"), (el) => ({
    src: el.src,
    autoplay: el.autoplay,
  }));
  const signal = await page.$eval(selector("audio-capture-preview"), async (el) => {
    const context = new OfflineAudioContext(1, 1, 48000);
    const buffer = await context.decodeAudioData(await (await fetch(el.src)).arrayBuffer());
    return {
      duration: buffer.duration,
      audible: buffer.getChannelData(0).some((sample) => Math.abs(sample) > 0.001),
    };
  });
  record(
    "captured file decodes to nonempty audio with an actual synthetic signal",
    signal.duration > 0.5 && signal.audible,
    JSON.stringify(signal),
  );
  record(
    "stopped recording has a local preview, releases sources and never auto-uploads",
    capturePreview.src.startsWith("blob:") &&
      !capturePreview.autoplay &&
      (await page.evaluate(() =>
        window.captureFixture.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === "ended"),
        ),
      )) &&
      uploads.length === 0 &&
      processes.length === 0,
  );
  await page.locator(selector("button-capture-use")).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="text-meeting-file"]')?.textContent.includes(".webm"),
  );
  record(
    "use-recording selects the captured file but still requires explicit upload consent",
    (await page.$eval(selector("button-upload-meeting"), (el) => el.disabled)) &&
      uploads.length === 0,
  );
  await page.evaluate(() => window.setContext({ candidateId: "cand-b", jobId: "job-a" }));
  await wait(250);
  await page.evaluate(() => window.setContext({ candidateId: "cand-a", jobId: "job-a" }));
  await page.waitForSelector(selector("button-capture-start"));
  record(
    "changing candidate clears unsaved capture",
    !(await page.$(selector("text-meeting-file"))),
  );
  await page.locator(selector("checkbox-capture-consent")).click();
  await page
    .locator(selector("input-capture-consent-statement"))
    .fill("Both participants agreed before this synthetic test.");
  await page.locator(selector("button-capture-start")).click();
  await page.waitForSelector(selector("button-capture-stop"));
  await page.locator(selector("button-capture-discard")).click();
  await page.waitForSelector(selector("button-capture-start"));
  record(
    "discard releases capture tracks without a file or upload",
    !(await page.$(selector("audio-capture-preview"))) &&
      (await page.evaluate(() =>
        window.captureFixture.streams.every((s) =>
          s.getTracks().every((t) => t.readyState === "ended"),
        ),
      )) &&
      uploads.length === 0,
  );
  await page.evaluate(() => Promise.all(window.captureFixture.contexts.map((c) => c.close())));
  await page.waitForFunction(() => document.body.innerText.includes("No meeting recordings yet"));
  await page.screenshot({ path: path.join(testRoot, "meeting-notes-empty.png"), fullPage: true });
  const submit = page.locator(selector("button-upload-meeting"));
  await (await page.$(selector("input-meeting-file"))).uploadFile(fixtureWav);
  await page.waitForFunction(() => document.querySelector('[data-testid="text-meeting-file"]'));
  await page
    .locator(selector("input-meeting-consent-statement"))
    .fill("All participants agreed to recording and AI transcription at the beginning.");
  const blockedWithoutConsent = await page.$eval(
    selector("button-upload-meeting"),
    (el) => el.disabled,
  );
  await page.locator(selector("checkbox-meeting-consent")).click();
  const enabledWithBoth = !(await page.$eval(
    selector("button-upload-meeting"),
    (el) => el.disabled,
  ));
  await page.locator(selector("checkbox-meeting-consent")).click();
  const blockedWithoutStatement = await page.$eval(
    selector("button-upload-meeting"),
    (el) => el.disabled,
  );
  record(
    "upload is blocked until both consent and factual statement are provided",
    blockedWithoutConsent && enabledWithBoth && blockedWithoutStatement && uploads.length === 0,
  );
  await page.locator(selector("checkbox-meeting-consent")).click();
  await page.locator(selector("input-meeting-planned")).fill("Role experience");
  await submit.click();
  await page.waitForSelector(selector("card-meeting-note-note-a"));
  await page.screenshot({
    path: path.join(testRoot, "meeting-notes-uploaded.png"),
    fullPage: true,
  });
  const submitted = uploads[0] || {};
  const contract = await page.evaluate(() => window.uploadContract);
  const fields = Object.fromEntries(contract || []);
  const contractOk =
    fields.file?.name === "synthetic.wav" &&
    fields.file?.type === "audio/wav" &&
    fields.title === "synthetic" &&
    fields.language === "en" &&
    fields.consent === "true" &&
    fields.consentStatement ===
      "All participants agreed to recording and AI transcription at the beginning." &&
    fields.plannedQuestions === "Role experience";
  record(
    "synthetic upload returns 201, exact multipart contract and refetched row/detail visible",
    uploadStatus === 201 &&
      uploads.length === 1 &&
      contractOk &&
      (await page.$$eval(selector("button-select-meeting-note-note-a"), (els) => els.length)) === 1,
    `${uploadStatus}; multipart fields ${contractOk ? "matched" : "did not match"}`,
  );
  record("upload does not automatically process recording", processes.length === 0);
  record(
    "speaker separation opt-in is present and unchecked by default",
    (await page.$eval(selector("checkbox-separate-speakers"), (el) =>
      el.getAttribute("aria-checked"),
    )) === "false",
  );
  await page.locator(selector("button-process-meeting")).click();
  await page.waitForFunction(() =>
    document.body.innerText.includes("Synthetic summary: candidate discussed project delivery."),
  );
  record(
    "explicit process sends POST {} 202 and polling/refetch shows synthetic transcript and summary",
    processStatus === 202 &&
      processes.length === 1 &&
      processes[0].body === "{}" &&
      (await page.$eval(selector("text-meeting-transcript"), (el) =>
        el.innerText.includes("Synthetic transcript"),
      )) &&
      (await page.$eval(selector("text-meeting-summary"), (el) =>
        el.innerText.includes("Synthetic summary"),
      )),
  );
  record(
    "default process shows no speaker evidence",
    !(await page.$(selector("section-speaker-evidence"))),
  );
  // Opt-in path: synthetic retryable failure, explicit checkbox, then evidence after polling.
  current = note({ status: "failed", canRetry: true, error: "Synthetic failure" });
  await page.evaluate(() => window.refetchNote("job-a", "cand-a", "note-a"));
  await page.waitForSelector(selector("checkbox-separate-speakers"));
  await page.locator(selector("checkbox-separate-speakers")).click();
  await page.locator(selector("button-process-meeting")).click();
  await page.waitForSelector(selector("section-speaker-evidence"), { timeout: 15000 });
  const segText = await page.$eval(selector("section-speaker-evidence"), (el) => el.innerText);
  record(
    "explicit opt-in sends separateSpeakers only on that request and renders anonymous segments",
    processes.length === 2 &&
      processes[0].body === "{}" &&
      JSON.parse(processes[1].body).separateSpeakers === true &&
      segText.includes("Speaker 1") &&
      segText.includes("Speaker 2") &&
      segText.includes("01:05") &&
      segText.includes("Synthetic segment beta.") &&
      !!(await page.$(selector("text-speaker-limitation"))),
    processes.map((x) => x.body).join(" | "),
  );
  // Human speaker label review.
  await page.locator(selector("button-speaker-review-edit")).click();
  await page.waitForSelector(selector("form-speaker-review"));
  const defaults = await page.$eval(selector("input-speaker-label-0"), (el) => el.value);
  const defaultRole = await page.$eval(selector("select-speaker-role-0"), (el) => el.value);
  record(
    "speaker review defaults stay anonymous/unknown and save is gated on confirmation",
    defaults === "Speaker 1" &&
      defaultRole === "unknown" &&
      (await page.$eval(selector("button-speaker-review-save"), (el) => el.disabled)) &&
      speakerPuts.length === 0,
  );
  await page.locator(selector("input-speaker-label-0")).fill("Synthetic Interviewer");
  await page.select(selector("select-speaker-role-0"), "interviewer");
  await page.locator(selector("checkbox-speaker-review-confirm")).click();
  await page.locator(selector("button-speaker-review-save")).click();
  await page.waitForSelector(selector("badge-speaker-reviewed"));
  await page.evaluate(() => window.refetchNote("job-a", "cand-a", "note-a"));
  await wait(500);
  const savedSpeakerDiagnostic = await page.evaluate(() => ({
    first: document.querySelector('[data-testid="text-speaker-label-0"]')?.textContent,
    second: document.querySelector('[data-testid="text-speaker-label-1"]')?.textContent,
    reviewed: !!document.querySelector('[data-testid="text-speaker-review-source"]'),
    sections: document.querySelectorAll('[data-testid="section-speaker-evidence"]').length,
  }));
  record(
    "saved staff label renders with staff-reviewed annotation after refresh",
    speakerPuts.length === 1 &&
      speakerPuts[0].confirm === true &&
      speakerPuts[0].previousRevision === null &&
      speakerPuts[0].labels.length === 2 &&
      savedSpeakerDiagnostic.sections === 1 &&
      (await page.$eval(selector("text-speaker-label-0"), (el) => el.innerText)) ===
        "Synthetic Interviewer" &&
      (await page.$eval(selector("text-speaker-label-1"), (el) => el.innerText)) === "Speaker 2" &&
      !!(await page.$(selector("text-speaker-review-source"))),
    JSON.stringify({ puts: speakerPuts, saved: savedSpeakerDiagnostic }),
  );
  speakerPutStatus = 409;
  await page.locator(selector("button-speaker-review-edit")).click();
  await page.locator(selector("input-speaker-label-0")).fill("UNSAVED DRAFT LABEL");
  await page.locator(selector("checkbox-speaker-review-confirm")).click();
  await page.locator(selector("button-speaker-review-save")).click();
  await page
    .waitForSelector(selector("text-speaker-review-conflict"), { timeout: 5000 })
    .catch(async (error) => {
      console.error(
        "Speaker review diagnostic",
        JSON.stringify({
          puts: speakerPuts,
          text: await page.$eval(selector("section-speaker-evidence"), (el) => el.innerText),
        }),
      );
      throw error;
    });
  record(
    "409 shows stale-source error and keeps last confirmed labels, not unsaved draft",
    !(await page.evaluate(() => document.body.innerText.includes("UNSAVED DRAFT LABEL"))) &&
      (await page.$eval(selector("text-speaker-label-0"), (el) => el.innerText)) ===
        "Synthetic Interviewer",
  );
  speakerPutStatus = 0;
  await page.locator(selector("button-speaker-review-edit")).click();
  await page.locator(selector("checkbox-speaker-review-confirm")).click();
  await page.locator(selector("button-speaker-review-clear")).click();
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="badge-speaker-reviewed"]'),
  );
  record(
    "clearing sends empty labels with prior revision and restores anonymous fallback",
    speakerPuts.at(-1).labels.length === 0 &&
      typeof speakerPuts.at(-1).previousRevision === "string" &&
      (await page.$eval(selector("text-speaker-label-0"), (el) => el.innerText)) === "Speaker 1",
  );
  await page.screenshot({
    path: path.join(testRoot, "meeting-notes-completed.png"),
    fullPage: true,
  });
  await page.locator(selector("button-download-meeting")).click();
  await wait();
  record(
    "recording download uses authenticated note endpoint rather than public URL",
    downloads.length === 1 &&
      downloads[0] === "/api/jobs/job-a/candidates/cand-a/meeting-notes/note-a/recording",
  );
  await page.locator(selector("button-delete-meeting")).click();
  await page.waitForSelector(selector("button-confirm-delete-meeting"));
  record("delete requires explicit confirmation", deletes.length === 0);
  await page.locator(selector("button-confirm-delete-meeting")).click();
  await page.waitForFunction(() => document.body.innerText.includes("No meeting recordings yet"));
  record(
    "confirmed delete issues DELETE 204 and clears list",
    deleteStatus === 204 &&
      deletes.length === 1 &&
      (await page.$$eval(selector("button-select-meeting-note-note-a"), (els) => els.length)) === 0,
  );
  // Native Zoom import (synthetic routes only; nothing contacts Zoom).
  record(
    "zoom appointments and provider preview are never requested automatically",
    zoomAppointmentReads === 0 &&
      zoomPreviews.length === 0 &&
      !!(await page.$(selector("text-meet-not-connected"))),
  );
  await page.locator(selector("button-zoom-load-appointments")).click();
  await page.waitForSelector(selector("radio-zoom-appointment-sched-1"));
  await page.locator(selector("radio-zoom-appointment-sched-1")).click();
  record(
    "listing and selecting an appointment does not preview the provider",
    zoomAppointmentReads === 1 && zoomPreviews.length === 0,
  );
  await page.locator(selector("button-zoom-preview")).click();
  await page.waitForSelector(selector("row-zoom-file-file-mp4"));
  record(
    "explicit preview sends only scheduleId, imports nothing, hides token, shows bounds",
    zoomPreviews.length === 1 &&
      JSON.stringify(zoomPreviews[0]) === '{"scheduleId":"sched-1"}' &&
      zoomImports.length === 0 &&
      !(await page.evaluate((t) => document.body.innerHTML.includes(t), ZOOM_TOKEN)) &&
      (await page.$eval(selector("text-zoom-file-unavailable-file-big"), (el) =>
        el.innerText.includes("100 MB"),
      )) &&
      (await page.$eval(selector("radio-zoom-file-file-big"), (el) => el.disabled)),
  );
  await page.locator(selector("radio-zoom-file-file-mp4")).click();
  await page.locator(selector("input-zoom-title")).fill("Synthetic Zoom import");
  const zoomNoConsent = await page.$eval(selector("button-zoom-import"), (el) => el.disabled);
  await page.locator(selector("checkbox-zoom-consent")).click();
  await page.locator(selector("checkbox-zoom-right-instance")).click();
  const zoomNoStatement = await page.$eval(selector("button-zoom-import"), (el) => el.disabled);
  record(
    "zoom import blocked without attestations and consent statement",
    zoomNoConsent && zoomNoStatement && zoomImports.length === 0,
  );
  const processCountBeforeZoom = processes.length;
  await page.locator(selector("input-zoom-consent-statement")).fill("Both agreed on the call.");
  await page.locator(selector("button-zoom-import")).click();
  await page.waitForSelector(selector("card-meeting-note-note-z"));
  record(
    "zoom import sends exact body with opaque token, selects note, does not process",
    zoomImports.length === 1 &&
      zoomImports[0] ===
        JSON.stringify({
          reviewToken: ZOOM_TOKEN,
          title: "Synthetic Zoom import",
          language: "en",
          consent: true,
          consentStatement: "Both agreed on the call.",
          plannedQuestions: "",
        }) &&
      processes.length === processCountBeforeZoom &&
      !!(await page.$(selector("text-meeting-native-source"))) &&
      !(await page.$(selector("form-zoom-import"))),
    zoomImports.join(" | "),
  );
  await page.locator(selector("radio-zoom-appointment-sched-1")).click();
  await page.locator(selector("button-zoom-preview")).click();
  await page.waitForSelector(selector("radio-zoom-file-file-mp4"));
  await page.locator(selector("radio-zoom-file-file-mp4")).click();
  await page.locator(selector("checkbox-zoom-consent")).click();
  await page.locator(selector("checkbox-zoom-right-instance")).click();
  await page.locator(selector("input-zoom-consent-statement")).fill("Both agreed on the call.");
  zoomImportStatus = 409;
  await page.locator(selector("button-zoom-import")).click();
  await page.waitForSelector(selector("text-zoom-stale"));
  record(
    "stale 409 discards preview/token and asks for explicit re-preview",
    zoomImports.length === 2 &&
      zoomPreviews.length === 2 &&
      !(await page.$(selector("row-zoom-file-file-mp4"))) &&
      !(await page.$(selector("form-zoom-import"))),
  );
  zoomImportStatus = 0;
  zoomPreviewStatus = 403;
  await page.locator(selector("button-zoom-preview")).click();
  await page.waitForSelector(selector("text-zoom-access-lost"));
  record(
    "403 preview clears appointments, form and selected private note",
    !(await page.$(selector("radio-zoom-appointment-sched-1"))) &&
      !(await page.$(selector("form-zoom-import"))) &&
      !(await page.$(selector("card-meeting-note-note-z"))),
  );
  zoomPreviewStatus = 0;
  // Reinsert synthetic private data, select it, then change candidate/job while detail is loaded.
  current = note({
    status: "completed",
    transcript: "PRIVATE candidate A transcript",
    summary: "PRIVATE candidate A summary",
  });
  await page.evaluate(() => window.setContext({ candidateId: "cand-a", jobId: "job-c" }));
  await page.waitForFunction(() => document.body.innerText.includes("No meeting recordings yet"));
  await page.evaluate(() => window.setContext({ candidateId: "cand-a", jobId: "job-a" }));
  await page.waitForSelector(selector("button-select-meeting-note-note-a"));
  await page.locator(selector("button-select-meeting-note-note-a")).click();
  await page.waitForFunction(() => document.body.innerText.includes("PRIVATE candidate A summary"));
  await page.evaluate(() => window.setContext({ candidateId: "cand-b", jobId: "job-b" }));
  await page.waitForFunction(() => document.body.innerText.includes("No meeting recordings yet"));
  record(
    "changing candidate/job clears private detail and upload form",
    !(await page.evaluate(() => document.body.innerText.includes("PRIVATE candidate A"))) &&
      (await page.$eval(selector("input-meeting-consent-statement"), (el) => el.value)) === "" &&
      detailReads >= 2,
  );
  // Cached data must be suppressed when a selected-note refetch fails with either status.
  current = note({
    status: "completed",
    transcript: "PRIVATE cached transcript",
    summary: "PRIVATE cached summary",
  });
  await page.evaluate(() => window.setContext({ candidateId: "cand-a", jobId: "job-a" }));
  await page.waitForSelector(selector("button-select-meeting-note-note-a"));
  await page.locator(selector("button-select-meeting-note-note-a")).click();
  // This fixture replaced a completed note while away from the page. Explicitly
  // refresh its 30-second cache before testing failure of a later refetch.
  await page.evaluate(() => window.refetchNote("job-a", "cand-a", "note-a"));
  await page.waitForFunction(() => document.body.innerText.includes("PRIVATE cached summary"));
  hideDetailsStatus = 403;
  await page.evaluate(() => window.refetchNote("job-a", "cand-a", "note-a"));
  await page.waitForFunction(() =>
    document.body.innerText.includes("Could not load this meeting note"),
  );
  const hidden403 = !(await page.evaluate(() =>
    document.body.innerText.includes("PRIVATE cached summary"),
  ));
  record("403 detail refetch fails closed without showing cached summary", hidden403);
  // Repeat as 404 on another freshly mounted query.
  hideDetailsStatus = 404;
  await page.evaluate(() => window.setContext({ candidateId: "cand-a", jobId: "job-c" }));
  await page.waitForFunction(() => document.body.innerText.includes("No meeting recordings yet"));
  await page.evaluate(() => window.setContext({ candidateId: "cand-a", jobId: "job-a" }));
  await page.waitForSelector(selector("button-select-meeting-note-note-a"));
  await page.locator(selector("button-select-meeting-note-note-a")).click();
  await page.waitForFunction(() =>
    document.body.innerText.includes("Could not load this meeting note"),
  );
  record(
    "404 detail fetch fails closed without showing cached summary",
    !(await page.evaluate(() => document.body.innerText.includes("PRIVATE cached summary"))),
  );
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('[data-testid="panel-meeting-notes"]'));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  await page.screenshot({ path: path.join(testRoot, "meeting-notes-mobile.png"), fullPage: true });
  record(
    "390px mobile viewport has no horizontal overflow",
    !overflow,
    `scrollWidth ${await page.evaluate(() => document.documentElement.scrollWidth)} / viewport ${await page.evaluate(() => document.documentElement.clientWidth)}`,
  );
  record(
    "no unexpected network requests or uncaught page errors",
    unexpected.length === 0 && errors.length === 0,
    [...unexpected, ...errors].join("; "),
  );
  console.log(`SCREENSHOTS ${testRoot}`);
} catch (e) {
  record("harness execution", false, [e.stack || e.message, ...errors].join("\n"));
} finally {
  rmSync(fixture, { force: true });
  rmSync(testRoot, { recursive: true, force: true });
  if (browser) {
    let timer;
    try {
      await Promise.race([
        browser.close(),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            browser.process()?.kill("SIGKILL");
            resolve();
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  await server.close();
}
if (results.some((r) => !r.ok)) process.exitCode = 1;
