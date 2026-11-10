import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recentSchemaContract } from "./recent-db-schema-contract.mjs";
import { requiredSchemaCheckNames } from "./check-recent-db-schema.mjs";

// Non-secret instance identity. Obtain it through the DEVELOPMENT database handle,
// never by assuming the app's DATABASE_URL points at development.
export const developmentFingerprintSql = `SELECT md5(
  current_database() || '|' ||
  COALESCE(inet_server_addr()::text, 'local') || '|' ||
  COALESCE(inet_server_port()::text, '0') || '|' ||
  EXTRACT(EPOCH FROM pg_postmaster_start_time())::text
) AS development_fingerprint`;

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const identifier = (value) => {
  assert.match(value, /^[a-z_][a-z0-9_]*$/);
  return `"${value}"`;
};

/**
 * Generate, never execute, rollback-only development SQL. All DDL is confined
 * to a fresh private namespace; functions are harmless stubs, not erasure code.
 */
export function buildSchemaAuditFixture(developmentFingerprint) {
  assert.match(developmentFingerprint ?? "", /^[0-9a-f]{32}$/);
  const namespace = `lexy_readiness_${randomUUID().replaceAll("-", "")}`;
  const q = (name) => `${identifier(namespace)}.${identifier(name)}`;
  const audit = readFileSync(new URL("./sql/check-recent-db-schema.sql", import.meta.url), "utf8");
  const contract = recentSchemaContract(
    readFileSync(
      new URL("./sql/2026-10-11-candidate-erasure-write-barrier.sql", import.meta.url),
      "utf8",
    ),
  );
  const stub = (fn) =>
    `BEGIN ${fn.return_type === "trigger" ? "RETURN NEW;" : fn.return_type === "boolean" ? "RETURN false;" : "RETURN;"} END;`;
  contract.functions = contract.functions.map((fn) => ({ ...fn, body: stub(fn) }));
  contract.indexes = contract.indexes.map((index) => ({
    ...index,
    definition: index.definition.replace(" ON public.", ` ON ${namespace}.`),
  }));
  const ddl = [
    "BEGIN;",
    "SET LOCAL statement_timeout = '10s';",
    "SET LOCAL lock_timeout = '2s';",
    `DO $target$ BEGIN
      IF (${developmentFingerprintSql}) IS DISTINCT FROM ${literal(developmentFingerprint)}
      THEN RAISE EXCEPTION 'Development target mismatch; no fixture objects were created';
      END IF;
    END $target$;`,
    `CREATE SCHEMA ${identifier(namespace)};`,
    `SET LOCAL search_path = pg_catalog, ${identifier(namespace)};`,
    `CREATE TABLE ${q("tenants")} (id text PRIMARY KEY);`,
    `CREATE TABLE ${q("interview_schedules")} (id text PRIMARY KEY, panel_revision text);`,
  ];
  const types = new Set(["text", "int4", "bool", "timestamp", "timestamptz", "jsonb"]);
  for (const table of contract.tables) {
    const fields = contract.columns
      .filter((column) => column.table_name === table.name)
      .map((column) => {
        assert.ok(types.has(column.data_type));
        return `${identifier(column.column_name)} ${column.data_type}${column.required ? " NOT NULL" : ""}${column.default_sql ? ` DEFAULT ${column.default_sql}` : ""}`;
      });
    ddl.push(`CREATE TABLE ${q(table.name)} (${fields.join(", ")});`);
    if (table.rls) ddl.push(`ALTER TABLE ${q(table.name)} ENABLE ROW LEVEL SECURITY;`);
    if (table.forced) ddl.push(`ALTER TABLE ${q(table.name)} FORCE ROW LEVEL SECURITY;`);
    if (table.no_public_grants) ddl.push(`REVOKE ALL ON ${q(table.name)} FROM PUBLIC;`);
    if (table.no_request_grants) ddl.push(`REVOKE ALL ON ${q(table.name)} FROM lexy_app;`);
  }
  ddl.push(`ALTER TABLE ${q("deletion_requests")} ADD COLUMN status text;`);
  for (const constraint of contract.constraints) {
    ddl.push(
      `ALTER TABLE ${q(constraint.table_name)} ADD CONSTRAINT ${identifier(constraint.name)} ${constraint.definition};`,
    );
  }
  ddl.push(...contract.indexes.map((index) => `${index.definition};`));
  for (const fn of contract.functions) {
    ddl.push(`CREATE FUNCTION ${q(fn.name)}(${fn.args}) RETURNS ${fn.return_type}
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
      AS $stub$${fn.body}$stub$;`);
  }
  for (const trigger of contract.triggers) {
    if (
      trigger.table_name !== "interview_schedules" &&
      !contract.tables.some((table) => table.name === trigger.table_name)
    )
      ddl.push(`CREATE TABLE ${q(trigger.table_name)} (id text);`);
  }
  ddl.push(
    `CREATE TABLE ${q("readiness_candidate_child")} (candidate_id text);`,
    `CREATE TABLE ${q("decision_events")} (candidate_id text);`,
  );
  const triggerSql = (table, args = [], events = "INSERT OR UPDATE", suffix = "") =>
    `CREATE TRIGGER lexy_erasure_write_barrier BEFORE ${events} ON ${q(table)}
     FOR EACH ROW ${suffix} EXECUTE FUNCTION ${q("lexy_erasure_write_barrier")}(${args.map(literal).join(",")});`;
  for (const trigger of contract.triggers) {
    const args = Buffer.from(trigger.args_hex, "hex").toString("utf8").split("\0").filter(Boolean);
    ddl.push(triggerSql(trigger.table_name, args));
  }
  ddl.push(
    triggerSql("readiness_candidate_child", ["candidate_id"]),
    `CREATE FUNCTION ${q("inspect_fixture")}(contract jsonb, target_schema text)
     RETURNS TABLE(check_name text, passed boolean) LANGUAGE sql STABLE
     AS $catalog$${audit}$catalog$;`,
  );
  ddl.push(`CREATE FUNCTION ${q("fixture_contract")}() RETURNS jsonb
    LANGUAGE sql IMMUTABLE AS $contract$
    SELECT ${literal(JSON.stringify(contract))}::jsonb
    $contract$;`);
  const inspect = `${q("inspect_fixture")}(${q("fixture_contract")}(), ${literal(namespace)})`;
  const requiredNames = [
    ...requiredSchemaCheckNames(contract),
    "trigger:readiness_candidate_child",
  ];
  const textArray = (values) => `ARRAY[${values.map(literal).join(",")}]::text[]`;
  const positive = `DO $positive$ DECLARE ok boolean; BEGIN
    SELECT count(*)=${requiredNames.length}
      AND count(DISTINCT check_name)=${requiredNames.length}
      AND bool_and(passed IS TRUE)
      AND ${textArray(requiredNames)} <@ array_agg(check_name)
    INTO ok FROM ${inspect};
    IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Intact fixture did not pass'; END IF;
  END $positive$;`;
  ddl.push(positive);
  const alter = (table, action) => `ALTER TABLE ${q(table)} ${action};`;
  const dropTrigger = (table) => `DROP TRIGGER lexy_erasure_write_barrier ON ${q(table)};`;
  const candidateFn = `${q("lexy_assert_candidate_active")}(text)`;
  const cases = [
    [
      "offered-time RLS disabled",
      alter("interview_offered_times", "DISABLE ROW LEVEL SECURITY"),
      ["table:interview_offered_times"],
    ],
    [
      "offered-time RLS not forced",
      alter("interview_offered_times", "NO FORCE ROW LEVEL SECURITY"),
      ["table:interview_offered_times"],
    ],
    [
      "offered-time request-role table grant",
      `GRANT SELECT ON ${q("interview_offered_times")} TO lexy_app;`,
      ["table:interview_offered_times"],
    ],
    [
      "offered-time request-role column grant",
      `GRANT SELECT (alternatives) ON ${q("interview_offered_times")} TO lexy_app;`,
      ["table:interview_offered_times"],
    ],
    [
      "offered-time public column grant",
      `GRANT SELECT (alternatives) ON ${q("interview_offered_times")} TO PUBLIC;`,
      ["table:interview_offered_times"],
    ],
    [
      "offered-time accidental policy",
      `CREATE POLICY accidental_read ON ${q("interview_offered_times")} FOR SELECT USING (true);`,
      ["table:interview_offered_times"],
    ],
    [
      "offered-time missing cascade",
      `${alter("interview_offered_times", "DROP CONSTRAINT interview_offered_times_schedule_id_fkey")}
      ${alter("interview_offered_times", "ADD CONSTRAINT interview_offered_times_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES interview_schedules(id)")}`,
      ["constraint:interview_offered_times.interview_offered_times_schedule_id_fkey"],
    ],
    [
      "offered-time erasure barrier lost",
      dropTrigger("interview_offered_times"),
      ["trigger:interview_offered_times"],
    ],
    [
      "missing column",
      alter("vendor_usage_attempts", "DROP COLUMN model"),
      ["column:vendor_usage_attempts.model"],
    ],
    [
      "nullable required column",
      alter("vendor_usage_attempts", "ALTER COLUMN provider DROP NOT NULL"),
      ["column:vendor_usage_attempts.provider"],
    ],
    [
      "old pilot timestamp",
      alter(
        "pilot_codes",
        "ALTER COLUMN created_at TYPE timestamp USING created_at AT TIME ZONE 'UTC'",
      ),
      ["column:pilot_codes.created_at"],
    ],
    [
      "missing insert default",
      alter("vendor_usage_attempts", "ALTER COLUMN units DROP DEFAULT"),
      ["column:vendor_usage_attempts.units"],
    ],
    [
      "stale usage labels",
      `${alter("vendor_usage_attempts", "DROP CONSTRAINT vendor_usage_attempts_area_check")}
      ${alter("vendor_usage_attempts", "ADD CONSTRAINT vendor_usage_attempts_area_check CHECK (area IN ('unattributed','interview_unclassified'))")}`,
      ["constraint:vendor_usage_attempts.vendor_usage_attempts_area_check"],
    ],
    [
      "cost no longer unknown-only",
      `${alter("vendor_usage_attempts", "DROP CONSTRAINT vendor_usage_attempts_cost_status_check")}
      ${alter("vendor_usage_attempts", "ADD CONSTRAINT vendor_usage_attempts_cost_status_check CHECK (cost_status IN ('unknown','estimated'))")}`,
      ["constraint:vendor_usage_attempts.vendor_usage_attempts_cost_status_check"],
    ],
    [
      "missing primary key",
      alter("tenant_pilot_grants", "DROP CONSTRAINT tenant_pilot_grants_pkey"),
      ["constraint:tenant_pilot_grants.tenant_pilot_grants_pkey"],
    ],
    [
      "lost active grant uniqueness",
      `DROP INDEX ${q("tenant_pilot_grants_active_uq")};
      CREATE INDEX tenant_pilot_grants_active_uq ON ${q("tenant_pilot_grants")}(tenant_id) WHERE ended_at IS NULL;`,
      ["index:tenant_pilot_grants_active_uq"],
    ],
    [
      "missing cleanup index",
      `DROP INDEX ${q("deletion_cleanup_pending_idx")};`,
      ["index:deletion_cleanup_pending_idx"],
    ],
    [
      "RLS disabled",
      alter("vendor_usage_attempts", "DISABLE ROW LEVEL SECURITY"),
      ["table:vendor_usage_attempts"],
    ],
    [
      "RLS no longer forced",
      alter("vendor_usage_attempts", "NO FORCE ROW LEVEL SECURITY"),
      ["table:vendor_usage_attempts"],
    ],
    [
      "unexpected permissive policy",
      `CREATE POLICY fixture_public ON ${q("pilot_codes")} FOR SELECT TO PUBLIC USING (true);`,
      ["table:pilot_codes"],
    ],
    [
      "public tombstone access",
      `GRANT SELECT ON ${q("candidate_erasure_tombstones")} TO PUBLIC;`,
      ["table:candidate_erasure_tombstones"],
    ],
    [
      "disabled erasure trigger",
      alter("candidates", "DISABLE TRIGGER lexy_erasure_write_barrier"),
      ["trigger:candidates"],
    ],
    [
      "replica-only erasure trigger",
      alter("candidates", "ENABLE REPLICA TRIGGER lexy_erasure_write_barrier"),
      ["trigger:candidates"],
    ],
    [
      "missing dynamic child trigger",
      dropTrigger("readiness_candidate_child"),
      ["trigger:readiness_candidate_child"],
    ],
    [
      "wrong child trigger arguments",
      `${dropTrigger("readiness_candidate_child")}${triggerSql("readiness_candidate_child", ["wrong_column"])}`,
      ["trigger:readiness_candidate_child"],
    ],
    [
      "missing update coverage",
      `${dropTrigger("candidates")}${triggerSql("candidates", [], "INSERT")}`,
      ["trigger:candidates"],
    ],
    [
      "conditional erasure trigger",
      `${dropTrigger("candidates")}${triggerSql("candidates", [], "INSERT OR UPDATE", "WHEN (false)")}`,
      ["trigger:candidates"],
    ],
    [
      "wrong trigger function",
      `${dropTrigger("candidates")}
      CREATE FUNCTION ${q("other_trigger")}() RETURNS trigger LANGUAGE plpgsql AS $stub$BEGIN RETURN NEW; END;$stub$;
      CREATE TRIGGER lexy_erasure_write_barrier BEFORE INSERT OR UPDATE ON ${q("candidates")}
      FOR EACH ROW EXECUTE FUNCTION ${q("other_trigger")}();`,
      ["trigger:candidates"],
    ],
    [
      "drifted function body",
      `CREATE OR REPLACE FUNCTION ${q("lexy_assert_candidate_active")}(subject text)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public
      AS $stub$BEGIN PERFORM 1; RETURN; END;$stub$;`,
      ["function:lexy_assert_candidate_active"],
    ],
    [
      "lost security definer",
      `ALTER FUNCTION ${candidateFn} SECURITY INVOKER;`,
      ["function:lexy_assert_candidate_active"],
    ],
    [
      "unsafe function search path",
      `ALTER FUNCTION ${candidateFn} SET search_path=public;`,
      ["function:lexy_assert_candidate_active"],
    ],
    [
      "missing erasure function",
      `DROP FUNCTION ${candidateFn};`,
      ["function:lexy_assert_candidate_active"],
    ],
    [
      "missing table",
      `DROP TABLE ${q("users")};`,
      ["column:users.account_erased_at", "table:users"],
    ],
  ];
  for (const [name, mutation, expected] of cases) {
    ddl.push(
      "SAVEPOINT negative_case;",
      mutation,
      `DO $negative$ DECLARE failures text[]; BEGIN
        SELECT array_agg(check_name ORDER BY check_name) FILTER (WHERE passed IS DISTINCT FROM true)
        INTO failures FROM ${inspect};
        IF failures IS DISTINCT FROM ${textArray([...expected].sort())}
        THEN RAISE EXCEPTION 'Negative case % returned unexpected failures: %', ${literal(name)}, failures;
        END IF;
      END $negative$;`,
      "ROLLBACK TO SAVEPOINT negative_case;",
      "RELEASE SAVEPOINT negative_case;",
    );
  }
  ddl.push(
    positive,
    `SELECT ${cases.length} AS negative_cases_passed, 2 AS intact_fixture_checks_passed;`,
    "ROLLBACK;",
    `SELECT NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname=${literal(namespace)})
     AS fixture_cleanup_passed;`,
  );
  return { sql: ddl.join("\n"), namespace, caseCount: cases.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fingerprint = process.argv[2];
  if (!/^[0-9a-f]{32}$/.test(fingerprint ?? "") || process.argv.length !== 3) {
    console.error("Usage: node scripts/recent-db-schema-sql-fixture.mjs DEVELOPMENT_FINGERPRINT");
    process.exitCode = 2;
  } else {
    console.log(buildSchemaAuditFixture(fingerprint).sql);
  }
}
