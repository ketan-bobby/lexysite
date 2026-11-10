import assert from "node:assert/strict";
import { absent, clone, disabled, fill, job, state, tid, value, workflow } from "./harness.mjs";

export const scenarios = [
  {
    name: "Safety guard rejects unknown API routes and non-allowlisted delivery actions",
    initial: () => state("approved"),
    expectedViolations: [
      "Unexpected API request: POST /api/outreach/send",
      "Unexpected action send",
    ],
    async run({ page, posts }) {
      const blocked = await page.evaluate(
        async ({ job, workflow }) => {
          const refused = async (url, options) => {
            try {
              await fetch(url, { ...options, signal: AbortSignal.timeout(3000) });
              return false;
            } catch (error) {
              if (error.name === "TimeoutError") throw error;
              return true;
            }
          };
          const unknown = await refused("/api/outreach/send", {
            method: "POST",
            body: "{}",
          });
          const delivery = await refused(`/api/jobs/${job}/candidate-workflows/${workflow}/offer`, {
            method: "POST",
            body: JSON.stringify({ action: "send", expectedRevision: 10, idempotencyKey: "guard" }),
          });
          return [unknown, delivery];
        },
        { job, workflow },
      );
      assert.deepEqual(blocked, [true, true]);
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Expired replacement is explicit, needs expiry, retains history and never auto-sends",
    initial: () => state("expired"),
    actions: ["save_draft"],
    async run({ page, posts }) {
      await absent(page, tid("offer-field-amount"));
      await page.click(tid("offer-prepare-replacement"));
      await value(page, tid("offer-field-amount"), "120000");
      await value(page, tid("offer-field-expiresAt"), "");
      assert.equal(posts.length, 0);
      await page.click(tid("offer-action-save_draft"));
      await page.waitForFunction(() =>
        document.body.textContent.includes("Choose an expiry date and time."),
      );
      assert.equal(posts.length, 0);
      await fill(page, tid("offer-field-expiresAt"), "2030-03-01T12:00");
      await fill(page, tid("offer-field-amount"), "130000");
      await page.click(tid("offer-action-save_draft"));
      await page.waitForSelector(tid("offer-action-submit_review"));
      await value(page, tid("offer-field-amount"), "130000");
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.expectedRevision, 10);
      assert.equal(posts[0].body.terms.amount, 130000);
      assert.equal(
        await page.$eval(tid("controlled-offer-status"), (el) => el.textContent.trim()),
        "draft",
      );
      assert.doesNotMatch(
        await page.$eval(tid("controlled-offer-approval"), (el) => el.textContent),
        /approved by| · sent /,
      );
      await absent(page, tid("offer-action-send"));
      await absent(page, tid("offer-action-approve"));
      const history = await page.$eval(tid("controlled-offer-history"), (el) => el.textContent);
      assert.match(history, /expired/);
      assert.match(history, /120000/);
    },
  },
  {
    name: "Withdrawn replacement can be discarded without any request",
    initial: () => state("withdrawn"),
    async run({ page, posts }) {
      await page.click(tid("offer-prepare-replacement"));
      await fill(page, tid("offer-field-amount"), "135000");
      await page.waitForSelector(tid("offer-action-discard"));
      await page.click(tid("offer-action-discard"));
      await page.waitForSelector(tid("offer-prepare-replacement"));
      await absent(page, tid("offer-field-amount"));
      assert.equal(posts.length, 0);
    },
  },
  ...["sent", "sending", "send_uncertain", "accepted", "declined"].map((status) => ({
    name: `${status} offers never expose replacement or edit shortcuts`,
    initial: () => state(status),
    async run({ page, posts }) {
      await absent(page, tid("offer-prepare-replacement"));
      await absent(page, tid("offer-field-amount"));
      await absent(page, tid("offer-action-save_draft"));
      assert.equal(posts.length, 0);
    },
  })),
  ...[{ canEdit: false }, { eligible: false, reason: "Current human Hire review is missing." }].map(
    (permissions) => ({
      name: `Replacement respects ${permissions.canEdit === false ? "edit ownership" : "eligibility"}`,
      initial: () => state("expired", permissions),
      async run({ page, posts }) {
        await absent(page, tid("offer-prepare-replacement"));
        await absent(page, tid("offer-field-amount"));
        await page.waitForSelector(tid("controlled-offer-terms"));
        if (permissions.reason)
          assert.ok(
            (await page.$eval("body", (el) => el.textContent)).includes(permissions.reason),
          );
        assert.equal(posts.length, 0);
      },
    }),
  ),
  {
    name: "Concurrent replacement preserves local edits, blocks save, then uses latest revision",
    initial: () => state("expired"),
    actions: ["save_draft"],
    async run({ page, posts, snapshot }) {
      await page.click(tid("offer-prepare-replacement"));
      await fill(page, tid("offer-field-amount"), "140000");
      await fill(page, tid("offer-field-expiresAt"), "2030-03-01T12:00");
      const latest = state("withdrawn", { workflowRevision: 52 });
      latest.offer.version = 3;
      latest.offer.terms.amount = 125000;
      await snapshot(latest);
      await page.waitForSelector(tid("offer-draft-conflict"));
      await value(page, tid("offer-field-amount"), "140000");
      await disabled(page, tid("offer-action-save_draft"));
      await page.click(tid("offer-draft-keep"));
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        {},
        tid("offer-draft-conflict"),
      );
      assert.equal(posts.length, 0);
      await page.click(tid("offer-action-save_draft"));
      await page.waitForSelector(tid("offer-action-submit_review"));
      await value(page, tid("offer-field-amount"), "140000");
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.expectedRevision, 52);
      assert.match(
        await page.$eval(tid("controlled-offer"), (el) => el.textContent),
        /[Vv]ersion 4/,
      );
    },
  },
  {
    name: "Load latest discards conflicting edits without writing",
    initial: () => state(),
    async run({ page, posts, snapshot }) {
      await fill(page, tid("offer-field-amount"), "140000");
      const latest = state();
      latest.offer.version = 2;
      latest.offer.terms.amount = 125000;
      latest.workflowRevision = 11;
      await snapshot(latest);
      await page.waitForSelector(tid("offer-draft-conflict"));
      await page.click(tid("offer-draft-load-latest"));
      await value(page, tid("offer-field-amount"), "125000");
      await absent(page, tid("offer-draft-conflict"));
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Changing workflow resets prepared replacement and unsaved terms",
    initial: () => state("expired"),
    async run({ page, posts, snapshot }) {
      await page.click(tid("offer-prepare-replacement"));
      await fill(page, tid("offer-field-amount"), "999999");
      const other = state("withdrawn");
      other.offer.id = "synthetic-other-offer";
      await snapshot(other, `${job}-other`, `${workflow}-other`);
      await page.waitForSelector(tid("offer-prepare-replacement", `${workflow}-other`));
      await absent(page, tid("offer-field-amount", `${workflow}-other`));
      await absent(page, tid("controlled-offer"));
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Read-only approver sees full terms but cannot edit or send",
    initial: () => state("review_required", { canEdit: false, canSend: false, canWithdraw: false }),
    async run({ page, posts }) {
      const text = await page.$eval(tid("controlled-offer-terms"), (el) => el.textContent);
      assert.match(text, /120000/);
      assert.match(text, /Synthetic manual offer letter/);
      await absent(page, tid("offer-field-amount"));
      await absent(page, tid("offer-action-save_draft"));
      await absent(page, tid("offer-action-send"));
      await page.click(tid("offer-action-approve"));
      await page.waitForSelector(tid("offer-confirm-action"));
      await disabled(page, tid("offer-confirm-action"));
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Human submission, letter check, approval and send remain distinct actions",
    initial: () => state(),
    actions: ["submit_review", "approve", "send"],
    async run({ page, posts }) {
      await page.click(tid("offer-action-submit_review"));
      await page.waitForSelector(tid("offer-action-approve"));
      assert.deepEqual(
        posts.map((p) => p.body.action),
        ["submit_review"],
      );
      await page.click(tid("offer-action-approve"));
      await page.waitForSelector(tid("offer-confirm-action"));
      await disabled(page, tid("offer-confirm-action"));
      await page.click(tid("offer-approve-letter-check"));
      await page.click(tid("offer-confirm-action"));
      await page.waitForSelector(tid("offer-action-send"));
      assert.deepEqual(
        posts.map((p) => p.body.action),
        ["submit_review", "approve"],
      );
      await page.click(tid("offer-action-send"));
      await page.waitForSelector(tid("offer-confirm-action"));
      assert.equal(posts.length, 2, "Opening send confirmation must not send");
      await page.click(tid("offer-confirm-action"));
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.textContent.trim() === "sent",
        {},
        tid("controlled-offer-status"),
      );
      assert.deepEqual(
        posts.map((p) => p.body.action),
        ["submit_review", "approve", "send"],
      );
      assert.deepEqual(
        posts.map((p) => p.body.expectedRevision),
        [10, 11, 12],
      );
      await absent(page, tid("offer-field-amount"));
    },
  },
  {
    name: "Unsaved edits cannot approve, submit or send an earlier saved version",
    initial: () => state("approved"),
    async run({ page, posts }) {
      await fill(page, tid("offer-field-amount"), "140000");
      await page.waitForSelector(tid("controlled-offer-dirty"));
      await disabled(page, tid("offer-action-send"));
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Past expiry is rejected locally, preserving replacement edits",
    initial: () => state("withdrawn"),
    async run({ page, posts }) {
      await page.click(tid("offer-prepare-replacement"));
      await fill(page, tid("offer-field-amount"), "145000");
      await fill(page, tid("offer-field-expiresAt"), "2000-01-01T12:00");
      await page.click(tid("offer-action-save_draft"));
      await page.waitForFunction(() =>
        document.body.textContent.includes("Offer expiry must be a valid future date."),
      );
      await value(page, tid("offer-field-amount"), "145000");
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Failed save preserves edits and retry reuses idempotency then shows saved terms",
    initial: () => state(),
    actions: ["save_draft"],
    async run({ page, posts, failNextSave }) {
      await fill(page, tid("offer-field-amount"), "150000");
      await page.waitForSelector(tid("controlled-offer-dirty"));
      failNextSave();
      await page.click(tid("offer-action-save_draft"));
      await page.waitForFunction(
        (selector) =>
          document.querySelector(selector)?.textContent.includes("Synthetic save conflict"),
        {},
        tid("controlled-offer-action-error"),
      );
      await value(page, tid("offer-field-amount"), "150000");
      await disabled(page, tid("offer-action-submit_review"));
      assert.equal(posts.length, 1);
      await page.click(tid("offer-action-save_draft"));
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        {},
        tid("controlled-offer-dirty"),
      );
      await value(page, tid("offer-field-amount"), "150000");
      assert.equal(posts.length, 2);
      assert.equal(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
      assert.equal(posts[1].body.expectedRevision, 10);
      await absent(page, tid("offer-action-send"));
    },
  },
  {
    name: "Mobile replacement form stays within viewport",
    initial: () => state("expired"),
    width: 390,
    async run({ page, posts }) {
      await page.click(tid("offer-prepare-replacement"));
      await value(page, tid("offer-field-expiresAt"), "");
      await page.waitForSelector(tid("offer-action-save_draft"));
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      assert.equal(posts.length, 0);
    },
  },
];

// Avoid sharing mutated snapshots across cases.
export const initialFor = (scenario) => clone(scenario.initial());
