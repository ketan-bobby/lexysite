/**
 * routes/agents.ts — Agent Dashboard & Pipeline Execution API
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API that surfaces the agent orchestrator to the frontend. Provides
 * status data for the Agent Dashboard page and trigger endpoints so recruiters
 * can run individual agents or multi-agent selections against a specific job.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /agents                        Agent registry: statuses + recent runs + events
 *   GET  /agents/runs                   Recent runs (filterable by agentId)
 *   POST /agents/:agentId/run           Run a single agent (202 async, creates a
 *                                       pipeline_runs row immediately)
 *   POST /agents/run-selection          Run a custom subset of agents in pipeline order
 *   GET  /agents/runs/:runId            Status of a specific run
 *   GET  /agents/stats                  Aggregate stats for the dashboard widgets
 *   GET  /agents/activity               Platform-wide recent activity feed
 *
 * ─── Canonical agent order ───────────────────────────────────────────────────
 * AGENT_ORDER ensures that no matter which subset the recruiter selects for
 * /agents/run-selection, agents execute in the correct pipeline order:
 *   icp(1) → sourcing(2) → screening(3) → verification(4) → outreach(5) →
 *   scheduling(6) → interview(7) → proctoring(8) → anti-ghosting(9)
 *
 * Analytics is registered (legacy) but is not part of the runnable pipeline —
 * it's a results dashboard surfaced in the Intelligence tab.
 *
 * The ordering note in the code calls out why verification must precede
 * interview: the interview agent's Gate 2 eligibility check rejects candidates
 * whose verification_status is not yet "verified".
 *
 * ─── Async run pattern ───────────────────────────────────────────────────────
 * POST /agents/:agentId/run responds 202 with the runId immediately, then
 * fires setImmediate() to execute orchestrator.runPipeline() without blocking
 * the HTTP response. The frontend polls GET /agents/runs/:runId to track
 * progress. On completion the pipeline_runs row is stamped status="completed"
 * or status="failed".
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, controlDb } from "@workspace/db";
import { pipelineRunsTable, jobPipelinesTable, jobsTable, candidatesTable, applicationsTable, interviewSessionsTable, outreachMessagesTable, usersTable } from "@workspace/db";
import { eq, desc, and, ne, isNotNull, count, sql, inArray } from "drizzle-orm";
import { orchestrator, type AgentId, type AgentRun } from "../lib/agents/orchestrator";
import { validate } from "../middlewares/validate";
import { getAuthUserId } from "../lib/auth-token";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { getPersistedRecentRuns, mergeRuns, getPersistedActivity, mergeActivity } from "../lib/pipeline-runs/read";
import { logger } from "../lib/logger";

const RunAgentBody = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().optional(),
  triggeredBy: z.string().optional(),
}).passthrough();

const RunSelectionBody = z.object({
  agentIds: z.array(z.string().min(1)).min(1),
  jobId: z.string().min(1),
  candidateId: z.string().optional(),
}).passthrough();

const PipelineConfigBody = z.object({
  agentIds: z.array(z.string()),
  autoRun: z.boolean().optional(),
  targetCandidates: z.number().optional(),
  interviewTypes: z.array(z.string()).optional(),
}).passthrough();

const router: IRouter = Router();

const VALID_IDS: AgentId[] = ["icp", "sourcing", "screening", "interview", "proctoring", "outreach", "anti-ghosting", "verification", "scheduling", "analytics"];

/* Canonical execution order for the pipeline builder.
 * Order matches the hiring funnel + the kanban stages:
 *   sourced → screening → verification → outreach → interview → scheduling
 * Verification MUST run before interview because the interview agent's
 * eligibility check rejects manual candidates whose verification_status is
 * not yet "verified" (see orchestrator._runInterview Gate 2). */
const AGENT_ORDER: Record<string, number> = {
  icp: 1, sourcing: 2, screening: 3, verification: 4, outreach: 5,
  scheduling: 6, interview: 7, proctoring: 8, "anti-ghosting": 9,
  // Analytics kept at the tail purely so any legacy saved configs
  // referencing it sort to the end; orchestrator no-ops on it.
  analytics: 99,
};

/* Roles allowed to READ agent operations. Deliberately excludes `candidate`
 * and `interviewer` — neither has any business seeing recruiting-agent activity
 * (sourcing, screening, outreach) across a tenant. Recruiter-class + admins only. */
const AGENT_VIEW_ROLES = ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"];
// WRITE roles for triggering agent runs. Recruiter-class only — a hiring
// manager can VIEW the dashboard but must not kick off pipeline runs, and
// candidate/interviewer are excluded entirely.
const AGENT_WRITE_ROLES = ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter"];

/* Resolve the caller for the agent read endpoints. Mirrors the auth pattern in
 * routes/recruiter-avatar.ts / routes/ai-jobs.ts: bearer → users row (source of
 * truth, never the token claims) → role allowlist → data-scope tenant subtree.
 * Returns `allowed` = the tenant ids the caller may see (null = platform_admin,
 * sees all). Writes the 401/403 response itself and returns null on rejection.
 *
 * These GET routes read the orchestrator's IN-MEMORY run/event history, which is
 * never touched by the RLS-scoped `db` connection — so RLS cannot scope it and
 * withTenantContext's fail-closed proxy never fires (no db call). Authorization
 * and tenant scoping MUST therefore be enforced here, explicitly.
 *
 * TODO(agents-dashboard-persistence): the dashboard run feed should read the
 * persisted `pipeline_runs` table (already tenant-stamped + RLS-scoped) instead
 * of this process-memory array, so history survives restarts and isolation is
 * enforced by the database rather than in-process filtering. Deferred — larger
 * migration than this security fix; tracked as a follow-up, not done here. */
async function resolveAgentViewer(
  req: any,
  res: any,
): Promise<{ caller: any; allowed: string[] | null } | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [caller] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!caller) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!AGENT_VIEW_ROLES.includes(caller.role)) { res.status(403).json({ error: "Forbidden" }); return null; }
  // getDataScopeTenantIds → null for platform_admin (means "see all"), else the
  // caller's assigned/subtree scope (recruiter_admin narrowed to assigned
  // clients). Preserve null as-is — coercing it to [] would hide EVERYTHING
  // from a platform admin (see _isVisible: null = global, [] = nothing).
  const allowed = await getDataScopeTenantIds(caller as any);
  return { caller, allowed };
}

/* Interim role gate for the agent WRITE routes (run / run-selection). Resolves
 * the caller from the bearer token → users row and requires a recruiter-class
 * role. Recruiter-OWNERSHIP (may THIS recruiter run agents on THIS job) is
 * deliberately NOT enforced here — that arrives with the Tier 2 middleware.
 * Returns the caller row, or null after sending 401/403. */
async function requireAgentWriter(req: any, res: any): Promise<any | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [caller] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!caller) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!AGENT_WRITE_ROLES.includes(caller.role)) { res.status(403).json({ error: "Forbidden" }); return null; }
  return caller;
}

/* Resolve triggered_by_user_id → a display name so the run history UI can show
 * "Triggered by {user}" instead of an opaque id. Best-effort + batched: one
 * lookup for all runs; users live in the control DB (see controlDb usage above).
 * Runs with no triggering user (scheduler/system) get triggeredByUser: null. */
async function withTriggeredByUser(runs: AgentRun[]): Promise<Array<AgentRun & { triggeredByUser: string | null }>> {
  const ids = [...new Set(runs.map(r => r.triggeredByUserId).filter((x): x is string => !!x))];
  const nameById = new Map<string, string>();
  if (ids.length > 0) {
    try {
      const rows = await controlDb
        .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.id, ids));
      for (const u of rows) nameById.set(u.id, u.name || u.email);
    } catch { /* best-effort — fall back to null (UI shows coarse triggeredBy) */ }
  }
  return runs.map(r => ({
    ...r,
    triggeredByUser: r.triggeredByUserId ? (nameById.get(r.triggeredByUserId) ?? null) : null,
  }));
}

/* Persisted-first run history (Part 3): the durable pipeline_runs data is the
 * source of truth; the orchestrator's in-memory buffer is a hot cache that only
 * contributes entries newer than the newest persisted one (in-flight freshness)
 * or fills in entirely when nothing is persisted for this scope. mergeRuns/
 * getPersistedRecentRuns apply the same `allowed` visibility gate the
 * orchestrator uses (null = platform sees all, [] = nothing). */
async function getAgentHubRuns(allowed: string[] | null, limit: number): Promise<AgentRun[]> {
  const [persisted, cache] = await Promise.all([
    getPersistedRecentRuns(allowed, limit),
    Promise.resolve(orchestrator.getRecentRuns(limit, allowed)),
  ]);
  return mergeRuns(persisted, cache, limit);
}

async function getAgentHubActivity(allowed: string[] | null, limit: number) {
  const persisted = await getPersistedActivity(allowed, limit);
  return mergeActivity(persisted, orchestrator.getEvents(limit, allowed), limit);
}

router.get("/agents", async (req, res) => {
  const viewer = await resolveAgentViewer(req, res);
  if (!viewer) return;
  const { allowed } = viewer;
  res.json({
    agents: orchestrator.getAgentStatuses(allowed),
    recentRuns: await withTriggeredByUser(await getAgentHubRuns(allowed, 10)),
    events: await getAgentHubActivity(allowed, 20),
  });
});

router.get("/agents/runs", async (req, res) => {
  const viewer = await resolveAgentViewer(req, res);
  if (!viewer) return;
  const { agentId, limit } = req.query;
  let runs = await getAgentHubRuns(viewer.allowed, Number(limit) || 50);
  if (agentId) runs = runs.filter(r => r.agentId === agentId);
  res.json(await withTriggeredByUser(runs));
});

router.post("/agents/:agentId/run", validate({ body: RunAgentBody }), async (req, res) => {
  const caller = await requireAgentWriter(req, res);
  if (!caller) return;
  const { agentId } = req.params;
  if (!VALID_IDS.includes(agentId as AgentId)) {
    return res.status(400).json({ error: "Unknown agent ID" });
  }
  const { jobId, candidateId, triggeredBy: overrideTriggeredBy } = req.body || {};
  if (!jobId) return res.status(400).json({ error: "jobId is required" });

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) return res.status(404).json({ error: "Job not found" });

  // Resolve a caller-supplied candidateId so it, too, can be tenant-gated
  // before it is fed into the pipeline config.
  let cand: { tenantId: string | null } | undefined;
  if (candidateId) {
    [cand] = await db.select({ tenantId: candidatesTable.tenantId })
      .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!cand) return res.status(404).json({ error: "Not found" });
  }

  // Tenant-membership gate — copied from gateJobAccess (routes/pipeline.ts):
  // the caller's data scope must own the job's tenant (and the candidate's
  // tenant when supplied), else 404. platform_admin sees all. Recruiter-
  // OWNERSHIP (assigned-to-this-req) is deferred to the Tier 2 middleware.
  if (caller.role !== "platform_admin") {
    const allowed = (await getDataScopeTenantIds(caller)) ?? [];
    if (!allowed.includes(job.tenantId ?? "")) {
      return res.status(404).json({ error: "Not found" });
    }
    if (cand && !allowed.includes(cand.tenantId ?? "")) {
      return res.status(404).json({ error: "Not found" });
    }
  }
  /* Plain-recruiter ceiling: the requisition must be ASSIGNED to the caller
     (Tier 2 assigned-to-this-req gate). Returns true for every non-recruiter.
     A supplied candidateId must ALSO be reachable via an assigned req. */
  if (!(await recruiterOwnsResource(caller, { kind: "jobId", value: jobId }))) {
    return res.status(404).json({ error: "Not found" });
  }
  if (candidateId && !(await recruiterOwnsResource(caller, { kind: "candidateId", value: candidateId }))) {
    return res.status(404).json({ error: "Not found" });
  }

  const enabledAgents = [{ id: agentId as AgentId, order: 1, config: candidateId ? { candidateId } : {} }];

  // Default to "user" (a recruiter clicked Run); allow callers to simulate an
  // automated source like "orchestrator" or "scheduler" so notification routing
  // (real-time vs. digest) can be tested.
  const triggeredBy = overrideTriggeredBy || "user";
  // Capture the caller (if a token is present) so the in-memory AgentRun records
  // carry triggering-user provenance. Non-gating here — this route's role/
  // ownership authorization is handled separately (Tier 2 write-path work).
  const triggeredByUserId = getAuthUserId(req);

  const [run] = await db.insert(pipelineRunsTable).values({
    jobId,
    tenantId: job.tenantId,
    triggeredBy,
    triggeredByUserId,
    status: "running",
    stages: [{ agentId, status: "pending", startedAt: null, completedAt: null, output: null }],
  }).returning();

  res.status(202).json({ runId: run.id, jobId, agentId, triggeredBy, message: `Running ${agentId}` });

  setImmediate(async () => {
    try {
      await orchestrator.runPipeline(jobId, run.id, enabledAgents, triggeredBy, {
        tenantId: job.tenantId,
        triggeredByUserId,
      });
      await db.update(pipelineRunsTable).set({ status: "completed", completedAt: new Date() }).where(eq(pipelineRunsTable.id, run.id));
    } catch (err: any) {
      await db.update(pipelineRunsTable).set({ status: "failed", completedAt: new Date(), error: err?.message }).where(eq(pipelineRunsTable.id, run.id));
    }
  });
});

/* POST /agents/run-selection
 * Run a custom subset of agents against a specific job (and optional candidate).
 * agentIds are sorted into their canonical pipeline order before execution. */
router.post("/agents/run-selection", validate({ body: RunSelectionBody }), async (req, res) => {
  const caller = await requireAgentWriter(req, res);
  if (!caller) return;
  const { agentIds, jobId, candidateId } = req.body as {
    agentIds: string[];
    jobId: string;
    candidateId?: string;
  };

  if (!Array.isArray(agentIds) || agentIds.length === 0) {
    return res.status(400).json({ error: "agentIds must be a non-empty array" });
  }
  if (!jobId) {
    return res.status(400).json({ error: "jobId is required" });
  }

  const invalid = agentIds.filter(id => !VALID_IDS.includes(id as AgentId));
  if (invalid.length > 0) {
    return res.status(400).json({ error: `Unknown agent IDs: ${invalid.join(", ")}` });
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) return res.status(404).json({ error: "Job not found" });

  // Resolve a caller-supplied candidateId so it, too, can be tenant-gated
  // before it is fed into the pipeline config.
  let cand: { tenantId: string | null } | undefined;
  if (candidateId) {
    [cand] = await db.select({ tenantId: candidatesTable.tenantId })
      .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!cand) return res.status(404).json({ error: "Not found" });
  }

  // Tenant-membership gate — copied from gateJobAccess (routes/pipeline.ts):
  // the caller's data scope must own the job's tenant (and the candidate's
  // tenant when supplied), else 404. platform_admin sees all. Recruiter-
  // OWNERSHIP (assigned-to-this-req) is deferred to the Tier 2 middleware.
  if (caller.role !== "platform_admin") {
    const allowed = (await getDataScopeTenantIds(caller)) ?? [];
    if (!allowed.includes(job.tenantId ?? "")) {
      return res.status(404).json({ error: "Not found" });
    }
    if (cand && !allowed.includes(cand.tenantId ?? "")) {
      return res.status(404).json({ error: "Not found" });
    }
  }
  /* Plain-recruiter ceiling: the requisition must be ASSIGNED to the caller
     (Tier 2 assigned-to-this-req gate). Returns true for every non-recruiter.
     A supplied candidateId must ALSO be reachable via an assigned req. */
  if (!(await recruiterOwnsResource(caller, { kind: "jobId", value: jobId }))) {
    return res.status(404).json({ error: "Not found" });
  }
  if (candidateId && !(await recruiterOwnsResource(caller, { kind: "candidateId", value: candidateId }))) {
    return res.status(404).json({ error: "Not found" });
  }

  // Provenance for the in-memory AgentRun records (see POST /agents/:agentId/run).
  const triggeredByUserId = getAuthUserId(req);

  const ordered = [...agentIds].sort((a, b) => (AGENT_ORDER[a] ?? 99) - (AGENT_ORDER[b] ?? 99));
  const enabledAgents = ordered.map((id, i) => ({ id, order: i + 1, config: candidateId ? { candidateId } : {} }));

  const [run] = await db.insert(pipelineRunsTable).values({
    jobId,
    tenantId: job.tenantId,
    triggeredBy: "user",
    triggeredByUserId,
    status: "running",
    stages: enabledAgents.map(a => ({ agentId: a.id, status: "pending", startedAt: null, completedAt: null, output: null })),
  }).returning();

  res.status(202).json({
    runId: run.id,
    jobId,
    stages: ordered,
    message: `Running ${ordered.length} agent${ordered.length > 1 ? "s" : ""}: ${ordered.join(" → ")}`,
  });

  setImmediate(async () => {
    try {
      // Mark pipeline as running
      const [jobForPipeline] = await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
      if (jobForPipeline) await upsertPipelineRow(jobId, jobForPipeline.tenantId, { status: "running", currentStage: ordered[0] ?? null });

      await orchestrator.runPipeline(jobId, run.id, enabledAgents, "user", {
        tenantId: job.tenantId,
        triggeredByUserId,
      });
      await db.update(pipelineRunsTable).set({ status: "completed", completedAt: new Date() }).where(eq(pipelineRunsTable.id, run.id));

      // ── Auto-rerun logic ──────────────────────────────────────────────────
      const [pipelineCfg] = await db.select().from(jobPipelinesTable).where(eq(jobPipelinesTable.jobId, jobId)).limit(1);
      const tenantId = pipelineCfg?.tenantId ?? job.tenantId;

      if (pipelineCfg?.autoRun) {
        const viable = await countViableCandidates(jobId);
        const target = pipelineCfg.targetCandidates ?? 5;
        const hasSourcingAgents = ordered.some(id => ["sourcing", "screening"].includes(id));

        if (viable >= target || !hasSourcingAgents) {
          // Target met — stop auto-run
          await upsertPipelineRow(jobId, tenantId, { status: "completed", autoRun: false, currentStage: null });
        } else {
          // Below target — re-run sourcing + screening
          const reruns = ordered.filter(id => ["sourcing", "screening"].includes(id));
          const rerunAgents = reruns.map((id, i) => ({ id: id as AgentId, order: i + 1, config: {} }));
          const [rerun] = await db.insert(pipelineRunsTable).values({
            jobId, tenantId,
            triggeredBy: "auto",
            // Carry the human who kicked off the chain — the auto-rerun's
            // provenance is the original initiator, even though triggeredBy="auto".
            triggeredByUserId,
            status: "running",
            stages: rerunAgents.map(a => ({ agentId: a.id, status: "pending", startedAt: null, completedAt: null, output: null })),
          }).returning();
          await upsertPipelineRow(jobId, tenantId, { status: "running", currentStage: reruns[0] });
          orchestrator.runPipeline(jobId, rerun.id, rerunAgents, "auto", {
            tenantId,
            triggeredByUserId,
          }).then(async () => {
            await db.update(pipelineRunsTable).set({ status: "completed", completedAt: new Date() }).where(eq(pipelineRunsTable.id, rerun.id));
            const v2 = await countViableCandidates(jobId);
            await upsertPipelineRow(jobId, tenantId, {
              status: v2 >= target ? "completed" : "idle",
              autoRun: v2 < target,
              currentStage: null,
            });
          }).catch(async () => {
            await db.update(pipelineRunsTable).set({ status: "failed", completedAt: new Date() }).where(eq(pipelineRunsTable.id, rerun.id));
            await upsertPipelineRow(jobId, tenantId, { status: "idle", currentStage: null });
          });
        }
      } else {
        if (jobForPipeline) await upsertPipelineRow(jobId, jobForPipeline.tenantId, { status: "idle", currentStage: null });
      }
    } catch (err: any) {
      await db.update(pipelineRunsTable).set({ status: "failed", completedAt: new Date(), error: err?.message }).where(eq(pipelineRunsTable.id, run.id));
      try {
        const [j] = await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
        if (j) await upsertPipelineRow(jobId, j.tenantId, { status: "failed", currentStage: null });
      } catch (cleanupErr: any) {
        // Best-effort cleanup: the run row is already marked failed above; if
        // the pipeline-status row can't be updated too, log it so a stale
        // "running" pipeline in the UI is traceable instead of silent.
        logger.warn(
          { jobId, runId: run.id, err: cleanupErr?.message },
          "[agents] failed to mark pipeline row failed after run failure",
        );
      }
    }
  });
});

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Count viable candidates for a job: screened applications not rejected/withdrawn */
async function countViableCandidates(jobId: string): Promise<number> {
  const rows = await db
    .select({ cnt: count() })
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.jobId, jobId),
        isNotNull(applicationsTable.matchScore),
        ne(applicationsTable.stage, "rejected"),
        ne(applicationsTable.stage, "withdrawn"),
      ),
    );
  return rows[0]?.cnt ?? 0;
}

/** Upsert a job_pipelines row */
async function upsertPipelineRow(
  jobId: string,
  tenantId: string,
  patch: Partial<{
    agents: string[];
    autoRun: boolean;
    targetCandidates: number;
    status: string;
    currentStage: string;
    interviewTypes: string[];
    interviewDirection: Record<string, { focusDirective?: string; customQuestions?: string[] }>;
  }>,
) {
  const existing = await db
    .select({ id: jobPipelinesTable.id })
    .from(jobPipelinesTable)
    .where(eq(jobPipelinesTable.jobId, jobId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(jobPipelinesTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(jobPipelinesTable.jobId, jobId));
  } else {
    await db.insert(jobPipelinesTable).values({
      jobId,
      tenantId,
      agents: patch.agents ?? [],
      autoRun: patch.autoRun ?? false,
      targetCandidates: patch.targetCandidates ?? 5,
      status: patch.status ?? "idle",
      /* Persist interview-type selection on FIRST save too — earlier this
       * was missing, so brand-new jobs silently dropped the recruiter's
       * choice and fell back to "general" on first interview run. */
      interviewTypes: patch.interviewTypes ?? [],
      /* Same for recruiter interview direction — without this, the FIRST
       * "Interview Setup" save on a brand-new job (no job_pipelines row yet)
       * would fall through to the column default {} and silently lose the
       * recruiter's focus + custom questions. */
      interviewDirection: patch.interviewDirection ?? {},
    });
  }
}

/* ── Pipeline config: load/save which agents + settings are enabled ──────── */

router.get("/jobs/:jobId/pipeline-config", async (req, res) => {
  const { jobId } = req.params;
  const [row] = await db.select().from(jobPipelinesTable).where(eq(jobPipelinesTable.jobId, jobId)).limit(1);
  return res.json({
    agentIds:         (row?.agents as string[]) ?? [],
    /* Persisted interview sub-types selected on the Workflow Canvas
     * (e.g. ["cultural"]). Empty array → orchestrator falls back to the
     * "general" question set. */
    interviewTypes:   (row?.interviewTypes as string[]) ?? [],
    /* Per-type + _default recruiter interview direction (focus + custom
     * questions), surfaced in the Workflow configurator and pipeline. */
    interviewDirection: (row?.interviewDirection as Record<string, any>) ?? {},
    autoRun:          row?.autoRun ?? false,
    targetCandidates: row?.targetCandidates ?? 5,
    status:           row?.status ?? "idle",
    currentStage:     row?.currentStage ?? null,
  });
});

router.post("/jobs/:jobId/pipeline-config", validate({ body: PipelineConfigBody }), async (req, res) => {
  const { jobId } = req.params;
  const { agentIds, autoRun, targetCandidates, interviewTypes } = req.body as {
    agentIds: string[];
    autoRun?: boolean;
    targetCandidates?: number;
    interviewTypes?: string[];
  };
  if (!Array.isArray(agentIds)) return res.status(400).json({ error: "agentIds must be an array" });

  /* Whitelist what we accept so a malformed/exotic value can't end up in
   * the orchestrator's interviewType switch. Anything outside this set is
   * silently dropped. */
  const ALLOWED_INTERVIEW_TYPES = new Set(["behavioral", "cultural", "technical", "programming"]);
  const cleanedTypes = Array.isArray(interviewTypes)
    ? interviewTypes.filter((t): t is string => typeof t === "string" && ALLOWED_INTERVIEW_TYPES.has(t))
    : undefined;

  const [job] = await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) return res.status(404).json({ error: "Job not found" });

  await upsertPipelineRow(jobId, job.tenantId, {
    agents: agentIds,
    ...(autoRun !== undefined ? { autoRun } : {}),
    ...(targetCandidates !== undefined ? { targetCandidates } : {}),
    ...(cleanedTypes !== undefined ? { interviewTypes: cleanedTypes } : {}),
  });
  return res.json({ ok: true });
});

/* ── Interview direction: recruiter focus + custom questions per job ──────── */

const ALLOWED_DIRECTION_KEYS = new Set([
  "behavioral", "cultural", "technical", "programming", "general", "_default",
]);

const InterviewDirectionBody = z.object({
  type: z.string(),
  focusDirective: z.string().max(2000).optional(),
  customQuestions: z.array(z.string().max(500)).max(20).optional(),
});

router.get("/jobs/:jobId/interview-direction", async (req, res) => {
  const { jobId } = req.params;
  const [row] = await db
    .select({ interviewDirection: jobPipelinesTable.interviewDirection })
    .from(jobPipelinesTable)
    .where(eq(jobPipelinesTable.jobId, jobId))
    .limit(1);
  return res.json({ interviewDirection: (row?.interviewDirection as Record<string, any>) ?? {} });
});

router.post("/jobs/:jobId/interview-direction", validate({ body: InterviewDirectionBody }), async (req, res) => {
  const { jobId } = req.params;
  const { type, focusDirective, customQuestions } = req.body as {
    type: string; focusDirective?: string; customQuestions?: string[];
  };
  if (!ALLOWED_DIRECTION_KEYS.has(type)) {
    return res.status(400).json({ error: `Invalid interview direction key: ${type}` });
  }

  const [job] = await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) return res.status(404).json({ error: "Job not found" });

  /* Merge into the existing map so other types' direction is preserved. Empty
   * focus + no questions removes the entry to keep the map tidy. */
  const [existing] = await db
    .select({ interviewDirection: jobPipelinesTable.interviewDirection })
    .from(jobPipelinesTable)
    .where(eq(jobPipelinesTable.jobId, jobId))
    .limit(1);
  const current = { ...((existing?.interviewDirection as Record<string, any>) ?? {}) };

  const cleanFocus = (focusDirective ?? "").trim();
  const cleanQuestions = (customQuestions ?? []).map((q) => (q ?? "").trim()).filter(Boolean);
  if (!cleanFocus && cleanQuestions.length === 0) {
    delete current[type];
  } else {
    current[type] = { focusDirective: cleanFocus, customQuestions: cleanQuestions };
  }

  await upsertPipelineRow(jobId, job.tenantId, { interviewDirection: current });
  return res.json({ ok: true, interviewDirection: current });
});

/* ── Pipeline status: viable count, running state ────────────────────────── */

router.get("/jobs/:jobId/pipeline-status", async (req, res) => {
  const { jobId } = req.params;
  const [row] = await db.select().from(jobPipelinesTable).where(eq(jobPipelinesTable.jobId, jobId)).limit(1);
  const viableCount = await countViableCandidates(jobId);

  // Check if there's an active run in the DB. Fall back to the most recent
  // run (any status) so the UI can keep showing the final completed/failed
  // chip strip for a few seconds after the pipeline finishes — otherwise
  // the live status flashes and disappears too fast to see.
  const [activeRun] = await db
    .select({ id: pipelineRunsTable.id, status: pipelineRunsTable.status, stages: pipelineRunsTable.stages, startedAt: pipelineRunsTable.startedAt })
    .from(pipelineRunsTable)
    .where(and(eq(pipelineRunsTable.jobId, jobId), eq(pipelineRunsTable.status, "running")))
    .orderBy(desc(pipelineRunsTable.startedAt))
    .limit(1);

  let recentRun = activeRun;
  if (!recentRun) {
    const [r] = await db
      .select({ id: pipelineRunsTable.id, status: pipelineRunsTable.status, stages: pipelineRunsTable.stages, startedAt: pipelineRunsTable.startedAt })
      .from(pipelineRunsTable)
      .where(eq(pipelineRunsTable.jobId, jobId))
      .orderBy(desc(pipelineRunsTable.startedAt))
      .limit(1);
    recentRun = r;
  }

  return res.json({
    status:           row?.status ?? "idle",
    currentStage:     row?.currentStage ?? null,
    autoRun:          row?.autoRun ?? false,
    targetCandidates: row?.targetCandidates ?? 5,
    viableCount,
    targetMet:        viableCount >= (row?.targetCandidates ?? 5),
    activeRun:        recentRun ?? null,
  });
});

/* ── Stop auto-run for a job ─────────────────────────────────────────────── */

router.post("/jobs/:jobId/pipeline-stop", async (req, res) => {
  const { jobId } = req.params;
  const [job] = await db.select({ tenantId: jobsTable.tenantId }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) return res.status(404).json({ error: "Job not found" });
  await upsertPipelineRow(jobId, job.tenantId, { autoRun: false, status: "idle" });
  return res.json({ ok: true });
});

/* Returns a merged, time-sorted activity timeline for a specific candidate.  */
router.get("/agents/events/candidate/:candidateId", async (req, res) => {
  const { candidateId } = req.params;

  /* Full auth stack (was previously UNAUTHENTICATED — leaked a candidate's whole
   * timeline: applications, interviews, outreach). Staff-only surface (recruiter
   * candidate-detail page). resolveAgentViewer enforces 401 (no token) + the
   * AGENT_VIEW_ROLES staff allowlist (candidate/interviewer are NOT staff and
   * recruiterOwnsResource returns true for them, so the role gate is load-bearing)
   * + returns the caller's tenant scope. Order after that: 404 unknown/out-of-scope
   * candidate (tenant gate, hides existence) → 404 recruiter-ceiling. */
  const viewer = await resolveAgentViewer(req, res);
  if (!viewer) return;
  const { caller, allowed } = viewer;
  const [target] = await db.select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!target) { res.status(404).json({ error: "Not found" }); return; }
  if (allowed !== null && (!target.tenantId || !allowed.includes(target.tenantId))) {
    res.status(404).json({ error: "Not found" }); return;
  }
  if (!(await recruiterOwnsResource(caller, { kind: "candidateId", value: candidateId }))) {
    res.status(404).json({ error: "Not found" }); return;
  }

  const [candidate, apps, interviews, messages] = await Promise.all([
    db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1),
    db.select().from(applicationsTable).where(eq(applicationsTable.candidateId, candidateId)),
    db.select().from(interviewSessionsTable).where(eq(interviewSessionsTable.candidateId, candidateId)).orderBy(desc(interviewSessionsTable.createdAt)),
    db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.candidateId, candidateId)).orderBy(desc(outreachMessagesTable.createdAt)),
  ]);

  const c = candidate[0];
  const events: {
    id: string; type: string; agent: string; label: string;
    result: string; color: string; timestamp: string;
  }[] = [];

  // Candidate created / added to platform
  if (c) {
    events.push({
      id: "created",
      type: "sourcing",
      agent: "Sourcing Agent",
      label: `Candidate added from ${c.source || "unknown source"}`,
      result: c.source || "Direct",
      color: "cyan",
      timestamp: (c as any).createdAt?.toISOString?.() || new Date().toISOString(),
    });

    // Resume screen
    if (c.resumeScreenScore != null) {
      events.push({
        id: "screen",
        type: "screening",
        agent: "Screening Agent",
        label: "Resume screening completed",
        result: `Score: ${Math.round(c.resumeScreenScore)}%`,
        color: "violet",
        timestamp: (c as any).updatedAt?.toISOString?.() || new Date().toISOString(),
      });
    }

    // Talent match score
    if (c.talentMatchScore != null) {
      events.push({
        id: "match",
        type: "icp",
        agent: "ICP Agent",
        label: "Talent match score calculated",
        result: `${Math.round(c.talentMatchScore)}% match`,
        color: "violet",
        timestamp: (c as any).updatedAt?.toISOString?.() || new Date().toISOString(),
      });
    }
  }

  // Applications
  for (const app of apps) {
    events.push({
      id: `app-${app.id}`,
      type: "pipeline",
      agent: "Pipeline Agent",
      label: `Application stage: ${app.stage}`,
      result: app.stage.charAt(0).toUpperCase() + app.stage.slice(1),
      color: "orange",
      timestamp: (app as any).createdAt?.toISOString?.() || new Date().toISOString(),
    });
  }

  // Interview sessions
  for (const iv of interviews) {
    events.push({
      id: `interview-${iv.id}`,
      type: "interview",
      agent: "Interview Agent",
      label: iv.status === "completed"
        ? "AI video interview completed"
        : iv.status === "in_progress"
          ? "AI video interview in progress"
          : "AI video interview scheduled",
      result: iv.status === "completed" && iv.score != null
        ? `Score: ${Math.round(iv.score)}%`
        : iv.status.charAt(0).toUpperCase() + iv.status.slice(1),
      color: "emerald",
      timestamp: (iv.completedAt ?? iv.startedAt ?? (iv as any).createdAt)?.toISOString?.() || new Date().toISOString(),
    });
  }

  // Outreach messages
  for (const msg of messages) {
    if (msg.status === "sent" || msg.sentAt) {
      events.push({
        id: `msg-${msg.id}`,
        type: "outreach",
        agent: "Outreach Agent",
        label: msg.status === "replied"
          ? `Candidate replied (${msg.replySentiment || "neutral"})`
          : "Outreach message sent",
        result: msg.status === "replied"
          ? msg.replySentiment === "positive" ? "Interested" : "Replied"
          : "Delivered",
        color: msg.status === "replied" ? "green" : "orange",
        timestamp: (msg.repliedAt ?? msg.sentAt ?? (msg as any).createdAt)?.toISOString?.() || new Date().toISOString(),
      });
    }
  }

  // Sort newest-first
  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  res.json({ candidateId, events });
});

router.get("/agents/proctoring/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  /* Full auth stack (was previously UNAUTHENTICATED — leaked interview proctoring
   * events for any session id). Consumed only by recruiter-facing pages
   * (recruiter/agents.tsx, recruiter/interviews/[id].tsx), so this is STAFF auth,
   * NOT the candidate interview-session cookie. resolveAgentViewer enforces 401
   * (no token) + the AGENT_VIEW_ROLES staff allowlist (candidate/interviewer are
   * excluded — recruiterOwnsResource returns true for them so the role gate is
   * load-bearing) + tenant scope. Order after that: 404 unknown session → 404
   * out-of-tenant → 404 recruiter-ceiling (via the session's candidate). 404
   * (never 403) hides existence. */
  const viewer = await resolveAgentViewer(req, res);
  if (!viewer) return;
  const { caller, allowed } = viewer;

  const [session] = await db.select().from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, sessionId)).limit(1);

  if (!session) { res.status(404).json({ error: "Session not found" }); return; }

  if (allowed !== null && (!session.tenantId || !allowed.includes(session.tenantId))) {
    res.status(404).json({ error: "Session not found" }); return;
  }
  if (!(await recruiterOwnsResource(caller, { kind: "candidateId", value: session.candidateId }))) {
    res.status(404).json({ error: "Session not found" }); return;
  }

  const events: any[] = (session.proctoring_events as any[]) ?? [];

  const tabSwitches   = events.filter(e => e.type === "tab_switch").length;
  const copyEvents    = events.filter(e => e.type === "copy").length;
  const pasteEvents   = events.filter(e => e.type === "paste").length;
  const multiFace     = events.filter(e => e.type === "snapshot" && (e.faceCount ?? 0) > 1).length;
  const suspicious    = events.filter(e => e.type === "snapshot" && e.suspiciousActivity).length;
  const snapshots     = events.filter(e => e.type === "snapshot");
  const framesSampled = snapshots.length * 30; // each snapshot represents ~30 frames

  const faceSnapshots    = snapshots.filter(e => e.faceVisible === true).length;
  const gazeSnapshots    = snapshots.filter(e => e.faceVisible === true && !e.suspiciousActivity).length;
  const totalSnaps       = snapshots.length || 1;
  const facePct          = Math.round((faceSnapshots / totalSnaps) * 1000) / 10;
  const gazePct          = Math.round((gazeSnapshots / totalSnaps) * 1000) / 10;

  // Per-signal pass/fail thresholds. These are the SAME booleans the UI renders,
  // and every downstream number (risk score, flags, agent notes) is derived from
  // them — so a red signal can never coexist with risk 0 / "all clean".
  const hasFrames          = snapshots.length > 0;
  const facePresentPass    = !hasFrames || facePct >= 80;
  const gazePass           = !hasFrames || gazePct >= 80;
  const multiPass          = multiFace === 0;
  const tabPass            = tabSwitches === 0;
  const audioAnomalyEvents = events.filter(e => e.type === "snapshot" && e.suspiciousActivity);
  const audioPass          = audioAnomalyEvents.length === 0;

  let riskScore = 0;
  riskScore += tabSwitches * 10;
  riskScore += copyEvents  * 5;
  riskScore += pasteEvents * 8;
  riskScore += multiFace   * 15;
  riskScore += suspicious  * 12;
  // Low face-presence / gaze must raise risk. facePct already accounts for every
  // snapshot where the face was not clearly present (faceVisible false OR missing),
  // which is why a session of "unknown" frames previously scored 0 risk despite a
  // red 63.6% presence reading. Penalise the absent fraction of the session.
  if (hasFrames) {
    riskScore += Math.round(Math.max(0, 100 - facePct) * 0.7);
    riskScore += Math.round(Math.max(0, 100 - gazePct) * 0.5);
  }
  riskScore = Math.min(100, riskScore);

  const flagList: { type: string; timestamp: string; severity: string; detail: string }[] = [];
  if (!facePresentPass) flagList.push({ type: "low_face_presence", timestamp: "--", severity: facePct < 60 ? "high" : "medium", detail: `Face visible only ${facePct}% of the session` });
  if (!gazePass)        flagList.push({ type: "gaze_off_camera",   timestamp: "--", severity: gazePct < 60 ? "high" : "medium", detail: `Gaze on camera only ${gazePct}% of the session` });
  if (tabSwitches)      flagList.push({ type: "tab_switch",        timestamp: "--", severity: "medium", detail: `${tabSwitches} tab switch${tabSwitches > 1 ? "es" : ""} detected` });
  if (suspicious)       flagList.push({ type: "suspicious",        timestamp: "--", severity: "high",   detail: `${suspicious} AI-flagged suspicious moment${suspicious > 1 ? "s" : ""}` });
  if (multiFace)        flagList.push({ type: "multiple_faces",    timestamp: "--", severity: "high",   detail: `${multiFace} snapshot${multiFace > 1 ? "s" : ""} with multiple faces` });
  if (copyEvents)       flagList.push({ type: "copy",              timestamp: "--", severity: "low",    detail: `${copyEvents} copy attempt${copyEvents > 1 ? "s" : ""}` });
  if (pasteEvents)      flagList.push({ type: "paste",             timestamp: "--", severity: "low",    detail: `${pasteEvents} paste event${pasteEvents > 1 ? "s" : ""}` });

  const verdict = riskScore < 20 ? "low_risk" : riskScore < 50 ? "medium_risk" : "high_risk";

  // Agent assessment narrative — built from the same failing signals so it can
  // never claim "all clean" while a check is red.
  const concerns: string[] = [];
  if (!facePresentPass) concerns.push(`the candidate's face was visible only ${facePct}% of the session`);
  if (!gazePass)        concerns.push(`gaze was on camera just ${gazePct}% of the time`);
  if (!multiPass)       concerns.push(`multiple faces appeared in ${multiFace} snapshot${multiFace > 1 ? "s" : ""}`);
  if (!tabPass)         concerns.push(`${tabSwitches} tab switch${tabSwitches > 1 ? "es" : ""} occurred`);
  if (suspicious)       concerns.push(`${suspicious} suspicious moment${suspicious > 1 ? "s were" : " was"} flagged by vision analysis`);
  if (copyEvents || pasteEvents) concerns.push(`${copyEvents + pasteEvents} copy/paste action${copyEvents + pasteEvents > 1 ? "s were" : " was"} detected`);
  if (!audioPass)       concerns.push(`${audioAnomalyEvents.length} audio anomal${audioAnomalyEvents.length > 1 ? "ies were" : "y was"} detected`);

  const joinConcerns = (items: string[]) =>
    items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

  let notes: string;
  if (!hasFrames) {
    notes = "No proctoring frames were captured for this session, so interview integrity could not be assessed.";
  } else if (concerns.length === 0) {
    notes = "All integrity signals are clean. The candidate appears genuine and no significant anomalies were detected.";
  } else if (riskScore < 50) {
    notes = `Some integrity signals need review: ${joinConcerns(concerns)}. Review the flagged events before making a decision.`;
  } else {
    notes = `Multiple integrity concerns were detected: ${joinConcerns(concerns)}. Manual review is strongly recommended before advancing this candidate.`;
  }

  res.json({
    sessionId,
    riskScore,
    startedAt: session.createdAt?.toISOString() ?? new Date().toISOString(),
    framesSampled,
    flags: flagList,
    checks: {
      facePresent:     { pass: facePresentPass, frames: faceSnapshots, outOf: snapshots.length, pct: hasFrames ? facePct : null },
      multiplePersons: { pass: multiPass,        maxDetected: multiFace > 0 ? 2 : 1 },
      gazeOnCamera:    { pass: gazePass,         pct: hasFrames ? gazePct : null },
      tabSwitches:     { pass: tabPass,          count: tabSwitches },
      audioAnomalies:  { pass: audioPass, count: audioAnomalyEvents.length, detail: audioAnomalyEvents.length ? `${audioAnomalyEvents.length} audio anomaly detected` : null },
      screenSharing:   { pass: true,             active: false },
    },
    verdict,
    notes,
  });
});

export default router;
