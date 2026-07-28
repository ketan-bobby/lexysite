/**
 * routes/ai-workorder.ts — Workorder (Job) AI Context CRUD (T004)
 *
 * GET/PUT /jobs/:jobId/ai-context — 1:1 upsert of per-role context that AI
 * message generation prioritises OVER the tenant brand profile on conflict.
 * The owning tenant is derived from the job (never trusted from the body), and
 * access is tenant-scoped via getAllowedTenantIds. Open to recruiter / HM /
 * tenant_admin / platform_admin.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { workorderAiContextsTable, jobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { getAllowedTenantIds } from "../lib/tenantUtils";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

const workModelValues = ["remote", "hybrid", "onsite"] as const;
const urgencyValues = ["low", "medium", "high", "critical"] as const;

const ContextBody = z.object({
  projectName: z.string().max(300).nullish(),
  department: z.string().max(300).nullish(),
  hiringManager: z.string().max(300).nullish(),
  whyRoleExists: z.string().max(8000).nullish(),
  businessProblem: z.string().max(8000).nullish(),
  teamDescription: z.string().max(8000).nullish(),
  projectDescription: z.string().max(8000).nullish(),
  techStack: z.string().max(4000).nullish(),
  mustHaveSkills: z.string().max(4000).nullish(),
  niceToHaveSkills: z.string().max(4000).nullish(),
  candidateSellingPoints: z.string().max(8000).nullish(),
  candidateConcerns: z.string().max(8000).nullish(),
  interviewProcess: z.string().max(8000).nullish(),
  compensationNotes: z.string().max(4000).nullish(),
  workModel: z.enum(workModelValues).nullish(),
  urgencyLevel: z.enum(urgencyValues).nullish(),
  hiringManagerPreferences: z.string().max(8000).nullish(),
  messagingAngle: z.string().max(4000).nullish(),
  aiInstructions: z.string().max(4000).nullish(),
});

async function loadJobIfAllowed(
  user: { role: string; tenantId: string | null },
  jobId: string,
): Promise<{ id: string; tenantId: string } | null> {
  const [job] = await db
    .select({ id: jobsTable.id, tenantId: jobsTable.tenantId })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);
  if (!job) return null;
  const allowed = await getAllowedTenantIds(user);
  if (allowed !== null && !allowed.includes(job.tenantId)) return null;
  return job;
}

// ── GET — read this job's AI context (null when none has been saved yet) ──────
router.get(
  "/jobs/:jobId/ai-context",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  async (req, res) => {
    const user = req.resolvedUser!;
    const job = await loadJobIfAllowed(user, req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const [context] = await db
      .select()
      .from(workorderAiContextsTable)
      .where(eq(workorderAiContextsTable.jobId, job.id))
      .limit(1);
    return res.json({ context: context ?? null });
  },
);

// ── PUT — upsert (1:1 on jobId) the per-role context, audited on every save ───
router.put(
  "/jobs/:jobId/ai-context",
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter", "hiring_manager"),
  validate({ body: ContextBody }),
  async (req, res) => {
    const user = req.resolvedUser!;
    const job = await loadJobIfAllowed(user, req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const body = req.body as z.infer<typeof ContextBody>;
    const patch = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    );
    const now = new Date();
    const [saved] = await db
      .insert(workorderAiContextsTable)
      .values({ ...patch, jobId: job.id, tenantId: job.tenantId, updatedById: user.id, updatedAt: now })
      .onConflictDoUpdate({
        target: workorderAiContextsTable.jobId,
        set: { ...patch, updatedById: user.id, updatedAt: now },
      })
      .returning();
    await recordAudit({
      tenantId: job.tenantId,
      actorType: "user",
      actorId: user.id,
      channel: "system",
      direction: "internal",
      action: "workorder_ai_context.upsert",
      title: "Workorder AI context saved",
      metadata: { jobId: job.id },
    });
    return res.json({ context: saved });
  },
);

export default router;
