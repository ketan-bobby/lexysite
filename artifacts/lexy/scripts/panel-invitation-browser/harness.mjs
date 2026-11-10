import assert from "node:assert/strict";
import { createOperationApi } from "./google-operation-api.mjs";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";
import { createInviteApi } from "./google-invite-api.mjs";
import { createStaffApi, statuses } from "./google-staff-api.mjs";

export const clone = (value) => structuredClone(value);
export const tid = (value) => `[data-testid="${value}"]`;
export const schedule = {
  id: "panel-ui-fixture-schedule",
  status: "confirmed",
  scheduledAt: "2035-11-01T10:00:00.000Z",
  durationMinutes: 60,
  version: `v1_${"a".repeat(64)}`,
};
export const actor = {
  id: "panel-ui-fixture-staff",
  tenantId: "panel-ui-fixture-tenant",
  email: "staff@example.invalid",
  name: "Synthetic staff",
  role: "platform_admin",
  createdAt: "2026-01-01T00:00:00.000Z",
};
export const initialStatus = {
  scheduleId: schedule.id,
  version: schedule.version,
  scheduledAt: schedule.scheduledAt,
  durationMinutes: schedule.durationMinutes,
  recipientEmail: "candidate@example.invalid",
  organizerEmail: "organizer@example.invalid",
  panelRecipients: [
    { userId: "panel-one", name: "Panel One", email: "one@example.invalid" },
    { userId: "panel-two", name: "Panel Two", email: "two@example.invalid" },
  ],
  approvalToken: "b".repeat(64),
  status: "not_sent",
  acceptedAt: null,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

export async function startHarness({
  googleOnly = false,
  googleStaff = false,
  googleInvite = false,
  googleOperation = false,
} = {}) {
  const root = path.resolve(import.meta.dirname, "../..");
  const cacheDir = mkdtempSync(path.join(tmpdir(), "lexy-panel-invitation-browser-"));
  const server = await createServer({
    configFile: false,
    root,
    base: "/",
    cacheDir,
    plugins: [react(), tailwindcss()],
    optimizeDeps: { entries: [path.join(root, "src/test-fixtures/panel-invitation-browser.tsx")] },
    resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
    logLevel: "error",
  });
  let browser;
  try {
    // No API proxy exists, even if browser interception were to regress.
    server.middlewares.use("/api", (_req, res) => {
      res.statusCode = 403;
      res.end("No backend exists in this fixture server.");
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const entry = "/__panel-invitation-regression";
    const html = await server.transformIndexHtml(
      entry,
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}</style>
      </head><body><div id="root"></div><script type="module">
      import { mountPanelInvitationFixture } from "/src/test-fixtures/panel-invitation-browser.tsx";
      window.mountFixture = (host, schedule) => mountPanelInvitationFixture(host, schedule, ${googleOnly}, ${googleStaff}, ${googleInvite}, ${googleOperation});
      </script></body></html>`,
    );
    let executablePath = puppeteer.executablePath();
    if (!existsSync(executablePath))
      executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      pipe: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-background-networking"],
    });
    return {
      async open({
        allowSend = false,
        outcome = "accepted",
        width = 1100,
        staff = "connected",
        search = "",
        role,
      } = {}) {
        const staffApi = createStaffApi(statuses[staff]);
        const inviteApi = createInviteApi(schedule);
        const opApi = createOperationApi(schedule);
        const navigations = [];
        const context = await browser.createBrowserContext();
        let current = clone(
          googleOnly
            ? {
                status: "verified",
                checkedAt: "2035-11-01T10:00:00Z",
                calendarReadVerified: true,
                availabilityReadVerified: true,
                meetSupported: true,
                accountBinding: "not_configured",
                invitationsEnabled: false,
              }
            : initialStatus,
        );
        let currentActor = clone(role ? { ...actor, role } : actor);
        let readFailure = null;
        let nextReadGate = null;
        let sendGate = null;
        const gates = [];
        const posts = [],
          reads = [],
          violations = [],
          errors = [];
        const hold = () => {
          const gate = deferred();
          gates.push(gate);
          return gate;
        };
        // Install our guarded page factory on this fresh context before opening
        // any pages. Scenarios can open another page only through this factory.
        const createPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await createPage();
          page.setDefaultTimeout(10_000);
          await page.setViewport({ width, height: 850 });
          await page.setBypassServiceWorker(true);
          page.on("pageerror", (error) => errors.push(error.message));
          await page.setRequestInterception(true);
          page.on("request", async (request) => {
            if (request.isInterceptResolutionHandled()) return;
            const url = new URL(request.url());
            const reply = (value, status = 200) =>
              request.respond({
                status,
                contentType: "application/json",
                body: JSON.stringify(value),
              });
            try {
              // Explicit OAuth navigation is recorded and replaced by an inert page:
              // no real Google authorization or network ever happens.
              if (
                googleStaff &&
                url.hostname === "accounts.google.com" &&
                url.pathname === "/favicon.ico"
              )
                return await request.respond({ status: 204 });
              if (
                googleStaff &&
                request.isNavigationRequest() &&
                url.hostname === "accounts.google.com"
              ) {
                navigations.push(url.href);
                return await request.respond({
                  status: 200,
                  contentType: "text/html",
                  body: "<p>oauth intercepted</p>",
                });
              }
              // Inline data: URLs (e.g. native datetime picker icon) never leave the browser.
              if (url.protocol === "data:") return await request.continue();
              assert.equal(url.origin, origin, "External request blocked");
              if (url.pathname === entry && request.method() === "GET")
                return await request.respond({
                  status: 200,
                  contentType: "text/html",
                  // No workers, popups, frames or remote connections. The real
                  // component needs only same-origin modules and inline styles.
                  headers: {
                    "Content-Security-Policy":
                      "default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; worker-src 'none'; frame-src 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin",
                  },
                  body: html,
                });
              if (url.pathname === "/api/auth/me" && request.method() === "GET")
                return await reply(currentActor);
              if (url.pathname.startsWith("/api/")) {
                if (googleOperation) return await opApi.handle(url, request, reply);
                if (googleInvite) return await inviteApi.handle(url, request, reply);
                if (googleStaff) {
                  assert.equal(allowSend, true, "Unapproved staff Google call blocked");
                  return await staffApi.handle(url, request, reply);
                }
                if (googleOnly) {
                  assert.equal(
                    url.pathname,
                    "/api/google-calendar/pilot-check",
                    "Unexpected API request",
                  );
                  assert.equal(request.method(), "POST", "Unexpected API method");
                  assert.equal(allowSend, true, "Unapproved read check blocked");
                  const body = JSON.parse(request.postData());
                  assert.deepEqual(body, { confirmReadOnlyCheck: true });
                  posts.push(body);
                  const snapshot = clone(current),
                    failure = readFailure,
                    gate = sendGate;
                  readFailure = null;
                  sendGate = null;
                  if (gate) await gate.promise;
                  return await reply(
                    failure ? { error: "fixture read unavailable" } : snapshot,
                    failure ?? 200,
                  );
                }
                assert.equal(
                  url.pathname,
                  `/api/outlook-calendar/schedules/${current.scheduleId}/panel-invitation`,
                  "Unexpected API request",
                );
                if (request.method() === "GET") {
                  reads.push(current.scheduleId);
                  const snapshot = clone(current);
                  const failure = readFailure;
                  readFailure = null;
                  const gate = nextReadGate;
                  nextReadGate = null;
                  if (gate) {
                    gate.started.resolve();
                    await gate.promise;
                  }
                  return await reply(
                    failure ? { error: "Synthetic status unavailable." } : snapshot,
                    failure ?? 200,
                  );
                }
                assert.equal(request.method(), "POST");
                assert.ok(allowSend, "Unapproved send blocked");
                const body = JSON.parse(request.postData());
                assert.deepEqual(
                  body,
                  {
                    confirm: true,
                    expectedVersion: current.version,
                    expectedApprovalToken: current.approvalToken,
                  },
                  "Send must use exactly the newly reviewed approval",
                );
                posts.push(clone(body));
                assert.equal(posts.length, 1, "Duplicate send blocked");
                current = {
                  ...current,
                  status: "accepted",
                  acceptedAt: "2026-10-24T06:00:00.000Z",
                };
                if (sendGate) await sendGate.promise;
                if (outcome === "ambiguous")
                  return await reply({ error: "Synthetic lost receipt." }, 503);
                if (outcome === "token_mismatch")
                  return await reply({ ...current, approvalToken: "e".repeat(64) });
                if (outcome === "roster_mismatch")
                  return await reply({ ...current, panelRecipients: [] });
                if (outcome === "not_accepted") {
                  current = { ...current, status: "needs_review", acceptedAt: null };
                }
                return await reply(current);
              }
              assert.ok(["GET", "HEAD"].includes(request.method()), "Non-API write blocked");
              await request.continue();
            } catch (error) {
              violations.push(error.message.split("\n")[0]);
              if (process.env.HARNESS_DEBUG) console.error("BLOCKED", request.url());
              if (!request.isInterceptResolutionHandled())
                await request.abort("blockedbyclient").catch(() => {});
            }
          });
          return page;
        };
        const load = async (page) => {
          await page.goto(`${origin}${entry}${search}`);
          await page.waitForFunction(() => typeof window.mountFixture === "function");
          await page.evaluate((s) => {
            window.fixture = window.mountFixture(document.getElementById("root"), s);
          }, schedule);
          await page.waitForFunction(
            (id) => document.querySelector('[data-testid="fixture-actor"]')?.textContent === id,
            {},
            currentActor.id,
          );
        };
        const page = await context.newPage();
        try {
          await load(page);
        } catch (error) {
          await context.close();
          throw error;
        }
        return {
          page,
          staff: staffApi,
          invite: inviteApi,
          op: opApi,
          navigations,
          posts,
          reads,
          violations,
          async diagnostics() {
            return {
              posts: posts.length,
              reads: reads.length,
              violations,
              errors,
              dialogs: await page.$$eval('[role="dialog"]', (items) =>
                items.map((el) => ({
                  text: el.textContent,
                  left: el.getBoundingClientRect().left,
                  right: el.getBoundingClientRect().right,
                  viewport: innerWidth,
                })),
              ),
            };
          },
          async extraPage() {
            const extra = await context.newPage();
            await load(extra);
            return extra;
          },
          async reload() {
            await load(page);
          },
          snapshot(next) {
            current = clone(next);
          },
          failNextRead(status) {
            readFailure = status;
          },
          holdNextRead() {
            const gate = hold();
            gate.started = deferred();
            nextReadGate = gate;
            return { started: gate.started.promise, release: gate.resolve };
          },
          holdSend() {
            const gate = hold();
            sendGate = gate;
            return gate.resolve;
          },
          async switchActor(next) {
            currentActor = clone(next);
            await page.evaluate((user) => window.fixture.switchActor(user), next);
          },
          async check(expectedViolations = []) {
            assert.deepEqual(violations, expectedViolations, "Unexpected traffic fails the suite");
            assert.deepEqual(errors, [], "Runtime errors fail the suite");
          },
          async close() {
            for (const gate of gates) {
              gate.started?.resolve();
              gate.resolve();
            }
            await context.close();
          },
        };
      },
      async close() {
        await browser.close();
        await server.close();
        rmSync(cacheDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (browser) await browser.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
