/**
 * routes/client-errors.ts — Browser-side error ingestion
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * POST /client-errors lets the frontend report a client-side failure (e.g. an
 * interview-recording upload that exhausted its retries) into the same
 * `system_errors` table the api-server uses for its own crashes, so platform
 * admins see browser failures on the existing System Errors dashboard with no
 * new UI. It is the client-side twin of lib/error-tracking.ts.
 *
 * ─── Auth ────────────────────────────────────────────────────────────────────
 * Mirrors the resolveCaller pattern of the sibling recording-upload routes in
 * routes/storage.ts: the caller must present a valid bearer token or httpOnly
 * session cookie (getAuthUserId handles both) that resolves to a real user
 * row. Anonymous reports are rejected — an open ingestion endpoint would be a
 * log-spam / disk-fill vector.
 *
 * ─── Rate limit ──────────────────────────────────────────────────────────────
 * 30 reports / minute / user. A real interview's worst case is a handful of
 * reports (exhausted-retries + fallback-failed + pointer-PATCH-failed + total
 * failure ≈ 4), so legitimate use never approaches the ceiling, while a
 * misbehaving client can't flood system_errors.
 *
 * ─── Tenant scoping ──────────────────────────────────────────────────────────
 * The handler never touches the RLS-proxied `db` — only controlDb (users
 * lookup) and captureError (dbAdmin insert into the non-RLS system_errors
 * table), so it works even when withTenantContext could not resolve a tenant
 * (e.g. a candidate reporting after their interview cookie was cleared).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { controlDb, usersTable } from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token";
import { captureError } from "../lib/error-tracking";
import { rateLimit } from "../middlewares/rateLimit";
import { validate } from "../middlewares/validate";

const router = Router();

const MAX_MESSAGE = 500;
const MAX_EXTRA_BYTES = 4 * 1024;

const ClientErrorBody = z.object({
  message: z.string().min(1).max(MAX_MESSAGE),
  context: z
    .object({
      sessionId: z.string().max(200).optional(),
      phase: z.string().max(100).optional(),
      extra: z.record(z.unknown()).optional(),
    })
    .optional(),
});

/** Clip the free-form extra bag so a hostile client can't stuff megabytes
 *  into a single system_errors row. */
function clipExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  try {
    const s = JSON.stringify(extra);
    if (s.length <= MAX_EXTRA_BYTES) return extra;
    return { clipped: true, preview: s.slice(0, MAX_EXTRA_BYTES) };
  } catch {
    return { unserializable: true };
  }
}

router.post(
  "/client-errors",
  /* keyFn: this route runs without resolveUser middleware, so the default
     `req.resolvedUser?.id || req.ip` key would degrade to per-IP — throttling
     unrelated users behind a shared NAT. Key by the authenticated user
     directly (falling back to IP for the pre-auth 401 path). */
  rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => getAuthUserId(req) ?? req.ip ?? "anon" }),
  validate({ body: ClientErrorBody }),
  async (req: Request, res: Response) => {
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    const [caller] = await controlDb
      .select({ id: usersTable.id, tenantId: usersTable.tenantId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!caller) return res.status(401).json({ error: "Authentication required" });

    const { message, context } = req.body as z.infer<typeof ClientErrorBody>;

    /* Fire-and-forget by contract (captureError never throws), but awaiting
       keeps the row visible to an immediately-following dashboard read and
       lets tests assert synchronously. */
    await captureError(new Error(`[client] ${message}`), {
      source: "manual",
      routePath: "client:report",
      tenantId: caller.tenantId ?? null,
      userId: caller.id,
      extra: {
        reportedFrom: "browser",
        sessionId: context?.sessionId,
        phase: context?.phase,
        ...clipExtra(context?.extra),
      },
    });

    return res.status(202).json({ ok: true });
  },
);

export default router;
