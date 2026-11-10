import { Router } from "express";
import { assertPanelConfirmation } from "../lib/interview-schedule-panel";
import { recordInterviewTimeConfirmation } from "../lib/interview-confirmation-notifications";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  dbAdmin,
  applicationsTable,
  candidatesTable,
  jobsTable,
  interviewSchedulesTable,
  interviewOfferedTimesTable,
} from "@workspace/db";
import { PublishStaffOfferedTimesBody, ChooseCandidateOfferedTimeBody } from "@workspace/api-zod";
import { z } from "zod";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { resolveCandidateId } from "../lib/portal-auth";
import { compliantCandidatePredicate } from "../lib/compliance-scope";
import { CalendarError } from "../lib/outlook-calendar-core";
import {
  assertCandidateTimeConfirmation,
  candidateTimeVersion,
  CandidateConfirmationError,
} from "../lib/candidate-schedule-confirmation";
import { scheduleVersion, scheduleSnapshotPredicate } from "../lib/coordinator-schedule-version";
import { makeOfferedTimes, offeredTimesView } from "../lib/interview-offered-times";
import { offeredTimesSchemaUnavailable } from "../lib/offered-times-errors";
import { logger } from "../lib/logger";

const router = Router();
const publishInput = PublishStaffOfferedTimesBody.extend({
  alternatives: z.array(z.string().datetime({ offset: true })).max(4),
}).strict();
const choiceInput = ChooseCandidateOfferedTimeBody.extend({
  confirm: z.literal(true),
  scheduledAt: z.string().datetime({ offset: true }),
}).strict();
type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Staff = Awaited<ReturnType<typeof calendarStaff>>;

export async function ownedSchedule(
  tx: Tx,
  scheduleId: string,
  owner: string | Staff,
  lock: boolean,
  requirePending = true,
) {
  const candidateId = typeof owner === "string" ? owner : null;
  const staff = typeof owner === "string" ? null : owner;
  const allowed = staff ? await getDataScopeTenantIds(staff) : null;
  const query = tx
    .select({
      schedule: interviewSchedulesTable,
      candidateId: applicationsTable.candidateId,
      jobId: jobsTable.id,
      jobStatus: jobsTable.status,
    })
    .from(interviewSchedulesTable)
    .innerJoin(applicationsTable, eq(applicationsTable.id, interviewSchedulesTable.applicationId))
    .innerJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
    .innerJoin(candidatesTable, eq(candidatesTable.id, applicationsTable.candidateId))
    .where(
      and(
        eq(interviewSchedulesTable.id, scheduleId),
        isNull(candidatesTable.dataErasedAt),
        or(
          eq(interviewSchedulesTable.tenantId, applicationsTable.tenantId),
          eq(interviewSchedulesTable.tenantId, jobsTable.tenantId),
        ),
        candidateId ? eq(applicationsTable.candidateId, candidateId) : undefined,
        staff ? compliantCandidatePredicate() : undefined,
        staff && allowed !== null ? inArray(jobsTable.tenantId, allowed) : undefined,
        staff?.role === "recruiter"
          ? inArray(jobsTable.id, await getRecruiterAssignedJobIds(staff))
          : undefined,
        staff?.role === "hiring_manager"
          ? eq(jobsTable.assignedHiringManagerId, staff.id)
          : undefined,
        staff?.role === "interviewer"
          ? eq(interviewSchedulesTable.interviewerId, staff.id)
          : undefined,
      ),
    )
    .limit(1);
  // Both publication and selection lock the schedule first, then the offer.
  let [row] = lock ? await query.for("update", { of: interviewSchedulesTable }) : await query;
  if (!row) throw new CandidateConfirmationError(404, "Interview schedule not found.");
  if (lock) {
    // Fence late writes after erasure, application reassignment or withdrawal
    // of job approval. Re-read authorization after any lock wait.
    await tx
      .select({ id: candidatesTable.id })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, row.candidateId))
      .for("share");
    await tx
      .select({ id: applicationsTable.id })
      .from(applicationsTable)
      .where(eq(applicationsTable.id, row.schedule.applicationId))
      .for("share");
    await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(eq(jobsTable.id, row.jobId))
      .for("share");
    [row] = await query;
    if (!row) throw new CandidateConfirmationError(404, "Interview schedule not found.");
  }
  const nowResult = await tx.execute(sql`SELECT clock_timestamp() AS now`);
  const now = new Date(nowResult.rows[0].now as string | Date).getTime();
  if (requirePending)
    assertCandidateTimeConfirmation(
      row.schedule,
      candidateTimeVersion(row.schedule),
      row.jobStatus,
      now,
    );
  return { ...row, now };
}

export async function readOffer(tx: Tx, scheduleId: string) {
  const [offer] = await tx
    .select()
    .from(interviewOfferedTimesTable)
    .where(eq(interviewOfferedTimesTable.scheduleId, scheduleId));
  return offer;
}

const staffPath = "/coordinator/schedules/:scheduleId/offered-times";
const candidatePath = "/portal/interview-schedules/:scheduleId/offered-times";

router.get(staffPath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await calendarStaff(getAuthUserId(req));
    const result = await dbAdmin.transaction(async (tx) => {
      const row = await ownedSchedule(tx, String(req.params.scheduleId), caller, false);
      return {
        version: scheduleVersion(row.schedule),
        proposal: offeredTimesView(
          row.schedule,
          row.candidateId,
          row.schedule.applicationId,
          await readOffer(tx, row.schedule.id),
          row.now,
        ),
      };
    });
    res.json(result);
  } catch (error) {
    handleError(error, res, next);
  }
});

router.put(staffPath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await calendarStaff(getAuthUserId(req));
    const parsed = publishInput.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Provide a current revision and up to four alternative times." });
      return;
    }
    const input = parsed.data;
    const result = await dbAdmin.transaction(async (tx) => {
      const row = await ownedSchedule(tx, String(req.params.scheduleId), caller, true);
      const old = await readOffer(tx, row.schedule.id);
      const displayed = offeredTimesView(
        row.schedule,
        row.candidateId,
        row.schedule.applicationId,
        old,
        row.now,
      );
      if (
        scheduleVersion(row.schedule) !== input.expectedVersion ||
        displayed.offerVersion !== input.expectedOfferVersion
      )
        throw new CandidateConfirmationError(
          409,
          "The schedule or offered times changed. Reload before publishing.",
        );
      let offer;
      try {
        offer = makeOfferedTimes(
          row.schedule,
          row.candidateId,
          row.schedule.applicationId,
          input.alternatives,
          row.now,
        );
      } catch (error) {
        throw new CandidateConfirmationError(
          400,
          error instanceof Error ? error.message : "Invalid alternatives.",
        );
      }
      if (!input.alternatives.length) {
        await tx
          .delete(interviewOfferedTimesTable)
          .where(eq(interviewOfferedTimesTable.scheduleId, row.schedule.id));
      } else {
        await tx.insert(interviewOfferedTimesTable).values(offer).onConflictDoUpdate({
          target: interviewOfferedTimesTable.scheduleId,
          set: offer,
        });
      }
      return {
        version: scheduleVersion(row.schedule),
        proposal: offeredTimesView(
          row.schedule,
          row.candidateId,
          row.schedule.applicationId,
          input.alternatives.length ? offer : undefined,
          row.now,
        ),
      };
    });
    res.json(result);
  } catch (error) {
    handleError(error, res, next);
  }
});

router.get(candidatePath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const candidateId = await resolveCandidateId(req);
    if (!candidateId) {
      res.status(401).json({ error: "Candidate sign-in required." });
      return;
    }
    const result = await dbAdmin.transaction(async (tx) => {
      const row = await ownedSchedule(tx, String(req.params.scheduleId), candidateId, false);
      return offeredTimesView(
        row.schedule,
        candidateId,
        row.schedule.applicationId,
        await readOffer(tx, row.schedule.id),
        row.now,
      );
    });
    res.json(result);
  } catch (error) {
    handleError(error, res, next);
  }
});

router.post(candidatePath, async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const candidateId = await resolveCandidateId(req);
    if (!candidateId) {
      res.status(401).json({ error: "Candidate sign-in required." });
      return;
    }
    const parsed = choiceInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Confirm one displayed offered time." });
      return;
    }
    const input = parsed.data;
    const result = await dbAdmin.transaction((tx) =>
      chooseOfferedTime(tx, String(req.params.scheduleId), candidateId, input),
    );
    res.json(result);
  } catch (error) {
    handleError(error, res, next);
  }
});

export async function chooseOfferedTime(
  tx: Tx,
  scheduleId: string,
  candidateId: string,
  input: { expectedVersion: string; expectedOfferVersion: string | null; scheduledAt: string },
  beforeSave?: (
    current: Awaited<ReturnType<typeof ownedSchedule>>,
    selected: string,
  ) => Promise<void>,
) {
  const row = await ownedSchedule(tx, scheduleId, candidateId, true);
  const view = offeredTimesView(
    row.schedule,
    candidateId,
    row.schedule.applicationId,
    await readOffer(tx, row.schedule.id),
    row.now,
  );
  const selected = new Date(input.scheduledAt).toISOString();
  if (
    view.version !== input.expectedVersion ||
    view.offerVersion !== input.expectedOfferVersion ||
    !view.startsAt.includes(selected)
  )
    throw new CandidateConfirmationError(
      409,
      "These offered times changed or expired. Reload before choosing.",
    );
  // Re-read the database clock after acquiring all authorization locks.
  const current = await ownedSchedule(tx, row.schedule.id, candidateId, false);
  if (
    current.now >= Date.parse(selected) ||
    (view.expiresAt && current.now >= Date.parse(view.expiresAt))
  )
    throw new CandidateConfirmationError(409, "This offered time expired. Reload before choosing.");
  await beforeSave?.(current, selected);
  await assertPanelConfirmation(tx, current.schedule, selected);
  const [saved] = await tx
    .update(interviewSchedulesTable)
    .set({ scheduledAt: new Date(selected), status: "confirmed" })
    .where(
      and(
        scheduleSnapshotPredicate(current.schedule),
        sql`${new Date(selected)}::timestamptz > clock_timestamp()`,
        view.expiresAt
          ? sql`${new Date(view.expiresAt)}::timestamptz > clock_timestamp()`
          : undefined,
      ),
    )
    .returning();
  if (!saved)
    throw new CandidateConfirmationError(409, "This schedule changed. Reload before choosing.");
  await recordInterviewTimeConfirmation(tx, saved, candidateId);
  await tx
    .delete(interviewOfferedTimesTable)
    .where(eq(interviewOfferedTimesTable.scheduleId, saved.id));
  return {
    scheduleId: saved.id,
    status: "confirmed" as const,
    scheduledAt: saved.scheduledAt.toISOString(),
    durationMinutes: saved.durationMinutes,
    version: candidateTimeVersion(saved),
    calendarReserved: false as const,
    invitationSent: false as const,
  };
}

export function handleError(
  error: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (error instanceof CandidateConfirmationError || error instanceof CalendarError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (offeredTimesSchemaUnavailable(error)) {
    // Do not leak raw SQL, record identifiers or migration internals to callers.
    logger.warn(
      { code: "offered_times_unavailable" },
      "Interview offered-times schema needs rollout verification",
    );
    res.status(503).json({
      code: "offered_times_unavailable",
      error:
        "Interview time choices are temporarily unavailable. Please try again later or contact your recruiter.",
    });
    return;
  }
  next(error);
}

export default router;
