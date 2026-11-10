import { Router } from "express";
import { and, eq, exists, gt, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  dbAdmin,
  applicationsTable,
  candidatesTable,
  interviewSchedulesTable,
  jobsTable,
} from "@workspace/db";
import { z } from "zod/v4";
import { resolveCandidateId } from "../lib/portal-auth";
import { scheduleSnapshotPredicate } from "../lib/coordinator-schedule-version";
import { UNAPPROVED_JOB_STATUSES } from "../lib/job-approval";
import { recordInterviewTimeConfirmation } from "../lib/interview-confirmation-notifications";
import { assertPanelConfirmation } from "../lib/interview-schedule-panel";
import {
  assertCandidateTimeConfirmation,
  candidateTimeVersion,
  CandidateConfirmationError,
} from "../lib/candidate-schedule-confirmation";

const router = Router();
const input = z
  .object({
    confirm: z.literal(true),
    expectedVersion: z.string().regex(/^v1_[0-9a-f]{64}$/),
  })
  .strict();

router.post("/portal/interview-schedules/:scheduleId/confirmation", async (req, res, next) => {
  try {
    const candidateId = await resolveCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Candidate sign-in required." });
    const parsed = input.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "Confirm the displayed proposed time." });
    const scheduleId = String(req.params.scheduleId);
    // Portal and employer tenants differ. Administrative access is limited by
    // the candidate-owned application predicates in BOTH the read and write.
    const result = await dbAdmin.transaction(async (tx) => {
      // Candidate self-ownership is independent of employer tenant membership.
      const [row] = await tx
        .select({ schedule: interviewSchedulesTable, jobStatus: jobsTable.status })
        .from(interviewSchedulesTable)
        .innerJoin(
          applicationsTable,
          eq(applicationsTable.id, interviewSchedulesTable.applicationId),
        )
        .innerJoin(
          jobsTable,
          and(
            eq(jobsTable.id, applicationsTable.jobId),
            or(
              eq(jobsTable.tenantId, interviewSchedulesTable.tenantId),
              eq(applicationsTable.tenantId, interviewSchedulesTable.tenantId),
            ),
          ),
        )
        .innerJoin(candidatesTable, eq(candidatesTable.id, applicationsTable.candidateId))
        .where(
          and(
            eq(interviewSchedulesTable.id, scheduleId),
            eq(applicationsTable.candidateId, candidateId),
            isNull(candidatesTable.dataErasedAt),
          ),
        )
        .limit(1);
      if (!row) throw new CandidateConfirmationError(404, "Interview schedule not found.");
      assertCandidateTimeConfirmation(row.schedule, parsed.data.expectedVersion, row.jobStatus);
      await assertPanelConfirmation(tx, row.schedule);
      const stillOwned = tx
        .select({ id: applicationsTable.id })
        .from(applicationsTable)
        .innerJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
        .innerJoin(candidatesTable, eq(candidatesTable.id, applicationsTable.candidateId))
        .where(
          and(
            eq(applicationsTable.id, interviewSchedulesTable.applicationId),
            eq(applicationsTable.candidateId, candidateId),
            or(
              eq(jobsTable.tenantId, interviewSchedulesTable.tenantId),
              eq(applicationsTable.tenantId, interviewSchedulesTable.tenantId),
            ),
            notInArray(jobsTable.status, [...UNAPPROVED_JOB_STATUSES]),
            isNull(candidatesTable.dataErasedAt),
          ),
        );
      const [saved] = await tx
        .update(interviewSchedulesTable)
        .set({ status: "confirmed" })
        .where(
          and(
            scheduleSnapshotPredicate(row.schedule),
            gt(interviewSchedulesTable.scheduledAt, sql`clock_timestamp()`),
            exists(stillOwned),
          ),
        )
        .returning();
      if (!saved)
        throw new CandidateConfirmationError(
          409,
          "This proposed time changed. Reload your interviews before trying again.",
        );
      await recordInterviewTimeConfirmation(tx, saved, candidateId);
      return {
        scheduleId: saved.id,
        status: "confirmed" as const,
        scheduledAt: saved.scheduledAt.toISOString(),
        durationMinutes: saved.durationMinutes,
        version: candidateTimeVersion(saved),
        calendarReserved: false as const,
        invitationSent: false as const,
      };
    });
    return res.json(result);
  } catch (error) {
    if (error instanceof CandidateConfirmationError)
      return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});
export default router;
