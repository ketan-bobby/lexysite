/**
 * trial-expiry-scheduler.ts — Demo-Trial Expiry Warning Emails
 *
 * Runs every 6 hours. Scans every tenant on plan='demo' and sends one of three
 * emails depending on how close they are to the 14-day trial expiry:
 *   T-3 days  → "Your L3xy trial ends in 3 days" (pre-warning, conversion)
 *   T-1 day   → "Your L3xy trial ends tomorrow"  (final nudge)
 *   T+0       → "Your L3xy trial has ended"      (expired, upgrade CTA)
 *
 * ─── Idempotency / multi-instance safety ─────────────────────────────────────
 * Each tenant has trial_warning_3d_sent_at / trial_warning_1d_sent_at /
 * trial_expired_email_sent_at columns. We CLAIM the right to send by doing an
 * atomic `UPDATE tenants SET <col>=now() WHERE id=$id AND <col> IS NULL
 * RETURNING id`. If the UPDATE returns 0 rows, another scheduler instance
 * (or a previous tick that crashed mid-send) already claimed it — we skip.
 *
 * ─── Catch-up after outages ──────────────────────────────────────────────────
 * We deliberately do NOT enforce an upper-day bound on the warning windows.
 * If the scheduler was offline during a tenant's T-3 window, we still send
 * T-3 the next time we run, UNLESS a later-stage email (T-1 or expired) was
 * already sent — in which case the earlier warning is suppressed (it'd be
 * misleading to email "ends in 3 days" to someone we already emailed
 * "expired"). We pick the LATEST applicable spec per tenant per tick.
 */
import { db, tenantsTable, usersTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { heartbeat } from "./heartbeat.js";
import { sendEmail, plainToHtml } from "./email.js";
import { PLAN_PACKAGES } from "./plans.js";

const TICK_MS = 6 * 60 * 60 * 1000; // 6 hours

const DEMO_TRIAL_DAYS = PLAN_PACKAGES.demo.expiresAfterDays; // 14

const APP_BASE = (
  process.env.PUBLIC_APP_URL ||
  process.env.APP_PUBLIC_URL ||
  (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "") ||
  "https://www.l3xy.ai"
).replace(/\/$/, "");

function upgradeUrl(): string {
  return `${APP_BASE}/subscription`;
}

type SentColumnName = "trial_warning_3d_sent_at" | "trial_warning_1d_sent_at" | "trial_expired_email_sent_at";
type SentField = "trialWarning3dSentAt" | "trialWarning1dSentAt" | "trialExpiredEmailSentAt";

interface WarningSpec {
  /** Human label for log lines. */
  label: "T-3" | "T-1" | "expired";
  /** Min days since planActivatedAt for this email to fire (inclusive). NO upper bound. */
  minDaysSinceActivation: number;
  /** Drizzle field name (camelCase). */
  setField: SentField;
  /** Snake-case DB column name (used in raw SQL atomic claim). */
  sentColumn: SentColumnName;
  subject: (tenantName: string) => string;
  body: (recipientName: string, tenantName: string) => string;
}

/** Ordered LATEST-stage first. We send only the latest applicable spec per
 *  tenant per tick — preventing "ends in 3 days" being sent after "expired". */
const WARNINGS_LATEST_FIRST: WarningSpec[] = [
  {
    label: "expired",
    minDaysSinceActivation: DEMO_TRIAL_DAYS, // 14+
    setField: "trialExpiredEmailSentAt",
    sentColumn: "trial_expired_email_sent_at",
    subject: () => "Your L3xy trial has ended",
    body: (name, tenant) =>
      `Hi ${name},

The 14-day L3xy trial for ${tenant} has ended. Your data is preserved — when you upgrade, everything is right where you left it.

Pick a plan here to unlock the platform again:
${upgradeUrl()}

If you'd like to talk to a human about pricing or what plan fits, just reply.

— The L3xy team`,
  },
  {
    label: "T-1",
    minDaysSinceActivation: DEMO_TRIAL_DAYS - 1, // 13+
    setField: "trialWarning1dSentAt",
    sentColumn: "trial_warning_1d_sent_at",
    subject: () => "Your L3xy trial ends tomorrow",
    body: (name, tenant) =>
      `Hi ${name},

Your L3xy trial for ${tenant} ends tomorrow. Once it expires, the platform locks the create-job and create-interview buttons until you upgrade.

Upgrade in two clicks here:
${upgradeUrl()}

— The L3xy team`,
  },
  {
    label: "T-3",
    minDaysSinceActivation: DEMO_TRIAL_DAYS - 3, // 11+
    setField: "trialWarning3dSentAt",
    sentColumn: "trial_warning_3d_sent_at",
    subject: () => "Your L3xy trial ends in 3 days",
    body: (name, tenant) =>
      `Hi ${name},

A quick heads-up — the L3xy trial for ${tenant} ends in 3 days. After that, your team won't be able to open new jobs or run new interviews until you choose a plan.

If you're ready to keep going, pick a plan here (Starter is $299/mo, Growth is $999/mo):
${upgradeUrl()}

If you ran into anything that didn't work, reply to this email and we'll fix it.

— The L3xy team`,
  },
];

/** Atomic compare-and-set: marks the column NOW if it's still NULL. Returns
 *  true if we won the claim (and must send), false if someone else beat us. */
async function claimSendSlot(tenantId: string, column: SentColumnName): Promise<boolean> {
  // Use raw SQL with the snake_case column name; drizzle's update API doesn't
  // give us cross-replica atomicity guarantees in one round-trip the same way.
  const result = await db.execute(sql`
    UPDATE tenants
       SET ${sql.raw(column)} = now()
     WHERE id = ${tenantId}
       AND ${sql.raw(column)} IS NULL
    RETURNING id
  `);
  const rows = (result as any).rows ?? (Array.isArray(result) ? result : []);
  return rows.length > 0;
}

async function tick() {
  const demoTenants = await db.select().from(tenantsTable).where(eq(tenantsTable.plan, "demo"));
  if (demoTenants.length === 0) return;

  const now = Date.now();
  let sent = 0;

  for (const tenant of demoTenants) {
    const anchor = (tenant.planActivatedAt ?? tenant.createdAt) as Date;
    const daysSince = (now - new Date(anchor).getTime()) / 86_400_000;

    // Find the LATEST stage this tenant qualifies for that hasn't been sent yet.
    // If a later stage was already sent, suppress earlier ones (don't email
    // "ends in 3 days" after "expired").
    let chosen: WarningSpec | null = null;
    let suppressEarlier = false;
    for (const spec of WARNINGS_LATEST_FIRST) {
      if (daysSince < spec.minDaysSinceActivation) continue;
      if ((tenant as any)[spec.setField]) {
        // This or a later stage was already sent → don't backfill earlier ones.
        suppressEarlier = true;
        continue;
      }
      if (suppressEarlier) break;
      chosen = spec; // first eligible NULL wins (we iterate latest-first)
      break;
    }
    if (!chosen) continue;

    // Atomically claim this send slot before doing any work — prevents
    // duplicate emails when two scheduler instances tick concurrently.
    const won = await claimSendSlot(tenant.id, chosen.sentColumn);
    if (!won) {
      logger.debug({ tenantId: tenant.id, label: chosen.label }, "[trial-expiry] another instance won the claim — skipping");
      continue;
    }

    // We hold the slot — best-effort send. If sendEmail fails we log and
    // leave the slot claimed; this prefers under-emailing to spamming the
    // user. (You can re-NULL the column manually to retry a specific tenant.)
    const [admin] = await db
      .select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(and(eq(usersTable.tenantId, tenant.id), eq(usersTable.role, "tenant_admin")))
      .limit(1);

    const recipient = admin?.email ?? tenant.contactEmail;
    if (!recipient) {
      logger.warn({ tenantId: tenant.id, label: chosen.label }, "[trial-expiry] no recipient email — slot consumed without send");
      continue;
    }

    const text = chosen.body(admin?.name ?? "there", tenant.name);
    const result = await sendEmail({
      to: recipient,
      subject: chosen.subject(tenant.name),
      text,
      html: plainToHtml(text),
      audit: {
        tenantId: tenant.id,
        actorLabel: "Trial Expiry Scheduler",
        subjectType: "external",
        subjectLabel: recipient,
        action: `trial.${chosen.label}.sent`,
        metadata: { tenantName: tenant.name, daysSinceActivation: Math.round(daysSince * 10) / 10 },
      },
    });

    if (!result.ok) {
      logger.error({ tenantId: tenant.id, label: chosen.label, err: result.error }, "[trial-expiry] send failed AFTER claim — slot remains consumed; manual re-trigger required");
      continue;
    }

    sent += 1;
    logger.info(
      { tenantId: tenant.id, tenantName: tenant.name, label: chosen.label, simulated: result.simulated ?? false },
      "[trial-expiry] sent",
    );
  }

  if (sent > 0) {
    logger.info({ count: sent }, "[trial-expiry-scheduler] tick complete");
  }
}

export function startTrialExpiryScheduler() {
  logger.info(`[trial-expiry-scheduler] Started — runs every ${TICK_MS / 3_600_000}h`);
  const run = () =>
    tick()
      .then(() => heartbeat("trial_expiry"))
      .catch((err) => {
        logger.error({ err: err?.message }, "[trial-expiry] tick failed");
        heartbeat("trial_expiry", "fail", err);
      });
  // Fire once on boot, then on interval.
  run();
  setInterval(run, TICK_MS);
}
