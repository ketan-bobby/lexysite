import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import {
  atsSchemaInspection,
  checkAtsSchema,
  requiredSchemaCheckNames,
} from "./check-recent-db-schema.mjs";

const { contract, query } = atsSchemaInspection();
const complete = () =>
  requiredSchemaCheckNames(contract).map((check_name) => ({ check_name, passed: true }));
function fixture(rows = complete(), mode = "on", failure) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.startsWith("SHOW")) return { rows: [{ transaction_read_only: mode }] };
      if (params) {
        if (failure) throw failure;
        return { rows };
      }
      return { rows: [] };
    },
  };
}

test("ATS audit covers twelve private tables including Zoho custody, campaigns and reviews", () => {
  assert.equal(contract.tables.length, 12);
  assert.ok(
    contract.tables.every((t) => t.rls && t.forced && t.no_policies && t.no_request_grants),
  );
  assert.equal(contract.scan_candidate_children, false);
  assert.equal(contract.ats_functions.length, 6);
  assert.equal(contract.ats_triggers.length, 6);
  assert.equal(contract.functions.length, 3);
  const names = requiredSchemaCheckNames(contract);
  assert.equal(names.length, new Set(names).size);
  assert.ok(names.includes("index:ats_refresh_one_running"));
  assert.ok(names.includes("index:ats_profile_external_person_unique"));
  assert.ok(names.includes("trigger:applications.ats_owned_application_insert"));
  assert.ok(names.includes("trigger:ats_mapping_verifications"));
  assert.ok(names.includes("trigger:ats_candidate_profiles"));
  for (const name of [
    "table:zoho_recruit_accounts",
    "table:zoho_imported_jobs",
    "table:zoho_interview_campaigns",
    "table:zoho_campaign_recipients",
    "table:zoho_campaign_reviews",
    "column:zoho_interview_campaigns.dispatch_lane",
    "constraint:zoho_interview_campaigns.zoho_campaign_dispatch_lane_check",
    "index:zoho_campaign_invitation_identity",
    "index:zoho_campaign_reviews_chain",
    "trigger:zoho_campaign_recipients",
    "trigger:zoho_campaign_reviews",
    "trigger:interview_plans.zoho_campaign_frozen_plan_barrier",
    "trigger:zoho_campaign_reviews.zoho_campaign_review_immutable",
    "trigger:zoho_campaign_recipients.zoho_campaign_identity_barrier",
  ])
    assert.ok(names.includes(name), name);
  assert.equal(
    contract.triggers.find((t) => t.table_name === "ats_candidate_profiles").args_hex,
    Buffer.from("candidate_id\0").toString("hex"),
  );
});

test("Zoho storage protections include private execution, exact bodies and all-event immutability", () => {
  for (const name of ["zoho_campaign_identity_barrier", "zoho_campaign_frozen_plan_barrier"]) {
    const fn = contract.ats_functions.find((f) => f.name === name);
    assert.equal(fn.definer, true);
    assert.equal(fn.owner_bypass, true);
    assert.equal(fn.search_path, "search_path=pg_catalog,public");
    assert.equal(fn.public_execute, false);
    assert.equal(fn.request_execute, false);
  }
  const immutable = contract.ats_functions.find((f) => f.name === "zoho_campaign_review_immutable");
  assert.equal(immutable.definer, false);
  assert.equal(immutable.public_execute, false);
  assert.equal(immutable.request_execute, false);
  assert.match(immutable.body, /RAISE EXCEPTION.*Append a new review/);
  assert.match(
    contract.ats_functions.find((f) => f.name === "zoho_campaign_identity_barrier").body,
    /candidate_erasure_tombstones/,
  );
  assert.equal(contract.ats_triggers.find((t) => t.table_name === "interview_plans").type, 27);
  const lane = contract.columns.find((c) => c.column_name === "dispatch_lane");
  assert.equal(lane.required, true);
  assert.equal(lane.default_sql, "'live'::text");
});

test("ATS inspection is catalog-only with bound schema, effective grants and exact security bodies", () => {
  assert.match(query, /pg_catalog\.pg_attribute/);
  assert.doesNotMatch(query, /information_schema\.columns/);
  assert.match(query, /has_any_column_privilege/);
  assert.match(query, /has_function_privilege/);
  assert.match(query, /owner_role\.rolbypassrls/);
  assert.match(query, /t\.tgattr/);
  assert.match(query, /t\.tgenabled IN \('O','A'\)/);
  assert.doesNotMatch(query, /(?:FROM|JOIN)\s+public\.(?:candidates|applications|users)\b/i);
  assert.ok(contract.ats_functions.every((fn) => fn.body.length > 50));
  const external = contract.ats_functions.find((fn) => fn.name === "ats_stage_is_external");
  assert.equal(external.language, "sql");
  assert.equal(external.owner_bypass, true);
  assert.equal(external.public_execute, false);
  assert.equal(external.request_execute, true);
});

test("successful ATS evidence stays explicitly unattested and always rolls back", async () => {
  const client = fixture();
  const report = await checkAtsSchema(client);
  assert.equal(report.scope, "ats-schema-metadata-only");
  assert.equal(report.targetEnvironment, "not-independently-attested");
  assert.equal(report.readOnly, true);
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, requiredSchemaCheckNames(contract).length);
  assert.equal(client.calls[0].text, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
  const catalog = client.calls.find((call) => call.params);
  assert.equal(catalog.params[1], "public");
  assert.deepEqual(JSON.parse(catalog.params[0]), contract);
});

test("every missing or drifted ATS check fails independently", async () => {
  for (const name of requiredSchemaCheckNames(contract)) {
    const rows = complete();
    rows.find((row) => row.check_name === name).passed = false;
    const report = await checkAtsSchema(fixture(rows));
    assert.equal(report.passed, false, name);
    assert.deepEqual(
      report.checks.filter((row) => !row.passed),
      [{ name, passed: false }],
    );
  }
});

test("partial, duplicate, or nonboolean ATS evidence cannot be called ready", async () => {
  const badBoolean = complete();
  badBoolean[0].passed = "t";
  const repeated = complete();
  repeated.push(repeated[0]);
  for (const rows of [[], complete().slice(1), badBoolean, repeated]) {
    const client = fixture(rows);
    await assert.rejects(checkAtsSchema(client), /incomplete or invalid evidence/);
    assert.equal(client.calls.at(-1).text, "ROLLBACK");
  }
});

test("writable sessions and database failures never bypass rollback or claim readiness", async () => {
  const writable = fixture(complete(), "off");
  await assert.rejects(checkAtsSchema(writable), /Read-only transaction/);
  assert.equal(
    writable.calls.some((call) => call.params),
    false,
  );
  assert.equal(writable.calls.at(-1).text, "ROLLBACK");
  const client = fixture(complete(), "on", new Error("Fixture unavailable"));
  await assert.rejects(checkAtsSchema(client), /Fixture unavailable/);
  assert.equal(client.calls.at(-1).text, "ROLLBACK");
});

test("unsupported CLI options fail without connecting or displaying secrets", () => {
  const run = spawnSync(
    process.execPath,
    ["scripts/check-recent-db-schema.mjs", "--ats", "--apply"],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, DATABASE_URL: "private-connection-value" },
      encoding: "utf8",
    },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Usage/);
  assert.doesNotMatch(run.stdout + run.stderr, /private-connection-value/);
});
