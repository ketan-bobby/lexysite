/**
 * linkedin-profile-monitor.ts — Candidate Status Check-in Engine
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Monitors candidates across every pool who haven't updated their profile in
 * 6+ months and sends a warm "has anything changed?" status check-in email
 * inviting them to update their profile. Runs daily.
 *
 * LinkedIn scanning is OPTIONAL and off by default: only when
 * ENRICH_LAYER_API_KEY is configured AND a candidate has a linkedinUrl does the
 * engine fetch live LinkedIn data first — in that case a detected job change
 * upgrades the email to a congratulations message. Without the key (the normal
 * configuration) no third-party lookup happens at all; every eligible
 * candidate simply receives the check-in email.
 *
 * Branding is applied per ownership: platform-pool candidates receive Lexy-
 * branded emails; tenant-pool candidates receive their owning tenant's branding
 * (name + primary colour) so the outreach never appears to come from Lexy. The
 * audit log and communication_events rows are tagged with each candidate's real
 * tenantId (not a hardcoded "platform").
 *
 * ─── Processing pipeline ─────────────────────────────────────────────────────
 *   1. Find all candidates with an email, updatedAt ≥ 6 months ago, and not
 *      contact-barred (GDPR-erased / do-not-contact are excluded)
 *   2. Filter out any candidate emailed within the last 90 days (cooldown)
 *   3. For each eligible candidate:
 *      a. If ENRICH_LAYER_API_KEY is set and they have a linkedinUrl, fetch
 *         their LinkedIn data and run detectJobChange(); a detected change
 *         sends a congratulations email instead
 *      b. Otherwise (the default) → send the status check-in email
 *      c. Write a communication_events row so the 90-day cooldown is enforced
 *
 * ─── detectJobChange() ───────────────────────────────────────────────────────
 * Compares the most recent experience entry (index 0 = current) from the
 * Enrich Layer response against what's stored in candidates.current_title and
 * current_company. Case-insensitive, whitespace-normalised comparison.
 *
 * ─── Scheduler ───────────────────────────────────────────────────────────────
 * First run is delayed 15 minutes after boot. Subsequent runs are every 24 hours.
 * getLastLinkedInScanResult() returns the result of the most recent run for the
 * admin dashboard.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/index.ts        — startLinkedInProfileMonitor() on server boot
 *   routes/sourcing.ts  — runLinkedInProfileMonitor() for manual trigger
 */
import { db } from "@workspace/db";
import { candidatesTable, communicationEventsTable, tenantsTable } from "@workspace/db";
import { eq, and, isNotNull, sql, inArray } from "drizzle-orm";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import { compliantCandidatePredicate } from "./compliance-scope.js";

/* ── Config ──────────────────────────────────────────────────────────────── */
const STALE_THRESHOLD_DAYS   = 180; // profile not updated in 6+ months → eligible for LinkedIn check
const ENGAGEMENT_COOLDOWN_DAYS = 90; // skip if we emailed them within the last 90 days

const PORTAL_URL =
  process.env.CANDIDATE_PORTAL_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/portal`
    : "https://lexy.ai/portal");

/* ── Enrich Layer — LinkedIn profile lookup ──────────────────────────────── */
interface EnrichLayerProfile {
  first_name?:   string;
  last_name?:    string;
  full_name?:    string;
  headline?:     string;
  occupation?:   string;
  experiences?:  Array<{
    title?:      string;
    company?:    string;
    starts_at?:  { year?: number; month?: number; day?: number } | null;
    ends_at?:    { year?: number; month?: number; day?: number } | null;
  }>;
}

async function fetchLinkedInViaEnrichLayer(linkedinUrl: string): Promise<EnrichLayerProfile | null> {
  const apiKey = process.env.ENRICH_LAYER_API_KEY;
  if (!apiKey) {
    logger.warn("[linkedin-monitor] ENRICH_LAYER_API_KEY not set — skipping lookup");
    return null;
  }

  try {
    const url = `https://enrichlayer.com/api/v2/profile?url=${encodeURIComponent(linkedinUrl)}`;
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(tid);

    if (!res.ok) {
      logger.warn({ status: res.status }, "[linkedin-monitor] Enrich Layer returned non-200");
      return null;
    }

    const data = await res.json() as EnrichLayerProfile;
    logger.info(
      { headline: data.headline, occupation: data.occupation },
      "[linkedin-monitor] Enrich Layer profile fetched",
    );
    return data;
  } catch (err: any) {
    logger.warn({ err: err.message }, "[linkedin-monitor] Enrich Layer fetch error");
    return null;
  }
}

/* ── Job-change detection (no AI needed — structured data) ───────────────── */
interface JobChangeResult {
  currentTitle:   string | null;
  currentCompany: string | null;
  jobChanged:     boolean;
}

function detectJobChange(
  profile:       EnrichLayerProfile,
  storedTitle:   string | null,
  storedCompany: string | null,
): JobChangeResult {
  /* Prefer the most recent experience entry (first in array = current) */
  const latestExp = profile.experiences?.[0];
  const currentTitle   = latestExp?.title   ?? profile.occupation ?? null;
  const currentCompany = latestExp?.company ?? null;

  if (!currentTitle && !currentCompany) {
    return { currentTitle: null, currentCompany: null, jobChanged: false };
  }

  const normalize = (s: string | null | undefined) =>
    (s ?? "").toLowerCase().trim().replace(/\s+/g, " ");

  const titleChanged   = currentTitle   && normalize(currentTitle)   !== normalize(storedTitle);
  const companyChanged = currentCompany && normalize(currentCompany) !== normalize(storedCompany);

  return {
    currentTitle,
    currentCompany,
    jobChanged: !!(titleChanged || companyChanged),
  };
}

/* ── Branding ────────────────────────────────────────────────────────────────
 * The monitor scans candidates across every pool. Platform-pool candidates get
 * Lexy branding; tenant-pool candidates get their owning tenant's branding so
 * the outreach reads as coming from the recruiter's own brand, never Lexy's. */
export interface Brand {
  /** Masthead text shown at the top of the email. */
  logoText:  string;
  /** Name used inline in body copy ("your <name> profile"). */
  name:      string;
  /** Accent colour for the logo + CTA button. */
  accent:    string;
  /** CTA button text colour (chosen for contrast against `accent`). */
  ctaText:   string;
  /** Footer line, including the "why you're receiving this" reason. */
  footer:    string;
}

export const LEXY_BRAND: Brand = {
  logoText: "L3XY",
  name:     "Lexy",
  accent:   "#00d4ff",
  ctaText:  "#0d1117",
  footer:   "Lexy AI Hiring Platform · You're receiving this because you're in our platform pool.",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only accept #rgb / #rrggbb hex so a tenant value can't inject arbitrary CSS
 *  into the email's <style> block. Anything else falls back to a neutral blue. */
function normalizeHexColor(c: string | null): string | null {
  if (!c) return null;
  const s = c.trim();
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s) ? s : null;
}

/** Pick a CTA text colour that stays legible on the given accent background. */
function contrastText(hex: string): string {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0d1117" : "#ffffff";
}

export function tenantBrand(name: string, primaryColor: string | null): Brand {
  const safe   = escapeHtml(name);
  const accent = normalizeHexColor(primaryColor) ?? "#3b82f6";
  return {
    logoText: safe,
    name:     safe,
    accent,
    ctaText:  contrastText(accent),
    footer:   `${safe} · You're receiving this because you're part of ${safe}'s talent network.`,
  };
}

/* ── Email templates ─────────────────────────────────────────────────────── */
const emailBase = `
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
  hr{border:none;border-top:1px solid #21262d;margin:24px 0;}
  .footer{color:#484f58;font-size:12px;text-align:center;margin-top:24px;line-height:1.5;}
  a.quiet{color:#484f58;}
`;

export function buildJobChangeEmail(
  firstName:  string,
  newTitle:   string | null,
  newCompany: string | null,
  brand:      Brand,
): { subject: string; html: string } {
  const roleInfo =
    newTitle && newCompany
      ? `as <strong style="color:#f0f6fc">${newTitle}</strong> at <strong style="color:#f0f6fc">${newCompany}</strong>`
      : newTitle
      ? `as <strong style="color:#f0f6fc">${newTitle}</strong>`
      : "in a new role";

  const subject = `Congratulations on your new chapter, ${firstName}!`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${emailBase}
  .badge{background:#10b98120;color:#10b981;border:1px solid #10b98140;}
  .logo{color:${brand.accent};}
  .cta{background:${brand.accent};color:${brand.ctaText};}
</style></head>
<body><div class="wrapper"><div class="card">
  <div class="logo">${brand.logoText}</div>
  <span class="badge">✦ New Role Detected</span>
  <h1>Congratulations on your new role!</h1>
  <p>Hi <span class="hl">${firstName}</span>,</p>
  <p>We noticed your LinkedIn profile shows you're now ${roleInfo} — fantastic news! We wanted to be the first to say congratulations.</p>
  <p>Your ${brand.name} profile still shows your previous position. Keeping it current means you're always in the best position for your next move, whenever that might be:</p>
  <a href="${PORTAL_URL}" class="cta">Update my ${brand.name} profile →</a>
  <hr>
  <p style="font-size:13px;">It takes under 2 minutes. You can also update your status to "not looking" if you're happy where you are — we'll respect that and adjust accordingly.</p>
</div>
<div class="footer">
  ${brand.footer}<br>
  <a href="${PORTAL_URL}" class="quiet">Manage preferences</a>
</div></div></body></html>`;

  return { subject, html };
}

function buildCheckInEmail(firstName: string, brand: Brand): { subject: string; html: string } {
  const subject = `${firstName}, has something exciting happened lately?`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${emailBase}
  .badge{background:#8b5cf620;color:#8b5cf6;border:1px solid #8b5cf640;}
  .logo{color:${brand.accent};}
  .cta{background:${brand.accent};color:${brand.ctaText};}
</style></head>
<body><div class="wrapper"><div class="card">
  <div class="logo">${brand.logoText}</div>
  <span class="badge">● Checking In</span>
  <h1>Has something exciting happened lately?</h1>
  <p>Hi <span class="hl">${firstName}</span>,</p>
  <p>It's been a while since we connected. If you've landed a new role recently — <span class="hl">congratulations!</span> We'd love to know.</p>
  <p>Keeping your ${brand.name} profile up to date means we always have the right picture of your career, and you're in the best position when the right opportunity comes along next time:</p>
  <a href="${PORTAL_URL}" class="cta">Update my profile →</a>
  <hr>
  <p style="font-size:13px;">If you're settled in a role and not looking, you can mark yourself as "not available" — we'll stop sending you opportunities while keeping your profile on file. Totally your call.</p>
</div>
<div class="footer">
  ${brand.footer}<br>
  <a href="${PORTAL_URL}" class="quiet">Manage preferences</a>
</div></div></body></html>`;

  return { subject, html };
}

/* ── Core scan ───────────────────────────────────────────────────────────── */
export interface LinkedInScanResult {
  scanned:            number;
  jobChangesDetected: number;
  emailsSent:         number;
  skipped:            number;
  errors:             number;
  details: Array<{
    candidateId: string;
    name:        string;
    action:      "job_change_email" | "checkin_email" | "skipped" | "error";
    newTitle?:   string;
    newCompany?: string;
  }>;
}

export async function runLinkedInProfileMonitor(): Promise<LinkedInScanResult> {
  logger.info("[linkedin-monitor] Starting LinkedIn profile monitor run");

  const now = Date.now();

  /* 1. Find all contactable candidates (every pool). Erased / do-not-contact
   *    candidates are excluded at the query level. */
  const allLinkedIn = await db
    .select({
      id:             candidatesTable.id,
      firstName:      candidatesTable.firstName,
      lastName:       candidatesTable.lastName,
      email:          candidatesTable.email,
      linkedinUrl:    candidatesTable.linkedinUrl,
      currentTitle:   candidatesTable.currentTitle,
      currentCompany: candidatesTable.currentCompany,
      updatedAt:      candidatesTable.updatedAt,
      pool:           candidatesTable.pool,
      tenantId:       candidatesTable.tenantId,
    })
    .from(candidatesTable)
    .where(and(
      isNotNull(candidatesTable.email),
      compliantCandidatePredicate(),
    ));

  /* 2. Filter: profile not updated in 6+ months (updatedAt = last time candidate touched their profile) */
  const targets = allLinkedIn.filter(c => {
    if (!c.email || !c.updatedAt) return false;
    const daysSinceUpdate = (now - new Date(c.updatedAt as any).getTime()) / 86_400_000;
    return daysSinceUpdate >= STALE_THRESHOLD_DAYS;
  });

  logger.info({ total: allLinkedIn.length, targets: targets.length }, "[linkedin-monitor] Targets identified");

  if (targets.length === 0) {
    const empty: LinkedInScanResult = { scanned: 0, jobChangesDetected: 0, emailsSent: 0, skipped: 0, errors: 0, details: [] };
    _lastResult = { ...empty, ranAt: new Date().toISOString() };
    return empty;
  }

  /* 3. Check last engagement date — skip if emailed within ENGAGEMENT_COOLDOWN_DAYS */
  const candidateIds = targets.map(c => c.id);
  const recentRows = await db
    .select({
      candidateId: communicationEventsTable.candidateId,
      maxSentAt: sql<string>`MAX(${communicationEventsTable.sentAt})`,
    })
    .from(communicationEventsTable)
    .where(
      and(
        eq(communicationEventsTable.type, "follow_up"),
        inArray(communicationEventsTable.candidateId, candidateIds),
      ),
    )
    .groupBy(communicationEventsTable.candidateId);

  const lastEmailMap = new Map<string, Date>();
  for (const row of recentRows) {
    if (row.candidateId && row.maxSentAt) {
      lastEmailMap.set(row.candidateId, new Date(row.maxSentAt));
    }
  }

  /* 3b. Resolve per-tenant branding for tenant-pool candidates. Platform-pool
   *     candidates (pool="platform" / tenantId="platform") use Lexy branding. */
  const tenantIds = [...new Set(
    targets
      .filter(c => c.pool !== "platform" && c.tenantId && c.tenantId !== "platform")
      .map(c => c.tenantId),
  )];
  const brandByTenantId = new Map<string, Brand>();
  if (tenantIds.length > 0) {
    const tenantRows = await db
      .select({
        id:           tenantsTable.id,
        name:         tenantsTable.name,
        primaryColor: tenantsTable.primaryColor,
      })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds));
    for (const t of tenantRows) {
      brandByTenantId.set(t.id, tenantBrand(t.name, t.primaryColor));
    }
  }

  /* Pick the right brand for a candidate. Platform-pool candidates get Lexy.
   * Tenant-pool candidates get their tenant's brand — and NEVER Lexy, so an
   * unresolvable tenant returns null (caller skips, rather than mis-branding a
   * tenant's candidate as Lexy). */
  const brandFor = (c: { pool: string | null; tenantId: string }): Brand | null => {
    if (c.pool === "platform" || c.tenantId === "platform") return LEXY_BRAND;
    return brandByTenantId.get(c.tenantId) ?? null;
  };

  /* 4. Process each candidate */
  const result: LinkedInScanResult = {
    scanned: 0, jobChangesDetected: 0, emailsSent: 0, skipped: 0, errors: 0, details: [],
  };

  for (const candidate of targets) {
    /* Cooldown check */
    const lastSent = lastEmailMap.get(candidate.id);
    if (lastSent) {
      const daysSinceLast = (now - lastSent.getTime()) / 86_400_000;
      if (daysSinceLast < ENGAGEMENT_COOLDOWN_DAYS) {
        result.skipped++;
        continue;
      }
    }

    /* Resolve branding. A tenant-pool candidate whose tenant can't be resolved
     * is skipped — we never fall back to Lexy branding for someone else's pool. */
    const brand = brandFor(candidate);
    if (!brand) {
      result.skipped++;
      logger.warn(
        { candidateId: candidate.id, tenantId: candidate.tenantId },
        "[linkedin-monitor] No tenant branding resolved for tenant-pool candidate — skipping to avoid Lexy mis-branding",
      );
      continue;
    }

    result.scanned++;
    const firstName = candidate.firstName ?? "there";
    const fullName  = `${firstName} ${candidate.lastName ?? ""}`.trim();

    try {
      let emailType: "job_change_email" | "checkin_email" = "checkin_email";
      let newTitle:   string | undefined;
      let newCompany: string | undefined;
      let emailPayload: { subject: string; html: string };

      /* Optional LinkedIn lookup — only when the key is configured AND the
       * candidate has a LinkedIn URL. Default path is no lookup at all. */
      const profile = (process.env.ENRICH_LAYER_API_KEY && candidate.linkedinUrl)
        ? await fetchLinkedInViaEnrichLayer(candidate.linkedinUrl)
        : null;

      if (profile) {
        const jobData = detectJobChange(
          profile,
          candidate.currentTitle ?? null,
          candidate.currentCompany ?? null,
        );

        if (jobData.jobChanged) {
          result.jobChangesDetected++;
          emailType  = "job_change_email";
          newTitle   = jobData.currentTitle   ?? undefined;
          newCompany = jobData.currentCompany ?? undefined;
          emailPayload = buildJobChangeEmail(firstName, newTitle ?? null, newCompany ?? null, brand);
          logger.info({ candidateId: candidate.id, newTitle, newCompany }, "[linkedin-monitor] Job change detected via Enrich Layer");
        } else {
          emailPayload = buildCheckInEmail(firstName, brand);
          logger.info({ candidateId: candidate.id }, "[linkedin-monitor] No job change detected — sending check-in");
        }
      } else {
        /* Default path: status check-in email, no third-party lookup */
        emailPayload = buildCheckInEmail(firstName, brand);
      }

      const sendResult = await sendEmail({
        to:      candidate.email!,
        subject: emailPayload.subject,
        html:    emailPayload.html,
        audit: {
          tenantId:     candidate.tenantId,
          actorLabel:   "Candidate Status Check-in",
          subjectType:  "candidate",
          subjectId:    candidate.id,
          subjectLabel: fullName,
          action:       "linkedin.profile_check",
          metadata:     { emailType, newTitle: newTitle ?? null, newCompany: newCompany ?? null },
        },
      });

      if (sendResult.ok) {
        await db.insert(communicationEventsTable).values({
          tenantId:    candidate.tenantId,
          candidateId: candidate.id,
          type:        "follow_up",
          channel:     "email",
          status:      "sent",
          subject:     emailPayload.subject,
          body:        `Status check-in (${emailType}${newTitle ? ` · ${newTitle}` : ""}${newCompany ? ` @ ${newCompany}` : ""})`,
          sentAt:      new Date(),
        } as any);

        result.emailsSent++;
        result.details.push({ candidateId: candidate.id, name: fullName, action: emailType, newTitle, newCompany });
        logger.info({ candidateId: candidate.id, emailType }, "[linkedin-monitor] Email sent");
      } else {
        result.errors++;
        logger.warn({ candidateId: candidate.id, error: sendResult.error }, "[linkedin-monitor] Email send failed");
      }
    } catch (err: any) {
      result.errors++;
      logger.error({ candidateId: candidate.id, err: err.message }, "[linkedin-monitor] Processing error");
      result.details.push({ candidateId: candidate.id, name: fullName, action: "error" });
    }
  }

  logger.info(
    { scanned: result.scanned, jobChangesDetected: result.jobChangesDetected, emailsSent: result.emailsSent },
    "[linkedin-monitor] Run complete",
  );
  /* Record for the dashboard — manual runs and scheduled runs alike */
  _lastResult = { ...result, ranAt: new Date().toISOString() };
  return result;
}

/* ── Scheduler ───────────────────────────────────────────────────────────── */
let _timer: ReturnType<typeof setTimeout> | null = null;
let _lastResult: (LinkedInScanResult & { ranAt: string }) | null = null;

export function getLastLinkedInScanResult() {
  return _lastResult;
}

export function startLinkedInProfileMonitor(): void {
  const INTERVAL_MS      = 24 * 60 * 60 * 1_000; // every 24 h
  const INITIAL_DELAY_MS = 15 * 60 * 1_000;        // first run 15 min after boot

  const runLoop = async () => {
    try {
      await runLinkedInProfileMonitor();
    } catch (err: any) {
      logger.error({ err: err.message }, "[linkedin-monitor] Scheduler error");
    }
    _timer = setTimeout(runLoop, INTERVAL_MS);
  };

  _timer = setTimeout(runLoop, INITIAL_DELAY_MS);
  logger.info("[linkedin-monitor-scheduler] Started — runs every 24 hours");
}
