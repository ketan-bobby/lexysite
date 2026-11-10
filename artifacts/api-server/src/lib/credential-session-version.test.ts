import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { issueToken, verifyToken, hasCurrentCredentialVersion } from "./auth-token";

process.env.SESSION_SECRET = "synthetic-credential-version-secret-0123456789";
test("credential epochs are signed independently of the nonce and clock", () => {
  const actor = { userId: "isolated-version", role: "candidate", tenantId: "isolated" };
  const old = issueToken({ ...actor, credentialVersion: randomUUID() });
  const fresh = issueToken({ ...actor, credentialVersion: randomUUID() });
  const a = verifyToken(old),
    b = verifyToken(fresh);
  assert(a.ok && b.ok);
  assert.notEqual(a.payload.cv, b.payload.cv);
  assert.notEqual(a.payload.sid, b.payload.sid);
  const parts = old.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...a.payload, cv: b.payload.cv })).toString("base64url");
  assert.deepEqual(verifyToken(parts.join(".")), { ok: false, reason: "bad_sig" });
});
test("unrotated accounts have an explicit initial epoch", () => {
  const token = verifyToken(issueToken({ userId: "isolated", role: "recruiter", tenantId: null }));
  assert(token.ok);
  assert.equal(token.payload.cv, "0");
});
test("pre-rollout signed sessions stay valid only until the first password change", () => {
  assert(hasCurrentCredentialVersion({}, "0"));
  assert(!hasCurrentCredentialVersion({}, randomUUID()));
});
test("only the current epoch works, even after a password hash is restored", () => {
  const older = randomUUID(),
    current = randomUUID();
  assert(hasCurrentCredentialVersion({ cv: current }, current));
  assert(!hasCurrentCredentialVersion({ cv: older }, current));
  assert(!hasCurrentCredentialVersion({ cv: "0" }, current));
});
