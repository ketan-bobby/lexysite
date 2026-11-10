import assert from "node:assert/strict";
import { test } from "node:test";
import { formatInterviewInstant, interviewTimeOffset } from "./interview-time-display";

const ny = { locale: "en-US", timeZone: "America/New_York" };

test("repeated fall-back clock times have distinct, instant-specific offsets", () => {
  const before = "2026-11-01T05:30:00.000Z";
  const after = "2026-11-01T06:30:00.000Z";
  const first = formatInterviewInstant(before, ny);
  const second = formatInterviewInstant(after, ny);
  assert.match(first, /1:30/);
  assert.match(second, /1:30/);
  assert.match(first, /GMT-04:00/);
  assert.match(second, /GMT-05:00/);
  assert.notEqual(first, second);
  assert.equal(interviewTimeOffset(before, ny), "GMT-04:00");
  assert.equal(interviewTimeOffset(after, ny), "GMT-05:00");
});

test("spring-forward instants use their actual clock time and offset", () => {
  assert.match(formatInterviewInstant("2026-03-08T06:30:00Z", ny), /1:30.*GMT-05:00/);
  assert.match(formatInterviewInstant("2026-03-08T07:30:00Z", ny), /3:30.*GMT-04:00/);
});

test("fractional-hour zones and local date rollover remain explicit", () => {
  const india = { locale: "en-US", timeZone: "Asia/Kolkata" };
  const text = formatInterviewInstant("2026-10-31T20:00:00Z", india);
  assert.match(text, /November 1, 2026/);
  assert.match(text, /1:30.*GMT\+05:30/);
  assert.equal(interviewTimeOffset("2026-10-31T20:00:00Z", india), "GMT+05:30");
});

test("sub-minute choices are not silently rendered as identical labels", () => {
  const base = "2026-11-01T06:30:00.000Z";
  const seconds = "2026-11-01T06:30:15.000Z";
  const millis = "2026-11-01T06:30:15.025Z";
  assert.notEqual(formatInterviewInstant(base, ny), formatInterviewInstant(seconds, ny));
  assert.notEqual(formatInterviewInstant(seconds, ny), formatInterviewInstant(millis, ny));
  assert.match(formatInterviewInstant(seconds, ny), /1:30:15/);
  assert.match(formatInterviewInstant(millis, ny), /1:30:15\.025/);
});

test("invalid instants and timezones fail rather than silently relabeling a slot", () => {
  for (const value of ["not-a-date", new Date(NaN)]) {
    assert.throws(() => formatInterviewInstant(value, ny), /Invalid interview time/);
    assert.throws(() => interviewTimeOffset(value, ny), /Invalid interview time/);
  }
  assert.throws(() => formatInterviewInstant("2026-11-01T06:30:00Z", { timeZone: "invalid" }));
  assert.equal(
    formatInterviewInstant(new Date("2026-11-01T06:30:00Z"), ny),
    formatInterviewInstant("2026-11-01T06:30:00Z", ny),
  );
});
