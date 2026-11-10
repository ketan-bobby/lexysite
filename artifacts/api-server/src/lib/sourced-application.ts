import { db, applicationsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { originFields, type OriginChannel } from "./sourcing-origin";

/**
 * Ensure a candidate has one sourced-stage application for this exact job.
 * A candidate may have one global sourced_candidates cache row but must be
 * linked independently to every requisition that sourced or rediscovered them.
 */
export async function ensureSourcedApplication(params: {
  tenantId: string;
  jobId: string;
  candidateId: string;
  channel: Extract<OriginChannel, "ai_sourcing" | "internal_mobility" | "known_talent_rediscovery">;
  evidence: Record<string, unknown>;
  setBy: string;
  matchScore?: number | null;
  dbc?: typeof db;
}): Promise<boolean> {
  const dbc = params.dbc ?? db;
  return dbc.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${params.jobId}), hashtext(${params.candidateId}))`,
    );
    const [existing] = await tx
      .select({ id: applicationsTable.id })
      .from(applicationsTable)
      .where(
        and(
          eq(applicationsTable.candidateId, params.candidateId),
          eq(applicationsTable.jobId, params.jobId),
        ),
      )
      .limit(1);
    if (existing) return false;

    await tx.insert(applicationsTable).values({
      tenantId: params.tenantId,
      jobId: params.jobId,
      candidateId: params.candidateId,
      stage: "sourced",
      matchScore: params.matchScore ?? null,
      ...originFields(params.channel, params.evidence, params.setBy),
    } as any);
    return true;
  });
}
