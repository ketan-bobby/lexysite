import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateScheduleBody,
  UpdateScheduleBody,
  assertFutureSchedule,
} from "./coordinator-schedule-input";

const create = {
  applicationId: "fixture-application",
  scheduledAt: "2030-11-01T10:00:00+05:30",
  type: "technical",
  durationMinutes: 60,
};
test("schedule input preserves valid time offsets and strips ownership reassignment", () => {
  const result = CreateScheduleBody.parse({
    ...create,
    tenantId: "foreign",
    id: "foreign",
    status: "completed",
  });
  assert.equal(result.scheduledAt, create.scheduledAt);
  assert.equal("tenantId" in result, false);
  assert.equal("status" in result, false);
  const update = UpdateScheduleBody.parse({
    notes: "reviewed",
    tenantId: "foreign",
    applicationId: "foreign",
  });
  assert.deepEqual(update, { notes: "reviewed" });
});
test("invalid times, excessive durations, unknown statuses and ratings cannot reach writes", () => {
  for (const patch of [
    { scheduledAt: "not a date" },
    { scheduledAt: "2030-11-01T10:00:00" },
    { durationMinutes: 0 },
    { durationMinutes: 481 },
    { durationMinutes: 5.5 },
    { type: "made_up" },
  ])
    assert.equal(CreateScheduleBody.safeParse({ ...create, ...patch }).success, false);
  for (const patch of [
    { status: "anything" },
    { feedbackRating: 0 },
    { feedbackRating: 6 },
    { scheduledAt: "bad" },
    {},
    { tenantId: "foreign" },
  ])
    assert.equal(UpdateScheduleBody.safeParse(patch).success, false);
});
test("future check rejects past, current and invalid instants", () => {
  const now = Date.parse("2030-11-01T00:00:00Z");
  assert.equal(assertFutureSchedule("2030-11-01T00:00:01Z", now), true);
  for (const time of ["bad", "2030-10-31T23:59:59Z", "2030-11-01T00:00:00Z"])
    assert.equal(assertFutureSchedule(time, now), false);
});
