import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkGoogleCalendarReads,
  GoogleCalendarReadError,
  assertGoogleReadOperation,
  GOOGLE_PRIMARY_READ,
  GOOGLE_FREEBUSY_READ,
  type GoogleCalendarReadGateway,
} from "./google-calendar-read";

const start = new Date("2035-11-01T10:00:00.000Z");
const end = "2035-11-01T10:15:00.000Z";
const primary = {
  id: "staff@example.invalid",
  timeZone: "Asia/Kolkata",
  summary: "DO NOT RETURN",
  conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] },
};
function fixture() {
  const state = {
    connections: [{ id: "fixture-connection", connector_name: "google-calendar" }],
    primary: structuredClone(primary) as unknown,
    busy: {
      timeMin: start.toISOString(),
      timeMax: end,
      calendars: {
        [primary.id]: {
          busy: [] as Array<{ start: string; end: string }>,
          errors: [] as unknown[],
        },
      },
    } as unknown,
    status: 200,
    calls: [] as Array<{ id: string; path: string; method: string; body?: unknown }>,
    failure: false,
  };
  const gateway: GoogleCalendarReadGateway = {
    async connections() {
      return state.connections;
    },
    async read(id, path, options) {
      state.calls.push({ id, path, ...options });
      if (state.failure) throw new Error("private provider/account exception");
      return {
        ok: state.status === 200,
        status: state.status,
        async json() {
          return path === GOOGLE_PRIMARY_READ ? state.primary : state.busy;
        },
      };
    },
  };
  return { state, gateway };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof GoogleCalendarReadError &&
  error.code === expected &&
  !error.message.includes(primary.id);

test("exactly two selected-connection read operations; response contains no private data", async () => {
  const { state, gateway } = fixture();
  state.busy = {
    timeMin: start.toISOString(),
    timeMax: end,
    calendars: {
      [primary.id]: { busy: [{ start: "2035-11-01T10:02:00Z", end: "2035-11-01T10:05:00Z" }] },
    },
  };
  const result = await checkGoogleCalendarReads(gateway, start);
  assert.deepEqual(result, {
    status: "verified",
    checkedAt: start.toISOString(),
    calendarReadVerified: true,
    availabilityReadVerified: true,
    meetSupported: true,
    accountBinding: "not_configured",
    invitationsEnabled: false,
  });
  assert.deepEqual(state.calls, [
    { id: "fixture-connection", path: GOOGLE_PRIMARY_READ, method: "GET" },
    {
      id: "fixture-connection",
      path: GOOGLE_FREEBUSY_READ,
      method: "POST",
      body: {
        timeMin: start.toISOString(),
        timeMax: end,
        timeZone: "UTC",
        calendarExpansionMax: 1,
        items: [{ id: primary.id }],
      },
    },
  ]);
  assert.equal(JSON.stringify(result).includes(primary.id), false);
  assert.equal(JSON.stringify(result).includes("DO NOT RETURN"), false);
  assert.equal(JSON.stringify(result).includes("10:02"), false);
});
test("zero, unrelated and multiple connections never pick an arbitrary account", async () => {
  for (const connections of [
    [],
    [{ id: "mail", connector_name: "gmail" }],
    [
      { id: "one", connector_name: "google-calendar" },
      { id: "two", connector_name: "google-calendar" },
    ],
  ]) {
    const { state, gateway } = fixture();
    state.connections = connections;
    const result = await checkGoogleCalendarReads(gateway, start);
    assert.equal(result.status, connections.length === 2 ? "selection_required" : "not_connected");
    assert.equal(result.availabilityReadVerified, false);
    assert.equal(result.invitationsEnabled, false);
    assert.equal(result.meetSupported, null);
    assert.equal(state.calls.length, 0);
  }
});
test("missing or unsupported conference capability never enables meeting writes", async () => {
  for (const value of [undefined, { allowedConferenceSolutionTypes: [] }]) {
    const { state, gateway } = fixture();
    state.primary = { ...primary, conferenceProperties: value };
    const result = await checkGoogleCalendarReads(gateway, start);
    assert.equal(result.meetSupported, value ? false : null);
    assert.equal(result.invitationsEnabled, false);
  }
});
for (const [name, mutate] of [
  ["missing primary id", () => ({ timeZone: "UTC" })],
  ["invalid time zone", () => ({ ...primary, timeZone: "not-a-zone" })],
  ["invalid capability", () => ({ ...primary, conferenceProperties: "hangoutsMeet" })],
] as const)
  test(name, async () => {
    const { state, gateway } = fixture();
    state.primary = mutate();
    await assert.rejects(
      checkGoogleCalendarReads(gateway, start),
      code("invalid_calendar_response"),
    );
    assert.equal(state.calls.length, 1);
  });
for (const [name, response, expected] of [
  [
    "missing calendar",
    { timeMin: start.toISOString(), timeMax: end, calendars: {} },
    "invalid_availability_response",
  ],
  [
    "wrong calendar",
    { timeMin: start.toISOString(), timeMax: end, calendars: { other: { busy: [] } } },
    "invalid_availability_response",
  ],
  [
    "missing busy list",
    { timeMin: start.toISOString(), timeMax: end, calendars: { [primary.id]: {} } },
    "invalid_availability_response",
  ],
  [
    "partial provider failure",
    {
      timeMin: start.toISOString(),
      timeMax: end,
      calendars: { [primary.id]: { busy: [], errors: [{ reason: "forbidden" }] } },
    },
    "availability_unknown",
  ],
  [
    "wrong window",
    { timeMin: "2035-11-01T10:01:00Z", timeMax: end, calendars: { [primary.id]: { busy: [] } } },
    "invalid_availability_response",
  ],
  [
    "unexpected group",
    {
      timeMin: start.toISOString(),
      timeMax: end,
      groups: { team: {} },
      calendars: { [primary.id]: { busy: [] } },
    },
    "invalid_availability_response",
  ],
] as const)
  test(name, async () => {
    const { state, gateway } = fixture();
    state.busy = response;
    await assert.rejects(checkGoogleCalendarReads(gateway, start), code(expected));
  });
test("invalid, reversed or out-of-window busy intervals fail closed", async () => {
  for (const interval of [
    { start: "bad", end },
    { start: end, end: start.toISOString() },
    { start: "2035-11-01T09:00:00Z", end },
    { start: start.toISOString(), end: "2035-11-01T11:00:00Z" },
  ]) {
    const { state, gateway } = fixture();
    state.busy = {
      timeMin: start.toISOString(),
      timeMax: end,
      calendars: { [primary.id]: { busy: [interval] } },
    };
    await assert.rejects(
      checkGoogleCalendarReads(gateway, start),
      (error: unknown) => error instanceof GoogleCalendarReadError,
    );
  }
});
test("permission, provider and thrown errors are sanitized and never imply availability", async () => {
  for (const status of [401, 403, 429, 500]) {
    const { state, gateway } = fixture();
    state.status = status;
    await assert.rejects(
      checkGoogleCalendarReads(gateway, start),
      code([401, 403].includes(status) ? "permission_required" : "provider_unavailable"),
    );
  }
  const { state, gateway } = fixture();
  state.failure = true;
  await assert.rejects(checkGoogleCalendarReads(gateway, start), code("provider_unavailable"));
});
test("request allowlist rejects event creation, ACLs, arbitrary URLs and expanded calendar reads", () => {
  for (const [path, method, body] of [
    [GOOGLE_PRIMARY_READ, "POST", undefined],
    ["/calendar/v3/calendars/primary/events", "POST", {}],
    ["/calendar/v3/calendars/primary/acl", "GET", undefined],
    ["https://www.googleapis.com" + GOOGLE_PRIMARY_READ, "GET", undefined],
    [GOOGLE_FREEBUSY_READ, "POST", { items: [{ id: "one" }, { id: "two" }] }],
  ] as const)
    assert.throws(
      () => assertGoogleReadOperation(path, { method, body }),
      code("operation_not_allowed"),
    );
});
test("free-busy request accepts only one calendar and a strict window of at most 15 minutes", () => {
  const body = {
    timeMin: start.toISOString(),
    timeMax: end,
    timeZone: "UTC",
    calendarExpansionMax: 1,
    items: [{ id: primary.id }],
  };
  assertGoogleReadOperation(GOOGLE_FREEBUSY_READ, { method: "POST", body });
  for (const change of [
    { timeMax: "2035-11-01T11:00:00Z" },
    { timeMax: start.toISOString() },
    { timeMin: "bad" },
    { groupExpansionMax: 100 },
    { calendarExpansionMax: 2 },
    { items: [{ id: primary.id, extra: true }] },
  ]) {
    assert.throws(
      () =>
        assertGoogleReadOperation(GOOGLE_FREEBUSY_READ, {
          method: "POST",
          body: { ...body, ...change },
        }),
      code("operation_not_allowed"),
    );
  }
});
