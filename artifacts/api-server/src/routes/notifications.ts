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
 *   GET  /user-notifications              Caller-only cursor history (50 by default)
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
import { eq, and, desc, sql, getTableColumns } from "drizzle-orm";
import { getAuthUserId } from "../lib/auth-token";
import { validate } from "../middlewares/validate";
import { notificationCursor, readNotificationCursor } from "../lib/notification-cursor";

/* No body fields are read on these endpoints — the action is implicit
 * in the route + caller. Strict empty-body validation prevents callers
 * from smuggling unexpected keys (defense-in-depth against future
 * mass-assignment bugs). */
/* Bodyless POSTs (fetch without a body ⇒ req.body === undefined) must still
 * validate — default undefined to {} before the strict empty-object check. */
const EmptyBody = z.preprocess((v) => v ?? {}, z.object({}).strict());

const router: IRouter = Router();

async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u?.status === "active" ? u : null;
}

router.get("/user-notifications", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const query = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(1024).optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid notification pagination" }); return; }
  let cursor: ReturnType<typeof readNotificationCursor> | undefined;
  try {
    cursor = query.data.cursor ? readNotificationCursor(query.data.cursor, user.id) : undefined;
  } catch {
    res.status(400).json({ error: "Invalid notification cursor" }); return;
  }
  // Retain PostgreSQL microseconds: JS Date truncation can skip rows at a page boundary.
  const rows = await db.select({
    ...getTableColumns(userNotificationsTable),
    cursorAt: sql<string>`to_char(${userNotificationsTable.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(userNotificationsTable)
    .where(and(eq(userNotificationsTable.userId, user.id), cursor
      ? sql`(${userNotificationsTable.createdAt}, ${userNotificationsTable.id}) < (${cursor.at}::timestamp, ${cursor.id}::text)`
      : undefined))
    .orderBy(desc(userNotificationsTable.createdAt), desc(userNotificationsTable.id))
    .limit(query.data.limit + 1);
  const page = rows.slice(0, query.data.limit);
  const last = page.at(-1);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Access-Control-Expose-Headers", "X-Next-Cursor");
  if (rows.length > query.data.limit && last)
    res.setHeader("X-Next-Cursor", notificationCursor(user.id, last.id, last.cursorAt));
  res.json(page.map(({ cursorAt: _cursorAt, ...r }) => ({ ...r, createdAt: r.createdAt.toISOString() })));
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
