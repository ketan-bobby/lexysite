// Reviewed storage requirements from migrations 0099–0103, not observed DB data.
export const zohoSpecifications = {
  zoho_recruit_accounts:
    "tenant_id:text user_id:text revision:text fingerprint:text flow_hash:text:? browser_hash:text:? flow_expires_at:timestamptz:? account_ref:text:? company_name:text:? refresh_token_enc:text:? approved_at:timestamptz:? updated_at:timestamptz",
  zoho_imported_jobs:
    "id:text tenant_id:text account_ref:text external_job_id:text job_id:text imported_by:text imported_at:timestamptz",
  zoho_interview_campaigns:
    "id:text tenant_id:text account_ref:text revision:text job_id:text external_job_id:text plan_id:text frozen_plan_id:text:? request_id:text snapshot_hash:text brief_hash:text application_count:int4 state:text dispatch_lane:text created_by:text approved_by:text:? approved_at:timestamptz:? created_at:timestamptz",
  zoho_campaign_recipients:
    "id:text campaign_id:text tenant_id:text account_ref:text external_job_id:text external_application_id:text external_candidate_id:text candidate_id:text:? session_id:text:? state:text reason:text:? message_id:text:? updated_at:timestamptz",
  zoho_campaign_reviews:
    "id:text tenant_id:text campaign_id:text recipient_id:text candidate_id:text session_id:text decision:text reason:text evidence_hash:text previous_review_id:text:? reviewed_by:text request_id:text request_hash:text created_at:timestamptz",
};

export const zohoDefaults = {
  "zoho_recruit_accounts.updated_at": "now()",
  "zoho_imported_jobs.imported_at": "now()",
  "zoho_interview_campaigns.state": "'draft'::text",
  "zoho_interview_campaigns.dispatch_lane": "'live'::text",
  "zoho_interview_campaigns.created_at": "now()",
  "zoho_campaign_recipients.state": "'draft'::text",
  "zoho_campaign_recipients.updated_at": "now()",
  "zoho_campaign_reviews.created_at": "now()",
};

export function zohoSchemaObjects({ index, fk, status }) {
  const check = (table_name, name, definition) => ({ table_name, name, definition });
  const invitationStates = [
    "queued",
    "preparing",
    "sending",
    "sent",
    "blocked",
    "review_required",
    "simulated",
  ];
  return {
    constraints: [
      fk("zoho_recruit_accounts", "user_id", "users"),
      fk("zoho_imported_jobs", "job_id", "jobs"),
      fk("zoho_campaign_recipients", "campaign_id", "zoho_interview_campaigns"),
      fk("zoho_campaign_reviews", "recipient_id", "zoho_campaign_recipients"),
      ...["zoho_interview_campaigns", "zoho_campaign_reviews"].map((table) =>
        check(table, `${table}_tenant_id_request_id_key`, "UNIQUE (tenant_id, request_id)"),
      ),
      check(
        "zoho_campaign_recipients",
        "zoho_campaign_recipients_campaign_id_external_candidate_id_key",
        "UNIQUE (campaign_id, external_candidate_id)",
      ),
      check(
        "zoho_interview_campaigns",
        "zoho_interview_campaigns_application_count_check",
        "CHECK ((application_count >= 0))",
      ),
      status("zoho_interview_campaigns", ["draft", "approved", "cancelled"], "state"),
      status(
        "zoho_campaign_recipients",
        [
          "draft",
          "queued",
          "preparing",
          "sending",
          "sent",
          "blocked",
          "review_required",
          "simulated",
          "skipped",
          "cancelled",
        ],
        "state",
      ),
      status("zoho_campaign_reviews", ["advance", "hold", "decline"], "decision"),
      check(
        "zoho_campaign_reviews",
        "zoho_campaign_reviews_reason_check",
        "CHECK (((length(btrim(reason)) >= 10) AND (length(btrim(reason)) <= 2000)))",
      ),
      {
        ...status("zoho_interview_campaigns", ["live", "isolated_test"], "dispatch_lane"),
        name: "zoho_campaign_dispatch_lane_check",
      },
    ],
    indexes: [
      index("zoho_recruit_account_ref_unique", "zoho_recruit_accounts", "account_ref"),
      index(
        "zoho_imported_job_identity",
        "zoho_imported_jobs",
        "tenant_id, account_ref, external_job_id",
      ),
      index(
        "zoho_campaign_invitation_identity",
        "zoho_campaign_recipients",
        "tenant_id, account_ref, external_job_id, external_candidate_id",
        true,
        ` WHERE (state = ANY (ARRAY[${invitationStates.map((value) => `'${value}'::text`).join(", ")}]))`,
      ),
      index("zoho_campaign_queue", "zoho_campaign_recipients", "state, updated_at", false),
      index(
        "zoho_campaign_reviews_history",
        "zoho_campaign_reviews",
        "tenant_id, recipient_id, created_at, id",
        false,
      ),
      {
        ...index(
          "zoho_campaign_reviews_chain",
          "zoho_campaign_reviews",
          "recipient_id, previous_review_id",
        ),
        definition:
          index(
            "zoho_campaign_reviews_chain",
            "zoho_campaign_reviews",
            "recipient_id, previous_review_id",
          ).definition + " NULLS NOT DISTINCT",
      },
    ],
    erasureTriggers: ["zoho_campaign_recipients", "zoho_campaign_reviews"].map((table_name) => ({
      table_name,
      args_hex: Buffer.from("candidate_id\0").toString("hex"),
    })),
    triggers: [
      {
        table_name: "zoho_campaign_recipients",
        name: "zoho_campaign_identity_barrier",
        function_name: "zoho_campaign_identity_barrier",
        type: 23,
        columns: [],
      },
      {
        table_name: "interview_plans",
        name: "zoho_campaign_frozen_plan_barrier",
        function_name: "zoho_campaign_frozen_plan_barrier",
        type: 27,
        columns: [],
      },
      {
        table_name: "zoho_campaign_reviews",
        name: "zoho_campaign_review_immutable",
        function_name: "zoho_campaign_review_immutable",
        type: 19,
        columns: [],
      },
    ],
  };
}
