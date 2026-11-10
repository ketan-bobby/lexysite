import assert from "node:assert/strict";
import { mock, test } from "node:test";
import {
  GOOGLE_PRIMARY_READ,
  GOOGLE_FREEBUSY_READ,
  GoogleCalendarReadError,
} from "./google-calendar-read";

const calls: unknown[][] = [];
mock.module("@replit/connectors-sdk", {
  namedExports: {
    ReplitConnectors: class {
      async listConnections(options: unknown) {
        calls.push(["list", options]);
        return [];
      }
      async proxy(...args: unknown[]) {
        calls.push(["proxy", ...args]);
        return new Response("{}");
      }
    },
  },
});
const { googleCalendarReadGateway, boundedGoogleRead } = await import("./google-calendar-gateway");

test("SDK selection is pinned, reads are filtered and forbidden calls stop before proxy access", async () => {
  calls.length = 0;
  const gateway = googleCalendarReadGateway();
  await gateway.connections();
  await gateway.read("selected-connection", GOOGLE_PRIMARY_READ, { method: "GET" });
  assert.deepEqual(calls, [
    ["list", { connector_names: "google-calendar" }],
    [
      "proxy",
      "google-calendar",
      GOOGLE_PRIMARY_READ,
      { connectionId: "selected-connection", method: "GET", body: undefined },
    ],
  ]);
  for (const path of [
    "/calendar/v3/calendars/primary/events",
    "/calendar/v3/calendars/primary/acl",
    "https://example.invalid",
  ]) {
    await assert.rejects(
      gateway.read("selected", path, { method: "POST", body: {} }),
      (error: unknown) =>
        error instanceof GoogleCalendarReadError && error.code === "operation_not_allowed",
    );
  }
  assert.equal(calls.length, 2);
  const body = {
    timeMin: "2035-11-01T10:00:00Z",
    timeMax: "2035-11-01T10:15:00Z",
    timeZone: "UTC",
    calendarExpansionMax: 1,
    items: [{ id: "staff@example.invalid" }],
  };
  await gateway.read("selected-connection", GOOGLE_FREEBUSY_READ, { method: "POST", body });
  assert.deepEqual(calls[2], [
    "proxy",
    "google-calendar",
    GOOGLE_FREEBUSY_READ,
    { connectionId: "selected-connection", method: "POST", body },
  ]);
});
test("bounded diagnostic returns success or sanitized timeout without retry", async () => {
  assert.equal(await boundedGoogleRead(Promise.resolve("ok"), 10), "ok");
  await assert.rejects(
    boundedGoogleRead(new Promise(() => {}), 5),
    (error: unknown) => error instanceof GoogleCalendarReadError && error.code === "read_timeout",
  );
});
