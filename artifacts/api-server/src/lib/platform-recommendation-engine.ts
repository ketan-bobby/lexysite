/**
 * platform-recommendation-engine.ts — AI-Powered Platform Candidate Matching
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Scans all open work orders that have platformRecommendationsEnabled=true and
 * evaluates every platform-pool candidate against each job using GPT-4o.
 * Strong matches (score ≥ 75) are auto-pushed to the client tenant's talent pool
 * and the candidate receives a "match alert" notification email.
 *
 * ─── How scoring works ───────────────────────────────────────────────────────
 * Each candidate–job pair is evaluated by the AI with a 100-point rubric:
 *   Role & title alignment with JD     30pts
 *   Skills depth (required skills)     30pts
 *   Location compatibility             20pts  (remote = always compatible;
 *                                             hybrid/onsite = must match city/region)
 *   Experience level fit               10pts
 *   Work style preference alignment    10pts
 *
 * shouldRecommend = true only when score ≥ MATCH_THRESHOLD (75) AND location
 * is compatible. The AI is instructed to be conservative — 80+ = clearly suited.
 *
 * ─── Auto-pause ──────────────────────────────────────────────────────────────
 * After every scan, jobs that had at least one historical push but no new push
 * in the last 7 days are automatically set platformRecommendationsEnabled=false.
 * This prevents perpetually re-scanning fully-matched jobs and keeps API costs down.
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 * Before scoring, the engine loads all already-pushed candidateIds for that
 * client tenant. A candidate is never pushed twice to the same tenant.
 * The talent_pool_submissions INSERT uses a WHERE NOT EXISTS guard for extra safety.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   platform-recommendation-scheduler.ts — runs once every 24 hours
 *   routes/sourcing.ts                   — exposes a manual trigger endpoint
 */

import { db } from "@workspace/db";
import {
  candidatesTable,
  jobsTable,
  icpTable,
  talentPoolSubmissionsTable,
} from "@workspace/db";
import { eq, desc, sql, and } from "drizzle-orm";
import { generateJSON } from "./ai";
import { FAIRNESS_DIRECTIVE } from "./fairness";
import { logger } from "./logger";
import { sendEmail } from "./email.js";
import { recordAudit } from "./audit.js";
import { applyCandidatePrivacyFilter, applyCandidateHardExclusions } from "../routes/candidates";

const MATCH_THRESHOLD = 75;

const PORTAL_URL =
  process.env.CANDIDATE_PORTAL_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}/portal`
    : "https://lexy.ai/portal");

async function sendMatchNotificationEmail(candidate: any, jobTitle: string): Promise<void> {
  if (!candidate.email) return;
  const firstName = candidate.firstName ?? "there";
  const subject   = `${firstName}, a company has shown interest in your profile`;
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;}
  .wrapper{max-width:600px;margin:0 auto;padding:32px 24px;}
  .card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:36px;}
  .logo{color:#00d4ff;font-size:20px;font-weight:800;letter-spacing:-0.5px;margin-bottom:28px;}
  h1{color:#f0f6fc;font-size:22px;font-weight:700;margin:0 0 14px;line-height:1.3;}
  p{color:#8b949e;font-size:15px;line-height:1.7;margin:0 0 16px;}
  .hl{color:#f0f6fc;}
  .cta{display:inline-block;background:#00d4ff;color:#0d1117;font-size:14px;font-weight:700;
       padding:13px 30px;border-radius:8px;text-decoration:none;margin:8px 0 24px;}
  .badge{display:inline-block;padding:4px 14px;border-radius:100px;font-size:12px;font-weight:600;
         margin-bottom:20px;background:#00d4ff20;color:#00d4ff;border:1px solid #00d4ff40;}
  hr{border:none;border-top:1px solid #21262d;margin:24px 0;}
  .footer{color:#484f58;font-size:12px;text-align:center;margin-top:24px;line-height:1.5;}
</style></head>
<body><div class="wrapper"><div class="card">
  <div class="logo">L3XY</div>
  <span class="badge">⚡ Match Alert</span>
  <h1>A company has shown interest in your profile</h1>
  <p>Hi <span class="hl">${firstName}</span>,</p>
  <p>Great news — our AI matching engine identified you as a <span class="hl">strong fit for a ${jobTitle} role</span> and your profile has been shared with a hiring team on the platform.</p>
  <p>Log in to your portal to keep your profile up to date, review your match score, and stay ready for any outreach:</p>
  <a href="${PORTAL_URL}" class="cta">View my portal →</a>
  <hr>
  <p style="font-size:13px;">The company may reach out directly. Make sure your contact details and availability are current.</p>
</div>
<div class="footer">
  Lexy AI Hiring Platform · You're receiving this because you matched a live role on the platform.<br>
  <a href="${PORTAL_URL}" style="color:#484f58;">Manage your profile</a>
</div></div></body></html>`;

  await sendEmail({
    to:      candidate.email,
    subject,
    html,
    audit: {
      tenantId:     "platform",
      actorLabel:   "Platform Recommendation Engine",
      subjectType:  "candidate",
      subjectId:    candidate.id,
      subjectLabel: `${firstName} ${candidate.lastName ?? ""}`.trim(),
      action:       "match.notification",
      metadata:     { jobTitle },
    },
  });
}

const SYSTEM_PROMPT = `You are a senior recruiting AI evaluating whether a platform candidate is a strong match for a specific job opening.
Be rigorous — only recommend candidates who are genuinely well-suited. A keyword in common does not constitute a match.
You must consider role alignment, skill depth, location compatibility, experience level, and work style.
Return ONLY valid JSON — no markdown, no explanation.

${FAIRNESS_DIRECTIVE}`;

const AUTO_PAUSE_DAYS = 7;

export interface ScanSummary {
  runAt: string;
  jobsScanned: number;
  candidatesEvaluated: number;
  newPushes: number;
  skippedAlreadyPushed: number;
  skippedLocation: number;
  errors: number;
  autoPaused: number;
  details: Array<{
    jobId: string;
    jobTitle: string;
    clientTenantId: string;
    pushed: number;
    evaluated: number;
    skippedLocation: number;
    errors: number;
  }>;
}

interface ScoreResult {
  score: number;
  locationCompatible: boolean;
  shouldRecommend: boolean;
  reasons: string[];
  disqualifiers: string[];
}

async function scoreCandidate(
  candidate: any,
  job: any,
  icp: any | null,
): Promise<ScoreResult> {
  const icpSection = icp
    ? `\nIdeal Candidate Profile:
- Required Skills: ${icp.requiredSkills?.join(", ") || "not specified"}
- Preferred Skills: ${icp.preferredSkills?.join(", ") || "none"}
- Must-Haves: ${icp.mustHaves?.join(", ") || "none"}
- Disqualifiers: ${icp.disqualifiers?.join(", ") || "none"}
- Seniority Level: ${icp.seniority || "not specified"}
- Years of Experience: ${icp.yearsExperienceMin ?? "?"} – ${icp.yearsExperienceMax ?? "?"} years
- Education: ${icp.educationRequirements || "not specified"}`
    : "";

  const prompt = `Evaluate this candidate against the job opening below.

JOB OPENING:
Title: ${job.title}
Department: ${job.department || "Not specified"}
Location: ${job.location || "Not specified"}
Work Arrangement: ${job.workType || "not specified"} (values: remote / hybrid / onsite)
Job Description (excerpt): ${(job.description || "No description provided").slice(0, 1200)}
${icpSection}

CANDIDATE PROFILE:
Name: ${candidate.firstName} ${candidate.lastName}
Current Title: ${candidate.currentTitle || "Unknown"}
Location: ${candidate.location || "Unknown — treat as location risk"}
Skills: ${(candidate.skills || []).join(", ") || "None listed"}
Experience Level: ${candidate.experienceLevel || "Unknown"}
Preferred Work Style: ${candidate.workStyle || "Unknown"}
Professional Summary: ${(candidate.summary || "Not provided").slice(0, 600)}

SCORING (total 100 points):
• Role & Title alignment with the JD: 30 pts
• Skills depth — required skills covered: 30 pts
• Location compatibility:
    - If workType = "remote" → any location is compatible (full 20 pts)
    - If workType = "hybrid" or "onsite" → candidate must be in the same city/region/country as the job (0 pts if incompatible)
• Experience level fit: 10 pts
• Work style preference alignment: 10 pts

IMPORTANT RULES:
- Set locationCompatible = false if workType is hybrid/onsite AND candidate location clearly differs from job location
- Set shouldRecommend = true ONLY if score >= ${MATCH_THRESHOLD} AND (workType = "remote" OR locationCompatible = true)
- Be conservative — a score of 80+ should mean the candidate is clearly suited for this role

Return ONLY this JSON:
{
  "score": <integer 0-100>,
  "locationCompatible": <boolean>,
  "shouldRecommend": <boolean>,
  "reasons": [<up to 3 concise positive reasons, each under 15 words>],
  "disqualifiers": [<up to 2 reasons not to recommend, or empty array>]
}`;

  return generateJSON<ScoreResult>(prompt, SYSTEM_PROMPT);
}

/* ── Deterministic location pre-gate ─────────────────────────────────────────
 * A cheap, deterministic filter applied BEFORE the (paid) AI scoring call so we
 * never engage a candidate who is plainly in the wrong region for an
 * onsite/hybrid role — e.g. a US-based developer for a role located in Mexico.
 * It is intentionally coarse and only blocks CONFIDENT mismatches; the AI
 * scorer remains the precise gate for same-region, city-level nuance.
 *
 *   - Remote roles                          → every location is eligible.
 *   - Onsite/hybrid (or unknown workType) with a known job location:
 *       · candidate location unknown          → NOT eligible (can't confirm region)
 *       · candidate & job share no location token → NOT eligible
 *       · otherwise                           → eligible
 *   - Job location unknown                   → eligible (nothing to compare against).
 */
const LOCATION_STOPWORDS = new Set([
  "city", "town", "area", "region", "metro", "metropolitan", "greater", "north",
  "south", "east", "west", "central", "county", "province", "state", "district",
  "downtown", "remote", "hybrid", "onsite", "the", "of", "and", "or",
]);

/** Collapse common multi-form country spellings to a single canonical token so
 *  "USA", "U.S.", "United States of America" all compare equal. */
function canonicalizeLocation(raw: string): string {
  let s = ` ${raw.toLowerCase()} `.replace(/[.,/()]/g, " ").replace(/\s+/g, " ");
  const aliases: Array<[RegExp, string]> = [
    [/\b(u\s?s\s?a|u\s?s|united states of america|united states|america)\b/g, " usa "],
    [/\b(u\s?k|united kingdom|great britain|britain|england)\b/g, " uk "],
    [/\b(mx|mex|mexico|méxico)\b/g, " mexico "],
    [/\b(uae|united arab emirates)\b/g, " uae "],
  ];
  for (const [re, rep] of aliases) s = s.replace(re, rep);
  return s;
}

function locationTokens(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    canonicalizeLocation(raw)
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 2 && !LOCATION_STOPWORDS.has(t)),
  );
}

function locationEligible(
  candidateLocation: string | null | undefined,
  job: { location?: string | null; workType?: string | null },
): boolean {
  if ((job.workType ?? "").toLowerCase() === "remote") return true;
  const jobTokens = locationTokens(job.location);
  if (jobTokens.size === 0) return true;          // no job location to gate on
  const candTokens = locationTokens(candidateLocation);
  if (candTokens.size === 0) return false;         // unknown candidate location → can't confirm region
  for (const t of candTokens) if (jobTokens.has(t)) return true;
  return false;
}

interface JobScanResult {
  evaluated: number;
  pushed: number;
  errors: number;
  skippedAlreadyPushed: number;
  skippedLocation: number;
}

/* Evaluate every platform candidate against ONE job. Shared by the full 24-hour
 * scan and the immediate single-job scan triggered when a job opts in. */
async function evaluateJobAgainstCandidates(
  job: {
    id: string;
    title: string;
    description: string | null;
    location: string | null;
    workType: string | null;
    department: string | null;
    tenantId: string;
  },
  platformCandidates: any[],
): Promise<JobScanResult> {
  const r: JobScanResult = { evaluated: 0, pushed: 0, errors: 0, skippedAlreadyPushed: 0, skippedLocation: 0 };

  // Fetch ICP for this job (latest version)
  const [icp] = await db
    .select()
    .from(icpTable)
    .where(eq(icpTable.jobId, job.id))
    .orderBy(desc(icpTable.version))
    .limit(1);

  // Fetch already-pushed candidate IDs for this client tenant
  const pushedRows = await db
    .select({ candidateId: talentPoolSubmissionsTable.candidateId })
    .from(talentPoolSubmissionsTable)
    .where(eq(talentPoolSubmissionsTable.clientTenantId as any, job.tenantId));

  const pushedIds = new Set(
    pushedRows.map((row: any) => row.candidateId).filter(Boolean),
  );

  logger.info(
    { jobId: job.id, title: job.title, alreadyPushed: pushedIds.size },
    "[platform-rec] Evaluating job",
  );

  /* ── PRIVACY SEAL (CRITICAL) ─────────────────────────────────────────────
     These candidates are about to be PUSHED, unprompted, into the client
     tenant's talent pool AND emailed a "you were matched" notice. That is an
     employer-facing surface, so the FULL canonical seal MUST run first — and
     per RECEIVING tenant (job.tenantId), because runPlatformRecommendationScan
     shares ONE platform-pool fetch across many different-tenant jobs, so the
     tenant-relative privacy filter has to be re-applied for each job here.
       • applyCandidateHardExclusions — drops erased / DNC / pending_profile.
       • applyCandidatePrivacyFilter(job.tenantId) — drops anyone who paused
         discovery, hid from / blocked THIS employer, or is match-only-invisible.
     A hidden/blocked job-seeker must NEVER be recommended to the very company
     they hid from — that is the exact catastrophe this audit exists to prevent. */
  const sealed = await applyCandidatePrivacyFilter(
    applyCandidateHardExclusions(platformCandidates),
    job.tenantId,
  );

  for (const candidate of sealed) {
    if (pushedIds.has(candidate.id)) {
      r.skippedAlreadyPushed++;
      continue;
    }

    // Deterministic location pre-gate — runs before the paid AI scoring call so
    // we don't engage clearly out-of-region candidates (e.g. a US dev for a
    // Mexico onsite role).
    if (!locationEligible(candidate.location, job)) {
      r.skippedLocation++;
      logger.debug(
        {
          candidateId: candidate.id,
          jobId: job.id,
          candidateLocation: candidate.location,
          jobLocation: job.location,
          workType: job.workType,
        },
        "[platform-rec] Skipped — location mismatch",
      );
      continue;
    }

    r.evaluated++;

    try {
      const result = await scoreCandidate(candidate, job, icp ?? null);

      logger.debug(
        { candidateId: candidate.id, jobId: job.id, score: result.score, recommend: result.shouldRecommend },
        "[platform-rec] Score result",
      );

      if (result.shouldRecommend && result.score >= MATCH_THRESHOLD) {
        const note = `[Auto-Matched by Platform AI] Score: ${result.score}/100. ${result.reasons.slice(0, 2).join("; ")}`;

        // INSERT ... RETURNING so we only count the push / email the candidate
        // when a row was ACTUALLY inserted. The WHERE NOT EXISTS guard makes
        // this a no-op if another concurrent scan (e.g. the 24h scheduled scan
        // overlapping this immediate single-job scan) already pushed them —
        // without RETURNING we'd over-count and send a duplicate match email.
        const inserted = await db.execute(sql`
          INSERT INTO talent_pool_submissions
            (id, full_name, email, phone, current_title, location,
             experience_level, work_style, languages, bio, linkedin_url, resume_object_path,
             status, candidate_id, client_tenant_id, pushed_by_user_id, note, pushed_at, job_posting_id)
          SELECT
            ${crypto.randomUUID()},
            ${`${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim()},
            ${candidate.email ?? null},
            ${candidate.phone ?? null},
            ${candidate.currentTitle ?? null},
            ${candidate.location ?? null},
            ${(candidate as any).experienceLevel ?? null},
            ${(candidate as any).workStyle ?? null},
            NULL,
            ${(candidate as any).summary ?? null},
            ${candidate.linkedinUrl ?? null},
            ${candidate.resumeUrl ?? null},
            'active',
            ${candidate.id},
            ${job.tenantId},
            NULL,
            ${note},
            NOW(),
            ${job.id}
          WHERE NOT EXISTS (
            SELECT 1 FROM talent_pool_submissions
            WHERE candidate_id = ${candidate.id}
              AND client_tenant_id = ${job.tenantId}
          )
          RETURNING id
        `);

        const didInsert = ((inserted as any).rows?.length ?? (inserted as any).rowCount ?? 0) > 0;
        pushedIds.add(candidate.id);

        if (didInsert) {
          r.pushed++;

          // Notify the candidate by email that their profile was matched
          void sendMatchNotificationEmail(candidate, job.title).catch((err: any) =>
            logger.warn({ candidateId: candidate.id, err: err?.message }, "[platform-rec] Match notification email failed"),
          );

          logger.info(
            { candidateId: candidate.id, jobId: job.id, score: result.score },
            "[platform-rec] Auto-pushed candidate",
          );
        }
      }
    } catch (err: any) {
      r.errors++;
      logger.error(
        { err: err.message, candidateId: candidate.id, jobId: job.id },
        "[platform-rec] Scoring error",
      );
    }
  }

  return r;
}

/* Run the recommendation evaluation for a SINGLE job immediately (e.g. the
 * moment a job opts in to platform recommendations) instead of waiting for the
 * next 24-hour scan. Respects the same consent gate — does nothing unless the
 * job has platformRecommendationsEnabled = true. */
export interface JobRecommendationResult extends JobScanResult {
  jobId: string;
  ran: boolean;
}

export async function runPlatformRecommendationForJob(jobId: string): Promise<JobRecommendationResult> {
  const empty = (ran: boolean): JobRecommendationResult => ({
    jobId, ran, evaluated: 0, pushed: 0, errors: 0, skippedAlreadyPushed: 0, skippedLocation: 0,
  });

  const [job] = await db
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      description: jobsTable.description,
      location: jobsTable.location,
      workType: jobsTable.workType,
      department: jobsTable.department,
      tenantId: jobsTable.tenantId,
      enabled: jobsTable.platformRecommendationsEnabled,
    })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId))
    .limit(1);

  if (!job) {
    logger.warn({ jobId }, "[platform-rec] Immediate scan skipped — job not found");
    return empty(false);
  }
  if (!job.enabled) {
    logger.info({ jobId }, "[platform-rec] Immediate scan skipped — recommendations not enabled for this job");
    return empty(false);
  }

  const platformCandidates = await db
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.pool, "platform"));

  if (platformCandidates.length === 0) {
    logger.info({ jobId }, "[platform-rec] Immediate scan — no platform candidates to evaluate");
    return empty(true);
  }

  logger.info(
    { jobId, candidates: platformCandidates.length },
    "[platform-rec] Immediate single-job recommendation scan starting",
  );

  const r = await evaluateJobAgainstCandidates(job, platformCandidates);

  logger.info({ jobId, ...r }, "[platform-rec] Immediate single-job recommendation scan complete");
  return { jobId, ran: true, ...r };
}

export async function runPlatformRecommendationScan(): Promise<ScanSummary> {
  const runAt = new Date().toISOString();
  let jobsScanned = 0;
  let candidatesEvaluated = 0;
  let newPushes = 0;
  let skippedAlreadyPushed = 0;
  let errors = 0;
  const details: ScanSummary["details"] = [];

  logger.info("[platform-rec] Starting platform recommendation scan");

  // 1. Fetch all open work orders
  const openJobs = await db
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      description: jobsTable.description,
      location: jobsTable.location,
      workType: jobsTable.workType,
      department: jobsTable.department,
      tenantId: jobsTable.tenantId,
    })
    .from(jobsTable)
    .where(eq(jobsTable.platformRecommendationsEnabled, true));

  if (openJobs.length === 0) {
    logger.info("[platform-rec] No open work orders — scan skipped");
    return { runAt, jobsScanned: 0, candidatesEvaluated: 0, newPushes: 0, skippedAlreadyPushed: 0, skippedLocation: 0, errors: 0, autoPaused: 0, details: [] };
  }

  // 2. Fetch all platform pool candidates
  const platformCandidates = await db
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.pool, "platform"));

  if (platformCandidates.length === 0) {
    logger.info("[platform-rec] No platform candidates — scan skipped");
    return { runAt, jobsScanned: 0, candidatesEvaluated: 0, newPushes: 0, skippedAlreadyPushed: 0, skippedLocation: 0, errors: 0, autoPaused: 0, details: [] };
  }

  logger.info(
    { jobs: openJobs.length, candidates: platformCandidates.length },
    "[platform-rec] Evaluating candidates against work orders",
  );

  // 3. Process each open work order (shared per-job evaluator)
  let skippedLocation = 0;
  for (const job of openJobs) {
    jobsScanned++;

    const jr = await evaluateJobAgainstCandidates(job, platformCandidates);

    candidatesEvaluated += jr.evaluated;
    newPushes += jr.pushed;
    skippedAlreadyPushed += jr.skippedAlreadyPushed;
    skippedLocation += jr.skippedLocation;
    errors += jr.errors;

    details.push({
      jobId: job.id,
      jobTitle: job.title,
      clientTenantId: job.tenantId,
      pushed: jr.pushed,
      evaluated: jr.evaluated,
      skippedLocation: jr.skippedLocation,
      errors: jr.errors,
    });
  }

  // ── Auto-pause: jobs with no new push in the last AUTO_PAUSE_DAYS days ──
  let autoPaused = 0;
  try {
    const cutoff = new Date(Date.now() - AUTO_PAUSE_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Find all currently-active jobs that have at least 1 push but none recently
    const candidatesForAutoPause = await db.execute<{ id: string; tenant_id: string; title: string }>(sql`
      SELECT j.id, j.tenant_id, j.title
      FROM jobs j
      WHERE j.platform_recommendations_enabled = true
        AND EXISTS (
          SELECT 1 FROM talent_pool_submissions tps
          WHERE tps.job_posting_id = j.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM talent_pool_submissions tps
          WHERE tps.job_posting_id = j.id
            AND tps.pushed_at > ${cutoff}::timestamptz
        )
    `);

    for (const row of candidatesForAutoPause.rows as any[]) {
      // Use .returning() so we only audit if we actually flipped the flag
      // (guards against a race where another writer disabled it first).
      const flipped = await db
        .update(jobsTable)
        .set({ platformRecommendationsEnabled: false, updatedAt: new Date() })
        .where(and(eq(jobsTable.id, row.id), eq(jobsTable.platformRecommendationsEnabled, true)))
        .returning({ id: jobsTable.id });

      if (flipped.length > 0) {
        autoPaused++;
        logger.info({ jobId: row.id }, `[platform-rec] Auto-paused job (no activity in ${AUTO_PAUSE_DAYS} days)`);
        void recordAudit({
          tenantId: row.tenant_id,
          actorType: "system",
          actorId: null,
          actorLabel: "Platform Recommendation Scheduler",
          subjectType: "system",
          subjectId: row.id,
          subjectLabel: row.title || `job:${row.id}`,
          channel: "system",
          direction: "internal",
          action: "platform_recommendations.disabled",
          title: `Auto-paused platform recommendations (no activity in ${AUTO_PAUSE_DAYS} days)`,
          metadata: {
            jobId: row.id,
            previousValue: true,
            newValue: false,
            actorRole: "system",
            reason: "auto_pause_inactivity",
            inactivityDays: AUTO_PAUSE_DAYS,
          },
        });
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message }, "[platform-rec] Auto-pause check failed");
  }

  const summary: ScanSummary = {
    runAt,
    jobsScanned,
    candidatesEvaluated,
    newPushes,
    skippedAlreadyPushed,
    skippedLocation,
    errors,
    autoPaused,
    details,
  };

  logger.info(summary, "[platform-rec] Scan complete");
  return summary;
}
