import { createHash } from "node:crypto";
import { dbAdmin } from "@workspace/db";
import { sql, type SQL } from "drizzle-orm";
import { classBRead, CLASS_B_READ_EXEMPTION } from "./class-b-read";
import { platformReadExemption, PLATFORM_READ_EXEMPTION } from "./platform-pool-read";
import { logger } from "./logger";

export interface WeeklyRecapBinding {
  userId: string | null;
  periodEnd: Date;
}

/** Opaque identity checksum, not an authorization token. Match PostgreSQL's
 * jsonb array serialization so recovery can recheck identity in the INSERT. */
export function weeklyDigestOperationId(
  input: {
    candidateId: string;
    ownerTenantId: string | null;
    to: string;
    weeklyRecap: WeeklyRecapBinding;
  },
  nonce: string,
): string {
  const identity = [input.candidateId, input.ownerTenantId, input.to, input.weeklyRecap.userId];
  const fingerprint = createHash("sha256")
    .update(`[${identity.map((value) => JSON.stringify(value)).join(", ")}]`)
    .digest("hex");
  return `candidate-cadence:weekly_digest:v1:${input.weeklyRecap.periodEnd.toISOString().slice(0, 10)}:${nonce}:${fingerprint}`;
}

// Candidate-owned background messaging, not employer access. Only newly bound
// receipts are recoverable; older receipts cannot prove the original owner.
const eligible = sql`
  ce.tenant_id = 'platform' AND ce.channel = 'email'
  AND ce.type = 'status_update' AND ce.status IN ('sent','delivered','opened') AND ce.sent_at IS NOT NULL
  AND ce.id ~ '^candidate-cadence:weekly_digest:v1:[0-9]{4}-[0-9]{2}-[0-9]{2}:[0-9a-f-]{36}:[0-9a-f]{64}$'
  AND c.pool IN ('platform') AND c.data_erased_at IS NULL
  AND COALESCE(c.do_not_contact, false) = false
  AND right(ce.id,64) = encode(sha256(convert_to(
    jsonb_build_array(c.id,c.tenant_id,c.email,c.user_id)::text,'UTF8')),'hex')`;
const period = sql`substring(ce.id from '^candidate-cadence:weekly_digest:v1:([0-9]{4}-[0-9]{2}-[0-9]{2}):')`;

function selfDirectedRead() {
  classBRead(CLASS_B_READ_EXEMPTION.CANDIDATE_SELF_OWNED);
  platformReadExemption(PLATFORM_READ_EXEMPTION.SELF_DIRECTED_CANDIDATE_MESSAGING);
}

/** No transport or learning-provider dependency: this can only create a bell
 * entry from an already accepted receipt. INSERT/SELECT fences late erasure,
 * DNC and owner drift; the deterministic PK preserves an existing read flag. */
export function createWeeklyDigestRecapStore(
  execute: (query: SQL) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> = (
    query,
  ) => dbAdmin.execute(query),
) {
  async function persistWeeklyDigestRecap(
    operationId: string,
    original?: { title: string; message: string },
  ): Promise<boolean> {
    selfDirectedRead();
    const result = await execute(sql`
    INSERT INTO candidate_notifications
      (id,tenant_id,candidate_id,type,title,message,is_read,action_url,created_at)
    SELECT 'weekly-digest:' || ce.id,'platform',ce.candidate_id,'weekly_digest',
      COALESCE(${original?.title ?? null}::text,'Your week on Lexy — week ending ' || ${period}),
      COALESCE(${original?.message ?? null}::text,
        'Your weekly update covers the period ending ' || ${period} ||
        '. Visit your career portal to continue your progress.'),
      false,'/portal',ce.created_at
    FROM communication_events ce JOIN candidates c ON c.id = ce.candidate_id
    WHERE ce.id = ${operationId} AND ${eligible}
    ON CONFLICT (id) DO NOTHING RETURNING id`);
    return (result.rowCount ?? 0) === 1;
  }

  async function recoverWeeklyDigestRecaps(
    operationId?: string,
  ): Promise<{ recovered: number; failed: number }> {
    selfDirectedRead();
    const pending = await execute(sql`
    SELECT ce.id FROM communication_events ce
    JOIN candidates c ON c.id = ce.candidate_id
    LEFT JOIN candidate_notifications n ON n.id = 'weekly-digest:' || ce.id
    WHERE ${eligible} AND n.id IS NULL
      AND (${operationId ?? null}::text IS NULL OR ce.id = ${operationId ?? null})
    ORDER BY ce.created_at,ce.id LIMIT 100`);
    let recovered = 0,
      failed = 0;
    for (const row of pending.rows) {
      try {
        if (typeof row.id === "string" && (await persistWeeklyDigestRecap(row.id))) recovered++;
      } catch {
        failed++;
        logger.warn("[weekly-digest] Recap recovery deferred; no email retry was attempted");
      }
    }
    return { recovered, failed };
  }
  return { persistWeeklyDigestRecap, recoverWeeklyDigestRecaps };
}
export const { persistWeeklyDigestRecap, recoverWeeklyDigestRecaps } =
  createWeeklyDigestRecapStore();
