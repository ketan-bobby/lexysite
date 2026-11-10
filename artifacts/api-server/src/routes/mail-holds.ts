import { Router, type IRouter, type Request, type Response } from "express";
import { controlDb, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  ListMailHoldsQueryParams,
  ListMailHoldsResponse,
  ReviewMailHoldBody,
  ReviewMailHoldResponse,
} from "@workspace/api-zod";
import { getAuthUserId } from "../lib/auth-token";
import { listMailHolds, reviewMailHold, MailHoldConflict } from "../lib/mail-hold-review";

const router: IRouter = Router();
async function requirePlatformAdmin(req: Request, res: Response) {
  const id = getAuthUserId(req);
  if (!id) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  const [user] = await controlDb
    .select({ id: usersTable.id, role: usersTable.role, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.id, id))
    .limit(1);
  if (!user || user.status !== "active") {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (user.role !== "platform_admin") {
    res.status(403).json({ error: "Platform administrator required" });
    return null;
  }
  return user;
}
router.get("/platform/mail-holds", async (req, res): Promise<void> => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = ListMailHoldsQueryParams.strict().safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid queue pagination" });
    return;
  }
  try {
    res.json(ListMailHoldsResponse.parse(await listMailHolds(parsed.data.cursor)));
  } catch {
    req.log.error("Email hold queue read failed");
    res.status(503).json({ error: "Email hold queue unavailable" });
  }
});
router.post("/platform/mail-holds/review", async (req, res): Promise<void> => {
  const actor = await requirePlatformAdmin(req, res);
  if (!actor) return;
  const parsed = ReviewMailHoldBody.strict().safeParse(req.body);
  if (!parsed.success || parsed.data.acknowledgeNoResend !== true) {
    res.status(400).json({ error: "Valid review and no-resend acknowledgement required" });
    return;
  }
  try {
    res.json(ReviewMailHoldResponse.parse(await reviewMailHold(actor.id, parsed.data)));
  } catch (error) {
    if (error instanceof MailHoldConflict) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    req.log.error("Email hold review could not be saved");
    res.status(503).json({ error: "Review could not be saved; original hold retained" });
  }
});
export default router;
