/**
 * routes/credits.ts — Tenant Credit Usage Endpoints
 *
 * GET  /credits/me/usage      Authenticated tenant: per-credit-kind usage
 *                             vs plan limits, in the current period.
 * GET  /credits/me/events     Authenticated tenant: recent ledger rows
 *                             (paginated). Useful for an "Activity" tab.
 *
 * Recording credits is done from feature code via lib/plan-enforcement.ts
 * `recordCreditEvent()` — never via this router.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { creditUsageEventsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { resolveUser } from "../middlewares/resolveUser";
import { getCreditUsage } from "../lib/plan-enforcement";

const router: IRouter = Router();

router.get("/credits/me/usage", resolveUser, async (req, res) => {
  const user = req.resolvedUser!;
  if (!user.tenantId) { res.status(400).json({ error: "User has no tenant" }); return; }
  const usage = await getCreditUsage(user.tenantId);
  res.json(usage);
});

router.get("/credits/me/events", resolveUser, async (req, res) => {
  const user = req.resolvedUser!;
  if (!user.tenantId) { res.status(400).json({ error: "User has no tenant" }); return; }
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const kind = req.query.kind as string | undefined;
  const where = kind
    ? and(eq(creditUsageEventsTable.tenantId, user.tenantId), eq(creditUsageEventsTable.kind, kind as any))
    : eq(creditUsageEventsTable.tenantId, user.tenantId);
  const rows = await db.select().from(creditUsageEventsTable).where(where).orderBy(desc(creditUsageEventsTable.occurredAt)).limit(limit);
  res.json({ events: rows });
});

/* ── Platform-admin: usage across all tenants (rolled up) ───────────────── */
router.get("/credits/admin/usage", resolveUser, async (req, res) => {
  const user = req.resolvedUser!;
  if (user.role !== "platform_admin") { res.status(403).json({ error: "Forbidden" }); return; }
  const sinceDays = Math.min(Number(req.query.sinceDays ?? 30), 365);
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const rows = await db
    .select({
      tenantId: creditUsageEventsTable.tenantId,
      kind:     creditUsageEventsTable.kind,
      units:    sql<number>`coalesce(sum(units), 0)::int`,
    })
    .from(creditUsageEventsTable)
    .where(sql`occurred_at >= ${since}`)
    .groupBy(creditUsageEventsTable.tenantId, creditUsageEventsTable.kind);
  res.json({ sinceDays, rows });
});

export default router;
