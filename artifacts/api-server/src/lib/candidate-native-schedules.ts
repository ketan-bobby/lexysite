import {
  dbAdmin,
  applicationsTable,
  candidatesTable,
  interviewSchedulesTable,
  jobsTable,
} from "@workspace/db";
import { and, desc, eq, isNull, ne, or } from "drizzle-orm";
import {
  assertCandidateTimeConfirmation,
  candidateTimeVersion,
  CandidateConfirmationError,
} from "./candidate-schedule-confirmation";

/**
 * Candidate self-service may cross portal/agency/employer tenants. The
 * administrative connection is deliberate: every row must join through the
 * canonical candidate's own application, not their portal tenant membership.
 */
export async function listCandidateNativeSchedules(candidateId: string) {
  const rows = await dbAdmin
    .select({
      schedule: interviewSchedulesTable,
      jobTitle: jobsTable.title,
      jobStatus: jobsTable.status,
      department: jobsTable.department,
      location: jobsTable.location,
    })
    .from(interviewSchedulesTable)
    .innerJoin(applicationsTable, eq(applicationsTable.id, interviewSchedulesTable.applicationId))
    .innerJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
    .innerJoin(candidatesTable, eq(candidatesTable.id, applicationsTable.candidateId))
    .where(
      and(
        eq(applicationsTable.candidateId, candidateId),
        isNull(candidatesTable.dataErasedAt),
        ne(interviewSchedulesTable.status, "cancelled"),
        or(
          eq(interviewSchedulesTable.tenantId, applicationsTable.tenantId),
          eq(interviewSchedulesTable.tenantId, jobsTable.tenantId),
        ),
      ),
    )
    .orderBy(desc(interviewSchedulesTable.scheduledAt));
  return rows.map(({ schedule, jobStatus, ...job }) => {
    let confirmationVersion: string | null = null;
    const version = candidateTimeVersion(schedule);
    try {
      assertCandidateTimeConfirmation(schedule, version, jobStatus);
      confirmationVersion = version;
    } catch (error) {
      if (!(error instanceof CandidateConfirmationError)) throw error;
    }
    // Never serialize staff notes/feedback or their staff-only content digest.
    return {
      id: schedule.id,
      jobTitle: job.jobTitle,
      department: job.department,
      location: job.location,
      type: schedule.type,
      status: schedule.status,
      scheduledAt: schedule.scheduledAt.toISOString(),
      duration: schedule.durationMinutes,
      score: null,
      feedback: null,
      source: "schedule" as const,
      confirmationVersion,
    };
  });
}
