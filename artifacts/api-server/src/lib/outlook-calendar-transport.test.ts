import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { CalendarError } from "./outlook-calendar-core";

function fresh() {
  return {
    account: { status: "connected", scopes: "Mail.Send Mail.Read Calendars.ReadWrite" } as {
      status: string;
      scopes: string;
    } | null,
    token: "fixture-access",
    tokenRequests: [] as unknown[][],
    response: new Response('{"value":[]}', { status: 200 }),
    failure: null as Error | null,
    calls: [] as { url: string; init: RequestInit }[],
  };
}
let state = fresh();
mock.module(new URL("./recruiter-mail.ts", import.meta.url), {
  namedExports: { getMailAccount: async () => state.account },
});
mock.module(new URL("./graph-auth.ts", import.meta.url), {
  namedExports: {
    getAccessTokenForUser: async (...args: unknown[]) => {
      state.tokenRequests.push(args);
      return state.token;
    },
  },
});
mock.module(new URL("./vendor-usage.ts", import.meta.url), {
  namedExports: {
    meteredFetch: (provider: string) => async (url: string, init: RequestInit) => {
      assert.equal(provider, "ms_graph");
      state.calls.push({ url, init });
      if (state.failure) throw state.failure;
      return state.response;
    },
  },
});
const { outlookCalendarRequest } = await import("./outlook-calendar");
beforeEach(() => {
  state = fresh();
});
const code = (expected: string) => (error: unknown) =>
  error instanceof CalendarError && error.code === expected;

test("missing, disconnected and mail-only accounts stop before token or provider access", async () => {
  for (const account of [
    null,
    { status: "revoked", scopes: "Calendars.ReadWrite" },
    { status: "connected", scopes: "Mail.Read Mail.Send" },
  ]) {
    state = fresh();
    state.account = account;
    await assert.rejects(outlookCalendarRequest("fixture-user"), code("calendar_consent_required"));
    assert.equal(state.tokenRequests.length, 0);
    assert.equal(state.calls.length, 0);
  }
});
test("missing calendar token produces reconnect guidance without provider fallback", async () => {
  state.token = "";
  await assert.rejects(outlookCalendarRequest("fixture-user"), code("calendar_reconnect_required"));
  assert.deepEqual(state.tokenRequests, [["fixture-user", ["Calendars.ReadWrite"]]]);
  assert.equal(state.calls.length, 0);
});
test("request is delegated, UTC, immutable-id, bounded, and preserves revision headers", async () => {
  const request = await outlookCalendarRequest("fixture-user");
  await request("/me/events", {
    headers: new Headers({ "If-Match": 'W/"fixture"', Authorization: "not-the-authorized-token" }),
  });
  const { url, init } = state.calls[0];
  const headers = new Headers(init.headers);
  assert.equal(url, "https://graph.microsoft.com/v1.0/me/events");
  assert.equal(headers.get("If-Match"), 'W/"fixture"');
  assert.equal(headers.get("Authorization"), "Bearer fixture-access");
  assert.equal(headers.get("Prefer"), 'outlook.timezone="UTC", IdType="ImmutableId"');
  assert.equal(init.redirect, "error");
  assert.ok(init.signal);
});
test("provider status failures remain explicit and do not expose private response bodies", async () => {
  for (const [status, expected, mapped] of [
    [401, "calendar_reconnect_required", 502],
    [403, "calendar_reconnect_required", 502],
    [412, "calendar_changed", 409],
    [429, "calendar_provider_error", 429],
    [404, "calendar_provider_error", 502],
    [500, "calendar_provider_error", 502],
  ] as const) {
    state = fresh();
    state.response = new Response("fixture-private-provider-body", { status });
    const request = await outlookCalendarRequest("fixture-user");
    await assert.rejects(
      request("/me/events"),
      (error: unknown) =>
        code(expected)(error) &&
        (error as CalendarError).status === mapped &&
        !(error as Error).message.includes("fixture-private-provider-body"),
    );
  }
});
test("lost write responses and malformed success bodies are uncertain, never success", async () => {
  for (const mode of ["lost", "malformed"] as const) {
    state = fresh();
    if (mode === "lost") state.failure = new Error("fixture-private-provider-detail");
    else state.response = new Response("fixture-private-non-json", { status: 200 });
    const request = await outlookCalendarRequest("fixture-user");
    await assert.rejects(
      request("/me/events", { method: "POST", body: "{}" }),
      code("calendar_request_uncertain"),
    );
  }
});
test("a confirmed bodyless deletion returns normally", async () => {
  state.response = new Response(null, { status: 204 });
  const request = await outlookCalendarRequest("fixture-user");
  assert.equal(await request("/me/events/fixture-event", { method: "DELETE" }), undefined);
});
test("an external destination cannot receive the user's token", async () => {
  const request = await outlookCalendarRequest("fixture-user");
  await assert.rejects(request("https://example.invalid/collect"));
  assert.equal(state.calls.length, 0);
});
