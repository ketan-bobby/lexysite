/**
 * routes/sourcing.ts — External Candidate Sourcing, Platform Recommendations & LinkedIn Monitor
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for on-demand candidate sourcing from external sources and for
 * managing the platform-level AI recommendation system that matches platform-
 * pool candidates to tenant job openings.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   POST /sourcing/search               Run a multi-source candidate search and
 *                                       return ranked results (does not persist)
 *   POST /sourcing/save                 Save selected sourced candidates to
 *                                       sourced_candidates for a specific job
 *   GET  /sourcing/recommendations      Fetch current platform recommendations
 *   POST /sourcing/scan                 Manually trigger the platform recommendation
 *                                       scan (platform_admin only)
 *   GET  /sourcing/scan-status          Status and last result of the scan
 *   POST /sourcing/linkedin-scan        Manually trigger the LinkedIn profile monitor
 *   GET  /sourcing/linkedin-scan-status Last result of the LinkedIn monitor
 *
 * ─── Five search sources ─────────────────────────────────────────────────────
 *   internal     — Candidates already in the tenant's candidates table, scored
 *                  by skill overlap with the ICP
 *   github       — GitHub Users API (only for engineering roles; skipped otherwise)
 *   pdl          — People Data Labs Elasticsearch (requires PDL_API_KEY)
 *   serp         — SerpAPI Google search of LinkedIn profiles (requires SERP_API_KEY;
 *                  falls back to AI-generated profiles in dev)
 *   enrichlayer  — SerpAPI URL discovery + EnrichLayer profile enrichment for
 *                  REAL skill/experience signal (requires ENRICH_LAYER_API_KEY +
 *                  SERP_API_KEY). Highest-fidelity adapter for non-engineering roles.
 *
 * Results from all sources are merged, deduped by email, re-scored via
 * scoreExternalCandidates() (GPT-4o batch with full ICP + domain enforcement),
 * and sorted by matchScore desc.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import {
  sourcedCandidatesTable,
  icpTable,
  jobsTable,
  candidatesTable,
  usersTable,
  applicationsTable,
  jobPipelinesTable,
} from "@workspace/db";
import { eq, desc, and, or, isNull, ne, inArray, sql } from "drizzle-orm";
import {
  scoreExternalCandidates,
  classifyLocationMatches,
  type SearchContext,
  type AdapterResult,
} from "../lib/external-sourcing.js";
import { runSourcingProviders, getProviderStatus } from "../lib/sourcing-providers.js";
import { validate } from "../middlewares/validate";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import { assertJobApproved } from "../lib/job-approval-gate";
import { generateJSON } from "../lib/ai";
import { getAuthUserId } from "../lib/auth-token";
import {
  getAllowedTenantIds,
  getDataScopeTenantIds,
  recruiterIsAssignedToJob,
  TALENT_REDISCOVERY,
  SOURCED_POOL_VISIBILITY,
  readScopeExemption,
} from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { findExistingCandidate } from "../lib/candidate-dedup.js";
import { DEFAULT_PIPELINE_AGENTS } from "../lib/pipeline-defaults.js";
import { logger } from "../lib/logger";
import { originFields } from "../lib/sourcing-origin";

const SourcingSearchBody = z
  .object({
    jobId: z.string().min(1),
    sources: z.array(z.string()).optional(),
    maxPerSource: z.number().optional(),
  })
  .passthrough();

const SourcingInternalBody = z
  .object({
    jobId: z.string().min(1),
    maxPerSource: z.number().int().min(1).max(50).optional(),
  })
  .passthrough();

const SourcingIngestBody = z
  .object({
    source: z.string().min(1),
    profileUrl: z.string().optional(),
    rawData: z.record(z.unknown()).optional(),
  })
  .passthrough();

const SourcingMergeBody = z
  .object({
    primaryCandidateId: z.string().min(1),
    duplicateCandidateIds: z.array(z.string().min(1)),
  })
  .passthrough();

const NlSourcingBody = z.object({
  query: z.string().min(3).max(2000),
  /* Optional: when present, results are scored against this job's ICP and
   * the response remembers the jobId so the UI can pre-fill the "attach to
   * work order" picker. Without it we fall back to a pure NL-derived
   * search context. */
  jobId: z.string().optional(),
  sources: z.array(z.string()).optional(),
  maxPerSource: z.number().int().min(1).max(50).optional(),
});

const router: IRouter = Router();

/* ── Build a SearchContext from the job + (optional) ICP ──────────────── */
/* Exported: the work-order agent run (lib/agent-runs/run-real.ts) builds its
 * context through the SAME function so run-sourced scores can never drift from
 * the /sourcing/search semantics (ICP location first-class, workType from job). */
export function buildSearchContext(job: any, icp: any | null, maxPerSource: number): SearchContext {
  return {
    jobTitle: icp?.jobTitle || job?.title || "",
    alternateTitles: icp?.alternateTitles || [],
    requiredSkills: icp?.requiredSkills || [],
    preferredSkills: icp?.preferredSkills || [],
    requiredCertifications: icp?.requiredCertifications || [],
    toolsAndSystems: icp?.toolsAndSystems || [],
    compliance: icp?.compliance || [],
    negativeKeywords: icp?.negativeKeywords || [],
    domain: icp?.domain ?? null,
    roleFamily: icp?.roleFamily ?? null,
    seniority: icp?.seniority ?? null,
    // Language requirements are not an ICP column (yet) — populated by the
    // NL-search path from the recruiter's brief; ICP-driven searches pass [].
    languages: (icp as any)?.languages ?? [],
    // Location is now a first-class ICP field. When an ICP row exists we honor
    // its location verbatim — a recruiter who CLEARS it (null/empty) means "no
    // location preference", so we must NOT silently fall back to job.location.
    // Only when there is no ICP row at all do we seed from the job's location.
    location: icp ? icp.location || "" : job?.location || "",
    // Work arrangement is a JOB attribute (not on the ICP) — a remote role must
    // never be pinned to a city during sourcing regardless of a stray ICP location.
    workType: (job?.workType as SearchContext["workType"]) ?? null,
    booleanSearchString: icp?.booleanSearchString ?? null,
    maxResults: maxPerSource,
  };
}

/* ── Internal-first gate ─────────────────────────────────────────────────
 * The product thesis is "discover your own talent first": a client must review
 * their OWN internal bench (tenant pool) for a requisition BEFORE Lexy spends on
 * external sourcing. We persist a small durable marker on the job's pipeline row
 * (job_pipelines.agent_config.__internalReview) the moment /sourcing/internal is
 * run, and the external endpoints refuse to spend (409) until it exists. A body
 * flag alone would be bypassable, so enforcement lives server-side.
 *
 * We reuse job_pipelines (already tenant-scoped + RLS-covered) rather than a new
 * table/migration. When no pipeline row exists yet we create one seeded with the
 * canonical DEFAULT_PIPELINE_AGENTS so the pipeline canvas's first-load seeding
 * is not suppressed. */
const INTERNAL_REVIEW_KEY = "__internalReview";

interface InternalReviewMarker {
  reviewedAt: string;
  reviewedByUserId: string | null;
  matchCount: number;
}

/* Exported: routes/agent-runs.ts enforces the same internal-first gate before
 * starting a REAL sourcing run (a new external-spend entrypoint). */
export async function getInternalReview(jobId: string): Promise<InternalReviewMarker | null> {
  const [row] = await db
    .select({ agentConfig: jobPipelinesTable.agentConfig })
    .from(jobPipelinesTable)
    .where(eq(jobPipelinesTable.jobId, jobId))
    .limit(1);
  const marker = (row?.agentConfig as any)?.[INTERNAL_REVIEW_KEY];
  return marker && typeof marker === "object" ? (marker as InternalReviewMarker) : null;
}

async function recordInternalReview(
  jobId: string,
  tenantId: string,
  meta: { reviewedByUserId: string | null; matchCount: number },
): Promise<void> {
  const marker: InternalReviewMarker = {
    reviewedAt: new Date().toISOString(),
    reviewedByUserId: meta.reviewedByUserId,
    matchCount: meta.matchCount,
  };
  const [existing] = await db
    .select({ agentConfig: jobPipelinesTable.agentConfig })
    .from(jobPipelinesTable)
    .where(eq(jobPipelinesTable.jobId, jobId))
    .limit(1);
  if (!existing) {
    await db.insert(jobPipelinesTable).values({
      jobId,
      // Use the job's real tenant (mirrors pipeline.ts). Never fabricate a
      // fallback tenant — a mis-tenanted pipeline row would leak the marker.
      tenantId,
      agents: DEFAULT_PIPELINE_AGENTS,
      agentConfig: { [INTERNAL_REVIEW_KEY]: marker },
      autoRun: false,
      status: "idle",
    } as any);
  } else {
    const nextConfig = { ...((existing.agentConfig as any) ?? {}), [INTERNAL_REVIEW_KEY]: marker };
    await db
      .update(jobPipelinesTable)
      .set({ agentConfig: nextConfig, updatedAt: new Date() } as any)
      .where(eq(jobPipelinesTable.jobId, jobId));
  }
}

/* ── Internal DB search ──────────────────────────────────────────────── */
/* Exported for lib/agent-runs/run-real.ts (work-order agent runs). This stays
 * THE internal-first discovery chokepoint (see
 * scripts/check-internal-search-tenant-scope.mjs) — do not fork a second copy.
 * `dbc` lets the fire-and-forget agent run pass dbAdmin explicitly. */
export async function searchInternalDatabase(
  ctx: SearchContext,
  tenantScope: string | string[] | null,
  dbc: typeof db = db,
): Promise<AdapterResult> {
  // Subtree scope: an array searches the full descendant tenant tree; null =
  // platform_admin (no tenant restriction). `and()` drops undefined conditions.
  const tenantCond =
    tenantScope === null
      ? undefined
      : Array.isArray(tenantScope)
        ? inArray(candidatesTable.tenantId, tenantScope)
        : eq(candidatesTable.tenantId, tenantScope);
  const all = await dbc
    .select()
    .from(candidatesTable)
    .where(
      and(
        tenantCond,
        /* PURE FIREWALL (thesis A): internal search must read ONLY tenant-owned
         * records (current employees + previously-saved/applied candidates), and
         * NEVER a personal platform-pool job-seeker profile. Tenant-owned rows are
         * pool='tenant'; personal profiles are pool='platform' (or the transitional
         * 'pending_profile'). Filtering on tenantId ALONE is not enough: it would
         * rely on platform rows always carrying a sentinel tenantId ("platform" /
         * the super-admin tenant) that never collides with a customer tenant — an
         * incidental guarantee, not an enforced one. The explicit pool='tenant'
         * predicate makes the firewall real: a platform profile can never surface
         * here regardless of any tenant-id coincidence. There is no join to the
         * platform pool anywhere in this query, and the saved-candidate path stores
         * a distinct employer-owned copy (candidate-import: tenantId=employer,
         * pool='tenant') rather than referencing the personal profile, so "saved
         * candidates" is not a bridge back into personal/job-seeking scope. */
        eq(candidatesTable.pool, "tenant"),
        or(
          isNull((candidatesTable as any).doNotContact),
          ne((candidatesTable as any).doNotContact, true),
        ),
        /* GDPR: erased candidate rows must never surface in any sourcing
         * result, even if they still match on title/skill. Same rule as the
         * candidates list endpoint. */
        isNull((candidatesTable as any).dataErasedAt),
      ),
    );

  // Languages count as match signal for internal candidates too — bench rows
  // often list "Spanish"/"English" in their skills array.
  const icpSkills = [...ctx.requiredSkills, ...ctx.languages].map((s) => s.toLowerCase());
  const titles = [ctx.jobTitle, ...ctx.alternateTitles].map((t) => t.toLowerCase()).filter(Boolean);

  const scored = all.map((c) => {
    const cSkills = (c.skills || []).map((s) => s.toLowerCase());
    const overlap = icpSkills.filter((s) => cSkills.some((cs) => cs.includes(s) || s.includes(cs)));
    const skillScore = icpSkills.length > 0 ? overlap.length / icpSkills.length : 0.5;

    // Title match also matters — prevents skill-stuffed candidates from a wrong domain
    const cTitle = (c.currentTitle || "").toLowerCase();
    const titleHit = titles.some((t) => t && cTitle.includes(t));
    const titleScore = titleHit ? 1 : 0.4;

    const finalScore = Math.round((skillScore * 0.6 + titleScore * 0.4) * 100);

    return {
      id: `internal_${c.id}`,
      candidateId: c.id,
      source: "internal" as const,
      isCurrentEmployee: !!(c as any).isCurrentEmployee,
      firstName: c.firstName,
      lastName: c.lastName,
      currentTitle: c.currentTitle ?? "",
      currentCompany: c.currentCompany ?? "",
      location: c.location ?? "",
      skills: c.skills ?? [],
      linkedinUrl: c.linkedinUrl ?? "",
      githubProfile: c.githubUrl ?? "",
      email: c.email,
      matchScore: finalScore,
    };
  });

  /* Current employees are ALWAYS surfaced — internal mobility is a primary
     channel for tenants that have given us HRIS/ATS access, and they should
     never be silently truncated by the maxResults cap. We carve them out
     first (bounded by EMPLOYEE_CAP so a 10k-employee tenant doesn't explode
     the downstream LLM scoring batch), then fill the remainder with the
     highest-scoring non-employees. */
  const EMPLOYEE_CAP = Math.max(25, Math.ceil(ctx.maxResults * 1.5));
  const employees = scored
    .filter((c) => c.isCurrentEmployee)
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
    .slice(0, EMPLOYEE_CAP);
  const nonEmployees = scored
    .filter((c) => !c.isCurrentEmployee)
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  const remainingSlots = Math.max(0, ctx.maxResults - employees.length);
  const top = [...employees, ...nonEmployees.slice(0, remainingSlots)];

  return {
    candidates: top as any,
    query: `Internal: title~[${titles.slice(0, 3).join(", ")}] skills~[${ctx.requiredSkills.slice(0, 5).join(", ")}] (employees=${employees.length})`,
  };
}

/* ── POST /sourcing/internal — internal-first discovery (tenant pool only) ──
 * Step 1 of the enforced internal-first flow. Searches ONLY the caller's own
 * tenant pool (current employees + previously-saved candidates) against the
 * job's ICP — never external providers, never the platform pool, so the
 * work↔personal firewall stays intact. Running it records the internal-review
 * marker that unlocks external sourcing spend for this requisition. */
router.post("/sourcing/internal", validate({ body: SourcingInternalBody }), async (req, res) => {
  const { jobId, maxPerSource = 15 } = req.body;
  if (!jobId) {
    res.status(400).json({ error: "jobId required" });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  const [icp] = await db
    .select()
    .from(icpTable)
    .where(eq(icpTable.jobId, jobId))
    .orderBy(desc(icpTable.version))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  // Same authz as /sourcing/search: the caller must belong to the job's tenant
  // (or an ancestor); a plain recruiter must be assigned to the requisition
  // (this route WRITES the review marker onto the job's pipeline row).
  const callerId = getAuthUserId(req);
  if (!callerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await db
    .select({ id: usersTable.id, tenantId: usersTable.tenantId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, callerId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const callerAllowed = await getDataScopeTenantIds(caller);
  if (callerAllowed !== null && (!job.tenantId || !callerAllowed.includes(job.tenantId))) {
    res.status(403).json({ error: "Forbidden — job is outside your tenant scope." });
    return;
  }
  if (caller.role === "recruiter" && !(await recruiterIsAssignedToJob(callerId, job))) {
    res.status(403).json({ error: "Forbidden — you are not assigned to this requisition." });
    return;
  }
  if (!assertJobApproved(res, job.status)) return;

  const tenantId = job.tenantId || "";
  const ctx = buildSearchContext(job, icp || null, maxPerSource);

  // Internal ONLY — tenant pool. searchInternalDatabase is scoped to the job's
  // tenant and never reads the platform pool, so personal/job-seeking profiles
  // are never linked to the employer.
  const internalRes = await searchInternalDatabase(ctx, tenantId);
  const internalScored =
    icp && internalRes.candidates.length > 0
      ? await scoreExternalCandidates(internalRes.candidates as any[], icp as any)
      : internalRes.candidates;
  const internalFinal = internalScored.map((s: any) => {
    const orig = internalRes.candidates.find((c: any) => c.id === s.id);
    return { ...s, candidateId: (orig as any)?.candidateId ?? (s as any).candidateId };
  });

  // Geo flag — same treatment as the combined search so the UI is consistent.
  const locResults = await classifyLocationMatches(
    internalFinal.map((c: any, i: number) => ({ id: String(i), location: c.location })),
    ctx.location,
  );
  const flagged = internalFinal.map((c: any, i: number) => {
    const r = locResults.get(String(i)) || { match: "unknown" as const, flag: null };
    return { ...c, locationMatch: r.match, locationFlag: r.flag };
  });

  // Record the review marker — THIS is what unlocks external sourcing spend.
  await recordInternalReview(jobId, tenantId, {
    reviewedByUserId: callerId,
    matchCount: flagged.length,
  });

  res.json({
    total: flagged.length,
    bySource: { internal: flagged.length },
    queries: { internal: { query: internalRes.query, skipped: (internalRes as any).skipped } },
    icpMissing: !icp,
    internalReviewedAt: new Date().toISOString(),
    candidates: flagged.sort((a: any, b: any) => {
      const empDiff =
        ((b as any).isCurrentEmployee ? 1 : 0) - ((a as any).isCurrentEmployee ? 1 : 0);
      if (empDiff !== 0) return empDiff;
      return ((b as any).matchScore ?? 0) - ((a as any).matchScore ?? 0);
    }),
  });
});

/* ── POST /sourcing/search — trigger external sourcing for a job ───── */
router.post("/sourcing/search", validate({ body: SourcingSearchBody }), async (req, res) => {
  const {
    jobId,
    sources = ["internal", "github", "pdl", "serp", "enrichlayer"],
    maxPerSource = 15,
  } = req.body;
  if (!jobId) {
    res.status(400).json({ error: "jobId required" });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  const [icp] = await db
    .select()
    .from(icpTable)
    .where(eq(icpTable.jobId, jobId))
    .orderBy(desc(icpTable.version))
    .limit(1);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  /* Tenant-membership gate. This route reads the tenant's private pool/DNC list
   * AND now writes sourced-stage application rows for `jobId`, so a bare jobId can
   * no longer be trusted: the caller must belong to the job's tenant (or an
   * ancestor). allowed === null = platform_admin (no filter). */
  const callerId = getAuthUserId(req);
  if (!callerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await db
    .select({ id: usersTable.id, tenantId: usersTable.tenantId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, callerId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const callerAllowed = await getDataScopeTenantIds(caller);
  if (callerAllowed !== null && (!job.tenantId || !callerAllowed.includes(job.tenantId))) {
    res.status(403).json({ error: "Forbidden — job is outside your tenant scope." });
    return;
  }
  /* WRITE gate: /sourcing/search attaches sourced-stage application rows to
   * `jobId`. Read-only recommendation scans (/sourcing/nl-search) stay
   * agency-wide — see TALENT_REDISCOVERY — but writing sourced candidates onto a
   * requisition requires assignment for a plain recruiter. Admin-class roles
   * already cleared the tenant-scope gate above. */
  if (caller.role === "recruiter" && !(await recruiterIsAssignedToJob(callerId, job))) {
    res.status(403).json({ error: "Forbidden — you are not assigned to this requisition." });
    return;
  }

  // Sourcing for a requisition is blocked until it has cleared approval.
  if (!assertJobApproved(res, job.status)) return;

  /* ADVISORY internal-first (2026-08-12, per product owner): reviewing the
   * requisition's own internal talent before spending on external providers is
   * a recommendation surfaced in the UI, not a server-side blocker. The
   * internal pool is always searched as part of this fan-out anyway. */

  const tenantId = job.tenantId || "";
  const ctx = buildSearchContext(job, icp || null, maxPerSource);

  /* `internal` is ALWAYS run — current employees and previously-saved tenant
     candidates must surface in every search regardless of which external
     sources the recruiter has toggled on. Recruiters never want to source for
     a role and miss someone already inside the company. The external providers
     (GitHub, PDL, SerpAPI, EnrichLayer) all run through the adapter layer
     (Task #28): two-phase discovery→enrichment, config-driven selection, and
     graceful degradation — see lib/sourcing-providers.ts.
     The caller's tenant membership for `jobId` is verified above before any
     search runs or any sourced application row is written. */
  const [internalRes, providerResults] = await Promise.all([
    searchInternalDatabase(ctx, tenantId),
    runSourcingProviders(ctx, { requested: sources }),
  ]);
  const ghRes = providerResults.github;
  const pdlRes = providerResults.pdl;
  const serpRes = providerResults.serp;
  const elRes = providerResults.enrichlayer;

  const externalAll = [
    ...ghRes.candidates,
    ...pdlRes.candidates,
    ...serpRes.candidates,
    ...elRes.candidates,
  ];
  const externalScored = icp ? await scoreExternalCandidates(externalAll, icp as any) : externalAll;

  const internalScored =
    icp && internalRes.candidates.length > 0
      ? await scoreExternalCandidates(internalRes.candidates as any[], icp as any)
      : internalRes.candidates;

  const internalFinal = internalScored.map((s: any) => {
    const orig = internalRes.candidates.find((c: any) => c.id === s.id);
    return { ...s, candidateId: (orig as any)?.candidateId ?? (s as any).candidateId };
  });

  // DNC filter for external candidates
  const dncRows = await db
    .select({ email: candidatesTable.email })
    .from(candidatesTable)
    .where(
      and(eq(candidatesTable.tenantId, tenantId), eq((candidatesTable as any).doNotContact, true)),
    );
  const dncEmails = new Set(
    dncRows.map((r) => (r.email ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const isDnc = (c: any) => {
    const e = (c?.email ?? "").trim().toLowerCase();
    return e !== "" && dncEmails.has(e);
  };
  const externalNonDnc = externalScored.filter((c) => !isDnc(c));

  /* Geo flag: keep every candidate but mark those clearly outside the ICP's
     target location. A candidate is a match if they are in the target region OR
     within ~100 miles of it; a candidate with no known location is left
     unflagged. Classified in ONE batched call (uses the model for proximity, no
     geocoding service). Keyed by array index so internal/external ids can never
     collide. Attached post-score / pre-persist so the flag is stored in rawData
     and returned to the client. */
  const combined = [...internalFinal, ...externalNonDnc];
  const locResults = await classifyLocationMatches(
    combined.map((c: any, i) => ({ id: String(i), location: c.location })),
    ctx.location,
  );
  const flaggedAll = combined.map((c: any, i) => {
    const r = locResults.get(String(i)) || { match: "unknown" as const, flag: null };
    return { ...c, locationMatch: r.match, locationFlag: r.flag };
  });
  const internalFlagged = flaggedAll.slice(0, internalFinal.length);
  const externalFlagged = flaggedAll.slice(internalFinal.length);

  const all = [...internalFlagged, ...externalFlagged];

  // Persist external candidates: upsert by LinkedIn URL into candidatesTable
  // first so we always reference a real candidate UUID — this prevents two
  // jobs sourcing the same LinkedIn profile from colliding on
  // sourced_candidates.normalizedCandidateId.
  let saved = 0;
  // Resolve the job's tenant ONCE so any sourced-stage application row we create
  // is visible on the correct work order (applications RLS is keyed on
  // tenant_id, which must match the job's tenant — not the caller's).
  let jobTenantId: string | null = null;
  try {
    const [jr] = await db
      .select({ tenantId: jobsTable.tenantId })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1);
    jobTenantId = jr?.tenantId ?? null;
  } catch {
    jobTenantId = null;
  }
  for (const c of externalFlagged as any[]) {
    try {
      let normalizedId: string = c.id;
      const tid = tenantId || "acme";
      const realEmail =
        typeof c.email === "string" &&
        c.email.trim() &&
        !c.email.trim().toLowerCase().endsWith("@unknown.local") &&
        !c.email.trim().toLowerCase().endsWith("@import.local")
          ? c.email.trim().toLowerCase()
          : "";

      // Reuse the existing candidate when we've seen this person before. Uses the
      // shared resolver so sourcing and import agree on identity (LinkedIn →
      // email → phone → name+location) — this prevents a second sourcing run, OR
      // a person already imported by phone/name, from creating a duplicate row
      // (and never trips the (tenant, lower(email)) unique index). Falls back to
      // inserting a fresh candidate.
      const existingCand: any = await findExistingCandidate({
        tenantId: tid,
        email: realEmail || c.email,
        phone: c.phone,
        linkedinUrl: c.linkedinUrl,
        firstName: c.firstName,
        lastName: c.lastName,
        location: c.location,
      });
      if (existingCand) {
        normalizedId = existingCand.id;
      } else {
        const [inserted] = await db
          .insert(candidatesTable)
          .values({
            tenantId: tid,
            firstName: c.firstName || "Unknown",
            lastName: c.lastName || "",
            // email is NOT NULL — mint a placeholder when the source had none.
            email:
              realEmail ||
              `sourced-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@unknown.local`,
            location: c.location || null,
            currentTitle: c.currentTitle || null,
            currentCompany: c.currentCompany || null,
            linkedinUrl: c.linkedinUrl || null,
            githubUrl: c.githubProfile || null,
            skills: c.skills || [],
            source: c.source || "serp",
          })
          .returning({ id: candidatesTable.id })
          .catch(() => [null as any]);
        if (inserted?.id) normalizedId = inserted.id;
      }

      const existing = await db
        .select()
        .from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.normalizedCandidateId, normalizedId))
        .limit(1);
      if (existing.length === 0) {
        await db.insert(sourcedCandidatesTable).values({
          tenantId: tenantId || "acme",
          source: c.source,
          rawData: { ...c, jobId, matchScore: c.matchScore, matchReason: c.matchReason },
          normalizedCandidateId: normalizedId,
          mergeConfidence: c.matchScore ? c.matchScore / 100 : null,
        });
        saved++;
      }

      // Create the sourced-stage application row AT SOURCING TIME so the funnel's
      // "Sourced" reflects everyone the agent surfaced FOR THIS JOB. Deduped on
      // (candidate, job) — deliberately NOT nested under the global
      // sourced_candidates dedupe above: a candidate previously sourced for a
      // DIFFERENT job (so their sourced_candidates row already exists) must still
      // get a job-scoped application row here, or per-requisition sourced counts
      // undercount. entry_type='sourced', written at the `sourced` stage: fires
      // NO automation (screening starts at 'screening', outreach at 'shortlisted'),
      // so no AI credits are consumed. Best-effort — never blocks sourcing.
      if (jobTenantId && normalizedId) {
        try {
          const existingApp = await db
            .select({ id: applicationsTable.id })
            .from(applicationsTable)
            .where(
              and(
                eq(applicationsTable.candidateId, normalizedId),
                eq(applicationsTable.jobId, jobId),
              ),
            )
            .limit(1);
          if (existingApp.length === 0) {
            await db.insert(applicationsTable).values({
              tenantId: jobTenantId,
              jobId,
              candidateId: normalizedId,
              stage: "sourced",
              ...originFields(
                "ai_sourcing",
                { source: c.source, jobId, via: "sourcing_scan", matchScore: c.matchScore ?? null },
                "sourcing_agent",
              ),
            });
          }
        } catch {
          /* best-effort: never block sourcing on app-row creation */
        }
      }
    } catch {
      /* skip duplicates */
    }
  }

  res.json({
    total: all.length,
    saved,
    bySource: {
      internal: internalRes.candidates.length,
      github: ghRes.candidates.length,
      pdl: pdlRes.candidates.length,
      serp: serpRes.candidates.length,
      enrichlayer: elRes.candidates.length,
    },
    queries: {
      internal: { query: internalRes.query, skipped: internalRes.skipped },
      github: { query: ghRes.query, skipped: ghRes.skipped },
      pdl: { query: pdlRes.query, skipped: pdlRes.skipped },
      serp: { query: serpRes.query, skipped: serpRes.skipped },
      enrichlayer: { query: elRes.query, skipped: elRes.skipped },
    },
    icpUsed: icp
      ? {
          domain: (icp as any).domain,
          subSpecialty: (icp as any).subSpecialty,
          roleFamily: (icp as any).roleFamily,
          booleanSearchString: (icp as any).booleanSearchString,
          alternateTitles: (icp as any).alternateTitles,
          requiredCertifications: (icp as any).requiredCertifications,
          toolsAndSystems: (icp as any).toolsAndSystems,
          negativeKeywords: (icp as any).negativeKeywords,
        }
      : null,
    icpMissing: !icp,
    pdlAvailable: !!process.env.PDL_API_KEY,
    serpAvailable: !!(process.env.SERP_API_KEY || process.env.SERPAPI_KEY),
    enrichLayerAvailable: !!process.env.ENRICH_LAYER_API_KEY,
    githubAvailable: true,
    internalAvailable: true,
    /* Primary sort = isCurrentEmployee desc (so internal employees never get
       pushed below an external candidate that happens to outscore them),
       secondary = matchScore desc. Mirrors the partition in
       searchInternalDatabase so the always-include guarantee survives the
       final merge with external sources. */
    candidates: all.sort((a, b) => {
      const empDiff =
        ((b as any).isCurrentEmployee ? 1 : 0) - ((a as any).isCurrentEmployee ? 1 : 0);
      if (empDiff !== 0) return empDiff;
      return ((b as any).matchScore ?? 0) - ((a as any).matchScore ?? 0);
    }),
  });
});

/* ── GET /sourcing/status — connector availability ───────────────────── */
router.get("/sourcing/status", async (_req, res) => {
  // External providers come from the adapter registry (Task #28) so availability
  // — including config-driven disabling — stays in lockstep with what actually
  // runs. `internal` (a DB search, not a provider) and `linkedin` (placeholder)
  // are not part of the registry and stay defined here.
  const ps = getProviderStatus();
  const connector = (p: (typeof ps)[keyof typeof ps]) => ({
    available: p.available,
    apiKey: p.apiKey,
    note: p.note,
  });
  res.json({
    connectors: {
      internal: {
        available: true,
        apiKey: false,
        note: "Always on — your talent pool + current employees",
        alwaysOn: true,
      },
      github: connector(ps.github),
      pdl: connector(ps.pdl),
      serp: connector(ps.serp),
      enrichlayer: connector(ps.enrichlayer),
      linkedin: { available: false, apiKey: false, note: "Coming soon" },
    },
  });
});

/* ── GET /sourcing/candidates ──────────────────────────────────────── */
router.get("/sourcing/candidates", async (req, res) => {
  /* Resolve the caller's tenant — sourced candidates and the DNC list are both
   * tenant-private. One tenant marking someone Do Not Contact must NOT affect
   * another tenant, and one tenant must never see another's sourced pool. */
  const userId = getAuthUserId(req);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [user] = await db
    .select({ id: usersTable.id, tenantId: usersTable.tenantId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!user.tenantId && user.role !== "platform_admin") {
    res.status(403).json({ error: "No tenant context" });
    return;
  }
  // Data scope: platform_admin = no filter (null); recruiter_admin = assigned
  // client tenants only (intersected with the agency subtree); everyone else =
  // full subtree via getAllowedTenantIds. The read-scope exemption below widens
  // a plain RECRUITER past their req-assignment ceiling — it must never widen a
  // recruiter_admin past their assigned clients.
  const allowed = await getDataScopeTenantIds(user);

  /* Read-scope exemption (ratified). The sourced pool is the tenant's SHARED
   * talent pool: a plain recruiter browsing it to find matches for their reqs is
   * the feature working, so this READ is intentionally tenant/subtree-wide and is
   * NOT narrowed to assigned requisitions. The corresponding WRITES — merge
   * (below) and source-onto-req (/sourcing/search) — DO require assignment. Same
   * asymmetry as talent rediscovery; documented so the deviation is greppable. */
  readScopeExemption(SOURCED_POOL_VISIBILITY);

  // Defensive cap: see lib/query-limits.ts.
  const sourced = await db
    .select()
    .from(sourcedCandidatesTable)
    .where(allowed === null ? undefined : inArray(sourcedCandidatesTable.tenantId, allowed))
    .orderBy(desc(sourcedCandidatesTable.createdAt))
    .limit(MAX_PAGE_SIZE);

  /* DNC filter — a candidate sourced BEFORE being marked Do Not Contact would
   * otherwise linger in this saved list and risk being re-contacted. Mirror the
   * search-path filter: drop any sourced row whose linked candidate id is on the
   * DNC list, or whose raw email matches a DNC email. Scoped to THIS tenant. */
  const dncRows = await db
    .select({
      id: candidatesTable.id,
      email: candidatesTable.email,
    })
    .from(candidatesTable)
    .where(
      and(
        allowed === null ? undefined : inArray(candidatesTable.tenantId, allowed),
        eq((candidatesTable as any).doNotContact, true),
      ),
    );
  const dncIds = new Set(dncRows.map((r) => r.id).filter(Boolean));
  const dncEmails = new Set(
    dncRows.map((r) => (r.email ?? "").trim().toLowerCase()).filter(Boolean),
  );

  const visible = sourced.filter((s) => {
    // Check BOTH id forms — a merged row can carry normalizedCandidateId AND
    // mergedWithCandidateId, and either may point at the DNC candidate.
    const normId = (s as any).normalizedCandidateId;
    const mergedId = (s as any).mergedWithCandidateId;
    if (normId && dncIds.has(normId)) return false;
    if (mergedId && dncIds.has(mergedId)) return false;
    const email = ((s.rawData as any)?.email ?? "").trim().toLowerCase();
    if (email && dncEmails.has(email)) return false;
    return true;
  });

  res.json(visible.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })));
});

/* ── POST /sourcing/ingest ────────────────────────────────────────── */
router.post("/sourcing/ingest", validate({ body: SourcingIngestBody }), async (req, res) => {
  const { source, profileUrl, rawData } = req.body;

  /* Auth + tenant resolution. This is a WRITE into a tenant-private pool, so the
   * destination tenant MUST come from the authenticated caller — never a literal.
   * (Previously hardcoded tenantId:"acme", which corrupted every other tenant's
   * pool and let any anonymous caller write.) */
  const callerId = getAuthUserId(req);
  if (!callerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await db
    .select({ tenantId: usersTable.tenantId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, callerId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!caller.tenantId) {
    res.status(403).json({ error: "No tenant context" });
    return;
  }

  const [sourced] = await db
    .insert(sourcedCandidatesTable)
    .values({
      tenantId: caller.tenantId,
      source,
      rawData: { ...rawData, profileUrl },
      mergeConfidence: null,
    })
    .returning();
  res.json({ ...sourced, createdAt: sourced.createdAt.toISOString() });
});

/* ── POST /sourcing/nl-search ──────────────────────────────────────────────
   Conversational sourcing. Recruiter types "Find me Java developers in NYC
   with 8 years of experience" and we:
     1. Use OpenAI to parse the prose into a structured SearchContext
        (title, alt-titles, skills, location, seniority/minYears, keywords).
     2. ALWAYS search the tenant's internal candidates table (same partition
        rules as /sourcing/search — current employees never get truncated).
     3. Optionally fan out to external sources gated on env keys.
     4. If `jobId` is supplied, also re-score against that job's ICP so the
        recruiter can compare the NL hits against their formal target.

   Returns the same envelope as /sourcing/search so the existing results UI
   in pages/recruiter/sourcing.tsx can render the response without changes.
   `interpretation` is included so the UI can echo back to the recruiter
   "Showing Java developers in New York with 8+ years experience…" — this
   is the trust signal that makes conversational search usable. */
router.post("/sourcing/nl-search", validate({ body: NlSourcingBody }), async (req, res) => {
  try {
    /* Resolve tenantId from the caller. Unlike /sourcing/search we don't
     * have a jobId to lean on, so we must authenticate. Pre-existing
     * project-wide auth pattern: token → userId → users row. */
    const userId = getAuthUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const [user] = await db
      .select({ id: usersTable.id, tenantId: usersTable.tenantId, role: usersTable.role })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!user.tenantId && user.role !== "platform_admin") {
      res.status(403).json({ error: "No tenant context" });
      return;
    }
    // Data scope: recruiter_admin is narrowed to assigned client tenants;
    // platform_admin = null (no filter); other roles keep subtree scope. The
    // read-scope exemption below applies to plain recruiters (req-assignment
    // ceiling), NOT to recruiter_admin client scoping.
    const allowed = await getDataScopeTenantIds(user);
    // Read-scope exemption: nl-search is a read-only recommendation scan (it
    // returns ranked candidates and never writes application rows), so it stays
    // agency-wide by design. The attach step that writes to a req is gated.
    readScopeExemption(TALENT_REDISCOVERY);

    const {
      query,
      jobId,
      sources = ["internal", "github", "pdl", "serp", "enrichlayer"],
      maxPerSource = 15,
    } = req.body as {
      query: string;
      jobId?: string;
      sources?: string[];
      maxPerSource?: number;
    };

    /* Step 1: NL → structured criteria via GPT. We keep the schema small
     * and aligned with SearchContext so the rest of the pipeline is a
     * drop-in. minYearsExperience is captured but not enforced inside
     * searchInternalDatabase yet — surfaced in the response and used as a
     * soft signal during scoreExternalCandidates. */
    type Parsed = {
      jobTitle: string;
      alternateTitles: string[];
      requiredSkills: string[];
      preferredSkills: string[];
      /* Structured language requirements ("bilingual Spanish/English" →
       * ["Spanish","English"]). Carried into SearchContext and enforced as a
       * hard requirement during LLM scoring. */
      languages: string[];
      location: string;
      seniority: string | null;
      minYearsExperience: number | null;
      /* Strategic-brief fields: parsed and echoed to the UI so the recruiter
       * sees they were understood, but NOT yet enforced as search filters
       * (volume planning and salary-cap enforcement are follow-up work). */
      headcountTarget: number | null;
      salaryCap: { amount: number; currency: string; period: "hour" | "month" | "year" } | null;
      keywords: string[];
      interpretation: string;
    };
    const parsed = await generateJSON<Parsed>(
      `You are a recruiting assistant. Parse the recruiter's free-text sourcing query into a structured search context.

Query: "${query}"

Return JSON with these fields:
- jobTitle: string — the primary role title (e.g. "Java Developer"). Empty string if not specified.
- alternateTitles: string[] — equivalent titles a recruiter would also accept (e.g. for "Java Developer" → ["Java Engineer", "Backend Engineer (Java)", "Software Engineer - Java"]). Generate 2-5.
- requiredSkills: string[] — must-have technical skills explicitly mentioned (e.g. ["Java", "Spring"]). Do not invent; extract only what's implied.
- preferredSkills: string[] — nice-to-have skills that are commonly paired with the role.
- languages: string[] — spoken/written human languages required for the role (e.g. "bilingual" customer service in Colombia → ["Spanish", "English"]; "German-speaking support" → ["German"]). Expand "bilingual"/"multilingual" using the location's dominant language plus English when that is the obvious intent. Empty array if no language requirement. Do NOT put programming languages here.
- location: string — city, region, or country mentioned. Empty string if remote/anywhere.
- seniority: "junior" | "mid" | "senior" | "staff" | "principal" | null — derive from years mentioned: <3 junior, 3-5 mid, 5-8 senior, 8-12 staff, 12+ principal. null if not stated.
- minYearsExperience: number | null — if a years floor is mentioned ("8 years", "8+", "at least 5"), put the integer. null otherwise.
- headcountTarget: number | null — if the recruiter states how many people they need to HIRE ("80 reps", "need 5 engineers"), put the integer. null if not stated.
- salaryCap: { amount: number, currency: string (ISO code like "USD"), period: "hour" | "month" | "year" } | null — if a pay ceiling is mentioned ("under 2000", "max $50k/year"). Infer the period from magnitude and role context when unstated (e.g. 2000 for a full-time rep = per month). Default currency USD unless another is implied. null if no budget mentioned.
- keywords: string[] — other relevant search terms (industries, tools, certifications) not captured above.
- interpretation: string — one sentence starting with "Searching for…" that mirrors back what you understood, including any language, headcount, and budget constraints. This is shown to the recruiter so they can verify.

Only include items actually implied by the query. Empty arrays are fine.`,
      "You parse recruiter sourcing queries into structured JSON. Respond with valid JSON only — no markdown fences, no commentary.",
    ).catch(
      (): Parsed => ({
        /* Parser failure must not kill the search — fall back to using the raw
         * query text as the title clause so providers still search for the
         * recruiter's actual ask instead of running an unconstrained scan. */
        jobTitle: query.slice(0, 120),
        alternateTitles: [],
        requiredSkills: [],
        preferredSkills: [],
        languages: [],
        location: "",
        seniority: null,
        minYearsExperience: null,
        headcountTarget: null,
        salaryCap: null,
        keywords: [],
        interpretation: `Searching for: ${query.slice(0, 160)}`,
      }),
    );
    /* The model may omit fields — normalize so downstream code never sees
     * undefined (validate() only guards the request body, not AI output). */
    parsed.alternateTitles = Array.isArray(parsed.alternateTitles) ? parsed.alternateTitles : [];
    parsed.requiredSkills = Array.isArray(parsed.requiredSkills) ? parsed.requiredSkills : [];
    parsed.preferredSkills = Array.isArray(parsed.preferredSkills) ? parsed.preferredSkills : [];
    parsed.languages = Array.isArray(parsed.languages) ? parsed.languages : [];
    parsed.keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
    parsed.headcountTarget =
      typeof parsed.headcountTarget === "number" && parsed.headcountTarget > 0
        ? Math.round(parsed.headcountTarget)
        : null;
    parsed.salaryCap =
      parsed.salaryCap && typeof parsed.salaryCap.amount === "number" && parsed.salaryCap.amount > 0
        ? {
            amount: parsed.salaryCap.amount,
            currency:
              typeof parsed.salaryCap.currency === "string" &&
              /^[A-Za-z]{3}$/.test(parsed.salaryCap.currency)
                ? parsed.salaryCap.currency.toUpperCase()
                : "USD",
            period: (["hour", "month", "year"] as const).includes(parsed.salaryCap.period as any)
              ? parsed.salaryCap.period
              : "month",
          }
        : null;

    /* Step 2: if a jobId is supplied, layer the job's ICP on top so we
     * inherit certifications, tools, domain, and the negative-keyword
     * exclusion list. Recruiter intent wins for the fields they spoke.
     *
     * Tenant-scope the lookup: a caller must only be able to enrich their
     * NL search with ICP context from a job that belongs to their own
     * tenant (platform_admin excepted). Without this gate the response
     * would leak cross-tenant ICP fields — domain, boolean string,
     * negative keywords — via `icpUsed`. Foreign jobId is treated as 404
     * (silent) rather than 403 so callers cannot enumerate valid jobs by
     * status code. */
    let job: any = null;
    let icp: any = null;
    if (jobId) {
      const [j] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
      // Subtree scope: a parent admin may enrich with a descendant tenant's job ICP.
      if (!j || (allowed && !allowed.includes(j.tenantId ?? ""))) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      job = j;
      const [ic] = await db
        .select()
        .from(icpTable)
        .where(eq(icpTable.jobId, jobId))
        .orderBy(desc(icpTable.version))
        .limit(1);
      icp = ic ?? null;

      /* ADVISORY internal-first (2026-08-12, per product owner): no longer a
       * blocking gate — internal results are included in the fan-out below and
       * the UI nudges recruiters to review them first. */
    }

    const ctx: SearchContext = {
      jobTitle: parsed.jobTitle || icp?.jobTitle || job?.title || "",
      alternateTitles:
        parsed.alternateTitles.length > 0 ? parsed.alternateTitles : (icp?.alternateTitles ?? []),
      requiredSkills:
        parsed.requiredSkills.length > 0 ? parsed.requiredSkills : (icp?.requiredSkills ?? []),
      preferredSkills:
        parsed.preferredSkills.length > 0 ? parsed.preferredSkills : (icp?.preferredSkills ?? []),
      requiredCertifications: icp?.requiredCertifications ?? [],
      toolsAndSystems: icp?.toolsAndSystems ?? [],
      compliance: icp?.compliance ?? [],
      negativeKeywords: icp?.negativeKeywords ?? [],
      domain: icp?.domain ?? null,
      roleFamily: icp?.roleFamily ?? null,
      seniority: parsed.seniority ?? icp?.seniority ?? null,
      languages: Array.isArray(parsed.languages) ? parsed.languages.filter(Boolean) : [],
      location: parsed.location || job?.location || "",
      workType: (job?.workType as SearchContext["workType"]) ?? null,
      booleanSearchString: icp?.booleanSearchString ?? null,
      maxResults: maxPerSource,
    };

    /* Step 3: same fan-out as /sourcing/search. Internal is always on; the
     * external providers run through the adapter layer (Task #28). */
    const [internalRes, providerResults] = await Promise.all([
      searchInternalDatabase(ctx, allowed),
      runSourcingProviders(ctx, { requested: sources }),
    ]);
    const ghRes = providerResults.github;
    const pdlRes = providerResults.pdl;
    const serpRes = providerResults.serp;
    const elRes = providerResults.enrichlayer;

    const externalAll = [
      ...ghRes.candidates,
      ...pdlRes.candidates,
      ...serpRes.candidates,
      ...elRes.candidates,
    ];
    /* Re-score using the ICP if we have one, otherwise leave the per-adapter
     * scores in place — scoreExternalCandidates needs a real ICP row to
     * work, so synthesising one from `parsed` would just degrade quality. */
    /* Recruiter-stated language requirements are layered onto the ICP for
     * scoring — the scorer treats them as a hard requirement. Without an ICP
     * we normally leave adapter scores in place (synthesising a full ICP from
     * prose degrades quality), but when the recruiter stated LANGUAGES we must
     * still enforce them — so we build a minimal criteria object from the
     * parsed brief for that one purpose. */
    const scoringIcp = icp
      ? { ...(icp as any), languages: ctx.languages }
      : ctx.languages.length
        ? {
            jobTitle: ctx.jobTitle,
            requiredSkills: ctx.requiredSkills,
            seniority: ctx.seniority,
            location: ctx.location || null,
            languages: ctx.languages,
          }
        : null;
    const externalScored = scoringIcp
      ? await scoreExternalCandidates(externalAll, scoringIcp)
      : externalAll;
    const internalFinal =
      scoringIcp && internalRes.candidates.length > 0
        ? (await scoreExternalCandidates(internalRes.candidates as any[], scoringIcp)).map(
            (s: any) => {
              const orig = internalRes.candidates.find((c: any) => c.id === s.id);
              return { ...s, candidateId: (orig as any)?.candidateId ?? (s as any).candidateId };
            },
          )
        : internalRes.candidates;

    /* DNC filter — must mirror /sourcing/search exactly. */
    const dncRows = await db
      .select({ email: candidatesTable.email })
      .from(candidatesTable)
      .where(
        and(
          allowed === null ? undefined : inArray(candidatesTable.tenantId, allowed),
          eq((candidatesTable as any).doNotContact, true),
        ),
      );
    const dncEmails = new Set(
      dncRows.map((r) => (r.email ?? "").trim().toLowerCase()).filter(Boolean),
    );
    const externalNonDnc = externalScored.filter((c: any) => {
      const e = (c?.email ?? "").trim().toLowerCase();
      return e === "" || !dncEmails.has(e);
    });

    const all = [...internalFinal, ...externalNonDnc];

    res.json({
      mode: "nl",
      query,
      interpretation: parsed.interpretation,
      parsed, // raw structured criteria for the UI to display
      jobId: jobId ?? null, // echoed back so the UI can pre-fill the attach picker
      total: all.length,
      saved: 0, // NL search doesn't persist — call /sourcing/save explicitly if needed
      bySource: {
        internal: internalRes.candidates.length,
        github: ghRes.candidates.length,
        pdl: pdlRes.candidates.length,
        serp: serpRes.candidates.length,
        enrichlayer: elRes.candidates.length,
      },
      queries: {
        internal: { query: internalRes.query, skipped: internalRes.skipped },
        github: { query: ghRes.query, skipped: ghRes.skipped },
        pdl: { query: pdlRes.query, skipped: pdlRes.skipped },
        serp: { query: serpRes.query, skipped: serpRes.skipped },
        enrichlayer: { query: elRes.query, skipped: elRes.skipped },
      },
      icpUsed: icp
        ? {
            domain: (icp as any).domain,
            roleFamily: (icp as any).roleFamily,
            booleanSearchString: (icp as any).booleanSearchString,
          }
        : null,
      icpMissing: !icp,
      candidates: all.sort((a: any, b: any) => {
        const empDiff = (b.isCurrentEmployee ? 1 : 0) - (a.isCurrentEmployee ? 1 : 0);
        if (empDiff !== 0) return empDiff;
        return (b.matchScore ?? 0) - (a.matchScore ?? 0);
      }),
    });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[sourcing/nl-search] failed");
    res.status(500).json({ error: "NL sourcing failed", detail: err?.message });
  }
});

/* ── POST /sourcing/merge ────────────────────────────────────────── */
router.post("/sourcing/merge", validate({ body: SourcingMergeBody }), async (req, res) => {
  const { primaryCandidateId, duplicateCandidateIds } = req.body;

  /* Interim role gate — recruiter-class only (recruiter-OWNERSHIP arrives with
   * the Tier 2 middleware). */
  const callerId = getAuthUserId(req);
  if (!callerId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [caller] = await db
    .select({ id: usersTable.id, tenantId: usersTable.tenantId, role: usersTable.role })
    .from(usersTable)
    .where(eq(usersTable.id, callerId))
    .limit(1);
  if (!caller) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!["platform_admin", "tenant_admin", "recruiter_admin", "recruiter"].includes(caller.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  /* Data-integrity gate — the merge pointer is written verbatim from the
   * caller-supplied primaryCandidateId, so an arbitrary/foreign id would point
   * duplicates at a candidate that doesn't exist or lives in another tenant.
   * Require the primary candidate to exist AND be inside the caller's subtree
   * (allowed === null = platform_admin, no filter). */
  const [primary] = await db
    .select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, primaryCandidateId))
    .limit(1);
  if (!primary) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const callerAllowed = await getDataScopeTenantIds(caller);
  if (callerAllowed !== null && (!primary.tenantId || !callerAllowed.includes(primary.tenantId))) {
    // 404 (not 403): an out-of-scope primary is indistinguishable from a
    // non-existent one, so a caller can't probe candidate existence across
    // tenants. Same existence-hiding convention as the ownership ceiling below.
    res.status(404).json({ error: "Not found" });
    return;
  }

  /* Recruiter OWNERSHIP ceiling (ratified). Merging REWRITES candidate identity —
   * a write with blast radius — so a plain recruiter may only merge candidates
   * that sit on a requisition ASSIGNED to them. This applies to the primary AND
   * every duplicate (all of them are being re-pointed). recruiterOwnsResource
   * returns TRUE for every non-recruiter role (admins already cleared the tenant
   * gate above). A non-owned OR non-existent id ⇒ 404 (existence hidden), the
   * same convention the ownership middleware uses. Reads stay tenant-wide
   * (SOURCED_POOL_VISIBILITY); this WRITE does not. */
  if (caller.role === "recruiter") {
    for (const cid of [primaryCandidateId, ...duplicateCandidateIds]) {
      if (!(await recruiterOwnsResource(caller, { kind: "candidateId", value: cid }))) {
        res.status(404).json({ error: "Not found" });
        return;
      }
    }
  }

  await Promise.all(
    duplicateCandidateIds.map((dupId: string) =>
      db
        .update(sourcedCandidatesTable)
        .set({ mergedWithCandidateId: primaryCandidateId })
        .where(eq(sourcedCandidatesTable.normalizedCandidateId, dupId)),
    ),
  );
  res.json({
    success: true,
    message: `Merged ${duplicateCandidateIds.length} profiles into primary candidate`,
  });
});

export default router;
