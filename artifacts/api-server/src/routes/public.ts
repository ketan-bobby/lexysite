/**
 * routes/public.ts — Public Careers Portal API (No Authentication Required)
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * All API routes accessible without a Bearer token. Mounted at /api/public/*.
 * Powers the candidate-facing public careers portal: job listings, application
 * submission, talent pool registration, and candidate self-serve pages.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /public/jobs                    List open jobs (optionally filtered by
 *                                        tenant slug or ?search=)
 *   GET  /public/jobs/:id                Job detail (title, description, company)
 *   POST /public/jobs/:id/apply          Submit a job application. Accepts a
 *                                        multipart form with resume file upload.
 *                                        Creates candidate + application rows,
 *                                        auto-sends a portal invite email.
 *   GET  /public/interview-invite/:token Candidate clicks email invite link.
 *                                        Marks session as "opened", redirects to
 *                                        the interview room URL.
 *   POST /public/talent-pool             Self-register to the platform talent pool.
 *   GET  /public/talent-pool/profile     Candidate's own talent pool profile.
 *   POST /public/talent-pool/profile     Update own profile.
 *   POST /public/auth/register           Candidate self-registration with password.
 *   POST /public/auth/forgot-password    Request a password-reset link.
 *   POST /public/auth/reset-password     Complete password reset via token.
 *   GET  /public/tenants/:slug           Fetch tenant branding for the portal
 *                                        header (logo, name, accent colour).
 *
 * ─── No-auth design ──────────────────────────────────────────────────────────
 * These routes intentionally require no authentication so candidates can browse
 * and apply without creating an account first. The apply flow creates their
 * account as part of submission and sends an invite email to claim it.
 *
 * ─── Security notes ──────────────────────────────────────────────────────────
 * • Rate-limit apply endpoint in production (not implemented here — handled
 *   by an upstream API Gateway / WAF rule).
 * • Passwords are bcrypt-hashed (12 rounds) before storage.
 * • Invite tokens use UUID v4 with a 48-hour TTL.
 * • Resume uploads are validated for MIME type and capped at 10 MB.
 */

import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  jobsTable,
  candidatesTable,
  applicationsTable,
  usersTable,
  tenantsTable,
  talentPoolSubmissionsTable,
  pendingTrialSignupsTable,
  passwordResetTokensTable,
} from "@workspace/db";
import { eq, and, desc, inArray, or, ne, isNull, sql } from "drizzle-orm";
import { getPlan, getRegionalPrice, regionFromCountry, regionMeta, listRegions, isRegion, type PlanCode, type Region } from "../lib/plans";
import { logger } from "../lib/logger";
import { originFields } from "../lib/sourcing-origin";
import { ensureCandidateUser, generateInviteToken } from "./invites";
import { ObjectStorageService } from "../lib/objectStorage";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { sendEmail } from "../lib/email";
import { interviewSessionsTable, communicationEventsTable, interviewPlansTable } from "@workspace/db";
import { isJobApprovedForInterview } from "../lib/job-approval";
import { issueToken, setSessionTokenCookie, devOnlyTokenBody } from "../lib/auth-token";
import { getTenantRegion } from "../lib/region";
import { rateLimit } from "../middlewares/rateLimit";
import { validate } from "../middlewares/validate";
import { validatePasswordStrength } from "../lib/password-policy";
import { logCandidateEvent } from "../lib/candidate-event-logger.js";

const router = Router();

/* ── Request body schemas ────────────────────────────────────────────────── */
const SignupCheckoutBody = z.object({
  name: z.string().min(1),
  email: z.string().min(1),
  company: z.string().min(1),
  password: z.string().min(1),
  planCode: z.string().optional(),
  region: z.string().optional(),
}).passthrough();

const SignupStatusBody = z.object({
  pendingSignupId: z.string().min(1),
}).passthrough();

const JobApplyBody = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().min(1),
  phone: z.string().optional().nullable(),
  currentTitle: z.string().optional().nullable(),
  currentCompany: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  resumeObjectPath: z.string().optional().nullable(),
  message: z.string().optional().nullable(),
}).passthrough();

const CareerRegisterBody = z.object({
  firstName: z.string().min(1),
  lastName: z.string().optional().nullable(),
  email: z.string().min(1),
  password: z.string().min(1),
  linkedinUrl: z.string().optional().nullable(),
}).passthrough();

const ForgotPasswordBody = z.object({
  email: z.string().min(1),
}).passthrough();

const ResetPasswordBody = z.object({
  token: z.string().min(1),
  password: z.string().min(1),
}).passthrough();

const TalentPoolUploadUrlBody = z.object({
  name: z.string().min(1),
  contentType: z.string().min(1),
  size: z.number().optional(),
}).passthrough();

const TalentPoolBody = z.object({
  fullName: z.string().min(1),
  email: z.string().min(1),
  currentTitle: z.string().min(1),
  phone: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  experienceLevel: z.string().optional().nullable(),
  workStyle: z.string().optional().nullable(),
  languages: z.array(z.string()).optional(),
  bio: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  resumeObjectPath: z.string().optional().nullable(),
}).passthrough();

const SalesLeadBody = z.object({
  fullName: z.string().min(1),
  email: z.string().min(1),
  phone: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
}).passthrough();

/* ── Rate limiters for unauthenticated endpoints ─────────────────────────────
 * Keyed on req.ip by default (rateLimit falls through to ip when there's no
 * resolvedUser, which is always the case under /api/public). Where we have a
 * meaningful identifier in the body (email, candidateId), we key on that too
 * with a second limiter so attackers can't trivially rotate IPs to spam a
 * single victim. All windows are conservative — generous enough that a real
 * user fumbling a form won't hit them, tight enough that automation can't run
 * unbounded.
 *
 * Limits picked from the post-RLS hardening audit. If we ever move to multi-
 * replica we MUST swap the in-memory store for Redis (see rateLimit.ts). */

const applyIpLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  scope: "public-apply-ip",
});

const careerRegisterIpLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  scope: "public-career-register-ip",
});

/* forgot-password: two complementary limiters. The email-keyed one protects
 * a single victim from being spam-reset-emailed even from many IPs. The IP
 * one protects the email-provider relationship from one bad actor enumerating
 * many addresses. */
const forgotPasswordEmailLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 3,
  scope: "public-forgot-password-email",
  keyFn: (req) =>
    String((req.body as any)?.email ?? "").trim().toLowerCase() || (req.ip ?? "anon"),
});
const forgotPasswordIpLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  scope: "public-forgot-password-ip",
});

const resetPasswordIpLimit = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  scope: "public-reset-password-ip",
});

const talentPoolIpLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  scope: "public-talent-pool-ip",
});

/**
 * GET /api/public/interview-invite/:token
 * Candidate clicks the link in their interview-invite email. We mark the
 * invite as opened (so the re-engagement scheduler skips it) and redirect
 * the candidate into the interview room. Records an audit row to
 * communication_events for GDPR.
 */
router.get("/interview-invite/:token", async (req, res) => {
  const token = String(req.params.token || "");
  if (!token) {
    res.status(400).send("Missing token");
    return;
  }

  const [session] = await db
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.inviteToken, token))
    .limit(1);

  if (!session) {
    res.status(404).type("html").send(
      "<h1>Link not found</h1><p>This interview link is invalid. Please contact the recruiter.</p>",
    );
    return;
  }

  if (session.inviteExpiresAt && session.inviteExpiresAt.getTime() < Date.now()) {
    res.status(410).type("html").send(
      "<h1>Link expired</h1><p>This interview link has expired. We'll send you a fresh one shortly.</p>",
    );
    return;
  }

  /* Approval gate (defense-in-depth): never let a candidate enter the interview
     room for a job-bound session whose work order isn't approved yet — e.g. a
     pre-existing session whose job was later sent back to draft/rejected. Plans
     with no jobId (candidate baseline/self-practice) are unaffected. */
  if (session.planId) {
    const [plan] = await db.select().from(interviewPlansTable).where(eq(interviewPlansTable.id, session.planId)).limit(1);
    if (plan?.jobId) {
      const [planJob] = await db.select().from(jobsTable).where(eq(jobsTable.id, plan.jobId)).limit(1);
      if (planJob && !isJobApprovedForInterview(planJob.status)) {
        logger.warn({ sessionId: session.id, jobId: plan.jobId, status: planJob.status }, "[interview-invite] blocked — work order not approved");
        res.status(403).type("html").send(
          "<h1>Interview not yet available</h1><p>This role is still being finalised. We'll be in touch as soon as it's ready.</p>",
        );
        return;
      }
    }
  }

  if (!session.inviteOpenedAt) {
    const now = new Date();
    await db
      .update(interviewSessionsTable)
      .set({ inviteOpenedAt: now })
      .where(eq(interviewSessionsTable.id, session.id));

    await db.insert(communicationEventsTable).values({
      tenantId: session.tenantId,
      candidateId: session.candidateId,
      applicationId: session.id,
      type: "status_update",
      channel: "email",
      status: "opened",
      subject: "Interview invite opened",
      body: `Candidate opened interview invite link at ${now.toISOString()}`,
      sentAt: now,
    });
  }

  res.redirect(302, `/interviews/${session.id}/room`);
});



/* ── Password reset tokens (DB-backed, single-use) ──────────────────────────
 *
 * Design:
 *   • Token = 32 random bytes, base64url-encoded → 43-char unguessable string.
 *     Sent to the user via email; the raw token never touches the DB.
 *   • We store only sha256(token) in password_reset_tokens.token_hash. A
 *     read-only DB compromise therefore cannot be used to reset any user's
 *     password.
 *   • Redeem atomically marks used_at, so the same token cannot be replayed
 *     even within the 1-hour TTL (e.g. if the email is forwarded or leaked).
 *   • Issuing a new token invalidates any other unused tokens for the same
 *     user, so an old leaked email stops working once the user requests a
 *     fresh reset link.
 */
const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashResetToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Map a user id to a signed 64-bit int suitable for pg_advisory_xact_lock.
 *  We hash → take first 8 bytes → interpret as signed bigint. The lock space
 *  is shared globally, so the hash provides enough entropy to avoid collisions
 *  with other advisory-lock users in the codebase. */
function lockKeyForUser(userId: string): bigint {
  const h = crypto.createHash("sha256").update(`password_reset:${userId}`).digest();
  return h.readBigInt64BE(0);
}

async function makeResetToken(userId: string, requestIp: string | null): Promise<string> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashResetToken(raw);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  /* Concurrency strategy (belt + braces):
   *   1. App-level: pg_advisory_xact_lock keyed off the user's id hashed to a
   *      bigint, taken at the start of the transaction. Any two concurrent
   *      forgot-password calls for the same user serialise on this lock.
   *      (SELECT...FOR UPDATE was insufficient because it doesn't lock when
   *      the user has zero existing rows.)
   *   2. DB-level: a partial unique index on (user_id) WHERE used_at IS NULL
   *      enforces "at most one active token per user" as a durable invariant
   *      independent of the application code path. Any race that slips past
   *      the advisory lock surfaces as a unique-violation rather than a
   *      silently-issued duplicate token. */
  const lockKey = lockKeyForUser(userId);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${lockKey})`);
    await tx
      .update(passwordResetTokensTable)
      .set({ usedAt: new Date() })
      .where(and(eq(passwordResetTokensTable.userId, userId), isNull(passwordResetTokensTable.usedAt)));
    await tx.insert(passwordResetTokensTable).values({
      userId,
      tokenHash,
      expiresAt,
      requestIp,
    });
  });

  return raw;
}

/** Atomic redeem: marks used_at only if not already used and not expired.
 *  Returns userId on success, or null on invalid/expired/already-used. */
async function consumeResetToken(rawToken: string): Promise<{ userId: string } | null> {
  const tokenHash = hashResetToken(rawToken);
  const now = new Date();
  const [row] = await db
    .update(passwordResetTokensTable)
    .set({ usedAt: now })
    .where(
      and(
        eq(passwordResetTokensTable.tokenHash, tokenHash),
        isNull(passwordResetTokensTable.usedAt),
        sql`${passwordResetTokensTable.expiresAt} > now()`,
      ),
    )
    .returning({ userId: passwordResetTokensTable.userId });
  return row ?? null;
}

/** Public-facing URL for the customer-installed Lexy SPA. Used to build
 *  email links. In dev the SPA is mounted at /lexy under REPLIT_DEV_DOMAIN;
 *  in prod set LEXY_APP_URL (or PUBLIC_APP_URL) to the bare app URL, e.g.
 *  `https://app.l3xy.ai` — *with* any path prefix the SPA is served under. */
function getLexyAppUrl(): string {
  const explicit = process.env.LEXY_APP_URL || process.env.PUBLIC_APP_URL;
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/lexy`;
  }
  return "http://localhost:5000/lexy";
}

function getAppBaseUrl(req: any): string {
  const env = process.env.PUBLIC_APP_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);
  if (env) return env.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || "localhost";
  return `${proto}://${host}`;
}

/* ── Geo detection ─────────────────────────────────────────────────────────
 * Resolves the requesting IP → ISO country code, used to pick the regional
 * pricing bucket. Order of resolution:
 *   1. cf-ipcountry header (Cloudflare). Trusted because it's set by the
 *      edge and stripped from inbound headers.
 *   2. x-vercel-ip-country (Vercel) — same trust model.
 *   3. ipapi.co lookup (free tier: 1000/day, no key). Cached in-memory for
 *      1h per IP so a single Replit instance trivially covers a normal day.
 *   4. Fallback to "US".
 *
 * Localhost and private-range IPs default to "US" (dev convenience).
 */
const GEO_CACHE = new Map<string, { country: string; expiresAt: number }>();
const GEO_TTL_MS = 60 * 60 * 1000;

function isPrivateOrLocalIp(ip: string): boolean {
  return ip === "::1" || ip === "127.0.0.1" || ip === "unknown" ||
    ip.startsWith("10.") || ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || ip.startsWith("::ffff:127.") || ip.startsWith("fc") || ip.startsWith("fd");
}

function detectCountryFromReq(req: import("express").Request): string {
  const cf = (req.headers["cf-ipcountry"] as string)?.toUpperCase();
  if (cf && cf !== "XX" && cf.length === 2) return cf;
  const vc = (req.headers["x-vercel-ip-country"] as string)?.toUpperCase();
  if (vc && vc.length === 2) return vc;
  const ip = req.ip ?? "unknown";
  if (isPrivateOrLocalIp(ip)) return "US";
  const cached = GEO_CACHE.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.country;
  return "US"; // sync fallback — async lookup fires in /geo route below
}

async function lookupCountryForIp(ip: string): Promise<string> {
  if (isPrivateOrLocalIp(ip)) return "US";
  const cached = GEO_CACHE.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.country;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/country/`, { signal: ctrl.signal });
    clearTimeout(timer);
    const txt = (await r.text()).trim().toUpperCase();
    if (r.ok && /^[A-Z]{2}$/.test(txt)) {
      GEO_CACHE.set(ip, { country: txt, expiresAt: Date.now() + GEO_TTL_MS });
      return txt;
    }
  } catch {
    /* fall through */
  }
  GEO_CACHE.set(ip, { country: "US", expiresAt: Date.now() + 5 * 60 * 1000 });
  return "US";
}

/* ── GET /api/public/geo ───────────────────────────────────────────────────
 * Lightweight endpoint the marketing pages call on mount to figure out the
 * visitor's pricing region. Returns:
 *   { country: "IN", region: "in", currency: "INR", symbol: "₹",
 *     regions: [...all regions for the toggle UI...] }
 */
router.get("/geo", async (req, res) => {
  const headerCountry =
    (req.headers["cf-ipcountry"] as string)?.toUpperCase() ||
    (req.headers["x-vercel-ip-country"] as string)?.toUpperCase();
  let country: string;
  if (headerCountry && headerCountry.length === 2 && headerCountry !== "XX") {
    country = headerCountry;
  } else {
    country = await lookupCountryForIp(req.ip ?? "unknown");
  }
  const region = regionFromCountry(country);
  const meta = regionMeta(region);
  res.set("Cache-Control", "private, max-age=300");
  res.json({
    country,
    region,
    currency: meta.currency,
    symbol: meta.symbol,
    regions: listRegions(),
  });
});

/* ── Stripe helpers (signup-checkout) ───────────────────────────────────── */
const STRIPE_API = "https://api.stripe.com/v1";
async function stripeCall(path: string, body?: Record<string, string>): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY missing");
  const init: RequestInit = {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) init.body = new URLSearchParams(body).toString();
  const r = await fetch(`${STRIPE_API}${path}`, init);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${j?.error?.message ?? r.statusText}`);
  return j;
}

/* ── Rate-limit map for /signup-checkout (per IP) ──────────────────────────
 * In-memory sliding window. Caps signup attempts per IP at 5 / 15 minutes.
 * This blunts both account-enumeration probing of the existing-email response
 * and abuse of Stripe Checkout session creation. Resets on process restart,
 * which is acceptable for a single-instance API server.
 */
const SIGNUP_RATE_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_RATE_MAX = 5;
const signupAttemptsByIp = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (signupAttemptsByIp.get(ip) ?? []).filter((t) => now - t < SIGNUP_RATE_WINDOW_MS);
  if (recent.length >= SIGNUP_RATE_MAX) {
    signupAttemptsByIp.set(ip, recent);
    return true;
  }
  recent.push(now);
  signupAttemptsByIp.set(ip, recent);
  // Opportunistic cleanup so the map doesn't grow unbounded.
  if (signupAttemptsByIp.size > 5_000) {
    for (const [k, v] of signupAttemptsByIp) {
      const fresh = v.filter((t) => now - t < SIGNUP_RATE_WINDOW_MS);
      if (fresh.length === 0) signupAttemptsByIp.delete(k);
      else signupAttemptsByIp.set(k, fresh);
    }
  }
  return false;
}

/* ── POST /api/public/signup-checkout ─────────────────────────────────────
 * Self-serve paid signup. Validates the form, persists a pending_trial_signups
 * row (with bcrypt password hash + chosen plan), and creates a Stripe Checkout
 * Session with metadata.pendingSignupId. The webhook
 * (routes/billing.ts → checkout.session.completed) reads that metadata to
 * provision the tenant + tenant_admin user + login token. The browser polls
 * /api/public/signup-status until the webhook fires, then redirects through
 * /auth/trial-exchange to land the user signed-in.
 *
 * Note on account enumeration: this endpoint returns a distinguishable 409 when
 * an account already exists. This is a deliberate UX trade-off (matching
 * Vercel/GitHub/Linear/etc.) — paying customers expect to be told their email
 * is already in use rather than being silently charged twice. We mitigate
 * automated enumeration with the per-IP rate limit above.
 */
router.post("/signup-checkout", validate({ body: SignupCheckoutBody }), async (req, res) => {
  try {
    // Self-serve Stripe checkout is OFF by default. Lexy's go-to-market is
    // sales-led — pricing is per-contract and provisioning happens manually
    // via PATCH /tenants/:id/billing once a deal is signed. Operators who
    // want to re-enable in-app credit-card signup must explicitly set
    // ENABLE_SELF_SERVE_BILLING=true *and* configure STRIPE_SECRET_KEY.
    if (String(process.env.ENABLE_SELF_SERVE_BILLING || "").toLowerCase() !== "true") {
      return res.status(503).json({ error: "BILLING_DISABLED", message: "Self-serve signup is disabled. Please contact sales." });
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "BILLING_NOT_CONFIGURED", message: "Self-serve signup is not available on this deployment." });
    }

    // req.ip is derived via Express's trust-proxy chain (configured in app.ts:
    // `app.set("trust proxy", 1)`), so it reflects the platform proxy's
    // observed client IP rather than the client-controllable X-Forwarded-For
    // first-hop. This makes the rate limiter unspoofable.
    const ip = req.ip || "unknown";
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: "RATE_LIMITED", message: "Too many signup attempts. Please wait a few minutes and try again." });
    }

    const { name, email, company, password, planCode, region: rawRegion } = (req.body ?? {}) as {
      name?: string; email?: string; company?: string; password?: string; planCode?: string; region?: string;
    };

    if (!name?.trim())    return res.status(400).json({ error: "Your full name is required" });
    if (!company?.trim()) return res.status(400).json({ error: "Company name is required" });
    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid work email is required" });
    }
    {
      const policy = validatePasswordStrength(password);
      if (!policy.ok) {
        return res.status(400).json({ error: policy.code, message: policy.message });
      }
    }

    const plan = getPlan(String(planCode ?? "starter") as PlanCode);
    if (plan.code !== "starter" && plan.code !== "growth") {
      return res.status(400).json({ error: "Only Starter and Growth can be self-served. Contact sales for Enterprise." });
    }

    // Resolve region: trust the client's selection if it's one of our buckets,
    // else fall back to detecting from the request IP via the geo cache (cf
    // header → cached lookup → "us"). This mirrors what the pricing page
    // shows so the headline price the user saw matches what they get charged.
    const submittedRegion = String(rawRegion ?? "").toLowerCase();
    const country = detectCountryFromReq(req);
    const region: Region = isRegion(submittedRegion)
      ? submittedRegion
      : regionFromCountry(country);

    const regionalPrice = getRegionalPrice(plan, region);
    if (!regionalPrice.stripePriceId) {
      return res.status(503).json({ error: "PRICE_ID_MISSING", message: `Stripe price for ${plan.name} is not configured on this deployment.` });
    }

    const normalisedEmail = email.trim().toLowerCase();

    // Reject if account already exists (signup flow, not password recovery — we
    // can be explicit here without the enumeration concern that applies to the
    // free-trial endpoint, since the user is providing a password they expect
    // to use).
    const [existingUser] = await db.select({ id: usersTable.id })
      .from(usersTable).where(eq(usersTable.email, normalisedEmail)).limit(1);
    if (existingUser) {
      return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const [pending] = await db.insert(pendingTrialSignupsTable).values({
      token,
      email: normalisedEmail,
      name: name.trim(),
      company: company.trim(),
      requestIp: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.ip ?? "unknown",
      expiresAt,
      passwordHash,
      planCode: plan.code,
      region,
    }).returning({ id: pendingTrialSignupsTable.id });

    if (!pending) {
      return res.status(500).json({ error: "Could not start signup. Please try again." });
    }

    const origin = getAppBaseUrl(req);
    // After Stripe checkout completes, Stripe redirects the browser to the
    // success page on lexy-site, which polls /signup-status until the webhook
    // has provisioned the tenant + minted the loginToken, then forwards to
    // /auth/trial-exchange to claim the session.
    const successUrl = `${origin}/lexy-site/signup-success?ps=${encodeURIComponent(pending.id)}`;
    const cancelUrl  = `${origin}/lexy-site/signup?canceled=1&plan=${encodeURIComponent(plan.code)}`;

    // Create the Stripe Customer up-front so we can persist the customer id on
    // the pending row (and later on the tenant). This keeps the webhook idempotent.
    const customer = await stripeCall("/customers", {
      email: normalisedEmail,
      name: company.trim(),
      "metadata[pendingSignupId]": pending.id,
    });

    const session = await stripeCall("/checkout/sessions", {
      mode: "subscription",
      customer: customer.id,
      "line_items[0][price]": regionalPrice.stripePriceId,
      "line_items[0][quantity]": "1",
      success_url: `${successUrl}&cs_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
      // 14-day Stripe-managed trial — card collected at checkout, charged on day 15.
      "subscription_data[trial_period_days]": "14",
      // Stripe Tax — auto-calculates VAT/GST/sales-tax based on the customer's
      // billing address. Requires Tax to be enabled in the Stripe Dashboard
      // (Settings → Tax) and tax registrations added for relevant regions.
      "automatic_tax[enabled]": "true",
      // Lets EU/UK/IN customers enter their VAT / GSTIN at checkout so the
      // invoice is reverse-charge / B2B-compliant.
      "tax_id_collection[enabled]": "true",
      // Force Stripe to collect a full billing address — needed for
      // automatic_tax to compute the right rate, and gives us a reliable
      // country to feed the anti-arbitrage check in the webhook.
      "billing_address_collection": "required",
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
      "metadata[pendingSignupId]": pending.id,
      "metadata[planCode]": plan.code,
      "metadata[region]": region,
      "metadata[displayCurrency]": regionalPrice.currency,
      "metadata[fallbackToUsd]": String(regionalPrice.fallbackToUsd ?? false),
      "subscription_data[metadata][pendingSignupId]": pending.id,
      "subscription_data[metadata][planCode]": plan.code,
      "subscription_data[metadata][region]": region,
    });

    await db.update(pendingTrialSignupsTable)
      .set({ stripeCheckoutSessionId: session.id, stripeCustomerId: customer.id })
      .where(eq(pendingTrialSignupsTable.id, pending.id));

    logger.info({ pendingId: pending.id, plan: plan.code, email: normalisedEmail }, "[signup-checkout] session created");
    return res.json({ url: session.url, pendingSignupId: pending.id });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[signup-checkout] failed");
    return res.status(502).json({ error: "SIGNUP_FAILED", message: err?.message || "Could not start signup." });
  }
});

/* ── POST /api/public/signup-status ────────────────────────────────────────
 * Polled by the /signup-success page after Stripe Checkout returns. Returns
 * the loginToken once the webhook has provisioned the tenant; otherwise
 * 'pending'. Does NOT reveal the bcrypt hash or any internal fields.
 */
router.post("/signup-status", validate({ body: SignupStatusBody }), async (req, res) => {
  try {
    const id = String((req.body ?? {}).pendingSignupId ?? "");
    if (!id) return res.status(400).json({ error: "Missing pendingSignupId" });

    const [row] = await db.select({
      id: pendingTrialSignupsTable.id,
      createdTenantId: pendingTrialSignupsTable.createdTenantId,
      loginToken: pendingTrialSignupsTable.loginToken,
      loginTokenExpiresAt: pendingTrialSignupsTable.loginTokenExpiresAt,
      loginTokenConsumedAt: pendingTrialSignupsTable.loginTokenConsumedAt,
      consumedAt: pendingTrialSignupsTable.consumedAt,
      expiresAt: pendingTrialSignupsTable.expiresAt,
    }).from(pendingTrialSignupsTable).where(eq(pendingTrialSignupsTable.id, id)).limit(1);

    if (!row) return res.status(404).json({ status: "not_found" });
    if (row.loginTokenConsumedAt) return res.json({ status: "already_used" });
    if (row.expiresAt.getTime() < Date.now() && !row.createdTenantId) return res.json({ status: "expired" });

    if (row.createdTenantId && row.loginToken) {
      return res.json({ status: "ready", loginToken: row.loginToken });
    }
    return res.json({ status: "pending" });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[signup-status] failed");
    return res.status(500).json({ status: "error" });
  }
});

/* ── GET /api/public/jobs ─────────────────────────────────────────────────── */
router.get("/jobs", async (req, res) => {
  try {
    const jobs = await db
      .select({
        id:             jobsTable.id,
        title:          jobsTable.title,
        department:     jobsTable.department,
        location:       jobsTable.location,
        workType:       jobsTable.workType,
        employmentType: jobsTable.employmentType,
        salaryMin:      jobsTable.salaryMin,
        salaryMax:      jobsTable.salaryMax,
        description:    jobsTable.description,
        createdAt:      jobsTable.createdAt,
      })
      .from(jobsTable)
      .where(eq(jobsTable.status, "published"))
      .orderBy(desc(jobsTable.createdAt));

    res.json({ data: jobs, total: jobs.length });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch public jobs");
    res.status(500).json({ error: "Failed to fetch jobs" });
  }
});

/* ── GET /api/public/jobs/:id ─────────────────────────────────────────────── */
router.get("/jobs/:id", async (req, res) => {
  try {
    const rows = await db
      .select({
        id:             jobsTable.id,
        title:          jobsTable.title,
        department:     jobsTable.department,
        location:       jobsTable.location,
        workType:       jobsTable.workType,
        employmentType: jobsTable.employmentType,
        salaryMin:      jobsTable.salaryMin,
        salaryMax:      jobsTable.salaryMax,
        description:    jobsTable.description,
        tenantId:       jobsTable.tenantId,
        status:         jobsTable.status,
        createdAt:      jobsTable.createdAt,
      })
      .from(jobsTable)
      .where(eq(jobsTable.id, req.params.id))
      .limit(1);

    if (rows.length === 0) {
      return res.status(404).json({ error: "Job not found", reason: "not_found" });
    }
    if (rows[0].status !== "published") {
      const notYetPublished = ["draft", "active", "pending_approval"].includes(rows[0].status ?? "");
      return res.status(404).json({
        error: notYetPublished ? "Job not yet published to career site" : "Job no longer available",
        reason: notYetPublished ? "not_yet_published" : "closed",
        jobStatus: rows[0].status,
      });
    }

    // Redact tenantId from public response
    const { tenantId: _, ...publicJob } = rows[0];
    res.json({ data: publicJob });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch public job");
    res.status(500).json({ error: "Failed to fetch job" });
  }
});

/* ── POST /api/public/jobs/:id/apply ─────────────────────────────────────── */
router.post("/jobs/:id/apply", applyIpLimit, validate({ body: JobApplyBody }), async (req, res) => {
  try {
    const jobId = req.params.id;
    const {
      firstName,
      lastName,
      email,
      phone,
      currentTitle,
      currentCompany,
      linkedinUrl,
      resumeObjectPath,
      message,
    } = req.body as {
      firstName?: string;
      lastName?: string;
      email?: string;
      phone?: string;
      currentTitle?: string;
      currentCompany?: string;
      linkedinUrl?: string;
      resumeObjectPath?: string;
      message?: string;
    };

    // Validation
    if (!firstName?.trim()) return res.status(400).json({ error: "First name is required" });
    if (!lastName?.trim())  return res.status(400).json({ error: "Last name is required" });
    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "A valid email address is required" });

    // Look up job to get tenantId
    const jobRows = await db
      .select({ id: jobsTable.id, tenantId: jobsTable.tenantId, status: jobsTable.status, title: jobsTable.title })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1);

    if (jobRows.length === 0) return res.status(404).json({ error: "Job not found" });
    if (jobRows[0].status !== "active") return res.status(400).json({ error: "This position is no longer accepting applications" });

    const { tenantId, title: jobTitle } = jobRows[0];

    // Check if candidate already exists with this email under this tenant
    const existingCandidates = await db
      .select({ id: candidatesTable.id })
      .from(candidatesTable)
      .where(
        and(
          eq(candidatesTable.email, email.trim().toLowerCase()),
          eq(candidatesTable.tenantId, tenantId),
        )
      )
      .limit(1);

    let candidateId: string;

    if (existingCandidates.length > 0) {
      candidateId = existingCandidates[0].id;

      // Update any new info they provided
      const updates: Record<string, any> = { updatedAt: new Date() };
      if (phone)          updates.phone          = phone;
      if (currentTitle)   updates.currentTitle   = currentTitle;
      if (currentCompany) updates.currentCompany = currentCompany;
      if (linkedinUrl)    updates.linkedinUrl     = linkedinUrl;
      if (resumeObjectPath) updates.resumeUrl    = resumeObjectPath;

      await db
        .update(candidatesTable)
        .set(updates)
        .where(eq(candidatesTable.id, candidateId));
    } else {
      // Create new candidate. The pre-check above can race with a concurrent
      // apply (or miss a legacy row stored with different email casing), so a
      // unique-violation (23505) on the (tenant, lower(email)) index is treated
      // as "already exists": re-select the existing row and reuse it instead of
      // 500-ing or creating a duplicate.
      const emailLower = email.trim().toLowerCase();
      try {
        const newCandidate = await db
          .insert(candidatesTable)
          .values({
            tenantId,
            firstName:       firstName.trim(),
            lastName:        lastName.trim(),
            email:           emailLower,
            phone:           phone?.trim(),
            currentTitle:    currentTitle?.trim(),
            currentCompany:  currentCompany?.trim(),
            linkedinUrl:     linkedinUrl?.trim(),
            resumeUrl:       resumeObjectPath,
            source:          "careers_portal",
            verificationStatus: "unverified",
          })
          .returning({ id: candidatesTable.id });

        candidateId = newCandidate[0].id;
      } catch (insErr: any) {
        if (insErr?.code !== "23505") throw insErr;
        const [raced] = await db
          .select({ id: candidatesTable.id })
          .from(candidatesTable)
          .where(and(eq(candidatesTable.tenantId, tenantId), sql`lower(${candidatesTable.email}) = ${emailLower}`))
          .limit(1);
        if (!raced) throw insErr;
        candidateId = raced.id;
      }
    }

    /* ── Uniform-response rule (enumeration guard, mirrors /career-register):
     * From here on, the HTTP response is byte-identical whether this email is
     * new, already a candidate, or already applied to this job. A distinct
     * "already applied" status would let an unauthenticated caller probe any
     * (email, job) pair and learn that a person is job-seeking at a specific
     * company. The duplicate branch is handled silently; continuation (portal
     * access) travels ONLY via the emailed magic link, never in the response —
     * returning the invite token here would hand a live magic link for the
     * typed email's portal account to an unverified caller (account takeover). */

    // Check for duplicate application — do NOT reveal it in the response.
    const existingApplication = await db
      .select({ id: applicationsTable.id })
      .from(applicationsTable)
      .where(
        and(
          eq(applicationsTable.jobId, jobId),
          eq(applicationsTable.candidateId, candidateId),
        )
      )
      .limit(1);

    const isDuplicate = existingApplication.length > 0;
    let applicationId: string;

    if (isDuplicate) {
      applicationId = existingApplication[0].id;
      logger.info({ jobId, candidateId, applicationId }, "Duplicate public application — responding uniformly, no new row");
    } else {
      const newApplication = await db
        .insert(applicationsTable)
        .values({
          tenantId,
          jobId,
          candidateId,
          stage: "applied",
          notes: message?.trim() || null,
          ...originFields("inbound", { via: "public_application_form" }, "candidate"),
        })
        .returning({ id: applicationsTable.id });
      applicationId = newApplication[0].id;

      logger.info({ jobId, candidateId, applicationId, jobTitle }, "New public application submitted");

      void logCandidateEvent({
        candidateId,
        jobId,
        tenantId,
        applicationId,
        eventType: "JOB_MATCHED",
        actorType: "candidate",
        source: "lexy_app",
        metadata: { stage: "applied", via: "public_application_form" },
      });
    }

    // Auto-create portal account and EMAIL a magic-link (never returned in the
    // response — see uniform-response rule above). Runs for the duplicate
    // branch too so side-effect timing stays comparable across branches.
    // EMAIL-UNIFORMITY: this single template is the ONLY mail sent from this
    // handler, on every branch (fresh email / existing candidate / duplicate
    // application). ensureCandidateUser silently reuses-or-creates the portal
    // user and sends nothing; generateInviteToken always mints a fresh token.
    // The recipient must never see "you already have an account" wording that
    // differs from the fresh-signup mail — keep it one branch-independent
    // template if you edit this.
    // A failure here must NOT roll back the application.
    try {
      const portalUserId = await ensureCandidateUser(candidateId, tenantId);
      if (portalUserId) {
        const token = await generateInviteToken(candidateId, portalUserId, tenantId);
        const link = `${getLexyAppUrl()}/accept-invite?token=${encodeURIComponent(token)}`;
        const greet = (firstName?.trim() || "there").replace(/[<>&]/g, "");
        const html = `
          <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
            <h2 style="margin:0 0 16px">Application received</h2>
            <p>Hi ${greet},</p>
            <p>Thanks for applying to <strong>${jobTitle}</strong>. Track your application and complete your profile in your candidate portal:</p>
            <p style="margin:24px 0">
              <a href="${link}" style="background:#06b6d4;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Open my candidate portal</a>
            </p>
            <p style="font-size:13px;color:#64748b">Or copy this link into your browser:<br><a href="${link}">${link}</a></p>
            <p style="font-size:13px;color:#64748b">If you didn't apply for this role, you can safely ignore this email.</p>
          </div>
        `;
        const mail = await sendEmail({ to: email.trim().toLowerCase(), subject: `Application received — ${jobTitle}`, html });
        logger.info({ candidateId, simulated: mail.simulated, sent: mail.ok }, "[jobs/apply] portal magic-link emailed");
      } else {
        logger.error({ candidateId, tenantId }, "CRITICAL: Portal user creation returned null after job application — candidate has no portal access");
      }
    } catch (portalErr: any) {
      // Log prominently, keep the application, and return the same uniform body.
      logger.error({ portalErr, candidateId, tenantId }, "Portal account/magic-link flow failed after job application");
    }

    res.status(201).json({
      success: true,
      message: `Your application for "${jobTitle}" has been received. We'll be in touch soon.`,
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to submit application");
    res.status(500).json({ error: "Failed to submit application. Please try again." });
  }
});

/* ── POST /api/public/career-register ──────────────────────────────────── */
// Public self-registration for the career profile landing page.
// Creates a candidate record + portal user and emails a magic sign-in link.
// The HTTP response is IDENTICAL whether or not the email already exists, so
// the endpoint cannot be used as an account-enumeration oracle (see the guard
// comment inside the handler). Continuation happens via email, not the response.
const CAREER_REGISTER_UNIFORM_MESSAGE =
  "Thanks! If that email can be used, we've sent a link to continue. Please check your inbox (and spam folder).";
router.post("/career-register", careerRegisterIpLimit, validate({ body: CareerRegisterBody }), async (req, res) => {
  try {
    const { firstName, lastName, email, password, linkedinUrl } = req.body as {
      firstName?:   string;
      lastName?:    string;
      email?:       string;
      password?:    string;
      linkedinUrl?: string;
    };

    if (!firstName?.trim() || !email?.trim()) {
      return res.status(400).json({ error: "First name and email are required" });
    }

    {
      const policy = validatePasswordStrength(password);
      if (!policy.ok) {
        return res.status(400).json({ error: policy.code, message: policy.message });
      }
    }

    const emailLower = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    // Hash the password
    const passwordHash = await bcrypt.hash(password, 10);

    /* ── Account-enumeration guard ────────────────────────────────────────
     * This endpoint is unauthenticated and internet-facing. It MUST return a
     * byte-identical response whether or not the email already has an account,
     * otherwise anyone can probe an arbitrary email and learn that the person
     * holds a Lexy account — i.e. "this person is job-hunting" — disclosed to
     * unauthenticated strangers at scale.
     *
     * Pattern (mirrors POST /public/forgot-password): ALWAYS respond with the
     * same "check your email to continue" body. The new-account vs.
     * already-registered branch is handled entirely by which email we send,
     * never by the HTTP response. Because the response no longer carries a
     * session token, we cannot auto-login here — new users continue via the
     * magic link in their welcome email.  */
    const firstNameTrim = firstName.trim();

    // Check if user already exists (returning candidate)
    const [existingUser] = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.email, emailLower))
      .limit(1);

    if (existingUser) {
      // Do NOT create anything and do NOT reveal existence. Send a "you already
      // have an account" email out-of-band, then return the uniform response.
      try {
        const loginLink  = `${getLexyAppUrl()}/portal/login`;
        const resetLink  = `${getLexyAppUrl()}/portal/forgot-password`;
        const greetName  = existingUser.name?.split(" ")[0] || firstNameTrim || "there";
        const html = `
          <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
            <h2 style="margin:0 0 16px">You already have a L3xy account</h2>
            <p>Hi ${greetName},</p>
            <p>Someone (probably you) just tried to create a L3xy career profile with this email address — but you already have an account. There's no need to sign up again.</p>
            <p style="margin:24px 0">
              <a href="${loginLink}" style="background:#06b6d4;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Sign in to L3xy</a>
            </p>
            <p style="font-size:13px;color:#64748b">Forgot your password? <a href="${resetLink}">Reset it here</a>.</p>
            <p style="font-size:13px;color:#64748b">If this wasn't you, you can safely ignore this email — your account is unchanged.</p>
          </div>
        `;
        const result = await sendEmail({ to: existingUser.email, subject: "You already have a L3xy account", html });
        logger.info({ userId: existingUser.id, simulated: result.simulated, sent: result.ok }, "[career-register] existing-account notice emailed");
      } catch (mailErr) {
        // Log server-side but still return the identical body — a send failure
        // must not become an enumeration side channel.
        logger.error({ mailErr }, "[career-register] failed to send existing-account notice");
      }
      return res.json({ ok: true, message: CAREER_REGISTER_UNIFORM_MESSAGE });
    }

    // Use the platform admin's tenant so self-registered candidates land
    // in the super-admin's pool (visible to platform_admin users).
    const [platformAdmin] = await db
      .select({ tenantId: usersTable.tenantId })
      .from(usersTable)
      .where(eq(usersTable.role, "platform_admin" as any))
      .limit(1);

    // Fall back to the first tenant if no platform_admin exists yet
    const [firstTenant] = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .limit(1);

    const tenantId = platformAdmin?.tenantId ?? firstTenant?.id ?? "default";
    const fullName = [firstName.trim(), lastName?.trim()].filter(Boolean).join(" ");

    /* Single transaction: create the portal user, then the candidate row
     * linked to that user via candidates.user_id (FK, migration 0012). A
     * partial failure cannot leave behind an orphaned user with no candidate
     * row (which would later cause /career-register to 409 forever) — the
     * whole pair commits atomically or rolls back together. */
    const result = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(usersTable)
        .values({
          tenantId,
          email:        emailLower,
          name:         fullName,
          passwordHash,
          role:         "candidate",
        })
        .returning({ id: usersTable.id, tenantId: usersTable.tenantId, email: usersTable.email, name: usersTable.name, role: usersTable.role, avatarUrl: usersTable.avatarUrl, createdAt: usersTable.createdAt });
      if (!u) throw new Error("user_insert_failed");

      const [c] = await tx
        .insert(candidatesTable)
        .values({
          tenantId,
          userId:      u.id,
          firstName:   firstName.trim(),
          lastName:    lastName?.trim() ?? "",
          email:       emailLower,
          source:      "self_registered",
          pool:        "pending_profile",
          linkedinUrl: linkedinUrl?.trim() || null,
        })
        .returning({ id: candidatesTable.id });
      if (!c) throw new Error("candidate_insert_failed");

      return { user: u, candidate: c };
    });

    const { user, candidate } = result;

    logger.info({ candidateId: candidate.id, userId: user.id }, "Self-registered candidate via career profile page");

    /* Send a welcome email with a magic sign-in link so the new user can
     * continue. We deliberately do NOT return a session token in the HTTP
     * response — doing so would make this branch distinguishable from the
     * existing-account branch above and reopen the enumeration oracle. The
     * magic link reuses the invite-token flow consumed by /accept-invite. */
    try {
      const token   = await generateInviteToken(candidate.id, user.id, tenantId);
      const link    = `${getLexyAppUrl()}/accept-invite?token=${encodeURIComponent(token)}`;
      const greet   = firstNameTrim || "there";
      const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
          <h2 style="margin:0 0 16px">Welcome to L3xy</h2>
          <p>Hi ${greet},</p>
          <p>Your career profile is ready. Click below to sign in and start your career interview — it takes about 10 minutes.</p>
          <p style="margin:24px 0">
            <a href="${link}" style="background:#06b6d4;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Continue to L3xy</a>
          </p>
          <p style="font-size:13px;color:#64748b">Or copy this link into your browser:<br><a href="${link}">${link}</a></p>
        </div>
      `;
      const result2 = await sendEmail({ to: user.email, subject: "Welcome to L3xy — continue your profile", html });
      logger.info({ userId: user.id, simulated: result2.simulated, sent: result2.ok }, "[career-register] welcome magic-link emailed");
    } catch (mailErr) {
      // Log server-side but still return the identical body — a send failure
      // must not become an enumeration side channel.
      logger.error({ mailErr, userId: user.id }, "[career-register] failed to send welcome email");
    }

    return res.json({ ok: true, message: CAREER_REGISTER_UNIFORM_MESSAGE });
  } catch (err: any) {
    logger.error({ err }, "Failed to self-register candidate");
    return res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

/* ── POST /api/public/forgot-password ─────────────────────────────────── */
router.post("/forgot-password", forgotPasswordIpLimit, forgotPasswordEmailLimit, validate({ body: ForgotPasswordBody }), async (req, res) => {
  try {
    const email = String((req.body as any)?.email ?? "").trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email address." });
    }

    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);

    // Always respond 200 so we don't leak account existence.
    if (!user) {
      logger.info({ email }, "[forgot-password] no user found, responding ok");
      return res.json({ ok: true });
    }

    const requestIp = req.ip || null;
    const token = await makeResetToken(user.id, requestIp);
    const link = `${getLexyAppUrl()}/portal/reset-password?token=${encodeURIComponent(token)}`;
    const firstName = user.name?.split(" ")[0] || "there";

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
        <h2 style="margin:0 0 16px">Reset your L3xy password</h2>
        <p>Hi ${firstName},</p>
        <p>We received a request to reset the password for your L3xy account. Click the button below to choose a new password. This link expires in 1 hour.</p>
        <p style="margin:24px 0">
          <a href="${link}" style="background:#06b6d4;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">Reset password</a>
        </p>
        <p style="font-size:13px;color:#64748b">Or copy this link into your browser:<br><a href="${link}">${link}</a></p>
        <p style="font-size:13px;color:#64748b">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `;

    const result = await sendEmail({
      to: user.email,
      subject: "Reset your L3xy password",
      html,
    });

    if (!result.ok) {
      // Log server-side but still return the identical 200 payload to avoid
      // account-enumeration side channel during provider/transient failures.
      logger.error({ email, err: result.error }, "[forgot-password] send failed");
      return res.json({ ok: true });
    }

    /* IMPORTANT: response body must be byte-identical for "user exists" vs
     * "user missing" vs "send failed" vs "exception thrown" so callers cannot
     * use the response as an account-enumeration oracle. Server-side logs
     * still capture the real outcome (including simulated vs real send). */
    logger.info({ userId: user.id, simulated: result.simulated }, "[forgot-password] reset link sent");
    return res.json({ ok: true });
  } catch (err) {
    // Log server-side but still return identical 200 payload.
    logger.error({ err }, "[forgot-password] failed");
    return res.json({ ok: true });
  }
});

/* ── POST /api/public/reset-password ──────────────────────────────────── */
router.post("/reset-password", resetPasswordIpLimit, validate({ body: ResetPasswordBody }), async (req, res) => {
  try {
    const { token, password } = req.body as { token?: string; password?: string };
    if (!token || !password) {
      return res.status(400).json({ error: "Missing token or password." });
    }
    const policy = validatePasswordStrength(password);
    if (!policy.ok) {
      return res.status(400).json({ error: policy.code, message: policy.message });
    }

    const verified = await consumeResetToken(token);
    if (!verified) {
      return res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
    }

    /* Lockout-bypass guard (architect 2026-05-16): the reset flow issues a
     * fresh session token below, so without this check a locked account
     * could regain access simply by completing a password reset — fully
     * bypassing the admin-unlock model in lib/account-lockout.ts. The lock
     * test is rolled INTO the UPDATE's WHERE clause so it's atomic with
     * the password write: if locked_at flips between the read and the
     * write (concurrent failed-login lock), the UPDATE matches zero rows
     * and we 423 without minting a token. */
    const passwordHash = await bcrypt.hash(password, 10);
    const [updated] = await db
      .update(usersTable)
      .set({ passwordHash })
      .where(and(eq(usersTable.id, verified.userId), isNull(usersTable.lockedAt)))
      .returning({ id: usersTable.id, tenantId: usersTable.tenantId, email: usersTable.email, name: usersTable.name, role: usersTable.role, avatarUrl: usersTable.avatarUrl, createdAt: usersTable.createdAt });

    if (!updated) {
      /* Either the user no longer exists OR the account is locked. Re-read
       * to distinguish (for accurate status code + clear UX) without re-
       * opening the bypass — the password row is unchanged either way. */
      const [stillThere] = await db
        .select({ lockedAt: usersTable.lockedAt })
        .from(usersTable)
        .where(eq(usersTable.id, verified.userId))
        .limit(1);
      if (stillThere?.lockedAt) {
        logger.warn(
          { userId: verified.userId },
          "[reset-password] rejected: account is locked — admin unlock required",
        );
        return res.status(423).json({
          error: "ACCOUNT_LOCKED",
          message:
            "This account is locked after too many failed sign-in attempts. Please contact your administrator to unlock it before resetting your password.",
        });
      }
      return res.status(404).json({ error: "Account not found." });
    }

    /* Fire-and-forget security notification — let the user know their password
     * just changed so silent account takeover via a leaked reset email is
     * detectable. Don't block the response on email delivery. */
    void (async () => {
      try {
        const firstName = updated.name?.split(" ")[0] || "there";
        const requestIp = req.ip || "unknown";
        const userAgent = (req.headers["user-agent"] as string) || "unknown device";
        const supportMailto = "mailto:support@l3xy.ai";
        const notifyHtml = `
          <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
            <h2 style="margin:0 0 16px">Your L3xy password was changed</h2>
            <p>Hi ${firstName},</p>
            <p>The password for your L3xy account (<strong>${updated.email}</strong>) was just changed.</p>
            <p style="font-size:13px;color:#64748b">Approximate time: ${new Date().toUTCString()}<br/>From IP: ${requestIp}<br/>Device: ${userAgent}</p>
            <p><strong>If this was you</strong>, no further action is needed.</p>
            <p><strong>If this wasn't you</strong>, your account may be compromised. Please <a href="${supportMailto}">contact L3xy support</a> immediately so we can lock the account and investigate.</p>
          </div>
        `;
        await sendEmail({
          to: updated.email,
          subject: "Your L3xy password was changed",
          html: notifyHtml,
          audit: {
            tenantId: updated.tenantId,
            actorLabel: "Auth",
            subjectType: "user",
            subjectId: updated.id,
            subjectLabel: updated.name,
            action: "auth.password_changed_notification",
          },
        });
      } catch (notifyErr) {
        logger.error({ userId: updated.id, err: notifyErr }, "[reset-password] notification email failed");
      }
    })();

    logger.info({ userId: updated.id }, "[reset-password] password updated");
    const resetToken = issueToken({ userId: updated.id, role: updated.role, tenantId: updated.tenantId, region: await getTenantRegion(updated.tenantId) });
    setSessionTokenCookie(res, resetToken);
    return res.json({
      ok: true,
      user: { ...updated, createdAt: updated.createdAt.toISOString() },
      ...devOnlyTokenBody(resetToken),
    });
  } catch (err) {
    logger.error({ err }, "[reset-password] failed");
    return res.status(500).json({ error: "Could not reset password. Please try again." });
  }
});

/* ── POST /api/public/talent-pool/upload-url ───────────────────────────── */
router.post("/talent-pool/upload-url", validate({ body: TalentPoolUploadUrlBody }), async (req, res) => {
  try {
    const { name, size, contentType } = req.body;
    if (!name || !contentType) {
      return res.status(400).json({ error: "name and contentType required" });
    }

    const ALLOWED = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (!ALLOWED.includes(contentType)) {
      return res.status(400).json({ error: "Invalid file type. Only PDF and Word documents are accepted." });
    }

    const storageService = new ObjectStorageService();
    const uploadURL  = await storageService.getObjectEntityUploadURL();
    const objectPath = storageService.normalizeObjectEntityPath(uploadURL);

    return res.json({ uploadURL, objectPath });
  } catch (err: any) {
    logger.error({ err }, "Failed to generate talent-pool upload URL");
    return res.status(500).json({ error: "Upload URL generation failed" });
  }
});

/* ── POST /api/public/talent-pool ─────────────────────────────────────── */
router.post("/talent-pool", talentPoolIpLimit, validate({ body: TalentPoolBody }), async (req, res) => {
  try {
    const {
      fullName, email, phone, currentTitle, location,
      experienceLevel, workStyle, languages, bio,
      linkedinUrl, resumeObjectPath,
    } = req.body;

    if (!fullName?.trim())  return res.status(400).json({ error: "fullName is required" });
    if (!email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Valid email is required" });
    if (!currentTitle?.trim()) return res.status(400).json({ error: "currentTitle is required" });

    const [submission] = await db
      .insert(talentPoolSubmissionsTable)
      .values({
        fullName:         fullName.trim(),
        email:            email.trim().toLowerCase(),
        phone:            phone?.trim() || null,
        currentTitle:     currentTitle.trim(),
        location:         location?.trim() || null,
        experienceLevel:  experienceLevel || null,
        workStyle:        workStyle || null,
        languages:        Array.isArray(languages) ? languages : [],
        bio:              bio?.trim() || null,
        linkedinUrl:      linkedinUrl?.trim() || null,
        resumeObjectPath: resumeObjectPath || null,
        status:           "new",
      })
      .returning();

    logger.info({ id: submission?.id, email }, "Talent pool submission received");
    return res.status(201).json({ success: true, id: submission?.id });
  } catch (err: any) {
    logger.error({ err }, "Failed to save talent pool submission");
    return res.status(500).json({ error: "Submission failed. Please try again." });
  }
});

/* ── GET /api/public/careers/:slug ──────────────────────────────────────── */
// Returns tenant branding + active jobs for white-labelled careers pages.
//
// Job visibility rules:
//   - Client (sub-tenant) page  → only non-confidential jobs where tenantId = this tenant
//   - Agency/parent page        → own internal jobs + confidential child-client jobs (masked)
//
router.get("/careers/:slug", async (req, res) => {
  try {
    const { slug } = req.params;

    const [tenant] = await db
      .select({
        id:           tenantsTable.id,
        name:         tenantsTable.name,
        slug:         tenantsTable.slug,
        logoUrl:      tenantsTable.logoUrl,
        primaryColor: tenantsTable.primaryColor,
        website:      tenantsTable.website,
        industry:     tenantsTable.industry,
        parentId:     tenantsTable.parentId,
      })
      .from(tenantsTable)
      .where(eq(tenantsTable.slug, slug))
      .limit(1);

    if (!tenant) {
      return res.status(404).json({ error: "Careers page not found" });
    }

    // Find child tenants (if any) — used to pull confidential jobs up to agency page
    const childTenants = await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.parentId, tenant.id));
    const childIds = childTenants.map(c => c.id);
    const isAgency = childIds.length > 0;

    let rawJobs: any[];

    if (isAgency) {
      // Agency page: own internal jobs (any confidentiality) + confidential client jobs
      const whereClause = childIds.length > 0
        ? or(
            eq(jobsTable.tenantId, tenant.id),
            and(
              inArray(jobsTable.tenantId, childIds),
              eq(jobsTable.isConfidential, true),
            )
          )!
        : eq(jobsTable.tenantId, tenant.id);

      rawJobs = await db
        .select({
          id:             jobsTable.id,
          title:          jobsTable.title,
          department:     jobsTable.department,
          location:       jobsTable.location,
          workType:       jobsTable.workType,
          employmentType: jobsTable.employmentType,
          salaryMin:      jobsTable.salaryMin,
          salaryMax:      jobsTable.salaryMax,
          description:    jobsTable.description,
          createdAt:      jobsTable.createdAt,
          isConfidential: jobsTable.isConfidential,
          tenantId:       jobsTable.tenantId,
        })
        .from(jobsTable)
        .where(and(whereClause, eq(jobsTable.status, "active")))
        .orderBy(desc(jobsTable.createdAt));
    } else {
      // Client page: only non-confidential jobs for this tenant
      rawJobs = await db
        .select({
          id:             jobsTable.id,
          title:          jobsTable.title,
          department:     jobsTable.department,
          location:       jobsTable.location,
          workType:       jobsTable.workType,
          employmentType: jobsTable.employmentType,
          salaryMin:      jobsTable.salaryMin,
          salaryMax:      jobsTable.salaryMax,
          description:    jobsTable.description,
          createdAt:      jobsTable.createdAt,
          isConfidential: jobsTable.isConfidential,
          tenantId:       jobsTable.tenantId,
        })
        .from(jobsTable)
        .where(and(
          eq(jobsTable.tenantId, tenant.id),
          eq(jobsTable.status, "active"),
          eq(jobsTable.isConfidential, false),
        ))
        .orderBy(desc(jobsTable.createdAt));
    }

    // Mask client identity for confidential jobs (posted on agency page)
    const jobs = rawJobs.map(j => ({
      id:             j.id,
      title:          j.title,
      department:     j.department,
      location:       j.location,
      workType:       j.workType,
      employmentType: j.employmentType,
      salaryMin:      j.salaryMin,
      salaryMax:      j.salaryMax,
      description:    j.description,
      createdAt:      j.createdAt,
      isConfidential: j.isConfidential,
      // Only expose the client name for non-confidential jobs on an agency page
      postingLabel:   j.isConfidential ? "Confidential Client" : null,
    }));

    // Strip parentId from the tenant object before sending
    const { parentId: _omit, ...tenantPublic } = tenant;
    res.json({ tenant: tenantPublic, jobs, total: jobs.length });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch careers page");
    res.status(500).json({ error: "Failed to load careers page" });
  }
});

/* ── POST /api/sales-lead (and legacy alias /api/demo-request) ─────────────
 * Lead-capture only — writes to the `demo_requests` table for sales follow-up.
 * Does NOT create a tenant. Prospects who want to self-serve a trial workspace
 * should hit POST /api/plans/start-trial instead (email-verified flow).
 *
 * The legacy `/demo-request` path is kept so existing forms keep working while
 * we migrate frontends to the clearer name.
 */
async function salesLeadHandler(req: any, res: any) {
  try {
    const { fullName, email, phone, company } = req.body;
    if (!fullName || !email) {
      return res.status(400).json({ error: "Name and email are required." });
    }
    await db.execute(sql`
      INSERT INTO demo_requests (full_name, email, phone, company)
      VALUES (${fullName}, ${email?.trim()}, ${phone?.trim() || null}, ${company?.trim() || null})
    `);
    logger.info({ email, company }, "Sales lead received");
    return res.status(201).json({ success: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to save sales lead");
    return res.status(500).json({ error: "Submission failed. Please try again." });
  }
}
router.post("/sales-lead", validate({ body: SalesLeadBody }), salesLeadHandler);
router.post("/demo-request", validate({ body: SalesLeadBody }), salesLeadHandler); // legacy alias

export default router;
