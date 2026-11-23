import { sql } from "drizzle-orm";

type ErasureTransaction = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };

/** Caller already owns the canonical candidate lock. Keep only replay hashes. */
export async function scrubQorInterviewRequests(tx: ErasureTransaction, candidateId: string) {
  const tables = (await tx.execute(
    sql`SELECT to_regclass('public.qor_interview_requests') IS NOT NULL AS installed`,
  )) as {
    rows: { installed: boolean }[];
  };
  if (!tables.rows[0]?.installed) return;
  const contact = sql`encode(sha256(convert_to(lower(btrim(c.email)), 'UTF8')), 'hex')`;
  const key = sql`('qor-contact:' || c.tenant_id || ':' || ${contact})`;
  // Serialize with new intake for this contact, including requests not linked yet.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
    FROM candidates c WHERE c.id=${candidateId} AND c.tenant_id IS NOT NULL`);
  await tx.execute(sql`INSERT INTO candidate_erasure_tombstones(subject_id)
    SELECT ${key} FROM candidates c WHERE c.id=${candidateId} AND c.tenant_id IS NOT NULL
    ON CONFLICT DO NOTHING`);
  await tx.execute(sql`UPDATE qor_interview_requests r SET
      erased_at=now(), external_application_id=NULL, external_candidate_id=NULL,
      contact_hash=NULL, selection_ref=NULL, external_job_id=NULL, job_title=NULL,
      job_brief=NULL, job_revision=NULL, job_approval_ref=NULL, job_id=NULL,
      candidate_id=NULL, session_id=NULL, prepared_by=NULL,
      invitation_released_at=NULL, invitation_released_by=NULL,
      invitation_reported_at=NULL, invitation_reported_by=NULL,
      report_hash=NULL, report_version=0, report_approved_at=NULL, report_approved_by=NULL
    FROM candidates c WHERE c.id=${candidateId} AND r.tenant_id=c.tenant_id
    AND (r.candidate_id=c.id OR r.contact_hash=${contact}) AND r.erased_at IS NULL`);
}
