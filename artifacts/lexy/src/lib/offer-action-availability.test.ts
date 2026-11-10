import assert from "node:assert/strict";
import { test } from "node:test";
import { canControlOffer } from "./offer-action-availability";

const eligible = {
  eligible: true,
  canEdit: true,
  canApprove: true,
  canSend: true,
  canWithdraw: true,
  canReconcile: true,
};
for (const [action, permission] of [
  ["save_draft", "canEdit"],
  ["submit_review", "canEdit"],
  ["approve", "canApprove"],
  ["send", "canSend"],
  ["withdraw", "canWithdraw"],
  ["reconcile_delivery", "canReconcile"],
] as const) {
  test(`offer action ${action}: current designated authority is required`, () => {
    assert.equal(canControlOffer(action, eligible), true);
    assert.equal(canControlOffer(action, { ...eligible, [permission]: false }), false);
  });
}
for (const action of ["save_draft", "submit_review", "approve", "send"] as const) {
  test(`offer action ${action}: paused hiring eligibility blocks advancement`, () => {
    assert.equal(canControlOffer(action, { ...eligible, eligible: false }), false);
  });
}
for (const action of ["withdraw", "reconcile_delivery"] as const) {
  test(`offer action ${action}: recovery remains possible when hiring eligibility is lost`, () => {
    assert.equal(canControlOffer(action, { ...eligible, eligible: false }), true);
  });
}
test("offer recovery: absent reconciliation permission is not authority", () => {
  assert.equal(
    canControlOffer("reconcile_delivery", { ...eligible, canReconcile: undefined }),
    false,
  );
});
