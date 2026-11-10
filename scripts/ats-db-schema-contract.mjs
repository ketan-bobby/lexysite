import { readFileSync } from "node:fs";
import { zohoSpecifications, zohoDefaults, zohoSchemaObjects } from "./zoho-db-schema-contract.mjs";

const specifications = {
  ...zohoSpecifications,
  employer_ats_bindings:
    "tenant_id:text connection_id:text account_ref:text revision:int4 status:text allocated_by:text confirmed_by:text:? updated_at:timestamptz",
  ats_mapping_verifications:
    "id:text tenant_id:text job_id:text workflow_id:text candidate_id:text actor_id:text key:text request_hash:text mapping_hash:text mapping:jsonb workflow_revision:int4 binding_revision:int4 status:text checked_at:timestamptz",
  ats_imported_applications:
    "id:text tenant_id:text job_id:text workflow_id:text account_ref:text external_job_id:text external_application_id:text snapshot:jsonb imported_by:text observed_at:timestamptz imported_at:timestamptz refresh_revision:int4 current_snapshot:jsonb:? last_checked_at:timestamptz:? availability:text",
  ats_import_observations:
    "id:text tenant_id:text record_id:text revision:int4 key:text request_hash:text actor_id:text availability:text snapshot:jsonb checked_at:timestamptz",
  ats_refresh_schedules:
    "id:text tenant_id:text job_id:text workflow_id:text owner_user_id:text revision:int4 status:text record_ids:jsonb interval_minutes:int4 binding_revision:int4 workflow_revision:int4 authority_hash:text next_run_at:timestamptz:? blocked_reason:text:? updated_at:timestamptz",
  ats_refresh_runs:
    "id:text tenant_id:text job_id:text workflow_id:text schedule_id:text schedule_revision:int4 status:text items:jsonb message:text:? started_at:timestamptz finished_at:timestamptz:?",
  ats_candidate_profiles:
    "id:text tenant_id:text system:text account_ref:text external_candidate_id:text candidate_id:text imported_by:text imported_at:timestamptz fields:_text idempotency_key:text request_hash:text",
};
const defaults = {
  ...zohoDefaults,
  "employer_ats_bindings.updated_at": "now()",
  "ats_mapping_verifications.checked_at": "now()",
  "ats_imported_applications.imported_at": "now()",
  "ats_imported_applications.refresh_revision": "0",
  "ats_imported_applications.availability": "'unchecked'::text",
  "ats_candidate_profiles.imported_at": "now()",
};
const index = (name, table, fields, unique = true, where = "") => ({
  name,
  definition: `CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON public.${table} USING btree (${fields})${where}`,
});
const fk = (table_name, column, parent) => ({
  table_name,
  name: `${table_name}_${column}_fkey`,
  definition: `FOREIGN KEY (${column}) REFERENCES ${parent}(id) ON DELETE CASCADE`,
});
const status = (table_name, values, column = "status") => ({
  table_name,
  name: `${table_name}_${column}_check`,
  definition: `CHECK ((${column} = ANY (ARRAY[${values.map((v) => `'${v}'::text`).join(", ")}])))`,
});

/** Runtime column types and reviewed SQL security bodies, never inspected DB values. */
export function atsSchemaContract(erasureFunctions) {
  const source = [
    "0091_ats_verification.sql",
    "0095_ats_stage_initial_write_guard.sql",
    "0101_zoho_interview_campaigns.sql",
    "0102_zoho_campaign_reviews.sql",
  ]
    .map((name) => readFileSync(new URL(`../lib/db/drizzle/${name}`, import.meta.url), "utf8"))
    .join("\n");
  const bodies = new Map(
    Array.from(
      source.matchAll(
        /CREATE(?: OR REPLACE)? FUNCTION (?:public\.)?(\w+)\([^)]*\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g,
      ),
      ([, name, body]) => [name, body.replaceAll("\r\n", "\n").trim()],
    ),
  );
  const fn = (
    name,
    args,
    return_type,
    language,
    definer,
    search_path,
    owner_bypass,
    public_execute,
    request_execute,
  ) => {
    if (!bodies.has(name)) throw new Error("ATS security function contract is incomplete");
    return {
      name,
      args,
      return_type,
      language,
      definer,
      search_path,
      owner_bypass,
      public_execute,
      request_execute,
      body: bodies.get(name),
    };
  };
  const zoho = zohoSchemaObjects({ index, fk, status });
  return {
    scan_candidate_children: false,
    tables: Object.keys(specifications).map((name) => ({
      name,
      rls: true,
      forced: true,
      no_policies: true,
      no_public_grants: true,
      no_request_grants: true,
    })),
    columns: Object.entries(specifications).flatMap(([table_name, fields]) =>
      fields.split(" ").map((field) => {
        const [column_name, data_type, nullable] = field.split(":");
        return {
          table_name,
          column_name,
          data_type,
          required: nullable !== "?",
          default_sql: defaults[`${table_name}.${column_name}`] ?? null,
        };
      }),
    ),
    constraints: [
      ...Object.keys(specifications).map((table_name) => ({
        table_name,
        name: `${table_name}_pkey`,
        definition: `PRIMARY KEY (${["employer_ats_bindings", "zoho_recruit_accounts"].includes(table_name) ? "tenant_id" : "id"})`,
      })),
      ...[
        "ats_mapping_verifications",
        "ats_imported_applications",
        "ats_refresh_schedules",
        "ats_refresh_runs",
      ].map((table) => fk(table, "workflow_id", "recruiting_workflows")),
      fk("ats_mapping_verifications", "candidate_id", "candidates"),
      fk("ats_import_observations", "record_id", "ats_imported_applications"),
      fk("ats_refresh_runs", "schedule_id", "ats_refresh_schedules"),
      fk("ats_candidate_profiles", "candidate_id", "candidates"),
      {
        table_name: "employer_ats_bindings",
        name: "employer_ats_bindings_revision_check",
        definition: "CHECK ((revision > 0))",
      },
      status("employer_ats_bindings", ["pending_employer", "active", "disconnected"]),
      status("ats_mapping_verifications", ["checking", "verified", "failed", "discarded"]),
      status("ats_import_observations", ["available", "unavailable"], "availability"),
      status("ats_refresh_schedules", ["enabled", "paused"]),
      status("ats_refresh_runs", ["running", "completed", "stopped", "interrupted"]),
      {
        table_name: "ats_refresh_schedules",
        name: "ats_refresh_schedules_interval_minutes_check",
        definition: "CHECK ((interval_minutes = ANY (ARRAY[60, 360, 1440])))",
      },
      ...zoho.constraints,
    ],
    indexes: [
      index("employer_ats_connection_owner_unique", "employer_ats_bindings", "connection_id"),
      index(
        "ats_verification_request_unique",
        "ats_mapping_verifications",
        "tenant_id, workflow_id, key",
      ),
      index(
        "ats_import_external_application_unique",
        "ats_imported_applications",
        "tenant_id, account_ref, external_application_id",
      ),
      index("ats_import_observation_key_unique", "ats_import_observations", "record_id, key"),
      index(
        "ats_import_observation_revision_unique",
        "ats_import_observations",
        "record_id, revision",
      ),
      index("ats_refresh_schedule_workflow_unique", "ats_refresh_schedules", "workflow_id"),
      index("ats_refresh_schedule_due", "ats_refresh_schedules", "status, next_run_at", false),
      index(
        "ats_refresh_run_history",
        "ats_refresh_runs",
        "tenant_id, workflow_id, started_at",
        false,
      ),
      index(
        "ats_refresh_one_running",
        "ats_refresh_runs",
        "schedule_id",
        true,
        " WHERE (status = 'running'::text)",
      ),
      index(
        "ats_profile_external_person_unique",
        "ats_candidate_profiles",
        "tenant_id, system, account_ref, external_candidate_id",
      ),
      index("ats_profile_request_unique", "ats_candidate_profiles", "tenant_id, idempotency_key"),
      ...zoho.indexes,
    ],
    functions: erasureFunctions,
    triggers: [
      ...zoho.erasureTriggers,
      {
        table_name: "ats_mapping_verifications",
        args_hex: Buffer.from("candidate_id\0").toString("hex"),
      },
      {
        table_name: "ats_candidate_profiles",
        args_hex: Buffer.from("candidate_id\0").toString("hex"),
      },
    ],
    ats_functions: [
      fn(
        "zoho_campaign_identity_barrier",
        "",
        "trigger",
        "plpgsql",
        true,
        "search_path=pg_catalog,public",
        true,
        false,
        false,
      ),
      fn(
        "zoho_campaign_frozen_plan_barrier",
        "",
        "trigger",
        "plpgsql",
        true,
        "search_path=pg_catalog,public",
        true,
        false,
        false,
      ),
      fn(
        "zoho_campaign_review_immutable",
        "",
        "trigger",
        "plpgsql",
        false,
        "",
        false,
        false,
        false,
      ),
      fn(
        "lexy_ats_allocation_identity_immutable",
        "",
        "trigger",
        "plpgsql",
        false,
        "",
        false,
        true,
        true,
      ),
      fn(
        "ats_stage_is_external",
        "cid text, jid text",
        "boolean",
        "sql",
        true,
        "search_path=pg_catalog",
        true,
        false,
        true,
      ),
      fn(
        "guard_ats_owned_initial_stage",
        "",
        "trigger",
        "plpgsql",
        true,
        "search_path=pg_catalog",
        true,
        false,
        false,
      ),
    ],
    ats_triggers: [
      ...zoho.triggers,
      {
        table_name: "employer_ats_bindings",
        name: "lexy_ats_allocation_identity_immutable",
        function_name: "lexy_ats_allocation_identity_immutable",
        type: 19,
        columns: [],
      },
      {
        table_name: "applications",
        name: "ats_owned_application_insert",
        function_name: "guard_ats_owned_initial_stage",
        type: 23,
        columns: ["candidate_id", "job_id"],
      },
      {
        table_name: "sourced_candidates",
        name: "ats_owned_sourced_insert",
        function_name: "guard_ats_owned_initial_stage",
        type: 23,
        columns: ["normalized_candidate_id", "raw_data"],
      },
    ],
  };
}
