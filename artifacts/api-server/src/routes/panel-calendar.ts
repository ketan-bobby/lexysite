import { Router, type Response, type NextFunction } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  dbAdmin,
  calendarPanelConsentsTable as consents,
  usersTable,
  interviewSchedulesTable,
  applicationsTable,
  jobsTable,
  candidatesTable,
} from "@workspace/db";
import { FindSchedulePanelTimesBody, SetPanelCalendarConsentBody } from "@workspace/api-zod";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { visibleSchedule } from "./outlook-calendar";
import { scheduleVersion } from "../lib/coordinator-schedule-version";
import { isJobApproved } from "../lib/job-approval-gate";
import { outlookCalendarRequest } from "../lib/outlook-calendar";
import { CalendarError } from "../lib/outlook-calendar-core";
import { commonPanelSlots } from "../lib/panel-calendar-slots";
import {
  storage,
  members,
  memberAllowed,
  mailboxHash,
  unavailable,
  panelCalendars,
} from "../lib/calendar-panel-access";

const router = Router();
type Caller = Awaited<ReturnType<typeof calendarStaff>>;
async function coordinator(userId: string | null) {
  const caller = await calendarStaff(userId);
  if (caller.role === "interviewer")
    throw new CalendarError(
      403,
      "coordinator_required",
      "Panel searches require authorised coordinating staff.",
    );
  return caller;
}
async function schedule(caller: Caller, id: string) {
  const row = await visibleSchedule(caller, id);
  if (
    !isJobApproved(row.job.status) ||
    row.schedule.type === "ai_interview" ||
    !["pending", "scheduled", "rescheduled", "confirmed"].includes(row.schedule.status) ||
    row.schedule.scheduledAt.getTime() <= Date.now()
  )
    throw new CalendarError(
      404,
      "schedule_not_found",
      "An upcoming authorised human interview is required.",
    );
  return row;
}
function fail(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      code: "invalid_input",
      error: "Provide a valid panel, time window and explicit consent choice.",
    });
    return;
  }
  if (error instanceof CalendarError) {
    if (error.status >= 500 || error.status === 429) {
      res.status(503).json({
        code: "panel_unknown",
        error:
          "One or more calendars could not be checked. Availability is unknown; no common times can be confirmed.",
      });
    } else res.status(error.status).json({ code: error.code, error: error.message });
    return;
  }
  next(error);
}
router.get("/outlook-calendar/panel-consent", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await calendarStaff(getAuthUserId(req));
    const result = await dbAdmin.transaction(async (tx) => {
      await storage(tx);
      const [consent] = await tx
        .select()
        .from(consents)
        .where(and(eq(consents.userId, caller.id), eq(consents.tenantId, caller.tenantId!)));
      return { enabled: !!consent, grantedAt: consent?.grantedAt.toISOString() ?? null };
    });
    res.json(result);
  } catch (error) {
    fail(error, res, next);
  }
});
router.post("/outlook-calendar/panel-consent", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const input = SetPanelCalendarConsentBody.strict().parse(req.body);
    const caller = await calendarStaff(getAuthUserId(req));
    await dbAdmin.transaction((tx) => storage(tx));
    if (!input.enabled) {
      await dbAdmin.delete(consents).where(eq(consents.userId, caller.id));
      res.json({ enabled: false, grantedAt: null });
      return;
    }
    if (!caller.tenantId) throw unavailable();
    const graph = await outlookCalendarRequest(caller.id);
    const mailbox = await graph<{ id: string }>("/me?$select=id");
    if (!mailbox?.id) throw unavailable();
    const result = await dbAdmin.transaction(async (tx) => {
      // Freeze identity/tenant during the grant; suspended staff cannot opt in.
      const [current] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, caller.id))
        .for("share");
      if (
        !current ||
        current.status !== "active" ||
        current.tenantId !== caller.tenantId ||
        current.role !== caller.role
      )
        throw unavailable();
      const [consent] = await tx
        .insert(consents)
        .values({
          userId: current.id,
          tenantId: current.tenantId!,
          mailboxHash: mailboxHash(mailbox.id),
          grantedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: consents.userId,
          set: {
            tenantId: current.tenantId!,
            mailboxHash: mailboxHash(mailbox.id),
            grantedAt: new Date(),
          },
        })
        .returning();
      return consent;
    });
    res.json({ enabled: true, grantedAt: result.grantedAt.toISOString() });
  } catch (error) {
    fail(error, res, next);
  }
});
router.get("/outlook-calendar/schedules/:scheduleId/panel-members", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await coordinator(getAuthUserId(req));
    const row = await schedule(caller, String(req.params.scheduleId));
    const result = await dbAdmin.transaction(async (tx) => {
      await storage(tx);
      return members(caller, row, tx);
    });
    res.json({
      scheduleId: row.schedule.id,
      version: scheduleVersion(row.schedule),
      members: result.map((r) => ({ id: r.member.id, name: r.member.name || "Staff member" })),
    });
  } catch (error) {
    fail(error, res, next);
  }
});
router.post("/outlook-calendar/schedules/:scheduleId/panel-times", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const input = FindSchedulePanelTimesBody.extend({
      start: z.string().datetime({ offset: true }),
      end: z.string().datetime({ offset: true }),
    })
      .strict()
      .parse(req.body);
    if (new Set(input.userIds).size !== input.userIds.length)
      throw new CalendarError(400, "invalid_panel", "Choose each panel member once.");
    const caller = await coordinator(getAuthUserId(req));
    const row = await schedule(caller, String(req.params.scheduleId));
    if (scheduleVersion(row.schedule) !== input.expectedVersion) throw unavailable();
    // Validate range before resolving any calendar token or querying Graph.
    commonPanelSlots([[]], { ...input, durationMinutes: row.schedule.durationMinutes });
    const result = await dbAdmin.transaction(async (tx) => {
      await storage(tx);
      await tx
        .select()
        .from(interviewSchedulesTable)
        .where(eq(interviewSchedulesTable.id, row.schedule.id))
        .for("share");
      await tx
        .select()
        .from(applicationsTable)
        .where(eq(applicationsTable.id, row.application.id))
        .for("share");
      await tx.select().from(jobsTable).where(eq(jobsTable.id, row.job.id)).for("share");
      await tx
        .select()
        .from(candidatesTable)
        .where(eq(candidatesTable.id, row.candidate.id))
        .for("share");
      const current = await schedule(caller, row.schedule.id);
      if (scheduleVersion(current.schedule) !== input.expectedVersion) throw unavailable();
      // Shared row locks serialize consent revocation and staff-status changes
      // against the bounded provider read. Never return partial-panel success.
      const panel = await members(caller, current, tx, input.userIds);
      if (panel.length !== input.userIds.length) throw unavailable();
      const availability = await panelCalendars(
        tx,
        panel,
        input.start,
        input.end,
        input.bufferMinutes,
      );
      const latest = await schedule(caller, current.schedule.id);
      if (scheduleVersion(latest.schedule) !== input.expectedVersion) throw unavailable();
      for (const { member } of panel)
        if (!(await memberAllowed(member, latest))) throw unavailable();
      return {
        scheduleId: current.schedule.id,
        version: input.expectedVersion,
        checkedAt: new Date().toISOString(),
        panelSize: panel.length,
        durationMinutes: current.schedule.durationMinutes,
        slots: commonPanelSlots(
          availability.calendars,
          { ...input, durationMinutes: current.schedule.durationMinutes },
          undefined,
          availability.allows,
        ),
      };
    });
    res.json(result);
  } catch (error) {
    fail(error, res, next);
  }
});
export default router;
