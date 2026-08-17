/**
 * routes/notifications.ts — In-App User Notifications
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for the recruiter bell-icon notification panel. Serves real-time-
 * style notifications that are written by the schedulers and agents when
 * something requires recruiter attention (interview completed, ghosting alert,
 * digest ready, etc.).
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /user-notifications              Last 50 notifications for the caller
 *   GET  /user-notifications/unread-count Unread count (for the badge)
 *   POST /user-notifications/:id/read     Mark one notification as read
 *   POST /user-notifications/read-all    Mark all notifications as read
 *
 * ─── Notification sources ────────────────────────────────────────────────────
 * Rows are inserted into user_notifications by:
 *   interview-invite-scheduler.ts — session abandoned
 *   recruiter-digest-scheduler.ts — digest sent
 *   anti-ghost-engine.ts          — ghosting alert created
 *   agents/orchestrator.ts        — screening batch complete
 *   routes/interviews.ts          — interview session complete (POST /notify)
 *
 * The frontend polls GET /user-notifications/unread-count every 30 seconds
 * and uses SSE (or polling) to refresh the panel when the count increases.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { controlDb, db, userNotificationsTable, usersTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { getAuthUserId } from "../lib/auth-token";
import { validate } from "../middlewares/validate";

/* No body fields are read on these endpoints — the action is implicit
 * in the route + caller. Strict empty-body validation prevents callers
 * from smuggling unexpected keys (defense-in-depth against future
 * mass-assignment bugs). */
/* Bodyless POSTs (fetch without a body ⇒ req.body === undefined) must still
 * validate — default undefined to {} before the strict empty-object check. */
const EmptyBody = z.preprocess((v) => v ?? {}, z.object({}).strict());

const router: IRouter = Router();

async function getCallerUser(req: any) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u || null;
}

router.get("/user-notifications", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const rows = await db.select().from(userNotificationsTable)
    .where(eq(userNotificationsTable.userId, user.id))
    .orderBy(desc(userNotificationsTable.createdAt))
    .limit(50);
  res.json(rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

router.get("/user-notifications/unread-count", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.json({ count: 0 }); return; }
  const [row] = await db.select({ c: sql<number>`count(*)::int` })
    .from(userNotificationsTable)
    .where(and(eq(userNotificationsTable.userId, user.id), eq(userNotificationsTable.isRead, false)));
  res.json({ count: row?.c ?? 0 });
});

router.post("/user-notifications/:id/read", validate({ body: EmptyBody }), async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  await db.update(userNotificationsTable)
    .set({ isRead: true })
    .where(and(eq(userNotificationsTable.id, req.params.id), eq(userNotificationsTable.userId, user.id)));
  res.json({ ok: true });
});

router.post("/user-notifications/read-all", validate({ body: EmptyBody }), async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  await db.update(userNotificationsTable)
    .set({ isRead: true })
    .where(eq(userNotificationsTable.userId, user.id));
  res.json({ ok: true });
});

export default router;
