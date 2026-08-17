/**
 * routes/analytics.ts — Platform Analytics & Engagement Metrics
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Aggregates and serves all metrics that power the Analytics and Engagement
 * dashboard pages. All queries are tenant-scoped via resolveUser +
 * getAllowedTenantIds() so a tenant user never sees another tenant's numbers.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET /analytics/overview          KPI snapshot: jobs, candidates, applications,
 *                                    interviews, offers, hires, avg time-to-hire,
 *                                    avg interview score, ghosting rate, reply rate,
 *                                    top candidate sources
 *   GET /analytics/funnel            Pipeline funnel: count per stage
 *                                    (sourced → screening → interview → offer → hired)
 *   GET /analytics/time-series       Weekly candidate + application counts for the
 *                                    past N weeks (used for trend charts)
 *   GET /analytics/ghosting          Ghosting risk distribution and recent alerts
 *   GET /analytics/outreach          Outreach campaign performance metrics
 *                                    (total sent, reply rate, positive rate, DNC)
 *   GET /analytics/talent-pool       Platform talent pool statistics
 *                                    (total, active, pending review, recent submissions)
 *   GET /analytics/engagement        Engagement metrics for the Engagement tab
 *   GET /analytics/linkedin-monitor  Last LinkedIn profile scan result + trigger
 *
 * ─── tenantFilter() ──────────────────────────────────────────────────────────
 * Shared helper that resolves the caller's allowed tenantIds and returns:
 *   null     — platform_admin (no WHERE clause needed)
 *   []       — no access (return 0 counts without hitting the DB)
 *   string[] — inject into inArray() WHERE clause
 *
 * ─── Empty-set short-circuit ─────────────────────────────────────────────────
 * All routes check for allowed?.length === 0 early and return zeroed-out
 * response shapes immediately, avoiding unnecessary DB queries.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { logger } from "../lib/logger";
import { db, controlDb } from "@workspace/db";
import {
  jobsTable,
  candidatesTable,
  applicationsTable,
  interviewSessionsTable,
  pipelineRunsTable,
  outreachCampaignsTable,
  ghostingRisksTable,
  communicationEventsTable,
  talentPoolSubmissionsTable,
  candidateDemographicsTable,
  aiDecisionLogTable,
  tenantsTable,
  candidateEventsTable,
  agentRunsTable,
  interviewPlansTable,
  pipelineRunEventsTable,
  recruiterInboxTable,
  usersTable,
} from "@workspace/db";
import {
  count,
  eq,
  gte,
  and,
  inArray,
  notInArray,
  desc,
  sql,
  lte,
  isNull,
  isNotNull,
  or,
  exists,
} from "drizzle-orm";
import { resolveUser } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import {
  restrictToCompliantCandidates,
  compliantCandidatePredicate,
} from "../lib/compliance-scope";
import { PLATFORM_READ_EXEMPTION, platformReadExemption } from "../lib/platform-pool-read";
import { PLACEHOLDER_DOMAINS } from "../lib/real-email";
import { TERMINAL_NEGATIVE_STAGES, TERMINAL_NEGATIVE_STAGE_SET } from "../lib/pipeline-stages";
import {
  runLinkedInProfileMonitor,
  getLastLinkedInScanResult,
} from "../lib/linkedin-profile-monitor";
import { orchestrator } from "../lib/agents/orchestrator";
import {
  MIN_GROUP_N,
  FOUR_FIFTHS,
  ADVERSE_MILESTONES,
  buildEventMax,
  buildUnits,
  analyzeAllAttributes,
} from "../lib/adverse-impact";

/* Engagement-trigger routes only kick off internal schedulers; no body
 * fields are consumed. Strict empty-body validation makes that contract
 * explicit and rejects any future caller that smuggles a `tenantId` /
 * `force` flag hoping the handler picks it up. */
const EmptyEngagementBody = z.preprocess((v) => v ?? {}, z.object({}).strict());

const router: IRouter = Router();

/* ── Shared helper: build tenant WHERE clause ─────────────────────────────── */
async function tenantFilter(req: any) {
  const user = req.resolvedUser!;
  const allowed = await getDataScopeTenantIds(user);
  return allowed; // null = platform_admin (no filter); [] = no access; string[] = restrict
}

/* ── Recruiter requisition scope ───────────────────────────────────────────
 * A plain `recruiter` may only see analytics for the requisitions ASSIGNED to
 * them and the candidates tied to those reqs — tenant scope alone is NOT enough
 * (it would leak co-workers' jobs/candidates in the same tenant tree). Every
 * other role gets nulls here, meaning "no extra narrowing beyond the tenant
 * ceiling".
 *
 *   jobIds       — null ⇒ no job restriction; []/[…] ⇒ restrict to these reqs.
 *   candidateIds — null ⇒ no candidate restriction; []/[…] ⇒ restrict to these
 *                  candidates (derived from applications to the assigned reqs).
 *
 * IMPORTANT: an EMPTY array still restricts (to nothing) — it must never be
 * treated as "no filter", or a recruiter with no assignments would see the
 * whole tenant. inScope() below enforces that.
 */
type RecruiterScope = { jobIds: string[] | null; candidateIds: string[] | null };

async function recruiterScope(req: any): Promise<RecruiterScope> {
  const user = req.resolvedUser!;
  if (user.role !== "recruiter") return { jobIds: null, candidateIds: null };
  const jobIds = await getRecruiterAssignedJobIds(user);
  if (jobIds.length === 0) return { jobIds: [], candidateIds: [] };
  const apps = await db
    .select({ candidateId: applicationsTable.candidateId })
    .from(applicationsTable)
    .where(inArray(applicationsTable.jobId, jobIds));
  const candidateIds = [...new Set(apps.map((a) => a.candidateId).filter(Boolean))] as string[];
  return { jobIds, candidateIds };
}

/** AND together the truthy conditions; undefined when none apply. */
function andConds(...conds: Array<any>) {
  const c = conds.filter((x) => x !== undefined && x !== null);
  if (c.length === 0) return undefined;
  if (c.length === 1) return c[0];
  return and(...c);
}

/** Tenant ceiling: null ⇒ no filter (platform_admin); [] ⇒ match nothing. */
function inTenant(col: any, allowed: string[] | null) {
  if (allowed === null) return undefined;
  if (allowed.length === 0) return sql`false`;
  return inArray(col, allowed);
}

/** Recruiter scope for interview sessions. Sessions carry NO job_id column —
 * they link to a job via application_id → applications.job_id, or (for
 * pipeline sessions whose application_id is a placeholder) via
 * plan_id → interview_plans.job_id. Candidate-based scoping is NOT used here:
 * a candidate on an assigned req may also hold sessions for other jobs, which
 * must stay outside the recruiter ceiling.
 * null ⇒ no filter; [] ⇒ match nothing. */
function sessionJobScope(jobIds: string[] | null) {
  if (jobIds === null) return undefined;
  if (jobIds.length === 0) return sql`false`;
  return or(
    exists(
      db
        .select({ one: sql`1` })
        .from(applicationsTable)
        .where(
          and(
            eq(applicationsTable.id, interviewSessionsTable.applicationId),
            inArray(applicationsTable.jobId, jobIds),
          ),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(interviewPlansTable)
        .where(
          and(
            eq(interviewPlansTable.id, interviewSessionsTable.planId),
            inArray(interviewPlansTable.jobId, jobIds),
          ),
        ),
    ),
  );
}

/** Recruiter scope: null ⇒ no filter; [] ⇒ match nothing; else inArray. */
function inScope(col: any, ids: string[] | null) {
  if (ids === null) return undefined;
  if (ids.length === 0) return sql`false`;
  return inArray(col, ids);
}

router.get("/analytics/overview", resolveUser, async (req, res) => {
  try {
    const allowed = await tenantFilter(req);
    const rs = await recruiterScope(req);

    /* "Total Candidates" must match what the /candidates list actually shows,
       otherwise the KPI links to a list with a different number (e.g. counts 4
       but the list shows 2). Replicate the list's visibility rules: hide
       GDPR-erased + do-not-contact + pending_profile candidates always, and
       hide platform-pool candidates unless this tenant has candidate-database
       access (platform_admin always sees the platform pool). */
    const user = req.resolvedUser!;
    let hasPlatformAccess = allowed === null; // platform_admin sees the platform pool
    if (allowed && allowed.length > 0 && user?.tenantId) {
      const [tRow] = await db
        .select({ a: tenantsTable.candidateDatabaseAccess })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, user.tenantId))
        .limit(1);
      hasPlatformAccess = tRow?.a === true;
    }
    const candidateConds: any[] = [
      isNull(candidatesTable.dataErasedAt),
      sql`${candidatesTable.doNotContact} IS NOT TRUE`,
      sql`${candidatesTable.pool} IS DISTINCT FROM 'pending_profile'`,
    ];
    if (rs.candidateIds !== null) {
      // Plain recruiter: candidates are ONLY those tied to assigned reqs.
      candidateConds.push(inScope(candidatesTable.id, rs.candidateIds));
    } else if (allowed) {
      // Mirror /candidates tenant-scope: platform-pool rows are visible
      // regardless of tenant ONLY with platform access; everything else must
      // belong to an allowed tenant. Without access, platform-pool is hidden.
      if (hasPlatformAccess) {
        /* Aggregate metric only — this count never returns per-candidate PII to
           the employer, and erased/DNC/pending are already excluded above, so
           the per-employer visibility seal is not applied. (Whether paused/hide/
           block/match-only should shrink counts is a Step-2 policy question.) */
        platformReadExemption(PLATFORM_READ_EXEMPTION.AGGREGATE_ANALYTICS_COUNT);
        candidateConds.push(
          or(eq(candidatesTable.pool, "platform"), inArray(candidatesTable.tenantId, allowed)),
        );
      } else {
        candidateConds.push(inArray(candidatesTable.tenantId, allowed));
        candidateConds.push(sql`${candidatesTable.pool} IS DISTINCT FROM 'platform'`);
      }
    }
    const whereCandidates = and(...candidateConds);

    const whereJobs = andConds(
      inTenant(jobsTable.tenantId, allowed),
      inScope(jobsTable.id, rs.jobIds),
    );
    const whereActiveJobs = andConds(
      eq(jobsTable.status, "active"),
      inTenant(jobsTable.tenantId, allowed),
      inScope(jobsTable.id, rs.jobIds),
    );
    /* "N applications" (the Total Candidates sublabel) must be counted over the
       SAME visible-candidate population as totalCandidates, otherwise an
       application belonging to a hidden candidate (GDPR-erased / do-not-contact /
       pending_profile / hidden platform-pool) inflates the applications number
       while its candidate is not counted — e.g. "1 candidate / 2 applications".
       Restrict applications to those whose candidate passes whereCandidates. */
    const visibleCandidateIds = db
      .select({ id: candidatesTable.id })
      .from(candidatesTable)
      .where(whereCandidates);
    const whereApplications = andConds(
      inTenant(applicationsTable.tenantId, allowed),
      inScope(applicationsTable.jobId, rs.jobIds),
      inArray(applicationsTable.candidateId, visibleCandidateIds),
    );
    const whereInterviews = andConds(
      eq(interviewSessionsTable.status, "completed"),
      inTenant(interviewSessionsTable.tenantId, allowed),
      sessionJobScope(rs.jobIds),
      restrictToCompliantCandidates(interviewSessionsTable.candidateId),
    );

    if (allowed?.length === 0 || (rs.jobIds !== null && rs.jobIds.length === 0)) {
      return res.json({
        totalJobs: 0,
        activeJobs: 0,
        totalCandidates: 0,
        totalApplications: 0,
        pipelineEntries: 0,
        candidatesInPipeline: 0,
        interviewsCompleted: 0,
        offersExtended: 0,
        hires: 0,
        avgTimeToHireDays: 0,
        avgInterviewScore: 0,
        ghostingRatePercent: 0,
        outreachReplyRate: 0,
        topSources: [],
      });
    }

    const [totalJobs] = await db.select({ count: count() }).from(jobsTable).where(whereJobs);
    const [activeJobs] = await db.select({ count: count() }).from(jobsTable).where(whereActiveJobs);
    const [totalCandidates] = await db
      .select({ count: count() })
      .from(candidatesTable)
      .where(whereCandidates);
    /* "Applications" (formal) counts only FORMAL pipeline entries — entry_type in
       ('applied','manual') — so the headline number is not inflated by prospects
       the AI merely sourced. `pipelineEntries` is every application row (all
       entry types) and `candidatesInPipeline` is the distinct candidates with any
       application (drives the Total Candidates sublabel). By construction
       totalApplications + sourced entries === pipelineEntries. */
    const [totalApplications] = await db
      .select({ count: count() })
      .from(applicationsTable)
      .where(
        andConds(whereApplications, inArray(applicationsTable.entryType, ["applied", "manual"])),
      );
    const [pipelineEntries] = await db
      .select({ count: count() })
      .from(applicationsTable)
      .where(whereApplications);
    /* candidatesInPipeline = distinct candidates with LIVE pipeline presence, so
       it excludes terminal-negative stages (rejected/withdrawn/offer_declined) —
       a candidate who only ever left through a negative exit is no longer "in
       pipelines". pipelineEntries/totalApplications above intentionally keep all
       stages (they count entries/formal applications, not live presence). */
    const [candidatesInPipeline] = await db
      .select({ count: sql<number>`count(distinct ${applicationsTable.candidateId})` })
      .from(applicationsTable)
      .where(
        andConds(
          whereApplications,
          notInArray(applicationsTable.stage, [...TERMINAL_NEGATIVE_STAGES]),
        ),
      );
    const [interviewsDone] = await db
      .select({ count: count() })
      .from(interviewSessionsTable)
      .where(whereInterviews);

    const applications = await db
      .select({ stage: applicationsTable.stage })
      .from(applicationsTable)
      .where(whereApplications);
    const offers = applications.filter((a) => a.stage === "offer").length;
    const hires = applications.filter((a) => a.stage === "hired").length;

    const candidates = await db
      .select({ id: candidatesTable.id, source: candidatesTable.source })
      .from(candidatesTable)
      .where(whereCandidates);

    /* ── Per-source conversion: of the candidates from a given source, what
     * fraction reached a hired application? Real ratio — null when a source has
     * no candidates so the UI shows "—" instead of a fabricated number. */
    const sourceCounts: Record<string, number> = {};
    const candidateSource = new Map<string, string>();
    for (const c of candidates) {
      const src = c.source || "Other";
      sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      candidateSource.set(c.id, src);
    }
    const hiredApps = await db
      .select({ candidateId: applicationsTable.candidateId })
      .from(applicationsTable)
      .where(
        andConds(
          eq(applicationsTable.stage, "hired"),
          inTenant(applicationsTable.tenantId, allowed),
          inScope(applicationsTable.jobId, rs.jobIds),
        ),
      );
    const hiredBySource: Record<string, number> = {};
    for (const h of hiredApps) {
      const src = candidateSource.get(h.candidateId);
      if (src) hiredBySource[src] = (hiredBySource[src] || 0) + 1;
    }
    const topSources = Object.entries(sourceCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([source, cnt]) => ({
        source,
        count: cnt,
        conversionRate: cnt > 0 ? (hiredBySource[source] || 0) / cnt : null,
      }));

    /* ── Avg interview score — real average of completed sessions that carry a
     * score. null when none are scored yet. */
    const [scoreAgg] = await db
      .select({ avg: sql<number | null>`avg(${interviewSessionsTable.score})` })
      .from(interviewSessionsTable)
      .where(
        andConds(
          eq(interviewSessionsTable.status, "completed"),
          sql`${interviewSessionsTable.score} IS NOT NULL`,
          inTenant(interviewSessionsTable.tenantId, allowed),
          sessionJobScope(rs.jobIds),
          restrictToCompliantCandidates(interviewSessionsTable.candidateId),
        ),
      );
    const avgInterviewScore =
      scoreAgg?.avg != null ? Math.round(Number(scoreAgg.avg) * 10) / 10 : null;

    /* ── Ghosting rate — share of started interviews the candidate abandoned or
     * let expire, out of all that reached a terminal state. null when no
     * interviews have concluded yet. */
    const sessionStatuses = await db
      .select({ status: interviewSessionsTable.status })
      .from(interviewSessionsTable)
      .where(
        andConds(
          inTenant(interviewSessionsTable.tenantId, allowed),
          sessionJobScope(rs.jobIds),
          restrictToCompliantCandidates(interviewSessionsTable.candidateId),
        ),
      );
    let terminal = 0,
      ghosted = 0;
    for (const s of sessionStatuses) {
      if (s.status === "completed") terminal++;
      else if (s.status === "abandoned" || s.status === "expired") {
        terminal++;
        ghosted++;
      }
    }
    const ghostingRatePercent = terminal > 0 ? Math.round((ghosted / terminal) * 1000) / 10 : null;

    /* ── Outreach reply rate — sum of replied / sum of sent across campaigns.
     * null when nothing has been sent. */
    const [replyAgg] = await db
      .select({
        sent: sql<number>`coalesce(sum(${outreachCampaignsTable.sentCount}), 0)`,
        replied: sql<number>`coalesce(sum(${outreachCampaignsTable.repliedCount}), 0)`,
      })
      .from(outreachCampaignsTable)
      .where(
        andConds(
          inTenant(outreachCampaignsTable.tenantId, allowed),
          inScope(outreachCampaignsTable.jobId, rs.jobIds),
        ),
      );
    const sentTotal = Number(replyAgg?.sent ?? 0);
    const outreachReplyRate = sentTotal > 0 ? Number(replyAgg?.replied ?? 0) / sentTotal : null;

    /* ── Avg time-to-hire — for hired applications, days from creation to the
     * final (hire) decision. Falls back to updatedAt when finalDecisionAt is
     * absent. null when there are no hires yet. */
    const hiredTimed = await db
      .select({
        createdAt: applicationsTable.createdAt,
        finalDecisionAt: applicationsTable.finalDecisionAt,
        updatedAt: applicationsTable.updatedAt,
      })
      .from(applicationsTable)
      .where(
        andConds(
          eq(applicationsTable.stage, "hired"),
          inTenant(applicationsTable.tenantId, allowed),
          inScope(applicationsTable.jobId, rs.jobIds),
          restrictToCompliantCandidates(applicationsTable.candidateId),
        ),
      );
    let hireDaysSum = 0,
      hireDaysN = 0;
    for (const h of hiredTimed) {
      const end = (h.finalDecisionAt ?? h.updatedAt)?.getTime();
      const start = h.createdAt?.getTime();
      if (end != null && start != null && end >= start) {
        hireDaysSum += (end - start) / 86_400_000;
        hireDaysN++;
      }
    }
    const avgTimeToHireDays =
      hireDaysN > 0 ? Math.round((hireDaysSum / hireDaysN) * 10) / 10 : null;

    res.json({
      totalJobs: Number(totalJobs.count),
      activeJobs: Number(activeJobs.count),
      totalCandidates: Number(totalCandidates.count),
      totalApplications: Number(totalApplications.count),
      pipelineEntries: Number(pipelineEntries.count),
      candidatesInPipeline: Number(candidatesInPipeline.count),
      interviewsCompleted: Number(interviewsDone.count),
      offersExtended: offers,
      hires,
      avgTimeToHireDays,
      avgInterviewScore,
      ghostingRatePercent,
      outreachReplyRate,
      topSources,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load analytics overview" });
  }
});

router.get("/analytics/funnel", resolveUser, async (req, res) => {
  try {
    const allowed = await tenantFilter(req);
    const { jobId } = req.query;

    /* Full funnel: Sourced → Applied → Screening → Interview →
     * HM Review → Offer Extended → Offer Accepted → Hired → Started.
     * Each count is "reached this stage or beyond" so the bar chart
     * accurately represents conversion loss at each gate. */
    const FUNNEL_STAGES = [
      { key: "sourced", label: "Sourced" },
      { key: "applied", label: "Applied" },
      { key: "screening", label: "Screening" },
      { key: "interview_completed", label: "Interviewed" },
      { key: "hm_review", label: "HM Review" },
      { key: "offer_extended", label: "Offer Extended" },
      { key: "offer_accepted", label: "Offer Accepted" },
      { key: "hired", label: "Hired" },
      { key: "started", label: "Started" },
    ] as const;

    const rs = await recruiterScope(req);
    // A recruiter querying a specific jobId may only see their own reqs.
    const jobIdParamOutOfScope =
      !!jobId && rs.jobIds !== null && !rs.jobIds.includes(jobId as string);
    if (
      allowed?.length === 0 ||
      (rs.jobIds !== null && rs.jobIds.length === 0) ||
      jobIdParamOutOfScope
    ) {
      return res.json({
        jobId: jobId || null,
        stages: FUNNEL_STAGES.map((s) => ({ stage: s.label, count: 0, conversionRate: null })),
      });
    }

    let whereClause = andConds(
      inTenant(applicationsTable.tenantId, allowed),
      inScope(applicationsTable.jobId, rs.jobIds),
      // Compliance: never count GDPR-erased / do-not-contact candidates.
      restrictToCompliantCandidates(applicationsTable.candidateId),
    );
    if (jobId) {
      whereClause = whereClause
        ? and(whereClause, eq(applicationsTable.jobId, jobId as string))
        : eq(applicationsTable.jobId, jobId as string);
    }

    const applications = await db
      .select({ stage: applicationsTable.stage, candidateId: applicationsTable.candidateId })
      .from(applicationsTable)
      .where(whereClause);

    /* Map each stage to an ordinal so we can check "reached this stage or beyond". */
    const stageOrder: Record<string, number> = {};
    const ALL_ORDERED = [
      "sourced",
      "applied",
      "screening",
      "verification",
      "shortlisted",
      "phone_screen",
      "assessment",
      "interview_scheduled",
      "interview",
      "interview_completed",
      "hm_review",
      "offer",
      "offer_recommended",
      "offer_extended",
      "offer_accepted",
      "hired",
      "started",
    ];
    ALL_ORDERED.forEach((s, i) => {
      stageOrder[s] = i;
    });

    /* Count DISTINCT CANDIDATES who reached each stage (not application rows).
       A candidate in two pipelines is one person in the funnel, so the Sourced
       bar can never exceed the total candidate count — and each bar reads as
       "how many people reached this stage or beyond". */
    const counts: Record<string, number> = {};
    FUNNEL_STAGES.forEach(({ key }) => {
      const threshold = stageOrder[key] ?? -1;
      const ids = new Set<string>();
      for (const a of applications) {
        if (TERMINAL_NEGATIVE_STAGE_SET.has(a.stage)) continue;
        if ((stageOrder[a.stage] ?? -1) >= threshold) ids.add(a.candidateId);
      }
      counts[key] = ids.size;
    });

    const stagesData = FUNNEL_STAGES.map(({ key, label }, idx) => ({
      stage: label,
      count: counts[key] || 0,
      conversionRate: idx === 0 ? null : counts[key] / (counts[FUNNEL_STAGES[idx - 1].key] || 1),
    }));

    res.json({ jobId: jobId || null, stages: stagesData });
  } catch (err) {
    res.status(500).json({ error: "Failed to load funnel data" });
  }
});

router.get("/analytics/trend", resolveUser, async (req, res) => {
  try {
    const allowed = await tenantFilter(req);
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const rs = await recruiterScope(req);
    if (allowed?.length === 0 || (rs.jobIds !== null && rs.jobIds.length === 0)) {
      const months = buildMonthBuckets();
      return res.json({
        trend: months.map(({ label }) => ({
          month: label,
          hires: 0,
          interviews: 0,
          applications: 0,
        })),
      });
    }

    const appWhere = andConds(
      gte(applicationsTable.createdAt, sixMonthsAgo),
      inTenant(applicationsTable.tenantId, allowed),
      inScope(applicationsTable.jobId, rs.jobIds),
      restrictToCompliantCandidates(applicationsTable.candidateId),
    );

    const ivWhere = andConds(
      eq(interviewSessionsTable.status, "completed"),
      gte(interviewSessionsTable.completedAt, sixMonthsAgo),
      inTenant(interviewSessionsTable.tenantId, allowed),
      sessionJobScope(rs.jobIds),
      restrictToCompliantCandidates(interviewSessionsTable.candidateId),
    );

    const [applications, interviews] = await Promise.all([
      db
        .select({ stage: applicationsTable.stage, createdAt: applicationsTable.createdAt })
        .from(applicationsTable)
        .where(appWhere),
      db
        .select({
          completedAt: interviewSessionsTable.completedAt,
          status: interviewSessionsTable.status,
        })
        .from(interviewSessionsTable)
        .where(ivWhere),
    ]);

    const months = buildMonthBuckets();
    const getMonth = (d: Date | null | undefined) => {
      if (!d) return null;
      const dt = d instanceof Date ? d : new Date(d);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    };

    const trend = months.map(({ month, label }) => ({
      month: label,
      hires: applications.filter((a) => a.stage === "hired" && getMonth(a.createdAt) === month)
        .length,
      interviews: interviews.filter((i) => getMonth(i.completedAt) === month).length,
      applications: applications.filter((a) => getMonth(a.createdAt) === month).length,
    }));

    res.json({ trend });
  } catch (err) {
    res.status(500).json({ error: "Failed to load trend data" });
  }
});

router.get("/analytics/score-distribution", resolveUser, async (req, res) => {
  try {
    const allowed = await tenantFilter(req);

    const rs = await recruiterScope(req);
    if (allowed?.length === 0 || (rs.jobIds !== null && rs.jobIds.length === 0)) {
      const distribution = ["90-100", "80-89", "70-79", "60-69", "50-59", "<50"].map((range) => ({
        range,
        count: 0,
      }));
      return res.json({ distribution, total: 0 });
    }

    const whereClause = andConds(
      eq(interviewSessionsTable.status, "completed"),
      inTenant(interviewSessionsTable.tenantId, allowed),
      sessionJobScope(rs.jobIds),
      restrictToCompliantCandidates(interviewSessionsTable.candidateId),
    );

    const sessions = await db
      .select({ score: interviewSessionsTable.score })
      .from(interviewSessionsTable)
      .where(whereClause);

    const buckets: Record<string, number> = {
      "90-100": 0,
      "80-89": 0,
      "70-79": 0,
      "60-69": 0,
      "50-59": 0,
      "<50": 0,
    };

    for (const s of sessions) {
      if (s.score == null) continue;
      const score = Math.round(s.score);
      if (score >= 90) buckets["90-100"]++;
      else if (score >= 80) buckets["80-89"]++;
      else if (score >= 70) buckets["70-79"]++;
      else if (score >= 60) buckets["60-69"]++;
      else if (score >= 50) buckets["50-59"]++;
      else buckets["<50"]++;
    }

    const distribution = Object.entries(buckets).map(([range, cnt]) => ({ range, count: cnt }));
    res.json({ distribution, total: sessions.length });
  } catch (err) {
    res.status(500).json({ error: "Failed to load score distribution" });
  }
});

/* ── GET /analytics/dashboard ─────────────────────────────────────────────── */
router.get("/analytics/dashboard", resolveUser, async (req, res) => {
  try {
    const user = req.resolvedUser!;
    const allowed = await getDataScopeTenantIds(user);
    const rs = await recruiterScope(req);

    if (allowed?.length === 0 || (rs.jobIds !== null && rs.jobIds.length === 0)) {
      return res.json({ recommendedActions: [], agentActivity: [], outreachReplyRate: 0 });
    }

    // Tenant + recruiter-scope helpers, keyed by which scope-column a table has.
    const jobScopedWhere = (tenantCol: any, jobIdCol: any, ...extra: any[]) =>
      andConds(inTenant(tenantCol, allowed), inScope(jobIdCol, rs.jobIds), ...extra);
    const candScopedWhere = (tenantCol: any, candIdCol: any, ...extra: any[]) =>
      andConds(inTenant(tenantCol, allowed), inScope(candIdCol, rs.candidateIds), ...extra);

    /* ── Recommended Actions ── */
    const actions: any[] = [];

    // 1. New applications awaiting review (applied stage)
    const [newApps] = await db
      .select({ count: count() })
      .from(applicationsTable)
      .where(
        jobScopedWhere(
          applicationsTable.tenantId,
          applicationsTable.jobId,
          eq(applicationsTable.stage, "applied"),
        ),
      );
    if (Number(newApps.count) > 0) {
      actions.push({
        id: "new-apps",
        priority: "high",
        label: `${newApps.count} New Application${Number(newApps.count) > 1 ? "s" : ""} Awaiting Review`,
        detail: "Candidates in applied stage — ready for screening",
        cta: "Review",
        icon: "Users",
        href: "/jobs",
        color: "text-emerald-400",
        ctaVariant: "default",
      });
    }

    // 2. Ghosting risks
    const [ghostRow] = await db
      .select({ cnt: count() })
      .from(ghostingRisksTable)
      .where(
        candScopedWhere(
          ghostingRisksTable.tenantId,
          ghostingRisksTable.candidateId,
          inArray(ghostingRisksTable.riskLevel, ["high", "critical"] as any),
        ),
      );
    const ghostTotal = Number(ghostRow?.cnt ?? 0);
    if (ghostTotal > 0) {
      actions.push({
        id: "ghosting",
        priority: "high",
        label: `${ghostTotal} Ghosting Risk${ghostTotal > 1 ? "s" : ""} Detected`,
        detail: "Candidates at risk of dropping off — follow up required",
        cta: "View",
        icon: "AlertTriangle",
        href: "/candidates",
        color: "text-yellow-400",
        ctaVariant: "outline",
      });
    }

    // 3. Open outreach campaigns needing attention
    const outreachDraft = await db
      .select({ id: outreachCampaignsTable.id, name: outreachCampaignsTable.name })
      .from(outreachCampaignsTable)
      .where(
        jobScopedWhere(
          outreachCampaignsTable.tenantId,
          outreachCampaignsTable.jobId,
          eq(outreachCampaignsTable.status, "draft"),
        ),
      )
      .limit(3);
    if (outreachDraft.length > 0) {
      actions.push({
        id: "outreach-draft",
        priority: "medium",
        label: `${outreachDraft.length} Outreach Campaign${outreachDraft.length > 1 ? "s" : ""} Ready to Launch`,
        detail: outreachDraft.map((c) => c.name).join(", "),
        cta: "Launch",
        icon: "Send",
        href: "/outreach",
        color: "text-cyan-400",
        ctaVariant: "default",
      });
    }

    // 4. Sourced applications (candidates sourced, not yet in pipeline)
    const [sourcedApps] = await db
      .select({ count: count() })
      .from(applicationsTable)
      .where(
        jobScopedWhere(
          applicationsTable.tenantId,
          applicationsTable.jobId,
          eq(applicationsTable.stage, "sourced"),
        ),
      );
    if (Number(sourcedApps.count) > 0) {
      actions.push({
        id: "sourced",
        priority: "medium",
        label: `${sourcedApps.count} Sourced Candidate${Number(sourcedApps.count) > 1 ? "s" : ""} Ready for Screening`,
        detail: "Run the screening agent to evaluate and score them",
        cta: "Screen Now",
        icon: "Zap",
        href: "/jobs",
        color: "text-violet-400",
        ctaVariant: "outline",
      });
    }

    // 5. Interview sessions completed without review
    const [completedInterviews] = await db
      .select({ count: count() })
      .from(interviewSessionsTable)
      .where(
        andConds(
          inTenant(interviewSessionsTable.tenantId, allowed),
          sessionJobScope(rs.jobIds),
          eq(interviewSessionsTable.status, "completed"),
        ),
      );
    if (Number(completedInterviews.count) > 0) {
      actions.push({
        id: "interviews",
        priority: "low",
        label: `${completedInterviews.count} AI Interview${Number(completedInterviews.count) > 1 ? "s" : ""} Completed`,
        detail: "Review scores and decide next steps",
        cta: "Review",
        icon: "Video",
        href: "/interviews",
        color: "text-violet-400",
        ctaVariant: "ghost",
      });
    }

    /* ── Agent Activity Feed ── */
    const runs = await db
      .select()
      .from(pipelineRunsTable)
      .where(jobScopedWhere(pipelineRunsTable.tenantId, pipelineRunsTable.jobId))
      .orderBy(desc(pipelineRunsTable.startedAt))
      .limit(10);

    // Get job titles for runs
    const jobIds = [...new Set(runs.map((r) => r.jobId).filter(Boolean))];
    const jobs =
      jobIds.length > 0
        ? await db
            .select({ id: jobsTable.id, title: jobsTable.title })
            .from(jobsTable)
            .where(inArray(jobsTable.id, jobIds as string[]))
        : [];
    const jobMap = Object.fromEntries(jobs.map((j) => [j.id, j.title]));

    const recentSessions = await db
      .select({
        id: interviewSessionsTable.id,
        status: interviewSessionsTable.status,
        score: interviewSessionsTable.score,
        completedAt: interviewSessionsTable.completedAt,
        startedAt: interviewSessionsTable.startedAt,
        lastActiveAt: interviewSessionsTable.lastActiveAt,
        createdAt: interviewSessionsTable.createdAt,
        candidateId: interviewSessionsTable.candidateId,
      })
      .from(interviewSessionsTable)
      .where(
        andConds(inTenant(interviewSessionsTable.tenantId, allowed), sessionJobScope(rs.jobIds)),
      )
      /* Order by REAL activity recency, not `completedAt`. In Postgres
         `ORDER BY completed_at DESC` sorts NULLs FIRST, so never-completed
         sessions (scheduled / abandoned) float to the top and masquerade as the
         latest activity — the exact bug that made 5 never-started sessions read
         as "in progress · just now". Coalesce to the most recent real timestamp
         so the feed reflects actual recency. Fetch a wider window so post-dedupe
         (below) we still have variety, then slice. */
      .orderBy(
        desc(
          sql`COALESCE(${interviewSessionsTable.completedAt}, ${interviewSessionsTable.lastActiveAt}, ${interviewSessionsTable.startedAt}, ${interviewSessionsTable.createdAt})`,
        ),
      )
      .limit(20);

    const agentActivity: any[] = [];

    /* Relative-time formatter grounded in a REAL epoch-ms timestamp. Never call
       this with `Date.now()` as a stand-in for a missing event time — a now()
       fallback prints "just now" forever for rows that never had activity (the
       original interview-feed bug). Adds day granularity so a 4-day-old
       scheduled row reads "4 days ago", not "98 hr ago". */
    const formatAgo = (ms: number) => {
      const diffMin = Math.max(0, Math.round((Date.now() - ms) / 60000));
      if (diffMin < 1) return "just now";
      if (diffMin < 60) return `${diffMin} min ago`;
      const hr = Math.round(diffMin / 60);
      if (hr < 24) return `${hr} hr ago`;
      const d = Math.round(hr / 24);
      return `${d} day${d > 1 ? "s" : ""} ago`;
    };

    // Pipeline runs → agent activity entries
    for (const run of runs) {
      const stageArr: any[] = Array.isArray(run.stages) ? run.stages : [];
      const currentStage =
        stageArr.find((s: any) => s.status === "running") ?? stageArr[stageArr.length - 1];
      const agentLabel = currentStage?.agentId
        ? currentStage.agentId.charAt(0).toUpperCase() + currentStage.agentId.slice(1) + " Agent"
        : "AI Agent";
      const jobTitle = run.jobId ? (jobMap[run.jobId] ?? "Unknown Job") : "Unknown Job";

      const started = run.startedAt ? new Date(run.startedAt).getTime() : Date.now();
      const ago = formatAgo(started);

      // `interrupted` (a run orphaned by a server restart, see
      // lib/pipeline-runs/reconcile) is deliberately NOT mapped to "flagged":
      // it's an infrastructure event, not an agent failure, so it must stay out
      // of failure surfacing. Neutral "pending"-class badge, distinct label.
      let statusMapped: "running" | "completed" | "pending" | "flagged" = "pending";
      if (run.status === "running") statusMapped = "running";
      else if (run.status === "completed") statusMapped = "completed";
      else if (run.status === "failed") statusMapped = "flagged";

      const stagesCompleted = stageArr.filter((s: any) => s.status === "completed").length;

      agentActivity.push({
        id: run.id,
        agent: agentLabel,
        action:
          run.status === "running"
            ? `Pipeline running for "${jobTitle}"`
            : run.status === "completed"
              ? `Pipeline completed for "${jobTitle}"`
              : run.status === "failed"
                ? `Pipeline failed for "${jobTitle}"`
                : run.status === "interrupted"
                  ? `Pipeline interrupted for "${jobTitle}" (server restart)`
                  : `Pipeline pending for "${jobTitle}"`,
        meta: stagesCompleted > 0 ? `${stagesCompleted} of ${stageArr.length} stages done` : null,
        status: statusMapped,
        ago,
        _sortMs: started,
        icon: "Zap",
        color: "text-primary",
      });
    }

    /* ── Interview sessions → activity entries ──────────────────────────────
     * Ground each row's badge + label in the session's REAL status instead of
     * labelling every non-completed session "in progress · just now". Only a
     * genuinely-live session (candidate actively answering) reads as "running";
     * a link that was generated but never started reads as "scheduled"; a
     * timed-out / expired session reads as a distinct terminal state.
     *
     * DEDUPE: the /interviews/generate-link path mints a fresh plan+session on
     * every click, so one candidate can accumulate N identical "scheduled" rows
     * (the root cause of the 5 phantom rows — see the duplicate-minting report).
     * We collapse by candidate + mapped-status into a single feed row and note
     * the count, rather than spamming the panel with duplicates. */
    const LIVE_STATUSES = new Set(["active", "in_progress", "resumed"]);
    type IvAgg = { entry: any; sortMs: number; count: number };
    const ivByKey = new Map<string, IvAgg>();

    for (const sess of recentSessions) {
      let statusMapped: "running" | "completed" | "pending" | "flagged";
      let label: string;
      // The timestamp that actually grounds this row's status — never now().
      let eventAt: Date | null;
      if (sess.status === "completed") {
        statusMapped = "completed";
        label = `AI Interview completed${sess.score != null ? ` — score ${Math.round(sess.score)}` : ""}`;
        eventAt = sess.completedAt ?? sess.lastActiveAt ?? sess.startedAt ?? sess.createdAt;
      } else if (LIVE_STATUSES.has(sess.status)) {
        statusMapped = "running";
        label = "AI Interview in progress";
        eventAt = sess.lastActiveAt ?? sess.startedAt ?? sess.createdAt;
      } else if (sess.status === "abandoned" || sess.status === "expired") {
        statusMapped = "flagged";
        label =
          sess.status === "expired"
            ? "AI Interview expired (never started)"
            : "AI Interview abandoned";
        eventAt = sess.lastActiveAt ?? sess.startedAt ?? sess.createdAt;
      } else if (sess.status === "flagged") {
        statusMapped = "flagged";
        label = "AI Interview flagged for review";
        eventAt = sess.lastActiveAt ?? sess.startedAt ?? sess.createdAt;
      } else {
        // scheduled / invited / opened / verified / paused → link exists, not live
        statusMapped = "pending";
        label = "AI Interview scheduled";
        eventAt = sess.createdAt;
      }

      // createdAt is NOT NULL, so there is always a truthful anchor.
      const ms = (eventAt ?? sess.createdAt).getTime();
      const key = `${sess.candidateId ?? sess.id}|${statusMapped}`;
      const agg = ivByKey.get(key);
      if (agg) {
        agg.count += 1;
        if (ms > agg.sortMs) agg.sortMs = ms; // keep the most recent event time
        continue;
      }
      ivByKey.set(key, {
        sortMs: ms,
        count: 1,
        entry: {
          id: `sess-${sess.id}`,
          agent: "Interview Agent",
          action: label,
          meta:
            statusMapped === "completed" && sess.score != null
              ? `Score: ${Math.round(sess.score)}/100`
              : null,
          status: statusMapped,
          icon: "Video",
          color: "text-violet-400",
        },
      });
    }

    for (const { entry, sortMs, count } of ivByKey.values()) {
      entry.ago = formatAgo(sortMs);
      if (count > 1) entry.meta = `${count} sessions`;
      entry._sortMs = sortMs;
      agentActivity.push(entry);
    }

    // Sort by real recency (most recent first) using the numeric event time.
    agentActivity.sort((a, b) => (b._sortMs ?? 0) - (a._sortMs ?? 0));

    /* ── Outreach reply rate ── */
    const campaigns = await db
      .select({
        enrolled: outreachCampaignsTable.enrolledCount,
        replied: outreachCampaignsTable.repliedCount,
      })
      .from(outreachCampaignsTable)
      .where(jobScopedWhere(outreachCampaignsTable.tenantId, outreachCampaignsTable.jobId));
    const totalEnrolled = campaigns.reduce((s, c) => s + (c.enrolled ?? 0), 0);
    const totalReplied = campaigns.reduce((s, c) => s + (c.replied ?? 0), 0);
    const outreachReplyRate =
      totalEnrolled > 0 ? Math.round((totalReplied / totalEnrolled) * 100) : 0;

    const agentStatuses = orchestrator.getAgentStatuses();
    /* "Agents online" reflects all autonomous work Lexy is doing RIGHT NOW:
     *   (a) in-flight orchestrator/agent runs (queued/running), PLUS
     *   (b) genuinely-live AI interviews — the interviewer IS an agent.
     * A session counts as live only when its status is active/in_progress/resumed
     * AND its heartbeat is fresh (last activity within LIVE_INTERVIEW_HEARTBEAT_MS).
     * The heartbeat gate is critical: a session stuck "active" for days (not yet
     * swept by the lifecycle scheduler) must NOT inflate the count, or the header
     * would falsely read "System Active" with no real work happening. Zero →
     * "System Ready"; >0 → "System Active — N agents running". */
    const LIVE_INTERVIEW_HEARTBEAT_MS = 30 * 60 * 1000; // 30 min silence ⇒ not live
    const liveHeartbeatCutoff = new Date(Date.now() - LIVE_INTERVIEW_HEARTBEAT_MS);
    const [activeRunsRow] = await db
      .select({ count: count() })
      .from(agentRunsTable)
      .where(
        jobScopedWhere(
          agentRunsTable.tenantId,
          agentRunsTable.workOrderId,
          inArray(agentRunsTable.status, ["queued", "running"] as any),
        ),
      );
    const [liveInterviewsRow] = await db
      .select({ count: count() })
      .from(interviewSessionsTable)
      .where(
        andConds(
          inTenant(interviewSessionsTable.tenantId, allowed),
          sessionJobScope(rs.jobIds),
          inArray(interviewSessionsTable.status, ["active", "in_progress", "resumed"] as any),
          gte(
            sql`COALESCE(${interviewSessionsTable.lastActiveAt}, ${interviewSessionsTable.startedAt}, ${interviewSessionsTable.createdAt})`,
            liveHeartbeatCutoff,
          ),
        ),
      );
    const agentsOnline = Number(activeRunsRow?.count ?? 0) + Number(liveInterviewsRow?.count ?? 0);

    // The single most recent in-flight run (newest first) so the Agent Activity
    // panel can take over its empty state with that run's live event stream.
    const [activeRunRow] = await db
      .select({
        id: agentRunsTable.id,
        workOrderId: agentRunsTable.workOrderId,
        jobTitle: jobsTable.title,
      })
      .from(agentRunsTable)
      .leftJoin(jobsTable, eq(jobsTable.id, agentRunsTable.workOrderId))
      .where(
        jobScopedWhere(
          agentRunsTable.tenantId,
          agentRunsTable.workOrderId,
          inArray(agentRunsTable.status, ["queued", "running"] as any),
        ),
      )
      .orderBy(desc(agentRunsTable.createdAt))
      .limit(1);
    const activeRun = activeRunRow
      ? {
          id: activeRunRow.id,
          workOrderId: activeRunRow.workOrderId,
          jobTitle: activeRunRow.jobTitle,
        }
      : null;

    res.json({
      recommendedActions: actions,
      agentActivity: agentActivity.slice(0, 10).map(({ _sortMs, ...rest }) => rest),
      outreachReplyRate,
      agentsOnline,
      agentsTotal: agentStatuses.length,
      activeRun,
    });
  } catch (err: any) {
    logger.error({ err }, "[dashboard] failed");
    res.status(500).json({ error: "Failed to load dashboard data" });
  }
});

/* ── GET /analytics/engagement ────────────────────────────────────────────── */
router.get("/analytics/engagement", resolveUser, async (req, res) => {
  try {
    const user = req.resolvedUser!;
    const allowed = await getDataScopeTenantIds(user);
    const rs = await recruiterScope(req);

    if (allowed?.length === 0 || (rs.jobIds !== null && rs.jobIds.length === 0)) {
      return res.json({
        poolHealth: { active: 0, passive: 0, inactive: 0, total: 0 },
        reengagementSent: { total: 0, thisMonth: 0, trend: [] },
        commsByType: [],
        recentEvents: [],
        ghostingSummary: { critical: 0, high: 0, medium: 0, low: 0 },
        outreachSummary: { totalSent: 0, totalReplied: 0, replyRate: 0, campaigns: 0 },
      });
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 86_400_000);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    /* ── 1. Platform pool health ── */
    /* Aggregate pool-health metric (counts + staleness), never per-candidate PII
       to the employer; erased/DNC excluded elsewhere in this handler. Aggregate
       shape is exempt from the per-employer visibility seal (Step-2 policy note
       applies to whether visibility controls should shrink these numbers). */
    platformReadExemption(PLATFORM_READ_EXEMPTION.AGGREGATE_ANALYTICS_COUNT);
    const platformWhere = andConds(
      eq(candidatesTable.pool as any, "platform"),
      inTenant(candidatesTable.tenantId, allowed),
      inScope(candidatesTable.id, rs.candidateIds),
    );

    const platformCandidates = await db
      .select({ id: candidatesTable.id, updatedAt: candidatesTable.updatedAt })
      .from(candidatesTable)
      .where(platformWhere);

    // Get last push timestamps for all platform candidates
    const platIds = platformCandidates.map((c) => c.id);
    const lastPushes =
      platIds.length > 0
        ? await db
            .select({
              candidateId: (talentPoolSubmissionsTable as any).candidateId,
              maxPushedAt: sql<string>`MAX(${(talentPoolSubmissionsTable as any).pushedAt})`,
            })
            .from(talentPoolSubmissionsTable)
            .where(inArray((talentPoolSubmissionsTable as any).candidateId, platIds))
            .groupBy((talentPoolSubmissionsTable as any).candidateId)
        : [];

    const pushMap = new Map<string, Date>();
    for (const r of lastPushes) {
      if (r.candidateId && r.maxPushedAt) pushMap.set(r.candidateId, new Date(r.maxPushedAt));
    }

    let active = 0,
      passive = 0,
      inactive = 0;
    for (const c of platformCandidates) {
      const updatedDate = c.updatedAt ? new Date(c.updatedAt as any) : new Date(0);
      const lastPush = pushMap.get(c.id);
      const lastActive = lastPush && lastPush > updatedDate ? lastPush : updatedDate;
      const daysSince = Math.floor((now.getTime() - lastActive.getTime()) / 86_400_000);
      if (daysSince <= 30) active++;
      else if (daysSince <= 90) passive++;
      else inactive++;
    }

    /* ── 2. Re-engagement communication events ── */
    const commWhere = andConds(
      eq((communicationEventsTable as any).type, "re_engagement"),
      inTenant((communicationEventsTable as any).tenantId, allowed),
      inScope((communicationEventsTable as any).candidateId, rs.candidateIds),
    );

    const allReEngagement = await db
      .select({
        id: (communicationEventsTable as any).id,
        sentAt: (communicationEventsTable as any).sentAt,
        status: (communicationEventsTable as any).status,
        candidateId: (communicationEventsTable as any).candidateId,
        subject: (communicationEventsTable as any).subject,
        createdAt: (communicationEventsTable as any).createdAt,
      })
      .from(communicationEventsTable)
      .where(commWhere)
      .orderBy(desc((communicationEventsTable as any).createdAt));

    const thisMonthReEng = allReEngagement.filter((e) => {
      const ts = e.sentAt ? new Date(e.sentAt as any) : new Date(e.createdAt as any);
      return ts >= startOfMonth;
    }).length;

    // Build 14-day trend buckets
    const trendBuckets: { date: string; label: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      trendBuckets.push({ date: key, label, count: 0 });
    }
    for (const e of allReEngagement) {
      const ts = e.sentAt ? new Date(e.sentAt as any) : new Date(e.createdAt as any);
      if (ts < fourteenDaysAgo) continue;
      const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")}`;
      const bucket = trendBuckets.find((b) => b.date === key);
      if (bucket) bucket.count++;
    }

    /* ── 3. Communications by type (all types, last 30 days) ── */
    const recentCommWhere = andConds(
      gte((communicationEventsTable as any).createdAt, thirtyDaysAgo),
      inTenant((communicationEventsTable as any).tenantId, allowed),
      inScope((communicationEventsTable as any).candidateId, rs.candidateIds),
    );

    const recentComms = await db
      .select({
        type: (communicationEventsTable as any).type,
        status: (communicationEventsTable as any).status,
      })
      .from(communicationEventsTable)
      .where(recentCommWhere);

    const typeMap: Record<string, number> = {};
    for (const c of recentComms) {
      const t = c.type ?? "other";
      typeMap[t] = (typeMap[t] ?? 0) + 1;
    }
    const commsByType = Object.entries(typeMap)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type: type.replace(/_/g, " "), count }));

    /* ── 4. Recent re-engagement events (with candidate name) ── */
    const recentEventRows = allReEngagement.slice(0, 12);
    const candidateIds = [...new Set(recentEventRows.map((e) => e.candidateId).filter(Boolean))];
    const candidateNames =
      candidateIds.length > 0
        ? await db
            .select({
              id: candidatesTable.id,
              firstName: candidatesTable.firstName,
              lastName: candidatesTable.lastName,
            })
            .from(candidatesTable)
            .where(inArray(candidatesTable.id, candidateIds as string[]))
        : [];
    const nameMap = Object.fromEntries(
      candidateNames.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]),
    );

    const recentEvents = recentEventRows.map((e) => ({
      id: e.id,
      candidateId: e.candidateId,
      candidateName: e.candidateId ? (nameMap[e.candidateId] ?? "Unknown") : "Unknown",
      subject: e.subject,
      status: e.status,
      sentAt: e.sentAt ?? e.createdAt,
    }));

    /* ── 5. Ghosting risk summary ── */
    const ghostWhere = andConds(
      inTenant(ghostingRisksTable.tenantId, allowed),
      inScope(ghostingRisksTable.candidateId, rs.candidateIds),
    );
    const ghostRows = await db
      .select({ riskLevel: ghostingRisksTable.riskLevel })
      .from(ghostingRisksTable)
      .where(ghostWhere);
    const ghostSummary = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const g of ghostRows) {
      const lv = g.riskLevel as keyof typeof ghostSummary;
      if (lv in ghostSummary) ghostSummary[lv]++;
    }

    /* ── 6. Outreach summary ── */
    const campWhere = andConds(
      inTenant(outreachCampaignsTable.tenantId, allowed),
      inScope(outreachCampaignsTable.jobId, rs.jobIds),
    );
    const camps = await db
      .select({
        enrolled: outreachCampaignsTable.enrolledCount,
        replied: outreachCampaignsTable.repliedCount,
        sent: outreachCampaignsTable.sentCount,
      })
      .from(outreachCampaignsTable)
      .where(campWhere);
    const totalEnrolled = camps.reduce((s, c) => s + (c.enrolled ?? 0), 0);
    const totalReplied = camps.reduce((s, c) => s + (c.replied ?? 0), 0);
    const totalSent = camps.reduce((s, c) => s + (c.sent ?? 0), 0);

    res.json({
      poolHealth: { active, passive, inactive, total: platformCandidates.length },
      reengagementSent: {
        total: allReEngagement.length,
        thisMonth: thisMonthReEng,
        trend: trendBuckets,
      },
      commsByType,
      recentEvents,
      ghostingSummary: ghostSummary,
      outreachSummary: {
        totalSent,
        totalReplied,
        replyRate: totalEnrolled > 0 ? Math.round((totalReplied / totalEnrolled) * 100) : 0,
        campaigns: camps.length,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "[engagement] failed");
    res.status(500).json({ error: "Failed to load engagement metrics" });
  }
});

/* ── POST /engagement/run-reengagement ───────────────────────────────────── */
router.post(
  "/engagement/run-reengagement",
  validate({ body: EmptyEngagementBody }),
  resolveUser,
  async (req, res) => {
    try {
      const { runCandidateReengagement } =
        await import("../lib/candidate-reengagement-scheduler.js");
      const result = await runCandidateReengagement();
      res.json({ ok: true, ...result });
    } catch (err: any) {
      logger.error({ err }, "[run-reengagement] failed");
      res.status(500).json({ error: "Re-engagement run failed" });
    }
  },
);

/* ── POST /engagement/scan-linkedin ─────────────────────────────────────────
 * Manual trigger for the Candidate Status Check-in engine. The run spans ALL
 * tenants (cross-tenant outbound email), so it is restricted to platform_admin
 * — everyone else relies on the daily scheduled run. */
router.post(
  "/engagement/scan-linkedin",
  validate({ body: EmptyEngagementBody }),
  resolveUser,
  async (req: any, res) => {
    try {
      const user = req.resolvedUser!;
      if (user.role !== "platform_admin") {
        return res
          .status(403)
          .json({
            error:
              "Forbidden — manual status check-in runs are restricted to platform_admin. The engine runs automatically every day.",
          });
      }
      const result = await runLinkedInProfileMonitor();
      res.json({ ok: true, ...result });
    } catch (err: any) {
      logger.error({ err }, "[scan-linkedin] failed");
      res.status(500).json({ error: "Scan failed" });
    }
  },
);

/* ── GET /engagement/linkedin-status ───────────────────────────────────────
 * Last check-in run summary (aggregate counts only — the per-candidate
 * `details` array is stripped for non-platform staff). */
router.get("/engagement/linkedin-status", resolveUser, async (req: any, res) => {
  try {
    const user = req.resolvedUser!;
    if (!["platform_admin", "tenant_admin", "recruiter_admin", "recruiter"].includes(user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const last = getLastLinkedInScanResult();
    if (!last) return res.json({ lastScan: null });
    const { details, ...counts } = last;
    res.json({ lastScan: user.role === "platform_admin" ? last : counts });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get status" });
  }
});

function buildMonthBuckets() {
  const months: { month: string; label: string }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    months.push({
      month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleString("en-US", { month: "short" }),
    });
  }
  return months;
}

/* ── GET /analytics/diversity ──────────────────────────────────────────────
 * Aggregate-only sourcing-equity dashboard.
 *
 * Strict k-anonymity: any bucket smaller than K_THRESHOLD is collapsed into
 * a single "not_enough_data" entry so individuals can never be re-identified
 * from public-facing analytics. This is the entire compliance story for why
 * we let recruiters see *aggregate* demographics at all — without it, on a
 * small pipeline a "1 candidate · Black female · sourced via X" bucket
 * would effectively dox the person.
 *
 * Recruiters CANNOT pivot from this endpoint to an individual demographic
 * record. The `/candidates/:id` route does not join `candidate_demographics`
 * — and adding such a join would violate the design contract documented in
 * schema/candidate-demographics.ts.
 *
 * Tuning K_THRESHOLD: 5 is the de-facto floor for HR analytics (EEOC EEO-1
 * uses 5, OFCCP audits use 3 with extra cell-suppression). Bump higher only
 * if a tenant explicitly requests it; lowering below 5 would be a
 * compliance regression.
 */
const K_THRESHOLD = 5;

router.get("/analytics/diversity", resolveUser, async (req, res) => {
  try {
    const allowed = await tenantFilter(req);
    const rs = await recruiterScope(req);
    if (allowed?.length === 0 || (rs.candidateIds !== null && rs.candidateIds.length === 0)) {
      return res.json({
        total: 0,
        kThreshold: K_THRESHOLD,
        gender: [],
        raceEthnicity: [],
        veteranStatus: [],
        disabilityStatus: [],
        bySource: [],
        note: "No data",
      });
    }
    const whereCands = andConds(
      inTenant(candidatesTable.tenantId, allowed),
      inScope(candidatesTable.id, rs.candidateIds),
    );
    /* INNER join — only candidates who actively self-identified contribute
     * to the aggregate. Candidates who skipped the form are simply not in
     * the denominator. */
    const rows = await db
      .select({
        candidateId: candidatesTable.id,
        source: candidatesTable.source,
        gender: candidateDemographicsTable.gender,
        raceEthnicity: candidateDemographicsTable.raceEthnicity,
        veteranStatus: candidateDemographicsTable.veteranStatus,
        disabilityStatus: candidateDemographicsTable.disabilityStatus,
      })
      .from(candidatesTable)
      .innerJoin(
        candidateDemographicsTable,
        eq(candidatesTable.id, candidateDemographicsTable.candidateId),
      )
      .where(whereCands);

    const total = rows.length;

    /* k-anonymity on the *total* itself: if fewer than K candidates have
     * disclosed at all, even returning a precise total leaks participation
     * volume (e.g. in a 3-candidate pipeline "2 disclosed" pinpoints which
     * two). Suppress everything and tell the UI to render the "not yet
     * unlocked" empty state. */
    if (total < K_THRESHOLD) {
      return res.json({
        total,
        kThreshold: K_THRESHOLD,
        gender: [],
        raceEthnicity: [],
        veteranStatus: [],
        disabilityStatus: [],
        bySource: [],
        note: "Below k-anonymity threshold",
      });
    }

    function tally(
      values: Array<string | null | undefined>,
    ): Array<{ label: string; count: number }> {
      const counts = new Map<string, number>();
      for (const v of values) {
        const k = v ?? "prefer_not_to_say";
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return [...counts.entries()].map(([label, c]) => ({ label, count: c }));
    }
    function collapse(
      buckets: Array<{ label: string; count: number }>,
    ): Array<{ label: string; count: number }> {
      const big = buckets.filter((b) => b.count >= K_THRESHOLD);
      const smallSum = buckets
        .filter((b) => b.count < K_THRESHOLD)
        .reduce((a, b) => a + b.count, 0);
      const out = [...big].sort((a, b) => b.count - a.count);
      if (smallSum > 0) out.push({ label: "not_enough_data", count: smallSum });
      return out;
    }
    /* Race/ethnicity is multi-select on the form; explode into one row per
     * label per candidate before bucketing so "Black + Hispanic" counts in
     * both. Candidates with no race data contribute one "prefer_not_to_say". */
    const raceFlat: string[] = [];
    for (const r of rows) {
      if (r.raceEthnicity && r.raceEthnicity.length > 0) raceFlat.push(...r.raceEthnicity);
      else raceFlat.push("prefer_not_to_say");
    }

    /* Source × gender matrix for the sourcing-equity story: "which channels
     * deliver underrepresented candidates?" Sources with <K total
     * demographics are dropped entirely (we don't even surface the source
     * name) to avoid a "1 candidate from referral-bob" leak. */
    const bySourceMap = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const src = r.source ?? "unknown";
      const g = r.gender ?? "prefer_not_to_say";
      if (!bySourceMap.has(src)) bySourceMap.set(src, new Map());
      const inner = bySourceMap.get(src)!;
      inner.set(g, (inner.get(g) ?? 0) + 1);
    }
    const bySource = [...bySourceMap.entries()]
      .map(([source, inner]) => {
        const totalSrc = [...inner.values()].reduce((a, b) => a + b, 0);
        if (totalSrc < K_THRESHOLD) return null;
        return {
          source,
          total: totalSrc,
          gender: collapse([...inner.entries()].map(([label, c]) => ({ label, count: c }))),
        };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => b.total - a.total);

    return res.json({
      total,
      kThreshold: K_THRESHOLD,
      gender: collapse(tally(rows.map((r) => r.gender))),
      raceEthnicity: collapse(tally(raceFlat)),
      veteranStatus: collapse(tally(rows.map((r) => r.veteranStatus))),
      disabilityStatus: collapse(tally(rows.map((r) => r.disabilityStatus))),
      bySource,
    });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[analytics/diversity] failed");
    return res.status(500).json({ error: "Failed to compute diversity" });
  }
});

/* ── GET /analytics/aedt-export ───────────────────────────────────────────────
 * NYC Local Law 144 bias-audit export.
 *
 * Returns CSV that an independent auditor can drop into a Jupyter notebook
 * to compute selection rates and impact ratios per the DCWP rules
 * (6 RCNY § 5-301). One row per AI decision recorded in
 * ai_decision_log, joined to:
 *   - candidate_demographics (LEFT join — undisclosed candidates still
 *     appear so the auditor knows the disclosure rate)
 *   - applications.stage (the *final* recruiter decision, so the auditor
 *     can compare "AI said advance / recruiter advanced?")
 *
 * Tenant scoping: standard tenantFilter() pattern. platform_admin gets
 * all tenants. Caller without job access gets empty CSV.
 *
 * k-anonymity is NOT applied at row level here — the CSV is delivered
 * directly to a NAMED auditor under contract (DPA Annex C → Sentry-style
 * confidentiality), not to a recruiter dashboard. The export endpoint is
 * gated by tenant role; a separate platform-admin export covers
 * cross-tenant auditor workflows.
 */
const AEDT_EXPORT_HEADER =
  "decision_id,decided_at,tenant_id,job_id,candidate_id,decision_type,score,label,input_hash,model_id,gender,race_ethnicity,veteran_status,disability_status,final_stage\n";

router.get("/analytics/aedt-export", resolveUser, async (req: any, res) => {
  try {
    /* Role gate: bias-audit exports contain row-level AI decisions joined
     * to candidate demographics — sensitive enough that we restrict to
     * platform_admin and tenant_admin (the compliance-owner role).
     * Regular recruiters get the aggregate /analytics/diversity view
     * instead. 403 (not 404) so the compliance owner knows the endpoint
     * exists but their account lacks permission. */
    const user = req.resolvedUser!;
    if (!["platform_admin", "tenant_admin"].includes(user.role)) {
      return res
        .status(403)
        .json({
          error: "Forbidden — AEDT export is restricted to platform_admin and tenant_admin.",
        });
    }

    const allowed = await tenantFilter(req);
    if (allowed?.length === 0) {
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="aedt-export-empty.csv"`);
      return res.send(AEDT_EXPORT_HEADER);
    }

    const jobIdParam = typeof req.query.jobId === "string" ? req.query.jobId : null;

    /* Build the WHERE: tenant filter, optional jobId filter, AEDT-flagged
     * jobs only (only AEDT jobs require auditor reproducibility). */
    const conds: any[] = [];
    if (allowed) conds.push(inArray(aiDecisionLogTable.tenantId, allowed));
    if (jobIdParam) conds.push(eq(aiDecisionLogTable.jobId, jobIdParam));
    conds.push(eq(jobsTable.aedtEnabled, true));
    const whereClause = conds.length > 1 ? and(...conds) : conds[0];

    const rows = await db
      .select({
        decisionId: aiDecisionLogTable.id,
        decidedAt: aiDecisionLogTable.createdAt,
        tenantId: aiDecisionLogTable.tenantId,
        jobId: aiDecisionLogTable.jobId,
        candidateId: aiDecisionLogTable.candidateId,
        decisionType: aiDecisionLogTable.decisionType,
        score: aiDecisionLogTable.score,
        label: aiDecisionLogTable.label,
        inputHash: aiDecisionLogTable.inputHash,
        modelId: aiDecisionLogTable.modelId,
        gender: candidateDemographicsTable.gender,
        raceEthnicity: candidateDemographicsTable.raceEthnicity,
        veteranStatus: candidateDemographicsTable.veteranStatus,
        disability: candidateDemographicsTable.disabilityStatus,
        finalStage: applicationsTable.stage,
      })
      .from(aiDecisionLogTable)
      .innerJoin(jobsTable, eq(aiDecisionLogTable.jobId, jobsTable.id))
      .leftJoin(
        candidateDemographicsTable,
        eq(aiDecisionLogTable.candidateId, candidateDemographicsTable.candidateId),
      )
      .leftJoin(
        applicationsTable,
        and(
          eq(applicationsTable.candidateId, aiDecisionLogTable.candidateId),
          eq(applicationsTable.jobId, aiDecisionLogTable.jobId),
        ),
      )
      .where(whereClause)
      .orderBy(desc(aiDecisionLogTable.createdAt))
      .limit(50_000); // hard cap; auditor uses /from /to for windowing in v2

    /* CSV escaping with formula-injection neutralization.
     *
     * Step 1 (anti-formula): any cell starting with =, +, -, @, tab, CR
     * is prefixed with a single quote ('). When opened in Excel or
     * Google Sheets, those characters would otherwise trigger formula
     * execution against attacker-controlled content (e.g. an AI label
     * or imported demographics text starting with "=cmd|"). Prefixing
     * neutralises the formula trigger; the leading quote is shown as
     * a literal in the cell but not interpreted.
     *
     * Step 2 (RFC-4180): quote fields containing comma, quote, or
     * newline; double-up internal quotes.
     *
     * Array fields (raceEthnicity is text[]) are joined with '|' so
     * single-cell auditor analysis still works. */
    const esc = (v: any): string => {
      if (v === null || v === undefined) return "";
      let s = Array.isArray(v) ? v.join("|") : String(v);
      if (s.length > 0 && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = AEDT_EXPORT_HEADER;
    const body = rows
      .map((r) =>
        [
          r.decisionId,
          r.decidedAt instanceof Date ? r.decidedAt.toISOString() : r.decidedAt,
          r.tenantId,
          r.jobId ?? "",
          r.candidateId ?? "",
          r.decisionType,
          r.score ?? "",
          r.label ?? "",
          r.inputHash ?? "",
          r.modelId ?? "",
          r.gender ?? "",
          r.raceEthnicity ?? "",
          r.veteranStatus ?? "",
          r.disability ?? "",
          r.finalStage ?? "",
        ]
          .map(esc)
          .join(","),
      )
      .join("\n");

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader(
      "content-disposition",
      `attachment; filename="aedt-export-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(header + body + (body ? "\n" : ""));
  } catch (err: any) {
    logger.error({ err: err?.message }, "[analytics/aedt-export] failed");
    res.status(500).json({ error: "Failed to generate AEDT export" });
  }
});

/* ── GET /analytics/adverse-impact ────────────────────────────────────────────
 * Four-fifths (80%) rule adverse-impact monitoring across the hiring funnel.
 *
 * For each protected attribute the candidate VOLUNTARILY self-identified
 * (gender, race/ethnicity, veteran, disability — from candidate_demographics),
 * and for each funnel milestone (screened → interviewed → offer → hired), we
 * compute each group's *selection rate* = (# in group who reached the
 * milestone) / (# in group who applied). The group with the highest selection
 * rate is the reference; every other group's impact ratio = its rate ÷ the
 * reference rate. Per the EEOC Uniform Guidelines, an impact ratio below 0.80
 * is flagged as potential adverse impact.
 *
 * ─── Statistical-validity / privacy gate ──────────────────────────────────────
 * A group whose applicant pool is below MIN_GROUP_N contributes NO ratio and is
 * marked `insufficientData` — a 4/5ths ratio computed on a handful of people is
 * both statistically meaningless and a re-identification risk. If fewer than two
 * groups clear the gate, the whole milestone is `insufficientData` (nothing to
 * compare against). This is the deterministic "insufficient data" fallback: we
 * never fabricate a ratio we cannot stand behind.
 *
 * ─── Furthest-stage reconstruction ────────────────────────────────────────────
 * applications.stage is current-only — a candidate rejected after the interview
 * now reads `rejected`, losing the fact that they reached the interview. So the
 * furthest milestone a (candidate, job) reached is the MAX of the application's
 * current stage level and the highest level implied by its immutable
 * candidate_events log. Sparse event/stage data simply yields lower reached
 * counts, which the MIN_GROUP_N gate then surfaces as "insufficient data".
 *
 * ─── Access ───────────────────────────────────────────────────────────────────
 * Admin-only (platform_admin / tenant_admin) — the same compliance-owner role
 * trusted with the raw AEDT export. Regular recruiters never see this; the
 * aggregate, k-anonymised /analytics/diversity view is their ceiling. Group
 * counts ARE shown here because the audience is the compliance owner, but ratios
 * still require MIN_GROUP_N for validity.
 */
/* The 4/5ths math (thresholds, stage/event level maps, unit collapse, per-group
 * ratio analysis) is PURE and lives in lib/adverse-impact.ts, where it is
 * locked in by unit tests (lib/adverse-impact.test.ts, `pnpm test:adverse-impact`).
 * This route only fetches rows and assembles the response. */

router.get("/analytics/adverse-impact", resolveUser, async (req: any, res) => {
  try {
    const user = req.resolvedUser!;
    if (!["platform_admin", "tenant_admin"].includes(user.role)) {
      return res
        .status(403)
        .json({
          error:
            "Forbidden — fairness analytics are restricted to platform_admin and tenant_admin.",
        });
    }

    const jobIdParam = typeof req.query.jobId === "string" ? req.query.jobId : null;

    /* TWO population views (EEOC guidance). The FORMAL adverse-impact report covers
     * applicants who entered a formal pipeline (entry_type applied/manual) — the
     * recognised applicant pool for 4/5ths analysis. The separate SOURCING-fairness
     * view covers prospects the AI merely surfaced (entry_type 'sourced'): a
     * top-of-funnel sourcing-equity audit, NOT a formal adverse-impact population.
     * Every response states its population definition + entry_type filter so a
     * report can never be read out of context. */
    const populationKey = req.query.population === "sourced" ? "sourced" : "formal";
    const POPULATIONS = {
      formal: {
        key: "formal",
        label: "Formal applicants",
        entryTypes: ["applied", "manual"],
        definition:
          "Candidates who entered a formal pipeline (applied directly or were manually added). This is the recognised applicant pool for 4/5ths adverse-impact analysis.",
      },
      sourced: {
        key: "sourced",
        label: "Sourced prospects",
        entryTypes: ["sourced"],
        definition:
          "Prospects the AI sourcing agent surfaced who have not entered a formal pipeline. Top-of-funnel sourcing-equity audit only — NOT a formal adverse-impact population.",
      },
    } as const;
    const population = POPULATIONS[populationKey];

    const allowed = await tenantFilter(req);

    /* Denominator for the demographic-coverage disclosure: EVERY unit in the
     * selected population, whether or not the candidate self-identified. */
    const appConds: any[] = [inArray(applicationsTable.entryType, population.entryTypes as any)];
    if (allowed) appConds.push(inArray(applicationsTable.tenantId, allowed));
    if (jobIdParam) appConds.push(eq(applicationsTable.jobId, jobIdParam));
    const appWhere = appConds.length > 1 ? and(...appConds) : appConds[0];

    const popRows =
      allowed?.length === 0
        ? []
        : await db
            .select({
              candidateId: applicationsTable.candidateId,
              jobId: applicationsTable.jobId,
            })
            .from(applicationsTable)
            .where(appWhere);
    const popUnits = new Set(popRows.map((r) => `${r.candidateId}::${r.jobId}`)).size;

    /* Honest coverage state: how many of the population actually self-identified.
     * With <k disclosures no ratios can be computed and we say so explicitly. */
    const buildCoverage = (withDemographics: number) => {
      const pct = popUnits > 0 ? Math.round((withDemographics / popUnits) * 100) : 0;
      const missingPct = 100 - pct;
      return {
        totalUnits: popUnits,
        withDemographics,
        disclosedPercent: pct,
        missingPercent: missingPct,
        sufficient: withDemographics >= MIN_GROUP_N,
        message:
          popUnits === 0
            ? `No ${population.label.toLowerCase()} in scope yet.`
            : withDemographics < MIN_GROUP_N
              ? `Insufficient demographic data: only ${withDemographics} of ${popUnits} ${population.label.toLowerCase()} (${pct}%) self-identified — below the k=${MIN_GROUP_N} reporting threshold, so no fairness ratios can be computed. ${missingPct}% of this population has no demographic data on file.`
              : `${withDemographics} of ${popUnits} ${population.label.toLowerCase()} (${pct}%) self-identified; ${missingPct}% have no demographic data on file and are excluded from the ratios below.`,
      };
    };

    const emptyResp = {
      generatedAt: new Date().toISOString(),
      thresholds: { minGroupN: MIN_GROUP_N, fourFifths: FOUR_FIFTHS },
      scope: { jobId: jobIdParam },
      population,
      demographicCoverage: buildCoverage(0),
      milestones: ADVERSE_MILESTONES.map((m) => ({ key: m.key, label: m.label })),
      attributes: [] as any[],
      anyFlagged: false,
      totalAnalyzed: 0,
    };
    if (allowed?.length === 0) return res.json(emptyResp);

    /* Base pool: one row per (candidate, job) application in the selected
     * population that ALSO has a voluntary demographics row (INNER join —
     * candidates who skipped self-ID are excluded from every denominator). */
    const baseRows = await db
      .select({
        candidateId: applicationsTable.candidateId,
        jobId: applicationsTable.jobId,
        stage: applicationsTable.stage,
        gender: candidateDemographicsTable.gender,
        raceEthnicity: candidateDemographicsTable.raceEthnicity,
        veteranStatus: candidateDemographicsTable.veteranStatus,
        disabilityStatus: candidateDemographicsTable.disabilityStatus,
      })
      .from(applicationsTable)
      .innerJoin(
        candidateDemographicsTable,
        eq(applicationsTable.candidateId, candidateDemographicsTable.candidateId),
      )
      .where(appWhere);

    if (baseRows.length === 0) return res.json(emptyResp);

    /* Furthest level reached per (candidate, job) from the immutable event log. */
    const evConds: any[] = [];
    if (allowed) evConds.push(inArray(candidateEventsTable.tenantId, allowed));
    if (jobIdParam) evConds.push(eq(candidateEventsTable.jobId, jobIdParam));
    const evWhere = evConds.length > 1 ? and(...evConds) : evConds[0];
    const evRows = await db
      .select({
        candidateId: candidateEventsTable.candidateId,
        jobId: candidateEventsTable.jobId,
        eventType: candidateEventsTable.eventType,
      })
      .from(candidateEventsTable)
      .where(evWhere);
    const evMax = buildEventMax(evRows);
    const units = buildUnits(baseRows, evMax);
    const attributes = analyzeAllAttributes(units);
    const anyFlagged = attributes.some((a) =>
      a.milestones.some((m) => m.groups.some((g) => g.flagged)),
    );

    return res.json({
      generatedAt: new Date().toISOString(),
      thresholds: { minGroupN: MIN_GROUP_N, fourFifths: FOUR_FIFTHS },
      scope: { jobId: jobIdParam },
      population,
      demographicCoverage: buildCoverage(units.length),
      milestones: ADVERSE_MILESTONES.map((m) => ({ key: m.key, label: m.label })),
      attributes,
      anyFlagged,
      totalAnalyzed: units.length,
    });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[analytics/adverse-impact] failed");
    return res.status(500).json({ error: "Failed to compute adverse impact" });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * MORNING REPORT  (Step 1 — read-only data contract, no UI)
 *
 * A per-user dashboard briefing that answers "what changed since I last looked?".
 * The SERVER decides FACTS only (which sentence types are non-zero and their
 * counts); the CLIENT renders the copy — so wording can change without touching
 * data. Every count is computed with the SAME canonical predicates + shared
 * scope helpers used by its source surface, plus the universal compliance seal
 * (restrictToCompliantCandidates / compliantCandidatePredicate). An erased or
 * do-not-contact candidate must therefore NEVER appear in any count.
 *
 * Honesty doctrine: no page-local reinvented queries. Each count reconciles
 * exactly with the queue / log it links to (e.g. awaiting_decision mirrors
 * GET /applications/pending-human-review for the same scope).
 *
 * Sentence ranking (ascending rank = higher priority; the client shows the top
 * few): decisions(1) > blockers(2) > failures(3) > completions(4) > news(5).
 *
 * Variants:
 *   welcome — user has never seen a report (last_report_seen_at IS NULL).
 *   quiet   — has seen one, but nothing is non-zero since then.
 *   report  — has seen one and ≥1 sentence is non-zero.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* Only human staff who work requisitions/queues get a Morning Report. Candidates
 * (who also carry a tenantId + role) are blocked with 403 — the report exposes
 * cross-candidate operational counts. */
const MORNING_REPORT_ROLES = new Set([
  "platform_admin",
  "tenant_admin",
  "recruiter",
  "recruiter_admin",
  "hiring_manager",
]);

/* SQL mirror of isRealEmail()'s negative case (see lib/real-email.ts): an email
 * that is empty or on a known placeholder domain is NOT deliverable, so the
 * candidate is blocked from outreach until real contact info arrives. Derived
 * from the single PLACEHOLDER_DOMAINS constant so the two never drift. */
function nonDeliverableEmailSql(col: any) {
  const likes = PLACEHOLDER_DOMAINS.map((d) => sql`lower(${col}) LIKE ${"%" + d}`);
  return sql`(${col} IS NULL OR btrim(${col}) = '' OR ${sql.join(likes, sql` OR `)})`;
}

router.get("/analytics/morning-report", resolveUser, async (req, res) => {
  try {
    const user = req.resolvedUser!;
    if (!MORNING_REPORT_ROLES.has(user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const generatedAt = new Date();

    /* Watermark lives on the identity row (not tenant-scoped). resolveUser
     * already loaded this exact row, so read it off req.resolvedUser instead of
     * re-querying the identity row — one fewer round trip per dashboard load. */
    const lastSeen = user.lastReportSeenAt ?? null;

    const allowed = await tenantFilter(req); // null=admin, []=none, string[]
    const rs = await recruiterScope(req); // recruiter narrowing (else nulls)

    /* No visible scope at all (recruiter with no assignments, or a tenant
     * ceiling of []) → no roles are active / set up. */
    const noScope =
      (allowed !== null && allowed.length === 0) || (rs.jobIds !== null && rs.jobIds.length === 0);

    /* Count of the caller's ACTIVE roles (jobs.status = 'active') in scope —
     * used by the welcome ("N roles are set up") and quiet ("N roles active")
     * states. Canonical "active" definition matches GET /analytics/overview. */
    const countActiveRoles = async (): Promise<number> => {
      if (noScope) return 0;
      const [row] = await db
        .select({ n: count() })
        .from(jobsTable)
        .where(
          andConds(
            eq(jobsTable.status, "active"),
            inTenant(jobsTable.tenantId, allowed),
            inScope(jobsTable.id, rs.jobIds),
          ),
        );
      return Number(row?.n ?? 0);
    };

    /* First-ever visit → welcome. No "since" window yet; the client shows an
     * onboarding greeting that points at the work orders. */
    if (!lastSeen) {
      const rolesSetUp = await countActiveRoles();
      return res.json({
        variant: "welcome",
        sinceLastSeen: null,
        generatedAt: generatedAt.toISOString(),
        sentences: [],
        rolesSetUp,
        nextAction: { type: "run_sourcing", linkTarget: { view: "work_orders" } },
      });
    }

    if (noScope) {
      return res.json({
        variant: "quiet",
        sinceLastSeen: lastSeen.toISOString(),
        generatedAt: generatedAt.toISOString(),
        sentences: [],
        rolesActive: 0,
        nextAction: null,
      });
    }

    const sentences: Array<{
      sentenceType: string;
      count: number;
      textParams: Record<string, number>;
      linkTarget: { view: string; params?: Record<string, string> };
      rank: number;
    }> = [];

    /* ── 1. AWAITING DECISION (rank 1) ────────────────────────────────────
     * Mirrors the governance pending-human-review queue: applications with an
     * AI recommendation still awaiting a human final_decision. Same scope +
     * compliance seal, so this reconciles with
     * GET /applications/pending-human-review. */
    const [reviewRow] = await db
      .select({ n: count() })
      .from(applicationsTable)
      .where(
        andConds(
          isNotNull(applicationsTable.aiRecommendation),
          isNull(applicationsTable.finalDecision),
          inTenant(applicationsTable.tenantId, allowed),
          inScope(applicationsTable.jobId, rs.jobIds),
          restrictToCompliantCandidates(applicationsTable.candidateId),
        ),
      );
    const nReview = Number(reviewRow?.n ?? 0);
    if (nReview > 0) {
      sentences.push({
        sentenceType: "awaiting_decision",
        count: nReview,
        textParams: { count: nReview },
        linkTarget: { view: "approval_queue" },
        rank: 1,
      });
    }

    /* ── 2. BLOCKED WORK (rank 2) ─────────────────────────────────────────
     * DISTINCT in-pipeline candidates (have ≥1 application in scope) whose
     * email is non-deliverable — they are blocked from outreach until contact
     * info is fixed. Compliant only. */
    const blockedRows = await db
      .selectDistinct({ candidateId: applicationsTable.candidateId })
      .from(applicationsTable)
      .innerJoin(candidatesTable, eq(applicationsTable.candidateId, candidatesTable.id))
      .where(
        andConds(
          inTenant(applicationsTable.tenantId, allowed),
          inScope(applicationsTable.jobId, rs.jobIds),
          nonDeliverableEmailSql(candidatesTable.email),
          compliantCandidatePredicate(),
        ),
      );
    const nBlocked = blockedRows.length;
    if (nBlocked > 0) {
      sentences.push({
        sentenceType: "blocked_work",
        count: nBlocked,
        textParams: { count: nBlocked },
        linkTarget: { view: "pipeline_blocked" },
        rank: 2,
      });
    }

    /* ── 3 + 4. RUNS SINCE LAST SEEN (ranks 3 & 4) ────────────────────────
     * ONE scan of pipeline_runs feeds BOTH the failed/interrupted sentence
     * (rank 3) and the completed sentence (rank 4), and a LEFT JOIN to the
     * per-run sourcing event sums yields candidates-added in the SAME round
     * trip — so these two sentences plus their metric cost a single query
     * instead of three. Runs relate to jobs, not candidates, so no candidate
     * compliance filter applies.
     *
     * The two branches are mutually exclusive by status and each carries its
     * own time predicate (failed/interrupted key off COALESCE(completed,
     * started); completed keys off completed_at), OR'd here and re-split in JS.
     * The event-sum subquery is GROUP BY run_id, so it never multiplies a run
     * row — one row per in-window run. */
    const runEventSums = db
      .select({
        tenantId: pipelineRunEventsTable.tenantId,
        runId: pipelineRunEventsTable.runId,
        added: sql<number>`COALESCE(SUM(${pipelineRunEventsTable.count}), 0)`.as("added"),
      })
      .from(pipelineRunEventsTable)
      .where(
        and(
          eq(pipelineRunEventsTable.type, "step_completed"),
          eq(pipelineRunEventsTable.stepName, "sourcing"),
        ),
      )
      .groupBy(pipelineRunEventsTable.tenantId, pipelineRunEventsTable.runId)
      .as("run_event_sums");

    const runRows = await db
      .select({
        id: pipelineRunsTable.id,
        status: pipelineRunsTable.status,
        added: runEventSums.added,
      })
      .from(pipelineRunsTable)
      /* Join on tenant AND run so event sums can never bind across tenants.
       * run_id is a globally-unique PK today, but keeping the tenant column in
       * the join makes the isolation explicit and self-evident. */
      .leftJoin(
        runEventSums,
        and(
          eq(runEventSums.runId, pipelineRunsTable.id),
          eq(runEventSums.tenantId, pipelineRunsTable.tenantId),
        ),
      )
      .where(
        andConds(
          inTenant(pipelineRunsTable.tenantId, allowed),
          inScope(pipelineRunsTable.jobId, rs.jobIds),
          sql`(
          (${pipelineRunsTable.status} IN ('failed', 'interrupted')
             AND COALESCE(${pipelineRunsTable.completedAt}, ${pipelineRunsTable.startedAt}) > ${lastSeen})
          OR (${pipelineRunsTable.status} = 'completed'
             AND ${pipelineRunsTable.completedAt} > ${lastSeen})
        )`,
        ),
      );

    const failedRows = runRows.filter((r) => r.status === "failed" || r.status === "interrupted");
    const nFailed = failedRows.length;
    if (nFailed > 0) {
      sentences.push({
        sentenceType: "interrupted_failed",
        count: nFailed,
        textParams: { count: nFailed },
        linkTarget:
          nFailed === 1
            ? { view: "run", params: { runId: failedRows[0].id } }
            : { view: "run_history" },
        rank: 3,
      });
    }

    const completedRows = runRows.filter((r) => r.status === "completed");
    const nCompleted = completedRows.length;
    if (nCompleted > 0) {
      const candidatesAdded = completedRows.reduce((s, r) => s + Number(r.added ?? 0), 0);
      sentences.push({
        sentenceType: "completed_work",
        count: nCompleted,
        textParams: { count: nCompleted, candidatesAdded },
        linkTarget: { view: "run_history" },
        rank: 4,
      });
    }

    /* ── 5. REPLIES / EVENTS (rank 5) ─────────────────────────────────────
     * recruiter_inbox_items received since last seen, in scope + compliant.
     * m = "interested" = positive_reply items. */
    const replyRows = await db
      .select({ type: recruiterInboxTable.type })
      .from(recruiterInboxTable)
      .where(
        andConds(
          sql`${recruiterInboxTable.receivedAt} > ${lastSeen}`,
          inTenant(recruiterInboxTable.tenantId, allowed),
          inScope(recruiterInboxTable.candidateId, rs.candidateIds),
          restrictToCompliantCandidates(recruiterInboxTable.candidateId),
        ),
      );
    const nReplies = replyRows.length;
    if (nReplies > 0) {
      const interested = replyRows.filter((r) => r.type === "positive_reply").length;
      sentences.push({
        sentenceType: "replies_events",
        count: nReplies,
        textParams: { count: nReplies, interested },
        linkTarget: { view: "inbox" },
        rank: 5,
      });
    }

    sentences.sort((a, b) => a.rank - b.rank);

    /* blocked_work is a STANDING current-state condition, not "news since you
     * were gone". It must not, on its own, manufacture a report — otherwise the
     * quiet fix-contacts nudge below could never fire. It still renders as a
     * report row whenever there is genuine news to report alongside it. */
    const newsSentences = sentences.filter((s) => s.sentenceType !== "blocked_work");

    if (newsSentences.length === 0) {
      /* QUIET — nothing new happened since last seen. The next action is derived
       * from CURRENT state (not history): fix blocked contacts first, else
       * nudge sourcing for a role that has no candidates yet, else nothing. */
      const rolesActive = await countActiveRoles();
      let nextAction: {
        type: string;
        count?: number;
        roleTitle?: string;
        linkTarget: { view: string; params?: Record<string, string> };
      } | null = null;

      if (nBlocked > 0) {
        nextAction = {
          type: "fix_contacts",
          count: nBlocked,
          linkTarget: { view: "pipeline_blocked" },
        };
      } else {
        /* First active role in scope with zero candidates (no applications). */
        const [emptyRole] = await db
          .select({ id: jobsTable.id, title: jobsTable.title })
          .from(jobsTable)
          .leftJoin(applicationsTable, eq(applicationsTable.jobId, jobsTable.id))
          .where(
            andConds(
              eq(jobsTable.status, "active"),
              inTenant(jobsTable.tenantId, allowed),
              inScope(jobsTable.id, rs.jobIds),
            ),
          )
          .groupBy(jobsTable.id, jobsTable.title)
          .having(sql`COUNT(${applicationsTable.id}) = 0`)
          .orderBy(jobsTable.title)
          .limit(1);
        if (emptyRole) {
          nextAction = {
            type: "source_role",
            roleTitle: emptyRole.title,
            linkTarget: { view: "role", params: { jobId: emptyRole.id } },
          };
        }
      }

      return res.json({
        variant: "quiet",
        sinceLastSeen: lastSeen.toISOString(),
        generatedAt: generatedAt.toISOString(),
        sentences: [],
        rolesActive,
        nextAction,
      });
    }

    return res.json({
      variant: "report",
      sinceLastSeen: lastSeen.toISOString(),
      generatedAt: generatedAt.toISOString(),
      sentences,
    });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[analytics/morning-report] failed");
    return res.status(500).json({ error: "Failed to build morning report" });
  }
});

/* GET /analytics/blocked-candidates
 * The candidate LIST behind the Morning Report "N candidates need contact
 * details" door. It MUST reconcile 1:1 with that door's count, so it reuses the
 * EXACT same predicate (rank-2 BLOCKED WORK above): distinct in-pipeline
 * candidates (≥1 application in scope) whose email is non-deliverable, compliant
 * only, tenant- and recruiter-scoped identically. The client can't derive this
 * set on its own — GET /candidates returns the whole bench (no in-pipeline
 * signal), and intelligence rows only cover already-scored candidates, so
 * unscored-but-blocked candidates would silently vanish from the list. */
router.get("/analytics/blocked-candidates", resolveUser, async (req, res) => {
  try {
    const user = req.resolvedUser!;
    if (!MORNING_REPORT_ROLES.has(user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const allowed = await tenantFilter(req); // null=admin, []=none, string[]
    const rs = await recruiterScope(req); // recruiter narrowing (else nulls)

    const noScope =
      (allowed !== null && allowed.length === 0) || (rs.jobIds !== null && rs.jobIds.length === 0);
    if (noScope) return res.json({ candidates: [] });

    /* Same set as the morning-report BLOCKED WORK count. */
    const blockedRows = await db
      .selectDistinct({ candidateId: applicationsTable.candidateId })
      .from(applicationsTable)
      .innerJoin(candidatesTable, eq(applicationsTable.candidateId, candidatesTable.id))
      .where(
        andConds(
          inTenant(applicationsTable.tenantId, allowed),
          inScope(applicationsTable.jobId, rs.jobIds),
          nonDeliverableEmailSql(candidatesTable.email),
          compliantCandidatePredicate(),
        ),
      );
    const ids = blockedRows.map((r) => r.candidateId).filter(Boolean) as string[];
    if (ids.length === 0) return res.json({ candidates: [] });

    /* Hydrate the candidate detail the card needs. IDs already passed the
     * compliant + non-deliverable-email filter above, so this re-fetch is a
     * plain lookup. */
    const rows = await db
      .select({
        id: candidatesTable.id,
        firstName: candidatesTable.firstName,
        lastName: candidatesTable.lastName,
        email: candidatesTable.email,
        currentTitle: candidatesTable.currentTitle,
        currentCompany: candidatesTable.currentCompany,
        location: candidatesTable.location,
        pool: candidatesTable.pool as any,
      })
      .from(candidatesTable)
      .where(inArray(candidatesTable.id, ids))
      .orderBy(candidatesTable.firstName, candidatesTable.lastName);

    return res.json({ candidates: rows });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[analytics/blocked-candidates] failed");
    return res.status(500).json({ error: "Failed to list blocked candidates" });
  }
});

/* POST /analytics/morning-report/seen
 * Advance the caller's OWN last_report_seen_at watermark (dismissal / next
 * visit). Pure per-user bookkeeping on the identity row — it changes no run,
 * count, queue, or their definitions. Strict empty body. */
const MorningReportSeenBody = z.preprocess((v) => v ?? {}, z.object({}).strict());
router.post(
  "/analytics/morning-report/seen",
  validate({ body: MorningReportSeenBody }),
  resolveUser,
  async (req, res) => {
    const user = req.resolvedUser!;
    if (!MORNING_REPORT_ROLES.has(user.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const now = new Date();
    await controlDb
      .update(usersTable)
      .set({ lastReportSeenAt: now })
      .where(eq(usersTable.id, user.id));
    return res.json({ ok: true, lastReportSeenAt: now.toISOString() });
  },
);

export default router;
