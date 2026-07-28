/**
 * routes/linx-requests.ts — client-side LINX engagement entry points (Step 2).
 *
 * A recruiter with access to a job asks LINX (a separate tenant) for help
 * filling the role. Submitting creates a linx_requests row (status pending).
 * LINX-side accept/decline handling is a later step.
 *
 * ── Boundary rules (see schema/linx-requests.ts + memory linx-requests-isolation)
 *   • NO candidate data is referenced or attached anywhere in this flow —
 *     the row carries job id + contact + note only.
 *   • linx_tenant_id comes from server config (lib/linx-config.ts), NEVER
 *     from the request body.
 *   • RLS (migration 0050) is the prod backstop; every route here ALSO
 *     applies explicit app-code scoping because dev strips RLS broadly.
 *
 * ── Authorization
 *   Any staff member with access to the job — NOT admin-gated:
 *     platform_admin / tenant_admin — job tenant within subtree scope
 *     recruiter_admin               — job tenant within assigned-client scope
 *     recruiter                     — must be assigned to the job
 *   Cross-tenant/missing job = 404 (never confirm existence).
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { controlDb, db, dbAdmin } from "@workspace/db";
import { jobsTable, usersTable, linxRequestsTable, tenantsTable } from "@workspace/db";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { validate } from "../middlewares/validate";
import { getAuthUserId } from "../lib/auth-token";
import {
  getAllowedTenantIds,
  getDataScopeTenantIds,
  recruiterIsAssignedToJob,
} from "../lib/tenantUtils";
import { getLinxTenantId } from "../lib/linx-config";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/* Staff roles allowed to engage LINX. Explicit allowlist (memory:
 * staff-only-route-role-gate — candidates carry a tenantId too). */
const LINX_REQUESTER_ROLES = new Set([
  "platform_admin",
  "tenant_admin",
  "recruiter_admin",
  "recruiter",
]);

/* Auth + job-access gate shared by both routes. Mirrors icp.ts:gateJobAccess
 * and adds the recruiter ownership ceiling + recruiter_admin client scope.
 * Returns { user, job } or null after writing the response. */
async function gateLinxJobAccess(
  req: Request,
  res: Response,
  jobId: string,
): Promise<{ user: any; job: any } | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!LINX_REQUESTER_ROLES.has(user.role)) { res.status(403).json({ error: "Forbidden" }); return null; }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) { res.status(404).json({ error: "Not found" }); return null; }

  /* Tenant ceiling: recruiter_admin narrows to assigned clients, everyone
     else uses the full subtree. 404 not 403 — never confirm existence. */
  const scope = user.role === "recruiter_admin"
    ? await getDataScopeTenantIds(user)
    : await getAllowedTenantIds(user);
  if (scope !== null && !scope.includes(job.tenantId ?? "")) {
    res.status(404).json({ error: "Not found" }); return null;
  }

  /* Recruiter ownership ceiling: tenant scope is NOT enough — must be
     assigned to this req (primary or job_recruiters roster). */
  if (user.role === "recruiter" && !(await recruiterIsAssignedToJob(user.id, job))) {
    res.status(404).json({ error: "Not found" }); return null;
  }

  return { user, job };
}

function mapRequest(r: typeof linxRequestsTable.$inferSelect) {
  /* Client-facing shape. NOTE: no candidate fields exist on this table by
   * design; nothing to strip. */
  return {
    id: r.id,
    jobId: r.jobId,
    status: r.status,
    contactName: r.contactName,
    contactEmail: r.contactEmail,
    note: r.note,
    declineReason: r.declineReason,
    requestedAt: r.requestedAt instanceof Date ? r.requestedAt.toISOString() : r.requestedAt,
    respondedAt: r.respondedAt instanceof Date ? r.respondedAt.toISOString() : r.respondedAt,
    resolvedAt: r.resolvedAt instanceof Date ? r.resolvedAt.toISOString() : r.resolvedAt,
  };
}

const CreateLinxRequestBody = z.object({
  jobId: z.string().min(1),
  contactName: z.string().trim().min(1).max(200),
  contactEmail: z.string().trim().email().max(320),
  note: z.string().trim().max(4000).optional(),
});

/* POST /linx-requests — create a pending engagement request for a job.
 * Both client surfaces (work-order wizard + Market Intelligence) hit this. */
router.post("/linx-requests", validate({ body: CreateLinxRequestBody }), async (req, res) => {
  try {
    const { jobId, contactName, contactEmail, note } = req.body as z.infer<typeof CreateLinxRequestBody>;
    const gate = await gateLinxJobAccess(req, res, jobId);
    if (!gate) return;
    const { user, job } = gate;

    const linxTenantId = await getLinxTenantId();
    if (!linxTenantId) {
      res.status(503).json({ error: "LINX engagement is not configured on this environment." });
      return;
    }
    if (job.tenantId === linxTenantId) {
      res.status(400).json({ error: "This role already belongs to LINX." });
      return;
    }

    /* One ACTIVE request per job: pending/accepted block a new one. A
       declined/filled/closed history row does not. Explicit tenant predicate
       alongside RLS (dual-tenant rows; scope by the job's tenant). */
    const [active] = await db.select().from(linxRequestsTable)
      .where(and(
        eq(linxRequestsTable.jobId, jobId),
        eq(linxRequestsTable.tenantId, job.tenantId ?? ""),
        inArray(linxRequestsTable.status, ["pending", "accepted"]),
      ))
      .orderBy(desc(linxRequestsTable.requestedAt))
      .limit(1);
    if (active) {
      res.status(409).json({ error: "An active LINX request already exists for this role.", request: mapRequest(active) });
      return;
    }

    let row;
    try {
      [row] = await db.insert(linxRequestsTable).values({
        tenantId: job.tenantId,
        jobId,
        requestedByUserId: user.id,
        contactName,
        contactEmail,
        note: note || null,
        status: "pending",
        linxTenantId,
      }).returning();
    } catch (err: any) {
      /* Concurrency seal: partial unique index linx_requests_one_active_per_job
         (migration 0051) turns a lost race into a 23505 — surface it as the
         same 409 the fast-path check produces. */
      if (err?.code === "23505") {
        res.status(409).json({ error: "An active LINX request already exists for this role." });
        return;
      }
      throw err;
    }

    res.status(201).json({ request: mapRequest(row) });
  } catch (err) {
    logger.error({ err }, "[linx-requests] create failed");
    res.status(500).json({ error: "Failed to create LINX request" });
  }
});

/* GET /jobs/:jobId/linx-request — latest request for this job (or null).
 * Drives the status badge everywhere the work order is shown. */
router.get("/jobs/:jobId/linx-request", async (req, res) => {
  try {
    const gate = await gateLinxJobAccess(req, res, req.params.jobId);
    if (!gate) return;
    const { job } = gate;

    const [row] = await db.select().from(linxRequestsTable)
      .where(and(
        eq(linxRequestsTable.jobId, req.params.jobId),
        eq(linxRequestsTable.tenantId, job.tenantId ?? ""),
      ))
      .orderBy(desc(linxRequestsTable.requestedAt))
      .limit(1);

    res.json({ request: row ? mapRequest(row) : null });
  } catch (err) {
    logger.error({ err }, "[linx-requests] fetch failed");
    res.status(500).json({ error: "Failed to load LINX request" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * LINX-SIDE routes (Step 3) — queue view + accept/decline.
 *
 * Callers here are admins OF THE LINX TENANT (tenant_admin whose scope
 * includes the configured LINX tenant, or platform_admin). Explicit role
 * allowlist + linx_tenant_id ∈ scope on every route; RLS (policy b: linx
 * side) is the prod backstop only.
 *
 * dbAdmin justification (narrow, commented at each site):
 *   • Reading the ORIGIN job/tenant is a deliberate cross-tenant METADATA
 *     read — exactly the data the handoff allows (never candidates).
 *   • Materialization writes target a sub-tenant that may be created inside
 *     this same request, so the request-scoped GUC tenant list cannot
 *     include it yet.
 * Every dbAdmin access is keyed off a linx_requests row the caller has
 * already been authorized against.
 * ═══════════════════════════════════════════════════════════════════════ */

const LINX_ADMIN_ROLES = new Set(["platform_admin", "tenant_admin"]);

/* Auth gate for LINX-side routes. Returns { user, linxTenantId } or null
 * after writing the response. */
async function gateLinxAdmin(
  req: Request,
  res: Response,
): Promise<{ user: any; linxTenantId: string } | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  if (!LINX_ADMIN_ROLES.has(user.role)) { res.status(403).json({ error: "Forbidden" }); return null; }

  const linxTenantId = await getLinxTenantId();
  if (!linxTenantId) {
    res.status(503).json({ error: "LINX engagement is not configured on this environment." });
    return null;
  }
  /* Must be an admin OF the LINX tenant subtree (platform_admin scope is
   * null = all). 403, not 404 — the queue is a fixed surface. */
  const scope = await getAllowedTenantIds(user);
  if (scope !== null && !scope.includes(linxTenantId)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { user, linxTenantId };
}

const LINX_QUEUE_STATUS_LIST = ["pending", "accepted", "declined", "filled", "closed"] as const;

/* GET /linx/requests — the LINX-side queue, optionally filtered by status.
 * Enriched with originating tenant name + job metadata (title/location/
 * salary band) — METADATA only, never candidate data. */
router.get("/linx/requests", async (req, res) => {
  try {
    const gate = await gateLinxAdmin(req, res);
    if (!gate) return;
    const { linxTenantId } = gate;

    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    if (statusRaw && !(LINX_QUEUE_STATUS_LIST as readonly string[]).includes(statusRaw)) {
      res.status(400).json({ error: "Invalid status filter" });
      return;
    }

    const conds = [eq(linxRequestsTable.linxTenantId, linxTenantId)];
    if (statusRaw) conds.push(eq(linxRequestsTable.status, statusRaw as any));

    /* dbAdmin: rows are pinned to the caller's LINX tenant by the predicate
     * above; the joins pull cross-tenant JOB/TENANT METADATA (title,
     * location, salary band, client name) which is exactly what the
     * handoff shares. No candidate tables are touched. */
    const rows = await dbAdmin
      .select({
        request: linxRequestsTable,
        clientTenantName: tenantsTable.name,
        jobTitle: jobsTable.title,
        jobLocation: jobsTable.location,
        jobSalaryMin: jobsTable.salaryMin,
        jobSalaryMax: jobsTable.salaryMax,
        jobWorkType: jobsTable.workType,
        jobEmploymentType: jobsTable.employmentType,
      })
      .from(linxRequestsTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, linxRequestsTable.tenantId))
      .leftJoin(jobsTable, eq(jobsTable.id, linxRequestsTable.jobId))
      .where(and(...conds))
      .orderBy(desc(linxRequestsTable.requestedAt))
      .limit(500);

    res.json({
      requests: rows.map(r => ({
        ...mapRequest(r.request),
        linxReqId: r.request.linxReqId,
        clientTenantName: r.clientTenantName,
        jobTitle: r.jobTitle,
        jobLocation: r.jobLocation,
        jobSalaryMin: r.jobSalaryMin,
        jobSalaryMax: r.jobSalaryMax,
        jobWorkType: r.jobWorkType,
        jobEmploymentType: r.jobEmploymentType,
      })),
    });
  } catch (err) {
    logger.error({ err }, "[linx-requests] queue fetch failed");
    res.status(500).json({ error: "Failed to load LINX queue" });
  }
});

/* Work-order number for the cloned requisition, generated with dbAdmin
 * because the target sub-tenant may have been created within this request
 * (outside the request GUC scope). Same WO-<year>-<client>-<sub>-<seq>
 * format as routes/jobs.ts. */
async function generateLinxWorkOrderNumber(tenantId: string): Promise<string> {
  const year = new Date().getFullYear();
  let clientCode = "CLT";
  const [client] = await controlDb.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  if (client) {
    const raw = client.slug || client.name;
    clientCode = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4).padEnd(2, "X");
  }
  /* work_order_number is GLOBALLY unique (jobs_work_order_number_unique),
   * so the max-sequence scan must be global on the full prefix — a
   * tenant-scoped scan can't see numbers minted by other tenants that share
   * the same code (e.g. "LINX") and would regenerate the same collision on
   * every retry. */
  const prefix = `WO-${year}-${clientCode}-MAIN-`;
  const existing = await dbAdmin
    .select({ workOrderNumber: jobsTable.workOrderNumber })
    .from(jobsTable)
    .where(sql`${jobsTable.workOrderNumber} ILIKE ${`${prefix}%`}`);
  let maxSeq = 0;
  for (const row of existing) {
    const match = (row.workOrderNumber ?? "").trim().toUpperCase().match(/-(\d{4})$/);
    if (!match) continue;
    const n = Number.parseInt(match[1] ?? "0", 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  return `${prefix}${(maxSeq + 1).toString().padStart(4, "0")}`;
}

/* Deterministic slug keying a LINX-side client record to the ORIGINATING
 * tenant. The unique slug column is the idempotency seal: a second request
 * from the same client tenant re-finds the same record. */
function linxClientSlug(originTenantId: string): string {
  return `linx-client-${originTenantId}`;
}

/* POST /linx/requests/:id/accept — idempotent materialization.
 *   1. find-or-create the client sub-tenant inside LINX (keyed by slug)
 *   2. find-or-create the contact as a hiring_manager user under it
 *   3. clone job METADATA into a new requisition owned by that client
 *   4. request → accepted, linx_req_id set, responded_at now
 * Re-accepting an already-accepted request returns the existing result. */
router.post("/linx/requests/:id/accept", async (req, res) => {
  try {
    const gate = await gateLinxAdmin(req, res);
    if (!gate) return;
    const { user, linxTenantId } = gate;
    const requestId = req.params.id;

    const [request] = await db.select().from(linxRequestsTable)
      .where(and(eq(linxRequestsTable.id, requestId), eq(linxRequestsTable.linxTenantId, linxTenantId)))
      .limit(1);
    if (!request) { res.status(404).json({ error: "Not found" }); return; }
    if (request.status === "accepted" || request.status === "filled") {
      /* Idempotent: already materialized. */
      res.json({ request: { ...mapRequest(request), linxReqId: request.linxReqId } });
      return;
    }
    if (request.status !== "pending") {
      res.status(409).json({ error: `Request is already ${request.status}.` });
      return;
    }

    /* Origin job METADATA (cross-tenant read via dbAdmin — this is the one
     * data class the handoff shares; a copy, not a live reference). */
    const [originJob] = await dbAdmin.select().from(jobsTable)
      .where(eq(jobsTable.id, request.jobId)).limit(1);
    if (!originJob) { res.status(410).json({ error: "The originating role no longer exists." }); return; }
    const [originTenant] = await controlDb.select().from(tenantsTable)
      .where(eq(tenantsTable.id, request.tenantId)).limit(1);
    const [linxTenant] = await controlDb.select().from(tenantsTable)
      .where(eq(tenantsTable.id, linxTenantId)).limit(1);

    /* Atomic claim BEFORE materializing so two concurrent accepts cannot
     * both clone (TOCTOU guard inside the UPDATE predicate). Reverted on
     * materialization failure. */
    const [claimed] = await db.update(linxRequestsTable)
      .set({ status: "accepted", respondedAt: new Date() })
      .where(and(
        eq(linxRequestsTable.id, requestId),
        eq(linxRequestsTable.linxTenantId, linxTenantId),
        eq(linxRequestsTable.status, "pending"),
      ))
      .returning();
    if (!claimed) {
      const [now] = await db.select().from(linxRequestsTable)
        .where(and(eq(linxRequestsTable.id, requestId), eq(linxRequestsTable.linxTenantId, linxTenantId)))
        .limit(1);
      if (now?.status === "accepted") {
        res.json({ request: { ...mapRequest(now), linxReqId: now.linxReqId } });
      } else {
        res.status(409).json({ error: `Request is already ${now?.status ?? "gone"}.` });
      }
      return;
    }

    try {
      /* 1 — find-or-create the client record (sub-tenant of LINX), keyed by
       * the originating tenant via the unique slug. dbAdmin: the new tenant
       * is outside the request GUC scope by definition. */
      const clientSlug = linxClientSlug(request.tenantId);
      let [clientTenant] = await controlDb.select().from(tenantsTable)
        .where(eq(tenantsTable.slug, clientSlug)).limit(1);
      if (!clientTenant) {
        try {
          [clientTenant] = await dbAdmin.insert(tenantsTable).values({
            parentId: linxTenantId,
            name: originTenant?.name ?? "LINX Client",
            slug: clientSlug,
            clientType: "sub_client",
            status: "active",
            plan: linxTenant?.plan ?? "starter",
            region: linxTenant?.region ?? "us",
            country: linxTenant?.country ?? null,
            contactEmail: request.contactEmail,
            createdById: user.id,
          }).returning();
        } catch (err: any) {
          if (err?.code !== "23505") throw err;
          /* Lost a create race — the slug seal means the row now exists. */
          [clientTenant] = await controlDb.select().from(tenantsTable)
            .where(eq(tenantsTable.slug, clientSlug)).limit(1);
        }
      }
      if (!clientTenant) throw new Error("client tenant materialization failed");

      /* 2 — find-or-create the contact person as a hiring_manager under the
       * client. users.email is GLOBALLY unique: if the address already
       * belongs to a user in another tenant (e.g. the requesting recruiter),
       * we do NOT hijack or duplicate it — the requisition is created
       * without an assigned HM and the contact stays on the request row. */
      const contactEmail = request.contactEmail.trim().toLowerCase();
      let hmId: string | null = null;
      const [existingHm] = await dbAdmin.select({ id: usersTable.id, role: usersTable.role })
        .from(usersTable)
        .where(and(
          sql`lower(${usersTable.email}) = ${contactEmail}`,
          eq(usersTable.tenantId, clientTenant.id),
        ))
        .limit(1);
      if (existingHm) {
        hmId = existingHm.id;
      } else {
        try {
          const [hm] = await dbAdmin.insert(usersTable).values({
            tenantId: clientTenant.id,
            email: contactEmail,
            name: request.contactName,
            /* Non-loginable placeholder (same pattern as portal_invited);
             * a real login requires the staff-invite flow. */
            passwordHash: "linx_hm_placeholder",
            role: "hiring_manager",
          }).returning({ id: usersTable.id });
          hmId = hm?.id ?? null;
        } catch (err: any) {
          if (err?.code !== "23505") throw err;
          logger.warn({ requestId }, "[linx-requests] contact email exists in another tenant — requisition created without assigned HM");
        }
      }

      /* 3 — clone job METADATA into a new requisition owned by the client,
       * inside the LINX tenant subtree. A copy — no live reference, no
       * candidate data, no pipeline state. */
      let newJob: typeof jobsTable.$inferSelect | undefined;
      for (let attempt = 0; attempt < 3 && !newJob; attempt++) {
        const workOrderNumber = await generateLinxWorkOrderNumber(clientTenant.id);
        try {
          [newJob] = await dbAdmin.insert(jobsTable).values({
            workOrderNumber,
            /* The client's own (origin) WO number, kept as external ref. */
            clientWorkOrderNumber: originJob.workOrderNumber ?? null,
            tenantId: clientTenant.id,
            createdById: user.id,
            title: originJob.title,
            department: originJob.department,
            location: originJob.location,
            workType: originJob.workType,
            employmentType: originJob.employmentType,
            salaryMin: originJob.salaryMin,
            salaryMax: originJob.salaryMax,
            description: originJob.description,
            language: originJob.language ?? "en",
            assignedHiringManagerId: hmId,
            status: "active",
          }).returning();
        } catch (err: any) {
          if (err?.code !== "23505") throw err; /* WO number race — retry */
        }
      }
      if (!newJob) throw new Error("requisition clone failed (work-order number contention)");

      /* 4 — point the request at the materialized requisition. */
      const [done] = await db.update(linxRequestsTable)
        .set({ linxReqId: newJob.id })
        .where(eq(linxRequestsTable.id, requestId))
        .returning();

      res.json({
        request: { ...mapRequest(done ?? claimed), linxReqId: newJob.id },
        requisition: { id: newJob.id, workOrderNumber: newJob.workOrderNumber, tenantId: clientTenant.id, clientName: clientTenant.name },
      });
    } catch (err) {
      /* Revert the claim so the request can be retried. */
      await db.update(linxRequestsTable)
        .set({ status: "pending", respondedAt: null })
        .where(and(eq(linxRequestsTable.id, requestId), eq(linxRequestsTable.status, "accepted")))
        .catch(() => undefined);
      throw err;
    }
  } catch (err) {
    logger.error({ err }, "[linx-requests] accept failed");
    res.status(500).json({ error: "Failed to accept LINX request" });
  }
});

const DeclineBody = z.object({
  reason: z.string().trim().max(2000).optional(),
});

/* POST /linx/requests/:id/decline — nothing materialized. Idempotent on an
 * already-declined row. */
router.post("/linx/requests/:id/decline", validate({ body: DeclineBody }), async (req, res) => {
  try {
    const gate = await gateLinxAdmin(req, res);
    if (!gate) return;
    const { linxTenantId } = gate;
    const requestId = req.params.id;
    const { reason } = req.body as z.infer<typeof DeclineBody>;

    const [updated] = await db.update(linxRequestsTable)
      .set({ status: "declined", declineReason: reason || null, respondedAt: new Date() })
      .where(and(
        eq(linxRequestsTable.id, requestId),
        eq(linxRequestsTable.linxTenantId, linxTenantId),
        eq(linxRequestsTable.status, "pending"),
      ))
      .returning();
    if (updated) {
      res.json({ request: mapRequest(updated) });
      return;
    }

    const [existing] = await db.select().from(linxRequestsTable)
      .where(and(eq(linxRequestsTable.id, requestId), eq(linxRequestsTable.linxTenantId, linxTenantId)))
      .limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status === "declined") {
      res.json({ request: mapRequest(existing) });
      return;
    }
    res.status(409).json({ error: `Request is already ${existing.status}.` });
  } catch (err) {
    logger.error({ err }, "[linx-requests] decline failed");
    res.status(500).json({ error: "Failed to decline LINX request" });
  }
});

/* ── Step 4: manual terminal actions ──────────────────────────────────────
 * Backstop for the automatic hooks (hire choke-point + job close): a LINX
 * admin can mark an accepted engagement filled or closed directly from the
 * queue. STATUS FIELD ONLY — no billing/invoicing/fees (handled entirely
 * outside the system). Idempotent when already in the target state. */
function makeTerminalRoute(target: "filled" | "closed") {
  return async (req: Request, res: Response) => {
    try {
      const gate = await gateLinxAdmin(req, res);
      if (!gate) return;
      const { linxTenantId } = gate;
      const requestId = req.params.id;

      /* filled may also upgrade a premature 'closed' (a hire trumps it). */
      const fromStatuses = target === "filled" ? ["accepted", "closed"] : ["accepted"];
      const [updated] = await db.update(linxRequestsTable)
        .set({ status: target, resolvedAt: new Date() })
        .where(and(
          eq(linxRequestsTable.id, requestId),
          eq(linxRequestsTable.linxTenantId, linxTenantId),
          inArray(linxRequestsTable.status, fromStatuses as any),
        ))
        .returning();
      if (updated) { res.json({ request: mapRequest(updated) }); return; }

      const [existing] = await db.select().from(linxRequestsTable)
        .where(and(eq(linxRequestsTable.id, requestId), eq(linxRequestsTable.linxTenantId, linxTenantId)))
        .limit(1);
      if (!existing) { res.status(404).json({ error: "Not found" }); return; }
      if (existing.status === target) { res.json({ request: mapRequest(existing) }); return; }
      res.status(409).json({ error: `Request is ${existing.status} — only an accepted engagement can be marked ${target}.` });
    } catch (err) {
      logger.error({ err, target }, "[linx-requests] terminal mark failed");
      res.status(500).json({ error: `Failed to mark LINX request as ${target}` });
    }
  };
}

router.post("/linx/requests/:id/mark-filled", makeTerminalRoute("filled"));
router.post("/linx/requests/:id/mark-closed", makeTerminalRoute("closed"));

export default router;
