import assert from "node:assert/strict";
import { actor, tid } from "./harness.mjs";
import { REV2, statuses } from "./google-staff-api.mjs";

const card = tid("google-staff-calendar"),
  connect = tid("google-staff-connect"),
  disconnect = tid("google-staff-disconnect"),
  check = tid("google-staff-check-availability");
const other = { ...actor, id: "other-fixture-staff" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (f) => f.page.$eval(card, (n) => n.textContent);
const pad = (n) => String(n).padStart(2, "0");
function localInput(daysAhead, hour = 10) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:00`;
}
async function setField(f, selector, value) {
  await f.page.$eval(
    selector,
    (node, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(node, v);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}
async function fillInterval(f, start = localInput(5), minutes = "45") {
  await setField(f, "#gsc-start", start);
  await setField(f, "#gsc-dur", minutes);
}
async function runCheck(f) {
  const n = f.staff.state.checks.length;
  await f.page.locator(check).click();
  await f.page.waitForFunction((sel) => !document.querySelector(sel)?.disabled, {}, check);
  await f.page.waitForFunction((sel, len) => document.querySelector(sel) && len >= 0, {}, card, n);
  assert.equal(f.staff.state.checks.length, n + 1);
}
const dblClick = (f, sel) => f.page.$eval(sel, (n) => (n.click(), n.click()));
const focus = (f) => f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
const settle = () => sleep(250);
async function readyCard(f) {
  await f.page.waitForSelector(card);
  await f.page.waitForFunction(
    (sel) => !document.querySelector(sel)?.querySelector(".animate-pulse"),
    {},
    card,
  );
}
async function consentAndClick(f) {
  await f.page.locator(`${card} input[type=checkbox]`).click();
}
const hasResult = async (f, re) => re.test(await body(f));

export const googleStaffScenarios = [
  {
    name: "Staff Google mount reads local status only, no auto availability, hides for candidates",
    options: { allowSend: true },
    async run(f) {
      await readyCard(f);
      assert.match(await body(f), /staff\.own@example\.invalid/);
      assert.equal(f.staff.state.gets, 1);
      assert.equal(f.staff.state.checks.length, 0);
      await focus(f);
      await settle();
      assert.equal(f.staff.state.checks.length, 0);
      await f.switchActor({ ...actor, role: "candidate" });
      await f.page.waitForFunction((s) => !document.querySelector(s), {}, card);
      await f.switchActor(other);
      await readyCard(f);
      assert.equal(f.staff.state.checks.length, 0);
      assert.equal(f.navigations.length, 0);
    },
  },
  {
    name: "Staff Google setup-required is honest and offers no connect or check",
    options: { allowSend: true, staff: "setup" },
    async run(f) {
      await readyCard(f);
      const t = await body(f);
      assert.match(t, /not set up/);
      assert.equal(await f.page.$(connect), null);
      assert.equal(await f.page.$(check), null);
      assert.equal(f.staff.state.connects.length, 0);
    },
  },
  {
    name: "Staff Google connect needs explicit consent, double-click authorizes once, to Google only",
    options: { allowSend: true, staff: "disconnected" },
    async run(f) {
      await readyCard(f);
      assert.match(await body(f), /clears (?:any old|the old) local grant/);
      assert.equal(await f.page.$eval(connect, (n) => n.disabled), true);
      await consentAndClick(f);
      const gate = f.staff.hold("connect");
      await dblClick(f, connect);
      await gate.started;
      await settle();
      assert.equal(f.staff.state.connects.length, 1);
      gate.release();
      await f.page.waitForFunction(() => document.body.textContent.includes("oauth intercepted"));
      assert.equal(f.navigations.length, 1);
      assert.equal(new URL(f.navigations[0]).pathname, "/o/oauth2/v2/auth");
      assert.equal(f.staff.state.connects.length, 1);
      assert.deepEqual(f.staff.state.connects[0], {
        confirmOwnCalendar: true,
        allowInvitations: false,
      });
    },
  },
  {
    name: "Staff Google invitation write permission is a separate opt-in that needs the acknowledgement",
    options: { allowSend: true, staff: "disconnected" },
    async run(f) {
      await readyCard(f);
      const allow = tid("google-staff-allow-invitations");
      assert.equal(await f.page.$eval(allow, (n) => n.disabled), true);
      await consentAndClick(f);
      assert.equal(await f.page.$eval(allow, (n) => n.disabled), false);
      await f.page.locator(allow).click();
      await f.page.locator(connect).click();
      await f.page.waitForFunction(() => document.body.textContent.includes("oauth intercepted"));
      assert.deepEqual(f.staff.state.connects, [
        { confirmOwnCalendar: true, allowInvitations: true },
      ]);
    },
  },
  {
    name: "Staff Google rejects non-Google authorization URLs and recovers from connect errors",
    options: { allowSend: true, staff: "disconnected" },
    async run(f) {
      await readyCard(f);
      await consentAndClick(f);
      const bad = [
        "http://accounts.google.com/o/oauth2/v2/auth?x=1",
        "https://evil.example.invalid/o/oauth2/v2/auth",
        "https://accounts.google.com.evil.example.invalid/o/oauth2/v2/auth",
        "https://accounts.google.com/o/oauth2/auth",
        "https://user:pw@accounts.google.com/o/oauth2/v2/auth",
        "javascript:alert(1)",
        "not a url",
      ];
      let n = 0;
      for (const url of bad) {
        f.staff.state.authUrl = url;
        await f.page.locator(connect).click();
        await f.page.waitForFunction(
          (sel) =>
            !document.querySelector(sel).disabled && document.querySelector('[role="alert"]'),
          {},
          connect,
        );
        assert.equal(f.staff.state.connects.length, ++n);
        assert.match(await body(f), /could not be started/);
      }
      f.staff.state.failNext.connect = 503;
      await f.page.locator(connect).click();
      await f.page.waitForFunction((sel) => !document.querySelector(sel).disabled, {}, connect);
      assert.equal(f.navigations.length, 0);
      f.staff.state.authUrl = "https://accounts.google.com/o/oauth2/v2/auth?ok=1";
      await f.page.locator(connect).click();
      await f.page.waitForFunction(() => document.body.textContent.includes("oauth intercepted"));
      assert.equal(f.navigations.length, 1);
    },
  },
  {
    name: "Staff Google late connect response after actor switch or unmount never navigates",
    options: { allowSend: true, staff: "disconnected" },
    async run(f) {
      for (const next of [other, { ...actor, id: "third-fixture", role: "candidate" }]) {
        await readyCard(f);
        await consentAndClick(f);
        const gate = f.staff.hold("connect");
        await f.page.locator(connect).click();
        await gate.started;
        await f.switchActor(next);
        gate.release();
        await settle();
        assert.equal(f.navigations.length, 0);
        assert.match(
          await f.page.evaluate(() => document.body.textContent),
          /fixture|Synthetic|Calendar|staff/i,
        );
        if (next.role !== "candidate") {
          await readyCard(f);
          assert.equal(
            await f.page.$eval(connect, (n) => n.disabled),
            true,
            "new actor starts unconsented",
          );
        }
      }
      assert.equal(f.navigations.length, 0);
    },
  },
  {
    name: "Staff Google availability: free/busy/outside receipts, exact request, clears on change",
    options: { allowSend: true },
    async run(f) {
      await readyCard(f);
      assert.equal(await f.page.$eval(check, (n) => n.disabled), true);
      const start = localInput(5);
      await fillInterval(f, start, "45");
      await f.page.locator(check).click();
      await f.page.waitForFunction(() =>
        document.body.textContent.includes("Free for this interval"),
      );
      const sent = f.staff.state.checks[0];
      assert.equal(sent.startAt, new Date(start).toISOString());
      assert.equal(sent.durationMinutes, 45);
      assert.equal(sent.revision, statuses.connected.revision);
      assert.match(await body(f), /Not reserved\. Not an invitation/);
      for (const [status, re] of [
        ["busy", /Busy during/],
        ["outside_working_hours", /Outside your working hours/],
      ]) {
        f.staff.state.receipt = () => ({ status });
        await runCheck(f);
        assert.match(await body(f), re);
      }
      // input change clears
      await setField(f, "#gsc-dur", "60");
      assert.equal(await hasResult(f, /Outside your working/), false);
      await runCheck(f);
      assert.match(await body(f), /Outside your working hours/);
      // focus clears, performs no provider read
      const before = f.staff.state.checks.length;
      await focus(f);
      assert.equal(await hasResult(f, /Outside your working/), false);
      await settle();
      assert.equal(f.staff.state.checks.length, before);
      // provider error clears and recovery works
      await runCheck(f);
      f.staff.state.failNext.check = 503;
      await runCheck(f);
      assert.match(await body(f), /availability check failed/);
      assert.equal(await hasResult(f, /Outside your working/), false);
      await runCheck(f);
      assert.match(await body(f), /Outside your working hours/);
      // revision change clears; next check uses new revision
      f.staff.state.status = { ...statuses.connected, revision: REV2 };
      await f.page.evaluate(() => window.fixture.refetchStatus());
      await f.page.waitForFunction(
        () => !document.body.textContent.includes("Outside your working"),
      );
      f.staff.state.receipt = null;
      await runCheck(f);
      assert.equal(f.staff.state.checks.at(-1).revision, REV2);
      // identity change clears
      await f.switchActor(other);
      await readyCard(f);
      assert.equal(await hasResult(f, /Free for this interval/), false);
      // input validation: >90 days / out-of-range duration never sends
      const n = f.staff.state.checks.length;
      await fillInterval(f, localInput(120), "45");
      assert.equal(await f.page.$eval(check, (x) => x.disabled), true);
      await fillInterval(f, localInput(5), "481");
      assert.equal(await f.page.$eval(check, (x) => x.disabled), true);
      await fillInterval(f, localInput(5), "14");
      assert.equal(await f.page.$eval(check, (x) => x.disabled), true);
      assert.equal(f.staff.state.checks.length, n);
    },
  },
  {
    name: "Staff Google stale/malformed/write-enabled/wrong-window receipts are never success",
    options: { allowSend: true },
    async run(f) {
      await readyCard(f);
      await fillInterval(f);
      const cases = [
        () => ({ revision: "rev-stale" }),
        () => ({ status: "unknown" }),
        () => ({ invitationsEnabled: true }),
        () => ({ reserved: true }),
        (_b, r) => ({ startAt: new Date(new Date(r.startAt).getTime() + 60000).toISOString() }),
        (_b, r) => ({ endAt: new Date(new Date(r.endAt).getTime() + 60000).toISOString() }),
        () => ({ reserved: undefined }),
        () => ({ status: "__proto__" }),
      ];
      for (const c of cases) {
        f.staff.state.receipt = c;
        await runCheck(f);
        const t = await body(f);
        assert.match(t, /availability check failed/);
        assert.equal(/Free for this interval/.test(t), false);
      }
    },
  },
  {
    name: "Staff Google disconnect is two-step, exact revision, single write per confirm, recoverable",
    options: { allowSend: true },
    async run(f) {
      await readyCard(f);
      await f.page.locator(disconnect).click();
      assert.equal(f.staff.state.disconnects.length, 0);
      await f.page.locator("button ::-p-text(Keep)").click();
      await f.page.locator(disconnect).click();
      f.staff.state.failNext.disconnect = 503;
      await dblClick(f, disconnect);
      await f.page.waitForFunction(() =>
        document.body.textContent.includes("could not be confirmed"),
      );
      assert.equal(f.staff.state.disconnects.length, 1);
      assert.match(await body(f), /staff\.own@example\.invalid/);
      await f.page.waitForFunction((sel) => !document.querySelector(sel)?.disabled, {}, disconnect);
      await dblClick(f, disconnect);
      await f.page.waitForFunction(() => document.body.textContent.includes("Not connected"));
      assert.equal(f.staff.state.disconnects.length, 2);
      assert.deepEqual(f.staff.state.disconnects[1], {
        revision: statuses.connected.revision,
        confirmDisconnect: true,
      });
      assert.equal(await f.page.$(check), null);
    },
  },
  {
    name: "Staff Google pending connection cancels with its revision",
    options: { allowSend: true, staff: "pending" },
    async run(f) {
      await readyCard(f);
      assert.match(await body(f), /Authorization is pending/);
      await f.page.locator(disconnect).click();
      await f.page.locator(disconnect).click();
      await f.page.waitForFunction(() => document.body.textContent.includes("Not connected"));
      assert.deepEqual(f.staff.state.disconnects, [
        { revision: "rev-pending", confirmDisconnect: true },
      ]);
    },
  },
  {
    name: "Staff Google callback error shows generic notice; callback query never proves connection",
    options: {
      allowSend: true,
      staff: "disconnected",
      search: "?googleCalendar=error&detail=secret-token",
    },
    async run(f) {
      await readyCard(f);
      const t = await body(f);
      assert.match(t, /did not complete/);
      assert.equal(t.includes("secret-token"), false);
      assert.match(t, /Not connected/);
      assert.equal(f.staff.state.checks.length, 0);
    },
  },
  {
    name: "Staff Google callback connected query alone claims nothing",
    options: { allowSend: true, staff: "disconnected", search: "?googleCalendar=connected" },
    async run(f) {
      await readyCard(f);
      const t = await body(f);
      assert.match(t, /Not connected/);
      assert.equal(/Connected as/.test(t), false);
      assert.equal(await f.page.$(check), null);
    },
  },
  {
    name: "Staff Google 390px controls remain reachable",
    options: { allowSend: true, width: 390 },
    async run(f) {
      await readyCard(f);
      await fillInterval(f);
      for (const sel of [check, disconnect, "#gsc-start", "#gsc-dur"]) {
        await f.page.$eval(sel, (n) => n.scrollIntoView());
        const b = await f.page.$eval(sel, (n) => {
          const r = n.getBoundingClientRect();
          return { l: r.left, r: r.right, w: innerWidth };
        });
        assert.ok(b.l >= 0 && b.r <= b.w, `${sel} within viewport`);
      }
      await runCheck(f);
      assert.match(await body(f), /Free for this interval/);
      assert.equal(
        await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
    },
  },
];
