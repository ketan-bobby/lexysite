import type { Request, Response, NextFunction } from "express";
import { controlDb, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAuthUserId, clearSessionTokenCookie } from "../lib/auth-token";

/**
 * Covers valid header AND cookie tokens, including RLS-bypassed endpoints.
 * Signature verification identifies a caller; it cannot revive an erased account.
 */
export async function rejectErasedAccount(req: Request, res: Response, next: NextFunction) {
  const id = getAuthUserId(req);
  if (!id) return next();
  try {
    const [user] = await controlDb
      .select({ erasedAt: usersTable.accountErasedAt })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    if (user?.erasedAt) {
      if (!req.headers.authorization)
        clearSessionTokenCookie(res, {
          headers: { "x-forwarded-proto": req.headers["x-forwarded-proto"] },
          protocol: req.protocol,
          secure: req.secure,
        });
      // Login authenticates fresh credentials; logout must remain possible.
      if (["/auth/login", "/auth/candidate-login", "/auth/logout"].includes(req.path))
        return next();
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  } catch {
    res.status(503).json({ error: "Authentication temporarily unavailable" });
  }
}
