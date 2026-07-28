/**
 * resolveUser.ts — Bearer-token auth middleware
 *
 * Verifies the HMAC-signed token from `Authorization: Bearer …` (see
 * lib/auth-token.ts), looks up the current user row, and attaches it to
 * `req.resolvedUser`. Every protected route relies on this — no handler
 * should assume `resolvedUser` exists if the route was mounted without
 * resolveUser in front of it.
 *
 * Failure modes (all return 401, no body details to avoid info leak):
 *   • missing / malformed token
 *   • bad HMAC signature  → token forged or wrong SESSION_SECRET
 *   • expired              → past payload.exp
 *   • user no longer exists in DB
 *
 * The DB lookup uses the live row so role/tenant changes take effect on the
 * next request without forcing the user to re-login.
 */
import { Request, Response, NextFunction } from "express";
import { controlDb } from "@workspace/db";
import { usersTable, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyToken, tokenFromRequest } from "../lib/auth-token";
import { logger } from "../lib/logger";
import { isRegion, type Region } from "../lib/region";

export interface ResolvedUser {
  id: string;
  tenantId: string | null;
  role: string;
  email: string;
  name: string;
  /** Multi-region Phase 0: the data-residency cell this user's tenant
   *  lives in. Populated for every authenticated request. Use this to
   *  pick the right pool via `forRegion(req.region)` and to route AI /
   *  storage calls via `aiForRegion()` / `bucketFor()`. */
  region: Region;
  /** The caller's Morning Report watermark, read from the SAME identity row
   *  this middleware already loads. Exposed so read paths (GET
   *  /analytics/morning-report) don't re-query the identity row for it. */
  lastReportSeenAt: Date | null;
}

declare global {
  namespace Express {
    interface Request {
      resolvedUser?: ResolvedUser;
      /** Convenience alias for resolvedUser.region. Always set on routes
       *  that mount the resolveUser middleware. */
      region?: Region;
    }
  }
}

export async function resolveUser(req: Request, res: Response, next: NextFunction) {
  /* Header first; httpOnly session cookie as fallback (Phase 1 of the
   * cookie-auth migration — see lib/auth-token.ts tokenFromRequest). */
  const authHeader = tokenFromRequest(req);
  const result = verifyToken(authHeader);
  if (!result.ok) {
    if (result.reason === "bad_sig") {
      logger.warn({ ip: req.ip, path: req.path }, "[auth] bad signature on bearer token");
    } else {
      logger.warn(
        { ip: req.ip, path: req.path, method: req.method, reason: result.reason, hasHeader: !!authHeader },
        "[auth] token rejected",
      );
    }
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const userId = result.payload.sub;
  /* Use controlDb (admin pool) for the identity lookup. The `db` Proxy is
   * RLS-bound and may be in fail-closed mode (set by withTenantContext when
   * it couldn't validate auth itself), which would turn a clean 401 into a
   * 500. The users table is identity data, not tenant-scoped, so RLS is not
   * relevant here — matching what withTenantContext does for its own lookup. */
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!u) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  /* Resolve region. Prefer the JWT claim (issued at login from the
   * tenant directory) to avoid an extra hop on every request. Fall back
   * to a controlDb lookup for tokens minted before the claim existed,
   * or for the rare user with no tenant (platform_admin seed). Default
   * 'us' if neither yields a value — single-cell mode means this still
   * routes correctly. */
  let region: Region = "us";
  const claimed = result.payload.region;
  if (claimed && isRegion(claimed)) {
    region = claimed;
  } else if (u.tenantId) {
    const [t] = await controlDb
      .select({ region: tenantsTable.region })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, u.tenantId))
      .limit(1);
    if (t?.region && isRegion(t.region)) region = t.region as Region;
  }

  req.resolvedUser = { id: u.id, tenantId: u.tenantId, role: u.role, email: u.email, name: u.name, region, lastReportSeenAt: u.lastReportSeenAt ?? null };
  req.region = region;
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.resolvedUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }
    next();
  };
}
