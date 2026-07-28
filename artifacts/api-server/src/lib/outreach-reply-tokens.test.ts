/**
 * outreach-reply-tokens.test.ts — unit tests for HMAC one-click reply tokens.
 *
 * The module captures INBOUND_EMAIL_SECRET at import time, so a dummy test
 * secret is set BEFORE the dynamic import below. No DB / network involved.
 * Run: npx tsx --test src/lib/outreach-reply-tokens.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.INBOUND_EMAIL_SECRET = "test-secret-for-unit-tests-only";

const mod = await import("./outreach-reply-tokens");
const {
  signReplyToken,
  verifyReplyToken,
  signMessageReplyToken,
  verifyMessageReplyToken,
  buildQuickReplyBlocks,
  buildMessageQuickReplyBlocks,
} = mod;

test("enrollment token round-trips (sign → verify)", () => {
  const token = signReplyToken("enr-123", "interested");
  const result = verifyReplyToken(token);
  assert.deepEqual(result, { ok: true, enrollmentId: "enr-123", action: "interested" });
});

test("all three actions round-trip", () => {
  for (const action of ["interested", "not_interested_job", "dnc"] as const) {
    const r = verifyReplyToken(signReplyToken("e1", action));
    assert.ok(r.ok && r.action === action);
  }
});

test("tampered payload is rejected (bad_signature)", () => {
  const token = signReplyToken("enr-123", "interested");
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  // Swap the action from `interested` to `dnc` while keeping the old sig.
  const tampered = decoded.replace(".interested.", ".dnc.");
  const forged = Buffer.from(tampered, "utf8").toString("base64url");
  const r = verifyReplyToken(forged);
  assert.deepEqual(r, { ok: false, error: "bad_signature" });
});

test("token signed with a different secret is rejected", () => {
  const exp = Date.now() + 1000 * 60;
  const payload = `enr-123.interested.${exp}`;
  const wrongSig = crypto.createHmac("sha256", "attacker-secret").update(payload).digest("hex");
  const forged = Buffer.from(`${payload}.${wrongSig}`, "utf8").toString("base64url");
  const r = verifyReplyToken(forged);
  assert.deepEqual(r, { ok: false, error: "bad_signature" });
});

test("expired enrollment token is rejected", () => {
  const exp = Date.now() - 1000; // already past
  const payload = `enr-123.interested.${exp}`;
  const sig = crypto
    .createHmac("sha256", process.env.INBOUND_EMAIL_SECRET!)
    .update(payload)
    .digest("hex");
  const token = Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
  const r = verifyReplyToken(token);
  assert.deepEqual(r, { ok: false, error: "expired" });
});

test("garbage tokens are rejected as malformed, not thrown", () => {
  for (const junk of ["", "not-a-token", Buffer.from("a.b").toString("base64url")]) {
    const r = verifyReplyToken(junk);
    assert.equal(r.ok, false);
  }
});

test("unknown action with a valid signature is rejected (bad_action)", () => {
  const exp = Date.now() + 1000 * 60;
  const payload = `enr-123.approve_all.${exp}`;
  const sig = crypto
    .createHmac("sha256", process.env.INBOUND_EMAIL_SECRET!)
    .update(payload)
    .digest("hex");
  const token = Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
  const r = verifyReplyToken(token);
  assert.deepEqual(r, { ok: false, error: "bad_action" });
});

test("message token round-trips and carries the m. namespace", () => {
  const token = signMessageReplyToken("msg-9", "dnc");
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  assert.ok(decoded.startsWith("m."), "message tokens must be namespaced");
  const r = verifyMessageReplyToken(token);
  assert.deepEqual(r, { ok: true, messageId: "msg-9", action: "dnc" });
});

test("namespaces cannot be confused: enrollment token fails message verifier and vice versa", () => {
  const enrToken = signReplyToken("enr-1", "interested");
  const msgToken = signMessageReplyToken("msg-1", "interested");
  assert.equal(verifyMessageReplyToken(enrToken).ok, false);
  assert.equal(verifyReplyToken(msgToken).ok, false);
});

test("buildQuickReplyBlocks embeds three verifiable action links", () => {
  const { html, text } = buildQuickReplyBlocks("enr-55", "https://app.example.com/");
  assert.ok(html.length > 0 && text.length > 0);
  // No double slash from the trailing base-url slash.
  assert.ok(html.includes("https://app.example.com/api/outreach/reply/"));
  assert.ok(!html.includes(".com//api/"));
  // Extract each token from the plain-text block and verify it.
  const urls = text.match(/https:\/\/\S+/g) ?? [];
  assert.equal(urls.length, 3);
  const actions = urls.map((u) => {
    const token = u.split("/reply/")[1];
    const r = verifyReplyToken(token);
    assert.ok(r.ok, "each embedded token must verify");
    return r.ok ? r.action : "";
  });
  assert.deepEqual(actions.sort(), ["dnc", "interested", "not_interested_job"]);
});

test("buildMessageQuickReplyBlocks embeds verifiable message tokens", () => {
  const { text } = buildMessageQuickReplyBlocks("msg-77", "https://app.example.com");
  const urls = text.match(/https:\/\/\S+/g) ?? [];
  assert.equal(urls.length, 3);
  for (const u of urls) {
    const token = u.split("/reply-msg/")[1];
    const r = verifyMessageReplyToken(token);
    assert.ok(r.ok && r.messageId === "msg-77");
  }
});
