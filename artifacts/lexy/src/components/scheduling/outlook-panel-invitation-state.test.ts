import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReviewPanelInvitation,
  isPanelReadFresh,
  readPanelStatus,
  receiptMatchesReview,
  samePanelReview,
} from "./outlook-panel-invitation-state";

const schedule = {
  id: "s1",
  status: "confirmed",
  scheduledAt: "2035-11-01T10:00:00.000Z",
  durationMinutes: 60,
  version: `v1_${"a".repeat(64)}`,
};
const base = {
  scheduleId: "s1",
  version: schedule.version,
  scheduledAt: schedule.scheduledAt,
  durationMinutes: 60,
  recipientEmail: "c@example.invalid",
  organizerEmail: "o@example.invalid",
  panelRecipients: [
    { userId: "u1", name: "A", email: "a@example.invalid" },
    { userId: "u2", name: "B", email: "b@example.invalid" },
  ],
  approvalToken: "b".repeat(64),
  status: "not_sent" as const,
  acceptedAt: null,
};

test("reads and validates", () => {
  assert.equal(readPanelStatus(base, "s1").version, base.version);
  assert.throws(() => readPanelStatus(base, "other"));
  assert.throws(() => readPanelStatus({ ...base, approvalToken: "x" }, "s1"));
  assert.throws(() =>
    readPanelStatus({ ...base, panelRecipients: [{ userId: "u", name: "n", email: "bad" }] }, "s1"),
  );
});
test("review eligibility", () => {
  assert.ok(canReviewPanelInvitation(schedule, base, 0));
  assert.ok(!canReviewPanelInvitation(schedule, { ...base, approvalToken: null }, 0));
  assert.ok(!canReviewPanelInvitation(schedule, { ...base, organizerEmail: null }, 0));
  assert.ok(!canReviewPanelInvitation(schedule, { ...base, status: "needs_review" }, 0));
  assert.ok(!canReviewPanelInvitation(schedule, { ...base, panelRecipients: [] }, 0));
});
test("receipt must match token, roster, organizer, time", () => {
  assert.ok(receiptMatchesReview(base, { ...base, status: "accepted" }));
  assert.ok(!samePanelReview(base, { ...base, approvalToken: "c".repeat(64) }));
  assert.ok(!samePanelReview(base, { ...base, organizerEmail: "x@example.invalid" }));
  assert.ok(!samePanelReview(base, { ...base, panelRecipients: [base.panelRecipients[0]] }));
  assert.ok(!samePanelReview(base, { ...base, scheduledAt: "2035-11-01T11:00:00.000Z" }));
});
test("freshness", () => {
  assert.ok(isPanelReadFresh(1000, 2000));
  assert.ok(!isPanelReadFresh(1000, 1000 + 100_000));
  assert.ok(!isPanelReadFresh(null));
});
