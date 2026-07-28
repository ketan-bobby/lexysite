/**
 * routes/recruiter-performance.ts — Recruiter Performance Analytics
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Powers the "Team Performance" tab on the Analytics page. Returns per-recruiter
 * performance rows plus team aggregates so admins can rank recruiters and a
 * recruiter can benchmark themselves against the team average.
 *
 * The metrics that already exist elsewhere (pipeline funnel, source quality, AI
 * collaboration score) are intentionally NOT recomputed here — this endpoint is
 * only the recruiter-level performance layer (productivity score, leaderboard,
 * SLA & aging, workload/capacity, benchmarking) that those panels lack.
 *
 * ─── Route ───────────────────────────────────────────────────────────────────
 *   GET /analytics/recruiter-performance
 *     → { scope, selfRecruiterId, cohortSize, generatedAt, team, recruiters[] }
 *
 * ─── Scoping (role-aware) ────────────────────────────────────────────────────
 *   platform_admin  → every recruiter (no tenant filter)
 *   tenant_admin    → recruiters in the agency subtree (getAllowedTenantIds)
 *   recruiter_admin → recruiters in their ASSIGNED clients (getDataScopeTenantIds)
 *   recruiter       → SELF ONLY row, but ranked + benchmarked against the team
 *                     cohort (their tenant subtree). Peers' individual rows are
 *                     never returned to a plain recruiter.
 *
 * Attribution flows through jobs.assigned_recruiter_id: a recruiter "owns" the
 * applications/events/outcomes tied to the requisitions assigned to them.
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  usersTable, jobsTable, applicationsTable,
  candidateEventsTable, candidateOutcomesTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { restrictToCompliantCandidates } from "../lib/compliance-scope.js";
import { TERMINAL_NEGATIVE_STAGE_SET } from "../lib/pipeline-stages.js";
import { resolveUser } from "../middlewares/resolveUser";
import { getAllowedTenantIds, getDataScopeTenantIds } from "../lib/tenantUtils";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/* Roles allowed to view the performance dashboard at all. Hiring managers /
 * interviewers / candidates have no recruiter-performance surface. */
const PERFORMANCE_ROLES = new Set(["platform_admin", "tenant_admin", "recruiter_admin", "recruiter"]);

/* Productivity-score weights (sum = 1). Kept here so they are trivially tunable
 * without touching the aggregation logic. Mirrors the spec defaults. */
const SCORE_WEIGHTS = {
  timeToSubmit:     0.20, // faster submit = better
  hireRate:         0.20, // hires / candidates managed
  volume:           0.15, // submission volume (cohort-relative)
  firstReview:      0.15, // speed from application → first recruiter review
  hmConversion:     0.15, // submitted → HM interview %
  offerConversion:  0.15, // offer → hire %
} as const;

/* Event types we pull for timing/conversion. Pulling a narrow set keeps the
 * candidate_events scan bounded even on a busy tenant. */
const RELEVANT_EVENTS = [
  "RECRUITER_REVIEWED",
  "RECRUITER_SHORTLISTED",
  "SUBMITTED_TO_HIRING_MANAGER",
  "HIRING_MANAGER_INTERVIEW_SCHEDULED",
  "HIRING_MANAGER_INTERVIEW_COMPLETED",
  "INTERVIEW_COMPLETED",
  "OFFER_RECOMMENDED",
  "OFFER_EXTENDED",
  "OFFER_ACCEPTED",
  "HIRED",
  "STARTED",
] as const;

const TERMINAL_NEGATIVE = TERMINAL_NEGATIVE_STAGE_SET;
const HIRED_STAGES = new Set(["hired", "started"]);
const OFFER_STAGES = new Set(["offer", "offer_recommended", "offer_extended", "offer_accepted"]);
/* Stages where an application is still awaiting the recruiter's first review. */
const AWAITING_REVIEW_STAGES = new Set(["sourced", "applied", "screening"]);

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Speed score: best days → 100, worst days → 0, linear in between. null in → null. */
function speedScore(days: number | null, best: number, worst: number): number | null {
  if (days == null || !Number.isFinite(days)) return null;
  if (days <= best) return 100;
  if (days >= worst) return 0;
  return clamp(Math.round((100 * (worst - days)) / (worst - best)));
}

/** Rate score: a percentage scaled so `target`% maps to 100. null in → null. */
function rateScore(pct: number | null, target: number): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  return clamp(Math.round((pct / target) * 100));
}

/** A plain percentage clamped to 0..100. null in → null. */
function pctScore(pct: number | null): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  return clamp(Math.round(pct));
}

/** Safe percentage; null when the denominator is 0 (so the UI shows "—"). */
function ratioPct(num: number, den: number): number | null {
  if (!den) return null;
  return (num / den) * 100;
}

/** Weighted blend over the non-null components, renormalising weights. */
function blend(components: Record<string, number | null>): number | null {
  let sum = 0;
  let wsum = 0;
  for (const key of Object.keys(SCORE_WEIGHTS) as Array<keyof typeof SCORE_WEIGHTS>) {
    const v = components[key];
    if (v == null) continue;
    const w = SCORE_WEIGHTS[key];
    sum += v * w;
    wsum += w;
  }
  if (wsum === 0) return null;
  return Math.round(sum / wsum);
}

function avg(nums: Array<number | null | undefined>): number | null {
  const vals = nums.filter((n): n is number => n != null && Number.isFinite(n));
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

interface PerRecruiter {
  recruiterId: string;
  name: string;
  email: string;
  role: string;
  candidatesManaged: number;
  submitted: number;
  interviews: number;
  hmInterviews: number;
  offers: number;
  hires: number;
  placementsValue: number;
  avgTimeToSubmitDays: number | null;
  sla: { firstReviewDays: number | null; reviewToSubmitDays: number | null };
  aging: { over24h: number; over3d: number; staleReqs: number };
  workload: { openReqs: number; inPipeline: number; awaitingReview: number };
  conversion: {
    submitToHm: number | null;
    hmToOffer: number | null;
    offerToHire: number | null;
    overallHire: number | null;
  };
  productivityScore: number | null;
  trendPct: number | null;
  rank: number;
}

router.get("/analytics/recruiter-performance", resolveUser, async (req, res) => {
  try {
    const user = req.resolvedUser!;
    if (!PERFORMANCE_ROLES.has(user.role)) {
      return res.status(403).json({ error: "forbidden" });
    }

    const selfOnly = user.role === "recruiter";
    let scopeLabel: string;
    let cohortTenants: string[] | null;

    if (user.role === "recruiter_admin") {
      cohortTenants = await getDataScopeTenantIds(user); // assigned clients only
      scopeLabel = "clients";
    } else if (user.role === "recruiter") {
      cohortTenants = await getAllowedTenantIds(user); // their tenant subtree (for benchmark)
      scopeLabel = "self";
    } else {
      cohortTenants = await getAllowedTenantIds(user); // subtree, or null for platform_admin
      scopeLabel = user.role === "platform_admin" ? "platform" : "agency";
    }

    const emptyTeam = {
      recruitersActive: 0, totalCandidates: 0, totalSubmitted: 0,
      totalInterviews: 0, totalOffers: 0, totalHires: 0, placementsValue: 0,
      avgTimeToSubmitDays: null as number | null,
      avgProductivityScore: null as number | null,
      avgSubmitToHm: null as number | null,
      avgHmToOffer: null as number | null,
      avgOfferToHire: null as number | null,
    };

    if (cohortTenants && cohortTenants.length === 0) {
      return res.json({
        scope: scopeLabel, selfRecruiterId: user.id, cohortSize: 0,
        generatedAt: new Date().toISOString(), team: emptyTeam, recruiters: [],
      });
    }

    /* 1. Cohort recruiters (recruiter + recruiter_admin, active).
     *
     * Attribution subtlety: plain recruiters are AGENCY-tenant users who get
     * assigned to CLIENT-tenant requisitions. A recruiter_admin's scope
     * (getDataScopeTenantIds) is its assigned CLIENT sub-tenants only — that set
     * does NOT contain the agency tenant the recruiter users live in, so we
     * cannot find the cohort via users.tenant_id. Instead we derive it from who
     * is assigned to jobs in those client tenants. Every other role's scope set
     * DOES include the agency tenant, so the direct user-tenant filter holds. */
    const recruiterConds: any[] = [
      inArray(usersTable.role, ["recruiter", "recruiter_admin"] as Array<typeof usersTable.role.enumValues[number]>),
      eq(usersTable.status, "active"),
    ];
    if (user.role === "recruiter_admin") {
      // cohortTenants is the assigned-client set and is non-empty here (the
      // empty case was short-circuited above). Recruiters in scope = those
      // assigned to a requisition in one of those client tenants.
      const clientJobRows = await db
        .select({ recruiterId: jobsTable.assignedRecruiterId })
        .from(jobsTable)
        .where(and(inArray(jobsTable.tenantId, cohortTenants!), isNotNull(jobsTable.assignedRecruiterId)));
      const assignedIds = [...new Set(
        clientJobRows.map(j => j.recruiterId).filter((x): x is string => !!x),
      )];
      if (assignedIds.length === 0) {
        return res.json({
          scope: scopeLabel, selfRecruiterId: user.id, cohortSize: 0,
          generatedAt: new Date().toISOString(), team: emptyTeam, recruiters: [],
        });
      }
      recruiterConds.push(inArray(usersTable.id, assignedIds));
    } else if (cohortTenants) {
      recruiterConds.push(inArray(usersTable.tenantId, cohortTenants));
    }
    const recruiterUsers = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email, role: usersTable.role })
      .from(usersTable)
      .where(and(...recruiterConds));

    const recruiterIds = recruiterUsers.map(r => r.id);
    if (recruiterIds.length === 0) {
      return res.json({
        scope: scopeLabel, selfRecruiterId: user.id, cohortSize: 0,
        generatedAt: new Date().toISOString(), team: emptyTeam, recruiters: [],
      });
    }

    /* 2. Requisitions assigned to those recruiters, within scope. */
    const jobConds: any[] = [inArray(jobsTable.assignedRecruiterId, recruiterIds)];
    if (cohortTenants) jobConds.push(inArray(jobsTable.tenantId, cohortTenants));
    const jobs = await db
      .select({ id: jobsTable.id, recruiterId: jobsTable.assignedRecruiterId, status: jobsTable.status })
      .from(jobsTable)
      .where(and(...jobConds));

    const jobToRecruiter = new Map<string, string>();
    const openReqsByRecruiter = new Map<string, number>();
    for (const j of jobs) {
      if (!j.recruiterId) continue;
      jobToRecruiter.set(j.id, j.recruiterId);
      if (j.status === "active") {
        openReqsByRecruiter.set(j.recruiterId, (openReqsByRecruiter.get(j.recruiterId) ?? 0) + 1);
      }
    }
    const jobIds = [...jobToRecruiter.keys()];

    /* 3. Applications, 4. events, 5. outcomes — all bounded by jobIds. */
    const apps = jobIds.length
      ? await db
          .select({
            id: applicationsTable.id, jobId: applicationsTable.jobId,
            candidateId: applicationsTable.candidateId, stage: applicationsTable.stage,
            createdAt: applicationsTable.createdAt,
          })
          .from(applicationsTable)
          // Compliance: exclude GDPR-erased / do-not-contact candidates from
          // every recruiter metric (candidatesManaged, submitted, hires, …).
          .where(and(
            inArray(applicationsTable.jobId, jobIds),
            restrictToCompliantCandidates(applicationsTable.candidateId),
          ))
      : [];

    const events = jobIds.length
      ? await db
          .select({
            jobId: candidateEventsTable.jobId,
            applicationId: candidateEventsTable.applicationId,
            eventType: candidateEventsTable.eventType,
            eventTimestamp: candidateEventsTable.eventTimestamp,
          })
          .from(candidateEventsTable)
          .where(and(
            inArray(candidateEventsTable.jobId, jobIds),
            inArray(candidateEventsTable.eventType, RELEVANT_EVENTS as unknown as Array<typeof candidateEventsTable.eventType.enumValues[number]>),
          ))
      : [];

    const outcomes = jobIds.length
      ? await db
          .select({
            jobId: candidateOutcomesTable.jobId,
            applicationId: candidateOutcomesTable.applicationId,
            hireDate: candidateOutcomesTable.hireDate,
            offerAmount: candidateOutcomesTable.offerAmount,
            offerAccepted: candidateOutcomesTable.offerAccepted,
          })
          .from(candidateOutcomesTable)
          .where(inArray(candidateOutcomesTable.jobId, jobIds))
      : [];

    /* ── Per-application timestamps from the event log (earliest of each). ── */
    const appCreatedAt = new Map<string, number>();
    const appReviewAt = new Map<string, number>();
    const appSubmitAt = new Map<string, number>();
    const appHmAt = new Map<string, number>();
    const appInterviewAt = new Map<string, number>();
    const appOfferAt = new Map<string, number>();
    const appHiredAt = new Map<string, number>();
    for (const a of apps) {
      if (a.createdAt) appCreatedAt.set(a.id, new Date(a.createdAt).getTime());
    }
    const setEarliest = (m: Map<string, number>, key: string | null, ts: number) => {
      if (!key) return;
      const prev = m.get(key);
      if (prev == null || ts < prev) m.set(key, ts);
    };
    for (const e of events) {
      if (!e.applicationId || !e.eventTimestamp) continue;
      const ts = new Date(e.eventTimestamp).getTime();
      switch (e.eventType) {
        case "RECRUITER_REVIEWED": setEarliest(appReviewAt, e.applicationId, ts); break;
        case "SUBMITTED_TO_HIRING_MANAGER": setEarliest(appSubmitAt, e.applicationId, ts); break;
        case "HIRING_MANAGER_INTERVIEW_COMPLETED":
        case "HIRING_MANAGER_INTERVIEW_SCHEDULED": setEarliest(appHmAt, e.applicationId, ts); break;
        case "INTERVIEW_COMPLETED": setEarliest(appInterviewAt, e.applicationId, ts); break;
        case "OFFER_EXTENDED":
        case "OFFER_RECOMMENDED": setEarliest(appOfferAt, e.applicationId, ts); break;
        case "HIRED": setEarliest(appHiredAt, e.applicationId, ts); break;
      }
    }

    const outcomeByApp = new Map<string, { hireDate: Date | null; offerAmount: number | null; offerAccepted: boolean | null }>();
    for (const o of outcomes) {
      if (o.applicationId) outcomeByApp.set(o.applicationId, { hireDate: o.hireDate ?? null, offerAmount: o.offerAmount ?? null, offerAccepted: o.offerAccepted ?? null });
    }

    /* ── Accumulators per recruiter. ── */
    interface Acc {
      candidates: Set<string>;
      submitted: number; interviews: number; hmInterviews: number; offers: number; hires: number;
      placementsValue: number;
      timeToSubmit: number[]; firstReview: number[]; reviewToSubmit: number[];
      over24h: number; over3d: number; inPipeline: number; awaitingReview: number;
      jobsTouched: Set<string>;
      recent: number; prior: number; // activity windows for trend
    }
    const acc = new Map<string, Acc>();
    const blank = (): Acc => ({
      candidates: new Set(), submitted: 0, interviews: 0, hmInterviews: 0, offers: 0, hires: 0,
      placementsValue: 0, timeToSubmit: [], firstReview: [], reviewToSubmit: [],
      over24h: 0, over3d: 0, inPipeline: 0, awaitingReview: 0, jobsTouched: new Set(), recent: 0, prior: 0,
    });
    for (const id of recruiterIds) acc.set(id, blank());

    const now = Date.now();
    for (const a of apps) {
      const rid = jobToRecruiter.get(a.jobId);
      if (!rid) continue;
      const A = acc.get(rid);
      if (!A) continue;
      A.candidates.add(a.candidateId);

      const created = appCreatedAt.get(a.id);
      const reviewAt = appReviewAt.get(a.id) ?? null;
      const submitAt = appSubmitAt.get(a.id) ?? null;
      const stage = a.stage as string;
      const oc = outcomeByApp.get(a.id);

      // Reached-stage logic: event evidence OR current stage.
      const reachedSubmit = submitAt != null || stage === "hm_review" || OFFER_STAGES.has(stage) || HIRED_STAGES.has(stage);
      const reachedHm = appHmAt.get(a.id) != null || OFFER_STAGES.has(stage) || HIRED_STAGES.has(stage);
      const reachedInterview = appInterviewAt.get(a.id) != null || stage === "interview_completed" || stage === "hm_review" || OFFER_STAGES.has(stage) || HIRED_STAGES.has(stage);
      const reachedOffer = appOfferAt.get(a.id) != null || OFFER_STAGES.has(stage) || HIRED_STAGES.has(stage);
      const reachedHire = appHiredAt.get(a.id) != null || HIRED_STAGES.has(stage) || (oc?.hireDate != null);

      if (reachedSubmit) A.submitted++;
      if (reachedInterview) A.interviews++;
      if (reachedHm) A.hmInterviews++;
      if (reachedOffer) A.offers++;
      if (reachedHire) {
        A.hires++;
        if (oc?.offerAmount != null && (oc.offerAccepted !== false)) A.placementsValue += oc.offerAmount;
      }

      // Pipeline / workload.
      if (!TERMINAL_NEGATIVE.has(stage) && !HIRED_STAGES.has(stage)) A.inPipeline++;
      const unreviewed = reviewAt == null && AWAITING_REVIEW_STAGES.has(stage);
      if (unreviewed) {
        A.awaitingReview++;
        if (created != null) {
          const ageMs = now - created;
          if (ageMs > DAY_MS) A.over24h++;
          if (ageMs > 3 * DAY_MS) A.over3d++;
        }
      }

      // SLA timings (days).
      if (created != null && submitAt != null) A.timeToSubmit.push((submitAt - created) / DAY_MS);
      if (created != null && reviewAt != null) A.firstReview.push((reviewAt - created) / DAY_MS);
      if (reviewAt != null && submitAt != null && submitAt >= reviewAt) A.reviewToSubmit.push((submitAt - reviewAt) / DAY_MS);
    }

    /* Trend: activity (submit/interview/hire events) last 30d vs prior 30d. */
    const win = 30 * DAY_MS;
    for (const e of events) {
      const rid = jobToRecruiter.get(e.jobId);
      if (!rid || !e.eventTimestamp) continue;
      if (e.eventType !== "SUBMITTED_TO_HIRING_MANAGER" && e.eventType !== "INTERVIEW_COMPLETED" && e.eventType !== "HIRED") continue;
      const A = acc.get(rid);
      if (!A) continue;
      const age = now - new Date(e.eventTimestamp).getTime();
      if (age <= win) A.recent++;
      else if (age <= 2 * win) A.prior++;
    }

    /* Stale reqs: open requisitions with no relevant event in the last 14 days. */
    const jobLastEvent = new Map<string, number>();
    for (const e of events) {
      if (!e.eventTimestamp) continue;
      const ts = new Date(e.eventTimestamp).getTime();
      const prev = jobLastEvent.get(e.jobId);
      if (prev == null || ts > prev) jobLastEvent.set(e.jobId, ts);
    }
    const staleByRecruiter = new Map<string, number>();
    for (const j of jobs) {
      if (j.status !== "active" || !j.recruiterId) continue;
      const last = jobLastEvent.get(j.id);
      if (last == null || now - last > 14 * DAY_MS) {
        staleByRecruiter.set(j.recruiterId, (staleByRecruiter.get(j.recruiterId) ?? 0) + 1);
      }
    }

    /* Cohort-relative volume normalisation. */
    let maxSubmitted = 0;
    for (const id of recruiterIds) maxSubmitted = Math.max(maxSubmitted, acc.get(id)!.submitted);

    /* Build per-recruiter rows. */
    const rows: PerRecruiter[] = recruiterUsers.map(u => {
      const A = acc.get(u.id)!;
      const candidatesManaged = A.candidates.size;
      const avgTimeToSubmitDays = avg(A.timeToSubmit);
      const firstReviewDays = avg(A.firstReview);
      const reviewToSubmitDays = avg(A.reviewToSubmit);
      const submitToHm = ratioPct(A.hmInterviews, A.submitted);
      const hmToOffer = ratioPct(A.offers, A.hmInterviews);
      const offerToHire = ratioPct(A.hires, A.offers);
      const overallHire = ratioPct(A.hires, candidatesManaged);

      const productivityScore = candidatesManaged === 0 && A.submitted === 0
        ? null
        : blend({
            timeToSubmit: speedScore(avgTimeToSubmitDays, 2, 12),
            hireRate: rateScore(overallHire, 15),
            volume: maxSubmitted > 0 ? Math.round((A.submitted / maxSubmitted) * 100) : null,
            firstReview: speedScore(firstReviewDays, 1, 7),
            hmConversion: pctScore(submitToHm),
            offerConversion: pctScore(offerToHire),
          });

      const trendPct = A.prior > 0 ? Math.round(((A.recent - A.prior) / A.prior) * 100) : null;

      return {
        recruiterId: u.id, name: u.name, email: u.email, role: u.role,
        candidatesManaged,
        submitted: A.submitted, interviews: A.interviews, hmInterviews: A.hmInterviews,
        offers: A.offers, hires: A.hires, placementsValue: Math.round(A.placementsValue),
        avgTimeToSubmitDays: avgTimeToSubmitDays == null ? null : Math.round(avgTimeToSubmitDays * 10) / 10,
        sla: {
          firstReviewDays: firstReviewDays == null ? null : Math.round(firstReviewDays * 10) / 10,
          reviewToSubmitDays: reviewToSubmitDays == null ? null : Math.round(reviewToSubmitDays * 10) / 10,
        },
        aging: { over24h: A.over24h, over3d: A.over3d, staleReqs: staleByRecruiter.get(u.id) ?? 0 },
        workload: { openReqs: openReqsByRecruiter.get(u.id) ?? 0, inPipeline: A.inPipeline, awaitingReview: A.awaitingReview },
        conversion: { submitToHm, hmToOffer, offerToHire, overallHire },
        productivityScore,
        trendPct,
        rank: 0,
      };
    });

    /* Rank by productivity score (nulls last) over the FULL cohort. */
    rows.sort((a, b) => (b.productivityScore ?? -1) - (a.productivityScore ?? -1));
    rows.forEach((r, i) => { r.rank = i + 1; });

    /* Team aggregates over the full cohort. */
    const team = {
      recruitersActive: rows.filter(r => r.candidatesManaged > 0 || r.workload.openReqs > 0).length,
      totalCandidates: rows.reduce((s, r) => s + r.candidatesManaged, 0),
      totalSubmitted: rows.reduce((s, r) => s + r.submitted, 0),
      totalInterviews: rows.reduce((s, r) => s + r.interviews, 0),
      totalOffers: rows.reduce((s, r) => s + r.offers, 0),
      totalHires: rows.reduce((s, r) => s + r.hires, 0),
      placementsValue: rows.reduce((s, r) => s + r.placementsValue, 0),
      avgTimeToSubmitDays: avg(rows.map(r => r.avgTimeToSubmitDays)),
      avgProductivityScore: avg(rows.map(r => r.productivityScore)),
      avgSubmitToHm: avg(rows.map(r => r.conversion.submitToHm)),
      avgHmToOffer: avg(rows.map(r => r.conversion.hmToOffer)),
      avgOfferToHire: avg(rows.map(r => r.conversion.offerToHire)),
    };

    /* A plain recruiter only sees their own row (still ranked vs the cohort). */
    const visibleRows = selfOnly ? rows.filter(r => r.recruiterId === user.id) : rows;

    return res.json({
      scope: scopeLabel,
      selfRecruiterId: user.id,
      cohortSize: rows.length,
      generatedAt: new Date().toISOString(),
      team,
      recruiters: visibleRows,
    });
  } catch (err) {
    logger.error({ err }, "[recruiter-performance] failed");
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
