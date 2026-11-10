import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZohoHandoffAuditFixture } from "./zoho-handoff-schema-sql-fixture.mjs";
import { handoffCheckNames } from "./check-zoho-handoff-schema.mjs";

test("handoff fixture rejects unverified identities and confines all mutations to disposable schemas", () => {
  for (const input of [undefined, "", "production", "a".repeat(31), "';COMMIT;--"])
    assert.throws(() => buildZohoHandoffAuditFixture(input));
  const { sql, namespace } = buildZohoHandoffAuditFixture("a".repeat(32));
  assert.ok(sql.indexOf("Development target mismatch") < sql.indexOf("CREATE SCHEMA"));
  assert.match(sql, /privileged development owner and restricted request role/);
  assert.match(sql, /ROLLBACK;\nSELECT NOT EXISTS/);
  assert.doesNotMatch(sql, /\bCOMMIT\b|\b(?:CREATE|ALTER|DROP)\s+ROLE\b/i);
  assert.doesNotMatch(sql, /(?:ON|ALTER TABLE|DROP TABLE)\s+public\./i);
  assert.doesNotMatch(sql, /\bINSERT INTO\b|\bDELETE FROM\b|\bUPDATE\s+public\./i);
  assert.match(sql, /SET LOCAL ROLE lexy_app/);
  assert.match(sql, /EXCEPTION WHEN insufficient_privilege THEN NULL/);
  assert.doesNotMatch(sql, /EXCEPTION WHEN OTHERS/);
  assert.ok(sql.includes(`SET LOCAL search_path="${namespace}",pg_catalog`));
});
test("all negative probes have exact failure contracts and independent rollback", () => {
  const { sql, cases, caseCount } = buildZohoHandoffAuditFixture("a".repeat(32));
  assert.equal(caseCount, 23);
  assert.equal(new Set(cases.map((c) => c.name)).size, caseCount);
  for (const item of cases) {
    assert.ok(item.expected.length);
    assert.ok(item.expected.every((name) => handoffCheckNames.includes(name)));
  }
  for (const name of [
    "missing mappings",
    "missing receipts",
    "wrong erasure function schema",
    "wrong immutability function schema",
    "missing request_id_unique",
  ])
    assert.ok(cases.some((c) => c.name === name));
  assert.match(sql, /EXCEPTION WHEN SQLSTATE 'ZH001' THEN NULL/);
  assert.match(sql, /failures IS DISTINCT FROM expected/);
  assert.match(sql, /total<>12/);
  assert.ok(Buffer.byteLength(sql) < 40000);
  assert.notEqual(
    buildZohoHandoffAuditFixture("a".repeat(32)).namespace,
    buildZohoHandoffAuditFixture("a".repeat(32)).namespace,
  );
});
