import { Router, type Request } from "express";
import { z } from "zod/v4";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { CalendarError } from "../lib/outlook-calendar-core";
import { googlePanelRepository } from "../lib/google-panel-store";

const consentBody = z
  .object({
    enabled: z.boolean(),
    expectedRevision: z.uuid(),
    confirmShare: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !v.enabled || v.confirmShare === true);
const timesBody = z
  .object({
    expectedVersion: z.string().min(1).max(200),
    userIds: z.array(z.string().min(1).max(200)).min(1).max(5),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    bufferMinutes: z.number().int().min(0).max(60),
  })
  .strict();
const saveBody = z
  .object({
    expectedVersion: z.string().regex(/^v1_[a-f0-9]{64}$/),
    userIds: z.array(z.string().min(1).max(200)).max(5),
    scheduledAt: z.iso.datetime({ offset: true }),
    bufferMinutes: z.number().int().min(0).max(60),
  })
  .strict()
  .refine((v) => new Set(v.userIds).size === v.userIds.length);
export function googlePanelCalendarRouter(
  deps: {
    actor: typeof calendarStaff;
    repository: Pick<
      ReturnType<typeof googlePanelRepository>,
      "consent" | "members" | "times" | "saved" | "save"
    >;
  } = { actor: calendarStaff, repository: googlePanelRepository() },
) {
  const router = Router();
  function handle(
    coordinate: boolean,
    work: (req: Request, caller: Awaited<ReturnType<typeof calendarStaff>>) => Promise<unknown>,
  ) {
    return async (req: Request, res: import("express").Response) => {
      res.set("Cache-Control", "no-store");
      try {
        const caller = await deps.actor(getAuthUserId(req));
        if (coordinate && caller.role === "interviewer")
          throw new CalendarError(
            403,
            "coordinator_required",
            "Coordinating staff access is required.",
          );
        return res.json(await work(req, caller));
      } catch (error) {
        if (error instanceof z.ZodError)
          return res.status(400).json({
            code: "invalid_input",
            error: "Provide valid sharing permission, panel and time-window details.",
          });
        if (error instanceof CalendarError && error.status < 500)
          return res.status(error.status).json({ code: error.code, error: error.message });
        return res.status(503).json({
          code: "panel_unknown",
          error:
            "Panel availability could not be verified. No external booking or invitation was made. Reload the saved panel before retrying.",
        });
      }
    };
  }
  router.get(
    "/google-calendar/schedules/:scheduleId/panel",
    handle(true, (req, caller) => deps.repository.saved(caller, String(req.params.scheduleId))),
  );
  router.put(
    "/google-calendar/schedules/:scheduleId/panel",
    handle(true, (req, caller) =>
      deps.repository.save(caller, String(req.params.scheduleId), saveBody.parse(req.body)),
    ),
  );
  router.get(
    "/google-calendar/panel-consent",
    handle(false, (_req, caller) => deps.repository.consent(caller)),
  );
  router.post(
    "/google-calendar/panel-consent",
    handle(false, (req, caller) => deps.repository.consent(caller, consentBody.parse(req.body))),
  );
  router.get(
    "/google-calendar/schedules/:scheduleId/panel-members",
    handle(true, (req, caller) => deps.repository.members(caller, String(req.params.scheduleId))),
  );
  router.post(
    "/google-calendar/schedules/:scheduleId/panel-times",
    handle(true, (req, caller) =>
      deps.repository.times(caller, String(req.params.scheduleId), timesBody.parse(req.body)),
    ),
  );
  return router;
}
export default googlePanelCalendarRouter();
