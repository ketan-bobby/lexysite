import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffReceipt } from "./ats-handoff-receipt";
const exported = { approvedBy: "human", approvedAt: "now", exportedBy: "owner", exportedAt: "now" };
test("manual handoff requires exact human acknowledgement, prior approval/export and a safe reference", () => {
  assert.throws(() =>
    handoffReceipt({}, { acknowledgeReview: true, evidenceReference: "CASE-123" }, "owner"),
  );
  for (const acknowledgeReview of [undefined, false])
    assert.throws(() =>
      handoffReceipt(exported, { acknowledgeReview, evidenceReference: "CASE-123" }, "owner"),
    );
  for (const evidenceReference of [
    "",
    "https://example.invalid",
    "person@example.invalid",
    "spaces here",
    "x".repeat(121),
  ])
    assert.throws(() =>
      handoffReceipt(exported, { acknowledgeReview: true, evidenceReference }, "owner"),
    );
  const record = handoffReceipt(
    exported,
    { acknowledgeReview: true, evidenceReference: "HR:CASE-123" },
    "owner",
  );
  assert.equal(record.recordedBy, "owner");
  assert.equal(record.verification, "human_reported_only");
  assert.throws(() =>
    handoffReceipt(
      { ...exported, handoffReceipt: record },
      { acknowledgeReview: true, evidenceReference: "NEW" },
      "owner",
    ),
  );
});
