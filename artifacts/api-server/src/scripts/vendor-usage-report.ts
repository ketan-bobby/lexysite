/**
 * Platform operations, read-only:
 * pnpm --filter @workspace/api-server exec tsx src/scripts/vendor-usage-report.ts [days]
 * Add --requests for individual attempts with receipt IDs and labelled estimates.
 *
 * No employer API. Unclassified interview use may include private learning.
 * Never use this observation report as an invoice or execution authorization.
 */
import { dbAdmin, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { PUBLIC_RATE_REFERENCE } from "../lib/vendor-rate-reference";
import { observeRequestCost } from "../lib/vendor-cost-observation";
import type { VendorUsageUnits } from "@workspace/db";

const args = process.argv.slice(2);
const perRequest = args.includes("--requests");
const positional = args.filter((arg) => arg !== "--requests");
const days = Number(positional[0] ?? 30);
if (positional.length > 1) {
  process.stderr.write("usage: vendor-usage-report.ts [days] [--requests]\n");
  process.exit(1);
}
if (!Number.isSafeInteger(days) || days < 1 || days > 90) {
  process.stderr.write("days must be an integer between 1 and 90\n");
  process.exit(1);
}

try {
  if (perRequest) {
    const requests = await dbAdmin.execute(sql`
      SELECT id, created_at, tenant_id, area, provider, operation, model,
        retry_index, status, http_status, latency_ms, units
      FROM vendor_usage_attempts
      WHERE created_at >= now() - make_interval(days => ${days})
      ORDER BY created_at DESC, id LIMIT 10000
    `);
    process.stdout.write(
      `${JSON.stringify(
        {
          days,
          mode: "per_request",
          limit: 10000,
          possiblyTruncated: requests.rows.length === 10000,
          coverage: "Instrumented attempts only; no inference of complete account spend.",
          pricing: "Public-rate estimates are NOT confirmed account charges or payment limits.",
          requests: requests.rows.map((row) => ({
            ...row,
            ...observeRequestCost({
              provider: String(row.provider),
              operation: String(row.operation),
              status: String(row.status),
              model: typeof row.model === "string" ? row.model : null,
              units: row.units as VendorUsageUnits,
            }),
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const result = await dbAdmin.execute(sql`
    WITH RECURSIVE ancestry AS (
      SELECT id AS leaf_id, id AS ancestor_id, parent_id, ARRAY[id] AS path
      FROM tenants
      UNION ALL
      SELECT a.leaf_id, t.id, t.parent_id, a.path || t.id
      FROM ancestry a JOIN tenants t ON t.id = a.parent_id
      WHERE NOT t.id = ANY(a.path) AND cardinality(a.path) < 30
    ), roots AS (
      SELECT leaf_id, ancestor_id AS billing_root FROM ancestry WHERE parent_id IS NULL
    )
    SELECT date_trunc('day', u.created_at)::date AS day,
      r.billing_root, u.area, u.provider, u.operation, u.model,
      count(*)::int AS observed_attempts,
      count(*) FILTER (WHERE u.status IN ('started', 'uncertain'))::int AS unresolved_attempts,
      count(*) FILTER (WHERE u.status = 'http_error')::int AS http_error_attempts,
      count(*) FILTER (WHERE u.retry_index > 0)::int AS observed_retry_attempts,
      count(*) FILTER (WHERE u.retry_index IS NULL)::int AS attempts_with_unknown_retry_index,
      sum((u.units->>'observed_api_requests')::bigint) AS observed_transport_invocations,
      sum((u.units->>'observed_websocket_sessions')::bigint) AS observed_websocket_sessions,
      sum((u.units->>'observed_email_recipients')::bigint) AS observed_email_recipient_submissions,
      sum((u.units->>'audio_bytes')::bigint) AS observed_audio_bytes,
      sum((u.units->>'input_tokens')::bigint) AS observed_input_tokens,
      sum((u.units->>'output_tokens')::bigint) AS observed_output_tokens,
      sum((u.units->>'cached_input_tokens')::bigint) AS observed_cached_input_tokens,
      sum((u.units->>'reasoning_tokens')::bigint) AS observed_reasoning_tokens,
      sum((u.units->>'audio_seconds')::numeric) AS provider_reported_audio_seconds,
      sum((u.units->>'input_characters')::bigint) AS observed_input_characters,
      count(*) FILTER (WHERE u.units->>'input_tokens' IS NULL AND u.operation = 'chat')::int
        AS chat_attempts_missing_usage,
      count(*) FILTER (WHERE u.units->>'input_tokens' IS NULL AND u.operation = 'embedding')::int
        AS embedding_attempts_missing_usage,
      count(*) FILTER (WHERE u.units->>'audio_seconds' IS NULL AND u.operation = 'stt')::int
        AS stt_attempts_missing_duration,
      count(*) FILTER (WHERE u.units->>'provider_request_id' IS NOT NULL)::int
        AS attempts_with_provider_receipts,
      sum((u.units->>'provider_reported_credits')::bigint) AS provider_reported_credits,
      NULL::numeric AS verified_cost_usd
    FROM vendor_usage_attempts u LEFT JOIN roots r ON r.leaf_id = u.tenant_id
    WHERE u.created_at >= now() - make_interval(days => ${days})
    GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1, 2, 3, 4, 5, 6
  `);
    process.stdout.write(
      `${JSON.stringify(
        {
          days,
          coverage:
            "Instrumented transports/sessions only; NOT complete account spend or an invoice.",
          privacy: "Platform operations only; interview use remains unclassified/private.",
          pricing:
            "Account charges unknown. Public reference rates are not receipts or plan allowances.",
          publicRateReference: PUBLIC_RATE_REFERENCE,
          rows: result.rows,
        },
        null,
        2,
      )}\n`,
    );
  }
} catch {
  process.stderr.write("Usage report failed; no cost or coverage conclusion is available.\n");
  process.exitCode = 1;
} finally {
  await pool.end();
}
