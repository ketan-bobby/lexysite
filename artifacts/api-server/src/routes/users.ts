/**
 * routes/users.ts — User Management (Recruiters & Admins)
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * CRUD for the users table, scoped to the roles and tenant hierarchy of
 * the requesting user. Candidate accounts are created via routes/auth.ts
 * and routes/invites.ts — this file handles recruiter/admin accounts only.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET    /users            List users visible to the caller
 *                             platform_admin → all users
 *                             tenant_admin / recruiter → own tenant users only
 *   POST   /users            Create a new user (platform_admin or tenant_admin)
 *                             tenant_admin may only create users in their own tenant
 *   GET    /users/:id        Get one user profile
 *   PUT    /users/:id        Update name / role / avatar (own profile or admin)
 *   DELETE /users/:id        Deactivate a user account
 *
 * ─── Role hierarchy ──────────────────────────────────────────────────────────
 *   platform_admin  — full access across all tenants
 *   tenant_admin    — full access within own tenant + child tenants
 *   hiring_manager  — read access to jobs and candidates in own tenant
 *   recruiter       — standard recruiter access (create/update jobs + candidates)
 *   candidate       — never returned by these routes (use /portal routes)
 *
 * ─── Tenant scoping ──────────────────────────────────────────────────────────
 * getAllowedTenantIds() from tenantUtils.ts is the single source of truth for
 * which tenantIds a given user is allowed to query.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable, tenantsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { getAllowedTenantIds } from "../lib/tenantUtils";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import { validate } from "../middlewares/validate";
import { validatePasswordStrength } from "../lib/password-policy";
import { unlockAccount } from "../lib/account-lockout";
import { logger } from "../lib/logger";

const CreateUserBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  role: z.string().min(1),
  name: z.string().optional(),
  tenantId: z.string().optional(),
});

const BCRYPT_ROUNDS = 12;

const router: IRouter = Router();

function mapUser(u: any, tenantName?: string | null) {
  return {
    id:         u.id,
    tenantId:   u.tenantId,
    tenantName: tenantName ?? null,
    email:      u.email,
    name:       u.name,
    role:       u.role,
    status:     u.status ?? "active",
    avatarUrl:  u.avatarUrl,
    createdAt:  u.createdAt.toISOString(),
  };
}

async function buildTenantNameMap(tenantIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(tenantIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: tenantsTable.id, name: tenantsTable.name })
    .from(tenantsTable)
    .where(inArray(tenantsTable.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/* ── GET /users ── tenant-scoped list ─────────────────────────────────────── */
router.get("/users", resolveUser, async (req, res) => {
  try {
    const user = req.resolvedUser!;
    const allowed = await getAllowedTenantIds(user);

    // Defensive cap: see lib/query-limits.ts.
    let users: any[];
    if (allowed === null) {
      users = await db.select().from(usersTable).limit(MAX_PAGE_SIZE);
    } else if (allowed.length === 0) {
      users = [];
    } else {
      users = await db.select().from(usersTable).where(inArray(usersTable.tenantId, allowed)).limit(MAX_PAGE_SIZE);
    }

    const tenantNames = await buildTenantNameMap(users.map((u) => u.tenantId));
    res.json(users.map((u) => mapUser(u, tenantNames.get(u.tenantId))));
  } catch (err) {
    res.status(500).json({ error: "Failed to load users" });
  }
});

/* ── PATCH /users/:userId ── admin updates (status, role, name) ─────────────
 * Currently used by Platform Admin to suspend / re-activate accounts.
 * platform_admin → any user; tenant_admin → users in their own tenant. */
const UpdateUserBody = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  name: z.string().min(1).optional(),
  role: z.enum(["platform_admin", "tenant_admin", "recruiter_admin", "hiring_manager", "recruiter", "interviewer"]).optional(),
});
router.patch("/users/:userId",
  validate({ body: UpdateUserBody }),
  resolveUser,
  requireRole("platform_admin", "tenant_admin", "recruiter_admin"),
  async (req, res) => {
    try {
      const caller = req.resolvedUser!;
      const [target] = await db.select().from(usersTable).where(eq(usersTable.id, req.params.userId)).limit(1);
      if (!target) { res.status(404).json({ error: "Not found" }); return; }

      const allowed = await getAllowedTenantIds(caller);
      if (allowed !== null && !allowed.includes(target.tenantId ?? "")) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (target.id === caller.id && req.body.status === "suspended") {
        res.status(400).json({ error: "Cannot suspend your own account" });
        return;
      }

      // Role-hierarchy enforcement. tenant_admin must never be able to mutate
      // a platform_admin target (suspend, rename, or demote), and only
      // platform_admin may grant the platform_admin role.
      if (caller.role !== "platform_admin") {
        if (target.role === "platform_admin") {
          res.status(403).json({ error: "Cannot modify a platform admin account" });
          return;
        }
        if (req.body.role === "platform_admin") {
          res.status(403).json({ error: "Cannot assign platform_admin role" });
          return;
        }
      }

      // Recruiter admins manage LINE STAFF only: they may suspend/rename/retitle
      // recruiters and hiring managers inside their OWN agency tenant, and may
      // never touch admins/interviewers/other roles, nor promote a target into
      // one. (getAllowedTenantIds above already confines to the agency subtree;
      // this further pins management to the agency tenant where line staff live.)
      if (caller.role === "recruiter_admin") {
        const LINE_STAFF = ["recruiter", "hiring_manager"];
        if (!LINE_STAFF.includes(target.role)) {
          res.status(403).json({ error: "Recruiter admins may only manage recruiters and hiring managers" });
          return;
        }
        if (target.tenantId !== caller.tenantId) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        if (req.body.role !== undefined && !LINE_STAFF.includes(req.body.role)) {
          res.status(403).json({ error: "Recruiter admins may only assign recruiter or hiring_manager roles" });
          return;
        }
      }

      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (req.body.status !== undefined) update.status = req.body.status;
      if (req.body.name   !== undefined) update.name   = req.body.name;
      if (req.body.role   !== undefined) update.role   = req.body.role;

      const [u] = await db.update(usersTable).set(update).where(eq(usersTable.id, target.id)).returning();
      logger.info(
        { userId: u.id, byUserId: caller.id, changed: Object.keys(update).filter((k) => k !== "updatedAt") },
        "[users/patch] admin updated user",
      );
      const tenantNames = await buildTenantNameMap([u.tenantId]);
      res.json(mapUser(u, tenantNames.get(u.tenantId)));
    } catch (err) {
      res.status(500).json({ error: "Failed to update user" });
    }
  });

/* ── POST /users ── platform_admin / tenant_admin only ───────────────────── */
router.post("/users", validate({ body: CreateUserBody }), resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter_admin"), async (req, res) => {
  try {
    const caller = req.resolvedUser!;
    const { email, name, role, password, tenantId } = req.body;

    if (!email || !password || !role) {
      res.status(400).json({ error: "email, password, and role are required" });
      return;
    }
    const policy = validatePasswordStrength(password);
    if (!policy.ok) {
      res.status(400).json({ error: policy.code, message: policy.message });
      return;
    }

    // Role allowlist — prevent privilege escalation
    const ALLOWED_ROLES_BY_CALLER: Record<string, string[]> = {
      platform_admin: ["platform_admin", "tenant_admin", "recruiter_admin", "hiring_manager", "recruiter", "interviewer"],
      tenant_admin:   ["tenant_admin", "recruiter_admin", "hiring_manager", "recruiter", "interviewer"],
      // Recruiter Admin manages line staff only — never other admins.
      recruiter_admin: ["recruiter", "hiring_manager"],
    };
    const allowedRoles = ALLOWED_ROLES_BY_CALLER[caller.role] || [];
    if (!allowedRoles.includes(role)) {
      res.status(403).json({ error: `Role '${role}' is not permitted for caller role '${caller.role}'` });
      return;
    }

    const targetTenantId = caller.role === "platform_admin"
      ? (tenantId || caller.tenantId)
      : caller.tenantId;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [u] = await db
      .insert(usersTable)
      .values({
        email,
        name,
        role,
        tenantId: targetTenantId || "default",
        passwordHash,
      })
      .returning();

    const tenantNames = await buildTenantNameMap([u.tenantId]);
    res.status(201).json(mapUser(u, tenantNames.get(u.tenantId)));
  } catch (err) {
    res.status(500).json({ error: "Failed to create user" });
  }
});

/* ── GET /users/:userId ── own-tenant guard ───────────────────────────────── */
router.get("/users/:userId", resolveUser, async (req, res) => {
  try {
    const caller = req.resolvedUser!;
    const [u] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.params.userId))
      .limit(1);

    if (!u) { res.status(404).json({ error: "Not found" }); return; }

    const allowed = await getAllowedTenantIds(caller);
    if (allowed !== null && !allowed.includes(u.tenantId ?? "")) {
      res.status(403).json({ error: "Forbidden" }); return;
    }

    const tenantNames = await buildTenantNameMap([u.tenantId]);
    res.json(mapUser(u, tenantNames.get(u.tenantId)));
  } catch (err) {
    res.status(500).json({ error: "Failed to load user" });
  }
});

/* ── POST /users/:userId/unlock ── admin-initiated account unlock ─────────
 * Clears the failed-login counter and lockedAt timestamp set by the auth
 * lockout in lib/account-lockout.ts. Required because the lockout
 * deliberately has no auto-expiry — locked accounts indicate a likely
 * credential-stuffing attempt and demand admin attention.
 *
 * Authorisation:
 *   - platform_admin: may unlock any user
 *   - tenant_admin:   may unlock users in their own tenant (and child
 *                     tenants — same scope as the GET /users list)
 *   - everyone else:  403
 */
router.post("/users/:userId/unlock", resolveUser, requireRole("platform_admin", "tenant_admin"), async (req, res) => {
  try {
    const caller = req.resolvedUser!;
    const [target] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.params.userId))
      .limit(1);

    if (!target) { res.status(404).json({ error: "Not found" }); return; }

    const allowed = await getAllowedTenantIds(caller);
    if (allowed !== null && !allowed.includes(target.tenantId ?? "")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    await unlockAccount(target.id);
    logger.info(
      { unlockedUserId: target.id, byUserId: caller.id, byRole: caller.role },
      "[users/unlock] account unlocked by admin",
    );
    res.json({ success: true, userId: target.id });
  } catch (err) {
    res.status(500).json({ error: "Failed to unlock user" });
  }
});

export default router;
