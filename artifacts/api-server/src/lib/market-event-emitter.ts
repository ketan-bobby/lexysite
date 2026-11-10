/**
 * market-event-emitter.ts
 *
 * Event-driven "your market value moved" emails. Fires transactional emails
 * (delivered as the project's "push" channel) when one of the key candidate-
 * facing market signals changes:
 *
 *   • A target company viewed your profile      → instant alert
 *   • Recruiter-view burst (≥3 in 24h)          → activity-surge alert
 *   • You were promoted to a higher peer band   → ranking-up alert
 *
 * All sends go through `sendOnce()` which writes to
 * candidate_market_events_sent so we never spam the same candidate with the
 * same event-key twice within its cooldown window.
 *
 * Authoring conventions copied from candidate-reengagement-scheduler.ts:
 *   - dark-theme HTML (#0d1117 / #161b22), L3XY logo, single CTA
 *   - audit.tenantId="platform", actorLabel describes the trigger
 *   - subject lines are positive + curiosity-driven, never "you have N jobs"
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  candidatesTable,
  tenantsTable,
  candidateActionEventsTable,
  candidateMarketEventsSentTable,
  candidateCareerProfilesTable,
} from "@workspace/db";
import { sendEmail } from "./email";
import { logger } from "./logger";
import { getViewerPrivacySeal, countSealedRecruiterViews } from "./viewer-privacy.js";
import { loadRoleAlertContext } from "./role-alert-policy";

const PORTAL_URL =
  process.env.CANDIDATE_PORTAL_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/portal`
    : "https://lexy.ai/portal");

/* ── Cooldowns ───────────────────────────────────────────────────────────── */
const COOLDOWN = {
  TARGET_COMPANY_VIEW: 24 * 60 * 60 * 1000, // per (candidate, viewerTenant) pair
  VIEW_BURST:          24 * 60 * 60 * 1000, // per candidate
  PEER_BAND_PROMOTION: 7  * 24 * 60 * 60 * 1000, // per band (suppress flapping)
  ROLE_OPEN_AT_TARGET: 6  * 60 * 60 * 1000, // per (candidate, jobId) pair
} as const;

/* ── Throttle helper ─────────────────────────────────────────────────────── */
/* Atomic claim: a single INSERT … ON CONFLICT DO UPDATE … WHERE sent_at <=
   cutoff RETURNING. Postgres serializes the row update under the unique
   constraint, so exactly one concurrent caller gets a RETURNING row — others
   see an empty result and back off. This closes the SELECT-then-UPSERT race
   the previous version had. */
async function shouldSend(candidateId: string, eventKey: string, cooldownMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownMs);
  const result = await db.execute(sql`
    INSERT INTO candidate_market_events_sent (candidate_id, event_key, sent_at)
    VALUES (${candidateId}, ${eventKey}, NOW())
    ON CONFLICT (candidate_id, event_key) DO UPDATE
      SET sent_at = NOW()
      WHERE candidate_market_events_sent.sent_at <= ${cutoff}
    RETURNING candidate_id
  `);
  const rows = (result as any).rows ?? result;
  return Array.isArray(rows) && rows.length > 0;
}

/* ── Email styles (matches candidate-reengagement-scheduler.ts) ─────────── */
function baseStyles(): string {
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
    .pill{display:inline-block;background:#00d4ff20;color:#00d4ff;border:1px solid #00d4ff40;
          padding:4px 14px;border-radius:100px;font-size:12px;font-weight:600;margin-bottom:20px;}
    .footer{color:#484f58;font-size:12px;text-align:center;margin-top:24px;line-height:1.5;}
    a.quiet{color:#484f58;}
  `;
}
function wrap(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${baseStyles()}</style></head>
<body><div class="wrapper"><div class="card"><div class="logo">L3XY</div>${body}</div>
<div class="footer">Lexy AI Hiring Platform · You're getting this because your market value moved.<br>
<a href="${PORTAL_URL}" class="quiet">Manage notifications</a></div></div></body></html>`;
}

/* ── Email templates ─────────────────────────────────────────────────────── */
function targetCompanyEmail(firstName: string, companyName: string): { subject: string; html: string } {
  return {
    subject: `${companyName} just viewed your profile`,
    html: wrap(`
      <span class="pill">● Target company</span>
      <h1>${companyName} just viewed your profile</h1>
      <p>Hi <span class="hl">${firstName}</span>,</p>
      <p>A recruiter at <span class="hl">${companyName}</span> — one of your target companies — opened your profile in the last few minutes.</p>
      <p>This is the moment to make sure your profile is sharp. Refresh your headline answer or add anything new before they decide whether to reach out.</p>
      <a href="${PORTAL_URL}" class="cta">Polish my profile →</a>
      <p style="font-size:13px;">Activity from a target company usually means they're actively shortlisting.</p>`),
  };
}

function viewBurstEmail(firstName: string, count: number): { subject: string; html: string } {
  return {
    subject: `Your market value moved`,
    html: wrap(`
      <span class="pill">● Activity surge</span>
      <h1>Your market value moved</h1>
      <p>Hi <span class="hl">${firstName}</span>,</p>
      <p><span class="hl">${count} recruiters</span> opened your profile in the last 24 hours — well above your normal pace.</p>
      <p>Bursts like this are how strong matches start. Spend a minute making sure your latest answers and headline reflect where you actually want to go next.</p>
      <a href="${PORTAL_URL}" class="cta">See who's looking →</a>`),
  };
}

function roleOpenEmail(firstName: string, companyName: string, roleTitle: string, portalUrl: string): { subject: string; html: string } {
  return {
    subject: `${companyName} just opened a role you'd match`,
    html: wrap(`
      <span class="pill">● Target company · role open</span>
      <h1>${companyName} just opened ${roleTitle}</h1>
      <p>Hi <span class="hl">${firstName}</span>,</p>
      <p><span class="hl">${companyName}</span> — one of your target companies — just posted <span class="hl">${roleTitle}</span>. Based on your profile, you're a strong shape match.</p>
      <p>Open the role from your dashboard to apply directly or one-click signal interest before the recruiter starts shortlisting.</p>
      <a href="${portalUrl}" class="cta">View the role →</a>
      <p style="font-size:13px;">You're getting this because you added ${companyName} to your target list.</p>`),
  };
}

function bandPromotionEmail(firstName: string, newBand: string, scopeLabel: string): { subject: string; html: string } {
  return {
    subject: `You moved up — you're now ${newBand} (${scopeLabel})`,
    html: wrap(`
      <span class="pill">● Ranking up</span>
      <h1>You're now ${newBand}</h1>
      <p>Hi <span class="hl">${firstName}</span>,</p>
      <p>Your peer ranking ${scopeLabel} just moved up — you're now in the <span class="hl">${newBand}</span> band against candidates with similar profiles.</p>
      <p>Higher bands surface to more recruiter searches automatically. Keep going — one more interview or skill update typically holds the band steady against decay.</p>
      <a href="${PORTAL_URL}" class="cta">Open my dashboard →</a>`),
  };
}

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Record a recruiter view of a candidate and fire any market-event emails
 * the view triggers. Safe to call from a request handler — best-effort: any
 * email failure is logged but never propagates.
 */
export async function recordRecruiterView(opts: {
  candidateId:    string;
  viewerTenantId: string | null;
}): Promise<void> {
  const { candidateId, viewerTenantId } = opts;

  /* Short-window dedupe: tab refreshes / React StrictMode double-mount /
     navigation back-and-forth would otherwise inflate the pulse count and
     "top viewers" totals. Within a 5-minute window, treat repeated views
     from the same (candidate, viewer) as a single visit. The market-event
     downstream side-effects are also skipped on the duplicate path. */
  const RECENT_WINDOW_MS = 5 * 60 * 1000;
  if (viewerTenantId) {
    const since = new Date(Date.now() - RECENT_WINDOW_MS);
    const [recent] = await db
      .select({ id: candidateActionEventsTable.id })
      .from(candidateActionEventsTable)
      .where(and(
        eq(candidateActionEventsTable.candidateId, candidateId),
        eq(candidateActionEventsTable.eventType, "recruiter_view"),
        eq(candidateActionEventsTable.viewerTenantId, viewerTenantId),
        gte(candidateActionEventsTable.createdAt, since),
      ))
      .limit(1);
    if (recent) return;
  }

  /* Log the event. The denormalized viewer column lets the portal pulse
     query identify companies cheaply. NULL viewer is allowed for legacy /
     API-only callers that have no tenant identity. */
  await db.insert(candidateActionEventsTable).values({
    candidateId,
    eventType:      "recruiter_view",
    viewerTenantId: viewerTenantId ?? null,
    payload:        viewerTenantId ? { viewerTenantId } : {},
  } as any);

  if (!viewerTenantId || viewerTenantId === "platform") return;

  /* Resolve candidate + viewer-tenant info in parallel — if either lookup
     fails we still keep the view logged, we just skip the email. */
  const [candRows, tenantRows, profileRows] = await Promise.all([
    db.select({
      id:         candidatesTable.id,
      firstName:  candidatesTable.firstName,
      email:      candidatesTable.email,
    }).from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1),
    db.select({ id: tenantsTable.id, name: tenantsTable.name })
      .from(tenantsTable).where(eq(tenantsTable.id, viewerTenantId)).limit(1),
    db.select({ targetCompanies: (candidateCareerProfilesTable as any).targetCompanies })
      .from(candidateCareerProfilesTable)
      .where(eq((candidateCareerProfilesTable as any).candidateId, candidateId)).limit(1),
  ]);
  const candidate = candRows[0];
  const tenant    = tenantRows[0];
  if (!candidate?.email || !tenant?.name) return;

  /* Viewer-privacy seal (lib/viewer-privacy.ts): view-triggered candidate
     emails are a "you were seen" surface. Paused → no view emails at all;
     a view from a blocked/hidden tenant must never trigger a target-company
     alert, and hidden tenants don't count toward the view burst. */
  const viewerSeal = await getViewerPrivacySeal(candidateId);
  if (viewerSeal.viewsPaused || viewerSeal.isTenantExcluded(viewerTenantId)) return;

  /* ── Target-company match ────────────────────────────────────────────── */
  const targets: string[] = (profileRows[0]?.targetCompanies ?? []) as string[];
  const tenantNameLc = tenant.name.toLowerCase();
  const targetMatch = targets.find(t => {
    const tlc = (t || "").toLowerCase().trim();
    return tlc && (tlc === tenantNameLc || tenantNameLc.includes(tlc) || tlc.includes(tenantNameLc));
  });
  if (targetMatch) {
    const eventKey = `target_company_view:${tenant.id}`;
    if (await shouldSend(candidate.id, eventKey, COOLDOWN.TARGET_COMPANY_VIEW)) {
      const { subject, html } = targetCompanyEmail(candidate.firstName ?? "there", tenant.name);
      try {
        await sendEmail({
          to: candidate.email, subject, html,
          audit: { tenantId: "platform", actorLabel: "Market Event Emitter",
            subjectType: "candidate", subjectId: candidate.id, action: "market_event.target_company_view" },
        });
        logger.info({ candidateId, viewerTenantId, viewerName: tenant.name }, "[market-event] target-company alert sent");
      } catch (err: any) {
        logger.warn({ err: err?.message, candidateId }, "[market-event] target-company email failed");
      }
    }
  }

  /* ── Recruiter-view burst (≥3 in 24h, dedup by viewer tenant) ────────── */
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ uniqueViewers = 0 } = {}] = await db
    .select({ uniqueViewers: sql<number>`COUNT(DISTINCT viewer_tenant_id)::int` })
    .from(candidateActionEventsTable)
    .where(and(
      eq(candidateActionEventsTable.candidateId, candidateId),
      eq(candidateActionEventsTable.eventType, "recruiter_view"),
      gte(candidateActionEventsTable.createdAt, since),
      sql`viewer_tenant_id IS NOT NULL AND viewer_tenant_id <> 'platform'`,
      viewerSeal.viewNotHidden,
    ));
  if (uniqueViewers >= 3) {
    if (await shouldSend(candidate.id, "recruiter_view_burst", COOLDOWN.VIEW_BURST)) {
      const { subject, html } = viewBurstEmail(candidate.firstName ?? "there", uniqueViewers);
      try {
        await sendEmail({
          to: candidate.email, subject, html,
          audit: { tenantId: "platform", actorLabel: "Market Event Emitter",
            subjectType: "candidate", subjectId: candidate.id, action: "market_event.view_burst" },
        });
        logger.info({ candidateId, uniqueViewers }, "[market-event] view-burst alert sent");
      } catch (err: any) {
        logger.warn({ err: err?.message, candidateId }, "[market-event] view-burst email failed");
      }
    }
  }
}

/**
 * Brochure promise (slide 7): "On open — Lexy pings you the moment a role
 * you'd match opens at one of your target companies." Called after authorized
 * publication (jobs.ts), not internal creation or approval.
 *
 * Records a `role_open_at_target` action event (surfaced in the dashboard
 * recent-signals feed) once per candidate/job. Email retains its existing
 * six-hour claim/cooldown; quiet settings do not consume a new claim.
 */
export async function recordRoleOpenAtTarget(opts: {
  candidateId: string;
  jobId:       string;
  companyName: string;
  roleTitle:   string;
}): Promise<void> {
  const { candidateId, jobId } = opts;
  // The optional caller snapshot is not authorization or current job content.
  // Serialize retries so a published role creates one private feed entry.
  const context = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`role-open:${candidateId}:${jobId}`}, 0))`);
    const current = await loadRoleAlertContext(candidateId, jobId, tx);
    if (!current) return null;
    const [existing] = await tx.select({ id: candidateActionEventsTable.id })
      .from(candidateActionEventsTable).where(and(
        eq(candidateActionEventsTable.candidateId, candidateId),
        eq(candidateActionEventsTable.eventType, "role_open_at_target"),
        sql`${candidateActionEventsTable.payload}->>'jobId' = ${jobId}`,
      )).limit(1);
    if (!existing) {
      await tx.insert(candidateActionEventsTable).values({
        candidateId, eventType: "role_open_at_target",
        payload: { jobId, companyName: current.companyName, roleTitle: current.roleTitle },
      });
    }
    return current;
  });
  // Quiet settings suppress email, not the candidate's own eligible activity.
  // Do not consume a send claim for an opted-out or missing destination.
  if (!context?.emailAllowed) return;

  const eventKey = `role_open_at_target:${jobId}`;
  if (!(await shouldSend(candidateId, eventKey, COOLDOWN.ROLE_OPEN_AT_TARGET))) return;

  // Recheck immediately before transport: cancellation, confidentiality,
  // subscription withdrawal or a newly committed quiet setting must win.
  // Keep any acquired claim if suppressed or delivery is uncertain.
  const current = await loadRoleAlertContext(candidateId, jobId);
  if (!current?.emailAllowed) return;
  const { companyName, roleTitle } = current;

  const { subject, html } = roleOpenEmail(current.firstName ?? "there", companyName, roleTitle, PORTAL_URL);
  try {
    const result = await sendEmail({
      to: current.email, subject, html,
      audit: { tenantId: "platform", actorLabel: "Market Event Emitter",
        subjectType: "candidate", subjectId: candidateId, action: "market_event.role_open_at_target" },
    });
    if (!result.ok || result.simulated || result.suppressed) {
      logger.info({
        candidateId, jobId,
        outcome: !result.ok ? "failed" : result.simulated ? "simulated" : "suppressed",
      }, "[market-event] role-open-at-target email not delivered");
      return;
    }
    logger.info({ candidateId, jobId, companyName }, "[market-event] role-open-at-target alert sent");
  } catch (err: any) {
    logger.warn({ err: err?.message, candidateId, jobId }, "[market-event] role-open-at-target email failed");
  }
}

/**
 * Called from the peer-percentile sweep when a candidate's band improves.
 * `scope` is "country" or "global" — used to label the email so the user
 * understands which ranking moved.
 */
export async function notifyPeerBandPromotion(opts: {
  candidateId: string;
  oldBand:     string | null;
  newBand:     string;
  scope:       "country" | "global";
}): Promise<void> {
  const { candidateId, oldBand, newBand, scope } = opts;
  if (oldBand === newBand) return;
  /* Only fire on STRICT promotions — band downgrades / first-ever band
     ("Building momentum" with no prior) shouldn't trigger a celebratory
     email. Bands ordered worst → best. */
  const ORDER = ["Building momentum", "On track", "Above average", "Top quarter", "Top tier"];
  const oldRank = oldBand ? ORDER.indexOf(oldBand) : -1;
  const newRank = ORDER.indexOf(newBand);
  if (newRank <= 0 || newRank <= oldRank) return; // not a promotion (or unknown band)

  const eventKey = `peer_band_promotion:${scope}:${newBand}`;
  if (!(await shouldSend(candidateId, eventKey, COOLDOWN.PEER_BAND_PROMOTION))) return;

  const [cand] = await db
    .select({ id: candidatesTable.id, firstName: candidatesTable.firstName, email: candidatesTable.email })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!cand?.email) return;

  const scopeLabel = scope === "country" ? "in your country" : "globally";
  const { subject, html } = bandPromotionEmail(cand.firstName ?? "there", newBand, scopeLabel);
  try {
    await sendEmail({
      to: cand.email, subject, html,
      audit: { tenantId: "platform", actorLabel: "Market Event Emitter",
        subjectType: "candidate", subjectId: cand.id, action: "market_event.band_promotion" },
    });
    logger.info({ candidateId, oldBand, newBand, scope }, "[market-event] band-promotion alert sent");
  } catch (err: any) {
    logger.warn({ err: err?.message, candidateId }, "[market-event] band-promotion email failed");
  }
}
