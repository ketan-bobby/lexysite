import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import express, { type Request } from "express";
import cookieParser from "cookie-parser";
import { createServer } from "node:http";
import { CalendarError } from "../lib/outlook-calendar-core";
import { googleMeetRecordingConfig } from "../lib/google-meet-recording-oauth";
import { googleStaffConfig } from "../lib/google-staff-config";

mock.module(new URL("../lib/auth-token.ts", import.meta.url), {
  namedExports: { getAuthUserId: (req: Request) => req.header("x-fixture-user") ?? null },
});
const { googleMeetRecordingAccountRouter } = await import("./google-meet-recording-account");
const config = googleMeetRecordingConfig(
  googleStaffConfig({
    GOOGLE_CALENDAR_CLIENT_ID: "fixture.apps.googleusercontent.com",
    GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic-secret",
    GOOGLE_CALENDAR_REDIRECT_URI: "https://api.example.test/api/google-calendar/callback",
    GOOGLE_CALENDAR_SETTINGS_URL: "https://app.example.test/settings/calendar",
    SESSION_SECRET: "synthetic-secret",
  }),
)!;
const actor = { id: "staff-fixture", tenantId: "employer-fixture" };
const revision = "c54ed488-ecde-44b4-a15d-662fc01018bf";
const status = {
  configured: true,
  state: "connected" as const,
  revision,
  accountEmail: "staff@example.test",
  connectedAt: new Date("2035-01-01"),
  canReadRecordings: true,
  redirectUri: config.redirectUri,
};
let actions: unknown[][] = [];
const app = express();
app.use(express.json(), cookieParser());
app.use(
  googleMeetRecordingAccountRouter({
    config: () => config,
    actor: async (id) => {
      if (!id || id === "inactive") throw new CalendarError(401, "unauthenticated", "Sign in.");
      if (id !== actor.id) throw new CalendarError(403, "staff_required", "Staff required.");
      return actor;
    },
    service: () => ({
      status: async (a) => {
        actions.push(["status", a]);
        return status;
      },
      begin: async (a) => {
        actions.push(["begin", a]);
        return {
          browser: "synthetic-browser",
          receipt: {
            authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic",
            expiresAt: "2035-01-01T00:10:00Z",
          },
        };
      },
      disconnect: async (a, rev) => {
        actions.push(["disconnect", a, rev]);
        return {
          ...status,
          state: "disconnected" as const,
          accountEmail: null,
          connectedAt: null,
          canReadRecordings: false,
        };
      },
      finish: async (a, input) => {
        actions.push(["finish", a, input]);
      },
      access: async () => {
        throw new Error("No recording download allowed in account routes");
      },
    }),
  }),
);
const server = createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});
async function call(path: string, body?: unknown, user: string | null = actor.id, cookie?: string) {
  return fetch(`${base}/google-meet-recordings${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(user ? { "x-fixture-user": user } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "manual",
  });
}
test("account reads are own-context and no-store, with no tokens returned", async () => {
  actions = [];
  const res = await call("/me");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(((await res.json()) as Record<string, unknown>).accountEmail, "staff@example.test");
  assert.deepEqual(actions, [["status", actor]]);
});
test("unauthenticated, inactive and candidate actors cannot read, connect or disconnect", async () => {
  for (const user of [null, "inactive", "candidate-fixture"]) {
    actions = [];
    for (const [path, body] of [
      ["/me", undefined],
      ["/me/connect", { confirmRecordingAccess: true }],
      ["/me/disconnect", { revision, confirmDisconnect: true }],
    ] as const) {
      const res = await call(path, body, user);
      assert.equal(res.status, user === "candidate-fixture" ? 403 : 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal(actions.length, 0);
  }
});
test("connect requires literal acknowledgement, rejects supplied identity, and sets only its scoped cookie", async () => {
  actions = [];
  for (const body of [
    {},
    { confirmRecordingAccess: false },
    { confirmRecordingAccess: "true" },
    { confirmRecordingAccess: true, tenantId: "foreign" },
  ]) {
    assert.equal((await call("/me/connect", body)).status, 400);
  }
  assert.equal(actions.length, 0);
  const res = await call("/me/connect", { confirmRecordingAccess: true });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie")!;
  assert.match(cookie, /lexy_google_meet_recording_flow=/);
  assert.match(cookie, /Path=\/api\/google-meet-recordings/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(!cookie.includes("lexy_google_calendar_flow"));
  assert.ok(!(await res.text()).includes("synthetic-browser"));
  assert.deepEqual(actions, [["begin", actor]]);
});
test("disconnect rejects false/foreign input and forwards only reviewed revision", async () => {
  actions = [];
  for (const body of [
    { revision, confirmDisconnect: false },
    { revision: "invalid", confirmDisconnect: true },
    { revision, confirmDisconnect: true, userId: "foreign" },
  ])
    assert.equal((await call("/me/disconnect", body)).status, 400);
  assert.equal(actions.length, 0);
  const res = await call("/me/disconnect", { revision, confirmDisconnect: true });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as Record<string, unknown>).canReadRecordings, false);
  assert.deepEqual(actions, [["disconnect", actor, revision]]);
});
test("callback clears its cookie, uses authenticated actor and fixed settings redirect without exposing code", async () => {
  actions = [];
  const res = await call(
    "/callback?state=fixture-state&code=fixture-code&returnTo=https://attacker.test",
    undefined,
    actor.id,
    "lexy_google_meet_recording_flow=fixture-browser",
  );
  assert.equal(res.status, 303);
  assert.equal(
    res.headers.get("location"),
    "https://app.example.test/settings/calendar?googleMeetRecordings=connected",
  );
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.match(res.headers.get("set-cookie")!, /lexy_google_meet_recording_flow=;/);
  assert.deepEqual(actions, [
    [
      "finish",
      actor,
      { state: "fixture-state", code: "fixture-code", browser: "fixture-browser", denied: false },
    ],
  ]);
  actions = [];
  const denied = await call(
    "/callback?state=fixture-state&code=fixture-code",
    undefined,
    "candidate-fixture",
  );
  assert.equal(
    denied.headers.get("location"),
    "https://app.example.test/settings/calendar?googleMeetRecordings=error",
  );
  assert.equal(actions.length, 0);
});
