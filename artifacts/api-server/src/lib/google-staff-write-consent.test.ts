import test from "node:test";
import assert from "node:assert/strict";
import { googleStaffProvider } from "./google-staff-provider";
import {
  GOOGLE_STAFF_SCOPES,
  GOOGLE_INVITATION_SCOPE,
  googleStaffConsent,
  digest,
  type GoogleStaffConfig,
} from "./google-staff-config";
const cfg: GoogleStaffConfig = {
  clientId: "synthetic.apps.googleusercontent.com",
  clientSecret: "synthetic-secret",
  redirectUri: "https://example.test/api/google-calendar/callback",
  settingsUrl: "https://example.test/settings/calendar",
  fingerprint: "synthetic",
};
const nonce = "synthetic-nonce";
function provider(scopes: string) {
  return googleStaffProvider(
    cfg,
    async () =>
      Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        id_token: "synthetic-id",
        token_type: "Bearer",
        expires_in: 3600,
        scope: scopes,
      }),
    async () => ({
      sub: "synthetic-subject",
      email: "staff@example.test",
      email_verified: true,
      nonce,
    }),
  );
}
test("Default Google consent never requests event writes; opt-in adds only owned-event permission", () => {
  const base = new URL(googleStaffConsent(cfg, "state", "challenge", "nonce"));
  assert.equal(base.searchParams.get("scope"), GOOGLE_STAFF_SCOPES.join(" "));
  assert.ok(!base.searchParams.get("scope")!.includes("calendar.events"));
  const opted = new URL(googleStaffConsent(cfg, "state", "challenge", "nonce", true));
  assert.equal(
    opted.searchParams.get("scope"),
    [...GOOGLE_STAFF_SCOPES, GOOGLE_INVITATION_SCOPE].join(" "),
  );
  assert.equal(opted.searchParams.get("include_granted_scopes"), "false");
});
test("Declined/partial write permission cannot produce a write-capable verified grant", async () => {
  const base = GOOGLE_STAFF_SCOPES.join(" ");
  await assert.rejects(provider(base).authorize("code", "verifier", digest(nonce), true));
  assert.equal(
    (await provider(base).authorize("code", "verifier", digest(nonce), false)).subject,
    "synthetic-subject",
  );
  assert.equal(
    (
      await provider(`${base} ${GOOGLE_INVITATION_SCOPE}`).authorize(
        "code",
        "verifier",
        digest(nonce),
        true,
      )
    ).subject,
    "synthetic-subject",
  );
});
test("Write refresh rechecks returned scopes; read-only refresh stays compatible", async () => {
  const base = GOOGLE_STAFF_SCOPES.join(" ");
  await assert.rejects(provider(base).refresh("synthetic-refresh", true));
  assert.equal(
    (await provider(base).refresh("synthetic-refresh", false)).accessToken,
    "synthetic-access",
  );
  assert.equal(
    (await provider(`${base} ${GOOGLE_INVITATION_SCOPE}`).refresh("synthetic-refresh", true))
      .accessToken,
    "synthetic-access",
  );
});
