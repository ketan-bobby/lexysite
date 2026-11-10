import assert from "node:assert/strict";
import test from "node:test";
import { campaignDeliveryEvidence } from "./zoho-campaign-delivery-evidence";

test("delivery evidence never treats claims, missing receipts or simulations as delivery", () => {
  const updatedAt = new Date("2026-11-02T00:00:00Z");
  const base = { reason: null, messageId: null, updatedAt };
  for (const state of ["sending", "review_required", "preparing", "sent", "blocked"]) {
    const result = campaignDeliveryEvidence({ ...base, state });
    assert.equal(result.acceptance, "unknown");
    assert.equal(result.delivery, "unverified");
    assert.equal(result.needsReview, ["sending", "review_required"].includes(state));
    assert.equal(result.lastStateChangeAt, updatedAt);
  }
  for (const reason of ["interrupted_attempt", "delivery_uncertain"]) {
    const result = campaignDeliveryEvidence({
      ...base,
      state: "review_required",
      reason,
      messageId: "unconfirmed-reference",
    });
    assert.equal(result.acceptance, "unknown");
    assert.equal(result.providerMessageId, "unconfirmed-reference");
    assert.equal(result.needsReview, true);
  }
  assert.equal(
    campaignDeliveryEvidence({ ...base, state: "simulated", messageId: "fake" }).acceptance,
    "simulated",
  );
  const accepted = campaignDeliveryEvidence({ ...base, state: "sent", messageId: "receipt" });
  assert.equal(accepted.acceptance, "recorded");
  assert.equal(accepted.delivery, "unverified");
});
