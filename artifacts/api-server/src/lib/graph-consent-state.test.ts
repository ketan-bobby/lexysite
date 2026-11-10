import { test } from "node:test";
import assert from "node:assert/strict";
import { sealGraphConsent, openGraphConsent } from "./graph-consent-state";

process.env.SESSION_SECRET = "isolated-calendar-consent-test-only";
const payload = {
  state: "random-state",
  verifier: "server-only-pkce",
  userId: "fixture-user",
  tenantId: "fixture-tenant",
  calendar: true,
  issuedAt: Date.now(),
};
test("consent state is authenticated, encrypted, and preserves the calendar capability", () => {
  const sealed = sealGraphConsent(payload);
  assert.equal(sealed.includes(payload.userId), false);
  assert.deepEqual(openGraphConsent(sealed, payload.state, payload.issuedAt), payload);
});
test("plain JSON and tampered cookies cannot link another user's mailbox", () => {
  assert.equal(openGraphConsent(JSON.stringify(payload), payload.state), null);
  const sealed = sealGraphConsent(payload);
  assert.equal(openGraphConsent(`${sealed.slice(0, -6)}AAAAAA`, payload.state), null);
});
test("state mismatch, missing state, expired and future-dated consent are rejected", () => {
  const sealed = sealGraphConsent(payload);
  assert.equal(openGraphConsent(sealed, "other", payload.issuedAt), null);
  assert.equal(openGraphConsent(sealed, undefined, payload.issuedAt), null);
  assert.equal(openGraphConsent(sealed, payload.state, payload.issuedAt + 600001), null);
  assert.equal(openGraphConsent(sealed, payload.state, payload.issuedAt - 1), null);
});
test("email-only consent remains a distinct capability", () => {
  assert.equal(
    openGraphConsent(
      sealGraphConsent({ ...payload, calendar: false }),
      payload.state,
      payload.issuedAt,
    )?.calendar,
    false,
  );
});
