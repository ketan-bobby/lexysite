import assert from "node:assert/strict";
import { test } from "node:test";
import { readCandidateConfirmationReceipt } from "./candidate-time-confirmation";

const review = { id: "fixture", scheduledAt: "2030-11-01T10:00:00Z", duration: 60 };
const receipt = {
  scheduleId: review.id,
  status: "confirmed",
  scheduledAt: review.scheduledAt,
  durationMinutes: review.duration,
  version: `v1_${"a".repeat(64)}`,
  calendarReserved: false,
  invitationSent: false,
};
test("native confirmation must match the exact reviewed time, duration and schedule", () => {
  assert.deepEqual(readCandidateConfirmationReceipt(receipt, review), receipt);
  for (const change of [
    { scheduleId: "other" },
    { scheduledAt: "invalid" },
    { scheduledAt: "2030-11-02T10:00:00Z" },
    { durationMinutes: 30 },
    { version: null },
    { status: "pending" },
    { calendarReserved: true },
    { invitationSent: true },
  ])
    assert.throws(() => readCandidateConfirmationReceipt({ ...receipt, ...change }, review));
  for (const value of [null, {}, [], { status: "confirmed" }])
    assert.throws(() => readCandidateConfirmationReceipt(value, review));
});
