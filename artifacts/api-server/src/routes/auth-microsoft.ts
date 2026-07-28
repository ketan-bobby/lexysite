/**
 * routes/auth-microsoft.ts — Microsoft Entra (Azure AD) SSO
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Adds an OpenID-Connect authorization-code + PKCE login flow against Microsoft
 * Entra, running ALONGSIDE the existing email/password auth in routes/auth.ts.
 * On success it mints the SAME v2 HMAC bearer token every other route already
 * understands (see lib/auth-token.ts), so the rest of the app is unchanged.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET /auth/microsoft/start     Build the Entra authorize URL (PKCE + state in
 *                                 a short-lived httpOnly cookie) and 302 there.
 *   GET /auth/microsoft/callback  Entra redirects back here with ?code&state.
 *                                 Exchange the code, validate the ID token, then
 *                                 match/provision a Lexy user and 302 to the SPA
 *                                 callback page with the bearer token in the URL
 *                                 fragment (#token=…, never a query param).
 *
 * ─── Identity model (locked-in security defaults) ───────────────────────────
 *   • Authority = `common` by default → work, school AND personal Microsoft
 *     accounts may sign in. Override with ENTRA_TENANT.
 *   • Match an existing Lexy user by VERIFIED email (users.email is globally
 *     unique). Existing users keep their role + tenant.
 *   • Unknown users are AUTO-PROVISIONED as the lowest-privilege `candidate`
 *     role in the platform tenant (mirrors POST /public/career-register). They
 *     are NEVER auto-granted a staff/admin role.
 *   • Cross-tenant takeover guard: if an inbound email matches an EXISTING
 *     STAFF (non-candidate) account, the Microsoft tenant id (`tid`) MUST be in
 *     the ENTRA_STAFF_TENANT_IDS allowlist, otherwise the sign-in is refused.
 *     This stops a malicious external Entra tenant from minting a token with a
 *     staff member's email and hijacking the account.
 *
 * ─── Required configuration ──────────────────────────────────────────────────
 *   ENTRA_CLIENT_ID         App-registration (client) id.            [required]
 *   ENTRA_CLIENT_SECRET     App-registration client secret.          [required]
 *   ENTRA_TENANT            Authority segment. Default "common".     [optional]
 *   ENTRA_REDIRECT_URI      Exact redirect URI registered in Entra.  [optional]
 *                           Defaults to <request-origin>/api/auth/microsoft/callback.
 *   ENTRA_POST_LOGIN_URL    SPA callback page. Defaults to
 *                           <request-origin>/auth/microsoft/callback. [optional]
 *   ENTRA_STAFF_TENANT_IDS  Comma-separated Entra tenant ids allowed to SSO into
 *                           existing staff accounts.                  [optional]
 *
 * These routes are pre-auth (no bearer token yet) and so are listed in
 * BYPASS_PREFIXES (`/auth/microsoft/`) in middlewares/withTenantContext.ts.
 */
import { Router, type IRouter, type Request } from "express";
import { ConfidentialClientApplication, CryptoProvider, LogLevel } from "@azure/msal-node";
import { controlDb, db } from "@workspace/db";
import { usersTable, tenantsTable, candidatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { issueToken, setSessionTokenCookie } from "../lib/auth-token";
import { getTenantRegion } from "../lib/region";

const router: IRouter = Router();

const SCOPES = ["openid", "profile", "email"];
const STATE_COOKIE = "ms_sso";
const COOKIE_PATH = "/api/auth/microsoft";

/* ── Lazy MSAL client ──────────────────────────────────────────────────────
 * Built on first use so a missing secret degrades to a clear "not configured"
 * redirect instead of crashing the whole API server at boot. */
let _pca: ConfidentialClientApplication | null = null;
function getClient(): ConfidentialClientApplication | null {
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  if (_pca) return _pca;
  const tenant = (process.env.ENTRA_TENANT || "common").trim();
  _pca = new ConfidentialClientApplication({
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenant}`,
    },
    system: {
      loggerOptions: {
        // Route MSAL's internal logs through our logger at a low volume; never
        // log PII (handled by MSAL when piiLoggingEnabled stays false).
        loggerCallback: (level, message) => {
          if (level === LogLevel.Error) logger.warn({ msal: message }, "[entra] msal");
        },
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
      },
    },
  });
  return _pca;
}

const cryptoProvider = new CryptoProvider();

function originOf(req: Request): string {
  // `app.set("trust proxy", 1)` makes req.protocol honour X-Forwarded-Proto and
  // req.get("host") honour the forwarded host, so this resolves to the public
  // origin (e.g. https://app.l3xy.ai) both in dev (Replit proxy) and prod.
  return `${req.protocol}://${req.get("host")}`;
}

function redirectUriFor(req: Request): string {
  return process.env.ENTRA_REDIRECT_URI?.trim() || `${originOf(req)}${COOKIE_PATH}/callback`;
}

function postLoginUrlFor(req: Request): string {
  return process.env.ENTRA_POST_LOGIN_URL?.trim() || `${originOf(req)}/auth/microsoft/callback`;
}

function loginErrorRedirect(req: Request, code: string): string {
  return `${originOf(req)}/login?sso_error=${encodeURIComponent(code)}`;
}

function staffTenantAllowlist(): string[] {
  return (process.env.ENTRA_STAFF_TENANT_IDS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* ── GET /auth/microsoft/start ─────────────────────────────────────────────── */
router.get("/auth/microsoft/start", async (req, res) => {
  const pca = getClient();
  if (!pca) {
    logger.warn("[entra] sign-in attempted but ENTRA_CLIENT_ID/SECRET not configured");
    return res.redirect(loginErrorRedirect(req, "not_configured"));
  }

  try {
    const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
    const state = cryptoProvider.createNewGuid();

    // PKCE verifier is a secret the client must keep until the callback; the
    // state defends against CSRF. Both ride in a short-lived httpOnly cookie
    // scoped to this route subtree (never readable by page JS).
    res.cookie(STATE_COOKIE, JSON.stringify({ state, verifier }), {
      httpOnly: true,
      secure: true,
      sameSite: "lax", // must survive the top-level GET redirect back from Entra
      maxAge: 10 * 60 * 1000,
      path: COOKIE_PATH,
    });

    const url = await pca.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: redirectUriFor(req),
      responseMode: "query",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      state,
      prompt: "select_account",
    });

    return res.redirect(url);
  } catch (err) {
    logger.error({ err }, "[entra] failed to build authorize URL");
    return res.redirect(loginErrorRedirect(req, "start_failed"));
  }
});

/* ── GET /auth/microsoft/callback ──────────────────────────────────────────── */
router.get("/auth/microsoft/callback", async (req, res) => {
  const pca = getClient();
  if (!pca) return res.redirect(loginErrorRedirect(req, "not_configured"));

  // Always clear the transient cookie regardless of outcome.
  const rawCookie = (req as any).cookies?.[STATE_COOKIE] as string | undefined;
  res.clearCookie(STATE_COOKIE, { path: COOKIE_PATH });

  // Entra may bounce back an error (user cancelled, consent declined, …).
  if (req.query.error) {
    logger.warn({ error: req.query.error, desc: req.query.error_description }, "[entra] callback returned error");
    return res.redirect(loginErrorRedirect(req, String(req.query.error)));
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const stateParam = typeof req.query.state === "string" ? req.query.state : "";
  if (!code) return res.redirect(loginErrorRedirect(req, "missing_code"));

  let cookie: { state?: string; verifier?: string } = {};
  try {
    cookie = rawCookie ? JSON.parse(rawCookie) : {};
  } catch {
    cookie = {};
  }
  if (!cookie.state || !cookie.verifier || cookie.state !== stateParam) {
    logger.warn("[entra] callback state/verifier mismatch — possible CSRF or expired flow");
    return res.redirect(loginErrorRedirect(req, "state_mismatch"));
  }

  let claims: Record<string, any> | undefined;
  try {
    const tokenResponse = await pca.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: redirectUriFor(req),
      codeVerifier: cookie.verifier,
      state: stateParam,
    });
    // MSAL has already validated the ID token signature, issuer (multi-tenant
    // aware for `common`), audience, nonce and expiry by this point.
    claims = (tokenResponse.account?.idTokenClaims ?? (tokenResponse as any).idTokenClaims) as Record<string, any>;
  } catch (err) {
    logger.error({ err }, "[entra] token exchange failed");
    return res.redirect(loginErrorRedirect(req, "token_exchange_failed"));
  }

  if (!claims) return res.redirect(loginErrorRedirect(req, "no_claims"));

  const rawEmail: string = claims.email || claims.preferred_username || claims.upn || "";
  const emailLower = rawEmail.trim().toLowerCase();
  const name: string = (claims.name || "").trim();
  const tid: string = String(claims.tid || "").toLowerCase();

  if (!emailLower || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
    logger.warn({ tid }, "[entra] sign-in had no usable email claim");
    return res.redirect(loginErrorRedirect(req, "no_email"));
  }

  try {
    const { userId, role, tenantId } = await resolveOrProvision(req, res, { emailLower, name, tid });
    if (!userId) return; // resolveOrProvision already issued a redirect

    const token = issueToken({ userId, role, tenantId, region: await getTenantRegion(tenantId) });

    // The httpOnly session cookie is the production auth channel.
    setSessionTokenCookie(res, token);

    // Production: auth rides SOLELY on the httpOnly cookie set above — the
    // token never appears in the redirect URL. Non-production keeps the URL
    // FRAGMENT handoff (#token=…, never a query param, so it can't hit server
    // logs or Referer) because the Replit preview iframe blocks third-party
    // cookies and the SPA's DEV-only Bearer fallback still needs the token.
    if (process.env.NODE_ENV === "production") {
      return res.redirect(postLoginUrlFor(req));
    }
    return res.redirect(`${postLoginUrlFor(req)}#token=${encodeURIComponent(token)}`);
  } catch (err) {
    logger.error({ err }, "[entra] provisioning failed");
    return res.redirect(loginErrorRedirect(req, "provisioning_failed"));
  }
});

const REFUSED = { userId: null, role: "", tenantId: "" } as const;

/**
 * Apply the existing-account sign-in policy to a matched user and return the
 * session shape, or null after writing a refusal redirect. This is the SINGLE
 * gate every existing-user path MUST flow through — both the first SELECT and
 * the 23505 race re-resolve — so a concurrent first-login can never bypass the
 * suspension check or the cross-tenant staff takeover guard.
 */
function gateExistingUser(
  req: Request,
  res: import("express").Response,
  user: { id: string; role: string; tenantId: string; status?: string | null },
  tid: string,
): { userId: string; role: string; tenantId: string } | null {
  if ((user.status ?? "") === "suspended") {
    res.redirect(loginErrorRedirect(req, "account_suspended"));
    return null;
  }
  // Cross-tenant takeover guard for STAFF accounts.
  if (user.role !== "candidate") {
    const allow = staffTenantAllowlist();
    if (!allow.length || !allow.includes(tid)) {
      logger.warn({ role: user.role, tid }, "[entra] refused staff SSO from non-allowlisted tenant");
      res.redirect(loginErrorRedirect(req, "staff_tenant_restricted"));
      return null;
    }
  }
  logger.info({ userId: user.id, role: user.role }, "[entra] signed in existing user");
  return { userId: user.id, role: user.role, tenantId: user.tenantId };
}

/**
 * Resolve the Lexy user for a verified Microsoft identity, provisioning a
 * lowest-privilege candidate when none exists. Returns userId=null after
 * writing its own redirect when the sign-in must be refused.
 */
async function resolveOrProvision(
  req: Request,
  res: import("express").Response,
  { emailLower, name, tid }: { emailLower: string; name: string; tid: string },
): Promise<{ userId: string | null; role: string; tenantId: string }> {
  const [existing] = await controlDb
    .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId, status: usersTable.status })
    .from(usersTable)
    .where(eq(usersTable.email, emailLower))
    .limit(1);

  if (existing) {
    return gateExistingUser(req, res, existing, tid) ?? REFUSED;
  }

  // ── Auto-provision a candidate (mirrors POST /public/career-register) ──
  const [platformAdmin] = await db
    .select({ tenantId: usersTable.tenantId })
    .from(usersTable)
    .where(eq(usersTable.role, "platform_admin" as any))
    .limit(1);
  const [firstTenant] = await db.select({ id: tenantsTable.id }).from(tenantsTable).limit(1);
  const tenantId = platformAdmin?.tenantId ?? firstTenant?.id ?? "default";

  const parts = name.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || emailLower.split("@")[0];
  const lastName = parts.slice(1).join(" ");

  try {
    const created = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(usersTable)
        .values({
          tenantId,
          email: emailLower,
          name: name || firstName,
          // Sentinel hash — password login is disabled for SSO-only accounts
          // until they set one via Forgot Password (mirrors "self_registered").
          passwordHash: "sso_microsoft",
          role: "candidate",
        })
        .returning({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId });
      if (!u) throw new Error("user_insert_failed");

      const [c] = await tx
        .insert(candidatesTable)
        .values({
          tenantId,
          userId: u.id,
          firstName,
          lastName,
          email: emailLower,
          source: "self_registered",
          pool: "pending_profile",
        })
        .returning({ id: candidatesTable.id });
      if (!c) throw new Error("candidate_insert_failed");

      return u;
    });

    logger.info({ userId: created.id }, "[entra] auto-provisioned candidate via Microsoft SSO");
    return { userId: created.id, role: created.role, tenantId: created.tenantId };
  } catch (err: any) {
    // Concurrent first-time sign-in: another request created the user between
    // our SELECT and INSERT (users.email is unique → 23505). Re-resolve.
    if (err?.code === "23505" || /unique|duplicate/i.test(String(err?.message))) {
      const [again] = await controlDb
        .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId, status: usersTable.status })
        .from(usersTable)
        .where(eq(usersTable.email, emailLower))
        .limit(1);
      // Re-resolved users MUST pass the same suspension + staff-allowlist gate
      // as the normal path — never short-circuit it on the race recovery.
      if (again) return gateExistingUser(req, res, again, tid) ?? REFUSED;
    }
    throw err;
  }
}

export default router;
