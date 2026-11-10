import assert from "node:assert/strict";
import { test } from "node:test";
import { readOverrideHistory } from "./intelligence-override-history";

test("absent history starts empty", () => {
  assert.deepEqual(readOverrideHistory(null), []);
  assert.deepEqual(readOverrideHistory(undefined), []);
});

test("native arrays preserve evidence without mutating the loaded row", () => {
  const original = [{ id: "existing", type: "override", reason: "Human review" }];
  const result = readOverrideHistory(original);
  assert.equal(JSON.stringify(result), JSON.stringify(original));
  assert.notEqual(result, original);
  result.push({ type: "feedback", rating: "positive" });
  assert.equal(original.length, 1);
});

test("legacy JSON strings preserve their entries", () => {
  const original = [{ id: "legacy", type: "feedback", rating: "negative" }];
  assert.deepEqual(readOverrideHistory(JSON.stringify(original)), original);
});

test("malformed or non-array history fails explicitly", () => {
  for (const value of [{}, 42, true, "{}", "null", '"text"', "{broken"]) {
    assert.throws(() => readOverrideHistory(value));
  }
});
