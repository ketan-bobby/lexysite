import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import express, { type Request } from "express";
import cookieParser from "cookie-parser";
import { createServer } from "node:http";
import { CalendarError } from "../lib/outlook-calendar-core";
import { googleStaffConfig } from "../lib/google-staff-config";
import type { GoogleStaffActor } from "../lib/google-staff-store";

mock.module(new URL("../lib/auth-token.ts", import.meta.url), {
  namedExports: { getAuthUserId: (req: Request) => req.header("x-fixture-user") ?? null },
});
const { googleStaffCalendarRouter } = await import("./google-staff-calendar");
const config = googleStaffConfig({
  GOOGLE_CALENDAR_CLIENT_ID: "fixture.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic-secret",
  GOOGLE_CALENDAR_REDIRECT_URI: "https://api.example.test/api/google-calendar/callback",
  GOOGLE_CALENDAR_SETTINGS_URL: "https://app.example.test/settings/calendar",
  SESSION_SECRET: "synthetic-secret",
})!;
const revision = "c54ed488-ecde-44b4-a15d-662fc01018bf";
const status = {
  configured: true,
  state: "connected" as const,
  revision,
  accountEmail: "owner@example.test",
  connectedAt: new Date("2035-01-01"),
  canCheckAvailability: true,
  canSendInvitations: false,
};
let rolesAllowed = true,
  active = true,
  factories = 0,
  actions: Array<unknown> = [];
const actor: GoogleStaffActor = { id: "fixture-staff", tenantId: "fixture-employer" };
const app = express();
app.use(express.json({ strict: false }), cookieParser());
app.use(
  googleStaffCalendarRouter({
    config: () => config,
    actor: async (id) => {
      if (!id || !active) throw new CalendarError(401, "unauthenticated", "Please sign in.");
      if (!rolesAllowed) throw new CalendarError(403, "staff_required", "Staff required.");
      return actor;
    },
    service: () => {
      factories++;
      return {
        status: async (a: GoogleStaffActor) => {
          actions.push(["status", a]);
          return status;
        },
        begin: async (a: GoogleStaffActor) => {
          actions.push(["begin", a]);
          return {
            browser: "synthetic-browser",
            receipt: {
              authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic",
              expiresAt: "2035-01-01T00:10:00Z",
            },
          };
        },
        disconnect: async (a: GoogleStaffActor, rev: string) => {
          actions.push(["disconnect", a, rev]);
          return {
            ...status,
            state: "disconnected" as const,
            accountEmail: null,
            connectedAt: null,
            canCheckAvailability: false,
          };
        },
        availability: async (a: GoogleStaffActor, input: unknown) => {
          actions.push(["availability", a, input]);
          return {
            revision,
            startAt: new Date("2035-01-01T10:00Z"),
            endAt: new Date("2035-01-01T10:30Z"),
            checkedAt: new Date(),
            status: "free" as const,
            reserved: false as const,
            invitationsEnabled: false as const,
          };
        },
        finish: async (
          a: GoogleStaffActor,
          input: { state: string; browser: string; code: string; denied: boolean },
        ) => {
          actions.push(["finish", a, input]);
          if (input.denied) throw new Error("sensitive Google diagnostic");
        },
      };
    },
  }),
);
const server = createServer(app);
let origin = "";
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  rolesAllowed = true;
  active = true;
  factories = 0;
  actions = [];
});
const request = (
  path = "/google-calendar/me",
  body?: unknown,
  headers: Record<string, string> = { "x-fixture-user": "fixture-staff" },
) =>
  fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
test("anonymous, inactive and candidate principals stop before service construction", async () => {
  assert.equal((await request(undefined, undefined, {})).status, 401);
  active = false;
  assert.equal((await request()).status, 401);
  active = true;
  rolesAllowed = false;
  for (const path of [
    "/google-calendar/me",
    "/google-calendar/me/connect",
    "/google-calendar/me/disconnect",
    "/google-calendar/me/availability",
  ])
    assert.equal((await request(path, path.endsWith("/me") ? undefined : {})).status, 403);
  assert.equal(factories, 0);
  assert.equal(actions.length, 0);
});
test("status is self/employer scoped and uncached; credentials never enter the HTTP response", async () => {
  const result = await request();
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(await result.json(), {
    ...status,
    connectedAt: status.connectedAt.toISOString(),
  });
  assert.deepEqual(actions, [["status", actor]]);
});
test("strict true acknowledgements reject spoofed identity, foreign connection and extra properties", async () => {
  for (const bad of [
    null,
    {},
    false,
    { confirmOwnCalendar: false },
    { confirmOwnCalendar: true, userId: "foreign" },
    { confirmOwnCalendar: true, tenantId: "foreign" },
    { confirmOwnCalendar: true, connectionId: "project" },
  ])
    assert.equal((await request("/google-calendar/me/connect", bad)).status, 400);
  for (const bad of [
    { revision, confirmDisconnect: false },
    { revision, confirmDisconnect: true, userId: "foreign" },
    { revision: "bad", confirmDisconnect: true },
  ])
    assert.equal((await request("/google-calendar/me/disconnect", bad)).status, 400);
  assert.equal(actions.length, 0);
});
test("consent uses a secure same-site browser cookie and exact local staff ownership", async () => {
  const response = await request("/google-calendar/me/connect", { confirmOwnCalendar: true });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/google-calendar"])
    assert.ok(cookie.includes(flag));
  assert.deepEqual(actions, [["begin", actor]]);
  const body = await response.json();
  assert.ok(body && typeof body === "object");
  assert.equal("browser" in body, false);
});
test("disconnect targets only the authenticated actor and caller-reviewed revision", async () => {
  const response = await request("/google-calendar/me/disconnect", {
    revision,
    confirmDisconnect: true,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body && typeof body === "object" && "canCheckAvailability" in body);
  assert.equal(body.canCheckAvailability, false);
  assert.deepEqual(actions, [["disconnect", actor, revision]]);
});
test("callback uses current staff identity and redirects only to configured settings without private query data", async () => {
  const response = await request(
    "/google-calendar/callback?state=synthetic-state&code=synthetic-code&return=https://attacker.example.test",
    undefined,
    {
      "x-fixture-user": "fixture-staff",
      cookie: "lexy_google_calendar_flow=synthetic-browser",
    },
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), config.settingsUrl + "?googleCalendar=connected");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(actions, [
    [
      "finish",
      actor,
      {
        state: "synthetic-state",
        browser: "synthetic-browser",
        code: "synthetic-code",
        denied: false,
      },
    ],
  ]);
  actions = [];
  const denied = await request(
    "/google-calendar/callback?state=synthetic&error=access_denied&error_description=private-detail",
  );
  assert.equal(denied.headers.get("location"), config.settingsUrl + "?googleCalendar=error");
  assert.equal(denied.headers.get("location")!.includes("private-detail"), false);
  actions = [];
  active = false;
  const inactive = await request("/google-calendar/callback?state=synthetic&code=synthetic");
  assert.equal(inactive.headers.get("location"), config.settingsUrl + "?googleCalendar=error");
  assert.equal(actions.length, 0);
});
