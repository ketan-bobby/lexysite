import { test } from "node:test";
import assert from "node:assert/strict";
import { googleStaffConfig, digest } from "./google-staff-config";
import {
  googleMeetRecordingConfig,
  googleMeetRecordingConsent,
  googleMeetRecordingOAuth,
} from "./google-meet-recording-oauth";
import { GOOGLE_MEET_RECORDING_SCOPES } from "./google-meet-recordings-provider";

const base = googleStaffConfig({
  GOOGLE_CALENDAR_CLIENT_ID: "fixture.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic-secret",
  GOOGLE_CALENDAR_REDIRECT_URI: "https://api.example.test/api/google-calendar/callback",
  GOOGLE_CALENDAR_SETTINGS_URL: "https://app.example.test/settings/calendar",
  SESSION_SECRET: "synthetic-secret",
})!;
const config = googleMeetRecordingConfig(base)!;
const reply = () => ({
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  id_token: "synthetic-id",
  token_type: "Bearer",
  expires_in: 3600,
  scope: GOOGLE_MEET_RECORDING_SCOPES.join(" "),
});
const identity = () => ({
  sub: "synthetic-subject",
  email: "staff@example.test",
  email_verified: true,
  nonce: "synthetic-nonce",
  azp: config.clientId,
});
test("separate callback/fingerprint and narrow grants do not mutate calendar configuration", () => {
  assert.equal(base.redirectUri, "https://api.example.test/api/google-calendar/callback");
  assert.notEqual(config.fingerprint, base.fingerprint);
  assert.equal(googleMeetRecordingConfig(null), null);
  const url = new URL(googleMeetRecordingConsent(config, "state", "challenge", "nonce"));
  assert.equal(
    url.searchParams.get("scope"),
    ["openid", "email", ...GOOGLE_MEET_RECORDING_SCOPES].join(" "),
  );
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.ok(!url.toString().includes("synthetic-secret"));
});
test("authorization exchanges code/PKCE once at the fixed endpoint and validates identity", async () => {
  let calls = 0;
  const provider = googleMeetRecordingOAuth(
    config,
    async (url, init) => {
      calls++;
      assert.equal(String(url), "https://oauth2.googleapis.com/token");
      assert.equal(init?.redirect, "error");
      const params = init!.body as URLSearchParams;
      assert.equal(params.get("code_verifier"), "synthetic-verifier");
      assert.equal(params.get("redirect_uri"), config.redirectUri);
      return Response.json(reply());
    },
    async () => identity(),
  );
  assert.deepEqual(
    await provider.authorize("synthetic-code", "synthetic-verifier", digest("synthetic-nonce")),
    {
      subject: "synthetic-subject",
      email: "staff@example.test",
      refreshToken: "synthetic-refresh",
    },
  );
  assert.equal(calls, 1);
});
test("calendar-only, missing or partially granted scopes cannot bind or refresh recording access", async () => {
  for (const scope of [
    undefined,
    "",
    GOOGLE_MEET_RECORDING_SCOPES[0],
    "https://www.googleapis.com/auth/calendar.freebusy",
  ]) {
    const provider = googleMeetRecordingOAuth(
      config,
      async () => Response.json({ ...reply(), scope }),
      async () => identity(),
    );
    await assert.rejects(provider.authorize("code", "verifier", digest("synthetic-nonce")));
    await assert.rejects(provider.refresh("synthetic-refresh"));
  }
});
test("unverified/wrong identity, nonce or authorized party never binds", async () => {
  for (const claims of [
    { ...identity(), email_verified: false },
    { ...identity(), nonce: "wrong" },
    { ...identity(), azp: "another-client" },
    { ...identity(), sub: "" },
  ]) {
    const provider = googleMeetRecordingOAuth(
      config,
      async () => Response.json(reply()),
      async () => claims,
    );
    await assert.rejects(provider.authorize("code", "verifier", digest("synthetic-nonce")));
  }
});
test("offline refresh and identity token are required for initial binding", async () => {
  for (const patch of [{ refresh_token: undefined }, { id_token: undefined }]) {
    const provider = googleMeetRecordingOAuth(
      config,
      async () => Response.json({ ...reply(), ...patch }),
      async () => identity(),
    );
    await assert.rejects(provider.authorize("code", "verifier", digest("synthetic-nonce")));
  }
});
test("scope-verified refresh supports optional credential rotation", async () => {
  for (const refresh_token of [undefined, "rotated-fixture"]) {
    const provider = googleMeetRecordingOAuth(config, async (_url, init) => {
      assert.equal((init!.body as URLSearchParams).get("grant_type"), "refresh_token");
      return Response.json({ ...reply(), refresh_token });
    });
    assert.deepEqual(await provider.refresh("synthetic-refresh"), {
      accessToken: "synthetic-access",
      ...(refresh_token ? { refreshToken: refresh_token } : {}),
    });
  }
});
test("provider failures, invalid grants, oversized bodies and malformed responses are sanitized without retry", async () => {
  for (const response of [
    () => Response.json({ error: "invalid_grant", description: "sensitive-body" }, { status: 400 }),
    () => new Response("sensitive-body", { status: 503 }),
    () => new Response("x".repeat(65537)),
    () => Response.json({ ...reply(), access_token: "" }),
  ]) {
    let calls = 0;
    const provider = googleMeetRecordingOAuth(config, async () => {
      calls++;
      return response();
    });
    await assert.rejects(
      provider.refresh("synthetic-refresh"),
      (error: unknown) =>
        !String(error).includes("sensitive-body") && !String(error).includes("synthetic-refresh"),
    );
    assert.equal(calls, 1);
  }
});
