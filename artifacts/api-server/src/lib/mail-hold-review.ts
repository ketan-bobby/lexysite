import { randomUUID } from "node:crypto";
import { dbAdmin, auditLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import type { MailHold, MailHoldReviewInput } from "@workspace/api-zod";
import { platformReadExemption, PLATFORM_READ_EXEMPTION } from "./platform-pool-read";

// Operational metadata only. This service is called only after an active
// platform-admin gate; it is not an employer candidate-search surface.
// It intentionally has no transport dependency and NEVER releases a send hold.
function eligible() {
  platformReadExemption(PLATFORM_READ_EXEMPTION.ADMINISTRATIVE_MAIL_HOLD_METADATA);
  return sql`
  ce.status = 'pending' AND ce.channel = 'email'
  AND (ce.id LIKE 'candidate-cadence:%'
    OR ce.id ~ '^inbox-reply:[0-9a-f]{64}$'
    OR ce.id LIKE 'interview-reengagement:%')
  AND c.data_erased_at IS NULL AND COALESCE(c.do_not_contact,false) = false
  AND (ce.tenant_id = c.tenant_id OR (ce.tenant_id = 'platform' AND c.pool IN ('platform')))`;
}
const reviewJoin = sql`LEFT JOIN LATERAL (
  SELECT a.id,a.created_at,a.metadata->>'disposition' AS disposition,
    count(*) OVER () AS review_count
  FROM audit_logs a WHERE a.action = 'mail_hold_reviewed'
    AND a.tenant_id = ce.tenant_id AND a.subject_type = 'candidate'
    AND a.subject_id = ce.candidate_id AND a.metadata->>'operationId' = ce.id
  ORDER BY a.created_at DESC,a.id DESC LIMIT 1
) r ON true`;
const version = sql`encode(sha256(convert_to(ce.xmin::text || ':' || COALESCE(r.review_count,0)::text,'UTF8')),'hex')`;
const selection = sql`ce.id AS "operationId", ce.tenant_id AS "tenantId",
  ce.candidate_id AS "candidateId", ce.type AS kind,
  to_char(ce.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "reservedAt",
  ${version} AS version, r.disposition AS "lastReview",
  to_char(r.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastReviewedAt"`;

export async function listMailHolds(cursor?: string, candidateId?: string) {
  const result = await dbAdmin.execute(sql`
    SELECT ${selection} FROM communication_events ce
    JOIN candidates c ON c.id = ce.candidate_id ${reviewJoin}
    WHERE ${eligible()} ${cursor ? sql`AND ce.id > ${cursor}` : sql``}
      ${candidateId ? sql`AND ce.candidate_id = ${candidateId}` : sql``}
    ORDER BY ce.id ASC LIMIT 51`);
  // Explicit metadata DTO; no body, subject, recipient address or candidate profile.
  const data = (result.rows as unknown as MailHold[]).slice(0, 50);
  const hasMore = result.rows.length > 50;
  return { data, hasMore, nextCursor: hasMore ? data.at(-1)!.operationId : null };
}

export class MailHoldConflict extends Error {
  constructor(public readonly status: 404 | 409) {
    super(status === 404 ? "Hold no longer available" : "Hold changed; refresh before reviewing");
  }
}

export async function reviewMailHold(actorId: string, input: MailHoldReviewInput) {
  return dbAdmin.transaction(async (tx) => {
    // Serialize reviews and prevent late erasure/DNC changes during the audit
    // insert. A concurrent sender may finish later; its actual outcome remains
    // authoritative because this service does not alter communication_events.
    const locked = await tx.execute(sql`
      SELECT ce.id FROM communication_events ce JOIN candidates c ON c.id=ce.candidate_id
      WHERE ce.id=${input.operationId} AND ${eligible()} FOR UPDATE OF ce,c`);
    if (locked.rows.length !== 1) throw new MailHoldConflict(404);
    const result = await tx.execute(sql`
      SELECT ${selection} FROM communication_events ce
      JOIN candidates c ON c.id=ce.candidate_id ${reviewJoin}
      WHERE ce.id=${input.operationId} AND ${eligible()}`);
    const row = result.rows[0] as unknown as MailHold | undefined;
    if (!row) throw new MailHoldConflict(404);
    if (row.version !== input.version) throw new MailHoldConflict(409);
    const reviewId = randomUUID();
    await tx.insert(auditLogsTable).values({
      id: reviewId,
      tenantId: row.tenantId,
      actorType: "user",
      actorId,
      subjectType: "candidate",
      subjectId: row.candidateId,
      channel: "system",
      direction: "internal",
      action: "mail_hold_reviewed",
      createdAt: sql`clock_timestamp()`,
      title: "Email hold reviewed; no resend authorized",
      metadata: {
        operationId: row.operationId,
        disposition: input.disposition,
        evidenceReference: input.evidenceReference,
        priorVersion: row.version,
        holdRetained: true,
      },
    });
    return { reviewId, disposition: input.disposition, holdRetained: true as const };
  });
}
