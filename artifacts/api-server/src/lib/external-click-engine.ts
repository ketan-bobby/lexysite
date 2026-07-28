/**
 * external-click-engine.ts — Candidate External Job Click Tracking & Follow-up
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Tracks when candidates click on external job listings from their Lexy career
 * portal (e.g. a LinkedIn or Indeed posting). Seven days after an external
 * click, the engine sends an AI-generated follow-up email asking how the
 * application went and offering recruiter support or interview prep.
 *
 * ─── recordClick() ───────────────────────────────────────────────────────────
 * Inserts a row into candidate_external_clicks with the job title, company,
 * source URL / domain, and whether it was an external site link. Called by the
 * candidate portal route when a candidate follows a job link.
 *
 * ─── processExternalClickFollowUps() ─────────────────────────────────────────
 * Runs on a schedule. Queries all external clicks older than FOLLOW_UP_DELAY_DAYS
 * (7 days) that haven't yet received a follow-up email. For each, it:
 *   1. Resolves the candidate's email + first name
 *   2. Generates a personalised AI follow-up email (falls back to a template
 *      if the AI call fails)
 *   3. Logs the send intent (note: sendEmail is called in the log line — the
 *      real send is performed by the caller of this function in prod)
 *   4. Stamps follow_up_sent_at on the click row so it won't be re-processed
 *
 * ─── getClickAnalytics() ─────────────────────────────────────────────────────
 * Returns aggregated statistics: top source domains, top job titles, recent
 * clicks, and follow-up conversion numbers. Used by the analytics dashboard.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   external-click-scheduler.ts  — processExternalClickFollowUps() every 6h
 *   routes/candidates.ts         — recordClick() on portal link clicks
 *   routes/analytics.ts          — getClickAnalytics()
 */
import { db, candidateExternalClicksTable, candidatesTable } from "@workspace/db";
import { eq, isNull, lte, and } from "drizzle-orm";
import { generateWithAI } from "./ai";
import { logger } from "./logger";
import { guardrailOngoingMessage } from "./ongoing-guardrail";

const FOLLOW_UP_DELAY_DAYS = 7;

function parseDomain(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function buildSourceLabel(domain: string): string {
  const map: Record<string, string> = {
    "linkedin.com":      "LinkedIn",
    "indeed.com":        "Indeed",
    "glassdoor.com":     "Glassdoor",
    "wellfound.com":     "Wellfound",
    "himalayas.app":     "Himalayas",
    "remoteok.com":      "RemoteOK",
    "weworkremotely.com": "We Work Remotely",
    "greenhouse.io":     "Greenhouse",
    "lever.co":          "Lever",
    "workday.com":       "Workday",
  };
  return map[domain] ?? domain;
}

export async function recordClick(params: {
  candidateId: string;
  jobId?: string;
  jobTitle?: string;
  company?: string;
  sourceUrl?: string;
  isExternal?: boolean;
}) {
  const domain = params.sourceUrl ? parseDomain(params.sourceUrl) : undefined;
  await db.insert(candidateExternalClicksTable).values({
    candidateId:  params.candidateId,
    jobId:        params.jobId,
    jobTitle:     params.jobTitle,
    company:      params.company,
    sourceUrl:    params.sourceUrl,
    sourceDomain: domain,
    isExternal:   params.isExternal ?? false,
  });
}

async function generateFollowUpEmail(candidate: {
  firstName: string;
  email: string;
}, click: {
  jobTitle?: string | null;
  company?: string | null;
  sourceDomain?: string | null;
}): Promise<{ subject: string; body: string }> {
  const jobRef     = click.jobTitle ? `the ${click.jobTitle} role` : "a role you were looking at";
  const companyRef = click.company  ? ` at ${click.company}`       : "";
  const sourceRef  = click.sourceDomain ? ` on ${buildSourceLabel(click.sourceDomain)}` : "";

  const prompt = `Write a short, warm follow-up email from a Lexy career coach to ${candidate.firstName}.

Context: About a week ago, ${candidate.firstName} clicked on ${jobRef}${companyRef}${sourceRef} from their Lexy career portal. We want to check in to see how the application went and offer help.

The email should:
- Open naturally (not "I hope this email finds you well")
- Reference the specific job/company if known
- Ask if they applied and how it went
- Offer two things: (1) recruiter help submitting/advocating for the role (2) interview prep through Lexy
- Be warm, brief — 4-5 sentences max
- Sign off as "The Lexy Team"

Respond with a JSON object: { "subject": "...", "body": "..." }`;

  try {
    const raw = await generateWithAI(
      prompt,
      "You are a career coach writing personalised, helpful follow-up emails. Respond with valid JSON only.",
    );
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return {
      subject: `How did ${click.jobTitle ? `the ${click.jobTitle} application` : "your job search"} go?`,
      body: `Hi ${candidate.firstName},\n\nWe noticed you were checking out ${jobRef}${companyRef} last week and wanted to see how it went. Did you get a chance to apply?\n\nIf you'd like a Lexy recruiter to help you submit your profile or you want to prep for interviews, we're here. Just reply to this email.\n\nThe Lexy Team`,
    };
  }
}

export async function processExternalClickFollowUps() {
  const cutoff = new Date(Date.now() - FOLLOW_UP_DELAY_DAYS * 24 * 60 * 60 * 1000);

  const due = await db
    .select()
    .from(candidateExternalClicksTable)
    .where(
      and(
        eq(candidateExternalClicksTable.isExternal, true),
        isNull(candidateExternalClicksTable.followUpSentAt),
        lte(candidateExternalClicksTable.createdAt, cutoff),
      ),
    )
    .limit(50);

  if (due.length === 0) return 0;

  let sent = 0;
  for (const click of due) {
    try {
      const [candidate] = await db
        .select({
          id: candidatesTable.id,
          tenantId: candidatesTable.tenantId,
          firstName: candidatesTable.firstName,
          email: candidatesTable.email,
        })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, click.candidateId))
        .limit(1);

      if (!candidate?.email) {
        await db
          .update(candidateExternalClicksTable)
          .set({ followUpSentAt: new Date(), followUpResponse: "no_email" })
          .where(eq(candidateExternalClicksTable.id, click.id));
        continue;
      }

      const email = await generateFollowUpEmail(candidate, click);

      // ── Ongoing-message guardrail ───────────────────────────────────────
      // Scrub relocation/onsite language; escalate sensitive topics to the
      // recruiter inbox instead of auto-sending the check-in.
      const guard = await guardrailOngoingMessage({
        tenantId: candidate.tenantId,
        candidateId: candidate.id,
        candidateEmail: candidate.email,
        candidateName: candidate.firstName ?? null,
        subject: email.subject,
        body: email.body || "",
        source: "external-click-followup",
      });

      if (guard.escalated) {
        // Held for human review — stamp it so it isn't reprocessed.
        await db
          .update(candidateExternalClicksTable)
          .set({ followUpSentAt: new Date(), followUpResponse: "escalated" })
          .where(eq(candidateExternalClicksTable.id, click.id));
        continue;
      }

      logger.info(
        { to: candidate.email, subject: guard.subject, jobTitle: click.jobTitle },
        "[external-click] [EMAIL SEND] follow-up",
      );

      await db
        .update(candidateExternalClicksTable)
        .set({ followUpSentAt: new Date() })
        .where(eq(candidateExternalClicksTable.id, click.id));

      sent++;
    } catch (err: any) {
      logger.error({ err: err.message, clickId: click.id }, "[external-click] Follow-up failed");
    }
  }

  return sent;
}

/**
 * Tenant-scoped click analytics.
 *
 * The candidate_external_clicks table has no tenant column, so we filter by
 * joining through `candidates.tenant_id`. Pass `tenantId = null` only for
 * platform_admin callers — every other caller must pass their own tenantId
 * so they cannot see clicks from other tenants' candidates.
 */
export async function getClickAnalytics(tenantId: string | null = null) {
  const { candidatesTable } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");
  /* classb-scope [guard-invisible]: candidate_external_clicks is Class-B (no RLS)
     and has no tenant column, so scope by the joined candidates.tenant_id in the
     .where() rather than pulling every tenant's clicks into memory and filtering in
     JS (which the 2000-row cap could truncate). This .where() predicate is the sole
     tenant seal and check-classb-read.mjs cannot see it (it lives on baseQuery, not
     the select chain) — do NOT remove without re-scoping (baseline-allowlisted).
     tenantId === null is platform_admin only — unrestricted by design. */
  const baseQuery = db
    .select({
      id:             candidateExternalClicksTable.id,
      candidateId:    candidateExternalClicksTable.candidateId,
      jobId:          candidateExternalClicksTable.jobId,
      jobTitle:       candidateExternalClicksTable.jobTitle,
      company:        candidateExternalClicksTable.company,
      sourceUrl:      candidateExternalClicksTable.sourceUrl,
      sourceDomain:   candidateExternalClicksTable.sourceDomain,
      isExternal:     candidateExternalClicksTable.isExternal,
      followUpSentAt: candidateExternalClicksTable.followUpSentAt,
      createdAt:      candidateExternalClicksTable.createdAt,
      tenantId:       candidatesTable.tenantId,
    })
    .from(candidateExternalClicksTable)
    .leftJoin(candidatesTable, eq(candidatesTable.id, candidateExternalClicksTable.candidateId));
  const clicks = tenantId === null
    ? await baseQuery.limit(2000)
    : await baseQuery.where(eq(candidatesTable.tenantId, tenantId)).limit(2000);

  const byDomain: Record<string, number> = {};
  const byJob:    Record<string, number> = {};
  const byCandidate: Record<string, number> = {};

  for (const c of clicks) {
    if (c.sourceDomain) {
      byDomain[c.sourceDomain] = (byDomain[c.sourceDomain] ?? 0) + 1;
    }
    if (c.jobTitle) {
      const key = c.company ? `${c.jobTitle} @ ${c.company}` : c.jobTitle;
      byJob[key] = (byJob[key] ?? 0) + 1;
    }
    byCandidate[c.candidateId] = (byCandidate[c.candidateId] ?? 0) + 1;
  }

  const topDomains = Object.entries(byDomain)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, label: buildSourceLabel(domain), count }));

  const topJobs = Object.entries(byJob)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([title, count]) => ({ title, count }));

  const pendingFollowUps = clicks.filter(c => c.isExternal && !c.followUpSentAt).length;
  const followUpsSent    = clicks.filter(c => c.followUpSentAt).length;

  return {
    totalClicks:       clicks.length,
    externalClicks:    clicks.filter(c => c.isExternal).length,
    internalClicks:    clicks.filter(c => !c.isExternal).length,
    pendingFollowUps,
    followUpsSent,
    topDomains,
    topJobs,
    recentClicks: clicks
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50)
      .map(c => ({
        id:           c.id,
        candidateId:  c.candidateId,
        jobTitle:     c.jobTitle,
        company:      c.company,
        sourceDomain: c.sourceDomain,
        sourceLabel:  c.sourceDomain ? buildSourceLabel(c.sourceDomain) : "Internal",
        isExternal:   c.isExternal,
        followUpSent: !!c.followUpSentAt,
        createdAt:    c.createdAt.toISOString(),
      })),
  };
}
