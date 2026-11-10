import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { developmentFingerprintSql } from "./recent-db-schema-sql-fixture.mjs";
import { handoffCheckNames, handoffSchemaInspection } from "./check-zoho-handoff-schema.mjs";

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** SQL generation only. No live tables, functions, policies or roles are changed. */
export function buildZohoHandoffAuditFixture(fingerprint) {
  assert.match(fingerprint ?? "", /^[0-9a-f]{32}$/);
  const namespace = `lexy_handoff_audit_${randomUUID().replaceAll("-", "")}`;
  const shadow = `${namespace}_shadow`;
  const q = (name) => `"${namespace}"."${name}"`;
  const mappings = q("zoho_stage_mappings");
  const events = q("zoho_stage_handoff_events");
  const presence = [
    "tables_present",
    "forced_rls",
    "request_table_privileges_denied",
    "request_column_privileges_denied",
  ];
  const cases = [];
  const add = (name, mutation, expected) =>
    cases.push({ name, mutation, expected: expected.sort() });
  add("missing mappings", `DROP TABLE ${mappings}`, [...presence]);
  add("missing receipts", `DROP TABLE ${events}`, [
    ...presence,
    "receipt_erasure_guard",
    "immutable_receipts",
    "simulation_only_state",
    "request_id_unique",
    "approval_evidence_unique",
    "recipient_cascade",
  ]);
  for (const table of [mappings, events]) {
    add(`${table}: RLS disabled`, `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`, [
      "forced_rls",
    ]);
    add(`${table}: RLS not forced`, `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`, [
      "forced_rls",
    ]);
    add(`${table}: request table grant`, `GRANT SELECT ON ${table} TO lexy_app`, [
      "request_table_privileges_denied",
      "request_column_privileges_denied",
    ]);
    add(`${table}: request column grant`, `GRANT SELECT(tenant_id) ON ${table} TO lexy_app`, [
      "request_column_privileges_denied",
    ]);
    add(`${table}: public grant`, `GRANT SELECT ON ${table} TO PUBLIC`, [
      "request_table_privileges_denied",
      "request_column_privileges_denied",
      "no_public_acl",
    ]);
    add(
      `${table}: unexpected policy`,
      `CREATE POLICY fixture_policy ON ${table} FOR SELECT TO lexy_app USING(true)`,
      ["no_request_policies"],
    );
  }
  add(
    "disabled erasure barrier",
    `ALTER TABLE ${events} DISABLE TRIGGER lexy_erasure_write_barrier`,
    ["receipt_erasure_guard"],
  );
  add(
    "wrong erasure argument",
    `CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON ${events}
     FOR EACH ROW EXECUTE FUNCTION ${q("lexy_erasure_write_barrier")}('session_id')`,
    ["receipt_erasure_guard"],
  );
  add(
    "wrong erasure function schema",
    `CREATE OR REPLACE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON ${events}
     FOR EACH ROW EXECUTE FUNCTION "${shadow}".lexy_erasure_write_barrier('candidate_id')`,
    ["receipt_erasure_guard"],
  );
  add(
    "disabled immutability barrier",
    `ALTER TABLE ${events} DISABLE TRIGGER zoho_stage_handoff_immutable`,
    ["immutable_receipts"],
  );
  add(
    "wrong immutability function schema",
    `CREATE OR REPLACE TRIGGER zoho_stage_handoff_immutable BEFORE UPDATE ON ${events}
     FOR EACH ROW EXECUTE FUNCTION "${shadow}".zoho_campaign_review_immutable()`,
    ["immutable_receipts"],
  );
  add(
    "missing simulation restriction",
    `ALTER TABLE ${events} DROP CONSTRAINT zoho_stage_handoff_events_state_check`,
    ["simulation_only_state"],
  );
  for (const [name, definition] of [
    ["request_id_unique", "UNIQUE (tenant_id, request_id)"],
    [
      "approval_evidence_unique",
      "UNIQUE (tenant_id, recipient_id, review_revision, mapping_revision)",
    ],
    [
      "recipient_cascade",
      "FOREIGN KEY (recipient_id) REFERENCES zoho_campaign_recipients(id) ON DELETE CASCADE",
    ],
  ]) {
    add(
      `missing ${name}`,
      `DO $drop$ DECLARE c text; BEGIN
      SELECT conname INTO STRICT c FROM pg_constraint
      WHERE conrelid=${literal(events)}::regclass
      AND pg_get_constraintdef(oid)=${literal(definition)};
      EXECUTE format('ALTER TABLE ${events} DROP CONSTRAINT %I',c);
      END $drop$`,
      [name],
    );
  }
  const migration = readFileSync(
    new URL("../lib/db/drizzle/0104_zoho_stage_handoff_preparation.sql", import.meta.url),
    "utf8",
  )
    .replace(/^BEGIN;\s*/, "")
    .replace(/COMMIT;\s*$/, "")
    .replaceAll("public.", `"${namespace}".`);
  assert.doesNotMatch(migration, /\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
  const query = handoffSchemaInspection().replaceAll("$1", literal(namespace));
  const checks = `ARRAY[${handoffCheckNames.map(literal).join(",")}]::text[]`;
  const sql = `BEGIN;
SET LOCAL statement_timeout='60s';
SET LOCAL lock_timeout='2s';
DO $target$ BEGIN
  IF (${developmentFingerprintSql}) IS DISTINCT FROM ${literal(fingerprint)}
  THEN RAISE EXCEPTION 'Development target mismatch; no fixture objects were created'; END IF;
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user)
     OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lexy_app' AND NOT rolsuper AND NOT rolbypassrls)
  THEN RAISE EXCEPTION 'Fixture requires a privileged development owner and restricted request role'; END IF;
END $target$;
CREATE SCHEMA "${namespace}";
CREATE SCHEMA "${shadow}";
REVOKE ALL ON SCHEMA "${namespace}", "${shadow}" FROM PUBLIC,lexy_app;
SET LOCAL search_path="${namespace}",pg_catalog;
CREATE TABLE ${q("zoho_interview_campaigns")}(id text PRIMARY KEY);
CREATE TABLE ${q("zoho_campaign_recipients")}(id text PRIMARY KEY);
${[namespace, shadow]
  .map((schema) =>
    ["lexy_erasure_write_barrier", "zoho_campaign_review_immutable"]
      .map(
        (name) => `CREATE FUNCTION "${schema}"."${name}"() RETURNS trigger
LANGUAGE plpgsql AS $stub$ BEGIN RETURN NEW; END; $stub$;`,
      )
      .join("\n"),
  )
  .join("\n")}
${migration}
CREATE FUNCTION ${q("audit")}() RETURNS TABLE(name text,passed boolean)
LANGUAGE sql AS $audit$ ${query} $audit$;
CREATE FUNCTION ${q("assert_failures")}(expected text[]) RETURNS void
LANGUAGE plpgsql AS $assert$
DECLARE names text[]; failures text[]; total integer;
BEGIN
  SELECT count(*),array_agg(name ORDER BY name),
    COALESCE(array_agg(name ORDER BY name) FILTER(WHERE NOT passed),'{}'::text[])
  INTO total,names,failures FROM ${q("audit")}();
  IF total<>12 OR names IS DISTINCT FROM (SELECT array_agg(n ORDER BY n) FROM unnest(${checks}) n)
     OR failures IS DISTINCT FROM expected
  THEN RAISE EXCEPTION 'Unexpected handoff audit result: %',failures; END IF;
END $assert$;
SELECT ${q("assert_failures")}('{}'::text[]);
DO $cases$ DECLARE item jsonb; BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(${literal(JSON.stringify(cases))}::jsonb)
  LOOP
    BEGIN
      EXECUTE item->>'mutation';
      PERFORM ${q("assert_failures")}(ARRAY(SELECT jsonb_array_elements_text(item->'expected')));
      RAISE EXCEPTION USING ERRCODE='ZH001';
    EXCEPTION WHEN SQLSTATE 'ZH001' THEN NULL;
    END;
    PERFORM ${q("assert_failures")}('{}'::text[]);
  END LOOP;
END $cases$;
SAVEPOINT request_probe;
GRANT USAGE ON SCHEMA "${namespace}" TO lexy_app;
SET LOCAL ROLE lexy_app;
DO $probe$ BEGIN
  BEGIN PERFORM 1 FROM ${mappings} LIMIT 1;
    RAISE EXCEPTION 'Request-role mapping read was not denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM 1 FROM ${events} LIMIT 1;
    RAISE EXCEPTION 'Request-role receipt read was not denied';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $probe$;
RESET ROLE;
ROLLBACK TO SAVEPOINT request_probe;
SELECT ${q("assert_failures")}('{}'::text[]);
ROLLBACK;
SELECT NOT EXISTS(SELECT 1 FROM pg_namespace
 WHERE nspname IN (${literal(namespace)},${literal(shadow)})) AS fixture_cleanup_passed;`;
  return { sql, namespace, shadow, cases, caseCount: cases.length };
}
