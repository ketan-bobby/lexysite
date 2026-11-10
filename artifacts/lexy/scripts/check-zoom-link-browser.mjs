import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";

// Real components + AuthProvider + generated client against intercepted synthetic responses.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (id) => `[data-testid="${id}"]`;
const V = "v1_" + "a".repeat(64);
const V2 = "v1_" + "b".repeat(64);
const PUB = "55555555-5555-4555-8555-555555555555";
const TOKEN = "zl_" + "c".repeat(64);
const URL1 = "https://us02web.zoom.us/j/84012345678?pwd=abc";
const URL2 = "https://us02web.zoom.us/j/84099999999";
const when = new Date(Date.now() + 3 * 86400_000).toISOString();
const sched = {
  id: "s1",
  scheduledAt: when,
  durationMinutes: 45,
  status: "confirmed",
  type: "technical",
  version: V,
};
const staff = {
  id: "u1",
  tenantId: "t1",
  email: "r@example.invalid",
  name: "Rec",
  role: "recruiter",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const cand = { ...staff, id: "c1", role: "candidate" };
const view = (o = {}) => ({
  scheduleId: "s1",
  version: V,
  publicationId: null,
  scheduledAt: when,
  durationMinutes: 45,
  jobTitle: "Support Engineer",
  state: "none",
  canPublish: true,
  reason: null,
  joinUrl: null,
  approvedAt: null,
  approvalToken: null,
  reviewExpiresAt: null,
  providerVerified: false,
  ...o,
});
const published = (u = URL1) =>
  view({ publicationId: PUB, state: "published", joinUrl: u, approvedAt: when });

const root = path.resolve(import.meta.dirname, "..");
const server = await createServer({
  configFile: false,
  root,
  base: "/",
  cacheDir: mkdtempSync(path.join(tmpdir(), "lexy-zl-")),
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: [path.join(root, "src/test-fixtures/zoom-link-browser.tsx")] },
  resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
  logLevel: "error",
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const entry = "/__zl";
const html = await server.transformIndexHtml(
  entry,
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script type="module">
import { mountZoomFixture } from "/src/test-fixtures/zoom-link-browser.tsx";
window.mountFixture = (h, p) => mountZoomFixture(h, p);</script></body></html>`,
);
let executablePath = puppeteer.executablePath();
if (!existsSync(executablePath))
  executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  pipe: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

async function open({ user = staff, state = view(), cand: candBody } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  const st = {
    user,
    state,
    candBody:
      candBody ??
      (() => ({
        body: {
          scheduleId: "s1",
          status: "unavailable",
          joinUrl: null,
          providerVerified: false,
          source: "staff_provided",
        },
      })),
    gets: 0,
    reviews: [],
    puts: [],
    deletes: [],
    candGets: 0,
    other: [],
    violations: [],
    errors: [],
    getFail: null,
    review: null,
    put: null,
    del: null,
    putGate: null,
  };
  page.on("pageerror", (e) => st.errors.push(e.message));
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const url = new URL(req.url());
    const json = (b, s = 200) =>
      req.respond({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    try {
      if (/fonts\.(googleapis|gstatic)\.com/.test(url.hostname))
        return await req.respond({ status: 200, contentType: "text/css", body: "" });
      if (url.protocol === "data:") return await req.continue();
      assert.equal(url.origin, origin, "External request blocked " + url.href);
      if (url.pathname === entry)
        return await req.respond({ status: 200, contentType: "text/html", body: html });
      if (url.pathname === "/api/auth/me")
        return st.user ? await json(st.user) : await json({}, 401);
      if (url.pathname === "/api/zoom/schedules/s1/link") {
        const m = req.method();
        if (m === "GET") {
          st.gets++;
          if (st.getFail) return await json({ error: "x" }, st.getFail);
          return await json(st.state);
        }
        const b = JSON.parse(req.postData());
        if (m === "PUT") {
          st.puts.push(b);
          if (st.putGate) await st.putGate;
          const r = st.put ? st.put(b) : null;
          if (r) return await json(r.body ?? {}, r.status ?? 200);
          st.state = published(b.joinUrl);
          return await json(st.state);
        }
        if (m === "DELETE") {
          st.deletes.push(b);
          const r = st.del ? st.del(b) : null;
          if (r) return await json(r.body ?? {}, r.status ?? 200);
          st.state = view({ version: V2 });
          return await json(st.state);
        }
      }
      if (url.pathname === "/api/zoom/schedules/s1/link-review") {
        const b = JSON.parse(req.postData());
        st.reviews.push(b);
        const r = st.review ? st.review(b) : null;
        if (r) return await json(r.body ?? {}, r.status ?? 200);
        return await json(
          view({
            ...st.state,
            joinUrl: b.joinUrl,
            approvalToken: TOKEN,
            reviewExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          }),
        );
      }
      if (url.pathname === "/api/portal/interview-schedules/s1/zoom-link") {
        st.candGets++;
        const r = st.candBody(st.candGets);
        return await json(r.body, r.status ?? 200);
      }
      if (url.pathname.startsWith("/api/")) {
        st.other.push(req.method() + " " + url.pathname);
        return await json({}, 404);
      }
      assert.ok(["GET", "HEAD"].includes(req.method()), "Non-API write blocked");
      await req.continue();
    } catch (e) {
      st.violations.push(e.message.split("\n")[0]);
      if (!req.isInterceptResolutionHandled()) await req.abort("blockedbyclient").catch(() => {});
    }
  });
  await page.goto(`${origin}${entry}`);
  await page.waitForFunction(() => typeof window.mountFixture === "function");
  await page.evaluate((p) => {
    window.fx = window.mountFixture(document.getElementById("root"), p);
  }, sched);
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="fixture-actor"]')?.textContent === id,
    {},
    user ? `${user.id}:${user.role}` : "none",
  );
  return { page, st, ctx };
}
const click = (f, id) => f.page.click(T(id));
const exists = async (f, id) => !!(await f.page.$(T(id)));
const text = (f, id) => f.page.$eval(T(id), (n) => n.textContent);
const disabled = (f, id) => f.page.$eval(T(id), (n) => n.disabled);
const fault = (f) => {
  assert.deepEqual(f.st.violations, []);
  assert.deepEqual(f.st.errors, []);
  assert.deepEqual(f.st.other, []);
};
async function openDialog(f) {
  await click(f, "button-staff-zoom-s1");
  await f.page.waitForSelector(T("text-staff-zoom-state"));
}
async function typeUrl(f, u) {
  await f.page.waitForSelector(T("input-staff-zoom-url"));
  await f.page.$eval(T("input-staff-zoom-url"), (n) => {
    n.value = "";
  });
  await f.page.type(T("input-staff-zoom-url"), u);
}
async function review(f, u = URL1) {
  await typeUrl(f, u);
  await click(f, "button-staff-zoom-review");
  await f.page.waitForSelector(T("text-staff-zoom-review"));
}
const noLink = (f) =>
  f.page.evaluate(() => !document.body.innerHTML.includes("zoom.us/j/") || false);

const scenarios = [
  [
    "review plus unchecked ack never PUTs",
    async () => {
      const f = await open();
      await openDialog(f);
      await review(f);
      assert.equal(f.st.reviews[0].expectedVersion, V);
      assert.equal(f.st.reviews[0].expectedPublicationId, null);
      assert.equal(await disabled(f, "button-staff-zoom-publish"), true);
      assert.equal(await f.page.$eval(T("checkbox-staff-zoom-ack"), (n) => n.checked), false);
      await sleep(150);
      assert.equal(f.st.puts.length, 0);
      fault(f);
      return f;
    },
  ],
  [
    "explicit publish sends reviewed values, GET lacking token does not block, remount shows persisted",
    async () => {
      const f = await open();
      await openDialog(f);
      await review(f);
      await click(f, "checkbox-staff-zoom-ack");
      await click(f, "button-staff-zoom-publish");
      await f.page.waitForFunction(() =>
        document.querySelector('[data-testid="text-staff-zoom-notice"]'),
      );
      assert.equal(f.st.puts.length, 1);
      const b = f.st.puts[0];
      assert.deepEqual(
        [b.confirm, b.approvalToken, b.expectedVersion, b.expectedPublicationId],
        [true, TOKEN, V, null],
      );
      assert.equal(b.joinUrl, URL1);
      assert.ok(b.reviewExpiresAt);
      await f.page.keyboard.press("Escape");
      await sleep(100);
      await click(f, "fixture-toggle");
      await click(f, "fixture-toggle");
      await openDialog(f);
      assert.match(await text(f, "text-staff-zoom-state"), /published/);
      assert.match(await text(f, "text-staff-zoom-state"), /not API-verified/);
      assert.equal(f.st.puts.length, 1);
      fault(f);
      return f;
    },
  ],
  [
    "editing url invalidates approval",
    async () => {
      const f = await open();
      await openDialog(f);
      await review(f);
      await click(f, "checkbox-staff-zoom-ack");
      await f.page.type(T("input-staff-zoom-url"), "9");
      assert.equal(await exists(f, "text-staff-zoom-review"), false);
      assert.equal(await disabled(f, "button-staff-zoom-publish"), true);
      assert.equal(f.st.puts.length, 0);
      fault(f);
      return f;
    },
  ],
  [
    "native change before publish drops approval, no PUT",
    async () => {
      const f = await open();
      await openDialog(f);
      await review(f);
      f.st.state = view({ version: V2 });
      await click(f, "checkbox-staff-zoom-ack");
      await click(f, "button-staff-zoom-publish");
      await f.page.waitForSelector(T("text-staff-zoom-error"));
      assert.equal(f.st.puts.length, 0);
      assert.equal(await exists(f, "text-staff-zoom-review"), false);
      assert.equal(await f.page.$eval(T("input-staff-zoom-url"), (n) => n.value), URL1);
      fault(f);
      return f;
    },
  ],
  [
    "409 on PUT keeps draft, drops approval, no success claim",
    async () => {
      const f = await open();
      await openDialog(f);
      await review(f);
      f.st.put = () => ({ status: 409, body: { error: "changed" } });
      await click(f, "checkbox-staff-zoom-ack");
      await click(f, "button-staff-zoom-publish");
      await f.page.waitForSelector(T("text-staff-zoom-error"));
      assert.equal(await exists(f, "text-staff-zoom-notice"), false);
      assert.equal(await exists(f, "text-staff-zoom-review"), false);
      assert.equal(await f.page.$eval(T("input-staff-zoom-url"), (n) => n.value), URL1);
      fault(f);
      return f;
    },
  ],
  [
    "uncertain publish (mismatched body) never claims success",
    async () => {
      const f = await open();
      await openDialog(f);
      await review(f);
      f.st.put = () => ({ body: view() });
      await click(f, "checkbox-staff-zoom-ack");
      await click(f, "button-staff-zoom-publish");
      await f.page.waitForSelector(T("text-staff-zoom-error"));
      assert.match(await text(f, "text-staff-zoom-error"), /could not confirm/);
      assert.equal(await exists(f, "text-staff-zoom-notice"), false);
      assert.equal(await exists(f, "text-staff-zoom-review"), false);
      fault(f);
      return f;
    },
  ],
  [
    "503 on read shows error and no stale link",
    async () => {
      const f = await open({ state: published() });
      f.st.getFail = 503;
      await click(f, "button-staff-zoom-s1");
      await f.page.waitForSelector(T("text-staff-zoom-error"));
      assert.equal(await exists(f, "text-staff-zoom-state"), false);
      assert.equal(await noLink(f), true);
      fault(f);
      return f;
    },
  ],
  [
    "remove needs separate confirmation and sends version+uuid",
    async () => {
      const f = await open({ state: published() });
      await openDialog(f);
      assert.equal(await disabled(f, "button-staff-zoom-remove"), true);
      await sleep(100);
      assert.equal(f.st.deletes.length, 0);
      await click(f, "checkbox-staff-zoom-remove");
      await click(f, "button-staff-zoom-remove");
      await f.page.waitForSelector(T("text-staff-zoom-notice"));
      assert.deepEqual(f.st.deletes, [
        { expectedVersion: V, expectedPublicationId: PUB, confirm: true },
      ]);
      fault(f);
      return f;
    },
  ],
  [
    "stale link can be removed",
    async () => {
      const f = await open({
        state: view({ state: "stale", publicationId: PUB, joinUrl: URL1, canPublish: false }),
      });
      await openDialog(f);
      await click(f, "checkbox-staff-zoom-remove");
      await click(f, "button-staff-zoom-remove");
      await f.page.waitForSelector(T("text-staff-zoom-notice"));
      assert.equal(f.st.deletes.length, 1);
      fault(f);
      return f;
    },
  ],
  [
    "calendar_invitation_exists blocks publishing",
    async () => {
      const f = await open({
        state: view({ canPublish: false, reason: "calendar_invitation_exists" }),
      });
      await openDialog(f);
      await f.page.waitForSelector(T("text-staff-zoom-blocked"));
      assert.equal(await exists(f, "input-staff-zoom-url"), false);
      fault(f);
      return f;
    },
  ],
  [
    "actor switch while PUT in flight does not write late state",
    async () => {
      const f = await open();
      await openDialog(f);
      await review(f);
      let release;
      f.st.putGate = new Promise((r) => (release = r));
      await click(f, "checkbox-staff-zoom-ack");
      await click(f, "button-staff-zoom-publish");
      await f.page.waitForFunction(
        () => document.querySelector('[data-testid="button-staff-zoom-publish"]')?.disabled,
      );
      await f.page.evaluate((u) => window.fx.switchActor(u), { ...staff, id: "u2" });
      await f.page.waitForFunction(
        () =>
          document.querySelector('[data-testid="fixture-actor"]')?.textContent === "u2:recruiter",
      );
      release();
      await sleep(200);
      assert.equal(await exists(f, "text-staff-zoom-notice"), false);
      assert.equal(await exists(f, "text-staff-zoom-review"), false);
      assert.equal(await exists(f, "input-staff-zoom-url"), false);
      fault(f);
      return f;
    },
  ],
  [
    "schedule version change resets approval",
    async () => {
      const f = await open();
      await openDialog(f);
      await review(f);
      await f.page.evaluate((p) => window.fx.setProps(p), { ...sched, version: V2 });
      await sleep(150);
      assert.equal(await exists(f, "text-staff-zoom-review"), false);
      assert.equal(f.st.puts.length, 0);
      fault(f);
      return f;
    },
  ],
  [
    "candidate: available safe link shows, source/verification honored",
    async () => {
      const f = await open({
        user: cand,
        cand: () => ({
          body: {
            scheduleId: "s1",
            status: "available",
            joinUrl: URL1,
            providerVerified: false,
            source: "staff_provided",
          },
        }),
      });
      await f.page.waitForSelector(T("link-zoom-join-s1"));
      assert.equal(await f.page.$eval(T("link-zoom-join-s1"), (n) => n.getAttribute("href")), URL1);
      assert.equal(f.st.gets, 0);
      fault(f);
      return f;
    },
  ],
  [
    "candidate: error shows retry, no stale link, retry recovers",
    async () => {
      let n = 0;
      const f = await open({
        user: cand,
        cand: () =>
          ++n === 1
            ? { body: { available: 1 }, status: 500 }
            : {
                body: {
                  scheduleId: "s1",
                  status: "available",
                  joinUrl: URL1,
                  providerVerified: false,
                  source: "staff_provided",
                },
              },
      });
      await f.page.waitForSelector(T("button-zoom-retry-s1"));
      assert.equal(await exists(f, "link-zoom-join-s1"), false);
      await click(f, "button-zoom-retry-s1");
      await f.page.waitForSelector(T("link-zoom-join-s1"));
      fault(f);
      return f;
    },
  ],
  [
    "candidate: foreign, verified, host, unavailable responses never leak",
    async () => {
      const bad = [
        {
          scheduleId: "other",
          status: "available",
          joinUrl: URL1,
          providerVerified: false,
          source: "staff_provided",
        },
        {
          scheduleId: "s1",
          status: "available",
          joinUrl: URL1,
          providerVerified: true,
          source: "staff_provided",
        },
        {
          scheduleId: "s1",
          status: "available",
          joinUrl: "https://zoom.us/s/84012345678?zak=secret",
          providerVerified: false,
          source: "staff_provided",
        },
        {
          scheduleId: "s1",
          status: "available",
          joinUrl: "https://evil.example/j/84012345678",
          providerVerified: false,
          source: "staff_provided",
        },
        {
          scheduleId: "s1",
          status: "unavailable",
          joinUrl: URL1,
          providerVerified: false,
          source: "staff_provided",
        },
      ];
      for (const body of bad) {
        const f = await open({ user: cand, cand: () => ({ body }) });
        await f.page.waitForFunction(() => true);
        await sleep(250);
        assert.equal(await exists(f, "link-zoom-join-s1"), false, JSON.stringify(body));
        assert.equal(
          await f.page.evaluate(() => /zoom\.us|evil\.example|zak=/.test(document.body.innerHTML)),
          false,
        );
        fault(f);
        await f.ctx.close();
      }
      return null;
    },
  ],
];

const only = process.argv[2];
const selected = only ? scenarios.filter(([n]) => n.includes(only)) : scenarios;
let passed = 0,
  failed = 0;
try {
  for (const [name, run] of selected) {
    let f;
    try {
      f = await run();
      passed++;
      console.log(`PASS ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}\n${e.stack}`);
    } finally {
      if (f) await f.ctx.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`Zoom link browser checks: ${passed}/${selected.length} passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
