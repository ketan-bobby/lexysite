/**
 * anti-ghost-engine.ts — Candidate Ghosting Detection & Nurture Engine
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Detects candidates who have gone dark at various pipeline stages and either
 * alerts the recruiter or automatically re-engages the candidate via email.
 *
 * ─── Five detectors ─────────────────────────────────────────────────────────
 *   1. detectInterviewNoShows    — interview_schedules still "pending/confirmed"
 *                                  more than 1 hour past their scheduledAt time
 *   2. detectOutreachDropouts    — candidates in active sequences who received
 *                                  2+ emails but haven't replied in 14+ days
 *   3. detectStalePipeline       — applications stuck in early stages (sourced /
 *                                  screening / verification) for 21+ days with
 *                                  no stage movement
 *   4. detectOfferLimbo          — applications stuck in the "offer" stage for
 *                                  7+ days with no accept/decline
 *   5. detectInterviewStale      — applications stuck in the "interview" stage
 *                                  for 14+ days with no stage movement (the
 *                                  engaged-then-quiet gap between detectors 3+4)
 *
 * Each detector is idempotent — it checks ghosting_alerts for an existing open
 * alert of the same type + reference before inserting a new one.
 *
 * ─── Nurture pool ───────────────────────────────────────────────────────────
 * Candidates who have truly gone cold are moved to the nurture pool.
 * processNurtureCycle() runs on a schedule and sends AI-generated re-engagement
 * emails to all nurture pool members whose nextContactAt has passed.
 * Always performs a DNC (Do Not Contact) check before sending any email.
 *
 * ─── Health scoring ──────────────────────────────────────────────────────────
 * getPipelineHealth() returns a 0–100 health score penalised by open alerts:
 *   critical alert → -15pts   high → -8pts   medium → -3pts
 *
 * ─── Called by ──────────────────────────────────────────────────────────────
 *   anti-ghost-scheduler.ts  — runs detectors every 30 min, nurture every 6h
 *   routes/anti-ghost.ts     — exposes manual trigger + alert management APIs
 */

import { db } from "@workspace/db";
import {
  ghostingAlertsTable, nurturePoolTable,
  applicationsTable, candidatesTable, sourcedCandidatesTable,
  interviewSchedulesTable, outreachEnrollmentsTable,
  outreachStepMessagesTable, tenantsTable,
} from "@workspace/db";
import { eq, and, lt, sql, desc, ne, inArray } from "drizzle-orm";
import OpenAI from "openai";
import { logger } from "./logger";
import { sendEmail, plainToHtml } from "./email";
import { guardrailOngoingMessage } from "./ongoing-guardrail";

const openai = new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function alreadyFlagged(
  tenantId: string,
  type: string,
  refField: "applicationId" | "enrollmentId" | "scheduleId" | "candidateId",
  refValue: string,
) {
  const rows = await db.select({ id: ghostingAlertsTable.id })
    .from(ghostingAlertsTable)
    .where(and(
      eq(ghostingAlertsTable.tenantId, tenantId),
      eq(ghostingAlertsTable.type, type),
      eq(ghostingAlertsTable.status, "open"),
      eq(ghostingAlertsTable[refField] as any, refValue),
    ))
    .limit(1);
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 1: Interview No-Show
// Flags interview_schedules that are past their scheduledAt but still
// "pending" or "confirmed" — nobody updated them = likely no-show.
// ─────────────────────────────────────────────────────────────────────────────
export async function detectInterviewNoShows(tenantId: string) {
  const now = new Date();
  const oneHourAgo = daysAgo(0);
  oneHourAgo.setTime(Date.now() - 60 * 60 * 1000);
  const twoDaysAgo = daysAgo(2);

  const schedules = await db.select().from(interviewSchedulesTable)
    .where(and(
      eq(interviewSchedulesTable.tenantId, tenantId),
      inArray(interviewSchedulesTable.status as any, ["pending", "confirmed"]),
      lt(interviewSchedulesTable.scheduledAt, oneHourAgo),
    ));

  const detected: any[] = [];

  for (const sched of schedules) {
    if (sched.scheduledAt < twoDaysAgo) continue; // Older than 48h — already stale, skip
    if (await alreadyFlagged(tenantId, "interview_no_show", "scheduleId", sched.id)) continue;

    // Try to get candidate name
    let candidateName = "Unknown";
    const app = await db.select().from(applicationsTable)
      .where(eq(applicationsTable.id, sched.applicationId)).limit(1);
    if (app[0]) {
      const cand = await db.select().from(candidatesTable)
        .where(eq(candidatesTable.id, app[0].candidateId)).limit(1);
      if (cand[0]) candidateName = `${cand[0].firstName} ${cand[0].lastName}`.trim();
    }

    const [alert] = await db.insert(ghostingAlertsTable).values({
      tenantId,
      type: "interview_no_show",
      severity: "high",
      jobId: app[0]?.jobId ?? null,
      candidateId: app[0]?.candidateId ?? null,
      applicationId: sched.applicationId,
      scheduleId: sched.id,
      candidateName,
      description: `Interview scheduled for ${sched.scheduledAt.toLocaleDateString()} is still marked "${sched.status}" — possible no-show.`,
      aiRecommendation: "Call or message the candidate within the hour. If confirmed no-show, update interview status and decide whether to reschedule or advance the next candidate.",
      suggestedAction: "call",
    }).returning();

    detected.push(alert);
  }

  if (detected.length) logger.info({ tenantId, count: detected.length }, "[anti-ghost] No-shows detected");
  return detected;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 2: Outreach Dropout
// Candidates in active outreach sequences who have received 2+ emails but
// haven't replied in 14+ days — they've gone dark mid-funnel.
// ─────────────────────────────────────────────────────────────────────────────
export async function detectOutreachDropouts(tenantId: string, silentDays = 14) {
  const cutoff = daysAgo(silentDays);
  const hardCutoff = daysAgo(silentDays * 2);

  const enrollments = await db.select().from(outreachEnrollmentsTable)
    .where(and(
      eq(outreachEnrollmentsTable.tenantId, tenantId),
      eq(outreachEnrollmentsTable.status, "active"),
    ));

  const detected: any[] = [];

  for (const enrollment of enrollments) {
    if (!enrollment.lastSentAt || enrollment.lastSentAt > cutoff) continue; // Too recent
    if (enrollment.totalStepsSent < 2) continue; // Need at least 2 touchpoints

    if (await alreadyFlagged(tenantId, "outreach_dropout", "enrollmentId", enrollment.id)) continue;

    const daysSilent = Math.floor((Date.now() - enrollment.lastSentAt.getTime()) / (1000 * 60 * 60 * 24));
    const severity = daysSilent > silentDays * 2 ? "high" : "medium";

    // Try to get jobId via candidate's active application
    let dropoutJobId: string | null = null;
    if (enrollment.candidateId) {
      const candidateApps = await db.select({ jobId: applicationsTable.jobId })
        .from(applicationsTable)
        .where(and(eq(applicationsTable.tenantId, tenantId), eq(applicationsTable.candidateId, enrollment.candidateId)))
        .limit(1);
      dropoutJobId = candidateApps[0]?.jobId ?? null;
    }

    const [alert] = await db.insert(ghostingAlertsTable).values({
      tenantId,
      type: "outreach_dropout",
      severity,
      jobId: dropoutJobId,
      candidateId: enrollment.candidateId,
      enrollmentId: enrollment.id,
      candidateName: enrollment.recipientName ?? "Unknown",
      description: `${enrollment.recipientName ?? "Candidate"} received ${enrollment.totalStepsSent} outreach emails but has not replied in ${daysSilent} days (last contact: ${enrollment.lastSentAt.toLocaleDateString()}).`,
      aiRecommendation: severity === "high"
        ? "Move to nurture pool for long-term re-engagement. Try a different channel (LinkedIn/phone). Consider a break of 30+ days before next contact."
        : "Send a final, value-led check-in with a soft CTA. If no response, move to nurture pool.",
      suggestedAction: "nurture",
    }).returning();

    detected.push(alert);
  }

  if (detected.length) logger.info({ tenantId, count: detected.length }, "[anti-ghost] Outreach dropouts detected");
  return detected;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 3: Stale Pipeline
// Applications stuck in early FORMAL stages (applied / screening / verification)
// for more than 21 days with no stage movement.
//
// `sourced` is intentionally EXCLUDED: a sourced entry is a prospect the AI
// surfaced who has not entered a formal pipeline, so it cannot "ghost" — flagging
// it would generate noise for every backfilled/newly-sourced candidate.
// ─────────────────────────────────────────────────────────────────────────────
export async function detectStalePipeline(tenantId: string, staleDays = 21) {
  const cutoff = daysAgo(staleDays);
  const staleStages = ["applied", "screening", "verification"];

  const apps = await db.select().from(applicationsTable)
    .where(and(
      eq(applicationsTable.tenantId, tenantId),
      inArray(applicationsTable.stage, staleStages as any[]),
      lt(applicationsTable.updatedAt, cutoff),
    ));

  const detected: any[] = [];

  for (const app of apps) {
    if (await alreadyFlagged(tenantId, "stale_pipeline", "applicationId", app.id)) continue;

    const daysSince = Math.floor((Date.now() - app.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
    const severity = daysSince > staleDays * 2 ? "high" : "medium";

    let candidateName = "Unknown";
    const cand = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, app.candidateId)).limit(1);
    if (cand[0]) candidateName = `${cand[0].firstName} ${cand[0].lastName}`.trim();

    const [alert] = await db.insert(ghostingAlertsTable).values({
      tenantId,
      type: "stale_pipeline",
      severity,
      jobId: app.jobId,
      candidateId: app.candidateId,
      applicationId: app.id,
      candidateName,
      description: `${candidateName} has been stuck in "${app.stage}" for ${daysSince} days with no pipeline movement.`,
      aiRecommendation: daysSince > 42
        ? "This candidate is likely cold. Either advance them with a nurture touch or archive the application to keep the pipeline clean."
        : "Review this application and either advance to the next stage or schedule outreach to re-qualify the candidate.",
      suggestedAction: daysSince > 42 ? "nurture" : "re_engage",
    }).returning();

    detected.push(alert);
  }

  if (detected.length) logger.info({ tenantId, count: detected.length }, "[anti-ghost] Stale pipeline detected");
  return detected;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 5: Interview Stale
// Applications stuck in the "interview" stage for 14+ days with no stage
// movement. Closes the engaged-then-quiet gap: detector 3 stops at
// verification and detector 4 starts at offer, so a candidate who interviewed
// and then went dark was invisible to staleness detection. Origin-neutral —
// applies to sourced and organic candidates alike (no entry_type filter),
// matching the rest of the detector suite.
// ─────────────────────────────────────────────────────────────────────────────
export async function detectInterviewStale(tenantId: string, staleDays = 14) {
  const cutoff = daysAgo(staleDays);

  const apps = await db.select().from(applicationsTable)
    .where(and(
      eq(applicationsTable.tenantId, tenantId),
      eq(applicationsTable.stage, "interview"),
      lt(applicationsTable.updatedAt, cutoff),
    ));

  const detected: any[] = [];

  for (const app of apps) {
    if (await alreadyFlagged(tenantId, "interview_stale", "applicationId", app.id)) continue;

    const daysSince = Math.floor((Date.now() - app.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
    const severity = daysSince > staleDays * 2 ? "high" : "medium";

    let candidateName = "Unknown";
    const cand = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, app.candidateId)).limit(1);
    if (cand[0]) candidateName = `${cand[0].firstName} ${cand[0].lastName}`.trim();

    const [alert] = await db.insert(ghostingAlertsTable).values({
      tenantId,
      type: "interview_stale",
      severity,
      jobId: app.jobId,
      candidateId: app.candidateId,
      applicationId: app.id,
      candidateName,
      description: `${candidateName} has been in the "interview" stage for ${daysSince} days with no advance or rejection.`,
      aiRecommendation: daysSince > staleDays * 2
        ? "This engaged candidate has gone quiet post-interview and is likely interviewing elsewhere. Call them today with a status update and a concrete next step, or close out the application."
        : "The candidate completed the interview step but nothing has moved. Share feedback or a decision timeline now — post-interview silence is the top reason engaged candidates drop out.",
      suggestedAction: daysSince > staleDays * 2 ? "call" : "re_engage",
    }).returning();

    detected.push(alert);
  }

  if (detected.length) logger.info({ tenantId, count: detected.length }, "[anti-ghost] Interview-stale detected");
  return detected;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 4: Offer Limbo
// Applications stuck in "offer" stage for 7+ days — candidate hasn't accepted
// or declined. Risk of losing them while they explore other offers.
// ─────────────────────────────────────────────────────────────────────────────
export async function detectOfferLimbo(tenantId: string, limboDays = 7) {
  const cutoff = daysAgo(limboDays);

  const apps = await db.select().from(applicationsTable)
    .where(and(
      eq(applicationsTable.tenantId, tenantId),
      eq(applicationsTable.stage, "offer"),
      lt(applicationsTable.updatedAt, cutoff),
    ));

  const detected: any[] = [];

  for (const app of apps) {
    if (await alreadyFlagged(tenantId, "offer_limbo", "applicationId", app.id)) continue;

    const daysSince = Math.floor((Date.now() - app.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
    const severity = daysSince > 14 ? "critical" : daysSince > 10 ? "high" : "medium";

    let candidateName = "Unknown";
    const cand = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, app.candidateId)).limit(1);
    if (cand[0]) candidateName = `${cand[0].firstName} ${cand[0].lastName}`.trim();

    const [alert] = await db.insert(ghostingAlertsTable).values({
      tenantId,
      type: "offer_limbo",
      severity,
      jobId: app.jobId,
      candidateId: app.candidateId,
      applicationId: app.id,
      candidateName,
      description: `${candidateName} has had an offer pending for ${daysSince} days with no response.`,
      aiRecommendation: daysSince > 14
        ? "URGENT: Candidate may be using this offer as leverage elsewhere. Call them directly today. Be ready to discuss counter-offers or set a firm decision deadline."
        : "Send a personal check-in call or message. Ask if they have any outstanding questions about the role, compensation, or start date.",
      suggestedAction: "call",
    }).returning();

    detected.push(alert);
  }

  if (detected.length) logger.info({ tenantId, count: detected.length }, "[anti-ghost] Offer limbo detected");
  return detected;
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN ALL DETECTORS for a tenant
// ─────────────────────────────────────────────────────────────────────────────
export async function runAllDetectors(tenantId: string) {
  const [noShows, dropouts, stale, limbo, interviewStale] = await Promise.all([
    detectInterviewNoShows(tenantId),
    detectOutreachDropouts(tenantId),
    detectStalePipeline(tenantId),
    detectOfferLimbo(tenantId),
    detectInterviewStale(tenantId),
  ]);
  return {
    noShows: noShows.length,
    outreachDropouts: dropouts.length,
    stalePipeline: stale.length,
    offerLimbo: limbo.length,
    interviewStale: interviewStale.length,
    total: noShows.length + dropouts.length + stale.length + limbo.length + interviewStale.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN SCAN FOR ALL TENANTS
// ─────────────────────────────────────────────────────────────────────────────
export async function runScanForAllTenants() {
  const tenants = await db.select({ id: tenantsTable.id }).from(tenantsTable);
  let totalDetected = 0;
  for (const tenant of tenants) {
    try {
      const result = await runAllDetectors(tenant.id);
      totalDetected += result.total;
    } catch (err: any) {
      logger.error({ tenantId: tenant.id, err: err.message }, "[anti-ghost] Scan failed for tenant");
    }
  }
  logger.info({ totalDetected }, "[anti-ghost] Full scan complete");
  return totalDetected;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD TO NURTURE POOL
// ─────────────────────────────────────────────────────────────────────────────
export async function addToNurturePool(opts: {
  tenantId: string;
  candidateId: string;
  candidateName?: string;
  candidateEmail?: string;
  reason?: string;
  cadenceDays?: number;
}) {
  const { tenantId, candidateId, candidateName, candidateEmail, reason, cadenceDays = 90 } = opts;

  // Idempotent
  const [existing] = await db.select().from(nurturePoolTable)
    .where(and(
      eq(nurturePoolTable.tenantId, tenantId),
      eq(nurturePoolTable.candidateId, candidateId),
      eq(nurturePoolTable.status, "active"),
    )).limit(1);
  if (existing) return existing;

  const nextContact = new Date();
  nextContact.setDate(nextContact.getDate() + cadenceDays);

  const [member] = await db.insert(nurturePoolTable).values({
    tenantId,
    candidateId,
    candidateName: candidateName ?? null,
    candidateEmail: candidateEmail ?? null,
    reason: reason ?? null,
    cadenceDays,
    nextContactAt: nextContact,
  }).returning();

  logger.info({ tenantId, candidateId }, "[anti-ghost] Candidate added to nurture pool");
  return member;
}

// ─────────────────────────────────────────────────────────────────────────────
// NURTURE CYCLE: Generate + send AI re-engagement emails for due members
// ─────────────────────────────────────────────────────────────────────────────
export async function processNurtureCycle(tenantId: string) {
  const now = new Date();
  const dueMembers = await db.select().from(nurturePoolTable)
    .where(and(
      eq(nurturePoolTable.tenantId, tenantId),
      eq(nurturePoolTable.status, "active"),
      lt(nurturePoolTable.nextContactAt, now),
    ));

  const processed: any[] = [];

  for (const member of dueMembers) {
    try {
      // ── Pre-send DNC guard ──────────────────────────────────────────────
      const [dncCheck] = await db.select({ doNotContact: candidatesTable.doNotContact })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, member.candidateId))
        .limit(1);

      // Also check by email if no direct match
      let isDNC = dncCheck?.doNotContact ?? false;
      if (!isDNC && member.candidateEmail) {
        const [emailCheck] = await db.select({ doNotContact: candidatesTable.doNotContact })
          .from(candidatesTable)
          .where(eq(candidatesTable.email, member.candidateEmail))
          .limit(1);
        isDNC = emailCheck?.doNotContact ?? false;
      }

      if (isDNC) {
        await db.update(nurturePoolTable)
          .set({ status: "stopped" })
          .where(eq(nurturePoolTable.id, member.id));
        logger.info({ memberId: member.id }, "[DNC] Nurture suppressed – candidate is DNC, removed from pool");
        continue;
      }

      const email = await generateReEngagementEmail({
        name: member.candidateName ?? "there",
        email: member.candidateEmail ?? "",
      });

      // ── Ongoing-message guardrail ───────────────────────────────────────
      // Scrub relocation/onsite language and escalate sensitive topics to the
      // recruiter inbox instead of auto-sending.
      const guard = await guardrailOngoingMessage({
        tenantId,
        candidateId: member.candidateId,
        candidateEmail: member.candidateEmail ?? "",
        candidateName: member.candidateName ?? null,
        subject: email.subject,
        body: email.body || "",
        source: "nurture",
      });

      // Real send via Amazon SES (logs and falls back to simulation when SES_FROM_EMAIL isn't set).
      // Skipped entirely when the message was escalated for human review.
      if (!guard.escalated && member.candidateEmail) {
        await sendEmail({
          to: member.candidateEmail,
          subject: guard.subject,
          html: plainToHtml(guard.body),
          text: guard.body,
        });
      }

      const nextContact = new Date(now);
      nextContact.setDate(nextContact.getDate() + member.cadenceDays);

      await db.update(nurturePoolTable)
        .set({
          lastContactedAt: now,
          nextContactAt: nextContact,
          totalTouchpoints: sql`${nurturePoolTable.totalTouchpoints} + 1`,
        })
        .where(eq(nurturePoolTable.id, member.id));

      processed.push({ memberId: member.id, candidateId: member.candidateId });
    } catch (err: any) {
      logger.error({ memberId: member.id, err: err.message }, "[anti-ghost] Nurture send failed");
    }
  }

  if (processed.length) logger.info({ tenantId, count: processed.length }, "[anti-ghost] Nurture cycle processed");
  return processed;
}

interface NurtureStepConfig {
  label?: string;
  toneInstructions?: string;
  templateSubject?: string;
  templateBody?: string;
  channel?: string;
}

function applyTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

async function generateReEngagementEmail(
  candidate: { name: string; email: string; jobTitle?: string; recruiterName?: string },
  stepConfig?: NurtureStepConfig,
) {
  const vars: Record<string, string> = {
    candidate_name: candidate.name,
    job_title: candidate.jobTitle ?? "this opportunity",
    recruiter_signature: candidate.recruiterName ?? "The Talent Team",
  };

  // If a template body exists, use AI to personalise it (not generate from scratch)
  const systemPrompt = stepConfig?.templateBody
    ? `You are an expert recruitment copywriter. Your job is to take the template below and personalise it for the candidate, making it feel natural and human while strictly preserving the message's intent.
Tone instructions: ${stepConfig.toneInstructions ?? "Warm and professional."}
Template:
Subject: ${applyTemplateVars(stepConfig.templateSubject ?? "", vars)}
Body:
${applyTemplateVars(stepConfig.templateBody, vars)}

Rules:
- Keep within 15% of the word count of the template
- Do NOT add content not in the template — only polish and personalise
- Return JSON: { "subject": "...", "body": "..." }`
    : `You are an expert recruitment copywriter. Generate a warm, personalised re-engagement email for a candidate named ${candidate.name} who has gone quiet.
Tone: ${stepConfig?.toneInstructions ?? "Warm but not pushy. Soft CTA only."}
Rules:
- Under 120 words
- No clichés like "I hope this finds you well"
- Sign off as "${candidate.recruiterName ?? "The Talent Team"}"
Return JSON: { "subject": "...", "body": "..." }`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 400,
      temperature: 0.65,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Generate the email now." },
      ],
      response_format: { type: "json_object" },
    });
    return JSON.parse(completion.choices[0]?.message?.content || "{}");
  } catch {
    const fallbackSubject = stepConfig?.templateSubject
      ? applyTemplateVars(stepConfig.templateSubject, vars)
      : `Quick check-in, ${candidate.name}`;
    const fallbackBody = stepConfig?.templateBody
      ? applyTemplateVars(stepConfig.templateBody, vars)
      : `Hi ${candidate.name},\n\nIt's been a while — just wanted to check in. If you're ever open to exploring something new, I'd love to reconnect.\n\nNo pressure at all.\n\n${candidate.recruiterName ?? "The Talent Team"}`;
    return { subject: fallbackSubject, body: fallbackBody };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PIPELINE HEALTH REPORT
// ─────────────────────────────────────────────────────────────────────────────
export async function getPipelineHealth(tenantId: string | string[] | null) {
  /* Accepts a single tenant id, a subtree list (parent + descendants), or
     null (platform_admin → all tenants). */
  const appCond = tenantId === null ? undefined
    : Array.isArray(tenantId)
      ? inArray(applicationsTable.tenantId, tenantId.length ? tenantId : ["__none__"])
      : eq(applicationsTable.tenantId, tenantId);
  const alertTenantCond = tenantId === null ? undefined
    : Array.isArray(tenantId)
      ? inArray(ghostingAlertsTable.tenantId, tenantId.length ? tenantId : ["__none__"])
      : eq(ghostingAlertsTable.tenantId, tenantId);
  const [allApps, openAlerts] = await Promise.all([
    db.select().from(applicationsTable).where(appCond),
    db.select().from(ghostingAlertsTable).where(and(
      alertTenantCond,
      eq(ghostingAlertsTable.status, "open"),
    )),
  ]);

  const stageBreakdown: Record<string, number> = {};
  for (const app of allApps) {
    stageBreakdown[app.stage] = (stageBreakdown[app.stage] ?? 0) + 1;
  }

  const criticalCount = openAlerts.filter(a => a.severity === "critical").length;
  const highCount = openAlerts.filter(a => a.severity === "high").length;

  // Health score: 100 - penalties for open alerts weighted by severity
  const penalty = criticalCount * 15 + highCount * 8 + openAlerts.filter(a => a.severity === "medium").length * 3;
  const healthScore = Math.max(0, Math.min(100, 100 - penalty));

  return {
    totalApplications: allApps.length,
    stageBreakdown,
    openAlerts: openAlerts.length,
    criticalAlerts: criticalCount,
    highAlerts: highCount,
    healthScore,
    byType: {
      interview_no_show: openAlerts.filter(a => a.type === "interview_no_show").length,
      outreach_dropout: openAlerts.filter(a => a.type === "outreach_dropout").length,
      stale_pipeline: openAlerts.filter(a => a.type === "stale_pipeline").length,
      offer_limbo: openAlerts.filter(a => a.type === "offer_limbo").length,
    },
  };
}
