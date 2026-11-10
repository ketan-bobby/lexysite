import { Router } from "express";
import { calendarStaff } from "../lib/calendar-staff";
import { getAuthUserId } from "../lib/auth-token";
import { resolveCandidateSession } from "../lib/portal-auth";
import { staffZoomLinkStore, candidateZoomLink } from "../lib/staff-zoom-link-store";
import { zoomDraft, zoomApproval, zoomRemoval } from "../lib/staff-zoom-link";
import { CalendarError } from "../lib/outlook-calendar-core";
import {
  zoomMeetingService,
  zoomMeetingReview,
  zoomMeetingApproval,
} from "../lib/zoom-meeting-service";
import { zoomProviderError } from "../lib/zoom-provider";
import {
  zoomMeetingRecovery,
  zoomRecoveryReview,
  zoomRecoveryApproval,
} from "../lib/zoom-meeting-recovery";

export function staffZoomLinksRouter(
  deps = {
    caller: calendarStaff,
    store: staffZoomLinkStore(),
    session: resolveCandidateSession,
    candidate: candidateZoomLink,
    meetings: zoomMeetingService(),
    recovery: zoomMeetingRecovery(),
  },
) {
  const router = Router();
  function handle(kind: "read" | "review" | "publish" | "remove") {
    return async (
      req: import("express").Request,
      res: import("express").Response,
    ): Promise<void> => {
      res.set("Cache-Control", "no-store");
      try {
        const caller = await deps.caller(getAuthUserId(req)),
          id = String(req.params.scheduleId);
        if (kind === "read") {
          res.json(await deps.store.read(caller, id));
          return;
        }
        const parsed = (
          kind === "review" ? zoomDraft : kind === "publish" ? zoomApproval : zoomRemoval
        ).safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid Zoom link request." });
          return;
        }
        const result =
          kind === "review"
            ? await deps.store.review(caller, id, zoomDraft.parse(parsed.data))
            : kind === "publish"
              ? await deps.store.publish(caller, id, zoomApproval.parse(parsed.data))
              : await deps.store.remove(caller, id, zoomRemoval.parse(parsed.data));
        res.json(result);
      } catch (error) {
        if (error instanceof CalendarError) {
          res.status(error.status).json({ code: error.code, error: error.message });
          return;
        }
        res
          .status(503)
          .json({ error: "Zoom link could not be confirmed. Reload before retrying." });
      }
    };
  }
  router.get("/zoom/schedules/:scheduleId/link", handle("read"));
  router.post("/zoom/schedules/:scheduleId/link-review", handle("review"));
  router.put("/zoom/schedules/:scheduleId/link", handle("publish"));
  router.delete("/zoom/schedules/:scheduleId/link", handle("remove"));
  const meeting =
    (kind: "read" | "review" | "approve") =>
    async (req: import("express").Request, res: import("express").Response) => {
      res.set("Cache-Control", "no-store");
      try {
        const caller = await deps.caller(getAuthUserId(req));
        const id = String(req.params.scheduleId);
        if (kind === "read") return res.json(await deps.meetings.read(caller, id));
        const parsed = (kind === "review" ? zoomMeetingReview : zoomMeetingApproval).safeParse(
          req.body,
        );
        if (!parsed.success)
          return res
            .status(400)
            .json({ code: "zoom_request_invalid", error: "Invalid Zoom meeting request." });
        return res.json(
          kind === "review"
            ? await deps.meetings.review(caller, id, zoomMeetingReview.parse(parsed.data))
            : await deps.meetings.approve(caller, id, zoomMeetingApproval.parse(parsed.data)),
        );
      } catch (error) {
        const safe = error instanceof CalendarError ? error : zoomProviderError();
        return res.status(safe.status).json({ code: safe.code, error: safe.message });
      }
    };
  router.get("/zoom/schedules/:scheduleId/meeting", meeting("read"));
  router.post("/zoom/schedules/:scheduleId/meeting-review", meeting("review"));
  router.post("/zoom/schedules/:scheduleId/meeting", meeting("approve"));
  const recovery =
    (approve: boolean) =>
    async (req: import("express").Request, res: import("express").Response) => {
      res.set("Cache-Control", "no-store");
      try {
        const caller = await deps.caller(getAuthUserId(req));
        const id = String(req.params.scheduleId);
        const parsed = (approve ? zoomRecoveryApproval : zoomRecoveryReview).safeParse(req.body);
        if (!parsed.success)
          return res
            .status(400)
            .json({ code: "zoom_request_invalid", error: "Invalid recovery request." });
        return res.json(
          approve
            ? await deps.recovery.approve(caller, id, zoomRecoveryApproval.parse(parsed.data))
            : await deps.recovery.review(caller, id, zoomRecoveryReview.parse(parsed.data)),
        );
      } catch (error) {
        const safe = error instanceof CalendarError ? error : zoomProviderError();
        return res.status(safe.status).json({ code: safe.code, error: safe.message });
      }
    };
  router.post("/zoom/schedules/:scheduleId/meeting-recovery-review", recovery(false));
  router.post("/zoom/schedules/:scheduleId/meeting-recovery", recovery(true));
  router.get("/portal/interview-schedules/:scheduleId/zoom-link", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const self = await deps.session(req);
      if (!self) {
        res.status(401).json({ error: "Candidate sign-in required." });
        return;
      }
      const result = await deps.candidate(self, String(req.params.scheduleId));
      if (!result) {
        res.status(404).json({ error: "Appointment not found." });
        return;
      }
      res.json(result);
    } catch {
      res.status(503).json({ error: "Meeting details unavailable. Please try again." });
    }
  });
  return router;
}
export default staffZoomLinksRouter();
