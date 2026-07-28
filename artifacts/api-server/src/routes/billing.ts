/**
 * routes/billing.ts — Stripe Billing Scaffolding
 *
 * Implements the minimal surface the in-app Subscription page needs to drive
 * checkout, the Stripe customer portal, and webhook ingestion. Stripe is
 * called via plain `fetch` — no SDK dependency required — so the file is safe
 * to ship even when STRIPE_SECRET_KEY is not yet configured (every route then
 * returns HTTP 503 with a clear "Billing not yet configured" message).
 *
 * ─── Routes ──────────────────────────────────────────────────────────────────
 *   POST /billing/checkout-session   → create Stripe Checkout for a plan upgrade
 *   POST /billing/portal-link        → return Stripe customer-portal URL
 *   GET  /billing/me/subscriptions   → caller's billing history
 *   POST /billing/webhook            → Stripe webhook receiver (signature verified)
 *
 * Required env (set via Replit Secrets when going live):
 *   STRIPE_SECRET_KEY           sk_live_… / sk_test_…
 *   STRIPE_WEBHOOK_SECRET       whsec_…
 *   STRIPE_PRICE_STARTER        price_…  (referenced by lib/plans.ts)
 *   STRIPE_PRICE_GROWTH         price_…
 *   STRIPE_PRICE_ENTERPRISE     price_…  (optional — usually invoiced manually)
 */
import crypto from "crypto";
import { Router, type IRouter, type Request } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import { tenantsTable, billingSubscriptionsTable, billingInvoicesTable, pendingTrialSignupsTable, usersTable, stripeProcessedEventsTable } from "@workspace/db";
import { desc, eq, and, isNull } from "drizzle-orm";
import { resolveUser } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { getPlan, getRegionalPrice, isRegion, type PlanCode, type Region } from "../lib/plans";
import { logger } from "../lib/logger";

const CheckoutSessionBody = z.object({
  planCode: z.string().min(1),
  successUrl: z.string().url().optional(),
  cancelUrl: z.string().url().optional(),
});

const PortalLinkBody = z.object({
  returnUrl: z.string().url().optional(),
});

/**
 * verifyStripeSignature — HMAC-SHA256 verification of the Stripe-Signature header.
 *
 * Stripe sends `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>...]`. We compute
 * HMAC-SHA256("<t>.<rawBody>", whSecret) and require a constant-time match
 * against any v1 value, AND require the timestamp be within 5 minutes (replay
 * defence). Returns false on any failure — the caller MUST 400 the request.
 */
function verifyStripeSignature(rawBody: Buffer | undefined, header: string | undefined, secret: string): boolean {
  if (!rawBody || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => { const [k, ...v] = p.split("="); return [k, v.join("=")]; }));
  const t = parts.t;
  if (!t) return false;
  // Replay window: 5 minutes
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const v1s = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (v1s.length === 0) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody.toString("utf8")}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  return v1s.some((v) => {
    const got = Buffer.from(v, "hex");
    return got.length === expectedBuf.length && crypto.timingSafeEqual(got, expectedBuf);
  });
}

const router: IRouter = Router();

const STRIPE_API = "https://api.stripe.com/v1";

function notConfigured(res: any) {
  res.status(503).json({
    error: "BILLING_NOT_CONFIGURED",
    message: "Stripe billing is not configured on this deployment yet. Set STRIPE_SECRET_KEY plus the price IDs to enable checkout.",
  });
}

/** Stripe is DORMANT by design (real billing = manual ACH + fee ledger).
 *  Presence of STRIPE_SECRET_KEY alone must NOT flip checkout on — the
 *  operator must also set STRIPE_ENABLE_ACK=true (see the dormancy sentinel
 *  in index.ts, which alarms hourly if the key is set without the ack). */
function stripeEnabled(): boolean {
  return (
    !!process.env.STRIPE_SECRET_KEY &&
    (process.env.STRIPE_ENABLE_ACK ?? "").toLowerCase() === "true"
  );
}

async function stripeCall(path: string, body?: Record<string, string>): Promise<any> {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY missing");
  const init: RequestInit = {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) init.body = new URLSearchParams(body).toString();
  const r = await fetch(`${STRIPE_API}${path}`, init);
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Stripe ${r.status}: ${j?.error?.message ?? r.statusText}`);
  return j;
}

async function ensureStripeCustomer(tenantId: string, email: string, name: string): Promise<string> {
  const [t] = await db.select({ stripeCustomerId: tenantsTable.stripeCustomerId }).from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  if (t?.stripeCustomerId) return t.stripeCustomerId;
  const created = await stripeCall("/customers", { email, name, "metadata[tenantId]": tenantId });
  await db.update(tenantsTable).set({ stripeCustomerId: created.id, updatedAt: new Date() }).where(eq(tenantsTable.id, tenantId));
  return created.id;
}

/* ── POST /billing/checkout-session ─────────────────────────────────────── */
router.post("/billing/checkout-session", validate({ body: CheckoutSessionBody }), resolveUser, async (req, res) => {
  if (!stripeEnabled()) return notConfigured(res);

  const user = req.resolvedUser!;
  if (user.role !== "tenant_admin" && user.role !== "platform_admin") {
    res.status(403).json({ error: "Only tenant admins can manage billing" }); return;
  }
  if (!user.tenantId) { res.status(400).json({ error: "User has no tenant" }); return; }

  const planCode = String(req.body?.planCode ?? "") as PlanCode;
  const plan = getPlan(planCode);
  if (plan.code === "demo" || plan.code === "enterprise") {
    res.status(400).json({ error: "Demo and Enterprise plans cannot be self-served via checkout. Contact sales." }); return;
  }

  try {
    const [tenant] = await controlDb.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
    if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

    // Resolve the price id from the tenant's region (with USD fallback inside
    // getRegionalPrice when the regional Stripe Price isn't configured yet).
    // This keeps checkout aligned with what the marketing pricing page shows.
    const tenantRegion = isRegion((tenant as any).region) ? ((tenant as any).region as Region) : "us";
    const regionalPrice = getRegionalPrice(plan, tenantRegion);
    // Honour tenant.billingTerm — sales sets it to 'annual' on contract
    // signing, and checkout then bills the annual Price ID for this region.
    //
    // FAIL-CLOSED: if billingTerm=annual but no annual Stripe Price is
    // configured (regional env OR US fallback env), refuse to start
    // checkout. Silently falling back to the monthly Price would charge
    // the customer the WRONG CADENCE — contradicting their signed contract
    // — and the operational fix (set the env) is trivial. Better to bounce
    // the request loudly than ship the wrong invoice cycle.
    const billingTerm = (tenant as any).billingTerm === "annual" ? "annual" : "monthly";
    const priceIdForCheckout = billingTerm === "annual"
      ? regionalPrice.stripePriceIdAnnual
      : regionalPrice.stripePriceId;
    if (!priceIdForCheckout) {
      const msg = billingTerm === "annual"
        ? `Annual Stripe price id for ${plan.name} (region: ${tenantRegion}) is not configured. Set STRIPE_PRICE_${plan.code.toUpperCase()}_ANNUAL (or the regional override) before initiating annual-cadence checkout.`
        : `Stripe price id for ${plan.name} not configured.`;
      logger.error(
        { tenantId: tenant.id, plan: plan.code, region: tenantRegion, billingTerm },
        "[billing/checkout-session] missing Stripe Price for requested billing term — refusing checkout",
      );
      res.status(503).json({ error: "PRICE_ID_MISSING", message: msg });
      return;
    }

    const customerId = await ensureStripeCustomer(tenant.id, tenant.contactEmail ?? user.email, tenant.name);

    const successUrl = String(req.body?.successUrl ?? `${req.protocol}://${req.get("host")}/subscription?status=success`);
    const cancelUrl  = String(req.body?.cancelUrl  ?? `${req.protocol}://${req.get("host")}/subscription?status=cancel`);
    const session = await stripeCall("/checkout/sessions", {
      mode: "subscription",
      customer: customerId,
      "line_items[0][price]": priceIdForCheckout,
      "line_items[0][quantity]": "1",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[tenantId]": tenant.id,
      "metadata[planCode]": plan.code,
      "metadata[region]": tenantRegion,
      "metadata[billingTerm]": billingTerm,
      "subscription_data[metadata][tenantId]": tenant.id,
      "subscription_data[metadata][planCode]": plan.code,
      "subscription_data[metadata][region]": tenantRegion,
      "subscription_data[metadata][billingTerm]": billingTerm,
    });
    res.json({ url: session.url, sessionId: session.id });
  } catch (err: any) {
    logger.error({ err }, "[billing/checkout-session] failed");
    res.status(502).json({ error: "STRIPE_FAILED", message: err.message });
  }
});

/* ── POST /billing/portal-link ──────────────────────────────────────────── */
router.post("/billing/portal-link", validate({ body: PortalLinkBody }), resolveUser, async (req, res) => {
  if (!stripeEnabled()) return notConfigured(res);
  const user = req.resolvedUser!;
  if (!user.tenantId) { res.status(400).json({ error: "User has no tenant" }); return; }
  try {
    const [tenant] = await controlDb.select().from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
    if (!tenant?.stripeCustomerId) { res.status(400).json({ error: "No Stripe customer for this tenant yet — start a checkout first." }); return; }
    const session = await stripeCall("/billing_portal/sessions", {
      customer: tenant.stripeCustomerId,
      return_url: String(req.body?.returnUrl ?? `${req.protocol}://${req.get("host")}/subscription`),
    });
    res.json({ url: session.url });
  } catch (err: any) {
    logger.error({ err }, "[billing/portal-link] failed");
    res.status(502).json({ error: "STRIPE_FAILED", message: err.message });
  }
});

/* ── GET /billing/me/subscriptions ──────────────────────────────────────── */
router.get("/billing/me/subscriptions", resolveUser, async (req, res) => {
  const user = req.resolvedUser!;
  if (!user.tenantId) { res.status(400).json({ error: "User has no tenant" }); return; }
  const subs = await db.select().from(billingSubscriptionsTable).where(eq(billingSubscriptionsTable.tenantId, user.tenantId)).orderBy(desc(billingSubscriptionsTable.createdAt));
  const invoices = await db.select().from(billingInvoicesTable).where(eq(billingInvoicesTable.tenantId, user.tenantId)).orderBy(desc(billingInvoicesTable.createdAt)).limit(50);
  // Manual-billing read-out: surface plan + paidThroughAt so the subscription
  // page can render "Paid through 2026-12-31 — managed by your account team"
  // without needing a separate endpoint. billing_notes is platform_admin-only
  // and is deliberately NOT included here.
  const [t] = await controlDb.select({
    plan: tenantsTable.plan,
    status: tenantsTable.status,
    billingTerm: tenantsTable.billingTerm,
    paidThroughAt: tenantsTable.paidThroughAt,
    planActivatedAt: tenantsTable.planActivatedAt,
  }).from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
  const manualBilling = t ? {
    plan: t.plan,
    status: t.status,
    billingTerm: t.billingTerm,
    paidThroughAt: t.paidThroughAt ? new Date(t.paidThroughAt).toISOString() : null,
    planActivatedAt: t.planActivatedAt ? new Date(t.planActivatedAt).toISOString() : null,
  } : null;
  res.json({ subscriptions: subs, invoices, manualBilling });
});

/* ── POST /billing/webhook ───────────────────────────────────────────────
 * Handles checkout.session.completed, customer.subscription.{created,updated,
 * deleted}, and invoice.payment_succeeded. The Stripe Dashboard is configured
 * to POST to https://www.l3xy.ai/api/billing/webhook. Signature verification
 * requires the *raw* body — app.ts mounts express.raw on this path BEFORE
 * express.json() runs, and exposes the raw bytes as req.rawBody.
 */
const stripeWebhookHandler = async (req: Request, res: any) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) { res.status(503).json({ error: "Webhook secret not configured" }); return; }

  // Strict signature verification — see verifyStripeSignature above. The raw
  // request bytes are exposed by app.ts via the express.raw mount on this path.
  const rawBody: Buffer | undefined = (req as any).rawBody;
  const sig = req.header("stripe-signature") ?? undefined;
  if (!verifyStripeSignature(rawBody, sig, secret)) {
    logger.warn({ ip: req.ip }, "[billing/webhook] signature verification failed — rejecting");
    res.status(400).json({ error: "INVALID_SIGNATURE" });
    return;
  }

  const event = req.body;
  if (!event?.type || !event?.id) { res.status(400).json({ error: "Invalid event" }); return; }

  /* ── Two-phase exact-once webhook ledger (T011 + T011n hardening) ─────────
   * The original single-phase design (INSERT-or-200) had a fatal hole:
   * if the handler threw AFTER the ledger row was committed, the next
   * Stripe retry would see the duplicate id and 200 short-circuit
   * without ever re-running the side effects. Billing events would be
   * silently dropped.
   *
   * Two-phase fix (Migration 0018 added the processed_at column):
   *
   *   1. CLAIM. INSERT with processed_at=NULL. On conflict:
   *        - If the existing row has processed_at IS NOT NULL → genuine
   *          duplicate, 200 short-circuit.
   *        - If the existing row has processed_at IS NULL → previous
   *          attempt crashed mid-handler. Reclaim it by stamping a
   *          fresh claimed_at and let this delivery re-run the handler.
   *   2. HANDLE. Run side effects inside the try below.
   *   3. FINALIZE. On success, UPDATE processed_at=now(). On any
   *      exception, DELETE the row so the next Stripe retry can
   *      re-claim. Either branch returns the correct HTTP status so
   *      Stripe's retry policy does the right thing.
   *
   * Stripe retries with exponential backoff for 5xx and most non-2xx;
   * a 200 is treated as "stop retrying". This file's contract with
   * Stripe is: ALL 2xx responses imply the side effects committed. */
  const payloadDigest = rawBody ? crypto.createHash("sha256").update(rawBody).digest("hex") : null;
  try {
    const inserted = await db
      .insert(stripeProcessedEventsTable)
      .values({
        eventId: event.id,
        eventType: event.type,
        livemode: event.livemode ?? null,
        apiVersion: event.api_version ?? null,
        payloadDigest,
        payload: event as Record<string, unknown>,
        /* processedAt left null on purpose — gets stamped in step 3. */
      })
      .onConflictDoNothing({ target: stripeProcessedEventsTable.eventId })
      .returning({ eventId: stripeProcessedEventsTable.eventId });

    if (inserted.length === 0) {
      /* Conflict path — look up the existing row to distinguish a real
       * duplicate (processed_at set) from a stranded claim. */
      const [existing] = await db
        .select({
          eventId: stripeProcessedEventsTable.eventId,
          processedAt: stripeProcessedEventsTable.processedAt,
        })
        .from(stripeProcessedEventsTable)
        .where(eq(stripeProcessedEventsTable.eventId, event.id))
        .limit(1);
      if (existing?.processedAt) {
        logger.info({ eventId: event.id, eventType: event.type }, "[billing/webhook] duplicate event, already processed — ignoring");
        res.json({ received: true, duplicate: true });
        return;
      }
      /* Stranded claim (prior handler crashed). Re-stamp claimed_at
       * and fall through to re-process. We deliberately do NOT
       * atomic-CAS here — at-least-once delivery is acceptable for
       * webhook handlers that already use per-tenant upserts and
       * per-table unique constraints downstream (see the
       * checkout.session.completed branch's ALREADY_CLAIMED logic). */
      await db
        .update(stripeProcessedEventsTable)
        .set({ claimedAt: new Date() })
        .where(eq(stripeProcessedEventsTable.eventId, event.id));
      logger.warn({ eventId: event.id, eventType: event.type }, "[billing/webhook] reclaiming stranded ledger row — prior handler crashed");
    }
  } catch (err: any) {
    logger.error({ err: err?.message, eventId: event.id }, "[billing/webhook] idempotency ledger claim failed — letting Stripe retry");
    res.status(500).json({ error: "IDEMPOTENCY_LEDGER_FAILED" });
    return;
  }

  try {
    const obj = event.data?.object ?? {};
    switch (event.type) {
      case "checkout.session.completed":
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        // Self-serve signup branch — when the checkout was initiated by an
        // unauthenticated prospect via /api/public/signup-checkout we have a
        // pendingSignupId in metadata but no tenant yet. Provision tenant +
        // tenant_admin user + login token here. Idempotent: if the pending
        // row already has a createdTenantId we skip silently.
        const pendingSignupId = obj.metadata?.pendingSignupId ?? obj.subscription_details?.metadata?.pendingSignupId;
        if (pendingSignupId) {
          // Atomic claim: only one webhook delivery (Stripe retries + duplicate
          // events for checkout.session.completed + customer.subscription.created)
          // wins the race to provision. Rows that have already been claimed
          // (createdTenantId IS NOT NULL) return zero rows and we no-op.
          const claimedAt = new Date();
          const provisionalSlugSeed = Math.random().toString(36).slice(2, 8);
          const [pending] = await db.select().from(pendingTrialSignupsTable).where(eq(pendingTrialSignupsTable.id, pendingSignupId)).limit(1);
          if (!pending) {
            logger.warn({ pendingSignupId }, "[billing/webhook] self-serve: pending row not found");
            break;
          }
          if (pending.createdTenantId) {
            logger.info({ pendingSignupId, tenantId: pending.createdTenantId }, "[billing/webhook] self-serve: already provisioned, ignoring");
            break;
          }

          const baseSlug = pending.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "tenant";
          const planForTenant = (pending.planCode ?? obj.metadata?.planCode ?? "starter") as PlanCode;
          const loginToken = crypto.randomBytes(32).toString("base64url");
          const loginTokenExpiresAt = new Date(Date.now() + 5 * 60 * 1000);

          // Provision inside a transaction. Errors propagate so the outer
          // try/catch returns 500 → Stripe retries with backoff. Slug uniqueness
          // is retried on conflict (up to 5 attempts).
          let attempt = 0;
          let provisionedTenantId: string | null = null;
          let lastErr: any = null;
          while (attempt < 5 && !provisionedTenantId) {
            attempt++;
            const slug = attempt === 1
              ? `${baseSlug}-${provisionalSlugSeed}`
              : `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`;
            try {
              await db.transaction(async (tx) => {
                // Atomic claim of the pending row — only the first concurrent
                // webhook to execute this UPDATE wins. Subsequent ones see 0
                // rows and abort the transaction without side effects.
                const claimRows = await tx.update(pendingTrialSignupsTable)
                  .set({ consumedAt: claimedAt })
                  .where(and(
                    eq(pendingTrialSignupsTable.id, pending.id),
                    isNull(pendingTrialSignupsTable.createdTenantId),
                  ))
                  .returning({ id: pendingTrialSignupsTable.id });
                if (claimRows.length === 0) {
                  // Another webhook delivery already claimed this signup.
                  // Throw a sentinel so the outer code logs and bails (200 OK,
                  // no retry needed — this is the desired idempotent behaviour).
                  throw new Error("ALREADY_CLAIMED");
                }

                // Anti-arbitrage telemetry: log when the customer's billing
                // country (collected at checkout) doesn't match the region
                // they selected on the pricing page. We're permissive on
                // purpose — many legitimate signups (travelling founders,
                // holding companies, agencies) have mismatched billing vs
                // operating regions, and Stripe Tax already applies the
                // correct tax to the *billing* address regardless.
                //
                // Only the `checkout.session.completed` event reliably
                // populates `customer_details.address.country`. The
                // `customer.subscription.created` event for the same signup
                // doesn't carry it, so checking there would silently miss
                // mismatches — we explicitly skip the check on that path
                // so the billing-team telemetry isn't biased by event order.
                const isCheckoutSessionEvent = obj.object === "checkout.session";
                const billingCountry = obj.customer_details?.address?.country ?? null;
                const expectedRegion = pending.region ?? "us";
                if (isCheckoutSessionEvent && billingCountry && expectedRegion === "in" && billingCountry !== "IN") {
                  logger.warn(
                    { pendingSignupId, expectedRegion, billingCountry, email: pending.email },
                    "[billing/webhook] regional pricing mismatch — IN price selected, non-IN billing country"
                  );
                }

                const [t] = await tx.insert(tenantsTable).values({
                  name: pending.company,
                  slug,
                  plan: planForTenant,
                  status: "active",
                  clientType: "direct",
                  contactEmail: pending.email,
                  stripeCustomerId: pending.stripeCustomerId ?? obj.customer ?? null,
                  planActivatedAt: new Date(),
                  region: pending.region ?? "us",
                }).returning();
                await tx.insert(usersTable).values({
                  tenantId: t.id,
                  email: pending.email,
                  name: pending.name,
                  role: "tenant_admin",
                  passwordHash: pending.passwordHash ?? "demo_hash",
                });
                await tx.update(pendingTrialSignupsTable).set({
                  createdTenantId: t.id,
                  loginToken,
                  loginTokenExpiresAt,
                }).where(eq(pendingTrialSignupsTable.id, pending.id));
                const subId = obj.subscription ?? obj.id;
                const status = obj.status ?? "trialing";
                const priceId = obj.items?.data?.[0]?.price?.id ?? "unknown";
                await tx.insert(billingSubscriptionsTable).values({
                  tenantId: t.id,
                  stripeSubscriptionId: subId,
                  stripePriceId: priceId,
                  planCode: planForTenant,
                  status: status as any,
                  currentPeriodStart: obj.current_period_start ? new Date(obj.current_period_start * 1000) : null,
                  currentPeriodEnd:   obj.current_period_end   ? new Date(obj.current_period_end * 1000)   : null,
                }).onConflictDoNothing();
                provisionedTenantId = t.id;
              });
            } catch (err: any) {
              if (err?.message === "ALREADY_CLAIMED") {
                logger.info({ pendingSignupId }, "[billing/webhook] self-serve: lost race to concurrent delivery, ok");
                lastErr = null;
                provisionedTenantId = "skipped";
                break;
              }
              // Likely slug uniqueness collision — retry with a fresh seed.
              const isUniqueViolation = /unique|duplicate key/i.test(String(err?.message ?? ""));
              lastErr = err;
              if (!isUniqueViolation) break;
              logger.warn({ err: err?.message, attempt, pendingSignupId }, "[billing/webhook] self-serve: retrying after collision");
            }
          }

          if (!provisionedTenantId) {
            // Critical: failed to provision. Throw so the outer handler returns
            // 500 and Stripe retries delivery with exponential backoff. Do NOT
            // swallow — a paid customer would otherwise be stranded.
            logger.error({ err: lastErr?.message, pendingSignupId }, "[billing/webhook] self-serve provisioning failed after retries");
            throw lastErr ?? new Error("Provisioning failed");
          }
          if (provisionedTenantId !== "skipped") {
            logger.info({ pendingSignupId, plan: planForTenant }, "[billing/webhook] self-serve tenant provisioned");
          }
          break;
        }

        const tenantId = obj.metadata?.tenantId;
        const planCode = obj.metadata?.planCode;
        if (tenantId) {
          const subId = obj.subscription ?? obj.id;
          const status = obj.status ?? "active";
          const priceId = obj.items?.data?.[0]?.price?.id ?? "unknown";
          await db.insert(billingSubscriptionsTable).values({
            tenantId,
            stripeSubscriptionId: subId,
            stripePriceId: priceId,
            planCode: planCode ?? "starter",
            status: status as any,
            currentPeriodStart: obj.current_period_start ? new Date(obj.current_period_start * 1000) : null,
            currentPeriodEnd:   obj.current_period_end   ? new Date(obj.current_period_end * 1000)   : null,
          }).onConflictDoNothing();
          if (planCode) {
            await db.update(tenantsTable).set({
              plan: planCode as any,
              status: "active",
              planActivatedAt: new Date(),
              updatedAt: new Date(),
            }).where(eq(tenantsTable.id, tenantId));
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const tenantId = obj.metadata?.tenantId;
        if (tenantId) {
          await db.update(billingSubscriptionsTable).set({ status: "canceled", updatedAt: new Date() }).where(eq(billingSubscriptionsTable.stripeSubscriptionId, obj.id));
        }
        break;
      }
      case "invoice.payment_succeeded":
      case "invoice.finalized": {
        const tenantId = obj.metadata?.tenantId ?? obj.subscription_details?.metadata?.tenantId;
        if (tenantId) {
          await db.insert(billingInvoicesTable).values({
            tenantId,
            stripeInvoiceId: obj.id,
            amountDueCents:  obj.amount_due ?? 0,
            amountPaidCents: obj.amount_paid ?? 0,
            currency: obj.currency ?? "usd",
            status: (obj.status ?? "open") as any,
            hostedInvoiceUrl: obj.hosted_invoice_url,
            invoicePdfUrl: obj.invoice_pdf,
            finalizedAt: obj.status_transitions?.finalized_at ? new Date(obj.status_transitions.finalized_at * 1000) : null,
          }).onConflictDoNothing();
        }
        break;
      }
      default:
        logger.info({ type: event.type }, "[billing/webhook] unhandled event type");
    }
    /* FINALIZE: side effects committed → stamp the ledger so future
     * deliveries 200 short-circuit. If this stamp itself fails, the
     * row stays with processed_at=NULL — the next retry will reclaim
     * the stranded row and the handler's downstream upserts will
     * dedupe via their own unique constraints. Stripe still gets a
     * 200 because the work is done. */
    try {
      await db
        .update(stripeProcessedEventsTable)
        .set({ processedAt: new Date() })
        .where(eq(stripeProcessedEventsTable.eventId, event.id));
    } catch (stampErr: any) {
      logger.error({ err: stampErr?.message, eventId: event.id }, "[billing/webhook] processed_at stamp failed (handler already committed)");
    }
    res.json({ received: true });
  } catch (err: any) {
    logger.error({ err, eventType: event.type, eventId: event.id }, "[billing/webhook] handler failed — releasing ledger claim so Stripe retry can re-process");
    /* Release the claim so the next Stripe retry isn't blocked by our
     * own ledger row. We must NOT 200 here — Stripe needs a 5xx to
     * trigger its retry policy. */
    try {
      await db
        .delete(stripeProcessedEventsTable)
        .where(and(
          eq(stripeProcessedEventsTable.eventId, event.id),
          isNull(stripeProcessedEventsTable.processedAt),
        ));
    } catch (releaseErr: any) {
      logger.error({ err: releaseErr?.message, eventId: event.id }, "[billing/webhook] failed to release stranded ledger claim — watchdog will reap");
    }
    res.status(500).json({ error: "WEBHOOK_HANDLER_FAILED", message: err.message });
  }
};

router.post("/billing/webhook", stripeWebhookHandler);

export default router;
