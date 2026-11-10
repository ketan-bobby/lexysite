import { Router, type RequestHandler } from "express";
import { RecallAssistantReadinessResponse } from "@workspace/api-zod";
import { resolveUser } from "../middlewares/resolveUser";
import { calendarStaff } from "../lib/calendar-staff";
import { checkRecallReadiness } from "../lib/recall-readiness";

/** Platform operations only: a project connection is not an employer-wide grant. */
export function recallReadinessHandler(
  actor = calendarStaff,
  check = checkRecallReadiness,
): RequestHandler {
  return async (req, res): Promise<void> => {
    res.set("Cache-Control", "no-store");
    const caller = await actor(req.resolvedUser?.id ?? null);
    if (caller.role !== "platform_admin") {
      res.status(403).json({ error: "Platform administrator access is required." });
      return;
    }
    const view = await check();
    res.json(
      RecallAssistantReadinessResponse.parse({
        ...view,
        checkedAt: new Date(view.checkedAt),
      }),
    );
  };
}

const router = Router();
router.get("/meeting-assistant/readiness", resolveUser, recallReadinessHandler());
export default router;
