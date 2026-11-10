/** A canonical profile assessment needs a real job-scoped source, even without a résumé. */
import {
  db,
  candidatesTable,
  sourcedCandidatesTable,
  applicationsTable,
  jobsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

/** Resolve through the authorized job, since an application's row tenant can differ. */
export async function workflowScreeningApplication(
  tenantId: string,
  jobId: string,
  candidateId: string,
) {
  const rows = await db
    .select({ id: applicationsTable.id, stage: applicationsTable.stage })
    .from(applicationsTable)
    .innerJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
    .where(
      and(
        eq(jobsTable.tenantId, tenantId),
        eq(jobsTable.id, jobId),
        eq(applicationsTable.candidateId, candidateId),
      ),
    );
  // Never move an application back from a later stage or mutate ambiguous duplicates.
  return rows.length === 1 && ["applied", "sourced", "screening"].includes(rows[0].stage)
    ? rows[0].id
    : undefined;
}

/** The stabilized screening prompt uses canonical role/skills, not a CV URL. */
export function workflowScreeningReadiness(
  candidate: Pick<typeof candidatesTable.$inferSelect, "resumeUrl" | "currentTitle" | "skills">,
) {
  const ready =
    !!candidate.currentTitle?.trim() ||
    (Array.isArray(candidate.skills) && candidate.skills.some((skill) => !!skill.trim()));
  return {
    ready,
    reason: ready
      ? null
      : candidate.resumeUrl?.trim()
        ? "A résumé is attached, but screening qualifications are not available yet. Finish résumé parsing or add the candidate’s role or skills."
        : "Add a résumé with extracted qualifications, or save the candidate’s role or skills. A name and profile link alone cannot support screening.",
  };
}

export function workflowProfileSnapshot(
  candidate: typeof candidatesTable.$inferSelect,
  previous: unknown = {},
): Record<string, unknown> {
  const saved =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {};
  return {
    ...saved,
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    currentTitle: candidate.currentTitle,
    currentCompany: candidate.currentCompany,
    location: candidate.location,
    skills: candidate.skills,
    profileOnly: true,
  };
}

export async function ensureWorkflowProfileSource(
  tenantId: string,
  jobId: string,
  candidate: typeof candidatesTable.$inferSelect,
) {
  return db.transaction(async (tx) => {
    // Different journey versions must not create duplicate pipeline cards.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow-profile:${jobId}:${candidate.id}`}, 0))`,
    );
    const [existing] = await tx
      .select()
      .from(sourcedCandidatesTable)
      .where(
        and(
          eq(sourcedCandidatesTable.tenantId, tenantId),
          eq(sourcedCandidatesTable.normalizedCandidateId, candidate.id),
          sql`${sourcedCandidatesTable.rawData}->>'jobId' = ${jobId}`,
        ),
      );
    if (existing) {
      const [updated] = await tx
        .update(sourcedCandidatesTable)
        .set({
          rawData: workflowProfileSnapshot(candidate, existing.rawData),
        })
        .where(
          and(
            eq(sourcedCandidatesTable.id, existing.id),
            eq(sourcedCandidatesTable.tenantId, tenantId),
            eq(sourcedCandidatesTable.normalizedCandidateId, candidate.id),
            sql`${sourcedCandidatesTable.rawData}->>'jobId' = ${jobId}`,
          ),
        )
        .returning();
      return updated;
    }
    const [created] = await tx
      .insert(sourcedCandidatesTable)
      .values({
        tenantId,
        normalizedCandidateId: candidate.id,
        source: "internal",
        rawData: workflowProfileSnapshot(candidate, {
          jobId,
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          currentTitle: candidate.currentTitle,
          currentCompany: candidate.currentCompany,
          location: candidate.location,
          skills: candidate.skills,
          stage: "sourced",
          profileOnly: true,
          // No résumé, external-provider or completed-grade claims.
        }),
      })
      .returning();
    return created;
  });
}
