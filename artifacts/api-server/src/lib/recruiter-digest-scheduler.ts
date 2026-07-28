/**
 * recruiter-digest-scheduler.ts — Daily Recruiter Email Digest
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Checks every hour whether any recruiter's daily digest is due to be sent,
 * then drains their pending recruiter_digest_queue rows and emails a single
 * summary report.
 *
 * ─── Delivery timing ─────────────────────────────────────────────────────────
 * Each recruiter receives at most ONE digest per calendar day (in their local
 * timezone). The digest is delivered at or after 08:00 local time. The "at or
 * after" rule means a missed 08:00 tick (e.g. server restart) delivers at 09:00
 * instead of silently skipping the day.
 *
 * ─── Atomic drain ────────────────────────────────────────────────────────────
 * Row IDs are captured at SELECT time; only those IDs are stamped sentAt after
 * the email succeeds. Rows inserted between the SELECT and the UPDATE remain
 * pending for the next day — no over-sends, no silent loss.
 *
 * ─── What goes in a digest ───────────────────────────────────────────────────
 * Items queued by other parts of the system (e.g. screening.batch events from
 * the screening agent) are grouped by job, sorted by score, and rendered as an
 * HTML table with pass / hold / reject breakdown and top candidate names.
 *
 * ─── Manual trigger ──────────────────────────────────────────────────────────
 * tick({ force: true }) bypasses the timezone and dedup checks — used by the
 * /digests/run-now admin endpoint. The tenantId parameter scopes the drain to
 * one tenant so platform admins and tenant admins can both use the endpoint
 * safely.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/index.ts      — startRecruiterDigestScheduler() on server boot
 *   routes/digests.ts — tick({ force: true }) for manual trigger
 */
import { db } from "@workspace/db";
import {
  recruiterDigestQueueTable,
  usersTable,
  jobsTable,
} from "@workspace/db";
import { and, eq, isNull, inArray, lte } from "drizzle-orm";
import { logger } from "./logger";
import { heartbeat } from "./heartbeat";
import { sendEmail } from "./email";
import { recordAudit } from "./audit";

const TICK_MS = 60 * 60 * 1000; // hourly
const DELIVERY_HOUR_LOCAL = 8; // send digest at 08:00 in recruiter's local timezone

/**
 * recruiter-digest-scheduler — runs hourly. For each recruiter whose local
 * time is at or past 08:00 today and who has not yet received today's
 * digest, drains their queued rows, sends one summary email, and stamps
 * `users.last_digest_sent_at`. The "at or past" rule (vs. "exactly 08:00")
 * means a missed tick at 08:00 still delivers at 09:00 the same day — no
 * silent skips when the service was down.
 */
export function startRecruiterDigestScheduler() {
  logger.info("[recruiter-digest] Started — checks hourly, delivers once per local day after 08:00");
  // Run once shortly after boot so we catch any recruiter we missed while
  // the service was down — `hasReceivedTodaysDigest()` prevents duplicates.
  const run = () =>
    tick()
      .then(() => heartbeat("recruiter_digest"))
      .catch((err) => {
        logger.error({ err }, "[recruiter-digest] tick error");
        heartbeat("recruiter_digest", "fail", err);
      });
  setTimeout(run, 30_000);
  setInterval(run, TICK_MS);
}

/**
 * Drain pending queue rows and email a digest to every eligible recruiter.
 *
 * Eligibility per recruiter:
 *   • Has at least one pending row in `recruiter_digest_queue`, AND
 *   • Either `force` is true, OR the recruiter's local time is ≥ 08:00 AND
 *     they haven't already received today's digest.
 *
 * Drain is atomic: row IDs are captured at SELECT time and only those IDs
 * are marked sent, so any new rows inserted during the email send remain
 * pending for tomorrow's digest (no silent loss).
 *
 * `tenantId`, when supplied, scopes the entire drain to that tenant — used
 * to safely expose `/digests/run-now` to tenant admins without leaking
 * across tenants.
 */
export async function tick(
  opts: { force?: boolean; tenantId?: string | null } = {},
): Promise<{ recruitersSent: number; itemsDrained: number; recruitersSkipped: number }> {
  const conds: any[] = [isNull(recruiterDigestQueueTable.sentAt)];
  if (opts.tenantId) conds.push(eq(recruiterDigestQueueTable.tenantId, opts.tenantId));

  const pending = await db.select().from(recruiterDigestQueueTable).where(and(...conds));
  if (pending.length === 0) return { recruitersSent: 0, itemsDrained: 0, recruitersSkipped: 0 };

  const recruiterIds = Array.from(new Set(pending.map((p) => p.recruiterId)));
  const recruiters = await db.select().from(usersTable).where(inArray(usersTable.id, recruiterIds));
  const recruiterById = new Map(recruiters.map((r) => [r.id, r]));

  let recruitersSent = 0;
  let recruitersSkipped = 0;
  let itemsDrained = 0;

  for (const recruiterId of recruiterIds) {
    const recruiter = recruiterById.get(recruiterId);
    if (!recruiter?.email) { recruitersSkipped++; continue; }

    const tz = recruiter.timezone || "UTC";
    if (!opts.force) {
      if (!isAtOrPastDeliveryHour(tz)) { recruitersSkipped++; continue; }
      if (hasReceivedTodaysDigest(recruiter.lastDigestSentAt, tz)) { recruitersSkipped++; continue; }
    }

    // Atomic claim: capture IDs *now* and only mark these as sent later.
    // Rows inserted between this select and the UPDATE remain pending and
    // will be picked up on the next tick — no over-sends, no lost rows.
    const claimedItems = pending.filter((p) => p.recruiterId === recruiterId);
    const claimedIds = claimedItems.map((p) => p.id);
    if (claimedIds.length === 0) { recruitersSkipped++; continue; }

    try {
      await sendDigest(recruiter, claimedItems);
      const sentAt = new Date();
      await db.update(recruiterDigestQueueTable)
        .set({ sentAt })
        .where(and(
          inArray(recruiterDigestQueueTable.id, claimedIds),
          isNull(recruiterDigestQueueTable.sentAt),
        ));
      // Stamp the recruiter so we don't try to send another digest today.
      await db.update(usersTable)
        .set({ lastDigestSentAt: sentAt })
        .where(eq(usersTable.id, recruiterId));
      recruitersSent++;
      itemsDrained += claimedIds.length;
    } catch (err) {
      logger.error({ err, recruiterId }, "[recruiter-digest] failed to deliver digest");
      recruitersSkipped++;
    }
  }

  if (recruitersSent > 0) {
    logger.info({ recruitersSent, itemsDrained, recruitersSkipped }, "[recruiter-digest] delivered");
  }
  return { recruitersSent, itemsDrained, recruitersSkipped };
}

/**
 * Build the HTML+text digest email body and send it to one recruiter.
 * Groups queued items by job, then by event type.
 */
async function sendDigest(
  recruiter: typeof usersTable.$inferSelect,
  items: Array<typeof recruiterDigestQueueTable.$inferSelect>,
): Promise<void> {
  // Group by jobId
  const byJob = new Map<string, typeof items>();
  for (const it of items) {
    const key = it.jobId || "_no_job";
    if (!byJob.has(key)) byJob.set(key, []);
    byJob.get(key)!.push(it);
  }

  // Look up job titles in one query
  const jobIds = Array.from(byJob.keys()).filter((k) => k !== "_no_job");
  const jobs = jobIds.length
    ? await db.select().from(jobsTable).where(inArray(jobsTable.id, jobIds))
    : [];
  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // Build per-job sections
  const sections: string[] = [];
  const textSections: string[] = [];
  let totalCandidatesScreened = 0;
  let totalAdvance = 0;

  for (const [jobId, jobItems] of byJob) {
    const job = jobById.get(jobId);
    const jobTitle = job?.title || "Unassigned";

    // Aggregate by eventType within the job
    const screening = jobItems.filter((it) => it.eventType === "screening.batch");

    const screeningCandidates: Array<{ name: string; score: number | null; recommendation: string }> = [];
    let jobAdvance = 0, jobHold = 0, jobReject = 0;
    for (const s of screening) {
      const p = s.payload as any;
      jobAdvance += p?.advanceCount ?? 0;
      jobHold += p?.holdCount ?? 0;
      jobReject += p?.rejectCount ?? 0;
      for (const c of p?.candidates ?? []) screeningCandidates.push(c);
    }

    if (screeningCandidates.length > 0) {
      // Sort by score desc, take top 10 per job
      screeningCandidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      totalCandidatesScreened += screeningCandidates.length;
      totalAdvance += jobAdvance;

      const top = screeningCandidates.slice(0, 10);
      const rows = top.map((c) => {
        const rec = c.recommendation || "hold";
        const color = rec === "advance" ? "#16a34a" : rec === "reject" ? "#dc2626" : "#a16207";
        return `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;">${escapeHtml(c.name)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-variant-numeric:tabular-nums;">${c.score ?? "—"}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #f0f0f0;"><span style="color:${color};font-weight:600;text-transform:uppercase;font-size:11px;">${rec}</span></td>
        </tr>`;
      }).join("");
      const more = screeningCandidates.length > top.length
        ? `<p style="margin:6px 0 0 0;color:#888;font-size:12px;">+ ${screeningCandidates.length - top.length} more in pipeline</p>`
        : "";

      sections.push(`<div style="margin:20px 0 28px 0;">
        <h3 style="margin:0 0 4px 0;font-size:16px;">${escapeHtml(jobTitle)}</h3>
        <p style="margin:0 0 10px 0;color:#666;font-size:13px;">
          ${screeningCandidates.length} candidate${screeningCandidates.length === 1 ? "" : "s"} screened ·
          <span style="color:#16a34a;">${jobAdvance} advance</span> ·
          <span style="color:#a16207;">${jobHold} hold</span> ·
          <span style="color:#dc2626;">${jobReject} reject</span>
        </p>
        <table style="border-collapse:collapse;width:100%;border:1px solid #eee;border-radius:6px;overflow:hidden;">
          <thead><tr style="background:#f8f9fb;text-align:left;font-size:11px;text-transform:uppercase;color:#666;">
            <th style="padding:6px 12px;">Candidate</th>
            <th style="padding:6px 12px;text-align:right;">Score</th>
            <th style="padding:6px 12px;">Rec</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${more}
        <p style="margin:8px 0 0 0;"><a href="${process.env.PUBLIC_APP_URL || ""}/jobs/${jobId}" style="color:#2563eb;text-decoration:none;font-size:13px;">Open pipeline →</a></p>
      </div>`);

      textSections.push(
        `${jobTitle}\n` +
        `  ${screeningCandidates.length} screened — ${jobAdvance} advance · ${jobHold} hold · ${jobReject} reject\n` +
        top.map((c) => `  • ${c.name} — ${c.score ?? "—"} — ${c.recommendation}`).join("\n") +
        (screeningCandidates.length > top.length ? `\n  + ${screeningCandidates.length - top.length} more` : ""),
      );
    }
  }

  const dateStr = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const subject = `Your daily Lexy digest — ${totalCandidatesScreened} candidate${totalCandidatesScreened === 1 ? "" : "s"} ready, ${totalAdvance} top picks`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;max-width:680px;margin:0 auto;padding:24px;">
    <h2 style="margin:0 0 4px 0;">Good morning, ${escapeHtml(recruiter.name?.split(" ")[0] || "there")} 👋</h2>
    <p style="margin:0 0 8px 0;color:#666;font-size:13px;">${dateStr}</p>
    <p style="margin:0 0 16px 0;color:#444;">
      Here's what Lexy worked on for you over the last day. <b>${totalCandidatesScreened}</b> candidate${totalCandidatesScreened === 1 ? "" : "s"} ${totalCandidatesScreened === 1 ? "is" : "are"} now in the Screening column across <b>${jobIds.length}</b> job${jobIds.length === 1 ? "" : "s"} — <b style="color:#16a34a;">${totalAdvance}</b> ${totalAdvance === 1 ? "is" : "are"} recommended to advance.
    </p>
    ${sections.join("")}
    <p style="margin:32px 0 0 0;color:#888;font-size:12px;border-top:1px solid #eee;padding-top:16px;">
      You're receiving daily digests because that's your notification preference. Want real-time alerts instead, or to mute these? Open <a href="${process.env.PUBLIC_APP_URL || ""}/settings/notifications" style="color:#2563eb;">notification settings</a>.
    </p>
    <p style="margin:8px 0 0 0;color:#888;font-size:12px;">— Lexy, your AI hiring co-pilot</p>
  </body></html>`;

  const text =
    `Your daily Lexy digest — ${dateStr}\n\n` +
    `${totalCandidatesScreened} candidate(s) screened across ${jobIds.length} job(s) · ${totalAdvance} recommended to advance\n\n` +
    textSections.join("\n\n");

  await sendEmail({
    to: recruiter.email,
    subject,
    html,
    text,
    audit: {
      tenantId: recruiter.tenantId,
      actorLabel: "Lexy Digest",
      subjectType: "user",
      subjectId: recruiter.id,
      subjectLabel: recruiter.name || recruiter.email,
      action: "digest.recruiter.daily_sent",
      metadata: {
        itemCount: items.length,
        jobCount: jobIds.length,
        totalCandidatesScreened,
        totalAdvance,
        eventTypes: Array.from(new Set(items.map((it) => it.eventType))),
      },
    },
  });

  void recordAudit({
    tenantId: recruiter.tenantId,
    actorType: "system",
    actorLabel: "Lexy Digest",
    subjectType: "user",
    subjectId: recruiter.id,
    subjectLabel: recruiter.name || recruiter.email,
    channel: "in_app",
    direction: "internal",
    action: "digest.queue.drained",
    title: `Drained ${items.length} digest item${items.length === 1 ? "" : "s"}`,
    body: `Across ${jobIds.length} job(s).`,
    metadata: { itemCount: items.length, jobCount: jobIds.length },
  });
}

/** True when the recruiter's local clock is at or past the delivery hour today. */
function isAtOrPastDeliveryHour(timezone: string): boolean {
  try {
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hour: "2-digit", hour12: false,
    }).format(new Date());
    // Intl returns "24" for midnight in some locales; treat 24 as 0.
    const hour = parseInt(hourStr, 10) % 24;
    return hour >= DELIVERY_HOUR_LOCAL;
  } catch {
    return new Date().getUTCHours() >= DELIVERY_HOUR_LOCAL;
  }
}

/**
 * True if this recruiter has already received a digest dated "today" in
 * their local timezone. We compare the YYYY-MM-DD strings rendered in
 * `timezone` so daylight-savings transitions and date-line crossings work
 * correctly without any date math.
 */
function hasReceivedTodaysDigest(lastSentAt: Date | null | undefined, timezone: string): boolean {
  if (!lastSentAt) return false;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    });
    return fmt.format(lastSentAt) === fmt.format(new Date());
  } catch {
    return lastSentAt.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
