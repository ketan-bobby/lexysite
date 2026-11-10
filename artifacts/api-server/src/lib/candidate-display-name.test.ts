import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateDisplayName } from "./candidate-display-name";

test("canonical candidate names use the stored name parts", () => {
  assert.equal(candidateDisplayName({ firstName: "First", lastName: "Last" }), "First Last");
  assert.equal(candidateDisplayName({ firstName: " First ", lastName: " Last " }), "First Last");
});

test("partial names stay useful without inventing missing parts", () => {
  assert.equal(candidateDisplayName({ firstName: "First", lastName: "" }), "First");
  assert.equal(candidateDisplayName({ firstName: null, lastName: "Last" }), "Last");
});

test("absent names retain the existing anonymous fallback", () => {
  assert.equal(candidateDisplayName(undefined), null);
  assert.equal(candidateDisplayName(null), null);
  assert.equal(candidateDisplayName({ firstName: " ", lastName: null }), null);
});
