import assert from "node:assert/strict";
import { actor, schedule, tid } from "./harness.mjs";
import { MEET } from "./google-invite-api.mjs";

const T = {
  open: tid(`button-google-invitation-${schedule.id}`),
  body: tid("google-invite-body"),
  review: tid("button-google-invite-review"),
  approve: tid("checkbox-google-invite-approve"),
  send: tid("button-google-invite-send"),
  details: tid("text-google-invite-details"),
  error: tid("text-google-invite-error"),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (f) => f.page.$eval(T.body, (n) => n.textContent);
const exists = (f, sel) => f.page.$(sel).then(Boolean);
const idle = (f) =>
  f.page.waitForFunction((r) => !document.querySelector(r)?.disabled, {}, T.review);
async function openDialog(f) {
  if (!(await f.page.$(T.body))) await f.page.locator(T.open).click();
  await f.page.waitForSelector(T.body);
}
async function review(f) {
  await f.page.locator(T.review).click();
  await f.page.waitForFunction((r) => !document.querySelector(r)?.disabled, {}, T.review);
  await sleep(50);
}
async function reviewApprove(f) {
  await openDialog(f);
  await review(f);
  await f.page.waitForSelector(T.approve);
  await f.page.locator(T.approve).click();
}
async function sendClick(f) {
  await f.page.locator(T.send).click();
  await idle(f);
  await sleep(80);
}
const opts = { allowSend: true };
const inv = (f) => f.invite.state;

export const googleInviteScenarios = [
  {
    name: "Invite: no read on mount or open; Review is GET-only and shows exact details, gated send",
    options: opts,
    async run(f) {
      await f.page.waitForSelector(T.open);
      await openDialog(f);
      await sleep(150);
      assert.equal(inv(f).gets, 0);
      await review(f);
      assert.equal(inv(f).gets, 1);
      assert.equal(inv(f).posts.length, 0);
      const t = await text(f);
      for (const s of [
        "candidate@example.invalid",
        "organizer@example.invalid",
        "Backend Engineer",
        "60 minutes",
        "may email the candidate",
        "every panel recipient listed above",
        "Guest-list visibility is disabled",
      ])
        assert.ok(t.includes(s), `missing ${s}`);
      assert.equal(await f.page.$eval(T.send, (n) => n.disabled), true);
      await f.page.locator(T.approve).click();
      assert.equal(await f.page.$eval(T.send, (n) => n.disabled), false);
      assert.equal(inv(f).posts.length, 0);
    },
  },
  {
    name: "Invite: approved send re-reads first, posts exactly once, shows Meet and not-delivery wording",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      await sendClick(f);
      assert.equal(inv(f).gets, 2);
      assert.equal(inv(f).posts.length, 1);
      assert.deepEqual(inv(f).posts[0], {
        confirm: true,
        expectedVersion: schedule.version,
        expectedApprovalToken: "approval-token-1",
        reviewExpiresAt: inv(f).posts[0].reviewExpiresAt,
      });
      const t = await text(f);
      assert.match(t, /not proof of email delivery/);
      assert.equal(await f.page.$eval(`${T.body} a`, (a) => a.href), MEET);
      assert.equal(await exists(f, T.send), false);
    },
  },
  {
    name: "Invite: rotated proof on pre-send read still posts once with the ORIGINAL proof",
    options: opts,
    async run(f) {
      inv(f).rotate = true;
      await reviewApprove(f);
      await sendClick(f);
      assert.equal(inv(f).gets, 2);
      assert.equal(inv(f).posts.length, 1);
      assert.equal(inv(f).posts[0].expectedApprovalToken, "approval-token-1");
      assert.equal(inv(f).posts[0].reviewExpiresAt, inv(f).firstGet.reviewExpiresAt);
      assert.match(await text(f), /not proof of email delivery/);
    },
  },
  {
    name: "Invite: expired original proof blocks even when a fresh read is ready",
    options: opts,
    async run(f) {
      inv(f).rotate = true;
      inv(f).current.reviewExpiresAt = new Date(Date.now() + 1500).toISOString();
      await reviewApprove(f);
      // Hold the approval click window open past expiry without the timer clearing it first.
      await sleep(1700);
      assert.equal(await f.page.$eval(T.send, (n) => n.disabled), true);
      assert.equal(inv(f).posts.length, 0);
    },
  },
  {
    name: "Invite: double click sends once",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      const h = f.invite.hold();
      await f.page.$eval(T.send, (n) => (n.click(), n.click()));
      await h.started;
      await sleep(150);
      assert.equal(inv(f).posts.length, 1);
      h.release();
      await idle(f);
      await sleep(100);
      assert.equal(inv(f).posts.length, 1);
    },
  },
  {
    name: "Invite: expired review clears approval and cannot send",
    options: opts,
    async run(f) {
      inv(f).current.reviewExpiresAt = new Date(Date.now() + 900).toISOString();
      await reviewApprove(f);
      await sleep(1300);
      assert.equal(await exists(f, T.send), true);
      assert.equal(await f.page.$eval(T.send, (n) => n.disabled), true);
      assert.equal(await exists(f, T.approve), false);
      assert.match(await text(f), /expired/i);
      assert.equal(inv(f).posts.length, 0);
    },
  },
  {
    name: "Invite: changed recipient or connection between review and click blocks the post",
    options: opts,
    async run(f) {
      for (const patch of [
        { recipientEmail: "someone.else@example.invalid" },
        { connectionRevision: "rev-2" },
      ]) {
        await reviewApprove(f);
        Object.assign(inv(f).current, patch);
        await f.page.locator(T.send).click();
        await idle(f);
        await sleep(100);
        assert.equal(inv(f).posts.length, 0);
        assert.match(await text(f), /changed or expired/);
        assert.equal(await exists(f, T.approve), false);
        inv(f).current = f.invite.base();
      }
    },
  },
  {
    name: "Invite: failed preflight read sends nothing; failed initial read shows no details",
    options: opts,
    async run(f) {
      await openDialog(f);
      inv(f).failGet = 500;
      await review(f);
      assert.equal(await exists(f, T.details), false);
      assert.equal(await exists(f, T.error), true);
      await review(f);
      await f.page.locator(T.approve).click();
      inv(f).failGet = 500;
      await f.page.locator(T.send).click();
      await idle(f);
      await sleep(100);
      assert.equal(inv(f).posts.length, 0);
      assert.match(await text(f), /Nothing was sent/);
    },
  },
  {
    name: "Invite: uncertain post forbids resend; refresh is read-only even if status claims ready",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      inv(f).failPost = 500;
      await sendClick(f);
      assert.match(await text(f), /Do not resend/);
      assert.equal(await exists(f, T.send), false);
      assert.equal(await exists(f, T.approve), false);
      inv(f).current = f.invite.base();
      await review(f);
      assert.equal(await exists(f, T.send), false);
      assert.equal(await exists(f, T.approve), false);
      assert.match(await text(f), /read-only/);
      assert.equal(inv(f).posts.length, 1);
    },
  },
  {
    name: "Invite: pending and failed Meet are never shown as a link or as success of Meet",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      inv(f).postPatch = { conferenceStatus: "pending", meetUrl: null };
      await sendClick(f);
      assert.match(await text(f), /still creating the Meet link/);
      assert.equal(await exists(f, `${T.body} a[href^="http"]`), false);
      inv(f).current = { ...inv(f).current, conferenceStatus: "failed", meetUrl: null };
      await review(f);
      assert.match(await text(f), /did not create a Meet link/);
      assert.equal(await exists(f, `${T.body} a[href^="http"]`), false);
    },
  },
  {
    name: "Invite: unsafe or lookalike Meet URLs are rejected",
    options: opts,
    async run(f) {
      await openDialog(f);
      for (const u of [
        "http://meet.google.com/abc-defg-hij",
        "https://meet.google.com.evil.example/abc-defg-hij",
        "https://meet.google.com/abc-defg-hij?authuser=1",
        "javascript:alert(1)",
        "https://evil.example/abc-defg-hij",
        "https://meet.google.com/abc-defg-hij/",
      ]) {
        inv(f).current = {
          ...f.invite.base(),
          status: "accepted",
          acceptedAt: "2035-10-01T09:00:00.000Z",
          approvalToken: null,
          reviewExpiresAt: null,
          conferenceStatus: "ready",
          meetUrl: u,
        };
        await review(f);
        assert.equal(await exists(f, `${T.body} a[href^="http"]`), false, u);
        assert.equal(await exists(f, tid("text-google-invite-accepted")), false, u);
      }
      assert.equal(inv(f).posts.length, 0);
    },
  },
  {
    name: "Invite: foreign provider or recipient in the receipt is treated as unconfirmed",
    options: opts,
    async run(f) {
      for (const patch of [
        { provider: "microsoft" },
        { recipientEmail: "someone.else@example.invalid" },
      ]) {
        await reviewApprove(f);
        inv(f).postPatch = patch;
        await sendClick(f);
        assert.match(await text(f), /Do not resend/);
        assert.equal(await exists(f, tid("text-google-invite-accepted")), false);
        assert.equal(await exists(f, T.send), false);
        await f.page.reload();
        await f.page.waitForFunction(() => typeof window.mountFixture === "function");
        await f.page.evaluate((s) => {
          window.fixture = window.mountFixture(document.getElementById("root"), s);
        }, schedule);
        await f.page.waitForSelector(T.open);
        inv(f).current = f.invite.base();
        inv(f).postPatch = null;
        inv(f).posts.length = 0;
      }
    },
  },
  {
    name: "Invite: focus and auth/identity changes clear approval",
    options: opts,
    async run(f) {
      await reviewApprove(f);
      await f.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await sleep(80);
      assert.equal(await exists(f, T.approve), false);
      assert.equal(await f.page.$eval(T.send, (n) => n.disabled), true);
      await review(f);
      await f.page.locator(T.approve).click();
      await f.switchActor({ ...actor, id: "other-fixture-staff" });
      await f.page.waitForFunction((s) => !document.querySelector(s), {}, T.body);
      assert.equal(inv(f).posts.length, 0);
      await f.switchActor({ ...actor, tenantId: "other-tenant" });
      await sleep(100);
      assert.equal(await exists(f, T.body), false);
    },
  },
  {
    name: "Invite: saved panel and other provider are honest, with no send path",
    options: opts,
    async run(f) {
      await openDialog(f);
      inv(f).current = {
        ...f.invite.base(),
        status: "unavailable",
        reason: "panel_unsupported",
        approvalToken: null,
        reviewExpiresAt: null,
      };
      await review(f);
      assert.match(await text(f), /not a current, authorized Google panel/);
      assert.equal(await exists(f, T.approve), false);
      inv(f).current = {
        ...f.invite.base(),
        status: "blocked_other_provider",
        reason: "another_provider",
        approvalToken: null,
        reviewExpiresAt: null,
      };
      await review(f);
      assert.match(await text(f), /another calendar provider/);
      assert.equal(await exists(f, T.approve), false);
    },
  },
  {
    name: "Invite: mobile layout keeps controls reachable without overflow",
    options: { allowSend: true, width: 375 },
    async run(f) {
      await reviewApprove(f);
      const m = await f.page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
        r: document
          .querySelector('[data-testid="button-google-invite-send"]')
          .getBoundingClientRect().right,
      }));
      assert.ok(m.sw <= m.cw, "horizontal overflow");
      assert.ok(m.r <= m.cw + 1);
      assert.equal(inv(f).posts.length, 0);
    },
  },
];
