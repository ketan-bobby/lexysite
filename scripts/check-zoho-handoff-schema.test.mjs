import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  handoffCheckNames,
  handoffSchemaInspection,
  checkZohoHandoffSchema,
  runZohoHandoffAudit,
} from "./check-zoho-handoff-schema.mjs";

const complete = () => handoffCheckNames.map((name) => ({ name, passed: true }));
function fixture({ rows = complete(), mode = "on", failQuery = false } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      calls.push("connect");
    },
    async end() {
      calls.push("end");
    },
    async query(text, params) {
      calls.push({ text, params });
      if (text.startsWith("SHOW")) return { rows: [{ transaction_read_only: mode }] };
      if (params) {
        if (failQuery) throw Error("PRIVATE_DRIVER_DETAILS");
        return { rows };
      }
      return { rows: [] };
    },
  };
}
test("handoff audit binds public, enforces read-only mode and returns minimized exact evidence", async () => {
  const client = fixture({ rows: complete().map((row) => ({ ...row, private: "omit" })) });
  const report = await checkZohoHandoffSchema(client);
  assert.equal(report.passed, true);
  assert.equal(report.targetEnvironment, "not-independently-attested");
  assert.deepEqual(report.checks, complete());
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
  assert.deepEqual(client.calls.find((c) => c.params)?.params, ["public"]);
  assert.doesNotMatch(handoffSchemaInspection(), /\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
  assert.match(handoffSchemaInspection(), /p\.pronamespace=n\.oid/);
});
test("failed checks block release; missing, duplicate, unexpected and untyped rows fail closed", async () => {
  const bad = complete();
  bad[0].passed = false;
  assert.equal((await checkZohoHandoffSchema(fixture({ rows: bad }))).passed, false);
  for (const rows of [
    [],
    complete().slice(1),
    [...complete(), complete()[0]],
    complete().map((r, i) => (i ? r : { ...r, name: "unexpected" })),
    complete().map((r, i) => (i ? r : { ...r, passed: "true" })),
    complete().map((r, i) => (i ? r : { ...r, passed: null })),
  ]) {
    const client = fixture({ rows });
    await assert.rejects(checkZohoHandoffSchema(client), /invalid handoff metadata/);
    assert.equal(client.calls.at(-1).text, "ROLLBACK");
  }
});
test("read-only and driver failures roll back without continuing the audit", async () => {
  const client = fixture({ mode: "off" });
  await assert.rejects(checkZohoHandoffSchema(client), /Read-only transaction/);
  assert.ok(!client.calls.some((c) => c.params));
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
  const failure = fixture({ failQuery: true });
  await assert.rejects(checkZohoHandoffSchema(failure));
  assert.equal(failure.calls.at(-1).text, "ROLLBACK");
});
test("CLI exit codes, safe errors and cleanup distinguish rejection from missing configuration", async () => {
  const output = [],
    errors = [];
  let client = fixture();
  const run = (args = []) =>
    runZohoHandoffAudit({
      args,
      env: { DATABASE_URL: "not-a-real-credential" },
      createClient: () => client,
      output: (m) => output.push(m),
      error: (m) => errors.push(m),
    });
  assert.equal(await run(), 0);
  assert.equal(client.calls.at(-1), "end");
  const rows = complete();
  rows[0].passed = false;
  client = fixture({ rows });
  assert.equal(await run(), 1);
  client = fixture({ failQuery: true });
  assert.equal(await run(), 2);
  assert.equal(client.calls.at(-1), "end");
  assert.doesNotMatch(errors.join(" "), /PRIVATE_DRIVER|not-a-real-credential/);
  client = fixture();
  assert.equal(await run(["--schema=other"]), 2);
  assert.deepEqual(client.calls, []);
  assert.equal(await runZohoHandoffAudit({ args: [], env: {}, error: (m) => errors.push(m) }), 2);
  assert.ok(output.length);
  client = fixture();
  client.connect = async () => {
    throw Error("PRIVATE_CONNECT_DETAILS");
  };
  assert.equal(await run(), 2);
  assert.equal(client.calls.at(-1), "end");
  client = fixture();
  client.end = async () => {
    throw Error("PRIVATE_CLEANUP_DETAILS");
  };
  assert.equal(await run(), 2);
  assert.doesNotMatch(errors.join(" "), /PRIVATE_CONNECT|PRIVATE_CLEANUP/);
});
test("required release step is wired before API tests and the real CLI rejects missing configuration", () => {
  const source = readFileSync(new URL("./check-assisted-baseline.mjs", import.meta.url), "utf8");
  assert.equal(source.split('required("zoho-handoff-database-schema"').length, 2);
  assert.ok(
    source.indexOf('required("zoho-handoff-database-schema"') < source.indexOf("const apiBatches"),
  );
  assert.match(
    source,
    /required\("zoho-handoff-database-schema", process\.execPath, \[\s*"--import",\s*guard,\s*"scripts\/check-zoho-handoff-schema\.mjs",/,
  );
  assert.ok(source.includes('"scripts/check-zoho-handoff-schema.test.mjs"'));
  assert.ok(source.includes('"scripts/zoho-handoff-schema-sql-fixture.test.mjs"'));
  const missing = spawnSync(process.execPath, ["scripts/check-zoho-handoff-schema.mjs"], {
    env: {},
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /DATABASE_URL is not configured/);
});
