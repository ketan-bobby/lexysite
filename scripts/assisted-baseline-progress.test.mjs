import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeAssistedBaselineProgress } from "./assisted-baseline-progress.mjs";

let directory;
let file;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "lexy-progress-test-"));
  file = path.join(directory, "summary.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const read = () => JSON.parse(readFileSync(file, "utf8"));

test("a new run has an incomplete report before any check starts", () => {
  writeAssistedBaselineProgress(file, []);
  assert.equal(read().complete, false);
  assert.equal(read().status, "incomplete");
  assert.equal(read().completedChecks, 0);
});
test("completed passes do not turn an unfinished gate green", () => {
  const results = [{ name: "typecheck", passed: true, durationMs: 12 }];
  writeAssistedBaselineProgress(file, results, {
    activeStep: "api-tests",
    startedAt: "2026-10-12T00:00:00.000Z",
  });
  const report = read();
  assert.equal(report.complete, false);
  assert.equal(report.status, "incomplete");
  assert.equal(report.activeStep, "api-tests");
  assert.equal(report.passedChecks, 1);
  assert.deepEqual(report.results, results);
  assert.equal(report.startedAt, "2026-10-12T00:00:00.000Z");
});
test("failures and their metadata survive subsequent checkpoints", () => {
  const results = [{ name: "first", passed: false, exitCode: 1, signal: null }];
  writeAssistedBaselineProgress(file, results);
  results.push({ name: "second", passed: true });
  writeAssistedBaselineProgress(file, results, { activeStep: "third" });
  assert.equal(read().failedChecks, 1);
  assert.equal(read().passedChecks, 1);
  assert.equal(read().completedChecks, 2);
  assert.equal(read().results[0].exitCode, 1);
  assert.equal(read().status, "incomplete");
});
test("only a finished, nonempty all-pass gate is marked passed", () => {
  writeAssistedBaselineProgress(file, [{ name: "check", passed: true }], {
    complete: true,
    activeStep: "check",
  });
  assert.equal(read().status, "passed");
  assert.equal(read().complete, true);
  assert.equal(read().activeStep, null);
});
test("a finished gate with failures remains failed", () => {
  writeAssistedBaselineProgress(file, [{ name: "check", passed: false }], { complete: true });
  assert.equal(read().status, "failed");
  assert.equal(read().failedChecks, 1);
});
test("empty or malformed success evidence cannot produce a green report", () => {
  for (const results of [[], [{ name: "check" }], [{ name: "check", passed: "true" }]]) {
    writeAssistedBaselineProgress(file, results, { complete: true });
    assert.equal(read().status, "failed");
  }
});
test("a replacement failure preserves the previous readable report", () => {
  writeAssistedBaselineProgress(file, [{ name: "first", passed: true }]);
  const previous = readFileSync(file, "utf8");
  mkdirSync(`${file}.tmp`);
  assert.throws(() => writeAssistedBaselineProgress(file, [{ name: "second", passed: false }]));
  assert.equal(readFileSync(file, "utf8"), previous);
});
test("successful replacement updates evidence and leaves no temporary file", () => {
  writeAssistedBaselineProgress(file, []);
  writeAssistedBaselineProgress(file, [{ name: "done", passed: true }], { complete: true });
  assert.equal(read().results[0].name, "done");
  assert.equal(existsSync(`${file}.tmp`), false);
});
