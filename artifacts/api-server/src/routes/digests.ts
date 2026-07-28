/**
 * routes/digests.ts — Recruiter Digest Queue Inspector & Manual Trigger
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for viewing and manually triggering the recruiter_digest_queue.
 * Primarily used by admin UIs and testing tooling — normal delivery is handled
 * automatically by recruiter-digest-scheduler.ts every hour.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /digests/pending    List every unsent digest queue row visible to the
 *                            caller (tenant-scoped; platform_admin sees all).
 *                            Useful for an admin UI showing what's queued for
 *                            tomorrow morning's batch.
 *   POST /digests/run-now    Force-send all pending digests for the caller's
 *                            tenant immediately (bypasses the 08:00 local-time
 *                            and once-per-day checks). platform_admin may pass
 *                            ?tenantId= to target any tenant.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { controlDb, db, usersTable, recruiterDigestQueueTable } from "@workspace/db";
import { validate } from "../middlewares/validate";
import { and, desc, eq, isNull } from "drizzle-orm";
import { tick as runDigestTick } from "../lib/recruiter-digest-scheduler";
import { getAuthUserId } from "../lib/auth-token";

const router: IRouter = Router();

async function getCallerUser(req: any) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u || null;
}

/**
 * GET /digests/pending — list every queued digest item visible to the
 * caller. Tenant-scoped; platform_admin sees all. Useful for an admin UI
 * showing what's waiting to go out tomorrow morning.
 */
router.get("/digests/pending", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const conds: any[] = [isNull(recruiterDigestQueueTable.sentAt)];
  if (user.role !== "platform_admin") {
    conds.push(eq(recruiterDigestQueueTable.tenantId, user.tenantId));
  }
  const rows = await db.select().from(recruiterDigestQueueTable)
    .where(and(...conds))
    .orderBy(desc(recruiterDigestQueueTable.createdAt))
    .limit(500);
  res.json({ items: rows, count: rows.length });
});

/**
 * POST /digests/run-now — force the digest scheduler to drain and send
 * every pending row right now, regardless of local hour.
 *
 * Tenancy is strictly enforced: tenant_admins only drain their own tenant's
 * queue; platform_admins can drain everything (omit tenantId in the call).
 */
router.post("/digests/run-now", validate({ body: z.object({}).strict() }), async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!["platform_admin", "tenant_admin"].includes(user.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  // Critical: scope tenant_admin to their own tenant. Without this they
  // could trigger digest sends for every other tenant in the system.
  const tenantId = user.role === "platform_admin" ? null : user.tenantId;
  const result = await runDigestTick({ force: true, tenantId });
  res.json({ ok: true, scope: tenantId ? `tenant:${tenantId}` : "all", ...result });
});

export default router;
