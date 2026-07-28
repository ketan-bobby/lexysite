/**
 * candidates.ts — Candidate Pool & Profile Routes
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * All candidate-facing and recruiter-facing data routes live here. This covers:
 *
 *   • GET  /candidates              — paginated candidate pool (pool/tenant scoped)
 *   • GET  /candidates/nl-search    — natural-language AI search over the pool
 *   • GET  /candidates/:id          — single candidate profile
 *   • PUT  /candidates/:id          — update candidate fields
 *   • POST /candidates/:id/upload-cv — upload & parse a new CV for an existing candidate
 *   • POST /candidates/parse-cv     — stateless CV text extraction (no auth required)
 *   • GET  /candidates/:id/interview-sessions — interview history
 *   • GET  /candidates/:id/recording/:session — stream proctored interview recording from S3
 *   … and more
 *
 * ─── Pool / Tenant Scoping (CRITICAL) ───────────────────────────────────────
 * Every candidate row has two fields that control visibility:
 *
 *   pool      "platform" | "tenant" | "pending_profile"
 *   tenantId  UUID of the owning tenant, or "platform" for shared candidates
 *
 * Access rules enforced throughout this file:
 *
 *   platform_admin    → sees everything (no tenantId filter)
 *   tenant recruiter  → sees:
 *                         • pool="tenant"   where tenantId ∈ {own + child tenants}
 *                         • pool="platform" ONLY if tenant.candidateDatabaseAccess = true
 *                         • pool="pending_profile" → hidden from all lists
 *
 * These rules are implemented in getAllowedTenantIds() and applied in every
 * list/search route via an in-memory filter on the fetched rows.
 *
 * ─── Auth ────────────────────────────────────────────────────────────────────
 * Routes use Lexy JWT tokens (demo_token_<userId> format in development).
 * getCallerUser() resolves the token to a full user row including role + tenantId.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import multer from "multer";
import { logger } from "../lib/logger";
import { recruiterLinkOrigin } from "../lib/sourcing-origin";
import { controlDb, db } from "@workspace/db";
import { validate } from "../middlewares/validate";

/* ── Request body schemas ────────────────────────────────────────────────── */
const NlSearchBody = z.object({
  query: z.string().min(1),
}).passthrough();

const CreateCandidateBody = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  currentTitle: z.string().optional().nullable(),
  currentCompany: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  githubUrl: z.string().optional().nullable(),
  skills: z.array(z.string()).optional(),
  source: z.string().optional().nullable(),
  jobId: z.string().optional().nullable(),
  resumeObjectPath: z.string().optional().nullable(),
  confirmDuplicate: z.boolean().optional(),
  // When true, an email collision updates the existing candidate (merging the
  // newer info) instead of returning a 409 — set after the recruiter confirms
  // the merge prompt.
  mergeIntoExisting: z.boolean().optional(),
}).passthrough();

const BulkImportBody = z.object({
  rows: z.array(z.record(z.unknown())).min(1),
  jobId: z.string().optional().nullable(),
  // When true, every imported row is flagged as a CURRENT EMPLOYEE (internal
  // mobility bench). Individual rows may also carry their own `isCurrentEmployee`
  // column, which overrides this top-level default per row.
  isCurrentEmployee: z.boolean().optional(),
}).passthrough();

const ViewCandidateBody = z.object({
  candidateId: z.string().min(1),
}).passthrough();

/* Strict allowlist for PUT /candidates/:candidateId.
 *
 * Unknown keys are stripped by zod (default behaviour) so a malicious
 * client cannot promote themselves to e.g. tenantId, pool="platform",
 * dataErasedAt=null, or set system-managed columns like dncSetBy. The
 * handler still spreads req.body into .set() but after validate() only
 * these keys can be present. */
const UpdateCandidateBody = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  currentTitle: z.string().nullable().optional(),
  currentCompany: z.string().nullable().optional(),
  linkedinUrl: z.string().nullable().optional(),
  githubUrl: z.string().nullable().optional(),
  skills: z.array(z.string()).optional(),
  source: z.string().nullable().optional(),
  resumeUrl: z.string().nullable().optional(),
  talentMatchScore: z.number().nullable().optional(),
  resumeScreenScore: z.number().nullable().optional(),
  hiringManagerApproval: z.enum(["approved", "rejected"]).nullable().optional(),
  /* Candidate-controlled privacy controls — safe to edit via PUT. */
  hideFromCurrentEmployer: z.boolean().optional(),
  currentEmployerDomain: z.string().nullable().optional(),
  blockedCompanyDomains: z.array(z.string()).optional(),
  matchOnlyVisibility: z.boolean().optional(),
  discoveryPaused: z.boolean().optional(),
  /* `pool` is allowed because recruiters use this PUT to promote
   * candidates between pools; the route's own authz still gates which
   * tenants can do this. */
  pool: z.string().optional(),
  /* `doNotContact` is a candidate-self-service flag — handler-level
   * authz already enforces that only the candidate or platform admin
   * can flip it; including it here doesn't widen access. */
  doNotContact: z.boolean().optional(),
});

const CandidateResumeBody = z.object({
  objectPath: z.string().min(1),
}).passthrough();

const PatchCandidateBody = z.object({
  hiringManagerApproval: z.enum(["approved", "rejected"]),
}).passthrough();

/* Toggle a single internal candidate on/off the current-employee bench. */
const EmployeeStatusBody = z.object({
  isCurrentEmployee: z.boolean(),
});

const PushToClientBody = z.object({
  clientTenantId: z.string().min(1),
  note: z.string().optional().nullable(),
  jobPostingId: z.string().optional().nullable(),
}).passthrough();
import { candidatesTable, applicationsTable, interviewSessionsTable, communicationEventsTable, interviewSchedulesTable, candidateNotificationsTable, sourcedCandidatesTable, usersTable, tenantsTable, candidateCareerProfilesTable, candidateRejectionsTable, talentPoolSubmissionsTable, inviteTokensTable, jobsTable, candidateJobIntelligenceTable } from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token";
import { resolveCandidateId } from "../lib/portal-auth";
import { assertJobApproved } from "../lib/job-approval-gate";
import { getAllowedTenantIds, getDataScopeTenantIds, getRecruiterAdminClientTenantIds, getRecruiterAssignedJobIds, recruiterIsAssignedToJob } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import { sendEmail, isEmailConfigured, plainToHtml } from "../lib/email";

/* ── Per-candidate privacy filter (brochure slide 6 — Stay invisible) ─────
 * SCOPE: PLATFORM-pool candidates only. Tenant-pool candidates are the
 * recruiter's own imported records (internal employees, referrals, manually
 * sourced) and are never hidden — otherwise an internal employee would
 * disappear from their own employer's ATS and miss promotion opportunities.
 *
 * For platform-pool candidates, excludes those who have either:
 *   (a) toggled `hide_from_current_employer=true` AND their
 *       `current_employer_domain` matches a domain owned by the recruiter's
 *       tenant (tenant.website hostname OR tenant.contactEmail domain), OR
 *   (b) added a domain to `blocked_company_domains` that matches the
 *       recruiter's tenant.
 *
 * Caller passes the recruiter's tenantId (NOT user.id) — for platform_admin
 * we pass null and the filter is a no-op so platform staff still see the
 * full pool for ops/support purposes.
 *
 * ── Fail-CLOSED policy ──────────────────────────────────────────────────
 * If we cannot resolve any domain for the recruiter's tenant (no website,
 * no contact email, or DB lookup failed) we MUST drop every candidate that
 * has any hide/block setting active. Returning them would silently leak
 * exactly the recruiter the candidate asked to be hidden from.
 *
 * ── Domain matching is suffix-based (boundary-safe) ─────────────────────
 * `acme.com` matches `acme.com` and `mail.acme.com`, but NOT `notacme.com`.
 * No substring matching, no name-token fallback — both have produced false
 * positives in the past. Tenant name is intentionally NOT used as a
 * privacy signal (too easy to spoof / collide).
 */
const tenantDomainCache = new Map<string, Set<string>>();
async function getTenantDomains(tenantId: string): Promise<Set<string>> {
  if (tenantDomainCache.has(tenantId)) return tenantDomainCache.get(tenantId)!;
  const out = new Set<string>();
  try {
    const [t] = await db
      .select({ website: tenantsTable.website, email: tenantsTable.contactEmail })
      .from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
    if (t?.website) {
      try {
        const u = new URL(t.website.startsWith("http") ? t.website : `https://${t.website}`);
        const host = u.hostname.replace(/^www\./, "").toLowerCase().trim();
        if (host) out.add(host);
      } catch { /* malformed website — skip */ }
    }
    if (t?.email && t.email.includes("@")) {
      const dom = t.email.split("@")[1]?.toLowerCase().trim();
      if (dom) out.add(dom);
    }
  } catch { /* swallow — but caller will fail closed if set is empty */ }
  tenantDomainCache.set(tenantId, out);
  setTimeout(() => tenantDomainCache.delete(tenantId), 60_000).unref?.();
  return out;
}

/** Strict suffix match: `acme.com` matches itself or any `*.acme.com`. */
function isSameOrSubdomain(candidate: string, target: string): boolean {
  if (!candidate || !target) return false;
  if (candidate === target) return true;
  return candidate.endsWith("." + target);
}

function normalizeDomain(raw: string | null | undefined): string {
  if (!raw) return "";
  return String(raw).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
}

/* Tokenize a job/role title into a Set of meaningful words (lowercased,
   stop-words and pure-numeric tokens stripped). Used by the match-only
   visibility check to determine whether a recruiter's open jobs overlap
   with a platform candidate's preferredRoles. We deliberately keep this
   loose (token overlap, not exact title match) so that "Senior Backend
   Engineer" matches "Backend Engineer" and "Engineering Manager" matches
   "Manager, Engineering". */
const TITLE_STOPWORDS = new Set([
  "the", "and", "or", "of", "for", "to", "in", "at", "a", "an",
  "senior", "sr", "junior", "jr", "lead", "principal", "staff",
  "i", "ii", "iii", "iv", "v",
]);
function tokenizeTitle(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    String(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 2 && !TITLE_STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );
}

/* Cache of tenant → set of meaningful tokens across all currently-open jobs.
   Computed lazily inside applyCandidatePrivacyFilter so we only pay the
   cost when at least one candidate has matchOnlyVisibility enabled. */
async function getTenantOpenJobTokens(recruiterTenantId: string): Promise<Set<string>> {
  const { jobsTable } = await import("@workspace/db");
  const rows = await db
    .select({ title: jobsTable.title })
    .from(jobsTable)
    .where(and(
      eq(jobsTable.tenantId, recruiterTenantId),
      /* "Currently-open" = live roles actively accepting candidates. The
         job_status enum has NO "open" value (draft|active|paused|closed|
         pending_approval|rejected|published) — querying status="open" threw
         22P02 and 500'd the whole employer discovery surface whenever ANY
         platform candidate had matchOnlyVisibility set. We use the strict
         `active` set only: match-only is a privacy control, so when in doubt
         we OVER-HIDE (reveal a match-only job-seeker to a tenant only when it
         has a genuinely active role), never over-expose. */
      eq(jobsTable.status, "active"),
    ));
  const tokens = new Set<string>();
  for (const r of rows) for (const t of tokenizeTitle(r.title)) tokens.add(t);
  return tokens;
}

export async function applyCandidatePrivacyFilter<T extends Record<string, any>>(
  candidates: T[], recruiterTenantId: string | null,
): Promise<T[]> {
  /* No-op for platform_admin (recruiterTenantId === null) — they must be
     able to see the full pool for ops/support. */
  if (!recruiterTenantId) return candidates;

  const tenantDomains = await getTenantDomains(recruiterTenantId);
  const haveDomains = tenantDomains.size > 0;

  /* ── Match-only visibility prep ──────────────────────────────────────
     If any platform candidate in the result set has matchOnlyVisibility
     enabled, fetch the recruiter tenant's open-job title tokens AND the
     candidates' preferredRoles in a single batch. Skip both lookups
     entirely when no candidate cares — keeps the fast path fast. */
  const matchOnlyCandidateIds = candidates
    .filter(c => c.pool === "platform" && c.matchOnlyVisibility === true)
    .map(c => c.id as string);

  let tenantTokens: Set<string> | null = null;
  let preferredRolesByCandidate: Map<string, string[]> = new Map();
  if (matchOnlyCandidateIds.length > 0) {
    tenantTokens = await getTenantOpenJobTokens(recruiterTenantId);
    if (tenantTokens.size > 0) {
      const profiles = await db
        .select({
          candidateId: candidateCareerProfilesTable.candidateId,
          preferredRoles: candidateCareerProfilesTable.preferredRoles,
        })
        .from(candidateCareerProfilesTable)
        .where(inArray(candidateCareerProfilesTable.candidateId, matchOnlyCandidateIds));
      for (const p of profiles) {
        preferredRolesByCandidate.set(
          p.candidateId,
          Array.isArray(p.preferredRoles) ? (p.preferredRoles as string[]) : [],
        );
      }
    }
  }

  return candidates.filter(c => {
    /* ── Pool scope ─────────────────────────────────────────────────────
       Privacy controls only apply to PLATFORM-pool candidates (people who
       self-registered on Lexy to find a new job). Tenant-pool candidates
       were imported by the recruiter themselves — internal employees up
       for promotion, referrals, manually sourced people — and the recruiter
       is allowed to see their own data regardless of any flag the candidate
       set as a job-seeker elsewhere. Without this scope, an Acme employee
       who self-registered on Lexy could disappear from Acme HR's own ATS
       and miss out on internal promotions. */
    if (c.pool !== "platform") return true;

    /* Master "Pause discovery" — brochure Privacy slide promise: "Stay
       invisible until you're ready." When set, the candidate vanishes from
       every recruiter discovery surface, regardless of any other setting. */
    if (c.discoveryPaused === true) return false;

    const hide = c.hideFromCurrentEmployer === true;
    const blocked: string[] = Array.isArray(c.blockedCompanyDomains) ? c.blockedCompanyDomains : [];
    const hasAnyPrivacy = hide || blocked.length > 0;

    /* Fail-CLOSED: the candidate explicitly asked to be hidden from someone
       and we can't tell who the recruiter belongs to → drop them. */
    if (!haveDomains) return !hasAnyPrivacy;

    /* (a) hide-from-current-employer — strict suffix match */
    if (hide) {
      const cd = normalizeDomain(c.currentEmployerDomain);
      if (cd) {
        for (const td of tenantDomains) {
          if (isSameOrSubdomain(cd, td) || isSameOrSubdomain(td, cd)) return false;
        }
      } else {
        /* hide=true but no domain set → caller couldn't have configured this
           via our PUT route (we require it). Older rows: fail closed for any
           recruiter we can identify, since the candidate's intent is clear. */
        return false;
      }
    }

    /* (b) per-company opt-out blocklist — strict suffix match */
    if (blocked.length > 0) {
      const blockedNorm = blocked.map(normalizeDomain).filter(Boolean);
      for (const bd of blockedNorm) {
        for (const td of tenantDomains) {
          if (isSameOrSubdomain(bd, td) || isSameOrSubdomain(td, bd)) return false;
        }
      }
    }

    /* (c) match-only visibility — brochure Privacy slide promise:
       "Show your profile only to recruiters whose roles genuinely match."
       Drop the candidate when:
         • the toggle is on, AND
         • the recruiter has zero open jobs whose tokenized title overlaps
           with any of the candidate's preferredRoles tokens.
       If the candidate hasn't filled in preferredRoles we have nothing to
       match against — fail closed (drop them) so an empty profile + the
       toggle = invisible by default, which is the privacy-respecting choice. */
    if (c.matchOnlyVisibility === true) {
      if (!tenantTokens || tenantTokens.size === 0) return false;
      const roles = preferredRolesByCandidate.get(c.id) ?? [];
      if (roles.length === 0) return false;
      let overlapped = false;
      for (const role of roles) {
        for (const tok of tokenizeTitle(role)) {
          if (tenantTokens.has(tok)) { overlapped = true; break; }
        }
        if (overlapped) break;
      }
      if (!overlapped) return false;
    }
    return true;
  });
}

/* ── Hard candidate exclusions ────────────────────────────────────────────
   Non-negotiable removals applied to ANY candidate result set before it can
   reach a recruiter/employer discovery surface, mirroring GET /candidates:
     • GDPR-erased rows (dataErasedAt)
     • do-not-contact rows (doNotContact)
     • not-yet-onboarded self-registrations (pool="pending_profile")
   This is the SAME seal every platform-pool read path must pass through. Keep
   it and applyCandidatePrivacyFilter as the single source of truth — no read
   path may re-implement these filters inline. */
export function applyCandidateHardExclusions<T extends Record<string, any>>(rows: T[]): T[] {
  return rows
    .filter(c => !(c as any).dataErasedAt)
    .filter(c => (c as any).doNotContact !== true)
    .filter(c => (c as any).pool !== "pending_profile");
}
import { eq, count, desc, and, inArray, sql, or } from "drizzle-orm";
import { generateJSON } from "../lib/ai";
import { enrichCandidateFromResume, screenCandidateResume, rescoreCandidateForJob } from "../lib/enrich-candidate";
import { scoreCandidateForJob } from "../lib/icp-generator";
import { computeCandidateMerge } from "../lib/candidate-merge";
import { orchestrator } from "../lib/agents/orchestrator";
import { logCandidateEvent, actorTypeFromRole } from "../lib/candidate-event-logger.js";
import { createRequire } from "node:module";
import mammoth from "mammoth";
import { streamRecordingParts, listRecordingParts } from "../lib/s3Recording";
import { ObjectStorageService, s3Client } from "../lib/objectStorage";
import { GetObjectCommand } from "@aws-sdk/client-s3";
const _require = createRequire(import.meta.url);
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = _require("pdf-parse");

// Two multer instances: bulk upload (up to 20 files, used for batch CV import)
// and single CV upload (1 file, used when a recruiter uploads a CV for one candidate).
// Accepted-type allowlist for the bulk CV importer (parse-cvs is the only
// consumer of `upload`): PDF / DOCX / TXT / CSV. Gate by extension OR known
// MIME — browsers send inconsistent MIME for .docx (often
// application/octet-stream), so the extension is the reliable signal. The
// handler re-validates type + PDF magic bytes as a second layer.
const CV_ALLOWED_EXT = [".pdf", ".docx", ".txt", ".csv"];
const CV_ALLOWED_MIME = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/csv",
  "application/csv",
]);
const upload   = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const lower = file.originalname.toLowerCase();
    const ok = CV_ALLOWED_EXT.some(e => lower.endsWith(e)) || CV_ALLOWED_MIME.has(file.mimetype);
    cb(null, ok);
  },
});
const cvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1  } });

const router: IRouter = Router();

/* ── Auth helpers ────────────────────────────────────────────────────────── */

/**
 * Resolve the calling user from the Authorization header.
 * Currently uses demo_token_<userId> tokens. Returns null if the token is
 * missing, invalid, or does not match any user row.
 */
async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

/* Tenant visibility scoping (own tenant + ALL descendant tenants) lives in
 * lib/tenantUtils.ts getAllowedTenantIds, imported above. Whether a caller can
 * also see pool="platform" candidates is controlled separately by
 * tenant.candidateDatabaseAccess. */

/* Tenant-scoped application count for a candidate. A platform-pool candidate
 * may have applications across many tenants; an employer must only ever see
 * the count within their OWN visibility scope, never a global total that
 * leaks how many other companies are pursuing the person (Step-3 audit).
 *   scope === null      → platform_admin, no tenant filter (sees all)
 *   scope === []        → no scope, count nothing
 *   scope === [t1,t2..] → count only applications in those tenants
 * Defined here (before the first route registration) so the route-ownership
 * scanner does not sweep its candidateId param into an adjacent route's span. */
function appCountForTenants(candId: string, scope: string[] | null) {
  return db.select({ count: count() }).from(applicationsTable).where(and(
    eq(applicationsTable.candidateId, candId),
    scope === null ? undefined : inArray(applicationsTable.tenantId, scope.length ? scope : ["__none__"]),
  ));
}

/* ── CV parse (single — no auth needed, stateless) ───────────────────────── */
router.post("/candidates/parse-cv", cvUpload.single("cv"), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded" });

  const mime = file.mimetype;
  let text = "";

  try {
    if (mime === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf")) {
      const parsed = await pdfParse(file.buffer);
      text = parsed.text;
    } else if (
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mime === "application/msword" ||
      file.originalname.toLowerCase().endsWith(".docx") ||
      file.originalname.toLowerCase().endsWith(".doc")
    ) {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = result.value;
    } else {
      return res.status(400).json({ error: "Unsupported file type. Please upload a PDF or Word document." });
    }
  } catch (err) {
    return res.status(422).json({ error: "Could not extract text from this file." });
  }

  if (!text.trim()) {
    return res.status(422).json({ error: "The file appears to be empty or has no readable text." });
  }

  const truncated = text.slice(0, 6000);

  const extracted = await generateJSON<any>(
    `Extract structured candidate information from this resume/CV text.

CV TEXT:
${truncated}

Return JSON with these fields (use null for anything not found):
{
  "firstName": string | null,
  "lastName": string | null,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "currentTitle": string | null,
  "currentCompany": string | null,
  "linkedinUrl": string | null,
  "githubUrl": string | null,
  "skills": string[] (up to 15 top technical and soft skills),
  "summary": string | null (2-3 sentence professional summary based on the CV),
  "yearsOfExperience": number | null
}

Rules:
- currentTitle = most recent job title
- currentCompany = most recent employer
- Extract the LinkedIn URL exactly as written (must start with linkedin.com)
- Extract GitHub URL if present
- Skills should be specific technologies and competencies, not generic phrases`,
    "You are a precise CV parser. Extract information exactly as it appears. Return only valid JSON.",
  );

  res.json({ ...extracted, fileName: file.originalname, charCount: text.length });
});

/* ── Candidate map helper ─────────────────────────────────────────────────── */
/* Coerce the many shapes a "current employee" flag can arrive in (CSV cells are
   strings) into a strict boolean: true only for real true / "true" / "1" / 1. */
function coerceEmployeeFlag(v: unknown): boolean {
  return v === true || v === "true" || v === "1" || v === 1;
}

/* Employer-facing candidate serializer — EXPLICIT FIELD ALLOWLIST.
 *
 * This is the single chokepoint that decides which candidate columns an
 * employer / recruiter / admin surface may see. It returns ONLY employer-
 * appropriate fields; every other column is structurally dropped so it can
 * never "ride along" on a response (Step-3 field-leak audit). mapCandidate is
 * called ONLY from employer/recruiter/admin surfaces in this file — the
 * candidate self-portal does not use it — so this allowlist never narrows a
 * candidate's own view of their settings.
 *
 * DELIBERATELY OMITTED (job-seeking / privacy-posture signals — must NEVER be
 * disclosed to an employer):
 *   hideFromCurrentEmployer, currentEmployerDomain, blockedCompanyDomains,
 *   matchOnlyVisibility, discoveryPaused — the discovery seal READS these to
 *     decide who is visible, then must not leak the candidate's posture.
 *   createdAt (profile-creation date) — a job-seeking recency signal with no
 *     employer value. For discoverable platform rows the list handler adds a
 *     sanctioned recency view (activityStatus / lastActiveAt) instead.
 *   weeklyDigestLastSentAt — internal scheduler bookkeeping.
 */
export function mapCandidate(c: any, applicationCount = 0) {
  const iso = (v: any) => (v instanceof Date ? v.toISOString() : (v ?? null));
  return {
    id: c.id,
    tenantId: c.tenantId,
    userId: c.userId ?? null,
    firstName: c.firstName,
    lastName: c.lastName,
    // Emails are always presented in lowercase for consistency.
    email: typeof c.email === "string" ? c.email.toLowerCase() : c.email,
    phone: c.phone ?? null,
    location: c.location ?? null,
    timezone: c.timezone ?? null,
    currentTitle: c.currentTitle ?? null,
    currentCompany: c.currentCompany ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    githubUrl: c.githubUrl ?? null,
    skills: c.skills || [],
    source: c.source ?? null,
    verificationStatus: c.verificationStatus ?? null,
    verificationResult: c.verificationResult ?? null,
    resumeUrl: c.resumeUrl ?? null,
    talentMatchScore: c.talentMatchScore ?? null,
    resumeScreenScore: c.resumeScreenScore ?? null,
    pool: c.pool,
    // DNC state is recruiter-facing — they must know a candidate opted out.
    doNotContact: c.doNotContact ?? false,
    dncAt: iso(c.dncAt),
    dncReason: c.dncReason ?? null,
    dncSetBy: c.dncSetBy ?? null,
    dataErasedAt: iso(c.dataErasedAt),
    hiringManagerApproval: c.hiringManagerApproval ?? null,
    createdById: c.createdById ?? null,
    // Work authorization / sponsorship — job-relevant screening, NOT demographics.
    workAuthorized: c.workAuthorized ?? null,
    requiresSponsorship: c.requiresSponsorship ?? null,
    sponsorshipCountry: c.sponsorshipCountry ?? null,
    sponsorshipNotes: c.sponsorshipNotes ?? null,
    screeningCompletedAt: iso(c.screeningCompletedAt),
    workAuthSource: c.workAuthSource ?? null,
    isCurrentEmployee: c.isCurrentEmployee ?? false,
    updatedAt: iso(c.updatedAt),
    applicationCount,
  };
}

/* ── POST /candidates/nl-search — Natural Language candidate search ────────── */
router.post("/candidates/nl-search", validate({ body: NlSearchBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { query } = req.body as { query?: string };
  if (!query?.trim()) {
    res.status(400).json({ error: "query is required" }); return;
  }

  /* Step 1 — AI parses the NL query into structured filters */
  type NlFilters = {
    skills: string[];
    locations: string[];
    countries: string[];
    activityStatus: "active" | "passive" | "inactive" | null;
    maxDaysSinceActive: number | null;
    experienceLevel: string | null;
    keywords: string[];
    pool: "platform" | "tenant" | null;
    interpretation: string;
  };

  const parsed = await generateJSON<NlFilters>(
    `You are a recruiting assistant. Parse the user's natural-language candidate search query into structured filters.

Query: "${query}"

Return a JSON object with these fields:
- skills: string[] — specific technical or soft skills mentioned (e.g. ["React", "TypeScript", "Python"])
- locations: string[] — cities or regions mentioned (e.g. ["London", "New York"])
- countries: string[] — countries mentioned including common abbreviations expanded (e.g. "US" → "United States", "UK" → "United Kingdom"). Include common variations.
- activityStatus: "active" | "passive" | "inactive" | null — if mentioned. "active" = recently active. If days are mentioned, compute the status.
- maxDaysSinceActive: number | null — if a time window like "last 30 days" is mentioned, put 30 here
- experienceLevel: "junior" | "mid" | "senior" | "lead" | null — if mentioned
- keywords: string[] — other important search terms (job titles, technologies, industries)
- pool: "platform" | "tenant" | null — "platform" if they say "platform pool" or "Lexy candidates"; "tenant" if "my pipeline" or "my candidates"; null otherwise
- interpretation: string — a concise human-readable description of what you understood (1 sentence, start with "Showing candidates…")

Only include non-empty arrays. Be liberal in matching location names (include alternate spellings).`,
    { skills: [], locations: [], countries: [], activityStatus: null, maxDaysSinceActive: null, experienceLevel: null, keywords: [], pool: null, interpretation: "Showing matching candidates" }
  );

  /* Step 2 — Load all candidates visible to this caller ───────────────────
   *
   * Three-layer visibility gate applied in order:
   *
   *   a) Hard exclusions (always hidden regardless of role):
   *      - dataErasedAt set   → GDPR-erased records, must never surface
   *      - doNotContact=true  → candidate opted out, must not be shown to recruiters
   *      - pool="pending_profile" → candidate registered but hasn't finished their
   *                                 career interview yet; hidden from all recruiter views
   *
   *   b) Tenant scope (non-admin users only):
   *      - pool="platform" candidates: only visible if tenant.candidateDatabaseAccess=true
   *      - pool="tenant" candidates: only visible if tenantId ∈ allowed set
   *        (own tenant + direct child tenants)
   *
   *   c) AI-parsed pool filter: if the user's query explicitly said "my candidates"
   *      or "platform pool", filter down to just that pool value.
   */
  /* Defensive cap (see lib/query-limits.ts) + push tenant scope into SQL —
     same rationale as GET /candidates. Platform-pool access flag is resolved
     up front so the WHERE only widens to platform rows when the tenant can
     actually see them (avoids starving tenant rows from the 1000-slice). */
  let base: any[];
  if (user.role === "platform_admin") {
    base = await db.select().from(candidatesTable).orderBy(desc(candidatesTable.createdAt)).limit(MAX_PAGE_SIZE);
  } else {
    const earlyAllowed = await getDataScopeTenantIds(user);
    if (!earlyAllowed || earlyAllowed.length === 0) {
      res.json({ interpretation: parsed.interpretation, filters: parsed, candidates: [] }); return;
    }
    let hasPlatformAccessEarly = false;
    if (user.tenantId) {
      const [tenantRow] = await db.select({ candidateDatabaseAccess: tenantsTable.candidateDatabaseAccess })
        .from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
      hasPlatformAccessEarly = tenantRow?.candidateDatabaseAccess === true;
    }
    const whereClause = hasPlatformAccessEarly
      ? or(inArray(candidatesTable.tenantId, earlyAllowed), eq(candidatesTable.pool, "platform"))
      : inArray(candidatesTable.tenantId, earlyAllowed);
    base = await db.select().from(candidatesTable)
      .where(whereClause)
      .orderBy(desc(candidatesTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  }

  // a) Hard exclusions
  // Canonical hard exclusions (erased / DNC / pending_profile) — use the shared
  // helper rather than re-implementing the filters inline, so this employer read
  // shares the ONE source of truth with GET /candidates and candidate-database.
  base = applyCandidateHardExclusions(base);
  /* Pass null for platform_admin so the filter no-ops — admins can have a
     non-null tenantId in seeded/staff data and would otherwise be subject to
     candidate-privacy hiding meant only for external recruiters. */
  base = await applyCandidatePrivacyFilter(base, user?.role === "platform_admin" ? null : (user?.tenantId ?? null));

  // b) Tenant scope
  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed) {
      if (allowed.length === 0) {
        res.json({ interpretation: parsed.interpretation, filters: parsed, candidates: [] }); return;
      }
      // Check if this tenant has been granted access to the shared platform pool
      let hasPlatformAccess = false;
      if (user.tenantId) {
        const [tenantRow] = await db.select({ candidateDatabaseAccess: tenantsTable.candidateDatabaseAccess })
          .from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
        hasPlatformAccess = tenantRow?.candidateDatabaseAccess === true;
      }
      base = base.filter(c => {
        const cPool = (c as any).pool ?? "tenant";
        if (cPool === "platform") return hasPlatformAccess;      // shared pool: gated by flag
        return allowed.includes((c as any).tenantId ?? "");      // tenant pool: must be in allowed set
      });
    }
  }

  // c) Explicit pool filter from the AI-parsed query (e.g. "show me platform candidates")
  if (parsed.pool) {
    base = base.filter(c => ((c as any).pool ?? "tenant") === parsed.pool);
  }

  /* Step 4 — Apply keyword/skill/location filters (guard against AI omitting fields) */
  const pSkills    = parsed.skills    ?? [];
  const pLocations = parsed.locations ?? [];
  const pCountries = parsed.countries ?? [];
  const pKeywords  = parsed.keywords  ?? [];
  const hasSkills    = pSkills.length > 0;
  const hasLocations = pLocations.length > 0 || pCountries.length > 0;
  const hasKeywords  = pKeywords.length > 0;
  const hasLevel     = !!parsed.experienceLevel;
  const locationTerms = [...pLocations, ...pCountries].map(s => s.toLowerCase());

  base = base.filter(c => {
    const candidateSkills: string[] = (c as any).skills ?? [];
    const location = ((c as any).location ?? "").toLowerCase();
    const searchBlob = [
      (c as any).firstName, (c as any).lastName, (c as any).email,
      (c as any).currentTitle, (c as any).currentCompany, (c as any).location,
    ].filter(Boolean).join(" ").toLowerCase();

    /* Skills — candidate must have at least one of the requested skills */
    if (hasSkills) {
      const skillsLower = candidateSkills.map((s: string) => s.toLowerCase());
      const matchesSkill = pSkills.some(sk =>
        skillsLower.some(cs => cs.includes(sk.toLowerCase()) || sk.toLowerCase().includes(cs))
      );
      if (!matchesSkill) return false;
    }

    /* Location / country */
    if (hasLocations) {
      const matchesLoc = locationTerms.some(lt => location.includes(lt));
      if (!matchesLoc) return false;
    }

    /* Keywords — candidate must match at least one keyword */
    if (hasKeywords) {
      const matchesKw = pKeywords.some(kw => searchBlob.includes(kw.toLowerCase()));
      if (!matchesKw) return false;
    }

    /* Experience level */
    if (hasLevel && parsed.experienceLevel) {
      if (!searchBlob.includes(parsed.experienceLevel.toLowerCase())) return false;
    }

    return true;
  });

  /* Step 5 — Compute activity status for platform candidates */
  const platformIds = base.filter(c => (c as any).pool === "platform").map(c => c.id);
  const lastPushMap = new Map<string, Date>();
  if (platformIds.length > 0) {
    const pushRows = await db
      .select({
        candidateId: (talentPoolSubmissionsTable as any).candidateId,
        maxPushedAt: sql<string>`MAX(${(talentPoolSubmissionsTable as any).pushedAt})`,
      })
      .from(talentPoolSubmissionsTable)
      .where(inArray((talentPoolSubmissionsTable as any).candidateId, platformIds))
      .groupBy((talentPoolSubmissionsTable as any).candidateId);
    for (const row of pushRows) {
      if (row.candidateId && row.maxPushedAt) lastPushMap.set(row.candidateId, new Date(row.maxPushedAt));
    }
  }

  const now = Date.now();
  const withActivity = base.map(c => {
    if ((c as any).pool !== "platform") return c;
    const updatedDate = new Date((c as any).updatedAt);
    const lastPush = lastPushMap.get(c.id);
    const lastActiveDate = lastPush && lastPush > updatedDate ? lastPush : updatedDate;
    const daysSince = Math.floor((now - lastActiveDate.getTime()) / 86_400_000);
    const activityStatus = daysSince <= 30 ? "active" : daysSince <= 90 ? "passive" : "inactive";
    // candidate-serialization-exempt: transient intermediate — this raw row is re-run through
    // mapCandidate() at the response-mapping step below (Step 7) before it is ever sent.
    return { ...c, lastActiveAt: lastActiveDate.toISOString(), activityStatus, daysSince };
  });

  /* Step 6 — Apply activity/days filter after computing status */
  let result = withActivity;
  if (parsed.activityStatus) {
    result = result.filter(c => (c as any).pool !== "platform" || (c as any).activityStatus === parsed.activityStatus);
  }
  if (parsed.maxDaysSinceActive != null) {
    result = result.filter(c => {
      if ((c as any).pool !== "platform") return true;
      return ((c as any).daysSince ?? 9999) <= parsed.maxDaysSinceActive!;
    });
  }

  /* Step 7 — Map to response shape */
  const candidates = result.map(c => ({
    ...mapCandidate(c),
    activityStatus: (c as any).activityStatus ?? null,
    lastActiveAt:   (c as any).lastActiveAt   ?? null,
  }));

  res.json({ interpretation: parsed.interpretation, filters: parsed, candidates });
});

/**
 * Resolve the full set of candidate ids a plain `recruiter` is responsible for —
 * i.e. candidates tied (via an application, a sourced row, or a platform-pool
 * push) to a requisition ASSIGNED to that recruiter.
 *
 * This is the authoritative narrowing for a recruiter's candidate list. It is
 * deliberately driven from the assigned-req linkage rather than intersecting a
 * pre-fetched recent-N slice of the tenant: a recruiter whose assigned
 * candidates happen to fall outside the most-recent MAX_PAGE_SIZE rows of a
 * large tenant would otherwise silently see none of them.
 *
 * The companion queries select a SINGLE id column and are NOT capped — the
 * recruiter must see EVERY candidate they are responsible for, so a fixed cap
 * here would silently drop assignments beyond it (the exact bug this fixes). A
 * one-column id set is cheap even at tens of thousands of rows; the caller
 * fetches the actual candidate rows by these ids in bounded chunks.
 */
async function getRecruiterAssignedCandidateIds(
  user: Pick<Awaited<ReturnType<typeof getCallerUser>> & {}, "id" | "role" | "tenantId">,
): Promise<Set<string>> {
  const ids = new Set<string>();
  const myJobIds = await getRecruiterAssignedJobIds(user);
  if (myJobIds.length === 0) return ids;
  const [apps, sourced, pushed] = await Promise.all([
    db.select({ candidateId: applicationsTable.candidateId }).from(applicationsTable)
      .where(inArray(applicationsTable.jobId, myJobIds)),
    db.select({ normalizedCandidateId: sourcedCandidatesTable.normalizedCandidateId }).from(sourcedCandidatesTable)
      .where(inArray(sql`${sourcedCandidatesTable.rawData}->>'jobId'`, myJobIds)),
    db.select({ candidateId: (talentPoolSubmissionsTable as any).candidateId }).from(talentPoolSubmissionsTable)
      .where(inArray((talentPoolSubmissionsTable as any).jobPostingId, myJobIds)),
  ]);
  for (const a of apps) if (a.candidateId) ids.add(a.candidateId);
  for (const s of sourced) if (s.normalizedCandidateId) ids.add(s.normalizedCandidateId);
  for (const p of pushed) if (p.candidateId) ids.add(p.candidateId);
  return ids;
}

/**
 * Fetch full candidate rows for an id set in bounded chunks, returning them
 * ordered by createdAt DESC. Used by the recruiter narrowing path so the
 * recruiter's COMPLETE assigned list is materialised without a single oversized
 * `IN (...)` clause and without the MAX_PAGE_SIZE cutoff that would otherwise
 * drop assignments beyond the cap.
 */
async function fetchCandidatesByIdsOrdered(idList: string[]): Promise<any[]> {
  const CHUNK = 500;
  const chunks: string[][] = [];
  for (let i = 0; i < idList.length; i += CHUNK) chunks.push(idList.slice(i, i + CHUNK));
  const results = await Promise.all(
    chunks.map(ch => db.select().from(candidatesTable).where(inArray(candidatesTable.id, ch))),
  );
  const rows = results.flat();
  rows.sort((a, b) => {
    const at = new Date((a as any).createdAt ?? 0).getTime();
    const bt = new Date((b as any).createdAt ?? 0).getTime();
    return bt - at;
  });
  return rows;
}

/* ── GET /candidates ──────────────────────────────────────────────────────── */
// Scoped to the caller's tenant (+ children). Platform admin sees all.
// Tenants only see pool='tenant' candidates unless candidateDatabaseAccess=true.
router.get("/candidates", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { search, page = 1, limit = 20, jobId, pool: poolFilter } = req.query;

  /* Defensive cap (see lib/query-limits.ts) + push tenant scope into SQL so a
     small tenant in a multi-tenant deployment still gets a meaningful slice.
     We resolve the platform-pool access flag UP FRONT so the WHERE only widens
     to platform rows for tenants that can actually see them — otherwise a
     flood of recent platform rows would fill the 1000-slice and starve the
     tenant's own candidates. */
  let base: any[];
  if (user.role === "platform_admin") {
    base = await db.select().from(candidatesTable).orderBy(desc(candidatesTable.createdAt)).limit(MAX_PAGE_SIZE);
  } else if (user.role === "recruiter") {
    /* A plain recruiter sees ONLY candidates tied to requisitions assigned to
       them, and must see ALL of them — no page-size cutoff. Resolve the full
       assigned-candidate id set from the assigned-req linkage (uncapped, ids
       only) and materialise the rows in bounded chunks. This replaces the old
       "recent-N tenant slice ∩ assigned ids" approach, which silently dropped a
       recruiter's assigned candidates whenever they fell outside the most-recent
       MAX_PAGE_SIZE rows of a large tenant. The downstream
       erased/DNC/pending/privacy/pool/tenant filters below still apply
       unchanged. */
    const allowedRecruiterCandidateIds = await getRecruiterAssignedCandidateIds(user);
    base = allowedRecruiterCandidateIds.size === 0
      ? []
      : await fetchCandidatesByIdsOrdered([...allowedRecruiterCandidateIds]);
  } else {
    // getDataScopeTenantIds narrows a recruiter_admin to ONLY their assigned
    // client sub-tenants; for everyone else it is the full allowed subtree.
    const earlyAllowed = await getDataScopeTenantIds(user);
    if (!earlyAllowed || earlyAllowed.length === 0) {
      res.json({ candidates: [], total: 0, page: Number(page), limit: Number(limit) });
      return;
    }
    let hasPlatformAccessEarly = false;
    if (user.tenantId) {
      const [tenantRow] = await db.select({ candidateDatabaseAccess: tenantsTable.candidateDatabaseAccess })
        .from(tenantsTable).where(eq(tenantsTable.id, user.tenantId)).limit(1);
      hasPlatformAccessEarly = tenantRow?.candidateDatabaseAccess === true;
    }
    const whereClause = hasPlatformAccessEarly
      ? or(inArray(candidatesTable.tenantId, earlyAllowed), eq(candidatesTable.pool, "platform"))
      : inArray(candidatesTable.tenantId, earlyAllowed);
    base = await db.select().from(candidatesTable)
      .where(whereClause)
      .orderBy(desc(candidatesTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  }

  // Hard exclusions (GDPR-erased, DNC, not-yet-onboarded pending_profile) —
  // one canonical implementation shared with every other platform-pool read
  // path (career-recording/-profile by id, the platform candidate-database).
  base = applyCandidateHardExclusions(base);

  // Per-candidate privacy: hide-from-current-employer + per-company opt-out blocklist
  /* Pass null for platform_admin so the filter no-ops — admins can have a
     non-null tenantId in seeded/staff data and would otherwise be subject to
     candidate-privacy hiding meant only for external recruiters. */
  base = await applyCandidatePrivacyFilter(base, user?.role === "platform_admin" ? null : (user?.tenantId ?? null));

  // Scope to the caller's allowed tenants (recruiter_admin → assigned clients)
  if (user && user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed) {
      if (allowed.length === 0) {
        res.json({ candidates: [], total: 0, page: Number(page), limit: Number(limit) });
        return;
      }
      // Check if the user's tenant has access to the platform candidate pool
      let hasPlatformAccess = false;
      if (user.tenantId) {
        const [tenantRow] = await db.select({ candidateDatabaseAccess: tenantsTable.candidateDatabaseAccess })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, user.tenantId))
          .limit(1);
        hasPlatformAccess = tenantRow?.candidateDatabaseAccess ?? false;
      }
      base = base.filter(c => {
        const cPool = (c as any).pool ?? "tenant";
        if (cPool === "platform") return hasPlatformAccess;
        return allowed.includes(c.tenantId ?? "");
      });
    }
  }

  // Optional pool filter (platform_admin can filter by pool)
  if (poolFilter && (poolFilter === "platform" || poolFilter === "tenant")) {
    base = base.filter(c => ((c as any).pool ?? "tenant") === poolFilter);
  }

  /* A plain recruiter's list is already narrowed to candidates tied to their
     assigned requisitions — `base` was built directly from that linkage above
     (see getRecruiterAssignedCandidateIds), so no post-fetch intersection is
     needed here. When a specific jobId is requested, the jobId branch below
     independently gates job access to the recruiter's own reqs. */

  // If jobId is provided, restrict to candidates linked to that job — either
  // via an application OR via a sourced_candidates row tagged with this jobId
  // (manual / bulk / CSV imports land in sourced_candidates first; the
  // applications row is only created when they progress through the pipeline).
  // Sourced rows that have NOT yet been normalized into the candidates table
  // are synthesized below so they show up alongside normalized records.
  let sourcedOnly: any[] = [];
  let sourcedMatchScoreMap = new Map<string, number | null>();
  if (jobId) {
    const jid = String(jobId);

    /* Gate job access ONCE, up front. A candidate list scoped to a jobId
       reveals which candidates are linked to that job, so only callers who may
       access the job (its tenant is within their allowed tenants, or they are a
       platform_admin) may run any of the job-linked filtering below. Without
       this, a caller with platform-pool browse access could pass a foreign
       jobId and enumerate the platform candidates attached to another tenant's
       job (an association leak). Unauthorized callers get an empty list. */
    let jobAllowed = user.role === "platform_admin";
    let allowedForJob: string[] | null = null;
    if (!jobAllowed) {
      const { jobsTable } = await import("@workspace/db");
      const [jobRow] = await db.select({ id: jobsTable.id, tenantId: jobsTable.tenantId, assignedRecruiterId: jobsTable.assignedRecruiterId })
        .from(jobsTable).where(eq(jobsTable.id, jid)).limit(1);
      allowedForJob = await getDataScopeTenantIds(user);
      jobAllowed = !!jobRow && (!allowedForJob || allowedForJob.includes(jobRow.tenantId ?? ""));
      // A plain recruiter may only inspect candidates of requisitions assigned
      // to them — either as the primary recruiter OR via the job_recruiters
      // roster (multi-recruiter assignment) — even within their own subtree.
      if (jobAllowed && user.role === "recruiter") {
        jobAllowed = !!jobRow && await recruiterIsAssignedToJob(user.id, jobRow);
      }
    }

    if (!jobAllowed) {
      base = [];
    } else {
    const { talentPoolSubmissionsTable } = await import("@workspace/db");
    const [apps, sourced, platformPushed] = await Promise.all([
      // Defensive caps (see lib/query-limits.ts) on all three companion
      // queries — a high-volume job could otherwise pull arbitrarily large
      // ID sets into Node memory just to compute a candidate-list filter.
      db.select({ candidateId: applicationsTable.candidateId })
        .from(applicationsTable)
        .where(eq(applicationsTable.jobId, jid))
        .limit(MAX_PAGE_SIZE),
      db.select().from(sourcedCandidatesTable)
        .where(sql`raw_data->>'jobId' = ${jid}`)
        .limit(MAX_PAGE_SIZE),
      db.select({ candidateId: (talentPoolSubmissionsTable as any).candidateId })
        .from(talentPoolSubmissionsTable)
        .where(eq((talentPoolSubmissionsTable as any).jobPostingId, jid))
        .limit(MAX_PAGE_SIZE),
    ]);
    const ids = new Set<string>();
    for (const a of apps) if (a.candidateId) ids.add(a.candidateId);
    for (const s of sourced) if (s.normalizedCandidateId) ids.add(s.normalizedCandidateId);
    for (const p of platformPushed) if (p.candidateId) ids.add(p.candidateId);
    base = ids.size ? base.filter(c => ids.has(c.id)) : [];

    /* A candidate explicitly placed in THIS job's pipeline (an application row,
       a sourced row tagged with this jobId, or a platform-pool push) must show
       up in the job's Candidates tab even when the candidate is a platform-pool
       record and the caller's tenant lacks global candidate-database browse
       access — otherwise the Candidates tab reads 0 while the Pipeline board
       shows the candidate (the board does not apply the platform-pool gate).
       Job access was already confirmed above, so we re-add only candidates that
       the earlier tenant/pool filtering removed. Erased / DNC / pending_profile
       / explicit pool filter / privacy filters still apply. */
    if (ids.size) {
      const haveIds = new Set(base.map(c => c.id));
      const missingIds = [...ids].filter(id => !haveIds.has(id));
      if (missingIds.length) {
        const extra = await db.select().from(candidatesTable)
          .where(inArray(candidatesTable.id, missingIds))
          .limit(MAX_PAGE_SIZE);
        let extraFiltered = applyCandidateHardExclusions(extra);
        // Honour an explicit pool filter on re-added rows too, so a
        // ?pool=tenant query never leaks platform-pool records back in.
        if (poolFilter && (poolFilter === "platform" || poolFilter === "tenant")) {
          extraFiltered = extraFiltered.filter(c => ((c as any).pool ?? "tenant") === poolFilter);
        }
        const extraVisible = await applyCandidatePrivacyFilter(
          extraFiltered,
          user?.role === "platform_admin" ? null : (user?.tenantId ?? null),
        );
        base = [...base, ...extraVisible];
      }
    }

    // Build a lookup so normalised candidates can inherit the raw matchScore
    // stored in sourced_candidates.raw_data when talent_match_score is null.
    for (const s of sourced) {
      if (s.normalizedCandidateId) {
        const ms = (s.rawData as any)?.matchScore ?? null;
        if (ms != null) sourcedMatchScoreMap.set(s.normalizedCandidateId, Number(ms));
      }
    }

    // Sourced rows with no normalized candidate row — build candidate-shaped
    // objects so the Candidates tab matches what the Pipeline kanban renders.
    sourcedOnly = sourced
      .filter(s => !s.normalizedCandidateId)
      .filter(s => !allowedForJob || allowedForJob.includes(s.tenantId ?? ""))
      .filter(s => ((s.rawData as any)?.doNotContact !== true))
      .map(s => {
        const raw = (s.rawData as any) ?? {};
        return {
          id: s.id,
          tenantId: s.tenantId,
          firstName: raw.firstName ?? "Unknown",
          lastName: raw.lastName ?? "",
          email: typeof raw.email === "string" ? raw.email.toLowerCase() : (raw.email ?? null),
          phone: raw.phone ?? null,
          currentTitle: raw.currentTitle ?? null,
          currentCompany: raw.currentCompany ?? null,
          location: raw.location ?? null,
          source: s.source,
          skills: raw.skills ?? [],
          linkedinUrl: raw.linkedinUrl ?? null,
          githubProfile: raw.githubProfile ?? null,
          githubUrl: raw.githubUrl ?? null,
          resumeScreenScore: raw.matchScore ?? null,
          talentMatchScore: raw.matchScore != null ? Number(raw.matchScore) : null,
          verificationStatus: raw.verificationStatus ?? null,
          createdAt: s.createdAt,
          updatedAt: s.createdAt,
          doNotContact: false,
          applicationCount: 0,
          isSourced: true,
          sourcedId: s.id,
        };
      });
    }
  }

  const filtered = search
    ? base.filter(c => `${c.firstName} ${c.lastName} ${c.email} ${c.currentTitle} ${c.currentCompany}`.toLowerCase().includes(String(search).toLowerCase()))
    : base;

  /* applicationCount must reflect ONLY the caller's own tenant scope — never a
   * cross-tenant global total that would leak how many other companies are
   * pursuing a platform-pool candidate (Step-3 audit). */
  const countScope = await getDataScopeTenantIds(user);
  const withCounts = await Promise.all(filtered.map(async (c) => {
    const [apps] = await appCountForTenants(c.id, countScope);
    const mapped = mapCandidate(c, Number(apps.count));
    // If the candidates row has no talent_match_score but there is a sourced
    // match score for this job, use it so the Pipeline Candidates tab shows a
    // meaningful score rather than N/A.
    if ((mapped.talentMatchScore == null) && sourcedMatchScoreMap.has(c.id)) {
      mapped.talentMatchScore = sourcedMatchScoreMap.get(c.id) ?? null;
    }
    return mapped;
  }));

  // Apply the same search filter to synthesized sourced rows.
  const sourcedFiltered = search
    ? sourcedOnly.filter(c => `${c.firstName} ${c.lastName} ${c.email ?? ""} ${c.currentTitle ?? ""} ${c.currentCompany ?? ""}`.toLowerCase().includes(String(search).toLowerCase()))
    : sourcedOnly;
  const sourcedMapped = sourcedFiltered.map(c => ({
    // candidate-serialization-exempt: `c` is a synthesized sourced_candidates row (tenant-owned,
    // carries no candidatesTable privacy-posture columns), not a platform-pool candidate row.
    ...c,
    createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
    updatedAt: c.updatedAt instanceof Date ? c.updatedAt.toISOString() : c.updatedAt,
  }));

  // Compute activity status for platform pool candidates
  // lastActiveAt = MAX(updatedAt, last pushed_at from talent_pool_submissions)
  // activityStatus: "active" ≤30 days, "passive" 31-90 days, "inactive" >90 days
  const platformIds = withCounts.filter(c => (c as any).pool === "platform").map(c => c.id);
  const lastPushMap = new Map<string, Date>();
  if (platformIds.length > 0) {
    const pushRows = await db
      .select({
        candidateId: (talentPoolSubmissionsTable as any).candidateId,
        maxPushedAt: sql<string>`MAX(${(talentPoolSubmissionsTable as any).pushedAt})`,
      })
      .from(talentPoolSubmissionsTable)
      .where(inArray((talentPoolSubmissionsTable as any).candidateId, platformIds))
      .groupBy((talentPoolSubmissionsTable as any).candidateId);
    for (const row of pushRows) {
      if (row.candidateId && row.maxPushedAt) {
        lastPushMap.set(row.candidateId, new Date(row.maxPushedAt));
      }
    }
  }
  const now = Date.now();
  const withActivity = withCounts.map(c => {
    if ((c as any).pool !== "platform") return c;
    const updatedDate = new Date(c.updatedAt as string);
    const lastPush = lastPushMap.get(c.id);
    const lastActiveDate = lastPush && lastPush > updatedDate ? lastPush : updatedDate;
    const daysSince = Math.floor((now - lastActiveDate.getTime()) / 86_400_000);
    const activityStatus = daysSince <= 30 ? "active" : daysSince <= 90 ? "passive" : "inactive";
    // candidate-serialization-exempt: `c` here is already mapCandidate() output (built in
    // withCounts above); this only appends the sanctioned activityStatus/lastActiveAt view.
    return { ...c, lastActiveAt: lastActiveDate.toISOString(), activityStatus };
  });

  /* ── Cross-pool dedup hint ─────────────────────────────────────────────────
     For each PLATFORM-pool result, check whether the caller's tenant already
     has an internal candidate row with the same email. If so, tag the row
     with `alreadyInTenantDb: true` and the internal candidate id so the UI
     can show an "Already in your DB" pill that deep-links to the internal
     record. We DO NOT hide or merge — the platform row remains discoverable;
     the tenant just gets a clear signal they already own this person.
     Skipped for platform_admin (they see all rows by design) and for users
     with no tenantId. */
  const hasPlatformResults = withActivity.some(c => (c as any).pool === "platform" && (c as any).email);
  if (hasPlatformResults && user && user.role !== "platform_admin" && user.tenantId) {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && allowed.length > 0) {
      const ownEmailRows = await db
        .select({ id: candidatesTable.id, email: candidatesTable.email })
        .from(candidatesTable)
        .where(and(
          inArray(candidatesTable.tenantId, allowed),
          sql`${candidatesTable.pool} = 'tenant'`,
          sql`${candidatesTable.email} IS NOT NULL`,
        ));
      const ownEmailMap = new Map<string, string>();
      for (const r of ownEmailRows) {
        if (r.email) ownEmailMap.set(r.email.toLowerCase(), r.id);
      }
      if (ownEmailMap.size > 0) {
        for (let i = 0; i < withActivity.length; i++) {
          const c = withActivity[i] as any;
          if (c.pool !== "platform" || !c.email) continue;
          const internalId = ownEmailMap.get(String(c.email).toLowerCase());
          if (internalId && internalId !== c.id) {
            // candidate-serialization-exempt: `c` is already mapCandidate() output (from
            // withActivity); this only tags the already-mapped row with a cross-pool dedup hint.
            withActivity[i] = { ...c, alreadyInTenantDb: true, internalCandidateId: internalId };
          }
        }
      }
    }
  }

  const merged = [...withActivity, ...sourcedMapped];
  res.json({ candidates: merged, total: merged.length, page: Number(page), limit: Number(limit) });
});

/* ── POST /candidates ────────────────────────────────────────────────────── */
/* Link a candidate to a job: score them and create the application + sourced
 * rows so they appear on the pipeline board. Idempotent — if an application
 * already exists for (candidate, job) it is left as-is and its score returned.
 * Returns the talent match score (or null). */
async function linkCandidateToJob(
  candidate: typeof candidatesTable.$inferSelect,
  jobId: string | null,
  tenantId: string,
  source: string | null | undefined,
): Promise<number | null> {
  if (!jobId) return null;
  const jid = String(jobId);

  const [existingApp] = await db.select().from(applicationsTable)
    .where(and(eq(applicationsTable.candidateId, candidate.id), eq(applicationsTable.jobId, jid)))
    .limit(1);
  if (existingApp) return existingApp.matchScore ?? null;

  // Score against the JOB's own tenant, not the caller/candidate tenant. Tenants
  // form a tree, so a parent-tenant recruiter can legitimately link a candidate
  // to a job that lives in a child tenant. scoreCandidateForJob guards its job
  // lookup by the tenant it's given — passing the caller's tenant here would
  // fail to find a cross-tenant job and silently return null ("Not scored").
  // The caller's access to this job's tenant is already validated up-front
  // (getAllowedTenantIds) before any link path runs, so using the job's tenant
  // here is safe and is what makes cross-tenant fit scores populate.
  const [jobRow] = await db.select({ tenantId: jobsTable.tenantId })
    .from(jobsTable).where(eq(jobsTable.id, jid)).limit(1);
  const scoringTenantId = jobRow?.tenantId ?? tenantId;

  const scored = await scoreCandidateForJob(jid, {
    firstName: candidate.firstName,
    lastName: candidate.lastName,
    currentTitle: candidate.currentTitle,
    currentCompany: candidate.currentCompany,
    skills: candidate.skills,
    location: candidate.location,
  }, scoringTenantId);
  const matchScore = scored?.score ?? null;

  /* Sourcing-origin attribution: a prior LINX/talent-pool push to this tenant
     makes the entry L3XY-sourced (fee-eligible on hire); otherwise it's the
     customer's own candidate (manual, never fee-eligible). */
  const origin = await recruiterLinkOrigin({
    candidateId: candidate.id,
    tenantId,
    via: source === "cv_upload" ? "cv_upload" : "manual_link",
  });

  const [newApp] = await db.insert(applicationsTable).values({
    candidateId: candidate.id,
    jobId: jid,
    stage: "sourced",
    tenantId,
    matchScore: matchScore ?? undefined,
    ...origin,
  }).returning({ id: applicationsTable.id });
  void logCandidateEvent({
    candidateId: candidate.id,
    jobId: jid,
    tenantId,
    applicationId: newApp?.id ?? null,
    eventType: "JOB_MATCHED",
    actorType: "system",
    source: source === "cv_upload" ? "recruiter_action" : "lexy_app",
    metadata: { matchScore, stage: "sourced", source },
  });
  await db.insert(sourcedCandidatesTable).values({
    tenantId,
    source: source ?? "manual",
    normalizedCandidateId: candidate.id,
    rawData: {
      jobId: jid,
      firstName: candidate.firstName,
      lastName: candidate.lastName,
      email: candidate.email,
      phone: candidate.phone,
      location: candidate.location,
      currentTitle: candidate.currentTitle,
      currentCompany: candidate.currentCompany,
      linkedinUrl: candidate.linkedinUrl,
      githubUrl: candidate.githubUrl,
      skills: candidate.skills,
      stage: "sourced",
      source: source ?? "manual",
      matchScore,
      matchReason: scored?.reason ?? null,
    },
  });
  return matchScore;
}

router.post("/candidates", validate({ body: CreateCandidateBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  if (!user.tenantId) { res.status(403).json({ error: "Forbidden: no tenant context" }); return; }
  const tenantId = user.tenantId;
  const { firstName, lastName, email, phone, location, currentTitle, currentCompany, linkedinUrl, githubUrl, skills, source, jobId, resumeObjectPath, confirmDuplicate, mergeIntoExisting } = req.body;

  if (!firstName || !lastName) {
    return res.status(400).json({ error: "firstName and lastName are required" });
  }

  // If a jobId is supplied, verify the caller may access that work order BEFORE
  // any duplicate/merge handling — every path below (create, merge, race
  // recovery) may link the candidate to this job, so a foreign jobId must be
  // rejected up front or it could link cross-tenant records / pull another
  // tenant's role + ICP into scoring.
  if (jobId) {
    const { jobsTable } = await import("@workspace/db");
    const [jobRow] = await db
      .select({ tenantId: jobsTable.tenantId, status: jobsTable.status })
      .from(jobsTable)
      .where(eq(jobsTable.id, String(jobId)))
      .limit(1);
    if (!jobRow) { res.status(404).json({ error: "Work order not found" }); return; }
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(jobRow.tenantId)) {
      res.status(404).json({ error: "Work order not found" });
      return;
    }
    // Block adding candidates to a work order that has not cleared approval.
    if (!assertJobApproved(res, jobRow.status)) return;
  }

  // Hard duplicate check by email (always enforced — backed by the unique DB
  // index `(tenant_id, lower(email))`). One person = one row per tenant.
  if (email?.trim()) {
    const emailLower = email.trim().toLowerCase();
    const [existing] = await db.select()
      .from(candidatesTable)
      .where(and(sql`lower(${candidatesTable.email}) = ${emailLower}`, eq(candidatesTable.tenantId, tenantId)))
      .limit(1);
    if (existing) {
      // Diff the newly uploaded/entered info against the stored record.
      const { values, changes } = computeCandidateMerge(existing, {
        firstName, lastName, phone, location, currentTitle, currentCompany,
        linkedinUrl, githubUrl, resumeUrl: resumeObjectPath, skills,
      });

      // Recruiter confirmed the merge prompt → update the existing record with
      // the newer info and link them to the job, instead of creating a dup.
      if (mergeIntoExisting === true) {
        let merged = existing;
        if (Object.keys(values).length > 0) {
          const [updated] = await db.update(candidatesTable)
            .set(values)
            .where(eq(candidatesTable.id, existing.id))
            .returning();
          merged = updated ?? existing;
        }
        const talentMatchScore = await linkCandidateToJob(merged, jobId ? String(jobId) : null, tenantId, source);
        if (jobId && merged.resumeUrl) {
          screenCandidateResume(merged.id, String(jobId))
            .catch((err) => logger.error({ err, candidateId: merged.id }, "[candidates] auto-screen failed"));
        }
        const [apps] = await db.select({ count: count() }).from(applicationsTable).where(eq(applicationsTable.candidateId, merged.id));
        return res.status(200).json({ ...mapCandidate(merged, Number(apps.count)), talentMatchScore, merged: true });
      }

      // Otherwise surface a prompt: who it is + what would change on merge.
      const [apps] = await db.select({ count: count() }).from(applicationsTable).where(eq(applicationsTable.candidateId, existing.id));
      return res.status(409).json({
        error: "A candidate with this email already exists in your account.",
        reason: "email_match",
        existing: mapCandidate(existing, Number(apps.count)),
        proposedChanges: changes,
      });
    }
  }

  // Soft duplicate check by (first+last name) AND (phone OR LinkedIn URL).
  // Returns 409 with reason "potential_duplicate" so the client can show a confirm dialog;
  // the recruiter can re-submit with `confirmDuplicate: true` to override.
  if (confirmDuplicate !== true) {
    const allDigits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
    // Compare on the last 10 digits so "+1 (555) 111-2222" and "555-111-2222"
    // both normalize to "5551112222" and match each other.
    const phoneDigits = allDigits.length >= 10 ? allDigits.slice(-10) : allDigits;
    const liUrl = typeof linkedinUrl === "string" ? linkedinUrl.trim().toLowerCase() : "";
    const fnLower = String(firstName).trim().toLowerCase();
    const lnLower = String(lastName).trim().toLowerCase();
    const fuzzyConditions: any[] = [];
    if (phoneDigits.length >= 7) {
      fuzzyConditions.push(sql`right(regexp_replace(coalesce(${candidatesTable.phone}, ''), '\\D', '', 'g'), 10) = ${phoneDigits}`);
    }
    if (liUrl) {
      fuzzyConditions.push(sql`lower(coalesce(${candidatesTable.linkedinUrl}, '')) = ${liUrl}`);
    }
    if (fuzzyConditions.length > 0) {
      const [existing] = await db.select()
        .from(candidatesTable)
        .where(and(
          eq(candidatesTable.tenantId, tenantId),
          sql`lower(${candidatesTable.firstName}) = ${fnLower}`,
          sql`lower(${candidatesTable.lastName}) = ${lnLower}`,
          fuzzyConditions.length === 1 ? fuzzyConditions[0] : or(...fuzzyConditions),
        ))
        .limit(1);
      if (existing) {
        const existingPhoneDigits = (existing.phone ?? "").replace(/\D/g, "");
        const existingPhoneTail = existingPhoneDigits.length >= 10 ? existingPhoneDigits.slice(-10) : existingPhoneDigits;
        const matchedOn: string[] = [];
        if (phoneDigits && existingPhoneTail === phoneDigits) matchedOn.push("phone number");
        if (liUrl && existing.linkedinUrl && existing.linkedinUrl.trim().toLowerCase() === liUrl) matchedOn.push("LinkedIn URL");
        const [apps] = await db.select({ count: count() }).from(applicationsTable).where(eq(applicationsTable.candidateId, existing.id));
        return res.status(409).json({
          error: `A candidate with the same name and ${matchedOn.join(" / ") || "contact info"} already exists. Submit again to confirm this is a different person.`,
          reason: "potential_duplicate",
          matchedOn,
          existing: mapCandidate(existing, Number(apps.count)),
        });
      }
    }
  }


  let candidate: typeof candidatesTable.$inferSelect;
  try {
    [candidate] = await db.insert(candidatesTable).values({
      tenantId,
      firstName, lastName,
      // The `candidates.email` column is NOT NULL but recruiters often add
      // candidates without an email. Mint a unique placeholder so the partial
      // unique index `(tenant_id, lower(email))` doesn't collide across
      // multiple "no-email" candidates. Matches the bulk-import / CV-import
      // pattern used elsewhere in this file.
      email: email?.trim()
        ? email.trim().toLowerCase()
        : `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@unknown.local`,
      phone, location, currentTitle, currentCompany, linkedinUrl, githubUrl,
      skills: skills || [],
      source: source ?? "manual",
      verificationStatus: "unverified",
      resumeUrl: resumeObjectPath?.trim() || null,
      createdById: user.id,
    }).returning();
  } catch (insErr: any) {
    // A concurrent request created the same-email row between the pre-check and
    // this insert. Recover by re-selecting it and surfacing the same merge
    // prompt (or performing the merge) so we never 500 or create a duplicate.
    if (insErr?.code === "23505" && email?.trim()) {
      const emailLower = email.trim().toLowerCase();
      const [existing] = await db.select()
        .from(candidatesTable)
        .where(and(sql`lower(${candidatesTable.email}) = ${emailLower}`, eq(candidatesTable.tenantId, tenantId)))
        .limit(1);
      if (existing) {
        const { values, changes } = computeCandidateMerge(existing, {
          firstName, lastName, phone, location, currentTitle, currentCompany,
          linkedinUrl, githubUrl, resumeUrl: resumeObjectPath, skills,
        });
        if (mergeIntoExisting === true) {
          let merged = existing;
          if (Object.keys(values).length > 0) {
            const [updated] = await db.update(candidatesTable).set(values).where(eq(candidatesTable.id, existing.id)).returning();
            merged = updated ?? existing;
          }
          const talentMatchScore = await linkCandidateToJob(merged, jobId ? String(jobId) : null, tenantId, source);
          if (jobId && merged.resumeUrl) {
            screenCandidateResume(merged.id, String(jobId))
              .catch((err) => logger.error({ err, candidateId: merged.id }, "[candidates] auto-screen failed"));
          }
          const [apps] = await db.select({ count: count() }).from(applicationsTable).where(eq(applicationsTable.candidateId, merged.id));
          return res.status(200).json({ ...mapCandidate(merged, Number(apps.count)), talentMatchScore, merged: true });
        }
        const [apps] = await db.select({ count: count() }).from(applicationsTable).where(eq(applicationsTable.candidateId, existing.id));
        return res.status(409).json({
          error: "A candidate with this email already exists in your account.",
          reason: "email_match",
          existing: mapCandidate(existing, Number(apps.count)),
          proposedChanges: changes,
        });
      }
    }
    throw insErr;
  }

  void logCandidateEvent({
    candidateId: candidate.id,
    jobId: jobId ? String(jobId) : null,
    tenantId: candidate.tenantId ?? tenantId,
    eventType: "CANDIDATE_CREATED",
    actorType: actorTypeFromRole(user?.role),
    actorId: user?.id ?? null,
    source: "recruiter_action",
    metadata: { firstName: candidate.firstName, lastName: candidate.lastName, candidateSource: candidate.source },
  });

  // Score the candidate against the role and add them to the pipeline board.
  // Best-effort: any failure leaves the score null — the candidate is still added.
  const matchScore = await linkCandidateToJob(candidate, jobId ? String(jobId) : null, tenantId, source);
  // Auto-screen manually-added candidates: if they have a resume on file and are
  // linked to a job, run the resume screen in the background so the Resume Screen
  // tab (and resume-derived skills) populate without a separate manual step.
  if (jobId && candidate.resumeUrl) {
    screenCandidateResume(candidate.id, String(jobId))
      .catch((err) => logger.error({ err, candidateId: candidate.id }, "[candidates] auto-screen failed"));
  }
  res.status(201).json({ ...mapCandidate(candidate), talentMatchScore: matchScore });
});

/* ── POST /candidates/bulk-import ────────────────────────────────────────── */
router.post("/candidates/bulk-import", validate({ body: BulkImportBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  if (!user.tenantId) { res.status(403).json({ error: "Forbidden: no tenant context" }); return; }
  const tenantId = user.tenantId;
  const { rows, jobId, isCurrentEmployee: bulkEmployeeRaw } = req.body as {
    rows: Array<{
      firstName: string; lastName: string; email: string;
      phone?: string; location?: string; currentTitle?: string;
      currentCompany?: string; linkedinUrl?: string; githubUrl?: string;
      skills?: string; source?: string; isCurrentEmployee?: unknown;
    }>;
    jobId?: string;
    isCurrentEmployee?: boolean;
  };

  // A truthy top-level flag marks the whole batch as current employees; a
  // per-row `isCurrentEmployee` column (true/"true"/"1") overrides it per row.
  const bulkEmployeeDefault = coerceEmployeeFlag(bulkEmployeeRaw);

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "rows must be a non-empty array" });
  }
  if (rows.length > 500) {
    return res.status(400).json({ error: "Maximum 500 rows per import" });
  }

  // When importing against a work order, the caller must own it (tenant scope)
  // and it must have cleared approval before candidates can be attached.
  if (jobId) {
    const { jobsTable } = await import("@workspace/db");
    const [jobRow] = await db.select({ tenantId: jobsTable.tenantId, status: jobsTable.status })
      .from(jobsTable).where(eq(jobsTable.id, String(jobId))).limit(1);
    if (!jobRow) { res.status(404).json({ error: "Work order not found" }); return; }
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(jobRow.tenantId)) {
      res.status(404).json({ error: "Work order not found" }); return;
    }
    if (!assertJobApproved(res, jobRow.status)) return;
  }

  const created: any[] = [];
  const skipped: string[] = [];
  const errors: Array<{ row: number; email: string; reason: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    if (!row.firstName?.trim() || !row.lastName?.trim() || !row.email?.trim()) {
      errors.push({ row: rowNum, email: row.email ?? "", reason: "firstName, lastName, and email are required" });
      continue;
    }

    const emailLower = row.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
      errors.push({ row: rowNum, email: row.email, reason: "Invalid email format" });
      continue;
    }

    try {
      const [existing] = await db.select({ id: candidatesTable.id })
        .from(candidatesTable)
        .where(and(sql`lower(${candidatesTable.email}) = ${emailLower}`, eq(candidatesTable.tenantId, tenantId)))
        .limit(1);

      // Resolve the employee flag for THIS row: an explicit per-row column wins,
      // otherwise fall back to the batch-level default.
      const rowIsEmployee = row.isCurrentEmployee !== undefined
        ? coerceEmployeeFlag(row.isCurrentEmployee)
        : bulkEmployeeDefault;

      let candidateId: string;
      let candidateRow: any = null;

      if (existing) {
        skipped.push(emailLower);
        candidateId = existing.id;
        const [full] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
        candidateRow = full;
        // Promote an already-saved candidate onto the employee bench when this
        // import flags them so (never auto-downgrade — that stays a manual toggle).
        if (rowIsEmployee && full && !full.isCurrentEmployee) {
          await db.update(candidatesTable)
            .set({ isCurrentEmployee: true, updatedAt: new Date() })
            .where(eq(candidatesTable.id, candidateId));
          candidateRow = { ...full, isCurrentEmployee: true };
        }
      } else {
        const skillsArr = row.skills
          ? row.skills.split(",").map((s: string) => s.trim()).filter(Boolean)
          : [];

        const [candidate] = await db.insert(candidatesTable).values({
          tenantId,
          firstName: row.firstName.trim(),
          lastName: row.lastName.trim(),
          email: emailLower,
          phone: row.phone?.trim() || null,
          location: row.location?.trim() || null,
          currentTitle: row.currentTitle?.trim() || null,
          currentCompany: row.currentCompany?.trim() || null,
          linkedinUrl: row.linkedinUrl?.trim() || null,
          githubUrl: row.githubUrl?.trim() || null,
          skills: skillsArr,
          source: row.source?.trim() || "manual_import",
          isCurrentEmployee: rowIsEmployee,
          verificationStatus: "unverified",
        }).returning();

        created.push(mapCandidate(candidate));
        candidateId = candidate.id;
        candidateRow = candidate;
      }

      if (jobId && candidateId) {
        // NOTE: We intentionally do NOT insert an applications row here.
        // The Pipeline board reads from sourced_candidates and hides any
        // sourced row that already has an application (since applications
        // default to stage "applied", which isn't a visible Kanban column).
        // The application row is created later when the candidate progresses.

        // Surface in the pipeline board (which reads from sourced_candidates).
        // Skip if this candidate was already sourced for this job.
        const existingSourced = await db.select({ id: sourcedCandidatesTable.id })
          .from(sourcedCandidatesTable)
          .where(and(
            eq(sourcedCandidatesTable.normalizedCandidateId, candidateId),
            sql`raw_data->>'jobId' = ${jobId}`,
          ))
          .limit(1);

        if (existingSourced.length === 0 && candidateRow) {
          const [sourced] = await db.insert(sourcedCandidatesTable).values({
            tenantId,
            source: "manual",
            normalizedCandidateId: candidateId,
            mergeConfidence: 1,
            rawData: {
              jobId,
              firstName: candidateRow.firstName,
              lastName: candidateRow.lastName,
              email: candidateRow.email,
              currentTitle: candidateRow.currentTitle,
              currentCompany: candidateRow.currentCompany,
              location: candidateRow.location,
              linkedinUrl: candidateRow.linkedinUrl,
              githubProfile: candidateRow.githubUrl,
              skills: candidateRow.skills,
              stage: "sourced",
              manual: true,
              matchScore: 80,
            },
          }).returning();

          // Fire-and-forget auto-screen so the card moves Sourced → Screening
          orchestrator.triggerAgent(
            "screening",
            { candidateId, jobId, sourcedId: sourced.id },
            "orchestrator"
          ).catch(err => logger.error({ err }, "[bulk-import] auto-screen failed"));
        }
      }
    } catch (err: any) {
      errors.push({ row: rowNum, email: row.email ?? "", reason: err?.message ?? "Database error" });
    }
  }

  res.status(201).json({
    success: true,
    created: created.length,
    skipped: skipped.length,
    errorCount: errors.length,
    errors: errors.slice(0, 20),
    candidates: created.slice(0, 50),
  });
});

/* ── Rejection lookup ─────────────────────────────────────────────────────
 * Declared BEFORE /candidates/:candidateId so Express doesn't shadow the
 * literal "rejection" path with the dynamic :candidateId param.
 *
 * GET /candidates/rejection?candidateId=&sourcedId=&applicationId=&jobId=
 * Returns the most recent persisted rejection record matching ANY of the
 * provided ID columns, scoped to jobId when supplied. Joins users so the
 * UI can show the recruiter's display name.
 */
router.get("/candidates/rejection", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const candidateId = (req.query.candidateId as string | undefined) || null;
  const sourcedId = (req.query.sourcedId as string | undefined) || null;
  const applicationId = (req.query.applicationId as string | undefined) || null;
  const jobId = (req.query.jobId as string | undefined) || null;

  if (!candidateId && !sourcedId && !applicationId) {
    res.status(400).json({ error: "Provide at least one of candidateId / sourcedId / applicationId" });
    return;
  }

  const idMatchers: any[] = [];
  if (candidateId)   idMatchers.push(eq(candidateRejectionsTable.candidateId, candidateId));
  if (sourcedId)     idMatchers.push(eq(candidateRejectionsTable.sourcedId, sourcedId));
  if (applicationId) idMatchers.push(eq(candidateRejectionsTable.applicationId, applicationId));

  /* Tenant safety — non-admins only see their own + child tenants; a
     recruiter_admin is confined to their assigned client sub-tenants. */
  const allowed = await getDataScopeTenantIds(user as any);
  const whereClauses: any[] = [or(...idMatchers)!];
  if (jobId) whereClauses.push(eq(candidateRejectionsTable.jobId, jobId));
  if (allowed) whereClauses.push(inArray(candidateRejectionsTable.tenantId, allowed));
  /* Recruiter ownership ceiling: a plain recruiter may only read rejection
     records tied to a requisition assigned to them. Every rejection carries a
     jobId, so constrain uniformly regardless of which id column was queried.
     Empty assignment set => no rows (fail closed). */
  if (user.role === "recruiter") {
    const assignedJobIds = await getRecruiterAssignedJobIds(user);
    if (assignedJobIds.length === 0) { res.json({ rejection: null }); return; }
    whereClauses.push(inArray(candidateRejectionsTable.jobId, assignedJobIds));
  }

  const rows = await db
    .select({
      id: candidateRejectionsTable.id,
      reason: candidateRejectionsTable.reason,
      notes: candidateRejectionsTable.notes,
      fromStage: candidateRejectionsTable.fromStage,
      language: candidateRejectionsTable.language,
      emailSent: candidateRejectionsTable.emailSent,
      emailError: candidateRejectionsTable.emailError,
      candidateEmail: candidateRejectionsTable.candidateEmail,
      candidateName: candidateRejectionsTable.candidateName,
      jobTitle: candidateRejectionsTable.jobTitle,
      rejectedByUserId: candidateRejectionsTable.rejectedByUserId,
      rejectedByRole: candidateRejectionsTable.rejectedByRole,
      createdAt: candidateRejectionsTable.createdAt,
      actorName: usersTable.name,
      actorEmail: usersTable.email,
    })
    .from(candidateRejectionsTable)
    .leftJoin(usersTable, eq(usersTable.id, candidateRejectionsTable.rejectedByUserId))
    .where(and(...whereClauses))
    .orderBy(desc(candidateRejectionsTable.createdAt))
    .limit(1);

  res.json({ rejection: rows[0] ?? null });
});

/* ── POST /candidates/:candidateId/reviewed ──────────────────────────────
 * Fired by the recruiter UI when a candidate profile is opened. Writes a
 * RECRUITER_REVIEWED event so analytics can measure review latency and
 * recruiter velocity. Candidates cannot call this route (role-gated).
 * Body: { jobId?: string }  — optional; inferred from most-recent application
 *                             if omitted.
 * ──────────────────────────────────────────────────────────────────────── */
const MarkReviewedBody = z.object({ jobId: z.string().optional() });
router.post("/candidates/:candidateId/reviewed", validate({ body: MarkReviewedBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (user.role === "candidate") { res.status(403).json({ error: "Forbidden" }); return; }

  const { candidateId } = req.params;
  const { jobId: bodyJobId } = req.body as { jobId?: string };

  /* Resolve jobId: prefer caller-supplied, otherwise pick the most recent
   * non-terminal application for this candidate visible to this user. */
  let resolvedJobId: string | null = bodyJobId ?? null;
  if (!resolvedJobId) {
    const allowed = await getDataScopeTenantIds(user);
    const appRows = await db
      .select({ jobId: applicationsTable.jobId })
      .from(applicationsTable)
      .where(
        and(
          eq(applicationsTable.candidateId, candidateId),
          allowed ? inArray(applicationsTable.tenantId, allowed) : undefined as any,
        ),
      )
      .orderBy(desc(applicationsTable.updatedAt))
      .limit(1);
    resolvedJobId = appRows[0]?.jobId ?? null;
  }

  /* Tenant-scope the candidateId */
  const [c] = await db.select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!c) { res.status(404).json({ error: "Not found" }); return; }

  if (user.role !== "platform_admin") {
    const scope = await getDataScopeTenantIds(user);
    if (scope && !scope.includes(c.tenantId ?? "")) { res.status(403).json({ error: "Forbidden" }); return; }
  }
  if (user.role === "recruiter" && !(await recruiterCanAccessCandidate(user, candidateId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  void logCandidateEvent({
    candidateId,
    jobId: resolvedJobId,
    tenantId: c.tenantId ?? "",
    eventType: "RECRUITER_REVIEWED",
    actorType: actorTypeFromRole(user.role),
    actorId: user.id,
    source: "recruiter_action",
    metadata: { jobId: resolvedJobId },
  });

  res.json({ ok: true });
});

/* ── GET /candidates/:candidateId ────────────────────────────────────────── */
router.get("/candidates/:candidateId", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, req.params.candidateId)).limit(1);
  if (!c) { res.status(404).json({ error: "Not found" }); return; }

  if (user && user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(c.tenantId ?? "")) {
      /* 404 (not 403) — a cross-tenant caller must not be able to distinguish
       * "exists in another tenant" from "does not exist" (existence disclosure).
       * Matches the canonical single-resource posture used elsewhere. */
      res.status(404).json({ error: "Not found" }); return;
    }
  }

  if (user?.role === "recruiter" && !(await recruiterCanAccessCandidate(user, c.id))) {
    /* 404 (not 403) — same existence-disclosure posture as the cross-tenant
       branch above: an unassigned candidate must look "not found" to a recruiter. */
    res.status(404).json({ error: "Not found" }); return;
  }

  /* Tenant-scope the count (Step-3 audit): never leak a cross-tenant total. */
  const [apps] = await appCountForTenants(c.id, await getDataScopeTenantIds(user));

  /* "Portal Active" must reflect that THIS candidate row has actually ACTIVATED
   * the portal — not merely that a placeholder user row was created at invite
   * time (ensureCandidateUser creates that row immediately). A portal counts as
   * activated when the candidate has either accepted an invite link
   * (invite_tokens.used_at set) or built a career profile.
   *
   * PRIVACY (correlation-leak fix): both checks are keyed by this candidate's
   * own id (c.id), which is already tenant-authorized by the 404 gate above, so
   * activation reflects engagement with *this* tenant's record ONLY. We must
   * NOT resolve a user by `email = c.email`: that lookup is cross-pool /
   * cross-tenant and would leak the EXISTENCE of a separate job-seeker account
   * held by, e.g., an employer's own imported employee. The former companion
   * field `portalInvited` (derived from exactly that email lookup) has no
   * consumer and is intentionally dropped. */
  let portalActivated = false;
  const [acceptedInvite] = await db
    .select({ token: inviteTokensTable.token })
    .from(inviteTokensTable)
    .where(and(eq(inviteTokensTable.candidateId, c.id), sql`${inviteTokensTable.usedAt} IS NOT NULL`))
    .limit(1);
  if (acceptedInvite) {
    portalActivated = true;
  } else {
    const [profile] = await db
      .select({ id: candidateCareerProfilesTable.candidateId })
      .from(candidateCareerProfilesTable)
      .where(eq(candidateCareerProfilesTable.candidateId, c.id))
      .limit(1);
    portalActivated = !!profile;
  }

  res.json({ ...mapCandidate(c, Number(apps.count)), hasPortalAccess: portalActivated });
});

/* ── POST /candidates/:candidateId/message ───────────────────────────────
   Recruiter sends a direct email message to a candidate from the profile
   page "Message" button. Sends a real email via SES and records a
   communication event so it shows up in the candidate's activity timeline. */
const SendCandidateMessageBody = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});
router.post("/candidates/:candidateId/message", validate({ body: SendCandidateMessageBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, req.params.candidateId)).limit(1);
  if (!c) { res.status(404).json({ error: "Not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(c.tenantId ?? "")) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
  }
  if (user.role === "recruiter" && !(await recruiterCanAccessCandidate(user, c.id))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  if (!c.email) { res.status(400).json({ error: "Candidate has no email on file" }); return; }

  const { subject, body } = req.body as { subject: string; body: string };

  /* Manual 1:1 recruiter → candidate email: send from the recruiter's OWN
     Outlook mailbox (Graph) when connected; falls back to SES automatically
     inside sendEmail. Mirrors the inbox-reply path. */
  const result = await sendEmail({
    to: c.email,
    subject,
    html: plainToHtml(body),
    text: body,
    senderUserId: user.id,
    useRecruiterMailbox: true,
    audit: {
      tenantId: c.tenantId ?? null,
      actorLabel: user?.name ?? "Recruiter",
      subjectType: "candidate",
      subjectId: c.id,
      subjectLabel: `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email,
      metadata: { candidateId: c.id },
    },
  });

  if (!result.ok) {
    res.status(502).json({ error: result.error ?? "Failed to send message", emailConfigured: isEmailConfigured() });
    return;
  }

  /* Record the activity event under the candidate's REAL tenant. Never fall
   * back to a hardcoded literal: communication_events is FORCE-RLS with a
   * WITH CHECK on tenant_id, so a bogus fallback both mis-attributes the row
   * and would be rejected by RLS for non-matching callers. If the candidate
   * has no tenant, skip the event (the email still sent). */
  if (c.tenantId) {
    try {
      await db.insert(communicationEventsTable).values({
        tenantId: c.tenantId,
        candidateId: c.id,
        type: "message",
        channel: "email",
        subject,
        body,
        status: "sent",
        sentAt: new Date(),
      });
    } catch (err) {
      logger.error({ err, candidateId: c.id }, "Message email sent but failed to record communication event");
    }
  } else {
    logger.warn({ candidateId: c.id }, "Message email sent but candidate has no tenant — skipped communication event");
  }

  res.json({ ok: true, email: c.email });
});

/* ── POST /recruiter/view-candidate ───────────────────────────────────────
   Records that a recruiter opened a candidate profile, and triggers the
   market-event emitter (target-company alert, view-burst alert).

   Auth model:
     - Caller MUST be authenticated (we derive viewerTenantId from the JWT,
       never from the body — closes the spoofing gap flagged in code review).
     - Platform admins are allowed but recorded as 'platform' viewer (the
       emitter then short-circuits; we don't surface "platform" as a viewing
       company to candidates).
     - Candidate visibility: we don't enforce per-tenant visibility here
       because the platform candidate pool is shared by design. We DO require
       the candidate to exist so we don't log views against junk IDs. */
router.post("/recruiter/view-candidate", validate({ body: ViewCandidateBody }), async (req, res) => {
  const { candidateId } = (req.body ?? {}) as { candidateId?: string };
  if (!candidateId) { res.status(400).json({ error: "candidateId required" }); return; }

  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  /* Confirm the candidate exists so we never log views against fabricated IDs. */
  const [exists] = await db
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId))
    .limit(1);
  if (!exists) { res.status(404).json({ error: "Candidate not found" }); return; }

  /* Server-derived — body cannot influence which company is recorded as the
     viewer. Platform admins fall back to "platform" (filtered out downstream). */
  const viewerTenantId = user.role === "platform_admin" ? "platform" : (user.tenantId ?? "platform");

  try {
    const { recordRecruiterView } = await import("../lib/market-event-emitter.js");
    /* Best-effort: never block the recruiter UI on email side-effects. */
    void recordRecruiterView({ candidateId, viewerTenantId });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to record view", message: err?.message });
  }
});

/* ── PUT /candidates/:candidateId ─────────────────────────────────────────── */
router.put("/candidates/:candidateId", validate({ body: UpdateCandidateBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [existing] = await db.select({ tenantId: candidatesTable.tenantId }).from(candidatesTable)
    .where(eq(candidatesTable.id, req.params.candidateId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  if (user && user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(existing.tenantId ?? "")) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
  }
  if (user?.role === "recruiter" && !(await recruiterCanAccessCandidate(user, req.params.candidateId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [c] = await db.update(candidatesTable)
    .set({ ...req.body, updatedAt: new Date() })
    .where(eq(candidatesTable.id, req.params.candidateId))
    .returning();
  if (!c) { res.status(404).json({ error: "Not found" }); return; }
  res.json(mapCandidate(c));
});

/* ── POST /candidates/:candidateId/resume ─────────────────────────────────── */
router.post("/candidates/:candidateId/resume", validate({ body: CandidateResumeBody }), async (req, res) => {
  const { objectPath } = req.body;
  if (!objectPath) { res.status(400).json({ error: "objectPath is required" }); return; }

  // Auth + tenant gate — same pattern as PUT /candidates/:id. Without this a
  // caller could attach a resume to (and now trigger skills enrichment on) any
  // candidate across tenants.
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [owner] = await db.select({ tenantId: candidatesTable.tenantId }).from(candidatesTable)
    .where(eq(candidatesTable.id, req.params.candidateId)).limit(1);
  if (!owner) { res.status(404).json({ error: "Not found" }); return; }
  if (user && user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(owner.tenantId ?? "")) { res.status(403).json({ error: "Forbidden" }); return; }
  }
  if (user?.role === "recruiter" && !(await recruiterCanAccessCandidate(user, req.params.candidateId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [c] = await db.update(candidatesTable)
    .set({ resumeUrl: objectPath, updatedAt: new Date() })
    .where(eq(candidatesTable.id, req.params.candidateId))
    .returning();
  if (!c) { res.status(404).json({ error: "Not found" }); return; }

  // Parse the freshly-uploaded resume and union any extracted skills into the
  // profile so "uploaded a resume" actually populates skills (feeds Talent
  // Match). Re-read so the response reflects the enriched skills. Best-effort.
  const merged = await enrichCandidateFromResume(c.id, objectPath);

  // The Talent Match score was computed at link time, before the resume existed
  // (often on an empty-skills/no-title profile → a stale low/0 score). Now that
  // the resume has populated skills, refresh the score for every job this
  // candidate is linked to so "upload resume → score updates" works without a
  // manual rescore. Background (fire-and-forget) so the upload response isn't
  // blocked by per-job LLM calls; the profile is polled by the UI.
  void (async () => {
    try {
      // Rescore every job this candidate is linked to — via an application
      // (pipeline) OR a candidate_job_intelligence row (matched via "match to
      // req"/screening but not added to a pipeline). The Talent Match panel
      // reads intelligence rows, so skipping them would leave the stale
      // pre-resume 0% in place forever.
      const [appJobs, intelJobs] = await Promise.all([
        db.select({ jobId: applicationsTable.jobId })
          .from(applicationsTable)
          .where(eq(applicationsTable.candidateId, c.id)),
        db.select({ jobId: candidateJobIntelligenceTable.jobId })
          .from(candidateJobIntelligenceTable)
          .where(eq(candidateJobIntelligenceTable.candidateId, c.id)),
      ]);
      const jobIds = Array.from(
        new Set([...appJobs, ...intelJobs].map((r) => r.jobId).filter((j): j is string => !!j)),
      );
      for (const jobId of jobIds) {
        // screenCandidateResume screens + rescores when the resume is readable;
        // if it bails (e.g. unreadable resume) rescore explicitly so the score
        // still refreshes off the freshly-merged skills.
        const screened = await screenCandidateResume(c.id, jobId);
        if (!screened.screened) await rescoreCandidateForJob(c.id, jobId);
      }
    } catch (err) {
      logger.error({ err, candidateId: c.id }, "[candidates] resume-upload rescore failed");
    }
  })();

  if (merged) {
    const [updated] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, c.id)).limit(1);
    if (updated) { res.json(mapCandidate(updated)); return; }
  }
  res.json(mapCandidate(c));
});

/* ── DELETE /candidates/:candidateId/resume ──────────────────────────────── */
router.delete("/candidates/:candidateId/resume", async (req, res) => {
  // Auth + tenant gate — same pattern as PUT /candidates/:id.
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [owner] = await db.select({ tenantId: candidatesTable.tenantId }).from(candidatesTable)
    .where(eq(candidatesTable.id, req.params.candidateId)).limit(1);
  if (!owner) { res.status(404).json({ error: "Not found" }); return; }
  if (user && user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(owner.tenantId ?? "")) { res.status(403).json({ error: "Forbidden" }); return; }
  }
  if (user?.role === "recruiter" && !(await recruiterCanAccessCandidate(user, req.params.candidateId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [c] = await db.update(candidatesTable)
    .set({ resumeUrl: null, updatedAt: new Date() })
    .where(eq(candidatesTable.id, req.params.candidateId))
    .returning();
  if (!c) { res.status(404).json({ error: "Not found" }); return; }
  res.json(mapCandidate(c));
});

/* ── Candidate portal dashboard ────────────────────────────────────────────── */
router.get("/portal/dashboard", async (req, res) => {
  /* Resolve the candidate strictly via the FK-based shared resolver.
   * No email join, no recruiter-role allowlist, no demo-candidate fallback —
   * all three of those previously enabled the auth-shadowing vector closed
   * by migration 0012. Unauthenticated or non-candidate callers → 401. */
  const candidateId = await resolveCandidateId(req);
  if (!candidateId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [candidate] = await db.select().from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) { res.status(404).json({ error: "Not found" }); return; }

  const apps = await db.select().from(applicationsTable).where(eq(applicationsTable.candidateId, candidate.id));
  const sessions = await db.select().from(interviewSessionsTable).where(eq(interviewSessionsTable.candidateId, candidate.id));
  const schedules = await db.select().from(interviewSchedulesTable);
  const [notifs] = await db.select({ count: count() }).from(candidateNotificationsTable).where(eq(candidateNotificationsTable.candidateId, candidate.id));

  const completedSessions = sessions.filter((s: any) => s.status === "completed");

  res.json({
    candidate: mapCandidate(candidate, apps.length),
    upcomingInterviews: schedules.slice(0, 3).map((s: any) => ({ ...s, scheduledAt: s.scheduledAt.toISOString(), createdAt: s.createdAt.toISOString() })),
    completedInterviews: completedSessions.map((s: any) => ({ ...s, startedAt: s.startedAt?.toISOString(), completedAt: s.completedAt?.toISOString(), createdAt: s.createdAt.toISOString() })),
    activeApplications: apps.map((a: any) => ({ ...a, createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString() })),
    prepCompletion: Math.min(100, completedSessions.length * 20),
    unreadNotificationCount: Number(notifs.count),
  });
});

router.get("/portal/notifications", async (req, res) => {
  /* FK-based candidate resolution only — see /portal/dashboard for rationale. */
  const candidateId = await resolveCandidateId(req);
  if (!candidateId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const notifs = await db.select().from(candidateNotificationsTable)
    .where(eq(candidateNotificationsTable.candidateId, candidateId))
    .orderBy(desc(candidateNotificationsTable.createdAt));
  res.json(notifs.map(n => ({ ...n, createdAt: n.createdAt.toISOString() })));
});

/* ── CV multi-file upload ─────────────────────────────────────────────────── */
router.post("/candidates/parse-cvs", upload.array("files", 20), async (req, res) => {
  const user = await getCallerUser(req);
  const files = req.files as Express.Multer.File[];
  const jobId = req.body.jobId as string | undefined;
  // When true, only extract fields for form pre-fill — do NOT create candidate
  // or application rows. Used by the single-candidate Add modal.
  const previewOnly = req.body.previewOnly === "true" || req.body.previewOnly === true;

  // Resolve tenant from the *job* when one is provided so newly created
  // candidates always end up under the same tenant the rest of the pipeline
  // (jobs, ICPs, sourced_candidates) belongs to. Falls back to the caller's
  // own tenant for tenant-less imports.
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!user.tenantId) { res.status(403).json({ error: "Forbidden: no tenant context" }); return; }
  let tenantId: string = user.tenantId;
  if (jobId) {
    const { jobsTable } = await import("@workspace/db");
    const [job] = await db.select({ tenantId: jobsTable.tenantId, status: jobsTable.status }).from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
    // Tenant-membership gate — copied from gateJobAccess (routes/pipeline.ts):
    // a caller-supplied jobId must belong to the caller's data scope, else 404,
    // so a CV upload can't create candidates under another tenant's requisition.
    // Recruiter-OWNERSHIP (assigned-to-this-req) is deferred to Tier 2.
    if (!job) { res.status(404).json({ error: "Not found" }); return; }
    if (user.role !== "platform_admin") {
      const allowed = (await getDataScopeTenantIds(user)) ?? [];
      if (!allowed.includes(job.tenantId ?? "")) { res.status(404).json({ error: "Not found" }); return; }
    }
    /* Plain-recruiter ceiling (Tier 2): the requisition must be ASSIGNED to the
       caller, else 404. Returns true for every non-recruiter role. */
    if (!(await recruiterOwnsResource(user, { kind: "jobId", value: jobId }))) {
      res.status(404).json({ error: "Not found" }); return;
    }
    if (job.tenantId) tenantId = job.tenantId;
    // Block candidate/application creation against an unapproved work order.
    // previewOnly only extracts fields for form pre-fill (creates no rows), so
    // it is allowed through.
    if (!previewOnly && !assertJobApproved(res, job.status)) return;
  }

  if (!files || files.length === 0) {
    res.status(400).json({ error: "No files uploaded" });
    return;
  }

  const results: any[] = [];

  /* Upload safety: PDF magic-byte sniffing + size cap. The browser <input>
     can be tricked into sending arbitrary bytes with a `.pdf` extension; the
     mime check alone is not enough. PDF files always start with `%PDF-`. */
  const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

  for (const file of files) {
    try {
      if (file.size > MAX_FILE_BYTES) {
        results.push({ fileName: file.originalname, error: `File exceeds 10 MB limit (${Math.round(file.size / 1024 / 1024)} MB).` });
        continue;
      }
      const lname = file.originalname.toLowerCase();
      if (lname.endsWith(".pdf") || file.mimetype === "application/pdf") {
        const head = file.buffer.slice(0, 5).toString("latin1");
        if (!head.startsWith("%PDF-")) {
          results.push({ fileName: file.originalname, error: "File claims to be a PDF but does not start with %PDF- header (rejected as unsafe)." });
          continue;
        }
      }
      let text = "";
      const mime = file.mimetype;
      const name = file.originalname.toLowerCase();

      // ── CSV roster: parse rows directly, no AI needed ─────────────────
      if (mime === "text/csv" || name.endsWith(".csv")) {
        const csvText = file.buffer.toString("utf-8");
        const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
        if (lines.length < 2) {
          results.push({ fileName: file.originalname, error: "CSV has no data rows." });
          continue;
        }
        const splitRow = (line: string): string[] => {
          const out: string[] = [];
          let cur = ""; let inQ = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
              else inQ = !inQ;
            } else if (ch === "," && !inQ) { out.push(cur); cur = ""; }
            else cur += ch;
          }
          out.push(cur);
          return out.map(s => s.trim());
        };
        const headers = splitRow(lines[0]).map(h => h.toLowerCase().replace(/[\s_-]/g, ""));
        const colIdx = (...keys: string[]) => keys.map(k => headers.indexOf(k.toLowerCase().replace(/[\s_-]/g, ""))).find(i => i >= 0) ?? -1;
        const idx = {
          firstName: colIdx("firstName", "first"),
          lastName: colIdx("lastName", "last"),
          email: colIdx("email"),
          phone: colIdx("phone"),
          location: colIdx("location"),
          currentTitle: colIdx("currentTitle", "title"),
          currentCompany: colIdx("currentCompany", "company"),
          linkedinUrl: colIdx("linkedinUrl", "linkedin"),
          githubUrl: colIdx("githubUrl", "github"),
          skills: colIdx("skills"),
        };
        let imported = 0; let skipped = 0; const rowErrors: string[] = [];
        for (let r = 1; r < lines.length; r++) {
          const cols = splitRow(lines[r]);
          const get = (i: number) => i >= 0 ? (cols[i] || "").trim() : "";
          const fn = get(idx.firstName); const ln = get(idx.lastName); const em = get(idx.email).toLowerCase();
          if (!fn && !ln && !em) continue;
          if (!fn || !ln) { skipped++; rowErrors.push(`Row ${r + 1}: missing first/last name`); continue; }

          if (em) {
            const [existing] = await db.select({ id: candidatesTable.id, firstName: candidatesTable.firstName, lastName: candidatesTable.lastName })
              .from(candidatesTable)
              .where(and(sql`lower(${candidatesTable.email}) = ${em}`, eq(candidatesTable.tenantId, tenantId)))
              .limit(1);
            if (existing) { skipped++; rowErrors.push(`Row ${r + 1}: ${em} already exists (${existing.firstName} ${existing.lastName})`); continue; }
          }

          if (jobId) {
            const skillsRaw = get(idx.skills);
            const [created] = await db.insert(candidatesTable).values({
              tenantId,
              firstName: fn,
              lastName: ln,
              email: em || `csv-import-${Date.now()}-${r}@unknown.local`,
              phone: get(idx.phone) || null,
              location: get(idx.location) || null,
              currentTitle: get(idx.currentTitle) || null,
              currentCompany: get(idx.currentCompany) || null,
              linkedinUrl: get(idx.linkedinUrl) || null,
              githubUrl: get(idx.githubUrl) || null,
              skills: skillsRaw ? skillsRaw.split(/[,;|]/).map(s => s.trim()).filter(Boolean) : [],
              source: "csv_upload",
              verificationStatus: "unverified",
            }).returning();

            // Surface on the Pipeline board only — no applications row
            // (see bulk-import note: "applied" stage isn't a visible Kanban
            // column, so creating an application here hides the card).
            await db.insert(sourcedCandidatesTable).values({
              tenantId,
              source: "manual",
              normalizedCandidateId: created.id,
              mergeConfidence: 1,
              rawData: {
                jobId,
                firstName: created.firstName,
                lastName: created.lastName,
                email: created.email,
                currentTitle: created.currentTitle,
                currentCompany: created.currentCompany,
                location: created.location,
                linkedinUrl: created.linkedinUrl,
                skills: created.skills,
                stage: "sourced",
                manual: true,
                matchScore: 80,
              },
            });
            imported++;
          }
        }
        results.push({
          fileName: file.originalname,
          csv: true,
          imported,
          skipped,
          errors: rowErrors.slice(0, 200),
          totalErrors: rowErrors.length,
        });
        continue;
      }

      if (mime === "application/pdf" || name.endsWith(".pdf")) {
        const pdfParse = (await import("pdf-parse")).default;
        const parsed = await pdfParse(file.buffer);
        text = parsed.text;
      } else if (
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        name.endsWith(".docx")
      ) {
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        text = result.value;
      } else if (mime === "text/plain" || name.endsWith(".txt")) {
        text = file.buffer.toString("utf-8");
      } else {
        results.push({ fileName: file.originalname, error: "Unsupported file type. Use PDF, DOCX, or TXT." });
        continue;
      }

      if (!text || text.trim().length < 20) {
        results.push({ fileName: file.originalname, error: "Could not extract readable text from this file." });
        continue;
      }

      const extracted = await generateJSON<{
        firstName: string; lastName: string; email: string;
        phone?: string; location?: string; currentTitle?: string;
        currentCompany?: string; linkedinUrl?: string; githubUrl?: string;
        skills?: string[]; summary?: string;
      }>(
        `Extract candidate information from this CV/resume text. Return a JSON object with these fields:
firstName, lastName, email, phone, location, currentTitle, currentCompany, linkedinUrl, githubUrl, skills (array of strings), summary (2-sentence professional summary).
If a field is not found, omit it or use null.

CV TEXT:
${text.slice(0, 6000)}`,
        "You are a CV parsing assistant. Extract structured candidate information from raw resume/CV text. Return valid JSON only — no markdown, no explanation."
      );

      if (!extracted.firstName && !extracted.lastName && !extracted.email) {
        results.push({ fileName: file.originalname, error: "Could not identify candidate from this file." });
        continue;
      }

      const candidate: any = {
        fileName: file.originalname,
        firstName: extracted.firstName ?? "",
        lastName: extracted.lastName ?? "",
        email: extracted.email ?? null,
        phone: extracted.phone ?? null,
        location: extracted.location ?? null,
        currentTitle: extracted.currentTitle ?? null,
        currentCompany: extracted.currentCompany ?? null,
        linkedinUrl: extracted.linkedinUrl ?? null,
        githubUrl: extracted.githubUrl ?? null,
        skills: extracted.skills ?? [],
        summary: extracted.summary ?? null,
      };

      if (!previewOnly && jobId && (candidate.firstName || candidate.lastName)) {
        const emailLower = candidate.email?.toLowerCase() ?? null;
        let candidateId: string | null = null;

        if (emailLower) {
          const [existing] = await db.select({ id: candidatesTable.id })
            .from(candidatesTable)
            .where(and(sql`lower(${candidatesTable.email}) = ${emailLower}`, eq(candidatesTable.tenantId, tenantId)))
            .limit(1);
          if (existing) { candidateId = existing.id; }
        }

        if (!candidateId) {
          const [created] = await db.insert(candidatesTable).values({
            tenantId,
            firstName: candidate.firstName,
            lastName: candidate.lastName,
            email: emailLower ?? `cv-import-${Date.now()}@unknown.local`,
            phone: candidate.phone,
            location: candidate.location,
            currentTitle: candidate.currentTitle,
            currentCompany: candidate.currentCompany,
            linkedinUrl: candidate.linkedinUrl,
            githubUrl: candidate.githubUrl,
            skills: candidate.skills,
            source: "cv_upload",
            verificationStatus: "unverified",
          }).returning();
          candidateId = created.id;
        }

        if (candidateId) {
          const [existingApp] = await db.select({ id: applicationsTable.id })
            .from(applicationsTable)
            .where(and(eq(applicationsTable.candidateId, candidateId), eq(applicationsTable.jobId, jobId)))
            .limit(1);
          if (!existingApp) {
            const bulkOrigin = await recruiterLinkOrigin({ candidateId, tenantId, via: "cv_bulk_upload" });
            const [bulkApp] = await db.insert(applicationsTable)
              .values({ jobId, candidateId, stage: "applied", tenantId, ...bulkOrigin })
              .returning({ id: applicationsTable.id });
            void logCandidateEvent({
              candidateId,
              jobId,
              tenantId,
              applicationId: bulkApp?.id ?? null,
              eventType: "JOB_MATCHED",
              actorType: "recruiter",
              source: "recruiter_action",
              metadata: { stage: "applied", via: "cv_bulk_upload" },
            });
          }
          candidate.candidateId = candidateId;
          candidate.imported = true;
        }
      }

      results.push(candidate);
    } catch (err: any) {
      results.push({ fileName: file.originalname, error: err?.message ?? "Parse failed" });
    }
  }

  res.json({ results, total: files.length, success: results.filter(r => !r.error).length });
});

/* ── PATCH /candidates/:candidateId ── hiring manager approval ───────────── */
router.patch("/candidates/:candidateId", validate({ body: PatchCandidateBody }), async (req, res) => {
  try {
    /* Caller auth is enforced below via getCallerUser (header or httpOnly
       session cookie) — no header-presence pre-check. */
    const { hiringManagerApproval } = req.body as { hiringManagerApproval?: string };
    if (!hiringManagerApproval || !["approved", "rejected"].includes(hiringManagerApproval)) {
      res.status(400).json({ error: "hiringManagerApproval must be 'approved' or 'rejected'" });
      return;
    }

    /* Authorize the caller against the candidate's data scope before mutating —
       header presence is not authorization. A plain recruiter may only act on a
       candidate tied to a requisition assigned to them. */
    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (user.role === "candidate") { res.status(403).json({ error: "Forbidden" }); return; }
    const [target] = await db.select({ tenantId: candidatesTable.tenantId })
      .from(candidatesTable).where(eq(candidatesTable.id, req.params.candidateId)).limit(1);
    if (!target) { res.status(404).json({ error: "Candidate not found" }); return; }
    if (user.role !== "platform_admin") {
      const scope = await getDataScopeTenantIds(user);
      if (scope && !scope.includes(target.tenantId ?? "")) { res.status(403).json({ error: "Forbidden" }); return; }
    }
    if (user.role === "recruiter" && !(await recruiterCanAccessCandidate(user, req.params.candidateId))) {
      res.status(403).json({ error: "Forbidden" }); return;
    }

    const [updated] = await db
      .update(candidatesTable)
      .set({ hiringManagerApproval, updatedAt: new Date() })
      .where(eq(candidatesTable.id, req.params.candidateId))
      .returning({ id: candidatesTable.id, hiringManagerApproval: candidatesTable.hiringManagerApproval });

    if (!updated) { res.status(404).json({ error: "Candidate not found" }); return; }

    // candidate-serialization-exempt: `updated` is a narrow .returning({ id, hiringManagerApproval })
    // projection, not a full candidatesTable row — it carries no privacy-posture columns.
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update candidate" });
  }
});

/* ── PATCH /candidates/:candidateId/employee-status ─────────────────────────
 * Mark / unmark a single internal candidate as a CURRENT EMPLOYEE (internal
 * mobility bench). Only tenant-pool records qualify — a shared platform-pool
 * candidate is not any one tenant's employee. Same ownership ceiling as
 * PATCH /candidates/:candidateId: header presence is not authorization. */
router.patch("/candidates/:candidateId/employee-status", validate({ body: EmployeeStatusBody }), async (req, res) => {
  try {
    /* Caller auth is enforced below via getCallerUser (header or httpOnly
       session cookie) — no header-presence pre-check. */
    const { isCurrentEmployee } = req.body as { isCurrentEmployee: boolean };

    const user = await getCallerUser(req);
    if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (user.role === "candidate") { res.status(403).json({ error: "Forbidden" }); return; }

    const [target] = await db
      .select({ tenantId: candidatesTable.tenantId, pool: candidatesTable.pool })
      .from(candidatesTable).where(eq(candidatesTable.id, req.params.candidateId)).limit(1);
    if (!target) { res.status(404).json({ error: "Candidate not found" }); return; }

    if (user.role !== "platform_admin") {
      const scope = await getDataScopeTenantIds(user);
      if (scope && !scope.includes(target.tenantId ?? "")) { res.status(403).json({ error: "Forbidden" }); return; }
    }
    if (user.role === "recruiter" && !(await recruiterCanAccessCandidate(user, req.params.candidateId))) {
      res.status(403).json({ error: "Forbidden" }); return;
    }

    // Only internal (tenant-pool) candidates can be flagged as employees.
    if (target.pool !== "tenant") {
      res.status(400).json({ error: "Only internal candidates can be marked as current employees" });
      return;
    }

    const [updated] = await db
      .update(candidatesTable)
      .set({ isCurrentEmployee, updatedAt: new Date() })
      .where(eq(candidatesTable.id, req.params.candidateId))
      .returning({ id: candidatesTable.id, isCurrentEmployee: candidatesTable.isCurrentEmployee });

    if (!updated) { res.status(404).json({ error: "Candidate not found" }); return; }
    // candidate-serialization-exempt: `updated` is a narrow .returning({ id, isCurrentEmployee })
    // projection, not a full candidatesTable row — it carries no privacy-posture columns.
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update employee status" });
  }
});

/* Returns true if the caller's tenant is licensed for the shared platform
   candidate pool (the SAME `candidateDatabaseAccess` gate enforced by the
   GET /candidates list + nl-search). Used to decide whether a caller may read a
   pool="platform" candidate that does not belong to one of their own tenants. */
async function callerHasPlatformPoolAccess(user: any): Promise<boolean> {
  if (!user?.tenantId) return false;
  const [tenantRow] = await db
    .select({ candidateDatabaseAccess: tenantsTable.candidateDatabaseAccess })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, user.tenantId))
    .limit(1);
  return tenantRow?.candidateDatabaseAccess === true;
}

/* A plain `recruiter` may only read/act on a candidate tied to a requisition
   ASSIGNED to them (via an application, a sourced row tagged with the job, or a
   talent-pool push to the job). Returns true for every other role — those are
   gated upstream by getDataScopeTenantIds tenant scope. This mirrors the
   list-narrowing linkage in GET /candidates so by-id routes enforce the same
   ownership ceiling instead of leaking unassigned candidates by id. */
async function recruiterCanAccessCandidate(
  user: { id: string; role: string; tenantId: string | null },
  candidateId: string,
): Promise<boolean> {
  if (user.role !== "recruiter") return true;
  const jobIds = await getRecruiterAssignedJobIds(user);
  if (jobIds.length === 0) return false;
  const [apps, sourced, pushed] = await Promise.all([
    db.select({ id: applicationsTable.id }).from(applicationsTable)
      .where(and(eq(applicationsTable.candidateId, candidateId), inArray(applicationsTable.jobId, jobIds)))
      .limit(1),
    db.select({ id: sourcedCandidatesTable.id }).from(sourcedCandidatesTable)
      .where(and(
        eq(sourcedCandidatesTable.normalizedCandidateId, candidateId),
        inArray(sql`${sourcedCandidatesTable.rawData}->>'jobId'`, jobIds),
      ))
      .limit(1),
    db.select({ id: talentPoolSubmissionsTable.id }).from(talentPoolSubmissionsTable)
      .where(and(
        eq((talentPoolSubmissionsTable as any).candidateId, candidateId),
        inArray((talentPoolSubmissionsTable as any).jobPostingId, jobIds),
      ))
      .limit(1),
  ]);
  return apps.length > 0 || sourced.length > 0 || pushed.length > 0;
}

/* ── GET /candidates/:candidateId/career-recording ───────────────────────── */
/* Streams the chunked screen recording for a candidate's career interview.     */
/* Auth: recruiter / tenant admin / platform admin Bearer token.               */
router.get("/candidates/:candidateId/career-recording", async (req: any, res: any) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { candidateId } = req.params;

  /* Verify caller may see this candidate. Select the FULL row (not just
     tenantId/pool) so the platform-pool privacy seal below has the privacy
     columns it needs. */
  const [candidate] = await db.select()
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) { res.status(404).json({ error: "Candidate not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    const isPoolPlatform = (candidate as any).pool === "platform";
    /* A platform-pool candidate is readable across tenants ONLY by a tenant that
       is licensed for the shared candidate database — the same gate enforced by
       GET /candidates. Without this, any authenticated recruiter could pull a
       shared candidate's profile/recording by ID even if their tenant was never
       granted pool access. Own-tenant candidates remain readable as before. */
    const platformReadOk = isPoolPlatform && (await callerHasPlatformPoolAccess(user));
    if (allowed && !allowed.includes(candidate.tenantId ?? "") && !platformReadOk) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
  }
  if (user.role === "recruiter" && !(await recruiterCanAccessCandidate(user, candidateId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  /* PRIVACY (platform-pool job-seeker seal): a valid candidateDatabaseAccess
     licence + a known candidateId must NOT bypass the candidate's own
     hide-from-employer / pause / blocklist / match-only + DNC / erased state.
     Apply the SAME seal as GET /candidates; a filtered-out record returns 404
     so its existence isn't confirmed to an employer it is hidden from. */
  if ((candidate as any).pool === "platform" && user.role !== "platform_admin") {
    const sealed = await applyCandidatePrivacyFilter(
      applyCandidateHardExclusions([candidate as any]),
      user.tenantId ?? null,
    );
    if (sealed.length === 0) { res.status(404).json({ error: "Candidate not found" }); return; }
  }

  /* Load the recording URL from the career profile */
  const [profile] = await db.select({ recordingUrl: candidateCareerProfilesTable.recordingUrl, recordingDurationSec: candidateCareerProfilesTable.recordingDurationSec })
    .from(candidateCareerProfilesTable)
    .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
    .limit(1);

  if (!profile?.recordingUrl) {
    res.status(404).json({ error: "No recording found" }); return;
  }

  /* Determine if this is a chunked session folder (/recordings/<uuid>/)
     or a legacy single-file path (/objects/...) */
  const folderMatch = profile.recordingUrl.match(/\/recordings\/([0-9a-f-]{36})\/?$/i);

  res.setHeader("Content-Type", "video/webm");
  res.setHeader("Cache-Control", "no-store");

  if (folderMatch) {
    /* Chunked recording — stream all parts concatenated */
    const sessionId = folderMatch[1];
    try {
      const { Readable } = await import("stream");
      await streamRecordingParts(sessionId, res);
      res.end();
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err?.message ?? "Stream failed" });
    }
  } else {
    /* Legacy single-object recording — stream via object storage */
    try {
      const oss = new ObjectStorageService();
      const bucket = oss.getBucket();
      const privatePrefix = oss.getPrivatePrefix();
      /* normalise: /objects/recordings/... → private/recordings/... */
      let s3Key = profile.recordingUrl.replace(/^\/objects\//, `${privatePrefix}/`);
      if (!s3Key.startsWith(privatePrefix)) s3Key = `${privatePrefix}/${s3Key.replace(/^\//, "")}`;
      const resp = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key }));
      const body = resp.Body as import("stream").Readable | null;
      if (!body) { res.status(404).end(); return; }
      body.pipe(res);
    } catch (err: any) {
      if (!res.headersSent) res.status(500).json({ error: err?.message ?? "Stream failed" });
    }
  }
});

/* ── GET /candidates/:candidateId/career-profile ─────────────────────────── */
/* Returns the portal-generated career profile for a candidate. Accessible by  */
/* any authenticated recruiter, tenant admin, or platform admin.                */
router.get("/candidates/:candidateId/career-profile", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { candidateId } = req.params;

  /* Verify the candidate is accessible to this caller. Select the FULL row so
     the platform-pool privacy seal below has the privacy columns it needs. */
  const [candidate] = await db.select()
    .from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) { res.status(404).json({ error: "Candidate not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    const isPoolPlatform = (candidate as any).pool === "platform";
    /* Same shared-pool licensing gate as career-recording above: a platform-pool
       candidate is readable cross-tenant only by a tenant with candidateDatabaseAccess. */
    const platformReadOk = isPoolPlatform && (await callerHasPlatformPoolAccess(user));
    if (allowed && !allowed.includes(candidate.tenantId ?? "") && !platformReadOk) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
  }
  if (user.role === "recruiter" && !(await recruiterCanAccessCandidate(user, candidateId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  /* PRIVACY (platform-pool job-seeker seal): same as career-recording — a
     licence + a known id must NOT bypass hide/pause/block/match-only + DNC /
     erased. A filtered-out record returns 404 (existence not confirmed). */
  if ((candidate as any).pool === "platform" && user.role !== "platform_admin") {
    const sealed = await applyCandidatePrivacyFilter(
      applyCandidateHardExclusions([candidate as any]),
      user.tenantId ?? null,
    );
    if (sealed.length === 0) { res.status(404).json({ error: "Candidate not found" }); return; }
  }

  const [profile] = await db.select()
    .from(candidateCareerProfilesTable)
    .where(eq(candidateCareerProfilesTable.candidateId, candidateId))
    .limit(1);

  if (!profile) {
    res.json({ exists: false, candidateId });
    return;
  }

  res.json({ exists: true, ...profile });
});

/* ── Client list ──────────────────────────────────────────────────────────
 * GET /api/clients
 * Returns all active client tenants visible to the calling recruiter.
 * platform_admin → all tenants; others → own tenant + children.
 */
router.get("/clients", async (req, res) => {
  const caller = await getCallerUser(req);
  if (!caller) { res.status(401).json({ error: "Unauthorized" }); return; }

  let rows;
  if (caller.role === "platform_admin") {
    rows = await db.select({
      id: tenantsTable.id,
      name: tenantsTable.name,
      slug: tenantsTable.slug,
      industry: tenantsTable.industry,
      clientType: tenantsTable.clientType,
      status: tenantsTable.status,
      contactEmail: tenantsTable.contactEmail,
      website: tenantsTable.website,
    }).from(tenantsTable).orderBy(tenantsTable.name);
  } else {
    /* recruiter_admin → only their assigned client sub-tenants (empty ⇒ no
       clients); everyone else uses the full subtree. */
    const allowedIds = await getDataScopeTenantIds(caller);
    if (!allowedIds || allowedIds.length === 0) { res.json({ clients: [] }); return; }
    rows = await db.select({
      id: tenantsTable.id,
      name: tenantsTable.name,
      slug: tenantsTable.slug,
      industry: tenantsTable.industry,
      clientType: tenantsTable.clientType,
      status: tenantsTable.status,
      contactEmail: tenantsTable.contactEmail,
      website: tenantsTable.website,
    }).from(tenantsTable)
      .where(inArray(tenantsTable.id, allowedIds))
      .orderBy(tenantsTable.name);
  }

  res.json({ clients: rows });
});

/* ── GET pushed candidates for a client ──────────────────────────────────
 * GET /api/talent-pool/submissions
 * Returns all talent pool submissions pushed to the calling user's tenant.
 * hiring_manager → sees submissions for their own tenantId
 * platform_admin → optional ?clientTenantId= filter, or all
 */
router.get("/talent-pool/submissions", async (req, res) => {
  const caller = await getCallerUser(req);
  if (!caller) { res.status(401).json({ error: "Unauthorized" }); return; }

  /* Staff-only: this returns candidate PII snapshots. getCallerUser auth is not
   * a role gate — a tenant-scoped candidate account would otherwise read its
   * tenant's whole talent-pool inbox. Restrict to recruiter staff. */
  const SUBMISSIONS_STAFF_ROLES = ["platform_admin", "tenant_admin", "recruiter", "hiring_manager"];
  if (!SUBMISSIONS_STAFF_ROLES.includes(caller.role)) { res.status(403).json({ error: "Forbidden" }); return; }

  const { talentPoolSubmissionsTable } = await import("@workspace/db");

  let clientTenantId: string | null = null;

  if (caller.role === "platform_admin") {
    clientTenantId = (req.query.clientTenantId as string) ?? null;
  } else {
    // Non-platform staff only see their own tenant's submissions; fail closed
    // if they somehow have no tenant context rather than querying with null.
    clientTenantId = caller.tenantId ?? null;
    if (!clientTenantId) { res.status(403).json({ error: "Forbidden" }); return; }
  }

  let rows: any[];
  if (clientTenantId) {
    rows = await db.select().from(talentPoolSubmissionsTable)
      .where(eq(talentPoolSubmissionsTable.clientTenantId as any, clientTenantId))
      .orderBy(desc((talentPoolSubmissionsTable as any).pushedAt));
  } else {
    rows = await db.select().from(talentPoolSubmissionsTable)
      .orderBy(desc((talentPoolSubmissionsTable as any).pushedAt));
  }

  /* Recruiter ownership ceiling: a plain recruiter may only see submissions tied
     to a requisition assigned to them. Fail closed — rows with no jobPostingId,
     or whose jobPostingId is not in the recruiter's assigned set, are excluded.
     Empty assignment set => no rows. */
  if (caller.role === "recruiter") {
    const assignedJobIds = await getRecruiterAssignedJobIds(caller);
    const assignedSet = new Set(assignedJobIds);
    rows = rows.filter((r) => r.jobPostingId && assignedSet.has(r.jobPostingId));
  }

  res.json({ submissions: rows });
});

/* ── Push candidate to client pool ───────────────────────────────────────
 * POST /api/candidates/:candidateId/push-to-client
 * Body: { clientTenantId: string; note?: string }
 *
 * Snapshots key candidate fields into talent_pool_submissions and tags
 * the record with the target client's tenant ID.
 */
router.post("/candidates/:candidateId/push-to-client", validate({ body: PushToClientBody }), async (req, res) => {
  const caller = await getCallerUser(req);
  if (!caller) { res.status(401).json({ error: "Unauthorized" }); return; }

  /* Staff-only: getDataScopeTenantIds is NOT a role gate — a tenant-scoped
   * candidate account would otherwise pass the tenant check below. This route
   * snapshots PII into a client pool, so restrict it to recruiter staff. */
  const PUSH_STAFF_ROLES = ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager"];
  if (!PUSH_STAFF_ROLES.includes(caller.role)) { res.status(403).json({ error: "Forbidden" }); return; }

  /* Recruiter ownership ceiling: a plain recruiter may only push a candidate
     tied to a requisition assigned to them — never an arbitrary candidate. */
  if (caller.role === "recruiter" && !(await recruiterCanAccessCandidate(caller, req.params.candidateId))) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const { candidateId } = req.params;
  const { clientTenantId, note, jobPostingId } = req.body ?? {};

  if (!clientTenantId) {
    res.status(400).json({ error: "clientTenantId is required" }); return;
  }

  /* DATA-scope ceiling: recruiter_admin is narrowed to ONLY their assigned
   * client sub-tenants ([] ⇒ nothing); every other non-platform role gets the
   * full agency subtree. tps_insert RLS is WITH CHECK(true) and both
   * clientTenantId and candidateId are caller-supplied, so without these gates
   * a caller could snapshot an out-of-scope candidate, or inject any candidate
   * into an arbitrary tenant's talent pool. platform_admin (null) bypasses. */
  const pushAllowed = await getDataScopeTenantIds(caller);
  if (pushAllowed && !pushAllowed.includes(clientTenantId)) {
    res.status(404).json({ error: "Client not found" }); return;
  }

  // Load the candidate
  const [candidate] = await db.select().from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) { res.status(404).json({ error: "Candidate not found" }); return; }

  /* The source candidate must also be inside the caller's data scope — a
   * recruiter_admin cannot lift a candidate from an UNASSIGNED client and push
   * it into an assigned one. platform_admin (null) bypasses. */
  if (pushAllowed && !pushAllowed.includes(candidate.tenantId ?? "")) {
    res.status(404).json({ error: "Candidate not found" }); return;
  }

  // Check the target client exists
  const [clientTenant] = await db.select({ id: tenantsTable.id, name: tenantsTable.name })
    .from(tenantsTable).where(eq(tenantsTable.id, clientTenantId)).limit(1);
  if (!clientTenant) { res.status(404).json({ error: "Client not found" }); return; }

  // Check for duplicate push (same candidate + same client)
  const { talentPoolSubmissionsTable } = await import("@workspace/db");
  const existing = await db.select({ id: talentPoolSubmissionsTable.id })
    .from(talentPoolSubmissionsTable)
    .where(
      and(
        eq(talentPoolSubmissionsTable.candidateId as any, candidateId),
        eq(talentPoolSubmissionsTable.clientTenantId as any, clientTenantId),
      )
    ).limit(1);

  if (existing.length > 0) {
    res.status(409).json({
      error: "duplicate",
      message: `${candidate.firstName} ${candidate.lastName} has already been pushed to ${clientTenant.name}.`,
    });
    return;
  }

  // Insert snapshot into talent_pool_submissions
  await db.execute(sql`
    INSERT INTO talent_pool_submissions
      (id, full_name, email, phone, current_title, location,
       experience_level, work_style, languages, bio, linkedin_url, resume_object_path,
       status, candidate_id, client_tenant_id, pushed_by_user_id, note, pushed_at, job_posting_id)
    VALUES (
      ${crypto.randomUUID()},
      ${`${candidate.firstName ?? ""} ${candidate.lastName ?? ""}`.trim()},
      ${candidate.email ?? null},
      ${candidate.phone ?? null},
      ${candidate.currentTitle ?? null},
      ${candidate.location ?? null},
      ${candidate.experienceLevel ?? null},
      ${candidate.workStyle ?? null},
      ${candidate.languages ? sql`${JSON.stringify(candidate.languages)}::jsonb` : sql`NULL`},
      ${candidate.summary ?? null},
      ${candidate.linkedinUrl ?? null},
      ${candidate.resumeUrl ?? null},
      'active',
      ${candidateId},
      ${clientTenantId},
      ${caller.id ?? null},
      ${note ?? null},
      NOW(),
      ${jobPostingId ?? null}
    )
  `);

  res.json({ ok: true, clientName: clientTenant.name });
});

export default router;
