/**
 * routes/tenants.ts — Tenant (Client) Management
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Full CRUD for the tenants table plus child-tenant hierarchy management,
 * aggregate statistics, and staff invite token generation.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET    /tenants                 List tenants visible to the caller.
 *                                   platform_admin → all tenants
 *                                   tenant_admin   → own tenant + direct children
 *   POST   /tenants                 Create a new tenant (platform_admin only)
 *   GET    /tenants/:id             Get one tenant + stats + children
 *   PUT    /tenants/:id             Update tenant profile (name, logo, settings)
 *   DELETE /tenants/:id             Soft-delete a tenant (platform_admin only)
 *   GET    /tenants/:id/stats       Aggregated counts (jobs, candidates, users, etc.)
 *   GET    /tenants/:id/children    Direct child tenants (branches + sub-clients)
 *   POST   /tenants/:id/invite      Generate a staff invite token (returns a URL)
 *   POST   /tenants/:id/branding    Update logo / colour scheme
 *
 * ─── Tenant hierarchy ────────────────────────────────────────────────────────
 * The tenants table supports a 2-level parent → child structure:
 *   platform tenant (clientType="platform")
 *     └─ agency tenant (clientType="agency" | "corporate")
 *          ├─ branch  (clientType="branch", parentId=agencyId)
 *          └─ sub-client (clientType="sub_client", parentId=agencyId)
 *
 * canAccessTenantAsync() walks the parentId chain upward from the target
 * tenant to check if the caller's tenantId appears anywhere in the ancestry.
 * This allows a parent-tenant admin to manage all their child tenants.
 *
 * ─── Staff invite tokens ─────────────────────────────────────────────────────
 * POST /tenants/:id/invite generates a UUID token stored in staff_invite_tokens
 * with a 7-day TTL. The invite URL is POST /auth/accept-invite/:token which
 * creates the user row and sets the tenantId automatically.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { tenantsTable, usersTable, jobsTable, candidatesTable, interviewSessionsTable, applicationsTable, staffInviteTokensTable } from "@workspace/db";
import { applyCandidatePrivacyFilter, applyCandidateHardExclusions } from "./candidates";
import { eq, count, isNull, and, inArray, gt, sql } from "drizzle-orm";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import { logger } from "../lib/logger";
import { REGIONS, isRegion, assertChildRegionMatches, type Region } from "../lib/region";
import { checkSubClientCreationAllowed, checkSeatInviteAllowed, buildLimitExceededBody, resolveRootTenantId } from "../lib/plan-enforcement";
import { advanceByTerm, isBillingTerm, getCountryPrice, TERM_MONTHS, type BillingTerm, type PlanCode } from "../lib/plans";
import { feeLineItemsTable } from "@workspace/db";

const CreateTenantBody = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  plan: z.string().optional(),
  parentId: z.string().optional().nullable(),
  clientType: z.string().optional(),
  industry: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  contactEmail: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  candidateDatabaseAccess: z.boolean().optional(),
  /** Multi-region Phase 0. Only honoured for root tenants created by a
   *  platform_admin. Children inherit the parent's region and any value
   *  here that disagrees with the parent is rejected with 400. */
  region: z.enum(REGIONS).optional(),
  /** Billing COUNTRY (ISO-3166-1 alpha-2). Separate from `region`. Only
   *  honoured for root tenants; children inherit the parent's country.
   *  Optional — null/omitted means "pending" (a platform_admin sets it later
   *  via the billing endpoint). Immutable once set. */
  country: z.string().length(2).optional().nullable(),
}).passthrough();

/* Strict allowlist for PUT /tenants/:tenantId.
 *
 * Unknown keys are stripped. Notably excluded: id, parentId, createdAt,
 * createdById, stripeCustomerId, plan (use plan-change flow),
 * planActivatedAt, status (use lifecycle flow), partnerId (use
 * attribution flow), trialWarning*SentAt (scheduler-managed). */
const UpdateTenantBody = z.object({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  logoUrl: z.string().nullable().optional(),
  primaryColor: z.string().nullable().optional(),
  clientType: z.string().optional(),
  industry: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  candidateDatabaseAccess: z.boolean().optional(),
  autoSendSafeReplies: z.boolean().optional(),
  /* region is intentionally NOT updatable — data-residency cell is
   * immutable after tenant creation (Phase 0 invariant). Changing it
   * would require physically migrating tenant data between cells, which
   * is a separate ops procedure, not a PUT. */
});

const CreateMemberBody = z.object({
  email: z.string().min(1),
  name: z.string().optional().nullable(),
  role: z.string().optional(),
}).passthrough();

const DatabaseAccessBody = z.object({
  enabled: z.boolean(),
});

const router: IRouter = Router();

/** Render a tenant row for the wire.
 *
 * `viewerRole` controls whether the operator-only `billingNotes` field is
 * included. Pass `req.resolvedUser?.role` from every call site — the
 * default is the strictest setting (omit notes). billing_notes contains
 * PO numbers, AP contact emails, and deal-owner names; only platform_admin
 * may see it. Every other role (tenant_admin, recruiter, hiring_manager,
 * etc.) receives the row without it. */
function mapTenant(
  t: any,
  extras: any = {},
  opts: { viewerRole?: string } = {},
) {
  const { billingNotes, ...rest } = t ?? {};
  const isPlatformAdmin = opts.viewerRole === "platform_admin";
  return {
    ...rest,
    ...(isPlatformAdmin ? { billingNotes } : {}),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    paidThroughAt: t.paidThroughAt ? new Date(t.paidThroughAt).toISOString() : null,
    ...extras,
  };
}

async function getTenantStats(tenantId: string) {
  const [jobs] = await db.select({ count: count() }).from(jobsTable).where(eq(jobsTable.tenantId, tenantId));
  const [candidates] = await db.select({ count: count() }).from(candidatesTable).where(eq(candidatesTable.tenantId, tenantId));
  const [users] = await db.select({ count: count() }).from(usersTable).where(eq(usersTable.tenantId, tenantId));
  const [branches] = await db.select({ count: count() }).from(tenantsTable)
    .where(and(eq(tenantsTable.parentId, tenantId), inArray(tenantsTable.clientType, ["branch"])));
  const [subClients] = await db.select({ count: count() }).from(tenantsTable)
    .where(and(eq(tenantsTable.parentId, tenantId), inArray(tenantsTable.clientType, ["sub_client"])));
  return {
    jobCount: Number(jobs.count),
    candidateCount: Number(candidates.count),
    userCount: Number(users.count),
    branchCount: Number(branches.count),
    subClientCount: Number(subClients.count),
    childCount: Number(branches.count) + Number(subClients.count),
  };
}

/**
 * Verify that the requesting user owns (or is a platform_admin of) the given tenantId.
 * Returns true if access is permitted.
 */
function canAccessTenant(userRole: string, userTenantId: string | null, targetTenantId: string): boolean {
  if (userRole === "platform_admin") return true;
  return userTenantId === targetTenantId;
}

/**
 * Async variant: tenant_admin may access any tenant within their own subtree
 * (their own tenant, direct children, grandchildren, etc.).
 */
async function canAccessTenantAsync(userRole: string, userTenantId: string | null, targetTenantId: string): Promise<boolean> {
  if (userRole === "platform_admin") return true;
  if (!userTenantId) return false;
  if (userTenantId === targetTenantId) return true;
  let cursor: string | null = targetTenantId;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    if (cursor === userTenantId) return true;
    const [row] = await db.select({ parentId: tenantsTable.parentId })
      .from(tenantsTable).where(eq(tenantsTable.id, cursor)).limit(1);
    if (!row) return false;
    cursor = row.parentId;
  }
  return false;
}

/* ── GET /tenants ─────────────────────────────────────────────────────────── */
// platform_admin  → can fetch topLevel=true (all root tenants) or any parentId
// tenant_admin    → can only fetch their own children (parentId must equal their tenantId)
// recruiter       → same scope as tenant_admin (read-only; their own children)
// recruiter_admin → same scope as recruiter (read-only; their own children) so
//                   they can see every client under their agency, including
//                   ones they are not yet mapped to in recruiter_admin_clients
// others          → 403
router.get("/tenants", resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter", "recruiter_admin"), async (req, res) => {
  const { parentId, topLevel } = req.query;
  const user = req.resolvedUser!;

  if (user.role === "tenant_admin" || user.role === "recruiter" || user.role === "recruiter_admin") {
    // Scoped users may only list children of their own tenant.
    // If no parentId is provided, auto-scope to their own tenantId.
    const requestedParentId = (parentId as string | undefined) ?? user.tenantId ?? "";
    if (!requestedParentId || requestedParentId !== user.tenantId) {
      res.status(403).json({ error: "Forbidden: may only list clients under your own tenant" });
      return;
    }
    const tenants = await db.select().from(tenantsTable)
      .where(eq(tenantsTable.parentId, user.tenantId!))
      .limit(MAX_PAGE_SIZE);
    const result = await Promise.all(tenants.map(async (t) => mapTenant(t, await getTenantStats(t.id), { viewerRole: user.role })));
    res.json(result);
    return;
  }

  // platform_admin — unrestricted. Defensive cap: see lib/query-limits.ts.
  let tenants;
  if (topLevel === "true") {
    tenants = await db.select().from(tenantsTable).where(isNull(tenantsTable.parentId)).limit(MAX_PAGE_SIZE);
  } else if (parentId) {
    tenants = await db.select().from(tenantsTable).where(eq(tenantsTable.parentId, parentId as string)).limit(MAX_PAGE_SIZE);
  } else {
    tenants = await db.select().from(tenantsTable).limit(MAX_PAGE_SIZE);
  }
  const result = await Promise.all(tenants.map(async (t) => mapTenant(t, await getTenantStats(t.id), { viewerRole: user.role })));
  res.json(result);
});

/* ── POST /tenants ────────────────────────────────────────────────────────── */
// platform_admin  → can create a top-level tenant (no parentId required)
// tenant_admin    → can only create a child under their own tenant (parentId is forced)
router.post("/tenants", validate({ body: CreateTenantBody }), resolveUser, requireRole("platform_admin", "tenant_admin"), async (req, res) => {
  const user = req.resolvedUser!;
  const { name, slug, plan, parentId, clientType, industry, website, contactEmail, address, candidateDatabaseAccess, region: requestedRegion, country: requestedCountry } = req.body as { region?: Region; country?: string | null } & Record<string, any>;

  let resolvedParentId: string | null = parentId || null;

  if (user.role === "tenant_admin") {
    // Tenant admins cannot create top-level (root) tenants
    if (!resolvedParentId) {
      resolvedParentId = user.tenantId;
    } else if (resolvedParentId !== user.tenantId) {
      // Allow creating children anywhere within the admin's own tenant subtree.
      // Walk up the ancestor chain from the requested parent and confirm it
      // eventually reaches the admin's own tenantId.
      let cursor: string | null = resolvedParentId;
      let isInSubtree = false;
      const visited = new Set<string>();
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        if (cursor === user.tenantId) { isInSubtree = true; break; }
        const [row] = await db.select({ parentId: tenantsTable.parentId })
          .from(tenantsTable).where(eq(tenantsTable.id, cursor)).limit(1);
        if (!row) break;
        cursor = row.parentId;
      }
      if (!isInSubtree) {
        res.status(403).json({ error: "Forbidden: cannot create clients under a different tenant" });
        return;
      }
    }
  }

  /* Plan & candidate-database access are platform-level commercial
   * entitlements. A tenant_admin spinning up their own sub-client must
   * NOT be able to upgrade a child's plan or grant portal-pool access —
   * those decisions belong to Lexy ops. For non-platform callers we
   * ignore the request-body values and inherit from the parent tenant
   * (which is the admin's own tenant or a node in its subtree). */
  let effectivePlan = plan;
  let effectiveDbAccess = candidateDatabaseAccess || false;
  /* Region resolution (Multi-region Phase 0):
   *   • Children always inherit the parent's region. Any mismatch in the
   *     request body is a 400 — multi-region nesting is not supported.
   *   • Root tenants (no parent) accept a region from the body. Only a
   *     platform_admin may create root tenants in the first place, so this
   *     branch only fires for them. Default 'us' if unspecified. */
  let effectiveRegion: Region = "us";
  /* Billing COUNTRY resolution (separate from region):
   *   • Children always inherit the parent's country (immutable, like region).
   *   • Root tenants accept an ISO-2 country from the body (uppercased), or
   *     null = pending (a platform_admin sets it later). */
  let effectiveCountry: string | null = null;
  if (resolvedParentId) {
    const [parent] = await db
      .select({
        plan: tenantsTable.plan,
        candidateDatabaseAccess: tenantsTable.candidateDatabaseAccess,
        region: tenantsTable.region,
        country: tenantsTable.country,
      })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, resolvedParentId))
      .limit(1);
    const parentRegion = (parent?.region as Region | undefined) ?? "us";
    if (requestedRegion && requestedRegion !== parentRegion) {
      try {
        assertChildRegionMatches(parentRegion, requestedRegion);
      } catch (err: any) {
        res.status(err.status || 400).json({ error: err.code || "REGION_MISMATCH", message: err.message });
        return;
      }
    }
    effectiveRegion = parentRegion;
    effectiveCountry = parent?.country ?? null;
    if (user.role !== "platform_admin") {
      effectivePlan     = parent?.plan ?? "starter";
      effectiveDbAccess = false; // never auto-grant; platform_admin toggles via /database-access
    }
  } else {
    if (requestedRegion && !isRegion(requestedRegion)) {
      res.status(400).json({ error: "INVALID_REGION", message: `region must be one of: ${REGIONS.join(", ")}` });
      return;
    }
    effectiveRegion = (requestedRegion as Region) || "us";
    effectiveCountry = requestedCountry ? requestedCountry.toUpperCase() : null;
  }

  // Plan-limit gate: sub-client cap on the root tenant. Only enforce when
  // creating an actual sub-client (i.e. there's a parent and the resolved
  // clientType is 'sub_client'). platform_admin creating top-level tenants,
  // branches, or other non-sub_client child types is not metered here.
  //
  // Sub-clients are leaves by convention (Lexy → root tenant → flat list of
  // sub-clients, no further nesting). We enforce that invariant here so the
  // cap can't be bypassed by parenting a new sub-client under an existing
  // sub-client/branch (which would not be counted by the root direct-child
  // query).
  const effectiveClientType = clientType || (resolvedParentId ? "sub_client" : "direct");
  if (resolvedParentId && effectiveClientType === "sub_client") {
    const rootId = await resolveRootTenantId(resolvedParentId);
    if (resolvedParentId !== rootId) {
      res.status(400).json({
        error: "INVALID_PARENT",
        message: "Sub-clients must be created directly under the root contracting tenant; nested sub-clients are not supported.",
      });
      return;
    }
    const subCheck = await checkSubClientCreationAllowed(resolvedParentId);
    if (!subCheck.allowed) {
      res.status(402).json(buildLimitExceededBody(subCheck));
      return;
    }
  }

  const [tenant] = await db.insert(tenantsTable).values({
    name, slug, plan: effectivePlan,
    parentId: resolvedParentId,
    clientType: effectiveClientType,
    industry, website, contactEmail, address,
    candidateDatabaseAccess: effectiveDbAccess,
    region: effectiveRegion,
    country: effectiveCountry,
    createdById: user.id,
  }).returning();
  res.status(201).json(mapTenant(tenant, { jobCount: 0, candidateCount: 0, userCount: 0, branchCount: 0 }, { viewerRole: user.role }));
});

/* ── GET /tenants/:tenantId ───────────────────────────────────────────────── */
// platform_admin  → any tenant
// tenant_admin    → only their own tenant or tenants in their subtree
// recruiter_admin → read-only; same subtree scope as tenant_admin
router.get("/tenants/:tenantId", resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter_admin"), async (req, res) => {
  const user = req.resolvedUser!;
  const [tenant] = await db.select().from(tenantsTable)
    .where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }

  if (user.role === "tenant_admin" || user.role === "recruiter_admin") {
    if (!(await canAccessTenantAsync(user.role, user.tenantId, tenant.id))) {
      res.status(404).json({ error: "Not found" });
      return;
    }
  }

  res.json(mapTenant(tenant, await getTenantStats(tenant.id), { viewerRole: user.role }));
});

/* ── PATCH /tenants/:tenantId/billing ─────────────────────────────────────
 *
 * Platform-admin only. The single write-path for the manual / sales-led
 * billing fields introduced in migration 0013. Lives on its own endpoint
 * (and not folded into the general PUT) so the audit trail is sharp and
 * so the field allowlist for tenant-admin self-service updates stays
 * narrow.
 *
 * Body shape — every field optional, only supplied keys are written:
 *   {
 *     plan?:           "demo" | "starter" | "growth" | "enterprise",
 *     status?:         "active" | "suspended" | "trial",
 *     billingTerm?:    "monthly" | "annual",
 *     paidThroughAt?:  ISO-8601 string | null,   // null = clear override
 *     billingNotes?:   string | null,            // null = clear notes
 *     planActivatedAt?: ISO-8601 string,          // optional reset on plan change
 *   }
 *
 * The response includes billingNotes (platform_admin caller). */
const BillingPatchBody = z.object({
  plan: z.enum(["demo", "starter", "growth", "enterprise"]).optional(),
  status: z.enum(["active", "past_due", "suspended", "trial"]).optional(),
  billingTerm: z.enum(["monthly", "quarterly", "annual"]).optional(),
  paidThroughAt: z.union([z.string().datetime(), z.null()]).optional(),
  billingNotes: z.union([z.string().max(2000), z.null()]).optional(),
  planActivatedAt: z.string().datetime().optional(),
  /** ISO-2 billing country. One-time set: only written when the tenant's
   *  country is still null (pending). Immutable once set. */
  country: z.string().length(2).optional(),
});
router.patch("/tenants/:tenantId/billing",
  validate({ body: BillingPatchBody }),
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const body = req.body as z.infer<typeof BillingPatchBody>;
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.plan !== undefined)            update.plan = body.plan;
    if (body.status !== undefined)          update.status = body.status;
    if (body.billingTerm !== undefined)     update.billingTerm = body.billingTerm;
    if (body.paidThroughAt !== undefined)   update.paidThroughAt = body.paidThroughAt === null ? null : new Date(body.paidThroughAt);
    if (body.billingNotes !== undefined)    update.billingNotes = body.billingNotes;
    if (body.planActivatedAt !== undefined) update.planActivatedAt = new Date(body.planActivatedAt);

    // Snapshot the pre-change row once — used by the one-time country rule
    // below AND the proration ledger entry on plan changes.
    const [existing] = await db.select({
      country: tenantsTable.country,
      plan: tenantsTable.plan,
      paidThroughAt: tenantsTable.paidThroughAt,
    }).from(tenantsTable).where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    // Country is a one-time set: only writable while still null (pending).
    // Once set it is immutable (matches the create-time inheritance rule).
    if (body.country !== undefined) {
      if (existing.country && existing.country !== body.country.toUpperCase()) {
        res.status(409).json({
          error: "COUNTRY_IMMUTABLE",
          message:
            `Billing country is already set to ${existing.country} and cannot be changed here. ` +
            `If it was set incorrectly, a platform admin can use POST /tenants/:id/correct-country (audited).`,
        });
        return;
      }
      if (!existing.country) update.country = body.country.toUpperCase();
    }

    const [tenant] = await db.update(tenantsTable)
      .set(update)
      .where(eq(tenantsTable.id, req.params.tenantId))
      .returning();
    if (!tenant) { res.status(404).json({ error: "Not found" }); return; }

    logger.info({
      actorId: req.resolvedUser!.id,
      tenantId: tenant.id,
      changed: Object.keys(update).filter(k => k !== "updatedAt"),
    }, "[billing] platform_admin manual billing update");

    // ── Proration ledger entry on mid-cycle plan change ──
    // delta = (new monthly − old monthly) × remaining_days / 30, recorded as
    // an itemType='proration' fee-ledger line (positive = amount owed for the
    // upgrade, negative = credit for a downgrade). Only when the tenant has
    // paid time remaining; skipped for "contact us" pricing (-1 amounts) —
    // Enterprise deltas are negotiated, not computed. Best-effort: a ledger
    // failure never rolls back the plan change itself (it's logged loudly).
    if (body.plan !== undefined && existing.plan && body.plan !== existing.plan) {
      try {
        const remainingMs = existing.paidThroughAt
          ? new Date(existing.paidThroughAt).getTime() - Date.now()
          : 0;
        const remainingDays = Math.max(0, Math.ceil(remainingMs / 86_400_000));
        if (remainingDays > 0) {
          const [oldPrice, newPrice] = await Promise.all([
            getCountryPrice(existing.country, existing.plan as PlanCode, "monthly"),
            getCountryPrice(existing.country, body.plan as PlanCode, "monthly"),
          ]);
          if (oldPrice.amount >= 0 && newPrice.amount >= 0) {
            const delta = Math.round((newPrice.amount - oldPrice.amount) * (remainingDays / 30) * 100) / 100;
            if (delta !== 0) {
              await db.insert(feeLineItemsTable).values({
                tenantId: tenant.id,
                itemType: "proration",
                planCode: body.plan,
                amount: delta,
                currency: newPrice.currency,
                description:
                  `Plan change proration: ${existing.plan} → ${body.plan}, ${remainingDays} day(s) remaining ` +
                  `(${newPrice.symbol}${newPrice.amount} − ${oldPrice.symbol}${oldPrice.amount})/mo × ${remainingDays}/30` +
                  (delta < 0 ? " — credit to tenant" : ""),
                evidence: {
                  oldPlan: existing.plan, newPlan: body.plan, remainingDays,
                  oldMonthly: oldPrice.amount, newMonthly: newPrice.amount,
                  priceSource: { old: oldPrice.source, new: newPrice.source },
                  actorId: req.resolvedUser!.id,
                },
              });
              logger.info({ tenantId: tenant.id, oldPlan: existing.plan, newPlan: body.plan, delta, remainingDays },
                "[billing] proration ledger line created");
            }
          } else {
            logger.warn({ tenantId: tenant.id, oldPlan: existing.plan, newPlan: body.plan },
              "[billing] proration skipped — contact-us pricing on one side (negotiate manually)");
          }
        }
      } catch (err) {
        logger.error({ err: (err as Error)?.message, tenantId: tenant.id },
          "[billing] proration ledger insert FAILED — record manually via the fee ledger");
      }
    }

    res.json(mapTenant(tenant, await getTenantStats(tenant.id), { viewerRole: req.resolvedUser!.role }));
  });

/* ── POST /tenants/:tenantId/correct-country ──────────────────────────────
 *
 * The DOCUMENTED escape hatch for the country-immutability rule. Billing
 * country is immutable through all normal write paths (pricing integrity),
 * but a support setup error at signup must be fixable without hand-run SQL.
 *
 * Rules:
 *   • platform_admin only, reason required — this is a support-ticket-driven
 *     correction, not a self-service field.
 *   • Cascades to every descendant tenant whose country equals the old value
 *     (children inherit country, so they must stay consistent with parent).
 *   • Audit: appended to the tenant's billingNotes (timestamped, actor,
 *     old→new, reason) inside the same transaction + structured log line.
 *   • Existing fee line items / recorded payments are NOT touched — amounts
 *     and currency were snapshotted at creation time. Only future price
 *     resolution uses the corrected country.
 *
 * Body: { country: "XX", reason: string } */
const CorrectCountryBody = z.object({
  country: z.string().length(2),
  reason: z.string().min(5).max(2000),
});
router.post("/tenants/:tenantId/correct-country",
  validate({ body: CorrectCountryBody }),
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const actor = req.resolvedUser!;
    const newCountry = (req.body.country as string).toUpperCase();
    const reason = req.body.reason as string;

    const [tenant] = await db.select().from(tenantsTable)
      .where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
    if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
    if (tenant.parentId) {
      res.status(409).json({
        error: "CORRECT_ROOT_TENANT",
        message: "Country is inherited from the parent — correct the top-level tenant instead; the fix cascades to all sub-accounts.",
      });
      return;
    }
    const oldCountry = tenant.country ?? null;
    if (oldCountry === newCountry) {
      res.status(409).json({ error: "NO_CHANGE", message: `Billing country is already ${newCountry}.` });
      return;
    }

    /* Collect the full descendant subtree (BFS over parentId). Children whose
       country differs from the parent's old value are deliberate pre-existing
       overrides: they (and their own subtrees) are SKIPPED, and the skip is
       recorded explicitly so a future admin never assumes a full cascade. */
    const subtreeIds: string[] = [tenant.id];
    const skipped: { id: string; name: string; country: string | null }[] = [];
    let frontier = [tenant.id];
    while (frontier.length) {
      const children = await db.select({ id: tenantsTable.id, name: tenantsTable.name, country: tenantsTable.country })
        .from(tenantsTable).where(inArray(tenantsTable.parentId, frontier));
      frontier = [];
      for (const c of children) {
        if ((c.country ?? null) === oldCountry) {
          frontier.push(c.id);
          subtreeIds.push(c.id);
        } else {
          skipped.push({ id: c.id, name: c.name, country: c.country ?? null });
        }
      }
    }

    const cascadedCount = subtreeIds.length - 1;
    const skippedNote = skipped.length
      ? ` ${skipped.length} sub-account(s) SKIPPED as pre-existing overrides, still on their own country: ${skipped
          .map((s) => `${s.name} [${s.country ?? "unset"}]`)
          .join(", ")}.`
      : "";
    const auditLine =
      `[${new Date().toISOString()}] COUNTRY CORRECTED ${oldCountry ?? "(unset)"} → ${newCountry} ` +
      `by ${actor.email ?? actor.id} (cascaded to ${cascadedCount} of ${cascadedCount + skipped.length} sub-account(s).${skippedNote}) Reason: ${reason}`;

    const updated = await db.transaction(async (tx) => {
      await tx.update(tenantsTable)
        .set({ country: newCountry, updatedAt: new Date() })
        .where(inArray(tenantsTable.id, subtreeIds));
      const [t] = await tx.update(tenantsTable)
        .set({
          billingNotes: sql`left(coalesce(${tenantsTable.billingNotes}, '') || case when coalesce(${tenantsTable.billingNotes}, '') = '' then '' else E'\n' end || ${auditLine}, 2000)`,
          updatedAt: new Date(),
        })
        .where(eq(tenantsTable.id, tenant.id))
        .returning();
      return t;
    });

    logger.warn({
      actorId: actor.id, tenantId: tenant.id, oldCountry, newCountry,
      cascadedTo: cascadedCount, skippedOverrides: skipped, reason,
    }, "[billing] platform_admin billing-country correction (immutability escape hatch)");

    res.json({
      ok: true,
      tenant: mapTenant(updated, await getTenantStats(tenant.id), { viewerRole: actor.role }),
      cascadedTenantIds: subtreeIds.slice(1),
      skippedOverrides: skipped,
    });
  });

/* ── POST /tenants/:tenantId/record-payment ───────────────────────────────
 *
 * The single external input to the manual-billing lifecycle. Lexy collects
 * money OUTSIDE the platform (ACH today); once received, a platform_admin
 * clicks "record payment" here. We extend paid_through_at by one billing
 * term, flip the tenant back to `active`, and clear the renewal-reminder
 * idempotency columns so the next cycle's expiry/lapse alerts fire fresh.
 *
 * The new paid_through is computed from max(now, existing paid_through_at) so
 * an early renewal stacks onto the remaining time instead of truncating it,
 * while a lapsed renewal restarts the clock from today.
 *
 * Body: { term?: "monthly" | "quarterly" | "annual" }
 *   When omitted, the tenant's stored billingTerm is used (default monthly). */
const RecordPaymentBody = z.object({
  term: z.enum(["monthly", "quarterly", "annual"]).optional(),
  /** Payment kind (default "full" = today's behaviour: advance paid_through
   *  by one term + reactivate).
   *    partial — money received but NOT enough to extend the term: recorded
   *              as an 'adjustment' ledger line only, paid_through unchanged.
   *    credit  — goodwill/negotiated credit toward the tenant (negative line).
   *    refund  — money returned to the tenant (negative line).
   *  partial/credit/refund REQUIRE amount (> 0; sign is derived from type)
   *  and never touch paid_through_at or status. */
  paymentType: z.enum(["full", "partial", "credit", "refund"]).optional(),
  amount: z.number().positive().finite().optional(),
  note: z.string().max(500).optional(),
});
router.post("/tenants/:tenantId/record-payment",
  validate({ body: RecordPaymentBody }),
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const { term: bodyTerm, paymentType = "full", amount, note } = req.body as z.infer<typeof RecordPaymentBody>;

    const [existing] = await db.select({
      billingTerm: tenantsTable.billingTerm,
      paidThroughAt: tenantsTable.paidThroughAt,
      country: tenantsTable.country,
      plan: tenantsTable.plan,
    }).from(tenantsTable).where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    // ── Partial payments / credits / refunds: ledger-only, no term advance ──
    if (paymentType !== "full") {
      if (amount === undefined) {
        res.status(400).json({ error: "AMOUNT_REQUIRED", message: `paymentType "${paymentType}" requires a positive amount.` });
        return;
      }
      // partial = positive money received; credit/refund = negative (toward tenant).
      const signed = paymentType === "partial" ? amount : -amount;
      const { currency, symbol } = await getCountryPrice(existing.country, (existing.plan as PlanCode) ?? "starter", "monthly")
        .then((p) => ({ currency: p.currency, symbol: p.symbol }));
      const [line] = await db.insert(feeLineItemsTable).values({
        tenantId: req.params.tenantId,
        itemType: "adjustment",
        planCode: existing.plan,
        amount: signed,
        currency,
        description:
          `${paymentType === "partial" ? "Partial payment received" : paymentType === "credit" ? "Credit issued" : "Refund issued"}: ${symbol}${amount}` +
          (note ? ` — ${note}` : "") +
          (paymentType === "partial" ? " (does not extend paid-through — record a full payment when the balance clears)" : ""),
        evidence: { paymentType, amount: signed, note: note ?? null, actorId: req.resolvedUser!.id },
      }).returning({ id: feeLineItemsTable.id });

      logger.info({ actorId: req.resolvedUser!.id, tenantId: req.params.tenantId, paymentType, amount: signed },
        "[billing] adjustment ledger line recorded (no term advance)");
      const [t] = await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
      res.json({
        ok: true,
        lineItemId: line?.id,
        paymentType,
        amount: signed,
        tenant: mapTenant(t!, await getTenantStats(req.params.tenantId), { viewerRole: req.resolvedUser!.role }),
      });
      return;
    }

    const term: BillingTerm = bodyTerm
      ?? (isBillingTerm(existing.billingTerm) ? existing.billingTerm : "monthly");

    const now = new Date();
    const base = existing.paidThroughAt && new Date(existing.paidThroughAt).getTime() > now.getTime()
      ? new Date(existing.paidThroughAt)
      : now;
    const newPaidThrough = advanceByTerm(base, term);

    const [tenant] = await db.update(tenantsTable)
      .set({
        paidThroughAt: newPaidThrough,
        billingTerm: term,
        status: "active",
        renewalReminderSentAt: null,
        renewalLapsedNotifiedAt: null,
        updatedAt: now,
      })
      .where(eq(tenantsTable.id, req.params.tenantId))
      .returning();
    if (!tenant) { res.status(404).json({ error: "Not found" }); return; }

    logger.info({
      actorId: req.resolvedUser!.id,
      tenantId: tenant.id,
      term,
      paidThroughAt: newPaidThrough.toISOString(),
    }, "[billing] platform_admin recorded payment");

    res.json(mapTenant(tenant, await getTenantStats(tenant.id), { viewerRole: req.resolvedUser!.role }));
  });

/* ── POST /tenants/:tenantId/grace-period ─────────────────────────────────
 *
 * Per-tenant grace-period override for negotiated (Enterprise) contracts.
 * Sets tenants.grace_period_days (0–365); null RESTORES the global
 * SUBSCRIPTION_GRACE_DAYS default. Read by both the lifecycle scheduler
 * (past_due→suspended cutoff) and plan-enforcement (hard block cutoff), so
 * the two stay consistent automatically.
 *
 * platform_admin only, reason required — audited via a timestamped line
 * appended to billingNotes (same pattern as correct-country).
 *
 * Body: { days: number | null, reason: string } */
const GracePeriodBody = z.object({
  days: z.union([z.number().int().min(0).max(365), z.null()]),
  reason: z.string().min(5).max(2000),
});
router.post("/tenants/:tenantId/grace-period",
  validate({ body: GracePeriodBody }),
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const actor = req.resolvedUser!;
    const { days, reason } = req.body as z.infer<typeof GracePeriodBody>;

    const [existing] = await db.select({ gracePeriodDays: tenantsTable.gracePeriodDays })
      .from(tenantsTable).where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }

    const auditLine =
      `[${new Date().toISOString()}] GRACE PERIOD ${existing.gracePeriodDays ?? "(default)"} → ${days ?? "(default)"} day(s) ` +
      `by ${actor.email ?? actor.id}. Reason: ${reason}`;

    const [tenant] = await db.update(tenantsTable)
      .set({
        gracePeriodDays: days,
        billingNotes: sql`left(coalesce(${tenantsTable.billingNotes}, '') || case when coalesce(${tenantsTable.billingNotes}, '') = '' then '' else E'\n' end || ${auditLine}, 2000)`,
        updatedAt: new Date(),
      })
      .where(eq(tenantsTable.id, req.params.tenantId))
      .returning();
    if (!tenant) { res.status(404).json({ error: "Not found" }); return; }

    logger.info({ actorId: actor.id, tenantId: tenant.id, gracePeriodDays: days, reason },
      "[billing] platform_admin set per-tenant grace period");

    res.json(mapTenant(tenant, await getTenantStats(tenant.id), { viewerRole: actor.role }));
  });

/* ── PUT /tenants/:tenantId ───────────────────────────────────────────────── */
// platform_admin  → any tenant
// tenant_admin    → only their own tenant or direct children
router.put("/tenants/:tenantId", validate({ body: UpdateTenantBody }), resolveUser, requireRole("platform_admin", "tenant_admin"), async (req, res) => {
  const user = req.resolvedUser!;

  if (user.role === "tenant_admin") {
    const [existing] = await db.select().from(tenantsTable)
      .where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (!(await canAccessTenantAsync(user.role, user.tenantId, existing.id))) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  const [tenant] = await db.update(tenantsTable)
    .set({ ...req.body, updatedAt: new Date() })
    .where(eq(tenantsTable.id, req.params.tenantId))
    .returning();
  if (!tenant) { res.status(404).json({ error: "Not found" }); return; }
  res.json(mapTenant(tenant, await getTenantStats(tenant.id), { viewerRole: user.role }));
});

/* ── GET /tenants/:tenantId/branches ─────────────────────────────────────── */
router.get("/tenants/:tenantId/branches", resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"), async (req, res) => {
  const user = req.resolvedUser!;
  if (user.role !== "platform_admin" && !(await canAccessTenantAsync(user.role, user.tenantId, req.params.tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const branches = await db.select().from(tenantsTable)
    .where(and(eq(tenantsTable.parentId, req.params.tenantId), inArray(tenantsTable.clientType, ["branch"])));
  const result = await Promise.all(branches.map(async (t) => mapTenant(t, await getTenantStats(t.id), { viewerRole: user.role })));
  res.json(result);
});

/* ── GET /tenants/:tenantId/sub-clients ──────────────────────────────────── */
router.get("/tenants/:tenantId/sub-clients", resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"), async (req, res) => {
  const user = req.resolvedUser!;
  if (user.role !== "platform_admin" && !(await canAccessTenantAsync(user.role, user.tenantId, req.params.tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const subClients = await db.select().from(tenantsTable)
    .where(and(eq(tenantsTable.parentId, req.params.tenantId), inArray(tenantsTable.clientType, ["sub_client"])));
  const result = await Promise.all(subClients.map(async (t) => mapTenant(t, await getTenantStats(t.id), { viewerRole: user.role })));
  res.json(result);
});

/* ── GET /tenants/:tenantId/members ──────────────────────────────────────── */
router.get("/tenants/:tenantId/members", resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"), async (req, res) => {
  const user = req.resolvedUser!;
  // Non-admin staff can only see members of their own tenant
  if (user.role !== "platform_admin" && !(await canAccessTenantAsync(user.role, user.tenantId, req.params.tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  // Team list = staff only. Candidates carry a tenantId too, so an unfiltered
  // tenant query inflates "Total members" (and pollutes the org chart) with
  // every candidate account. Restrict to the staff roles surfaced on the page.
  const STAFF_ROLES = [
    "platform_admin",
    "tenant_admin",
    "recruiter_admin",
    "recruiter",
    "hiring_manager",
    "interviewer",
  ] as const;
  const members = await db.select().from(usersTable)
    .where(and(
      eq(usersTable.tenantId, req.params.tenantId),
      inArray(usersTable.role, STAFF_ROLES as unknown as string[]),
    ));

  const pending = await db.select().from(staffInviteTokensTable).where(and(
    eq(staffInviteTokensTable.tenantId, req.params.tenantId),
    isNull(staffInviteTokensTable.usedAt),
    gt(staffInviteTokensTable.expiresAt, new Date()),
  ));

  const activeMembers = members.map(m => ({
    ...m,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    passwordHash: undefined,
    status: "active" as const,
  }));

  const pendingMembers = pending.map(p => ({
    id: `invite_${p.token}`,
    email: p.email,
    name: p.name,
    role: p.role,
    tenantId: p.tenantId,
    avatarUrl: null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.createdAt.toISOString(),
    status: "pending" as const,
    inviteToken: p.token,
    expiresAt: p.expiresAt.toISOString(),
  }));

  res.json([...activeMembers, ...pendingMembers]);
});

/* ── POST /tenants/:tenantId/members ─────────────────────────────────────── */
router.post("/tenants/:tenantId/members", validate({ body: CreateMemberBody }), resolveUser, requireRole("platform_admin", "tenant_admin"), async (req, res) => {
  const user = req.resolvedUser!;
  if (user.role === "tenant_admin" && !(await canAccessTenantAsync(user.role, user.tenantId, req.params.tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const { email, name, role } = req.body;

  // Plan-limit gate: same seat cap as POST /staff-invites — without this
  // check, this alternate member-creation path bypasses the cap entirely.
  const seatCheck = await checkSeatInviteAllowed(req.params.tenantId);
  if (!seatCheck.allowed) {
    res.status(402).json(buildLimitExceededBody(seatCheck));
    return;
  }

  const [member] = await db.insert(usersTable).values({
    tenantId: req.params.tenantId,
    email,
    name,
    role: role || "recruiter",
    passwordHash: "invite_pending",
  }).returning();
  res.status(201).json({
    ...member,
    createdAt: member.createdAt.toISOString(),
    updatedAt: member.updatedAt.toISOString(),
    passwordHash: undefined,
  });
});

/* ── GET /tenants/:tenantId/activity ─────────────────────────────────────── */
router.get("/tenants/:tenantId/activity", resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter_admin"), async (req, res) => {
  const user = req.resolvedUser!;
  if (user.role !== "platform_admin" && !(await canAccessTenantAsync(user.role, user.tenantId, req.params.tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const { tenantId } = req.params;

  const [totalJobs]  = await db.select({ count: count() }).from(jobsTable).where(eq(jobsTable.tenantId, tenantId));
  const [activeJobs] = await db.select({ count: count() }).from(jobsTable).where(and(eq(jobsTable.tenantId, tenantId), eq(jobsTable.status, "active")));
  const [draftJobs]  = await db.select({ count: count() }).from(jobsTable).where(and(eq(jobsTable.tenantId, tenantId), eq(jobsTable.status, "draft")));

  const [totalSessions]     = await db.select({ count: count() }).from(interviewSessionsTable).where(eq(interviewSessionsTable.tenantId, tenantId));
  const [completedSessions] = await db.select({ count: count() }).from(interviewSessionsTable).where(and(eq(interviewSessionsTable.tenantId, tenantId), eq(interviewSessionsTable.status, "completed")));
  const [activeSessions]    = await db.select({ count: count() }).from(interviewSessionsTable).where(and(eq(interviewSessionsTable.tenantId, tenantId), eq(interviewSessionsTable.status, "active")));

  const [totalApps]   = await db.select({ count: count() }).from(applicationsTable).where(eq(applicationsTable.tenantId, tenantId));
  const [offerApps]   = await db.select({ count: count() }).from(applicationsTable).where(and(eq(applicationsTable.tenantId, tenantId), eq(applicationsTable.stage, "offer")));
  const [hiredApps]   = await db.select({ count: count() }).from(applicationsTable).where(and(eq(applicationsTable.tenantId, tenantId), eq(applicationsTable.stage, "hired")));
  const [screenApps]  = await db.select({ count: count() }).from(applicationsTable).where(and(eq(applicationsTable.tenantId, tenantId), eq(applicationsTable.stage, "screening")));

  const recentJobs = await db.select({
    id: jobsTable.id,
    title: jobsTable.title,
    status: jobsTable.status,
    workOrderNumber: jobsTable.workOrderNumber,
    createdAt: jobsTable.createdAt,
  }).from(jobsTable).where(eq(jobsTable.tenantId, tenantId)).limit(5);

  res.json({
    pipeline: {
      totalJobs: Number(totalJobs.count),
      activeJobs: Number(activeJobs.count),
      draftJobs: Number(draftJobs.count),
      closedJobs: Number(totalJobs.count) - Number(activeJobs.count) - Number(draftJobs.count),
    },
    interviews: {
      total: Number(totalSessions.count),
      completed: Number(completedSessions.count),
      active: Number(activeSessions.count),
      completionRate: Number(totalSessions.count) > 0
        ? Math.round((Number(completedSessions.count) / Number(totalSessions.count)) * 100)
        : 0,
    },
    applications: {
      total: Number(totalApps.count),
      screening: Number(screenApps.count),
      offers: Number(offerApps.count),
      hires: Number(hiredApps.count),
      conversionRate: Number(totalApps.count) > 0
        ? Math.round((Number(hiredApps.count) / Number(totalApps.count)) * 100)
        : 0,
    },
    recentJobs: recentJobs.map(j => ({ ...j, createdAt: j.createdAt.toISOString() })),
  });
});

/* ── GET /tenants/:tenantId/candidate-database ───────────────────────────── */
// Returns the platform candidate pool. Requires candidateDatabaseAccess=true on the tenant.
router.get("/tenants/:tenantId/candidate-database", resolveUser, requireRole("platform_admin", "tenant_admin", "recruiter_admin", "recruiter"), async (req, res) => {
  const user = req.resolvedUser!;
  if (user.role !== "platform_admin" && !(await canAccessTenantAsync(user.role, user.tenantId, req.params.tenantId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const [tenant] = await db.select().from(tenantsTable)
    .where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  // Platform admins can always see; others need the permission flag
  const hasAccess = user.role === "platform_admin" || tenant.candidateDatabaseAccess;
  if (!hasAccess) {
    res.json({ access: false, message: "Platform candidate database access is not enabled for your account. Contact your platform administrator." });
    return;
  }

  const { search, page = 1, limit = 50 } = req.query;
  const pageNum  = Math.max(1, Number(page));
  const limitNum = Math.min(200, Math.max(1, Number(limit)));

  // Only return platform-pool candidates
  let rows = await db.select().from(candidatesTable)
    .where(eq((candidatesTable as any).pool, "platform"))
    .orderBy(candidatesTable.createdAt);

  /* PRIVACY — CRITICAL: platform-pool rows are job-seeker records. They must
     never reach an employer surface without the SAME seal used by
     GET /candidates. A candidateDatabaseAccess licence grants access to the
     shared pool, but it does NOT override an individual candidate's privacy
     state. Apply hard exclusions (erased / DNC / pending_profile) and the
     per-candidate privacy filter (pause / hide-from-employer / blocklist /
     match-only), scoped to the caller's own (employer) tenant. platform_admin
     passes null → full pool for ops/support, matching GET /candidates. */
  rows = applyCandidateHardExclusions(rows);
  rows = await applyCandidatePrivacyFilter(
    rows,
    user.role === "platform_admin" ? null : (user.tenantId ?? null),
  );

  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter(c => `${c.firstName} ${c.lastName} ${c.email} ${c.currentTitle ?? ""} ${c.currentCompany ?? ""}`.toLowerCase().includes(q));
  }

  const total = rows.length;
  const paged = rows.slice((pageNum - 1) * limitNum, pageNum * limitNum);

  res.json({ access: true, total, page: pageNum, limit: limitNum, candidates: paged });
});

/* ── POST /tenants/:tenantId/database-access ─────────────────────────────── */
// Platform admin toggles candidateDatabaseAccess for a tenant.
router.post("/tenants/:tenantId/database-access", validate({ body: DatabaseAccessBody }), resolveUser, requireRole("platform_admin"), async (req, res) => {
  const { enabled } = req.body as { enabled: boolean };
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled (boolean) is required" }); return;
  }
  const [updated] = await db.update(tenantsTable)
    .set({ candidateDatabaseAccess: enabled, updatedAt: new Date() })
    .where(eq(tenantsTable.id, req.params.tenantId))
    .returning();
  if (!updated) { res.status(404).json({ error: "Tenant not found" }); return; }
  res.json({ success: true, candidateDatabaseAccess: updated.candidateDatabaseAccess });
});

export default router;
