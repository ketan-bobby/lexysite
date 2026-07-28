/**
 * routes/plans.ts — Subscription Package Catalog & Tenant Plan Status
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /plans                       Public catalog of subscription packages
 *                                     (used by pricing page on lexy-site).
 *   GET  /plans/me/usage              Authenticated: current tenant's plan,
 *                                     limits, and live usage counts.
 *   GET  /plans/:code                 Single plan package detail.
 *   POST /plans/demo                  Provision a fresh DEMO tenant (1 job,
 *                                     5 interviews, 14-day expiry). Open to
 *                                     anyone — gated by a honeypot field plus
 *                                     a per-IP rate limit (5 / hour).
 *
 * ─── Route ordering note ─────────────────────────────────────────────────────
 * `/plans/me/usage` MUST be declared BEFORE `/plans/:code` — otherwise Express
 * matches the dynamic `:code` segment first and the usage endpoint becomes
 * unreachable (it would resolve to PLAN_PACKAGES["me"] = undefined → 404).
 *
 * Plan packages themselves are defined in lib/plans.ts — this file only wires
 * them up to HTTP. Limit enforcement lives in lib/plan-enforcement.ts.
 */
import { Router, type IRouter, type Request } from "express";
import crypto from "node:crypto";
import { controlDb, db } from "@workspace/db";
import { tenantsTable, usersTable, pendingTrialSignupsTable } from "@workspace/db";
import { and, eq, isNull, gt, desc } from "drizzle-orm";
import { PLAN_PACKAGES, listPublicPlans, getPlan, getRegionalPrice, isRegion, type PlanCode, type Region } from "../lib/plans";
import { sendEmail, plainToHtml } from "../lib/email";
import {
  checkJobCreationAllowed,
  checkInterviewCreationAllowed,
  checkSeatInviteAllowed,
  checkSubClientCreationAllowed,
} from "../lib/plan-enforcement";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { logger } from "../lib/logger";
import { z } from "zod";
import { validate } from "../middlewares/validate";
import { rateLimit } from "../middlewares/rateLimit";

const StartTrialBody = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
  company: z.string().min(1),
  role: z.string().optional().nullable(),
  teamSize: z.string().optional().nullable(),
  hiringFocus: z.string().optional().nullable(),
  honeypot: z.string().optional().nullable(),
}).passthrough();

const AdminSetPlanBody = z.object({
  planCode: z.string().min(1),
}).passthrough();

const router: IRouter = Router();

/* ── In-memory rate limiter for /plans/demo ─────────────────────────────────
 * Hard cap of 5 demo provisions per IP per rolling 60 minutes. Sufficient to
 * stop opportunistic abuse without needing Redis. For a real production rollout
 * this should move to a shared store (Redis / DB) so it survives restarts and
 * scales across replicas.
 */
/* Demo start-trial limiter — delegates to the shared rate-limit middleware
 * so it inherits the same Redis backend the rest of the API uses. Uses
 * mode:"sliding" to preserve the prior semantics exactly: a true rolling
 * 1-hour window of 5 hits per IP, with no boundary burst (a fixed window
 * would let a bot fire 5 hits at 11:59:59 and 5 more at 12:00:00). Keyed
 * off the trusted req.ip (Express trust-proxy is set). */
const DEMO_RATE_LIMIT_PER_HOUR = 5;
const demoStartTrialLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: DEMO_RATE_LIMIT_PER_HOUR,
  scope: "demo-start-trial-ip",
  mode: "sliding",
  keyFn: (req) => req.ip || "anon",
});
function getClientIp(req: Request): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd[0]) return fwd[0];
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/* ── Canonical origin (security-critical) ──────────────────────────────────
 * Used in every URL we put in transactional emails AND in every redirect
 * target after email verification. We DO NOT trust Host / X-Forwarded-Host
 * headers — those are attacker-controllable on most edge proxies and a poisoned
 * Host on a magic-link request would let an attacker direct trial victims to
 * their own controlled domain. Pinned to PUBLIC_APP_URL (production) or the
 * Replit dev domain (dev) with l3xy.ai as the final fallback.
 */
const CANONICAL_ORIGIN = (
  process.env.PUBLIC_APP_URL ||
  process.env.APP_PUBLIC_URL ||
  (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "") ||
  "https://www.l3xy.ai"
).replace(/\/$/, "");

/* ── GET /plans ───────────────────────────────────────────────────────────
 * Public catalog. Optional `?region=<code>` overlays per-region pricing onto
 * each plan as a `regionalPrice` field (currency, symbol, priceMonthly,
 * pricePerSeat, perHireFee, fallbackToUsd). Without `region` the response is
 * the legacy USD baseline — keeps existing callers working unchanged.
 * See lib/plans.ts → `Region` for the full list of supported region codes.
 */
router.get("/plans", (req, res) => {
  const rawRegion = String(req.query.region ?? "").toLowerCase();
  const region: Region | null = isRegion(rawRegion) ? rawRegion : null;
  const plans = listPublicPlans().map((p) => {
    if (!region) return p;
    return { ...p, regionalPrice: getRegionalPrice(p, region) };
  });
  res.json({ plans, region });
});

/* ── GET /plans/me/usage ──────────────────────────────────────────────────
 * MUST come before /plans/:code (see route-ordering note at top of file).
 */
router.get("/plans/me/usage", resolveUser, async (req, res) => {
  const user = req.resolvedUser!;
  if (!user.tenantId) { res.status(400).json({ error: "User has no tenant" }); return; }

  const [tenant] = await controlDb.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  // Seats + sub-clients are evaluated against the ROOT tenant inside the
  // helpers (sub-clients inherit their plan), so calling with the caller's
  // tenant id is safe — the helpers do the resolveRootTenantId walk for us.
  const [jobsCheck, interviewsCheck, seatsCheck, subClientsCheck] = await Promise.all([
    checkJobCreationAllowed(tenant.id),
    checkInterviewCreationAllowed(tenant.id),
    checkSeatInviteAllowed(tenant.id),
    checkSubClientCreationAllowed(tenant.id),
  ]);

  const plan = getPlan(tenant.plan);
  // expiresAt MUST be anchored to planActivatedAt so the UI matches the gating
  // logic in lib/plan-enforcement.ts. Falling back to createdAt for legacy rows
  // that pre-date the planActivatedAt column.
  const planAnchor = ((tenant as any).planActivatedAt ?? tenant.createdAt) as Date;
  // Surface the tenant's region so the in-app subscription UI can fetch
  // /plans?region=<tenantRegion> and show prices that match what the
  // tenant will actually be charged on upgrade (see routes/billing.ts).
  const tenantRegion: Region = isRegion((tenant as any).region) ? ((tenant as any).region as Region) : "us";
  // Sales-led billing cadence (see schema/tenants.ts and routes/billing.ts).
  // Surfaced read-only — UI renders it as a "Billed annually" badge; there's
  // no customer-facing toggle.
  const billingTerm = ((tenant as any).billingTerm === "annual" ? "annual" : "monthly") as "monthly" | "annual";
  res.json({
    tenant: {
      id: tenant.id, name: tenant.name, plan: tenant.plan, region: tenantRegion,
      billingTerm,
      createdAt: tenant.createdAt.toISOString(),
      planActivatedAt: planAnchor.toISOString(),
    },
    plan,
    planExpired: jobsCheck.planExpired,
    expiresAt: plan.expiresAfterDays > 0
      ? new Date(new Date(planAnchor).getTime() + plan.expiresAfterDays * 86_400_000).toISOString()
      : null,
    usage: {
      openJobs:        { current: jobsCheck.current,       limit: jobsCheck.limit       },
      interviews:      { current: interviewsCheck.current, limit: interviewsCheck.limit },
      staffSeats:      { current: seatsCheck.current,      limit: seatsCheck.limit      },
      subClients:      { current: subClientsCheck.current, limit: subClientsCheck.limit },
    },
  });
});

/* ── Platform-admin: every tenant's plan + live usage ──────────────────────
 * Drives the platform-admin "Subscriptions" overview page. Returns one row
 * per tenant with plan code, expiry, and live counts of open jobs / interviews
 * this period. Joins are kept minimal for performance — totals come from
 * lightweight COUNT queries grouped by tenant.
 */
router.get("/plans/admin/tenants", resolveUser, async (req, res) => {
  const user = req.resolvedUser!;
  if (user.role !== "platform_admin") { res.status(403).json({ error: "Forbidden — platform_admin only" }); return; }

  const tenants = await db.select().from(tenantsTable);

  // Build per-tenant usage rows (plan/expiry/usage). Two grouped COUNTs (jobs
  // open + interviews this period) are issued per request — fine for <500
  // tenants. Move to a materialised view if this grows.
  const rows = await Promise.all(tenants.map(async (t) => {
    const [jobsCheck, intCheck] = await Promise.all([
      checkJobCreationAllowed(t.id),
      checkInterviewCreationAllowed(t.id),
    ]);
    const plan = getPlan(t.plan);
    return {
      tenant: {
        id: t.id, name: t.name, slug: t.slug, plan: t.plan, status: t.status,
        region: (t as any).region ?? "us",
        country: (t as any).country ?? null,
        billingTerm: (t as any).billingTerm ?? "monthly",
        paidThroughAt: (t as any).paidThroughAt ? new Date((t as any).paidThroughAt).toISOString() : null,
        partnerId: (t as any).partnerId ?? null,
        contactEmail: t.contactEmail,
        planActivatedAt: ((t as any).planActivatedAt ?? t.createdAt).toISOString(),
        createdAt: t.createdAt.toISOString(),
      },
      plan,
      planExpired: jobsCheck.planExpired,
      expiresAt: plan.expiresAfterDays > 0
        ? new Date(new Date((t as any).planActivatedAt ?? t.createdAt).getTime() + plan.expiresAfterDays * 86_400_000).toISOString()
        : null,
      usage: {
        openJobs:   { current: jobsCheck.current, limit: jobsCheck.limit },
        interviews: { current: intCheck.current,  limit: intCheck.limit  },
      },
    };
  }));
  res.json({ tenants: rows });
});

/* ── Platform-admin: change a tenant's plan ─────────────────────────────── *
 *
 * Legacy free plan-change endpoint. The manual-billing flow introduced in
 * migration 0013 (see PATCH /tenants/:id/billing in routes/tenants.ts) is
 * the single write-path for any tenant on a signed contract — that
 * endpoint records the plan, status, billingTerm, paidThroughAt, and
 * billing_notes atomically with an audit log entry.
 *
 * To prevent operators from accidentally stomping a contract via this
 * older path, we 409 when the tenant has a non-null paid_through_at.
 * Clear it via the billing PATCH first (or perform the change there). */
router.patch("/plans/admin/tenants/:tenantId/plan", validate({ body: AdminSetPlanBody }), resolveUser, async (req, res) => {
  const user = req.resolvedUser!;
  if (user.role !== "platform_admin") { res.status(403).json({ error: "Forbidden — platform_admin only" }); return; }
  const { planCode } = req.body ?? {};
  const newPlan = getPlan(planCode);
  if (newPlan.code !== planCode) { res.status(400).json({ error: "Unknown plan code" }); return; }

  const [existing] = await db.select({ paidThroughAt: tenantsTable.paidThroughAt })
    .from(tenantsTable).where(eq(tenantsTable.id, req.params.tenantId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Tenant not found" }); return; }
  if (existing.paidThroughAt) {
    res.status(409).json({
      error: "BILLING_MANAGED",
      message: "This tenant has a sales-led billing record (paid_through_at is set). Change the plan via PATCH /tenants/:id/billing so the contract terms stay in sync.",
    });
    return;
  }

  const [updated] = await db.update(tenantsTable).set({
    plan: newPlan.code,
    planActivatedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(tenantsTable.id, req.params.tenantId)).returning();
  if (!updated) { res.status(404).json({ error: "Tenant not found" }); return; }
  res.json({ tenant: updated, plan: newPlan });
});

/* ── GET /plans/:code ───────────────────────────────────────────────────── */
router.get("/plans/:code", (req, res) => {
  const code = req.params.code as PlanCode;
  const pkg = PLAN_PACKAGES[code];
  if (!pkg) { res.status(404).json({ error: "Plan not found" }); return; }
  res.json(pkg);
});

/* ── POST /plans/start-trial (and legacy alias /plans/demo) ──────────────────
 * STEP 1 of the email-verified self-serve trial flow.
 *
 * Validates the form, generates a one-time verification token, stores it in
 * pending_trial_signups, and sends the prospect a magic link. NO tenant or user
 * is created until they click the link (handled by /plans/start-trial/verify).
 *
 * The legacy `/plans/demo` path is kept ONLY as an alias so any existing sales
 * tooling or curl docs keep working. New callers should use the explicit
 * `/plans/start-trial` name.
 */
async function startTrialHandler(req: Request, res: any) {
  /* Rate limiting handled by the demoStartTrialLimiter middleware attached
   * at route registration below — keeps the per-IP count in the shared
   * rate-limit store (in-memory today, Redis when REDIS_URL is set). */
  const ip = getClientIp(req);

  const { name, email, company, role, teamSize, hiringFocus, honeypot } = req.body ?? {};

  // Honeypot field — real users won't fill this; bots fill every field.
  if (honeypot) { res.status(200).json({ ok: true }); return; }

  if (!name || !email || !company) {
    res.status(400).json({ error: "name, email, and company are required" });
    return;
  }

  // Account-enumeration mitigation: if an account already exists for this
  // email we DO NOT reveal that fact in the response. Instead we still return
  // the same 202 "check your email" response below, but skip the trial-link
  // email entirely (and optionally send a "you already have an account" email).
  // This prevents bots from probing which emails are registered.
  const normalisedEmail = String(email).toLowerCase().trim();
  const [existing] = await db.select({ id: usersTable.id })
    .from(usersTable).where(eq(usersTable.email, normalisedEmail)).limit(1);

  const sameResponse = {
    ok: true,
    message: "Check your email — if you don't already have an L3xy account, we just sent you a verification link to start your trial. The link expires in 24 hours.",
  };

  if (existing) {
    // Send a "you already have an account" notice, but never reveal this in
    // the HTTP response. Failure here is non-fatal (email infra hiccup).
    void sendEmail({
      to: normalisedEmail,
      subject: "You already have an L3xy account",
      text: `Hi ${name},\n\nSomeone (probably you) tried to start a new L3xy trial with this email, but you already have an account. Sign in here instead:\n\n${CANONICAL_ORIGIN}/login\n\nIf this wasn't you, just ignore this email.\n\n— The L3xy team`,
      audit: { actorLabel: "Trial Signup", subjectType: "external", subjectLabel: normalisedEmail, action: "trial.duplicate_email.notice", metadata: { ip } },
    }).catch(() => {});
    res.status(202).json(sameResponse);
    return;
  }

  // Generate verification token and persist pending row. We DO NOT create a
  // tenant or user here — that only happens after the magic-link click. This
  // means a forged/typo'd email cannot pollute the tenants table.
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  try {
    await db.insert(pendingTrialSignupsTable).values({
      token,
      email: String(email).toLowerCase().trim(),
      name: String(name).trim(),
      company: String(company).trim(),
      role: role ? String(role).trim().slice(0, 200) : null,
      teamSize: teamSize ? String(teamSize).trim().slice(0, 50) : null,
      hiringFocus: hiringFocus ? String(hiringFocus).trim().slice(0, 500) : null,
      requestIp: ip,
      expiresAt,
    });
  } catch (err: any) {
    logger.error({ err: err?.message, ip, email }, "[plans/start-trial] failed to persist pending signup");
    res.status(500).json({ error: "PENDING_INSERT_FAILED", message: "Could not start your trial. Please try again." });
    return;
  }

  // SECURITY: never trust Host / X-Forwarded-* headers for security-sensitive
  // URL generation — an attacker could supply a malicious Host header and
  // poison the magic link. Always use the hardcoded canonical origin.
  const verifyUrl = `${CANONICAL_ORIGIN}/api/plans/start-trial/verify?token=${encodeURIComponent(token)}`;

  const text = `Hi ${name},

Thanks for requesting an L3xy trial. Click the link below to verify your email and unlock your 14-day workspace (1 job, 20 interviews):

${verifyUrl}

This link is valid for 24 hours. If you didn't ask for this, just ignore this email — no account will be created.

— The L3xy team`;

  const emailResult = await sendEmail({
    to: email,
    subject: "Verify your email to start your L3xy trial",
    text,
    html: plainToHtml(text),
    audit: {
      actorLabel: "Trial Signup",
      subjectType: "external",
      subjectLabel: email,
      action: "trial.verify_link.sent",
      metadata: { company, ip },
    },
  });

  if (!emailResult.ok) {
    logger.error({ err: emailResult.error, email }, "[plans/start-trial] verify email send failed");
    // Don't 500 — the row is in DB. We can also surface to support to manually relay.
  }

  res.status(202).json({
    ...sameResponse,
    // Surface the simulated flag so dev environments can see it in the UI; in
    // prod with real SES creds this will always be undefined/false.
    simulated: emailResult.simulated ?? false,
  });
}

router.post("/plans/start-trial", demoStartTrialLimiter, startTrialHandler);
router.post("/plans/demo",        demoStartTrialLimiter, startTrialHandler); // legacy alias

/* ── GET /plans/start-trial/verify?token=... ────────────────────────────────
 * STEP 2 of the email-verified self-serve trial flow.
 *
 * Consumes the token, creates the tenant + tenant_admin user, marks the
 * pending row consumed, then 302-redirects the browser to the lexy app's
 * login page with `?autologin=<email>` so the user lands signed-in.
 *
 * The user row uses passwordHash="demo_hash" — a placeholder that is REJECTED
 * by routes/auth.ts (it doesn't match the bcrypt /^\$2[aby]\$/ prefix). The
 * user therefore CANNOT log in via /auth/login until they set a real password
 * via /auth/complete-trial-signup (using the one-time loginToken issued by
 * this verify flow) or via /public/forgot-password.
 */
router.get("/plans/start-trial/verify", async (req, res) => {
  const token = String(req.query.token ?? "");
  if (!token) { res.status(400).send("Missing token."); return; }

  // SECURITY: pinned canonical origin (see comment in startTrialHandler).
  const failUrl = `${CANONICAL_ORIGIN}/login?trial_error=invalid`;

  const [pending] = await db
    .select()
    .from(pendingTrialSignupsTable)
    .where(and(
      eq(pendingTrialSignupsTable.token, token),
      isNull(pendingTrialSignupsTable.consumedAt),
      gt(pendingTrialSignupsTable.expiresAt, new Date()),
    ))
    .limit(1);

  if (!pending) {
    logger.warn({ tokenPrefix: token.slice(0, 8) }, "[plans/start-trial/verify] invalid or expired token");
    res.redirect(302, failUrl);
    return;
  }

  // Race: if someone already registered this email manually since the pending row
  // was created, do not duplicate.
  const [existing] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(eq(usersTable.email, pending.email)).limit(1);
  if (existing) {
    await db.update(pendingTrialSignupsTable)
      .set({ consumedAt: new Date() })
      .where(eq(pendingTrialSignupsTable.id, pending.id));
    res.redirect(302, `${CANONICAL_ORIGIN}/login?trial_error=already_registered&email=${encodeURIComponent(pending.email)}`);
    return;
  }

  const baseSlug = pending.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "demo";
  const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;

  // Mint a single-use loginToken (24 h TTL) for the password-setup step.
  // SECURITY: this is a separate secret from the verify token — the verify
  // token is one-time per email, the loginToken is one-time per session and
  // travels via a 302 redirect so it never appears in the inbound email. The
  // 24 h TTL lets a user open the link, get distracted, and finish later
  // (the previous 5-min window failed real users on slow networks/refreshes).
  const loginToken = crypto.randomBytes(32).toString("base64url");
  const loginTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  let tenant: typeof tenantsTable.$inferSelect;
  let user: typeof usersTable.$inferSelect;
  try {
    const result = await db.transaction(async (tx) => {
      const [t] = await tx.insert(tenantsTable).values({
        name: pending.company,
        slug,
        plan: "demo",
        status: "trial",
        clientType: "direct",
        contactEmail: pending.email,
      }).returning();

      const [u] = await tx.insert(usersTable).values({
        tenantId: t.id,
        email: pending.email,
        name: pending.name,
        role: "tenant_admin",
        // Placeholder hash — NOT a passwordless sentinel. The user CANNOT log
        // in via /auth/login until they reset their password via Forgot
        // Password. Their first session is issued via /auth/exchange-trial-
        // token using the single-use loginToken below.
        passwordHash: "demo_hash",
      }).returning();

      await tx.update(pendingTrialSignupsTable)
        .set({
          consumedAt: new Date(),
          createdTenantId: t.id,
          loginToken,
          loginTokenExpiresAt,
        })
        .where(eq(pendingTrialSignupsTable.id, pending.id));

      return { tenant: t, user: u };
    });
    tenant = result.tenant;
    user = result.user;
  } catch (err: any) {
    logger.error({ err: err?.message, email: pending.email }, "[plans/start-trial/verify] tenant creation failed");
    res.redirect(302, failUrl);
    return;
  }

  logger.info(
    { tenantId: tenant.id, userId: user.id, email: pending.email },
    "[plans/start-trial/verify] tenant provisioned",
  );

  // Redirect to the lexy app trial-setup page with the one-time loginToken.
  // The page asks the user to choose a password, then POSTs to
  // /api/auth/complete-trial-signup which sets the bcrypt hash, claims the
  // token, and returns a session. This is far friendlier than auto-login —
  // a forgotten browser tab or refresh doesn't burn the link, and the user
  // ends up with a real password they can use to sign in again later.
  res.redirect(302, `${CANONICAL_ORIGIN}/auth/trial-setup?lt=${encodeURIComponent(loginToken)}`);
});

/* ── GET /plans/start-trial/list ─ platform_admin only ──────────────────────
 * Returns recent trial-request submissions (most recent first) so platform
 * admins can see who has expressed interest. Includes consumption status so
 * staff can distinguish prospects who completed signup vs. who didn't.
 */
router.get(
  "/plans/start-trial/list",
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const rows = await db
      .select({
        id: pendingTrialSignupsTable.id,
        name: pendingTrialSignupsTable.name,
        email: pendingTrialSignupsTable.email,
        company: pendingTrialSignupsTable.company,
        requestIp: pendingTrialSignupsTable.requestIp,
        createdAt: pendingTrialSignupsTable.createdAt,
        expiresAt: pendingTrialSignupsTable.expiresAt,
        consumedAt: pendingTrialSignupsTable.consumedAt,
        createdTenantId: pendingTrialSignupsTable.createdTenantId,
        planCode: pendingTrialSignupsTable.planCode,
        region: pendingTrialSignupsTable.region,
        role: pendingTrialSignupsTable.role,
        teamSize: pendingTrialSignupsTable.teamSize,
        hiringFocus: pendingTrialSignupsTable.hiringFocus,
      })
      .from(pendingTrialSignupsTable)
      .orderBy(desc(pendingTrialSignupsTable.createdAt))
      .limit(limit);

    const now = Date.now();
    const items = rows.map((r) => ({
      ...r,
      status: r.consumedAt
        ? "verified"
        : r.expiresAt && r.expiresAt.getTime() < now
          ? "expired"
          : "pending",
    }));

    res.json({ items, count: items.length });
  },
);

export default router;
