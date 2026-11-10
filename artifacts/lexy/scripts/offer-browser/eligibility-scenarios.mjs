import assert from "node:assert/strict";
import { absent, disabled, state, tid } from "./harness.mjs";

const reason = "A completed, structured human Hire decision is required before preparing an offer.";
export const eligibilityScenarios = [
  ...[
    ["draft", "submit_review"],
    ["review_required", "approve"],
    ["approved", "send"],
  ].map(([status, action]) => ({
    name: `Lost hiring eligibility blocks ${action} while withdrawal remains available`,
    initial: () => state(status, { eligible: false, reason }),
    async run({ page, posts }) {
      await disabled(page, tid(`offer-action-${action}`));
      await absent(page, tid("offer-field-amount"));
      assert.equal(await page.$eval(tid("offer-action-withdraw"), (el) => el.disabled), false);
      assert.ok((await page.$eval("body", (el) => el.textContent)).includes(reason));
      assert.equal(posts.length, 0);
    },
  })),
  ...["eligibility", "sender authority"].map((change) => ({
    name: `Open send confirmation is discarded after losing ${change}`,
    initial: () => state("approved"),
    async run({ page, posts, snapshot }) {
      await page.click(tid("offer-action-send"));
      await page.waitForSelector(tid("offer-confirm"));
      const changed = state("approved");
      if (change === "eligibility") {
        changed.eligible = false;
        changed.reason = reason;
      } else {
        changed.canSend = false;
      }
      // Neither offer version nor workflow revision has changed. The viewer's
      // current authority and eligibility must still invalidate confirmation.
      await snapshot(changed);
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        {},
        tid("offer-confirm"),
      );
      if (change === "eligibility") await disabled(page, tid("offer-action-send"));
      else await absent(page, tid("offer-action-send"));
      assert.equal(posts.length, 0);
    },
  })),
  {
    name: "Open approval and letter acknowledgement reset when approver authority is revoked",
    initial: () => state("review_required"),
    async run({ page, posts, snapshot }) {
      await page.click(tid("offer-action-approve"));
      await page.waitForSelector(tid("offer-confirm"));
      await page.click(tid("offer-approve-letter-check"));
      await snapshot(state("review_required", { canApprove: false }));
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        {},
        tid("offer-confirm"),
      );
      await snapshot(state("review_required"));
      await page.waitForSelector(tid("offer-action-approve"));
      await page.click(tid("offer-action-approve"));
      await disabled(page, tid("offer-confirm-action"));
      assert.equal(await page.$eval(tid("offer-approve-letter-check"), (el) => el.checked), false);
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Existing delivery recovery stays available when the hiring decision is no longer eligible",
    initial: () => {
      const paused = state("send_uncertain", { eligible: false, reason, canReconcile: true });
      paused.offer.deliveryAttemptId = "synthetic-existing-attempt";
      return paused;
    },
    async run({ page, posts }) {
      await absent(page, tid("offer-action-send"));
      await page.click(tid("reconcile-open-check"));
      await page.waitForSelector(tid("reconcile-check-confirm"));
      await disabled(page, tid("reconcile-submit"));
      assert.equal(posts.length, 0);
    },
  },
];
