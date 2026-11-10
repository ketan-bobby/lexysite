import type { Request, Response, NextFunction } from "express";
import { tokenFromRequest, verifyToken } from "../lib/auth-token";
import { sessionIsRevoked } from "../lib/session-revocations";

export function createSessionRevocationGuard(lookup = sessionIsRevoked) {
  return async function sessionRevocationGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Re-login and idempotent logout must work with an old/revoked browser cookie.
    if (
      req.path === "/auth/logout" ||
      (req.method === "GET" &&
        ["/auth/microsoft/start", "/auth/microsoft/callback"].includes(req.path)) ||
      (req.method === "POST" &&
        [
          "/auth/login",
          "/auth/candidate-login",
          "/public/forgot-password",
          "/public/reset-password",
        ].includes(req.path))
    ) {
      next();
      return;
    }
    const raw = tokenFromRequest(req);
    const verified = verifyToken(raw);
    if (!raw || !verified.ok || verified.legacy) {
      next();
      return;
    }
    try {
      if (await lookup(raw)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    } catch {
      // Missing migration/unavailable identity store is never an auth bypass.
      res.status(503).json({ error: "Session verification unavailable. Please retry." });
      return;
    }
    next();
  };
}
export const sessionRevocationGuard = createSessionRevocationGuard();
