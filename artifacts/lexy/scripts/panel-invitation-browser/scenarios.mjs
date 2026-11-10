import assert from "node:assert/strict";
import { actor, clone, initialStatus, schedule, tid } from "./harness.mjs";

const button = (name) => tid(`button-${name}-panel-invitation`);
const confirm = button("confirm-send");
const review = button("review");
const reload = button("reload");
const details = tid("text-panel-invitation-details");
const reviewed = tid("text-panel-review");
const accepted = tid("text-panel-invitation-accepted");
const error = tid("text-panel-invitation-error");
const waitAbsent = (page, selector) =>
  page.waitForFunction((s) => !document.querySelector(s), {}, selector);
const waitDisabled = (page, selector, disabled = true) =>
  page.waitForFunction((s, d) => document.querySelector(s)?.disabled === d, {}, selector, disabled);
const text = (page, selector) => page.$eval(selector, (el) => el.textContent);

export async function openStatus(page) {
  await page.locator(tid(`button-panel-invitation-${schedule.id}`)).click();
  await page.waitForSelector(details, { visible: true });
}
async function openReview(page) {
  await waitDisabled(page, review, false);
  await page.locator(review).click();
  await page.waitForSelector(reviewed, { visible: true });
}
async function cancel(page) {
  await page.$eval(reviewed, (el) => {
    [...el.closest('[role="dialog"]').querySelectorAll("button")]
      .find((b) => b.textContent === "Cancel")
      .click();
  });
  await waitAbsent(page, reviewed);
}
async function backgroundReload(page) {
  // Deliberately exercise the real reload handler while a review is open.
  // Radix normally blocks pointer access to the underlying dialog. This is an
  // injected background read, not a claim that users can click through a modal.
  await page.$eval(reload, (el) => el.click());
  await waitAbsent(page, reviewed);
}

export const scenarios = [
  {
    name: "mount, read, review, cancel and reopen never send",
    async run(f) {
      assert.equal(f.posts.length, 0);
      await openStatus(f.page);
      await openReview(f.page);
      const shown = await text(f.page, reviewed);
      for (const value of [
        initialStatus.organizerEmail,
        initialStatus.recipientEmail,
        "Panel One",
        "one@example.invalid",
        "Panel Two",
        "two@example.invalid",
        "2035",
        "60 minutes",
      ])
        assert.ok(shown.includes(value), `Missing reviewed detail: ${value}`);
      await cancel(f.page);
      await f.page.keyboard.press("Escape");
      await openStatus(f.page);
      await f.page.evaluate(() => window.fixture.advanceClock(10_000));
      assert.equal(f.posts.length, 0);
    },
  },
  {
    name: "explicit delayed double-click sends once; receipt survives reload and reopen",
    options: { allowSend: true },
    async run(f) {
      const release = f.holdSend();
      await openStatus(f.page);
      await openReview(f.page);
      await f.page.$eval(confirm, (el) => {
        el.click();
        el.click();
      });
      await waitDisabled(f.page, confirm);
      assert.equal(f.posts.length, 1);
      assert.deepEqual(f.posts[0], {
        confirm: true,
        expectedVersion: schedule.version,
        expectedApprovalToken: initialStatus.approvalToken,
      });
      release();
      await f.page.waitForSelector(accepted);
      const receipt = await text(f.page, accepted);
      assert.match(receipt, /not proof of email delivery/);
      assert.match(receipt, /not acceptance by the candidate or any panel/);
      await f.page.keyboard.press("Escape");
      await openStatus(f.page);
      await f.page.waitForSelector(accepted);
      await f.reload();
      await openStatus(f.page);
      await f.page.waitForSelector(accepted);
      await waitDisabled(f.page, review);
      assert.equal(f.posts.length, 1);
    },
  },
  {
    name: "409 and 503 reads discard cached approval and block sending",
    async run(f) {
      await openStatus(f.page);
      await waitDisabled(f.page, review, false);
      for (const status of [409, 503]) {
        f.failNextRead(status);
        await f.page.click(reload);
        await f.page.waitForSelector(error);
        await waitAbsent(f.page, details);
        await waitDisabled(f.page, review);
        assert.equal(f.posts.length, 0);
      }
    },
  },
  {
    name: "an expired read closes an open review; only deliberate reload restores review",
    async run(f) {
      await openStatus(f.page);
      await openReview(f.page);
      const before = f.reads.length;
      await f.page.evaluate(() => window.fixture.advanceClock(95_000));
      await waitAbsent(f.page, reviewed);
      await waitDisabled(f.page, review);
      assert.equal(f.reads.length, before, "The clock must not automatically refresh or send");
      await f.page.click(reload);
      await waitDisabled(f.page, review, false);
      await waitAbsent(f.page, reviewed);
      assert.equal(f.posts.length, 0);
    },
  },
  ...["token", "recipient"].map((kind) => ({
    name: `changed GET ${kind} cancels open approval and requires review of new details`,
    options: { allowSend: true },
    async run(f) {
      await openStatus(f.page);
      await openReview(f.page);
      const changed = clone(initialStatus);
      if (kind === "token") changed.approvalToken = "c".repeat(64);
      else changed.panelRecipients[0].email = "changed@example.invalid";
      f.snapshot(changed);
      const held = f.holdNextRead();
      await backgroundReload(f.page);
      await held.started;
      await waitDisabled(f.page, review);
      assert.equal(f.posts.length, 0);
      held.release();
      await waitDisabled(f.page, review, false);
      await waitAbsent(f.page, reviewed);
      await openReview(f.page);
      if (kind === "recipient")
        assert.ok((await text(f.page, reviewed)).includes("changed@example.invalid"));
      await f.page.click(confirm);
      await f.page.waitForSelector(accepted);
      assert.equal(f.posts.length, 1);
      assert.equal(f.posts[0].expectedApprovalToken, changed.approvalToken);
    },
  })),
  ...["ambiguous", "token_mismatch", "roster_mismatch"].map((outcome) => ({
    name: `${outcome} response cannot show success or trigger retry; read-only recovery works`,
    options: { allowSend: true, outcome },
    async run(f) {
      await openStatus(f.page);
      await openReview(f.page);
      await f.page.click(confirm);
      await f.page.waitForSelector(error);
      await waitAbsent(f.page, accepted);
      await waitAbsent(f.page, reviewed);
      await waitDisabled(f.page, review);
      assert.match(await text(f.page, error), /Do not resend/);
      await f.page.evaluate(() => {
        window.fixture.advanceClock(10_000);
        window.dispatchEvent(new Event("focus"));
      });
      assert.equal(f.posts.length, 1);
      await f.page.click(reload);
      await f.page.waitForSelector(accepted);
      await f.reload();
      await openStatus(f.page);
      await f.page.waitForSelector(accepted);
      assert.equal(f.posts.length, 1);
    },
  })),
  {
    name: "a non-accepted receipt remains read-only after reload",
    options: { allowSend: true, outcome: "not_accepted" },
    async run(f) {
      await openStatus(f.page);
      await openReview(f.page);
      await f.page.click(confirm);
      await f.page.waitForSelector(error);
      await waitDisabled(f.page, review);
      await f.page.click(reload);
      await waitDisabled(f.page, review);
      await waitAbsent(f.page, accepted);
      assert.equal(f.posts.length, 1);
    },
  },
  {
    name: "late GET from a prior staff session cannot restore its dialog or approval",
    async run(f) {
      await openStatus(f.page);
      const held = f.holdNextRead();
      await f.page.click(reload);
      await held.started;
      await f.switchActor({ ...actor, id: "panel-ui-fixture-other-staff" });
      await waitAbsent(f.page, details);
      f.snapshot({ ...initialStatus, organizerEmail: "other-organizer@example.invalid" });
      await openStatus(f.page);
      await waitDisabled(f.page, review, false);
      const completed = f.page.waitForResponse(
        (r) => r.request().method() === "GET" && r.url().endsWith("/panel-invitation"),
      );
      held.release();
      await completed;
      await f.page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      assert.match(await text(f.page, details), /other-organizer@example.invalid/);
      assert.equal(f.posts.length, 0);
    },
  },
  {
    name: "schedule revision changes invalidate the open review",
    async run(f) {
      await openStatus(f.page);
      await openReview(f.page);
      const next = { ...schedule, version: `v1_${"d".repeat(64)}` };
      await f.page.evaluate((s) => window.fixture.switchSchedule(s), next);
      await waitAbsent(f.page, reviewed);
      await waitAbsent(f.page, details);
      assert.equal(f.posts.length, 0);
    },
  },
  {
    name: "390px review keeps recipients and confirmation controls reachable",
    options: { allowSend: true, width: 390 },
    async run(f) {
      await openStatus(f.page);
      await openReview(f.page);
      const shape = await f.page.$eval(reviewed, (el) => {
        const rect = el.closest('[role="dialog"]').getBoundingClientRect();
        return { left: rect.left, right: rect.right, width: innerWidth };
      });
      assert.ok(shape.left >= 0 && shape.right <= shape.width + 1);
      assert.match(await text(f.page, reviewed), /two@example.invalid/);
      await f.page.$eval(confirm, (el) => el.scrollIntoView({ block: "center" }));
      await f.page.click(confirm);
      await f.page.waitForSelector(accepted);
      assert.equal(f.posts.length, 1);
    },
  },
  {
    name: "network guard denies unknown API writes on the first and additional pages",
    expectedViolations: [
      "Unexpected API request",
      "Unexpected API request",
      "Non-API write blocked",
      "Unapproved send blocked",
    ],
    async run(f) {
      const extra = await f.extraPage();
      for (const page of [f.page, extra]) {
        const denied = await page.evaluate(async () => {
          try {
            await fetch("/api/webhooks/inbound-email", { method: "POST", body: "{}" });
            return false;
          } catch {
            return true;
          }
        });
        assert.equal(denied, true);
      }
      const denied = await f.page.evaluate(async () => {
        try {
          await fetch("/not-an-api", { method: "POST", body: "{}" });
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(denied, true);
      const unapproved = await f.page.evaluate(async (id) => {
        try {
          await fetch(`/api/outlook-calendar/schedules/${id}/panel-invitation`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          return false;
        } catch {
          return true;
        }
      }, schedule.id);
      assert.equal(unapproved, true);
      const external = await f.page.evaluate(async () => {
        try {
          await fetch("https://provider.example.invalid/api");
          return false;
        } catch {
          return true;
        }
      });
      assert.equal(external, true);
      assert.equal(f.posts.length, 0);
    },
  },
];
