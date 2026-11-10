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
const REV = "11111111-1111-4111-8111-111111111111";
const CONN = "33333333-3333-4333-8333-333333333333";
const future = Date.now() + 3 * 86400_000;
const sched = {
  id: "s1",
  applicationId: "a1",
  interviewerId: null,
  scheduledAt: new Date(future).toISOString(),
  durationMinutes: 45,
  status: "scheduled",
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
const members = (o = {}) => ({
  scheduleId: "s1",
  version: V,
  members: [
    { id: "m1", name: "Ana" },
    { id: "m2", name: "Ben" },
  ],
  ...o,
});
const dayStr = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const slotAt = (min) => {
  const a = new Date(new Date(`${dayStr(future)}T09:00:00`).getTime() + min * 60000);
  return { start: a.toISOString(), end: new Date(a.getTime() + 45 * 60000).toISOString() };
};
const times = (b, o = {}) => ({
  scheduleId: "s1",
  version: V,
  checkedAt: new Date().toISOString(),
  panelSize: b.userIds.length,
  durationMinutes: 45,
  calendarReserved: false,
  invitationSent: false,
  slots: [slotAt(60), slotAt(180)],
  ...o,
});

const V2 = "v1_" + "e".repeat(64);
const savedBody = (o = {}) => ({
  scheduleId: "s1",
  version: V,
  scheduledAt: sched.scheduledAt,
  durationMinutes: 45,
  members: [],
  bufferMinutes: 0,
  provider: null,
  calendarReserved: false,
  invitationSent: false,
  ...o,
});
const googleSaved = (o = {}) =>
  savedBody({
    provider: "google",
    members: [
      { id: "m1", name: "Ana" },
      { id: "m2", name: "Ben" },
    ],
    bufferMinutes: 10,
    ...o,
  });

const root = path.resolve(import.meta.dirname, "..");
const server = await createServer({
  configFile: false,
  root,
  base: "/",
  cacheDir: mkdtempSync(path.join(tmpdir(), "lexy-gp-")),
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: [path.join(root, "src/test-fixtures/google-panel-browser.tsx")] },
  resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
  logLevel: "error",
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const entry = "/__gp";
const html = await server.transformIndexHtml(
  entry,
  `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script type="module">
import { mountGoogleFixture } from "/src/test-fixtures/google-panel-browser.tsx";
window.mountFixture = (h, p) => mountGoogleFixture(h, p);</script></body></html>`,
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

async function open({ width = 1100, user = staff, consent, mem, find, saved, put, outlook } = {}) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 900 });
  const st = {
    healthy: !consent || consent.canEnable,
    user,
    consent: consent ?? { enabled: false, canEnable: true, revision: CONN, grantedAt: null },
    mem: mem ?? (() => ({ body: members() })),
    find: find ?? ((b) => ({ body: times(b) })),
    saved: saved ?? (() => ({ body: savedBody() })),
    put:
      put ??
      ((b) => {
        const body = b.userIds.length
          ? googleSaved({
              version: V2,
              scheduledAt: b.scheduledAt,
              bufferMinutes: b.bufferMinutes,
              members: b.userIds.map((id) => ({ id, name: id === "m1" ? "Ana" : "Ben" })),
            })
          : savedBody({ version: V2, scheduledAt: b.scheduledAt });
        st.current = body;
        return { body };
      }),
    current: null,
    olGets: 0,
    olWrites: [],
    puts: [],
    savedGets: 0,
    posts: [],
    finds: [],
    memGets: 0,
    consentGets: 0,
    other: [],
    violations: [],
    errors: [],
    gate: null,
  };
  if (outlook) await page.evaluateOnNewDocument(() => (window.__outlook = true));
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
      if (url.pathname === "/api/google-calendar/panel-consent") {
        if (req.method() === "GET") {
          st.consentGets++;
          return await json(st.consent);
        }
        const b = JSON.parse(req.postData());
        st.posts.push(b);
        const r = typeof st.setConsent === "function" ? st.setConsent(b) : null;
        if (r) return await json(r.body, r.status ?? 200);
        st.consent = b.enabled
          ? {
              enabled: true,
              canEnable: true,
              revision: b.expectedRevision,
              grantedAt: new Date().toISOString(),
            }
          : {
              enabled: false,
              canEnable: !!st.healthy,
              revision: b.expectedRevision,
              grantedAt: null,
            };
        return await json(st.consent);
      }
      if (url.pathname === "/api/google-calendar/schedules/s1/panel") {
        if (req.method() === "GET") {
          st.savedGets++;
          const r = st.current ? { body: st.current } : st.saved(st.savedGets);
          return await json(r.body, r.status ?? 200);
        }
        const b = JSON.parse(req.postData());
        st.puts.push(b);
        if (st.putGate) await st.putGate;
        const r = st.put(b, st.puts.length);
        return await json(r.body, r.status ?? 200);
      }
      if (url.pathname === "/api/outlook-calendar/schedules/s1/panel") {
        if (req.method() !== "GET") {
          st.olWrites.push(req.method());
          return await json({ error: "blocked" }, 409);
        }
        st.olGets++;
        return await json(st.saved(1).body);
      }
      if (url.pathname === "/api/outlook-calendar/schedules/s1/panel-members") {
        return await json(members());
      }
      if (url.pathname === "/api/google-calendar/schedules/s1/panel-members") {
        st.memGets++;
        if (st.gate) await st.gate;
        const r = st.mem(st.memGets);
        return await json(r.body, r.status ?? 200);
      }
      if (url.pathname === "/api/google-calendar/schedules/s1/panel-times") {
        const b = JSON.parse(req.postData());
        st.finds.push(b);
        if (st.findGate) await st.findGate;
        const r = st.find(b);
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
  return {
    page,
    st,
    ctx,
    actor: (u) => page.evaluate((x) => window.fx.switchActor(x), u),
    setProps: (p) => page.evaluate((x) => window.fx.setProps(x), p),
  };
}
const click = (f, id) => f.page.click(T(id));
const exists = async (f, id) => !!(await f.page.$(T(id)));
const text = (f, id) => f.page.$eval(T(id), (n) => n.textContent);
const fault = (f) => {
  assert.deepEqual(f.st.violations, []);
  assert.deepEqual(f.st.errors, []);
  assert.deepEqual(f.st.other, []);
};
async function search(f, ids = ["m1"]) {
  await click(f, "button-open-google-panel");
  await f.page.waitForSelector(T("checkbox-google-panel-m1"));
  for (const id of ids) await click(f, `checkbox-google-panel-${id}`);
  await click(f, "button-search-google-panel");
}
const overflow = (f) => f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const scenarios = [
  [
    "consent grant requires acknowledgment and confirmShare",
    async () => {
      const f = await open();
      await f.page.waitForSelector(T("button-google-panel-enable"));
      assert.equal(await f.page.$eval(T("button-google-panel-enable"), (n) => n.disabled), true);
      await click(f, "checkbox-google-panel-ack");
      await click(f, "button-google-panel-enable");
      await f.page.waitForSelector(T("button-google-panel-revoke"));
      assert.equal(f.st.posts.length, 1);
      assert.equal(f.st.posts[0].enabled, true);
      assert.equal(f.st.posts[0].confirmShare, true);
      assert.equal(f.st.posts[0].expectedRevision, CONN);
      fault(f);
      return f;
    },
  ],
  [
    "null or malformed revision: enabling disabled, no mutation",
    async () => {
      for (const consent of [
        { enabled: false, canEnable: false, revision: null, grantedAt: null },
        { enabled: false, canEnable: true, revision: "nope", grantedAt: null },
      ]) {
        const f = await open({ consent });
        if (consent.revision === null) {
          await f.page.waitForSelector(T("text-google-panel-needs-connection"));
          await click(f, "checkbox-google-panel-ack");
          assert.equal(
            await f.page.$eval(T("button-google-panel-enable"), (n) => n.disabled),
            true,
          );
          await f.page.$eval(T("button-google-panel-enable"), (n) => n.click());
        } else await f.page.waitForSelector(T("button-google-panel-reload") + ",[role=alert]");
        await sleep(200);
        assert.deepEqual(f.st.posts, []);
        fault(f);
        await f.ctx.close();
      }
      return null;
    },
  ],
  [
    "unhealthy saved permission can be revoked but not enabled",
    async () => {
      const f = await open({
        consent: {
          enabled: true,
          canEnable: false,
          revision: REV,
          grantedAt: new Date().toISOString(),
        },
      });
      await f.page.waitForSelector(T("text-google-panel-unhealthy"));
      await click(f, "button-google-panel-revoke");
      await f.page.waitForSelector(T("text-google-panel-needs-connection"));
      assert.deepEqual(f.st.posts, [{ enabled: false, expectedRevision: REV }]);
      assert.equal(await f.page.$eval(T("button-google-panel-enable"), (n) => n.disabled), true);
      fault(f);
      return f;
    },
  ],
  [
    "revoke sends current revision",
    async () => {
      const f = await open({
        consent: {
          enabled: true,
          canEnable: true,
          revision: REV,
          grantedAt: new Date().toISOString(),
        },
      });
      await f.page.waitForSelector(T("button-google-panel-revoke"));
      await click(f, "button-google-panel-revoke");
      await f.page.waitForSelector(T("button-google-panel-enable"));
      assert.deepEqual(f.st.posts, [{ enabled: false, expectedRevision: REV }]);
      fault(f);
      return f;
    },
  ],
  [
    "consent failure surfaces error, no optimistic success",
    async () => {
      const f = await open({
        consent: {
          enabled: true,
          canEnable: true,
          revision: REV,
          grantedAt: new Date().toISOString(),
        },
      });
      f.st.setConsent = () => ({ status: 409, body: { error: "Your choice changed elsewhere." } });
      await f.page.waitForSelector(T("button-google-panel-revoke"));
      await click(f, "button-google-panel-revoke");
      await f.page.waitForSelector(T("text-google-panel-error"));
      assert.match(await text(f, "text-google-panel-error"), /changed elsewhere/);
      assert.match(await text(f, "status-google-panel-consent"), /on/);
      assert.equal(await exists(f, "text-google-panel-done"), false);
      fault(f);
      return f;
    },
  ],
  [
    "malformed consent response not trusted",
    async () => {
      const f = await open({
        consent: {
          enabled: true,
          canEnable: true,
          revision: REV,
          grantedAt: new Date().toISOString(),
        },
      });
      f.st.setConsent = () => ({
        body: { enabled: true, canEnable: true, revision: REV, grantedAt: "x" },
      });
      await f.page.waitForSelector(T("button-google-panel-revoke"));
      await click(f, "button-google-panel-revoke");
      await f.page.waitForSelector(T("text-google-panel-error"));
      assert.match(await text(f, "status-google-panel-consent"), /on/);
      fault(f);
      return f;
    },
  ],
  [
    "candidate: no consent card, no fetch",
    async () => {
      const f = await open({ user: { ...staff, role: "candidate" } });
      await sleep(400);
      assert.equal(await exists(f, "card-google-panel-consent"), false);
      assert.equal(f.st.consentGets, 0);
      assert.equal(f.st.memGets, 0);
      assert.equal(f.st.savedGets, 0);
      fault(f);
      return f;
    },
  ],
  [
    "interviewer may opt in but not search",
    async () => {
      const f = await open({ user: { ...staff, role: "interviewer" } });
      await f.page.waitForSelector(T("button-google-panel-enable"));
      assert.equal(await exists(f, "button-open-google-panel"), false);
      assert.equal(f.st.memGets, 0);
      fault(f);
      return f;
    },
  ],
  [
    "search sends validated inputs; review opens without writes",
    async () => {
      const f = await open();
      await search(f, ["m1", "m2"]);
      await f.page.waitForSelector(T("google-panel-results"));
      const b = f.st.finds[0];
      assert.equal(b.expectedVersion, V);
      assert.deepEqual(b.userIds, ["m1", "m2"]);
      assert.equal(b.bufferMinutes, 15);
      assert.ok(Date.parse(b.end) - Date.parse(b.start) <= 25 * 3600_000);
      const s = slotAt(60);
      await click(f, `button-use-google-time-${s.start}`);
      await f.page.waitForSelector(T("google-panel-review"));
      assert.equal(f.st.puts.length, 0);
      assert.equal(f.st.posts.length, 0);
      assert.equal(f.st.finds.length, 1);
      fault(f);
      return f;
    },
  ],
  [
    "version mismatch in results rejected",
    async () => {
      const f = await open({
        find: (b) => ({ body: times(b, { version: "v1_" + "b".repeat(64) }) }),
      });
      await search(f);
      await f.page.waitForSelector(T("text-google-panel-search-error"));
      assert.equal(await exists(f, "google-panel-results"), false);
      fault(f);
      return f;
    },
  ],
  [
    "malformed results rejected",
    async () => {
      const bads = [
        (b) => times(b, { calendarReserved: true }),
        (b) => times(b, { invitationSent: true }),
        (b) => times(b, { durationMinutes: 30 }),
        (b) => times(b, { panelSize: 3 }),
        (b) => times(b, { slots: [{ start: "x", end: "y" }] }),
        (b) => times(b, { slots: [{ start: slotAt(60).start, end: slotAt(70).end }] }),
        (b) => times(b, { slots: [slotAt(60 * 20)] }),
        (b) => times(b, { scheduleId: "other" }),
      ];
      for (const bad of bads) {
        const f = await open({ find: (b) => ({ body: bad(b) }) });
        await search(f);
        await f.page.waitForSelector(T("text-google-panel-search-error"));
        assert.equal(await exists(f, "google-panel-results"), false);
        fault(f);
        await f.ctx.close();
      }
      return null;
    },
  ],
  [
    "server errors never shown as free",
    async () => {
      const f = await open({ find: () => ({ status: 502, body: { error: "x" } }) });
      await search(f);
      await f.page.waitForSelector(T("text-google-panel-search-error"));
      assert.match(
        await text(f, "text-google-panel-search-error"),
        /does not mean calendars are free/,
      );
      fault(f);
      return f;
    },
  ],
  [
    "role change clears results and hides finder",
    async () => {
      const f = await open();
      await search(f);
      await f.page.waitForSelector(T("google-panel-results"));
      f.st.user = { ...staff, role: "interviewer" };
      await f.actor({ ...staff, role: "interviewer" });
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="google-panel-results"]'),
      );
      assert.equal(await exists(f, "button-open-google-panel"), false);
      fault(f);
      return f;
    },
  ],
  [
    "role change during search discards late response",
    async () => {
      const f = await open();
      let rel;
      f.st.findGate = new Promise((r) => (rel = r));
      await search(f);
      await sleep(200);
      await f.actor({ ...staff, role: "interviewer" });
      rel();
      await sleep(400);
      assert.equal(await exists(f, "google-panel-results"), false);
      fault(f);
      return f;
    },
  ],
  [
    "schedule version prop change invalidates results",
    async () => {
      const f = await open();
      await search(f);
      await f.page.waitForSelector(T("google-panel-results"));
      await f.setProps({ ...sched, version: "v1_" + "c".repeat(64) });
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="google-panel-results"]'),
      );
      fault(f);
      return f;
    },
  ],
  [
    "input change clears results",
    async () => {
      const f = await open();
      await search(f);
      await f.page.waitForSelector(T("google-panel-results"));
      await click(f, "checkbox-google-panel-m2");
      assert.equal(await exists(f, "google-panel-results"), false);
      fault(f);
      return f;
    },
  ],
  [
    "directory refetch on focus clears results; member removal blocks use",
    async () => {
      let n = 0;
      const f = await open({
        mem: () => ({
          body: ++n === 1 ? members() : members({ members: [{ id: "m2", name: "Ben" }] }),
        }),
      });
      await search(f);
      await f.page.waitForSelector(T("google-panel-results"));
      await f.page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="google-panel-results"]'),
      );
      assert.ok(f.st.memGets >= 2);
      fault(f);
      return f;
    },
  ],
  [
    "directory error shows retry, not empty",
    async () => {
      const f = await open({ mem: () => ({ status: 500, body: { error: "x" } }) });
      await click(f, "button-open-google-panel");
      await f.page.waitForFunction(() => document.body.textContent.includes("could not be loaded"));
      assert.equal(await exists(f, "button-search-google-panel"), false);
      fault(f);
      return f;
    },
  ],
  [
    "stale directory version blocks search",
    async () => {
      const f = await open({ mem: () => ({ body: members({ version: "v1_" + "d".repeat(64) }) }) });
      await click(f, "button-open-google-panel");
      await f.page.waitForFunction(() => document.body.textContent.includes("schedule changed"));
      assert.equal(f.st.finds.length, 0);
      fault(f);
      return f;
    },
  ],
  [
    "invalid inputs make no request",
    async () => {
      const f = await open();
      await click(f, "button-open-google-panel");
      await f.page.waitForSelector(T("checkbox-google-panel-m1"));
      await click(f, "checkbox-google-panel-m1");
      await f.page.$eval("#gp-buf-s1", (n) => {
        n.focus();
      });
      await f.page.click("#gp-buf-s1", { clickCount: 3 });
      await f.page.keyboard.type("99");
      await click(f, "button-search-google-panel");
      await f.page.waitForSelector(T("text-google-panel-search-error"));
      assert.equal(f.st.finds.length, 0);
      fault(f);
      return f;
    },
  ],
  [
    "phone viewport has no overflow",
    async () => {
      const f = await open({ width: 360 });
      await search(f, ["m2"]);
      await f.page.waitForSelector(T("google-panel-results"));
      assert.equal(await overflow(f), true);
      fault(f);
      return f;
    },
  ],
  [
    "saved roster shows on open and after remount without the directory",
    async () => {
      const f = await open({
        saved: () => ({ body: googleSaved() }),
        mem: () => ({ status: 500, body: { error: "x" } }),
      });
      await f.page.waitForFunction(() =>
        document.body.textContent.includes("Ana, Ben (buffer 10 min)"),
      );
      assert.equal(f.st.memGets, 0);
      const before = f.st.savedGets;
      await click(f, "fixture-toggle");
      await click(f, "fixture-toggle");
      await f.page.waitForFunction(() =>
        document.body.textContent.includes("Ana, Ben (buffer 10 min)"),
      );
      assert.ok(f.st.savedGets > before);
      fault(f);
      return f;
    },
  ],
  [
    "saved roster preselects in directory",
    async () => {
      const f = await open({ saved: () => ({ body: googleSaved() }) });
      await click(f, "button-open-google-panel");
      await f.page.waitForSelector(`${T("checkbox-google-panel-m1")}:checked`);
      await f.page.waitForSelector(`${T("checkbox-google-panel-m2")}:checked`);
      fault(f);
      return f;
    },
  ],
  [
    "explicit review then save sends exact body and invalidates",
    async () => {
      const f = await open();
      await f.page.waitForSelector(T("button-open-google-panel"));
      await search(f, ["m1", "m2"]);
      await f.page.waitForSelector(T("google-panel-results"));
      const s = slotAt(60);
      await click(f, `button-use-google-time-${s.start}`);
      await f.page.waitForSelector(T("google-panel-review"));
      assert.equal(f.st.puts.length, 0);
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-save-google-panel"]').disabled,
      );
      await click(f, "button-save-google-panel");
      await f.page.waitForSelector(T("text-google-save-result"));
      assert.deepEqual(f.st.puts, [
        { expectedVersion: V, userIds: ["m1", "m2"], scheduledAt: s.start, bufferMinutes: 15 },
      ]);
      assert.equal(await exists(f, "google-panel-review"), false);
      assert.ok((await text(f, "text-google-save-result")).includes("No calendar was reserved"));
      fault(f);
      return f;
    },
  ],
  [
    "remove needs deliberate confirmation and keeps exact time, buffer 0",
    async () => {
      const f = await open({
        saved: () => ({ body: googleSaved() }),
        mem: () => ({ status: 500, body: {} }),
      });
      await f.page.waitForSelector(T("button-remove-google-panel"));
      await click(f, "button-remove-google-panel");
      await f.page.waitForSelector(T("google-remove-confirm"));
      assert.equal(f.st.puts.length, 0);
      await click(f, "button-cancel-remove-google-panel");
      assert.equal(f.st.puts.length, 0);
      await click(f, "button-remove-google-panel");
      await click(f, "button-confirm-remove-google-panel");
      await f.page.waitForSelector(T("text-google-save-result"));
      assert.deepEqual(f.st.puts, [
        { expectedVersion: V, userIds: [], scheduledAt: sched.scheduledAt, bufferMinutes: 0 },
      ]);
      await f.page.waitForFunction(() =>
        document.body.textContent.includes("No Google panel saved"),
      );
      fault(f);
      return f;
    },
  ],
  [
    "409 keeps review and draft, shows server message",
    async () => {
      const f = await open({
        put: () => ({ status: 409, body: { error: "The schedule changed." } }),
      });
      await search(f, ["m1"]);
      await f.page.waitForSelector(T("google-panel-results"));
      await click(f, `button-use-google-time-${slotAt(60).start}`);
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-save-google-panel"]').disabled,
      );
      await click(f, "button-save-google-panel");
      await f.page.waitForSelector(T("text-google-save-error"));
      assert.ok((await text(f, "text-google-save-error")).includes("The schedule changed."));
      assert.equal(await exists(f, "google-panel-review"), true);
      assert.equal(await f.page.$eval(T("checkbox-google-panel-m1"), (n) => n.checked), true);
      fault(f);
      return f;
    },
  ],
  [
    "malformed or unknown outcome requires reload before retry",
    async () => {
      for (const bad of [
        { body: googleSaved({ scheduleId: "other" }) },
        { body: googleSaved({ version: V2, members: [{ id: "m2", name: "Ben" }] }) },
        { body: googleSaved({ version: V2, provider: "outlook" }) },
        { body: googleSaved({ version: V2, calendarReserved: true }) },
        { status: 500, body: {} },
      ]) {
        const f = await open({ put: () => bad, mem: () => ({ body: members() }) });
        await search(f, ["m1"]);
        await f.page.waitForSelector(T("google-panel-results"));
        await click(f, `button-use-google-time-${slotAt(60).start}`);
        await f.page.waitForFunction(
          () => !document.querySelector('[data-testid="button-save-google-panel"]').disabled,
        );
        await click(f, "button-save-google-panel");
        await f.page.waitForSelector(T("button-reload-after-unconfirmed"));
        assert.ok((await text(f, "text-google-save-error")).includes("may or may not"));
        assert.equal(await f.page.$eval(T("button-save-google-panel"), (n) => n.disabled), true);
        assert.equal(f.st.puts.length, 1);
        await click(f, "button-reload-after-unconfirmed");
        await f.page.waitForFunction(
          () => !document.querySelector('[data-testid="button-reload-after-unconfirmed"]'),
        );
        assert.equal(await f.page.$eval(T("button-save-google-panel"), (n) => n.disabled), false);
        fault(f);
        await f.ctx.close();
      }
      return null;
    },
  ],
  [
    "outlook or legacy panel blocks overwrite and removal",
    async () => {
      for (const body of [
        googleSaved({ provider: "outlook" }),
        (() => {
          const b = googleSaved();
          delete b.provider;
          return b;
        })(),
      ]) {
        const f = await open({ saved: () => ({ body }) });
        await f.page.waitForSelector(T("text-google-panel-outlook-blocked"));
        assert.equal(await exists(f, "button-remove-google-panel"), false);
        await search(f, ["m1"]);
        await f.page.waitForSelector(T("google-panel-results"));
        await click(f, `button-use-google-time-${slotAt(60).start}`);
        await f.page.waitForSelector(T("google-panel-review"));
        assert.equal(await f.page.$eval(T("button-save-google-panel"), (n) => n.disabled), true);
        assert.equal(f.st.puts.length, 0);
        fault(f);
        await f.ctx.close();
      }
      return null;
    },
  ],
  [
    "saved panel error offers reload, mismatched duration rejected",
    async () => {
      const f = await open({ saved: () => ({ body: googleSaved({ durationMinutes: 30 }) }) });
      await f.page.waitForSelector(T("button-reload-saved-google-panel"));
      assert.equal(await exists(f, "button-remove-google-panel"), false);
      fault(f);
      return f;
    },
  ],
  [
    "account switch refetches saved panel under new scope",
    async () => {
      const f = await open({ saved: () => ({ body: googleSaved() }) });
      await f.page.waitForSelector(T("text-saved-google-panel-s1"));
      const before = f.st.savedGets;
      f.st.user = { ...staff, id: "u2" };
      await f.actor({ ...staff, id: "u2" });
      await f.page.waitForFunction(
        () =>
          document.querySelector('[data-testid="fixture-actor"]').textContent === "u2:recruiter",
      );
      await sleep(400);
      assert.ok(f.st.savedGets > before);
      assert.equal(await exists(f, "text-saved-google-panel-s1"), true);
      fault(f);
      return f;
    },
  ],
  [
    "phone viewport: saved panel and review have no overflow",
    async () => {
      const f = await open({ width: 360, saved: () => ({ body: googleSaved() }) });
      await f.page.waitForSelector(T("button-remove-google-panel"));
      await click(f, "button-remove-google-panel");
      await f.page.waitForSelector(T("google-remove-confirm"));
      assert.equal(await overflow(f), true);
      await click(f, "button-cancel-remove-google-panel");
      await f.page.waitForSelector(T("checkbox-google-panel-m1")).catch(() => {});
      await click(f, "button-open-google-panel");
      await f.page.waitForSelector(T("checkbox-google-panel-m1"));
      await click(f, "button-search-google-panel");
      await f.page.waitForSelector(T("google-panel-results"));
      await click(f, `button-use-google-time-${slotAt(60).start}`);
      await f.page.waitForSelector(T("google-panel-review"));
      assert.equal(await overflow(f), true);
      fault(f);
      return f;
    },
  ],
  [
    "outlook finder: google saved panel is read-only, no Outlook write",
    async () => {
      const f = await open({ outlook: true, saved: () => ({ body: googleSaved() }) });
      await f.page.waitForSelector(T("text-google-panel-readonly-s1"));
      assert.equal(await exists(f, "button-remove-saved-panel"), false);
      await click(f, "button-open-panel-times");
      await f.page.waitForSelector(T("checkbox-panel-m1"));
      assert.equal(await exists(f, "button-save-panel-current-time"), false);
      assert.deepEqual(f.st.olWrites, []);
      assert.ok(f.st.olGets >= 1);
      fault(f);
      return f;
    },
  ],
  [
    "in-flight save survives directory refresh and still invalidates",
    async () => {
      let n = 0;
      const f = await open({
        mem: () => ({
          body: ++n === 1 ? members() : members({ members: [{ id: "m1", name: "Ana" }] }),
        }),
      });
      await search(f, ["m1"]);
      await f.page.waitForSelector(T("google-panel-results"));
      await click(f, `button-use-google-time-${slotAt(60).start}`);
      await f.page.waitForFunction(
        () => !document.querySelector('[data-testid="button-save-google-panel"]').disabled,
      );
      let rel;
      f.st.putGate = new Promise((r) => (rel = r));
      await click(f, "button-save-google-panel");
      await f.page.waitForFunction(() => document.body.textContent.includes("Saving"));
      const mem = f.st.memGets;
      await f.page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await f.page.waitForFunction((m) => true, {}, mem);
      await sleep(400);
      assert.ok(f.st.memGets > mem);
      rel();
      await f.page.waitForSelector(T("text-google-save-result"));
      assert.equal(f.st.puts.length, 1);
      assert.equal(await exists(f, "text-google-save-error"), false);
      fault(f);
      return f;
    },
  ],
  [
    "existing Outlook consent untouched (no Outlook endpoints called)",
    async () => {
      const f = await open();
      await f.page.waitForSelector(T("button-google-panel-enable"));
      assert.deepEqual(f.st.other, []);
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
console.log(`Google panel browser checks: ${passed}/${selected.length} passed; ${failed} failed`);
process.exitCode = failed ? 1 : 0;
