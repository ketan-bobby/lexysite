/**
 * auth-token.test.ts — unit tests for HMAC bearer session tokens.
 *
 * A dummy SESSION_SECRET is set before import; no DB or network involved.
 * Run: npx tsx --test src/lib/auth-token.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SESSION_SECRET = "unit-test-session-secret-0123456789abcdef";
delete process.env.DEV_AUTH_FALLBACK;

const { issueToken, verifyToken, getAuthUserId } = await import("./auth-token");

const baseUser = { userId: "user-1", role: "recruiter", tenantId: "ten-1" };

test("issue → verify round-trips the payload", () => {
  const token = issueToken({ ...baseUser, region: "us" });
  const r = verifyToken(token);
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.payload.sub, "user-1");
    assert.equal(r.payload.role, "recruiter");
    assert.equal(r.payload.tenantId, "ten-1");
    assert.equal(r.payload.region, "us");
    assert.ok(r.payload.exp > Math.floor(Date.now() / 1000));
  }
});

test("verify accepts a 'Bearer ' prefix", () => {
  const token = issueToken(baseUser);
  const r = verifyToken(`Bearer ${token}`);
  assert.ok(r.ok);
});

test("missing / empty tokens fail with reason=missing", () => {
  for (const v of [null, undefined, "", "Bearer  "]) {
    const r = verifyToken(v as string | null | undefined);
    assert.deepEqual(r, { ok: false, reason: "missing" });
  }
});

test("tampered payload fails signature check", () => {
  const token = issueToken(baseUser);
  const [v2, payloadB64, sig] = token.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  payload.role = "platform_admin"; // privilege-escalation attempt
  const forgedPayload = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const r = verifyToken(`${v2}.${forgedPayload}.${sig}`);
  assert.deepEqual(r, { ok: false, reason: "bad_sig" });
});

test("token signed with a different secret is rejected", () => {
  const payload = {
    sub: "user-1",
    role: "platform_admin",
    tenantId: null,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const mac = crypto
    .createHmac("sha256", "attacker-controlled-secret-64-chars-long!!")
    .update("v2." + payloadB64)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const r = verifyToken(`v2.${payloadB64}.${mac}`);
  assert.deepEqual(r, { ok: false, reason: "bad_sig" });
});

test("expired token is rejected AFTER the signature verifies", () => {
  // Build a legitimately-signed but expired token by re-signing with the
  // real secret (same algorithm the module uses).
  const payload = {
    sub: "user-1",
    role: "recruiter",
    tenantId: "ten-1",
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 3600,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const mac = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update("v2." + payloadB64)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const r = verifyToken(`v2.${payloadB64}.${mac}`);
  assert.deepEqual(r, { ok: false, reason: "expired" });
});

test("junk and truncated tokens are malformed, never thrown", () => {
  for (const junk of ["v2.abc", "v2.a.b.c.d", "random-string", "v2..", "demo_token_"]) {
    const r = verifyToken(junk);
    assert.equal(r.ok, false, `should reject: ${junk}`);
  }
});

test("legacy demo tokens are rejected when DEV_AUTH_FALLBACK is off", () => {
  const r = verifyToken("demo_token_user-1");
  assert.deepEqual(r, { ok: false, reason: "legacy_disabled" });
});

test("getAuthUserId returns sub for a valid Authorization header", () => {
  const token = issueToken(baseUser);
  const userId = getAuthUserId({ headers: { authorization: `Bearer ${token}` } });
  assert.equal(userId, "user-1");
});

test("getAuthUserId returns null for missing/invalid headers", () => {
  assert.equal(getAuthUserId({ headers: {} }), null);
  assert.equal(getAuthUserId({ headers: { authorization: "Bearer nope" } }), null);
});

test("getAuthUserId handles an array-valued header (takes the first)", () => {
  const token = issueToken(baseUser);
  const userId = getAuthUserId({
    headers: { authorization: [`Bearer ${token}`, "Bearer junk"] },
  });
  assert.equal(userId, "user-1");
});
