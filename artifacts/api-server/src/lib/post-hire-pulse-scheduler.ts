/**
 * post-hire-pulse-scheduler.ts — 30/90-Day Quality-of-Hire Pulses
 *
 * Runs every 6 hours. For every hired candidate_outcomes row, sends the hiring
 * manager a short (3-question) quality pulse 30 and 90 days after the hire date.
 * The manager's answers (collected via the in-app /hire-pulse form, persisted by
 * POST /outcomes/:applicationId/pulse) produce the hire_quality_score — the
 * "should have been hired" signal the learning loop is missing today.
 *
 * ─── Idempotency / multi-instance safety ─────────────────────────────────────
 * Each outcome row has pulse_30_sent_at / pulse_90_sent_at columns. We CLAIM the
 * right to send by an atomic `UPDATE candidate_outcomes SET <col>=now()
 * WHERE id=$id AND <col> IS NULL RETURNING id`. A 0-row result means another
 * instance (or an earlier tick) already claimed it — we skip. We deliberately
 * impose no upper-day bound so a pulse missed during an outage still goes out on
 * the next tick.
 *
 * Best-effort: a send that fails AFTER the claim leaves the slot consumed
 * (prefers under-emailing to spamming). Re-NULL the column to retry one row.
 */
import { db, candidateOutcomesTable, jobsTable, tenantsTable, usersTable } from "@workspace/db";
import { and, eq, isNull, isNotNull, lte, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { heartbeat } from "./heartbeat.js";
import { sendEmail, plainToHtml } from "./email.js";

const TICK_MS = 6 * 60 * 60 * 1000; // 6 hours
const DAY_MS = 86_400_000;

const APP_BASE = (
  process.env.PUBLIC_APP_URL ||
  process.env.APP_PUBLIC_URL ||
  (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "") ||
  "https://www.l3xy.ai"
).replace(/\/$/, "");

type Phase = "30" | "90";
type SentColumn = "pulse_30_sent_at" | "pulse_90_sent_at";

interface PulseSpec {
  phase: Phase;
  minDays: number;
  sentColumn: SentColumn;
}

/** Latest-phase first so we never send the 30-day pulse after the 90-day one. */
const PULSES_LATEST_FIRST: PulseSpec[] = [
  { phase: "90", minDays: 90, sentColumn: "pulse_90_sent_at" },
  { phase: "30", minDays: 30, sentColumn: "pulse_30_sent_at" },
];

/** The 3 questions asked at each pulse (kept in sync with the /hire-pulse form). */
const PULSE_QUESTIONS = [
  "How is this hire performing against your expectations? (1 = well below, 5 = well above)",
  "How well are they integrating with the team? (1 = poorly, 5 = excellently)",
  "Knowing what you know now, would you hire them again? (1 = definitely not, 5 = definitely yes)",
];

function pulseUrl(applicationId: string, phase: Phase): string {
  return `${APP_BASE}/hire-pulse/${applicationId}?phase=${phase}`;
}

function pulseBody(recipientName: string, jobTitle: string, phase: Phase, applicationId: string): string {
  const horizon = phase === "30" ? "30 days" : "90 days";
  return `Hi ${recipientName},

It's been about ${horizon} since this hire for "${jobTitle}" started. A 30-second check-in helps us measure quality of hire — not just whether someone got hired, but whether it worked out.

Three quick questions:
1. ${PULSE_QUESTIONS[0]}
2. ${PULSE_QUESTIONS[1]}
3. ${PULSE_QUESTIONS[2]}

Answer here (takes under a minute):
${pulseUrl(applicationId, phase)}

Thank you — your input directly improves who we surface for your future roles.

— The L3xy team`;
}

/** Atomic compare-and-set: claims the slot if still NULL. Returns true if we won. */
async function claimSendSlot(outcomeId: string, column: SentColumn): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE candidate_outcomes
       SET ${sql.raw(column)} = now()
     WHERE id = ${outcomeId}
       AND ${sql.raw(column)} IS NULL
    RETURNING id
  `);
  const rows = (result as any).rows ?? (Array.isArray(result) ? result : []);
  return rows.length > 0;
}

/** Resolve the hiring-manager recipient for a job (best-effort cascade). */
async function resolveRecipient(jobId: string, tenantId: string): Promise<{ email: string; name: string } | null> {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);

  const candidateUserIds = [job?.assignedRecruiterId, job?.createdById].filter(Boolean) as string[];
  for (const uid of candidateUserIds) {
    const [u] = await db.select({ email: usersTable.email, name: usersTable.name })
      .from(usersTable).where(eq(usersTable.id, uid)).limit(1);
    if (u?.email) return { email: u.email, name: u.name ?? "there" };
  }

  const [admin] = await db.select({ email: usersTable.email, name: usersTable.name })
    .from(usersTable)
    .where(and(eq(usersTable.tenantId, tenantId), eq(usersTable.role, "tenant_admin")))
    .limit(1);
  if (admin?.email) return { email: admin.email, name: admin.name ?? "there" };

  const [tenant] = await db.select({ email: tenantsTable.contactEmail, name: tenantsTable.name })
    .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  if (tenant?.email) return { email: tenant.email, name: tenant.name ?? "there" };

  return null;
}

async function tick() {
  const now = Date.now();

  // Only hired rows with a hire_date are eligible. Pull the ones old enough for
  // at least the earliest pulse window; per-row we pick the right phase below.
  const hired = await db.select().from(candidateOutcomesTable).where(and(
    eq(candidateOutcomesTable.outcome, "hired"),
    isNotNull(candidateOutcomesTable.hireDate),
    lte(candidateOutcomesTable.hireDate, new Date(now - 30 * DAY_MS)),
  ));
  if (hired.length === 0) return;

  let sent = 0;

  for (const row of hired) {
    const hireMs = new Date(row.hireDate as Date).getTime();
    const daysSince = (now - hireMs) / DAY_MS;

    // Choose the latest pulse this row qualifies for that hasn't been sent yet.
    let chosen: PulseSpec | null = null;
    let suppressEarlier = false;
    for (const spec of PULSES_LATEST_FIRST) {
      if (daysSince < spec.minDays) continue;
      const alreadySent = spec.phase === "90" ? row.pulse90SentAt : row.pulse30SentAt;
      if (alreadySent) { suppressEarlier = true; continue; }
      if (suppressEarlier) break;
      chosen = spec;
      break;
    }
    if (!chosen) continue;

    const won = await claimSendSlot(row.id, chosen.sentColumn);
    if (!won) continue;

    const recipient = await resolveRecipient(row.jobId, row.tenantId);
    if (!recipient) {
      logger.warn({ outcomeId: row.id, phase: chosen.phase }, "[post-hire-pulse] no recipient — slot consumed without send");
      continue;
    }

    const [job] = await db.select({ title: jobsTable.title }).from(jobsTable).where(eq(jobsTable.id, row.jobId)).limit(1);
    const jobTitle = job?.title ?? "this role";
    const text = pulseBody(recipient.name, jobTitle, chosen.phase, row.applicationId);

    const result = await sendEmail({
      to: recipient.email,
      subject: `Quick ${chosen.phase}-day check-in on your hire for "${jobTitle}"`,
      text,
      html: plainToHtml(text),
      audit: {
        tenantId: row.tenantId,
        actorLabel: "Post-Hire Pulse Scheduler",
        subjectType: "external",
        subjectLabel: recipient.email,
        action: `hire_pulse.${chosen.phase}d.sent`,
        metadata: { applicationId: row.applicationId, jobId: row.jobId, daysSinceHire: Math.round(daysSince) },
      },
    });

    if (!result.ok) {
      logger.error({ outcomeId: row.id, phase: chosen.phase, err: result.error }, "[post-hire-pulse] send failed AFTER claim — slot consumed; manual re-trigger required");
      continue;
    }

    sent += 1;
    logger.info({ outcomeId: row.id, phase: chosen.phase, simulated: result.simulated ?? false }, "[post-hire-pulse] sent");
  }

  if (sent > 0) logger.info({ count: sent }, "[post-hire-pulse-scheduler] tick complete");
}

export function startPostHirePulseScheduler() {
  logger.info(`[post-hire-pulse-scheduler] Started — runs every ${TICK_MS / 3_600_000}h (30d + 90d pulses)`);
  const run = () =>
    tick()
      .then(() => heartbeat("post_hire_pulse"))
      .catch((err) => {
        logger.error({ err: err?.message }, "[post-hire-pulse] tick failed");
        heartbeat("post_hire_pulse", "fail", err);
      });
  run();
  setInterval(run, TICK_MS);
}

export { PULSE_QUESTIONS };
