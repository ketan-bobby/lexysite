import assert from "node:assert/strict";
import { test } from "node:test";
import { offerDraftSync } from "./offer-draft-sync";

for (const [name, base, current, dirty, expected] of [
  ["initial hydration", null, "offer:1", false, "sync"],
  ["initial empty offer", null, "none", false, "sync"],
  ["clean remote update", "offer:1", "offer:2", false, "sync"],
  ["same-version refresh while editing", "offer:1", "offer:1", true, "keep"],
  ["remote version preserves unsaved edits", "offer:1", "offer:2", true, "conflict"],
  ["remote first draft preserves a local first draft", "none", "offer:1", true, "conflict"],
  ["remote removal preserves local edits", "offer:1", "none", true, "conflict"],
  ["replacement offer preserves local edits", "offer:1", "replacement:1", true, "conflict"],
  ["explicitly keeping edits resolves the conflict", "offer:2", "offer:2", true, "keep"],
  ["explicitly discarding edits permits the latest version", "offer:1", "offer:2", false, "sync"],
] as const) {
  test(`offer draft sync: ${name}`, () => {
    assert.equal(offerDraftSync(base, current, dirty), expected);
  });
}
