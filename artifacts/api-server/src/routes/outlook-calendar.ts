import { Router, type IRouter } from "express";
import {
  db,
  dbAdmin,
  interviewSchedulesTable,
  applicationsTable,
  jobsTable,
  candidatesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { isJobApproved } from "../lib/job-approval-gate";
import { outlookCalendarRequest } from "../lib/outlook-calendar";
import {
  CalendarError,
  calendarEvents,
  calendarWindow,
  eventView,
  linkedCalendarEvent,
  scheduleBinding,
  utcInstant,
} from "../lib/outlook-calendar-core";
import { logger } from "../lib/logger";
import { compliantCandidatePredicate } from "../lib/compliance-scope";
import { calendarScheduleVisible } from "../lib/outlook-calendar-core";
import {
  applyCalendarAction,
  assertCalendarScheduleCurrent,
} from "../lib/outlook-calendar-operation";
import { scheduleVersion, scheduleSnapshotPredicate } from "../lib/coordinator-schedule-version";
import { assertSavedPanel } from "../lib/interview-schedule-panel";

const router: IRouter = Router();
const windowInput = z.object({
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
});
const actionInput = z
  .object({
    action: z.enum(["create", "update", "pull", "cancel"]),
    confirm: z.literal(true),
    expectedScheduledAt: z.iso.datetime({ offset: true }),
    expectedVersion: z
      .string()
      .regex(/^v1_[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

router.use("/outlook-calendar", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.locals.calendarCaller = await calendarStaff(getAuthUserId(req));
    next();
  } catch (error) {
    if (error instanceof CalendarError)
      res.status(error.status).json({ error: error.message, code: error.code });
    else next(error);
  }
});

router.get("/outlook-calendar/availability", async (req, res, next) => {
  try {
    const input = windowInput.parse(req.query);
    const window = calendarWindow(input.start, input.end);
    const request = await outlookCalendarRequest(res.locals.calendarCaller.id);
    const events = await calendarEvents(request, window.start, window.end);
    // Return availability, never subjects, bodies, guests, or private-event names.
    const busy = events
      .filter((event) => !event.isCancelled && event.showAs !== "free")
      .map((event) => ({ start: utcInstant(event.start), end: utcInstant(event.end) }));
    res.json({ ...window, busy });
  } catch (error) {
    next(error);
  }
});

export async function visibleSchedule(
  caller: Awaited<ReturnType<typeof calendarStaff>>,
  scheduleId: string,
  cleanup = false,
) {
  const [row] = await db
    .select({
      schedule: interviewSchedulesTable,
      application: applicationsTable,
      job: jobsTable,
      candidate: candidatesTable,
    })
    .from(interviewSchedulesTable)
    .innerJoin(applicationsTable, eq(applicationsTable.id, interviewSchedulesTable.applicationId))
    .innerJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
    .innerJoin(candidatesTable, eq(candidatesTable.id, applicationsTable.candidateId))
    .where(
      and(
        eq(interviewSchedulesTable.id, scheduleId),
        eq(interviewSchedulesTable.tenantId, applicationsTable.tenantId),
        cleanup ? undefined : compliantCandidatePredicate(),
      ),
    )
    .limit(1);
  if (!row) throw new CalendarError(404, "schedule_not_found", "Schedule not found.");
  const allowed = await getDataScopeTenantIds(caller);
  if (
    !calendarScheduleVisible({
      callerId: caller.id,
      role: caller.role,
      allowedTenantIds: allowed,
      ownsJob: await recruiterOwnsResource(caller, { kind: "jobId", value: row.job.id }),
      jobTenantId: row.job.tenantId,
      applicationTenantId: row.application.tenantId,
      scheduleTenantId: row.schedule.tenantId,
      interviewerId: row.schedule.interviewerId,
    })
  ) {
    throw new CalendarError(
      404,
      "schedule_not_found",
      "Schedule not found or assigned to a different interviewer.",
    );
  }
  return row;
}

router.get("/outlook-calendar/schedules/:scheduleId", async (req, res, next) => {
  try {
    const caller = res.locals.calendarCaller as Awaited<ReturnType<typeof calendarStaff>>;
    const { schedule } = await visibleSchedule(caller, req.params.scheduleId);
    const request = await outlookCalendarRequest(caller.id);
    const event = await linkedCalendarEvent(
      request,
      scheduleBinding(schedule.tenantId, schedule.id),
    );
    res.json({ event: eventView(event), scheduleVersion: scheduleVersion(schedule) });
  } catch (error) {
    next(error);
  }
});

router.post("/outlook-calendar/schedules/:scheduleId", async (req, res, next) => {
  try {
    const input = actionInput.parse(req.body);
    const caller = res.locals.calendarCaller as Awaited<ReturnType<typeof calendarStaff>>;
    const { schedule, job } = await visibleSchedule(
      caller,
      req.params.scheduleId,
      input.action === "cancel",
    );
    // Reject stale views before resolving tokens or making any Graph request.
    assertCalendarScheduleCurrent(input, schedule);
    const request = await outlookCalendarRequest(caller.id);
    const receipt = await applyCalendarAction(
      input,
      {
        callerId: caller.id,
        schedule,
        jobTitle: job.title,
        jobApproved: isJobApproved(job.status),
      },
      request,
      async (changes) => {
        if (schedule.panelRevision && changes.scheduledAt) {
          return dbAdmin.transaction(async (tx) => {
            await assertSavedPanel(
              tx,
              schedule,
              changes.scheduledAt!.toISOString(),
              changes.durationMinutes ?? schedule.durationMinutes,
            );
            const [updated] = await tx
              .update(interviewSchedulesTable)
              .set({ ...changes, status: "pending" })
              .where(scheduleSnapshotPredicate(schedule))
              .returning({ id: interviewSchedulesTable.id });
            return Boolean(updated);
          });
        }
        const [updated] = await db
          .update(interviewSchedulesTable)
          .set(changes)
          .where(scheduleSnapshotPredicate(schedule))
          .returning({ id: interviewSchedulesTable.id });
        return Boolean(updated);
      },
    );
    logger.info(
      {
        userId: caller.id,
        scheduleId: schedule.id,
        action: input.action,
        nativeChanged: receipt.nativeChanged,
        remoteChanged: receipt.remoteChanged,
      },
      "[calendar] human calendar action completed",
    );
    res.json(receipt);
  } catch (error) {
    next(error);
  }
});

router.use(
  "/outlook-calendar",
  (
    error: unknown,
    _req: unknown,
    res: import("express").Response,
    next: import("express").NextFunction,
  ) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid calendar input.", code: "invalid_input" });
      return;
    }
    if (error instanceof CalendarError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    next(error);
  },
);

export default router;
