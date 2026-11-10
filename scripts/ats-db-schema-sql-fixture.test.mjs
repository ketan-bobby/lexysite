import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { atsSchemaInspection, requiredSchemaCheckNames } from "./check-recent-db-schema.mjs";
import { buildAtsSchemaAuditFixture } from "./ats-db-schema-sql-fixture.mjs";

const fingerprint = "a".repeat(32);
test("ATS fixture rejects absent, malformed and injectable target identities", () => {
  for (const input of [undefined, "", "production", "a".repeat(31), `${fingerprint}';COMMIT;--`])
    assert.throws(() => buildAtsSchemaAuditFixture(input));
});
test("ATS fixture is private, target-guarded, rollback-only and contains no application data writes", () => {
  const { sql, namespace, shadow } = buildAtsSchemaAuditFixture(fingerprint);
  assert.ok(sql.startsWith("BEGIN;"));
  assert.ok(sql.indexOf("Development target mismatch") < sql.indexOf("CREATE SCHEMA"));
  assert.match(sql, /SET LOCAL statement_timeout = '60s'/);
  assert.match(sql, /SET LOCAL lock_timeout = '2s'/);
  assert.match(sql, /Fixture requires a privileged development owner and restricted request role/);
  assert.match(sql, new RegExp(`REVOKE ALL ON SCHEMA "${namespace}" FROM PUBLIC, lexy_app`));
  assert.match(sql, /ROLLBACK;\nSELECT NOT EXISTS/);
  assert.ok(sql.includes(`'${shadow}'`));
  assert.doesNotMatch(sql, /\bCOMMIT\b|\b(?:CREATE|ALTER|DROP)\s+ROLE\b/i);
  assert.doesNotMatch(sql, /\bINSERT INTO\b|\bDELETE FROM\b|\bUPDATE\s+(?:public\.|")/i);
  assert.doesNotMatch(sql, /(?:ON|ALTER TABLE|DROP TABLE)\s+public\./i);
  assert.doesNotMatch(sql, /CREATE(?: OR REPLACE)? FUNCTION\s+public\./i);
});
test("ATS fixture exercises the full bound query with harmless test-local function bodies", () => {
  const before = atsSchemaInspection();
  const { sql } = buildAtsSchemaAuditFixture(fingerprint);
  assert.ok(sql.includes(before.query));
  assert.match(sql, /AS \$stub\$SELECT false\$stub\$/);
  assert.match(sql, /AS \$stub\$BEGIN RETURN NEW; END;\$stub\$/);
  assert.deepEqual(atsSchemaInspection(), before);
  assert.match(sql, /LANGUAGE plpgsql AS \$positive\$/);
});
test("each negative case requires the exact expected failed checks and independent rollback", () => {
  const fixture = buildAtsSchemaAuditFixture(fingerprint);
  const names = new Set(requiredSchemaCheckNames(atsSchemaInspection().contract));
  assert.ok(fixture.caseCount >= 60);
  assert.equal(new Set(fixture.cases.map((c) => c.name)).size, fixture.caseCount);
  for (const item of fixture.cases) {
    assert.ok(item.expected.length);
    assert.ok(item.expected.every((name) => names.has(name)));
  }
  assert.match(fixture.sql, /FOR item IN SELECT value FROM jsonb_array_elements/);
  assert.match(fixture.sql, /EXECUTE replace\(item->>1,'__ATS_FIXTURE__'/);
  assert.match(fixture.sql, /RAISE EXCEPTION USING ERRCODE='ZT001'/);
  assert.match(fixture.sql, /EXCEPTION WHEN SQLSTATE 'ZT001' THEN NULL/);
  assert.doesNotMatch(fixture.sql, /EXCEPTION WHEN OTHERS/);
  assert.ok(
    fixture.sql.includes(`PERFORM "${fixture.namespace}"."assert_failure"(item->>0,expected)`),
  );
  assert.ok(fixture.sql.includes(`PERFORM "${fixture.namespace}"."assert_intact"();`));
  assert.match(fixture.sql, /encode\(sha256\(convert_to\(string_agg/);
  assert.match(fixture.sql, /failures IS DISTINCT FROM/);
  for (const text of [
    "restricted owner",
    "public execution",
    "request execution",
    "unsafe path",
    "replica only",
    "wrong update columns",
    "wrong schema",
    "safe overload",
    "request column grant",
    "wrong active-run partial predicate",
    "uniqueness removed",
    "missing profile erasure barrier",
    "uncertain invitation removed from dedup predicate",
    "multiple initial reviews allowed",
    "dispatch isolation default",
    "dispatch isolation nullability",
    "zoho_campaign_reviews: missing erasure barrier",
    "zoho_campaign_reviews: wrong erasure subject",
    "zoho_campaign_recipients: disabled erasure barrier",
    "zoho_campaign_frozen_plan_barrier: wrong timing",
    "frozen plan delete protection removed",
  ])
    assert.ok(
      fixture.cases.some(({ name }) => name.includes(text)),
      text,
    );
});
test("Zoho denial probes exercise the real request role and all five table ACLs", () => {
  const { sql, cases } = buildAtsSchemaAuditFixture(fingerprint);
  assert.match(sql, /GRANT USAGE ON SCHEMA .* TO lexy_app/);
  assert.match(sql, /SET LOCAL ROLE lexy_app;/);
  assert.match(sql, /EXCEPTION WHEN insufficient_privilege THEN NULL/);
  assert.match(sql, /RESET ROLE;\nROLLBACK TO SAVEPOINT request_role_probe;/);
  for (const table of atsSchemaInspection().contract.tables.filter((t) =>
    t.name.startsWith("zoho_"),
  )) {
    assert.ok(sql.includes(`"${table.name}" LIMIT 1`));
    for (const label of ["public grant", "request grant", "column grant", "unexpected policy"])
      assert.ok(cases.some((c) => c.name === `${table.name}: ${label}`));
  }
});
test("payload is bounded and invocations do not reuse fixture namespaces", () => {
  const first = buildAtsSchemaAuditFixture(fingerprint);
  const second = buildAtsSchemaAuditFixture(fingerprint);
  assert.notEqual(first.namespace, second.namespace);
  assert.ok(first.shadow.length < 64);
  assert.ok(Buffer.byteLength(first.sql) < 96 * 1024);
  assert.equal((first.sql.match(/AS \$catalog\$/g) ?? []).length, 1);
});
test("generator CLI rejects invalid arguments without database access", () => {
  for (const args of [[], ["bad"], [fingerprint, "--apply"]]) {
    const result = spawnSync(process.execPath, ["scripts/ats-db-schema-sql-fixture.mjs", ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, "");
  }
});
