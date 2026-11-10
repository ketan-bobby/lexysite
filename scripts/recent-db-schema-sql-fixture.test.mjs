import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSchemaAuditFixture,
  developmentFingerprintSql,
} from "./recent-db-schema-sql-fixture.mjs";

const fingerprint = "0123456789abcdef0123456789abcdef";

test("SQL fixture refuses to generate without a verified development fingerprint", () => {
  for (const value of [undefined, "", "production", "'; DROP SCHEMA public; --"]) {
    assert.throws(() => buildSchemaAuditFixture(value));
  }
  assert.match(developmentFingerprintSql, /^SELECT md5\(/);
  assert.match(developmentFingerprintSql, /pg_postmaster_start_time/);
});

test("fixture is target-guarded, private, rollback-only, and uses harmless stub functions", () => {
  const { sql, namespace, caseCount } = buildSchemaAuditFixture(fingerprint);
  assert.match(namespace, /^lexy_readiness_[a-f0-9]{32}$/);
  assert.equal(caseCount, 33);
  assert.ok(sql.indexOf("Development target mismatch") < sql.indexOf("CREATE SCHEMA"));
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /ROLLBACK;\nSELECT NOT EXISTS/);
  assert.doesNotMatch(sql, /\bCOMMIT\b/i);
  assert.doesNotMatch(
    sql,
    /(?:ALTER|DROP|CREATE|INSERT INTO|UPDATE|DELETE FROM)\s+(?:TABLE|FUNCTION|SCHEMA)?\s*"?public"?\./i,
  );
  assert.doesNotMatch(sql, /lexy_assert_candidate_active\(subject\)/);
  assert.match(sql, /AS \$stub\$BEGIN RETURN; END;\$stub\$/);
  assert.match(sql, /fixture_cleanup_passed/);
  assert.match(sql, /"interview_schedules" \(id text PRIMARY KEY, panel_revision text\)/);
  assert.equal((sql.match(/SAVEPOINT negative_case;/g) ?? []).length, 99);
});

test("each execution gets a distinct namespace and all audit namespaces are bound", () => {
  const first = buildSchemaAuditFixture(fingerprint);
  const second = buildSchemaAuditFixture(fingerprint);
  assert.notEqual(first.namespace, second.namespace);
  assert.match(first.sql, /n\.nspname=\$2/);
  assert.match(first.sql, /JOIN pg_catalog\.pg_attribute a ON a\.attrelid=c\.oid/);
  assert.doesNotMatch(first.sql, /n\.nspname='public'/);
});

test("the shared contract is serialized once to keep SQL transport comfortably bounded", () => {
  const { sql } = buildSchemaAuditFixture(fingerprint);
  assert.equal((sql.match(/"functions":\[/g) ?? []).length, 1);
  assert.ok(Buffer.byteLength(sql, "utf8") < 96 * 1024);
});
