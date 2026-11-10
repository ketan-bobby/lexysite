import { expectedUsageArea } from "./usage-schema-contract.mjs";

const expectedDefaults = {
  "staff_google_calendars.updated_at": "now()",
  "staff_google_calendars.needs_reconnect": "false",
  "staff_google_meet_recordings.updated_at": "now()",
  "staff_google_meet_recordings.needs_reconnect": "false",
  "staff_google_calendars.invitation_consent": "false",
  "staff_google_calendars.flow_invitations": "false",
  "interview_calendar_invitation_attempts.provider": "'outlook'::text",
  "calendar_working_hours.updated_at": "now()",
  "interview_schedule_panels.saved_at": "now()",
  "calendar_panel_consents.granted_at": "now()",
  "vendor_usage_attempts.created_at": "now()",
  "vendor_usage_attempts.units": "'{}'::jsonb",
  "vendor_usage_attempts.cost_status": "'unknown'::text",
  "pilot_codes.redemption_count": "0",
  "pilot_codes.disabled": "false",
  "pilot_codes.created_at": "now()",
  "tenant_pilot_grants.created_at": "now()",
  "candidate_erasure_tombstones.erased_at": "now()",
  "interview_calendar_invitation_attempts.changes": "'[]'::jsonb",
};

const columns = (table_name, specification) =>
  specification.split(" ").map((field) => {
    const [column_name, data_type, required] = field.split(":");
    return {
      table_name,
      column_name,
      data_type,
      required: required === "!",
      default_sql: expectedDefaults[`${table_name}.${column_name}`] ?? null,
    };
  });

/** Runtime schema plus reviewed security DDL. Never execute the migration text. */
export function recentSchemaContract(erasureMigration) {
  const functions = Array.from(
    erasureMigration.matchAll(
      /CREATE OR REPLACE FUNCTION public\.(\w+)\(([^)]*)\)\s*RETURNS (\w+)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/g,
    ),
    ([, name, args, return_type, body]) => ({
      name,
      args: args.trim(),
      return_type,
      body: body.replaceAll("\r\n", "\n").trim(),
    }),
  );
  const names = functions.map((fn) => fn.name).sort();
  if (
    JSON.stringify(names) !==
    JSON.stringify([
      "lexy_assert_candidate_active",
      "lexy_erasure_job_blocked",
      "lexy_erasure_write_barrier",
    ])
  ) {
    throw new Error("Erasure migration function contract is incomplete");
  }
  const trigger = (table_name, args = []) => ({
    table_name,
    args_hex: args.length ? Buffer.from(`${args.join("\0")}\0`).toString("hex") : "",
  });
  return {
    tables: [
      {
        name: "calendar_working_hours",
        rls: true,
        forced: true,
        no_policies: true,
        no_public_grants: true,
        no_request_grants: true,
      },
      {
        name: "staff_google_calendars",
        rls: true,
        forced: true,
        no_policies: true,
        no_public_grants: true,
        no_request_grants: true,
      },
      {
        name: "staff_google_meet_recordings",
        rls: true,
        forced: true,
        no_policies: true,
        no_public_grants: true,
        no_request_grants: true,
      },
      {
        name: "interview_schedule_panels",
        rls: true,
        forced: true,
        no_policies: true,
        no_public_grants: true,
        no_request_grants: true,
      },
      {
        name: "calendar_panel_consents",
        rls: true,
        forced: true,
        no_policies: true,
        no_public_grants: true,
        no_request_grants: true,
      },
      {
        name: "interview_calendar_invitation_attempts",
        rls: true,
        forced: true,
        no_policies: true,
        no_public_grants: true,
        no_request_grants: true,
      },
      {
        name: "interview_booking_links",
        rls: true,
        forced: true,
        no_policies: true,
        no_public_grants: true,
        no_request_grants: true,
      },
      { name: "vendor_usage_attempts", rls: true, forced: true, no_policies: true },
      {
        name: "interview_offered_times",
        rls: true,
        forced: true,
        no_policies: true,
        no_public_grants: true,
        no_request_grants: true,
      },
      { name: "pilot_codes", rls: true, no_policies: true },
      { name: "tenant_pilot_grants", rls: true, no_policies: true },
      { name: "candidate_erasure_tombstones", no_public_grants: true },
      { name: "users" },
      { name: "deletion_requests" },
    ],
    columns: [
      ...columns(
        "calendar_working_hours",
        "user_id:text:! tenant_id:text:! revision:text:! time_zone:text:? windows:jsonb:! updated_at:timestamptz:!",
      ),
      ...columns(
        "interview_schedule_panels",
        "schedule_id:text:! revision:text:! coordinator_id:text:! members:jsonb:! buffer_minutes:int4:! saved_at:timestamptz:!",
      ),
      ...columns("interview_schedules", "panel_revision:text:?"),
      ...columns(
        "calendar_panel_consents",
        "user_id:text:! tenant_id:text:! mailbox_hash:text:! granted_at:timestamptz:!",
      ),
      ...columns(
        "staff_google_calendars",
        "user_id:text:! tenant_id:text:! revision:text:! client_fingerprint:text:! subject:text account_email:text refresh_token_enc:text connected_at:timestamptz needs_reconnect:bool:! invitation_consent:bool:! flow_invitations:bool:! flow_hash:text browser_hash:text verifier_enc:text nonce_hash:text flow_expires_at:timestamptz updated_at:timestamptz:!",
      ),
      ...columns(
        "staff_google_meet_recordings",
        "user_id:text:! tenant_id:text:! revision:text:! client_fingerprint:text:! subject:text account_email:text refresh_token_enc:text connected_at:timestamptz needs_reconnect:bool:! flow_hash:text browser_hash:text verifier_enc:text nonce_hash:text flow_expires_at:timestamptz updated_at:timestamptz:!",
      ),
      ...columns(
        "interview_calendar_invitation_attempts",
        "schedule_id:text:! candidate_id:text:! application_id:text:! organizer_id:text:! recipient_hash:text:! schedule_version:text:! transaction_id:text:! status:text:! attempted_at:timestamptz:! accepted_at:timestamptz event_id:text changes:jsonb:! panel_snapshot:jsonb provider:text:! google_snapshot:jsonb",
      ),
      ...columns(
        "interview_booking_links",
        "schedule_id:text:! candidate_id:text:! application_id:text:! proposal_version:text:! offer_version:text version:text:! token_hash:text:! expires_at:timestamptz:! used_at:timestamptz selected_at:timestamptz confirmed_version:text",
      ),
      ...columns(
        "interview_offered_times",
        "schedule_id:text:! candidate_id:text:! application_id:text:! proposal_version:text:! version:text:! alternatives:jsonb:! expires_at:timestamptz:!",
      ),
      ...columns(
        "vendor_usage_attempts",
        "id:text:! created_at:timestamptz:! tenant_id:text area:text:! provider:text:! operation:text:! model:text retry_index:int4 status:text:! http_status:int4 latency_ms:int4 units:jsonb:! cost_status:text:!",
      ),
      ...columns(
        "pilot_codes",
        "id:text:! code:text:! label:text:! max_redemptions:int4:! redemption_count:int4:! disabled:bool:! created_by:text:! created_at:timestamptz:!",
      ),
      ...columns(
        "tenant_pilot_grants",
        "id:text:! tenant_id:text:! code_id:text:! previous_plans:jsonb:! redeemed_by:text:! created_at:timestamptz:! ended_at:timestamptz ended_by:text",
      ),
      ...columns("candidate_erasure_tombstones", "subject_id:text:! erased_at:timestamptz:!"),
      ...columns("users", "account_erased_at:timestamp"),
      ...columns("deletion_requests", "storage_cleanup:jsonb"),
    ],
    constraints: [
      [
        "staff_google_meet_recordings",
        "staff_google_meet_recordings_pkey",
        "PRIMARY KEY (user_id)",
      ],
      [
        "staff_google_meet_recordings",
        "staff_google_meet_recordings_user_id_fkey",
        "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
      ],
      [
        "staff_google_meet_recordings",
        "staff_google_meet_recordings_connection_complete",
        "CHECK ((((refresh_token_enc IS NULL) AND (subject IS NULL) AND (account_email IS NULL) AND (connected_at IS NULL)) OR ((refresh_token_enc IS NOT NULL) AND (subject IS NOT NULL) AND (account_email IS NOT NULL) AND (connected_at IS NOT NULL))))",
      ],
      [
        "staff_google_meet_recordings",
        "staff_google_meet_recordings_flow_complete",
        "CHECK ((((flow_hash IS NULL) AND (browser_hash IS NULL) AND (verifier_enc IS NULL) AND (nonce_hash IS NULL) AND (flow_expires_at IS NULL)) OR ((flow_hash IS NOT NULL) AND (browser_hash IS NOT NULL) AND (verifier_enc IS NOT NULL) AND (nonce_hash IS NOT NULL) AND (flow_expires_at IS NOT NULL))))",
      ],
      [
        "interview_calendar_invitation_attempts",
        "interview_calendar_invitation_attempts_pkey",
        "PRIMARY KEY (schedule_id)",
      ],
      [
        "interview_calendar_invitation_attempts",
        "interview_calendar_invitation_attempts_schedule_id_fkey",
        "FOREIGN KEY (schedule_id) REFERENCES interview_schedules(id) ON DELETE CASCADE",
      ],
      [
        "interview_calendar_invitation_attempts",
        "interview_calendar_invitation_attempts_status_check",
        "CHECK ((status = ANY (ARRAY['attempted'::text, 'accepted'::text])))",
      ],
      ["interview_booking_links", "interview_booking_links_pkey", "PRIMARY KEY (schedule_id)"],
      ["interview_booking_links", "interview_booking_links_token_hash_key", "UNIQUE (token_hash)"],
      [
        "interview_booking_links",
        "interview_booking_links_schedule_id_fkey",
        "FOREIGN KEY (schedule_id) REFERENCES interview_schedules(id) ON DELETE CASCADE",
      ],
      ["interview_offered_times", "interview_offered_times_pkey", "PRIMARY KEY (schedule_id)"],
      [
        "interview_offered_times",
        "interview_offered_times_schedule_id_fkey",
        "FOREIGN KEY (schedule_id) REFERENCES interview_schedules(id) ON DELETE CASCADE",
      ],
      ["vendor_usage_attempts", "vendor_usage_attempts_pkey", "PRIMARY KEY (id)"],
      ["pilot_codes", "pilot_codes_pkey", "PRIMARY KEY (id)"],
      ["pilot_codes", "pilot_codes_code_key", "UNIQUE (code)"],
      ["tenant_pilot_grants", "tenant_pilot_grants_pkey", "PRIMARY KEY (id)"],
      [
        "candidate_erasure_tombstones",
        "candidate_erasure_tombstones_pkey",
        "PRIMARY KEY (subject_id)",
      ],
      [
        "tenant_pilot_grants",
        "tenant_pilot_grants_tenant_id_fkey",
        "FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE",
      ],
      [
        "tenant_pilot_grants",
        "tenant_pilot_grants_code_id_fkey",
        "FOREIGN KEY (code_id) REFERENCES pilot_codes(id)",
      ],
      ["vendor_usage_attempts", "vendor_usage_attempts_area_check", expectedUsageArea],
      [
        "vendor_usage_attempts",
        "vendor_usage_attempts_cost_status_check",
        "CHECK ((cost_status = 'unknown'::text))",
      ],
    ].map(([table_name, name, definition]) => ({ table_name, name, definition })),
    indexes: [
      [
        "staff_google_meet_recordings_flow_unique",
        "CREATE UNIQUE INDEX staff_google_meet_recordings_flow_unique ON public.staff_google_meet_recordings USING btree (flow_hash)",
      ],
      [
        "vendor_usage_attempts_created_idx",
        "CREATE INDEX vendor_usage_attempts_created_idx ON public.vendor_usage_attempts USING btree (created_at)",
      ],
      [
        "vendor_usage_attempts_tenant_created_idx",
        "CREATE INDEX vendor_usage_attempts_tenant_created_idx ON public.vendor_usage_attempts USING btree (tenant_id, created_at)",
      ],
      [
        "tenant_pilot_grants_active_uq",
        "CREATE UNIQUE INDEX tenant_pilot_grants_active_uq ON public.tenant_pilot_grants USING btree (tenant_id) WHERE (ended_at IS NULL)",
      ],
      [
        "deletion_cleanup_pending_idx",
        "CREATE INDEX deletion_cleanup_pending_idx ON public.deletion_requests USING btree (((storage_cleanup ->> 'nextAttemptAt'::text))) WHERE ((storage_cleanup IS NOT NULL) AND (status = 'in_progress'::text))",
      ],
    ].map(([name, definition]) => ({ name, definition })),
    functions,
    triggers: [
      trigger("interview_calendar_invitation_attempts", ["candidate_id"]),
      trigger("interview_booking_links", ["candidate_id"]),
      trigger("interview_offered_times", ["candidate_id"]),
      trigger("candidates"),
      trigger("sourced_candidates", ["normalized_candidate_id"]),
      trigger("ai_jobs"),
      trigger("interview_summaries", ["interview_session_id", "interview_sessions"]),
      trigger("interview_schedules", ["application_id", "applications"]),
      trigger("recruiting_workflow_events", ["workflow_id", "recruiting_workflows"]),
    ],
  };
}
