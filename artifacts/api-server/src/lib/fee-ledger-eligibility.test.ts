/**
 * fee-ledger-eligibility.test.ts — edge cases for per-hire fee eligibility
 * and origin-field stamping.
 *
 * Run: pnpm --filter @workspace/api-server run test:fee-eligibility
 *
 * Locked business rules under test:
 *   • fee-eligible ⟺ entry_type='sourced' AND origin_evidence present
 *     AND evidence.channel ∈ {ai_sourcing, linx}
 *   • pre-launch rows (NULL evidence) are NEVER eligible
 *   • inbound / customer channels never produce a fee-eligible combination
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFeeEligible } from "./fee-ledger";
import { originFields } from "./sourcing-origin";

test("ai_sourcing evidence on a sourced row is eligible", () => {
  assert.equal(isFeeEligible("sourced", { channel: "ai_sourcing" }), true);
});

test("linx evidence on a sourced row is eligible (distinguishable channel)", () => {
  assert.equal(isFeeEligible("sourced", { channel: "linx" }), true);
});

test("pre-launch sourced row (NULL evidence) is NEVER eligible", () => {
  assert.equal(isFeeEligible("sourced", null), false);
  assert.equal(isFeeEligible("sourced", undefined), false);
});

test("sourced row with non-fee channel is not eligible", () => {
  assert.equal(isFeeEligible("sourced", { channel: "customer" }), false);
  assert.equal(isFeeEligible("sourced", { channel: "inbound" }), false);
  assert.equal(isFeeEligible("sourced", { channel: "" }), false);
  assert.equal(isFeeEligible("sourced", {}), false);
});

test("applied / manual entries are never eligible even with a fee channel", () => {
  assert.equal(isFeeEligible("applied", { channel: "ai_sourcing" }), false);
  assert.equal(isFeeEligible("manual", { channel: "linx" }), false);
  assert.equal(isFeeEligible(null, { channel: "ai_sourcing" }), false);
  assert.equal(isFeeEligible(undefined, { channel: "linx" }), false);
});

test("malformed evidence shapes are not eligible", () => {
  assert.equal(isFeeEligible("sourced", "ai_sourcing"), false);
  assert.equal(isFeeEligible("sourced", 42), false);
  assert.equal(isFeeEligible("sourced", { channel: { nested: "ai_sourcing" } }), false);
});

test("originFields maps channels to the locked entry_type values", () => {
  assert.equal(originFields("ai_sourcing", {}, "u1").entryType, "sourced");
  assert.equal(originFields("linx", {}, "u1").entryType, "sourced");
  assert.equal(originFields("inbound", {}, "u1").entryType, "applied");
  assert.equal(originFields("customer", {}, "u1").entryType, "manual");
});

test("originFields evidence always carries the channel + recordedAt", () => {
  const f = originFields("linx", { submissionId: "s1" }, "u9");
  assert.equal((f.originEvidence as any).channel, "linx");
  assert.equal((f.originEvidence as any).submissionId, "s1");
  assert.ok(typeof (f.originEvidence as any).recordedAt === "string");
  assert.equal(f.originSetBy, "u9");
  assert.ok(f.originSetAt instanceof Date);
});

test("originFields output is fee-eligible exactly for the two fee channels", () => {
  for (const [channel, expected] of [
    ["ai_sourcing", true],
    ["linx", true],
    ["inbound", false],
    ["customer", false],
  ] as const) {
    const f = originFields(channel, {}, "u1");
    assert.equal(isFeeEligible(f.entryType, f.originEvidence), expected, channel);
  }
});
