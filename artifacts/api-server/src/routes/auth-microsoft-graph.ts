/**
 * routes/auth-microsoft-graph.ts — "Connect your Outlook" consent flow
 *
 * Distinct from routes/auth-microsoft.ts (SSO login). These routes let an
 * already-logged-in recruiter grant Lexy delegated Microsoft Graph access
 * (Mail.Send + Mail.Read + offline_access) so the platform can send "as them"
 * from their own mailbox and later sync their Outlook replies back into Lexy.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /auth/microsoft-graph/start       (AUTH)   Build the consent URL. The
 *        recruiter's userId+tenantId ride in a short-lived httpOnly cookie
 *        (alongside PKCE verifier + state) so the callback can attribute the
 *        grant. Returns { url } as JSON — the SPA navigates there.
 *   GET  /auth/microsoft-graph/callback    (BYPASS) Microsoft redirects here
 *        (top-level GET, no bearer). Validate state, redeem the code, store the
 *        encrypted refresh token, then 302 back to recruiter settings.
 *   GET  /auth/microsoft-graph/status      (AUTH)   Connection status for the UI.
 *   POST /auth/microsoft-graph/disconnect  (AUTH)   Remove the connection.
 *
 * Only the /callback path is added to BYPASS_PREFIXES (it has no bearer token);
 * the other three require a valid session and 401 otherwise.
 */
import { Router, type IRouter, type Request } from "express";
import { verifyToken, tokenFromRequest } from "../lib/auth-token";
import { logger } from "../lib/logger";
import {
  isGraphConfigured,
  generatePkce,
  newGuid,
  buildConsentUrl,
  redeemCodeAndStore,
} from "../lib/graph-auth";
import { getMailAccount, deleteMailAccount } from "../lib/recruiter-mail";

const router: IRouter = Router();

const STATE_COOKIE = "ms_graph";
const COOKIE_PATH = "/api/auth/microsoft-graph";

/**
 * Resolve the public origin for building absolute redirect URLs.
 *
 * Behind the deployment proxy the inbound `Host` header is the internal bind
 * address (e.g. `localhost:8080`), so `req.get("host")` cannot be trusted to
 * produce a working public URL. Prefer an explicitly configured public base
 * URL (same convention as staff-invites.ts / plans.ts) and only fall back to
 * the request host for local development where no public URL is configured.
 */
function configuredPublicOrigin(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.APP_PUBLIC_URL ||
    process.env.APP_BASE_URL ||
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "")
  ).replace(/\/$/, "");
}
function originOf(req: Request): string {
  return configuredPublicOrigin() || `${req.protocol}://${req.get("host")}`;
}
function redirectUriFor(req: Request): string {
  return process.env.ENTRA_GRAPH_REDIRECT_URI?.trim() || `${originOf(req)}${COOKIE_PATH}/callback`;
}
function settingsRedirect(req: Request, status: "connected" | "error", code?: string): string {
  const q = code ? `&reason=${encodeURIComponent(code)}` : "";
  return `${originOf(req)}/recruiter/settings?outlook=${status}${q}`;
}

/* ── GET /auth/microsoft-graph/start (AUTH) ─────────────────────────────────── */
router.get("/auth/microsoft-graph/start", async (req, res) => {
  const v = verifyToken(tokenFromRequest(req));
  if (!v.ok) return res.status(401).json({ error: "unauthenticated" });
  if (!isGraphConfigured()) return res.status(503).json({ error: "not_configured" });

  try {
    const { verifier, challenge } = await generatePkce();
    const state = newGuid();
    res.cookie(
      STATE_COOKIE,
      JSON.stringify({ state, verifier, userId: v.payload.sub, tenantId: v.payload.tenantId ?? "" }),
      { httpOnly: true, secure: true, sameSite: "lax", maxAge: 10 * 60 * 1000, path: COOKIE_PATH },
    );
    const url = await buildConsentUrl({ redirectUri: redirectUriFor(req), state, challenge });
    if (!url) return res.status(503).json({ error: "not_configured" });
    return res.json({ url });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[graph] failed to build consent URL");
    return res.status(500).json({ error: "start_failed" });
  }
});

/* ── GET /auth/microsoft-graph/callback (BYPASS) ───────────────────────────── */
router.get("/auth/microsoft-graph/callback", async (req, res) => {
  const rawCookie = (req as any).cookies?.[STATE_COOKIE] as string | undefined;
  res.clearCookie(STATE_COOKIE, { path: COOKIE_PATH });

  if (req.query.error) {
    logger.warn({ error: req.query.error }, "[graph] consent callback returned error");
    return res.redirect(settingsRedirect(req, "error", String(req.query.error)));
  }

  const code = typeof req.query.code === "string" ? req.query.code : "";
  const stateParam = typeof req.query.state === "string" ? req.query.state : "";
  if (!code) return res.redirect(settingsRedirect(req, "error", "missing_code"));

  let cookie: { state?: string; verifier?: string; userId?: string; tenantId?: string } = {};
  try {
    cookie = rawCookie ? JSON.parse(rawCookie) : {};
  } catch {
    cookie = {};
  }
  if (!cookie.state || !cookie.verifier || !cookie.userId || cookie.state !== stateParam) {
    logger.warn("[graph] callback state/verifier/user mismatch — possible CSRF or expired flow");
    return res.redirect(settingsRedirect(req, "error", "state_mismatch"));
  }

  const result = await redeemCodeAndStore({
    userId: cookie.userId,
    tenantId: cookie.tenantId ?? "",
    code,
    verifier: cookie.verifier,
    redirectUri: redirectUriFor(req),
  });
  return res.redirect(
    result.ok ? settingsRedirect(req, "connected") : settingsRedirect(req, "error", result.error),
  );
});

/* ── GET /auth/microsoft-graph/status (AUTH) ───────────────────────────────── */
router.get("/auth/microsoft-graph/status", async (req, res) => {
  const v = verifyToken(tokenFromRequest(req));
  if (!v.ok) return res.status(401).json({ error: "unauthenticated" });
  const acct = await getMailAccount(v.payload.sub);
  res.json({
    configured: isGraphConfigured(),
    connected: Boolean(acct && acct.status === "connected"),
    status: acct?.status ?? null,
    email: acct?.email ?? null,
    // Only surface an error string when the mailbox is actually unhealthy.
    lastError: acct && acct.status !== "connected" ? acct.lastError ?? null : null,
  });
});

/* ── POST /auth/microsoft-graph/disconnect (AUTH) ──────────────────────────── */
router.post("/auth/microsoft-graph/disconnect", async (req, res) => {
  const v = verifyToken(tokenFromRequest(req));
  if (!v.ok) return res.status(401).json({ error: "unauthenticated" });
  await deleteMailAccount(v.payload.sub);
  res.json({ ok: true });
});

export default router;
