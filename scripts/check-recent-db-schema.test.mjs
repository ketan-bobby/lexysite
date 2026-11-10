import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkRecentSchema, requiredSchemaCheckNames } from "./check-recent-db-schema.mjs";
import { recentSchemaContract } from "./recent-db-schema-contract.mjs";

const migration = readFileSync(
  new URL("./sql/2026-10-11-candidate-erasure-write-barrier.sql", import.meta.url),
  "utf8",
);
const completeRows = () =>
  requiredSchemaCheckNames(recentSchemaContract(migration)).map((check_name) => ({
    check_name,
    passed: true,
  }));

test("panel buffer metadata uses the PostgreSQL catalog type, not its SQL alias", () => {
  const column = recentSchemaContract(migration).columns.find(
    (c) => c.table_name === "interview_schedule_panels" && c.column_name === "buffer_minutes",
  );
  assert.equal(column?.data_type, "int4");
});

function fixture({ rows = completeRows(), mode = "on", error } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.startsWith("SHOW")) return { rows: [{ transaction_read_only: mode }] };
      if (params) {
        if (error) throw error;
        return { rows };
      }
      return { rows: [] };
    },
  };
}

test("catalog reads are bound to a verified read-only transaction, always rolled back", async () => {
  const client = fixture();
  const report = await checkRecentSchema(client);
  assert.equal(report.passed, true);
  assert.equal(report.readOnly, true);
  assert.equal(report.targetEnvironment, "not-independently-attested");
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
  const catalog = client.calls.find((call) => call.params);
  assert.equal(catalog.params.length, 2);
  assert.equal(catalog.params[1], "public");
  assert.match(catalog.text, /pg_catalog\.pg_trigger/);
  assert.match(catalog.text, /pg_catalog\.pg_get_constraintdef/);
  assert.doesNotMatch(
    catalog.text,
    /FROM\s+(?:public\.)?(?:candidates|users|interview_sessions)\b/i,
  );
  assert.equal(JSON.parse(catalog.params[0]).functions.length, 3);
});

test("missing or drifted metadata is not reported as ready", async () => {
  const rows = completeRows();
  rows.find((row) => row.check_name === "trigger:candidates").passed = false;
  const report = await checkRecentSchema(fixture({ rows }));
  assert.equal(report.passed, false);
  assert.deepEqual(
    report.checks.filter((row) => !row.passed),
    [{ name: "trigger:candidates", passed: false }],
  );
});

test("incomplete, duplicate, or non-boolean evidence cannot produce a false pass", async () => {
  const nonBoolean = completeRows();
  nonBoolean[0].passed = "f";
  const duplicate = completeRows();
  duplicate.push(duplicate[0]);
  for (const rows of [[], completeRows().slice(1), nonBoolean, duplicate]) {
    const client = fixture({ rows });
    await assert.rejects(checkRecentSchema(client), /incomplete or invalid evidence/);
    assert.equal(client.calls.at(-1).text, "ROLLBACK");
  }
});

test("a writable transaction is rejected before metadata inspection", async () => {
  const client = fixture({ mode: "off" });
  await assert.rejects(checkRecentSchema(client), /Read-only transaction/);
  assert.equal(
    client.calls.some((call) => call.params),
    false,
  );
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("database failures remain failures and still roll back", async () => {
  const failure = new Error("fixture connection failure");
  const client = fixture({ error: failure });
  await assert.rejects(checkRecentSchema(client), (error) => error === failure);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("function expectations come from the reviewed migration, not the inspected database", () => {
  const contract = recentSchemaContract(migration);
  assert.equal(contract.functions.length, 3);
  assert.ok(contract.functions.every((fn) => fn.body.includes("candidate")));
  assert.equal(
    contract.triggers.find((item) => item.table_name === "sourced_candidates").args_hex,
    Buffer.from("normalized_candidate_id\0").toString("hex"),
  );
  assert.throws(() => recentSchemaContract(""), /contract is incomplete/);
  assert.ok(
    contract.constraints
      .find((item) => item.name.endsWith("_area_check"))
      .definition.includes("discovery|enrichment"),
  );
});

test("pilot date columns require the timezone-aware types used by the runtime schema", () => {
  const contract = recentSchemaContract(migration);
  for (const [table, column] of [
    ["pilot_codes", "created_at"],
    ["tenant_pilot_grants", "created_at"],
    ["tenant_pilot_grants", "ended_at"],
  ]) {
    const expected = contract.columns.find(
      (item) => item.table_name === table && item.column_name === column,
    );
    assert.equal(expected.data_type, "timestamptz");
  }
});

test("release usage contract preserves every reviewed activity label without broadening it", async () => {
  const { expectedUsageArea, meetingUsageSchemaReport } =
    await import("./check-meeting-usage-schema.mjs");
  const definition = recentSchemaContract(migration).constraints.find(
    (item) => item.name === "vendor_usage_attempts_area_check",
  ).definition;
  assert.equal(definition, expectedUsageArea);
  const labelMigration = readFileSync(
    new URL("../lib/db/drizzle/0076_usage_economics_labels.sql", import.meta.url),
    "utf8",
  );
  const labels = (text) => [...text.matchAll(/'activity:[a-z_]+'/g)].map(([label]) => label);
  assert.deepEqual(labels(definition), labels(labelMigration));
  assert.equal(labels(definition).length, 8);
  for (const area of [
    definition.replace("'activity:recruiter'", "'activity:unreviewed'"),
    definition.replace(
      " OR (area = ANY (ARRAY['activity:",
      " OR true OR (area = ANY (ARRAY['activity:",
    ),
    "CHECK (true)",
  ]) {
    const report = meetingUsageSchemaReport({ area });
    assert.equal(report.checks.find((item) => item.name === "usage-activity-labels").passed, false);
  }
});

test("insert-critical defaults are checked rather than accepting columns by name alone", () => {
  const contract = recentSchemaContract(migration);
  for (const [table, column, expectedDefault] of [
    ["vendor_usage_attempts", "cost_status", "'unknown'::text"],
    ["vendor_usage_attempts", "units", "'{}'::jsonb"],
    ["pilot_codes", "redemption_count", "0"],
    ["pilot_codes", "disabled", "false"],
    ["candidate_erasure_tombstones", "erased_at", "now()"],
  ]) {
    const expected = contract.columns.find(
      (item) => item.table_name === table && item.column_name === column,
    );
    assert.equal(expected.default_sql, expectedDefault);
  }
});

test("offered-time deployment evidence requires privacy, lifetime and erasure protections", () => {
  const contract = recentSchemaContract(migration);
  const table = contract.tables.find((item) => item.name === "interview_offered_times");
  assert.deepEqual(table, {
    name: "interview_offered_times",
    rls: true,
    forced: true,
    no_policies: true,
    no_public_grants: true,
    no_request_grants: true,
  });
  assert.equal(contract.columns.filter((item) => item.table_name === table.name).length, 7);
  assert.equal(
    contract.triggers.find((item) => item.table_name === table.name).args_hex,
    Buffer.from("candidate_id\0").toString("hex"),
  );
  assert.ok(
    contract.constraints.some(
      (item) => item.table_name === table.name && item.definition.includes("ON DELETE CASCADE"),
    ),
  );
});
