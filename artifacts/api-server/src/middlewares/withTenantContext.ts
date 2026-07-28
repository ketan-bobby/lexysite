/**
 * withTenantContext.ts — Per-request RLS context middleware
 *
 * ─── What this does ─────────────────────────────────────────────────────────
 * For every authenticated /api/* request, this middleware:
 *   1. Decodes the HMAC-signed bearer token to get { tenantId, role }
 *      (no DB lookup — the verified JWT payload is the source of truth).
 *   2. Acquires a dedicated PoolClient from the shared pg pool.
 *   3. Runs three session-level SET statements on that client:
 *        SET ROLE lexy_app                          → drop BYPASSRLS
 *        SET app.current_tenant_id = '<tenant>'     → RLS policy uses this
 *        SET app.is_platform_admin = 'true'|'false' → RLS bypass for admins
 *   4. Wraps a Drizzle handle around that client and stores it in
 *      AsyncLocalStorage. The global `db` Proxy in @workspace/db checks
 *      that storage on every call, so handlers that do `db.select()...`
 *      automatically run their queries on the locked-down connection.
 *   5. When the response finishes (or closes early), runs `DISCARD ALL`
 *      to wipe session state, then releases the client back to the pool.
 *
 * ─── What this does NOT do ──────────────────────────────────────────────────
 *   • It does NOT enforce auth. Routes that need auth must still use
 *     resolveUser/requireAuth as before. This middleware silently
 *     falls through (no client acquired, no context set) for any
 *     request without a valid bearer token — those requests use the
 *     admin pool, exactly as they did before this pilot.
 *   • It does NOT cover Stripe webhooks, public unauthenticated
 *     endpoints, /health, or the raw-body transcription endpoint. Those
 *     routes are listed in BYPASS_PREFIXES and skipped entirely.
 *
 * ─── Failure handling ───────────────────────────────────────────────────────
 *   • Bad token (forged / expired) → silently fall through. The route's
 *     own auth middleware will reject with 401.
 *   • Pool client acquisition fails → 503. We do NOT silently fall
 *     through here, because that would unexpectedly downgrade the
 *     request from RLS-enforced to admin-pool, defeating the pilot.
 *   • SET fails → 503 + release. Same reasoning.
 *
 * ─── Performance note ───────────────────────────────────────────────────────
 * This adds ~3 round-trips (3 SET statements) to every authenticated
 * request. On a local Postgres that is sub-millisecond; on a remote
 * primary it is noticeable. If/when we roll out beyond the pilot we
 * should consider batching them into one query, or using a prepared
 * "context" function on the DB side.
 */
import type { Request, Response, NextFunction } from "express";
import { pool, requestDbContext, schema, dbAdmin, usersTable } from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { verifyToken, tokenFromRequest } from "../lib/auth-token";
import { logger } from "../lib/logger";

/**
 * Paths under /api that MUST NOT acquire an RLS-bound connection because
 * they either:
 *   (a) have no bearer token (webhooks, public endpoints, candidate cookies),
 *   (b) use a raw body parser whose semantics we must not disturb, or
 *   (c) are health/diagnostic endpoints that should run with zero overhead.
 *
 * NOTE on /api/public/careers: those routes intentionally read another
 * tenant's careers data anonymously. They must keep using dbAdmin.
 */
/**
 * BYPASS list — routes that are CALLABLE WITHOUT a bearer token and
 * are allowed to use the admin pool (dbAdmin / BYPASSRLS).
 *
 * The bypass list serves two purposes:
 *   1. Skip the cost of acquiring a pool client + SET ROLE on routes
 *      that don't need RLS context (public read endpoints, webhooks).
 *   2. Whitelist routes for the fail-closed mechanism below: every
 *      non-bypass /api/* route that arrives WITHOUT a valid bearer
 *      token will have an AsyncLocalStorage sentinel set so that any
 *      attempt to use the global `db` Proxy throws — preventing a
 *      route that forgot resolveUser/requireAuth from silently
 *      bypassing RLS via the admin pool.
 *
 * Adding a new entry here is a SECURITY decision: it says "this route
 * is intentionally callable without a bearer token, and is responsible
 * for its own access control (e.g. inbound-webhook signature, URL
 * invite token, captcha)."
 *
 * Matching is "exact OR prefix" (`reqPath === p || reqPath.startsWith(p)`),
 * so trailing-slash entries (e.g. `/invites/`) match nested paths like
 * `/invites/abc123/accept` but NOT the bare `/invites` create endpoint.
 */
const BYPASS_PREFIXES = [
  /* Already-bypassed before fail-closed: */
  "/public/",            // unauthenticated marketing/careers/signup endpoints
  "/billing/webhook",    // Stripe webhook (signature-verified raw body)
  "/webhooks/",          // SES + inbound-email webhooks (inbound-secret guarded)
  "/auth/microsoft-graph/callback", // Outlook consent redirect (no bearer; state-cookie guarded)
  "/health",             // liveness/readiness probes

  /* Added 2026-05-16 with the fail-closed Proxy throw.
   * Each line corresponds to an audited route that legitimately runs
   * without a bearer token; see route map below for the full audit. */

  // ── /auth/ routes that exchange email+password (or URL token) for a bearer token ──
  "/auth/login",
  "/auth/candidate-login",
  "/auth/register",
  "/auth/microsoft/",           // Entra SSO: start + callback run pre-bearer-token
  "/auth/trial-token-info",      // GET ?token=… verifies a magic link
  "/auth/complete-trial-signup", // POST { token, password } completes signup
  "/auth/logout",                // stateless no-op
  "/auth/me",                    // returns 401 itself when token missing/invalid;
                                 // when token IS valid, withTenantContext can't
                                 // resolve a tenant for some candidate flows
                                 // anyway — handler does its own dbAdmin lookup.

  // ── Invite-by-URL-token flows (no bearer header; token is in the URL) ──
  // NOTE: /invites/ is deliberately NOT a broad prefix bypass. A prefix entry
  // here would also bypass authenticated sibling routes such as
  // /invites/bulk-career-invite and /invites/career-campaign-status, dropping
  // them onto the admin pool with no RLS. The genuinely public URL-token
  // routes are bypassed narrowly (UUID-strict) via BYPASS_REGEXES below.
  "/staff-invites/",  // GET /staff-invites/:token, POST /staff-invites/:token/accept
                      // (POST /staff-invites with no trailing slash → still authed via resolveUser)

  // ── Added 2026-05-16 follow-up after second architect review.
  //    These were verified DB-touching public flows that were not in the
  //    original bypass list and would 500 under the fail-closed Proxy. ──
  "/plans/start-trial",        // POST — magic-link trial signup
  "/plans/demo",               // legacy alias of /plans/start-trial
  "/plans/start-trial/verify", // GET — completes magic-link flow
  "/outreach/reply/",          // GET/POST /outreach/reply/:token — candidate replies
  "/outreach/reply-msg/",      // GET/POST /outreach/reply-msg/:token — message thread
  "/newsletter/",              // POST /newsletter/subscribe (public form)
];

/**
 * Regex-based bypasses for routes with a dynamic segment in the middle of
 * the path — currently the interview cookie-flow endpoints, where the
 * `:interviewId` UUID sits between the prefix and the suffix and the
 * simple "startsWith" prefix matcher above cannot distinguish them from
 * authenticated /interviews/:scheduleId/feedback (which uses resolveUser
 * and DOES need RLS context).
 *
 * Each entry MUST be anchored with `^…$` and match exactly one route —
 * keep the list narrow so a typo in a route handler can't silently
 * widen the bypass surface.
 */
const BYPASS_REGEXES: RegExp[] = [
  // GET /interviews/:interviewId (candidate fetches the interview shell)
  /^\/interviews\/[A-Za-z0-9_-]+$/,
  // GET /interviews/:interviewId/intro — recruiter "smooth handover" intro,
  // fetched on the start screen BEFORE /begin mints the session cookie. The
  // session id in the URL is the candidate's credential (same trust as the
  // interview link); the handler only surfaces the recruiter's own intro video.
  /^\/interviews\/[A-Za-z0-9_-]+\/intro$/,
  // Consent gate: GET consent-status + POST consent run BEFORE /begin mints
  // the interview session cookie (the candidate is on the public interview
  // link and has no bearer token). The session id in the URL is the
  // candidate's credential — same trust model as GET /interviews/:id and
  // /intro above. POST /consent is additionally guarded by requireSameOriginPost.
  // The handlers scope every query by that session id (and the candidate it
  // resolves to), so they own their own access control on the admin pool.
  /^\/interviews\/[A-Za-z0-9_-]+\/consent-status$/,
  /^\/interviews\/[A-Za-z0-9_-]+\/consent$/,
  // Aggregate STT quality metrics — no candidate data, intentionally
  // unauthenticated (see routes/interviews.ts). Matched EXACTLY so no other
  // route under /interviews/transcribe* can silently inherit the bypass.
  /^\/interviews\/transcribe\/metrics$/,
  // Cookie-flow POSTs (requireInterviewSessionCookie + requireSameOriginPost
  // are the real access gates — no bearer involved)
  /^\/interviews\/[A-Za-z0-9_-]+\/(begin|converse|save-turn|submit-code|answer|proctor-event|end|transcribe)$/,
  // Step-up identity verification (mid-interview liveness check)
  /^\/interviews\/[A-Za-z0-9_-]+\/step-up\/(start|verify)$/,
  // Upload-token: issues a short-lived JWT for recording upload while the
  // interview session cookie is still valid (cookie is the auth gate here,
  // not a bearer token — requireInterviewSessionCookie is the real guard).
  /^\/interviews\/[A-Za-z0-9_-]+\/upload-token$/,
  // Work-authorization logistics: GET prompt + POST answer — cookie-gated,
  // non-scored step that runs after the assessed questions. Not in the main
  // cookie-flow list above because the path suffix doesn't match that pattern.
  /^\/interviews\/[A-Za-z0-9_-]+\/work-auth-prompt$/,
  /^\/interviews\/[A-Za-z0-9_-]+\/work-auth$/,
  // Invite-by-URL-token flows: the token is a crypto.randomUUID() carried in
  // the URL (candidate has no bearer). Matched UUID-strict so authenticated
  // sibling routes (/invites/bulk-career-invite, /invites/career-campaign-status,
  // /invites/generate) do NOT bypass — they must stay on the RLS-bound pool.
  /^\/invites\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^\/invites\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/accept$/i,
];

/* Note: `/candidate-portal/` used to be listed here on the assumption that
 * candidates used cookie sessions. That was wrong — candidates log in via
 * /auth/candidate-login and receive a bearer token in exactly the same
 * shape as recruiters, so they already flow through this middleware and
 * onto the RLS-bound connection. The bypass entry was vestigial and was
 * removed as part of the Phase A RLS extension. */

function shouldBypass(reqPath: string): boolean {
  // reqPath here is relative to the /api mount (Express strips the mount
  // before middleware runs), so "/public/foo" → bypass.
  for (const p of BYPASS_PREFIXES) {
    if (reqPath === p || reqPath.startsWith(p)) return true;
  }
  for (const r of BYPASS_REGEXES) {
    if (r.test(reqPath)) return true;
  }
  return false;
}

/**
 * Defense-in-depth: tenant IDs in this codebase are arbitrary text (not
 * strict UUIDs — see e.g. "00000000-0000-0000-0000-00000000p1at"), so we
 * cannot regex for a UUID shape. Instead we whitelist what we'll splice
 * into a SET statement: alphanumerics, dash, underscore, length ≤ 64.
 * The tenant id originates from a HMAC-verified JWT payload, so this is
 * belt-and-braces; if validation ever fails we 401 and log loudly.
 */
const SAFE_TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Wrap `next()` so the rest of the request chain runs inside an
 * AsyncLocalStorage frame that tells the `db` Proxy to throw on use.
 * This is the fail-closed path: the request landed on a non-bypass
 * route, didn't present valid auth, so it MUST NOT silently get the
 * admin-pool connection.
 *
 * The route's own auth middleware (resolveUser / requireAuth) will
 * normally 401 before any `db` access happens, in which case the throw
 * never fires. The throw is the safety net for routes that forgot
 * their auth middleware entirely.
 */
function runFailClosed(reqPath: string, next: NextFunction): void {
  requestDbContext.run({ failClosed: true, path: reqPath }, () => next());
}

export async function withTenantContext(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (shouldBypass(req.path)) return next();

  /* Header first; httpOnly session cookie as fallback — MUST stay in sync
   * with resolveUser, otherwise a cookie-only request passes auth there but
   * hits this middleware's fail-closed DB pool and 500s. */
  const authHeader = tokenFromRequest(req);
  const verified = verifyToken(authHeader);
  if (!verified.ok) {
    // No valid bearer token. Fail closed: the route's own auth check
    // will normally reject with 401, but if it forgot to, the `db`
    // Proxy will throw on first use instead of silently using dbAdmin.
    return runFailClosed(req.path, next);
  }

  /* CRITICAL: do NOT trust `verified.payload.tenantId` / `verified.payload.role`
   * directly for RLS context. v2 tokens live for 30 days; in that window a
   * user's tenant or role may have been changed by an admin. If we drove RLS
   * off the token claims, a stale token would keep the OLD tenant/admin
   * privileges — silently reintroducing the cross-tenant exposure RLS is
   * meant to prevent.
   *
   * Source of truth is the user row. We use `dbAdmin` (BYPASSRLS) for this
   * lookup specifically because the users table is not yet RLS-protected,
   * and even if it were, we wouldn't have a context to read it under yet.
   *
   * Cost: one extra round-trip per authed request. `resolveUser` already
   * does this same lookup downstream, so the longer-term optimisation is
   * to stash the row on `req` and have `resolveUser` reuse it — tracked as
   * a follow-up in RLS_PILOT.md. */
  let userRow: { id: string; tenantId: string | null; role: string } | undefined;
  try {
    const [row] = await dbAdmin
      .select({ id: usersTable.id, tenantId: usersTable.tenantId, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, verified.payload.sub))
      .limit(1);
    userRow = row;
  } catch (err) {
    logger.error({ err, sub: verified.payload.sub, path: req.path },
      "[withTenantContext] user lookup failed");
    res.status(503).json({ error: "Database temporarily unavailable" });
    return;
  }
  if (!userRow) {
    // Token is valid but the user has been deleted. Fail closed; the
    // route's own auth (resolveUser) will reject with 401, and if it
    // forgot to, the `db` Proxy will throw on first use instead of
    // silently using dbAdmin.
    return runFailClosed(req.path, next);
  }

  const tenantId = userRow.tenantId;
  if (!tenantId || !SAFE_TENANT_ID.test(tenantId)) {
    // User has no tenant (shouldn't happen in this app) or one we refuse
    // to splice. Fail closed — without a tenantId we cannot set the RLS
    // GUC, so any `db` call from the handler would silently leak across
    // tenants. The throw forces such a request to surface as a 500
    // rather than mask the problem.
    logger.warn(
      { sub: userRow.id, path: req.path },
      "[withTenantContext] user has missing/invalid tenantId — failing closed",
    );
    return runFailClosed(req.path, next);
  }

  const isPlatformAdmin = userRow.role === "platform_admin";

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.error({ err, path: req.path }, "[withTenantContext] pool.connect() failed");
    res.status(503).json({ error: "Database temporarily unavailable" });
    return;
  }

  try {
    // Compute the caller's FULL descendant subtree (own tenant + children,
    // grandchildren, …) on this still-superuser connection, BEFORE SET ROLE.
    // The `tenants` table is not RLS-protected, but the recursive CTE runs
    // here while the connection still has BYPASSRLS so we never depend on a
    // policy to read it. UNION (not UNION ALL) dedups → a malformed cyclic
    // hierarchy terminates instead of looping forever.
    //
    // Each id is re-validated against SAFE_TENANT_ID before it is spliced into
    // the comma-delimited GUC: any id containing a comma (the delimiter) or
    // other unexpected character is dropped, so a poisoned tenants row can
    // never widen another tenant's allowed set. The caller's own tenantId is
    // always included (it already passed SAFE_TENANT_ID above).
    let allowedTenantIds: string[] = [tenantId];
    try {
      const subtree = await client.query<{ id: string }>(
        `WITH RECURSIVE subtree AS (
           SELECT id FROM tenants WHERE id = $1
           UNION
           SELECT t.id FROM tenants t
           INNER JOIN subtree s ON t.parent_id = s.id
         )
         SELECT id FROM subtree`,
        [tenantId],
      );
      const ids = subtree.rows
        .map(r => r.id)
        .filter(id => typeof id === "string" && SAFE_TENANT_ID.test(id));
      if (!ids.includes(tenantId)) ids.push(tenantId);
      allowedTenantIds = ids;
    } catch (subErr) {
      // Fail closed to own-tenant-only visibility rather than aborting the
      // request: the standard RLS policies still enforce isolation, the
      // caller just temporarily loses descendant visibility.
      logger.error(
        { err: subErr, tenantId, path: req.path },
        "[withTenantContext] subtree lookup failed — scoping to own tenant only",
      );
      allowedTenantIds = [tenantId];
    }

    // Set the GUCs at the session level (no surrounding BEGIN), so that
    // nested db.transaction() calls inside the handler still get normal
    // BEGIN/COMMIT semantics, and our context survives across them.
    //   app.current_tenant_id  — the caller's own tenant (legacy / audit)
    //   app.is_platform_admin  — 'true' bypasses tenant scoping in policies
    //   app.allowed_tenant_ids — comma-joined own + descendant subtree, read
    //                            by the app_tenant_in_scope() RLS helper
    await client.query(
      `SELECT set_config('app.current_tenant_id', $1, false),
              set_config('app.is_platform_admin', $2, false),
              set_config('app.allowed_tenant_ids', $3, false)`,
      [tenantId, isPlatformAdmin ? "true" : "false", allowedTenantIds.join(",")],
    );
    await client.query(`SET ROLE lexy_app`);
  } catch (err) {
    logger.error(
      { err, tenantId, path: req.path },
      "[withTenantContext] failed to set RLS context — releasing client",
    );
    client.release();
    res.status(503).json({ error: "Database temporarily unavailable" });
    return;
  }

  const requestDb = drizzle(client, { schema });

  // Cleanup runs exactly once, whichever of (finish, close, error) fires
  // first. We DISCARD ALL before release so the next user of this client
  // gets a pristine session, never inheriting our SET ROLE or GUCs.
  //
  // CRITICAL: if DISCARD ALL fails, the session is in an unknown state
  // (may still be in a transaction, may still have SET ROLE active, may
  // have stale GUCs). Returning that client to the pool would leak our
  // context to the NEXT request that picks it up — a cross-request
  // contamination bug. So in that case we pass an Error to release(),
  // which tells pg-pool to DESTROY the client instead of pooling it.
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await client.query(`DISCARD ALL`);
      client.release();
    } catch (err) {
      logger.error(
        { err, tenantId },
        "[withTenantContext] DISCARD ALL failed — destroying client to prevent session contamination",
      );
      try {
        client.release(err as Error);
      } catch (releaseErr) {
        logger.error({ releaseErr }, "[withTenantContext] client.release(err) also failed");
      }
    }
  };
  res.on("finish", cleanup);
  res.on("close", cleanup);

  requestDbContext.run(
    { db: requestDb, tenantId, isPlatformAdmin },
    () => next(),
  );
}
