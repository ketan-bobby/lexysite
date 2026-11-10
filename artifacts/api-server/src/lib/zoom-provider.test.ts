import assert from "node:assert/strict";
import { test } from "node:test";
import { zoomAppConfig, zoomProvider } from "./zoom-provider";

const config = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://api.example.com/api/zoom-account/callback",
  settingsUrl: "https://app.example.com/settings/calendar",
};
test("Zoom configuration fails closed without a staff OAuth app and HTTPS callback", () => {
  assert.equal(zoomAppConfig({}), null);
  assert.equal(zoomAppConfig({ ZOOM_OAUTH_CLIENT_ID: "a" }), null);
  assert.equal(
    zoomAppConfig({
      ZOOM_OAUTH_CLIENT_ID: "a",
      ZOOM_OAUTH_CLIENT_SECRET: "b",
      ZOOM_OAUTH_REDIRECT_URI: "http://example.com/api/zoom-account/callback",
      ZOOM_OAUTH_SETTINGS_URL: config.settingsUrl,
      SESSION_SECRET: "local-only-test",
    }),
    null,
  );
});
test("Zoom provider uses staff authorization code, refresh and verified identity", async () => {
  const calls: { url: string; method: string; authorization: string }[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const uri = String(url);
    calls.push({
      url: uri,
      method: init?.method ?? "",
      authorization: new Headers(init?.headers).get("Authorization") ?? "",
    });
    return Response.json(
      uri.endsWith("/users/me")
        ? { id: "zoom-host", email: "host@example.com" }
        : { access_token: "access", refresh_token: "refresh" },
    );
  };
  const provider = zoomProvider(config, fake as typeof fetch);
  const url = new URL(provider.authorizeUrl("state"));
  assert.equal(url.hostname, "zoom.us");
  assert.equal(url.searchParams.get("state"), "state");
  assert.equal(url.searchParams.get("redirect_uri"), config.redirectUri);
  assert.deepEqual(await provider.authorize("code"), {
    zoomUserId: "zoom-host",
    email: "host@example.com",
    refreshToken: "refresh",
  });
  assert.equal((await provider.refresh("previous")).refresh_token, "refresh");
  assert.deepEqual(
    calls.map((c) => [c.method, new URL(c.url).pathname]),
    [
      ["POST", "/oauth/token"],
      ["GET", "/v2/users/me"],
      ["POST", "/oauth/token"],
    ],
  );
  assert.match(calls[0].authorization, /^Basic /);
  assert.equal(calls[1].authorization, "Bearer access");
});
test("meeting creation, read, update and deletion use user-scoped Zoom routes", async () => {
  const calls: { method: string; pathname: string; body?: unknown }[] = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      method: init?.method ?? "",
      pathname: new URL(String(url)).pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (init?.method === "DELETE" || init?.method === "PATCH")
      return new Response(null, { status: 204 });
    return Response.json({ id: 12345678901, join_url: "https://us06web.zoom.us/j/12345678901" });
  };
  const provider = zoomProvider(config, fake as typeof fetch);
  const expected = { meetingId: "12345678901", joinUrl: "https://us06web.zoom.us/j/12345678901" };
  assert.deepEqual(
    await provider.create("token", "Interview", "2026-11-01T10:00:00.000Z", 30),
    expected,
  );
  assert.deepEqual(
    await provider.update("token", expected.meetingId, "2026-11-02T10:00:00.000Z", 60),
    expected,
  );
  await provider.remove("token", expected.meetingId);
  assert.deepEqual(
    calls.map((c) => [c.method, c.pathname]),
    [
      ["POST", "/v2/users/me/meetings"],
      ["PATCH", "/v2/meetings/12345678901"],
      ["GET", "/v2/meetings/12345678901"],
      ["DELETE", "/v2/meetings/12345678901"],
    ],
  );
  assert.deepEqual((calls[0].body as any).settings, {
    waiting_room: true,
    join_before_host: false,
  });
});
test("an invalid Zoom response, failed request or unexpected host never yields a meeting receipt", async () => {
  const blocked = zoomProvider(config, async () =>
    Response.json({ id: "12345678901", join_url: "https://evil.example/j/12345678901" }),
  );
  await assert.rejects(() => blocked.create("token", "Interview", "2026-11-01T10:00:00Z", 30));
  const denied = zoomProvider(config, async () => new Response(null, { status: 401 }));
  await assert.rejects(() => denied.read("token", "12345678901"), {
    code: "zoom_reconnect_required",
  });
  const uncertain = zoomProvider(config, async () => {
    throw new Error("network");
  });
  await assert.rejects(() => uncertain.remove("token", "12345678901"), {
    code: "zoom_provider_unavailable",
  });
});
test("Zoom recovery transport reads exact host/time/operation evidence and accepts only a documented missing result", async () => {
  const calls: { method?: string; body?: unknown }[] = [];
  const operation = "original-operation";
  const body = {
    id: 12345678901,
    join_url: "https://zoom.us/j/12345678901",
    host_id: "host",
    topic: "Interview",
    type: 2,
    start_time: "2026-11-01T10:00:00Z",
    duration: 30,
    agenda: `Lexy operation: ${operation}`,
    start_url: "PRIVATE-NEVER-RETURN",
  };
  const provider = zoomProvider(config, async (_url, init) => {
    calls.push({ method: init?.method, body: init?.body && JSON.parse(String(init.body)) });
    return Response.json(body);
  });
  await provider.create("token", "Interview", body.start_time, 30, operation);
  assert.equal((calls[0].body as any).agenda, body.agenda);
  const evidence = await provider.inspect("token", "12345678901");
  assert.equal(evidence?.hostZoomId, "host");
  assert.equal(evidence?.agenda, body.agenda);
  assert.equal(JSON.stringify(evidence).includes("PRIVATE-NEVER-RETURN"), false);
  assert.equal(calls[1].method, "GET");
  assert.equal(
    await zoomProvider(config, async () => Response.json({ code: 3001 }, { status: 404 })).inspect(
      "t",
      "12345678901",
    ),
    null,
  );
  for (const response of [
    Response.json({ code: 999 }, { status: 404 }),
    new Response("not-json", { status: 404 }),
    Response.json({ code: 3001 }, { status: 403 }),
    Response.json({ ...body, type: 8 }),
    Response.json({ ...body, id: 12345678902 }),
  ]) {
    await assert.rejects(() =>
      zoomProvider(config, async () => response).inspect("t", "12345678901"),
    );
  }
});
