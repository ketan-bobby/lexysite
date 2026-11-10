import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calendarActionInput,
  readCalendarReceipt,
  verifyCalendarActionReceipt,
} from "./calendar-schedule-action";

const version = `v1_${"a".repeat(64)}`;
const shown = {
  id: "fixture",
  scheduledAt: "2030-11-01T10:00:00Z",
  durationMinutes: 60,
  status: "confirmed",
  version,
};
const event = {
  start: shown.scheduledAt,
  end: "2030-11-01T11:00:00Z",
  durationMinutes: 60,
  cancelled: false,
  webLink: null,
};

test("every explicit calendar action sends the displayed content revision without changing its snapshot", () => {
  const read = readCalendarReceipt({ event, scheduleVersion: version }, true);
  for (const action of ["create", "update", "pull", "cancel"] as const)
    assert.deepEqual(calendarActionInput(action, shown, read), {
      action,
      confirm: true,
      expectedScheduledAt: shown.scheduledAt,
      expectedVersion: version,
    });
  assert.equal(shown.version, version);
});

test("missing and changed read revisions block writes even when the time is unchanged", () => {
  for (const scheduleVersion of [undefined, `v1_${"b".repeat(64)}`])
    assert.throws(
      () => calendarActionInput("cancel", shown, { event, scheduleVersion }),
      /changed/,
    );
  assert.throws(
    () =>
      calendarActionInput(
        "create",
        { ...shown, version: undefined },
        { event, scheduleVersion: version },
      ),
    /Refresh/,
  );
});

test("unknown, malformed and unsafe calendar responses cannot display a usable hold", () => {
  for (const body of [
    null,
    {},
    { event: undefined },
    { event: {} },
    { event: { ...event, start: "bad" } },
    { event: { ...event, end: event.start } },
    { event: { ...event, durationMinutes: 480 } },
    { event: { ...event, cancelled: "false" } },
    { event: { ...event, webLink: "javascript:alert(1)" } },
    { event: { ...event, webLink: "https://unrelated.invalid/event" } },
  ])
    assert.throws(() => readCalendarReceipt(body));
  assert.throws(() => readCalendarReceipt({ event: null }, true), /Refresh/);
  assert.deepEqual(
    readCalendarReceipt({ event: null, scheduleVersion: version }, true).event,
    null,
  );
});

test("mutation receipts must confirm the requested native/provider effects", () => {
  for (const action of ["create", "update", "pull", "cancel"] as const)
    for (const body of [
      null,
      {},
      { event },
      { event: null, nativeChanged: false, remoteChanged: false },
    ])
      assert.throws(() => verifyCalendarActionReceipt(body, action));
  assert.equal(
    verifyCalendarActionReceipt({ event, nativeChanged: false, remoteChanged: false }, "create")
      .event,
    event,
  );
  assert.equal(
    verifyCalendarActionReceipt({ event, nativeChanged: false, remoteChanged: true }, "update")
      .remoteChanged,
    true,
  );
  assert.equal(
    verifyCalendarActionReceipt(
      { event: { ...event, cancelled: true }, nativeChanged: true, remoteChanged: false },
      "pull",
    ).nativeChanged,
    true,
  );
  assert.equal(
    verifyCalendarActionReceipt({ event: null, nativeChanged: true, remoteChanged: true }, "cancel")
      .event,
    null,
  );
  assert.equal(
    verifyCalendarActionReceipt(
      { event: null, nativeChanged: true, remoteChanged: false },
      "cancel",
    ).remoteChanged,
    false,
  );
});
