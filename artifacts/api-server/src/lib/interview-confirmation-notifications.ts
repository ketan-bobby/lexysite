import { createHash } from "node:crypto";
import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  dbAdmin,
  applicationsTable,
  candidatesTable,
  candidateActionEventsTable,
  interviewSchedulesTable,
  jobsTable,
  userNotificationsTable,
  usersTable,
  tenantsTable,
  jobRecruitersTable,
} from "@workspace/db";
import { CandidateConfirmationError } from "./candidate-schedule-confirmation";
import { UNAPPROVED_JOB_STATUSES } from "./job-approval";
import { logger } from "./logger";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Schedule = typeof interviewSchedulesTable.$inferSelect;

/** Native confirmation, actor evidence and in-app notices commit or roll back together.
 * Public booking capabilities establish a native confirmation, not recipient identity.
 * Notifications deliberately contain no candidate identity or historical appointment.
 */
export async function recordInterviewTimeConfirmation(
  tx: Tx,
  schedule: Schedule,
  candidateId: string,
  kind: "confirmed" | "change_requested" | "change_withdrawn" = "confirmed",
) {
  const [context] = await tx
    .select({ job: jobsTable })
    .from(applicationsTable)
    .innerJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
    .innerJoin(candidatesTable, eq(candidatesTable.id, applicationsTable.candidateId))
    .where(
      and(
        eq(applicationsTable.id, schedule.applicationId),
        eq(applicationsTable.candidateId, candidateId),
        or(
          eq(applicationsTable.tenantId, schedule.tenantId),
          eq(jobsTable.tenantId, schedule.tenantId),
        ),
        isNull(candidatesTable.dataErasedAt),
        notInArray(jobsTable.status, [...UNAPPROVED_JOB_STATUSES]),
      ),
    )
    .for("share", { of: [applicationsTable, jobsTable, candidatesTable] });
  if (!context)
    throw new CandidateConfirmationError(409, "This interview changed. Reload before confirming.");
  const payload = {
    scheduleId: schedule.id,
    applicationId: schedule.applicationId,
    scheduledAt: schedule.scheduledAt.toISOString(),
  };
  // Keep event names literal so the privacy write guard can verify that this
  // shared scheduling path can never emit a recruiter-view event.
  const [event] =
    kind === "confirmed"
      ? await tx
          .insert(candidateActionEventsTable)
          .values({ candidateId, eventType: "interview_time_confirmed", payload })
          .returning({ id: candidateActionEventsTable.id })
      : kind === "change_requested"
        ? await tx
            .insert(candidateActionEventsTable)
            .values({ candidateId, eventType: "interview_time_change_requested", payload })
            .returning({ id: candidateActionEventsTable.id })
        : await tx
            .insert(candidateActionEventsTable)
            .values({ candidateId, eventType: "interview_time_change_withdrawn", payload })
            .returning({ id: candidateActionEventsTable.id });
  if (!event) throw new Error("Interview confirmation event was not persisted");

  // A candidate request's RLS context cannot stand in for recipient scope.
  // Explicit ancestry + current staffing checks run on this owner-scoped tx.
  // Never broadcast to everyone in the candidate's tenant or all platform admins.
  const result = await tx.execute<{ id: string; tenantId: string }>(sql`
    WITH RECURSIVE ancestry AS (
      SELECT id,parent_id FROM ${tenantsTable} WHERE id=${context.job.tenantId}
      UNION
      SELECT t.id,t.parent_id FROM ${tenantsTable} t
        JOIN ancestry a ON t.id=a.parent_id
    ), eligible AS (
      SELECT u.id,u.tenant_id,u.role,
        (u.id=${context.job.assignedRecruiterId} OR EXISTS(
          SELECT 1 FROM ${jobRecruitersTable} r WHERE r.job_id=${context.job.id}
            AND r.tenant_id=${context.job.tenantId} AND r.recruiter_user_id=u.id
        )) AS staffed
      FROM ${usersTable} u
      WHERE u.status='active' AND u.tenant_id IS NOT NULL
        AND (u.role='platform_admin' OR u.tenant_id IN(SELECT id FROM ancestry))
    ), designated AS (
      SELECT id,tenant_id FROM eligible
      WHERE (staffed AND role IN('recruiter','recruiter_admin','tenant_admin','platform_admin'))
        OR (id=${schedule.interviewerId} AND role IN('interviewer','hiring_manager','tenant_admin','platform_admin'))
    )
    SELECT id,tenant_id AS "tenantId" FROM designated
    UNION
    SELECT id,tenant_id AS "tenantId" FROM eligible
      WHERE role='tenant_admin' AND tenant_id=${context.job.tenantId}
        AND NOT EXISTS(SELECT 1 FROM designated d JOIN eligible e ON e.id=d.id
          WHERE e.role IN('recruiter','recruiter_admin','tenant_admin','platform_admin'))
  `);
  if (!result.rows.length) {
    logger.warn(
      { scheduleId: schedule.id },
      "Interview scheduling action without an eligible staff notification recipient",
    );
    return;
  }
  for (const recipient of result.rows) {
    const id = `interview-${kind}:${createHash("sha256")
      .update(JSON.stringify([event.id, recipient.id]))
      .digest("hex")}`;
    await tx
      .insert(userNotificationsTable)
      .values({
        id,
        tenantId: recipient.tenantId,
        userId: recipient.id,
        type:
          kind === "confirmed"
            ? "interview_time_confirmed"
            : kind === "change_requested"
              ? "interview_time_change_requested"
              : "interview_time_change_withdrawn",
        title:
          kind === "confirmed"
            ? "Interview time confirmed in Lexy"
            : kind === "change_requested"
              ? "Interview time-change requested"
              : "Interview time-change request withdrawn",
        message:
          kind === "confirmed"
            ? "Review the current interview schedule. Outlook reservation and invitation are separate staff-controlled actions."
            : kind === "change_requested"
              ? "Review the request in the coordinator. The appointment is unchanged; no calendar invitation was sent."
              : "The candidate withdrew the request. The appointment is unchanged; no calendar invitation was sent.",
        actionUrl: `/coordinator?schedule=${encodeURIComponent(schedule.id)}`,
      })
      .onConflictDoNothing({ target: userNotificationsTable.id });
  }
}
