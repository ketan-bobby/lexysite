import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";

// Real component + AuthProvider + generated client against intercepted synthetic
// responses. Proves UI gating only; not provider availability or delivery.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (id) => `[data-testid="${id}"]`;
const props = {
  scheduleId: "meet-fixture-schedule",
  scheduledAt: "2035-11-01T10:00:00.000Z",
  durationMinutes: 45,
};
const cand = {
  id: "cand-1",
  tenantId: "tenant-1",
  email: "c@example.invalid",
  name: "Synthetic",
  role: "candidate",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const GOOD = "https://meet.google.com/abc-defg-hij";
const ready = (o = {}) => ({
  scheduleId: props.scheduleId,
  scheduledAt: props.scheduledAt,
  durationMinutes: 45,
  status: "ready",
  meetUrl: GOOD,
  ...o,
});

const root = path.resolve(import.meta.dirname, "..");
const server = await createServer({
  configFile: false,
  root,
  base: "/",
  cacheDir: mkdtempSync(path.join(tmpdir(), "lexy-meet-browser-")),
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    entries: [path.join(root, "src/test-fixtures/candidate-google-meet-browser.tsx")],
  },
  resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
  logLevel: "error",
});
server.middlewares.use("/api", (_q, res) => {
  res.statusCode = 403;
  res.end("no backend");
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const entry = "/__meet-regression";
const html = await server.transformIndexHtml(
  entry,
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script type="module">
import { mountMeetFixture } from "/src/test-fixtures/candidate-google-meet-browser.tsx";
window.mountFixture = (h, p) => mountMeetFixture(h, p);</script></body></html>`,
);
let executablePath = puppeteer.executablePath();
if (!existsSync(executablePath))
  executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  pipe: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-background-networking"],
});

async function open({ width = 1100, user = cand, meet = () => ({ body: ready() }) } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 800 });
  const st = { user, meet, gets: 0, nav: [], violations: [], errors: [], writes: 0, gate: null };
  page.on("pageerror", (e) => st.errors.push(e.message));
  await page.evaluateOnNewDocument(() => {
    const orig = window.fetch.bind(window);
    window.__meetCaches = [];
    window.fetch = (input, init) => {
      const u = typeof input === "string" ? input : input.url;
      if (u.includes("/google-meet")) window.__meetCaches.push(init?.cache);
      return orig(input, init);
    };
  });
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const url = new URL(req.url());
    const json = (b, s = 200) =>
      req.respond({ status: s, contentType: "application/json", body: JSON.stringify(b) });
    try {
      if (url.hostname === "meet.google.com") {
        if (!req.isNavigationRequest()) return await req.respond({ status: 204 });
        st.nav.push(url.href);
        return await req.respond({
          status: 200,
          contentType: "text/html",
          body: "<p>meet intercepted</p>",
        });
      }
      if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com")
        return await req.respond({ status: 200, contentType: "text/css", body: "" });
      if (url.protocol === "data:") return await req.continue();
      assert.equal(url.origin, origin, "External request blocked " + url.href);
      if (url.pathname === entry)
        return await req.respond({ status: 200, contentType: "text/html", body: html });
      if (url.pathname === "/api/auth/me")
        return st.user ? await json(st.user) : await json({}, 401);
      if (url.pathname === `/api/portal/interview-schedules/${props.scheduleId}/google-meet`) {
        assert.equal(req.method(), "GET");
        st.gets++;
        if (st.gate) await st.gate;
        const r = await st.meet(st.gets);
        return await json(r.body, r.status ?? 200);
      }
      assert.ok(!url.pathname.startsWith("/api/"), `Unexpected API ${url.pathname}`);
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
  }, props);
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="fixture-actor"]')?.textContent === id,
    {},
    user ? user.id : "none",
  );
  return {
    page,
    st,
    ctx,
    setProps: (p) => page.evaluate((x) => window.fx.setProps(x), p),
    unmount: () => page.evaluate(() => window.fx.unmount()),
    actor: (u) => page.evaluate((x) => window.fx.switchActor(x), u),
  };
}
const join = (f) => f.page.$(T("button-join-google-meet"));
const waitJoin = (f) => f.page.waitForSelector(T("button-join-google-meet"));
const gone = async (f, ms = 400) => {
  await sleep(ms);
  assert.equal(await join(f), null);
};
const noFault = async (f) => {
  const c = await f.page.evaluate(() => window.__meetCaches);
  assert.ok(
    c.every((x) => x === "no-store"),
    "every Meet read uses cache: no-store " + c,
  );
  assert.deepEqual(f.st.violations, []);
  assert.deepEqual(f.st.errors, []);
  assert.equal(f.st.writes, 0);
};

const scenarios = [
  [
    "ready shows join, prep preserved, no private claims",
    async () => {
      const f = await open();
      await waitJoin(f);
      const txt = await f.page.$eval(T("actions"), (n) => n.textContent);
      assert.match(txt, /Join Google Meet/);
      assert.match(txt, /Prep/);
      assert.doesNotMatch(txt, /delivered|RSVP|accepted your|@/i);
      await noFault(f);
      return f;
    },
  ],
  [
    "pending/unavailable hidden",
    async () => {
      const f = await open({
        meet: () => ({ body: { ...ready(), status: "unavailable", meetUrl: null } }),
      });
      await gone(f);
      await noFault(f);
      return f;
    },
  ],
  [
    "stale timing hidden",
    async () => {
      const f = await open({
        meet: () => ({ body: ready({ scheduledAt: "2035-11-01T11:00:00.000Z" }) }),
      });
      await gone(f);
      await noFault(f);
      return f;
    },
  ],
  [
    "stale duration hidden",
    async () => {
      const f = await open({ meet: () => ({ body: ready({ durationMinutes: 30 }) }) });
      await gone(f);
      await noFault(f);
      return f;
    },
  ],
  [
    "wrong schedule id hidden",
    async () => {
      const f = await open({ meet: () => ({ body: ready({ scheduleId: "other" }) }) });
      await gone(f);
      await noFault(f);
      return f;
    },
  ],
  [
    "malicious urls hidden",
    async () => {
      for (const bad of [
        "https://evil.example/abc-defg-hij",
        "http://meet.google.com/abc-defg-hij",
        "https://meet.google.com.evil.example/abc-defg-hij",
        "https://user@meet.google.com/abc-defg-hij",
        "https://meet.google.com:444/abc-defg-hij",
        "https://meet.google.com/abc-defg-hij?authuser=1",
        "https://meet.google.com/abc-defg-hij#x",
        "https://meet.google.com/abc-defg-hij/",
        "javascript:alert(1)",
        "https://meet.google.com/ABC-defg-hij",
        "https://meet.google.com/lookup/abc",
      ]) {
        const f = await open({ meet: () => ({ body: ready({ meetUrl: bad }) }) });
        await gone(f, 250);
        assert.equal(await f.page.$("a[href]"), null);
        await noFault(f);
        await f.ctx.close();
      }
      return null;
    },
  ],
  [
    "non-candidate role hidden and never fetched",
    async () => {
      const f = await open({ user: { ...cand, role: "recruiter" } });
      await gone(f);
      assert.equal(f.st.gets, 0);
      await noFault(f);
      return f;
    },
  ],
  [
    "error on read hides",
    async () => {
      const f = await open({ meet: () => ({ status: 500, body: { error: "x" } }) });
      await gone(f);
      await noFault(f);
      return f;
    },
  ],
  [
    "cancellation on focus refresh hides link",
    async () => {
      const f = await open({
        meet: (n) => ({
          body: n === 1 ? ready() : { ...ready(), status: "unavailable", meetUrl: null },
        }),
      });
      await waitJoin(f);
      await f.page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-join-google-meet"]'),
      );
      assert.ok(f.st.gets >= 2);
      await noFault(f);
      return f;
    },
  ],
  [
    "error on refresh hides link",
    async () => {
      const f = await open({
        meet: (n) => (n === 1 ? { body: ready() } : { status: 503, body: { error: "x" } }),
      });
      await waitJoin(f);
      await f.page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-join-google-meet"]'),
      );
      await noFault(f);
      return f;
    },
  ],
  [
    "join revalidates fresh and succeeds same-tab",
    async () => {
      const f = await open();
      await waitJoin(f);
      const before = f.st.gets;
      await (await join(f)).click();
      await f.page.waitForFunction(() => document.body.textContent.includes("meet intercepted"));
      assert.deepEqual(f.st.nav, [GOOD]);
      assert.ok(f.st.gets > before, "fresh GET on join");
      await noFault(f);
      return f;
    },
  ],
  [
    "join blocked when fresh read is cancelled",
    async () => {
      const f = await open({
        meet: (n) => ({
          body: n === 1 ? ready() : { ...ready(), status: "unavailable", meetUrl: null },
        }),
      });
      await waitJoin(f);
      await (await join(f)).click();
      await f.page.waitForSelector(T("text-google-meet-failed")).catch(() => {});
      await sleep(300);
      assert.deepEqual(f.st.nav, []);
      assert.equal(await join(f), null);
      await noFault(f);
      return f;
    },
  ],
  [
    "join blocked when fresh read errors",
    async () => {
      const f = await open({
        meet: (n) => (n === 1 ? { body: ready() } : { status: 500, body: { error: "x" } }),
      });
      await waitJoin(f);
      await (await join(f)).click();
      await sleep(400);
      assert.deepEqual(f.st.nav, []);
      assert.equal(await join(f), null);
      await noFault(f);
      return f;
    },
  ],
  [
    "join blocked when fresh url malicious",
    async () => {
      const f = await open({
        meet: (n) => ({
          body: n === 1 ? ready() : ready({ meetUrl: "https://evil.example/abc-defg-hij" }),
        }),
      });
      await waitJoin(f);
      await (await join(f)).click();
      await sleep(400);
      assert.deepEqual(f.st.nav, []);
      await noFault(f);
      return f;
    },
  ],
  [
    "identity change during join await blocks navigation",
    async () => {
      const f = await open({ meet: (n) => ({ body: ready() }) });
      await waitJoin(f);
      let release;
      f.st.gate = new Promise((r) => (release = r));
      await (await join(f)).click();
      await sleep(150);
      f.st.user = { ...cand, id: "cand-2" };
      await f.actor({ ...cand, id: "cand-2" });
      await gone(f, 100);
      release();
      await sleep(400);
      assert.deepEqual(f.st.nav, []);
      await noFault(f);
      return f;
    },
  ],
  [
    "prop change during join await blocks navigation and clears immediately",
    async () => {
      const f = await open();
      await waitJoin(f);
      let release;
      f.st.gate = new Promise((r) => (release = r));
      await (await join(f)).click();
      await sleep(150);
      await f.setProps({ ...props, durationMinutes: 60 });
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-join-google-meet"]'),
      );
      release();
      await sleep(400);
      assert.deepEqual(f.st.nav, []);
      await noFault(f);
      return f;
    },
  ],
  [
    "logout clears immediately",
    async () => {
      const f = await open();
      await waitJoin(f);
      await f.actor(null);
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-join-google-meet"]'),
      );
      await noFault(f);
      return f;
    },
  ],
  [
    "identity switch does not reuse previous cache",
    async () => {
      const f = await open({ meet: () => ({ body: ready() }) });
      await waitJoin(f);
      let release;
      f.st.gate = new Promise((r) => (release = r));
      f.st.user = { ...cand, id: "cand-3", tenantId: "tenant-9" };
      await f.actor({ ...cand, id: "cand-3", tenantId: "tenant-9" });
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-join-google-meet"]'),
      );
      release();
      await waitJoin(f);
      await noFault(f);
      return f;
    },
  ],
  [
    "prop change to unmatched start hides while old data cached",
    async () => {
      const f = await open();
      await waitJoin(f);
      await f.setProps({ ...props, scheduledAt: "2035-11-02T10:00:00.000Z" });
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-join-google-meet"]'),
      );
      await sleep(300);
      assert.equal(await join(f), null);
      await noFault(f);
      return f;
    },
  ],
  [
    "mobile join reachable without overflow",
    async () => {
      const f = await open({ width: 360 });
      await waitJoin(f);
      const r = await f.page.$eval(T("button-join-google-meet"), (n) => {
        const b = n.getBoundingClientRect();
        return { l: b.left, r: b.right, w: innerWidth, sw: document.documentElement.scrollWidth };
      });
      assert.ok(r.l >= 0 && r.r <= r.w && r.sw <= r.w, JSON.stringify(r));
      await noFault(f);
      return f;
    },
  ],
  [
    "same-id role change during join await blocks navigation",
    async () => {
      const f = await open();
      await waitJoin(f);
      let release;
      f.st.gate = new Promise((r) => (release = r));
      await (await join(f)).click();
      await sleep(150);
      f.st.user = { ...cand, role: "recruiter" };
      await f.actor({ ...cand, role: "recruiter" });
      await gone(f, 100);
      release();
      await sleep(400);
      assert.deepEqual(f.st.nav, []);
      await noFault(f);
      return f;
    },
  ],
  [
    "unmount during join await never navigates",
    async () => {
      const f = await open();
      await waitJoin(f);
      let release;
      f.st.gate = new Promise((r) => (release = r));
      await (await join(f)).click();
      await sleep(150);
      await f.unmount();
      release();
      await sleep(400);
      assert.deepEqual(f.st.nav, []);
      await noFault(f);
      return f;
    },
  ],
  [
    "focus refetch pending hides cached link",
    async () => {
      const f = await open();
      await waitJoin(f);
      let release;
      f.st.gate = new Promise((r) => (release = r));
      await f.page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-join-google-meet"]'),
      );
      release();
      await waitJoin(f);
      await noFault(f);
      return f;
    },
  ],
  [
    "focus refetch error hides cached link",
    async () => {
      const f = await open({
        meet: (n) => (n === 1 ? { body: ready() } : { status: 500, body: { error: "x" } }),
      });
      await waitJoin(f);
      await f.page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-join-google-meet"]'),
      );
      await sleep(300);
      assert.equal(await join(f), null);
      await noFault(f);
      return f;
    },
  ],
];

const only = process.argv[2];
const selected = only ? scenarios.filter(([n]) => n.includes(only)) : scenarios;
let passed = 0,
  failed = 0;
try {
  for (const [name, run] of selected) {
    console.log(`RUN ${name}`);
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
console.log(
  `Candidate Google Meet browser checks: ${passed}/${selected.length} passed; ${failed} failed`,
);
process.exitCode = failed ? 1 : 0;
