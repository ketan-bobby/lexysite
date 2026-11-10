import { Router } from "express";
import crypto from "node:crypto";
import { controlDb } from "@workspace/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { validate } from "../middlewares/validate";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { rateLimit } from "../middlewares/rateLimit";
import {
  activePilot,
  redeemPilot,
  endPilot,
  normalizePilotCode,
  PilotError,
} from "../lib/pilot-codes";

const router = Router();
const CodeInput = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9-]+$/),
  label: z.string().trim().min(1).max(120),
  maxRedemptions: z.number().int().min(1).max(10000),
});
const RedemptionInput = z.object({
  code: z.string().trim().min(3).max(64),
  tenantId: z.string().min(1).optional(),
});
function handleError(res: any, error: unknown) {
  const code = (error as any)?.cause?.code ?? (error as any)?.code;
  if (error instanceof PilotError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  if (code === "23505") {
    res.status(409).json({ error: "This pilot code already exists." });
    return;
  }
  if (code === "42P01") {
    res.status(503).json({
      error:
        "Pilot codes are not configured in this environment. Apply the pilot database migration first.",
    });
    return;
  }
  throw error;
}
router.get(
  "/pilot-codes/me",
  resolveUser,
  requireRole("tenant_admin", "platform_admin", "recruiter", "recruiter_admin"),
  async (req, res) => {
    const pilot = req.resolvedUser!.tenantId ? await activePilot(req.resolvedUser!.tenantId) : null;
    res.json({ pilot, complimentary: !!pilot });
  },
);
router.post(
  "/pilot-codes/redeem",
  resolveUser,
  requireRole("tenant_admin", "platform_admin"),
  rateLimit({ windowMs: 60000, max: 10, scope: "pilot-redeem" }),
  validate({ body: RedemptionInput }),
  async (req, res) => {
    const user = req.resolvedUser!;
    if (req.body.tenantId && user.role !== "platform_admin") {
      res.status(403).json({ error: "Only a platform admin can select another account." });
      return;
    }
    const tenantId = req.body.tenantId ?? user.tenantId;
    if (!tenantId) {
      res.status(400).json({ error: "Account required." });
      return;
    }
    try {
      await redeemPilot(req.body.code, tenantId, user.id);
      res.json({ pilot: await activePilot(tenantId) });
    } catch (error) {
      handleError(res, error);
    }
  },
);
router.get("/pilot-codes/admin", resolveUser, requireRole("platform_admin"), async (_req, res) => {
  const codes =
    await controlDb.execute(sql`SELECT id,code,label,max_redemptions AS "maxRedemptions",
    redemption_count AS "redemptionCount",disabled,created_at AS "createdAt" FROM pilot_codes ORDER BY created_at DESC`);
  const grants =
    await controlDb.execute(sql`SELECT g.id,g.tenant_id AS "tenantId",t.name AS "tenantName",
    c.code,c.label,g.created_at AS "createdAt",g.ended_at AS "endedAt"
    FROM tenant_pilot_grants g JOIN pilot_codes c ON c.id=g.code_id JOIN tenants t ON t.id=g.tenant_id
    ORDER BY g.created_at DESC`);
  res.json({ codes: codes.rows, grants: grants.rows });
});
router.post(
  "/pilot-codes/admin",
  resolveUser,
  requireRole("platform_admin"),
  validate({ body: CodeInput }),
  async (req, res) => {
    try {
      const id = crypto.randomUUID();
      await controlDb.execute(sql`INSERT INTO pilot_codes (id,code,label,max_redemptions,created_by)
      VALUES (${id},${normalizePilotCode(req.body.code)},${req.body.label},${req.body.maxRedemptions},${req.resolvedUser!.id})`);
      res.status(201).json({ id, code: normalizePilotCode(req.body.code) });
    } catch (error) {
      handleError(res, error);
    }
  },
);
router.post(
  "/pilot-codes/admin/:id/disable",
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const rows = await controlDb.execute(
      sql`UPDATE pilot_codes SET disabled=true WHERE id=${req.params.id} RETURNING id`,
    );
    if (!rows.rows.length) {
      res.status(404).json({ error: "Code not found." });
      return;
    }
    res.json({ ok: true });
  },
);
router.post(
  "/pilot-codes/admin/grants/:id/end",
  resolveUser,
  requireRole("platform_admin"),
  validate({ body: z.object({ confirm: z.literal(true) }) }),
  async (req, res) => {
    try {
      await endPilot(req.params.id as string, req.resolvedUser!.id);
      res.json({ ok: true });
    } catch (error) {
      handleError(res, error);
    }
  },
);
export default router;
