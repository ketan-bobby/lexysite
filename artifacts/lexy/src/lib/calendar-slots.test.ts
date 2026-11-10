import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableInterviewSlots,
  localScheduleFields,
  localWorkWindow,
  scheduleDraftInstant,
  validateAvailability,
} from "./calendar-slots";

const availability = {
  start: "2030-11-01T00:00:00Z",
  end: "2030-11-02T00:00:00Z",
  busy: [{ start: "2030-11-01T10:00:00Z", end: "2030-11-01T11:00:00Z" }],
};
const options = {
  start: "2030-11-01T09:00:00Z",
  end: "2030-11-01T12:00:00Z",
  durationMinutes: 60,
  bufferMinutes: 0,
  now: Date.parse("2030-10-31T00:00:00Z"),
};
test("only complete nonoverlapping slots fit in the requested working window", () => {
  assert.deepEqual(
    availableInterviewSlots(availability, options).map((slot) => slot.start),
    ["2030-11-01T09:00:00.000Z", "2030-11-01T11:00:00.000Z"],
  );
  assert.equal(
    availableInterviewSlots(availability, { ...options, durationMinutes: 120 }).length,
    0,
  );
});
test("buffers, overlapping meetings and day-spanning meetings remain busy", () => {
  assert.equal(availableInterviewSlots(availability, { ...options, bufferMinutes: 15 }).length, 0);
  const busy = [
    { start: "2030-10-31T22:00:00Z", end: "2030-11-01T10:00:00Z" },
    { start: "2030-11-01T09:30:00Z", end: "2030-11-01T11:30:00Z" },
  ];
  assert.equal(availableInterviewSlots({ ...availability, busy }, options).length, 0);
});
test("offsets are compared as instants and past/short-notice slots are excluded", () => {
  const slots = availableInterviewSlots(
    { ...availability, busy: [] },
    {
      ...options,
      now: Date.parse("2030-11-01T09:00:00Z"),
      durationMinutes: 30,
    },
  );
  assert.equal(slots[0].start, "2030-11-01T09:15:00.000Z");
  assert.deepEqual(
    availableInterviewSlots(
      {
        ...availability,
        busy: [{ start: "2030-11-01T15:30:00+05:30", end: "2030-11-01T16:30:00+05:30" }],
      },
      options,
    ),
    availableInterviewSlots(availability, options),
  );
});
test("unknown, partial, malformed and reversed availability fails closed", () => {
  for (const data of [
    null,
    {},
    { ...availability, busy: undefined },
    { ...availability, busy: [null] },
    { ...availability, busy: [{ start: "bad", end: "bad" }] },
    { ...availability, busy: [{ start: availability.end, end: availability.start }] },
  ]) {
    assert.throws(() => validateAvailability(data));
  }
  assert.throws(() =>
    availableInterviewSlots(availability, { ...options, start: "2030-10-31T23:00:00Z" }),
  );
  for (const durationMinutes of [0, -1, 481, 30.5])
    assert.throws(() => availableInterviewSlots(availability, { ...options, durationMinutes }));
  assert.throws(() => availableInterviewSlots(availability, { ...options, bufferMinutes: -1 }));
});
test("local fields round-trip without assuming that browser time is UTC", () => {
  const date = new Date(2030, 10, 1, 9, 30);
  assert.deepEqual(localScheduleFields(date.toISOString()), { date: "2030-11-01", time: "09:30" });
  const window = localWorkWindow("2030-11-01", "09:30", "17:00");
  assert.equal(window.start, date.toISOString());
  for (const [day, start, end] of [
    ["2030-02-30", "09:00", "17:00"],
    ["2030-11-01", "18:00", "17:00"],
    ["2030-11-01", "25:00", "26:00"],
  ])
    assert.throws(() => localWorkWindow(day, start, end));
});

test("selected slot retains its exact instant, including an ambiguous daylight-saving hour", () => {
  const selected = "2030-11-03T06:30:00.000Z";
  const fields = localScheduleFields(selected);
  assert.equal(scheduleDraftInstant(fields.date, fields.time, selected), selected);
  assert.throws(() => scheduleDraftInstant("2030-02-30", "09:00"));
  if (Intl.DateTimeFormat().resolvedOptions().timeZone === "America/New_York") {
    assert.equal(fields.time, "01:30");
    assert.throws(() => localWorkWindow("2030-03-10", "02:30", "04:00"));
    assert.throws(() => scheduleDraftInstant("2030-03-10", "02:30"));
  }
});
