import assert from "node:assert/strict";
import { absent, disabled, fill, state, tid } from "./harness.mjs";

function uncertain(overrides = {}) {
  const snapshot = state("send_uncertain", { canReconcile: true, ...overrides });
  snapshot.offer.deliveryAttemptId = "synthetic-delivery-attempt";
  snapshot.offer.approvedBy = "synthetic-approver";
  return snapshot;
}
export const reconciliationScenarios = [
  {
    name: "Uncertain delivery evidence check requires explicit confirmation and never resends",
    initial: () => uncertain(),
    actions: ["reconcile_delivery"],
    async run({ page, posts }) {
      await absent(page, tid("offer-action-send"));
      await page.click(tid("reconcile-open-check"));
      await disabled(page, tid("reconcile-submit"));
      assert.equal(posts.length, 0);
      await page.click(tid("reconcile-check-confirm"));
      await page.click(tid("reconcile-submit"));
      await page.waitForSelector(tid("delivery-reconcile-result"));
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.deliveryResolution, "check_provider");
      assert.equal(posts[0].body.deliveryAttemptId, "synthetic-delivery-attempt");
      await absent(page, tid("offer-action-send"));
      assert.match(
        await page.$eval(tid("delivery-reconcile-result"), (el) => el.textContent),
        /Still uncertain. Do not resend./,
      );
    },
  },
  {
    name: "Human settlement requires reason, evidence and acknowledgements, then clears approval",
    initial: () => uncertain(),
    actions: ["reconcile_delivery"],
    async run({ page, posts }) {
      await page.click(tid("reconcile-open-settle"));
      await disabled(page, tid("reconcile-submit"));
      await fill(
        page,
        tid("reconcile-reason"),
        "Synthetic provider confirmed request never accepted.",
      );
      await fill(page, tid("reconcile-evidence"), "Synthetic provider case reference.");
      await disabled(page, tid("reconcile-submit"));
      await page.click(tid("reconcile-ack"));
      await disabled(page, tid("reconcile-submit"));
      assert.equal(posts.length, 0);
      await page.click(tid("reconcile-review"));
      await page.waitForSelector(tid("reconcile-confirm-dialog"));
      await page.click(tid("reconcile-submit"));
      await page.waitForSelector(tid("offer-action-submit_review"));
      assert.equal(posts.length, 1);
      assert.equal(posts[0].body.deliveryResolution, "confirmed_not_sent");
      assert.equal(posts[0].body.acknowledgeNoDelivery, true);
      await absent(page, tid("offer-action-send"));
      await absent(page, tid("offer-action-approve"));
      assert.doesNotMatch(
        await page.$eval(tid("controlled-offer-approval"), (el) => el.textContent),
        /approved by/,
      );
    },
  },
  {
    name: "Reconciliation confirmation cannot act on a changed attempt or revision",
    initial: () => uncertain(),
    async run({ page, posts, snapshot }) {
      await page.click(tid("reconcile-open-check"));
      await page.click(tid("reconcile-check-confirm"));
      const changed = uncertain();
      changed.workflowRevision++;
      changed.offer.deliveryAttemptId = "synthetic-new-attempt";
      await snapshot(changed);
      await page.waitForSelector(tid("reconcile-stale"));
      await disabled(page, tid("reconcile-submit"));
      assert.equal(posts.length, 0);
      await page.click(tid("reconcile-discard"));
      await absent(page, tid("reconcile-submit"));
      await page.click(tid("reconcile-open-check"));
      await disabled(page, tid("reconcile-submit"));
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Only designated recovery staff can open reconciliation controls",
    initial: () => uncertain({ canReconcile: false }),
    async run({ page, posts }) {
      await page.waitForSelector(tid("delivery-reconcile"));
      await absent(page, tid("reconcile-open-check"));
      await absent(page, tid("reconcile-open-settle"));
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Legacy uncertain offers without a delivery attempt remain held",
    initial: () => {
      const snapshot = uncertain();
      delete snapshot.offer.deliveryAttemptId;
      return snapshot;
    },
    async run({ page, posts }) {
      await page.waitForSelector(tid("delivery-reconcile-legacy"));
      await absent(page, tid("reconcile-open-check"));
      await absent(page, tid("reconcile-open-settle"));
      await absent(page, tid("offer-action-send"));
      assert.equal(posts.length, 0);
    },
  },
];
