import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";

// Standalone, synthetic-only browser check for the Greenhouse local financial workspace.
// The real GreenhouseOfferWorkspace renders in Chromium against a loopback Vite fixture.
// Every /api/ call is answered by an in-script synthetic state machine. No login, no
// database, no providers, no candidates. All other external traffic is aborted.

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(ROOT, "../..", "generated-artifacts", "greenhouse-offer-browser");
const JOB = "synthetic-job";
const WF = "synthetic-workflow";
const API_PATH = `/api/jobs/${JOB}/candidate-workflows/${WF}/greenhouse-offer`;
const STATE_PATH = `/api/jobs/${JOB}/workflow-state`;
const PAGE_PATH = "/__greenhouse-offer-regression";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const sel = (name) => `[data-testid="${name}-${WF}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => structuredClone(v);
// Affirmative delivery claims only; "not sent to the candidate" is allowed.
const DELIVERY_CLAIM =
  /(?<!not )(?<!no )(sent|delivered) to (the )?candidate|offer (has been )?(sent|delivered)/i;

// Unique, schema-valid revisions (64 lowercase hex). Each generated state gets a new one.
let revCounter = 0;
const revisionLog = [];
function newRev() {
  const rev = (++revCounter).toString(16).padStart(64, "0");
  revisionLog.push(rev);
  return rev;
}

function baseState() {
  return {
    workflowRevision: 1,
    localRevision: "a".repeat(64),
    proposal: null,
    people: [
      { id: "synthetic-owner-id", name: "Synthetic Owner" },
      { id: "synthetic-approver-id", name: "Synthetic Approver" },
    ],
    canEdit: true,
    canApprove: false,
    canSubmit: false,
    blockers: ["Configuration not verified"],
    controlRevision: null,
    attempt: null,
    executionMode: "unavailable",
    history: [],
  };
}

// Synthetic server-side reducer. Approve never advances to submission; submit is separate.
function reduce(cur, body) {
  const next = clone(cur);
  next.workflowRevision = cur.workflowRevision + 1;
  if (body.action === "save") {
    next.proposal = clone(body.proposal);
    next.localRevision = newRev();
  } else if (body.action === "approve") {
    next.attempt = { ...cur.attempt, state: "approved", revision: newRev() };
    next.canApprove = false;
    next.canSubmit = true;
  } else if (body.action === "submit") {
    next.attempt = { ...cur.attempt, state: "verified_submission", revision: newRev() };
    next.canSubmit = false;
  } else if (body.action === "recover") {
    next.attempt = { ...cur.attempt, revision: newRev() };
  }
  return next;
}

function validatePost(cur, body) {
  const problems = [];
  const keys = Object.keys(body).sort();
  if (body.action === "save") {
    const want = ["action", "confirm", "expectedLocalRevision", "idempotencyKey", "proposal"];
    if (JSON.stringify(keys) !== JSON.stringify(want)) problems.push(`save keys ${keys.join(",")}`);
  } else {
    if (body.proposal !== undefined) problems.push(`${body.action} must not carry proposal`);
    if (body.expectedControlRevision !== cur.controlRevision)
      problems.push(
        `${body.action} controlRevision ${String(body.expectedControlRevision).slice(0, 8)} != server`,
      );
    if (body.attemptId !== cur.attempt?.id)
      problems.push(`${body.action} attemptId ${body.attemptId} != ${cur.attempt?.id}`);
  }
  if (!["save", "approve", "submit", "recover"].includes(body.action))
    problems.push(`action ${body.action}`);
  if (body.confirm !== true) problems.push("confirm is not true");
  if (!HEX64.test(body.expectedLocalRevision)) problems.push("expectedLocalRevision not 64-hex");
  if (body.expectedLocalRevision !== cur.localRevision)
    problems.push(
      `stale expectedLocalRevision ${String(body.expectedLocalRevision).slice(0, 8)} != server ${cur.localRevision.slice(0, 8)}`,
    );
  if (!UUID.test(body.idempotencyKey ?? "")) problems.push("idempotencyKey is not a UUID");
  return problems;
}

async function main() {
  const cacheDir = mkdtempSync(path.join(tmpdir(), "lexy-greenhouse-browser-"));
  mkdirSync(OUT, { recursive: true });
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`PASS  ${name}`);
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
      console.log(`FAIL  ${name}\n      ${error.message}`);
    }
  };

  let vite;
  let browser;
  let context;
  try {
    console.log("Greenhouse workspace check: starting loopback Vite fixture");
    vite = await createServer({
      configFile: false,
      root: ROOT,
      base: "/",
      cacheDir,
      optimizeDeps: {
        entries: [path.join(ROOT, "src/test-fixtures/greenhouse-offer-browser.tsx")],
      },
      plugins: [react(), tailwindcss()],
      resolve: { alias: { "@": path.join(ROOT, "src") }, dedupe: ["react", "react-dom"] },
      server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
      logLevel: "error",
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    const html = await vite.transformIndexHtml(
      PAGE_PATH,
      `<!doctype html><html><body><div id="root"></div>
      <script type="module">
        import { mountGreenhouseOfferFixture } from "/src/test-fixtures/greenhouse-offer-browser.tsx";
        window.mountFixture = mountGreenhouseOfferFixture;
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
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-background-networking"],
    });
    context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.setDefaultNavigationTimeout(10000);
    await page.setViewport({ width: 1100, height: 900 });

    // Synthetic API state. `current` is what the GET returns and what POSTs act on.
    const api = {
      current: baseState(),
      posts: [],
      violations: [],
      getStatus: null,
      stateRefreshes: 0,
      externalBlocked: [],
    };
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      if (request.isInterceptResolutionHandled()) return;
      const url = new URL(request.url());
      const reply = (status, payload) =>
        request.respond({ status, contentType: "application/json", body: JSON.stringify(payload) });
      try {
        if (url.origin === origin && url.pathname === PAGE_PATH)
          return await request.respond({ status: 200, contentType: "text/html", body: html });
        if (url.origin === origin && url.pathname === API_PATH) {
          if (request.method() === "GET") {
            if (api.getStatus) {
              const status = api.getStatus;
              api.getStatus = null;
              return await reply(status, { error: "Synthetic access denied" });
            }
            return await reply(200, api.current);
          }
          assert.equal(request.method(), "POST", `unexpected ${request.method()} on workspace`);
          const body = JSON.parse(request.postData());
          const problems = validatePost(api.current, body);
          api.posts.push(body);
          if (problems.length) {
            api.violations.push(`${body.action}: ${problems.join("; ")}`);
            return await reply(409, { error: "Synthetic conflict" });
          }
          const next = reduce(api.current, body);
          api.current = next;
          return await reply(200, next);
        }
        if (url.origin === origin && url.pathname === STATE_PATH) {
          api.stateRefreshes++;
          return await request.abort("blockedbyclient");
        }
        if (url.pathname.startsWith("/api/")) {
          api.externalBlocked.push(`unexpected api ${request.method()} ${url.pathname}`);
          return await request.abort("blockedbyclient");
        }
        if (url.hostname === "fonts.googleapis.com")
          return await request.respond({ status: 200, contentType: "text/css", body: "" });
        if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) {
          api.externalBlocked.push(`external ${url.origin}`);
          return await request.abort("blockedbyclient");
        }
        if (!["GET", "HEAD"].includes(request.method())) {
          api.externalBlocked.push(`mutation ${request.method()} ${url.pathname}`);
          return await request.abort("blockedbyclient");
        }
        return await request.continue();
      } catch (error) {
        api.externalBlocked.push(`handler error: ${error.message}`);
        await request.abort("blockedbyclient").catch(() => {});
      }
    });

    // ---------- helpers ----------
    const exists = async (s) => (await page.$(s)) !== null;
    const disabled = (s) => page.$eval(s, (el) => el.disabled);
    const text = (s) =>
      page.$eval(s, (el) => el.innerText.replace(/\s+/g, " ").trim()).catch(() => "");
    const body = () => page.evaluate(() => document.body.innerText);
    const bodyContent = () => page.evaluate(() => document.body.textContent);
    async function until(fn, label, ms = 6000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await fn()) return;
        await sleep(60);
      }
      throw new Error(`Timed out waiting for: ${label}`);
    }
    const waitText = (t) => until(async () => (await body()).includes(t), `text "${t}"`);
    const waitErr = (t) =>
      until(async () => (await text(sel("gh-offer-action-error"))).includes(t), `error "${t}"`);
    async function clickWhenEnabled(s) {
      await until(async () => !(await disabled(s)), `enabled ${s}`);
      await page.click(s);
    }
    async function setField(handle, value) {
      await handle.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      if (value) await handle.type(value);
    }
    async function fieldOf(i) {
      const rows = await page.$$('[data-testid^="gh-offer-row-"]');
      assert.ok(rows[i], `row ${i} is missing`);
      return {
        name: await rows[i].$('input[aria-label="Field name"]'),
        type: await rows[i].$('select[aria-label="Field type"]'),
        value: await rows[i].$('input[aria-label="Value"]'),
        currency: await rows[i].$('input[aria-label="Currency code"]'),
      };
    }
    const opening = () => page.$(sel("gh-offer-opening"));
    const openingValue = () => page.$eval(sel("gh-offer-opening"), (e) => e.value);
    async function setState(next) {
      api.current = next;
      await page.evaluate((s) => window.fixture.update(s), next);
    }
    const nextState = (patch) => ({
      ...clone(api.current),
      workflowRevision: api.current.workflowRevision + 1,
      ...patch,
    });
    const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    async function overflow() {
      return page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        const offenders = [...document.querySelectorAll("body *")]
          .filter(
            (el) =>
              el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > vw + 0.5,
          )
          .slice(0, 5)
          .map(
            (el) =>
              `${el.tagName}${el.getAttribute("data-testid") ? "[" + el.getAttribute("data-testid") + "]" : ""}`,
          );
        return { vw, scrollWidth: document.documentElement.scrollWidth, offenders };
      });
    }
    const PROVIDER_BTNS = ["prepare", "approve", "submit"];

    // ---------- mount the real component ----------
    api.current = baseState();
    await page.goto(`${origin}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof window.mountFixture === "function");
    await page.evaluate(() => {
      window.fixture = window.mountFixture(document.getElementById("root"));
    });
    await until(() => exists(sel("gh-offer-local")), "workspace rendered");

    // ---------- Phase A: start state and local save ----------
    await check(
      "A1 start state: local draft, unavailable provider state, blockers, provider actions disabled",
      async () => {
        const t = await body();
        assert.ok(t.includes("LOCAL DRAFT"));
        assert.ok(t.includes("Connection unavailable"));
        assert.ok(t.includes("Configuration not verified"));
        assert.ok(t.includes("No employer-approved Greenhouse connection is ready"));
        assert.ok(t.includes("No attempt has been started."));
        for (const a of PROVIDER_BTNS)
          assert.equal(await disabled(sel(`gh-offer-${a}`)), true, `${a} enabled`);
        assert.equal(
          await exists(sel("gh-offer-recover")),
          false,
          "recover visible without attempt",
        );
        assert.equal(await disabled(sel("gh-offer-save")), true, "save enabled while clean");
        assert.equal(api.posts.length, 0);
        await shot("01-start");
      },
    );

    await check("A2 invalid draft without roles is refused locally (no POST)", async () => {
      await page.click(sel("gh-offer-add-field"));
      const f = await fieldOf(0);
      await setField(f.name, "base_salary");
      await f.type.select("currency");
      // Re-query: the currency input only exists after the type changes to currency.
      const f2 = await fieldOf(0);
      await setField(f2.value, "8750000");
      await setField(f2.currency, "USD");
      await clickWhenEnabled(sel("gh-offer-save"));
      await waitErr("Choose an approver and a submitter.");
      assert.equal(api.posts.length, 0, "a POST was sent for an invalid draft");
    });

    await check(
      "A3 valid save posts only action/expectedLocalRevision/idempotencyKey/confirm/proposal with integer minor units",
      async () => {
        await (await page.$(sel("gh-offer-approverId"))).select("synthetic-approver-id");
        await (await page.$(sel("gh-offer-submitterId"))).select("synthetic-owner-id");
        await setField(await opening(), "OPEN-SYN-1");
        await page.click(sel("gh-offer-add-field"));
        const r2 = await fieldOf(1);
        await setField(r2.name, "location");
        await setField(r2.value, "Remote");
        await page.click(sel("gh-offer-add-field"));
        const r3 = await fieldOf(2);
        await setField(r3.name, "bonus_points");
        await r3.type.select("number");
        await setField(r3.value, "3");
        await clickWhenEnabled(sel("gh-offer-save"));
        await until(() => api.posts.length === 1, "save POST");
        const p = api.posts[0];
        assert.deepEqual(Object.keys(p).sort(), [
          "action",
          "confirm",
          "expectedLocalRevision",
          "idempotencyKey",
          "proposal",
        ]);
        assert.equal(p.action, "save");
        assert.equal(p.confirm, true);
        assert.equal(p.expectedLocalRevision, "a".repeat(64));
        assert.match(p.idempotencyKey, UUID);
        assert.deepEqual(p.proposal, {
          openingId: "OPEN-SYN-1",
          startDate: null,
          approverId: "synthetic-approver-id",
          submitterId: "synthetic-owner-id",
          values: {
            base_salary: { amountMinor: 8750000, currency: "USD" },
            location: "Remote",
            bonus_points: 3,
          },
        });
        await waitText("Local terms saved. Nothing was sent to Greenhouse or the candidate.");
        const review = await text(`[data-testid="gh-offer-review-${WF}"]`);
        assert.ok(review.includes("8750000 minor units USD"), `review: ${review}`);
        assert.ok(
          review.includes("Synthetic Approver") && review.includes("Synthetic Owner"),
          `review: ${review}`,
        );
        await shot("02-saved");
      },
    );

    await check(
      "A4 invalid money/field edits are refused, each with no POST, then discarded",
      async () => {
        const cases = [
          {
            label: "fractional minor units",
            row: 0,
            field: "value",
            v: "87500.50",
            expect: "whole number of minor units",
          },
          {
            label: "negative amount",
            row: 0,
            field: "value",
            v: "-5",
            expect: "whole number of minor units",
          },
          {
            label: "exponent notation",
            row: 0,
            field: "value",
            v: "1e3",
            expect: "whole number of minor units",
          },
          {
            label: "two-letter currency",
            row: 0,
            field: "currency",
            v: "US",
            expect: "3-letter currency code",
          },
          {
            label: "duplicate field name",
            row: 1,
            field: "name",
            v: "base_salary",
            expect: "appears twice",
          },
          {
            label: "non-numeric number field",
            row: 2,
            field: "value",
            v: "abc",
            expect: "must be a number",
          },
        ];
        for (const c of cases) {
          const f = await fieldOf(c.row);
          await setField(f[c.field], c.v);
          await clickWhenEnabled(sel("gh-offer-save"));
          await waitErr(c.expect);
          assert.equal(api.posts.length, 1, `${c.label}: a POST was sent`);
          await clickWhenEnabled(sel("gh-offer-discard"));
          await until(
            async () => (await disabled(sel("gh-offer-save"))) === true,
            `discard ${c.label}`,
          );
          // Discard re-keys rows (fresh UUIDs); wait for the restored rows before re-querying.
          await until(
            async () =>
              (await page.$$eval('input[aria-label="Field name"]', (els) =>
                els.map((e) => e.value).join(","),
              )) === "base_salary,location,bonus_points",
            `rows restored after ${c.label}`,
          );
        }
        const review = await text(`[data-testid="gh-offer-review-${WF}"]`);
        assert.ok(
          review.includes("8750000 minor units USD"),
          "saved amount changed after refused edits",
        );
      },
    );

    await check("A5 after local save provider actions remain disabled (unavailable)", async () => {
      for (const a of PROVIDER_BTNS)
        assert.equal(await disabled(sel(`gh-offer-${a}`)), true, `${a} enabled`);
      assert.equal(await exists(sel("gh-offer-recover")), false);
    });

    // ---------- Phase B: dirty edit vs newer server revision ----------
    await check(
      "B1 dirty edit + newer server revision: edits kept, latest terms shown, save blocked",
      async () => {
        await setField(await opening(), "OPEN-EDIT");
        const before = api.current;
        api.current = {
          ...clone(before),
          workflowRevision: before.workflowRevision + 1,
          localRevision: newRev(),
          proposal: {
            ...clone(before.proposal),
            openingId: "OPEN-SERVER",
            values: {
              base_salary: { amountMinor: 9100000, currency: "USD" },
              location: "Remote",
              bonus_points: 3,
            },
          },
        };
        await page.evaluate(() => window.fixture.refresh());
        await until(() => exists(sel("gh-offer-conflict")), "conflict panel");
        const c = await text(sel("gh-offer-conflict"));
        assert.ok(c.includes("Someone saved different terms while you were editing."), c);
        const latest = await text(`[data-testid="gh-offer-review-${WF}-latest"]`);
        assert.ok(latest.includes("9100000 minor units USD"), `latest review: ${latest}`);
        assert.equal(await openingValue(), "OPEN-EDIT", "dirty edit was lost");
        assert.equal(await disabled(sel("gh-offer-save")), true, "save enabled during conflict");
        assert.equal(await exists(sel("gh-offer-keep")), true);
        assert.equal(await exists(sel("gh-offer-discard-conflict")), true);
        for (const a of PROVIDER_BTNS)
          assert.equal(await disabled(sel(`gh-offer-${a}`)), true, `${a} enabled while dirty`);
        assert.equal(api.posts.length, 1, "POST sent during conflict");
        await shot("03-conflict");
      },
    );

    await check("B2 discard during conflict adopts saved terms with no POST", async () => {
      await clickWhenEnabled(sel("gh-offer-discard-conflict"));
      await until(async () => !(await exists(sel("gh-offer-conflict"))), "conflict panel gone");
      assert.equal(await openingValue(), "OPEN-SERVER");
      assert.equal(await disabled(sel("gh-offer-save")), true);
      assert.equal(api.posts.length, 1);
    });

    let reviewedRevision = null;
    await check("B3 keep-then-save uses the reviewed newer revision", async () => {
      await setField(await opening(), "OPEN-EDIT-2");
      const before = api.current;
      api.current = {
        ...clone(before),
        workflowRevision: before.workflowRevision + 1,
        localRevision: newRev(),
        proposal: { ...clone(before.proposal), openingId: "OPEN-SERVER-2" },
      };
      reviewedRevision = api.current.localRevision;
      await page.evaluate(() => window.fixture.refresh());
      await until(() => exists(sel("gh-offer-conflict")), "conflict panel");
      await clickWhenEnabled(sel("gh-offer-keep"));
      await until(
        async () => !(await exists(sel("gh-offer-conflict"))),
        "conflict cleared by keep",
      );
      assert.equal(await openingValue(), "OPEN-EDIT-2", "keep discarded user edits");
      assert.equal(await disabled(sel("gh-offer-save")), false, "save still blocked after keep");
      await clickWhenEnabled(sel("gh-offer-save"));
      await until(() => api.posts.length === 2, "save POST after keep");
      const p = api.posts[1];
      assert.equal(p.action, "save");
      assert.equal(p.expectedLocalRevision, reviewedRevision, "save used a stale revision");
      assert.equal(p.proposal.openingId, "OPEN-EDIT-2");
      await waitText("Local terms saved. Nothing was sent to Greenhouse or the candidate.");
    });

    // ---------- Phase C: simulated prepared attempt approval ----------
    const preparedControl = newRev();
    await check(
      "C1 simulated prepared attempt: canEdit false, full terms read-only, approve only",
      async () => {
        await setState(
          nextState({
            canEdit: false,
            canApprove: true,
            canSubmit: false,
            executionMode: "simulated",
            blockers: [],
            controlRevision: preparedControl,
            attempt: { id: "synthetic-attempt-prepared-1", revision: newRev(), state: "prepared" },
          }),
        );
        await until(() => exists(sel("gh-offer-approve")), "approve button");
        const t = await body();
        assert.ok(t.includes("Read-only: you cannot edit these terms."));
        const review = await text(`[data-testid="gh-offer-review-${WF}"]`);
        for (const s of [
          "OPEN-EDIT-2",
          "9100000 minor units USD",
          "Remote",
          "Synthetic Approver",
          "Synthetic Owner",
          "bonus_points",
        ])
          assert.ok(review.includes(s), `review missing ${s}: ${review}`);
        assert.ok(t.includes("Current attempt synthetic-attempt-prepared-1: prepared."));
        assert.equal(await disabled(sel("gh-offer-approve")), false, "approve disabled");
        assert.equal(
          await disabled(sel("gh-offer-submit")),
          true,
          "submit enabled before approval",
        );
        assert.equal(
          await disabled(sel("gh-offer-prepare")),
          true,
          "prepare enabled while read-only",
        );
        assert.equal(
          await exists(sel("gh-offer-ack")),
          false,
          "checkbox shown before approve click",
        );
        await shot("04-prepared");
      },
    );

    await check(
      "C2 approve opens separate confirmation with full terms; confirm disabled until checkbox",
      async () => {
        await clickWhenEnabled(sel("gh-offer-approve"));
        await until(() => exists(sel("gh-offer-confirm")), "approve confirmation");
        const dlg = await text(sel("gh-offer-confirm"));
        assert.ok(dlg.includes("9100000 minor units USD") && dlg.includes("OPEN-EDIT-2"), dlg);
        assert.ok(dlg.includes("approve them under my name"), dlg);
        assert.equal(
          await disabled(sel("gh-offer-confirm-action")),
          true,
          "confirm enabled before checkbox",
        );
        assert.equal(await page.$eval(sel("gh-offer-ack"), (e) => e.checked), false);
        assert.equal(api.posts.length, 2, "approval POST sent before confirmation");
      },
    );

    await check("C3 approval POST is approve-only (no submit) and moves to approved", async () => {
      await page.click(sel("gh-offer-ack"));
      await clickWhenEnabled(sel("gh-offer-confirm-action"));
      await until(() => api.posts.length === 3, "approve POST");
      const p = api.posts[2];
      assert.equal(p.action, "approve");
      assert.equal(p.attemptId, "synthetic-attempt-prepared-1");
      assert.equal(p.expectedControlRevision, preparedControl);
      assert.equal(p.proposal, undefined);
      assert.equal(
        api.posts.filter((x) => x.action === "submit").length,
        0,
        "approval triggered submit",
      );
      await waitText("approve recorded. Check the attempt state below.");
      assert.ok((await body()).includes("Current attempt synthetic-attempt-prepared-1: approved."));
      assert.equal(
        await disabled(sel("gh-offer-approve")),
        true,
        "approve still enabled after approval",
      );
      assert.equal(
        await disabled(sel("gh-offer-submit")),
        false,
        "submit not enabled after approval",
      );
      await shot("05-approved");
    });

    // ---------- Phase D: approved -> simulation submission ----------
    await check(
      "D1 approved: distinct simulation-submission confirmation, no candidate-delivery claim",
      async () => {
        await clickWhenEnabled(sel("gh-offer-submit"));
        await until(() => exists(sel("gh-offer-confirm")), "submit confirmation");
        const dlg = await text(sel("gh-offer-confirm"));
        assert.ok(dlg.includes("records a simulation submission"), dlg);
        assert.ok(dlg.includes("not sent to the candidate"), dlg);
        assert.equal(DELIVERY_CLAIM.test(dlg), false, `delivery claim in dialog: ${dlg}`);
        assert.equal(
          await page.$eval(sel("gh-offer-confirm-action"), (e) => e.textContent.trim()),
          "Confirm simulation submission",
        );
        assert.equal(await disabled(sel("gh-offer-confirm-action")), true);
        assert.equal(api.posts.length, 3, "submit POST sent before confirmation");
        await shot("06-submit-confirm");
      },
    );

    await check(
      "D2 submission POST records simulation only; no candidate delivery language",
      async () => {
        await page.click(sel("gh-offer-ack"));
        await clickWhenEnabled(sel("gh-offer-confirm-action"));
        await until(() => api.posts.length === 4, "submit POST");
        const p = api.posts[3];
        assert.equal(p.action, "submit");
        assert.equal(p.attemptId, "synthetic-attempt-prepared-1");
        await waitText("Simulation submission recorded. No candidate received anything.");
        const notice = await text(sel("gh-offer-notice"));
        assert.equal(DELIVERY_CLAIM.test(notice), false, `delivery claim: ${notice}`);
        assert.ok(
          (await body()).includes(
            "Current attempt synthetic-attempt-prepared-1: verified submission.",
          ),
        );
        assert.equal(
          await disabled(sel("gh-offer-submit")),
          true,
          "submit enabled after submission",
        );
      },
    );

    // ---------- Phase E: review_required and unavailable recovery ----------
    const reviewAttempt = "synthetic-attempt-review-1";
    await check(
      "E1 review_required shows exact attempt ID and read-only recovery in simulated mode",
      async () => {
        await setState(
          nextState({
            canEdit: false,
            canApprove: false,
            canSubmit: false,
            executionMode: "simulated",
            blockers: [],
            controlRevision: newRev(),
            attempt: { id: reviewAttempt, revision: newRev(), state: "review_required" },
          }),
        );
        await until(() => exists(sel("gh-offer-recover")), "recover button");
        const t = await body();
        assert.ok(
          t.includes(`Current attempt ${reviewAttempt}: review required.`),
          "exact attempt id not shown",
        );
        assert.equal(await disabled(sel("gh-offer-recover")), false, "recover disabled");
        assert.equal(await disabled(sel("gh-offer-approve")), true);
        assert.equal(await disabled(sel("gh-offer-submit")), true);
        await shot("07-review-required");
      },
    );

    await check("E2 recovery POST carries exact attempt ID, no approve/submit", async () => {
      const before = api.posts.length;
      await clickWhenEnabled(sel("gh-offer-recover"));
      await until(() => api.posts.length === before + 1, "recover POST");
      const p = api.posts[before];
      assert.equal(p.action, "recover");
      assert.equal(p.attemptId, reviewAttempt);
      assert.equal(p.proposal, undefined);
      await waitText("recover recorded. Check the attempt state below.");
      assert.ok((await body()).includes(`Current attempt ${reviewAttempt}: review required.`));
      assert.equal(
        api.posts.filter((x) => ["approve", "submit"].includes(x.action)).length,
        2,
        "recovery sent approve/submit",
      );
    });

    await check("E3 unavailable mode never offers recovery even for review_required", async () => {
      await setState(
        nextState({
          canEdit: false,
          canApprove: false,
          canSubmit: false,
          executionMode: "unavailable",
          blockers: ["Configuration not verified"],
          controlRevision: null,
          attempt: { id: reviewAttempt, revision: newRev(), state: "review_required" },
        }),
      );
      await until(
        async () => (await body()).includes("No employer-approved Greenhouse connection is ready"),
        "unavailable copy",
      );
      assert.equal(
        await exists(sel("gh-offer-recover")),
        false,
        "recover offered in unavailable mode",
      );
      for (const a of PROVIDER_BTNS)
        assert.equal(await disabled(sel(`gh-offer-${a}`)), true, `${a} enabled`);
      await shot("08-unavailable-review");
    });

    // ---------- Phase F: refresh 403 hides cached financial values ----------
    await check("F1 refresh returning 403 hides cached terms, attempt and fields", async () => {
      await setState(
        nextState({
          history: [
            {
              sequence: 1,
              attemptId: "b73e7025-9e9c-4f9c-8c04-ecbc43df523b",
              state: "review_required",
              recordedAt: "2026-11-15T12:00:00Z",
              actorId: "private-historical-reviewer",
              receiptRecorded: false,
            },
          ],
        }),
      );
      const cached = await bodyContent();
      assert.ok(cached.includes("private-historical-reviewer"), "history positive control");
      for (const s of ["9100000", "OPEN-EDIT-2", "Synthetic Approver"])
        assert.ok(cached.includes(s), `precondition missing ${s}`);
      api.getStatus = 403;
      await page.evaluate(() => window.fixture.refresh());
      await until(() => exists(sel("gh-offer-error")), "403 error panel");
      const raw = await bodyContent();
      assert.ok(
        (await body()).includes(
          "You do not have access to the Greenhouse offer workspace for this candidate.",
        ),
      );
      for (const s of [
        "9100000",
        "8750000",
        "OPEN-EDIT-2",
        "OPEN-SERVER",
        "Synthetic Approver",
        "Synthetic Owner",
        "minor units",
        "bonus_points",
        "Remote",
        reviewAttempt,
        "Current attempt",
        "private-historical-reviewer",
        "Submission history",
      ])
        assert.ok(!raw.includes(s), `403 view still shows "${s}"`);
      assert.equal(await exists(sel("gh-offer")), false, "workspace section still rendered");
      assert.equal(
        await page.$$eval("input, select", (els) => els.length),
        0,
        "inputs still rendered",
      );
      await shot("09-403");
    });

    await check("F2 retry after 403 restores the workspace from a successful GET", async () => {
      await clickWhenEnabled(sel("gh-offer-retry"));
      await until(() => exists(sel("gh-offer")), "workspace restored");
      assert.ok((await body()).includes("LOCAL DRAFT"));
      assert.ok((await body()).includes("9100000 minor units USD"));
    });

    // ---------- Phase G: 390px layout ----------
    await page.setViewport({ width: 390, height: 844 });
    const overflows = {};
    await check(
      "G1 390px editable workspace with prepared attempt: no horizontal overflow",
      async () => {
        await setState(
          nextState({
            canEdit: true,
            canApprove: true,
            canSubmit: false,
            executionMode: "simulated",
            blockers: [],
            controlRevision: newRev(),
            attempt: { id: "synthetic-attempt-prepared-2", revision: newRev(), state: "prepared" },
          }),
        );
        await until(() => exists(sel("gh-offer-opening")), "editor visible");
        const o = await overflow();
        overflows.editor = o;
        assert.ok(
          o.scrollWidth <= o.vw,
          `scrollWidth ${o.scrollWidth} > ${o.vw}; offenders ${o.offenders}`,
        );
        await shot("10-390-editor");
      },
    );

    await check("G2 390px approval confirmation: no horizontal overflow", async () => {
      await clickWhenEnabled(sel("gh-offer-approve"));
      await until(() => exists(sel("gh-offer-confirm")), "approve confirmation");
      const o = await overflow();
      overflows.confirm = o;
      assert.ok(
        o.scrollWidth <= o.vw,
        `scrollWidth ${o.scrollWidth} > ${o.vw}; offenders ${o.offenders}`,
      );
      await shot("11-390-confirm");
    });

    await check("G3 390px conflict panel: no horizontal overflow", async () => {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find(
          (x) => x.textContent.trim() === "Back",
        );
        b?.click();
      });
      await until(async () => !(await exists(sel("gh-offer-confirm"))), "confirm closed");
      await setField(await opening(), "OPEN-MOBILE-EDIT");
      const before = api.current;
      api.current = {
        ...clone(before),
        workflowRevision: before.workflowRevision + 1,
        localRevision: newRev(),
      };
      await page.evaluate(() => window.fixture.refresh());
      await until(() => exists(sel("gh-offer-conflict")), "conflict panel");
      const o = await overflow();
      overflows.conflict = o;
      await shot("12-390-conflict");
      assert.ok(
        o.scrollWidth <= o.vw,
        `scrollWidth ${o.scrollWidth} > ${o.vw}; offenders ${o.offenders}`,
      );
    });

    // ---------- controlled provider is synthetic too; never a real account ----------
    await check(
      "H1 controlled submit requires a new explicit acknowledgement and explains internal emails",
      async () => {
        await setState(
          nextState({
            executionMode: "controlled",
            canEdit: false,
            canApprove: false,
            canSubmit: true,
            blockers: [],
            controlRevision: newRev(),
            attempt: { id: "synthetic-controlled-attempt", revision: newRev(), state: "approved" },
          }),
        );
        await until(() => exists(sel("gh-offer-conflict")), "retained unsaved edits");
        await clickWhenEnabled(sel("gh-offer-discard-conflict"));
        await clickWhenEnabled(sel("gh-offer-submit"));
        await until(() => exists(sel("gh-offer-confirm")), "controlled confirmation");
        const before = api.posts.length;
        const dlg = await text(sel("gh-offer-confirm"));
        assert.ok(dlg.includes("may email employer approvers"), dlg);
        assert.ok(dlg.includes("does not send an offer to the candidate"), dlg);
        assert.ok(!dlg.includes("simulation submission"), dlg);
        assert.equal(await disabled(sel("gh-offer-confirm-action")), true);
        await page.click(sel("gh-offer-ack"));
        await clickWhenEnabled(sel("gh-offer-confirm-action"));
        await until(() => api.posts.length === before + 1, "controlled submit POST");
        await waitText("Greenhouse draft and internal approval submission verified.");
        assert.equal(api.posts.at(-1).action, "submit");
        assert.equal(api.posts.at(-1).attemptId, "synthetic-controlled-attempt");
        await shot("13-controlled-submission");
      },
    );
    await check(
      "H2 draft-created holds allow read-only recovery but never resubmission",
      async () => {
        await setState(
          nextState({
            canEdit: false,
            canApprove: false,
            canSubmit: false,
            attempt: {
              id: "synthetic-controlled-held",
              revision: newRev(),
              state: "draft_created",
            },
          }),
        );
        await until(() => exists(sel("gh-offer-recover")), "draft-created recovery");
        assert.equal(await disabled(sel("gh-offer-submit")), true);
        const before = api.posts.length;
        await clickWhenEnabled(sel("gh-offer-recover"));
        await until(() => api.posts.length === before + 1, "held recovery");
        assert.equal(api.posts.at(-1).action, "recover");
        await shot("14-controlled-draft-hold");
      },
    );

    await check(
      "I1 retained history distinguishes uncertain recovery, renders safely at 390px, and makes no writes",
      async () => {
        const before = api.posts.length;
        const states = ["prepared", "claimed", "draft_created", "observed_match", "observed_other"];
        const attemptId = "b73e7025-9e9c-4f9c-8c04-ecbc43df523b";
        await setState(
          nextState({
            history: states.map((state, index) => ({
              sequence: index + 1,
              attemptId,
              state,
              recordedAt: `2026-11-15T12:00:0${4 - index}Z`,
              actorId: index === 4 ? null : "<script>historical-staff</script>",
              receiptRecorded: index === 2,
            })),
          }),
        );
        const timeline = 'section[aria-label="Greenhouse submission history"]';
        const content = await text(timeline);
        assert.ok(content.includes("Draft receipt saved — approval request not yet verified"));
        assert.ok(content.includes("submission not attributed"));
        assert.ok(content.includes("Recovery observations never authorize a retry"));
        assert.ok(content.includes("Staff identity not retained"));
        assert.ok(content.includes("<script>historical-staff</script>"));
        assert.equal(await page.$$eval(`${timeline} script`, (els) => els.length), 0);
        const items = await page.$$eval(`${timeline} li`, (els) => els.map((el) => el.textContent));
        assert.deepEqual(
          items.map((item) => item.match(/^#(\d+)/)?.[1]),
          ["1", "2", "3", "4", "5"],
        );
        const o = await overflow();
        assert.ok(o.scrollWidth <= o.vw, `history overflow ${JSON.stringify(o)}`);
        assert.equal(api.posts.length, before, "reading history cannot submit or recover");
        await page.$eval(timeline, (el) => el.scrollIntoView());
        await shot("15-submission-history");
      },
    );

    // ---------- global checks ----------
    await check(
      "G4 no external/blocked traffic, mutations outside the synthetic endpoint, or page errors",
      async () => {
        assert.deepEqual(api.externalBlocked, [], "blocked/unexpected requests");
        assert.deepEqual(api.violations, [], "stale or malformed POSTs");
        assert.deepEqual(pageErrors, [], "uncaught page errors");
      },
    );
    await check("G5 revisions generated for synthetic states are unique", async () => {
      const all = ["a".repeat(64), ...revisionLog];
      assert.equal(new Set(all).size, all.length, "duplicate revision");
    });

    writeFileSync(
      path.join(OUT, "summary.json"),
      JSON.stringify(
        {
          results,
          posts: api.posts,
          violations: api.violations,
          stateRefreshes: api.stateRefreshes,
          consoleErrors,
          overflows,
        },
        null,
        2,
      ),
    );
    console.log(
      `workflow-state requests intercepted (synthetic, none expected): ${api.stateRefreshes}`,
    );
    console.log(`console errors observed (informational): ${consoleErrors.length}`);
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (vite) await vite.close().catch(() => {});
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
