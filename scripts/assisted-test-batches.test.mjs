import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { planAssistedTestBatches } from "./assisted-test-batches.mjs";

test("the release gate requires every Zoho regression suite exactly once", () => {
  const source = readFileSync(new URL("./check-assisted-baseline.mjs", import.meta.url), "utf8");
  const block = source.match(/const apiTests\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(block, "the API suite registration must remain explicit");
  const registered = [...block[1].matchAll(/"([^"]+\.test\.ts)"/g)].map((match) => match[1]);
  const suites = readdirSync(
    new URL("../artifacts/api-server/src/lib/ats-connectors/", import.meta.url),
  ).filter((name) => name.startsWith("zoho-") && name.endsWith(".test.ts"));
  assert.ok(suites.length >= 6, "connection, reads, imports, campaigns and reviews need coverage");
  for (const name of suites) {
    const file = `src/lib/ats-connectors/${name}`;
    assert.equal(registered.filter((entry) => entry === file).length, 1, file);
  }
  const batches = planAssistedTestBatches(registered, [], { maxFilesPerBatch: 4 });
  const executed = batches.flatMap((batch) => batch.files);
  for (const name of suites) {
    assert.equal(executed.filter((file) => file.endsWith(`/${name}`)).length, 1, name);
  }
});

test("both read-only schema audits are required, guarded checks before database fixture journeys", () => {
  const source = readFileSync(new URL("./check-assisted-baseline.mjs", import.meta.url), "utf8");
  for (const [name, mode] of [
    ["recent-database-schema", []],
    ["ats-database-schema", ['"--ats"']],
  ]) {
    const pattern = new RegExp(
      `required\\(\\s*"${name}"\\s*,\\s*process\\.execPath\\s*,\\s*\\[([\\s\\S]*?)\\]\\s*\\)`,
      "g",
    );
    const matches = [...source.matchAll(pattern)];
    assert.equal(matches.length, 1, `${name} must be a required check exactly once`);
    assert.deepEqual(
      matches[0][1]
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      ['"--import"', "guard", '"scripts/check-recent-db-schema.mjs"', ...mode],
    );
    assert.ok(matches[0].index < source.indexOf("const apiBatches"));
  }
});

test("plan, work-order and recording regressions are required exactly once", () => {
  const source = readFileSync(new URL("./check-assisted-baseline.mjs", import.meta.url), "utf8");
  for (const [list, suite] of [
    ["apiTests", "src/lib/interview-plan-questions.test.ts"],
    ["apiTests", "src/lib/meeting-speakers.test.ts"],
    ["apiTests", "src/lib/meeting-notes-core.test.ts"],
    ["apiTests", "src/lib/meeting-notes-long-recording.test.ts"],
    ["apiTests", "src/lib/meeting-notes-transcription.test.ts"],
    ["apiTests", "src/lib/meeting-upload.test.ts"],
    ["apiTests", "src/lib/object-file-upload.test.ts"],
    ["apiTests", "src/lib/object-file-upload-sdk.test.ts"],
    ["apiTests", "scripts/meeting-notes-read-benchmark.test.ts"],
    ["apiTests", "src/lib/zoom-recordings-provider.test.ts"],
    ["apiTests", "src/lib/google-meet-recordings-provider.test.ts"],
    ["apiTests", "src/lib/google-meet-recording-oauth.test.ts"],
    ["apiTests", "src/lib/google-meet-recording-account.test.ts"],
    ["webTests", "src/components/scheduling/google-meet-recording-state.test.ts"],
    ["apiTests", "src/routes/google-meet-recording-account.test.ts"],
    ["apiTests", "src/lib/native-recording-review.test.ts"],
    ["apiTests", "src/lib/native-meet-recording-core.test.ts"],
    ["apiTests", "src/lib/native-meet-recording-context.test.ts"],
    ["webTests", "src/lib/work-order-approval.test.ts"],
    ["webTests", "src/lib/meeting-live-capture.test.ts"],
  ]) {
    const block = source.match(new RegExp(`const ${list}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    assert.ok(block, `${list} must remain explicit`);
    const files = [...block[1].matchAll(/"([^"]+\.test\.ts)"/g)].map((match) => match[1]);
    assert.equal(files.filter((file) => file === suite).length, 1, suite);
  }
});

test("meeting evidence and usage-label schema readiness is required before fixture journeys", () => {
  const source = readFileSync(new URL("./check-assisted-baseline.mjs", import.meta.url), "utf8");
  const calls = [
    ...source.matchAll(
      /required\("meeting-usage-database-schema", process\.execPath, \[([\s\S]*?)\]\);/g,
    ),
  ];
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /"--import",\s*guard,\s*"scripts\/check-meeting-usage-schema\.mjs"/);
  assert.ok(calls[0].index < source.indexOf("const apiBatches"));
  assert.match(source, /"scripts\/check-meeting-usage-schema\.test\.mjs"/);
});

test("real-browser meeting capture is a required release check, not replaced by state fakes", () => {
  const source = readFileSync(new URL("./check-assisted-baseline.mjs", import.meta.url), "utf8");
  const checks = [
    ...source.matchAll(/required\("meeting-notes-browser", "pnpm", \[([\s\S]*?)\]\);/g),
  ];
  assert.equal(checks.length, 1);
  assert.match(checks[0][1], /"scripts\/check-meeting-notes-browser\.mjs"/);
});

test("dedicated integration batches preserve every file exactly once without mutating input", () => {
  const files = ["unit.test.ts", "long.test.ts", "http.test.ts"];
  const batches = planAssistedTestBatches(files, [{ name: "journey", file: "long.test.ts" }]);
  assert.deepEqual(batches, [
    { name: "other", files: ["unit.test.ts", "http.test.ts"] },
    { name: "journey", files: ["long.test.ts"] },
  ]);
  assert.deepEqual(batches.flatMap((batch) => batch.files).sort(), [...files].sort());
  assert.deepEqual(files, ["unit.test.ts", "long.test.ts", "http.test.ts"]);
});

test("a single dedicated file does not produce an empty runner batch", () => {
  assert.deepEqual(
    planAssistedTestBatches(["long.test.ts"], [{ name: "journey", file: "long.test.ts" }]),
    [{ name: "journey", files: ["long.test.ts"] }],
  );
});

test("bounded serial batches preserve all files exactly once and keep dedicated files separate", () => {
  const files = ["a", "b", "c", "d", "e", "journey"];
  const batches = planAssistedTestBatches(files, [{ name: "journey", file: "journey" }], {
    maxFilesPerBatch: 2,
  });
  assert.deepEqual(batches, [
    { name: "other-1", files: ["a", "b"] },
    { name: "other-2", files: ["c", "d"] },
    { name: "other-3", files: ["e"] },
    { name: "journey", files: ["journey"] },
  ]);
  assert.deepEqual(
    batches.flatMap((batch) => batch.files),
    files,
  );
  assert.deepEqual(files, ["a", "b", "c", "d", "e", "journey"]);
});

test("invalid batch sizes and generated-name collisions fail rather than dropping coverage", () => {
  for (const maxFilesPerBatch of [0, -1, 1.5, NaN])
    assert.throws(() => planAssistedTestBatches(["a"], [], { maxFilesPerBatch }));
  assert.throws(() =>
    planAssistedTestBatches(["a", "b", "c"], [{ name: "other-1", file: "c" }], {
      maxFilesPerBatch: 1,
    }),
  );
});

test("empty, duplicate and missing file manifests fail instead of losing coverage", () => {
  assert.throws(() => planAssistedTestBatches([], []));
  assert.throws(() => planAssistedTestBatches(["a", "a"], []));
  assert.throws(() => planAssistedTestBatches(["a"], [{ name: "journey", file: "missing" }]));
  assert.throws(() =>
    planAssistedTestBatches(
      ["a"],
      [
        { name: "one", file: "a" },
        { name: "two", file: "a" },
      ],
    ),
  );
});

test("duplicate or reserved batch names cannot overwrite logs", () => {
  for (const dedicated of [
    [{ name: "other", file: "a" }],
    [{ name: "../unsafe", file: "a" }],
    [
      { name: "same", file: "a" },
      { name: "same", file: "b" },
    ],
  ])
    assert.throws(() => planAssistedTestBatches(["a", "b"], dedicated));
});
