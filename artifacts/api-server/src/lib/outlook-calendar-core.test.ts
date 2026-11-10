import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CALENDAR_BINDING,
  CalendarError,
  assertCalendarAvailable,
  assertPersonalHold,
  calendarEvents,
  calendarWindow,
  calendarScheduleVisible,
  eventView,
  hasCalendarScope,
  linkedCalendarEvent,
  safeGraphPath,
  scheduleBinding,
  utcInstant,
  type CalendarRequest,
  type GraphEvent,
} from "./outlook-calendar-core";

const event = (overrides: Partial<GraphEvent> = {}): GraphEvent => ({
  id: "private-event",
  "@odata.etag": 'W/"revision"',
  start: { dateTime: "2026-11-01T10:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-01T11:00:00", timeZone: "UTC" },
  showAs: "busy",
  isOrganizer: true,
  attendees: [],
  type: "singleInstance",
  ...overrides,
});
function requestReturning(value: unknown): CalendarRequest {
  return async <T>() => value as T;
}
test("calendar permission is separate from mail and normalized for Graph resource prefixes", () => {
  assert.equal(hasCalendarScope("Mail.Send Mail.Read offline_access"), false);
  assert.equal(hasCalendarScope("https://graph.microsoft.com/calendars.readwrite"), true);
  assert.equal(hasCalendarScope("Calendars.Read"), false);
});
test("date ranges are finite, ordered and bounded", () => {
  assert.equal(
    calendarWindow("2026-11-01T10:00:00+05:30", "2026-11-01T11:00:00+05:30").start,
    "2026-11-01T04:30:00.000Z",
  );
  for (const [a, b] of [
    ["bad", "bad"],
    ["2026-11-02", "2026-11-01"],
    ["2026-11-01", "2026-11-10"],
  ]) {
    assert.throws(() => calendarWindow(a, b), CalendarError);
  }
});
test("UTC handling is independent of server locale and rejects unsupported zones", () => {
  assert.equal(utcInstant(event().start), "2026-11-01T10:00:00.000Z");
  assert.throws(() =>
    utcInstant({ dateTime: "2026-11-01T10:00:00", timeZone: "India Standard Time" }),
  );
  assert.throws(() => utcInstant({ dateTime: "invalid", timeZone: "UTC" }));
});
test("schedule binding is deterministic and cannot collide across tenants or mail owners", () => {
  assert.equal(scheduleBinding("a", "s"), scheduleBinding("a", "s"));
  assert.notEqual(scheduleBinding("a", "s"), scheduleBinding("b", "s"));
  assert.notEqual(scheduleBinding("a:b", "c"), scheduleBinding("a", "b:c"));
});
test("Graph pagination can only target the same /me Graph resource", () => {
  for (const path of [
    "https://evil.invalid/v1.0/me/events",
    "http://graph.microsoft.com/v1.0/me/events",
    "https://graph.microsoft.com/v1.0/users/other/events",
    "https://u:p@graph.microsoft.com/v1.0/me/events",
    "/me/../users/other",
  ]) {
    assert.throws(() => safeGraphPath(path));
  }
  assert.equal(safeGraphPath("/me/events"), "https://graph.microsoft.com/v1.0/me/events");
});
test("availability consumes every page, including a conflict on the second page", async () => {
  let calls = 0;
  const request: CalendarRequest = async <T>() =>
    (++calls === 1
      ? {
          value: [],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=test",
        }
      : { value: [event()] }) as T;
  await assert.rejects(
    assertCalendarAvailable(request, "2026-11-01T10:00:00.000Z", "2026-11-01T11:00:00.000Z"),
    (error: unknown) => error instanceof CalendarError && error.code === "calendar_conflict",
  );
  assert.equal(calls, 2);
});
test("free, cancelled and the held event itself do not block moving that hold", async () => {
  await assertCalendarAvailable(
    requestReturning({
      value: [
        event(),
        event({ id: "free", showAs: "free" }),
        event({ id: "cancelled", isCancelled: true }),
      ],
    }),
    "2026-11-01T10:00:00.000Z",
    "2026-11-01T11:00:00.000Z",
    "private-event",
  );
});
test("unknown busy states are treated as busy, never as free", async () => {
  await assert.rejects(
    assertCalendarAvailable(
      requestReturning({ value: [event({ showAs: "unknown" })] }),
      "2026-11-01T10:00:00.000Z",
      "2026-11-01T11:00:00.000Z",
    ),
  );
});
test("a partial, looping, oversized, or malformed calendar never returns false availability", async () => {
  for (const response of [
    { value: [], "@odata.nextLink": "https://evil.invalid/events" },
    { value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView" },
    { value: "invalid" },
  ])
    await assert.rejects(calendarEvents(requestReturning(response), "2026-11-01", "2026-11-02"));
  let calls = 0;
  const request: CalendarRequest = async <T>() =>
    ({
      value: [],
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendarView?page=${++calls}`,
    }) as T;
  await assert.rejects(calendarEvents(request, "2026-11-01", "2026-11-02"));
  assert.equal(calls, 10);
});
test("provider failures are not converted to an empty calendar", async () => {
  const request: CalendarRequest = async () => {
    throw new Error("provider unavailable");
  };
  await assert.rejects(calendarEvents(request, "2026-11-01", "2026-11-02"), /provider unavailable/);
});
test("linked lookup uses a tenant-bound property and rejects duplicates", async () => {
  let requested = "";
  const request: CalendarRequest = async <T>(path: string) => {
    requested = path;
    return { value: [event()] } as T;
  };
  assert.equal((await linkedCalendarEvent(request, "binding"))?.id, "private-event");
  const filter = new URL(safeGraphPath(requested)).searchParams.get("$filter");
  assert.ok(filter?.includes(CALENDAR_BINDING) && filter.includes("'binding'"));
  assert.equal(await linkedCalendarEvent(requestReturning({ value: [] }), "binding"), null);
  await assert.rejects(
    linkedCalendarEvent(requestReturning({ value: [event(), event()] }), "binding"),
  );
});
test("no guest, recurring or non-organizer event can be mutated by the personal hold feature", () => {
  assert.doesNotThrow(() => assertPersonalHold(event()));
  for (const value of [
    event({ attendees: [{}] }),
    event({ isOrganizer: false }),
    event({ type: "seriesMaster" }),
  ]) {
    assert.throws(() => assertPersonalHold(value));
  }
});
test("receipt strips private fields and unsafe provider links", () => {
  const result = eventView(event({ webLink: "https://evil.invalid/token" }));
  assert.equal(result?.webLink, null);
  assert.deepEqual(Object.keys(result!).sort(), [
    "cancelled",
    "durationMinutes",
    "end",
    "start",
    "webLink",
  ]);
  assert.equal(eventView(null), null);
  assert.throws(() =>
    eventView(event({ end: { dateTime: "2026-11-03T11:00:00", timeZone: "UTC" } })),
  );
});
const scope = {
  callerId: "recruiter",
  role: "recruiter",
  allowedTenantIds: ["client"],
  ownsJob: true,
  jobTenantId: "client",
  scheduleTenantId: "agency",
  applicationTenantId: "agency",
  interviewerId: null,
};
test("schedule scope accepts a legitimately dual-tenant application", () =>
  assert.equal(calendarScheduleVisible(scope), true));
test("schedule scope denies wrong tenant, wrong requisition, and foreign child rows", () => {
  for (const input of [
    { ...scope, jobTenantId: "foreign" },
    { ...scope, ownsJob: false },
    { ...scope, scheduleTenantId: "foreign" },
  ]) {
    assert.equal(calendarScheduleVisible(input), false);
  }
});
test("even an administrator cannot operate another interviewer's calendar hold", () => {
  assert.equal(
    calendarScheduleVisible({
      ...scope,
      role: "platform_admin",
      allowedTenantIds: null,
      interviewerId: "other",
    }),
    false,
  );
});
test("hiring managers and interviewers need an explicit self assignment", () => {
  assert.equal(calendarScheduleVisible({ ...scope, role: "interviewer" }), false);
  assert.equal(
    calendarScheduleVisible({ ...scope, role: "hiring_manager", interviewerId: "recruiter" }),
    true,
  );
});
