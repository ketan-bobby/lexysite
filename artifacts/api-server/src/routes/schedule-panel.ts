import { Router } from "express";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  dbAdmin,
  interviewSchedulesTable,
  interviewSchedulePanelsTable as panels,
  usersTable,
} from "@workspace/db";
import { SaveSchedulePanelBody } from "@workspace/api-zod";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { visibleSchedule } from "./outlook-calendar";
import { scheduleVersion, scheduleSnapshotPredicate } from "../lib/coordinator-schedule-version";
import { CalendarError } from "../lib/outlook-calendar-core";
import { storage, unavailable } from "../lib/calendar-panel-access";
import {
  assertPanelCoordinator,
  checkPanelSlot,
  lockPanelSchedule,
} from "../lib/interview-schedule-panel";
import { readSchedulePanel, savedPanelView as view } from "../lib/saved-panel-view";
import { savedPanelProvider } from "../lib/saved-panel-members";

const router = Router();
router.get("/outlook-calendar/schedules/:scheduleId/panel", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await calendarStaff(getAuthUserId(req));
    const row = await visibleSchedule(caller, String(req.params.scheduleId));
    await assertPanelCoordinator(caller, row);
    res.json(await dbAdmin.transaction((tx) => view(tx, row, caller.tenantId)));
  } catch (error) {
    respond(error, res, next);
  }
});
router.put("/outlook-calendar/schedules/:scheduleId/panel", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const input = SaveSchedulePanelBody.extend({
      scheduledAt: z.string().datetime({ offset: true }),
    })
      .strict()
      .parse(req.body);
    if (new Set(input.userIds).size !== input.userIds.length)
      throw new CalendarError(400, "invalid_panel", "Choose each panel member once.");
    const caller = await calendarStaff(getAuthUserId(req));
    const visible = await visibleSchedule(caller, String(req.params.scheduleId));
    const result = await dbAdmin.transaction(async (tx) => {
      const row = await lockPanelSchedule(tx, visible.schedule.id);
      await tx.select().from(usersTable).where(eq(usersTable.id, caller.id)).for("share");
      const currentCaller = await calendarStaff(caller.id);
      await assertPanelCoordinator(currentCaller, row);
      if (scheduleVersion(row.schedule) !== input.expectedVersion) throw unavailable();
      await storage(tx, "interview_schedule_panels");
      const saved = await readSchedulePanel(tx, row);
      if (savedPanelProvider(saved?.members ?? []) === "google")
        throw new CalendarError(
          409,
          "panel_provider_conflict",
          "Use the Google panel controls to change or remove the saved Google panel.",
        );
      if (
        !input.userIds.length &&
        (Date.parse(input.scheduledAt) !== row.schedule.scheduledAt.getTime() ||
          input.bufferMinutes !== 0)
      )
        throw new CalendarError(
          400,
          "invalid_removal",
          "Removing a panel must keep the saved time and use no buffer.",
        );
      if (Date.parse(input.scheduledAt) <= Date.now()) throw unavailable();
      const checked = input.userIds.length
        ? await checkPanelSlot(
            tx,
            currentCaller,
            row,
            input.userIds,
            input.scheduledAt,
            row.schedule.durationMinutes,
            input.bufferMinutes,
          )
        : [];
      const revision = randomUUID();
      const [schedule] = await tx
        .update(interviewSchedulesTable)
        .set({
          scheduledAt: new Date(input.scheduledAt),
          status: "pending",
          panelRevision: revision,
        })
        .where(scheduleSnapshotPredicate(row.schedule))
        .returning();
      if (!schedule) throw unavailable();
      const values = {
        scheduleId: schedule.id,
        revision,
        coordinatorId: caller.id,
        bufferMinutes: input.bufferMinutes,
        members: checked.map((p) => ({
          userId: p.member.id,
          mailboxHash: p.consent.mailboxHash,
          grantedAt: p.consent.grantedAt.toISOString(),
        })),
        savedAt: new Date(),
      };
      await tx
        .insert(panels)
        .values(values)
        .onConflictDoUpdate({ target: panels.scheduleId, set: values });
      return view(tx, { ...row, schedule }, caller.tenantId);
    });
    res.json(result);
  } catch (error) {
    respond(error, res, next);
  }
});
function respond(
  error: unknown,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  if (error instanceof z.ZodError)
    return res.status(400).json({ error: "Choose a valid panel, saved revision and future time." });
  if (error instanceof CalendarError)
    return res.status(error.status >= 500 ? 503 : error.status).json({
      code: error.status >= 500 ? "panel_unknown" : error.code,
      error:
        error.status >= 500
          ? "Panel availability could not be confirmed. Nothing was saved; your draft can be retried."
          : error.message,
    });
  return next(error);
}
export default router;
