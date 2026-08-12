/**
 * routes/agent-runs.ts — Agent Run event model API
 *
 * A source-agnostic surface over the agent_runs / agent_run_events tables. The
 * frontend subscribes to a run by POLLING its events (every ~2s) and never has
 * to know whether the events came from the real sourcing pipeline or from
 * `simulateSourcingRun`.
 *
 *   POST /agent-runs/simulate   { workOrderId, shortlistSize? } → { runId }
 *   GET  /agent-runs            ?workOrderId=…                   → runs (audit log)
 *   GET  /agent-runs/:id                                         → run + events
 *   GET  /agent-runs/:id/events ?after=<seq>                     → events after seq
 *
 * All routes are authenticated (mounted behind withTenantContext). Reads use the
 * tenant-scoped `db` role, so RLS enforces isolation. Any caller-supplied
 * workOrderId is validated against getAllowedTenantIds before use.
 */
import { Router, type IRouter } from "express";
import {
  db,
  requestDbContext,
  agentRunsTable,
  agentRunEventsTable,
  jobsTable,
  tenantsTable,
  usersTable,
} from "@workspace/db";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { z } from "zod/v4";
import { validate } from "../middlewares/validate";
import { getAuthUserId } from "../lib/auth-token";
import { getAllowedTenantIds, recruiterIsAssignedToJob } from "../lib/tenantUtils";
import { startGuardedAgentRun, emitRunEvent, completeAgentRun } from "../lib/agent-runs/recorder";
import { simulateSourcingRun } from "../lib/agent-runs/simulate";
import { runRealSourcingRun } from "../lib/agent-runs/run-real";

const router: IRouter = Router();

/**
 * Global safety cap: sourcing runs execute in-process (fire-and-forget), so this
 * limits total concurrent runs SERVER-WIDE (across all tenants) to protect the
 * process from overload. Distinct from the per-work-order limit (1 active run
 * per requisition) enforced separately below.
 */
const MAX_CONCURRENT_RUNS = 3;

/** Resolve the caller (tenant + role) or return null (→ 401). */
async function resolveCaller(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [user] = await db
    .select({ id: usersTable.id, tenantId: usersTable.tenantId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return user ?? null;
}

/** Load a job the caller may see; returns null when not found / out of scope. */
async function loadAuthorizedJob(user: { tenantId: string | null; role: string }, jobId: string) {
  const allowed = await getAllowedTenantIds(user);
  const [job] = await db
    .select({
      id: jobsTable.id,
      tenantId: jobsTable.tenantId,
      status: jobsTable.status,
      assignedRecruiterId: jobsTable.assignedRecruiterId,
    })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);
  if (!job) return null;
  if (allowed !== null && !allowed.includes(job.tenantId)) return null;
  return job;
}

const SimulateBody = z.object({
  workOrderId: z.string().min(1),
  shortlistSize: z.number().int().min(1).max(25).optional(),
  /** EXPLICIT demo flag. Default (absent/false) runs the REAL sourcing
   *  pipeline; only `simulated: true` produces demo-labeled persona data. */
  simulated: z.boolean().optional(),
});

// Cast note: validate() is typed against zod v3's ZodTypeAny while route
// schemas use zod/v4 — runtime-compatible (validate only calls safeParse),
// but the nominal types differ. Cast at the boundary like other callers.
router.post("/agent-runs/simulate", validate({ body: SimulateBody as never }), async (req, res) => {
  const user = await resolveCaller(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const {
    workOrderId,
    shortlistSize,
    simulated = false,
  } = req.body as z.infer<typeof SimulateBody>;
  const job = await loadAuthorizedJob(user, workOrderId);
  if (!job) {
    res.status(404).json({ error: "Work order not found" });
    return;
  }

  /* Recruiter ownership ceiling: starting a run writes candidates onto (and,
   * for real runs, spends money against) this requisition, so a plain
   * recruiter must be on its roster — same gate as POST /sourcing/search.
   * Admin-class roles already cleared the tenant-scope check above. */
  if (user.role === "recruiter" && !(await recruiterIsAssignedToJob(user.id, job))) {
    res.status(403).json({ error: "Forbidden — you are not assigned to this requisition." });
    return;
  }

  // Approval gate: sourcing creates candidate records, so it may only run on an
  // approved work order (not a draft / pending / rejected requisition).
  if (["draft", "pending_approval", "rejected"].includes(job.status)) {
    res.status(409).json({
      error: "This work order isn't approved yet — approve it before sourcing.",
      code: "not_approved",
    });
    return;
  }

  // ADVISORY internal-first (2026-08-12, per product owner): reviewing the
  // internal bench before a real (spending) run is a UI recommendation, not a
  // server-side blocker. Runs search the internal pool as part of the fan-out.

  // Concurrency caps, enforced atomically (advisory-locked check+insert) so two
  // parallel starts can't both slip past:
  //   • per work order — only one active sourcing run at a time (409)
  //   • globally       — at most MAX_CONCURRENT_RUNS across all tenants (429),
  //     since runs execute in-process and would otherwise overload the executor.
  const started = await startGuardedAgentRun(
    {
      tenantId: job.tenantId,
      workOrderId: job.id,
      agentType: "sourcing",
      isSimulated: simulated,
      triggeredBy: user.id,
      status: "running",
    },
    { maxConcurrent: MAX_CONCURRENT_RUNS },
  );
  if (!started.ok) {
    if (started.code === "run_in_progress") {
      res.status(409).json({
        error: "A sourcing run is already in progress",
        code: "run_in_progress",
        runId: started.runId,
      });
    } else {
      res.status(429).json({
        error: "Too many sourcing runs in progress right now — please try again in a moment.",
        code: "global_run_limit",
      });
    }
    return;
  }
  const run = started.run;

  // Fire-and-forget: the run keeps emitting events after this response.
  // Default = the REAL provider pipeline + LLM/ICP scorer; `simulated: true`
  // is the explicit demo path (persona data, "Demo run" badge via isSimulated).
  //
  // The executor MUST run OUTSIDE the request's AsyncLocalStorage frame:
  // withTenantContext releases the request-scoped PoolClient when the 202
  // response finishes, so any `db` call inherited into this background work
  // would hit a released client. `requestDbContext.exit()` empties the store,
  // making every `db` access inside the run fall through to dbAdmin (the
  // documented rule for background work) — with explicit tenantId scoping.
  const executor = simulated ? simulateSourcingRun : runRealSourcingRun;
  requestDbContext.exit(() => {
    void executor(
      { id: run.id, tenantId: run.tenantId, workOrderId: run.workOrderId },
      { shortlistSize },
    );
  });

  res.status(202).json({ runId: run.id, run });
});

/** List runs for a work order (the audit log), newest first. */
router.get("/agent-runs", async (req, res) => {
  const user = await resolveCaller(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const workOrderId = typeof req.query.workOrderId === "string" ? req.query.workOrderId : "";
  if (!workOrderId) {
    res.status(400).json({ error: "workOrderId is required" });
    return;
  }

  const job = await loadAuthorizedJob(user, workOrderId);
  if (!job) {
    res.status(404).json({ error: "Work order not found" });
    return;
  }

  const runs = await db
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.workOrderId, workOrderId))
    .orderBy(desc(agentRunsTable.createdAt))
    .limit(50);

  res.json({ runs });
});

/** A single run plus its full ordered event stream. */
router.get("/agent-runs/:id", async (req, res) => {
  const user = await resolveCaller(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // RLS already scopes agent_runs to the caller's tenant subtree.
  const [run] = await db
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.id, req.params.id))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const events = await db
    .select()
    .from(agentRunEventsTable)
    .where(eq(agentRunEventsTable.runId, run.id))
    .orderBy(asc(agentRunEventsTable.seq));

  // Enrich with the work-order title + client (tenant) name so the run view
  // header can read "Sourcing candidates for <title>" · <client> without a
  // second round-trip. RLS already scoped the run; the job lookup is scoped
  // by the same tenant subtree.
  let jobTitle: string | null = null;
  let clientName: string | null = null;
  let workOrderNumber: string | null = null;
  if (run.workOrderId) {
    const [job] = await db
      .select({
        title: jobsTable.title,
        workOrderNumber: jobsTable.workOrderNumber,
        clientName: tenantsTable.name,
      })
      .from(jobsTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, jobsTable.tenantId))
      .where(eq(jobsTable.id, run.workOrderId))
      .limit(1);
    jobTitle = job?.title ?? null;
    clientName = job?.clientName ?? null;
    workOrderNumber = job?.workOrderNumber ?? null;
  }

  res.json({ run: { ...run, jobTitle, clientName, workOrderNumber }, events });
});

/**
 * Cancel an in-flight run. Sets status → cancelled and appends a terminal event
 * so the stream ends cleanly. Idempotent: cancelling an already-terminal run is
 * a no-op that returns its current status. The simulate loop checks
 * `isRunCancelled` between stages and stops without overwriting this status.
 */
router.post("/agent-runs/:id/cancel", async (req, res) => {
  const user = await resolveCaller(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // RLS already scopes agent_runs to the caller's tenant subtree.
  const [run] = await db
    .select({
      id: agentRunsTable.id,
      status: agentRunsTable.status,
      tenantId: agentRunsTable.tenantId,
    })
    .from(agentRunsTable)
    .where(eq(agentRunsTable.id, req.params.id))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  if (!["queued", "running"].includes(run.status)) {
    res.json({ status: run.status });
    return;
  }

  await emitRunEvent(
    { id: run.id, tenantId: run.tenantId },
    { type: "run_failed", message: "Sourcing run cancelled by recruiter" },
  );
  await completeAgentRun(run.id, "cancelled");
  res.json({ status: "cancelled" });
});

/** Incremental events for a run — the 2s poll target. */
router.get("/agent-runs/:id/events", async (req, res) => {
  const user = await resolveCaller(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [run] = await db
    .select({
      id: agentRunsTable.id,
      status: agentRunsTable.status,
      summary: agentRunsTable.summary,
    })
    .from(agentRunsTable)
    .where(eq(agentRunsTable.id, req.params.id))
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const after = Number.parseInt(String(req.query.after ?? "0"), 10) || 0;
  const events = await db
    .select()
    .from(agentRunEventsTable)
    .where(and(eq(agentRunEventsTable.runId, run.id), gt(agentRunEventsTable.seq, after)))
    .orderBy(asc(agentRunEventsTable.seq));

  res.json({ status: run.status, summary: run.summary, events });
});

export default router;
