import { Router } from "express";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { googleStaffConfig } from "../lib/google-staff-config";
import { googleInvitationStore } from "../lib/google-invitation-store";
import { googleInvitationOperationService } from "../lib/google-invitation-operation";
import { inviteError } from "./outlook-candidate-invitations";
export function googleInvitationOperationsRouter(
  deps = {
    caller: calendarStaff,
    service: () =>
      googleInvitationOperationService({
        store: googleInvitationStore(),
        config: googleStaffConfig,
      }),
  },
) {
  const router = Router();
  router.get(
    "/google-calendar/schedules/:scheduleId/invitation/operation",
    async (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const caller = await deps.caller(getAuthUserId(req));
        res.json(await deps.service().review(caller, String(req.params.scheduleId)));
      } catch (error) {
        inviteError(error, res, next);
      }
    },
  );
  router.post(
    "/google-calendar/schedules/:scheduleId/invitation/operation",
    async (req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const caller = await deps.caller(getAuthUserId(req));
        res.json(await deps.service().apply(caller, String(req.params.scheduleId), req.body));
      } catch (error) {
        inviteError(error, res, next);
      }
    },
  );
  return router;
}
