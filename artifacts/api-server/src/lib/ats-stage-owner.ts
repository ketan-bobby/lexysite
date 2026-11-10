import { and, eq, sql } from "drizzle-orm";
import { db, recruitingWorkflowsTable as workflows } from "@workspace/db";

type Handle = Pick<typeof db, "select" | "execute">;
export class AtsStageOwnershipConflict extends Error {
  readonly status = 409;
  readonly code = "ATS_STAGE_OWNED";
  constructor() {
    super(
      "The employer has assigned hiring-stage control to its ATS. Change the stage there, or ask the employer administrator to explicitly return control to Lexy.",
    );
  }
}

/** Shared before job/row locks by both declarations and native transitions. */
export async function lockAtsStageOwner(
  h: Pick<typeof db, "execute">,
  candidateId: string,
  jobId: string,
) {
  await h.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(${jobId}::text,${candidateId}::text)::text,78123))`,
  );
}

export async function externalStageOwner(h: Handle, candidateId: string, jobId: string) {
  const [row] = await h
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.candidateId, candidateId),
        eq(workflows.jobId, jobId),
        sql`${workflows.steps} @> '[{"key":"hiring_decision","atsStageOwnership":{"status":"external"}}]'::jsonb`,
      ),
    )
    .limit(1);
  return row;
}

export async function assertNativeStageOwner(h: Handle, candidateId: string, jobId: string) {
  // Ordinary stage writes run as lexy_app; private workflow rows are admin-only.
  // Expose only the ownership predicate, never grant direct workflow reads.
  const result = await h.execute(
    sql`SELECT public.ats_stage_is_external(${candidateId},${jobId}) AS owned`,
  );
  if (result.rows[0]?.owned === true) throw new AtsStageOwnershipConflict();
}
