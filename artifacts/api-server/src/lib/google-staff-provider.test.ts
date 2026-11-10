import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { googleStaffProvider, verifyGoogleStaffIdentity } from "./google-staff-provider";
import { googleStaffConfig, digest, GOOGLE_STAFF_SCOPES } from "./google-staff-config";

const config = googleStaffConfig({
  GOOGLE_CALENDAR_CLIENT_ID: "fixture.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic-secret",
  GOOGLE_CALENDAR_REDIRECT_URI: "https://api.example.test/api/google-calendar/callback",
  GOOGLE_CALENDAR_SETTINGS_URL: "https://app.example.test/settings/calendar",
  SESSION_SECRET: "synthetic-secret",
})!;
const start = "2035-01-01T10:00:00.000Z",
  end = "2035-01-01T10:30:00.000Z";
const token = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: GOOGLE_STAFF_SCOPES.join(" "),
  id_token: "synthetic-token",
};
const claims = {
  sub: "google-subject",
  email: "owner@example.test",
  email_verified: true,
  nonce: "synthetic-nonce",
  azp: config.clientId,
};
const body = () => ({
  timeMin: start,
  timeMax: end,
  calendars: { "primary@example.test": { busy: [] as Array<{ start: string; end: string }> } },
});
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("customer provider calls only token, fixed primary metadata and one exact free/busy calendar", async () => {
  const requests: Array<{ url: string; options: RequestInit | undefined }> = [];
  const request: typeof fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/token")) return response(token);
    if (String(url).includes("/calendars/primary?"))
      return response({ id: "primary@example.test", timeZone: "UTC" });
    return response(body());
  };
  const provider = googleStaffProvider(config, request, async () => claims);
  const grant = await provider.authorize(
    "synthetic-code",
    "synthetic-verifier",
    digest(claims.nonce),
  );
  assert.deepEqual(grant, {
    subject: claims.sub,
    email: claims.email,
    refreshToken: token.refresh_token,
  });
  const refreshed = await provider.refresh(grant.refreshToken);
  assert.equal(await provider.busy(refreshed.accessToken, start, end), false);
  assert.deepEqual(
    requests.map((r) => new URL(r.url).pathname),
    ["/token", "/token", "/calendar/v3/calendars/primary", "/calendar/v3/freeBusy"],
  );
  const exchange = new URLSearchParams(requests[0].options!.body as URLSearchParams);
  assert.equal(exchange.get("code_verifier"), "synthetic-verifier");
  assert.equal(exchange.get("redirect_uri"), config.redirectUri);
  const availability = JSON.parse(requests[3].options!.body as string);
  assert.deepEqual(availability, {
    timeMin: start,
    timeMax: end,
    timeZone: "UTC",
    calendarExpansionMax: 1,
    items: [{ id: "primary@example.test" }],
  });
  assert.ok(requests.every((r) => r.options?.redirect === "error" && r.options.signal));
});
test("missing offline grant, scopes, verified email, nonce or authorized party never binds", async () => {
  for (const bad of [
    { ...token, refresh_token: undefined },
    { ...token, id_token: undefined },
    { ...token, scope: "openid email" },
  ]) {
    const provider = googleStaffProvider(
      config,
      async () => response(bad),
      async () => claims,
    );
    await assert.rejects(provider.authorize("code", "verifier", digest(claims.nonce)));
  }
  for (const bad of [
    { ...claims, email_verified: false },
    { ...claims, nonce: "wrong" },
    { ...claims, azp: "foreign-client" },
    { ...claims, email: "not-an-email" },
    { ...claims, sub: "" },
  ]) {
    const provider = googleStaffProvider(
      config,
      async () => response(token),
      async () => bad,
    );
    await assert.rejects(provider.authorize("code", "verifier", digest(claims.nonce)));
  }
});
test("signed ID tokens require Google issuer, this client audience, valid signature and fresh expiry", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "synthetic-key";
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = async (issuer: string, audience: string, expired = false) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(expired ? Math.floor(Date.now() / 1000) - 3600 : Math.floor(Date.now() / 1000))
      .setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 1800 : "5m")
      .sign(privateKey);
  assert.equal(
    (
      await verifyGoogleStaffIdentity(
        config,
        await sign("https://accounts.google.com", config.clientId),
        keys,
      )
    ).sub,
    claims.sub,
  );
  for (const [issuer, audience, expired] of [
    ["https://attacker.example.test", config.clientId, false],
    ["https://accounts.google.com", "foreign", false],
    ["https://accounts.google.com", config.clientId, true],
  ] as const)
    await assert.rejects(
      verifyGoogleStaffIdentity(config, await sign(issuer, audience, expired), keys),
    );
  const other = await generateKeyPair("RS256");
  const forged = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(config.clientId)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(other.privateKey);
  await assert.rejects(verifyGoogleStaffIdentity(config, forged, keys));
});
test("incomplete, foreign-calendar and malformed availability never become free", async () => {
  const cases = [
    {},
    { ...body(), timeMax: start },
    { ...body(), calendars: {} },
    { ...body(), calendars: { "foreign@example.test": { busy: [] } } },
    {
      ...body(),
      calendars: { "primary@example.test": { busy: [], errors: [{ reason: "forbidden" }] } },
    },
    { ...body(), groups: { foreign: {} } },
    { ...body(), calendars: { "primary@example.test": { busy: [{ start: end, end: start }] } } },
    {
      ...body(),
      calendars: { "primary@example.test": { busy: [{ start: "2035-01-01T09:00:00Z", end }] } },
    },
    { ...body(), calendars: { "primary@example.test": {} } },
  ];
  for (const value of cases) {
    const provider = googleStaffProvider(config, async (url) =>
      String(url).includes("/calendars/primary?")
        ? response({ id: "primary@example.test", timeZone: "UTC" })
        : response(value),
    );
    await assert.rejects(provider.busy("synthetic-access", start, end));
  }
});
test("provider errors are sanitized; revoked grants are distinct from temporary failures", async () => {
  for (const status of [401, 403, 429, 500]) {
    const provider = googleStaffProvider(config, async () =>
      response({ error: "private diagnostic details" }, status),
    );
    await assert.rejects(provider.busy("synthetic-access", start, end), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("private"), false);
      assert.equal(
        "status" in error ? error.status : null,
        status === 401 || status === 403 ? 409 : 503,
      );
      return true;
    });
  }
  const provider = googleStaffProvider(config, async () =>
    response({ error: "invalid_grant", error_description: "private Google diagnostic" }, 400),
  );
  await assert.rejects(
    provider.refresh("synthetic-refresh"),
    (error) =>
      error instanceof Error && "code" in error && error.code === "google_reconnect_required",
  );
});
test("configuration rejects hostile callback/settings URLs and needs separate staff OAuth credentials", () => {
  assert.equal(googleStaffConfig({}), null);
  const env = {
    GOOGLE_CALENDAR_CLIENT_ID: config.clientId,
    GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic",
    GOOGLE_CALENDAR_REDIRECT_URI: config.redirectUri,
    GOOGLE_CALENDAR_SETTINGS_URL: config.settingsUrl,
    SESSION_SECRET: "synthetic",
  };
  for (const url of [
    "http://api.example.test/api/google-calendar/callback",
    "https://api.example.test/other",
    "https://api.example.test/api/google-calendar/callback?return=attacker",
  ])
    assert.equal(googleStaffConfig({ ...env, GOOGLE_CALENDAR_REDIRECT_URI: url }), null);
  assert.equal(
    googleStaffConfig({
      ...env,
      GOOGLE_CALENDAR_SETTINGS_URL: "https://app.example.test/settings/calendar#fragment",
    }),
    null,
  );
});
