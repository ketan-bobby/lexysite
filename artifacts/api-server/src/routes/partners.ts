/**
 * routes/partners.ts — Partner Program (Rev-Share Affiliates)
 *
 * Platform-admin-only CRUD on the partner program plus payout calculation
 * helpers. Tenant attribution can be set either at provisioning time
 * (POST /tenants … "partnerId") or by an admin via PATCH /partners/:id/attribute.
 *
 * Rev-share math + the 35% net-margin floor live in lib/partner-payouts.ts so
 * they're testable in isolation.
 *
 * ─── Routes ──────────────────────────────────────────────────────────────────
 *   GET    /partners                       List all partners (admin)
 *   POST   /partners                       Create partner (admin)
 *   GET    /partners/:id                   Detail + attributed tenants
 *   PATCH  /partners/:id                   Update (status, rev-share, etc.)
 *   POST   /partners/:id/attribute         Attribute a tenant to this partner
 *   POST   /partners/:id/payouts/calculate Run payout calculation for a month
 *   GET    /partners/:id/payouts           List payouts
 *   PATCH  /partners/payouts/:payoutId     Approve/mark-paid/cancel a payout
 *   GET    /partners/config                Read-only payout-config snapshot
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  partnersTable,
  partnerAttributionEventsTable,
  partnerPayoutsTable,
  tenantsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { resolveUser } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { calculatePartnerPayout, PARTNER_PAYOUT_CONFIG, type Region } from "../lib/partner-payouts";

const router: IRouter = Router();

const PartnerCreateBody = z.object({
  name: z.string().min(1),
  contactEmail: z.string().email(),
  companyName: z.string().optional().nullable(),
  region: z.string().optional(),
  revSharePct: z.union([z.number(), z.string()]).optional(),
  notes: z.string().optional().nullable(),
});

const PartnerUpdateBody = z.object({
  status: z.string().optional(),
  revSharePct: z.union([z.number(), z.string()]).optional(),
  region: z.string().optional(),
  notes: z.string().optional().nullable(),
  payoutMethod: z.string().optional().nullable(),
  approvedAt: z.union([z.string(), z.date()]).optional(),
}).passthrough();

const PartnerAttributeBody = z.object({
  tenantId: z.string().min(1),
});

const PartnerPayoutCalculateBody = z.object({
  periodMonth: z.string().optional(),
  attributedRevenueCents: z.number().optional(),
}).passthrough();

const PartnerPayoutUpdateBody = z.object({
  status: z.string().optional(),
  notes: z.string().optional().nullable(),
  paidAt: z.union([z.string(), z.date()]).optional(),
}).passthrough();

function requirePlatformAdmin(req: any, res: any): boolean {
  if (req.resolvedUser?.role !== "platform_admin") {
    res.status(403).json({ error: "Forbidden — platform_admin only" });
    return false;
  }
  return true;
}

router.get("/partners/config", resolveUser, (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  res.json(PARTNER_PAYOUT_CONFIG);
});

router.get("/partners", resolveUser, async (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  const rows = await db.select().from(partnersTable).orderBy(desc(partnersTable.createdAt));
  res.json({ partners: rows });
});

router.post("/partners", validate({ body: PartnerCreateBody }), resolveUser, async (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  const { name, contactEmail, companyName, region, revSharePct, notes } = req.body ?? {};
  if (!name || !contactEmail) { res.status(400).json({ error: "name and contactEmail are required" }); return; }
  try {
    const [row] = await db.insert(partnersTable).values({
      name,
      contactEmail,
      companyName,
      region: (region ?? "us") as any,
      revSharePct: String(revSharePct ?? 20),
      notes,
    }).returning();
    res.status(201).json(row);
  } catch (err: any) {
    if (String(err.message ?? "").toLowerCase().includes("unique")) {
      res.status(409).json({ error: "EMAIL_ALREADY_REGISTERED" }); return;
    }
    res.status(500).json({ error: "CREATE_FAILED", message: err.message });
  }
});

router.get("/partners/:id", resolveUser, async (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  const [partner] = await db.select().from(partnersTable).where(eq(partnersTable.id, String(req.params.id))).limit(1);
  if (!partner) { res.status(404).json({ error: "Not found" }); return; }
  const attributions = await db.select().from(partnerAttributionEventsTable).where(eq(partnerAttributionEventsTable.partnerId, partner.id)).orderBy(desc(partnerAttributionEventsTable.attributedAt));
  res.json({ partner, attributions });
});

router.patch("/partners/:id", validate({ body: PartnerUpdateBody }), resolveUser, async (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  const update: any = { updatedAt: new Date() };
  if (req.body?.status)        update.status = req.body.status;
  if (req.body?.revSharePct !== undefined) update.revSharePct = String(req.body.revSharePct);
  if (req.body?.region)        update.region = req.body.region;
  if (req.body?.notes !== undefined) update.notes = req.body.notes;
  if (req.body?.payoutMethod !== undefined) update.payoutMethod = req.body.payoutMethod;
  if (req.body?.status === "active" && !req.body?.approvedAt) update.approvedAt = new Date();
  const [row] = await db.update(partnersTable).set(update).where(eq(partnersTable.id, String(req.params.id))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

router.post("/partners/:id/attribute", validate({ body: PartnerAttributeBody }), resolveUser, async (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  const { tenantId } = req.body ?? {};
  if (!tenantId) { res.status(400).json({ error: "tenantId required" }); return; }
  const [partner] = await db.select().from(partnersTable).where(eq(partnersTable.id, String(req.params.id))).limit(1);
  if (!partner) { res.status(404).json({ error: "Partner not found" }); return; }

  await db.insert(partnerAttributionEventsTable).values({
    partnerId: partner.id,
    tenantId,
    revSharePctAtAttribution: partner.revSharePct,
  });
  await db.update(tenantsTable).set({ partnerId: partner.id, updatedAt: new Date() }).where(eq(tenantsTable.id, String(tenantId)));
  res.status(201).json({ ok: true });
});

router.post("/partners/:id/payouts/calculate", validate({ body: PartnerPayoutCalculateBody }), resolveUser, async (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  const periodMonth = String(req.body?.periodMonth ?? new Date().toISOString().slice(0, 7));
  const attributedRevenueCents = Number(req.body?.attributedRevenueCents ?? 0);
  // Idempotency + sanity guards — financial endpoint, fail loudly:
  //   • period must look like YYYY-MM (cheap regex catches typos)
  //   • revenue must be a positive integer (no negatives, no fractional cents)
  //   • a payout for (partner, period) cannot be re-created — must be edited via PATCH
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodMonth)) { res.status(400).json({ error: "periodMonth must be YYYY-MM" }); return; }
  if (!Number.isInteger(attributedRevenueCents) || attributedRevenueCents <= 0) {
    res.status(400).json({ error: "attributedRevenueCents must be a positive integer (cents)" }); return;
  }

  const [partner] = await db.select().from(partnersTable).where(eq(partnersTable.id, String(req.params.id))).limit(1);
  if (!partner) { res.status(404).json({ error: "Not found" }); return; }

  const [existing] = await db.select().from(partnerPayoutsTable).where(and(
    eq(partnerPayoutsTable.partnerId, partner.id),
    eq(partnerPayoutsTable.periodMonth, periodMonth),
  )).limit(1);
  if (existing) {
    res.status(409).json({ error: "PAYOUT_EXISTS", message: `A payout already exists for ${partner.name} / ${periodMonth}. Edit it via PATCH /partners/payouts/${existing.id}.`, payout: existing });
    return;
  }

  const calc = calculatePartnerPayout({
    attributedRevenueCents,
    negotiatedRevSharePct: Number(partner.revSharePct),
    region: partner.region as Region,
  });

  const [row] = await db.insert(partnerPayoutsTable).values({
    partnerId: partner.id,
    periodMonth,
    attributedRevenueCents: calc.attributedRevenueCents,
    rawPayoutCents: calc.rawPayoutCents,
    payoutCents: calc.payoutCents,
    marginFloorApplied: calc.marginFloorApplied,
  }).returning();
  res.status(201).json({ payout: row, calc });
});

router.get("/partners/:id/payouts", resolveUser, async (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  const rows = await db.select().from(partnerPayoutsTable).where(eq(partnerPayoutsTable.partnerId, String(req.params.id))).orderBy(desc(partnerPayoutsTable.createdAt));
  res.json({ payouts: rows });
});

router.patch("/partners/payouts/:payoutId", validate({ body: PartnerPayoutUpdateBody }), resolveUser, async (req, res) => {
  if (!requirePlatformAdmin(req, res)) return;
  const update: any = {};
  if (req.body?.status) update.status = req.body.status;
  if (req.body?.notes !== undefined) update.notes = req.body.notes;
  if (req.body?.status === "paid" && !req.body?.paidAt) update.paidAt = new Date();
  const [row] = await db.update(partnerPayoutsTable).set(update).where(eq(partnerPayoutsTable.id, String(req.params.payoutId))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(row);
});

export default router;
