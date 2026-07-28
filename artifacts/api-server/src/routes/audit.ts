/**
 * routes/audit.ts — Audit Log Query API
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Read-only REST API for querying the audit_logs table. Used by the Audit
 * page in the recruiter dashboard to show a compliance-grade tamper-evident
 * trail of all emails sent, AI decisions made, stage changes, and access events.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET /audit-logs   List audit log entries with rich filtering.
 *
 * ─── Query parameters ────────────────────────────────────────────────────────
 *   subjectType / subjectId   Filter by who the event was about
 *   actorType / actorId       Filter by who triggered the event
 *   channel                   "email" | "in_app" | "sms" | "webhook" | "system"
 *   direction                 "outbound" | "inbound" | "internal"
 *   action                    Exact action slug (e.g. "outreach.send")
 *   actionPrefix              Prefix match (e.g. "outreach." returns all outreach events)
 *   from / to                 ISO timestamp bounds on created_at
 *   limit                     Default 100, max 500
 *
 * ─── Tenant scoping ──────────────────────────────────────────────────────────
 * platform_admin sees all rows.
 * Tenant users see only rows where tenantId matches their own tenant.
 * Null tenantId rows (platform-level system events) are only visible to
 * platform_admin.
 */
import { Router, type IRouter } from "express";
import { controlDb, db, auditLogsTable, usersTable } from "@workspace/db";
import { and, desc, eq, sql, gte, lte } from "drizzle-orm";
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
 * GET /audit-logs — list audit-trail entries.
 * Query params (all optional):
 *   subjectType, subjectId       — filter by who the message was addressed to
 *   actorType, actorId           — filter by who produced the message
 *   channel                      — "email" | "in_app" | "sms" | "webhook" | "system"
 *   direction                    — "outbound" | "inbound" | "internal"
 *   action                       — exact action slug, or pass `actionPrefix` for prefix match
 *   actionPrefix                 — e.g. "notification." or "email."
 *   from, to                     — ISO timestamps to bound created_at
 *   limit (default 100, max 500)
 */
router.get("/audit-logs", async (req: any, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const q = req.query as Record<string, string | undefined>;
  const limit = Math.min(Number(q.limit ?? 100), 500);

  const conds: any[] = [];
  /* Tenancy isolation — fail-closed.
   *   • platform_admin   → no tenant filter (sees all rows incl. null-tenant)
   *   • tenant user      → restricted to their own tenant_id
   *   • non-admin with NO tenantId → returns nothing (would otherwise leak
   *     cross-tenant rows). This is the bug the previous version had:
   *     `if (user.role !== "platform_admin" && user.tenantId)` skipped the
   *     filter entirely when tenantId was null. */
  if (user.role !== "platform_admin") {
    if (!user.tenantId) {
      res.json({ items: [], count: 0 });
      return;
    }
    conds.push(eq(auditLogsTable.tenantId, user.tenantId));
  }
  if (q.subjectType) conds.push(eq(auditLogsTable.subjectType, q.subjectType));
  if (q.subjectId) conds.push(eq(auditLogsTable.subjectId, q.subjectId));
  if (q.actorType) conds.push(eq(auditLogsTable.actorType, q.actorType));
  if (q.actorId) conds.push(eq(auditLogsTable.actorId, q.actorId));
  if (q.channel) conds.push(eq(auditLogsTable.channel, q.channel));
  if (q.direction) conds.push(eq(auditLogsTable.direction, q.direction));
  if (q.action) conds.push(eq(auditLogsTable.action, q.action));
  if (q.actionPrefix) conds.push(sql`${auditLogsTable.action} LIKE ${q.actionPrefix + "%"}`);
  if (q.from) conds.push(gte(auditLogsTable.createdAt, new Date(q.from)));
  if (q.to) conds.push(lte(auditLogsTable.createdAt, new Date(q.to)));

  const rows = await db.select().from(auditLogsTable)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit);

  res.json({ items: rows, count: rows.length });
});

export default router;
