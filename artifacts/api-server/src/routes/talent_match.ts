/**
 * routes/talent_match.ts — Talent Match Scores & Resume Screening
 *
 * Tenant-scoped: every read/write requires an authenticated caller and
 * resolves tenantId from the candidate or job under operation. Cross-tenant
 * access returns 404 (never 403) to avoid ID enumeration.
 *
 * ─── Routes ──────────────────────────────────────────────────────────────────
 *   GET  /talent-matches/by-candidate/:candidateId  Roles a candidate matches
 *   POST /talent-match                              Compute/fetch a candidate↔job fit
 *   POST /talent-match/rediscover                   Score a job against the pool
 *   POST /resume-screens                            Blind AI resume screen
 *   GET  /resume-screens/:candidateId               Latest screen for a candidate
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import { classBRead, CLASS_B_READ_EXEMPTION } from "../lib/class-b-read";
import {
  talentMatchesTable,
  resumeScreensTable,
  candidatesTable,
  applicationsTable,
  candidateJobIntelligenceTable,
  icpTable,
  jobsTable,
  usersTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { rankWithStaleness } from "../lib/staleness.js";
import { generateWithAI } from "../lib/ai";
import { FAIRNESS_DIRECTIVE, redactPii } from "../lib/fairness";
import { mergeSkillsIntoCandidate } from "../lib/enrich-candidate";
import { getAuthUserId } from "../lib/auth-token";
import { validate } from "../middlewares/validate";
import { getDataScopeTenantIds, recruiterIsAssignedToJob, TALENT_REDISCOVERY, readScopeExemption } from "../lib/tenantUtils";

const TalentMatchBody = z.object({
  candidateId: z.string().min(1),
  jobId: z.string().min(1),
}).passthrough();

const TalentMatchRediscoverBody = z.object({
  jobId: z.string().min(1),
  limit: z.number().optional(),
}).passthrough();

const ResumeScreenBody = z.object({
  candidateId: z.string().min(1),
  jobId: z.string().min(1),
  resumeText: z.string().optional(),
}).passthrough();

const router: IRouter = Router();

async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

/* Returns true and continues; on failure sends 401/404 and returns false. */
async function gateCandidate(req: any, res: any, candidateId: string): Promise<{ user: any; candidate: any } | null> {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!c) { res.status(404).json({ error: "Not found" }); return null; }
  if (user.role !== "platform_admin") {
    // DATA-scope ceiling: recruiter_admin sees ONLY assigned client sub-tenants.
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(c.tenantId ?? "")) {
      res.status(404).json({ error: "Not found" }); return null;
    }
  }
  return { user, candidate: c };
}
async function gateJob(req: any, res: any, jobId: string): Promise<{ user: any; job: any } | null> {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [j] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!j) { res.status(404).json({ error: "Not found" }); return null; }
  if (user.role !== "platform_admin") {
    // DATA-scope ceiling: recruiter_admin sees ONLY assigned client sub-tenants.
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(j.tenantId ?? "")) {
      res.status(404).json({ error: "Not found" }); return null;
    }
  }
  return { user, job: j };
}

/* WRITE gate for artifacts that attach to a requisition (talent_match, resume
 * screen). Reads stay agency-wide by design — see TALENT_REDISCOVERY — but a
 * plain recruiter may only WRITE a match/screen against a requisition they are
 * assigned to. Admin-class roles (platform_admin, tenant_admin, recruiter_admin)
 * already cleared the data-scope gate above and may write. Returns true when
 * allowed; otherwise writes a 403 and returns false. */
async function requireRequisitionWriteAccess(res: any, user: any, job: any): Promise<boolean> {
  if (user.role === "recruiter" && !(await recruiterIsAssignedToJob(user.id, job))) {
    res.status(403).json({ error: "Forbidden — you are not assigned to this requisition." });
    return false;
  }
  return true;
}

/* ── Deterministic cold-start fit score ──────────────────────────────────────
 * Used when a candidate has no stored `talentMatchScore` yet. Replaces a prior
 * `Math.random()` fallback so scores are reproducible and defensible. Blends
 * four real profile signals: ICP skill overlap (dominant), title alignment,
 * verification verdict, and sourcing-channel quality. This is an explicitly
 * PRELIMINARY estimate — a full AI resume screen still produces the calibrated
 * score persisted to `talentMatchScore`. */
const SOURCE_QUALITY: Record<string, number> = {
  referral: 8, linkedin: 6, github: 6, internal: 7,
  application: 5, sourced: 5, platform: 4, import: 3,
};
function heuristicFitScore(candidate: any, icp: any): number {
  const candSkills: string[] = (candidate?.skills || []).map((s: string) => s.toLowerCase().trim());
  let score = 0;
  let hasSignal = false;

  // Skill alignment vs ICP (up to 60 pts) — the dominant signal.
  const req: string[] = (icp?.requiredSkills || []).map((s: string) => s.toLowerCase().trim());
  const pref: string[] = (icp?.preferredSkills || []).map((s: string) => s.toLowerCase().trim());
  if (req.length || pref.length) {
    hasSignal = true;
    const reqHit = req.length ? req.filter((s) => candSkills.includes(s)).length / req.length : 0;
    const prefHit = pref.length ? pref.filter((s) => candSkills.includes(s)).length / pref.length : 0;
    score += reqHit * 45 + prefHit * 15;
  } else if (candSkills.length) {
    // No ICP to compare against: credit a populated skill profile only.
    hasSignal = true;
    score += (Math.min(candSkills.length, 8) / 8) * 35;
  }

  // Title alignment vs ICP job title / alternate titles (up to 15 pts).
  const candTitle: string = (candidate?.currentTitle || "").toLowerCase();
  if (candTitle && icp?.jobTitle) {
    const titles: string[] = [icp.jobTitle, ...((icp.alternateTitles as string[]) || [])].map((t: string) => t.toLowerCase());
    const matched = titles.some((t: string) =>
      t.split(/\s+/).filter((w: string) => w.length > 3).some((w: string) => candTitle.includes(w)),
    );
    if (matched) { score += 15; hasSignal = true; }
  }

  // Verification verdict (up to 12 pts).
  const verdict: string | undefined = (candidate?.verificationResult || {})?.verdict;
  if (verdict) {
    hasSignal = true;
    if (verdict === "clear") score += 12;
    else if (verdict === "review") score += 6;
  }

  // Sourcing-channel quality (up to 8 pts).
  const src: string = (candidate?.source || "").toLowerCase();
  if (src) { hasSignal = true; score += SOURCE_QUALITY[src] ?? 3; }

  // No usable signals at all → deterministic neutral baseline (never random).
  if (!hasSignal) return 50;
  return Math.max(1, Math.min(100, Math.round(score)));
}

// ── GET /talent-matches/by-candidate/:candidateId ─────────────────────────────
// All roles a candidate is matched to, merging stored talent_matches rows with
// synthetic rows for jobs the candidate is merely linked to via an application.
router.get("/talent-matches/by-candidate/:candidateId", async (req, res) => {
  const gate = await gateCandidate(req, res, req.params.candidateId);
  if (!gate) return;
  // Read-scope exemption: a candidate's cross-req matches are surfaced
  // agency-wide (not narrowed to the recruiter's assigned reqs) by design.
  readScopeExemption(TALENT_REDISCOVERY);
  const candidateId = req.params.candidateId;
  const rows = await db
    .select({
      id: talentMatchesTable.id,
      jobId: talentMatchesTable.jobId,
      fitScore: talentMatchesTable.fitScore as unknown as number | null,
      recommendation: talentMatchesTable.recommendation as unknown as string | null,
      jobTitle: jobsTable.title,
      jobStatus: jobsTable.status,
    })
    .from(talentMatchesTable)
    .leftJoin(jobsTable, eq(jobsTable.id, talentMatchesTable.jobId))
    .where(eq(talentMatchesTable.candidateId, candidateId))
    .orderBy(desc(talentMatchesTable.fitScore));

  /* Also surface roles the candidate is actively linked to via an application
   * (e.g. manually added/sourced for a specific job). Without this, a candidate
   * added directly for a role shows "No roles matched yet" until someone runs an
   * explicit Talent Match. talent_matches rows take precedence; the per-job
   * application matchScore is used as the fit score for the rest. */
  const appRows = await db
    .select({
      jobId: applicationsTable.jobId,
      matchScore: applicationsTable.matchScore,
      jobTitle: jobsTable.title,
      jobStatus: jobsTable.status,
      jobTenantId: jobsTable.tenantId,
    })
    .from(applicationsTable)
    .leftJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
    .where(eq(applicationsTable.candidateId, candidateId));

  /* Tenant-gate the synthetic rows: a candidate may be linked (cross-tenant)
   * to a job outside the caller's visibility. Only surface jobs whose tenant is
   * within the caller's allowed subtree (platform_admin bypasses). */
  const allowedTenants =
    gate.user.role === "platform_admin" ? null : await getDataScopeTenantIds(gate.user);

  const seen = new Set(rows.map((m) => m.jobId));
  for (const a of appRows) {
    if (!a.jobId || seen.has(a.jobId)) continue;
    if (allowedTenants && !allowedTenants.includes(a.jobTenantId ?? "")) continue;
    seen.add(a.jobId);
    rows.push({
      id: `app-${a.jobId}`,
      jobId: a.jobId,
      fitScore: a.matchScore ?? null,
      recommendation: null,
      jobTitle: a.jobTitle,
      jobStatus: a.jobStatus,
    });
  }

  /* Finally, surface roles the candidate has been SCORED against by the
   * intelligence engine (candidate_job_intelligence) even when no talent_match
   * or application row exists — e.g. a recruiter ran "match to req"/screening
   * without formally adding the candidate to the pipeline. Per the score
   * source-of-truth rule, accrued intelligence should appear on every candidate
   * surface, not vanish as "No roles matched yet". Tenant-gate by the JOB's
   * tenant; talent_match and application rows still take precedence per job. */
  /* Class-B read: the DB span carries no tenant predicate, but every returned
     row is filtered by `allowedTenants.includes(jobTenantId)` in the loop below
     before it leaves the handler (post-query tenant filter). */
  classBRead(CLASS_B_READ_EXEMPTION.POST_QUERY_TENANT_FILTER);
  const intelRows = await db
    .select({
      jobId: candidateJobIntelligenceTable.jobId,
      fitScore: candidateJobIntelligenceTable.fitScore as unknown as number | null,
      recommendation: candidateJobIntelligenceTable.nextBestAction as unknown as string | null,
      jobTitle: jobsTable.title,
      jobStatus: jobsTable.status,
      jobTenantId: jobsTable.tenantId,
    })
    .from(candidateJobIntelligenceTable)
    .leftJoin(jobsTable, eq(jobsTable.id, candidateJobIntelligenceTable.jobId))
    .where(eq(candidateJobIntelligenceTable.candidateId, candidateId));

  for (const it of intelRows) {
    if (!it.jobId || seen.has(it.jobId)) continue;
    if (allowedTenants && !allowedTenants.includes(it.jobTenantId ?? "")) continue;
    seen.add(it.jobId);
    rows.push({
      id: `intel-${it.jobId}`,
      jobId: it.jobId,
      fitScore: it.fitScore ?? null,
      recommendation: it.recommendation,
      jobTitle: it.jobTitle,
      jobStatus: it.jobStatus,
    });
  }

  rows.sort((x, y) => (y.fitScore ?? -1) - (x.fitScore ?? -1));
  res.json({ matches: rows });
});

// ── POST /talent-match ────────────────────────────────────────────────────────
// Compute (or return the existing) fit score for one candidate↔job pair. Both
// records must share the same tenant — no cross-tenant binding.
router.post("/talent-match", validate({ body: TalentMatchBody }), async (req, res) => {
  const { candidateId, jobId } = req.body;
  if (!candidateId || !jobId) { res.status(400).json({ error: "candidateId and jobId required" }); return; }
  /* Both candidate AND job must belong to the caller's tenant tree, AND the
     two must share the same tenant (no cross-tenant binding). */
  const cGate = await gateCandidate(req, res, candidateId);
  if (!cGate) return;
  const jGate = await gateJob(req, res, jobId);
  if (!jGate) return;
  if ((cGate.candidate.tenantId ?? "") !== (jGate.job.tenantId ?? "")) {
    res.status(404).json({ error: "Not found" }); return;
  }
  // WRITE: persisting a talent_match row attaches the candidate to this req.
  if (!(await requireRequisitionWriteAccess(res, jGate.user, jGate.job))) return;
  const tenantId = jGate.job.tenantId as string;
  const candidate = cGate.candidate;

  const existing = await db.select().from(talentMatchesTable)
    .where(eq(talentMatchesTable.candidateId, candidateId)).limit(1);
  if (existing.length) {
    res.json({ ...existing[0], candidate: { ...candidate, applicationCount: 0, skills: candidate.skills || [], createdAt: candidate.createdAt.toISOString(), updatedAt: candidate.updatedAt.toISOString() }, createdAt: existing[0].createdAt.toISOString() });
    return;
  }

  const [icp] = await db.select().from(icpTable).where(eq(icpTable.jobId, jobId)).limit(1);

  const hasStoredScore = candidate?.talentMatchScore != null;
  const fitScore: number = hasStoredScore
    ? (candidate.talentMatchScore as number)
    : heuristicFitScore(candidate, icp);
  const basis = hasStoredScore
    ? ""
    : " (preliminary estimate from profile signals — run a full AI screen for a calibrated score)";
  const [match] = await db.insert(talentMatchesTable).values({
    tenantId,
    candidateId, jobId,
    fitScore,
    matchExplanation: `${candidate?.firstName || "Candidate"} shows ${fitScore > 80 ? "strong" : fitScore > 65 ? "moderate" : "limited"} alignment with the role requirements${basis}.`,
    strengths: candidate?.skills?.slice(0, 3) || ["Relevant experience"],
    gaps: icp?.requiredSkills?.filter((s: string) => !candidate?.skills?.includes(s)).slice(0, 2) || ["Additional skills needed"],
    recommendation: fitScore > 85 ? "strong_yes" : fitScore > 75 ? "yes" : fitScore > 60 ? "maybe" : "no",
  }).returning();

  res.json({ ...match, candidate: { ...candidate, applicationCount: 0, skills: candidate.skills || [], createdAt: candidate.createdAt.toISOString(), updatedAt: candidate.updatedAt.toISOString() }, createdAt: match.createdAt.toISOString() });
});

// ── POST /talent-match/rediscover ─────────────────────────────────────────────
// Score a batch of candidates from the job's tenant against a single job and
// return them ranked by fit. Used to surface internal-pool matches for a role.
router.post("/talent-match/rediscover", validate({ body: TalentMatchRediscoverBody }), async (req, res) => {
  const { jobId, limit = 10 } = req.body;
  if (!jobId) { res.status(400).json({ error: "jobId required" }); return; }
  const gate = await gateJob(req, res, jobId);
  if (!gate) return;
  // Read-scope exemption: rediscover is a read-only pool scan for a req; it
  // ranks candidates but writes nothing, so it stays agency-wide by design.
  readScopeExemption(TALENT_REDISCOVERY);
  /* Restrict the candidate pool to the job's tenant — previously this
     function rediscovered across all tenants. */
  const candidates = await db.select().from(candidatesTable)
    .where(eq(candidatesTable.tenantId, gate.job.tenantId as string))
    .limit(Number(limit));
  const [icp] = await db.select().from(icpTable).where(eq(icpTable.jobId, jobId)).limit(1);
  const matches = candidates.map(c => {
    const hasStoredScore = c.talentMatchScore != null;
    const fitScore: number = hasStoredScore
      ? (c.talentMatchScore as number)
      : heuristicFitScore(c, icp);
    const basis = hasStoredScore
      ? ""
      : " (preliminary estimate — run a full AI screen to calibrate)";
    return {
      candidateId: c.id,
      jobId,
      fitScore,
      /* preliminary = the score is a deterministic profile heuristic, not a
         calibrated AI screen. Lets the UI flag it as low-confidence evidence
         instead of presenting a heuristic estimate as a firm match score. */
      preliminary: !hasStoredScore,
      matchExplanation: `${c.firstName} ${c.lastName} matches ~${fitScore}% of the role requirements${basis}.`,
      strengths: c.skills?.slice(0, 2) || [],
      gaps: icp?.requiredSkills?.filter((s: string) => !(c.skills || []).includes(s)).slice(0, 2) || ["May need upskilling in some areas"],
      recommendation: fitScore > 80 ? "yes" : fitScore > 60 ? "maybe" : "no",
      candidate: { ...c, applicationCount: 0, skills: c.skills || [], createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() },
      createdAt: new Date().toISOString(),
    };
  });

  /* Staleness-adjusted RANKING (lib/staleness.ts): inactive candidates rank
     below equally-matched active ones — a read-time demotion, never a filter.
     Displayed fitScore stays the base match quality; the order (and the
     transparency fields rankScore/stalenessMultiplier/daysInactive) reflect
     recency. lastActive for tenant-pool rows = candidate.updatedAt. */
  const ranked = rankWithStaleness(matches, (m) => m.fitScore, (m) => m.candidate.updatedAt);
  res.json(ranked.map(r => ({
    ...r.item,
    rankScore: r.rankScore,
    stalenessMultiplier: r.stalenessMultiplier,
    daysInactive: r.daysInactive,
  })));
});

// ── POST /resume-screens ──────────────────────────────────────────────────────
// Run a blind (PII-redacted) AI resume screen for a candidate↔job pair, persist
// the result, and merge any newly-surfaced skills back onto the candidate.
router.post("/resume-screens", async (req, res) => {
  const { candidateId, jobId, resumeText } = req.body;
  if (!candidateId || !jobId) { res.status(400).json({ error: "candidateId and jobId required" }); return; }
  const cGate = await gateCandidate(req, res, candidateId);
  if (!cGate) return;
  const jGate = await gateJob(req, res, jobId);
  if (!jGate) return;
  if ((cGate.candidate.tenantId ?? "") !== (jGate.job.tenantId ?? "")) {
    res.status(404).json({ error: "Not found" }); return;
  }
  // WRITE: persisting a resume_screen row attaches the candidate to this req.
  if (!(await requireRequisitionWriteAccess(res, jGate.user, jGate.job))) return;
  const tenantId = jGate.job.tenantId as string;

  // Blind screening: strip name/contact/DOB and other protected details from
  // the resume BEFORE it reaches the model, so the screening score cannot be
  // influenced by who the candidate is — only by what they can do.
  const cand: any = cGate.candidate;
  const safeResume = redactPii(resumeText, [cand?.firstName, cand?.lastName, cand?.fullName].filter(Boolean));

  const prompt = `Screen this resume for the job. The resume has been redacted of personal identifiers; score only on job-relevant skills and experience.
Resume text: ${safeResume?.substring(0, 4000) || "No resume text provided"}.
Return JSON with: screeningScore (0-100), extractedSkills (array), missingSkills (array), adjacentSkills (array), workHistory (array of {company, title, startDate, endDate, current}), education (array of strings), recruiterSummary (string).`;

  const aiResponse = await generateWithAI(
    prompt,
    `You are an expert recruiter screening a resume against a role. Return strictly valid JSON only.\n\n${FAIRNESS_DIRECTIVE}`,
  );
  let parsed: any = {};
  try { parsed = JSON.parse(aiResponse); } catch { parsed = {}; }

  const [screen] = await db.insert(resumeScreensTable).values({
    tenantId,
    candidateId, jobId,
    screeningScore: parsed.screeningScore || 72,
    extractedSkills: parsed.extractedSkills || [],
    missingSkills: parsed.missingSkills || [],
    adjacentSkills: parsed.adjacentSkills || [],
    workHistory: parsed.workHistory || [],
    education: parsed.education || [],
    recruiterSummary: parsed.recruiterSummary || "Resume screened successfully.",
  }).returning();

  // Enrich the candidate profile with the skills the screen just surfaced so
  // they show on the Overview and feed Talent Match (union — never overwrites).
  await mergeSkillsIntoCandidate(candidateId, parsed.extractedSkills);

  res.json({ ...screen, createdAt: screen.createdAt.toISOString() });
});

// ── GET /resume-screens/:candidateId ──────────────────────────────────────────
// Return the most recent resume screen for a candidate (404 if none exists).
router.get("/resume-screens/:candidateId", async (req, res) => {
  const gate = await gateCandidate(req, res, req.params.candidateId);
  if (!gate) return;
  const [screen] = await db.select().from(resumeScreensTable)
    .where(eq(resumeScreensTable.candidateId, req.params.candidateId))
    .orderBy(desc(resumeScreensTable.createdAt)).limit(1);
  if (!screen) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...screen, createdAt: screen.createdAt.toISOString() });
});

export default router;
