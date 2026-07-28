/**
 * routes/anti-ghost.ts — Anti-Ghosting Alerts, Nurture Pool & Config
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for the Anti-Ghosting dashboard: viewing alerts, managing the
 * nurture pool, configuring the nurture sequence, and triggering manual scans.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /anti-ghost/alerts              List ghosting_alerts (tenant-scoped,
 *                                        filterable by status / riskLevel)
 *   POST /anti-ghost/alerts/:id/resolve  Resolve an alert (recruiter took action)
 *   GET  /anti-ghost/nurture-pool        List candidates in the nurture pool
 *   POST /anti-ghost/nurture-pool        Add a candidate to the nurture pool
 *   DELETE /anti-ghost/nurture-pool/:id  Remove a candidate from the nurture pool
 *   POST /anti-ghost/scan                Trigger an immediate ghosting detection scan
 *   GET  /anti-ghost/config              Get the tenant's nurture sequence config
 *   PUT  /anti-ghost/config              Update the nurture sequence steps
 *   GET  /anti-ghost/pipeline-health     Pipeline health overview (ghosting rates
 *                                        and conversion metrics per stage)
 *
 * ─── Nurture sequence config ─────────────────────────────────────────────────
 * Each tenant can customise the nurture sequence: number of steps, delay days
 * between steps, tone instructions per step, and channel (email / call reminder
 * / LinkedIn). Stored as JSONB in job_pipelines.config under "antiGhostConfig".
 * GET /anti-ghost/config returns a merged view of the tenant default plus any
 * job-specific overrides. PUT /anti-ghost/config updates the tenant default.
 *
 * ─── NurtureStep & AntiGhostConfig interfaces ────────────────────────────────
 * Exported from this module so the frontend TypeScript client can import them
 * without duplicating the shape definition.
 */
import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import {
  ghostingAlertsTable, nurturePoolTable, candidatesTable,
  jobsTable, jobPipelinesTable, usersTable,
} from "@workspace/db";

import { eq, and, desc, inArray, isNull, or } from "drizzle-orm";
import { getAuthUserId } from "../lib/auth-token.js";
import { getAllowedTenantIds } from "../lib/tenantUtils.js";

/* Resolve the authenticated caller. Returns the user row or null after
   writing a 401. 2026-05-23 audit fix: replaces the old `getTenantId`
   helper which silently fell back to a hardcoded demo tenant id whenever
   `req.user` was unset — meaning every anonymous caller of every route in
   this file was treated as that tenant. */
async function requireAuthedUser(req: Request, res: Response): Promise<any | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  return user;
}

/* Convenience: get the caller's tenant id, requiring auth. Returns null
   after writing a 401 if the caller is anonymous or has no tenant. */
async function getTenantId(req: Request, res: Response): Promise<string | null> {
  const user = await requireAuthedUser(req, res);
  if (!user) return null;
  if (!user.tenantId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  return user.tenantId;
}

/* Auth + tenant gate for mutating routes that take a row id from req.params.
   IMPORTANT: auth check happens BEFORE the row lookup so anonymous callers
   can't tell "row exists in another tenant" apart from "row does not exist". */
async function gateRowByTenant<T extends { tenantId: string | null }>(
  req: Request,
  res: Response,
  fetchRow: () => Promise<T | undefined>,
): Promise<{ user: any; row: T } | null> {
  const user = await requireAuthedUser(req, res);
  if (!user) return null;
  const row = await fetchRow();
  if (!row) { res.status(404).json({ error: "Not found" }); return null; }
  /* Subtree scope: own tenant + ALL descendants (children, grandchildren, …)
     via the shared helper, in lock-step with the RLS app_tenant_in_scope()
     policy. null = platform_admin (no restriction). */
  const allowed = await getAllowedTenantIds(user);
  if (allowed !== null && !allowed.includes(row.tenantId ?? "")) {
    res.status(404).json({ error: "Not found" }); return null;
  }
  return { user, row };
}

/* Resolve the caller and the set of tenant ids they may SEE — own tenant plus
   the ENTIRE descendant subtree (children, grandchildren, …), matching the RLS
   app_tenant_in_scope() policy. `allowed === null` means platform_admin (no
   restriction). Returns null after writing 401 for anonymous callers. */
async function getAllowedTenantScope(
  req: Request, res: Response,
): Promise<{ user: any; allowed: string[] | null } | null> {
  const user = await requireAuthedUser(req, res);
  if (!user) return null;
  const allowed = await getAllowedTenantIds(user);
  return { user, allowed };
}

/* Build a tenant-scope SQL condition for a column: subtree inArray for scoped
   users, or undefined (no restriction) for platform_admin. */
function tenantScopeCond(col: any, allowed: string[] | null) {
  if (allowed === null) return undefined;
  return inArray(col, allowed.length ? allowed : ["__none__"]);
}

// ─── Nurture sequence step type ──────────────────────────────────────────────
export interface NurtureStep {
  id: string;
  order: number;
  delayDays: number;
  channel: "email" | "call_reminder" | "linkedin";
  label: string;
  toneInstructions: string;
  templateBody: string;
  templateSubject: string;
  finalStep: boolean;
}

export interface AntiGhostConfig {
  nurtureSteps: NurtureStep[];
}

import { logger } from "../lib/logger";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import {
  runAllDetectors, addToNurturePool, processNurtureCycle,
  getPipelineHealth,
} from "../lib/anti-ghost-engine";
import { validate } from "../middlewares/validate";

const UpdateAlertBody = z.object({
  status: z.enum(["acknowledged", "resolved", "dismissed", "open"]),
  resolvedBy: z.string().optional().nullable(),
}).passthrough();

const AddNurturePoolBody = z.object({
  candidateId: z.string().min(1),
  reason: z.string().optional(),
  cadenceDays: z.number().optional(),
}).passthrough();

const UpdateNurturePoolBody = z.object({
  status: z.string().optional(),
  cadenceDays: z.number().optional(),
}).passthrough();

const NurtureSequenceBody = z.object({
  nurtureSteps: z.array(z.record(z.unknown())),
}).passthrough();

const router: IRouter = Router();

// ── GET /api/ghosting/jobs ────────────────────────────────────────────────────
// All jobs that have the anti-ghost agent enabled, with per-job health summary
router.get("/ghosting/jobs", async (req, res) => {
  const scope = await getAllowedTenantScope(req, res); if (!scope) return;
  const { allowed } = scope;
  try {
    // 1. All active/draft jobs across the caller's tenant subtree
    // Defensive cap: see lib/query-limits.ts.
    const jobs = await db.select().from(jobsTable)
      .where(tenantScopeCond(jobsTable.tenantId, allowed))
      .limit(MAX_PAGE_SIZE);

    // 2. Their pipeline configs
    const jobIds = jobs.map(j => j.id);
    const pipelines = jobIds.length
      ? await db.select().from(jobPipelinesTable).where(inArray(jobPipelinesTable.jobId, jobIds))
      : [];

    // 3. Keep only jobs with anti-ghosting enabled
    const enabledJobIds = new Set(
      pipelines
        .filter(p => Array.isArray(p.agents) && (p.agents as string[]).includes("anti-ghosting"))
        .map(p => p.jobId)
    );
    const activeJobs = jobs.filter(j => enabledJobIds.has(j.id));
    if (activeJobs.length === 0) { res.json([]); return; }

    // 4. All open alerts for these jobs
    const alerts = await db.select().from(ghostingAlertsTable)
      .where(and(
        tenantScopeCond(ghostingAlertsTable.tenantId, allowed),
        inArray(ghostingAlertsTable.jobId, activeJobs.map(j => j.id)),
        eq(ghostingAlertsTable.status, "open"),
      ));

    // 5. Build per-job summary
    const result = activeJobs.map(job => {
      const jobAlerts = alerts.filter(a => a.jobId === job.id);
      const critical = jobAlerts.filter(a => a.severity === "critical").length;
      const high     = jobAlerts.filter(a => a.severity === "high").length;
      const medium   = jobAlerts.filter(a => a.severity === "medium").length;
      const penalty  = critical * 15 + high * 8 + medium * 3;
      const healthScore = Math.max(0, Math.min(100, 100 - penalty));
      return {
        jobId:       job.id,
        title:       job.title,
        status:      job.status,
        location:    job.location,
        department:  job.department,
        openAlerts:  jobAlerts.length,
        critical,
        high,
        medium,
        healthScore,
        byType: {
          interview_no_show: jobAlerts.filter(a => a.type === "interview_no_show").length,
          outreach_dropout:  jobAlerts.filter(a => a.type === "outreach_dropout").length,
          stale_pipeline:    jobAlerts.filter(a => a.type === "stale_pipeline").length,
          offer_limbo:       jobAlerts.filter(a => a.type === "offer_limbo").length,
          interview_stale:   jobAlerts.filter(a => a.type === "interview_stale").length,
        },
      };
    }).sort((a, b) => a.healthScore - b.healthScore); // worst health first

    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ghosting/alerts ──────────────────────────────────────────────────
// List all alerts (optionally filtered by status/severity/type/jobId)
router.get("/ghosting/alerts", async (req, res) => {
  const scope = await getAllowedTenantScope(req, res); if (!scope) return;
  const { allowed } = scope;
  const { status, severity, type, jobId } = req.query as Record<string, string>;

  // Defensive cap: see lib/query-limits.ts.
  let rows = await db.select().from(ghostingAlertsTable)
    .where(tenantScopeCond(ghostingAlertsTable.tenantId, allowed))
    .orderBy(desc(ghostingAlertsTable.createdAt))
    .limit(MAX_PAGE_SIZE);

  if (status)   rows = rows.filter(r => r.status === status);
  if (severity) rows = rows.filter(r => r.severity === severity);
  if (type)     rows = rows.filter(r => r.type === type);
  if (jobId)    rows = rows.filter(r => r.jobId === jobId);

  res.json(rows.map(r => ({
    ...r,
    createdAt:  r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  })));
});

// ── GET /api/ghosting/job/:jobId/summary ──────────────────────────────────────
// Scoped health summary for a single work order — used in the WO detail tab
router.get("/ghosting/job/:jobId/summary", async (req, res) => {
  const scope = await getAllowedTenantScope(req, res); if (!scope) return;
  const { allowed } = scope;
  const { jobId } = req.params;
  try {
    const alerts = await db.select().from(ghostingAlertsTable)
      .where(and(
        tenantScopeCond(ghostingAlertsTable.tenantId, allowed),
        eq(ghostingAlertsTable.jobId, jobId),
        eq(ghostingAlertsTable.status, "open"),
      ));

    const critical = alerts.filter(a => a.severity === "critical").length;
    const high     = alerts.filter(a => a.severity === "high").length;
    const medium   = alerts.filter(a => a.severity === "medium").length;
    const penalty  = critical * 15 + high * 8 + medium * 3;
    const healthScore = Math.max(0, Math.min(100, 100 - penalty));

    res.json({
      jobId,
      openAlerts: alerts.length,
      critical,
      high,
      medium,
      healthScore,
      byType: {
        interview_no_show: alerts.filter(a => a.type === "interview_no_show").length,
        outreach_dropout:  alerts.filter(a => a.type === "outreach_dropout").length,
        stale_pipeline:    alerts.filter(a => a.type === "stale_pipeline").length,
        offer_limbo:       alerts.filter(a => a.type === "offer_limbo").length,
        interview_stale:   alerts.filter(a => a.type === "interview_stale").length,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/ghosting/alerts/:id ────────────────────────────────────────────
// Resolve / acknowledge / dismiss an alert
router.patch("/ghosting/alerts/:id", validate({ body: UpdateAlertBody }), async (req, res) => {
  const { status, resolvedBy } = req.body;
  if (!["acknowledged", "resolved", "dismissed", "open"].includes(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }
  try {
    /* Auth-first, then fetch and tenant-check, then update by composite
       (id + tenantId) so even a concurrent row-swap can't escape the check. */
    const gate = await gateRowByTenant(req, res, () =>
      db.select().from(ghostingAlertsTable)
        .where(eq(ghostingAlertsTable.id, req.params.id)).limit(1).then(r => r[0]));
    if (!gate) return;
    const [updated] = await db.update(ghostingAlertsTable)
      .set({
        status,
        resolvedBy: resolvedBy ?? null,
        resolvedAt: status === "resolved" ? new Date() : null,
      })
      .where(and(
        eq(ghostingAlertsTable.id, req.params.id),
        eq(ghostingAlertsTable.tenantId, gate.row.tenantId),
      ))
      .returning();
    if (!updated) { res.status(404).json({ error: "Alert not found" }); return; }
    res.json({ ...updated, createdAt: updated.createdAt.toISOString(), resolvedAt: updated.resolvedAt?.toISOString() ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ghosting/scan ───────────────────────────────────────────────────
// Manually trigger a full detection scan for the current tenant
router.post("/ghosting/scan", async (req, res) => {
  const scope = await getAllowedTenantScope(req, res); if (!scope) return;
  const { user, allowed } = scope;
  try {
    /* Subtree: a parent triggers detection across its own tenant + all
       descendants. platform_admin is scoped to its own tenant here (heavy op;
       the platform-wide scheduler already covers every tenant). */
    const targets = allowed === null
      ? (user.tenantId ? [user.tenantId] : [])
      : allowed;
    if (targets.length === 0) { res.status(400).json({ error: "No tenant scope" }); return; }
    const results = await Promise.all(targets.map((t) => runAllDetectors(t)));
    const merged = results.reduce((acc, r) => ({
      noShows: acc.noShows + r.noShows,
      outreachDropouts: acc.outreachDropouts + r.outreachDropouts,
      stalePipeline: acc.stalePipeline + r.stalePipeline,
      offerLimbo: acc.offerLimbo + r.offerLimbo,
      interviewStale: acc.interviewStale + r.interviewStale,
      total: acc.total + r.total,
    }), { noShows: 0, outreachDropouts: 0, stalePipeline: 0, offerLimbo: 0, interviewStale: 0, total: 0 });
    logger.info({ tenantIds: targets, result: merged }, "[anti-ghost] Manual scan triggered");
    res.json(merged);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ghosting/health ──────────────────────────────────────────────────
// Pipeline health report for the dashboard
router.get("/ghosting/health", async (req, res) => {
  const scope = await getAllowedTenantScope(req, res); if (!scope) return;
  const { allowed } = scope;
  try {
    /* Subtree health: aggregates the caller's own tenant + all descendants.
       platform_admin (allowed === null) → all tenants. */
    const report = await getPipelineHealth(allowed);
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/nurture-pool ─────────────────────────────────────────────────────
router.get("/nurture-pool", async (req, res) => {
  const scope = await getAllowedTenantScope(req, res); if (!scope) return;
  const { allowed } = scope;
  // Defensive cap: see lib/query-limits.ts.
  const rows = await db.select().from(nurturePoolTable)
    .where(tenantScopeCond(nurturePoolTable.tenantId, allowed))
    .orderBy(desc(nurturePoolTable.addedAt))
    .limit(MAX_PAGE_SIZE);
  res.json(rows.map(r => ({
    ...r,
    addedAt:        r.addedAt.toISOString(),
    lastContactedAt: r.lastContactedAt?.toISOString() ?? null,
    nextContactAt:   r.nextContactAt?.toISOString() ?? null,
  })));
});

// ── POST /api/nurture-pool ────────────────────────────────────────────────────
router.post("/nurture-pool", validate({ body: AddNurturePoolBody }), async (req, res) => {
  const tenantId = await getTenantId(req, res); if (!tenantId) return;
  const { candidateId, reason, cadenceDays } = req.body;
  if (!candidateId) { res.status(400).json({ error: "candidateId required" }); return; }

  // Try to get candidate info
  const [cand] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  try {
    const member = await addToNurturePool({
      tenantId,
      candidateId,
      candidateName: cand ? `${cand.firstName} ${cand.lastName}`.trim() : undefined,
      candidateEmail: cand?.email ?? undefined,
      reason,
      cadenceDays: cadenceDays ?? 90,
    });
    res.json({ ...member, addedAt: member.addedAt.toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/nurture-pool/:id ───────────────────────────────────────────────
router.patch("/nurture-pool/:id", validate({ body: UpdateNurturePoolBody }), async (req, res) => {
  const { status, cadenceDays } = req.body;
  try {
    const gate = await gateRowByTenant(req, res, () =>
      db.select().from(nurturePoolTable)
        .where(eq(nurturePoolTable.id, req.params.id)).limit(1).then(r => r[0]));
    if (!gate) return;
    const updates: any = {};
    if (status)      updates.status = status;
    if (cadenceDays) updates.cadenceDays = cadenceDays;
    const [updated] = await db.update(nurturePoolTable)
      .set(updates)
      .where(and(
        eq(nurturePoolTable.id, req.params.id),
        eq(nurturePoolTable.tenantId, gate.row.tenantId),
      ))
      .returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ...updated, addedAt: updated.addedAt.toISOString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ghosting/jobs/:jobId/nurture-sequence ────────────────────────────
// Get the nurture sequence config for a specific job
router.get("/ghosting/jobs/:jobId/nurture-sequence", async (req, res) => {
  const { jobId } = req.params;
  /* Auth + subtree gate via the job's tenant (404 on cross-tenant access). */
  const gate = await gateRowByTenant(req, res, () =>
    db.select({ tenantId: jobsTable.tenantId }).from(jobsTable)
      .where(eq(jobsTable.id, jobId)).limit(1).then((r) => r[0]));
  if (!gate) return;
  try {
    const [row] = await db.select().from(jobPipelinesTable)
      .where(eq(jobPipelinesTable.jobId, jobId)).limit(1);
    const config = (row?.agentConfig as any) ?? {};
    const nurtureSteps: NurtureStep[] = config?.["anti-ghosting"]?.nurtureSteps ?? defaultNurtureSteps();
    res.json({ nurtureSteps });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/ghosting/jobs/:jobId/nurture-sequence ────────────────────────────
// Save the nurture sequence config for a specific job
router.put("/ghosting/jobs/:jobId/nurture-sequence", validate({ body: NurtureSequenceBody }), async (req, res) => {
  const { jobId } = req.params;
  const { nurtureSteps } = req.body as { nurtureSteps: NurtureStep[] };
  if (!Array.isArray(nurtureSteps)) {
    res.status(400).json({ error: "nurtureSteps must be an array" }); return;
  }
  /* Auth + subtree gate via the job's tenant (404 on cross-tenant access). */
  const gate = await gateRowByTenant(req, res, () =>
    db.select({ tenantId: jobsTable.tenantId }).from(jobsTable)
      .where(eq(jobsTable.id, jobId)).limit(1).then((r) => r[0]));
  if (!gate) return;
  try {
    const [row] = await db.select().from(jobPipelinesTable)
      .where(eq(jobPipelinesTable.jobId, jobId)).limit(1);

    const existingConfig = (row?.agentConfig as any) ?? {};
    const updatedConfig = {
      ...existingConfig,
      "anti-ghosting": { ...(existingConfig["anti-ghosting"] ?? {}), nurtureSteps },
    };

    if (row) {
      await db.update(jobPipelinesTable)
        .set({ agentConfig: updatedConfig, updatedAt: new Date() })
        .where(eq(jobPipelinesTable.jobId, jobId));
    } else {
      const [job] = await db.select({ tenantId: jobsTable.tenantId })
        .from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
      if (!job) { res.status(404).json({ error: "Job not found" }); return; }
      await db.insert(jobPipelinesTable).values({
        jobId,
        tenantId: job.tenantId,
        agents: [],
        agentConfig: updatedConfig,
      });
    }
    res.json({ ok: true, nurtureSteps });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Default nurture steps factory ───────────────────────────────────────────
function defaultNurtureSteps(): NurtureStep[] {
  return [
    {
      id: crypto.randomUUID(),
      order: 1,
      delayDays: 3,
      channel: "email",
      label: "Warm Check-In",
      toneInstructions: "Warm and human, not pushy. Acknowledge they may be busy. Light CTA.",
      templateSubject: "Quick check-in, {{candidate_name}}",
      templateBody: `Hi {{candidate_name}},

Just wanted to touch base — I know things get busy and I haven't heard back from you. No pressure at all.

When you get a chance, would you be open to a quick 15-min chat about the {{job_title}} opportunity? Happy to work around your schedule.

{{recruiter_signature}}`,
      finalStep: false,
    },
    {
      id: crypto.randomUUID(),
      order: 2,
      delayDays: 14,
      channel: "email",
      label: "Value Re-Engagement",
      toneInstructions: "Mention something specific and valuable about the role or company. No guilt-tripping.",
      templateSubject: "Still thinking of you for {{job_title}}",
      templateBody: `Hi {{candidate_name}},

I wanted to reach out one more time — we've made some progress on the {{job_title}} role and I still think you'd be a great fit.

If the timing isn't right, no worries at all. But if you're still open, I'd love to reconnect.

{{recruiter_signature}}`,
      finalStep: false,
    },
    {
      id: crypto.randomUUID(),
      order: 3,
      delayDays: 30,
      channel: "email",
      label: "Final Farewell",
      toneInstructions: "Graceful closing. Leave the door open. No resentment. Keep it very short.",
      templateSubject: "Closing the loop, {{candidate_name}}",
      templateBody: `Hi {{candidate_name}},

I'll leave it here for now — I know your inbox is busy and I don't want to keep pinging you.

If things change down the road, feel free to reach back out. I'll always be happy to chat.

Wishing you all the best,
{{recruiter_signature}}`,
      finalStep: true,
    },
  ];
}

// ── POST /api/nurture-pool/process ────────────────────────────────────────────
// Manually trigger a nurture cycle
router.post("/nurture-pool/process", async (req, res) => {
  const scope = await getAllowedTenantScope(req, res); if (!scope) return;
  const { user, allowed } = scope;
  try {
    /* Subtree: process the caller's own tenant + all descendants.
       platform_admin scoped to own tenant (heavy op; scheduler covers all). */
    const targets = allowed === null
      ? (user.tenantId ? [user.tenantId] : [])
      : allowed;
    if (targets.length === 0) { res.status(400).json({ error: "No tenant scope" }); return; }
    const results = await Promise.all(targets.map((t) => processNurtureCycle(t)));
    const members = results.flat();
    res.json({ processed: members.length, members });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
