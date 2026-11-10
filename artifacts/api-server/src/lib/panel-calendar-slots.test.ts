import assert from "node:assert/strict";
import { test } from "node:test";
import { commonPanelSlots } from "./panel-calendar-slots";
import type { GraphEvent } from "./outlook-calendar-core";
const options = {
  start: "2035-11-01T09:00:00Z",
  end: "2035-11-01T12:00:00Z",
  durationMinutes: 30,
  bufferMinutes: 0,
};
const now = Date.parse("2035-11-01T08:00:00Z");
function busy(start: string, end: string, extra: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: "private",
    start: { dateTime: start, timeZone: "UTC" },
    end: { dateTime: end, timeZone: "UTC" },
    showAs: "busy",
    ...extra,
  };
}
test("common slots exclude overlapping busy periods across every selected member", () => {
  const result = commonPanelSlots(
    [
      [busy("2035-11-01T09:00:00Z", "2035-11-01T10:00:00Z")],
      [busy("2035-11-01T10:00:00Z", "2035-11-01T11:00:00Z")],
    ],
    options,
    now,
  );
  assert.deepEqual(
    result.map((s) => s.start),
    ["2035-11-01T11:00:00.000Z", "2035-11-01T11:15:00.000Z", "2035-11-01T11:30:00.000Z"],
  );
  assert.deepEqual(Object.keys(result[0]).sort(), ["end", "start"]);
});
test("buffers exclude adjacent and just-outside-window events", () => {
  const result = commonPanelSlots(
    [[busy("2035-11-01T08:30:00Z", "2035-11-01T08:55:00Z")]],
    { ...options, bufferMinutes: 15 },
    now,
  );
  assert.equal(result[0].start, "2035-11-01T09:15:00.000Z");
});
test("free and cancelled events do not block, tentative and unknown periods do", () => {
  const result = commonPanelSlots(
    [
      [
        busy(options.start, options.end, { showAs: "free" }),
        busy(options.start, options.end, { isCancelled: true }),
      ],
    ],
    options,
    now,
  );
  assert.equal(result.length, 11);
  for (const showAs of ["tentative", "oof", "unknown", "workingElsewhere"])
    assert.deepEqual(
      commonPanelSlots([[busy(options.start, options.end, { showAs })]], options, now),
      [],
    );
});
test("missing calendars, malformed periods and misleading flags fail closed", () => {
  for (const calendar of [
    null,
    [null],
    [{ isCancelled: "false", showAs: "busy" }],
    [{ showAs: "busy" }],
  ]) {
    assert.throws(() => commonPanelSlots([calendar as unknown as GraphEvent[]], options, now));
  }
  assert.throws(() => commonPanelSlots([], options, now));
  assert.throws(() => commonPanelSlots([[busy(options.end, options.start)]], options, now));
});
test("window limits, explicit panel size and integer duration/buffer are enforced", () => {
  for (const patch of [
    { durationMinutes: 4 },
    { bufferMinutes: 61 },
    { bufferMinutes: 0.5 },
    { end: "2035-11-03T10:00:00Z" },
  ])
    assert.throws(() => commonPanelSlots([[]], { ...options, ...patch }, now));
  assert.throws(() =>
    commonPanelSlots(
      Array.from({ length: 6 }, () => []),
      options,
      now,
    ),
  );
});
test("offsets represent the same instant and suggestions respect notice and output cap", () => {
  assert.deepEqual(
    commonPanelSlots([[]], { ...options, start: "2035-11-01T14:30:00+05:30" }, now),
    commonPanelSlots([[]], options, now),
  );
  const result = commonPanelSlots([[]], options, Date.parse("2035-11-01T09:01:00Z"));
  assert.equal(result[0].start, "2035-11-01T09:30:00.000Z");
  assert.equal(
    commonPanelSlots([[]], { ...options, end: "2035-11-02T09:00:00Z", durationMinutes: 5 }, now)
      .length,
    40,
  );
});
