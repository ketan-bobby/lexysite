import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyCalendarAction,
  type CalendarAction,
  type NativeCalendarChange,
} from "./outlook-calendar-operation";
import { CalendarError, type CalendarRequest, type GraphEvent } from "./outlook-calendar-core";
import { scheduleVersion } from "./coordinator-schedule-version";

const future = new Date(Date.now() + 2 * 86400000);
future.setUTCHours(14, 0, 0, 0);
const context = {
  callerId: "fixture-user",
  jobApproved: true,
  jobTitle: "Fictional Engineer",
  schedule: {
    id: "fixture-schedule",
    tenantId: "fixture-tenant",
    scheduledAt: future,
    durationMinutes: 60,
    status: "pending",
  },
};
const input = (action: CalendarAction["action"]): CalendarAction => ({
  action,
  confirm: true,
  expectedScheduledAt: future.toISOString(),
});
function event(overrides: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id: "fixture-event",
    "@odata.etag": 'W/"one"',
    type: "singleInstance",
    isOrganizer: true,
    attendees: [],
    start: { dateTime: future.toISOString(), timeZone: "UTC" },
    end: { dateTime: new Date(future.getTime() + 3600000).toISOString(), timeZone: "UTC" },
    ...overrides,
  };
}
function harness(existing: GraphEvent | null = null, failWrite = false) {
  const calls: {
    path: string;
    method: string;
    body?: Record<string, unknown>;
    headers?: RequestInit["headers"];
  }[] = [];
  const native: NativeCalendarChange[] = [];
  const request: CalendarRequest = async <T>(path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      path,
      method,
      headers: init?.headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method !== "GET" && failWrite)
      throw new CalendarError(503, "calendar_request_uncertain", "Provider acceptance uncertain");
    if (method === "GET")
      return { value: path.includes("calendarView") ? [] : existing ? [existing] : [] } as T;
    return (method === "DELETE" ? undefined : event()) as T;
  };
  const writeNative = async (change: NativeCalendarChange) => {
    native.push(change);
    return true;
  };
  return { request, writeNative, calls, native };
}
test("create books a private, tenant-bound hold without candidate invitations", async () => {
  const h = harness();
  const result = await applyCalendarAction(input("create"), context, h.request, h.writeNative);
  const creation = h.calls.find((c) => c.method === "POST")!;
  assert.equal(result.remoteChanged, true);
  assert.equal(result.nativeChanged, false);
  assert.equal(creation.body?.sensitivity, "private");
  assert.deepEqual(creation.body?.attendees, []);
  assert.equal(JSON.stringify(creation.body).includes("candidate@example"), false);
  assert.ok(creation.body?.transactionId);
  assert.ok(creation.body?.singleValueExtendedProperties);
  assert.equal(h.native.length, 0);
});
test("create retry returns the same linked receipt without another write", async () => {
  const h = harness(event());
  const result = await applyCalendarAction(input("create"), context, h.request, h.writeNative);
  assert.equal(result.remoteChanged, false);
  assert.equal(h.calls.length, 1);
});
test("create retries use the same transaction id even if the first receipt was lost", async () => {
  const a = harness(),
    b = harness();
  await applyCalendarAction(input("create"), context, a.request, a.writeNative);
  await applyCalendarAction(input("create"), context, b.request, b.writeNative);
  assert.equal(
    a.calls.find((c) => c.method === "POST")?.body?.transactionId,
    b.calls.find((c) => c.method === "POST")?.body?.transactionId,
  );
});
test("update pushes Lexy timing with the current Outlook revision", async () => {
  const h = harness(event());
  const result = await applyCalendarAction(input("update"), context, h.request, h.writeNative);
  const update = h.calls.find((c) => c.method === "PATCH")!;
  assert.equal((update.headers as Record<string, string>)["If-Match"], 'W/"one"');
  assert.equal(result.remoteChanged, true);
  assert.equal(h.native.length, 0);
});
test("pull changes native timing only after a valid linked provider receipt", async () => {
  const later = new Date(future.getTime() + 7200000).toISOString();
  const h = harness(
    event({
      start: { dateTime: later, timeZone: "UTC" },
      end: { dateTime: new Date(future.getTime() + 10800000).toISOString(), timeZone: "UTC" },
    }),
  );
  const result = await applyCalendarAction(input("pull"), context, h.request, h.writeNative);
  assert.equal(result.nativeChanged, true);
  assert.equal(result.remoteChanged, false);
  assert.equal(h.native[0].scheduledAt?.toISOString(), later);
  assert.equal(h.native[0].status, "rescheduled");
});
test("cancel deletes the exact personal hold before cancelling the native schedule", async () => {
  const h = harness(event());
  const result = await applyCalendarAction(input("cancel"), context, h.request, h.writeNative);
  assert.equal(h.calls.find((c) => c.method === "DELETE")?.path, "/me/events/fixture-event");
  assert.equal(h.native[0].status, "cancelled");
  assert.equal(result.event, null);
});
test("cancel without a linked personal hold changes only the native schedule", async () => {
  const h = harness();
  const result = await applyCalendarAction(input("cancel"), context, h.request, h.writeNative);
  assert.equal(result.event, null);
  assert.equal(result.nativeChanged, true);
  assert.equal(result.remoteChanged, false);
  assert.equal(h.native.length, 1);
  assert.deepEqual(h.native[0], { status: "cancelled" });
  assert.equal(
    h.calls.some((call) => call.method !== "GET"),
    false,
  );
});
test("uncertain deletion does not mark the native interview cancelled", async () => {
  const h = harness(event(), true);
  await assert.rejects(
    applyCalendarAction(input("cancel"), context, h.request, h.writeNative),
    /uncertain/,
  );
  assert.equal(h.native.length, 0);
});
test("missing event on pull or update does not invent a successful sync", async () => {
  for (const action of ["pull", "update"] as const) {
    const h = harness();
    await assert.rejects(applyCalendarAction(input(action), context, h.request, h.writeNative));
    assert.equal(h.native.length, 0);
    assert.equal(h.calls.filter((c) => c.method !== "GET").length, 0);
  }
});
test("stale native timing, unapproved job, and completed schedule stop before provider access", async () => {
  for (const variant of [
    { ...context, jobApproved: false },
    { ...context, schedule: { ...context.schedule, status: "completed" } },
    {
      ...context,
      schedule: { ...context.schedule, scheduledAt: new Date(future.getTime() + 60000) },
    },
  ]) {
    const h = harness();
    await assert.rejects(applyCalendarAction(input("create"), variant, h.request, h.writeNative));
    assert.equal(h.calls.length, 0);
  }
});
test("cleanup is allowed for an unapproved job but never overwrites a completed interview", async () => {
  const h = harness(event());
  await applyCalendarAction(
    input("cancel"),
    { ...context, jobApproved: false },
    h.request,
    h.writeNative,
  );
  assert.equal(h.native[0].status, "cancelled");
  await assert.rejects(
    applyCalendarAction(
      input("cancel"),
      { ...context, schedule: { ...context.schedule, status: "completed" } },
      h.request,
      h.writeNative,
    ),
  );
});
test("guest meetings and missing revisions prevent all destructive writes", async () => {
  for (const existing of [event({ attendees: [{}] }), event({ "@odata.etag": undefined })]) {
    for (const action of ["update", "cancel"] as const) {
      const h = harness(existing);
      await assert.rejects(applyCalendarAction(input(action), context, h.request, h.writeNative));
      assert.equal(h.calls.filter((c) => c.method !== "GET").length, 0);
      assert.equal(h.native.length, 0);
    }
  }
});
test("concurrent native change after remote deletion is reported as reconciliation, not success", async () => {
  const h = harness(event());
  await assert.rejects(
    applyCalendarAction(input("cancel"), context, h.request, async () => false),
    (error: unknown) => error instanceof CalendarError && error.code === "reconciliation_required",
  );
});

test("a stale content revision blocks every calendar action before provider or native I/O", async () => {
  const original = {
    ...context.schedule,
    applicationId: "fixture-app",
    type: "technical",
    interviewerId: "first",
    notes: null,
  };
  const expectedVersion = scheduleVersion(original);
  for (const change of [
    { durationMinutes: 90 },
    { interviewerId: "second" },
    { status: "confirmed" },
    { notes: "New notes" },
    { type: "behavioral" },
    { applicationId: "other-app" },
    { feedbackRating: 4 },
    { feedbackNotes: "Latest feedback" },
    { location: "New room" },
  ]) {
    for (const action of ["create", "update", "pull", "cancel"] as const) {
      const h = harness(event());
      await assert.rejects(
        applyCalendarAction(
          { ...input(action), expectedVersion },
          { ...context, schedule: { ...original, ...change } },
          h.request,
          h.writeNative,
        ),
        (error: unknown) => error instanceof CalendarError && error.code === "schedule_changed",
      );
      assert.equal(h.calls.length, 0);
      assert.equal(h.native.length, 0);
    }
  }
});

test("a matching content revision preserves personal holds and conditional provider writes", async () => {
  const h = harness(event());
  const result = await applyCalendarAction(
    { ...input("update"), expectedVersion: scheduleVersion({ ...context.schedule }) },
    context,
    h.request,
    h.writeNative,
  );
  assert.equal(result.remoteChanged, true);
  assert.equal(result.nativeChanged, false);
  assert.equal(
    new Headers(h.calls.find((call) => call.method === "PATCH")?.headers).get("If-Match"),
    'W/"one"',
  );
});
