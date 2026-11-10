import assert from "node:assert/strict";
import { actor, schedule, tid } from "./harness.mjs";
import { tok } from "./google-operation-api.mjs";

const T = {
  open: tid(`button-google-operation-${schedule.id}`),
  body: tid("google-operation-body"),
  review: tid("button-google-operation-review"),
  ack: tid("checkbox-google-operation-ack"),
  approve: tid("checkbox-google-operation-approve"),
  send: tid("button-google-operation-send"),
  details: tid("text-google-operation-details"),
  error: tid("text-google-operation-error"),
  accepted: tid("text-google-operation-accepted"),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (f) => f.page.$eval(T.body, (n) => n.textContent);
const exists = (f, sel) => f.page.$(sel).then(Boolean);
const op = (f) => f.op.state;
const idle = (f) =>
  f.page.waitForFunction((r) => !document.querySelector(r)?.disabled, {}, T.review);
async function openDialog(f) {
  if (!(await f.page.$(T.body))) await f.page.locator(T.open).click();
  await f.page.waitForSelector(T.body);
}
async function review(f) {
  await f.page.locator(T.review).click();
  await idle(f);
  await sleep(50);
}
async function approveBoth(f) {
  await f.page.waitForSelector(T.ack);
  await f.page.locator(T.ack).click();
  await f.page.locator(T.approve).click();
}
async function reviewApprove(f) {
  await openDialog(f);
  await review(f);
  await approveBoth(f);
}
async function sendClick(f) {
  await f.page.locator(T.send).click();
  await idle(f);
  await sleep(80);
}
const sendDisabled = (f) => f.page.$eval(T.send, (n) => n.disabled);
async function setSchedule(f, patch) {
  await f.page.evaluate((s) => window.fixture.switchSchedule(s), { ...schedule, ...patch });
  await sleep(80);
}
const opts = { allowSend: true };

export const googleOperationScenarios = [
  {
    name: "Operation: no read on mount/open; review is explicit and shows exact instants, parties and two-step approval",
    options: opts,
    async run(f) {
      await f.page.waitForSelector(T.open);
      await openDialog(f);
      await sleep(150);
      assert.equal(op(f).gets, 0);
      assert.match(await text(f), /does not update Google/);
      await review(f);
      assert.equal(op(f).gets, 1);
      assert.equal(op(f).posts.length, 0);
      const t = await text(f);
      for (const s of [
        "candidate@example.invalid",
        "organizer@example.invalid",
        "Reschedule event",
        "2035-10-31T09:00:00.123Z",
        "2035-11-01T10:00:00.000Z",
        "may email the candidate and all listed panel recipients",
        "All current panel calendars and saved working hours are rechecked",
        "A busy or unverifiable calendar stops the update",
      ])
        assert.ok(t.includes(s), `missing ${s}`);
      assert.match(t, /\.123/);
      assert.match(t, /GMT|UTC/);
      assert.equal(await sendDisabled(f), true);
      await f.page.locator(T.ack).click();
      assert.equal(await sendDisabled(f), true, "ack alone must not enable send");
      await f.page.locator(T.approve).click();
      assert.equal(await sendDisabled(f), false);
      assert.equal(op(f).posts.length, 0);
    },
  },
  {
    name: "Operation: approved apply re-reads, posts once, with kind and ORIGINAL proof after rotation",
    options: opts,
    async run(f) {
      op(f).rotate = true;
      await reviewApprove(f);
      await sendClick(f);
      assert.equal(op(f).gets, 2);
      assert.equal(op(f).posts.length, 1);
      const p = op(f).posts[0];
      assert.equal(p.kind, "reschedule");
      assert.equal(p.expectedVersion, schedule.version);
      assert.equal(p.expectedApprovalToken, tok("a"));
      assert.equal(p.reviewExpiresAt, op(f).firstGet.reviewExpiresAt);
      assert.match(await text(f), /not proof that the guest was notified/);
      assert.equal(await exists(f, T.send), false);
    },
  },
  {
    name: "Operation: double click posts once",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      const h = f.op.hold();
      await f.page.$eval(T.send, (n) => (n.click(), n.click()));
      await h.started;
      await sleep(150);
      assert.equal(op(f).posts.length, 1);
      h.release();
      await idle(f);
      await sleep(100);
      assert.equal(op(f).posts.length, 1);
    },
  },
  {
    name: "Operation: immutable drift (target, previous, etag, recipient, organizer, kind) blocks the write",
    options: opts,
    async run(f) {
      const drifts = [
        { targetEnd: "2035-11-01T11:30:00.000Z" },
        { previousStart: "2035-10-31T09:00:00.124Z" },
        { sourceEtag: "etag-2" },
        { recipientEmail: "someone.else@example.invalid" },
        { organizerEmail: "other.org@example.invalid" },
      ];
      for (const d of drifts) {
        await reviewApprove(f);
        Object.assign(op(f).current, d);
        await f.page.locator(T.send).click();
        await idle(f);
        await sleep(100);
        assert.equal(op(f).posts.length, 0, JSON.stringify(d));
        assert.match(await text(f), /change or its review expired/);
        assert.equal(await exists(f, T.approve), false);
        op(f).current = f.op.base();
      }
    },
  },
  {
    name: "Operation: expired original proof blocks even when a fresh read is ready",
    options: opts,
    async run(f) {
      op(f).rotate = true;
      op(f).current.reviewExpiresAt = new Date(Date.now() + 1500).toISOString();
      await reviewApprove(f);
      await sleep(1800);
      assert.equal(await sendDisabled(f), true);
      assert.equal(op(f).posts.length, 0);
      assert.match(await text(f), /review expired/);
    },
  },
  {
    name: "Operation: unknown write is quarantined read-only, never retried, even if a later read claims ready",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      op(f).failPost = 500;
      await sendClick(f);
      assert.match(await text(f), /Do not retry/);
      assert.equal(await exists(f, T.send), false);
      op(f).current = f.op.base();
      await review(f);
      assert.equal(await exists(f, T.send), false);
      assert.equal(await exists(f, T.approve), false);
      assert.equal(await exists(f, T.ack), false);
      assert.match(await text(f), /Read-only/);
      assert.equal(op(f).posts.length, 1);
    },
  },
  {
    name: "Operation: mismatched receipt is treated as unconfirmed",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      op(f).postPatch = { recipientEmail: "someone.else@example.invalid" };
      await sendClick(f);
      assert.match(await text(f), /Do not retry/);
      assert.equal(await exists(f, T.accepted), false);
    },
  },
  {
    name: "Operation: cancelled native schedule is reachable, derives cancel, and accepted cancel is historical only",
    options: opts,
    async run(f) {
      await setSchedule(f, { status: "cancelled" });
      op(f).current = f.op.base("cancel");
      await f.page.waitForSelector(T.open);
      assert.match(await f.page.$eval(T.open, (n) => n.textContent), /Cancel in Google/);
      await openDialog(f);
      await review(f);
      const t = await text(f);
      assert.match(t, /Cancel event/);
      assert.match(t, /will be cancelled in Google/);
      await approveBoth(f);
      await sendClick(f);
      assert.equal(op(f).posts[0].kind, "cancel");
      const a = await f.page.$eval(T.accepted, (n) => n.textContent);
      assert.match(a, /does not cancel the interview in Lexy/);
      assert.match(a, /cannot\s+be resent or recreated/);
      assert.match(a, /not proof that the guest was notified/);
    },
  },
  {
    name: "Operation: server kind that disagrees with the native status is rejected",
    options: opts,
    async run(f) {
      await setSchedule(f, { status: "cancelled" });
      await openDialog(f);
      op(f).current = f.op.base("reschedule");
      await review(f);
      assert.equal(await exists(f, T.details), false);
      assert.equal(await exists(f, T.error), true);
      assert.equal(op(f).posts.length, 0);
    },
  },
  {
    name: "Operation: needs_review, current and unavailable offer no write path",
    options: opts,
    async run(f) {
      await openDialog(f);
      for (const [status, re] of [
        ["needs_review", /does not prove which operation/],
        ["current", /already matches/],
        ["unavailable", /not available/],
      ]) {
        op(f).current = { ...f.op.base(), status, approvalToken: null, reviewExpiresAt: null };
        await review(f);
        assert.match(await text(f), re);
        assert.equal(await exists(f, T.ack), false);
      }
    },
  },
  {
    name: "Operation: stale reply after schedule edit, focus, actor and tenant change is discarded",
    options: opts,
    async run(f) {
      await openDialog(f);
      let h = f.op.holdGet();
      await f.page.locator(T.review).click();
      await h.started;
      await setSchedule(f, { scheduledAt: "2035-11-02T10:00:00.000Z" });
      h.release();
      await sleep(150);
      assert.equal(await exists(f, T.body), false);
      await setSchedule(f, {});
      await openDialog(f);
      await review(f);
      await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await sleep(80);
      assert.equal(await exists(f, T.approve), false);
      assert.equal(await sendDisabled(f), true);
      await review(f);
      await approveBoth(f);
      await f.switchActor({ ...actor, id: "other-fixture-staff" });
      await f.page.waitForFunction((s) => !document.querySelector(s), {}, T.body);
      await openDialog(f);
      h = f.op.holdGet();
      await f.page.locator(T.review).click();
      await h.started;
      await f.switchActor({ ...actor, tenantId: "other-tenant" });
      h.release();
      await sleep(150);
      assert.equal(await exists(f, T.body), false);
      assert.equal(op(f).posts.length, 0);
    },
  },
  {
    name: "Operation: failed preflight read sends nothing",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      op(f).failGet = 500;
      await f.page.locator(T.send).click();
      await idle(f);
      await sleep(100);
      assert.equal(op(f).posts.length, 0);
      assert.match(await text(f), /Nothing was sent/);
    },
  },
  {
    name: "Operation: mobile layout keeps controls reachable without overflow",
    options: { allowSend: true, width: 375 },
    async run(f) {
      await reviewApprove(f);
      const m = await f.page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        r: document
          .querySelector('[data-testid="button-google-operation-send"]')
          .getBoundingClientRect().right,
      }));
      assert.ok(m.sw <= m.cw, "horizontal overflow");
      assert.ok(m.r <= m.cw + 1);
      assert.equal(op(f).posts.length, 0);
    },
  },
];
