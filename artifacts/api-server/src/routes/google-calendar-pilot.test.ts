import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import express, { type Request } from "express";
import { createServer } from "node:http";
import { CalendarError } from "../lib/outlook-calendar-core";
import { GOOGLE_PRIMARY_READ, type GoogleCalendarReadGateway } from "../lib/google-calendar-read";

let role = "platform_admin",
  active = true,
  providerCalls = 0,
  factoryCalls = 0,
  fail = false;
let pause: Promise<void> | null = null,
  entered: (() => void) | null = null;
const callerIds: Array<string | null> = [];
mock.module(new URL("../lib/calendar-staff.ts", import.meta.url), {
  namedExports: {
    calendarStaff: async (id: string | null) => {
      callerIds.push(id);
      if (!id || !active) throw new CalendarError(401, "unauthenticated", "Please sign in.");
      return { role };
    },
  },
});
mock.module(new URL("../lib/auth-token.ts", import.meta.url), {
  namedExports: {
    getAuthUserId: (req: Request) => req.header("x-fixture-user") ?? null,
  },
});
const { calendarStaff } = await import("../lib/calendar-staff");
const { googlePilotRouter } = await import("./google-calendar-pilot");
const gateway: GoogleCalendarReadGateway = {
  async connections() {
    providerCalls++;
    entered?.();
    if (pause) await pause;
    if (fail) throw new Error("private-account@example.invalid SDK failure");
    return [{ id: "private-connection", connector_name: "google-calendar" }];
  },
  async read(_id, path, options) {
    providerCalls++;
    return {
      ok: true,
      status: 200,
      async json() {
        if (path === GOOGLE_PRIMARY_READ)
          return {
            id: "private-account@example.invalid",
            timeZone: "UTC",
            conferenceProperties: { allowedConferenceSolutionTypes: ["hangoutsMeet"] },
          };
        const body = options.body as { timeMin: string; timeMax: string };
        return {
          timeMin: body.timeMin,
          timeMax: body.timeMax,
          calendars: { "private-account@example.invalid": { busy: [] } },
        };
      },
    };
  },
};
const app = express();
// Let the route itself reject JSON null, rather than only testing body-parser's error page.
app.use(express.json({ strict: false }));
app.use(
  googlePilotRouter({
    staff: calendarStaff,
    gateway: () => {
      factoryCalls++;
      return gateway;
    },
  }),
);
const server = createServer(app);
let origin: string;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test port");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  role = "platform_admin";
  active = true;
  providerCalls = 0;
  factoryCalls = 0;
  fail = false;
  pause = null;
  entered = null;
  callerIds.length = 0;
});
const body = { confirmReadOnlyCheck: true };
function post(input: unknown = body, user = "fixture-admin") {
  return fetch(`${origin}/google-calendar/pilot-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(user ? { "x-fixture-user": user } : {}) },
    body: JSON.stringify(input),
  });
}
test("anonymous, inactive and all non-platform roles stop before SDK construction", async () => {
  assert.equal((await post(body, "")).status, 401);
  active = false;
  assert.equal((await post()).status, 401);
  active = true;
  for (const value of [
    "candidate",
    "tenant_admin",
    "recruiter_admin",
    "recruiter",
    "hiring_manager",
    "interviewer",
  ]) {
    role = value;
    assert.equal((await post()).status, 403);
  }
  assert.equal(providerCalls, 0);
  assert.equal(factoryCalls, 0);
  assert.equal(callerIds[0], null);
});
test("acknowledgement is strict; caller cannot choose a calendar, connection or window", async () => {
  for (const input of [
    {},
    null,
    { confirmReadOnlyCheck: false },
    { ...body, connectionId: "foreign" },
    { ...body, calendarId: "foreign" },
    { ...body, timeMin: "2035-11-01" },
    { ...body, tenantId: "foreign" },
  ]) {
    assert.equal((await post(input)).status, 400);
  }
  assert.equal(providerCalls, 0);
  assert.equal(factoryCalls, 0);
});
test("read-only receipt is uncached, contains no identity or availability and never enables invitations", async () => {
  const response = await post();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.text(),
    result = JSON.parse(text);
  assert.equal(result.status, "verified");
  assert.equal(result.invitationsEnabled, false);
  assert.equal(result.accountBinding, "not_configured");
  assert.equal(result.availabilityReadVerified, true);
  assert.equal(text.includes("private-account"), false);
  assert.equal(text.includes("private-connection"), false);
  assert.equal(providerCalls, 3);
});
test("provider error is sanitized and a later explicit check can recover", async () => {
  fail = true;
  const response = await post();
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.equal(text.includes("private-account"), false);
  assert.equal(text.includes("SDK failure"), false);
  fail = false;
  assert.equal((await post()).status, 200);
});
test("concurrent checks do not issue a second provider read", async () => {
  let release!: () => void;
  pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = post();
  await started;
  try {
    const second = await post();
    assert.equal(second.status, 409);
    assert.equal(factoryCalls, 1);
    assert.equal(providerCalls, 1);
  } finally {
    release();
  }
  assert.equal((await first).status, 200);
});
