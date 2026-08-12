/**
 * career-profile.ts — Candidate career profile API routes.
 *
 * All routes are prefixed with `/portal` and require a valid candidate JWT
 * (enforced by the `candidateAuth` middleware applied in the router mount).
 *
 * ── Endpoints ──
 *  GET  /portal/career-profile                  → Full profile row for the logged-in candidate
 *  POST /portal/career-profile/resume           → Save a resume object path to the profile
 *  POST /portal/career-profile/resume/parse     → AI-parse a resume PDF/DOCX into structured JSON
 *  POST /portal/career-interview/chat           → Streaming/polling AI interview chat turn
 *  POST /portal/career-interview/complete       → Trigger full AI analysis after interview
 *  POST /portal/career-interview/regenerate-transcript → Re-generate transcript from stored conversation
 *  GET  /portal/career-interview/voice          → Azure TTS synthesis for a given text
 *  GET  /portal/opportunities                   → Matched open roles from the job index
 *  GET  /portal/career-recommendations          → AI-generated next-best-action recommendations
 *  POST /portal/recommendations/complete        → Mark a recommendation as done
 *  POST /portal/log-action                      → Emit a candidate activity event
 *  GET  /portal/applications                    → All applications for the logged-in candidate
 *  GET  /portal/interviews                      → All scheduled + AI-session interviews
 *
 * ── Key dependencies ──
 *  - `chatCompletionWithAI` : Unified LLM call (always OpenAI in production).
 *  - `synthesizeSpeechAzure`: Azure Cognitive Services TTS for voice mode.
 *  - `pdfParse` / `mammoth` : Resume text extraction from PDF / DOCX files.
 *  - `getRecordingUploadUrl`: S3 pre-signed upload URLs for video recording.
 *
 * ── Database tables ──
 *  - `candidateCareerProfilesTable` : Main profile row (1 per candidate)
 *  - `candidateRecommendationProgressTable` : Completed recommendation events
 *  - `candidateActivityStreaksTable` : Daily activity streak tracking
 *  - `candidateActionEventsTable`    : Raw event log for activity feed
 */

import { Router } from "express";
import { classBRead, CLASS_B_READ_EXEMPTION } from "../lib/class-b-read";
import { createRequire } from "module";
import multer from "multer";
import mammoth from "mammoth";
import OpenAI from "openai";
import { z } from "zod";
import { db, candidateCareerProfilesTable, jobsTable, usersTable, candidateRecommendationProgressTable, applicationsTable, candidatesTable, candidateProgressSnapshotsTable, candidateActivityStreaksTable, candidateActionEventsTable, candidateSkillScoresTable, interviewSchedulesTable, interviewSessionsTable, tenantsTable, talentPoolSubmissionsTable, communicationEventsTable, candidateDemographicsTable, candidateAiConsentTable, deletionRequestsTable } from "@workspace/db";
import { changeCandidateStage } from "../lib/change-candidate-stage.js";
import { recordAudit } from "../lib/audit";
import { eq, desc, and, ilike, gte, sql, avg, inArray, count, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { originFields } from "../lib/sourcing-origin";
import { chatCompletionWithAI, synthesizeSpeechAzure, resolveLangMeta } from "../lib/ai";
import { getRecordingUploadUrl, getRecordingPlaybackUrl, isS3Configured, streamRecordingParts } from "../lib/s3Recording";
import { ObjectStorageService, s3Client } from "../lib/objectStorage";
import { getAuthUserId } from "../lib/auth-token";
import { resolveCandidateId } from "../lib/portal-auth";
import { fillCandidateSocialUrlsIfEmpty } from "../lib/enrich-candidate";
import { validate } from "../middlewares/validate";
import { logCandidateEvent } from "../lib/candidate-event-logger.js";
import { computeInterviewQuality } from "../lib/readiness-quality.js";
import { processSelfReportedJobChange } from "../lib/self-report-reengagement.js";

/* ── Inline request body schemas (zod) ───────────────────────────────────── */
const CandidateMeUpdateBody = z.object({
  firstName: z.string().optional().nullable(),
  lastName: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  githubUrl: z.string().optional().nullable(),
}).passthrough();

const PrepQuestionsBody = z.object({
  mode: z.string().min(1),
  modeLabel: z.string().min(1),
  categories: z.array(z.string()),
  count: z.number().optional(),
}).passthrough();

const CareerProfileUpdateBody = z.object({
  currentTitle: z.string().optional().nullable(),
  currentCompany: z.string().optional().nullable(),
  yearsExperience: z.number().optional().nullable(),
  currentSalaryRange: z.string().optional().nullable(),
  skills: z.array(z.string()).optional(),
  education: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  bio: z.string().optional().nullable(),
  careerGoal3yr: z.string().optional().nullable(),
  careerGoal5yr: z.string().optional().nullable(),
  targetCompanies: z.array(z.string()).optional(),
  targetIndustries: z.array(z.string()).optional(),
  preferredRoles: z.array(z.string()).optional(),
  desiredSalaryRange: z.string().optional().nullable(),
  preferredWorkStyle: z.string().optional().nullable(),
  preferredTeamSize: z.string().optional().nullable(),
  motivations: z.array(z.string()).optional(),
}).passthrough();

const CareerInterviewMessageBody = z.object({
  message: z.string().min(1),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  })).optional(),
  language: z.string().optional(),
  persona: z.string().optional(),
  resumeProfile: z.record(z.unknown()).nullable().optional(),
  hasResumeUrl: z.boolean().optional(),
}).passthrough();

const CareerInterviewCompleteBody = z.object({
  history: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).optional(),
  language: z.string().optional(),
}).passthrough();

const MocksCompleteBody = z.object({
  mode: z.string().min(1),
  modeLabel: z.string().optional(),
  categories: z.array(z.string()).optional(),
  questionsAnswered: z.number().optional(),
  gotItCount: z.number().optional(),
  needWorkCount: z.number().optional(),
}).passthrough();

const PrivacyUpdateBody = z.object({
  discoveryPaused: z.boolean().optional(),
  hideFromCurrentEmployer: z.boolean().optional(),
  currentEmployerDomain: z.string().optional().nullable(),
  blockedCompanyDomains: z.array(z.string()).optional(),
  matchOnlyVisibility: z.boolean().optional(),
}).passthrough();

const RecommendationsCompleteBody = z.object({
  recKey: z.string().min(1),
  notes: z.string().optional().nullable(),
}).passthrough();

const ResumeSaveBody = z.object({
  resumeObjectPath: z.string().min(1),
}).passthrough();

const TtsBody = z.object({
  text: z.string().min(1),
  voice: z.string().optional().nullable(),
  language: z.string().optional(),
}).passthrough();

const RecordingUploadUrlBody = z.object({
  filename: z.string().optional(),
}).passthrough();

const SaveRecordingBody = z.object({
  objectPath: z.string().optional().nullable(),
  durationSec: z.number().optional().nullable(),
  recordingSessionId: z.string().optional().nullable(),
}).passthrough();

const LogActionBody = z.object({
  eventType: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
}).passthrough();

const TrackClickBody = z.object({
  jobId: z.string().optional().nullable(),
  jobTitle: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  sourceUrl: z.string().optional().nullable(),
  isExternal: z.boolean().optional(),
}).passthrough();

const _require = createRequire(import.meta.url);
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = _require("pdf-parse");
const resumeUploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

const router = Router();

const openai = new OpenAI({ apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY, baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL });
const objectStorageService = new ObjectStorageService();

/* ── Profile merge utility ───────────────────────────────────────────────── */
/**
 * SINGLE SOURCE OF TRUTH for assembling a career profile record after an
 * interview completes.
 *
 * Priority (highest → lowest) for each field:
 *   1. AI-extracted from the interview conversation  (freshest signal)
 *   2. Existing DB profile                           (resume-parsed or prior interview)
 *   3. Resume parsed profile JSON                    (structural fallback)
 *   4. null / []                                     (explicit absence)
 *
 * Rules:
 *  - Scalar fields (string | number | null): take the first non-null value
 *    along the priority chain.
 *  - Array fields: merge all sources, deduplicate, cap where noted.
 *    Exception: strengthAreas / growthAreas come ONLY from the interview
 *    extraction — they represent the AI's fresh assessment and should not
 *    accumulate stale values across sessions.
 *
 * Adding a new profile field?  Add ONE line here.  Every interview path
 * automatically gets the correct fallback behaviour for free.
 */
function mergeProfileData(
  extracted:       Record<string, any>,
  existing:        Record<string, any> | null,
  resumeParsed:    Record<string, any> | null,
): Record<string, any> {
  const rp = resumeParsed ?? {};
  const ex = existing    ?? {};

  /** First non-null wins along the priority chain. */
  function pick<T>(...values: (T | null | undefined)[]): T | null {
    for (const v of values) {
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }

  /**
   * Merge arrays from multiple sources, deduplicate case-insensitively,
   * and cap the result length.
   */
  function mergeArrays(cap: number, ...sources: (any[] | null | undefined)[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const src of sources) {
      for (const item of (src ?? [])) {
        const key = String(item).toLowerCase();
        if (!seen.has(key)) { seen.add(key); out.push(String(item)); }
      }
    }
    return out.slice(0, cap);
  }

  return {
    // ── Identity & background ─────────────────────────────────────────────
    currentTitle:    pick(extracted.currentTitle,    ex.currentTitle,    rp.current_title),
    currentCompany:  pick(extracted.currentCompany,  ex.currentCompany,  rp.current_company),
    yearsExperience: pick(extracted.yearsExperience, ex.yearsExperience, rp.total_years_experience),
    education:       pick(extracted.education,       ex.education,       rp.education),
    bio:             pick(extracted.bio,             ex.bio),

    // ── Skills — merge all sources, interview wins on overlap ─────────────
    skills: mergeArrays(12,
      extracted.skills,
      ex.skills       as string[] | null,
      rp.core_skills  as string[] | null,
      rp.skills       as string[] | null,
    ),

    // ── Career goals ──────────────────────────────────────────────────────
    careerGoal3yr:      pick(extracted.careerGoal3yr,  ex.careerGoal3yr),
    careerGoal5yr:      pick(extracted.careerGoal5yr,  ex.careerGoal5yr),
    preferredWorkStyle: pick(extracted.preferredWorkStyle, ex.preferredWorkStyle),

    // ── Targets & preferences (interview wins; fall back to existing) ─────
    targetCompanies:  (extracted.targetCompanies  ?? []).length > 0 ? extracted.targetCompanies  : (ex.targetCompanies  ?? []),
    targetIndustries: (extracted.targetIndustries ?? []).length > 0 ? extracted.targetIndustries : (ex.targetIndustries ?? []),
    preferredRoles:   (extracted.preferredRoles   ?? []).length > 0 ? extracted.preferredRoles   : (ex.preferredRoles   ?? []),
    motivations:      (extracted.motivations      ?? []).length > 0 ? extracted.motivations      : (ex.motivations      ?? []),

    // ── AI assessment — fresh from THIS interview only ────────────────────
    // Do NOT merge with prior values; these represent the AI's current read.
    strengthAreas: extracted.strengthAreas ?? [],
    growthAreas:   extracted.growthAreas   ?? [],

    // ── AI-generated artefacts ────────────────────────────────────────────
    aiSummary:   extracted.aiSummary   ?? null,
    careerPaths: extracted.careerPaths ?? [],
  };
}

/**
 * Validate that the merged profile contains the fields that the interview
 * was supposed to capture.  Logs a warning for each gap so we can spot
 * regressions in development without breaking users.
 *
 * Returns a list of missing field names (empty = all good).
 */
function validateMergedProfile(
  merged:      Record<string, any>,
  candidateId: string,
  hasResume:   boolean,
): string[] {
  const required: { field: string; label: string }[] = [
    { field: "currentTitle",    label: "current title"      },
    { field: "careerGoal3yr",   label: "3-year career goal" },
    { field: "careerGoal5yr",   label: "5-year career vision" },
    { field: "preferredRoles",  label: "preferred roles"    },
    { field: "strengthAreas",   label: "strength areas"     },
  ];
  if (hasResume) {
    // Resume path explicitly skips asking years-of-experience; it should
    // have come from the resume itself — warn only if still missing.
    required.push({ field: "yearsExperience", label: "years of experience" });
  }

  const missing: string[] = [];
  for (const { field, label } of required) {
    const v = merged[field];
    const isEmpty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
    if (isEmpty) {
      missing.push(field);
      logger.warn(
        { candidateId, field, hasResume },
        `[interview-complete] Required profile field '${label}' is still empty after merge — check extraction prompt coverage`,
      );
    }
  }
  return missing;
}

/* ── Score helpers ───────────────────────────────────────────────────────── */
// computeInterviewQuality moved to ../lib/readiness-quality.ts (substance-based
// scoring, replacing the old volume-biased length metric) — see that file and
// its tests (readiness-quality.test.ts) for the rubric.

function computeProfileCompleteness(data: {
  currentTitle?: any; currentCompany?: any; yearsExperience?: any;
  skills?: any[]; education?: any; bio?: any;
  careerGoal3yr?: any; careerGoal5yr?: any;
  targetIndustries?: any[]; preferredRoles?: any[];
  strengthAreas?: any[]; growthAreas?: any[]; aiSummary?: any;
  interviewQualityScore?: number;
}): number {
  // q is 0-1 multiplier for AI-generated / interview-derived fields.
  // Resume-sourced fields (title, company, years, skills, education) always count at full value.
  const q = Math.min(1, (data.interviewQualityScore ?? 100) / 100);

  let score = 0;
  // Resume-derived (full value always)
  if (data.currentTitle)             score += 10;
  if (data.currentCompany)           score += 5;
  if (data.yearsExperience != null)  score += 10;
  score += Math.min(15, (data.skills ?? []).length * 2);    // 2 pts/skill, max 15
  if (data.education)                score += 8;

  // Interview-derived (quality-weighted)
  if (data.bio)                      score += 7  * q;
  if (data.careerGoal3yr)            score += 10 * q;
  if (data.careerGoal5yr)            score += 5  * q;
  if ((data.targetIndustries ?? []).length > 0) score += 5 * q;
  if ((data.preferredRoles ?? []).length > 0)   score += 5 * q;
  score += Math.min(10, (data.strengthAreas ?? []).length * 2) * q;
  score += Math.min(5,  (data.growthAreas  ?? []).length  * 2) * q;
  if (data.aiSummary)                score += 5  * q;

  return Math.min(100, Math.round(score));
}

export interface ReadinessBreakdownItem {
  factor: string;
  description: string;
  earned: number;
  max: number;
  /** short human-readable tip shown when not at full points */
  tip?: string;
}

/**
 * Compute readiness score (0-100) from profile richness.
 * Base 30 for completing the interview, then scaled by breadth and quality.
 * Returns both the final score and a per-factor breakdown so the candidate
 * can see exactly what contributes and what to improve.
 */
function computeReadinessScore(data: {
  baselineInterviewCompleted?: boolean;
  skills?: any[]; yearsExperience?: any;
  careerGoal3yr?: any; careerGoal5yr?: any; preferredRoles?: any[];
  strengthAreas?: any[]; growthAreas?: any[];
  careerPaths?: any[]; aiSummary?: any;
  interviewQualityScore?: number;
}): { score: number; breakdown: ReadinessBreakdownItem[] } {
  const breakdown: ReadinessBreakdownItem[] = [];

  // Quality multiplier (0-1): weights everything ABOVE the base 30-pt interview credit.
  // If answers were substantive (quality=100) → full points.
  // If answers were very short/empty (quality=5) → most interview-derived pts zeroed out.
  // Resume-sourced fields (skills, years) are not penalised by quality.
  const q = Math.min(1, (data.interviewQualityScore ?? 100) / 100);
  const qualityLabel = q >= 0.8 ? "Detailed" : q >= 0.5 ? "Moderate" : q >= 0.25 ? "Brief" : "Very brief";

  // Base — completing the interview
  const interviewPts = data.baselineInterviewCompleted ? 30 : 0;
  breakdown.push({
    factor: "Career interview",
    description: data.baselineInterviewCompleted
      ? `Completed · answer depth: ${qualityLabel} (${Math.round(q * 100)}%)`
      : "AI baseline interview completed",
    earned: interviewPts,
    max: 30,
    tip: data.baselineInterviewCompleted
      ? (q < 0.6 ? "Redo the interview with more detailed answers to boost your score" : undefined)
      : "Complete the 10-minute AI career interview to unlock this",
  });

  if (!data.baselineInterviewCompleted) {
    return { score: 0, breakdown };
  }

  // Skill breadth: resume-derived → no quality penalty (2 pts/skill, max 20)
  const skillCount = (data.skills ?? []).length;
  const skillPts = Math.min(20, skillCount * 2);
  breakdown.push({
    factor: "Skills breadth",
    description: `${skillCount} skill${skillCount !== 1 ? "s" : ""} identified`,
    earned: skillPts,
    max: 20,
    tip: skillCount < 10 ? `Add more skills — each skill worth 2 pts (up to 10 skills)` : undefined,
  });

  // Experience depth: resume-derived → no quality penalty (0.5 pts/year, max 10)
  const yoe = data.yearsExperience ?? 0;
  const yoePts = Math.min(10, Math.round(yoe * 0.5));
  breakdown.push({
    factor: "Experience depth",
    description: `${yoe} year${yoe !== 1 ? "s" : ""} of experience`,
    earned: yoePts,
    max: 10,
    tip: yoePts < 10 ? "Experience depth grows automatically as your career progresses" : undefined,
  });

  // Career clarity — quality-weighted
  const goal3Pts = data.careerGoal3yr ? Math.round(8 * q) : 0;
  breakdown.push({
    factor: "3-year career goal",
    description: data.careerGoal3yr ? "Set" : "Not yet captured",
    earned: goal3Pts,
    max: 8,
    tip: !data.careerGoal3yr
      ? "Redo the career interview and tell us where you want to be in 3 years"
      : (q < 0.6 ? "Give more detailed answers to earn full points" : undefined),
  });

  const goal5Pts = data.careerGoal5yr ? Math.round(4 * q) : 0;
  breakdown.push({
    factor: "5-year career vision",
    description: data.careerGoal5yr ? "Set" : "Not yet captured",
    earned: goal5Pts,
    max: 4,
    tip: !data.careerGoal5yr ? "Redo the career interview — you'll be asked about your 5-year vision" : undefined,
  });

  const rolesPts = (data.preferredRoles ?? []).length > 0 ? Math.round(5 * q) : 0;
  breakdown.push({
    factor: "Target roles",
    description: (data.preferredRoles ?? []).length > 0
      ? `${(data.preferredRoles ?? []).length} preferred role${(data.preferredRoles ?? []).length !== 1 ? "s" : ""} identified`
      : "Not yet captured",
    earned: rolesPts,
    max: 5,
    tip: rolesPts === 0 ? "Redo the interview and mention specific roles you're aiming for" : undefined,
  });

  // Self-awareness — quality-weighted
  const strengthCount = (data.strengthAreas ?? []).length;
  const strengthPts = Math.round(Math.min(10, strengthCount * 2) * q);
  breakdown.push({
    factor: "Strengths identified",
    description: `${strengthCount} strength area${strengthCount !== 1 ? "s" : ""} found`,
    earned: strengthPts,
    max: 10,
    tip: strengthCount < 5 || q < 0.6 ? "Share detailed answers about your experience — AI identifies strengths from specifics" : undefined,
  });

  // Growth awareness — quality-weighted
  const growthCount = (data.growthAreas ?? []).length;
  const growthPts = Math.round(Math.min(6, growthCount * 2) * q);
  breakdown.push({
    factor: "Growth areas mapped",
    description: `${growthCount} skill gap${growthCount !== 1 ? "s" : ""} identified`,
    earned: growthPts,
    max: 6,
    tip: growthCount < 3 || q < 0.6 ? "Mention your target roles clearly — AI maps gaps from your answers" : undefined,
  });

  // AI-generated career paths — quality-weighted
  const pathsPts = (data.careerPaths ?? []).length > 0 ? Math.round(4 * q) : 0;
  breakdown.push({
    factor: "Career paths generated",
    description: (data.careerPaths ?? []).length > 0
      ? `${(data.careerPaths ?? []).length} AI-generated path${(data.careerPaths ?? []).length !== 1 ? "s" : ""}`
      : "Not yet generated",
    earned: pathsPts,
    max: 4,
    tip: pathsPts === 0 ? "Complete your interview to trigger career path generation" : undefined,
  });

  const summaryPts = data.aiSummary ? Math.round(3 * q) : 0;
  breakdown.push({
    factor: "AI career summary",
    description: data.aiSummary ? "Generated" : "Not yet generated",
    earned: summaryPts,
    max: 3,
    tip: summaryPts === 0 ? "Complete your interview to generate your AI career summary" : undefined,
  });

  const score = Math.min(100, Math.round(
    interviewPts + skillPts + yoePts + goal3Pts + goal5Pts +
    rolesPts + strengthPts + growthPts + pathsPts + summaryPts
  ));

  return { score, breakdown };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
/**
 * Resolve the candidate's underlying `candidates.id` from the request.
 *
 * Returns `null` if the request is not authenticated or the caller is not a
 * candidate. Every /portal/* route MUST treat null as 401 — no fallback to a
 * demo candidate is permitted in any environment, since /portal handlers
 * mutate user-specific PII.
 *
 * Resolution model (post-2026-05-16 hardening):
 *   1. HMAC-verify the bearer token via getAuthUserId() — returns the userId
 *      the token claims to be (lib/auth-token.ts).
 *   2. Load the users row and REQUIRE role === "candidate". Recruiter, admin,
 *      and platform_admin sessions cannot read or write candidate PII via
 *      /portal/*, even if their account email happens to match a candidate's.
 *   3. Look up the candidate row via candidates.user_id (FK, see migration
 *      0012). No email join, no fallback to userId. If no candidate row owns
 *      this user, return null — better a 401 than the wrong candidate's data.
 *
 * Previous behaviour joined candidates.email = users.email which let any
 * user (recruiter, admin) whose email happened to match a candidate's read
 * and overwrite that candidate's profile, demographics, and self-ID. That
 * shadowing vector is closed here.
 */
async function getCandidateId(req: any): Promise<string | null> {
  // Delegates to the single shared resolver. Kept as a thin wrapper so the
  // ~80 existing call sites in this file don't need to change.
  return resolveCandidateId(req);
}

function computeCompleteness(profile: any): number {
  const fields = [
    profile.current_title, profile.current_company, profile.years_experience,
    profile.career_goal_3yr, profile.career_goal_5yr,
    (profile.target_companies as string[])?.length > 0,
    (profile.target_industries as string[])?.length > 0,
    (profile.preferred_roles as string[])?.length > 0,
    profile.preferred_work_style, profile.bio,
    profile.baseline_interview_completed,
    (profile.career_paths as any[])?.length > 0,
  ];
  const filled = fields.filter(Boolean).length;
  return Math.round((filled / fields.length) * 100);
}

/* ── GET /api/portal/candidate/me — basic account info ─────────────────── */
router.get("/portal/candidate/me", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
    const [c] = await db.select({
      id: candidatesTable.id,
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
      email: candidatesTable.email,
      phone: candidatesTable.phone,
      location: candidatesTable.location,
      linkedinUrl: candidatesTable.linkedinUrl,
      githubUrl: candidatesTable.githubUrl,
      currentTitle: candidatesTable.currentTitle,
      currentCompany: candidatesTable.currentCompany,
      createdAt: candidatesTable.createdAt,
    }).from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!c) return res.status(404).json({ error: "Candidate not found" });
    return res.json({ data: c });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch candidate");
    return res.status(500).json({ error: "Failed to fetch candidate" });
  }
});

/* ── PATCH /api/portal/candidate/me — update basic account info ─────────── */
router.patch("/portal/candidate/me", validate({ body: CandidateMeUpdateBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
    const { firstName, lastName, phone, location, linkedinUrl, githubUrl } = req.body;
    const updateData: any = { updatedAt: new Date() };
    if (firstName  !== undefined) updateData.firstName  = firstName;
    if (lastName   !== undefined) updateData.lastName   = lastName;
    if (phone      !== undefined) updateData.phone      = phone;
    if (location   !== undefined) updateData.location   = location;
    if (linkedinUrl !== undefined) updateData.linkedinUrl = linkedinUrl;
    if (githubUrl  !== undefined) updateData.githubUrl  = githubUrl;
    const [updated] = await db.update(candidatesTable).set(updateData)
      .where(eq(candidatesTable.id, candidateId)).returning();
    return res.json({ data: updated });
  } catch (err: any) {
    logger.error({ err }, "Failed to update candidate");
    return res.status(500).json({ error: "Failed to update candidate" });
  }
});

/* ── GET /api/portal/career-profile ─────────────────────────────────────── */
router.get("/portal/career-profile", async (req: any, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const [profile, candidate] = await Promise.all([
      db.select().from(candidateCareerProfilesTable)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
        .limit(1),
      db.select({ resumeUrl: candidatesTable.resumeUrl })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, candidateId))
        .limit(1),
    ]);

    if (profile.length === 0) {
      const resumeUrl = candidate[0]?.resumeUrl ?? null;
      return res.json({ data: resumeUrl ? { resumeUrl } : null });
    }

    return res.json({ data: { ...profile[0], resumeUrl: candidate[0]?.resumeUrl ?? null } });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch career profile");
    return res.status(500).json({ error: "Failed to fetch career profile" });
  }
});

/* ── POST /api/portal/prep/questions — AI-personalised question generation ── */
router.post("/portal/prep/questions", validate({ body: PrepQuestionsBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { mode, modeLabel, categories, count = 8 } = req.body as {
      mode: string;
      modeLabel: string;
      categories: string[];
      count?: number;
    };

    // Fetch full profile including parsed resume data
    const [profileRows, candidateRows] = await Promise.all([
      db.select().from(candidateCareerProfilesTable)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
        .limit(1),
      db.select({ resumeUrl: candidatesTable.resumeUrl })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, candidateId))
        .limit(1),
    ]);

    const profile: any = profileRows[0] ?? {};
    const resumeParsed: any = profile.resumeParsedProfile ?? {};

    // Build a rich profile context string for the prompt
    const ctx: string[] = [];
    const role = profile.currentTitle ?? resumeParsed.current_role ?? null;
    if (role)                                   ctx.push(`Current Role: ${role}`);
    if (profile.currentCompany)                 ctx.push(`Company: ${profile.currentCompany}`);
    if (profile.yearsExperience != null)        ctx.push(`Years of Experience: ${profile.yearsExperience}`);

    const skills = [
      ...(profile.skills ?? []),
      ...(resumeParsed.core_skills ?? []),
    ].filter(Boolean);
    const uniqueSkills = [...new Set(skills)].slice(0, 12);
    if (uniqueSkills.length)                    ctx.push(`Key Skills: ${uniqueSkills.join(", ")}`);

    if (resumeParsed.career_summary)            ctx.push(`Professional Summary: ${resumeParsed.career_summary}`);
    if (profile.bio)                            ctx.push(`Bio: ${profile.bio}`);
    if (profile.careerGoal3yr)                  ctx.push(`3-Year Goal: ${profile.careerGoal3yr}`);
    if (profile.careerGoal5yr)                  ctx.push(`5-Year Goal: ${profile.careerGoal5yr}`);

    const industries = (profile.targetIndustries ?? []).slice(0, 4);
    if (industries.length)                      ctx.push(`Target Industries: ${industries.join(", ")}`);

    const preferredRoles = (profile.preferredRoles ?? []).slice(0, 3);
    if (preferredRoles.length)                  ctx.push(`Preferred Roles: ${preferredRoles.join(", ")}`);

    const strengths = (profile.strengthAreas ?? []).slice(0, 4);
    if (strengths.length)                       ctx.push(`Strength Areas: ${strengths.join(", ")}`);

    const growthAreas = (profile.growthAreas ?? []).slice(0, 4);
    if (growthAreas.length)                     ctx.push(`Growth Areas: ${growthAreas.join(", ")}`);

    // Map mode categories to a human-readable focus description
    const focusMap: Record<string, string> = {
      behavioral:          "behavioural STAR-method questions about the candidate's real experiences",
      leadership:          "leadership, team management, and strategic decision-making questions",
      technical_coding:    "technical coding, system design, and engineering problem-solving questions",
      technical_management:"IT strategy, technology leadership, and systems management questions",
      ai_strategy:         "AI strategy, adoption, governance, and innovation questions",
      entrepreneurship:    "entrepreneurship, startup thinking, validation, and venture questions",
      hr_people:           "talent acquisition, people management, culture, and HR strategy questions",
    };
    const focusList = categories.map(c => focusMap[c] ?? c).join(" and ");

    const hasProfile = ctx.length >= 2;
    const profileBlock = hasProfile
      ? `\nCANDIDATE PROFILE:\n${ctx.join("\n")}\n`
      : "\n(No detailed profile available — generate high-quality general questions for this mode.)\n";

    // Derive a hard constraint block so the model cannot drift into the wrong question type
    const isBehavioralOnly = categories.length > 0 && categories.every(c => c === "behavioral");
    const isTechnicalOnly  = categories.length > 0 && categories.every(c => c === "technical_coding" || c === "technical_management");
    const modeConstraint = isBehavioralOnly
      ? `\nCRITICAL MODE CONSTRAINT — BEHAVIORAL ONLY:
- Every question MUST be a situational/behavioural question using the STAR method (Situation, Task, Action, Result).
- Do NOT ask about algorithms, system design, coding, debugging, architecture, or any technical problem-solving.
- Even when the candidate has a technical background, frame ALL questions around their past experiences, decisions, leadership, collaboration, and outcomes — NOT technical knowledge.
- Wrong example: "How would you design a scalable system?" — this is technical, forbidden.
- Right example: "Tell me about a time you had to make a difficult decision under pressure." — this is behavioural, correct.\n`
      : isTechnicalOnly
      ? `\nCRITICAL MODE CONSTRAINT — TECHNICAL ONLY:
- Every question MUST be technical in nature: coding, system design, architecture, debugging, or domain-specific problem-solving.
- Do NOT ask purely behavioural "tell me about a time" questions.\n`
      : "";

    // Category label to use in the JSON output (mode-specific, not a generic list)
    const categoryLabel = isBehavioralOnly ? "Behavioral"
      : isTechnicalOnly ? "Technical"
      : modeLabel;

    const systemPrompt = `You are an expert career coach and senior interview preparation specialist.
Generate exactly ${count} interview preparation questions for a "${modeLabel}" practice session.
Focus on: ${focusList}.
${modeConstraint}${profileBlock}
REQUIREMENTS:
- Each question must be directly relevant to the candidate's specific role, industry, experience level, and skills wherever the profile provides enough detail.
- Reference their actual background naturally in the question where appropriate (e.g. "Given your background in [skill/industry]..." or "As a [role] with [X] years experience...").
- If the profile is sparse, generate expert-level general questions appropriate for the mode.
- Model answers must use STAR methodology for behavioural questions, or structured frameworks for strategic/technical ones.
- Tips must be concrete, actionable, and specific — not generic advice like "be confident".
- Vary the difficulty and angle across the ${count} questions so the session feels like a real interview progression.
- Return a JSON object with a single key "questions" containing an array of exactly ${count} objects.

JSON format:
{
  "questions": [
    {
      "q": "The interview question",
      "a": "Model answer guidance using STAR or relevant framework",
      "tips": ["Tip 1", "Tip 2", "Tip 3", "Tip 4"],
      "category": "${categoryLabel}"
    }
  ]
}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: systemPrompt }],
      temperature: 0.8,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let questions: any[] = [];

    try {
      const parsed = JSON.parse(raw);
      // Handle both {"questions": [...]} and direct array wrapped in an object key
      if (Array.isArray(parsed)) {
        questions = parsed;
      } else {
        const firstArrayKey = Object.keys(parsed).find(k => Array.isArray(parsed[k]));
        questions = firstArrayKey ? parsed[firstArrayKey] : [];
      }
    } catch {
      logger.error({ raw }, "Failed to parse AI question response");
      return res.status(500).json({ error: "Failed to parse AI response" });
    }

    // Validate and sanitize
    const valid = questions
      .filter(q => q && typeof q.q === "string" && typeof q.a === "string")
      .map(q => ({
        q: q.q,
        a: q.a,
        tips: Array.isArray(q.tips) ? q.tips.slice(0, 4) : [],
        category: q.category ?? modeLabel,
        personalized: true,
      }));

    if (valid.length === 0) {
      return res.status(500).json({ error: "No valid questions generated" });
    }

    return res.json({ questions: valid, personalized: hasProfile });
  } catch (err: any) {
    logger.error({ err }, "Failed to generate prep questions");
    return res.status(500).json({ error: "Failed to generate questions" });
  }
});

/* ── PUT /api/portal/career-profile ─────────────────────────────────────── */
router.put("/portal/career-profile", validate({ body: CareerProfileUpdateBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const {
      currentTitle, currentCompany, yearsExperience, currentSalaryRange,
      skills, education, location, bio,
      careerGoal3yr, careerGoal5yr, targetCompanies, targetIndustries,
      preferredRoles, desiredSalaryRange, preferredWorkStyle, preferredTeamSize, motivations,
    } = req.body;

    const existing = await db
      .select({
        id:             candidateCareerProfilesTable.id,
        currentTitle:   candidateCareerProfilesTable.currentTitle,
        currentCompany: candidateCareerProfilesTable.currentCompany,
      })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    const updateData: any = {
      updatedAt: new Date(),
    };
    if (currentTitle !== undefined)        updateData.currentTitle = currentTitle;
    if (currentCompany !== undefined)      updateData.currentCompany = currentCompany;
    if (yearsExperience !== undefined)     updateData.yearsExperience = yearsExperience;
    if (currentSalaryRange !== undefined)  updateData.currentSalaryRange = currentSalaryRange;
    if (skills !== undefined)              updateData.skills = skills;
    if (education !== undefined)           updateData.education = education;
    if (location !== undefined)            updateData.location = location;
    if (bio !== undefined)                 updateData.bio = bio;
    if (careerGoal3yr !== undefined)       updateData.careerGoal3yr = careerGoal3yr;
    if (careerGoal5yr !== undefined)       updateData.careerGoal5yr = careerGoal5yr;
    if (targetCompanies !== undefined)     updateData.targetCompanies = targetCompanies;
    if (targetIndustries !== undefined)    updateData.targetIndustries = targetIndustries;
    if (preferredRoles !== undefined)      updateData.preferredRoles = preferredRoles;
    if (desiredSalaryRange !== undefined)  updateData.desiredSalaryRange = desiredSalaryRange;
    if (preferredWorkStyle !== undefined)  updateData.preferredWorkStyle = preferredWorkStyle;
    if (preferredTeamSize !== undefined)   updateData.preferredTeamSize = preferredTeamSize;
    if (motivations !== undefined)         updateData.motivations = motivations;

    let profile;
    if (existing.length > 0) {
      const result = await db
        .update(candidateCareerProfilesTable)
        .set(updateData)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
        .returning();
      profile = result[0];
    } else {
      const result = await db
        .insert(candidateCareerProfilesTable)
        .values({ candidateId, ...updateData })
        .returning();
      profile = result[0];
    }

    const completeness = computeCompleteness(profile);
    await db
      .update(candidateCareerProfilesTable)
      .set({ profileCompleteness: completeness })
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId));

    /* Self-reported job change: compare what the candidate just submitted
     * against the stored prior values (career profile row read above; the
     * helper falls back to the canonical candidates row for first-time saves).
     * Fire-and-forget — the save response never waits on email delivery, and
     * DNC / pause-discovery / erasure quiet gates live inside the helper. */
    if (currentTitle !== undefined || currentCompany !== undefined) {
      void processSelfReportedJobChange({
        candidateId,
        prevTitle:   existing[0]?.currentTitle,
        prevCompany: existing[0]?.currentCompany,
        newTitle:    currentTitle,
        newCompany:  currentCompany,
      }).catch(err =>
        logger.warn({ err: err?.message, candidateId }, "self-report job-change processing failed"),
      );
    }

    return res.json({ data: { ...profile, profileCompleteness: completeness } });
  } catch (err: any) {
    logger.error({ err }, "Failed to update career profile");
    return res.status(500).json({ error: "Failed to update career profile" });
  }
});

/* ── Advisor persona definitions ─────────────────────────────────────────── */
const ADVISOR_PERSONAS: Record<string, { name: string; voice: string; style: string; wrapUpOffer: string; wrapUpOfferNoUpload: string; extendedOffer: string; extendedOfferNoUpload: string }> = {
  lexy: {
    name: "Lexy",
    voice: "nova",
    style: "You are Lexy — a warm, empathetic, and encouraging career advisor. You make people feel genuinely heard and excited about their future. Your tone is conversational, uplifting, and human.",
    wrapUpOffer: "I think I have a really solid picture of you now. Would you like to share anything else, or shall I go ahead and build your personalised career analysis? After that, I'll ask you to upload your resume — it takes 30 seconds and helps us surface even better matches for you.",
    wrapUpOfferNoUpload: "I think I have a really solid picture of you now. Would you like to share anything else, or shall I go ahead and build your personalised career analysis?",
    extendedOffer: "Is there anything else on your mind, or are you ready for your career analysis? (We'll ask you to upload your resume right after — don't worry, it's quick!)",
    extendedOfferNoUpload: "Is there anything else on your mind, or are you ready for your career analysis?",
  },
  jordan: {
    name: "Jordan",
    voice: "onyx",
    style: "You are Jordan — a strategic, analytical career advisor. You ask precise, insightful questions and help candidates think rigorously about their career trajectory. Your tone is direct, clear, and professionally motivating.",
    wrapUpOffer: "I have a clear strategic picture of where you are and where you want to go. Would you like to add anything else, or shall I build your career analysis now? One final step after that — we'll ask you to upload your resume so we can cross-reference your experience for sharper role matches.",
    wrapUpOfferNoUpload: "I have a clear strategic picture of where you are and where you want to go. Would you like to add anything else, or shall I build your career analysis now?",
    extendedOffer: "Anything else you want on the record before I run your analysis? (Resume upload comes right after — takes under a minute.)",
    extendedOfferNoUpload: "Anything else you want on the record before I run your analysis?",
  },
  morgan: {
    name: "Morgan",
    voice: "shimmer",
    style: "You are Morgan — a creative, inspiring career advisor who helps candidates see their biggest possibilities and think boldly. You find unexpected connections between their skills and their dreams. Your tone is enthusiastic, imaginative, and forward-thinking.",
    wrapUpOffer: "What a conversation — I can already see some exciting paths for you! Want to keep exploring, or shall I go ahead and map out your career possibilities? After that, we'll ask you to drop in your resume — it only takes a moment and helps unlock even more accurate matches.",
    wrapUpOfferNoUpload: "What a conversation — I can already see some exciting paths for you! Want to keep exploring, or shall I go ahead and map out your career possibilities?",
    extendedOffer: "Anything else sparking for you, or shall we turn all of this into your personalised career map? (Quick resume upload comes right after — it supercharges everything!)",
    extendedOfferNoUpload: "Anything else sparking for you, or shall we turn all of this into your personalised career map?",
  },
};

/* Language display names (subset of full LANGUAGE_MAP) */
const LANGUAGE_NAMES: Record<string, string> = {
  "en-US": "English (US)", "en-GB": "English (UK)", "en-AU": "English (AU)",
  "en-IN": "English (IN)", "en-CA": "English (CA)",
  "es-ES": "Spanish (Spain)", "es-MX": "Spanish (Mexico)", "es-US": "Spanish (US)",
  fr: "French", de: "German", it: "Italian", pt: "Portuguese",
  nl: "Dutch", ru: "Russian", tr: "Turkish",
  zh: "Chinese", ja: "Japanese", ko: "Korean", ar: "Arabic",
  hi: "Hindi", bn: "Bengali", ta: "Tamil", te: "Telugu",
  mr: "Marathi", gu: "Gujarati", pa: "Punjabi",
};

/* ── POST /api/portal/career-interview/message ───────────────────────────── */
router.post("/portal/career-interview/message", validate({ body: CareerInterviewMessageBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { message, history = [], language = "en-US", persona = "lexy", resumeProfile = null, hasResumeUrl = false } = req.body as {
      message: string;
      history: Array<{ role: "user" | "assistant"; content: string }>;
      language?: string;
      persona?: string;
      resumeProfile?: Record<string, any> | null;
      hasResumeUrl?: boolean;
    };

    if (!message?.trim()) return res.status(400).json({ error: "message is required" });

    const advisor = ADVISOR_PERSONAS[persona] ?? ADVISOR_PERSONAS.lexy;
    const languageName = LANGUAGE_NAMES[language] ?? "English (US)";
    const isNonEnglish = !language.startsWith("en");
    const hasResume = !!resumeProfile && typeof resumeProfile === "object";
    /* candidateHasResume is true if they have a parsed profile OR just a resume URL saved */
    const candidateHasResume = hasResume || !!hasResumeUrl;

    /* ── Build resume context snippet for prompts ── */
    const buildResumeContext = () => {
      if (!hasResume) return "";
      const r = resumeProfile!;
      const parts: string[] = ["CANDIDATE RESUME CONTEXT (self-reported — use for tailoring, validate during interview):"];
      if (r.name) parts.push(`Name: ${r.name}`);
      if (r.likely_role) parts.push(`Current/Recent Role: ${r.likely_role}`);
      if (r.seniority_level) parts.push(`Seniority: ${r.seniority_level}`);
      if (r.total_years_experience) parts.push(`Years of Experience: ~${r.total_years_experience} years`);
      if (r.current_company) parts.push(`Current Company: ${r.current_company}`);
      if (r.industries?.length) parts.push(`Industries: ${r.industries.join(", ")}`);
      if (r.core_skills?.length) parts.push(`Core Skills: ${r.core_skills.join(", ")}`);
      if (r.tools?.length) parts.push(`Tools/Frameworks: ${r.tools.join(", ")}`);
      if (r.education) parts.push(`Education: ${r.education}`);
      if (r.certifications?.length) parts.push(`Certifications: ${r.certifications.join(", ")}`);
      if (r.career_summary) parts.push(`Summary: ${r.career_summary}`);
      return parts.join("\n");
    };

    /* ── Opening greeting (called once before the first user message) ── */
    if (message === "__start__") {
      /* Illinois AIVI Act / BIPA / EU AI Act consent gate — mirror of the
         /interviews/:id/begin gate. The career (self) interview also records
         video and collects biometric proctoring signals, so it must not start
         until the candidate has an active consent for the current version.
         Returns 412 so the candidate UI routes to /portal/interview-consent. */
      const aiConsent = await import("../lib/ai-consent.js");
      if (!(await aiConsent.hasActiveAiConsent(candidateId))) {
        return res.status(412).json({
          error: "AI_CONSENT_REQUIRED",
          message: "Candidate has not consented to the current AI interview + biometric disclosure.",
          consentVersion: aiConsent.CURRENT_AI_CONSENT_VERSION,
        });
      }
      let greetingPrompt: string;
      if (hasResume) {
        const resumeCtx = buildResumeContext();
        greetingPrompt = isNonEnglish
          ? `You are Lexy, a warm and friendly AI career advisor. The candidate has uploaded their resume. Write a short, personalised opening greeting in ${languageName} ONLY.
${resumeCtx}
The greeting should:
- Introduce yourself as Lexy
- Reference 1-2 specific things from their background (role, company, or a key skill) to show you've read their resume
- Let them know you'll skip the basic questions since you have their background
- Mention this interview will take about 15 minutes and that you'll give them a heads-up about a minute before time is up
- Ask one targeted question that goes deeper — e.g. validate a specific skill or ask about their most meaningful project
Keep it warm, 3-4 sentences. Write ENTIRELY in ${languageName}.`
          : `You are Lexy, a warm and friendly AI career advisor. The candidate has uploaded their resume — you already know their background. Write a short, personalised opening greeting.
${resumeCtx}
The greeting should:
- Briefly introduce yourself as Lexy
- Reference 1-2 specific details from their resume (their role, company, or a standout skill) to show you've read it
- Tell them you'll skip basic background questions since you already have the essentials
- Mention this interview will take about 15 minutes and that you'll give them a heads-up about a minute before time is up
- Ask a deep, specific validation question — e.g. "I see you've worked with [skill]. What kind of systems/projects did you build with it?" or "You've been at [company] — what's the most complex problem you solved there?"
Keep it warm and specific, 3-5 sentences.`;
      } else {
        greetingPrompt = isNonEnglish
          ? `You are Lexy, a warm and friendly AI career advisor. Write a short opening greeting in ${languageName} ONLY (no English at all) to start a career interview. The greeting should:
- Introduce yourself as Lexy, their personal career advisor
- Mention this interview will take about 15 minutes and that you'll give them a heads-up about a minute before time is up
- Say you're here to build their personalised career profile and map out exciting paths for them
- End by asking: what is their current role and company?
Keep it to 3-4 short sentences. Write ENTIRELY in ${languageName}.`
          : `You are Lexy, a warm and friendly AI career advisor. Write a short, natural opening greeting to start a career interview. Introduce yourself, mention the interview will take about 15 minutes and that you'll give them a heads-up about a minute before time is up, briefly mention you'll build their personalised career profile, and ask what their current role and company is. 3-4 sentences, warm and conversational.`;
      }

      const greeting = await chatCompletionWithAI(
        [{ role: "user", content: greetingPrompt }],
        language,
        { maxTokens: 200, temperature: 0.7 },
      ) || (hasResume
        ? "Hi! I'm Lexy, your AI career advisor. I've had a look at your resume — great background! This interview will take about 15 minutes, and I'll give you a heads-up about a minute before we wrap up. I'll skip the basic questions since I already have the essentials. Let me ask something more specific — what's the most impactful project you've worked on recently?"
        : "Hi! I'm Lexy, your personal career advisor. This interview will take about 15 minutes, and I'll give you a heads-up about a minute before we wrap up. I'm here to build your personalised career profile and map out some exciting paths for you.\n\nLet's start simple — what's your current role and company?");
      return res.json({ reply: greeting, history: [], isComplete: false, voice: advisor.voice });
    }

    // Both resume and non-resume get 10 questions (9 career topics + 1 work-eligibility
    // logistics question asked last). With a resume, the questions skip basic background
    // and focus on depth-validation — same quantity, richer quality.
    const BASE_QUESTIONS = 10;
    const userMsgsSoFar = history.filter((m: any) => m.role === "user").length;
    const thisIsQuestion = userMsgsSoFar + 2;

    // ── Interview phase flags ──────────────────────────────────────────────
    // turns 1-7   → Q2 through Q8 (normal questions)
    // turn  8     → isLastQuestion: ask Q9 (motivations), NO wrap-up offer yet
    // turn  9     → isWrapUp: Q9 answered → thank & offer the choice
    // turn  10+   → isExtended: user chose to share more — ask a follow-up & re-offer
    // isComplete  → fires only when user explicitly says "yes/ready/go ahead"
    //               OR after 3 extended turns (safety cap)
    const isLastQuestion = thisIsQuestion === BASE_QUESTIONS;         // ask final topic Q
    const isWrapUp       = thisIsQuestion === BASE_QUESTIONS + 1;    // offer wrap-up choice
    const isExtended     = thisIsQuestion >  BASE_QUESTIONS + 1;     // user continued sharing

    /**
     * Detect whether the candidate's most recent message signals they want to
     * finish and generate their career analysis, or whether they want to keep talking.
     *
     * "more" always wins — if they say "yes, I do have more to share" the "more"
     * signals override the "yes".  "unclear" means continue the conversation.
     */
    function detectUserIntent(msg: string): "finish" | "more" | "unclear" {
      const m = msg.toLowerCase();
      const moreSignals = [
        /* English */
        "more to share", "more to add", "want to add", "have more", "something more",
        "bit more", "few more", "one more", "not yet", "not ready", "before that",
        "actually", "also wanted", "forgot to mention", "i wanted to",
        /* Spanish */
        "tengo más", "quiero agregar", "hay algo más", "todavía no", "aún no",
        "también quería", "olvidé mencionar", "quería añadir",
        /* French */ "j'ai encore", "j'aimerais ajouter", "pas encore",
        /* Portuguese */ "tenho mais", "quero adicionar", "ainda não",
        /* Hindi */ "और है", "कुछ और",
      ];
      if (moreSignals.some(s => m.includes(s))) return "more";

      const finishSignals = [
        /* English */
        "go ahead", "yes, go", "yeah, go", "sure, go", "ready", "let's go", "lets go",
        "generate", "build my career", "build my profile", "proceed", "yes please",
        "yes do it", "nothing else", "nothing more", "that's all", "thats all",
        "nothing to add", "done sharing", "i'm done", "i am done", "that's everything",
        "thats everything", "all done", "let's proceed", "lets proceed", "sounds good",
        "go for it", "yes, sure", "yes, that", "please go ahead",
        "thank you", "thanks", "thank you so much", "thanks a lot", "thank you lexy",
        "perfect", "great", "awesome", "ok great", "okay great", "ok thanks",
        /* Spanish */
        "adelante", "sí, adelante", "sí por favor", "si, adelante", "si por favor",
        "de acuerdo", "listo", "lista", "ya está", "ya esta", "nada más", "nada mas",
        "eso es todo", "estoy listo", "estoy lista", "puede generar", "genera mi",
        "sí, generar", "sí, procede", "si, procede", "muchas gracias", "gracias lexy",
        "perfecto", "genial", "excelente", "muy bien", "está bien", "esta bien",
        "sí, eso es todo", "si, eso es todo", "sí, gracias", "si, gracias",
        /* French */
        "allez-y", "oui, allez", "c'est bon", "d'accord", "merci", "parfait",
        "c'est tout", "je suis prêt", "je suis prete", "rien de plus", "oui merci",
        "oui, c'est", "c'est parfait", "très bien",
        /* Portuguese */
        "pode ir", "tudo bem", "pronto", "obrigado", "obrigada", "perfeito",
        "é isso", "nada mais", "estou pronto", "estou pronta", "sim, pode",
        "por favor, gere", "sim obrigado", "sim, obrigada",
        /* German */
        "bitte", "ja, bitte", "danke", "perfekt", "das ist alles", "ich bin bereit",
        "ja, danke", "in ordnung", "einverstanden", "gut, danke", "alles klar",
        /* Italian */
        "vai avanti", "sì, vai", "grazie", "perfetto", "va bene", "sono pronto",
        "sono pronta", "non ho altro", "è tutto", "sì, grazie",
        /* Dutch */
        "ga door", "ja, ga", "dank je", "dank u", "perfect", "goed",
        "ik ben klaar", "dat is alles", "ja, dank je", "prima",
        /* Russian */
        "давайте", "да, давайте", "спасибо", "отлично", "хорошо", "всё",
        "готово", "я готов", "я готова", "больше нечего добавить",
        /* Chinese */
        "好的", "谢谢", "好", "可以", "没有了", "就这样", "完了",
        "开始吧", "生成吧", "好了", "谢谢你", "太好了",
        /* Japanese */
        "はい", "ありがとう", "ありがとうございます", "いいです", "大丈夫",
        "お願いします", "進めてください", "もう大丈夫", "以上です",
        /* Korean */
        "네", "예", "감사합니다", "좋아요", "알겠습니다", "괜찮아요",
        "진행해주세요", "다 됐어요", "이상입니다",
        /* Arabic */
        "تفضل", "نعم", "شكراً", "شكرا", "حسناً", "حسنا", "موافق",
        "جاهز", "ليس لدي ما أضيفه", "هذا كل شيء", "اشكرك",
        /* Turkish */
        "evet", "teşekkürler", "teşekkür ederim", "tamam", "peki", "hazırım",
        "devam edin", "başka bir şey yok", "hepsi bu",
        /* Polish */
        "tak", "dziękuję", "świetnie", "dobrze", "w porządku", "proszę",
        "nie mam nic więcej", "to wszystko", "jestem gotowy", "jestem gotowa",
        /* Swedish */
        "ja", "tack", "perfekt", "bra", "okej", "jag är redo",
        "det är allt", "inget mer", "varsågod",
        /* Norwegian */
        "ja", "takk", "perfekt", "bra", "ok", "jeg er klar",
        "det er alt", "ikke noe mer",
        /* Danish */
        "ja", "tak", "perfekt", "godt", "ok", "jeg er klar",
        "det er alt", "ikke noget mere",
        /* Hindi */
        "ठीक है", "हाँ", "धन्यवाद", "तैयार हूँ", "बिल्कुल", "अच्छा",
        "हाँ, आगे बढ़ें", "बस इतना ही", "कुछ नहीं जोड़ना",
        /* Bengali */
        "হ্যাঁ", "ধন্যবাদ", "ঠিক আছে", "আমি প্রস্তুত", "এটাই সব",
        /* Tamil */
        "ஆம்", "நன்றி", "சரி", "நான் தயார்", "இதுதான் எல்லாம்",
        /* Telugu */
        "అవును", "ధన్యవాదాలు", "సరే", "నేను సిద్ధంగా ఉన్నాను",
        /* Marathi */
        "हो", "धन्यवाद", "ठीक आहे", "मी तयार आहे",
        /* Gujarati */
        "હા", "આભાર", "ઠીક છે", "હું તૈયાર છું",
        /* Kannada */
        "ಹೌದು", "ಧನ್ಯವಾದ", "ಸರಿ", "ನಾನು ತಯಾರಿದ್ದೇನೆ",
        /* Malayalam */
        "അതെ", "നന്ദി", "ശരി", "ഞാൻ തയ്യാറാണ്",
        /* Punjabi */
        "ਹਾਂ", "ਧੰਨਵਾਦ", "ਠੀਕ ਹੈ", "ਮੈਂ ਤਿਆਰ ਹਾਂ",
        /* Urdu */
        "ہاں", "شکریہ", "ٹھیک ہے", "میں تیار ہوں",
      ];
      if (finishSignals.some(s => m.includes(s))) return "finish";

      return "unclear";
    }

    // isComplete fires when:
    //  a) At the wrap-up turn, the user explicitly says they're ready → skip extended phase
    //  b) In extended mode, the user says they're ready OR they've had 3 extended turns (safety cap)
    const userIntent = (isWrapUp || isExtended) ? detectUserIntent(message) : "unclear";
    const extendedTurnCount = Math.max(0, thisIsQuestion - (BASE_QUESTIONS + 1));
    const forcedByCap = isExtended && extendedTurnCount >= 3;  // safety cap hit
    // Absolute hard cap — prevents interviews going on forever in any language.
    // If the candidate has sent 12+ messages without reaching a clean finish,
    // force-complete regardless of phase so the profile can be built.
    const absoluteCapFired = userMsgsSoFar >= 12;

    const isComplete =
      absoluteCapFired ||
      isWrapUp ||   // after last question is answered → close immediately, no choice offered
      (isExtended  && (userIntent === "finish" || forcedByCap));
    // hardComplete = true means the extended safety cap fired; the frontend should NOT
    // show "Add more details" again because every subsequent message would re-trigger the cap.
    const hardComplete = isComplete && (forcedByCap || absoluteCapFired);

    const resumeCtxBlock = hasResume ? `\n${buildResumeContext()}\n` : "";

    const antiHallucinationRule = `
CRITICAL ANTI-HALLUCINATION RULES — MUST FOLLOW:
- ONLY reference facts, companies, skills, and experiences the candidate explicitly stated in this conversation
- NEVER infer, assume, or invent information the candidate did not say
- NEVER put words in the candidate's mouth or answer on their behalf
- If something is unclear or not yet mentioned, ASK — do not assume
- If you acknowledge their answer, only reflect back what they actually said

CRITICAL ANTI-BIAS RULES — MUST FOLLOW:
- Treat every candidate identically regardless of name, gender, nationality, religion, age, accent, educational institution prestige, or any other protected characteristic
- NEVER let a candidate's name, alma mater, or location influence the difficulty or framing of your questions
- Ask the same depth and type of questions regardless of who the candidate appears to be
- Do NOT make assumptions about a candidate's background, capabilities, or career trajectory based on demographics
- Judge only on skills, experience, and stated goals — nothing else`;

    const systemPrompt = hasResume
      ? `${advisor.style}
You are conducting a career interview. The candidate has uploaded their resume — you already know their background.
${isNonEnglish ? `\nCRITICAL: Conduct this ENTIRE interview in ${languageName}. Every single response must be written in ${languageName} — no English at all.\n` : ""}
${resumeCtxBlock}
${antiHallucinationRule}

INTERVIEW RULES WITH RESUME:
- DO NOT ask basic questions like "tell me about yourself", "what skills do you have", or "walk me through your resume" — you already have this from the resume
- DO NOT ask about current role, company, education, or years of experience — already known from resume
- INSTEAD, focus every question on VALIDATING and GOING DEEPER on what the resume shows
- Ask questions like: "I see you've worked with [skill] — what kind of [projects/systems/decisions] did you own?" or "You seem to have [experience type] — what's your proudest achievement there?"
- Resume data is self-reported — your job is to validate it through concrete examples and stories

Focus your questions on these high-value areas:
- Depth validation: "Your resume shows X — tell me about a specific time you used that at scale / in a hard situation"
- Decision-making: What did they own? What tradeoffs did they make?
- Leadership & impact: Did they lead people, products, or outcomes?
- Problem solving: Most complex problem they've tackled
- Career direction — REQUIRED: You MUST ask these in some form during the interview:
  • 3-year target: "Where do you see yourself in 3 years — what outcome or role are you aiming for?"
  • 5-year vision: "And looking further ahead — what does your 5-year career vision look like? Dream role or impact?"
  These two questions are non-negotiable — the career analysis depends on them.
- Motivations: What drives them — growth, impact, money, mission?

RESPONSE LENGTH RULE:
- Acknowledge their previous answer in ONE short sentence only — never multi-sentence praise or coaching
- Do NOT give career advice, tips, or motivational speeches mid-interview
- Format: 1 acknowledgment sentence + 1 question = 2 sentences total per turn (except opening/closing)

ONE QUESTION RULE — THIS IS ABSOLUTE AND NON-NEGOTIABLE:
- You MUST ask exactly ONE question per response. Not two. Not three. ONE.
- Your entire response must contain exactly one question mark (?).
- If you find yourself wanting to ask more, save those topics for the next turn.
- This is a conversation, not a form. Let the candidate breathe between questions.

NO PREMATURE CLOSING — THIS IS MANDATORY:
- You are on question ${thisIsQuestion} of ${BASE_QUESTIONS}. You still have ${Math.max(0, BASE_QUESTIONS - thisIsQuestion + 1)} question(s) left to ask.
- Do NOT say goodbye, farewell, "take care", "best of luck", "I have everything I need", "that's all I need", "we're done", or ANY closing language until you receive the explicit wrap-up instruction below.
- Even if you feel you have enough information, you MUST continue asking questions until instructed to wrap up.
- Ending early is a failure — keep going.

${isLastQuestion ? `\nThis is the LAST question — work-eligibility logistics. Begin your response by warmly telling the candidate: "And this brings us to our final question — which concludes your career intake." Briefly acknowledge their previous answer in one sentence, then ask ONE combined logistics question covering both points: whether they're legally authorized to work in the country where they're seeking roles, and whether they'll now or in future need visa sponsorship to keep working there. Phrase it as a single sentence with one question mark. Ask ONLY about legal work authorization and sponsorship — NEVER nationality, origin, citizenship, or immigration history. Do NOT offer to generate their career analysis yet. Just ask and wait for their answer.` : ""}
${isExtended && !isComplete ? `\nThe candidate chose to share more. Ask one thoughtful follow-up based on something they mentioned. After they respond, offer the choice to generate their career analysis or continue sharing. Do NOT mention resume upload.` : ""}
${isComplete ? `\nThe interview is now complete. Thank the candidate sincerely and warmly for their time. Keep it to 1–2 sentences — something like "Thank you so much for your time today — it was a pleasure learning about your career journey." Do NOT ask any more questions. Do NOT mention building a career analysis or any next steps. Just a genuine, warm thank-you and sign-off.` : ""}`
      : `${advisor.style}
Your job is to conduct a conversational career baseline interview to understand a candidate's background and goals.
${isNonEnglish ? `\nCRITICAL: Conduct this ENTIRE interview in ${languageName}. Every single response must be written in ${languageName} — no English at all.\n` : ""}
${antiHallucinationRule}

IMPORTANT: The opening greeting already asked the candidate about their current role and company. Their answer is already in the conversation history. Do NOT ask about current role or company again — that topic is fully covered. Move straight to the next topic.

Follow this natural flow — but don't rush. Ask 1 question per message, listen to their answers, and adapt:

Phase 1 – Where they are today (questions 1–3):
- Q1 [ALREADY ANSWERED via greeting]: Current role and company ✓
- Q2: Key skills and what they're best at
- Q3: Education background and years of experience

Phase 2 – Where they want to go (questions 4–6):
- Q4: What they want to be doing in 3 years
- Q5: Their 5-year career vision / dream role
- Q6: Industries they're excited about

Phase 3 – Target companies & preferences (questions 7–8):
- Q7: 3–5 dream companies they'd love to work at
- Q8: Preferred work style (remote/hybrid/on-site) and team culture

Phase 4 – What drives them (question 9):
- Q9: Their core motivations (impact, learning, leadership, salary, etc.)

Phase 5 – Work eligibility logistics (question 10 — REQUIRED):
- Q10: Two quick, lawful yes/no logistics questions for the candidate's profile — (1) whether they are legally authorized to work in the country where they're seeking roles, and (2) whether they will now or in future need visa sponsorship to keep working there. Ask ONLY these two. NEVER ask about nationality, country of origin, citizenship status, immigration history, or any protected characteristic.

Rules:
- Acknowledge their answer in ONE short sentence only — do NOT write multi-sentence praise, encouragement, or reflections before asking the next question
- Your primary job is to ASK the next question — the acknowledgment is just a bridge, not a coaching session
- Do NOT give career tips, advice, or motivational speeches mid-interview — save that energy for asking great questions
- Do NOT generate a JSON summary yourself — just have a great conversation
- Keep responses tight: 1 acknowledgment sentence + 1 question = total of 2 sentences max per turn

ONE QUESTION RULE — THIS IS ABSOLUTE AND NON-NEGOTIABLE:
- You MUST ask exactly ONE question per response. Not two. Not three. ONE.
- Your entire response must contain exactly one question mark (?).
- If you find yourself wanting to ask more, save those topics for the next turn.
- This is a conversation, not a form. Let the candidate breathe between questions.

NO PREMATURE CLOSING — THIS IS MANDATORY:
- You are on question ${thisIsQuestion} of ${BASE_QUESTIONS}. You still have ${Math.max(0, BASE_QUESTIONS - thisIsQuestion + 1)} question(s) left to ask.
- Do NOT say goodbye, farewell, "take care", "best of luck", "I have everything I need", "that's all I need", "we're done", or ANY closing language until you receive the explicit wrap-up instruction below.
- Even if you feel you have enough information, you MUST continue asking the next topic question.
- Ending early is a failure — keep going.

You are now on question ${thisIsQuestion} — ask the topic for that question number above.
${isLastQuestion ? `\nThis is the LAST question (Q${BASE_QUESTIONS}: work-eligibility logistics). Begin your response by warmly telling the candidate (in ${languageName}) that this is the final question and it concludes their career intake. Briefly acknowledge their previous answer, then ask ONE combined logistics question covering both points: whether they're legally authorized to work in the country where they're seeking roles, and whether they'll now or in future need visa sponsorship to keep working there. Phrase it as a single sentence with one question mark (this logistics turn is the one place both points go together). Ask ONLY about legal work authorization and sponsorship — NEVER nationality, origin, citizenship, or immigration history. Do NOT offer to generate their career analysis. Just ask and wait for their answer.` : ""}
${isExtended && !isComplete ? `\nThe candidate chose to share more. Ask a thoughtful follow-up on something they mentioned. After their response, offer (in ${languageName} if needed): "${candidateHasResume ? advisor.extendedOfferNoUpload : advisor.extendedOffer}"` : ""}
${isComplete ? `\nThe interview is now complete. In ${languageName}, thank the candidate sincerely and warmly for their time. Keep it to 1–2 sentences — something like "Thank you so much for your time today — it was a pleasure learning about your career journey." Do NOT ask any more questions. Do NOT mention building a career analysis or any next steps. Just a genuine, warm thank-you and sign-off.` : ""}`;

    // ── API-level goodbye-loop guard ──────────────────────────────────────
    // If the interview is in extended mode and the last assistant message already
    // looks like a farewell (goodbye, take care, etc.), the candidate is responding
    // to a closing message. Don't generate another one — just return a no-op so the
    // frontend can handle it cleanly (frontend also gates this, this is belt+suspenders).
    if (isExtended) {
      const lastAI = [...history].reverse().find((m: any) => m.role === "assistant")?.content ?? "";
      const farewellMarkers = ["take care", "goodbye", "have a great", "all the best", "best of luck", "until next time", "reach out anytime", "have an amazing", "signing off", "bon courage", "bonne chance", "au revoir", "على خير", "وداعا", "مع السلامة"];
      const alreadyFarewelled = farewellMarkers.some(f => lastAI.toLowerCase().includes(f.toLowerCase()));
      if (alreadyFarewelled) {
        // Silently confirm completion — no new message generated
        logger.info({ jobId: "career-interview" }, "Goodbye-loop guard fired — skipping LLM call");
        return res.json({ reply: "", history: [...history, { role: "user", content: message }], isComplete: true, hardComplete: true, voice: advisor.voice });
      }
    }

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...history,
      { role: "user" as const, content: message },
    ];

    let reply = await chatCompletionWithAI(messages, language, { maxTokens: 300, temperature: 0.65 })
      || (candidateHasResume ? advisor.wrapUpOfferNoUpload : advisor.wrapUpOffer);

    // ── One-question enforcement ──────────────────────────────────────────
    // If the model still sneaked in a second question, truncate at the sentence
    // boundary just before the second '?' so only one question reaches the candidate.
    // We skip this during wrapUp/extended/complete phases where the offer sentence
    // itself is a question.
    // Matches ?, ？ (full-width, used in Chinese/Japanese/Korean), ؟ (Arabic)
    const Q_RE = /[?？؟]/g;

    if (!isWrapUp && !isExtended && !isComplete) {
      const qMarks = [...reply.matchAll(Q_RE)];
      if (qMarks.length > 1) {
        // Find the start of the sentence containing the second '?'
        const secondQPos = qMarks[1].index!;
        // Walk back to the nearest sentence-ending punctuation before secondQPos
        const beforeSecond = reply.slice(0, secondQPos);
        const lastStop = Math.max(
          beforeSecond.lastIndexOf(". "),
          beforeSecond.lastIndexOf("! "),
          beforeSecond.lastIndexOf("。"),
          beforeSecond.lastIndexOf(".\n"),
        );
        if (lastStop > 0) {
          reply = reply.slice(0, lastStop + 1).trim();
          logger.info({ jobId: "career-interview" }, "Trimmed double-question from AI reply");
        }
      }

      // ── Zero-question guard ───────────────────────────────────────────
      // In non-English interviews the model sometimes produces a warm acknowledgment
      // with NO question mark — congratulating the candidate without asking the next
      // question, which freezes the conversation.  Detect this and retry once with
      // a stricter prompt that forces a question.
      // NOTE: Q_RE covers ?, ？ (CJK full-width), ؟ (Arabic) so this works for all scripts.
      if (![...reply.matchAll(Q_RE)].length) {
        logger.info({ jobId: "career-interview", thisIsQuestion, language }, "Zero-question guard fired — retrying with forced question");
        const forceQuestionPrompt = `${systemPrompt}

URGENT CORRECTION: Your previous response contained NO question. That is a failure of the ONE QUESTION RULE. You MUST include exactly one question in your response. Write: one brief acknowledgment sentence + one direct question about the next topic. The response MUST end with a question mark (? or the equivalent in the interview language).`;
        const retryMessages = [
          { role: "system" as const, content: forceQuestionPrompt },
          ...history,
          { role: "user" as const, content: message },
        ];
        const retried = await chatCompletionWithAI(retryMessages, language, { maxTokens: 200, temperature: 0.5 });
        if (retried && [...retried.matchAll(Q_RE)].length > 0) {
          reply = retried;
          logger.info({ jobId: "career-interview", thisIsQuestion }, "Zero-question guard: retry succeeded");
        } else {
          logger.warn({ jobId: "career-interview", thisIsQuestion }, "Zero-question guard: retry also produced no question");
        }
      }
    }

    // ── Post-generation farewell guard ────────────────────────────────────
    // Even with strict prompting, the model can occasionally generate a closing
    // farewell during the middle of the interview (e.g. "Take care! Good luck!").
    // If that happens outside of the wrapUp/extended/isComplete phases, we treat
    // it as an implicit completion so the frontend exits cleanly instead of
    // getting stuck in a goodbye loop.
    if (!isComplete) {
      const replyLower = reply.toLowerCase();
      const prematureFarewells = [
        /* English */
        "take care!", "take care,", "take care.", "take care ",
        "good luck!", "best of luck!", "best of luck ", "best of luck,", "best of luck.",
        "goodbye!", "goodbye.", "goodbye,",
        "career journey", "exciting career", "feel free to reach out",
        "i have everything i need", "that's all i need",
        "thats all i need", "i've gathered everything", "ive gathered everything",
        "we're all done", "we are all done", "interview is complete",
        "that wraps up", "this concludes", "i'll go ahead and generate",
        "ill go ahead and generate", "ready to build your career",
        "let me generate your career", "building your career profile now",
        /* Spanish */
        "¡hasta luego", "hasta luego", "hasta pronto", "hasta la próxima",
        "mucho éxito", "mucho exito", "¡mucho éxito", "te deseo mucho éxito",
        "buena suerte", "¡buena suerte", "ha sido un placer", "fue un placer",
        "que te vaya bien", "que te vaya muy bien", "¡suerte",
        "cuídate", "cuídate mucho", "nos vemos", "¡nos vemos",
        "con esto tengo todo", "tengo todo lo que necesito", "ya tenemos todo",
        "con eso es suficiente", "puedo generar tu", "voy a generar tu",
        "generar tu perfil", "construyendo tu perfil", "tu análisis está listo",
        /* French */
        "bonne chance", "au revoir", "à bientôt", "a bientot", "bonne continuation",
        "j'ai tout ce qu'il me faut", "je vais générer", "je peux générer",
        "en bocca al lupo",
        /* Portuguese */
        "boa sorte", "até logo", "até breve", "tchau", "adeus",
        "tenho tudo que preciso", "vou gerar seu", "seu perfil está pronto",
        /* German */
        "viel erfolg", "auf wiedersehen", "alles gute", "tschüss",
        "ich habe alles was ich brauche", "ich werde nun", "viel glück",
        /* Italian */
        "in bocca al lupo", "buona fortuna", "arrivederci", "a presto",
        "tutto il meglio", "ho tutto quello che mi serve", "genera il mio profilo",
        "buona continuazione", "auguri",
        /* Dutch */
        "veel succes", "tot ziens", "tot snel", "dag dag",
        "ik heb alles wat ik nodig heb", "je profiel genereren", "sterkte",
        /* Russian */
        "удачи", "до свидания", "всего хорошего", "всего доброго",
        "у меня есть всё", "создам ваш профиль", "пока",
        /* Chinese (Simplified & Traditional) */
        "再见", "拜拜", "祝你好运", "加油", "保重",
        "我有了所有需要的信息", "生成您的职业分析", "我已获得所有信息",
        "再見", "祝你好運",
        /* Japanese */
        "さようなら", "またね", "頑張ってください", "お疲れ様", "ご武運を",
        "必要な情報が揃いました", "プロフィールを生成", "では、また",
        "お体に気をつけて",
        /* Korean */
        "안녕히 가세요", "잘 가세요", "행운을 빕니다", "화이팅",
        "필요한 정보를 모두 얻었습니다", "프로필을 생성", "잘 부탁드립니다",
        /* Arabic */
        "على خير", "وداعا", "مع السلامة", "بالتوفيق", "إلى اللقاء",
        "حظ سعيد", "لدي كل ما أحتاجه", "سيتم إنشاء ملفك",
        /* Turkish */
        "iyi şanslar", "hoşça kal", "görüşürüz", "güle güle",
        "ihtiyacım olan her şeye sahibim", "profilinizi oluşturacağım", "başarılar",
        /* Polish */
        "powodzenia", "do widzenia", "do zobaczenia", "trzymaj się",
        "mam wszystko czego potrzebuję", "wygeneruję twój profil",
        /* Swedish */
        "lycka till", "hejdå", "vi ses", "ta hand om dig",
        "jag har allt jag behöver", "skapa din profil",
        /* Norwegian */
        "lykke til", "ha det bra", "adjø", "vi snakkes",
        "jeg har alt jeg trenger", "opprette profilen din",
        /* Danish */
        "held og lykke", "farvel", "hej hej", "pas på dig selv",
        "jeg har alt hvad jeg har brug for", "oprette din profil",
        /* Hindi */
        "शुभकामनाएं", "अलविदा", "धन्यवाद, आपसे बात करके",
        "मुझे वह सब मिल गया जो मुझे चाहिए", "आपकी प्रोफ़ाइल बनाई जाएगी",
        /* Bengali */
        "শুভকামনা", "বিদায়", "আবার দেখা হবে", "ভালো থাকবেন",
        /* Tamil */
        "வாழ்த்துக்கள்", "விடைபெறுகிறேன்", "மீண்டும் சந்திப்போம்",
        /* Telugu */
        "శుభాకాంక్షలు", "వీడ్కోలు", "మళ్ళీ కలుద్దాం",
        /* Marathi */
        "शुभेच्छा", "निरोप", "पुन्हा भेटू",
        /* Gujarati */
        "શુભેચ્છા", "આવજો", "ફરી મળીશું",
        /* Kannada */
        "ಶುಭಾಶಯಗಳು", "ವಿದಾಯ", "ಮತ್ತೆ ಭೇಟಿಯಾಗೋಣ",
        /* Malayalam */
        "ആശംസകൾ", "വിട", "വീണ്ടും കാണാം",
        /* Punjabi */
        "ਸ਼ੁਭਕਾਮਨਾਵਾਂ", "ਅਲਵਿਦਾ", "ਫਿਰ ਮਿਲਾਂਗੇ",
        /* Urdu */
        "خوش رہیں", "خدا حافظ", "شکریہ، آپ سے بات کر کے",
      ];
      if (prematureFarewells.some(f => replyLower.includes(f))) {
        logger.info({ jobId: "career-interview", thisIsQuestion, isWrapUp, isExtended }, "Post-gen farewell guard fired — marking interview complete");
        const updatedHistory = [...history, { role: "user", content: message }, { role: "assistant", content: reply }];
        return res.json({ reply, history: updatedHistory, isComplete: true, hardComplete: false, voice: advisor.voice });
      }
    }

    const updatedHistory = [...history, { role: "user", content: message }, { role: "assistant", content: reply }];
    return res.json({ reply, history: updatedHistory, isComplete, hardComplete, voice: advisor.voice });
  } catch (err: any) {
    logger.error({ err }, "Failed to run career interview message");
    return res.status(500).json({ error: "Failed to process message" });
  }
});

/* ── POST /api/portal/career-interview/complete ─────────────────────────── */
router.post("/portal/career-interview/complete", validate({ body: CareerInterviewCompleteBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { history = [], language = "en-US" } = req.body as {
      history: Array<{ role: string; content: string }>;
      language?: string;
    };

    if (history.length < 4) return res.status(400).json({ error: "Insufficient interview data" });

    const langMeta    = resolveLangMeta(language);
    const isNonEnglish = langMeta.region === "indian" || !language.startsWith("en");
    const langLabel    = langMeta.label;

    // Extract structured data from conversation
    const extractionPrompt = `Based on this career interview conversation, extract the candidate's career profile data.

CRITICAL: Extract ONLY information the candidate explicitly stated. If a field was not mentioned, use null. Do NOT infer, guess, or fill gaps with assumptions.
ANTI-BIAS: Base every field value solely on what the candidate said. Do NOT adjust, inflate, or reduce any field based on the candidate's name, apparent gender, nationality, age, educational institution, or any other demographic signal.

IMPORTANT: Even if the interview was conducted in a non-English language (e.g. Hindi, Tamil, Marathi), ALL JSON field values MUST be written in English only. Translate any non-English content into English before placing it in the JSON. Do not use any non-English characters in the JSON output.

Conversation:
${history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n")}

Return ONLY a valid JSON object with this exact structure (use null for missing fields):
{
  "currentTitle": "string or null",
  "currentCompany": "string or null",
  "yearsExperience": number or null,
  "bio": "2-3 sentence summary of who they are",
  "skills": ["skill1", "skill2", ...] (up to 8),
  "education": "string or null",
  "careerGoal3yr": "what they want to achieve in 3 years — their near-term career target or next role milestone",
  "careerGoal5yr": "where they want to be in 5 years — their dream role, long-term impact, or ultimate career aspiration. Look for answers to questions phrased as '5-year vision', 'in 5 years', 'long-term goal', 'dream role', 'ultimately I want', 'end goal'. If they gave both a 3-year and 5-year answer, use the LONGER/bigger one here. These two fields must be DIFFERENT — do NOT copy the 3-year goal here. Only return null if the candidate gave absolutely no indication of any long-term direction.",
  "targetCompanies": ["company1", "company2", ...] (up to 5),
  "targetIndustries": ["industry1", "industry2", ...],
  "preferredRoles": ["role1", "role2", ...],
  "preferredWorkStyle": "remote" | "hybrid" | "on-site" | null,
  "motivations": ["motivation1", "motivation2", ...],
  "workAuthorized": true | false | null (true ONLY if the candidate explicitly confirmed they are legally authorized to work; false if they explicitly said they are not; null if not discussed — never infer from nationality, name, or accent),
  "requiresSponsorship": true | false | null (true if they said they need or will need visa sponsorship; false if they said they will not; null if not discussed),
  "sponsorshipCountry": "the country the candidate referenced for work authorization or sponsorship, or null",
  "sponsorshipNotes": "short free-text context the candidate gave about their work eligibility (e.g. 'H-1B transfer required'), or null",
  "strengthAreas": ["strength1", "strength2", ...] (3-5 core strengths),
  "growthAreas": ["area1", "area2", ...] (2-3 areas to grow),
  "aiSummary": "A factual 6-8 sentence career narrative based ONLY on what the candidate said in this interview. Cover: (1) who they are and their professional background, (2) their key strengths as evidenced in the conversation, (3) their stated career ambitions and direction, (4) what kind of opportunity they described wanting. Do NOT invent or embellish — only summarise what was actually shared. Write as a polished third-person talent profile.",
  "careerPaths": [
    {
      "title": "Path name",
      "description": "What this path involves — based on the candidate's stated experience and goals",
      "timeframe": "e.g. 3-5 years",
      "targetRole": "End role title — grounded in what the candidate said they want",
      "targetCompanyType": "Type of company — based on stated preferences only",
      "milestones": ["milestone 1", "milestone 2", "milestone 3"],
      "keySkillsNeeded": ["skill1", "skill2"],
      "salaryRange": "Typical market range for this role/level in their region — clearly labelled as a market estimate, not a guarantee",
      "difficulty": "achievable" | "ambitious" | "stretch",
      "fit": "high" | "medium" | "speculative"
    }
  ] (exactly 3 paths: one safe/achievable, one ambitious, one stretch/pivot.
NOTE: Career paths are forward-looking AI projections based on stated experience and goals — clearly distinct from extracted facts. Ensure the paths reflect what the candidate actually said about their direction; do NOT invent aspirations they did not express.
ANTI-BIAS: Generate paths of equal quality and ambition regardless of the candidate's demographics. Every candidate deserves the same rigour and optimism in their career path suggestions.)
}`;

    /* Build a raw Q&A summary for transcript/analysis prompts */
    const rawConversation = history.map((m, i) => {
      const speaker = m.role === "assistant" ? "LEXY" : "CANDIDATE";
      return `[${i + 1}] ${speaker}: ${m.content}`;
    }).join("\n\n");

    /* ── Transcript prompt (English) ── */
    const transcriptEnPrompt = isNonEnglish
      ? `The following is a career interview conversation that took place in ${langLabel}. Translate it fully to English and format it as a detailed, readable interview transcript.

Rules:
- Number each exchange (Q1/A1, Q2/A2, etc.)
- Use "LEXY (AI Career Advisor):" for Lexy's turns and "CANDIDATE:" for candidate turns
- Translate accurately — preserve all details, do not summarise or omit
- Add a header: "CAREER INTERVIEW TRANSCRIPT" with "Interview Language: ${langLabel}" and today's date
- Keep the tone professional

Conversation:
${rawConversation}`
      : `Format the following career interview conversation as a detailed, readable interview transcript.

Rules:
- Number each exchange (Q1/A1, Q2/A2, etc.)
- Use "LEXY (AI Career Advisor):" for Lexy's turns and "CANDIDATE:" for candidate turns
- Add a header: "CAREER INTERVIEW TRANSCRIPT" with today's date
- Keep every word verbatim — do not summarise or omit anything

Conversation:
${rawConversation}`;

    /* ── Transcript prompt (native language, only if non-English) ── */
    const transcriptNativePrompt = isNonEnglish
      ? `Format the following career interview conversation (which is in ${langLabel}) as a detailed, readable transcript entirely in ${langLabel}.

Rules:
- Number each exchange (Q1/A1, Q2/A2, etc.)
- Label Lexy's turns as "LEXY (AI Career Advisor in ${langLabel})" — translate this title fully into ${langLabel}
- Label candidate turns as "CANDIDATE" — translate this word into ${langLabel}
- Add a header that is the translation of "CAREER INTERVIEW TRANSCRIPT" in ${langLabel}, along with today's date in ${langLabel}
- Keep every word verbatim — do not summarise or omit anything
- Write ENTIRELY in ${langLabel} — no English at all

Conversation:
${rawConversation}` : null;

    /* ── Analysis prompt (English) ── */
    const analysisEnPrompt = `You are a senior talent intelligence analyst writing a comprehensive career assessment report${isNonEnglish ? ` (this interview was conducted in ${langLabel}; analyse the content as if it were translated to English)` : ""}. This report will be read by senior hiring managers and the candidate themselves. It must be substantive, specific, evidence-backed, and genuinely useful — not a generic summary.

RULES:
- Every claim must reference specific evidence from the interview (quote or paraphrase actual answers)
- Each section must be substantial — minimum 3-5 sentences of body text PLUS bullet points where required
- Use bold (**text**) for sub-headings within sections
- Avoid generic filler phrases ("hardworking", "team player", "passionate") unless backed by concrete evidence
- Write in British English, professional tone
- ANTI-HALLUCINATION: Base EVERY statement strictly on what the candidate said in this conversation. Do NOT invent, assume, or embellish. If a section's topic was not covered in the interview, write "Not discussed in this interview" for that sub-section — never fill gaps with speculation.
- ANTI-BIAS: Evaluate this candidate solely on their stated skills, experience, and goals. Do NOT make any assumptions, positive or negative, based on their name, gender, nationality, age, educational institution, religion, or any other protected characteristic. Apply identical evaluative standards to every candidate regardless of background.

Write the report with these EIGHT sections, each clearly labelled with its number and title:

1. EXECUTIVE SUMMARY
**Overview:** A 4-5 sentence narrative portrait of this candidate — who they are professionally, the arc of their career, their standout qualities, and what makes them distinctive. Do not just list facts; synthesise them into a coherent picture.
**Hiring Manager Headline:** One punchy sentence a recruiter would use to describe this candidate to a client.

2. PROFESSIONAL BACKGROUND
**Current Position & Tenure:** Detail their current or most recent role, company, and length of tenure. What scope of responsibility did they describe?
**Career Trajectory:** How has their career evolved? Note any pivots, accelerations, or lateral moves mentioned.
**Domain Expertise:** What specific technical or functional areas do they demonstrably know well, based on what they said?
**Education & Credentials:** Qualifications mentioned, relevance to their current path.

3. KEY STRENGTHS (minimum 5 strengths)
For each strength write:
- **[Strength Name]:** 2-3 sentences explaining what this strength is, how it was evidenced in the interview (quote or paraphrase), and why it matters professionally.

4. CAREER ASPIRATIONS & AMBITION
**3-Year Target:** What specific outcomes do they want in the next 3 years? How realistic are these given their current position?
**5-Year Vision:** What does their longer-term future look like? Is there entrepreneurial ambition, leadership aspiration, or specialist depth?
**Dream Employers & Roles:** Specific companies or role types they named. What does this tell us about their self-image and market awareness?
**Ambition Assessment:** Is this person's ambition calibrated, under-ambitious, or over-ambitious relative to their experience? Explain.

5. MOTIVATIONS, VALUES & WORK STYLE
**Primary Motivators:** What 3-4 things genuinely drive this person? (Cite their exact words where possible.)
**Work Style Preferences:** Remote / hybrid / on-site preference and why. Team vs. solo. Structured vs. autonomous.
**Values in Practice:** What does their interview behaviour suggest about their professional values — e.g., intellectual curiosity, loyalty, impact orientation?

6. GROWTH OPPORTUNITIES & DEVELOPMENT NEEDS
For each area write:
- **[Area]:** What the gap is, why it matters for their stated goals, and a concrete suggestion for how to address it within 6-12 months.
Identify 3-4 distinct growth areas. Be honest — this section is most useful when it is candid.

7. CAREER FIT ASSESSMENT
**Best-Fit Roles:** 3-5 specific job titles this person is genuinely well-suited for, with a sentence of reasoning each.
**Best-Fit Industries & Company Types:** Which industries and company stages (startup / SME / enterprise) would suit their background and motivations?
**Culture Fit Indicators:** What type of team, leadership style, and organisational culture would bring out the best in this person?
**Red Flags / Watch Points:** Any concerns surfaced by the interview — gaps, inconsistencies, unrealistic expectations, or areas needing verification. Be factual, not judgmental.

8. RECOMMENDED NEXT STEPS
Provide 5-6 specific, actionable steps this candidate should take within the next 6 months. Each step should include:
- **[Action]:** What to do, why it matters for their specific goals, and how to measure success.

Interview conversation:
${rawConversation}`;

    /* ── Analysis prompt (native language, only if non-English) ── */
    const analysisNativePrompt = isNonEnglish
      ? `You are a senior talent intelligence analyst. Write a comprehensive, in-depth career assessment report based on the following career interview conducted in ${langLabel}. The report must be written ENTIRELY in ${langLabel} — no English at all.

This report will be read by hiring managers and the candidate. It must be substantive, specific, evidence-backed, and genuinely useful — not a generic summary.

RULES:
- Every claim must reference specific evidence from the interview (quote or paraphrase actual answers)
- Each section must be substantial — minimum 3-5 sentences of body text PLUS bullet points where required
- Use bold markers for sub-headings within sections
- Write ENTIRELY in ${langLabel} — no English at all
- Translate all section titles and sub-headings into ${langLabel}
- ANTI-HALLUCINATION: Base EVERY statement strictly on what the candidate said. Do NOT invent, assume, or embellish. If a section's topic was not discussed, write the equivalent of "Not discussed in this interview" in ${langLabel} — never fill gaps with speculation.
- ANTI-BIAS: Evaluate solely on stated skills, experience, and goals. Make NO assumptions based on name, gender, nationality, age, institution, religion, or any protected characteristic. Apply identical standards to every candidate.

Write the report with these EIGHT sections (translate all titles to ${langLabel}):

1. EXECUTIVE SUMMARY — 4-5 sentence narrative portrait + one headline sentence
2. PROFESSIONAL BACKGROUND — current role, career trajectory, domain expertise, education
3. KEY STRENGTHS (minimum 5) — for each: name, 2-3 sentences with interview evidence, professional significance
4. CAREER ASPIRATIONS & AMBITION — 3-yr target, 5-yr vision, dream employers, ambition assessment
5. MOTIVATIONS, VALUES & WORK STYLE — primary motivators (cite exact words), work style, values in practice
6. GROWTH OPPORTUNITIES & DEVELOPMENT NEEDS — 3-4 areas with gap description and 6-12 month suggestion each
7. CAREER FIT ASSESSMENT — best-fit roles (3-5 with reasoning), industries, culture fit, red flags
8. RECOMMENDED NEXT STEPS — 5-6 specific actions with reasoning and success metrics

Interview conversation:
${rawConversation}` : null;

    /* ── Run extraction + transcript + analysis in parallel ── */
    const [extractionResult, txEnResult, txNativeResult, analysisEnResult, analysisNativeResult] =
      await Promise.allSettled([
        /* 1. Structured JSON extraction — always in English */
        chatCompletionWithAI(
          [
            { role: "system", content: "You are a data extraction AI. Return only valid JSON, no markdown. Never truncate the JSON — always close all arrays and objects." },
            { role: "user", content: extractionPrompt },
          ],
          "en-US",
          { maxTokens: 3500, temperature: 0.2 },
        ),
        /* 2. English transcript */
        chatCompletionWithAI(
          [{ role: "user", content: transcriptEnPrompt }],
          "en-US",
          { maxTokens: 3000, temperature: 0.2 },
        ),
        /* 3. Native-language transcript (skip if English interview) */
        transcriptNativePrompt
          ? chatCompletionWithAI(
              [{ role: "user", content: transcriptNativePrompt }],
              language,
              { maxTokens: 3000, temperature: 0.2 },
            )
          : Promise.resolve(null),
        /* 4. English analysis */
        chatCompletionWithAI(
          [{ role: "user", content: analysisEnPrompt }],
          "en-US",
          { maxTokens: 4096, temperature: 0.4 },
        ),
        /* 5. Native-language analysis (skip if English interview) */
        analysisNativePrompt
          ? chatCompletionWithAI(
              [{ role: "user", content: analysisNativePrompt }],
              language,
              { maxTokens: 4096, temperature: 0.4 },
            )
          : Promise.resolve(null),
      ]);

    let extracted: any = {};
    try {
      const raw = extractionResult.status === "fulfilled" ? extractionResult.value : "{}";
      extracted = JSON.parse((raw ?? "{}").replace(/^```json\n?/, "").replace(/\n?```$/, ""));
    } catch {
      logger.warn("Failed to parse extraction JSON, using partial data");
    }

    /* ── 5-year vision safety net ─────────────────────────────────────────
       If the main extraction missed careerGoal5yr, do a fast targeted pass
       to recover it from the conversation before we proceed.              */
    if (!extracted.careerGoal5yr) {
      const fiveYrKeywords = /5.?year|five.?year|long.?term|dream role|ultimately|end goal|vision/i;
      const hasFiveYrContent = history.some(m => m.role === "user" && fiveYrKeywords.test(m.content));
      if (hasFiveYrContent) {
        try {
          const recovery = await chatCompletionWithAI(
            [
              { role: "system", content: "You are a data extraction AI. Return only valid JSON, no markdown." },
              {
                role: "user",
                content: `From this career interview, extract ONLY the candidate's 5-year career vision or long-term goal.
Look for what they said in response to questions about 5 years from now, their dream role, their ultimate ambition, or long-term direction.
Return JSON: { "careerGoal5yr": "string or null" }
Conversation:
${history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n")}`,
              },
            ],
            "en-US",
            { maxTokens: 200, temperature: 0.1 },
          );
          const recoveryParsed = JSON.parse((recovery ?? "{}").replace(/^```json\n?/, "").replace(/\n?```$/, ""));
          if (recoveryParsed.careerGoal5yr) {
            extracted.careerGoal5yr = recoveryParsed.careerGoal5yr;
            logger.info({ candidateId }, "[5yr-recovery] Recovered careerGoal5yr via targeted extraction");
          }
        } catch {
          logger.warn({ candidateId }, "[5yr-recovery] Targeted careerGoal5yr extraction failed");
        }
      } else {
        logger.info({ candidateId }, "[5yr-recovery] No 5-year content detected in conversation — skipping recovery");
      }
    }

    const transcriptEn     = txEnResult.status       === "fulfilled" ? txEnResult.value       : null;
    const transcriptNative = txNativeResult.status   === "fulfilled" ? txNativeResult.value   : null;
    const analysisEn       = analysisEnResult.status === "fulfilled" ? analysisEnResult.value : null;
    const analysisNative   = analysisNativeResult.status === "fulfilled" ? analysisNativeResult.value : null;

    logger.info({ language, isNonEnglish, hadTranscript: !!transcriptEn, hadAnalysis: !!analysisEn }, "Interview completion: transcript+analysis generated");

    // Fetch existing profile (full row) so mergeProfileData can backfill gaps.
    const existingRows = await db
      .select()
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);
    const existingProfile = existingRows[0] ?? null;
    const resumeParsed    = (existingProfile?.resumeParsedProfile ?? null) as Record<string, any> | null;

    // ── Central merge — all fallback logic lives in mergeProfileData() ─────
    const merged = mergeProfileData(extracted, existingProfile as any, resumeParsed);

    // ── Validation — warns in logs if required fields are still empty ──────
    validateMergedProfile(merged, candidateId, !!(existingProfile?.resumeUrl));

    const interviewQualityScore = computeInterviewQuality(history);
    logger.info({ candidateId, interviewQualityScore }, "Interview quality score computed");

    const profileData = {
      ...merged,
      baselineInterviewCompleted: true,
      baselineConversation: history,
      interviewLanguage:   language,
      transcriptEnglish:   transcriptEn   ?? null,
      transcriptNative:    transcriptNative ?? null,
      analysisEnglish:     analysisEn     ?? null,
      analysisNative:      analysisNative ?? null,
      interviewQualityScore,
      profileCompleteness: computeProfileCompleteness({ ...merged, interviewQualityScore }),
      updatedAt: new Date(),
    };

    let profile;
    if (existingRows.length > 0) {
      const result = await db
        .update(candidateCareerProfilesTable)
        .set(profileData)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
        .returning();
      profile = result[0];
    } else {
      const result = await db
        .insert(candidateCareerProfilesTable)
        .values({ candidateId, ...profileData })
        .returning();
      profile = result[0];
    }

    /* Ruling (July 2026): completing the baseline interview NO LONGER
     * auto-promotes a self-registered candidate into the platform pool.
     * Discovery is an explicit opt-in (POST /portal/candidate/discovery,
     * chokepoint lib/discovery-consent.ts) presented during onboarding.
     * We still write title/company onto the candidate row so the owning
     * tenant's recruiter view shows real data. */
    const candidateUpdate: Record<string, any> = { updatedAt: new Date() };
    if (merged.currentTitle)   candidateUpdate.currentTitle   = merged.currentTitle;
    if (merged.currentCompany) candidateUpdate.currentCompany = merged.currentCompany;
    if (merged.currentTitle || merged.currentCompany) {
      await db.update(candidatesTable).set(candidateUpdate).where(eq(candidatesTable.id, candidateId));
    }

    // ── Work-authorization capture (runs for ALL candidates) ───────────────
    // The baseline interview asks two lawful work-eligibility logistics questions
    // at the end. If the candidate gave an explicit answer, persist it onto the
    // candidate row so the recruiter Verification card is filled without depending
    // on the separate portal screening form. We NEVER overwrite an existing
    // explicit answer with null — interview silence must not erase a prior
    // self-report. Best-effort: a failure here never breaks interview completion.
    try {
      const waUpdate: Record<string, any> = {};
      if (extracted.workAuthorized === true || extracted.workAuthorized === false)
        waUpdate.workAuthorized = extracted.workAuthorized;
      if (extracted.requiresSponsorship === true || extracted.requiresSponsorship === false)
        waUpdate.requiresSponsorship = extracted.requiresSponsorship;
      if (typeof extracted.sponsorshipCountry === "string" && extracted.sponsorshipCountry.trim())
        waUpdate.sponsorshipCountry = extracted.sponsorshipCountry.trim().slice(0, 120);
      if (typeof extracted.sponsorshipNotes === "string" && extracted.sponsorshipNotes.trim())
        waUpdate.sponsorshipNotes = extracted.sponsorshipNotes.trim().slice(0, 1000);

      if (Object.keys(waUpdate).length > 0) {
        const [existingWa] = await db.select({
          workAuthorized:       candidatesTable.workAuthorized,
          requiresSponsorship:  candidatesTable.requiresSponsorship,
          screeningCompletedAt: candidatesTable.screeningCompletedAt,
        }).from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);

        // Resolve the post-update boolean state to decide screening completion.
        const finalAuthorized  = waUpdate.workAuthorized      ?? existingWa?.workAuthorized      ?? null;
        const finalSponsorship = waUpdate.requiresSponsorship ?? existingWa?.requiresSponsorship ?? null;
        if (finalAuthorized != null && finalSponsorship != null && !existingWa?.screeningCompletedAt) {
          waUpdate.screeningCompletedAt = new Date();
        }
        waUpdate.workAuthSource = "baseline_interview";
        waUpdate.updatedAt = new Date();
        await db.update(candidatesTable).set(waUpdate).where(eq(candidatesTable.id, candidateId));
        logger.info(
          { candidateId, hasAuth: finalAuthorized != null, hasSponsorship: finalSponsorship != null },
          "[career-interview] Captured work-authorization from interview",
        );
      }
    } catch (waErr: any) {
      logger.warn({ candidateId, err: waErr?.message }, "[career-interview] Work-auth capture failed (non-fatal)");
    }

    return res.json({ data: profile });
  } catch (err: any) {
    logger.error({ err }, "Failed to complete career interview");
    return res.status(500).json({ error: "Failed to complete interview" });
  }
});

/* ── POST /api/portal/career-profile/recompute ──────────────────────────
 * Re-applies mergeProfileData() against an already-completed profile so
 * that resume-parsed fallbacks and deduplication rules are refreshed
 * WITHOUT requiring a new interview.
 *
 * Use this to heal profiles that were saved before the merge utility
 * existed, or after any change to the merge rules.
 *
 * Safe to call multiple times — idempotent.
 * ────────────────────────────────────────────────────────────────────── */
router.post("/portal/career-profile/recompute", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const rows = await db
      .select()
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    if (rows.length === 0) {
      return res.status(404).json({ error: "No career profile found" });
    }

    const profile    = rows[0];
    const resumeParsed = (profile.resumeParsedProfile ?? null) as Record<string, any> | null;

    if (!profile.baselineInterviewCompleted) {
      return res.status(400).json({ error: "No interview data to recompute — complete the career interview first" });
    }

    // Treat the current profile values as "extracted" (they came from a prior interview)
    // and re-run the merge to pick up any resume fallbacks that were missing before.
    const currentValues: Record<string, any> = {
      currentTitle:       profile.currentTitle,
      currentCompany:     profile.currentCompany,
      yearsExperience:    profile.yearsExperience,
      education:          profile.education,
      bio:                profile.bio,
      skills:             profile.skills,
      careerGoal3yr:      profile.careerGoal3yr,
      careerGoal5yr:      profile.careerGoal5yr,
      targetCompanies:    profile.targetCompanies,
      targetIndustries:   profile.targetIndustries,
      preferredRoles:     profile.preferredRoles,
      preferredWorkStyle: profile.preferredWorkStyle,
      motivations:        profile.motivations,
      strengthAreas:      profile.strengthAreas,
      growthAreas:        profile.growthAreas,
      aiSummary:          profile.aiSummary,
      careerPaths:        profile.careerPaths,
    };

    // Pass existing profile as both extracted AND existing — merge will pick up
    // resume-parsed fallbacks for any null fields.
    const merged = mergeProfileData(currentValues, currentValues, resumeParsed);
    const missing = validateMergedProfile(merged, candidateId, !!(profile.resumeUrl));

    const recomputeQuality = profile.interviewQualityScore ?? 100;
    const updated = await db
      .update(candidateCareerProfilesTable)
      .set({
        ...merged,
        profileCompleteness: computeProfileCompleteness({ ...merged, interviewQualityScore: recomputeQuality }),
        updatedAt: new Date(),
      })
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .returning();

    logger.info({ candidateId, missingFields: missing }, "[recompute] Profile recomputed successfully");

    return res.json({
      data: updated[0],
      recomputed: true,
      missingFields: missing,
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to recompute career profile");
    return res.status(500).json({ error: "Failed to recompute profile" });
  }
});

/* ── POST /api/portal/career-interview/regenerate-transcript ──────────── */
router.post("/portal/career-interview/regenerate-transcript", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const [profileRows] = await Promise.all([
      db.select({
        id: candidateCareerProfilesTable.id,
        baselineConversation: candidateCareerProfilesTable.baselineConversation,
        interviewLanguage: candidateCareerProfilesTable.interviewLanguage,
        baselineInterviewCompleted: candidateCareerProfilesTable.baselineInterviewCompleted,
      })
        .from(candidateCareerProfilesTable)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
        .limit(1),
    ]);

    const profile = profileRows[0];
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    if (!profile.baselineInterviewCompleted) return res.status(400).json({ error: "Interview not completed" });

    const history = (profile.baselineConversation as Array<{ role: string; content: string }>) ?? [];
    if (history.length < 4) return res.status(400).json({ error: "Insufficient conversation history" });

    const language = profile.interviewLanguage ?? "en-US";
    const langMeta = resolveLangMeta(language);
    const isNonEnglish = langMeta.region === "indian" || !language.startsWith("en");
    const langLabel = langMeta.label;

    const rawConversation = history.map((m, i) => {
      const speaker = m.role === "assistant" ? "LEXY" : "CANDIDATE";
      return `[${i + 1}] ${speaker}: ${m.content}`;
    }).join("\n\n");

    const transcriptEnPrompt = isNonEnglish
      ? `The following is a career interview conversation that took place in ${langLabel}. Translate it fully to English and format it as a detailed, readable interview transcript.

Rules:
- Number each exchange (Q1/A1, Q2/A2, etc.)
- Use "LEXY (AI Career Advisor):" for Lexy's turns and "CANDIDATE:" for candidate turns
- Translate accurately — preserve all details, do not summarise or omit
- Add a header: "CAREER INTERVIEW TRANSCRIPT" with "Interview Language: ${langLabel}" and today's date
- Keep the tone professional

Conversation:
${rawConversation}`
      : `Format the following career interview conversation as a detailed, readable interview transcript.

Rules:
- Number each exchange (Q1/A1, Q2/A2, etc.)
- Use "LEXY (AI Career Advisor):" for Lexy's turns and "CANDIDATE:" for candidate turns
- Add a header: "CAREER INTERVIEW TRANSCRIPT" with today's date
- Keep every word verbatim — do not summarise or omit anything

Conversation:
${rawConversation}`;

    const [txEnResult, txNativeResult] = await Promise.allSettled([
      chatCompletionWithAI(
        [{ role: "user", content: transcriptEnPrompt }],
        "en-US",
        { maxTokens: 3000, temperature: 0.2 },
      ),
      isNonEnglish
        ? chatCompletionWithAI(
            [{ role: "user", content: `Format the following career interview conversation (which is in ${langLabel}) as a detailed, readable transcript entirely in ${langLabel}.\n\nRules:\n- Number each exchange (Q1/A1, Q2/A2, etc.)\n- Label Lexy's turns as "LEXY (AI Career Advisor in ${langLabel})"\n- Label candidate turns as "CANDIDATE" (translated to ${langLabel})\n- Add a header translated to ${langLabel} with today's date\n- Write ENTIRELY in ${langLabel}\n\nConversation:\n${rawConversation}` }],
            language,
            { maxTokens: 3000, temperature: 0.2 },
          )
        : Promise.resolve(null),
    ]);

    const transcriptEn = txEnResult.status === "fulfilled" ? txEnResult.value : null;
    const transcriptNative = txNativeResult.status === "fulfilled" ? txNativeResult.value : null;

    if (!transcriptEn) return res.status(500).json({ error: "Failed to generate transcript" });

    await db
      .update(candidateCareerProfilesTable)
      .set({
        transcriptEnglish: transcriptEn,
        transcriptNative: transcriptNative ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId));

    logger.info({ candidateId }, "Transcript regenerated successfully");
    return res.json({ success: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to regenerate transcript");
    return res.status(500).json({ error: "Failed to regenerate transcript" });
  }
});

/* ── POST /api/portal/mocks/complete ────────────────────────────────────────
 * Called by the candidate portal's prep page when a mock-interview session
 * finishes. This is the single point where the candidate-facing brochure
 * promise — "Each round feeds your skill score and updates your sparkline" —
 * actually becomes real:
 *
 *   1. Computes a 0-100 score from the candidate's self-rating breakdown
 *      (Got it / Need work) plus a small completion bonus.
 *   2. Writes a `candidate_action_events` row with eventType =
 *      "mock_interview_completed" — this is what the weekly digest counts,
 *      what Five In A Row reads, and what shows up in "recent signals".
 *   3. Writes a `candidate_skill_scores` row per category practised — these
 *      power the per-skill 90-day sparklines on the Career Hub.
 *
 * Both writes happen for every completion so the score, the sparkline, the
 * badge, and the digest all stay in lock-step.
 */
import { rateLimit as _rateLimit } from "../middlewares/rateLimit";
router.post("/portal/mocks/complete",
  /* 5 completions per hour per candidate — well above any legitimate usage,
     and stops a runaway client from polluting the skill-score timeline. */
  _rateLimit({ windowMs: 60 * 60_000, max: 5 }),
  validate({ body: MocksCompleteBody }),
  async (req: any, res) => {
  try {
    /* Strict auth — write paths must NOT fall back to the shared demo
       candidate, otherwise unauthenticated callers can pollute the demo
       account's metrics (skill score, sparkline, badge progress).
       getCandidateId resolves the session (Bearer header or httpOnly session
       cookie) and returns null for anonymous callers — they are rejected
       below, never routed to the shared demo candidate. */
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const {
      mode, modeLabel, categories,
      questionsAnswered, gotItCount, needWorkCount,
    } = req.body ?? {};

    if (!mode || typeof mode !== "string") {
      return res.status(400).json({ error: "mode is required" });
    }
    const total      = Math.max(0, Number(questionsAnswered ?? 0) | 0);
    const gotIt      = Math.max(0, Number(gotItCount ?? 0) | 0);
    const needWork   = Math.max(0, Number(needWorkCount ?? 0) | 0);
    const ratedTotal = gotIt + needWork;

    /* Score = self-rated success rate, anchored at 50 if nothing was rated.
       Add a small (+5) completion bonus once the candidate finishes a real
       session (≥5 questions). Cap at 95 — we never claim a candidate is
       "100% ready" off self-ratings alone. */
    const baseScore       = ratedTotal > 0 ? Math.round((gotIt / ratedTotal) * 100) : 50;
    const completionBonus = total >= 5 ? 5 : 0;
    const score           = Math.min(95, baseScore + completionBonus);

    /* 1) Action event — drives digest, badge, and recent-signals. */
    const [event] = await db
      .insert(candidateActionEventsTable)
      .values({
        candidateId,
        eventType: "mock_interview_completed",
        payload: { mode, modeLabel, categories, questionsAnswered: total, gotItCount: gotIt, needWorkCount: needWork, score } as any,
      })
      .returning({ id: candidateActionEventsTable.id });

    /* 2) Skill score rows — one per category practised, so each dimension's
          sparkline picks up the new data point. Falls back to mode.id when
          the client didn't send categories (older clients). */
    const skillKeys: string[] = Array.isArray(categories) && categories.length > 0
      ? categories.map((c: any) => String(c)).filter(Boolean)
      : [String(mode)];

    if (skillKeys.length > 0) {
      await db.insert(candidateSkillScoresTable).values(
        skillKeys.map(skill => ({
          candidateId,
          skill,
          score,
          source:    "mock_interview",
          sessionId: event?.id ?? null,
        })),
      );
    }

    return res.json({ ok: true, score, eventId: event?.id ?? null, skillsUpdated: skillKeys });
  } catch (err: any) {
    logger.error({ err }, "mocks/complete failed");
    return res.status(500).json({ error: "Failed to record mock completion", message: err?.message });
  }
});

/* ── GET /api/portal/privacy ────────────────────────────────────────────────
   Returns the candidate's current privacy controls (brochure slide 6 —
   "Stay invisible to your boss"). Powers the Settings → Privacy panel. */
router.get("/portal/privacy", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
    const [c] = await db.select({
      discoveryPaused:         (candidatesTable as any).discoveryPaused,
      hideFromCurrentEmployer: (candidatesTable as any).hideFromCurrentEmployer,
      currentEmployerDomain:   (candidatesTable as any).currentEmployerDomain,
      blockedCompanyDomains:   (candidatesTable as any).blockedCompanyDomains,
      matchOnlyVisibility:     (candidatesTable as any).matchOnlyVisibility,
    }).from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
    return res.json({
      discoveryPaused:         c?.discoveryPaused ?? false,
      hideFromCurrentEmployer: c?.hideFromCurrentEmployer ?? false,
      currentEmployerDomain:   c?.currentEmployerDomain ?? "",
      blockedCompanyDomains:   (c?.blockedCompanyDomains ?? []) as string[],
      matchOnlyVisibility:     c?.matchOnlyVisibility ?? false,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to load privacy settings", message: err?.message });
  }
});

/* ── PUT /api/portal/privacy ────────────────────────────────────────────────
   Updates the three privacy controls. Validates: domain strings are lowered,
   www-stripped, deduped, and capped at 50 entries to stop abuse. */
router.put("/portal/privacy", validate({ body: PrivacyUpdateBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
    const { discoveryPaused, hideFromCurrentEmployer, currentEmployerDomain, blockedCompanyDomains, matchOnlyVisibility } = req.body ?? {};

    const cleanDomain = (raw: any): string => {
      const s = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
      return s.split("/")[0]; // strip any path
    };

    /* Strict domain validator — at least one dot, valid label chars only.
       Rejects "javascript:", whitespace blobs, IP addresses, and the empty
       string. Keeps the privacy filter's suffix matching trustworthy. */
    const VALID_DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
    const isValidDomain = (d: string) => VALID_DOMAIN.test(d) && !/^\d+(\.\d+)+$/.test(d);

    const hide = !!hideFromCurrentEmployer;
    const cleanedEmployer = currentEmployerDomain ? cleanDomain(currentEmployerDomain) : "";

    /* Hard rule: if you turn the toggle ON you must give us a domain, otherwise
       we have nothing to match against and you'd be silently unprotected. */
    if (hide && !cleanedEmployer) {
      return res.status(400).json({ error: "currentEmployerDomain is required when hideFromCurrentEmployer is true" });
    }
    if (cleanedEmployer && !isValidDomain(cleanedEmployer)) {
      return res.status(400).json({ error: `Invalid currentEmployerDomain: "${cleanedEmployer}"` });
    }

    const rawBlocked = Array.isArray(blockedCompanyDomains) ? blockedCompanyDomains : [];
    const cleanedBlocked: string[] = [];
    const invalid: string[] = [];
    for (const raw of rawBlocked) {
      const d = cleanDomain(raw);
      if (!d) continue;
      if (!isValidDomain(d)) { invalid.push(d); continue; }
      if (!cleanedBlocked.includes(d)) cleanedBlocked.push(d);
    }
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid blocked domains: ${invalid.join(", ")}` });
    }
    const finalBlocked = cleanedBlocked.slice(0, 50);

    const matchOnly = !!matchOnlyVisibility;
    const paused    = !!discoveryPaused;

    await db.update(candidatesTable).set({
      discoveryPaused:         paused,
      hideFromCurrentEmployer: hide,
      currentEmployerDomain:   cleanedEmployer || null,
      blockedCompanyDomains:   finalBlocked as any,
      matchOnlyVisibility:     matchOnly,
      updatedAt: new Date(),
    } as any).where(eq(candidatesTable.id, candidateId));

    return res.json({
      discoveryPaused:         paused,
      hideFromCurrentEmployer: hide,
      currentEmployerDomain:   cleanedEmployer,
      blockedCompanyDomains:   finalBlocked,
      matchOnlyVisibility:     matchOnly,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to update privacy settings", message: err?.message });
  }
});

/* ── GET /api/portal/engagement ─────────────────────────────────────────────
   Returns the data powering the new candidate-engagement widgets:
     • achievements (earned + locked, with progress hints)
     • peer percentile bands (country + global, fuzzy positive)
     • per-skill score history for the improvement sparkline
     • recruiter-view pulse (last 24h / 7d / 30d) for social proof

   Lazily awards any newly-qualified achievements on each call so the dashboard
   reflects the latest state without needing event-handler wiring everywhere. */
router.get("/portal/engagement", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { listAchievements, awardAchievements } = await import("../lib/achievement-engine.js");
    const { getLatestPeerSnapshot } = await import("../lib/peer-percentile.js");

    /* Fire-and-await: cheap (handful of small SELECTs); newly-earned badges
       returned to the frontend so it can flash a celebration toast. */
    const newlyEarned = await awardAchievements(candidateId).catch(() => []);
    const achievements = await listAchievements(candidateId);
    const peer = await getLatestPeerSnapshot(candidateId);

    /* Per-skill score history (last 90 days). Frontend draws a sparkline per skill. */
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    const skillRows = await db
      .select()
      .from(candidateSkillScoresTable)
      .where(and(
        eq(candidateSkillScoresTable.candidateId, candidateId),
        gte(candidateSkillScoresTable.createdAt, ninetyDaysAgo),
      ))
      .orderBy(candidateSkillScoresTable.createdAt);

    const bySkill = new Map<string, { skill: string; history: { score: number; at: string }[] }>();
    for (const r of skillRows) {
      if (!bySkill.has(r.skill)) bySkill.set(r.skill, { skill: r.skill, history: [] });
      bySkill.get(r.skill)!.history.push({
        score: r.score,
        at: (r.createdAt as Date).toISOString(),
      });
    }
    const skillScores = Array.from(bySkill.values());

    /* Recruiter-view pulse — drives the "X recruiters viewed your profile in
       the last 24h" social-proof card. */
    const oneDayAgo = new Date(Date.now() - 86_400_000);
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

    /* ── Retroactive privacy seal on "who viewed you" ──────────────────────
       Canonical seal lives in lib/viewer-privacy.ts — every reader of
       recruiter_view events must apply it. Semantics documented there. */
    const { getViewerPrivacySeal, countSealedRecruiterViews } = await import("../lib/viewer-privacy.js");
    const viewerSeal = await getViewerPrivacySeal(candidateId);
    const viewsPaused = viewerSeal.viewsPaused;
    const viewNotHidden = viewerSeal.viewNotHidden;

    const views24h = await countSealedRecruiterViews(candidateId, oneDayAgo, viewerSeal);
    const views7d  = await countSealedRecruiterViews(candidateId, sevenDaysAgo, viewerSeal);
    const views30d = await countSealedRecruiterViews(candidateId, thirtyDaysAgo, viewerSeal);

    /* ── Identified-company viewers (last 30d) ──────────────────────────────
       Powers the "Stripe just viewed you" UI — replaces the anonymous count
       with the actual hiring teams that opened this candidate. Excludes
       NULL viewer_tenant_id (legacy / API-only views) and the synthetic
       "platform" tenant. */
    const viewerCompanyRows = viewsPaused ? [] : await db
      .select({
        tenantId: candidateActionEventsTable.viewerTenantId,
        name:     tenantsTable.name,
        count:    sql<number>`COUNT(*)::int`,
        lastAt:   sql<Date>`MAX(${candidateActionEventsTable.createdAt})`,
      })
      .from(candidateActionEventsTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, candidateActionEventsTable.viewerTenantId))
      .where(and(
        eq(candidateActionEventsTable.candidateId, candidateId),
        eq(candidateActionEventsTable.eventType, "recruiter_view"),
        gte(candidateActionEventsTable.createdAt, thirtyDaysAgo),
        sql`${candidateActionEventsTable.viewerTenantId} IS NOT NULL`,
        sql`${candidateActionEventsTable.viewerTenantId} <> 'platform'`,
        viewNotHidden,
      ))
      .groupBy(candidateActionEventsTable.viewerTenantId, tenantsTable.name)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(5);
    const topViewerCompanies = viewerCompanyRows
      .filter(r => r.name) // drop tenants we couldn't resolve a name for
      .map(r => ({ name: r.name as string, count: Number(r.count), lastViewedAt: (r.lastAt as Date)?.toISOString?.() ?? null }));

    /* ── Viewer companies grouped by tier ───────────────────────────────────
       Brochure RecruitersLooking slide promises: "See who's viewed your
       profile this week, anonymized by company tier." Pull ALL identified
       viewer tenants in the last 7 days (not just top 5) and bucket each
       into a tier — so even when individual viewer names are sensitive
       (recruiter is researching anonymously), the candidate still sees the
       caliber of attention. */
    /* Group by tenant ID (NOT name) so distinct tenants that happen to share
       a display name don't get collapsed into a single bucket. Null/unknown
       names are kept and routed into Tier 3, so every valid recruiter_view
       event in the last 7 days is counted somewhere — never dropped. */
    const viewerWeekRows = viewsPaused ? [] : await db
      .select({
        tenantId: candidateActionEventsTable.viewerTenantId,
        name:     tenantsTable.name,
        count:    sql<number>`COUNT(*)::int`,
      })
      .from(candidateActionEventsTable)
      .leftJoin(tenantsTable, eq(tenantsTable.id, candidateActionEventsTable.viewerTenantId))
      .where(and(
        eq(candidateActionEventsTable.candidateId, candidateId),
        eq(candidateActionEventsTable.eventType, "recruiter_view"),
        gte(candidateActionEventsTable.createdAt, new Date(Date.now() - 7 * 86_400_000)),
        sql`${candidateActionEventsTable.viewerTenantId} IS NOT NULL`,
        sql`${candidateActionEventsTable.viewerTenantId} <> 'platform'`,
        viewNotHidden,
      ))
      .groupBy(candidateActionEventsTable.viewerTenantId, tenantsTable.name);

    const viewerCompaniesByTier = (() => {
      /* Tier classifier — substring match on the tenant's display name.
         Conservative: anything we can't classify (or an unresolved tenant
         name) falls into Tier 3 so we never mis-promote a generic recruiter
         into Tier 1, but every viewer event still gets counted. */
      const tier1 = [
        "google","meta","facebook","amazon","apple","microsoft","netflix",
        "openai","anthropic","nvidia","tesla","tiktok","bytedance",
      ];
      const tier2 = [
        "stripe","airbnb","uber","lyft","databricks","snowflake","palantir",
        "shopify","square","block","spotify","pinterest","twitter","x corp",
        "linkedin","salesforce","oracle","adobe","ibm","intel","amd",
        "atlassian","figma","notion","canva","coinbase","robinhood","plaid",
        "doordash","instacart","reddit","dropbox","slack","zoom","mongodb",
        "datadog","cloudflare","hubspot","workday","servicenow","intuit",
      ];
      const buckets: Record<"tier1" | "tier2" | "tier3", number[]> = {
        tier1: [], tier2: [], tier3: [],
      };
      for (const r of viewerWeekRows) {
        const lc = (r.name ?? "").toLowerCase();
        const inTier1 = lc !== "" && tier1.some(t => lc.includes(t));
        const inTier2 = !inTier1 && lc !== "" && tier2.some(t => lc.includes(t));
        const bucket = inTier1 ? "tier1" : inTier2 ? "tier2" : "tier3";
        buckets[bucket].push(Number(r.count));
      }
      return {
        tier1: { count: buckets.tier1.reduce((s, x) => s + x, 0), companyCount: buckets.tier1.length },
        tier2: { count: buckets.tier2.reduce((s, x) => s + x, 0), companyCount: buckets.tier2.length },
        tier3: { count: buckets.tier3.reduce((s, x) => s + x, 0), companyCount: buckets.tier3.length },
      };
    })();

    /* ── Target-company matches ─────────────────────────────────────────────
       Did any of the candidate's saved target companies actually view them
       in the last 30 days? We query ALL identified viewers (not just the
       top 5) so a target-company hit isn't dropped just because higher-volume
       generic viewers crowded it out of the top list. */
    const [profileRow] = await db
      .select({ targets: (candidateCareerProfilesTable as any).targetCompanies })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);
    const targets: string[] = (profileRow?.targets ?? []) as string[];

    let targetCompanyMatches: { name: string; lastViewedAt: string | null; viewCount: number }[] = [];
    if (targets.length > 0 && !viewsPaused) {
      const allViewerRows = await db
        .select({
          name:   tenantsTable.name,
          count:  sql<number>`COUNT(*)::int`,
          lastAt: sql<Date>`MAX(${candidateActionEventsTable.createdAt})`,
        })
        .from(candidateActionEventsTable)
        .leftJoin(tenantsTable, eq(tenantsTable.id, candidateActionEventsTable.viewerTenantId))
        .where(and(
          eq(candidateActionEventsTable.candidateId, candidateId),
          eq(candidateActionEventsTable.eventType, "recruiter_view"),
          gte(candidateActionEventsTable.createdAt, thirtyDaysAgo),
          sql`${candidateActionEventsTable.viewerTenantId} IS NOT NULL`,
          sql`${candidateActionEventsTable.viewerTenantId} <> 'platform'`,
          viewNotHidden,
        ))
        .groupBy(tenantsTable.name);
      const viewerByLcName = new Map(
        allViewerRows.filter(r => r.name).map(r => [(r.name as string).toLowerCase(),
          { name: r.name as string, count: Number(r.count), lastAt: (r.lastAt as Date)?.toISOString?.() ?? null }]),
      );
      targetCompanyMatches = targets
        .map(t => {
          const tlc = (t || "").toLowerCase().trim();
          if (!tlc) return null;
          /* Exact, then substring (bidirectional) — matches the same fuzzy
             rule the emitter uses so portal & email agree. */
          let hit = viewerByLcName.get(tlc);
          if (!hit) {
            for (const [vlc, v] of viewerByLcName) {
              if (vlc.includes(tlc) || tlc.includes(vlc)) { hit = v; break; }
            }
          }
          return hit ? { name: t, lastViewedAt: hit.lastAt, viewCount: hit.count } : null;
        })
        .filter((x): x is { name: string; lastViewedAt: string | null; viewCount: number } => x !== null);
    }

    /* ── Skill-score monthly delta (brochure slide 4 — "Your scores nudged
       up this month") ───────────────────────────────────────────────────
       Compare today's readiness vs the readiness recorded ~30d ago in the
       progress-snapshot history. Surfaced as a small pill next to the
       readiness ring. Returns null if we don't have a baseline yet. */
    const [latestSnap] = await db.select()
      .from(candidateProgressSnapshotsTable)
      .where(eq(candidateProgressSnapshotsTable.candidateId, candidateId))
      .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
      .limit(1);
    const [oldSnap] = await db.select()
      .from(candidateProgressSnapshotsTable)
      .where(and(
        eq(candidateProgressSnapshotsTable.candidateId, candidateId),
        sql`${candidateProgressSnapshotsTable.createdAt} <= ${thirtyDaysAgo}`,
      ))
      .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
      .limit(1);
    const skillScoreMonthlyDelta = (latestSnap && oldSnap)
      ? { current: latestSnap.readinessScore, previous: oldSnap.readinessScore,
          delta: latestSnap.readinessScore - oldSnap.readinessScore }
      : null;

    /* ── Recent role-open-at-target events (brochure slide 7 — "On open") ──
       Most-recent N alerts, joined to nothing (payload carries the
       displayable fields). Drives the "Stripe just opened SRE Lead" card. */
    const roleOpenRows = await db.select()
      .from(candidateActionEventsTable)
      .where(and(
        eq(candidateActionEventsTable.candidateId, candidateId),
        eq(candidateActionEventsTable.eventType, "role_open_at_target"),
        gte(candidateActionEventsTable.createdAt, thirtyDaysAgo),
      ))
      .orderBy(desc(candidateActionEventsTable.createdAt))
      .limit(5);
    const recentRoleOpens = roleOpenRows.map(r => ({
      jobId:       (r.payload as any)?.jobId ?? null,
      companyName: (r.payload as any)?.companyName ?? "A target company",
      roleTitle:   (r.payload as any)?.roleTitle ?? "a role",
      at:          (r.createdAt as Date).toISOString(),
    }));

    /* ── Latest mock-session rubric (brochure slide 5 — Per-dimension scoring)
       Returns the four-dim rubric + verbatim "your strongest line" for the
       most recent completed prep session, so the dashboard can preview it
       without re-fetching the prep route. */
    const { prepSessionsTable } = await import("@workspace/db");
    const [latestPrep] = await db.select()
      .from(prepSessionsTable)
      .where(and(
        eq(prepSessionsTable.candidateId, candidateId),
        eq(prepSessionsTable.status, "completed"),
      ))
      .orderBy(desc(prepSessionsTable.updatedAt))
      .limit(1);
    const latestPrepRubric = latestPrep ? {
      sessionId:      latestPrep.id,
      mode:           latestPrep.mode,
      readinessScore: latestPrep.readinessScore,
      rubricScores:   latestPrep.rubricScores ?? null,
      verbatimQuotes: latestPrep.verbatimQuotes ?? [],
      completedAt:    (latestPrep.updatedAt as Date).toISOString(),
    } : null;

    return res.json({
      achievements,
      newlyEarned,
      peer,
      skillScores,
      skillScoreMonthlyDelta,
      recruiterPulse: { last24h: views24h, last7d: views7d, last30d: views30d },
      topViewerCompanies,
      viewerCompaniesByTier,
      targetCompanyMatches,
      recentRoleOpens,
      latestPrepRubric,
    });
  } catch (err: any) {
    return res.status(500).json({ error: "Failed to load engagement data", message: err?.message });
  }
});

/* ── GET /api/portal/career-recommendations ─────────────────────────────── */
router.get("/portal/career-recommendations", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const profile = await db
      .select()
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    const p = profile[0];
    if (!p) {
      return res.json({
        data: [
          { recKey: "interview", type: "interview", label: "Complete your Career Baseline Interview", priority: "high", href: "/portal/career/interview" },
          { recKey: "profile",   type: "profile",   label: "Build your Career Profile",              priority: "high", href: "/portal/career" },
        ],
      });
    }

    // Load completed recs for this candidate
    const completions = await db
      .select()
      .from(candidateRecommendationProgressTable)
      .where(eq(candidateRecommendationProgressTable.candidateId, candidateId));
    const completedKeys = new Set(completions.filter(c => c.completedAt).map(c => c.recKey));

    // Auto-mark interview rec as complete when baseline is done
    if (p.baselineInterviewCompleted && !completedKeys.has("interview")) {
      await db.insert(candidateRecommendationProgressTable).values({
        id: crypto.randomUUID(),
        candidateId,
        recKey: "interview",
        completedAt: new Date(),
      }).onConflictDoNothing();
      completedKeys.add("interview");
    }

    // Auto-detect: if candidate has applied to a target company, mark research rec done
    const targetCosAll = (p.targetCompanies as string[]) ?? [];
    if (targetCosAll.length > 0) {
      // Get all applications for this candidate with their job info
      const candidateApps = await db
        .select({ jobId: applicationsTable.jobId })
        .from(applicationsTable)
        .where(eq(applicationsTable.candidateId, candidateId));

      if (candidateApps.length > 0) {
        const jobIds = candidateApps.map(a => a.jobId);

        const appliedCompanies = new Set(
          (await Promise.all(jobIds.map(id =>
            db.select({ company: jobsTable.company }).from(jobsTable).where(eq(jobsTable.id, id)).limit(1)
          ))).flatMap(r => r.map(j => j.company?.toLowerCase() ?? ""))
        );

        for (const company of targetCosAll) {
          const key = `research:${company}`;
          if (!completedKeys.has(key) && appliedCompanies.has(company.toLowerCase())) {
            await db.insert(candidateRecommendationProgressTable).values({
              id: crypto.randomUUID(),
              candidateId,
              recKey: key,
              completedAt: new Date(),
              notes: `Auto-detected: applied to a job at ${company}`,
            }).onConflictDoNothing();
            completedKeys.add(key);
          }
        }
      }
    }

    const recs: any[] = [];

    // ── 90-day refresh trigger ─────────────────────────────────────────────
    if (p.baselineInterviewCompleted) {
      const daysSinceUpdate = (Date.now() - new Date(p.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate >= 90 && !completedKeys.has("refresh")) {
        const monthsAgo = Math.floor(daysSinceUpdate / 30);
        recs.push({
          recKey: "refresh",
          type: "refresh",
          label: `Your career profile is ${monthsAgo} months old — time to refresh it`,
          priority: "high",
          href: "/portal/career/interview",
        });
      }
    }

    if (!p.baselineInterviewCompleted && !completedKeys.has("interview")) {
      recs.push({ recKey: "interview", type: "interview", label: "Complete your Career Baseline Interview", priority: "high", href: "/portal/career/interview" });
    }

    const paths = (p.careerPaths as any[]) ?? [];
    if (paths.length > 0) {
      const topMilestone = paths[0]?.milestones?.[0];
      if (topMilestone) {
        const key = `milestone:${topMilestone}`;
        if (!completedKeys.has(key)) {
          recs.push({ recKey: key, type: "career", label: `Next milestone: ${topMilestone}`, priority: "high", href: "/portal/career" });
        }
      }
    }

    const growthAreas = (p.growthAreas as string[]) ?? [];
    if (growthAreas[0]) {
      const key = `learning:${growthAreas[0]}`;
      if (!completedKeys.has(key)) {
        recs.push({ recKey: key, type: "learning", label: `Develop: ${growthAreas[0]}`, priority: "medium", href: "/portal/career" });
      }
    }

    const targetCos = (p.targetCompanies as string[]) ?? [];
    if (targetCos[0]) {
      const key = `research:${targetCos[0]}`;
      if (!completedKeys.has(key)) {
        recs.push({ recKey: key, type: "research", label: `Research open roles at ${targetCos[0]}`, priority: "medium", href: "/portal/career" });
      }
    }

    if (p.profileCompleteness < 80 && !completedKeys.has("profile")) {
      recs.push({ recKey: "profile", type: "profile", label: "Complete your career profile to unlock better matches", priority: "medium", href: "/portal/career" });
    }

    if (p.careerGoal3yr && !completedKeys.has("goal")) {
      recs.push({ recKey: "goal", type: "goal", label: `Track progress toward: ${p.careerGoal3yr?.slice(0, 50)}…`, priority: "low", href: "/portal/career" });
    }

    return res.json({ data: recs.slice(0, 6) });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch career recommendations");
    return res.status(500).json({ error: "Failed to fetch career recommendations" });
  }
});

/* ── POST /api/portal/recommendations/complete ──────────────────────────── */
router.post("/portal/recommendations/complete", validate({ body: RecommendationsCompleteBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { recKey, notes } = req.body;
    if (!recKey) return res.status(400).json({ error: "recKey is required" });

    const notesVal = notes?.trim() || null;

    // Upsert: insert if not exists, update completedAt + notes if exists
    const existing = await db
      .select()
      .from(candidateRecommendationProgressTable)
      .where(and(
        eq(candidateRecommendationProgressTable.candidateId, candidateId),
        eq(candidateRecommendationProgressTable.recKey, recKey),
      ))
      .limit(1);

    if (existing[0]) {
      await db
        .update(candidateRecommendationProgressTable)
        .set({ completedAt: new Date(), notes: notesVal })
        .where(and(
          eq(candidateRecommendationProgressTable.candidateId, candidateId),
          eq(candidateRecommendationProgressTable.recKey, recKey),
        ));
    } else {
      await db.insert(candidateRecommendationProgressTable).values({
        id: crypto.randomUUID(),
        candidateId,
        recKey,
        completedAt: new Date(),
        notes: notesVal,
      });
    }

    return res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to mark recommendation complete");
    return res.status(500).json({ error: "Failed to update recommendation" });
  }
});

/* ── POST /api/portal/career-profile/resume ─────────────────────────────── */
router.post("/portal/career-profile/resume", validate({ body: ResumeSaveBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { resumeObjectPath } = req.body as { resumeObjectPath?: string };
    if (!resumeObjectPath?.trim()) {
      return res.status(400).json({ error: "resumeObjectPath is required" });
    }

    await db
      .update(candidatesTable)
      .set({ resumeUrl: resumeObjectPath.trim(), updatedAt: new Date() })
      .where(eq(candidatesTable.id, candidateId));

    return res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "Failed to save resume");
    return res.status(500).json({ error: "Failed to save resume" });
  }
});

/* ── POST /api/portal/career-profile/resume/parse ───────────────────────── */
router.post("/portal/career-profile/resume/parse", resumeUploadMiddleware.single("file"), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const file = req.file as Express.Multer.File | undefined;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    /* ── Extract raw text ── */
    let rawText = "";
    const mime = file.mimetype;
    try {
      if (mime === "application/pdf") {
        const result = await pdfParse(file.buffer);
        rawText = result.text;
      } else if (
        mime === "application/msword" ||
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        rawText = result.value;
      } else {
        return res.status(400).json({ error: "PDF or Word files only (.pdf, .doc, .docx)" });
      }
    } catch (extractErr) {
      logger.error({ extractErr }, "Resume text extraction failed");
      return res.json({ ok: false, parseError: true, message: "Couldn't fully read your resume, but you can still continue with the interview." });
    }

    if (!rawText.trim() || rawText.trim().length < 50) {
      return res.json({ ok: false, parseError: true, message: "Couldn't extract enough content from your resume, but you can still continue with the interview." });
    }

    /* ── Parse into structured profile with AI ── */
    const truncated = rawText.slice(0, 6000);
    const parsePrompt = `You are a expert recruiter and career advisor. Extract a structured candidate profile from the resume text below.

RULES:
- Normalize job titles to standard industry titles (e.g. "Sr. SWE" → "Senior Software Engineer")
- Normalize skills to canonical names (e.g. "ReactJS" → "React", "Postgres" → "PostgreSQL")
- Estimate total years of experience from dates; if not clear, estimate from career stage
- career_summary: a concise 2-3 sentence profile of who this person is professionally
- All output values must be in English
- If a LinkedIn or GitHub profile URL appears anywhere in the resume, extract it EXACTLY as written into linkedin_url / github_url; otherwise use null
- Return ONLY valid JSON, no markdown fences

Resume text:
${truncated}

Return this exact JSON (use null for missing fields, empty arrays [] for missing lists):
{
  "name": "full name or null",
  "likely_role": "most recent or current job title",
  "seniority_level": "junior" | "mid" | "senior" | "lead" | "executive" | null,
  "total_years_experience": number or null,
  "current_company": "string or null",
  "past_companies": ["company1", ...],
  "industries": ["industry1", ...],
  "core_skills": ["skill1", "skill2", ...] (top 8, normalized),
  "tools": ["tool1", ...] (frameworks, platforms, tools — up to 10),
  "languages": ["language1", ...] (human languages spoken, e.g. English, Hindi),
  "education": "highest degree and institution or null",
  "certifications": ["cert1", ...],
  "location": "city, country or null",
  "linkedin_url": "LinkedIn profile URL if present in the resume, else null",
  "github_url": "GitHub profile URL if present in the resume, else null",
  "career_summary": "2-3 sentence professional summary"
}`;

    let parsed: Record<string, any> | null = null;
    try {
      const aiResp = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: parsePrompt }],
        max_tokens: 600,
        temperature: 0.2,
        response_format: { type: "json_object" },
      });
      const raw = aiResp.choices[0]?.message?.content ?? "{}";
      parsed = JSON.parse(raw);
    } catch (aiErr) {
      logger.error({ aiErr }, "AI resume parsing failed");
      return res.json({ ok: false, parseError: true, message: "Couldn't fully read your resume, but you can still continue with the interview." });
    }

    /* ── Build resume signals (for scoring later) ── */
    const resumeSignals = {
      source: "resume",
      extractedAt: new Date().toISOString(),
      rawTextLength: rawText.length,
      skills: parsed.core_skills ?? [],
      tools: parsed.tools ?? [],
      industries: parsed.industries ?? [],
      seniority: parsed.seniority_level ?? null,
      yearsExperience: parsed.total_years_experience ?? null,
      companies: parsed.past_companies ?? [],
      certifications: parsed.certifications ?? [],
    };

    /* ── Persist to DB ── */
    const existing = await db
      .select({ id: candidateCareerProfilesTable.id })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(candidateCareerProfilesTable)
        .set({ resumeParsedProfile: parsed, resumeSignals, updatedAt: new Date() })
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId));
    } else {
      await db
        .insert(candidateCareerProfilesTable)
        .values({ candidateId, resumeParsedProfile: parsed, resumeSignals, updatedAt: new Date() });
    }

    await fillCandidateSocialUrlsIfEmpty(candidateId, { linkedinUrl: parsed.linkedin_url, githubUrl: parsed.github_url });
    return res.json({ ok: true, profile: parsed });
  } catch (err: any) {
    logger.error({ err }, "Resume parse route failed");
    return res.json({ ok: false, parseError: true, message: "Couldn't fully read your resume, but you can still continue with the interview." });
  }
});

/* ── POST /api/portal/career-profile/resume/parse-existing ──────────────── *
 * Downloads the candidate's already-stored resume from S3 and parses it.
 * Called on page load when resumeUrl exists but resumeParsedProfile is null.
 * No file upload needed — uses the stored objectPath from the candidates table.
 */
router.post("/portal/career-profile/resume/parse-existing", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    /* 1. Look up the stored resume URL from the candidates table */
    const [cand] = await db
      .select({ resumeUrl: candidatesTable.resumeUrl })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);

    if (!cand?.resumeUrl) {
      return res.json({ ok: false, parseError: true, message: "No resume on file." });
    }

    /* 2. Download the file from S3 */
    let fileBuffer: Buffer;
    let mimeType: string;
    try {
      const objectRef = await objectStorageService.getObjectEntityFile(cand.resumeUrl);
      mimeType = objectRef.contentType ?? "application/pdf";
      const response = await objectStorageService.downloadObject(objectRef, 0);
      const arrayBuf = await response.arrayBuffer();
      fileBuffer = Buffer.from(arrayBuf);
    } catch (downloadErr: any) {
      logger.error({ downloadErr, resumeUrl: cand.resumeUrl }, "Failed to download resume from S3");
      return res.json({ ok: false, parseError: true, message: "Couldn't retrieve your resume from storage." });
    }

    /* 3. Extract text */
    let rawText = "";
    try {
      if (mimeType === "application/pdf") {
        const result = await pdfParse(fileBuffer);
        rawText = result.text;
      } else if (
        mimeType === "application/msword" ||
        mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        const result = await mammoth.extractRawText({ buffer: fileBuffer });
        rawText = result.value;
      } else {
        return res.json({ ok: false, parseError: true, message: "Resume format not supported for auto-parsing." });
      }
    } catch (extractErr) {
      logger.error({ extractErr }, "Resume text extraction failed (parse-existing)");
      return res.json({ ok: false, parseError: true, message: "Couldn't read your resume. Try replacing it with a text-based PDF or DOCX." });
    }

    if (!rawText.trim() || rawText.trim().length < 50) {
      return res.json({ ok: false, parseError: true, message: "Resume appears to be image-only (no readable text). Try replacing it with a text-based PDF." });
    }

    /* 4. Parse into structured profile with AI */
    const truncated = rawText.slice(0, 6000);
    const parsePrompt = `You are a expert recruiter and career advisor. Extract a structured candidate profile from the resume text below.

RULES:
- Normalize job titles to standard industry titles (e.g. "Sr. SWE" → "Senior Software Engineer")
- Normalize skills to canonical names (e.g. "ReactJS" → "React", "Postgres" → "PostgreSQL")
- Estimate total years of experience from dates; if not clear, estimate from career stage
- career_summary: a concise 2-3 sentence profile of who this person is professionally
- All output values must be in English
- If a LinkedIn or GitHub profile URL appears anywhere in the resume, extract it EXACTLY as written into linkedin_url / github_url; otherwise use null
- Return ONLY valid JSON, no markdown fences

Resume text:
${truncated}

Return this exact JSON (use null for missing fields, empty arrays [] for missing lists):
{
  "name": "full name or null",
  "likely_role": "most recent or current job title",
  "seniority_level": "junior" | "mid" | "senior" | "lead" | "executive" | null,
  "total_years_experience": number or null,
  "current_company": "string or null",
  "past_companies": ["company1", ...],
  "industries": ["industry1", ...],
  "core_skills": ["skill1", "skill2", ...] (top 8, normalized),
  "tools": ["tool1", ...] (frameworks, platforms, tools — up to 10),
  "languages": ["language1", ...] (human languages spoken, e.g. English, Hindi),
  "education": "highest degree and institution or null",
  "certifications": ["cert1", ...],
  "location": "city, country or null",
  "linkedin_url": "LinkedIn profile URL if present in the resume, else null",
  "github_url": "GitHub profile URL if present in the resume, else null",
  "career_summary": "2-3 sentence professional summary"
}`;

    let parsed: Record<string, any> | null = null;
    try {
      const aiResp = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: parsePrompt }],
        max_tokens: 600,
        temperature: 0.2,
        response_format: { type: "json_object" },
      });
      const raw = aiResp.choices[0]?.message?.content ?? "{}";
      parsed = JSON.parse(raw);
    } catch (aiErr) {
      logger.error({ aiErr }, "AI resume parsing failed (parse-existing)");
      return res.json({ ok: false, parseError: true, message: "Couldn't fully read your resume, but you can still continue with the interview." });
    }

    /* 5. Persist to DB */
    const resumeSignals = {
      source: "resume",
      extractedAt: new Date().toISOString(),
      rawTextLength: rawText.length,
      skills: parsed.core_skills ?? [],
      tools: parsed.tools ?? [],
      industries: parsed.industries ?? [],
      seniority: parsed.seniority_level ?? null,
      yearsExperience: parsed.total_years_experience ?? null,
      companies: parsed.past_companies ?? [],
      certifications: parsed.certifications ?? [],
    };

    const existing = await db
      .select({ id: candidateCareerProfilesTable.id })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(candidateCareerProfilesTable)
        .set({ resumeParsedProfile: parsed, resumeSignals, updatedAt: new Date() })
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId));
    } else {
      await db
        .insert(candidateCareerProfilesTable)
        .values({ candidateId, resumeParsedProfile: parsed, resumeSignals, updatedAt: new Date() });
    }

    logger.info({ candidateId, rawTextLength: rawText.length }, "Resume auto-parsed from existing S3 object");
    await fillCandidateSocialUrlsIfEmpty(candidateId, { linkedinUrl: parsed.linkedin_url, githubUrl: parsed.github_url });
    return res.json({ ok: true, profile: parsed });
  } catch (err: any) {
    logger.error({ err }, "Resume parse-existing route failed");
    return res.json({ ok: false, parseError: true, message: "Couldn't fully read your resume, but you can still continue with the interview." });
  }
});

/* ── GET /api/portal/applications ───────────────────────────────────────── */
// Stage pipeline used for display timeline (ordered)
const STAGE_PIPELINE = [
  { key: "applied",    label: "Applied" },
  { key: "screening",  label: "Screening" },
  { key: "interview",  label: "Interview" },
  { key: "offer",      label: "Offer" },
  { key: "hired",      label: "Hired" },
];

// Maps every DB stage to the nearest pipeline index
const STAGE_INDEX: Record<string, number> = {
  sourced: 0, applied: 0,
  shortlisted: 1, phone_screen: 1, verification: 1, screening: 1,
  interview: 2, interview_scheduled: 2, interview_completed: 2, hm_review: 2, assessment: 2,
  offer: 3,
  hired: 4,
  rejected: -1, withdrawn: -1,
};

router.get("/portal/applications", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const apps = await db
      .select({
        id:          applicationsTable.id,
        stage:       applicationsTable.stage,
        matchScore:  applicationsTable.matchScore,
        notes:       applicationsTable.notes,
        createdAt:   applicationsTable.createdAt,
        updatedAt:   applicationsTable.updatedAt,
        jobId:       jobsTable.id,
        jobTitle:    jobsTable.title,
        department:  jobsTable.department,
        location:    jobsTable.location,
        workType:    jobsTable.workType,
        salaryMin:   jobsTable.salaryMin,
        salaryMax:   jobsTable.salaryMax,
      })
      .from(applicationsTable)
      .innerJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
      .where(eq(applicationsTable.candidateId, candidateId))
      .orderBy(desc(applicationsTable.createdAt));

    const data = apps.map(a => {
      const stageIdx = STAGE_INDEX[a.stage] ?? 0;
      const pipeline = STAGE_PIPELINE.map((s, i) => {
        let status: "done" | "active" | "pending" | "rejected";
        if (stageIdx === -1) {
          status = i === 0 ? "done" : "pending";
        } else if (i < stageIdx) {
          status = "done";
        } else if (i === stageIdx) {
          status = "active";
        } else {
          status = "pending";
        }
        return {
          name: s.label,
          status,
          completedAt: i < stageIdx ? a.updatedAt?.toISOString() ?? null : null,
        };
      });

      return {
        id: a.id,
        jobId: a.jobId,
        jobTitle: a.jobTitle,
        department: a.department,
        location: a.location ?? "",
        workType: a.workType ?? "",
        salaryMin: a.salaryMin,
        salaryMax: a.salaryMax,
        appliedAt: a.createdAt.toISOString(),
        currentStage: a.stage,
        matchScore: a.matchScore,
        stages: stageIdx === -1 ? "rejected" : pipeline,
        status: stageIdx === -1 ? "closed" : "active",
      };
    });

    return res.json({ data, total: data.length });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch portal applications");
    return res.status(500).json({ error: "Failed to fetch applications" });
  }
});

/* Candidate self-withdraw — lets a candidate pull out of a role they applied to
 * or were sourced for. Previously the `withdrawn` stage existed in the schema
 * but no path ever set it: candidates who wanted out had no action, and
 * recruiters kept chasing them (a silent dead-end). This sets the candidate's
 * own application to "withdrawn" (terminal, like rejected) and records the
 * decision through the governance enforcer as `candidate_withdrawn`. Authorized
 * strictly by the candidate's own user → only their own applications. */
router.post("/portal/applications/:applicationId/withdraw", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const [app] = await db.select()
      .from(applicationsTable)
      .where(and(
        eq(applicationsTable.id, req.params.applicationId),
        eq(applicationsTable.candidateId, candidateId),
      )).limit(1);
    if (!app) return res.status(404).json({ error: "Application not found" });

    // Terminal stages cannot be withdrawn from.
    if (app.stage === "withdrawn" || app.stage === "rejected" || app.stage === "hired") {
      return res.status(409).json({ error: `Cannot withdraw an application that is already ${app.stage}.` });
    }

    const reason: string | null = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 1000) : null;

    await changeCandidateStage({
      tenantId: app.tenantId,
      candidateId,
      jobId: app.jobId ?? "",
      to: "withdrawn",
      from: app.stage,
      actor: { type: "candidate", role: "candidate", id: candidateId },
      source: "candidate_portal",
      reason,
      applicationId: app.id,
    });

    /* Governance attestation — best-effort, must not roll back the withdrawal. */
    (async () => {
      try {
        const { applyHumanDecision } = await import("../lib/governance/decision-enforcement.js");
        await applyHumanDecision({
          applicationId: app.id,
          finalDecision: "candidate_withdrawn",
          decidedByUserId: "candidate_self",
          decidedByRole: "candidate" as any,
          attestation: "Candidate withdrew from this application via the candidate portal.",
          reason,
        });
      } catch (err) {
        logger.warn({ err, applicationId: app.id }, "Failed to record candidate withdrawal decision (non-fatal)");
      }
    })();

    /* Auto-capture the terminal "withdrawn" outcome so the learning loop has a
     * label. Best-effort, must not roll back the withdrawal. */
    if (app.jobId) {
      (async () => {
        try {
          const { recordTerminalOutcome } = await import("../lib/record-terminal-outcome.js");
          await recordTerminalOutcome({
            tenantId: app.tenantId,
            applicationId: app.id,
            candidateId,
            jobId: app.jobId,
            outcome: "withdrawn",
            source: "auto:portal-withdraw",
          });
        } catch (err) {
          logger.warn({ err, applicationId: app.id }, "Failed to auto-capture withdrawal outcome (non-fatal)");
        }
      })();
    }

    return res.json({ ok: true, stage: updated?.stage ?? "withdrawn" });
  } catch (err: any) {
    logger.error({ err }, "Failed to withdraw application");
    return res.status(500).json({ error: "Failed to withdraw application" });
  }
});

/* ── GET /api/portal/interviews ──────────────────────────────────────────── */
router.get("/portal/interviews", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    // Scheduled interviews (from interview_schedules + applications + jobs)
    const candidateApps = await db
      .select({ id: applicationsTable.id, jobId: applicationsTable.jobId })
      .from(applicationsTable)
      .where(eq(applicationsTable.candidateId, candidateId));

    const scheduled: any[] = [];
    for (const app of candidateApps) {
      const [job] = await db
        .select({ title: jobsTable.title, department: jobsTable.department, location: jobsTable.location })
        .from(jobsTable)
        .where(eq(jobsTable.id, app.jobId))
        .limit(1);

      const scheds = await db
        .select()
        .from(interviewSchedulesTable)
        .where(eq(interviewSchedulesTable.applicationId, app.id))
        .orderBy(desc(interviewSchedulesTable.scheduledAt));

      for (const s of scheds) {
        if (s.status === "cancelled") continue;
        scheduled.push({
          id: s.id,
          jobTitle: job?.title ?? "Interview",
          department: job?.department ?? null,
          location: job?.location ?? null,
          type: s.type,
          status: s.status,
          scheduledAt: s.scheduledAt.toISOString(),
          duration: s.durationMinutes,
          score: null,
          feedback: null,
          source: "schedule",
        });
      }
    }

    /* Upcoming AI interviews (interview_sessions not yet taken). Recruiters
     * launch these directly — there is no interview_schedules row — so without
     * this block a candidate with a pending AI interview sees an empty
     * "Upcoming" tab. The Join button links to /interviews/:id/room, which is
     * gated server-side (session cookie mint + job-approval gate), so listing
     * the session here grants nothing extra. Expired sessions are skipped. */
    const PENDING_SESSION_STATUSES = ["scheduled", "invited", "opened", "verified", "active", "paused", "in_progress"] as const;
    const now = Date.now();
    const pendingSessions = await db
      .select()
      .from(interviewSessionsTable)
      .where(and(
        eq(interviewSessionsTable.candidateId, candidateId),
        inArray(interviewSessionsTable.status, PENDING_SESSION_STATUSES as unknown as string[])
      ))
      .orderBy(desc(interviewSessionsTable.createdAt));

    for (const s of pendingSessions) {
      const expiry = (s as any).expiresAt ?? s.inviteExpiresAt;
      if (expiry && new Date(expiry).getTime() < now) continue;
      let jobTitle = "Screening Interview";
      let department: string | null = null;
      if (s.applicationId) {
        const [app] = await db.select({ jobId: applicationsTable.jobId })
          .from(applicationsTable).where(eq(applicationsTable.id, s.applicationId)).limit(1);
        if (app) {
          const [job] = await db.select({ title: jobsTable.title, department: jobsTable.department })
            .from(jobsTable).where(eq(jobsTable.id, app.jobId)).limit(1);
          if (job) { jobTitle = job.title; department = job.department; }
        }
      }
      scheduled.push({
        id: s.id,
        jobTitle,
        department,
        location: null,
        type: "ai_interview",
        /* The frontend treats "pending"/"confirmed" as upcoming regardless of
         * date, so map every pre-completion session status to "pending". */
        status: "pending",
        scheduledAt: (s.inviteSentAt ?? s.createdAt).toISOString(),
        duration: null,
        score: null,
        feedback: null,
        source: "session",
      });
    }

    /* Completed interviews shown to the candidate.
     *
     * Two kinds appear, with different visibility rules:
     *   1. Recruiter-initiated screening interviews (`interview_sessions`) — the
     *      candidate can SEE that the interview happened, but its RESULTS (score
     *      + feedback) are withheld (recruiter-side only). The career baseline is
     *      NOT stored here (it lives on the career profile, injected below), so
     *      any row here is a recruiter screening; default its label to "Screening
     *      Interview" — never "Career Baseline Interview" — when no job resolves
     *      (e.g. pipeline launches with a placeholder applicationId).
     *   2. The candidate's own mock/practice interviews (`prep_sessions`) — these
     *      DO show results (readiness score). */
    const sessions = await db
      .select()
      .from(interviewSessionsTable)
      .where(and(
        eq(interviewSessionsTable.candidateId, candidateId),
        eq(interviewSessionsTable.status, "completed")
      ))
      .orderBy(desc(interviewSessionsTable.completedAt));

    const recruiterSessions = await Promise.all(sessions.map(async s => {
      let jobTitle = "Screening Interview";
      let department: string | null = null;
      if (s.applicationId) {
        const [app] = await db.select({ jobId: applicationsTable.jobId })
          .from(applicationsTable).where(eq(applicationsTable.id, s.applicationId)).limit(1);
        if (app) {
          const [job] = await db.select({ title: jobsTable.title, department: jobsTable.department })
            .from(jobsTable).where(eq(jobsTable.id, app.jobId)).limit(1);
          if (job) { jobTitle = job.title; department = job.department; }
        }
      }
      return {
        id: s.id,
        jobTitle,
        department,
        type: "ai_interview",
        status: "completed",
        scheduledAt: s.completedAt?.toISOString() ?? s.createdAt.toISOString(),
        duration: null,
        score: null,      // results withheld from the candidate
        feedback: null,   // results withheld from the candidate
        source: "session",
      };
    }));

    const MOCK_MODE_LABELS: Record<string, string> = {
      quick:            "Quick Practice",
      full:             "Full Mock Interview",
      mock_interview:   "Mock Interview",
      behavioral:       "Behavioral Practice",
      technical:        "Technical Practice",
      competency:       "Competency Practice",
      product_sense:    "Product Sense Practice",
      domain_deep_dive: "Domain Deep Dive",
    };

    const { prepSessionsTable } = await import("@workspace/db");
    const mockSessions = await db
      .select()
      .from(prepSessionsTable)
      .where(and(
        eq(prepSessionsTable.candidateId, candidateId),
        eq(prepSessionsTable.status, "completed"),
      ))
      .orderBy(desc(prepSessionsTable.updatedAt));

    const mockCompleted = mockSessions.map(m => ({
      id: m.id,
      jobTitle: MOCK_MODE_LABELS[m.mode] ?? "Mock Interview",
      department: null,
      type: "mock",
      status: "completed",
      scheduledAt: (m.updatedAt ?? m.createdAt).toISOString(),
      duration: null,
      score: m.readinessScore != null ? Math.round(m.readinessScore) : null,  // results shown
      feedback: null,
      source: "mock",
    }));

    const completedSessions: any[] = [...recruiterSessions, ...mockCompleted];

    // ── Also surface the Career Baseline Interview ──────────────────────────
    // The baseline "Career Engine" interview is stored on the career profile
    // (not interview_sessions), so include it here when the candidate has
    // completed it. Without this, candidates who took the career interview
    // see an empty "Completed" tab on My Interviews.
    const [careerProfile] = await db
      .select({
        baselineInterviewCompleted: candidateCareerProfilesTable.baselineInterviewCompleted,
        updatedAt: candidateCareerProfilesTable.updatedAt,
      })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    if (careerProfile?.baselineInterviewCompleted) {
      const alreadyHasBaseline = completedSessions.some(
        (s: any) => s.source === "baseline"
      );
      if (!alreadyHasBaseline) {
        completedSessions.push({
          id: `career-baseline-${candidateId}`,
          jobTitle: "Career Baseline Interview",
          department: null,
          type: "ai_interview",
          status: "completed",
          scheduledAt: (careerProfile.updatedAt ?? new Date()).toISOString(),
          duration: null,
          score: null,
          feedback: null,
          source: "baseline",
        });
      }
    }

    return res.json({
      data: {
        scheduled,
        completed: completedSessions.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)),
      },
      total: scheduled.length + completedSessions.length,
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch portal interviews");
    return res.status(500).json({ error: "Failed to fetch interviews" });
  }
});

/* ── GET /api/portal/opportunities ──────────────────────────────────────── */
router.get("/portal/opportunities", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const profile = await db
      .select()
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    const p = profile[0];

    // No profile yet — don't show random jobs; tell the frontend to prompt profile completion
    if (!p) {
      return res.json({ data: [], total: 0, matchedCount: 0, noProfile: true });
    }

    // Also fetch the raw candidate record — it holds the ground-truth currentTitle + skills
    // from their resume/import, which we use as a fallback when the career profile is sparse.
    const [cand] = await db
      .select({ currentTitle: candidatesTable.currentTitle, skills: candidatesTable.skills })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);

    const jobs = await db
      .select({
        id:             jobsTable.id,
        title:          jobsTable.title,
        department:     jobsTable.department,
        location:       jobsTable.location,
        workType:       jobsTable.workType,
        employmentType: jobsTable.employmentType,
        salaryMin:      jobsTable.salaryMin,
        salaryMax:      jobsTable.salaryMax,
        description:    jobsTable.description,
        status:         jobsTable.status,
        tenantId:       jobsTable.tenantId,
        company:        tenantsTable.name,
      })
      .from(jobsTable)
      .leftJoin(tenantsTable, eq(jobsTable.tenantId, tenantsTable.id))
      .where(inArray(jobsTable.status, ["active", "paused"]))
      .orderBy(desc(jobsTable.createdAt))
      .limit(80);

    if (jobs.length === 0) {
      return res.json({ data: [], total: 0, matchedCount: 0 });
    }

    // Explicit profile preferences
    const preferredRoles: string[]     = (p.preferredRoles   as string[]) ?? [];
    const targetIndustries: string[]   = (p.targetIndustries as string[]) ?? [];
    const skills: string[]             = (p.skills           as string[]) ?? [];
    const preferredWorkStyle: string | null = p.preferredWorkStyle as string | null;

    // Augment with resume-parsed data when explicit preferences are sparse
    const resumeProfile: any = p.resumeParsedProfile ?? {};
    const resumeSkills: string[]      = resumeProfile?.core_skills   ?? resumeProfile?.skills   ?? [];
    const resumeTools: string[]       = resumeProfile?.tools         ?? [];
    const resumeRole: string          = resumeProfile?.likely_role   ?? "";
    const resumeIndustries: string[]  = resumeProfile?.industries    ?? [];
    const resumeSummary: string       = resumeProfile?.career_summary ?? "";

    // Ground-truth from the candidates table (import / recruiter-entered)
    const candTitle: string    = cand?.currentTitle ?? "";
    const candSkills: string[] = (cand?.skills as string[]) ?? [];

    // Merge: explicit prefs → resume-parsed → career-profile currentTitle → candidates currentTitle
    // The candidates table title is the most reliable fallback — it comes from a real import/resume.
    const currentTitle: string = (p.currentTitle as string) || candTitle;
    const rawRoles       = [...new Set([...preferredRoles, ...(resumeRole ? [resumeRole] : [])])];
    // If no roles from prefs or resume, fall back to current title (career profile first, then candidates table)
    const allRoles       = rawRoles.length > 0 ? rawRoles : (currentTitle ? [currentTitle] : []);
    const allIndustries  = [...new Set([...targetIndustries, ...resumeIndustries])];
    // Merge profile skills + resume skills + candidates-table skills (deduped)
    const allSkills      = [...new Set([...skills, ...resumeSkills, ...resumeTools, ...candSkills])];

    const hasAnySignal = allRoles.length > 0 || allIndustries.length > 0 || allSkills.length > 0 || resumeSummary.length > 20;

    // If we have no signal at all (fresh candidate, no resume, no interview), return noProfile
    if (!hasAnySignal) {
      return res.json({ data: [], total: 0, matchedCount: 0, noProfile: true });
    }

    // CRITICAL: if we still have no role signal (no title anywhere), we must not let pure
    // skill matches surface unrelated jobs.  Without a role anchor the gate below is disabled,
    // so we return noProfile to prompt the candidate to complete their profile interview.
    if (allRoles.length === 0) {
      return res.json({ data: [], total: 0, matchedCount: 0, noProfile: true });
    }

    // Synonym / stem expansions for common skill/role terms
    const SYNONYMS: Record<string, string[]> = {
      management:    ["manager", "managing", "director", "vp"],
      programming:   ["software", "engineer", "developer", "dev", "coding", "code"],
      "website development": ["web", "frontend", "fullstack", "full-stack"],
      // NOTE: "head" intentionally excluded — it is a standalone title word that causes
      // compound roles like "IT Head" to falsely match "Head of Marketing"
      leadership:    ["lead", "director", "vp", "chief"],
      technology:    ["it", "tech", "engineering", "software", "systems", "infrastructure"],
      information:   ["it", "tech", "data", "systems", "digital"],
      analytics:     ["analyst", "analysis", "data", "insights"],
      sales:         ["revenue", "business development", "account"],
      marketing:     ["growth", "brand", "campaign", "content"],
      finance:       ["financial", "accounting", "controller", "cfo"],
      hr:            ["people", "talent", "recruiting", "human resources"],
      operations:    ["ops", "process", "efficiency"],
      design:        ["ux", "ui", "product design", "creative"],
      ai:            ["machine learning", "ml", "artificial intelligence", "nlp", "data science"],
      nursing:       ["nurse", "clinical", "healthcare", "medical", "care", "patient", "hospital"],
      healthcare:    ["nurse", "clinical", "doctor", "physician", "therapist", "health", "medical"],
      teaching:      ["teacher", "educator", "instructor", "tutor", "training", "education"],
      accounting:    ["accountant", "cpa", "bookkeeper", "controller", "audit"],
      legal:         ["lawyer", "attorney", "counsel", "paralegal", "compliance"],
      logistics:     ["supply chain", "warehouse", "freight", "shipping", "procurement"],
      construction:  ["builder", "contractor", "civil", "architect", "project manager"],
    };

    function termMatches(haystack: string, term: string): boolean {
      const t = term.toLowerCase().trim();
      if (!t) return false;
      if (haystack.includes(t)) return true;
      for (const [key, syns] of Object.entries(SYNONYMS)) {
        // Block 1: the term is/contains the synonym KEY → look for synonyms in haystack
        if (t === key || t.includes(key)) {
          for (const syn of syns) if (haystack.includes(syn)) return true;
        }
        // Block 2: the term IS EXACTLY a synonym value (not a compound containing one) →
        // look for the key or sibling synonyms in haystack.
        // IMPORTANT: use exact match (syns.includes(t)), NOT substring (t.includes(s)).
        // This prevents "IT Head" from firing via "head" being inside the string.
        if (syns.includes(t)) {
          if (haystack.includes(key)) return true;
          if (syns.some(s => haystack.includes(s))) return true;
        }
      }
      // Root word match for long unambiguous terms only (min 7 chars to avoid "it", "lead" etc.)
      const root = t.split(/\s+/)[0];
      if (root.length >= 7 && haystack.includes(root)) return true;
      return false;
    }

    // Maximum possible raw score — used to normalise to 0-100%
    // Roles: up to 5 × 4 = 20 | Industries: up to 3 × 3 = 9 | Skills: cap 8 | Summary: 1 | WorkStyle: 1
    const MAX_RAW_SCORE = 5 * 4 + 3 * 3 + 8 + 1 + 1; // 39

    function scoreJob(job: typeof jobs[0]): number {
      const haystack = [
        job.title,
        job.department,
        job.location ?? "",
        job.description ?? "",
      ].join(" ").toLowerCase();

      // Preferred roles: PRIMARY gate — capped at 5 to prevent score inflation (4 pts each)
      let rolePts = 0;
      let roleMatchCount = 0;
      for (const r of allRoles.slice(0, 5)) {
        if (termMatches(haystack, r)) { rolePts += 4; roleMatchCount++; }
      }

      // GATE: if the candidate has role preferences but none match this job, skip it entirely.
      // This prevents skills like "management" or "leadership" from matching unrelated jobs.
      if (allRoles.length > 0 && roleMatchCount === 0) return 0;

      let s = rolePts;

      // Target industries: strong signal (3 pts each, max 3 industries)
      for (const ind of allIndustries.slice(0, 3)) if (termMatches(haystack, ind)) s += 3;

      // Skills: medium signal (2 pts each, cap at 8 to avoid skill-spamming)
      let skillPts = 0;
      for (const sk of allSkills) {
        if (termMatches(haystack, sk)) { skillPts += 2; if (skillPts >= 8) break; }
      }
      s += skillPts;

      // Resume summary keyword match: light signal (at most +1)
      if (resumeSummary.length > 20) {
        const summaryWords = resumeSummary.toLowerCase().split(/\W+/).filter(w => w.length >= 5);
        for (const w of summaryWords) {
          if (haystack.includes(w)) { s += 1; break; }
        }
      }

      // Work style preference bonus
      if (preferredWorkStyle && job.workType === preferredWorkStyle) s += 1;

      return s;
    }

    const scored = jobs
      .map(j => {
        const raw = scoreJob(j);
        const pct = raw === 0 ? 0 : Math.min(99, Math.round((raw / MAX_RAW_SCORE) * 100));
        return { ...j, _score: pct, _rawScore: raw, isFuture: j.status === "paused" };
      })
      .filter(j => j._rawScore >= 4)
      .sort((a, b) => {
        // Active jobs first, then future (paused) jobs; within each group sort by score desc
        if (a.isFuture !== b.isFuture) return a.isFuture ? 1 : -1;
        return b._score - a._score;
      })
      .slice(0, 8)
      .map(({ _rawScore: _r, ...rest }) => rest);

    const nowCount    = scored.filter(j => !j.isFuture).length;
    const futureCount = scored.filter(j => j.isFuture).length;
    const matchedCount = nowCount;

    return res.json({
      data: scored,
      total: scored.length,
      matchedCount,
      nowCount,
      futureCount,
      noMatches: scored.length === 0,
    });
  } catch (err: any) {
    logger.error({ err }, "Failed to fetch opportunities");
    return res.status(500).json({ error: "Failed to fetch opportunities" });
  }
});

/* ── POST /api/portal/express-interest/:jobId ────────────────────────────
 *  Candidate registers interest in a paused/upcoming role.
 *  Creates an application record in stage="sourced" with a note, or
 *  returns the existing application if already registered.
 * ─────────────────────────────────────────────────────────────────────── */
router.post("/portal/express-interest/:jobId", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { jobId } = req.params;

    // Load the job to verify it exists and get tenantId
    const [job] = await db
      .select({ id: jobsTable.id, tenantId: jobsTable.tenantId, title: jobsTable.title, status: jobsTable.status })
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1);

    if (!job) return res.status(404).json({ error: "Job not found" });

    // Check for existing application
    const existing = await db
      .select({ id: applicationsTable.id, stage: applicationsTable.stage })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.jobId, jobId), eq(applicationsTable.candidateId, candidateId)))
      .limit(1);

    if (existing.length > 0) {
      return res.json({ success: true, alreadyRegistered: true, applicationId: existing[0].id });
    }

    // Create the application in "sourced" stage (talent pipeline entry)
    const [app] = await db
      .insert(applicationsTable)
      .values({
        tenantId:    job.tenantId,
        jobId,
        candidateId,
        stage:       "sourced" as any,
        notes:       "Candidate expressed interest via portal (role not yet open).",
        ...originFields("inbound", { via: "portal_express_interest" }, candidateId),
      })
      .returning({ id: applicationsTable.id });

    void logCandidateEvent({
      candidateId,
      jobId,
      tenantId: job.tenantId ?? "",
      applicationId: app.id,
      eventType: "JOB_MATCHED",
      actorType: "candidate",
      source: "lexy_app",
      metadata: { stage: "sourced", via: "portal_express_interest" },
    });

    return res.json({ success: true, alreadyRegistered: false, applicationId: app.id });
  } catch (err: any) {
    logger.error({ err }, "Failed to register express interest");
    return res.status(500).json({ error: "Failed to register interest" });
  }
});

/* ── POST /api/portal/tts ─────────────────────────────────────────────────
 *  Converts text to speech. Routes Indian languages to Azure Speech Service
 *  (Neural voices) and all others to OpenAI TTS.
 *  Accepts: { text, voice, language }
 *  Strips emojis and markdown before synthesis so they aren't read aloud.
 * ─────────────────────────────────────────────────────────────────────── */
router.post("/portal/tts", validate({ body: TtsBody }), async (req: any, res) => {
  try {
    /* Auth gate — TTS bills the OpenAI / Azure account; never expose it
       unauthenticated. */
    const callerId = await getCandidateId(req);
    if (!callerId) return res.status(401).json({ error: "Unauthorized" });
    const { text, voice: rawVoice, language = "en-US" } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "text required" });
    }

    /* Remove all emoji codepoints and common markdown */
    const clean = text
      .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")   // supplementary multilingual plane emoji
      .replace(/[\u{2600}-\u{27BF}]/gu, "")      // misc symbols, dingbats
      .replace(/[\u{FE00}-\u{FE0F}]/gu, "")      // variation selectors
      .replace(/\*\*/g, "")                       // bold markdown
      .replace(/\*/g, "")                         // italic markdown
      .replace(/#{1,6}\s/g, "")                  // headings
      .replace(/\s{2,}/g, " ")                   // collapse multiple spaces
      .trim();

    if (!clean) return res.status(400).json({ error: "No speakable text after cleaning" });

    /* ── Route Indian languages to Azure Speech ── */
    const langMeta = resolveLangMeta(language);
    if (langMeta.speechProvider === "azure" && langMeta.region === "indian") {
      logger.info({ language, azureVoice: langMeta.azureVoice }, "TTS → Azure Speech");
      const buffer = await synthesizeSpeechAzure(clean, langMeta.azureLocale, langMeta.azureVoice);
      if (buffer) {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Length", buffer.length);
        res.setHeader("Cache-Control", "no-store");
        return res.end(buffer);
      }
      logger.warn({ language }, "Azure Speech failed — falling back to OpenAI TTS");
    }

    /* ── Default: OpenAI TTS ── */
    const VALID_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
    const voice = VALID_VOICES.includes(rawVoice) ? rawVoice : "shimmer";

    /* Use direct API key (no proxy base URL) — Replit AI proxy does not support audio/speech */
    const ttsApiKey = process.env.OPENAI_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    if (!ttsApiKey) return res.status(503).json({ error: "TTS not configured" });
    const { default: OpenAI } = await import("openai");
    const ttsClient = new OpenAI({ apiKey: ttsApiKey });

    const mp3 = await ttsClient.audio.speech.create({
      model: "tts-1-hd",
      voice: voice as any,
      input: clean,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.end(buffer);
  } catch (err: any) {
    logger.error({ err }, "TTS failed");
    return res.status(500).json({ error: "TTS failed" });
  }
});

/* ── POST /api/portal/career-interview/recording-upload-url ─────────────── */
// Returns a pre-signed S3 PUT URL so the browser uploads the video blob
// directly to S3 without streaming bytes through the API server.
router.post("/portal/career-interview/recording-upload-url", validate({ body: RecordingUploadUrlBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    if (!isS3Configured()) {
      return res.status(503).json({
        error: "Video recording storage is not configured. Set AWS_S3_BUCKET, AWS_REGION, and AWS credentials.",
      });
    }

    const { filename = "interview.webm" } = req.body;
    const { uploadUrl, s3Key } = await getRecordingUploadUrl(candidateId, filename);
    return res.json({ uploadUrl, objectPath: s3Key });
  } catch (err: any) {
    logger.error({ err }, "recording-upload-url failed");
    return res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/* ── POST /api/portal/career-interview/save-recording ───────────────────── */
// Saves the recording object path and duration to the candidate's career profile.
router.post("/portal/career-interview/save-recording", validate({ body: SaveRecordingBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { objectPath, durationSec, recordingSessionId } = req.body;
    const dur = typeof durationSec === "number" && Number.isFinite(durationSec) ? durationSec : null;

    // ── Early-abandon gate ────────────────────────────────────────────────
    // If the candidate closed the interview before the minimum length (~10s),
    // there is no useful footage to surface. Don't write a recordingUrl (which
    // would render a broken/empty player to recruiters); instead mark the
    // profile so recruiters can see the interview was ended early. This call
    // typically arrives via the page-unload keepalive beacon.
    if (dur !== null && dur < 10) {
      const [existing] = await db
        .select({ recordingUrl: candidateCareerProfilesTable.recordingUrl })
        .from(candidateCareerProfilesTable)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
        .limit(1);
      // If real footage already exists (e.g. a part was uploaded at ~10s and
      // the server wrote the pointer), keep it — don't mislabel it as abandoned.
      if (existing?.recordingUrl) return res.json({ ok: true });

      await db
        .insert(candidateCareerProfilesTable)
        .values({ candidateId, recordingStatus: "abandoned_early" })
        .onConflictDoUpdate({
          target: candidateCareerProfilesTable.candidateId,
          set: { recordingStatus: "abandoned_early", updatedAt: new Date() },
        });
      logger.info({ candidateId, durationSec: dur }, "Interview recording abandoned early (<10s)");
      return res.json({ ok: true, abandonedEarly: true });
    }

    // Accept either a finished single-file objectPath (legacy) or a
    // recordingSessionId that identifies a folder of sequentially-numbered
    // screen-recording parts (new live-chunk approach).
    const resolvedUrl = objectPath
      || (recordingSessionId ? `/recordings/${recordingSessionId}/` : null);

    if (!resolvedUrl) return res.status(400).json({ error: "objectPath or recordingSessionId required" });

    // Use upsert so the recording URL is persisted regardless of whether
    // the career profile row exists yet.  The /complete endpoint fires an
    // AI pipeline that can take 30-60 s to create the row — if save-recording
    // ran first (which is common because chunk uploads finish in seconds while
    // the 8 s delay before /complete plus its AI latency is much longer) a
    // plain UPDATE would silently affect 0 rows and the recording URL would
    // be lost.  With ON CONFLICT DO UPDATE the recording is always stored:
    //   • Row doesn't exist yet → INSERT a lightweight stub (just recording
    //     info); /complete will UPDATE all the other fields later and the
    //     recordingUrl column won't be in its SET clause so it is preserved.
    //   • Row already exists    → UPDATE only the recording columns, leaving
    //     everything else intact.
    await db
      .insert(candidateCareerProfilesTable)
      .values({
        candidateId,
        recordingUrl: resolvedUrl,
        recordingDurationSec: dur ? Math.round(dur) : null,
        recordingStatus: null,
      })
      .onConflictDoUpdate({
        target: candidateCareerProfilesTable.candidateId,
        set: {
          recordingUrl: resolvedUrl,
          recordingDurationSec: dur ? Math.round(dur) : null,
          // Clear any prior early-abandon mark now that real footage is saved.
          recordingStatus: null,
          updatedAt: new Date(),
        },
      });

    logger.info({ candidateId, objectPath, durationSec, resolvedUrl }, "Interview recording saved (upserted)");
    return res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "save-recording failed");
    return res.status(500).json({ error: "Failed to save recording" });
  }
});

/* ── GET /api/portal/career-interview/my-recording ─────────────────────── */
// Streams the candidate's own career interview recording (chunked parts).
// Auth: candidate session cookie only.
router.get("/portal/career-interview/my-recording", async (req: any, res: any) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const [profile] = await db
      .select({ recordingUrl: candidateCareerProfilesTable.recordingUrl, recordingDurationSec: candidateCareerProfilesTable.recordingDurationSec })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    if (!profile?.recordingUrl) {
      return res.status(404).json({ error: "No recording found" });
    }

    res.setHeader("Content-Type", "video/webm");
    res.setHeader("Cache-Control", "no-store");

    const folderMatch = profile.recordingUrl.match(/\/recordings\/([0-9a-f-]{36})\/?$/i);
    if (folderMatch) {
      const sessionId = folderMatch[1];
      await streamRecordingParts(sessionId, res);
      res.end();
    } else {
      /* Legacy single-object */
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const oss = new ObjectStorageService();
      const bucket = oss.getBucket();
      const privatePrefix = oss.getPrivatePrefix();
      let s3Key = profile.recordingUrl.replace(/^\/objects\//, `${privatePrefix}/`);
      if (!s3Key.startsWith(privatePrefix)) s3Key = `${privatePrefix}/${s3Key.replace(/^\//, "")}`;
      const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
      const body = resp.Body as import("stream").Readable | null;
      if (!body) return res.status(404).end();
      body.pipe(res);
    }
  } catch (err: any) {
    logger.error({ err }, "my-recording stream failed");
    if (!res.headersSent) res.status(500).json({ error: err?.message ?? "Stream failed" });
  }
});

/* ── GET /api/portal/career-interview/recording-playback-url/:candidateId ── */
// Admin endpoint: returns a time-limited signed GET URL to play back a recording.
router.get("/portal/career-interview/recording-playback-url/:candidateId", async (req: any, res) => {
  try {
    /* Authz: caller must be (a) the candidate themselves, or (b) a recruiter
       in the same tenant as the target candidate. Anything else → 404. */
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const { candidateId } = req.params;
    const [caller] = await db.select({ id: usersTable.id, role: usersTable.role, email: usersTable.email, tenantId: usersTable.tenantId })
      .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!caller) return res.status(401).json({ error: "Unauthorized" });
    const [target] = await db.select({ id: candidatesTable.id, userId: candidatesTable.userId, tenantId: candidatesTable.tenantId })
      .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!target) return res.status(404).json({ error: "Not found" });
    /* Self-check is by FK (candidates.user_id === caller.id), NOT by email.
     * Email equality was a shadowing vector — a candidate whose email matched
     * another candidate's could read that other candidate's recording. */
    const isSelf = caller.role === "candidate" && target.userId === caller.id;
    const isStaff = ["recruiter", "admin", "platform_admin"].includes(caller.role)
      && (caller.role === "platform_admin" || caller.tenantId === target.tenantId);
    if (!isSelf && !isStaff) return res.status(404).json({ error: "Not found" });

    const [profile] = await db
      .select({ recordingUrl: candidateCareerProfilesTable.recordingUrl, durationSec: candidateCareerProfilesTable.recordingDurationSec })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    if (!profile?.recordingUrl) {
      return res.status(404).json({ error: "No recording found for this candidate" });
    }

    const playbackUrl = await getRecordingPlaybackUrl(profile.recordingUrl);
    return res.json({ playbackUrl, durationSec: profile.durationSec });
  } catch (err: any) {
    logger.error({ err }, "recording-playback-url failed");
    return res.status(500).json({ error: "Failed to generate playback URL" });
  }
});

/* ── POST /api/portal/activity-ping ──────────────────────────────────────── */
router.post("/portal/activity-ping", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [streak] = await db
      .select()
      .from(candidateActivityStreaksTable)
      .where(eq(candidateActivityStreaksTable.candidateId, candidateId))
      .limit(1);

    if (!streak) {
      await db.insert(candidateActivityStreaksTable).values({
        candidateId,
        currentStreak: 1,
        longestStreak: 1,
        totalSessions: 1,
        lastActivityAt: now,
      });
      return res.json({ streak: 1, totalSessions: 1, isNewDay: true });
    }

    const lastActivity = streak.lastActivityAt;
    const lastDayStart = lastActivity
      ? new Date(lastActivity.getFullYear(), lastActivity.getMonth(), lastActivity.getDate())
      : null;

    const isNewDay = !lastDayStart || lastDayStart.getTime() < todayStart.getTime();
    const isConsecutive = lastDayStart
      ? todayStart.getTime() - lastDayStart.getTime() <= 86400000
      : false;

    const newStreak = isNewDay ? (isConsecutive ? streak.currentStreak + 1 : 1) : streak.currentStreak;
    const newTotal  = isNewDay ? streak.totalSessions + 1 : streak.totalSessions;

    await db.update(candidateActivityStreaksTable)
      .set({
        currentStreak: newStreak,
        longestStreak: Math.max(newStreak, streak.longestStreak),
        totalSessions: newTotal,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(candidateActivityStreaksTable.candidateId, candidateId));

    return res.json({ streak: newStreak, totalSessions: newTotal, isNewDay });
  } catch (err: any) {
    logger.error({ err }, "activity-ping failed");
    return res.status(500).json({ error: "Failed to record activity" });
  }
});

/* ── GET /api/portal/career-progress ────────────────────────────────────── */
router.get("/portal/career-progress", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const [profile] = await db
      .select()
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
      .limit(1);

    const [streak] = await db
      .select()
      .from(candidateActivityStreaksTable)
      .where(eq(candidateActivityStreaksTable.candidateId, candidateId))
      .limit(1);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const snapshots = await db
      .select()
      .from(candidateProgressSnapshotsTable)
      .where(
        and(
          eq(candidateProgressSnapshotsTable.candidateId, candidateId),
          gte(candidateProgressSnapshotsTable.createdAt, sevenDaysAgo)
        )
      )
      .orderBy(desc(candidateProgressSnapshotsTable.createdAt))
      .limit(7);

    const recentActions = await db
      .select()
      .from(candidateActionEventsTable)
      .where(
        and(
          eq(candidateActionEventsTable.candidateId, candidateId),
          gte(candidateActionEventsTable.createdAt, sevenDaysAgo)
        )
      )
      .orderBy(desc(candidateActionEventsTable.createdAt))
      .limit(20);

    const oldest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

    const { score: readinessScore, breakdown: readinessBreakdown } = computeReadinessScore({
      baselineInterviewCompleted: profile?.baselineInterviewCompleted ?? false,
      skills:        (profile?.skills as string[])        ?? [],
      yearsExperience: profile?.yearsExperience           ?? 0,
      careerGoal3yr: profile?.careerGoal3yr               ?? null,
      careerGoal5yr: profile?.careerGoal5yr               ?? null,
      preferredRoles: (profile?.preferredRoles as string[]) ?? [],
      strengthAreas: (profile?.strengthAreas as string[]) ?? [],
      growthAreas:   (profile?.growthAreas as string[])   ?? [],
      careerPaths:   (profile?.careerPaths as any[])      ?? [],
      aiSummary:     profile?.aiSummary                   ?? null,
      interviewQualityScore: profile?.interviewQualityScore ?? 100,
    });

    // Only show a delta when the oldest snapshot had a non-zero baseline.
    // A baseline of 0 means the snapshot was taken before any profile data existed,
    // so the delta would equal the current value and be misleading.
    const readinessDelta = (oldest && oldest.readinessScore > 0)
      ? readinessScore - oldest.readinessScore
      : null;
    const profileDelta = (oldest && oldest.profileCompleteness > 0 && profile)
      ? (profile.profileCompleteness ?? 0) - oldest.profileCompleteness
      : null;

    /* Viewer-privacy seal (lib/viewer-privacy.ts): paused → the "you were
       seen" stat goes quiet; blocked/hidden viewer tenants are dropped from
       both the count and the recentActions feed. */
    const { getViewerPrivacySeal } = await import("../lib/viewer-privacy.js");
    const viewerSeal = await getViewerPrivacySeal(candidateId);
    const sealedActions = recentActions.filter((e: any) =>
      e.eventType !== "recruiter_view" ||
      (!viewerSeal.viewsPaused && !viewerSeal.isTenantExcluded(e.viewerTenantId)));

    const practiceSessionsThisWeek = recentActions.filter(e => e.eventType === "practice_session").length;
    const opportunitiesUnlocked    = recentActions.filter(e => e.eventType === "opportunity_unlocked").length;
    const recruiterViewsThisWeek   = sealedActions.filter(e => e.eventType === "recruiter_view").length;

    await db.insert(candidateProgressSnapshotsTable).values({
      candidateId,
      readinessScore,
      profileCompleteness: profile?.profileCompleteness ?? 0,
      opportunitiesCount: 0,
      visibilityScore: 0,
      recruiterViews: 0,
    });

    return res.json({
      readinessScore,
      readinessBreakdown,
      readinessDelta,
      profileDelta,
      streak: {
        current: streak?.currentStreak ?? 0,
        longest: streak?.longestStreak ?? 0,
        totalSessions: streak?.totalSessions ?? 0,
        lastActivityAt: streak?.lastActivityAt ?? null,
      },
      weeklyStats: {
        practiceSessionsThisWeek,
        opportunitiesUnlocked,
        recruiterViewsThisWeek,
        profileImproved: (profileDelta ?? 0) > 0,
      },
      recentActions: sealedActions.slice(0, 5),
    });
  } catch (err: any) {
    logger.error({ err }, "career-progress failed");
    return res.status(500).json({ error: "Failed to fetch career progress" });
  }
});

/* ── POST /api/portal/log-action ─────────────────────────────────────────── */
router.post("/portal/log-action", validate({ body: LogActionBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
    const { eventType, payload } = req.body as { eventType: string; payload?: Record<string, any> };
    if (!eventType) return res.status(400).json({ error: "eventType required" });
    /* Reserved system event types: only trusted server paths may write these.
       "recruiter_view" drives the viewer-privacy seal (lib/viewer-privacy.ts)
       and the who-viewed-you surfaces — a candidate-supplied insert here could
       spoof view counts / burst emails. "role_open_at_target" is emitted only
       by lib/market-event-emitter.ts on real job creation. */
    const RESERVED_EVENT_TYPES = new Set(["recruiter_view", "role_open_at_target"]);
    if (RESERVED_EVENT_TYPES.has(eventType)) {
      return res.status(400).json({ error: "Reserved event type" });
    }
    await db.insert(candidateActionEventsTable).values({ candidateId, eventType, payload: payload ?? {} });
    return res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "log-action failed");
    return res.status(500).json({ error: "Failed to log action" });
  }
});

/* ── GET /api/portal/career-benchmark ────────────────────────────────────── */
/*
 * Returns anonymised aggregate benchmarks across all candidates who have
 * completed the baseline interview.
 *
 * Minimum sample-size rules (per spec):
 *   < 50  → available: false ("not enough data yet")
 *   50-99 → available: true, broad averages only (no percentiles)
 *   ≥ 100 → available: true, full averages + P25/P75 percentiles
 *
 * NEVER exposes individual candidate data.
 */
router.get("/portal/career-benchmark", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const MIN_BROAD    = 50;
    const MIN_PERCENTILE = 100;

    // Count candidates who completed the baseline interview
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.baselineInterviewCompleted, true));

    if (total < MIN_BROAD) {
      return res.json({
        available: false,
        reason: "insufficient_data",
        count: total,
        threshold: MIN_BROAD,
      });
    }

    // Compute averages from the latest snapshot per candidate
    // Using candidateProgressSnapshotsTable which stores readiness_score + profile_completeness
    const [agg] = await db
      .select({
        avgReadiness:  sql<number>`round(avg(readiness_score)::numeric, 1)`,
        avgProfile:    sql<number>`round(avg(profile_completeness)::numeric, 1)`,
        p25Readiness:  sql<number>`round((percentile_cont(0.25) within group (order by readiness_score))::numeric, 1)`,
        p75Readiness:  sql<number>`round((percentile_cont(0.75) within group (order by readiness_score))::numeric, 1)`,
      })
      .from(candidateProgressSnapshotsTable);

    const showPercentiles = total >= MIN_PERCENTILE;

    return res.json({
      available: true,
      count: total,
      showPercentiles,
      averages: {
        readiness:          Number(agg?.avgReadiness ?? 0),
        profileCompleteness: Number(agg?.avgProfile ?? 0),
        p25:                showPercentiles ? Number(agg?.p25Readiness ?? 0) : null,
        p75:                showPercentiles ? Number(agg?.p75Readiness ?? 0) : null,
      },
    });
  } catch (err: any) {
    logger.error({ err }, "career-benchmark failed");
    return res.status(500).json({ error: "Failed to fetch benchmark data" });
  }
});

/* ── POST /api/portal/track-click ────────────────────────────────────────── */
router.post("/portal/track-click", validate({ body: TrackClickBody }), async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const { jobId, jobTitle, company, sourceUrl, isExternal = false } = req.body;

    const { recordClick } = await import("../lib/external-click-engine");
    await recordClick({ candidateId, jobId, jobTitle, company, sourceUrl, isExternal });

    return res.json({ ok: true });
  } catch (err: any) {
    logger.error({ err }, "track-click failed");
    return res.status(500).json({ error: "Failed to record click" });
  }
});

/* ── GET /api/portal/click-analytics (recruiter-facing) ─────────────────── */
router.get("/portal/click-analytics", async (req: any, res) => {
  try {
    /* Recruiter-facing analytics — must be authenticated. */
    const userId = getAuthUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const [caller] = await db.select({ role: usersTable.role, tenantId: usersTable.tenantId })
      .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!caller || !["recruiter", "admin", "platform_admin"].includes(caller.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    /* Tenant scope — platform_admin sees everything; everyone else sees only
       clicks belonging to candidates in their own tenant. */
    const tenantScope = caller.role === "platform_admin" ? null : (caller.tenantId ?? "__none__");
    const { getClickAnalytics } = await import("../lib/external-click-engine");
    const data = await getClickAnalytics(tenantScope);
    return res.json(data);
  } catch (err: any) {
    logger.error({ err }, "click-analytics failed");
    return res.status(500).json({ error: "Failed to fetch click analytics" });
  }
});

/* ── GET /portal/activity-status ─────────────────────────────────────────── */
router.get("/portal/activity-status", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const [candidate] = await db
      .select({
        updatedAt:      candidatesTable.updatedAt,
        currentTitle:   candidatesTable.currentTitle,
        currentCompany: candidatesTable.currentCompany,
      })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);

    // If no candidate row exists, treat as newly active (graceful fallback)
    const baseDate = candidate?.updatedAt ? new Date(candidate.updatedAt as any) : new Date();

    const [pushRow] = await db
      .select({ maxPushedAt: sql<string>`MAX(${(talentPoolSubmissionsTable as any).pushedAt})` })
      .from(talentPoolSubmissionsTable)
      .where(eq((talentPoolSubmissionsTable as any).candidateId, candidateId));

    const lastPush     = pushRow?.maxPushedAt ? new Date(pushRow.maxPushedAt) : null;
    const lastActiveAt = lastPush && lastPush > baseDate ? lastPush : baseDate;
    const daysSince    = Math.floor((Date.now() - lastActiveAt.getTime()) / 86_400_000);
    const activityStatus =
      daysSince <= 30 ? "active" :
      daysSince <= 90 ? "passive" : "inactive";

    const [countRow] = await db
      .select({ cnt: count() })
      .from(talentPoolSubmissionsTable)
      .where(eq((talentPoolSubmissionsTable as any).candidateId, candidateId));

    return res.json({
      activityStatus,
      lastActiveAt:        lastActiveAt.toISOString(),
      daysSince,
      companiesInterested: Number(countRow?.cnt ?? 0),
      /* Powers the "Still at [Company]?" one-tap confirm in the portal banner. */
      currentCompany:      candidate?.currentCompany ?? null,
      currentTitle:        candidate?.currentTitle ?? null,
    });
  } catch (err: any) {
    logger.error({ err }, "activity-status failed");
    return res.status(500).json({ error: "Failed to fetch activity status" });
  }
});

/* ── POST /portal/refresh-activity ──────────────────────────────────────── */
router.post("/portal/refresh-activity", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const now = new Date();
    await db.update(candidatesTable)
      .set({ updatedAt: now })
      .where(eq(candidatesTable.id, candidateId));

    const [countRow] = await db
      .select({ cnt: count() })
      .from(talentPoolSubmissionsTable)
      .where(eq((talentPoolSubmissionsTable as any).candidateId, candidateId));

    return res.json({
      activityStatus:      "active",
      lastActiveAt:        now.toISOString(),
      daysSince:           0,
      companiesInterested: Number(countRow?.cnt ?? 0),
    });
  } catch (err: any) {
    logger.error({ err }, "refresh-activity failed");
    return res.status(500).json({ error: "Failed to refresh activity" });
  }
});

/* ── GET /portal/me/export ──────────────────────────────────────────────────
   Self-service GDPR Article 20 (right to data portability) / CCPA "right to
   know" companion to DELETE /portal/me below.

   Returns a single JSON document containing every row of personal data the
   candidate is the data subject of, drawn from the same tables that the
   erasure cascade touches. Sent inline as a downloadable attachment so the
   candidate can save it without piping through the browser address bar.

   Scope (deliberately bounded to data the candidate IS the subject of —
   not data ABOUT recruiters who interacted with them, which would be a
   third-party-data leak):
     • candidates (their own row, full PII)
     • candidate_career_profiles
     • applications they submitted
     • interview_sessions (incl. answers + proctoring events; recordingUrl
       is a presigned download — they get the URL, not the bytes)
     • outreach_messages addressed to them
     • communication_events sent to them
     • candidate_action_events (their clicks / opens)
     • candidate_skill_scores
     • verification_records

   Excluded by design:
     • audit_logs — these reference the subject but exist for compliance
       record-keeping (legitimate interest under GDPR Art. 6(1)(f)); they
       are NOT erased on /portal/me delete either, for the same reason.
     • Recruiter notes that contain the recruiter's evaluation of the
       candidate — see docs/PII_HANDLING.md §6 for the legal rationale.

   Audit: every export call writes an `audit_logs` entry so we have an
   immutable record that a portability request was served. */
router.get("/portal/me/export", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const [cand] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!cand) return res.status(404).json({ error: "Candidate not found" });
    if ((cand as any).dataErasedAt) {
      return res.status(410).json({ error: "Data has been erased; nothing to export." });
    }

    const {
      candidateJobIntelligenceTable,
      outreachMessagesTable,
      outreachEnrollmentsTable,
      nurturePoolTable,
      applicationsTable: appTable,
      interviewSummariesTable,
      interviewSchedulesTable: schedTable,
      verificationRecordsTable,
      communicationEventsTable,
    } = await import("@workspace/db");

    /* Run all child-table reads in parallel — the candidate's record set
     * is bounded so this is cheap, and serial reads would add ~10×100ms of
     * latency for no reason. Each is a simple `WHERE candidate_id = ?`. */
    const [
      careerProfile,
      applications,
      sessions,
      outreachMessages,
      outreachEnrollments,
      nurturePool,
      actionEvents,
      skillScores,
      verifications,
      intelligence,
      communications,
    ] = await Promise.all([
      db.select().from(candidateCareerProfilesTable)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId)),
      db.select().from(appTable).where(eq(appTable.candidateId, candidateId)),
      db.select().from(interviewSessionsTable).where(eq(interviewSessionsTable.candidateId, candidateId)),
      db.select().from(outreachMessagesTable).where(eq(outreachMessagesTable.candidateId, candidateId)),
      db.select().from(outreachEnrollmentsTable).where(eq(outreachEnrollmentsTable.candidateId, candidateId)),
      db.select().from(nurturePoolTable).where(eq(nurturePoolTable.candidateId, candidateId)),
      db.select().from(candidateActionEventsTable).where(eq(candidateActionEventsTable.candidateId, candidateId)),
      db.select().from(candidateSkillScoresTable).where(eq(candidateSkillScoresTable.candidateId, candidateId)),
      db.select().from(verificationRecordsTable).where(eq(verificationRecordsTable.candidateId, candidateId)),
      db.select().from(candidateJobIntelligenceTable).where(eq(candidateJobIntelligenceTable.candidateId, candidateId)),
      db.select().from(communicationEventsTable).where(eq(communicationEventsTable.candidateId, candidateId)),
    ]);
    /* Class-B read (candidateJobIntelligenceTable, above): the CANDIDATE exporting
       their OWN data via the portal, keyed by their own candidateId (resolved from
       candidates.userId = the authenticated self), not a tenant column. The
       employer tenant seal is N/A — the subject is reading about themselves. */
    classBRead(CLASS_B_READ_EXEMPTION.CANDIDATE_SELF_OWNED);

    /* Pull session-scoped children only if we have any sessions — otherwise
     * the IN () would either error or return everything depending on driver.
     *
     * NOTE: interview SUMMARIES (the AI verdict prepared for the hiring team —
     * overallScore, recommendation, recruiterSummary, strengths/weaknesses)
     * are deliberately NOT exported. Like recruiter free-text notes, they are
     * the hiring team's assessment and are withheld by the fairness firewall;
     * the candidate may request them via the DPO for manual review. */
    void interviewSummariesTable;
    const sessionIds = sessions.map((s: any) => s.id);
    const schedules = sessionIds.length > 0
      ? await db.select().from(schedTable)
          .where(inArray(schedTable.sessionId, sessionIds))
      : [];

    /* Fairness firewall on recruiter-run interview sessions: export the fact
     * of the interview and the candidate's OWN words (their answers), but
     * strip the AI's per-answer grades, the overall score, proctoring/trust
     * internals, and the session-binding secret material. */
    const sessionsRedacted = sessions.map((s: any) => {
      const {
        score: _score, codeSubmissions: _code,
        proctoring_events: _pe, suspiciousEvents: _se,
        trustScore: _ts, suspiciousEventCount: _sec,
        bindSecret: _bs, bindFingerprint: _bf, bindUserAgent: _bua,
        bindIpPrefix: _bip, cookieNonce: _cn, stepUpOtpHash: _oh,
        ...rest
      } = s;
      return {
        ...rest,
        answers: Array.isArray(s.answers)
          ? s.answers.map((a: any) => {
              const { score: _as, feedback: _af, ...aRest } = a ?? {};
              return aRest;
            })
          : [],
        aiAssessment: "[withheld — results are shared with the hiring team; contact dpo@l3xy.ai to request review]",
      };
    });

    /* Strip recruiter free-text annotations from applications: `notes` may
     * contain third-party information (other interviewers' impressions,
     * reference quotes, etc.) that the candidate is NOT automatically
     * entitled to under GDPR Art. 15 — those require a manual third-party-
     * data review before disclosure. The candidate may still request the
     * un-redacted notes by emailing the DPO, who can review and release. */
    const applicationsRedacted = applications.map((a: any) => ({
      ...a,
      notes: a.notes != null
        ? "[redacted — contact dpo@l3xy.ai to request third-party-data review]"
        : null,
    }));

    const payload = {
      exportedAt:        new Date().toISOString(),
      schemaVersion:     1,
      candidateId,
      note:              "This is the personal data Lexy holds about you as the data subject. See docs/PII_HANDLING.md for what each field means and which records are retained for compliance after erasure. Recruiter free-text notes on your applications have been redacted from this automated export; email dpo@l3xy.ai to request manual review.",
      candidate:         cand,
      careerProfile:     careerProfile[0] ?? null,
      applications:      applicationsRedacted,
      interviewSessions: sessionsRedacted,
      interviewSchedules: schedules,
      outreachMessages,
      outreachEnrollments,
      nurturePool,
      communicationEvents: communications,
      actionEvents,
      skillScores,
      verifications,
      jobIntelligence:   intelligence,
    };

    /* Best-effort audit trail. We don't await: a slow audit insert must not
     * block returning the export, and a failed audit is logged elsewhere. */
    void recordAudit({
      tenantId:     (cand as any).tenantId ?? null,
      actorType:    "candidate",
      actorId:      candidateId,
      actorLabel:   `${(cand as any).firstName ?? ""} ${(cand as any).lastName ?? ""}`.trim() || "candidate",
      subjectType:  "candidate",
      subjectId:    candidateId,
      subjectLabel: (cand as any).email ?? candidateId,
      channel:      "portal",
      direction:    "outbound",
      action:       "gdpr_data_export",
      title:        "Candidate self-service data export",
      body:         `Exported ${applications.length} applications, ${sessions.length} interviews, ${outreachMessages.length} outreach messages.`,
      metadata:     { counts: {
        applications: applications.length,
        interviewSessions: sessions.length,
        outreachMessages: outreachMessages.length,
        communicationEvents: communications.length,
      } },
    });

    /* Content-Disposition encourages the browser to save rather than render.
     * application/json is correct; the filename is just a hint. */
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="lexy-data-export-${candidateId.slice(0, 8)}.json"`);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (err: any) {
    logger.error({ err: err?.message }, "[GDPR-export] failed");
    return res.status(500).json({ error: "Export failed", detail: err?.message });
  }
});

/* ── DELETE /portal/me ──────────────────────────────────────────────────────
   Self-service GDPR right-to-erasure. The candidate is the data subject;
   they can wipe their own PII without going through a recruiter. Reuses
   the same anonymise + cascade routine as the staff-driven endpoint at
   DELETE /api/dnc/:candidateId/data so behaviour stays in lock-step. */
router.delete("/portal/me", async (req: any, res) => {
  try {
    const candidateId = await getCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });

    const [cand] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId)).limit(1);
    if (!cand) return res.status(404).json({ error: "Candidate not found" });
    if ((cand as any).dataErasedAt) {
      return res.json({ ok: true, message: "Data already erased." });
    }

    const now = new Date();
    const erasedRef = `[erased-${candidateId.slice(0, 8)}]`;

    /* ── Atomic DB cascade ──────────────────────────────────────────────
       All DB mutations run inside a single transaction. If any DB step
       throws, the entire cascade rolls back — the candidate is never left
       in a half-anonymised state. S3 deletion runs AFTER commit so a DB
       rollback doesn't strand a candidate whose row was restored without
       their resume bytes. Orphan S3 objects (commit-then-S3-fail) are
       acceptable and cleaned up by the audit retry pipeline. */
    const purge: Record<string, any> = { candidateId };
    const {
      candidateJobIntelligenceTable,
      outreachMessagesTable,
      outreachEnrollmentsTable,
      nurturePoolTable,
      applicationsTable: appTable,
      interviewSummariesTable,
      interviewSchedulesTable: schedTable,
      verificationRecordsTable,
    } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");

    await db.transaction(async (tx) => {
      await tx.update(candidatesTable)
        .set({
          firstName:      "[Erased]",
          lastName:       "[Erased]",
          email:          `erased+${candidateId.slice(0, 8)}@deleted.invalid`,
          phone:          null,
          location:       null,
          linkedinUrl:    null,
          githubUrl:      null,
          currentTitle:   null,
          currentCompany: null,
          resumeUrl:      null,
          skills:         [],
          doNotContact:   true,
          dncAt:          (cand as any).dncAt ?? now,
          dncReason:      "self_service_gdpr",
          dataErasedAt:   now,
          updatedAt:      now,
        } as any)
        .where(eq(candidatesTable.id, candidateId));

      /* Hard-delete the candidate's self-authored career profile (goals,
       * salary expectations, bio, target companies) — this is squarely the
       * subject's own PII and not subject to any retention basis. Mirrors
       * the same row in the staff-driven cascade in routes/dnc.ts. */
      await tx.delete(candidateCareerProfilesTable)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId));

      await tx.delete(candidateJobIntelligenceTable)
        .where(eq(candidateJobIntelligenceTable.candidateId, candidateId));
      await tx.delete(outreachMessagesTable)
        .where(eq(outreachMessagesTable.candidateId, candidateId));
      await tx.update(outreachEnrollmentsTable)
        .set({ status: "stopped", recipientName: "[Erased]", recipientEmail: `erased@deleted.invalid`, updatedAt: now })
        .where(eq(outreachEnrollmentsTable.candidateId, candidateId));
      await tx.update(nurturePoolTable)
        .set({ status: "stopped", candidateName: "[Erased]", candidateEmail: `erased@deleted.invalid` })
        .where(eq(nurturePoolTable.candidateId, candidateId));
      /* Capture affected application IDs for post-commit governance
       * final_decision writes (candidate_withdrawn). Cannot nest the
       * enforcement service inside this tx — it owns its own writes. */
      // stage-write-exempt: inside the atomic self-service GDPR-erasure
      // transaction. changeCandidateStage() opens its own db.transaction with
      // `FOR UPDATE`, which would deadlock against this outer tx's row locks
      // (and moving it post-commit would break erasure atomicity). Provenance
      // is recorded post-commit by the governance applyHumanDecision() block
      // below (final_decision = candidate_withdrawn + immutable decision_event
      // per row) — a stronger audit record than a generic STAGE_CHANGED.
      const __affected = await tx.update(appTable)
        .set({ notes: "Candidate self-erased per GDPR request.", stage: "rejected" as any, updatedAt: now })
        .where(eq(appTable.candidateId, candidateId))
        .returning({ id: appTable.id });
      (purge as any).__gdprAffectedAppIds = __affected.map((a) => a.id);

      const sessions = await tx.select({ id: interviewSessionsTable.id })
        .from(interviewSessionsTable)
        .where(eq(interviewSessionsTable.candidateId, candidateId));
      const sessionIds = sessions.map(s => s.id);
      if (sessionIds.length > 0) {
        await tx.delete(interviewSummariesTable).where(inArray(interviewSummariesTable.sessionId, sessionIds));
        await tx.delete(schedTable).where(inArray(schedTable.sessionId, sessionIds));
      }
      await tx.delete(interviewSessionsTable)
        .where(eq(interviewSessionsTable.candidateId, candidateId));
      await tx.delete(candidateActionEventsTable)
        .where(eq(candidateActionEventsTable.candidateId, candidateId));
      await tx.delete(candidateSkillScoresTable)
        .where(eq(candidateSkillScoresTable.candidateId, candidateId));
      await tx.delete(verificationRecordsTable)
        .where(eq(verificationRecordsTable.candidateId, candidateId));
    });
    purge.cascade = "ok";

    /* ── Governance final_decision (T010) ────────────────────────────────
     * Same as the admin-driven cascade in routes/dnc.ts: this self-
     * erasure terminates every open application as `candidate_withdrawn`,
     * routed through the enforcement service so the audit trail matches
     * LL144 / CO AI Act expectations. Best-effort: the GDPR commit has
     * already happened above and must not be rolled back if this fails. */
    const __affectedAppIds: string[] = ((purge as any).__gdprAffectedAppIds ?? []) as string[];
    delete (purge as any).__gdprAffectedAppIds;
    if (__affectedAppIds.length > 0) {
      try {
        const { applyHumanDecision } = await import("../lib/governance/decision-enforcement.js");
        await Promise.all(__affectedAppIds.map((appId) =>
          applyHumanDecision({
            applicationId: appId,
            finalDecision: "candidate_withdrawn",
            decidedByUserId: candidateId,        // candidate is the actor for self-service erasure
            decidedByRole: "candidate" as any,
            attestation:
              "I reviewed the AI recommendations and role-relevant candidate information before confirming this action (candidate self-service GDPR erasure — closures recorded as candidate_withdrawn).",
            reason: "gdpr_self_erasure",
          }),
        ));
        purge.governanceDecisions = __affectedAppIds.length;
      } catch (err: any) {
        logger.warn({ candidateId, err: err?.message }, "[governance] self-erasure final_decision write failed (non-fatal)");
      }
    }

    /* Best-effort S3 resume purge. */
    try {
      if ((cand as any).resumeUrl) {
        const { s3Client } = await import("../lib/s3");
        const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        const bucket = process.env.AWS_S3_BUCKET;
        const url = (cand as any).resumeUrl as string;
        const key = url.startsWith("http")
          ? new URL(url).pathname.replace(/^\//, "")
          : url.replace(/^\//, "");
        if (bucket && key) {
          await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          purge.resumeObject = "deleted";
        }
      }
    } catch (s3Err: any) {
      logger.warn({ candidateId, err: s3Err?.message }, "[GDPR-self] S3 delete failed");
      purge.s3Error = s3Err?.message ?? "unknown";
    }

    logger.info({ candidateId, purge }, "[GDPR-self] Candidate self-erased");
    return res.json({
      ok: true,
      message: "Your personal data has been anonymised across the platform. Application records are retained in anonymised form for audit purposes.",
      erasedRef,
      purge,
    });
  } catch (err: any) {
    logger.error({ err: err?.message }, "[GDPR-self] failed");
    return res.status(500).json({ error: "Erasure failed", detail: err?.message });
  }
});

/* ════════════════════════════════════════════════════════════════════════════
 * CANDIDATE SCREENING (work authorisation / sponsorship)
 * ────────────────────────────────────────────────────────────────────────────
 * Job-relevant screening data the candidate self-reports during onboarding.
 * Distinct from `candidate_demographics` — these fields DO surface to
 * recruiters on the candidate card (legitimate hiring use). Read-only for
 * recruiters; only the candidate can change them via the portal.
 * ══════════════════════════════════════════════════════════════════════════ */
const ScreeningUpdateBody = z.object({
  workAuthorized:      z.boolean().nullable().optional(),
  requiresSponsorship: z.boolean().nullable().optional(),
  sponsorshipCountry:  z.string().max(120).nullable().optional(),
  sponsorshipNotes:    z.string().max(1000).nullable().optional(),
}).strict();

router.get("/portal/candidate/screening", async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const [c] = await db.select({
    workAuthorized:       candidatesTable.workAuthorized,
    requiresSponsorship:  candidatesTable.requiresSponsorship,
    sponsorshipCountry:   candidatesTable.sponsorshipCountry,
    sponsorshipNotes:     candidatesTable.sponsorshipNotes,
    screeningCompletedAt: candidatesTable.screeningCompletedAt,
  }).from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!c) return res.status(404).json({ error: "Candidate not found" });
  return res.json({ data: c });
});

router.patch("/portal/candidate/screening", validate({ body: ScreeningUpdateBody }), async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const updates: any = { updatedAt: new Date() };
  const has = (k: string) => Object.prototype.hasOwnProperty.call(req.body, k);
  if (has("workAuthorized"))      updates.workAuthorized      = req.body.workAuthorized;
  if (has("requiresSponsorship")) updates.requiresSponsorship = req.body.requiresSponsorship;
  if (has("sponsorshipCountry"))  updates.sponsorshipCountry  = req.body.sponsorshipCountry;
  if (has("sponsorshipNotes"))    updates.sponsorshipNotes    = req.body.sponsorshipNotes;
  /* Provenance: a candidate editing the portal form is a direct self-report.
     This overrides any earlier interview-derived value's source. */
  if (has("workAuthorized") || has("requiresSponsorship") || has("sponsorshipCountry") || has("sponsorshipNotes"))
    updates.workAuthSource = "self_report";
  /* Mark screening complete the first time both required answers land.
   * Resolve final state from (incoming ?? existing) so a candidate who answers
   * one boolean now and the other in a later request still gets marked complete.
   * We don't gate later edits — the candidate can revise either field at any
   * time without "un-completing" the step. The completion timestamp is what
   * the recruiter UI uses to decide whether to show "Not yet answered". */
  {
    const [existing] = await db.select({
      workAuthorized:       candidatesTable.workAuthorized,
      requiresSponsorship:  candidatesTable.requiresSponsorship,
      screeningCompletedAt: candidatesTable.screeningCompletedAt,
    }).from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
    const finalAuthorized  = has("workAuthorized")      ? updates.workAuthorized      : existing?.workAuthorized;
    const finalSponsorship = has("requiresSponsorship") ? updates.requiresSponsorship : existing?.requiresSponsorship;
    if (finalAuthorized != null && finalSponsorship != null && !existing?.screeningCompletedAt) {
      updates.screeningCompletedAt = new Date();
    }
  }
  const [updated] = await db.update(candidatesTable).set(updates)
    .where(eq(candidatesTable.id, candidateId))
    .returning({
      workAuthorized:       candidatesTable.workAuthorized,
      requiresSponsorship:  candidatesTable.requiresSponsorship,
      sponsorshipCountry:   candidatesTable.sponsorshipCountry,
      sponsorshipNotes:     candidatesTable.sponsorshipNotes,
      screeningCompletedAt: candidatesTable.screeningCompletedAt,
    });
  return res.json({ data: updated });
});

/* ════════════════════════════════════════════════════════════════════════════
 * VOLUNTARY SELF-IDENTIFICATION (DEMOGRAPHICS)
 * ────────────────────────────────────────────────────────────────────────────
 * Strictly decoupled from screening. Lives in its own table
 * (candidate_demographics) and is NEVER joined into the recruiter candidate
 * detail query. Only aggregate, k-anonymised (>= 5 per bucket) views are
 * surfaced to recruiters via /analytics/diversity.
 *
 * Region-aware disclosure copy:
 *   - US/CA/AU → OFCCP-style "Voluntary Self-Identification" boilerplate.
 *   - EU/UK    → GDPR Article 9 "special category" explicit-consent text.
 * The disclosure version is snapshotted into consent_version on save so we
 * can prove exactly which copy a candidate consented under, even after we
 * update the wording.
 *
 * Bump DEMOGRAPHICS_CONSENT_VERSION whenever the disclosure copy changes
 * materially; pre-existing rows stay valid but new submissions get tagged
 * with the new version.
 * ══════════════════════════════════════════════════════════════════════════ */
const DEMOGRAPHICS_CONSENT_VERSION = "self-id-2026-05";

const DemographicsUpdateBody = z.object({
  gender:             z.enum(["female","male","non_binary","self_describe","prefer_not_to_say"]).nullable().optional(),
  genderSelfDescribe: z.string().max(120).nullable().optional(),
  raceEthnicity:      z.array(z.string().max(60)).max(10).nullable().optional(),
  veteranStatus:      z.enum(["protected_veteran","not_veteran","prefer_not_to_say"]).nullable().optional(),
  disabilityStatus:   z.enum(["yes","no","prefer_not_to_say"]).nullable().optional(),
  consented:          z.boolean(),
}).strict();

function disclosureCopyFor(region: string): { title: string; body: string; version: string; locale: "eu" | "us" } {
  if (region === "eu" || region === "uk") {
    return {
      version: DEMOGRAPHICS_CONSENT_VERSION,
      locale: "eu",
      title: "Voluntary diversity disclosure (GDPR Article 9)",
      body:
        "Under GDPR Article 9 the categories below are special-category personal data. " +
        "Sharing this information is entirely voluntary, will not affect your candidacy, " +
        "and will be used only in aggregate groups of 5 or more to help employers improve " +
        "sourcing equity. You may update or withdraw your responses at any time. " +
        "By submitting, you give explicit consent for L3xy to process these categories " +
        "for the stated purpose only.",
    };
  }
  return {
    version: DEMOGRAPHICS_CONSENT_VERSION,
    locale: "us",
    title: "Voluntary Self-Identification (EEO)",
    body:
      "Federal law lets employers ask the following questions to monitor equal-opportunity " +
      "hiring. Your response is voluntary, refusal will not subject you to any adverse " +
      "treatment, and the information will only be used in aggregate groups of 5 or more " +
      "to help employers measure sourcing equity. It will never appear on your individual " +
      "profile to a recruiter.",
  };
}

router.get("/portal/candidate/demographics", async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const [candidate] = await db.select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  const [tenant] = await db.select({ region: tenantsTable.region })
    .from(tenantsTable).where(eq(tenantsTable.id, candidate.tenantId)).limit(1);
  const region = (tenant?.region as string) ?? "us";
  const [demo] = await db.select().from(candidateDemographicsTable)
    .where(eq(candidateDemographicsTable.candidateId, candidateId)).limit(1);
  return res.json({
    data: demo ?? null,
    disclosure: disclosureCopyFor(region),
    region,
  });
});

router.patch("/portal/candidate/demographics", validate({ body: DemographicsUpdateBody }), async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  if (req.body.consented !== true) return res.status(400).json({ error: "Explicit consent required" });
  const [candidate] = await db.select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  const [tenant] = await db.select({ region: tenantsTable.region })
    .from(tenantsTable).where(eq(tenantsTable.id, candidate.tenantId)).limit(1);
  const region = (tenant?.region as string) ?? "us";

  /* "prefer_not_to_say" is the data model's NULL — collapse it on write so
   * we never store the literal string. Aggregations then read NULL as the
   * "no answer" bucket, identical to candidates who skipped the question. */
  const norm = (v: any) => v === "prefer_not_to_say" ? null : (v ?? null);
  const values = {
    candidateId,
    region,
    gender:             norm(req.body.gender),
    genderSelfDescribe: req.body.gender === "self_describe" ? (req.body.genderSelfDescribe ?? null) : null,
    raceEthnicity:      (req.body.raceEthnicity && req.body.raceEthnicity.length > 0) ? req.body.raceEthnicity : null,
    veteranStatus:      norm(req.body.veteranStatus),
    disabilityStatus:   norm(req.body.disabilityStatus),
    consentVersion:     DEMOGRAPHICS_CONSENT_VERSION,
    consentedAt:        new Date(),
    updatedAt:          new Date(),
  };
  const [row] = await db.insert(candidateDemographicsTable)
    .values(values)
    .onConflictDoUpdate({
      target: candidateDemographicsTable.candidateId,
      set: {
        region:             values.region,
        gender:             values.gender,
        genderSelfDescribe: values.genderSelfDescribe,
        raceEthnicity:      values.raceEthnicity,
        veteranStatus:      values.veteranStatus,
        disabilityStatus:   values.disabilityStatus,
        consentVersion:     values.consentVersion,
        consentedAt:        values.consentedAt,
        updatedAt:          values.updatedAt,
      },
    })
    .returning();
  return res.json({ data: row });
});

/* Candidate withdraws consent — hard delete (GDPR right-to-erasure on this
 * specific category). Audit log already captures the candidate-action event
 * via the standard middleware. */
router.delete("/portal/candidate/demographics", async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  await db.delete(candidateDemographicsTable)
    .where(eq(candidateDemographicsTable.candidateId, candidateId));
  return res.json({ data: null });
});

/* ════════════════════════════════════════════════════════════════════════════
 * ILLINOIS AIVI / EU AI ACT — CANDIDATE AI-INTERVIEW CONSENT
 * ────────────────────────────────────────────────────────────────────────────
 * The Illinois Artificial Intelligence Video Interview Act (820 ILCS 42)
 * requires that before an AI is used to evaluate a candidate by video, the
 * employer must (1) notify the applicant, (2) explain how the AI works
 * and which characteristics it evaluates, and (3) obtain the applicant's
 * consent. The EU AI Act Article 26(11) and NYC LL144 candidate-notice
 * rule have overlapping requirements; we satisfy all three with this one
 * consent capture.
 *
 * The /interviews/:id/begin endpoint refuses to mint a session if there
 * is no un-revoked candidate_ai_consent row for the current version.
 * ══════════════════════════════════════════════════════════════════════════ */
const AiConsentBody = z.object({
  consent: z.literal(true),                         // AI interview disclosure affirmation
  biometricConsent: z.literal(true),                // separate BIPA written biometric release
}).strict();

router.get("/portal/candidate/ai-consent", async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const aiConsent = await import("../lib/ai-consent.js");
  const [latest] = await db.select().from(candidateAiConsentTable)
    .where(eq(candidateAiConsentTable.candidateId, candidateId))
    .orderBy(desc(candidateAiConsentTable.consentedAt))
    .limit(1);
  return res.json({
    currentVersion: aiConsent.CURRENT_AI_CONSENT_VERSION,
    disclosure: aiConsent.getCurrentDisclosure(),
    consent: latest ?? null,
    /* active = latest row exists, matches current version, not revoked */
    active: !!latest
      && latest.consentVersion === aiConsent.CURRENT_AI_CONSENT_VERSION
      && !latest.revokedAt,
  });
});

router.post("/portal/candidate/ai-consent", validate({ body: AiConsentBody }), async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const aiConsent = await import("../lib/ai-consent.js");
  const disclosure = aiConsent.getCurrentDisclosure();
  const [row] = await db.insert(candidateAiConsentTable).values({
    candidateId,
    consentVersion: aiConsent.CURRENT_AI_CONSENT_VERSION,
    disclosureSnapshot: disclosure,
    captureContext: {
      ua: (req.headers["user-agent"] as string)?.slice(0, 300) ?? null,
      ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
          ?? (req as any).ip ?? null,
      /* Record the separate BIPA biometric written release explicitly so the
         audit trail shows both affirmations, not just the AI-interview one. */
      biometricConsent: req.body.biometricConsent === true,
    },
  }).returning();
  return res.json({ data: row });
});

/* Candidate withdraws AI consent. We DO NOT delete the row (that would
 * destroy the audit trail) — instead we mark revokedAt. The /begin gate
 * then requires a fresh consent. */
router.delete("/portal/candidate/ai-consent", async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const aiConsent = await import("../lib/ai-consent.js");
  await db.update(candidateAiConsentTable)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(candidateAiConsentTable.candidateId, candidateId),
      eq(candidateAiConsentTable.consentVersion, aiConsent.CURRENT_AI_CONSENT_VERSION),
      isNull(candidateAiConsentTable.revokedAt),
    ));
  return res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════════════════════
 * PLATFORM-POOL DISCOVERY OPT-IN (ruling July 2026)
 * ────────────────────────────────────────────────────────────────────────────
 * Portal access ≠ discovery. Becoming discoverable to OTHER licensed
 * companies (pool='platform') requires this explicit, logged opt-in. The
 * pool write happens ONLY inside lib/discovery-consent.ts (chokepoint,
 * CI-guarded). Candidate-self routes: authz = getCandidateId(req).
 * ══════════════════════════════════════════════════════════════════════════ */
const DiscoveryConsentBody = z.object({
  consent: z.literal(true),
  surface: z.enum(["onboarding", "settings"]).default("settings"),
}).strict();

router.get("/portal/candidate/discovery", async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const dc = await import("../lib/discovery-consent.js");
  const [candidate] = await db.select({ pool: candidatesTable.pool })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  const active = await dc.hasActiveDiscoveryOptIn(candidateId);
  return res.json({
    currentVersion: dc.CURRENT_DISCOVERY_CONSENT_VERSION,
    disclosure: dc.getDiscoveryDisclosure(),
    active,
    discoverable: active && (candidate as any)?.pool === "platform",
  });
});

router.post("/portal/candidate/discovery", validate({ body: DiscoveryConsentBody }), async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const dc = await import("../lib/discovery-consent.js");
  const row = await dc.grantDiscoveryOptIn(candidateId, {
    ua: (req.headers["user-agent"] as string) ?? null,
    ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? (req as any).ip ?? null,
    surface: req.body.surface,
  });
  if (!row) return res.status(404).json({ error: "Candidate not found" });
  return res.json({ data: row });
});

/* Withdraw: keeps the consent rows (audit trail), restores the pre-opt-in pool. */
router.delete("/portal/candidate/discovery", async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const dc = await import("../lib/discovery-consent.js");
  await dc.revokeDiscoveryOptIn(candidateId);
  return res.json({ ok: true });
});

/* ════════════════════════════════════════════════════════════════════════════
 * RIGHT-TO-ERASURE REQUEST (IL AIVI / GDPR Art 17 / CCPA)
 * ────────────────────────────────────────────────────────────────────────────
 * Candidate-fronted submit endpoint. Insert a row into deletion_requests
 * with status=pending; platform_admin reviews via /admin/deletion-requests
 * and fulfils via the admin tool (see routes/admin-deletion.ts).
 * Runbook: docs/RUNBOOK_DATA_DELETION.md.
 * ══════════════════════════════════════════════════════════════════════════ */
const DeletionRequestBody = z.object({
  jurisdiction: z.enum(["il_aivi", "gdpr", "ccpa", "other"]),
  reason:       z.string().max(2000).optional(),
}).strict();

/* TENANT SCOPING NOTE: getCandidateId() → resolveCandidateId() looks up
 * candidates.user_id against the bearer-token's user (see the long
 * comment above getCandidateId at line 540). A candidate can only ever
 * resolve to their own candidate row, and the tenant_id on that row is
 * the candidate's tenant — there is no cross-tenant abuse vector here
 * because the candidate cannot supply candidateId from the wire. */
router.post("/portal/candidate/deletion-request", validate({ body: DeletionRequestBody }), async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const [c] = await db.select({ email: candidatesTable.email })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!c) return res.status(404).json({ error: "Candidate not found" });
  const [row] = await db.insert(deletionRequestsTable).values({
    candidateId,
    candidateEmailSnapshot: c.email ?? null,
    reason: req.body.reason ?? null,
    jurisdiction: req.body.jurisdiction,
    status: "pending",
    updatedAt: new Date(),
  }).returning();
  /* Audit-log the candidate-side action. The admin's fulfilment action
   * writes its own audit row in routes/admin-deletion.ts. */
  void recordAudit({
    tenantId: null,
    actorType: "candidate",
    actorId: candidateId,
    subjectType: "candidate",
    subjectId: candidateId,
    subjectLabel: c.email ?? null,
    channel: "system",
    direction: "internal",
    action: "candidate.deletion_request_submitted",
    title: `Deletion request — ${req.body.jurisdiction}`,
    body: req.body.reason ?? null,
    metadata: { requestId: row.id, jurisdiction: req.body.jurisdiction },
  });
  /* Fire-and-forget notification to legal — failure is logged via the
   * email module's audit row but never blocks the candidate-side submit. */
  void (async () => {
    const { sendDeletionRequestNotificationToLegal } = await import("../lib/deletion-emails.js");
    await sendDeletionRequestNotificationToLegal({
      requestId: row.id,
      candidateId,
      candidateEmail: c.email ?? null,
      jurisdiction: req.body.jurisdiction,
      reason: req.body.reason ?? null,
    });
  })();
  return res.json({ data: row });
});

router.get("/portal/candidate/deletion-request", async (req: any, res) => {
  const candidateId = await getCandidateId(req);
  if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
  const rows = await db.select().from(deletionRequestsTable)
    .where(eq(deletionRequestsTable.candidateId, candidateId))
    .orderBy(desc(deletionRequestsTable.createdAt))
    .limit(20);
  return res.json({ data: rows });
});

export default router;
