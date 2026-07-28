/**
 * routes/recruiter-admins.ts — Recruiter Admin ↔ Client (sub-tenant) management
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * A Tenant Admin owns billing and creates client sub-tenants, then assigns one
 * or more of those clients to a Recruiter Admin. A Recruiter Admin is scoped to
 * ONLY their assigned client sub-tenants (see lib/tenantUtils.getDataScopeTenantIds).
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET    /recruiter-admins                 List recruiter_admin users in the
 *                                            caller's subtree + each one's
 *                                            assigned clients, plus the set of
 *                                            available client sub-tenants.
 *                                            Requires tenant_admin/platform_admin.
 *   PUT    /recruiter-admins/:userId/clients Replace the full set of clients
 *                                            assigned to a recruiter_admin.
 *                                            Body: { clientTenantIds: string[] }.
 *                                            Requires tenant_admin/platform_admin.
 *   GET    /recruiter-admins/my/clients      The caller's OWN assigned clients
 *                                            (recruiter_admin self-service).
 *
 * ─── Scoping ─────────────────────────────────────────────────────────────────
 * Every foreign id (target user, each client tenant) is validated against the
 * caller's allowed subtree before any write. A client must be a `sub_client`
 * tenant inside the caller's agency. The assignment row's `tenant_id` is the
 * agency (the recruiter admin's own tenant) so the standard tenant_isolation
 * RLS policy applies uniformly.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { usersTable, tenantsTable, recruiterAdminClientsTable, recruiterManagersTable, jobsTable } from "@workspace/db";
import { and, eq, inArray, isNull, desc } from "drizzle-orm";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { getAllowedTenantIds, getRecruiterAdminClientTenantIds } from "../lib/tenantUtils";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const UpdateClientsBody = z.object({
  clientTenantIds: z.array(z.string()).default([]),
});

/* ── GET /recruiter-admins ──────────────────────────────────────────────────
   List recruiter_admin users in the caller's subtree, each with their assigned
   clients, plus the available client sub-tenants the caller may assign. */
router.get("/recruiter-admins", resolveUser, requireRole("platform_admin", "tenant_admin"), async (req, res) => {
  try {
    const caller = req.resolvedUser!;
    const allowed = await getAllowedTenantIds(caller); // null = platform_admin (all)

    // Recruiter admins visible to the caller.
    const adminRows = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, tenantId: usersTable.tenantId })
      .from(usersTable)
      .where(
        allowed === null
          ? eq(usersTable.role, "recruiter_admin")
          : and(eq(usersTable.role, "recruiter_admin"), inArray(usersTable.tenantId, allowed)),
      );

    // Available client sub-tenants the caller may assign.
    const clientRows = await db
      .select({ id: tenantsTable.id, name: tenantsTable.name, clientType: tenantsTable.clientType })
      .from(tenantsTable)
      .where(
        allowed === null
          ? eq(tenantsTable.clientType, "sub_client")
          : and(eq(tenantsTable.clientType, "sub_client"), inArray(tenantsTable.id, allowed)),
      );
    const clientNameMap = new Map(clientRows.map(c => [c.id, c.name]));

    // Assignments for the visible recruiter admins.
    const adminIds = adminRows.map(a => a.id);
    const assignmentsByAdmin = new Map<string, Array<{ clientTenantId: string; clientName: string | null }>>();
    if (adminIds.length > 0) {
      const assignRows = await db
        .select({
          recruiterAdminUserId: recruiterAdminClientsTable.recruiterAdminUserId,
          clientTenantId: recruiterAdminClientsTable.clientTenantId,
        })
        .from(recruiterAdminClientsTable)
        .where(inArray(recruiterAdminClientsTable.recruiterAdminUserId, adminIds));
      for (const r of assignRows) {
        const list = assignmentsByAdmin.get(r.recruiterAdminUserId) ?? [];
        list.push({ clientTenantId: r.clientTenantId, clientName: clientNameMap.get(r.clientTenantId) ?? null });
        assignmentsByAdmin.set(r.recruiterAdminUserId, list);
      }
    }

    res.json({
      recruiterAdmins: adminRows.map(a => ({
        id: a.id,
        name: a.name,
        email: a.email,
        tenantId: a.tenantId,
        clients: assignmentsByAdmin.get(a.id) ?? [],
      })),
      availableClients: clientRows.map(c => ({ id: c.id, name: c.name })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to list recruiter admins");
    res.status(500).json({ error: "Failed to list recruiter admins" });
  }
});

/* ── PUT /recruiter-admins/:userId/clients ──────────────────────────────────
   Replace the full set of clients assigned to a recruiter_admin. */
router.put(
  "/recruiter-admins/:userId/clients",
  validate({ body: UpdateClientsBody }),
  resolveUser,
  requireRole("platform_admin", "tenant_admin"),
  async (req, res) => {
    try {
      const caller = req.resolvedUser!;
      const { userId } = req.params;
      const { clientTenantIds } = req.body as { clientTenantIds: string[] };
      const allowed = await getAllowedTenantIds(caller); // null = platform_admin

      // Validate the target user: must exist, be a recruiter_admin, and (for a
      // tenant_admin caller) live inside the caller's subtree.
      const [target] = await db
        .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      if (!target || target.role !== "recruiter_admin") {
        res.status(404).json({ error: "Recruiter admin not found" });
        return;
      }
      if (allowed !== null && !allowed.includes(target.tenantId)) {
        res.status(403).json({ error: "Recruiter admin is outside your scope" });
        return;
      }

      // De-duplicate and validate each client: must be a sub_client tenant inside
      // the caller's scope.
      const uniqueClientIds = Array.from(new Set(clientTenantIds.filter(Boolean)));
      if (uniqueClientIds.length > 0) {
        const validClients = await db
          .select({ id: tenantsTable.id })
          .from(tenantsTable)
          .where(
            allowed === null
              ? and(inArray(tenantsTable.id, uniqueClientIds), eq(tenantsTable.clientType, "sub_client"))
              : and(
                  inArray(tenantsTable.id, uniqueClientIds),
                  eq(tenantsTable.clientType, "sub_client"),
                  inArray(tenantsTable.id, allowed),
                ),
          );
        if (validClients.length !== uniqueClientIds.length) {
          res.status(400).json({ error: "One or more clients are invalid or outside your scope" });
          return;
        }
      }

      // The agency tenant that owns the assignment row = the recruiter admin's
      // own tenant. Replace-set atomically.
      const agencyTenantId = target.tenantId;
      await db.transaction(async (tx) => {
        await tx.delete(recruiterAdminClientsTable)
          .where(eq(recruiterAdminClientsTable.recruiterAdminUserId, userId));
        if (uniqueClientIds.length > 0) {
          await tx.insert(recruiterAdminClientsTable).values(
            uniqueClientIds.map(clientTenantId => ({
              tenantId: agencyTenantId,
              recruiterAdminUserId: userId,
              clientTenantId,
              assignedByUserId: caller.id,
            })),
          );
        }
      });

      res.json({ ok: true, userId, clientTenantIds: uniqueClientIds });
    } catch (err) {
      logger.error({ err }, "Failed to update recruiter admin clients");
      res.status(500).json({ error: "Failed to update recruiter admin clients" });
    }
  },
);

/* ── GET /recruiter-admins/my/clients ───────────────────────────────────────
   The caller's OWN assigned clients (recruiter_admin self-service). */
router.get("/recruiter-admins/my/clients", resolveUser, requireRole("recruiter_admin"), async (req, res) => {
  try {
    const caller = req.resolvedUser!;
    const clientIds = await getRecruiterAdminClientTenantIds(caller.id);
    if (clientIds.length === 0) {
      res.json({ clients: [] });
      return;
    }
    const rows = await db
      .select({ id: tenantsTable.id, name: tenantsTable.name })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, clientIds));
    res.json({ clients: rows });
  } catch (err) {
    logger.error({ err }, "Failed to list own clients");
    res.status(500).json({ error: "Failed to list clients" });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
   Recruiter → Recruiter Admin reporting links (recruiter_managers)

   A recruiter may report to MULTIPLE recruiter admins. A Tenant Admin sets these
   links on the Team page. Mirrors the client-assignment endpoints above:
   tenant/subtree scoped, every foreign id validated, replace-set is atomic.
   ────────────────────────────────────────────────────────────────────────── */

const UpdateManagersBody = z.object({
  recruiterAdminUserIds: z.array(z.string()).default([]),
  // When set, the reporting links are scoped to this single work order
  // (jobs.id) as an override. Omitted / null = the recruiter's DEFAULT reporting.
  jobId: z.string().nullish(),
});

/* ── GET /recruiter-reporting ───────────────────────────────────────────────
   List recruiter users in the caller's subtree, each with the recruiter admins
   they report to, plus the recruiter admins available to assign as managers. */
router.get("/recruiter-reporting", resolveUser, requireRole("platform_admin", "tenant_admin"), async (req, res) => {
  try {
    const caller = req.resolvedUser!;
    const allowed = await getAllowedTenantIds(caller); // null = platform_admin (all)

    // Recruiters visible to the caller.
    const recruiterRows = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, tenantId: usersTable.tenantId })
      .from(usersTable)
      .where(
        allowed === null
          ? eq(usersTable.role, "recruiter")
          : and(eq(usersTable.role, "recruiter"), inArray(usersTable.tenantId, allowed)),
      );

    // Recruiter admins the caller may assign as managers.
    const adminRows = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(
        allowed === null
          ? eq(usersTable.role, "recruiter_admin")
          : and(eq(usersTable.role, "recruiter_admin"), inArray(usersTable.tenantId, allowed)),
      );
    const adminInfoMap = new Map(adminRows.map(a => [a.id, a]));

    const recruiterIds = recruiterRows.map(r => r.id);
    type ManagerInfo = { recruiterAdminUserId: string; name: string | null; email: string | null };

    // Reporting links (both default and per-work-order) for the visible
    // recruiters. job_id NULL = default reporting; a value = a work-order override.
    const defaultManagers = new Map<string, ManagerInfo[]>();          // recruiterId -> managers
    const woManagers = new Map<string, ManagerInfo[]>();               // `${recruiterId}:${jobId}` -> managers
    if (recruiterIds.length > 0) {
      const linkRows = await db
        .select({
          recruiterUserId: recruiterManagersTable.recruiterUserId,
          recruiterAdminUserId: recruiterManagersTable.recruiterAdminUserId,
          jobId: recruiterManagersTable.jobId,
        })
        .from(recruiterManagersTable)
        .where(inArray(recruiterManagersTable.recruiterUserId, recruiterIds));
      for (const l of linkRows) {
        // Only surface managers still visible to the caller.
        const info = adminInfoMap.get(l.recruiterAdminUserId);
        if (!info) continue;
        const entry: ManagerInfo = { recruiterAdminUserId: l.recruiterAdminUserId, name: info.name, email: info.email };
        if (l.jobId) {
          const key = `${l.recruiterUserId}:${l.jobId}`;
          const list = woManagers.get(key) ?? [];
          list.push(entry);
          woManagers.set(key, list);
        } else {
          const list = defaultManagers.get(l.recruiterUserId) ?? [];
          list.push(entry);
          defaultManagers.set(l.recruiterUserId, list);
        }
      }
    }

    // Work orders (jobs) assigned to the visible recruiters, within scope.
    const jobsByRecruiter = new Map<string, Array<{ id: string; title: string; workOrderNumber: string | null; tenantId: string }>>();
    const clientTenantIds = new Set<string>();
    if (recruiterIds.length > 0) {
      const jobRows = await db
        .select({
          id: jobsTable.id,
          title: jobsTable.title,
          workOrderNumber: jobsTable.workOrderNumber,
          tenantId: jobsTable.tenantId,
          assignedRecruiterId: jobsTable.assignedRecruiterId,
        })
        .from(jobsTable)
        .where(
          allowed === null
            ? inArray(jobsTable.assignedRecruiterId, recruiterIds)
            : and(inArray(jobsTable.assignedRecruiterId, recruiterIds), inArray(jobsTable.tenantId, allowed)),
        )
        .orderBy(desc(jobsTable.createdAt));
      for (const j of jobRows) {
        if (!j.assignedRecruiterId) continue;
        const list = jobsByRecruiter.get(j.assignedRecruiterId) ?? [];
        list.push({ id: j.id, title: j.title, workOrderNumber: j.workOrderNumber, tenantId: j.tenantId });
        jobsByRecruiter.set(j.assignedRecruiterId, list);
        clientTenantIds.add(j.tenantId);
      }
    }

    // Client (sub-tenant) display names for the work orders.
    const clientNameMap = new Map<string, string>();
    // Recruiter admins assigned to each client → the admins available to
    // supervise a work order for that client.
    const adminsByClient = new Map<string, ManagerInfo[]>();
    if (clientTenantIds.size > 0) {
      const ids = Array.from(clientTenantIds);
      const [clientRows, racRows] = await Promise.all([
        db.select({ id: tenantsTable.id, name: tenantsTable.name }).from(tenantsTable).where(inArray(tenantsTable.id, ids)),
        db
          .select({
            clientTenantId: recruiterAdminClientsTable.clientTenantId,
            recruiterAdminUserId: recruiterAdminClientsTable.recruiterAdminUserId,
          })
          .from(recruiterAdminClientsTable)
          .where(inArray(recruiterAdminClientsTable.clientTenantId, ids)),
      ]);
      for (const c of clientRows) clientNameMap.set(c.id, c.name);
      for (const rac of racRows) {
        const info = adminInfoMap.get(rac.recruiterAdminUserId);
        if (!info) continue; // only admins visible to the caller
        const list = adminsByClient.get(rac.clientTenantId) ?? [];
        list.push({ recruiterAdminUserId: rac.recruiterAdminUserId, name: info.name, email: info.email });
        adminsByClient.set(rac.clientTenantId, list);
      }
    }

    res.json({
      recruiters: recruiterRows.map(r => ({
        id: r.id,
        name: r.name,
        email: r.email,
        tenantId: r.tenantId,
        // Default reporting (applies to every work order not customised).
        managers: defaultManagers.get(r.id) ?? [],
        // Per-work-order reporting overrides.
        workOrders: (jobsByRecruiter.get(r.id) ?? []).map(j => ({
          jobId: j.id,
          title: j.title,
          workOrderNumber: j.workOrderNumber,
          clientTenantId: j.tenantId,
          clientName: clientNameMap.get(j.tenantId) ?? null,
          managers: woManagers.get(`${r.id}:${j.id}`) ?? [],
          // Admins assigned to this work order's client (preferred choices).
          availableAdmins: adminsByClient.get(j.tenantId) ?? [],
        })),
      })),
      availableRecruiterAdmins: adminRows.map(a => ({ id: a.id, name: a.name, email: a.email })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to list recruiter reporting");
    res.status(500).json({ error: "Failed to list recruiter reporting" });
  }
});

/* ── PUT /recruiters/:userId/managers ───────────────────────────────────────
   Replace the full set of recruiter admins a recruiter reports to. */
router.put(
  "/recruiters/:userId/managers",
  validate({ body: UpdateManagersBody }),
  resolveUser,
  requireRole("platform_admin", "tenant_admin"),
  async (req, res) => {
    try {
      const caller = req.resolvedUser!;
      const { userId } = req.params;
      const { recruiterAdminUserIds, jobId } = req.body as { recruiterAdminUserIds: string[]; jobId?: string | null };
      const allowed = await getAllowedTenantIds(caller); // null = platform_admin

      // Validate the target user: must exist, be a recruiter, and (for a
      // tenant_admin caller) live inside the caller's subtree.
      const [target] = await db
        .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .limit(1);
      if (!target || target.role !== "recruiter") {
        res.status(404).json({ error: "Recruiter not found" });
        return;
      }
      if (allowed !== null && !allowed.includes(target.tenantId)) {
        res.status(403).json({ error: "Recruiter is outside your scope" });
        return;
      }

      // If this is a per-work-order override, validate the work order: it must
      // exist, be assigned to THIS recruiter, and live inside the caller's scope.
      const scopedJobId = jobId ?? null;
      if (scopedJobId) {
        const [job] = await db
          .select({ id: jobsTable.id, tenantId: jobsTable.tenantId, assignedRecruiterId: jobsTable.assignedRecruiterId })
          .from(jobsTable)
          .where(eq(jobsTable.id, scopedJobId))
          .limit(1);
        if (!job || job.assignedRecruiterId !== userId) {
          res.status(404).json({ error: "Work order not found for this recruiter" });
          return;
        }
        if (allowed !== null && !allowed.includes(job.tenantId)) {
          res.status(403).json({ error: "Work order is outside your scope" });
          return;
        }
      }

      // De-duplicate and validate each manager: must be a recruiter_admin inside
      // the caller's scope.
      const uniqueAdminIds = Array.from(new Set(recruiterAdminUserIds.filter(Boolean)));
      if (uniqueAdminIds.length > 0) {
        const validAdmins = await db
          .select({ id: usersTable.id })
          .from(usersTable)
          .where(
            allowed === null
              ? and(inArray(usersTable.id, uniqueAdminIds), eq(usersTable.role, "recruiter_admin"))
              : and(
                  inArray(usersTable.id, uniqueAdminIds),
                  eq(usersTable.role, "recruiter_admin"),
                  inArray(usersTable.tenantId, allowed),
                ),
          );
        if (validAdmins.length !== uniqueAdminIds.length) {
          res.status(400).json({ error: "One or more recruiter admins are invalid or outside your scope" });
          return;
        }
      }

      // The agency tenant that owns the reporting row = the recruiter's own
      // tenant. Replace-set atomically, scoped to the default (job_id IS NULL)
      // or the single work order being edited so the other scope is untouched.
      const agencyTenantId = target.tenantId;
      await db.transaction(async (tx) => {
        await tx.delete(recruiterManagersTable)
          .where(
            scopedJobId
              ? and(eq(recruiterManagersTable.recruiterUserId, userId), eq(recruiterManagersTable.jobId, scopedJobId))
              : and(eq(recruiterManagersTable.recruiterUserId, userId), isNull(recruiterManagersTable.jobId)),
          );
        if (uniqueAdminIds.length > 0) {
          await tx.insert(recruiterManagersTable).values(
            uniqueAdminIds.map(recruiterAdminUserId => ({
              tenantId: agencyTenantId,
              recruiterUserId: userId,
              recruiterAdminUserId,
              jobId: scopedJobId,
              assignedByUserId: caller.id,
            })),
          );
        }
      });

      res.json({ ok: true, userId, jobId: scopedJobId, recruiterAdminUserIds: uniqueAdminIds });
    } catch (err) {
      logger.error({ err }, "Failed to update recruiter managers");
      res.status(500).json({ error: "Failed to update recruiter managers" });
    }
  },
);

export default router;
