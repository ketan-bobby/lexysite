/**
 * Candidate-approved written introduction.
 *
 * This router is deliberately independent of career-profile, prep, learning,
 * evaluation and recommendation routes. Its data model accepts candidate edits
 * only and never generates or imports text from any private candidate surface.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  db,
  candidateIntroductionsTable,
  candidatesTable,
  talentPoolSubmissionsTable,
  applicationsTable,
  tenantsTable,
  jobsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { validate } from "../middlewares/validate";
import { resolveCandidateSession } from "../lib/portal-auth";
import { resolveUser } from "../middlewares/resolveUser";
import { getDataScopeTenantIds, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { getApprovedCandidateIntroduction } from "../lib/candidate-introduction";
import { applyCandidateHardExclusions, applyCandidatePrivacyFilter } from "./candidates";

const Strength = z.object({
  title: z.string().trim().min(1).max(100),
  evidence: z.string().trim().min(1).max(500),
}).strict();
const Achievement = z.object({
  text: z.string().trim().min(1).max(500),
}).strict();
const IntroductionBody = z.object({
  summary: z.string().trim().max(1200).default(""),
  strengths: z.array(Strength).max(8).default([]),
  achievements: z.array(Achievement).max(8).default([]),
  careerDirection: z.string().trim().max(500).nullable().optional(),
  rolePreferences: z.string().trim().max(500).nullable().optional(),
  availability: z.string().trim().max(250).nullable().optional(),
}).strict();
const ApprovalBody = z.object({
  /** Optimistic-concurrency token returned by the last draft read/save. */
  version: z.string().datetime(),
}).strict();

const EMPLOYER_ROLES = ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"];
const router: IRouter = Router();
// Draft versions are consent tokens, not cacheable profile data. A stale GET
// must never supply the version shown to a candidate reviewing an approval.
router.use("/portal/introduction", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

function privateResponse(candidateId: string, row?: any) {
  return {
    exists: !!row,
    candidateId,
    status: row?.status ?? "draft",
    summary: row?.summary ?? "",
    strengths: Array.isArray(row?.strengths) ? row.strengths : [],
    achievements: Array.isArray(row?.achievements) ? row.achievements : [],
    careerDirection: row?.careerDirection ?? null,
    rolePreferences: row?.rolePreferences ?? null,
    availability: row?.availability ?? null,
    approvedAt: row?.approvedAt ?? null,
    withdrawnAt: row?.withdrawnAt ?? null,
    version: row?.updatedAt?.toISOString?.() ?? null,
  };
}

async function ownIntroduction(req: any, res: any) {
  const session = await resolveCandidateSession(req);
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  return session;
}

router.get("/portal/introduction", resolveUser, async (req, res) => {
  const session = await ownIntroduction(req, res);
  if (!session) return;
  const [row] = await db.select().from(candidateIntroductionsTable)
    .where(eq(candidateIntroductionsTable.candidateId, session.candidateId)).limit(1);
  res.json(privateResponse(session.candidateId, row));
});

router.put("/portal/introduction", resolveUser, validate({ body: IntroductionBody }), async (req, res) => {
  const session = await ownIntroduction(req, res);
  if (!session) return;
  const body = req.body as z.infer<typeof IntroductionBody>;
  const now = new Date();
  const values = {
    summary: body.summary,
    strengths: body.strengths,
    achievements: body.achievements,
    careerDirection: body.careerDirection?.trim() || null,
    rolePreferences: body.rolePreferences?.trim() || null,
    availability: body.availability?.trim() || null,
    status: "draft",
    approvedAt: null,
    withdrawnAt: null,
    updatedAt: now,
  } as const;
  const [existing] = await db.select({ id: candidateIntroductionsTable.id })
    .from(candidateIntroductionsTable)
    .where(eq(candidateIntroductionsTable.candidateId, session.candidateId)).limit(1);
  if (existing) {
    await db.update(candidateIntroductionsTable).set(values)
      .where(eq(candidateIntroductionsTable.candidateId, session.candidateId));
  } else {
    await db.insert(candidateIntroductionsTable).values({
      id: crypto.randomUUID(),
      candidateId: session.candidateId,
      tenantId: session.tenantId,
      ...values,
      createdAt: now,
    });
  }
  const [saved] = await db.select().from(candidateIntroductionsTable)
    .where(eq(candidateIntroductionsTable.candidateId, session.candidateId)).limit(1);
  res.json(privateResponse(session.candidateId, saved));
});

router.post("/portal/introduction/approve", resolveUser, validate({ body: ApprovalBody }), async (req, res) => {
  const session = await ownIntroduction(req, res);
  if (!session) return;
  const [row] = await db.select().from(candidateIntroductionsTable)
    .where(eq(candidateIntroductionsTable.candidateId, session.candidateId)).limit(1);
  if (!row) { res.status(422).json({ error: "Save an introduction before approving it." }); return; }
  const hasDirectionOrPreference = !!(row.careerDirection?.trim() || row.rolePreferences?.trim() || row.availability?.trim());
  const hasEvidenceBackedStrength = Array.isArray(row.strengths)
    && row.strengths.some((s) => typeof (s as any)?.title === "string" && typeof (s as any)?.evidence === "string"
      && (s as any).title.trim() && (s as any).evidence.trim());
  if (!row.summary.trim() || !hasEvidenceBackedStrength || !hasDirectionOrPreference) {
    res.status(422).json({
      error: "Add a summary, one evidence-backed strength, and your direction, preferences, or availability before approving.",
    });
    return;
  }
  const version = (req.body as z.infer<typeof ApprovalBody>).version;
  if (row.updatedAt.toISOString() !== version) {
    res.status(409).json({ error: "This draft changed. Review the latest version before approving." });
    return;
  }
  const approvedAt = new Date();
  const updated = await db.update(candidateIntroductionsTable).set({
    status: "approved",
    approvedAt,
    withdrawnAt: null,
    updatedAt: approvedAt,
  }).where(and(
    eq(candidateIntroductionsTable.candidateId, session.candidateId),
    eq(candidateIntroductionsTable.updatedAt, row.updatedAt),
  )).returning({ id: candidateIntroductionsTable.id });
  if (updated.length === 0) {
    res.status(409).json({ error: "This draft changed. Review the latest version before approving." });
    return;
  }
  const [approved] = await db.select().from(candidateIntroductionsTable)
    .where(eq(candidateIntroductionsTable.candidateId, session.candidateId)).limit(1);
  res.json(privateResponse(session.candidateId, approved));
});

router.post("/portal/introduction/withdraw", resolveUser, async (req, res) => {
  const session = await ownIntroduction(req, res);
  if (!session) return;
  const [row] = await db.select({ id: candidateIntroductionsTable.id }).from(candidateIntroductionsTable)
    .where(eq(candidateIntroductionsTable.candidateId, session.candidateId)).limit(1);
  if (!row) { res.status(404).json({ error: "Introduction not found." }); return; }
  const withdrawnAt = new Date();
  await db.update(candidateIntroductionsTable).set({
    status: "withdrawn",
    approvedAt: null,
    withdrawnAt,
    updatedAt: withdrawnAt,
  }).where(eq(candidateIntroductionsTable.candidateId, session.candidateId));
  const [withdrawn] = await db.select().from(candidateIntroductionsTable)
    .where(eq(candidateIntroductionsTable.candidateId, session.candidateId)).limit(1);
  res.json(privateResponse(session.candidateId, withdrawn));
});

/**
 * A submission is a candidate-specific alternative to a platform-pool licence,
 * not permission to search the global database. Recruiters still need to own
 * the submitted requisition.
 */
async function hasSubmittedAccess(user: any, candidateId: string): Promise<boolean> {
  if (user.role === "platform_admin") return true;
  if (!user.tenantId) return false;
  const submissions = await db.select({
    jobPostingId: talentPoolSubmissionsTable.jobPostingId,
  }).from(talentPoolSubmissionsTable).where(and(
    eq(talentPoolSubmissionsTable.candidateId, candidateId),
    eq(talentPoolSubmissionsTable.clientTenantId, user.tenantId),
    eq(talentPoolSubmissionsTable.status, "active"),
  ));
  if (submissions.length === 0) return false;
  if (user.role === "recruiter") {
    const assignedIds = new Set(await getRecruiterAssignedJobIds(user));
    return submissions.some((submission) => !!submission.jobPostingId && assignedIds.has(submission.jobPostingId));
  }
  /* A hiring manager may only use a submission that belongs to one of their
   * assigned work orders. A tenant relationship alone must not expose another
   * manager's submission. */
  if (user.role === "hiring_manager") {
    const jobIds = submissions.map((submission) => submission.jobPostingId).filter((id): id is string => !!id);
    if (jobIds.length === 0) return false;
    const [job] = await db.select({ id: jobsTable.id }).from(jobsTable).where(and(
      inArray(jobsTable.id, jobIds),
      eq(jobsTable.tenantId, user.tenantId),
      eq(jobsTable.assignedHiringManagerId, user.id),
    )).limit(1);
    return !!job;
  }
  return true;
}

async function hasDirectScopedAccess(user: any, candidateId: string): Promise<boolean> {
  if (user.role === "platform_admin") return true;
  const [candidate] = await db.select()
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) return false;
  if (candidate.pool === "platform") {
    if (!user.tenantId) return false;
    const [tenant] = await db.select({ candidateDatabaseAccess: tenantsTable.candidateDatabaseAccess })
      .from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
    if (tenant?.candidateDatabaseAccess !== true) return false;
    /* A licence never overrides the canonical individual privacy seal. */
    const visible = await applyCandidatePrivacyFilter(
      applyCandidateHardExclusions([candidate]),
      user.tenantId,
    );
    if (visible.length === 0) return false;
  } else {
    const scopedTenants = await getDataScopeTenantIds(user);
    if (!scopedTenants?.includes(candidate.tenantId)) return false;
  }
  if (user.role !== "recruiter") return true;
  const assignedIds = await getRecruiterAssignedJobIds(user);
  if (assignedIds.length === 0) return false;
  const [application] = await db.select({ id: applicationsTable.id }).from(applicationsTable)
    .where(and(eq(applicationsTable.candidateId, candidateId), inArray(applicationsTable.jobId, assignedIds)))
    .limit(1);
  return !!application;
}

router.get("/candidates/:candidateId/introduction", resolveUser, async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const user = req.resolvedUser;
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!EMPLOYER_ROLES.includes(user.role)) { res.status(404).json({ error: "Not found" }); return; }
  const rawCandidateId = req.params.candidateId;
  const candidateId = Array.isArray(rawCandidateId) ? rawCandidateId[0] : rawCandidateId;
  if (!candidateId) { res.status(404).json({ error: "Not found" }); return; }
  const [submitted, direct] = await Promise.all([
    hasSubmittedAccess(user, candidateId),
    hasDirectScopedAccess(user, candidateId),
  ]);
  if (!submitted && !direct) { res.status(404).json({ error: "Not found" }); return; }
  /* The relationship/licence decision above never overrides a platform-pool
   * candidate's own privacy controls. Keep this check here as well as in the
   * licensed path so a submission-based grant is sealed identically. */
  if (user.role !== "platform_admin") {
    const [candidate] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!candidate) { res.status(404).json({ error: "Not found" }); return; }
    if (candidate.pool === "platform") {
      const visible = await applyCandidatePrivacyFilter(
        applyCandidateHardExclusions([candidate]),
        user.tenantId ?? null,
      );
      if (visible.length === 0) { res.status(404).json({ error: "Not found" }); return; }
    }
  }
  const introduction = await getApprovedCandidateIntroduction(candidateId);
  if (!introduction) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ exists: true, ...introduction });
});

export default router;