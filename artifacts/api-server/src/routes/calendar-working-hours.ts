import { randomUUID } from "node:crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { dbAdmin, usersTable, calendarWorkingHoursTable as hours } from "@workspace/db";
import { SaveCalendarWorkingHoursBody } from "@workspace/api-zod";
import { calendarStaff } from "../lib/calendar-staff";
import { getAuthUserId } from "../lib/auth-token";
import { CalendarError } from "../lib/outlook-calendar-core";
import { storage } from "../lib/calendar-panel-access";
import { workingHoursPolicy } from "../lib/calendar-working-hours";

const router = Router();
async function preferences(
  userId: string | null,
  input?: z.infer<typeof SaveCalendarWorkingHoursBody>,
) {
  const caller = await calendarStaff(userId);
  return dbAdmin.transaction(async (tx) => {
    await storage(tx, "calendar_working_hours");
    // Serialize even first creation against panel checks' shared user locks.
    const [current] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, caller.id))
      .for(input ? "update" : "share");
    if (
      !current ||
      current.status !== "active" ||
      current.role !== caller.role ||
      current.tenantId !== caller.tenantId
    )
      throw new CalendarError(
        409,
        "staff_changed",
        "Your staff access changed. Reload before continuing.",
      );
    const [row] = await tx.select().from(hours).where(eq(hours.userId, current.id)).for("share");
    if (row && !z.string().uuid().safeParse(row.revision).success)
      throw new CalendarError(
        503,
        "working_hours_unknown",
        "Working-hour settings could not be verified.",
      );
    if (!input) {
      if (!row || row.tenantId !== current.tenantId)
        return { version: row?.revision ?? null, timeZone: null, windows: [] };
      try {
        const policy = workingHoursPolicy(row.timeZone, row.windows);
        return { version: row.revision, timeZone: policy.timeZone, windows: policy.windows };
      } catch {
        throw new CalendarError(
          503,
          "working_hours_unknown",
          "Working-hour settings could not be verified.",
        );
      }
    }
    if (!current.tenantId)
      throw new CalendarError(
        403,
        "organisation_required",
        "An organisation is required to save panel working hours.",
      );
    if ((row?.revision ?? null) !== input.expectedVersion)
      throw new CalendarError(
        409,
        "working_hours_changed",
        "Your working hours changed. Reload before saving; your draft has not been saved.",
      );
    let policy: ReturnType<typeof workingHoursPolicy>;
    try {
      policy = workingHoursPolicy(input.timeZone, input.windows);
    } catch {
      throw new CalendarError(
        400,
        "invalid_working_hours",
        "Use a valid IANA timezone and non-overlapping forward intervals. Split overnight hours across days.",
      );
    }
    const values = {
      userId: current.id,
      tenantId: current.tenantId,
      revision: randomUUID(),
      timeZone: policy.timeZone,
      windows: policy.windows,
      updatedAt: new Date(),
    };
    const [saved] = await tx
      .insert(hours)
      .values(values)
      .onConflictDoUpdate({ target: hours.userId, set: values })
      .returning();
    return { version: saved.revision, timeZone: saved.timeZone, windows: saved.windows };
  });
}
router.get("/outlook-calendar/working-hours", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await preferences(getAuthUserId(req)));
  } catch (error) {
    if (error instanceof CalendarError)
      res.status(error.status).json({ code: error.code, error: error.message });
    else next(error);
  }
});
router.put("/outlook-calendar/working-hours", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const input = SaveCalendarWorkingHoursBody.strict().parse(req.body);
    res.json(await preferences(getAuthUserId(req), input));
  } catch (error) {
    if (error instanceof z.ZodError)
      res.status(400).json({
        code: "invalid_working_hours",
        error: "Provide a valid timezone, weekly hours and current version.",
      });
    else if (error instanceof CalendarError)
      res.status(error.status).json({ code: error.code, error: error.message });
    else next(error);
  }
});
export default router;
