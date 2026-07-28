/**
 * routes/subscription-prices.ts — Country Pricing Catalog (platform_admin) + Pricing Read
 *
 * The admin-editable override layer for country-level subscription PRICE
 * DISPLAY. Tier entitlements (seats / caps / features) stay global in
 * lib/plans.ts — only the displayed price varies per country.
 *
 *   CATALOG CRUD (platform_admin only):
 *     GET    /subscription-prices            — list (optional ?country / ?planCode)
 *     POST   /subscription-prices            — create a (country, plan, term) row
 *     PATCH  /subscription-prices/:id        — edit amounts / currency / tax / active
 *     DELETE /subscription-prices/:id        — remove an override (falls back to rate-card)
 *
 *   PRICING READ (any authenticated user):
 *     GET    /pricing?country=XX&plan=..&term=..  — resolved price + VAT note for the UI
 *     GET    /pricing/matrix?country=XX           — all plans × terms resolved for a country
 *
 * No in-system payment processing — this is display + record-keeping only.
 * Amounts are stored in MAJOR currency units (799 = $799). -1 = "contact us".
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, subscriptionPricesTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { logger } from "../lib/logger";
import {
  getCountryPrice,
  type BillingTerm,
  type PlanCode,
} from "../lib/plans";

const router: IRouter = Router();

const PRICED_PLANS = ["starter", "growth", "enterprise"] as const;
const TERMS = ["monthly", "quarterly", "annual"] as const;

/* ── GET /subscription-prices ─────────────────────────────────────────────
 * List catalog rows. platform_admin only. Optional ?country / ?planCode. */
router.get("/subscription-prices",
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const country = typeof req.query.country === "string" ? req.query.country.toUpperCase() : undefined;
    const planCode = typeof req.query.planCode === "string" ? req.query.planCode : undefined;

    const conds = [];
    if (country) conds.push(eq(subscriptionPricesTable.country, country));
    if (planCode) conds.push(eq(subscriptionPricesTable.planCode, planCode));

    const rows = await db
      .select()
      .from(subscriptionPricesTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(
        asc(subscriptionPricesTable.country),
        asc(subscriptionPricesTable.planCode),
        asc(subscriptionPricesTable.billingTerm),
      );

    res.json({ prices: rows });
  });

/* ── POST /subscription-prices ────────────────────────────────────────────
 * Create a catalog override row. Unique on (country, planCode, billingTerm). */
const CreatePriceBody = z.object({
  country: z.string().length(2),
  planCode: z.enum(PRICED_PLANS),
  billingTerm: z.enum(TERMS),
  currency: z.string().min(1).max(8),
  symbol: z.string().min(1).max(8).optional(),
  amount: z.number().int(),
  perSeatAmount: z.number().int().min(0).optional(),
  perHireAmount: z.number().int().min(0).optional(),
  taxNote: z.string().max(300).optional(),
  active: z.boolean().optional(),
});
router.post("/subscription-prices",
  validate({ body: CreatePriceBody }),
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const body = req.body as z.infer<typeof CreatePriceBody>;
    try {
      const [row] = await db.insert(subscriptionPricesTable).values({
        country: body.country.toUpperCase(),
        planCode: body.planCode,
        billingTerm: body.billingTerm,
        currency: body.currency.toUpperCase(),
        symbol: body.symbol ?? "$",
        amount: body.amount,
        perSeatAmount: body.perSeatAmount ?? 0,
        perHireAmount: body.perHireAmount ?? 0,
        ...(body.taxNote !== undefined ? { taxNote: body.taxNote } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      }).returning();

      logger.info({ actorId: req.resolvedUser!.id, priceId: row.id, country: row.country, planCode: row.planCode, billingTerm: row.billingTerm }, "[pricing] catalog row created");
      res.status(201).json(row);
    } catch (err: any) {
      if (String(err?.code) === "23505") {
        res.status(409).json({
          error: "PRICE_EXISTS",
          message: `A price for ${body.country.toUpperCase()} / ${body.planCode} / ${body.billingTerm} already exists. Edit it instead.`,
        });
        return;
      }
      throw err;
    }
  });

/* ── PATCH /subscription-prices/:id ───────────────────────────────────────
 * Edit an existing override row. (country/plan/term are immutable — delete and
 * recreate to re-key, so the unique index stays meaningful.) */
const UpdatePriceBody = z.object({
  currency: z.string().min(1).max(8).optional(),
  symbol: z.string().min(1).max(8).optional(),
  amount: z.number().int().optional(),
  perSeatAmount: z.number().int().min(0).optional(),
  perHireAmount: z.number().int().min(0).optional(),
  taxNote: z.string().max(300).optional(),
  active: z.boolean().optional(),
});
router.patch("/subscription-prices/:id",
  validate({ body: UpdatePriceBody }),
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const body = req.body as z.infer<typeof UpdatePriceBody>;
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.currency !== undefined)      update.currency = body.currency.toUpperCase();
    if (body.symbol !== undefined)        update.symbol = body.symbol;
    if (body.amount !== undefined)        update.amount = body.amount;
    if (body.perSeatAmount !== undefined) update.perSeatAmount = body.perSeatAmount;
    if (body.perHireAmount !== undefined) update.perHireAmount = body.perHireAmount;
    if (body.taxNote !== undefined)       update.taxNote = body.taxNote;
    if (body.active !== undefined)        update.active = body.active;

    const [row] = await db.update(subscriptionPricesTable)
      .set(update)
      .where(eq(subscriptionPricesTable.id, req.params.id))
      .returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }

    logger.info({ actorId: req.resolvedUser!.id, priceId: row.id, changed: Object.keys(update).filter(k => k !== "updatedAt") }, "[pricing] catalog row updated");
    res.json(row);
  });

/* ── DELETE /subscription-prices/:id ──────────────────────────────────────
 * Remove an override. The resolver then falls back to the code rate-card. */
router.delete("/subscription-prices/:id",
  resolveUser,
  requireRole("platform_admin"),
  async (req, res) => {
    const [row] = await db.delete(subscriptionPricesTable)
      .where(eq(subscriptionPricesTable.id, req.params.id))
      .returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    logger.info({ actorId: req.resolvedUser!.id, priceId: row.id }, "[pricing] catalog row deleted");
    res.json({ ok: true });
  });

/* ── GET /pricing ─────────────────────────────────────────────────────────
 * Resolve the displayed price for a (country, plan, term): DB override → code
 * rate-card fallback. Any authenticated user (UI display). */
router.get("/pricing",
  resolveUser,
  async (req, res) => {
    const country = typeof req.query.country === "string" ? req.query.country : "US";
    const planRaw = typeof req.query.plan === "string" ? req.query.plan : "starter";
    const termRaw = typeof req.query.term === "string" ? req.query.term : "monthly";

    if (!(PRICED_PLANS as readonly string[]).includes(planRaw) && planRaw !== "demo") {
      res.status(400).json({ error: "INVALID_PLAN", message: `plan must be one of: demo, ${PRICED_PLANS.join(", ")}` });
      return;
    }
    if (!(TERMS as readonly string[]).includes(termRaw)) {
      res.status(400).json({ error: "INVALID_TERM", message: `term must be one of: ${TERMS.join(", ")}` });
      return;
    }

    const price = await getCountryPrice(country, planRaw as PlanCode, termRaw as BillingTerm);
    res.json(price);
  });

/* ── GET /pricing/matrix ──────────────────────────────────────────────────
 * Resolve every priced plan × term for a country in one call (UI table). */
router.get("/pricing/matrix",
  resolveUser,
  async (req, res) => {
    const country = typeof req.query.country === "string" ? req.query.country : "US";
    const matrix = await Promise.all(
      PRICED_PLANS.flatMap((plan) =>
        TERMS.map((term) => getCountryPrice(country, plan as PlanCode, term as BillingTerm)),
      ),
    );
    res.json({ country: country.toUpperCase(), prices: matrix });
  });

export default router;
