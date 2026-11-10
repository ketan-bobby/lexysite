import { Router } from "express";
import { CheckGoogleCalendarPilotBody } from "@workspace/api-zod";
import { calendarStaff } from "../lib/calendar-staff";
import { getAuthUserId } from "../lib/auth-token";
import { CalendarError } from "../lib/outlook-calendar-core";
import { GoogleCalendarReadError, checkGoogleCalendarReads } from "../lib/google-calendar-read";
import { boundedGoogleRead, googleCalendarReadGateway } from "../lib/google-calendar-gateway";

export function googlePilotRouter(
  deps = {
    staff: calendarStaff,
    gateway: googleCalendarReadGateway,
  },
) {
  const router = Router();
  let inProgress = false;
  router.post("/google-calendar/pilot-check", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      // Project-level diagnostics, not a tenant's or staff member's connected calendar.
      const caller = await deps.staff(getAuthUserId(req));
      if (caller.role !== "platform_admin") {
        res.status(403).json({ error: "An active platform administrator is required." });
        return;
      }
      if (
        !CheckGoogleCalendarPilotBody.strict().safeParse(req.body).success ||
        req.body.confirmReadOnlyCheck !== true
      ) {
        res.status(400).json({ error: "Confirm the read-only check without additional input." });
        return;
      }
      if (inProgress) {
        res.status(409).json({ error: "A project calendar check is already in progress." });
        return;
      }
      inProgress = true;
      try {
        const result = await boundedGoogleRead(checkGoogleCalendarReads(deps.gateway()));
        res.json(result);
      } finally {
        inProgress = false;
      }
    } catch (error) {
      if (error instanceof CalendarError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      const code = error instanceof GoogleCalendarReadError ? error.code : "connection_unavailable";
      // Do not log SDK exceptions: they may contain connection/account details.
      req.log?.warn({ code }, "Google Calendar pilot read check could not be verified");
      res.status(503).json({
        error: "Google Calendar reads could not be verified. No invitations are enabled.",
        code,
      });
    }
  });
  return router;
}
export default googlePilotRouter();
