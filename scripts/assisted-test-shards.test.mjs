import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shardAssistedTestBatch } from "./assisted-test-shards.mjs";

test("shards select every parent and descendant exactly once, escaping regex characters", () => {
  const names = ["review (yes)?", "identity [clear]", "final.decision+"];
  const source = names.map((name) => `test(${JSON.stringify(name)}, async () => {});`).join("\n");
  const batch = { name: "journey", files: ["journey.test.ts"] };
  const shards = shardAssistedTestBatch(batch, source, 2);
  assert.deepEqual(
    shards.flatMap((shard) => shard.testNames),
    names,
  );
  assert.deepEqual(batch.files, ["journey.test.ts"]);
  for (const name of names) {
    for (const title of [name, `${name} nested child`]) {
      assert.equal(
        shards.filter((shard) => new RegExp(shard.testNamePattern).test(title)).length,
        1,
      );
    }
  }
  assert.ok(shards.every((shard) => !new RegExp(shard.testNamePattern).test("unregistered")));
  assert.deepEqual(
    shards.map((shard) => shard.name),
    ["journey-1", "journey-2"],
  );
});

test("unsafe manifests and unsupported registration fail rather than lose coverage", () => {
  const batch = { name: "journey", files: ["journey.test.ts"] };
  for (const source of [
    "",
    'test("same", () => {}); test("same", () => {});',
    'test("parent", () => {}); test("parent child", () => {});',
    "test(dynamicName, () => {});",
    'test.only("exclusive", () => {});',
    'test.skip("skipped", () => {});',
    'test("broken", () => {',
  ])
    assert.throws(() => shardAssistedTestBatch(batch, source));
  assert.throws(() => shardAssistedTestBatch({ ...batch, files: ["a", "b"] }, 'test("x",()=>{});'));
  assert.throws(() => shardAssistedTestBatch(batch, 'test("x",()=>{});', 0));
});

test("the actual workflow journey manifest is fully partitioned without overlap", () => {
  const path = "artifacts/api-server/src/routes/recruiting-workflow-journey.integration.test.ts";
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const shards = shardAssistedTestBatch({ name: "journey", files: [path] }, source);
  assert.ok(shards.length > 1);
  for (const name of shards.flatMap((shard) => shard.testNames)) {
    assert.equal(shards.filter((shard) => new RegExp(shard.testNamePattern).test(name)).length, 1);
  }
});
