import assert from "node:assert/strict";
import { test } from "node:test";
import { offerInboxNeedsAction } from "./offer-inbox-action";

for (const action of ["prepare", "review", "send", "blocked"] as const) {
  test(`offer inbox retains ${action} in Needs action`, () => {
    assert.equal(offerInboxNeedsAction(action), true);
  });
}

test("manual external handoff needs human action and is not hidden by default", () => {
  assert.equal(offerInboxNeedsAction("external_handoff"), true);
});

test("monitor-only offers stay available in All loaded, not Needs action", () => {
  assert.equal(offerInboxNeedsAction("monitor"), false);
});
