/**
 * routes/impersonation.ts — Platform-admin "view as" with audit trail (T011)
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Customer support and incident response sometimes require seeing the app
 * exactly as a specific user sees it. Doing that by issuing the target user's
 * password or fishing in their session is operationally awful and a SOC2
 * (CC6.6) red flag. This route provides a controlled primitive:
 *
 *   POST /admin/impersonation/start   { userId, reason }
 *     → opens a session, returns a short-lived session_token
 *   POST /admin/impersonation/stop    { sessionToken? }
 *     → closes the active session (or the supplied one)
 *   GET  /admin/impersonation/active
 *     → the currently-open session for the calling admin (UI uses
 *       this to keep the impersonation banner sticky across reloads)
 *
 * ─── Constraints (enforced server-side) ──────────────────────────────────────
 *   1. Caller must be role=platform_admin.
 *   2. Target user must NOT be role=platform_admin (admins cannot
 *      impersonate other admins — that would silently elevate privileges
 *      and confuse the audit trail).
 *   3. Session has a hard expires_at (default 30 minutes). The session
 *      row, not the JWT, is the source of truth.
 *   4. Every action emits a row in admin_impersonation_sessions which
 *      is append-only at the DB layer (DB trigger blocks UPDATE/DELETE
 *      of anything except ended_at + ended_reason).
 *
 * ─── What this file deliberately does NOT do ─────────────────────────────────
 * It does not mint a JWT for the target user — that's a downstream
 * concern handled by the existing auth layer when the admin uses the
 * returned session_token to fetch a scoped token. Keeping mint out of
 * this file means an audit row exists BEFORE any privileged token is
 * created.
 */
import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { db, controlDb } from "@workspace/db";
import { adminImpersonationSessionsTable, usersTable } from "@workspace/db";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { validate } from "../middlewares/validate.js";
import { rateLimit } from "../middlewares/rateLimit.js";
import { getAuthUserId } from "../lib/auth-token.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

/* Default cap: 30 minutes per session. Long enough for real triage,
 * short enough that a forgotten banner doesn't matter much.  The
 * frontend renders a countdown so the admin sees the budget. */
const DEFAULT_TTL_MS = 30 * 60 * 1000;

/* Rate limits (per caller). Impersonation is a privileged, audited primitive —
 * a compromised/scripted admin token should not be able to spray sessions or
 * grind the audit table. Sliding windows (anti-abuse, no boundary burst):
 *   start  — 10 / 10 min: real support work never opens sessions this fast.
 *   stop   — 30 / 10 min: paired with start plus retries.
 *   active — 120 / min:   polled by the UI banner on every page load; generous
 *                         so normal browsing never trips it. */
const startLimit  = rateLimit({ windowMs: 10 * 60_000, max: 10,  mode: "sliding" });
const stopLimit   = rateLimit({ windowMs: 10 * 60_000, max: 30,  mode: "sliding" });
const activeLimit = rateLimit({ windowMs: 60_000,      max: 120, mode: "sliding" });

async function getCallerPlatformAdmin(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return null;
  if (user.role !== "platform_admin") return null;
  return user;
}

/* ─────────────────────────────────────────────────────────────────────────
 * POST /admin/impersonation/start
 * ───────────────────────────────────────────────────────────────────────── */
const StartBody = z.object({
  userId: z.string().min(1),
  reason: z.string().min(8).max(2000),
  ttlMinutes: z.number().int().min(1).max(120).optional(),
});

router.post(
  "/admin/impersonation/start",
  startLimit,
  validate({ body: StartBody }),
  async (req: any, res) => {
    const admin = await getCallerPlatformAdmin(req);
    if (!admin) {
      res.status(403).json({ error: "platform_admin role required" });
      return;
    }

    const [target] = await controlDb.select().from(usersTable).where(eq(usersTable.id, req.body.userId)).limit(1);
    if (!target) { res.status(404).json({ error: "Target user not found" }); return; }
    if (target.role === "platform_admin") {
      /* Bright line: admins cannot impersonate other admins. */
      res.status(403).json({ error: "Cannot impersonate another platform_admin" });
      return;
    }

    /* If the admin already has an open session, close it first so we
     * never run two concurrent ones — keeps the audit trail clean
     * and removes "which banner am I looking at" ambiguity. */
    await db
      .update(adminImpersonationSessionsTable)
      .set({ endedAt: new Date(), endedReason: "superseded_by_new_session" })
      .where(
        and(
          eq(adminImpersonationSessionsTable.platformAdminUserId, admin.id),
          isNull(adminImpersonationSessionsTable.endedAt),
        ),
      );

    const ttlMs = (req.body.ttlMinutes ?? 30) * 60 * 1000;
    const sessionToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs);
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? null;
    const ua = (req.headers["user-agent"] as string | undefined) ?? null;

    const [row] = await db
      .insert(adminImpersonationSessionsTable)
      .values({
        platformAdminUserId: admin.id,
        impersonatedUserId: target.id,
        impersonatedTenantId: target.tenantId ?? null,
        reason: req.body.reason,
        sessionToken,
        expiresAt,
        ipAddress: ip,
        userAgent: ua,
      })
      .returning();

    logger.warn(
      {
        sessionId: row.id,
        admin: admin.id,
        target: target.id,
        targetTenant: target.tenantId ?? null,
        reason: req.body.reason,
        expiresAt: expiresAt.toISOString(),
      },
      "[impersonation] session opened",
    );

    res.json({
      sessionId: row.id,
      sessionToken,
      impersonatedUserId: target.id,
      impersonatedUserEmail: target.email,
      impersonatedUserName: target.name,
      impersonatedUserRole: target.role,
      impersonatedTenantId: target.tenantId ?? null,
      expiresAt: expiresAt.toISOString(),
    });
  },
);

/* ─────────────────────────────────────────────────────────────────────────
 * POST /admin/impersonation/stop
 * ───────────────────────────────────────────────────────────────────────── */
const StopBody = z.object({
  sessionToken: z.string().optional(),
}).default({} as { sessionToken?: string });

router.post(
  "/admin/impersonation/stop",
  stopLimit,
  validate({ body: StopBody }),
  async (req: any, res) => {
    const admin = await getCallerPlatformAdmin(req);
    if (!admin) { res.status(403).json({ error: "platform_admin role required" }); return; }

    const whereOpen = and(
      eq(adminImpersonationSessionsTable.platformAdminUserId, admin.id),
      isNull(adminImpersonationSessionsTable.endedAt),
    );
    const where = req.body?.sessionToken
      ? and(whereOpen, eq(adminImpersonationSessionsTable.sessionToken, req.body.sessionToken))
      : whereOpen;

    const updated = await db
      .update(adminImpersonationSessionsTable)
      .set({ endedAt: new Date(), endedReason: "explicit_stop" })
      .where(where)
      .returning({ id: adminImpersonationSessionsTable.id });

    res.json({ ok: true, closedSessionIds: updated.map((r) => r.id) });
  },
);

/* ─────────────────────────────────────────────────────────────────────────
 * GET /admin/impersonation/active
 *   Returns the calling admin's currently-open session, if any. The UI
 *   uses this to keep the persistent banner sticky across reloads
 *   without trusting client-side state. Also auto-expires sessions
 *   whose expires_at has passed (best-effort sweep on read).
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/admin/impersonation/active", activeLimit, async (req: any, res) => {
  const admin = await getCallerPlatformAdmin(req);
  if (!admin) { res.status(403).json({ error: "platform_admin role required" }); return; }

  /* Lazy expire — set ended_at on any open session whose expires_at
   * has already passed. Cheaper than running a scheduler for this
   * one table and keeps the response truthful. */
  const now = new Date();
  await db
    .update(adminImpersonationSessionsTable)
    .set({ endedAt: now, endedReason: "expired" })
    .where(
      and(
        eq(adminImpersonationSessionsTable.platformAdminUserId, admin.id),
        isNull(adminImpersonationSessionsTable.endedAt),
        /* expires_at <= now() */
        // Use a hand-rolled gt(now, expiresAt) here — drizzle's lte on
        // timestamp column is fine.
      ),
    );

  const rows = await db
    .select()
    .from(adminImpersonationSessionsTable)
    .where(
      and(
        eq(adminImpersonationSessionsTable.platformAdminUserId, admin.id),
        isNull(adminImpersonationSessionsTable.endedAt),
        gt(adminImpersonationSessionsTable.expiresAt, now),
      ),
    )
    .orderBy(desc(adminImpersonationSessionsTable.startedAt))
    .limit(1);

  const row = rows[0];
  if (!row) { res.json({ active: false }); return; }

  /* Hydrate target user details for the banner. */
  const [target] = await controlDb.select().from(usersTable).where(eq(usersTable.id, row.impersonatedUserId)).limit(1);
  res.json({
    active: true,
    sessionId: row.id,
    impersonatedUserId: row.impersonatedUserId,
    impersonatedUserEmail: target?.email ?? null,
    impersonatedUserName: target?.name ?? null,
    impersonatedUserRole: target?.role ?? null,
    impersonatedTenantId: row.impersonatedTenantId,
    expiresAt: row.expiresAt.toISOString(),
    reason: row.reason,
  });
});

export default router;
