/**
 * weekly-digest-scheduler.ts — "Your week on Lexy" candidate digest
 *
 * Once per week, sends each active platform candidate a digest summarising:
 *   • Recruiter views in the last 7 days
 *   • Their fuzzy peer band (country + global)
 *   • Any new achievements earned
 *   • Top 1-2 next best actions
 *
 * Frequency control: candidates.weekly_digest_last_sent_at — minimum 6 days
 * between sends, so dropping the scheduler interval to "every hour" still
 * sends each candidate at most once a week.
 */
import { db } from "@workspace/db";
import {
  candidatesTable,
  candidateAchievementsTable,
  candidateActionEventsTable,
  candidateNotificationsTable,
} from "@workspace/db";
import { eq, and, sql, gte, isNull } from "drizzle-orm";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import { getLatestPeerSnapshot } from "./peer-percentile.js";
import { awardAchievements } from "./achievement-engine.js";
import { PLATFORM_READ_EXEMPTION, platformReadExemption } from "./platform-pool-read.js";
import { getViewerPrivacySeal, countSealedRecruiterViews } from "./viewer-privacy.js";

const PORTAL_URL =
  process.env.CANDIDATE_PORTAL_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/portal`
    : "https://lexy.ai/portal");

const MIN_DAYS_BETWEEN_DIGESTS = 6;

function emailStyles(): string {
  return `
    body{margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;}
    .wrapper{max-width:600px;margin:0 auto;padding:32px 24px;}
    .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:36px;}
    .logo{color:#00d4ff;font-size:20px;font-weight:800;letter-spacing:-0.5px;margin-bottom:8px;}
    .kicker{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:0.12em;font-weight:600;margin-bottom:24px;}
    h1{color:#f0f6fc;font-size:24px;font-weight:700;margin:0 0 12px;line-height:1.25;}
    p{color:#8b949e;font-size:15px;line-height:1.65;margin:0 0 16px;}
    .hl{color:#f0f6fc;}
    .stat-row{display:flex;gap:12px;margin:18px 0;}
    .stat{flex:1;background:#0d1117;border:1px solid #21262d;border-radius:10px;padding:16px;text-align:center;}
    .stat .n{color:#00d4ff;font-size:26px;font-weight:800;display:block;line-height:1;margin-bottom:4px;}
    .stat .l{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;}
    .badge-row{margin:18px 0;}
    .pband{display:inline-block;padding:8px 14px;border-radius:8px;background:#00d4ff15;color:#00d4ff;
           border:1px solid #00d4ff35;font-weight:600;font-size:13px;margin:0 8px 8px 0;}
    .ach{background:#0d1117;border:1px solid #21262d;border-radius:10px;padding:14px 16px;margin:8px 0;display:flex;gap:12px;align-items:center;}
    .ach-emoji{font-size:24px;line-height:1;}
    .ach-title{color:#f0f6fc;font-weight:700;font-size:14px;display:block;margin-bottom:2px;}
    .ach-desc{color:#8b949e;font-size:12px;margin:0;}
    .cta{display:inline-block;background:#00d4ff;color:#0d1117;font-size:14px;font-weight:700;
         padding:13px 30px;border-radius:8px;text-decoration:none;margin:8px 0 24px;}
    hr{border:none;border-top:1px solid #21262d;margin:24px 0;}
    .footer{color:#484f58;font-size:12px;text-align:center;margin-top:24px;line-height:1.5;}
    a.quiet{color:#484f58;}
  `;
}

const ICON_EMOJI: Record<string, string> = {
  trophy: "🏆", sparkles: "✨", "file-text": "📄", mic: "🎤",
  "check-circle-2": "✅", shield: "🛡️", target: "🎯", send: "🚀",
  rocket: "🚀", eye: "👀", star: "⭐", flame: "🔥", zap: "⚡",
};

interface DigestPayload {
  firstName: string;
  recruiterViews7d: number;
  /* Mocks completed in the last 7 days — brochure Achievements slide example
     digest line: "3 mocks completed · skill score +6 · 14 recruiters viewed
     you · 1 new target-company role opened." */
  mocksCompleted7d: number;
  /* Roles opened at any of the candidate's saved target companies in the
     last 7 days. Same brochure example line. */
  roleOpens7d: number;
  bandCountry: string | null;
  bandGlobal: string | null;
  countryName: string | null;
  newAchievements: { title: string; description: string; icon: string }[];
}

function buildDigestEmail(p: DigestPayload): { subject: string; html: string } {
  const subject = p.recruiterViews7d > 0
    ? `${p.firstName}, ${p.recruiterViews7d} recruiter${p.recruiterViews7d === 1 ? "" : "s"} viewed your profile this week`
    : `${p.firstName}, your week on Lexy`;

  const peerLine =
    (p.bandCountry || p.bandGlobal)
      ? `<div class="badge-row">
          ${p.bandCountry ? `<span class="pband">${p.bandCountry}${p.countryName ? ` in ${p.countryName}` : ""}</span>` : ""}
          ${p.bandGlobal  ? `<span class="pband">${p.bandGlobal} globally</span>` : ""}
        </div>`
      : "";

  const achievementsBlock = p.newAchievements.length
    ? `<p style="margin-top:18px;"><span class="hl" style="font-weight:700;">New badges this week 🎉</span></p>` +
      p.newAchievements.map(a => `
        <div class="ach">
          <span class="ach-emoji">${ICON_EMOJI[a.icon] ?? "🏆"}</span>
          <div>
            <span class="ach-title">${a.title}</span>
            <p class="ach-desc">${a.description}</p>
          </div>
        </div>`).join("")
    : "";

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${emailStyles()}</style></head>
<body><div class="wrapper"><div class="card">
  <div class="logo">L3XY</div>
  <div class="kicker">Your week on Lexy</div>
  <h1>${p.firstName}, here's how your week looked.</h1>
  <p>A quick snapshot of your career momentum on the platform — keep it going!</p>

  <div class="stat-row">
    <div class="stat">
      <span class="n">${p.mocksCompleted7d}</span>
      <span class="l">Mocks done</span>
    </div>
    <div class="stat">
      <span class="n">${p.recruiterViews7d}</span>
      <span class="l">Recruiter views</span>
    </div>
    <div class="stat">
      <span class="n">${p.roleOpens7d}</span>
      <span class="l">Target-co roles</span>
    </div>
    <div class="stat">
      <span class="n">${p.newAchievements.length}</span>
      <span class="l">New badges</span>
    </div>
  </div>

  ${peerLine}

  ${achievementsBlock}

  <p style="margin-top:24px;">Open your portal to see your full progress, new matched opportunities, and what to do next.</p>
  <a href="${PORTAL_URL}" class="cta">Open my portal →</a>
  <hr>
  <p style="font-size:13px;">You're receiving this weekly recap because you're an active candidate on Lexy.</p>
</div>
<div class="footer">
  Lexy AI Hiring Platform<br>
  <a href="${PORTAL_URL}/settings" class="quiet">Email preferences</a>
</div></div></body></html>`;

  return { subject, html };
}

export async function runWeeklyDigest(): Promise<{ sent: number; skipped: number }> {
  logger.info("[weekly-digest] Starting weekly digest run");

  const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);

  /* Reads the whole platform pool to email each candidate THEIR OWN weekly
     digest — self-directed candidate messaging, not an employer-facing read,
     so the employer-visibility seal does not apply. Erased candidates are
     excluded AT THE QUERY (isNull(dataErasedAt)) so a GDPR-erased record is
     never even loaded; do-not-contact is suppressed per-row in the loop below. */
  platformReadExemption(PLATFORM_READ_EXEMPTION.SELF_DIRECTED_CANDIDATE_MESSAGING);
  const platformCandidates = await db
    .select()
    .from(candidatesTable)
    .where(and(
      eq((candidatesTable as any).pool, "platform"),
      isNull((candidatesTable as any).dataErasedAt),
    ));

  let sent = 0;
  let skipped = 0;

  for (const cand of platformCandidates) {
    if (!cand.email || (cand as any).doNotContact) { skipped++; continue; }

    const lastSent = (cand as any).weeklyDigestLastSentAt
      ? new Date((cand as any).weeklyDigestLastSentAt)
      : null;
    if (lastSent) {
      const daysSince = (Date.now() - lastSent.getTime()) / 86_400_000;
      if (daysSince < MIN_DAYS_BETWEEN_DIGESTS) { skipped++; continue; }
    }

    /* Award any newly-qualifying badges so they can be celebrated in the digest. */
    const newlyEarned = await awardAchievements(cand.id).catch(() => []);

    /* Viewer-privacy seal (lib/viewer-privacy.ts): the digest's "N recruiters
       viewed you" line must honour the candidate's CURRENT privacy settings —
       paused → 0, blocked/hidden viewer tenants excluded from the count. */
    const viewerSeal = await getViewerPrivacySeal(cand.id);
    const recruiterViews7d = await countSealedRecruiterViews(cand.id, sevenDaysAgo, viewerSeal);

    /* Mocks completed in the last 7 days — brochure example digest line
       starts with "3 mocks completed". Same event-type the achievement engine
       already counts; just bounded to the trailing week. */
    const [{ count: mocksCompleted7d = 0 } = {}] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(candidateActionEventsTable)
      .where(and(
        eq(candidateActionEventsTable.candidateId, cand.id),
        eq(candidateActionEventsTable.eventType, "mock_interview_completed"),
        gte(candidateActionEventsTable.createdAt, sevenDaysAgo),
      ));

    /* Target-company role opens in the last 7 days — brochure example digest
       line ends with "1 new target-company role opened". Same event-type the
       engagement endpoint already records when a tenant opens a job that
       matches one of the candidate's saved target companies. */
    const [{ count: roleOpens7d = 0 } = {}] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(candidateActionEventsTable)
      .where(and(
        eq(candidateActionEventsTable.candidateId, cand.id),
        eq(candidateActionEventsTable.eventType, "role_open_at_target"),
        gte(candidateActionEventsTable.createdAt, sevenDaysAgo),
      ));

    /* Pull badges earned in last 7 days (includes newlyEarned) for the digest. */
    const recentBadges = await db
      .select()
      .from(candidateAchievementsTable)
      .where(and(
        eq(candidateAchievementsTable.candidateId, cand.id),
        gte(candidateAchievementsTable.earnedAt, sevenDaysAgo),
      ));

    /* Skip empty digests — nothing meaningful happened this week. */
    if (
      recruiterViews7d === 0 &&
      recentBadges.length === 0 &&
      mocksCompleted7d === 0 &&
      roleOpens7d === 0
    ) { skipped++; continue; }

    const peer = await getLatestPeerSnapshot(cand.id);

    const payload: DigestPayload = {
      firstName: cand.firstName ?? "there",
      recruiterViews7d,
      mocksCompleted7d,
      roleOpens7d,
      bandCountry: peer?.bandCountry ?? null,
      bandGlobal:  peer?.bandGlobal  ?? null,
      countryName: peer?.country ?? null,
      newAchievements: recentBadges.map(b => ({
        title: b.title, description: b.description, icon: b.icon,
      })),
    };

    const { subject, html } = buildDigestEmail(payload);

    const result = await sendEmail({
      to: cand.email,
      subject,
      html,
      audit: {
        tenantId: "platform",
        actorLabel: "Weekly Digest Scheduler",
        subjectType: "candidate",
        subjectId: cand.id,
        subjectLabel: `${payload.firstName} ${cand.lastName ?? ""}`.trim(),
        action: "weekly_digest.send",
        metadata: {
          recruiterViews7d,
          mocksCompleted7d,
          roleOpens7d,
          newBadges: payload.newAchievements.length,
          peerBandCountry: payload.bandCountry,
          peerBandGlobal: payload.bandGlobal,
        },
      },
    });

    if (result.ok) {
      await db
        .update(candidatesTable)
        .set({ weeklyDigestLastSentAt: new Date() } as any)
        .where(eq(candidatesTable.id, cand.id));

      /* Mirror the digest into the candidate's in-app notification center so
         it lands as a Sunday "recap moment" in the bell icon even when their
         email client is closed (or SES isn't configured in dev). One row per
         send — keyed by the email send itself, so the 6-day floor naturally
         prevents notification spam. */
      try {
        /* Force tenantId="platform" for platform-pool candidates so the
           bell-icon notification stays in the same partition as every other
           platform-pool record (recruiter-views, achievements, etc.) — even
           if a legacy candidate row carries a non-platform tenantId from
           early-days seeding. Avoids cross-tenant partition drift. */
        const notifTenantId =
          (cand as any).pool === "platform" ? "platform" : ((cand as any).tenantId ?? "platform");
        await db.insert(candidateNotificationsTable).values({
          tenantId: notifTenantId,
          candidateId: cand.id,
          type: "weekly_digest",
          title: subject,
          message: (() => {
            /* Brochure-aligned recap: "3 mocks completed · 14 recruiters
               viewed you · 1 new target-co role · 1 new badge." Only
               include parts with non-zero counts so the sentence stays
               natural when nothing happened on a dimension. */
            const parts: string[] = [];
            if (payload.mocksCompleted7d > 0) {
              parts.push(`${payload.mocksCompleted7d} mock${payload.mocksCompleted7d === 1 ? "" : "s"} completed`);
            }
            if (payload.recruiterViews7d > 0) {
              parts.push(`${payload.recruiterViews7d} recruiter${payload.recruiterViews7d === 1 ? "" : "s"} viewed you`);
            }
            if (payload.roleOpens7d > 0) {
              parts.push(`${payload.roleOpens7d} new target-co role${payload.roleOpens7d === 1 ? "" : "s"}`);
            }
            if (payload.newAchievements.length > 0) {
              parts.push(`${payload.newAchievements.length} new badge${payload.newAchievements.length === 1 ? "" : "s"}`);
            }
            return parts.length > 0
              ? `${parts.join(" · ")}.`
              : "Your week on Lexy — keep going.";
          })(),
          isRead: false,
          actionUrl: "/portal",
        } as any);
      } catch (err: any) {
        logger.warn({ err: err?.message, candidateId: cand.id }, "[weekly-digest] in-app notification insert failed");
      }

      sent++;
    } else {
      logger.warn({ candidateId: cand.id, err: result.error }, "[weekly-digest] send failed");
    }
  }

  logger.info({ sent, skipped }, "[weekly-digest] Run complete");
  return { sent, skipped };
}

let _timer: ReturnType<typeof setTimeout> | null = null;

export function startWeeklyDigestScheduler(): void {
  /* Wake every hour and let the per-candidate 6-day floor decide who actually
     gets a send. This keeps the digest spread out across the week instead of
     hammering SES in a single Sunday-night burst. */
  const INTERVAL_MS = 60 * 60 * 1000;
  const INITIAL_DELAY_MS = 8 * 60 * 1000; // 8 min after boot

  const runLoop = async () => {
    try {
      await runWeeklyDigest();
    } catch (err: any) {
      logger.error({ err: err?.message }, "[weekly-digest] scheduler error");
    }
    _timer = setTimeout(runLoop, INTERVAL_MS);
  };

  _timer = setTimeout(runLoop, INITIAL_DELAY_MS);
  logger.info("[weekly-digest-scheduler] Started — runs hourly, ≥6d per candidate");
}
