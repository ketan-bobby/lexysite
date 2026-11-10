import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";

export const tid = (id) => `[data-testid="${id}"]`;
export const actor = {
  id: "holds-browser-admin",
  name: "Synthetic admin",
  email: "admin@example.invalid",
  role: "platform_admin",
  tenantId: "fixture",
  region: "us",
  status: "active",
};
export const hold = (suffix = "one") => ({
  operationId: `candidate-cadence:self_report:fixture-${suffix}`,
  candidateId: `private-candidate-${suffix}`,
  tenantId: "fixture",
  kind: "follow_up",
  reservedAt: "2026-11-01T10:00:00Z",
  version: "a".repeat(64),
  lastReview: null,
  lastReviewedAt: null,
});
export const pageOf = (rows, nextCursor = null) => ({
  data: rows,
  hasMore: !!nextCursor,
  nextCursor,
});

export async function startHarness({
  fixtureModule = "mail-holds-browser",
  readyTestId = `radio-hold-${hold().operationId}`,
} = {}) {
  assert.match(fixtureModule, /^[a-z-]+$/);
  const root = path.resolve(import.meta.dirname, "../..");
  const cacheDir = mkdtempSync(path.join(tmpdir(), "mail-holds-browser-"));
  const server = await createServer({
    configFile: false,
    root,
    base: "/",
    cacheDir,
    plugins: [react(), tailwindcss()],
    optimizeDeps: { entries: [path.join(root, `src/test-fixtures/${fixtureModule}.tsx`)] },
    resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
    logLevel: "error",
  });
  let browser;
  try {
    // Defense in depth: this isolated server has NO application API/proxy.
    server.middlewares.use("/api", (_req, res) => {
      res.statusCode = 403;
      res.end("No backend in fixture");
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const html = await server.transformIndexHtml(
      "/platform/mail-holds",
      `<!doctype html><html class="dark"><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>*,*::before,*::after{animation:none!important;transition:none!important}</style>
      </head><body><div id="root"></div><script type="module">
      import * as entry from '/src/test-fixtures/${fixtureModule}.tsx';
      window.fixture=(entry.mountSecurityFixture || entry.mountMailHoldsFixture)(document.getElementById('root'));
      </script></body></html>`,
    );
    let executablePath = puppeteer.executablePath();
    if (!existsSync(executablePath))
      executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      pipe: true,
      args: ["--no-sandbox", "--disable-background-networking"],
    });
    return {
      async open() {
        const context = await browser.createBrowserContext(),
          page = await context.newPage();
        const state = {
          actor: structuredClone(actor),
          first: pageOf([hold()]),
          second: pageOf([hold("two")]),
          readStatus: 200,
          reviewStatus: 200,
          posts: [],
          reads: [],
          violations: [],
          errors: [],
          gate: null,
          logoutStatus: 200,
          logoutAllStatus: 200,
          logoutAllDelayMs: 0,
          logoutAllRequests: [],
          logoutHeaders: [],
        };
        page.setDefaultTimeout(12_000);
        await page.setViewport({ width: 1280, height: 900 });
        await page.setBypassServiceWorker(true);
        await page.evaluateOnNewDocument(
          (user) => localStorage.setItem("user", JSON.stringify(user)),
          actor,
        );
        page.on("pageerror", (e) => state.errors.push(e.message));
        await page.setRequestInterception(true);
        page.on("request", async (req) => {
          const url = new URL(req.url());
          const reply = (body, status = 200) =>
            req.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
          try {
            if (url.protocol === "data:" || url.protocol === "blob:") return await req.continue();
            assert.equal(url.origin, origin, "External request blocked");
            if (url.pathname === "/platform/mail-holds")
              return await req.respond({
                status: 200,
                contentType: "text/html",
                headers: {
                  "Content-Security-Policy":
                    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; frame-src 'none'; form-action 'none'",
                },
                body: html,
              });
            if (url.pathname === "/api/auth/me") return await reply(state.actor);
            if (url.pathname === "/api/auth/logout-all" && req.method() === "POST") {
              const data = JSON.parse(req.postData() || "{}");
              state.logoutAllRequests.push({
                keys: Object.keys(data).sort(),
                acknowledge: data.acknowledge,
                passwordWasExpected: data.password === "Synthetic1!confirmation",
                authorization: req.headers().authorization ?? null,
              });
              if (state.logoutAllDelayMs)
                await new Promise((resolve) => setTimeout(resolve, state.logoutAllDelayMs));
              const errors = {
                403: "The password could not be confirmed.",
                409: "Password confirmation is unavailable for this organization sign-in account.",
                503: "All-device sign-out could not be confirmed. Retry or sign in again.",
              };
              return await reply(
                state.logoutAllStatus === 200
                  ? { success: true, message: "Signed out all devices." }
                  : { error: errors[state.logoutAllStatus] || "Sign-out failed" },
                state.logoutAllStatus,
              );
            }
            if (url.pathname === "/api/auth/logout" && req.method() === "POST") {
              state.logoutHeaders.push(req.headers().authorization ?? null);
              return await reply(
                state.logoutStatus === 200
                  ? { success: true }
                  : { error: "Synthetic logout failure" },
                state.logoutStatus,
              );
            }
            if (url.pathname === "/login")
              return await req.respond({
                status: 200,
                contentType: "text/html",
                body: "<h1>Signed out fixture</h1>",
              });
            if (url.pathname === "/api/platform/mail-holds" && req.method() === "GET") {
              state.reads.push(url.searchParams.get("cursor"));
              const status = state.readStatus,
                body = structuredClone(url.searchParams.has("cursor") ? state.second : state.first);
              const gate = state.gate;
              state.gate = null;
              if (gate) await gate;
              return await reply(
                status === 200 ? body : { error: "Synthetic read denial" },
                status,
              );
            }
            if (url.pathname === "/api/platform/mail-holds/review" && req.method() === "POST") {
              const body = JSON.parse(req.postData());
              state.posts.push(body);
              assert.deepEqual(
                Object.keys(body).sort(),
                [
                  "acknowledgeNoResend",
                  "disposition",
                  "evidenceReference",
                  "operationId",
                  "version",
                ].sort(),
              );
              return await reply(
                state.reviewStatus === 200
                  ? {
                      reviewId: "synthetic-review",
                      disposition: body.disposition,
                      holdRetained: true,
                    }
                  : { error: "Synthetic review failure" },
                state.reviewStatus,
              );
            }
            if (url.pathname.startsWith("/api/")) {
              assert.equal(req.method(), "GET", "Unexpected API mutation blocked");
              if (url.pathname === "/api/jobs") return await reply([]);
              if (url.pathname === "/api/admin/impersonation/active")
                return await reply({ active: false });
              // Read-only shell chrome is outside this page-contract suite.
              return await reply({});
            }
            assert.equal(req.method(), "GET", "Unexpected non-API mutation blocked");
            return await req.continue();
          } catch (error) {
            state.violations.push(error.message);
            await req.abort().catch(() => {});
          }
        });
        await page.goto(`${origin}/platform/mail-holds`, { waitUntil: "domcontentloaded" });
        try {
          await page.waitForSelector(tid(readyTestId));
        } catch (error) {
          const diagnostics = {
            errors: state.errors,
            violations: state.violations,
            body: await page.evaluate(() => document.body.innerText).catch(() => ""),
            reads: state.reads,
          };
          await context.close();
          throw new Error(`Fixture failed to mount: ${JSON.stringify(diagnostics)}`, {
            cause: error,
          });
        }
        return {
          page,
          state,
          refresh: () =>
            page.evaluate(() => {
              void window.fixture.refresh();
            }),
          async select(row = hold()) {
            await page.click(tid(`radio-hold-${row.operationId}`));
            await page.waitForSelector(tid("input-evidence-reference"));
          },
          async fill() {
            await page.click(tid("radio-closed-no-resend"));
            await page.type(tid("input-evidence-reference"), "CASE-123");
            await page.click(tid("checkbox-acknowledge"));
          },
          async check() {
            assert.deepEqual(state.violations, []);
            assert.deepEqual(state.errors, []);
          },
          async close() {
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
    await browser?.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    throw error;
  }
}
