import assert from "node:assert/strict";
import { test } from "node:test";
import { readJsonObject, readJsonRows } from "./json-response";

test("object replies retain extra fields and nested private evidence", async () => {
  const body = { id: "fixture", extra: { privateNote: "PRIVATE_EVIDENCE" } };
  const parsed = await readJsonObject({ json: async () => body });
  assert.deepEqual(parsed, body);
  assert.match(JSON.stringify(parsed), /PRIVATE_EVIDENCE/);
});

test("object replies reject missing, primitive and array payloads", async () => {
  for (const body of [null, undefined, "text", 1, []]) {
    await assert.rejects(readJsonObject({ json: async () => body }));
  }
});

test("row replies retain every field without filtering rows", async () => {
  const rows = [{ id: "first", privateNote: "PRIVATE_EVIDENCE" }, { id: "second" }];
  assert.deepEqual(await readJsonRows({ json: async () => rows }), rows);
});

test("row replies reject object envelopes and malformed entries", async () => {
  for (const body of [{ rows: [] }, [null], [1]]) {
    await assert.rejects(readJsonRows({ json: async () => body }));
  }
});
