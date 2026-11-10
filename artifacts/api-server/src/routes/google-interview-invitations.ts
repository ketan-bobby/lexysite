import { Router } from "express";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { googleStaffConfig } from "../lib/google-staff-config";
import { googleInvitationStore } from "../lib/google-invitation-store";
import { googleInvitationService } from "../lib/google-interview-invitation";
import { inviteError } from "./outlook-candidate-invitations";
import { googleInvitationOperationsRouter } from "./google-invitation-operations";
export function googleInterviewInvitationsRouter(
  deps = {
    caller: calendarStaff,
    service: () =>
      googleInvitationService({ store: googleInvitationStore(), config: googleStaffConfig }),
  },
) {
  const router = Router();
  router.use(googleInvitationOperationsRouter());
  router.get("/google-calendar/schedules/:scheduleId/invitation", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const caller = await deps.caller(getAuthUserId(req));
      res.json(await deps.service().review(caller, String(req.params.scheduleId)));
    } catch (error) {
      inviteError(error, res, next);
    }
  });
  router.post("/google-calendar/schedules/:scheduleId/invitation", async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const caller = await deps.caller(getAuthUserId(req));
      res.json(await deps.service().send(caller, String(req.params.scheduleId), req.body));
    } catch (error) {
      inviteError(error, res, next);
    }
  });
  return router;
}
export default googleInterviewInvitationsRouter();
