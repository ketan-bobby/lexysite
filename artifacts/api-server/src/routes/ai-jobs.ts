/**
 * routes/ai-jobs.ts — AI job queue admin dashboard
 *
 * Staff-gated read + retry endpoints over the `ai_jobs` queue so recruiters /
 * admins can see the health of post-interview AI processing (summaries,
 * scoring, intelligence enrichment, match rescoring) and re-run anything that
 * failed.
 *
 * Tenant scoping mirrors the rest of the interview surface:
 *   • platform_admin sees every job (including queue-internal rows with a null
 *     tenant).
 *   • Other staff see only jobs whose tenant is inside their allowed subtree
 *     (getAllowedTenantIds). Non-staff roles are rejected with 403.
 *
 * Reads/writes use dbAdmin (the queue is cross-tenant by design and these
 * handlers apply their own explicit tenant filter), consistent with lib/ai-queue.
 */
import { Router, type IRouter } from "express";
import {
  controlDb,
  dbAdmin,
  aiJobsTable,
  interviewSessionsTable,
  interviewPlansTable,
  candidatesTable,
  jobsTable,
  usersTable,
} from "@workspace/db";
import { eq, desc, inArray, and, sql } from "drizzle-orm";
import { getAuthUserId } from "../lib/auth-token";
import { getAllowedTenantIds } from "../lib/tenantUtils";
import { retryJob } from "../lib/ai-queue/queue";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const STAFF_ROLES = ["platform_admin", "tenant_admin", "recruiter", "hiring_manager", "interviewer"];

/** Resolve the caller and enforce the staff allowlist. Returns the caller row
 *  and the tenant filter to apply (null = unrestricted / platform_admin). */
async function resolveStaff(
  req: any,
  res: any,
): Promise<{ caller: any; allowedTenants: string[] | null } | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [caller] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!caller) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!STAFF_ROLES.includes(caller.role)) { res.status(403).json({ error: "Forbidden" }); return null; }
  if (caller.role === "platform_admin") return { caller, allowedTenants: null };
  const allowedTenants = await getAllowedTenantIds(caller as any);
  if (!allowedTenants || allowedTenants.length === 0) return { caller, allowedTenants: [] };
  return { caller, allowedTenants };
}

/* GET /admin/ai-jobs/stats — counts by status for the dashboard header. */
router.get("/admin/ai-jobs/stats", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const { allowedTenants } = auth;

  const rows = await dbAdmin
    .select({ status: aiJobsTable.status, count: sql<number>`count(*)::int` })
    .from(aiJobsTable)
    .where(allowedTenants === null ? undefined : inArray(aiJobsTable.tenantId, allowedTenants))
    .groupBy(aiJobsTable.status);

  const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const r of rows) {
    if (r.status && r.status in stats) (stats as any)[r.status] = Number(r.count);
  }
  res.json(stats);
});

/* GET /admin/ai-jobs — recent jobs with their interview/candidate/job context.
   Query: ?status=failed&limit=100 */
router.get("/admin/ai-jobs", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const { allowedTenants } = auth;

  const statusFilter = typeof req.query.status === "string" ? req.query.status : null;
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  const conds: any[] = [];
  if (allowedTenants !== null) conds.push(inArray(aiJobsTable.tenantId, allowedTenants));
  if (statusFilter && ["pending", "processing", "completed", "failed"].includes(statusFilter)) {
    conds.push(eq(aiJobsTable.status, statusFilter as any));
  }

  const rows = await dbAdmin
    .select({
      id: aiJobsTable.id,
      type: aiJobsTable.type,
      status: aiJobsTable.status,
      retryCount: aiJobsTable.retryCount,
      maxAttempts: aiJobsTable.maxAttempts,
      lastError: aiJobsTable.lastError,
      priority: aiJobsTable.priority,
      runAt: aiJobsTable.runAt,
      lockedBy: aiJobsTable.lockedBy,
      startedAt: aiJobsTable.startedAt,
      completedAt: aiJobsTable.completedAt,
      createdAt: aiJobsTable.createdAt,
      updatedAt: aiJobsTable.updatedAt,
      tenantId: aiJobsTable.tenantId,
      interviewSessionId: aiJobsTable.interviewSessionId,
      candidateFirstName: candidatesTable.firstName,
      candidateLastName: candidatesTable.lastName,
      jobTitle: jobsTable.title,
    })
    .from(aiJobsTable)
    .leftJoin(interviewSessionsTable, eq(interviewSessionsTable.id, aiJobsTable.interviewSessionId))
    .leftJoin(candidatesTable, eq(candidatesTable.id, interviewSessionsTable.candidateId))
    .leftJoin(interviewPlansTable, eq(interviewPlansTable.id, interviewSessionsTable.planId))
    .leftJoin(jobsTable, eq(jobsTable.id, interviewPlansTable.jobId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(aiJobsTable.createdAt))
    .limit(limit);

  res.json(
    rows.map((r) => ({
      ...r,
      candidateName:
        [r.candidateFirstName, r.candidateLastName].filter(Boolean).join(" ").trim() || null,
      runAt: r.runAt?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
      updatedAt: r.updatedAt?.toISOString() ?? null,
    })),
  );
});

/* POST /admin/ai-jobs/:jobId/retry — re-queue a job (typically a failed one). */
router.post("/admin/ai-jobs/:jobId/retry", async (req: any, res) => {
  res.setHeader("Cache-Control", "no-store");
  const auth = await resolveStaff(req, res);
  if (!auth) return;
  const { allowedTenants } = auth;

  /* Authorize the specific job against the caller's tenant scope before touching it. */
  const [job] = await dbAdmin
    .select({ id: aiJobsTable.id, tenantId: aiJobsTable.tenantId })
    .from(aiJobsTable)
    .where(eq(aiJobsTable.id, req.params.jobId))
    .limit(1);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  if (allowedTenants !== null) {
    if (!job.tenantId || !allowedTenants.includes(job.tenantId)) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
  }

  const updated = await retryJob(job.id);
  if (!updated) { res.status(404).json({ error: "Job not found" }); return; }
  logger.info({ jobId: job.id, by: auth.caller.id }, "[ai-queue] job manually retried");
  res.json({ ok: true, id: updated.id, status: updated.status });
});

export default router;
