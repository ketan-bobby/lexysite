/**
 * enrich-candidate.ts — Resume-driven candidate profile enrichment.
 *
 * The platform extracts skills from resumes in several places (CV import,
 * resume screening) but historically only the bulk CV-import path wrote those
 * skills back onto the candidate row. Resume uploads on an existing candidate
 * and standalone resume screens left `candidates.skills` empty, which is why
 * a candidate could have an uploaded + screened resume yet still show
 * "No skills listed" (and therefore score poorly / 0% on Talent Match).
 *
 * This module centralizes "enrich the candidate profile from resume-derived
 * skills":
 *   • mergeSkillsIntoCandidate()   — union new skills into candidates.skills.
 *   • extractSkillsFromResume()    — download a stored resume + AI-extract skills.
 *   • enrichCandidateFromResume()  — extract + merge in one best-effort call.
 *
 * All writers UNION (never overwrite) so recruiter-entered skills are preserved.
 *
 * PROVENANCE IS IMMUTABLE TO ENRICHMENT. candidates.source is now
 * badge-determining on the pipeline board (MANUAL / DEMO RUN / AI SOURCED —
 * see PipelinePanel.tsx). No enrichment path may rewrite candidates.source.
 * In particular the upcoming PDL single-candidate email enrichment must leave
 * source untouched: a MANUAL candidate whose email gets PDL-enriched stays
 * MANUAL. The pdl_enriched flag belongs on the email/contact data, not on
 * provenance. Every writer here only touches contact/skill fields
 * (linkedinUrl, githubUrl, skills) and deliberately never `.set({ source })`.
 */
import { db, candidatesTable, jobsTable, icpTable, resumeScreensTable, applicationsTable, sourcedCandidatesTable, candidateJobIntelligenceTable } from "@workspace/db";
import { and, eq, or, isNull } from "drizzle-orm";
import { logger } from "./logger.js";
import { generateJSON } from "./ai.js";
import { scoreCandidateForJob } from "./icp-generator.js";
import { upsertIntelligence } from "./intelligence.js";
import { ObjectStorageService } from "./objectStorage.js";

/** Case-insensitive union of skill lists, preserving first-seen casing/order. */
export function unionSkills(
  existing: readonly string[] | null | undefined,
  incoming: readonly string[] | null | undefined,
): string[] {
  const seen = new Map<string, string>();
  for (const raw of [...(existing ?? []), ...(incoming ?? [])]) {
    const v = (raw ?? "").trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (!seen.has(key)) seen.set(key, v);
  }
  return Array.from(seen.values());
}

/**
 * Validate that `raw` is a URL whose hostname is (a subdomain of) `domain`.
 * Returns the trimmed URL when valid, else null. Accepts scheme-less inputs
 * (e.g. "linkedin.com/in/jane") by assuming https://.
 */
function normalizeSocialUrl(raw: string | null | undefined, domain: string): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    const host = u.hostname.toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) return v;
  } catch {
    /* not a parseable URL */
  }
  return null;
}

/**
 * Backfill candidates.linkedin_url / github_url from resume-extracted URLs, but
 * ONLY when the column is currently empty — never overwrite a value the candidate
 * or recruiter entered themselves. Light-validates the domain so unrelated links
 * aren't stored. Best-effort: logs and swallows errors, never throws.
 */
export async function fillCandidateSocialUrlsIfEmpty(
  candidateId: string,
  urls: { linkedinUrl?: string | null; githubUrl?: string | null },
): Promise<void> {
  try {
    const li = normalizeSocialUrl(urls.linkedinUrl, "linkedin.com");
    const gh = normalizeSocialUrl(urls.githubUrl, "github.com");

    if (li) {
      await db
        .update(candidatesTable)
        .set({ linkedinUrl: li })
        .where(and(
          eq(candidatesTable.id, candidateId),
          or(isNull(candidatesTable.linkedinUrl), eq(candidatesTable.linkedinUrl, "")),
        ));
    }
    if (gh) {
      await db
        .update(candidatesTable)
        .set({ githubUrl: gh })
        .where(and(
          eq(candidatesTable.id, candidateId),
          or(isNull(candidatesTable.githubUrl), eq(candidatesTable.githubUrl, "")),
        ));
    }
  } catch (err) {
    logger.warn({ err, candidateId }, "[enrich] fillCandidateSocialUrlsIfEmpty failed (non-fatal)");
  }
}

/**
 * Union `incoming` skills into candidates.skills. Returns the merged list, or
 * null when there was nothing to add / candidate missing. Never throws.
 */
export async function mergeSkillsIntoCandidate(
  candidateId: string,
  incoming: readonly string[] | null | undefined,
): Promise<string[] | null> {
  try {
    const clean = (incoming ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
    if (clean.length === 0) return null;

    // Read-modify-write must be atomic: concurrent enrich calls (e.g. a resume
    // upload + a resume screen racing) would otherwise last-writer-wins and drop
    // skills. Lock the row FOR UPDATE inside a transaction so the union holds.
    return await db.transaction(async (tx) => {
      const [c] = await tx
        .select({ skills: candidatesTable.skills })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, candidateId))
        .limit(1)
        .for("update");
      if (!c) return null;

      const existing = (c.skills as string[]) ?? [];
      const merged = unionSkills(existing, clean);
      // No-op when nothing new was added.
      if (merged.length === existing.length) return existing;

      await tx
        .update(candidatesTable)
        .set({ skills: merged, updatedAt: new Date() })
        .where(eq(candidatesTable.id, candidateId));
      logger.info(
        { candidateId, added: merged.length - existing.length, total: merged.length },
        "[enrich] merged resume skills into candidate",
      );
      return merged;
    });
  } catch (err) {
    logger.warn({ err, candidateId }, "[enrich] mergeSkillsIntoCandidate failed (non-fatal)");
    return null;
  }
}

/** Extract readable text from a downloaded resume buffer (PDF / DOCX / TXT). */
async function extractResumeText(buf: Buffer): Promise<string> {
  const head = buf.slice(0, 4).toString("latin1");
  if (head.startsWith("%PDF")) {
    const pdfParse = (await import("pdf-parse")).default;
    const parsed = await pdfParse(buf);
    return parsed.text ?? "";
  }
  // DOCX (and other OOXML) are ZIP archives — magic bytes "PK".
  if (head.startsWith("PK")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value ?? "";
  }
  return buf.toString("utf-8");
}

/**
 * Download a stored resume (by /objects/... path) and return its readable text.
 * Returns "" on any failure. Never throws.
 */
export async function downloadResumeText(objectPath: string): Promise<string> {
  try {
    if (!objectPath) return "";
    const svc = new ObjectStorageService();
    const ref = await svc.getObjectEntityFile(objectPath);
    const resp = await svc.downloadObject(ref);
    const buf = Buffer.from(await resp.arrayBuffer());
    return await extractResumeText(buf);
  } catch (err) {
    logger.warn({ err, objectPath }, "[enrich] downloadResumeText failed (non-fatal)");
    return "";
  }
}

export async function extractSkillsFromResume(objectPath: string): Promise<string[]> {
  try {
    if (!objectPath) return [];
    const text = await downloadResumeText(objectPath);
    if (!text || text.trim().length < 20) {
      logger.warn({ objectPath }, "[enrich] resume produced no readable text");
      return [];
    }

    const extracted = await generateJSON<{ skills?: string[] }>(
      `Extract the candidate's professional/technical skills from this resume text.
Return JSON: { "skills": string[] } — concise individual skills (languages, frameworks,
tools, methodologies, domains). No duplicates, no sentences.

RESUME TEXT:
${text.slice(0, 6000)}`,
      "You extract a clean skills list from resume text. Return valid JSON only — no markdown, no explanation.",
    );
    return (extracted.skills ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  } catch (err) {
    logger.warn({ err, objectPath }, "[enrich] extractSkillsFromResume failed (non-fatal)");
    return [];
  }
}

/**
 * One-shot: extract skills from a candidate's resume and union them into the
 * candidate profile. Best-effort — returns the merged skills or null.
 */
export async function enrichCandidateFromResume(
  candidateId: string,
  objectPath: string,
): Promise<string[] | null> {
  const skills = await extractSkillsFromResume(objectPath);
  if (skills.length === 0) return null;
  return mergeSkillsIntoCandidate(candidateId, skills);
}

/**
 * Recompute a candidate's Talent Match score for a specific job AFTER their
 * profile has been enriched (e.g. resume-derived skills/title merged in), and
 * persist the fresh score to both stores the Pipeline reads:
 *   • applications.match_score
 *   • sourced_candidates.raw_data.matchScore / matchReason
 *
 * Why this exists: the match score is computed once at candidate-link time
 * (linkCandidateToJob). When a candidate is added from a resume, skills are
 * extracted ASYNCHRONOUSLY after linking, so the link-time score is computed on
 * an empty profile — the LLM correctly returns ~0 ("no data to evaluate"). The
 * profile then fills in, but nothing re-scored it, leaving a stale "Match 0%".
 *
 * Best-effort: only overwrites when a fresh non-null score is produced, so a
 * scoring failure never clobbers an existing good score. Never throws.
 */
export async function rescoreCandidateForJob(
  candidateId: string,
  jobId: string,
): Promise<number | null> {
  try {
    if (!candidateId || !jobId) return null;

    const [candidate] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!candidate) return null;

    // Score against the JOB's own tenant (tenants form a tree — a parent-tenant
    // recruiter may link a candidate onto a child-tenant job). Mirrors the
    // tenant choice in linkCandidateToJob.
    const [job] = await db.select({ tenantId: jobsTable.tenantId })
      .from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    if (!job) return null;

    const scored = await scoreCandidateForJob(jobId, {
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      currentTitle: candidate.currentTitle,
      currentCompany: candidate.currentCompany,
      skills: candidate.skills as string[] | null,
      location: candidate.location,
    }, job.tenantId);
    if (!scored || typeof scored.score !== "number") return null;

    // Update the application row (if the candidate is linked to this job).
    await db.update(applicationsTable)
      .set({ matchScore: scored.score, updatedAt: new Date() })
      .where(and(
        eq(applicationsTable.candidateId, candidateId),
        eq(applicationsTable.jobId, jobId),
      ));

    // Update the sourced row's rawData jsonb. raw_data has no jobId column, so
    // read-modify-write under FOR UPDATE and only touch rows pointing at this job.
    await db.transaction(async (tx) => {
      const rows = await tx.select().from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.normalizedCandidateId, candidateId))
        .for("update");
      for (const row of rows) {
        const raw = (row.rawData as any) ?? {};
        if (String(raw.jobId ?? "") !== String(jobId)) continue;
        raw.matchScore = scored.score;
        raw.matchReason = scored.reason ?? null;
        await tx.update(sourcedCandidatesTable)
          .set({ rawData: raw })
          .where(eq(sourcedCandidatesTable.id, row.id));
      }
    });

    // Refresh the Talent Match panel's source-of-truth. It displays
    // candidate_job_intelligence.fitScore, which is derived from the screening
    // signal and goes stale when the score was first computed before the resume
    // existed. Fold the fresh score into the existing intelligence row's
    // screening signal (preserving its other fields) so it no longer shows 0%.
    try {
      const [intel] = await db
        .select({ signals: candidateJobIntelligenceTable.signalsJson })
        .from(candidateJobIntelligenceTable)
        .where(and(
          eq(candidateJobIntelligenceTable.candidateId, candidateId),
          eq(candidateJobIntelligenceTable.jobId, jobId),
        ))
        .limit(1);
      if (intel && job.tenantId) {
        const prevScreening = ((intel.signals as Record<string, unknown> | null)?.screening
          ?? {}) as Record<string, unknown>;
        await upsertIntelligence(job.tenantId, jobId, candidateId, {
          screening: {
            ...prevScreening,
            skillMatchScore: scored.score,
            resumeMatchScore: scored.score,
            score: scored.score,
          },
        });
      }
    } catch (err) {
      logger.warn({ err, candidateId, jobId }, "[rescore] intelligence fitScore refresh failed (non-fatal)");
    }

    logger.info(
      { candidateId, jobId, score: scored.score },
      "[rescore] recomputed Talent Match score after enrichment",
    );
    return scored.score;
  } catch (err) {
    logger.warn({ err, candidateId, jobId }, "[rescore] rescoreCandidateForJob failed (non-fatal)");
    return null;
  }
}

/**
 * Resume-screen a candidate against a specific job and persist a `resume_screens`
 * row (the record the candidate Resume Screen tab reads) plus union the
 * resume-derived skills into the candidate profile.
 *
 * Cross-tenant safe: the row is tenanted to the JOB's tenant, since a parent-tenant
 * recruiter may add a candidate from their pool onto a child-tenant job.
 * Idempotent: skips when a resume_screens row already exists for (candidate, job).
 * Best-effort — logs and returns a status object, never throws.
 */
export async function screenCandidateResume(
  candidateId: string,
  jobId: string,
): Promise<{ screened: boolean; reason?: string }> {
  try {
    const [candidate] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!candidate) return { screened: false, reason: "candidate_not_found" };
    if (!candidate.resumeUrl) return { screened: false, reason: "no_resume" };

    const [job] = await db.select().from(jobsTable)
      .where(eq(jobsTable.id, jobId)).limit(1);
    if (!job) return { screened: false, reason: "job_not_found" };

    // Idempotent: never re-screen the same candidate/job pair.
    const [existing] = await db.select({ id: resumeScreensTable.id })
      .from(resumeScreensTable)
      .where(and(
        eq(resumeScreensTable.candidateId, candidateId),
        eq(resumeScreensTable.jobId, jobId),
      ))
      .limit(1);
    if (existing) return { screened: false, reason: "already_screened" };

    const text = await downloadResumeText(candidate.resumeUrl);
    if (!text || text.trim().length < 20) {
      return { screened: false, reason: "no_readable_text" };
    }

    const [icp] = await db.select().from(icpTable)
      .where(eq(icpTable.jobId, jobId)).limit(1);
    const requiredSkills = (icp?.requiredSkills as string[] | undefined) ?? [];

    const result = await generateJSON<{
      screeningScore?: number;
      extractedSkills?: string[];
      missingSkills?: string[];
      adjacentSkills?: string[];
      workHistory?: unknown[];
      education?: string[];
      recruiterSummary?: string;
      recommendation?: "advance" | "hold" | "reject";
      linkedinUrl?: string | null;
      githubUrl?: string | null;
    }>(
      `Screen this resume against the job and return structured JSON.

JOB: ${job.title ?? "Unknown role"}
REQUIRED SKILLS: ${requiredSkills.length ? requiredSkills.join(", ") : "(not specified)"}

RESUME TEXT:
${text.slice(0, 6000)}

Return JSON with keys:
  screeningScore (0-100 integer — fit for THIS job),
  extractedSkills (string[] — skills evidenced in the resume),
  missingSkills (string[] — required skills not evidenced),
  adjacentSkills (string[] — transferable/related skills),
  workHistory (array of { company, title, startDate, endDate, current }),
  education (string[]),
  recommendation ("advance"|"hold"|"reject" — advance a strong fit, reject only when clearly unqualified),
  linkedinUrl (string|null — candidate's LinkedIn profile URL if it appears in the resume),
  githubUrl (string|null — candidate's GitHub profile URL if it appears in the resume),
  recruiterSummary (2-3 sentence plain-language summary for the recruiter).`,
      "You are an expert technical recruiter. Screen resumes objectively and return valid JSON only — no markdown, no commentary.",
    );

    const extractedSkills = (result.extractedSkills ?? []).map((s) => (s ?? "").trim()).filter(Boolean);

    // The Pipeline kanban derives a sourced candidate's stage from
    // rawData.screeningResult.recommendation, so a stale verdict left over from an
    // earlier screen on an EMPTY pre-resume profile (recommendation "reject",
    // score 0) keeps the candidate parked in the Rejected column even after their
    // resume lands. We overwrite that verdict with this resume-based screen below.
    const recommendation: "advance" | "hold" | "reject" =
      result.recommendation === "advance" || result.recommendation === "reject"
        ? result.recommendation
        : "hold";
    const screeningResult = {
      score: typeof result.screeningScore === "number" ? result.screeningScore : 0,
      recommendation,
      extractedSkills,
      missingSkills: (result.missingSkills ?? []).map((s) => (s ?? "").trim()).filter(Boolean),
      recruiterSummary: result.recruiterSummary || "Resume screened.",
    };

    // Persist the resume_screens row AND sync the sourced rawData verdict in ONE
    // transaction. The resume_screens row is the idempotency marker (a later call
    // early-returns "already_screened"), so if the sourced sync ran separately and
    // failed, the stale verdict would be stranded with no retry. raw_data has no
    // jobId column, so read-modify-write under FOR UPDATE, only touching this job's rows.
    await db.transaction(async (tx) => {
      await tx.insert(resumeScreensTable).values({
        tenantId: (job.tenantId as string) ?? candidate.tenantId,
        candidateId,
        jobId,
        screeningScore: typeof result.screeningScore === "number" ? result.screeningScore : 0,
        extractedSkills,
        missingSkills: screeningResult.missingSkills,
        adjacentSkills: (result.adjacentSkills ?? []).map((s) => (s ?? "").trim()).filter(Boolean),
        workHistory: Array.isArray(result.workHistory) ? result.workHistory : [],
        education: (result.education ?? []).map((s) => (s ?? "").trim()).filter(Boolean),
        recruiterSummary: screeningResult.recruiterSummary,
      });

      const rows = await tx.select().from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.normalizedCandidateId, candidateId))
        .for("update");
      for (const row of rows) {
        const raw = (row.rawData as any) ?? {};
        if (String(raw.jobId ?? "") !== String(jobId)) continue;
        raw.screened = true;
        raw.screeningResult = screeningResult;
        // Only clear an AI/screening-derived "rejected" stage. A human reject
        // (recruiter or hiring manager) persists rejection metadata alongside the
        // stage — never resurrect those candidates back into the active pipeline.
        const humanRejected = !!(raw.rejectedByUserId || raw.rejectedAt || raw.rejectionReason || raw.rejectedByRole);
        if (raw.stage === "rejected" && !humanRejected) raw.stage = "sourced";
        await tx.update(sourcedCandidatesTable)
          .set({ rawData: raw })
          .where(eq(sourcedCandidatesTable.id, row.id));
      }
    });

    // Surface resume-derived skills on the candidate profile (union, never overwrites).
    await mergeSkillsIntoCandidate(candidateId, extractedSkills);

    // Backfill LinkedIn/GitHub from the resume when those fields are still empty.
    await fillCandidateSocialUrlsIfEmpty(candidateId, {
      linkedinUrl: result.linkedinUrl,
      githubUrl: result.githubUrl,
    });

    // The Talent Match score was computed at link time on a then-empty profile
    // (resume skills are extracted asynchronously). Now that the profile is
    // enriched, recompute it so the Pipeline shows a real match instead of 0%.
    await rescoreCandidateForJob(candidateId, jobId);

    logger.info({ candidateId, jobId, score: result.screeningScore }, "[screen] resume screened");
    return { screened: true };
  } catch (err) {
    logger.warn({ err, candidateId, jobId }, "[screen] screenCandidateResume failed (non-fatal)");
    return { screened: false, reason: "error" };
  }
}
