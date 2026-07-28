/**
 * routes/auth.ts — Authentication & Session Management
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Handles all login flows for recruiter users and candidates. Issues simple
 * bearer tokens (demo_token_<userId>) used by all other protected routes.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   POST /auth/login              Recruiter / admin login. Email + password are
 *                                 BOTH required; password must bcrypt-verify
 *                                 against a real `$2…` hash. Accounts with a
 *                                 sentinel/placeholder hash get 401
 *                                 PASSWORD_NOT_SET and must use Forgot Password.
 *   POST /auth/candidate-login    Candidate portal login. Same rules — invited
 *                                 candidates whose hash is still "portal_invited"
 *                                 must complete the invite flow (clicking the
 *                                 emailed link → /api/invites/:token/accept)
 *                                 OR use Forgot Password before they can log
 *                                 in with email + password here.
 *   POST /auth/register           Self-registration for new candidates. Hashes password
 *                                 with bcrypt, creates a user row with role="candidate".
 *   GET  /auth/me                 Verify token + return current user profile
 *   POST /auth/logout             No-op (tokens are stateless; client discards token)
 *
 * ─── Token format ────────────────────────────────────────────────────────────
 * Tokens are HMAC-SHA256 signed v2 tokens (see lib/auth-token.ts):
 *   v2.<base64url(payload)>.<base64url(hmac)>
 * resolveUser middleware verifies the signature + expiry, then looks up the
 * live user row so role/tenant changes take effect immediately.
 *
 * ─── Tenant enrichment ───────────────────────────────────────────────────────
 * Login responses include tenantName + tenantType from the tenants table so
 * the frontend can render the correct client branding without a separate fetch.
 */
import { Router, type IRouter } from "express";
import { controlDb, db } from "@workspace/db";
import { usersTable, tenantsTable, pendingTrialSignupsTable } from "@workspace/db";
import { and, eq, isNull, gt, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { LoginBody, CandidateLoginBody } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { issueToken, verifyToken, tokenFromRequest, setSessionTokenCookie, clearSessionTokenCookie, devOnlyTokenBody } from "../lib/auth-token";
import { rateLimit } from "../middlewares/rateLimit";
import { validate } from "../middlewares/validate";
import { validatePasswordStrength } from "../lib/password-policy";
import {
  isUserLocked,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "../lib/account-lockout";

/* Shared 423 response used by both /auth/login and /auth/candidate-login.
 * Distinct error code (ACCOUNT_LOCKED) lets the client render a specific
 * "contact your administrator" UI instead of the generic 401. */
const LOCKED_PAYLOAD = {
  error: "ACCOUNT_LOCKED",
  message:
    "This account is locked after too many failed sign-in attempts. Please contact your administrator to unlock it.",
};

const router: IRouter = Router();

/* ── Auth-route rate limits ─────────────────────────────────────────────────
 * These routes are the prime target for credential stuffing, token brute-
 * force, and signup abuse. They were unthrottled prior to 2026-05-23.
 *
 * Two parallel keys are used on /auth/login + /auth/candidate-login:
 *   - per-IP   (10 attempts / 15 min)  defeats single-host brute force
 *   - per-email (5 attempts / 15 min)  defeats rotating-IP brute force
 *     against one known account
 * Both must pass; either tripping returns 429 with Retry-After.
 *
 * `keyFn` lower-cases + trims the email so case/whitespace variants share a
 * bucket. Fallback to "no-email" so a totally empty body still hits a
 * stable bucket instead of bypassing the limiter.
 *
 * Per-route GET trial-token-info gets a looser cap (30 / hour) because a
 * legitimate user may refresh the trial-setup page a handful of times.
 *
 * Limits are in-memory (single replica). See middlewares/rateLimit.ts.
 */
/* Both keyFns return a constant namespace prefix ("login-ip" / "login-email")
 * so /auth/login and /auth/candidate-login SHARE a bucket. Without this,
 * each route gets its own routeKey suffix in rateLimit.ts and an attacker
 * could double their attempts against the same email/IP by alternating the
 * two endpoints. (Architect-flagged split-bypass, 2026-05-23.) */
const loginIpLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  scope: "auth-login",
  keyFn: (req) => `ip:${req.ip ?? "anon"}`,
});
const loginEmailLimit = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  scope: "auth-login",
  keyFn: (req) => {
    const e = String((req.body as any)?.email ?? "").trim().toLowerCase();
    return `email:${e || "no-email"}`;
  },
});
const trialCompleteLimit  = rateLimit({ windowMs: 60 * 60_000, max: 5 });
const trialTokenInfoLimit = rateLimit({ windowMs: 60 * 60_000, max: 30 });

/* ── GET /auth/trial-token-info ──────────────────────────────────────────────
 * Lookup-only (does NOT consume) for the trial-setup page. Lets us greet the
 * user with their email/company on the password form without burning the
 * one-time token if they refresh the page. Returns 401 for invalid/expired/
 * already-consumed tokens — same shape used by the complete endpoint below.
 */
router.get("/auth/trial-token-info", trialTokenInfoLimit, async (req, res) => {
  const token = String(req.query.token ?? "");
  if (!token) { res.status(400).json({ error: "token required" }); return; }

  const [pending] = await db.select({
    email: pendingTrialSignupsTable.email,
    name:  pendingTrialSignupsTable.name,
    company: pendingTrialSignupsTable.company,
    tenantId: pendingTrialSignupsTable.createdTenantId,
  })
    .from(pendingTrialSignupsTable)
    .where(and(
      eq(pendingTrialSignupsTable.loginToken, token),
      isNull(pendingTrialSignupsTable.loginTokenConsumedAt),
      gt(pendingTrialSignupsTable.loginTokenExpiresAt, new Date()),
    ))
    .limit(1);

  if (!pending || !pending.tenantId) {
    res.status(401).json({ error: "INVALID_OR_EXPIRED" });
    return;
  }

  res.json({ email: pending.email, name: pending.name, company: pending.company });
});

/* ── POST /auth/complete-trial-signup ───────────────────────────────────────
 * Final step of the email-verified self-serve trial flow. Takes the loginToken
 * from the trial-setup page plus a chosen password; atomically claims the
 * token, replaces the placeholder "demo_hash" with a real bcrypt hash, and
 * returns a session token. After this point the user can sign in normally
 * via /auth/login with their email + password.
 *
 * Security:
 *   - Single-statement UPDATE ... RETURNING claims the token so concurrent
 *     submits cannot both succeed.
 *   - Password is bcrypt-hashed (cost 10) before hitting the users row.
 *   - Token TTL = 24 h, single-use, separate secret from the email-verify
 *     token (defence-in-depth — the inbox copy never carries the loginToken).
 */
router.post("/auth/complete-trial-signup", trialCompleteLimit, async (req, res) => {
  const body = (req.body ?? {}) as { token?: string; password?: string };
  const token = String(body.token ?? "");
  const password = String(body.password ?? "");
  if (!token) { res.status(400).json({ error: "token required" }); return; }
  const policy = validatePasswordStrength(password);
  if (!policy.ok) {
    res.status(400).json({ error: policy.code, message: policy.message });
    return;
  }

  // Hash the password BEFORE we touch the DB. bcrypt is CPU-only and can
  // fail (cost too high, OOM, etc.) — doing it first means any password-
  // related failure happens before the token is burned, so the user can
  // simply retry. Code review FAIL #1 fix.
  let passwordHash: string;
  try {
    passwordHash = await bcrypt.hash(password, 10);
  } catch (err: any) {
    logger.error({ err: err?.message }, "[complete-trial-signup] bcrypt hash failed");
    res.status(500).json({ error: "HASH_FAILED" });
    return;
  }

  // Single transaction: claim the token, locate the tenant_admin, verify it
  // still has the placeholder hash, and write the new hash. If anything
  // throws, Postgres rolls back the token claim so the user can retry with
  // the same link.
  let result: { user: typeof usersTable.$inferSelect; tenantId: string } | null = null;
  let failureReason: "INVALID_OR_EXPIRED" | "TENANT_USER_MISSING" | "ALREADY_SET" | null = null;
  try {
    result = await db.transaction(async (tx) => {
      const claimed = await tx.execute<{ created_tenant_id: string | null }>(sql`
        UPDATE pending_trial_signups
           SET login_token_consumed_at = now()
         WHERE login_token = ${token}
           AND login_token_consumed_at IS NULL
           AND login_token_expires_at > now()
           AND created_tenant_id IS NOT NULL
        RETURNING created_tenant_id
      `);
      const row = (claimed as any).rows?.[0] ?? (Array.isArray(claimed) ? claimed[0] : undefined);
      const tenantId = row?.created_tenant_id ?? row?.createdTenantId;
      if (!tenantId) { failureReason = "INVALID_OR_EXPIRED"; throw new Error("token_invalid"); }

      /* Locate the tenant_admin so we know which user to update AND so we
         can return TENANT_USER_MISSING separately from ALREADY_SET. The
         actual overwrite is guarded by a SQL-level WHERE clause below — we
         do NOT trust this read for the overwrite decision (TOCTOU-safe). */
      const [u] = await tx.select().from(usersTable)
        .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.role, "tenant_admin")))
        .limit(1);
      if (!u) { failureReason = "TENANT_USER_MISSING"; throw new Error("user_missing"); }

      /* Race-safe overwrite: a single UPDATE … WHERE password_hash='demo_hash'
         RETURNING. If a concurrent Forgot-Password flow set a real hash
         between the SELECT above and this UPDATE, the WHERE clause matches
         zero rows, the RETURNING is empty, and we throw ALREADY_SET — which
         rolls back the token claim. This closes the TOCTOU gap flagged in
         code review. */
      const upd = await tx.execute<{ id: string }>(sql`
        UPDATE users SET password_hash = ${passwordHash}
         WHERE id = ${u.id} AND password_hash = 'demo_hash'
        RETURNING id
      `);
      const updRows = (upd as any).rows ?? upd;
      if (!Array.isArray(updRows) || updRows.length === 0) {
        failureReason = "ALREADY_SET"; throw new Error("password_already_set");
      }

      return { user: u, tenantId };
    });
  } catch {
    if (failureReason === "INVALID_OR_EXPIRED") { res.status(401).json({ error: "INVALID_OR_EXPIRED" }); return; }
    if (failureReason === "ALREADY_SET") {
      res.status(409).json({ error: "ALREADY_SET", message: "An account with this email already has a password. Please sign in instead." });
      return;
    }
    if (failureReason === "TENANT_USER_MISSING") {
      logger.error("[complete-trial-signup] tenant has no tenant_admin user — data integrity issue");
      res.status(500).json({ error: "TENANT_USER_MISSING" });
      return;
    }
    logger.error("[complete-trial-signup] transaction failed");
    res.status(500).json({ error: "INTERNAL" });
    return;
  }

  const { user: u, tenantId } = result!;
  const [tenant] = await db.select({ name: tenantsTable.name, clientType: tenantsTable.clientType, region: tenantsTable.region })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);

  logger.info({ tenantId, userId: u.id, email: u.email }, "[complete-trial-signup] password set, session issued");

  const trialToken = issueToken({ userId: u.id, role: u.role, tenantId: u.tenantId, region: tenant?.region ?? null });
  setSessionTokenCookie(res, trialToken);
  res.json({
    user: {
      id: u.id, tenantId: u.tenantId,
      tenantName: tenant?.name ?? null,
      tenantType: tenant?.clientType ?? null,
      email: u.email, name: u.name, role: u.role,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt.toISOString(),
    },
    ...devOnlyTokenBody(trialToken),
  });
});

router.post("/auth/login", loginIpLimit, loginEmailLimit, validate({ body: LoginBody }), async (req, res) => {
  /* `validate({ body: LoginBody })` has already rejected requests with a
   * missing/non-string email or password with a structured 400. By the time
   * we get here, `req.body.email` and `req.body.password` are guaranteed
   * present and string-typed. We keep `password` as a `let` further down
   * because the existing bcrypt-prefix guard treats a missing real hash as
   * 401, not 400, and the schema doesn't enforce a length floor. */
  const { email, password } = req.body as { email: string; password: string };

  const user = await controlDb.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
  if (!user.length || user[0].role === "candidate") {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const u = user[0];

  /* Account lockout check — must run BEFORE bcrypt.compare so we don't waste
   * CPU on a locked account and so an attacker can't use response-timing to
   * distinguish "locked-and-right-password" from "locked-and-wrong-password".
   * Locked accounts cannot be unlocked by a correct password — only by an
   * admin via POST /users/:userId/unlock. (Hardening 2026-05-16.) */
  if (isUserLocked(u)) {
    logger.warn({ userId: u.id }, "[auth/login] rejected: account locked");
    res.status(423).json(LOCKED_PAYLOAD);
    return;
  }

  /* Admin-initiated suspend (separate from automated lockout). Blocks login
   * until an admin sets status back to "active" via PATCH /users/:id. */
  if ((u as any).status === "suspended") {
    logger.warn({ userId: u.id }, "[auth/login] rejected: account suspended");
    res.status(403).json({
      error: "ACCOUNT_SUSPENDED",
      message: "This account has been suspended by an administrator. Please contact your administrator.",
    });
    return;
  }

  /* Password verification for staff/admin accounts.
   *
   * Hardened 2026-05-23: previously any account whose `password_hash` matched
   * one of the legacy sentinel strings ("portal_invited", "self_registered",
   * "demo") was logged in WITHOUT a password. That bypass is now removed —
   * every staff/admin login MUST present a password that bcrypt-verifies
   * against a real `$2…` hash.
   *
   * Defensive guard: if the stored hash doesn't start with the bcrypt prefix
   * (`$2a` / `$2b` / `$2y`), we refuse the login outright instead of letting
   * bcrypt.compare quietly return false. This catches both the old sentinels
   * AND any future placeholder (e.g. the "demo_hash" used by the trial flow)
   * from accidentally becoming a soft-login. Users in this state must use
   * the password-reset flow (`POST /api/public/forgot-password`) to set a
   * real password.
   */
  if (!password) {
    res.status(401).json({ error: "Password is required" });
    return;
  }
  const isRealBcryptHash = /^\$2[aby]\$/.test(u.passwordHash);
  if (!isRealBcryptHash) {
    logger.warn(
      { userId: u.id, role: u.role },
      "[auth/login] account has non-bcrypt password hash — refusing login; user must set a password via forgot-password",
    );
    res.status(401).json({
      error: "PASSWORD_NOT_SET",
      message:
        "Your account doesn't have a password set yet. Please use the 'Forgot password' link to set one.",
    });
    return;
  }
  const valid = await bcrypt.compare(password, u.passwordHash);
  if (!valid) {
    /* Increment failed-login counter; on the Nth failure the account is
     * locked atomically (see lib/account-lockout.ts). Concurrent failed
     * attempts cannot lose updates — the counter is incremented in SQL. */
    const snap = await recordFailedLogin(u.id);
    if (snap.lockedAt) {
      res.status(423).json(LOCKED_PAYLOAD);
      return;
    }
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Success — reset the failed-login counter (no-op if already 0).
  await recordSuccessfulLogin(u.id);

  const [tenant] = u.tenantId
    ? await db.select({ name: tenantsTable.name, clientType: tenantsTable.clientType, region: tenantsTable.region }).from(tenantsTable).where(eq(tenantsTable.id, u.tenantId)).limit(1)
    : [null];

  const sessionToken = issueToken({ userId: u.id, role: u.role, tenantId: u.tenantId, region: tenant?.region ?? null });

  /* Cookie-auth migration: ALSO set the token in an httpOnly cookie. The JSON
   * body below is unchanged — every existing consumer keeps working;
   * middlewares accept the cookie only when no Authorization header is
   * present. */
  setSessionTokenCookie(res, sessionToken);

  res.json({
    user: {
      id: u.id,
      tenantId: u.tenantId,
      tenantName: tenant?.name ?? null,
      tenantType: tenant?.clientType ?? null,
      email: u.email,
      name: u.name,
      role: u.role,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt.toISOString(),
    },
    ...devOnlyTokenBody(sessionToken),
  });
});

router.post("/auth/candidate-login", loginIpLimit, loginEmailLimit, validate({ body: CandidateLoginBody }), async (req, res) => {
  /* validate() has guaranteed `email` and `password` are present strings;
   * empty-string still needs the auth-level "Invalid credentials" path
   * below (we don't 400-leak which input was bad). */
  const { email, password } = req.body as { email: string; password: string };

  const user = await controlDb.select().from(usersTable).where(eq(usersTable.email, email.toLowerCase())).limit(1);
  if (!user.length || user[0].role !== "candidate") {
    /* Generic 401 — do NOT reveal whether the email exists or has the wrong
     * role. Specific reason (no-such-user vs wrong-role) stays in logs only,
     * to close the account-enumeration channel flagged by code review
     * 2026-05-23. */
    logger.info(
      { emailHash: email.toLowerCase().slice(0, 3), found: user.length > 0 },
      "[auth/candidate-login] rejected: no matching candidate account",
    );
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const u = user[0];

  /* Same lockout check as the staff /auth/login above — locked candidate
   * accounts must be unlocked by an admin before they can sign in. */
  if (isUserLocked(u)) {
    logger.warn({ userId: u.id }, "[auth/candidate-login] rejected: account locked");
    res.status(423).json(LOCKED_PAYLOAD);
    return;
  }

  /* Admin-initiated suspend (same as staff /auth/login). */
  if ((u as any).status === "suspended") {
    logger.warn({ userId: u.id }, "[auth/candidate-login] rejected: account suspended");
    res.status(403).json({
      error: "ACCOUNT_SUSPENDED",
      message: "This account has been suspended. Please contact support.",
    });
    return;
  }

  /* Candidate password verification — see the matching block in /auth/login
   * above for context. The legacy email-only bypass for "portal_invited" and
   * "self_registered" sentinel hashes is removed (2026-05-23): anyone who
   * knew an invited candidate's email could previously impersonate them.
   *
   * Invited candidates (`portal_invited`) must finish the invite by clicking
   * the link emailed to them — that lands on POST /api/invites/:token/accept,
   * which validates the token and returns a fresh session. To get a reusable
   * password afterwards, they use /forgot-password. Self-registered users
   * already go through /career-register, which sets a real bcrypt hash.
   */
  if (!password) {
    res.status(401).json({ error: "Password is required" });
    return;
  }
  const isRealBcryptHash = /^\$2[aby]\$/.test(u.passwordHash);
  if (!isRealBcryptHash) {
    logger.warn(
      { userId: u.id },
      "[auth/candidate-login] candidate has non-bcrypt password hash — refusing login; must accept invite or use forgot-password",
    );
    res.status(401).json({
      error: "PASSWORD_NOT_SET",
      message:
        "This account hasn't set a password yet. Please use the invite link emailed to you, or use 'Forgot password' to set one.",
    });
    return;
  }
  const valid = await bcrypt.compare(password, u.passwordHash);
  if (!valid) {
    /* Match the generic "Invalid credentials" wording used for the "no such
     * account" branch above so an attacker can't distinguish "wrong password
     * for an existing email" from "email doesn't exist". */
    const snap = await recordFailedLogin(u.id);
    if (snap.lockedAt) {
      res.status(423).json(LOCKED_PAYLOAD);
      return;
    }
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // Success — reset the failed-login counter.
  await recordSuccessfulLogin(u.id);

  const [tenant] = u.tenantId
    ? await db.select({ name: tenantsTable.name, clientType: tenantsTable.clientType, region: tenantsTable.region }).from(tenantsTable).where(eq(tenantsTable.id, u.tenantId)).limit(1)
    : [null];

  const candidateToken = issueToken({ userId: u.id, role: u.role, tenantId: u.tenantId, region: tenant?.region ?? null });
  setSessionTokenCookie(res, candidateToken);
  res.json({
    user: {
      id: u.id,
      tenantId: u.tenantId,
      tenantName: tenant?.name ?? null,
      tenantType: tenant?.clientType ?? null,
      email: u.email,
      name: u.name,
      role: u.role,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt.toISOString(),
    },
    ...devOnlyTokenBody(candidateToken),
  });
});

router.get("/auth/me", async (req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");

  const v = verifyToken(tokenFromRequest(req));
  if (!v.ok) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, v.payload.sub)).limit(1);
  if (!u) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [tenant] = u.tenantId
    ? await db.select({ name: tenantsTable.name, clientType: tenantsTable.clientType }).from(tenantsTable).where(eq(tenantsTable.id, u.tenantId)).limit(1)
    : [null];

  res.json({ id: u.id, tenantId: u.tenantId, tenantName: tenant?.name ?? null, tenantType: tenant?.clientType ?? null, email: u.email, name: u.name, role: u.role, avatarUrl: u.avatarUrl, createdAt: u.createdAt.toISOString() });
});

router.post("/auth/logout", (_req, res) => {
  /* Cookie-auth migration: clear the httpOnly session cookie so logout
   * actually terminates cookie-based sessions (the client can't clear an
   * httpOnly cookie itself). */
  clearSessionTokenCookie(res);
  res.json({ success: true, message: "Logged out" });
});

export default router;
