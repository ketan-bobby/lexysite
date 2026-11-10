import assert from "node:assert/strict";
import { test } from "node:test";
import { workingHoursPolicy } from "./calendar-working-hours";
import { commonPanelSlots } from "./panel-calendar-slots";

const instant = Date.parse;
const fits = (
  zone: string | null,
  windows: Array<{ day: number; start: string; end: string }>,
  a: string,
  b: string,
) => workingHoursPolicy(zone, windows).allows(instant(a), instant(b));
test("unset hours add no restriction; configured empty hours close every day", () => {
  assert.equal(fits(null, [], "2035-11-01T10:00Z", "2035-11-01T11:00Z"), true);
  assert.equal(fits("UTC", [], "2035-11-01T10:00Z", "2035-11-01T11:00Z"), false);
});
test("boundaries, partial minutes, split shifts and unscheduled weekdays are exact", () => {
  const windows = [
    { day: 4, start: "09:00", end: "12:00" },
    { day: 4, start: "13:00", end: "17:00" },
  ];
  assert.equal(fits("UTC", windows, "2035-11-01T09:00Z", "2035-11-01T12:00Z"), true);
  assert.equal(fits("UTC", windows, "2035-11-01T11:00Z", "2035-11-01T12:00:00.001Z"), false);
  assert.equal(fits("UTC", windows, "2035-11-01T11:30Z", "2035-11-01T13:30Z"), false);
  assert.equal(fits("UTC", windows, "2035-11-02T10:00Z", "2035-11-02T11:00Z"), false);
});
test("half-hour and quarter-hour zones and local dates differ from UTC", () => {
  assert.equal(
    fits(
      "Asia/Kolkata",
      [{ day: 4, start: "09:30", end: "10:30" }],
      "2035-11-01T04:00Z",
      "2035-11-01T05:00Z",
    ),
    true,
  );
  assert.equal(
    fits(
      "Asia/Kathmandu",
      [{ day: 4, start: "09:45", end: "10:45" }],
      "2035-11-01T04:00Z",
      "2035-11-01T05:00Z",
    ),
    true,
  );
  assert.equal(
    fits(
      "America/Los_Angeles",
      [{ day: 3, start: "17:00", end: "18:00" }],
      "2035-11-01T00:00Z",
      "2035-11-01T01:00Z",
    ),
    true,
  );
});
test("a shift crossing midnight needs both local-day intervals", () => {
  const windows = [
    { day: 4, start: "23:00", end: "24:00" },
    { day: 5, start: "00:00", end: "01:00" },
  ];
  assert.equal(fits("UTC", windows, "2035-11-01T23:30Z", "2035-11-02T00:30Z"), true);
  assert.equal(fits("UTC", windows.slice(0, 1), "2035-11-01T23:30Z", "2035-11-02T00:30Z"), false);
});
test("DST spring gap uses real elapsed instants and checks the far side", () => {
  assert.equal(
    fits(
      "America/New_York",
      [{ day: 0, start: "01:00", end: "04:00" }],
      "2027-03-14T06:30Z",
      "2027-03-14T07:30Z",
    ),
    true,
  );
  assert.equal(
    fits(
      "America/New_York",
      [{ day: 0, start: "01:00", end: "03:00" }],
      "2027-03-14T06:30Z",
      "2027-03-14T07:30Z",
    ),
    false,
  );
});
test("both DST fall-back instants are checked, not collapsed to a wall-clock date", () => {
  const windows = [{ day: 0, start: "01:00", end: "02:00" }];
  assert.equal(fits("America/New_York", windows, "2027-11-07T05:00Z", "2027-11-07T06:00Z"), true);
  assert.equal(fits("America/New_York", windows, "2027-11-07T06:00Z", "2027-11-07T07:00Z"), true);
  assert.equal(fits("America/New_York", windows, "2027-11-07T06:30Z", "2027-11-07T07:30Z"), false);
});
test("invalid zones, offsets, overlaps and backwards intervals never become unrestricted", () => {
  for (const zone of ["Invalid/Place", "+05:30", "", " UTC"])
    assert.throws(() => workingHoursPolicy(zone, []));
  for (const windows of [
    [{ day: 4, start: "17:00", end: "09:00" }],
    [{ day: 7, start: "09:00", end: "17:00" }],
    [{ day: 4, start: "24:00", end: "24:00" }],
    [
      { day: 4, start: "09:00", end: "12:00" },
      { day: 4, start: "11:00", end: "13:00" },
    ],
  ])
    assert.throws(() => workingHoursPolicy("UTC", windows));
  assert.throws(() => workingHoursPolicy(null, [{ day: 4, start: "09:00", end: "17:00" }]));
});
test("working-hour filtering happens before the output cap and includes buffers", () => {
  const p = workingHoursPolicy("UTC", [{ day: 4, start: "20:00", end: "23:00" }]);
  const options = {
    start: "2035-11-01T00:00Z",
    end: "2035-11-02T00:00Z",
    durationMinutes: 60,
    bufferMinutes: 15,
  };
  const slots = commonPanelSlots([[]], options, instant("2035-10-01T00:00Z"), (a, b) =>
    p.allows(a - 15 * 60000, b + 15 * 60000),
  );
  assert.equal(slots.length, 7);
  assert.equal(slots[0].start, "2035-11-01T20:15:00.000Z");
  assert.equal(slots.at(-1)?.end, "2035-11-01T22:45:00.000Z");
});
