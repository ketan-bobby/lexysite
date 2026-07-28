/**
 * routes/system-errors.ts — Platform-admin error dashboard API
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Read-only API for the system_errors table populated by lib/error-tracking.ts.
 * Lets a platform admin answer "how many 500s in the last hour and on which
 * routes" without needing to grep log files or stand up Sentry.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /admin/system-errors            Recent errors with rich filtering.
 *   GET  /admin/system-errors/summary    Group-by counts: per-route, per-source
 *                                        for the time window.
 *
 * ─── Auth ────────────────────────────────────────────────────────────────────
 * Strictly platform_admin. Tenant admins do NOT see errors from other
 * tenants. system_errors is not RLS-protected, so the auth gate IS the
 * boundary — guard it carefully.
 *
 * ─── Why dbAdmin ─────────────────────────────────────────────────────────────
 * system_errors is not RLS-protected (header comment in the schema explains
 * why — it's a platform-admin diagnostic, not tenant data). Reading through
 * the RLS-bound `db` Proxy would not change visibility, but using dbAdmin
 * is explicit and matches the symmetry with the insert path.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { dbAdmin, systemErrorsTable, usersTable } from "@workspace/db";
import { and, desc, eq, gte, sql, isNotNull } from "drizzle-orm";
import { getAuthUserId } from "../lib/auth-token";
import { validate } from "../middlewares/validate";

const router: IRouter = Router();

async function requirePlatformAdmin(req: any, res: any): Promise<{ id: string } | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [u] = await dbAdmin.select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!u) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (u.role !== "platform_admin") { res.status(403).json({ error: "Forbidden" }); return null; }
  return { id: u.id };
}

const ListQuery = z.object({
  source: z.enum(["express", "uncaughtException", "unhandledRejection", "scheduler", "manual"]).optional(),
  routePath: z.string().min(1).max(200).optional(),
  sinceMinutes: z.coerce.number().int().min(1).max(60 * 24 * 30).default(60),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

router.get("/admin/system-errors", validate({ query: ListQuery }), async (req, res) => {
  const admin = await requirePlatformAdmin(req, res);
  if (!admin) return;
  const q = (res.locals.validated?.query ?? req.query) as z.infer<typeof ListQuery>;
  const since = new Date(Date.now() - q.sinceMinutes * 60_000);
  const conds = [gte(systemErrorsTable.occurredAt, since)];
  if (q.source) conds.push(eq(systemErrorsTable.source, q.source));
  if (q.routePath) conds.push(eq(systemErrorsTable.routePath, q.routePath));

  const rows = await dbAdmin.select().from(systemErrorsTable)
    .where(and(...conds))
    .orderBy(desc(systemErrorsTable.occurredAt))
    .limit(q.limit);

  res.json(rows.map((r) => ({
    ...r,
    occurredAt: r.occurredAt.toISOString(),
  })));
});

const SummaryQuery = z.object({
  sinceMinutes: z.coerce.number().int().min(1).max(60 * 24 * 30).default(60),
}).strict();

router.get("/admin/system-errors/summary", validate({ query: SummaryQuery }), async (req, res) => {
  const admin = await requirePlatformAdmin(req, res);
  if (!admin) return;
  const q = (res.locals.validated?.query ?? req.query) as z.infer<typeof SummaryQuery>;
  const since = new Date(Date.now() - q.sinceMinutes * 60_000);

  const byRoute = await dbAdmin.select({
    routePath: systemErrorsTable.routePath,
    count: sql<number>`count(*)::int`,
    lastSeen: sql<Date>`max(${systemErrorsTable.occurredAt})`,
  }).from(systemErrorsTable)
    .where(and(gte(systemErrorsTable.occurredAt, since), isNotNull(systemErrorsTable.routePath)))
    .groupBy(systemErrorsTable.routePath)
    .orderBy(sql`count(*) desc`)
    .limit(50);

  const bySource = await dbAdmin.select({
    source: systemErrorsTable.source,
    count: sql<number>`count(*)::int`,
  }).from(systemErrorsTable)
    .where(gte(systemErrorsTable.occurredAt, since))
    .groupBy(systemErrorsTable.source);

  const [{ total }] = await dbAdmin.select({ total: sql<number>`count(*)::int` })
    .from(systemErrorsTable)
    .where(gte(systemErrorsTable.occurredAt, since));

  res.json({
    windowMinutes: q.sinceMinutes,
    total,
    bySource,
    byRoute: byRoute.map((r) => ({ ...r, lastSeen: r.lastSeen ? new Date(r.lastSeen).toISOString() : null })),
  });
});

export default router;
