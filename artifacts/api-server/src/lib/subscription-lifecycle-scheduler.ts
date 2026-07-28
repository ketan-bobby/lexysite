/**
 * subscription-lifecycle-scheduler.ts — Country Subscription Lifecycle + Renewal Alerts
 *
 * Runs daily. Lexy collects payment OUTSIDE the platform (ACH today), so the
 * only billing state the app owns is `paid_through_at` (extended via the
 * one-click record-payment action). This scheduler turns that date into an
 * automatic lifecycle and keeps the platform-admin team informed:
 *
 *   1. STATUS TRANSITIONS (guarded, idempotent):
 *        active     while now ≤ paid_through_at
 *        past_due   while paid_through_at < now ≤ paid_through_at + GRACE_DAYS
 *        suspended  once now > paid_through_at + GRACE_DAYS  (hard-blocked)
 *      A future paid_through_at also RECOVERS a past_due/suspended tenant back
 *      to active (safety net — record-payment already does this synchronously).
 *      `trial` tenants are left alone (the trial-expiry-scheduler owns them).
 *
 *   2. NOTIFICATIONS (in-app bell + email) — ESCALATING DUNNING CADENCE.
 *      Thresholds (days relative to paid_through_at, default [-14,-7,-1,0],
 *      override via SUBSCRIPTION_ALERT_THRESHOLDS="-14,-7,-1,0") each fire
 *      at most once per billing cycle, claimed atomically via the
 *      billing_alerts_sent table: INSERT ... ON CONFLICT DO NOTHING on
 *      UNIQUE(tenant_id, cycle_anchor, alert_type) — the insert winning IS
 *      the claim (same claim-then-send pattern as before, table instead of
 *      columns). cycle_anchor = the paid_through_at being measured, so
 *      record-payment advancing the date re-arms every threshold with no
 *      reset bookkeeping. Negative thresholds = "renewing soon" reminders;
 *      threshold 0 = the lapse/grace warning.
 *
 *   3. SEAT-OVERAGE SWEEP: once per calendar month per tenant, active staff
 *      seats above the plan's included cap emit a 'seat_overage' line into
 *      the fee ledger (same review queue + CSV export as per-hire fees).
 *      Dedup is the partial unique index on (tenant_id, period_key).
 *
 *      Each alert goes to BOTH audiences:
 *        • platform_admins (they collect the external ACH payment), AND
 *        • the TENANT (billing contact email + every tenant_admin, in-app +
 *          email) — the tenant must never be suspended without having been
 *          told directly; a missed alert in the admin inbox is not a backstop.
 *      Additionally, the moment the suspended flip actually WINS, a final
 *      "account suspended" notice goes to tenant + admins. The guarded
 *      status UPDATE is itself the idempotency claim, so this fires exactly
 *      once per suspension even without a dedicated column.
 *
 * ─── Multi-instance safety ───────────────────────────────────────────────────
 * Every send and every notification is claimed with an atomic
 * `UPDATE ... WHERE <col> IS NULL RETURNING id`; status flips use a guarded
 * `UPDATE ... WHERE status = <current>`. If the claim returns 0 rows another
 * instance already handled it and we skip.
 */
import {
  db,
  tenantsTable,
  usersTable,
  userNotificationsTable,
  billingAlertsSentTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { heartbeat } from "./heartbeat.js";
import { sendEmail, plainToHtml } from "./email.js";
import { graceDaysFor } from "./plan-enforcement.js";
import { getSubtreeTenantIds } from "./tenantUtils.js";
import { getPlan, getCountryPrice, type PlanCode } from "./plans.js";

const TICK_MS = 24 * 60 * 60 * 1000; // daily

/** Dunning thresholds in days relative to paid_through_at. Negative = days
 *  before expiry ("renewing soon"), 0 = at/after lapse. Each fires at most
 *  once per cycle. Configurable: SUBSCRIPTION_ALERT_THRESHOLDS="-14,-7,-1,0" */
export const DUNNING_THRESHOLDS: number[] = (() => {
  const raw = process.env.SUBSCRIPTION_ALERT_THRESHOLDS;
  const parsed = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n <= 0);
  const list = parsed.length > 0 ? [...new Set(parsed)] : [-14, -7, -1, 0];
  return list.sort((a, b) => a - b);
})();

const APP_BASE = (
  process.env.PUBLIC_APP_URL ||
  process.env.APP_PUBLIC_URL ||
  (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "") ||
  "https://www.l3xy.ai"
).replace(/\/$/, "");

const ADMIN_URL = `${APP_BASE}/platform/subscriptions`;

const DAY_MS = 86_400_000;

type LifecycleStatus = "active" | "past_due" | "suspended";

interface AdminRecipient {
  id: string;
  email: string | null;
  name: string | null;
  tenantId: string;
}

/** Load every platform_admin once per tick — they receive all alerts. */
async function getPlatformAdmins(): Promise<AdminRecipient[]> {
  return db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      tenantId: usersTable.tenantId,
    })
    .from(usersTable)
    .where(eq(usersTable.role, "platform_admin"));
}

/** Tenant-side recipients: the tenant's billing contact email (may not be a
 *  user) + every tenant_admin of the tenant (in-app + email). */
async function getTenantRecipients(tenantId: string): Promise<{
  contactEmail: string | null;
  admins: AdminRecipient[];
}> {
  const [t] = await db
    .select({ contactEmail: tenantsTable.contactEmail })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);
  const admins = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      tenantId: usersTable.tenantId,
    })
    .from(usersTable)
    .where(sql`${usersTable.tenantId} = ${tenantId} AND ${usersTable.role} = 'tenant_admin'`);
  return { contactEmail: t?.contactEmail ?? null, admins };
}

/** Notify the TENANT: in-app rows for its tenant_admins + best-effort emails
 *  to the billing contact and each tenant_admin (deduped). */
async function notifyTenant(
  tenantId: string,
  args: { kind: "expiry_soon" | "lapsed" | "suspended"; title: string; body: string },
): Promise<void> {
  const { contactEmail, admins } = await getTenantRecipients(tenantId);
  for (const admin of admins) {
    try {
      await db.insert(userNotificationsTable).values({
        tenantId,
        userId: admin.id,
        type: `subscription_${args.kind}`,
        title: args.title,
        message: args.body,
        actionUrl: "/settings/billing",
      });
    } catch (err) {
      logger.error({ err, userId: admin.id }, "[subscription-lifecycle] tenant in-app notify failed");
    }
  }
  const emails = [...new Set([contactEmail, ...admins.map((a) => a.email)].filter((e): e is string => !!e))];
  if (emails.length === 0) {
    // No reachable tenant contact — surface loudly so the gap is fixable.
    logger.warn({ tenantId, kind: args.kind }, "[subscription-lifecycle] tenant has NO billing contact or tenant_admin email — tenant-facing alert not delivered");
    return;
  }
  const text = `${args.body}\n\n— The L3xy Team`;
  for (const to of emails) {
    await sendEmail({
      to,
      subject: args.title,
      text,
      html: plainToHtml(text),
      audit: {
        tenantId,
        actorLabel: "Subscription Lifecycle Scheduler",
        subjectType: "external",
        subjectLabel: to,
        action: `subscription.${args.kind}.tenant_notified`,
        metadata: {},
      },
    }).catch((err) => logger.error({ err, to }, "[subscription-lifecycle] tenant email failed"));
  }
}

/** Pure lifecycle decision: where should a tenant be right now?
 *  Boundary semantics (strict >): AT paid_through / AT grace cutoff the tenant
 *  is still in the earlier state; only strictly past it does it transition.
 *  Exported for regression tests. */
export function desiredStatusFor(nowMs: number, paidThroughMs: number, graceDays: number): LifecycleStatus {
  const graceCutoff = paidThroughMs + graceDays * DAY_MS;
  if (nowMs > graceCutoff) return "suspended";
  if (nowMs > paidThroughMs) return "past_due";
  return "active";
}

/** Guarded status flip — only updates if the row is still at `from`. */
async function transitionStatus(tenantId: string, from: LifecycleStatus, to: LifecycleStatus): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE tenants
       SET status = ${to}::tenant_status, updated_at = now()
     WHERE id = ${tenantId}
       AND status = ${from}::tenant_status
    RETURNING id
  `);
  const rows = (result as any).rows ?? (Array.isArray(result) ? result : []);
  return rows.length > 0;
}

/** Atomic per-cycle alert claim. The UNIQUE(tenant_id, cycle_anchor,
 *  alert_type) constraint makes the INSERT itself the claim: winning the
 *  insert (a returned row) = this instance sends; conflict = someone already
 *  did (this tick or a previous one) — skip. */
async function claimAlert(tenantId: string, cycleAnchor: string, alertType: string): Promise<boolean> {
  const [won] = await db
    .insert(billingAlertsSentTable)
    .values({ tenantId, cycleAnchor, alertType })
    .onConflictDoNothing()
    .returning({ id: billingAlertsSentTable.id });
  return !!won;
}

/** Fan an alert out to every platform admin: in-app bell row + best-effort email. */
async function notifyAdmins(
  admins: AdminRecipient[],
  args: { kind: "expiry_soon" | "lapsed"; tenantName: string; subjectTenantId: string; title: string; body: string },
): Promise<void> {
  for (const admin of admins) {
    try {
      await db.insert(userNotificationsTable).values({
        tenantId: admin.tenantId,
        userId: admin.id,
        type: `subscription_${args.kind}`,
        title: args.title,
        message: args.body,
        actionUrl: "/platform/subscriptions",
      });
    } catch (err) {
      logger.error({ err, adminId: admin.id }, "[subscription-lifecycle] in-app notify failed");
    }
    if (!admin.email) continue;
    const text = `${args.body}\n\nManage subscriptions:\n${ADMIN_URL}\n\n— L3xy Platform`;
    await sendEmail({
      to: admin.email,
      subject: args.title,
      text,
      html: plainToHtml(text),
      audit: {
        tenantId: args.subjectTenantId,
        actorLabel: "Subscription Lifecycle Scheduler",
        subjectType: "external",
        subjectLabel: admin.email,
        action: `subscription.${args.kind}.notified`,
        metadata: { tenantName: args.tenantName },
      },
    }).catch((err) => logger.error({ err, adminId: admin.id }, "[subscription-lifecycle] email failed"));
  }
}

/** Roles that occupy a paid staff seat. Candidates never do; platform_admins
 *  are L3xy operators, not tenant staff. */
const SEAT_ROLES = ["tenant_admin", "recruiter", "hiring_manager", "interviewer", "recruiter_admin"] as const;

/**
 * Monthly seat-overage sweep. For each billing tenant (paid contract, not
 * demo/trial/suspended), counts ACTIVE staff users across its whole subtree
 * and, when that exceeds the plan's included `maxStaffSeats` (-1 = unlimited),
 * inserts ONE 'seat_overage' fee-ledger line for the current calendar month:
 *   amount = overage_seats × per-seat monthly fee (country-priced).
 * The line lands in the same pending_review queue as per-hire fees — staff
 * approve/waive it there, and it exports in the same CSV. Dedup is the
 * partial unique index fee_line_items_seat_overage_period_uq
 * (tenant_id, period_key='YYYY-MM'), claimed with ON CONFLICT DO NOTHING.
 */
async function sweepSeatOverage(
  tenants: Array<{ id: string; name: string; plan: string | null; status: string | null; country: string | null }>,
): Promise<void> {
  const periodKey = new Date().toISOString().slice(0, 7); // YYYY-MM
  for (const t of tenants) {
    if (t.status === "trial" || t.status === "suspended") continue;
    const plan = getPlan(t.plan);
    const included = plan.limits.maxStaffSeats;
    if (included < 0) continue; // unlimited seats

    try {
      const subtree = await getSubtreeTenantIds(t.id);
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(usersTable)
        .where(and(
          inArray(usersTable.tenantId, subtree),
          inArray(usersTable.role, [...SEAT_ROLES]),
          eq(usersTable.status, "active"),
        ));
      const seats = row?.n ?? 0;
      const overage = seats - included;
      if (overage <= 0) continue;

      const price = await getCountryPrice(t.country, (plan.code as PlanCode) ?? "starter", "monthly");
      if (!(price.perSeatAmount > 0)) continue; // no per-seat fee configured
      const amount = overage * price.perSeatAmount;
      const description =
        `Seat overage ${periodKey}: ${seats} active staff seats vs ${included} included on ${plan.code} — ${overage} × ${price.symbol}${price.perSeatAmount}/mo`;

      const result = await db.execute(sql`
        INSERT INTO fee_line_items
          (tenant_id, item_type, plan_code, amount, currency, description, period_key, evidence)
        VALUES
          (${t.id}, 'seat_overage', ${plan.code}, ${amount}, ${price.currency}, ${description}, ${periodKey},
           ${JSON.stringify({ seats, included, overage, perSeatAmount: price.perSeatAmount, priceSource: price.source })}::jsonb)
        ON CONFLICT (tenant_id, period_key) WHERE item_type = 'seat_overage' DO NOTHING
        RETURNING id
      `);
      const rows = (result as any).rows ?? (Array.isArray(result) ? result : []);
      if (rows.length > 0) {
        logger.info({ tenantId: t.id, periodKey, seats, included, overage, amount }, "[subscription-lifecycle] seat-overage line created");
      }
    } catch (err) {
      // Per-tenant isolation: one bad tenant must not stop the sweep.
      logger.error({ err: (err as Error)?.message, tenantId: t.id }, "[subscription-lifecycle] seat sweep failed for tenant");
    }
  }
}

async function tick() {
  // Only tenants with a real paid contract (paid_through_at set) and not on the
  // free demo plan participate in the manual-billing lifecycle.
  const subs = await db
    .select({
      id: tenantsTable.id,
      name: tenantsTable.name,
      plan: tenantsTable.plan,
      status: tenantsTable.status,
      paidThroughAt: tenantsTable.paidThroughAt,
      gracePeriodDays: tenantsTable.gracePeriodDays,
      country: tenantsTable.country,
    })
    .from(tenantsTable)
    .where(isNotNull(tenantsTable.paidThroughAt));

  const candidates = subs.filter((t) => t.plan !== "demo");
  if (candidates.length === 0) return;

  const now = Date.now();
  const admins = await getPlatformAdmins();
  let flips = 0;
  let alerts = 0;

  for (const t of candidates) {
    if (!t.paidThroughAt) continue;
    // The trial-expiry-scheduler owns `trial` tenants — never touch them here.
    if (t.status === "trial") continue;

    const pt = new Date(t.paidThroughAt).getTime();
    const cycleAnchor = new Date(pt).toISOString();
    // Per-tenant grace override (negotiated Enterprise terms) ?? global default.
    const graceDays = graceDaysFor(t.gracePeriodDays);
    const graceCutoff = pt + graceDays * DAY_MS;
    const desired = desiredStatusFor(now, pt, graceDays);

    const current = t.status as LifecycleStatus;
    // Set when the suspension flip fires its tenant notice this tick — used to
    // suppress a same-tick duplicate tenant "lapsed" email below.
    let suspendedNotifiedThisTick = false;
    if (current !== desired && (current === "active" || current === "past_due" || current === "suspended")) {
      const won = await transitionStatus(t.id, current, desired);
      if (won) {
        flips += 1;
        logger.info({ tenantId: t.id, from: current, to: desired }, "[subscription-lifecycle] status transition");

        // Guaranteed suspension notice — fires exactly once (the guarded
        // UPDATE above is the claim). Even if earlier reminder/lapse alerts
        // were missed, suspension is never silent for the tenant.
        if (desired === "suspended") {
          const suspTitle = `Your L3xy subscription has been suspended — ${t.name}`;
          const suspBody =
            `Your subscription payment was due on ${new Date(pt).toISOString().slice(0, 10)} and the ${graceDays}-day grace period has now ended, so access for ${t.name} has been suspended. ` +
            `Please contact your L3xy account manager or reply to this email to arrange payment — access is restored as soon as the payment is recorded.`;
          suspendedNotifiedThisTick = true;
          await notifyTenant(t.id, { kind: "suspended", title: suspTitle, body: suspBody });
          await notifyAdmins(admins, {
            kind: "lapsed",
            tenantName: t.name,
            subjectTenantId: t.id,
            title: `Tenant SUSPENDED — ${t.name}`,
            body: `${t.name} has been suspended (grace of ${graceDays} days exhausted). The tenant has been notified. Record a payment to restore access.`,
          });
          alerts += 1;
        }
      }
    }

    // ── Escalating dunning cadence ──
    // Each threshold fires once per cycle (cycle = this paid_through_at value;
    // recording a payment advances the anchor and re-arms everything).
    const daysToExpiry = (pt - now) / DAY_MS;

    for (const threshold of DUNNING_THRESHOLDS) {
      if (threshold < 0) {
        // Reminder: fires once we're within |threshold| days of expiry (but
        // not yet lapsed). Later reminders naturally supersede earlier ones —
        // if the scheduler was down through -14 and -7, both claims succeed
        // on the next tick, but each is sent at most once per cycle.
        if (now <= pt && daysToExpiry <= -threshold) {
          if (await claimAlert(t.id, cycleAnchor, `reminder_${-threshold}d`)) {
            const days = Math.max(0, Math.ceil(daysToExpiry));
            await notifyAdmins(admins, {
              kind: "expiry_soon",
              tenantName: t.name,
              subjectTenantId: t.id,
              title: `Subscription renewing soon — ${t.name} (${days} day${days === 1 ? "" : "s"})`,
              body: `${t.name}'s subscription is paid through ${new Date(pt).toISOString().slice(0, 10)} (in ${days} day${days === 1 ? "" : "s"}). Collect the next payment and record it to extend their access.`,
            });
            await notifyTenant(t.id, {
              kind: "expiry_soon",
              title: `Your L3xy subscription renews soon — ${t.name}`,
              body: `Your L3xy subscription for ${t.name} is paid through ${new Date(pt).toISOString().slice(0, 10)} (${days} day${days === 1 ? "" : "s"} from now). Please arrange your next payment to keep access uninterrupted. If you have already paid, no action is needed — it may take a short time to be recorded.`,
            });
            alerts += 1;
          }
        }
      } else {
        // Lapse alert (threshold 0): paid_through in the past.
        if (now > pt) {
          if (await claimAlert(t.id, cycleAnchor, "lapsed")) {
            const overdueDays = Math.floor((now - pt) / DAY_MS);
            const stateLabel = now > graceCutoff
              ? `now SUSPENDED (grace of ${graceDays} days exhausted)`
              : `in the ${graceDays}-day grace window (past_due — still active)`;
            await notifyAdmins(admins, {
              kind: "lapsed",
              tenantName: t.name,
              subjectTenantId: t.id,
              title: `Subscription lapsed — ${t.name}`,
              body: `${t.name}'s subscription lapsed ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago and is ${stateLabel}. Record a payment to restore access.`,
            });
            const tenantLapseBody = now > graceCutoff
              ? `Your L3xy subscription payment for ${t.name} was due ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago and access has been suspended. Please arrange payment to restore access immediately.`
              : `Your L3xy subscription payment for ${t.name} was due ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago. Your access continues during a ${graceDays}-day grace period, but will be suspended after ${new Date(graceCutoff).toISOString().slice(0, 10)} if payment is not received. If you have already paid, it may take a short time to be recorded.`;
            if (!suspendedNotifiedThisTick) {
              await notifyTenant(t.id, {
                kind: "lapsed",
                title: `Payment overdue — your L3xy subscription (${t.name})`,
                body: tenantLapseBody,
              });
            }
            alerts += 1;
          }
        }
      }
    }
  }

  // ── Seat-overage sweep (monthly, per billing tenant) ──
  try {
    await sweepSeatOverage(candidates);
  } catch (err) {
    logger.error({ err: (err as Error)?.message }, "[subscription-lifecycle] seat-overage sweep failed");
  }

  if (flips > 0 || alerts > 0) {
    logger.info({ flips, alerts, scanned: candidates.length }, "[subscription-lifecycle-scheduler] tick complete");
  }
}

export function startSubscriptionLifecycleScheduler() {
  logger.info(
    `[subscription-lifecycle-scheduler] Started — runs every ${TICK_MS / 3_600_000}h (dunning thresholds [${DUNNING_THRESHOLDS.join(", ")}]d)`,
  );
  const run = () =>
    tick()
      .then(() => heartbeat("subscription_lifecycle"))
      .catch((err) => {
        logger.error({ err: err?.message }, "[subscription-lifecycle] tick failed");
        heartbeat("subscription_lifecycle", "fail", err);
      });
  run();
  setInterval(run, TICK_MS);
}
