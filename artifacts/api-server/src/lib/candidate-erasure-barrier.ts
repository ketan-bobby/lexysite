import { dbAdmin } from "@workspace/db";
import { sql } from "drizzle-orm";

/** Missing/deleted canonical or source rows must not be used for more work. */
export async function isCandidateErased(candidateId: string): Promise<boolean> {
  const result = await dbAdmin.execute(sql`SELECT
    EXISTS(SELECT 1 FROM candidate_erasure_tombstones WHERE subject_id=${candidateId})
    OR EXISTS(SELECT 1 FROM candidates WHERE id=${candidateId} AND data_erased_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM sourced_candidates s JOIN candidates c ON c.id=s.normalized_candidate_id
      WHERE s.id=${candidateId} AND c.data_erased_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM sourced_candidates s JOIN candidate_erasure_tombstones t
      ON t.subject_id=s.normalized_candidate_id WHERE s.id=${candidateId})
    OR NOT (EXISTS(SELECT 1 FROM candidates WHERE id=${candidateId})
      OR EXISTS(SELECT 1 FROM sourced_candidates WHERE id=${candidateId})) AS blocked`);
  return result.rows[0]?.blocked !== false;
}

export async function isErasedAiWork(
  payload: unknown,
  sessionId?: string | null,
): Promise<boolean> {
  const result = await dbAdmin.execute(sql`SELECT public.lexy_erasure_job_blocked(
    ${JSON.stringify(payload ?? {})}::jsonb, ${sessionId ?? null}::text) AS blocked`);
  return result.rows[0]?.blocked !== false;
}

export function isErasureBarrierError(error: unknown): boolean {
  const e = error as { message?: string; cause?: { message?: string } };
  return e?.message === "candidate_erased" || e?.cause?.message === "candidate_erased";
}
