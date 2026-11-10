import assert from "node:assert/strict";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

export const job = "offer-ui-fixture-job";
export const workflow = "offer-ui-fixture-workflow";
export const tid = (name, id = workflow) => `[data-testid="${name}-${id}"]`;
export const clone = (value) => structuredClone(value);
export const terms = {
  employerName: "Synthetic Employer",
  roleTitle: "Synthetic Engineer",
  amount: 120000,
  currency: "USD",
  frequency: "annual",
  location: "Remote",
  startDate: "2030-01-01",
  expiresAt: "2030-02-01T12:00:00.000Z",
  letter: "Synthetic manual offer letter. No actual employment is offered.",
};
export function state(status = "draft", overrides = {}) {
  return {
    offer: {
      id: "synthetic-offer",
      version: 1,
      status,
      terms: clone(terms),
      recipientEmail: "candidate@example.invalid",
      testOnly: true,
      createdBy: "synthetic-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    history: [],
    canEdit: true,
    canApprove: true,
    canSend: true,
    canWithdraw: true,
    canReconcile: false,
    eligible: true,
    reason: null,
    workflowRevision: 10,
    ...overrides,
  };
}

export async function startHarness() {
  const root = path.resolve(import.meta.dirname, "../..");
  const cacheDir = mkdtempSync(path.join(tmpdir(), "lexy-offer-browser-"));
  console.log("Offer harness: creating fixture-only Vite server");
  const server = await createServer({
    configFile: false,
    root,
    base: "/",
    cacheDir,
    optimizeDeps: {
      entries: [
        path.join(root, "src/test-fixtures/controlled-offer-browser.tsx"),
        path.join(root, "src/test-fixtures/human-decision-browser.tsx"),
      ],
    },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
    server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
    logLevel: "error",
  });
  let browser;
  try {
    console.log("Offer harness: listening on loopback");
    await server.listen();
    const address = server.httpServer.address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    console.log("Offer harness: preparing fixture HTML");
    const html = await server.transformIndexHtml(
      "/__offer-regression",
      `<!doctype html><html><body><div id="root"></div>
      <script type="module">
        import { mountOfferFixture } from "/src/test-fixtures/controlled-offer-browser.tsx";
        window.mountFixture = mountOfferFixture;
      </script></body></html>`,
    );
    const decisionHtml = await server.transformIndexHtml(
      "/__decision-regression",
      `<!doctype html><html><body><div id="root"></div>
      <script type="module">
        import { mountHumanDecisionFixture } from "/src/test-fixtures/human-decision-browser.tsx";
        window.mountFixture = mountHumanDecisionFixture;
      </script></body></html>`,
    );
    let executablePath = puppeteer.executablePath();
    if (!existsSync(executablePath)) {
      try {
        executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
      } catch {
        throw new Error(
          "Chrome is required: install Puppeteer's Chrome or provide Chromium on PATH.",
        );
      }
    }
    console.log("Offer harness: launching Chromium");
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-background-networking"],
    });
    console.log("Offer harness: ready");
    return {
      async close() {
        await browser.close();
        await server.close();
        rmSync(cacheDir, { recursive: true, force: true });
      },
      async open(initial, allowedActions = [], width = 1100, mode = "offer") {
        const context = await browser.createBrowserContext();
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        page.setDefaultNavigationTimeout(10_000);
        await page.setViewport({ width, height: 900 });
        const snapshots = new Map([
          [`${job}/${workflow}`, clone(mode === "decision" ? initial.offerState : initial)],
        ]);
        const posts = [];
        let saveFailure = null;
        const violations = [];
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setRequestInterception(true);
        page.on("request", async (request) => {
          if (request.isInterceptResolutionHandled()) return;
          const url = new URL(request.url());
          const reply = (body, status = 200) =>
            request.respond({
              status,
              contentType: "application/json",
              body: JSON.stringify(body),
            });
          try {
            if (
              url.origin === origin &&
              url.pathname ===
                (mode === "decision" ? "/__decision-regression" : "/__offer-regression")
            )
              return await request.respond({
                status: 200,
                contentType: "text/html",
                body: mode === "decision" ? decisionHtml : html,
              });
            // Browser interception is installed before navigation. No API requests
            // are forwarded, including reads, auth, providers and email delivery.
            if (url.pathname.startsWith("/api/")) {
              const match = url.pathname.match(
                /^\/api\/jobs\/(offer-ui-fixture-[\w-]+)\/candidate-workflows\/(offer-ui-fixture-[\w-]+)\/offer$/,
              );
              const key = match && `${match[1]}/${match[2]}`;
              const current = snapshots.get(key);
              if (url.origin !== origin || !current)
                throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
              if (request.method() === "GET") return await reply(current);
              assert.equal(request.method(), "POST");
              const body = JSON.parse(request.postData());
              assert.ok(allowedActions.includes(body.action), `Unexpected action ${body.action}`);
              assert.equal(body.expectedRevision, current.workflowRevision);
              assert.ok(body.idempotencyKey?.length);
              posts.push({ key, body });
              if (body.action === "save_draft" && saveFailure) {
                const failure = saveFailure;
                saveFailure = null;
                return await reply({ error: "Synthetic save conflict. Please retry." }, failure);
              }
              const saved = clone(current);
              saved.workflowRevision++;
              if (body.action === "save_draft") {
                saved.history.push(clone(current.offer));
                saved.offer = {
                  id: `synthetic-saved-${posts.length}`,
                  version: current.offer.version + 1,
                  status: "draft",
                  terms: body.terms,
                  recipientEmail: current.offer.recipientEmail,
                  testOnly: true,
                  createdBy: "synthetic-owner",
                  createdAt: "2026-01-02T00:00:00.000Z",
                };
              } else if (body.action === "submit_review") {
                saved.offer.status = "review_required";
              } else if (body.action === "approve") {
                saved.offer.status = "approved";
                saved.offer.approvedBy = "synthetic-approver";
              } else if (body.action === "send") {
                saved.offer.status = "sent";
              } else if (body.action === "reconcile_delivery") {
                assert.equal(body.deliveryAttemptId, current.offer.deliveryAttemptId);
                assert.ok(current.canReconcile);
                const settling = body.deliveryResolution === "confirmed_not_sent";
                if (settling) {
                  assert.ok(body.reason?.trim().length >= 10);
                  assert.ok(body.evidenceReference?.trim().length >= 10);
                  assert.equal(body.acknowledgeNoDelivery, true);
                  saved.offer.status = "draft";
                  delete saved.offer.approvedBy;
                  delete saved.offer.approvedAt;
                } else {
                  assert.equal(body.deliveryResolution, "check_provider");
                }
                saved.offer.deliveryReconciliation = {
                  outcome: settling ? "confirmed_not_sent" : "uncertain",
                  checkedAt: "2026-01-02T00:00:00Z",
                  checkedBy: "synthetic-owner",
                  reason: settling
                    ? body.reason
                    : "Synthetic original attempt has no acceptance receipt.",
                  ...(settling ? { evidenceReference: body.evidenceReference } : {}),
                };
              }
              // POST response and subsequent GET must agree; stale replay data
              // otherwise looks like an application cache regression.
              snapshots.set(key, saved);
              return await reply(saved);
            }
            // CSS's optional web font is replaced locally, not fetched.
            if (url.hostname === "fonts.googleapis.com")
              return await request.respond({ status: 200, contentType: "text/css", body: "" });
            if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol))
              throw new Error(`External request blocked: ${url.origin}`);
            assert.ok(
              ["GET", "HEAD"].includes(request.method()),
              `Non-API mutation blocked: ${request.method()}`,
            );
            await request.continue();
          } catch (error) {
            violations.push(error.message);
            await request.abort("blockedbyclient");
          }
        });
        try {
          await page.goto(
            `${origin}/${mode === "decision" ? "__decision-regression" : "__offer-regression"}`,
            { waitUntil: "domcontentloaded" },
          );
          await page.waitForFunction(() => typeof window.mountFixture === "function");
          await page.evaluate((initial) => {
            window.fixture = window.mountFixture(document.getElementById("root"), initial);
          }, initial);
          await page.waitForSelector(
            tid(mode === "decision" ? "human-decision" : "controlled-offer"),
          );
        } catch (error) {
          await context.close();
          throw new Error(
            `Fixture startup failed: ${error.message}; errors=${JSON.stringify(errors)}; blocked=${JSON.stringify(violations)}`,
            { cause: error },
          );
        }
        return {
          page,
          posts,
          failNextSave(status = 409) {
            saveFailure = status;
          },
          async snapshot(next, nextJob = job, nextWorkflow = workflow) {
            snapshots.set(
              `${nextJob}/${nextWorkflow}`,
              clone(mode === "decision" ? next.offerState : next),
            );
            await page.evaluate(
              ({ next, nextJob, nextWorkflow, job, workflow }) => {
                if (nextJob === job && nextWorkflow === workflow) window.fixture.snapshot(next);
                else window.fixture.switchContext(next, nextJob, nextWorkflow);
              },
              { next, nextJob, nextWorkflow, job, workflow },
            );
          },
          async check(expectedViolations = []) {
            assert.deepEqual(
              violations,
              expectedViolations,
              "All unexpected requests must fail the suite",
            );
            assert.deepEqual(errors, [], "Browser runtime errors must fail the suite");
          },
          async close() {
            await context.close();
          },
        };
      },
    };
  } catch (error) {
    if (browser) await browser.close();
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
    throw error;
  }
}

export async function fill(page, selector, value) {
  await page.waitForSelector(selector);
  await page.$eval(
    selector,
    (element, value) => {
      const prototype =
        element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
  await page.waitForFunction(
    (selector, value) => document.querySelector(selector)?.value === value,
    {},
    selector,
    value,
  );
}
export async function absent(page, selector) {
  assert.equal(await page.$(selector), null, `Expected no ${selector}`);
}
export async function disabled(page, selector) {
  assert.equal(await page.$eval(selector, (el) => el.disabled), true);
}
export async function value(page, selector, expected) {
  await page.waitForFunction(
    (selector, expected) => document.querySelector(selector)?.value === expected,
    {},
    selector,
    expected,
  );
}
