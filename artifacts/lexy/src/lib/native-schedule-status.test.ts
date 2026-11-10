import assert from "node:assert/strict";
import { test } from "node:test";
import { COORDINATOR_REFRESH_INTERVAL, nativeScheduleStatusLabel } from "./native-schedule-status";

test("native confirmation does not claim a candidate actor, booking or invitation", () => {
  const label = nativeScheduleStatusLabel("confirmed");
  assert.equal(label, "Time confirmed in Lexy");
  assert.doesNotMatch(label, /candidate|outlook|booked|invitation|sent/i);
});

test("other statuses remain distinct and never imply external cancellation or delivery", () => {
  assert.equal(nativeScheduleStatusLabel("pending"), "Awaiting time confirmation");
  for (const status of ["scheduled", "rescheduled", "cancelled", "completed", "no_show"]) {
    assert.match(nativeScheduleStatusLabel(status), /in Lexy$/);
    assert.doesNotMatch(nativeScheduleStatusLabel(status), /outlook|invitation|delivered/i);
  }
});

test("unrecognized values do not get a successful-status label", () => {
  for (const status of ["", "delivered", "__proto__", "constructor"])
    assert.equal(nativeScheduleStatusLabel(status), "Unrecognized schedule status");
  assert.equal(COORDINATOR_REFRESH_INTERVAL, 30_000);
});
