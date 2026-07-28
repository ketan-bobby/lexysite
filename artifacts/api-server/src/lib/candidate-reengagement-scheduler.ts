/**
 * candidate-reengagement-scheduler.ts — Platform Candidate Re-engagement
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Monitors platform-pool candidates for inactivity and sends them personalised
 * re-engagement emails to keep their profiles visible to recruiters.
 *
 * ─── Activity thresholds ─────────────────────────────────────────────────────
 *   Passive  (30–89 days inactive)  — "Are you still looking?" email
 *                                     Resent at most every 30 days
 *   Inactive (90+ days inactive)    — "Your profile is losing visibility" email
 *                                     Resent at most every 60 days
 *
 * "Last active" is the maximum of the candidate's updatedAt and their latest
 * talent_pool_submissions.pushed_at — a recent push counts as activity even if
 * the candidate hasn't personally touched their profile.
 *
 * ─── DNC / safety guards ─────────────────────────────────────────────────────
 * Candidates with do_not_contact=true or no email are silently skipped.
 * Send intervals are enforced by checking communication_events for the most
 * recent re_engagement type email per candidate.
 *
 * ─── Schedule ────────────────────────────────────────────────────────────────
 * First run is delayed 5 minutes after boot (other services need to warm up).
 * Subsequent runs are every 24 hours.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/index.ts — startCandidateReengagementScheduler() on server boot
 */
import { db } from "@workspace/db";
import {
  candidatesTable,
  communicationEventsTable,
  talentPoolSubmissionsTable,
} from "@workspace/db";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import { PLATFORM_READ_EXEMPTION, platformReadExemption } from "./platform-pool-read.js";

const PASSIVE_THRESHOLD_DAYS  = 30;
const INACTIVE_THRESHOLD_DAYS = 90;
const PASSIVE_REMAIL_INTERVAL  = 30;
const INACTIVE_REMAIL_INTERVAL = 60;

const PORTAL_URL =
  process.env.CANDIDATE_PORTAL_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/portal`
    : "https://lexy.ai/portal");

/* ─── Email templates ───────────────────────────────────────────────── */
function emailStyles(): string {
  return `
    body{margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;}
    .wrapper{max-width:600px;margin:0 auto;padding:32px 24px;}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:36px;}
    .logo{color:#00d4ff;font-size:20px;font-weight:800;letter-spacing:-0.5px;margin-bottom:28px;}
    h1{color:#f0f6fc;font-size:22px;font-weight:700;margin:0 0 14px;line-height:1.3;}
    p{color:#8b949e;font-size:15px;line-height:1.7;margin:0 0 16px;}
    .hl{color:#f0f6fc;}
    .cta{display:inline-block;background:#00d4ff;color:#0d1117;font-size:14px;font-weight:700;
         padding:13px 30px;border-radius:8px;text-decoration:none;margin:8px 0 24px;}
    .badge{display:inline-block;padding:4px 14px;border-radius:100px;font-size:12px;font-weight:600;margin-bottom:20px;}
    .b-passive{background:#f59e0b20;color:#f59e0b;border:1px solid #f59e0b40;}
    .b-inactive{background:#ef444420;color:#ef4444;border:1px solid #ef444440;}
    hr{border:none;border-top:1px solid #21262d;margin:24px 0;}
    .footer{color:#484f58;font-size:12px;text-align:center;margin-top:24px;line-height:1.5;}
    a.quiet{color:#484f58;}
  `;
}

function buildPassiveEmail(firstName: string): { subject: string; html: string } {
  const subject = `${firstName}, are you still open to new opportunities?`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${emailStyles()}</style></head>
<body><div class="wrapper"><div class="card">
  <div class="logo">L3XY</div>
  <span class="badge b-passive">● Passive</span>
  <h1>Are you still open to new opportunities?</h1>
  <p>Hi <span class="hl">${firstName}</span>,</p>
  <p>Your Lexy profile hasn't been updated in a while. Recruiters and hiring teams actively browse the platform pool — <span class="hl">staying active dramatically increases your chances of being matched to the right role.</span></p>
  <p>It takes less than a minute to confirm you're still looking and refresh your visibility score:</p>
  <a href="${PORTAL_URL}" class="cta">I'm still looking →</a>
  <hr>
  <p style="font-size:13px;">If you've already found a role, log in to update your status so we stop sending you opportunities.</p>
</div>
<div class="footer">
  Lexy AI Hiring Platform · You're receiving this because you're in the platform candidate pool.<br>
  <a href="${PORTAL_URL}" class="quiet">Manage your profile</a>
</div></div></body></html>`;
  return { subject, html };
}

function buildInactiveEmail(firstName: string): { subject: string; html: string } {
  const subject = `${firstName}, your profile is losing recruiter visibility`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${emailStyles()}</style></head>
<body><div class="wrapper"><div class="card">
  <div class="logo">L3XY</div>
  <span class="badge b-inactive">● Inactive</span>
  <h1>Your profile is losing recruiter visibility</h1>
  <p>Hi <span class="hl">${firstName}</span>,</p>
  <p>Your Lexy profile has been inactive for over 90 days. <span class="hl">Inactive profiles are ranked below equally-matched active candidates</span> in recruiter searches and AI matching. You'll still appear for roles you're a strong fit for — just lower down the list than candidates who've been recently active.</p>
  <p>A quick visit to your portal is all it takes to restore your Active status and get back in front of hiring teams:</p>
  <a href="${PORTAL_URL}" class="cta">Restore my visibility →</a>
  <hr>
  <p style="font-size:13px;">Log in to update your profile, confirm you're still looking, or close your account if you've found a new role.</p>
</div>
<div class="footer">
  Lexy AI Hiring Platform · You're receiving this because you're in the platform candidate pool.<br>
  <a href="${PORTAL_URL}" class="quiet">Manage your profile</a>
</div></div></body></html>`;
  return { subject, html };
}

/* ─── Core logic ────────────────────────────────────────────────────── */
export async function runCandidateReengagement(): Promise<{ sent: number; skipped: number }> {
  logger.info("[reengagement] Starting candidate re-engagement run");

  /* Reads the whole platform pool to send each candidate THEIR OWN
     re-engagement nudge — self-directed candidate messaging, not an
     employer-facing read, so the employer-visibility seal does not apply.
     Erased candidates are excluded AT THE QUERY (isNull(dataErasedAt)) so a
     GDPR-erased record is never even loaded; do-not-contact is suppressed
     per-row before send (see the `doNotContact` guard in the loop below). */
  platformReadExemption(PLATFORM_READ_EXEMPTION.SELF_DIRECTED_CANDIDATE_MESSAGING);
  const platformCandidates = await db
    .select()
    .from(candidatesTable)
    .where(and(
      eq((candidatesTable as any).pool, "platform"),
      isNull((candidatesTable as any).dataErasedAt),
    ));

  if (platformCandidates.length === 0) {
    logger.info("[reengagement] No platform candidates — skipping");
    return { sent: 0, skipped: 0 };
  }

  const candidateIds = platformCandidates.map(c => c.id);

  // Batch-fetch last pushed_at per candidate
  const pushRows = await db
    .select({
      candidateId: (talentPoolSubmissionsTable as any).candidateId,
      maxPushedAt: sql<string>`MAX(${(talentPoolSubmissionsTable as any).pushedAt})`,
    })
    .from(talentPoolSubmissionsTable)
    .where(inArray((talentPoolSubmissionsTable as any).candidateId, candidateIds))
    .groupBy((talentPoolSubmissionsTable as any).candidateId);

  const lastPushMap = new Map<string, Date>();
  for (const row of pushRows) {
    if (row.candidateId && row.maxPushedAt) {
      lastPushMap.set(row.candidateId, new Date(row.maxPushedAt));
    }
  }

  // Batch-fetch last re-engagement email per candidate
  const reRows = await db
    .select({
      candidateId: communicationEventsTable.candidateId,
      maxSentAt: sql<string>`MAX(${communicationEventsTable.sentAt})`,
    })
    .from(communicationEventsTable)
    .where(
      and(
        eq(communicationEventsTable.type, "re_engagement"),
        inArray(communicationEventsTable.candidateId, candidateIds),
      )
    )
    .groupBy(communicationEventsTable.candidateId);

  const lastReengagementMap = new Map<string, Date>();
  for (const row of reRows) {
    if (row.candidateId && row.maxSentAt) {
      lastReengagementMap.set(row.candidateId, new Date(row.maxSentAt));
    }
  }

  const now = Date.now();
  let sent = 0;
  let skipped = 0;

  for (const candidate of platformCandidates) {
    if (!candidate.email || (candidate as any).doNotContact) {
      skipped++;
      continue;
    }

    // Compute activity
    const updatedDate = new Date(candidate.updatedAt as any);
    const lastPush    = lastPushMap.get(candidate.id);
    const lastActive  = lastPush && lastPush > updatedDate ? lastPush : updatedDate;
    const daysSince   = Math.floor((now - lastActive.getTime()) / 86_400_000);

    const isPassive  = daysSince >= PASSIVE_THRESHOLD_DAYS && daysSince < INACTIVE_THRESHOLD_DAYS;
    const isInactive = daysSince >= INACTIVE_THRESHOLD_DAYS;

    if (!isPassive && !isInactive) { skipped++; continue; }

    // Respect send-interval to avoid spamming
    const lastRe      = lastReengagementMap.get(candidate.id);
    const intervalDays = isInactive ? INACTIVE_REMAIL_INTERVAL : PASSIVE_REMAIL_INTERVAL;
    if (lastRe) {
      const daysSinceRe = Math.floor((now - lastRe.getTime()) / 86_400_000);
      if (daysSinceRe < intervalDays) { skipped++; continue; }
    }

    const firstName = candidate.firstName ?? "there";
    const status    = isInactive ? "inactive" : "passive";
    const { subject, html } = isInactive
      ? buildInactiveEmail(firstName)
      : buildPassiveEmail(firstName);

    const result = await sendEmail({
      to: candidate.email,
      subject,
      html,
      audit: {
        tenantId: "platform",
        actorLabel: "Re-engagement Scheduler",
        subjectType: "candidate",
        subjectId: candidate.id,
        subjectLabel: `${firstName} ${candidate.lastName ?? ""}`.trim(),
        action: "reengagement.send",
        metadata: { activityStatus: status, daysSince },
      },
    });

    if (result.ok) {
      await db.insert(communicationEventsTable).values({
        tenantId:    "platform",
        candidateId: candidate.id,
        type:        "re_engagement",
        channel:     "email",
        status:      "sent",
        subject,
        body:        `Re-engagement (${status}, ${daysSince}d inactive)`,
        sentAt:      new Date(),
      } as any);
      sent++;
      logger.info({ candidateId: candidate.id, status, daysSince }, "[reengagement] Sent email");
    } else {
      logger.warn({ candidateId: candidate.id, error: result.error }, "[reengagement] Send failed");
    }
  }

  logger.info({ sent, skipped }, "[reengagement] Run complete");
  return { sent, skipped };
}

/* ─── Scheduler ─────────────────────────────────────────────────────── */
let _timer: ReturnType<typeof setTimeout> | null = null;

export function startCandidateReengagementScheduler(): void {
  const INTERVAL_MS      = 24 * 60 * 60 * 1000;
  const INITIAL_DELAY_MS =  5 * 60 * 1000;      // first run 5 min after boot

  const runLoop = async () => {
    try {
      await runCandidateReengagement();
    } catch (err: any) {
      logger.error({ err: err.message }, "[reengagement] Scheduler error");
    }
    _timer = setTimeout(runLoop, INTERVAL_MS);
  };

  _timer = setTimeout(runLoop, INITIAL_DELAY_MS);
  logger.info("[reengagement-scheduler] Started — runs every 24 hours");
}
