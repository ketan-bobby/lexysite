import assert from "node:assert/strict";
import { actor, tid } from "./harness.mjs";

const good = {
  status: "verified",
  checkedAt: "2035-11-01T10:00:00Z",
  calendarReadVerified: true,
  availabilityReadVerified: true,
  meetSupported: true,
  accountBinding: "not_configured",
  invitationsEnabled: false,
};
const card = tid("google-calendar-pilot"),
  button = tid("google-pilot-check");
async function check(f) {
  const response = f.page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/google-calendar/pilot-check" &&
      r.request().method() === "POST",
  );
  await f.page.locator(button).click();
  await response;
  await f.page.waitForFunction(
    (selector) => !document.querySelector(selector)?.disabled,
    {},
    button,
  );
}
async function body(f) {
  return f.page.$eval(card, (node) => node.textContent);
}
export const googleScenarios = [
  {
    name: "Google pilot does not auto-read; explicit double-click checks once and reload clears receipt",
    options: { allowSend: true },
    async run(f) {
      await f.page.waitForSelector(card);
      assert.equal(f.posts.length, 0);
      const release = f.holdSend();
      await f.page.$eval(button, (node) => {
        node.click();
        node.click();
      });
      await f.page.waitForFunction(
        (selector) => document.querySelector(selector)?.disabled,
        {},
        button,
      );
      assert.equal(f.posts.length, 1);
      release();
      await f.page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent.includes("Read checks passed"),
        {},
        card,
      );
      const text = await body(f);
      assert.match(text, /Staff\/employer account binding is not configured/);
      assert.match(text, /not proof of meeting-creation permission/);
      assert.match(text, /does not authorize/);
      assert.equal(text.includes("@"), false);
      await f.reload();
      await f.page.waitForSelector(card);
      assert.equal((await body(f)).includes("Read checks passed"), false);
      assert.equal(f.posts.length, 1);
    },
  },
  {
    name: "Google pilot stays hidden for non-platform roles and clears results on admin identity change",
    options: { allowSend: true },
    async run(f) {
      await check(f);
      assert.match(await body(f), /Read checks passed/);
      for (const role of [
        "candidate",
        "recruiter",
        "tenant_admin",
        "recruiter_admin",
        "interviewer",
        "hiring_manager",
      ]) {
        await f.switchActor({ ...actor, role });
        await f.page.waitForFunction((selector) => !document.querySelector(selector), {}, card);
      }
      await f.switchActor({ ...actor, id: "other-fixture-admin" });
      await f.page.waitForSelector(card);
      assert.equal((await body(f)).includes("Read checks passed"), false);
      assert.equal(f.posts.length, 1);
    },
  },
  {
    name: "Google failed and write-enabled receipts clear prior success; explicit recovery only",
    options: { allowSend: true },
    async run(f) {
      await check(f);
      assert.match(await body(f), /Read checks passed/);
      f.failNextRead(503);
      await check(f);
      await f.page.waitForSelector('[role="alert"]');
      assert.equal((await body(f)).includes("Read checks passed"), false);
      f.snapshot({ ...good, invitationsEnabled: true });
      await check(f);
      assert.match(await body(f), /could not be verified/);
      assert.equal((await body(f)).includes("Read checks passed"), false);
      f.snapshot(good);
      await check(f);
      assert.match(await body(f), /Read checks passed/);
      assert.equal(f.posts.length, 4);
    },
  },
  {
    name: "Google absent and ambiguous connection receipts never show read or Meet success",
    options: { allowSend: true },
    async run(f) {
      for (const status of ["not_connected", "selection_required"]) {
        f.snapshot({
          ...good,
          status,
          calendarReadVerified: false,
          availabilityReadVerified: false,
          meetSupported: null,
        });
        await check(f);
        const text = await body(f);
        assert.equal(text.includes("Read checks passed"), false);
        assert.equal(text.includes("advertised by this calendar"), false);
        assert.match(text, status === "not_connected" ? /No accessible/ : /Multiple Google/);
      }
    },
  },
  {
    name: "Google pilot 390px control and privacy copy remain reachable",
    options: { allowSend: true, width: 390 },
    async run(f) {
      await check(f);
      assert.match(await body(f), /Read checks passed/);
      const bounds = await f.page.$eval(button, (node) => {
        const r = node.getBoundingClientRect();
        return { left: r.left, right: r.right, width: window.innerWidth };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width);
      assert.match(await body(f), /No account identifiers, event details or busy periods/);
    },
  },
  {
    name: "Google harness denies any check without explicit fixture permission",
    options: {},
    expectedViolations: ["Unapproved read check blocked"],
    async run(f) {
      const denied = await f.page.evaluate(async () => {
        try {
          await fetch("/api/google-calendar/pilot-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirmReadOnlyCheck: true }),
          });
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(denied, true);
      assert.equal(f.posts.length, 0);
    },
  },
];
