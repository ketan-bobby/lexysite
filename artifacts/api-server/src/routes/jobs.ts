/**
 * routes/jobs.ts — Job (Work Order) CRUD & Assignment
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * All CRUD for the jobs table plus the work-order number generator and
 * recruiter/hiring-manager assignment APIs.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET    /jobs                   List jobs (tenant-scoped, optional ?status= filter)
 *   POST   /jobs                   Create a new job + auto-generate work order number
 *   GET    /jobs/:id               Get one job with application count + assignee names
 *   PUT    /jobs/:id               Update job (title, description, status, assignees)
 *   DELETE /jobs/:id               Soft-delete (or hard-delete) a job
 *   POST   /jobs/:id/assign        Assign recruiter + hiring manager
 *   POST   /jobs/:id/generate-jd   AI-generate a job description from a brief
 *   GET    /jobs/:id/activity      Recent activity feed for a job
 *
 * ─── Work order number ───────────────────────────────────────────────────────
 * generateWorkOrderNumber() produces a human-readable code such as
 * "WO-2025-LINX-MAIN-0001". Components:
 *   WO-<year>-<clientCode>-<subClientCode>-<seq>
 * clientCode is derived from the tenant slug/name (up to 4 alpha-numeric chars).
 * seq is a zero-padded 4-digit count of existing WOs in the same year prefix.
 *
 * ─── Tenant scoping ──────────────────────────────────────────────────────────
 * platform_admin → sees all jobs.
 * tenant users   → see only jobs whose tenantId is in their allowed set
 *                  (own tenantId + direct child tenants).
 *
 * ─── jobWithCount() ──────────────────────────────────────────────────────────
 * Enriches a raw job row with: applicationCount, assignedRecruiterName,
 * assignedHiringManagerName, createdByRole. Used by both GET /jobs and
 * GET /jobs/:id so the frontend never needs a separate lookup.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, controlDb } from "@workspace/db";
import { jobsTable, applicationsTable, tenantsTable, usersTable, candidatesTable, candidateOutcomesTable, userNotificationsTable, jobRecruitersTable } from "@workspace/db";
import { changeCandidateStage } from "../lib/change-candidate-stage.js";
import { resolveLinxRequisitionTerminal, revertLinxRequisitionTerminal } from "../lib/linx-terminal.js";
import { logCandidateEvent, actorTypeFromRole } from "../lib/candidate-event-logger.js";
import { eq, count, desc, and, sql, inArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { orchestrator } from "../lib/agents/orchestrator";
import { logger } from "../lib/logger";
import { MAX_PAGE_SIZE } from "../lib/query-limits";
import { generateWithAI } from "../lib/ai";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";

const GenerateJdBody = z.object({
  title: z.string().min(1),
  department: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  workType: z.string().optional().nullable(),
  employmentType: z.string().optional().nullable(),
  salaryMin: z.number().optional().nullable(),
  salaryMax: z.number().optional().nullable(),
});

const PreviewIcpBody = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  department: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
});

const CreateJobBody = z.object({
  title: z.string().min(1),
  department: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  workType: z.enum(["remote", "hybrid", "onsite"]).optional().nullable(),
  employmentType: z.enum(["full_time", "part_time", "contract", "internship"]).optional().nullable(),
  salaryMin: z.number().int().nonnegative().optional().nullable(),
  salaryMax: z.number().int().nonnegative().optional().nullable(),
  description: z.string().optional().nullable(),
  clientId: z.string().optional().nullable(),
  subClientId: z.string().optional().nullable(),
  jdSource: z.string().optional().nullable(),
  jdFileName: z.string().optional().nullable(),
  language: z.string().optional().nullable(),
  isConfidential: z.boolean().optional(),
  assignedRecruiterId: z.string().optional().nullable(),
  // Additional recruiters staffed on this work order. The first id (or an
  // explicit assignedRecruiterId) becomes the PRIMARY; the rest are stored in
  // the job_recruiters join table. Every listed recruiter gets access.
  assignedRecruiterIds: z.array(z.string()).optional(),
  assignedHiringManagerId: z.string().optional().nullable(),
  clientWorkOrderNumber: z.string().max(120).optional().nullable(),
}).passthrough().refine(
  (v) => v.salaryMin == null || v.salaryMax == null || v.salaryMin <= v.salaryMax,
  { message: "salaryMin must be ≤ salaryMax", path: ["salaryMin"] },
);

/* Strict allowlist for PUT /jobs/:jobId.
 *
 * Unknown keys are stripped by zod by default, so a caller cannot use
 * this route to set tenantId, createdById, approvedById, or any other
 * system-managed column via mass-assignment. */
const UpdateJobBody = z.object({
  title: z.string().min(1).optional(),
  department: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  workType: z.enum(["remote", "hybrid", "onsite"]).nullable().optional(),
  employmentType: z.enum(["full_time", "part_time", "contract", "internship"]).nullable().optional(),
  salaryMin: z.number().int().nonnegative().nullable().optional(),
  salaryMax: z.number().int().nonnegative().nullable().optional(),
  description: z.string().min(1).optional(),
  jdSource: z.string().nullable().optional(),
  jdFileName: z.string().nullable().optional(),
  language: z.string().optional(),
  isConfidential: z.boolean().optional(),
  assignedRecruiterId: z.string().nullable().optional(),
  // Full recruiter roster for this work order. When present it REPLACES the
  // join-table set; the first id (or an explicit assignedRecruiterId) becomes
  // the primary. Every listed recruiter gets access.
  assignedRecruiterIds: z.array(z.string()).optional(),
  assignedHiringManagerId: z.string().nullable().optional(),
  clientWorkOrderNumber: z.string().max(120).nullable().optional(),
  status: z.enum(["draft", "active", "paused", "closed", "pending_approval", "rejected", "published"]).optional(),
  // NOTE: `platformRecommendationsEnabled` is intentionally NOT accepted here.
  // It is a tenant-consent flag and must be changed only via the dedicated
  // `PATCH /jobs/:jobId/platform-recommendations` endpoint, which enforces
  // role restrictions (platform_admin is blocked) and writes an audit log
  // entry per flip. Allowing it via the general PUT would bypass both.
  subClientId: z.string().nullable().optional(),
}).refine(
  (v) => v.salaryMin == null || v.salaryMax == null || v.salaryMin <= v.salaryMax,
  { message: "salaryMin must be ≤ salaryMax", path: ["salaryMin"] },
);

const ApproveJobBody = z.object({
  assignedRecruiterId: z.string().optional(),
  // Optional full recruiter roster to assign on approval (admins only).
  assignedRecruiterIds: z.array(z.string()).optional(),
}).passthrough();

const RejectJobBody = z.object({
  note: z.string().optional(),
}).passthrough();

const PlatformRecommendationsBody = z.object({
  enabled: z.boolean(),
});
import { checkJobCreationAllowed, buildLimitExceededBody } from "../lib/plan-enforcement";
import { getAuthUserId } from "../lib/auth-token";
import { getAllowedTenantIds, getDataScopeTenantIds, recruiterIsAssignedToJob, getRecruiterAssignedJobIds } from "../lib/tenantUtils";
import { recordAudit } from "../lib/audit.js";

const router: IRouter = Router();

/* ── Helpers ────────────────────────────────────────────────────────────── */

async function getCallerUser(req: Request) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

async function jobWithCount(job: any) {
  const [apps] = await db.select({ count: count() }).from(applicationsTable).where(eq(applicationsTable.jobId, job.id));

  // Resolve assigned user names + creator role
  let assignedRecruiterName: string | null = null;
  let assignedHiringManagerName: string | null = null;
  let createdByRole: string | null = null;
  if (job.assignedRecruiterId) {
    const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, job.assignedRecruiterId)).limit(1);
    assignedRecruiterName = u?.name ?? null;
  }
  if (job.assignedHiringManagerId) {
    const [u] = await db.select({ name: usersTable.name }).from(usersTable).where(eq(usersTable.id, job.assignedHiringManagerId)).limit(1);
    assignedHiringManagerName = u?.name ?? null;
  }
  if (job.createdById) {
    const [u] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, job.createdById)).limit(1);
    createdByRole = u?.role ?? null;
  }

  // Full recruiter roster = primary (assignedRecruiterId) ∪ job_recruiters rows.
  // The UI edits this whole set in the Team Assignment step; the primary stays
  // in assignedRecruiterId for backward compat.
  const rosterIds = new Set<string>();
  if (job.assignedRecruiterId) rosterIds.add(job.assignedRecruiterId);
  const jrRows = await db.select({ recruiterUserId: jobRecruitersTable.recruiterUserId })
    .from(jobRecruitersTable).where(eq(jobRecruitersTable.jobId, job.id));
  for (const r of jrRows) rosterIds.add(r.recruiterUserId);
  let assignedRecruiters: { id: string; name: string | null }[] = [];
  if (rosterIds.size > 0) {
    const ids = [...rosterIds];
    const urows = await db.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable).where(inArray(usersTable.id, ids));
    const nameById = new Map(urows.map(u => [u.id, u.name ?? null]));
    assignedRecruiters = ids.map(id => ({ id, name: nameById.get(id) ?? null }));
  }

  return {
    ...job,
    applicationCount: Number(apps.count),
    assignedRecruiterName,
    assignedRecruiterIds: assignedRecruiters.map(a => a.id),
    assignedRecruiters,
    assignedHiringManagerName,
    createdByRole,
    createdAt: job.createdAt instanceof Date ? job.createdAt.toISOString() : job.createdAt,
    updatedAt: job.updatedAt instanceof Date ? job.updatedAt.toISOString() : job.updatedAt,
  };
}

async function generateWorkOrderNumber(tenantId: string, subClientId?: string | null): Promise<string> {
  const year = new Date().getFullYear();
  let clientCode = "CLT";
  const [client] = await controlDb.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1);
  if (client) {
    const raw = client.slug || client.name;
    clientCode = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4).padEnd(2, "X");
  }
  let subCode = "MAIN";
  if (subClientId) {
    const [sub] = await controlDb.select().from(tenantsTable).where(eq(tenantsTable.id, subClientId)).limit(1);
    if (sub) {
      const raw = sub.slug || sub.name;
      subCode = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 4).padEnd(2, "X");
    }
  }
  const yearNeedle = `WO-${year}-`;
  /* Derive sequence from the MAX parsed suffix instead of COUNT(*).
   * This tolerates dirty historical values with leading junk (e.g. '",WO-...')
   * by still extracting the trailing #### and advancing correctly. */
  const existing = await db
    .select({ workOrderNumber: jobsTable.workOrderNumber })
    .from(jobsTable)
    .where(and(eq(jobsTable.tenantId, tenantId), sql`${jobsTable.workOrderNumber} ILIKE ${`%${yearNeedle}%`}`));

  let maxSeq = 0;
  for (const row of existing) {
    const raw = (row.workOrderNumber ?? "").trim().toUpperCase();
    const match = raw.match(/WO-\d{4}-[A-Z0-9]+-[A-Z0-9]+-(\d{4})$/);
    if (!match) continue;
    const n = Number.parseInt(match[1] ?? "0", 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }

  const seq = (maxSeq + 1).toString().padStart(4, "0");
  return `WO-${year}-${clientCode}-${subCode}-${seq}`;
}

/* Tenant visibility scoping (own tenant + ALL descendant tenants) is shared in
 * lib/tenantUtils.ts getAllowedTenantIds, imported below. */

const STAFF_ROLES = ["platform_admin", "tenant_admin", "recruiter_admin", "recruiter", "hiring_manager", "interviewer"];

/* Infer the local currency from a free-text job location so AI-generated job
 * descriptions quote salaries in the right currency (e.g. India → ₹ INR, not $).
 * Defaults to USD when the location is unknown/blank. */
function currencyForLocation(location?: string | null): { symbol: string; code: string } {
  const l = (location || "").toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => l.includes(k));
  if (has("india", "bengaluru", "bangalore", "mumbai", "delhi", "hyderabad", "chennai", "pune", "kolkata", "gurgaon", "gurugram", "noida")) return { symbol: "₹", code: "INR" };
  if (has("united kingdom", "u.k.", "uk", "england", "scotland", "wales", "london", "manchester")) return { symbol: "£", code: "GBP" };
  if (has("eurozone", "germany", "france", "spain", "italy", "netherlands", "ireland", "portugal", "belgium", "austria", "berlin", "paris", "madrid", "amsterdam", "dublin")) return { symbol: "€", code: "EUR" };
  if (has("canada", "toronto", "vancouver", "montreal", "ontario")) return { symbol: "C$", code: "CAD" };
  if (has("australia", "sydney", "melbourne", "brisbane")) return { symbol: "A$", code: "AUD" };
  if (has("singapore")) return { symbol: "S$", code: "SGD" };
  if (has("united arab emirates", "uae", "dubai", "abu dhabi")) return { symbol: "AED ", code: "AED" };
  if (has("japan", "tokyo")) return { symbol: "¥", code: "JPY" };
  if (has("brazil", "são paulo", "sao paulo", "rio de janeiro")) return { symbol: "R$", code: "BRL" };
  if (has("south africa", "johannesburg", "cape town")) return { symbol: "R", code: "ZAR" };
  return { symbol: "$", code: "USD" };
}

/* ── AI helper routes (no auth required — stateless) ─────────────────── */

router.post("/jobs/generate-jd", validate({ body: GenerateJdBody }), async (req, res) => {
  const { title, department, location, workType, employmentType, salaryMin, salaryMax } = req.body;
  const { symbol: curSymbol, code: curCode } = currencyForLocation(location);
  const prompt = `Write a professional, detailed Job Description for the following role. Use clear sections with headings. Be specific and compelling.

Role: ${title}
Department: ${department || "N/A"}
Location: ${location || "N/A"}
Work Arrangement: ${workType || "hybrid"}
Employment Type: ${employmentType || "full_time"}
${salaryMin || salaryMax ? `Salary: ${salaryMin ? `${curSymbol}${salaryMin.toLocaleString()}` : ""}${salaryMax ? ` – ${curSymbol}${salaryMax.toLocaleString()}` : ""}` : ""}

Currency: All compensation/salary figures must be expressed in ${curCode} using the ${curSymbol} symbol. Do NOT convert to or mention US dollars unless the currency is USD.

Include the following sections:
1. About the Role (2-3 sentences overview)
2. What You'll Do (5-7 bullet point responsibilities)
3. What We're Looking For (5-6 bullet point requirements — mix of must-haves and nice-to-haves)
4. Why Join Us (2-3 compelling bullet points about the opportunity)

Keep the tone professional yet engaging. Do not add placeholder text like [Company Name] — use "we" and "the team" instead.`;

  const jd = await generateWithAI(prompt);
  res.json({ jd });
});

router.post("/jobs/preview-icp", validate({ body: PreviewIcpBody }), async (req, res) => {
  const { title, description, department, location } = req.body;
  const prompt = `Generate an Ideal Candidate Profile (ICP) for this role. Return ONLY valid JSON.

Title: ${title}
Department: ${department || "N/A"}
Location: ${location || "N/A"}
JD: ${description}

Return JSON with exactly these fields:
{
  "seniority": "Mid-Senior",
  "yearsExperienceMin": 3,
  "yearsExperienceMax": 7,
  "requiredSkills": ["skill1", "skill2"],
  "preferredSkills": ["skill1", "skill2"],
  "mustHaves": ["must-have 1", "must-have 2"],
  "niceToHaves": ["nice to have 1"],
  "disqualifiers": ["dealbreaker 1"],
  "educationRequirements": "Bachelor's degree in relevant field"
}`;

  const raw = await generateWithAI(prompt);
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    res.json(parsed);
  } catch {
    res.json({
      seniority: "Mid-Senior", yearsExperienceMin: 3, yearsExperienceMax: 7,
      requiredSkills: [], preferredSkills: [], mustHaves: [], niceToHaves: [],
      disqualifiers: [], educationRequirements: "Bachelor's degree or equivalent",
    });
  }
});

/* ── GET /jobs ────────────────────────────────────────────────────────── */
// platform_admin → sees all, may filter by ?tenantId
// tenant_admin/recruiter → sees only their tenant + their direct clients
// hiring_manager → sees jobs assigned to them OR belonging to their tenant
// interviewer → sees all jobs in their tenant (for scheduling context)
router.get("/jobs", async (req, res) => {
  const user = await getCallerUser(req);
  /* Mandatory auth — anonymous callers were previously dropped into the
     `!user || platform_admin` branch and saw every tenant's jobs. */
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const { status, page = 1, limit = 20, tenantId: queryTenantId, assignedToMe } = req.query;

  let jobs;
  // Defensive cap on every branch — see lib/query-limits.ts. A tenant with
  // thousands of work orders would otherwise pull the whole table per call.
  if (user.role === "platform_admin") {
    let query = db.select().from(jobsTable).$dynamic();
    if (queryTenantId) query = query.where(eq(jobsTable.tenantId, queryTenantId as string));
    jobs = await query.orderBy(desc(jobsTable.createdAt)).limit(MAX_PAGE_SIZE);
  } else if (user.role === "hiring_manager") {
    // HMs only see work orders assigned to them
    const allowed = await getAllowedTenantIds(user);
    if (!allowed || allowed.length === 0) { res.json({ jobs: [], total: 0, page: Number(page), limit: Number(limit) }); return; }
    jobs = await db.select().from(jobsTable)
      .where(and(
        inArray(jobsTable.tenantId, allowed),
        eq(jobsTable.assignedHiringManagerId, user.id),
      ))
      .orderBy(desc(jobsTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  } else if (user.role === "recruiter") {
    // Recruiters only see work orders assigned to them — either as the primary
    // (jobs.assigned_recruiter_id) or via the job_recruiters roster. The shared
    // getRecruiterAssignedJobIds already unions both and enforces the tenant
    // subtree ceiling, so an empty set means "no assigned reqs → see nothing".
    const assignedJobIds = await getRecruiterAssignedJobIds(user);
    if (!assignedJobIds || assignedJobIds.length === 0) {
      res.json({ jobs: [], total: 0, page: Number(page), limit: Number(limit) });
      return;
    }
    jobs = await db.select().from(jobsTable)
      .where(inArray(jobsTable.id, assignedJobIds))
      .orderBy(desc(jobsTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  } else if (user.role === "recruiter_admin") {
    // Recruiter Admins see every work order belonging to their ASSIGNED client
    // sub-tenants only (getDataScopeTenantIds). No assigned clients ⇒ nothing.
    const scope = await getDataScopeTenantIds(user);
    if (!scope || scope.length === 0) {
      res.json({ jobs: [], total: 0, page: Number(page), limit: Number(limit) });
      return;
    }
    jobs = await db.select().from(jobsTable)
      .where(inArray(jobsTable.tenantId, scope))
      .orderBy(desc(jobsTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  } else {
    // tenant_admin, interviewer, etc. — all jobs in their tenant tree
    const allowed = await getAllowedTenantIds(user);
    if (!allowed || allowed.length === 0) {
      res.json({ jobs: [], total: 0, page: Number(page), limit: Number(limit) });
      return;
    }
    jobs = await db.select().from(jobsTable)
      .where(inArray(jobsTable.tenantId, allowed))
      .orderBy(desc(jobsTable.createdAt))
      .limit(MAX_PAGE_SIZE);
  }

  const filtered = status ? jobs.filter((j) => j.status === status) : jobs;
  const withCounts = await Promise.all(filtered.map(jobWithCount));
  res.json({ jobs: withCounts, total: filtered.length, page: Number(page), limit: Number(limit) });
});

/* ── Approval routing for recruiter-created work orders ───────────────────
 * A work order created by a plain `recruiter` does NOT go live immediately —
 * it must be approved. The approver is resolved by priority:
 *   1. recruiter_admin(s) assigned to the job's client (sub-)tenant via
 *      recruiter_admin_clients.client_tenant_id = job.tenantId.
 *   2. tenant_admin(s) of the job tenant or the creating agency tenant, when
 *      no recruiter_admin is assigned to that client.
 * Returns [] when neither exists — the caller then auto-activates the job and
 * writes a SOC2 audit entry (autoPublishedNoApprover).
 *
 * Lookups run on controlDb (admin/BYPASSRLS) because this is an internal
 * routing decision that must see approver rows across the agency subtree
 * regardless of the recruiter's own narrower data scope. Only suspended users
 * are excluded — they cannot act on the queue.
 * ────────────────────────────────────────────────────────────────────────── */
type JobApprover = { userId: string; tenantId: string; role: string };

async function resolveJobApprovers(
  jobTenantId: string,
  agencyTenantId: string | null,
): Promise<JobApprover[]> {
  // 1) recruiter_admins assigned to this client tenant.
  const raResult = await controlDb.execute<{ recruiter_admin_user_id: string }>(sql`
    SELECT recruiter_admin_user_id FROM recruiter_admin_clients
    WHERE client_tenant_id = ${jobTenantId}
  `);
  const raList = (raResult as unknown as { rows?: Array<{ recruiter_admin_user_id: string }> }).rows
    ?? (raResult as unknown as Array<{ recruiter_admin_user_id: string }>);
  const raIds = Array.isArray(raList)
    ? raList.map((r) => r.recruiter_admin_user_id).filter(Boolean)
    : [];

  if (raIds.length > 0) {
    const admins = await controlDb.select({
      id: usersTable.id,
      tenantId: usersTable.tenantId,
      role: usersTable.role,
      status: usersTable.status,
    }).from(usersTable)
      .where(and(inArray(usersTable.id, raIds), eq(usersTable.role, "recruiter_admin")));
    const active = admins.filter((u) => u.status !== "suspended");
    if (active.length > 0) {
      return active.map((u) => ({ userId: u.id, tenantId: u.tenantId ?? jobTenantId, role: u.role }));
    }
  }

  // 2) Fallback: tenant_admin(s) of the job tenant or the creating agency.
  const tenantScope = Array.from(new Set([jobTenantId, agencyTenantId].filter(Boolean))) as string[];
  if (tenantScope.length === 0) return [];
  const tenantAdmins = await controlDb.select({
    id: usersTable.id,
    tenantId: usersTable.tenantId,
    role: usersTable.role,
    status: usersTable.status,
  }).from(usersTable)
    .where(and(eq(usersTable.role, "tenant_admin"), inArray(usersTable.tenantId, tenantScope)));
  return tenantAdmins
    .filter((u) => u.status !== "suspended")
    .map((u) => ({ userId: u.id, tenantId: u.tenantId ?? jobTenantId, role: u.role }));
}

/* Best-effort in-app bell notification to each approver. Never throws and never
 * blocks the request — a notification failure must not fail job creation. */
async function notifyJobApprovers(
  job: { id: string; title: string; workOrderNumber: string | null },
  approvers: JobApprover[],
  submitterName: string,
): Promise<void> {
  if (approvers.length === 0) return;
  const woLabel = job.workOrderNumber ?? job.title;
  try {
    await controlDb.insert(userNotificationsTable).values(
      approvers.map((a) => ({
        tenantId: a.tenantId,
        userId: a.userId,
        type: "job_pending_approval",
        title: "Work order awaiting your approval",
        message: `${submitterName} submitted "${job.title}" (${woLabel}) for approval.`,
        actionUrl: `/jobs/${job.id}`,
      })),
    );
  } catch (err: any) {
    logger.warn({ err: err?.message, jobId: job.id }, "Failed to notify job approvers");
  }
}

/* ── POST /jobs ───────────────────────────────────────────────────────── */
// Always uses the caller's tenantId unless platform_admin provides an explicit clientId
// Allowed roles: platform_admin, tenant_admin, recruiter, hiring_manager
router.post("/jobs", validate({ body: CreateJobBody }), async (req, res) => {
  const user = await getCallerUser(req);
  const { title, department, location, workType, employmentType, salaryMin, salaryMax, clientWorkOrderNumber,
          description, clientId, subClientId, jdSource, jdFileName, language,
          isConfidential, assignedRecruiterId, assignedRecruiterIds, assignedHiringManagerId } = req.body;

  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!STAFF_ROLES.includes(user.role)) { res.status(403).json({ error: "Forbidden" }); return; }

  let tenantId: string;

  if (user.role === "platform_admin") {
    // Platform admin must supply a clientId
    if (clientId) {
      tenantId = clientId;
    } else {
      /* Platform admin must explicitly choose a clientId — silently defaulting
         to the first tenant is a footgun (jobs land in the wrong client's
         pipeline). Force the caller to be explicit. */
      res.status(400).json({ error: "platform_admin must supply a clientId when creating a job" });
      return;
    }
  } else if (user.role === "recruiter_admin") {
    /* A recruiter_admin may ONLY create requisitions inside one of their
       ASSIGNED client sub-tenants — never their own agency tenant, never an
       unassigned client. No assigned clients ⇒ denied (fail closed), matching
       the "no assignments => sees/does nothing" invariant. */
    const scope = await getDataScopeTenantIds(user);
    if (!scope || scope.length === 0) {
      res.status(403).json({ error: "Forbidden: you have no assigned clients" });
      return;
    }
    if (!clientId || !scope.includes(clientId)) {
      res.status(403).json({ error: "Forbidden: choose one of your assigned clients" });
      return;
    }
    tenantId = clientId;
  } else if (user.tenantId) {
    // Tenant user: use their own tenantId, or validate clientId is anywhere in
    // their descendant subtree (children, grandchildren, …) — matching the
    // FULL/subtree RLS policy, not just direct children.
    if (clientId && clientId !== user.tenantId) {
      const allowed = (await getAllowedTenantIds(user)) ?? [];
      if (!allowed.includes(clientId)) {
        res.status(403).json({ error: "Forbidden: clientId does not belong to your tenant" });
        return;
      }
      tenantId = clientId;
    } else {
      tenantId = user.tenantId;
    }
  } else {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // ── Plan-limit gate ─────────────────────────────────────────────────────
  // Block creation if the tenant has hit its open-jobs cap or the plan has
  // expired (e.g. a 14-day demo). Platform admins are still gated — they're
  // creating the job on behalf of the tenant, so the tenant's plan applies.
  const jobCheck = await checkJobCreationAllowed(tenantId);
  if (!jobCheck.allowed) {
    res.status(402).json(buildLimitExceededBody(jobCheck));
    return;
  }

  const workOrderNumber = await generateWorkOrderNumber(tenantId, subClientId);

  // Hiring managers always own the requisition they create
  const resolvedHmId = user.role === "hiring_manager"
    ? user.id
    : (assignedHiringManagerId || null);

  // Team Assignment can now list MULTIPLE recruiters. The primary/lead stays in
  // jobs.assigned_recruiter_id; the whole set is mirrored into job_recruiters so
  // every listed recruiter gets access. Primary = explicit assignedRecruiterId,
  // else the first of the list, else (for a recruiter creating their own req)
  // themselves.
  const recruiterIdList: string[] = Array.isArray(assignedRecruiterIds)
    ? assignedRecruiterIds.filter((x: unknown): x is string => typeof x === "string" && !!x)
    : [];
  const resolvedRecruiterId = user.role === "recruiter"
    ? (assignedRecruiterId || recruiterIdList[0] || user.id)
    : (assignedRecruiterId || recruiterIdList[0] || null);

  // Complete roster = primary ∪ any additional listed recruiters. Validate the
  // whole set BEFORE inserting so an invalid/out-of-scope id can't create a job.
  const roster = [...new Set([resolvedRecruiterId, ...recruiterIdList].filter(Boolean) as string[])];
  if (!(await validateRecruiterIds(user, roster))) {
    res.status(400).json({ error: "One or more assigned recruiters are invalid or outside your scope" });
    return;
  }

  // Work orders created by a plain recruiter must be APPROVED before going live:
  // they enter "pending_approval" and are routed to the recruiter_admin assigned
  // to the client (or the tenant_admin when no recruiter_admin exists). Every
  // other staff role (tenant_admin, recruiter_admin, hiring_manager, platform_admin)
  // creates the job directly as "active" — the team can begin sourcing immediately.
  // "published" is a separate explicit action (PATCH /jobs/:id/publish) that posts
  // the job to the public career site so external candidates can find and apply.
  let initialStatus: "active" | "pending_approval" = "active";
  let autoPublishedNoApprover = false;
  let approvers: JobApprover[] = [];

  if (user.role === "recruiter") {
    approvers = await resolveJobApprovers(tenantId, user.tenantId ?? null);
    if (approvers.length > 0) {
      initialStatus = "pending_approval";
    } else {
      // No recruiter_admin and no tenant_admin to approve — fail OPEN so the
      // recruiter is never blocked from working, but record an audit entry.
      initialStatus = "active";
      autoPublishedNoApprover = true;
    }
  }

  const [job] = await db.insert(jobsTable).values({
    tenantId,
    subClientId: subClientId || null,
    createdById: user?.id ?? null,
    title, department, location, workType, employmentType, salaryMin, salaryMax, description,
    workOrderNumber,
    clientWorkOrderNumber: (typeof clientWorkOrderNumber === "string" && clientWorkOrderNumber.trim())
      ? clientWorkOrderNumber.trim()
      : null,
    jdSource: jdSource || null,
    jdFileName: jdFileName || null,
    language: language || "en",
    isConfidential: !!isConfidential,
    assignedRecruiterId: resolvedRecruiterId,
    assignedHiringManagerId: resolvedHmId,
    status: initialStatus,
  }).returning();

  // Mirror the full recruiter roster into the join table so every listed
  // recruiter (not just the primary) can access this work order + its candidates.
  await syncJobRecruiters(job.id, tenantId, roster, user.id);

  const result = await jobWithCount(job);
  res.status(201).json(result);

  if (description && description.length > 20) {
    logger.info({ jobId: job.id, title, workOrderNumber }, "Job created → triggering ICP agent");
    orchestrator.triggerAgent("icp", { jobId: job.id, title, description, department, location }, "orchestrator")
      .catch(err => logger.error({ err, jobId: job.id }, "ICP agent failed after job creation"));
  }

  /* A recruiter-created work order entered the approval queue — notify the
     resolved approver(s) (recruiter_admin, else tenant_admin). Best-effort. */
  if (initialStatus === "pending_approval") {
    void notifyJobApprovers(job, approvers, user.name ?? user.email ?? "A recruiter");
  }

  /* SOC2-style audit trail when a recruiter job auto-publishes because no
     approver exists. Fire-and-forget — recordAudit never throws. */
  if (autoPublishedNoApprover) {
    void recordAudit({
      tenantId,
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email ?? user.id,
      subjectType: "system",
      subjectId: job.id,
      subjectLabel: job.title,
      channel: "system",
      direction: "internal",
      action: "job.auto_publish.no_approver",
      title: `Recruiter job auto-published — no approver in tenant`,
      body: `Job ${job.workOrderNumber ?? job.id} ("${job.title}") was created by recruiter ${user.id} and published directly as active because the tenant has no recruiter_admin assigned to the client and no tenant_admin to approve it.`,
      metadata: { jobId: job.id, workOrderNumber: job.workOrderNumber, recruiterId: user.id },
    });
  }

  /* Brochure parity (slide 7 — "On open"): when this tenant posts a role,
     fan out a role-open alert to every candidate who put them in their
     target-companies list. Done in the background — never blocks the
     job-create response. */
  (async () => {
    try {
      const { candidateCareerProfilesTable } = await import("@workspace/db");
      const { recordRoleOpenAtTarget } = await import("../lib/market-event-emitter");
      const [tenantRow] = await db.select({ name: tenantsTable.name }).from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId)).limit(1);
      const tenantName = tenantRow?.name ?? "";
      if (!tenantName) return;
      const tlc = tenantName.toLowerCase().trim();

      /* Pull every candidate's targetCompanies array. For dev volumes this is
         fine; at scale move to a GIN-indexed jsonb query. */
      const profiles = await db.select({
        candidateId: (candidateCareerProfilesTable as any).candidateId,
        targets:     (candidateCareerProfilesTable as any).targetCompanies,
      }).from(candidateCareerProfilesTable);

      const matched = profiles.filter(p => {
        const targets: string[] = (p.targets ?? []) as string[];
        return targets.some(t => {
          const x = (t || "").toLowerCase().trim();
          return x && (x === tlc || x.includes(tlc) || tlc.includes(x));
        });
      });
      for (const m of matched) {
        if (!m.candidateId) continue;
        await recordRoleOpenAtTarget({
          candidateId: m.candidateId,
          jobId: job.id,
          companyName: tenantName,
          roleTitle: title,
        }).catch(err => logger.warn({ err: err?.message, candidateId: m.candidateId, jobId: job.id }, "role-open emit failed"));
      }
      logger.info({ jobId: job.id, matched: matched.length }, "Role-open fan-out complete");
    } catch (err: any) {
      logger.warn({ err: err?.message, jobId: job.id }, "Role-open fan-out failed");
    }
  })();
});

/* Recruiter ownership ceiling: a plain recruiter may only act on a requisition
   they are assigned to — either the PRIMARY recruiter (assignedRecruiterId ===
   self) OR a member of the job_recruiters join table (multi-recruiter staffing).
   Returns true when the caller must be BLOCKED. Non-recruiter roles are never
   blocked by this guard (their tenant/data-scope ceiling is enforced
   separately). Removing a recruiter's assignment (primary or join row)
   therefore immediately revokes their access to that req.

   `job.id` is required so the join table can be consulted; the primary check is
   a fast path that avoids the extra query in the common single-recruiter case. */
async function recruiterBlockedFromJob(
  user: { role: string; id: string },
  job: { id: string; assignedRecruiterId: string | null },
): Promise<boolean> {
  if (user.role !== "recruiter") return false;
  return !(await recruiterIsAssignedToJob(user.id, job));
}

/* Validate a caller-supplied set of recruiter ids before granting them access to
   a work order. Every id must be a real `recruiter` user inside the caller's
   agency subtree (getAllowedTenantIds). platform_admin is unrestricted (null
   allow-set). This is a security gate: every listed recruiter gets access to the
   req and its candidates, so an unvalidated id would be an access grant to an
   arbitrary user. Returns true when the whole set is valid. */
async function validateRecruiterIds(
  user: { role: string },
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0) return true;
  const agencyAllowed = await getAllowedTenantIds(user as any);
  const rows = await db.select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
    .from(usersTable).where(inArray(usersTable.id, ids));
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const id of ids) {
    const u = byId.get(id);
    const inScope = !!u && (!agencyAllowed || agencyAllowed.includes(u.tenantId));
    if (!u || u.role !== "recruiter" || !inScope) return false;
  }
  return true;
}

/* Replace the recruiter roster for a work order in the job_recruiters join
   table. Stores the COMPLETE set of selected recruiters (including the primary)
   so the join table alone is the full roster; getRecruiterAssignedJobIds unions
   primary + join defensively. Idempotent: deletes existing rows then inserts the
   deduped set. Caller must have already validated the ids + tenant. */
async function syncJobRecruiters(
  jobId: string,
  tenantId: string,
  recruiterIds: string[],
  assignedByUserId: string | null,
): Promise<void> {
  const unique = [...new Set(recruiterIds.filter(Boolean))];
  // Delete-then-insert must be atomic: without a transaction, a failed insert
  // after the delete would leave the roster empty (revoking access), and two
  // concurrent syncs could interleave into a corrupt roster. Access decisions
  // read this table, so consistency is a security property, not just tidiness.
  await db.transaction(async (tx) => {
    await tx.delete(jobRecruitersTable).where(eq(jobRecruitersTable.jobId, jobId));
    if (unique.length === 0) return;
    await tx.insert(jobRecruitersTable)
      .values(unique.map(rid => ({ tenantId, jobId, recruiterUserId: rid, assignedByUserId })))
      .onConflictDoNothing();
  });
}

/* ── GET /jobs/:jobId ─────────────────────────────────────────────────── */
router.get("/jobs/:jobId", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!job) { res.status(404).json({ error: "Not found" }); return; }
  /* Cross-tenant access returns 404 (not 403) to prevent ID enumeration. */
  if (user.role !== "platform_admin") {
    /* recruiter_admin → assigned client sub-tenants only (getDataScopeTenantIds);
       everyone else uses the full subtree. No assigned clients ⇒ nothing. */
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(job.tenantId)) {
      res.status(404).json({ error: "Not found" }); return;
    }
    /* A plain recruiter only sees requisitions assigned to them (primary OR
       join-table member) — mirror the list view (GET /jobs) so the detail route
       can't leak unassigned reqs. */
    if (await recruiterBlockedFromJob(user, job)) {
      res.status(404).json({ error: "Not found" }); return;
    }
  }

  res.json(await jobWithCount(job));
});

/* ── PUT /jobs/:jobId ─────────────────────────────────────────────────── */
router.put("/jobs/:jobId", validate({ body: UpdateJobBody }), async (req, res) => {
  const user = await getCallerUser(req);
  /* Mandatory auth — previously authz only ran inside `if (user && …)`,
     so an unauthenticated caller could PUT any job by ID. */
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [existing] = await db.select({ id: jobsTable.id, tenantId: jobsTable.tenantId, assignedRecruiterId: jobsTable.assignedRecruiterId }).from(jobsTable)
    .where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  if (user.role !== "platform_admin") {
    /* A recruiter_admin may only touch jobs inside their ASSIGNED client
       sub-tenants (getDataScopeTenantIds); everyone else uses the full subtree. */
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(existing.tenantId)) {
      /* 404 (not 403) to avoid leaking job existence across tenants. */
      res.status(404).json({ error: "Not found" }); return;
    }
    /* A plain recruiter may only mutate requisitions assigned to them. */
    if (await recruiterBlockedFromJob(user, existing)) {
      res.status(404).json({ error: "Not found" }); return;
    }
  }

  const updateData = { ...req.body, updatedAt: new Date() };
  /* `assignedRecruiterIds` is the multi-recruiter roster — NOT a jobs column.
     Pull it out of updateData (it would break the UPDATE otherwise) and handle
     it via the join table below. */
  const rosterInput: string[] | undefined = Array.isArray((updateData as any).assignedRecruiterIds)
    ? (updateData as any).assignedRecruiterIds.filter((x: unknown): x is string => typeof x === "string" && !!x)
    : undefined;
  delete (updateData as any).assignedRecruiterIds;
  // Normalize the client work order number: blank/whitespace clears it to null.
  if ("clientWorkOrderNumber" in updateData) {
    const v = updateData.clientWorkOrderNumber;
    updateData.clientWorkOrderNumber = (typeof v === "string" && v.trim()) ? v.trim() : null;
  }
  // Hiring managers always remain assigned to their own requisitions
  if (user && user.role === "hiring_manager") {
    updateData.assignedHiringManagerId = user.id;
  }

  /* When a roster is supplied, the primary (assignedRecruiterId) follows it: an
     explicit assignedRecruiterId wins, else the first roster id becomes primary
     so the lead is always part of the roster. */
  if (rosterInput !== undefined && !updateData.assignedRecruiterId && rosterInput.length > 0) {
    updateData.assignedRecruiterId = rosterInput[0];
  }

  /* Every recruiter that will be granted access must be a real `recruiter`
     inside the caller's agency subtree (platform_admin is unrestricted). This
     covers both the single assignedRecruiterId (re)assignment and the multi
     roster — an unvalidated id would grant an arbitrary user access to the req
     and its candidates. */
  if (user.role !== "platform_admin") {
    const idsToValidate = new Set<string>();
    if (typeof updateData.assignedRecruiterId === "string" && updateData.assignedRecruiterId) {
      idsToValidate.add(updateData.assignedRecruiterId);
    }
    if (rosterInput) for (const id of rosterInput) idsToValidate.add(id);
    if (!(await validateRecruiterIds(user, [...idsToValidate]))) {
      res.status(400).json({ error: "One or more assigned recruiters are invalid or outside your scope" }); return;
    }
  }

  const [job] = await db.update(jobsTable)
    .set(updateData)
    .where(eq(jobsTable.id, req.params.jobId))
    .returning();
  if (!job) { res.status(404).json({ error: "Not found" }); return; }

  /* Sync the join table when a roster was supplied. The roster = the whole set
     the UI sent, plus the resolved primary (so the lead is always a member). */
  if (rosterInput !== undefined) {
    const fullRoster = [...new Set([job.assignedRecruiterId, ...rosterInput].filter(Boolean) as string[])];
    await syncJobRecruiters(job.id, job.tenantId, fullRoster, user.id);
  }

  const result = await jobWithCount(job);
  res.json(result);

  if (req.body.description && req.body.description.length > 20) {
    logger.info({ jobId: job.id }, "Job updated → re-triggering ICP agent");
    orchestrator.triggerAgent("icp", { jobId: job.id, title: job.title, description: job.description, department: job.department, location: job.location }, "orchestrator")
      .catch(err => logger.error({ err, jobId: job.id }, "ICP agent failed after job update"));
  }
});

/* ── POST /jobs/:jobId/submit ─────────────────────────────────────────────
 * Submits a draft job for approval:
 *   - Recruiters/admins → submit to assigned hiring manager
 *   - Hiring managers   → submit to tenant admin for approval (HM is the creator)
 * Status transitions: draft → pending_approval
 * ────────────────────────────────────────────────────────────────────────── */
router.post("/jobs/:jobId/submit", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!["platform_admin", "tenant_admin", "recruiter", "hiring_manager"].includes(user.role)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Job not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getAllowedTenantIds(user);
    if (allowed && !allowed.includes(existing.tenantId)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    /* A plain recruiter may only submit requisitions assigned to them. */
    if (await recruiterBlockedFromJob(user, existing)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
  }

  if (!["draft", "active"].includes(existing.status)) {
    res.status(400).json({ error: `Job is ${existing.status} — only active or draft jobs can be submitted for approval` }); return;
  }

  // HMs submitting their own requisition don't need an external HM assigned —
  // they are the HM.
  const isHmCreatedJob = user.role === "hiring_manager" && existing.createdById === user.id;

  // HMs can only submit jobs they created
  if (user.role === "hiring_manager" && existing.createdById !== user.id) {
    res.status(403).json({ error: "You can only submit work orders you created" }); return;
  }

  /* Resolve the approval queue. A recruiter's work order routes to the
     recruiter_admin assigned to the client (or the tenant_admin). Only when
     there is neither an eligible approver NOR an assigned hiring manager is
     there nobody to review it — in that case require an HM first. */
  const approvers = await resolveJobApprovers(existing.tenantId, user.tenantId ?? existing.tenantId);
  if (!isHmCreatedJob && approvers.length === 0 && !existing.assignedHiringManagerId) {
    res.status(400).json({ error: "Assign a hiring manager before submitting for approval" }); return;
  }

  const [updated] = await db.update(jobsTable)
    .set({ status: "pending_approval", updatedAt: new Date() })
    .where(eq(jobsTable.id, req.params.jobId))
    .returning();

  void notifyJobApprovers(updated, approvers, user.name ?? user.email ?? "A recruiter");

  logger.info({ jobId: updated.id, submittedBy: user.id, submitterRole: user.role, approvers: approvers.length }, "Job submitted for approval");
  res.json(await jobWithCount(updated));
});

/* ── PATCH /jobs/:jobId/approve ───────────────────────────────────────────
 * Approves a pending_approval job.
 *   - HM-created jobs → must be approved by tenant_admin (not the HM themselves)
 *   - Recruiter-created jobs → approved by the assigned HM (or any admin)
 * Optional body: { assignedRecruiterId } — tenant_admin can assign a recruiter on approval
 * Status transitions: pending_approval → active
 * ────────────────────────────────────────────────────────────────────────── */
router.patch("/jobs/:jobId/approve", validate({ body: ApproveJobBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!["platform_admin", "tenant_admin", "recruiter_admin", "hiring_manager"].includes(user.role)) {
    res.status(403).json({ error: "Only hiring managers, recruiter admins, and tenant admins can approve jobs" }); return;
  }

  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Job not found" }); return; }

  /* Tenant ceiling: a recruiter_admin may approve only inside their assigned
     client sub-tenants; tenant_admin/hiring_manager only within their subtree.
     404 (not 403) for out-of-scope jobs to avoid ID enumeration. */
  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(existing.tenantId)) {
      res.status(404).json({ error: "Job not found" }); return;
    }
  }

  // No one may approve a work order they themselves created.
  if (existing.createdById === user.id) {
    res.status(403).json({ error: "You cannot approve a work order you created. It must be reviewed by someone else." }); return;
  }

  // HMs can only approve jobs assigned to them (recruiter-initiated flow)
  if (user.role === "hiring_manager" && existing.assignedHiringManagerId !== user.id) {
    res.status(403).json({ error: "You are not the assigned hiring manager for this job" }); return;
  }

  if (existing.status !== "pending_approval") {
    res.status(400).json({ error: `Job is ${existing.status} — only pending_approval jobs can be approved` }); return;
  }

  const { assignedRecruiterId, assignedRecruiterIds } = req.body as { assignedRecruiterId?: string; assignedRecruiterIds?: string[] };
  /* recruiter_admin may also staff on approval — every id is still validated
     against their scope via validateRecruiterIds below. */
  const canAssign = ["platform_admin", "tenant_admin", "recruiter_admin"].includes(user.role);
  const rosterInput: string[] | undefined = (canAssign && Array.isArray(assignedRecruiterIds))
    ? assignedRecruiterIds.filter((x): x is string => typeof x === "string" && !!x)
    : undefined;

  const updatePayload: Record<string, any> = {
    status: "active",
    approvedById: user.id,
    rejectionNote: null,
    updatedAt: new Date(),
  };
  // Tenant admin can simultaneously assign recruiter(s) when approving a job.
  // Primary = explicit assignedRecruiterId, else the first roster id.
  const primaryOnApprove = (canAssign ? assignedRecruiterId : undefined) || rosterInput?.[0];
  if (primaryOnApprove) {
    updatePayload.assignedRecruiterId = primaryOnApprove;
  }

  /* Validate every recruiter that will be granted access (primary + roster). */
  if (user.role !== "platform_admin") {
    const idsToValidate = new Set<string>();
    if (primaryOnApprove) idsToValidate.add(primaryOnApprove);
    if (rosterInput) for (const id of rosterInput) idsToValidate.add(id);
    if (!(await validateRecruiterIds(user, [...idsToValidate]))) {
      res.status(400).json({ error: "One or more assigned recruiters are invalid or outside your scope" }); return;
    }
  }

  const [updated] = await db.update(jobsTable)
    .set(updatePayload)
    .where(eq(jobsTable.id, req.params.jobId))
    .returning();

  /* Sync the join table when a roster was supplied on approval. */
  if (rosterInput !== undefined) {
    const fullRoster = [...new Set([updated.assignedRecruiterId, ...rosterInput].filter(Boolean) as string[])];
    await syncJobRecruiters(updated.id, updated.tenantId, fullRoster, user.id);
  }

  logger.info({ jobId: updated.id, approvedBy: user.id, assignedRecruiterId: updated.assignedRecruiterId }, "Job approved → active");
  res.json(await jobWithCount(updated));
});

/* ── PATCH /jobs/:jobId/reject ────────────────────────────────────────────
 * Hiring manager (or admin) rejects a pending_approval job.
 * Status transitions: pending_approval → draft (with rejection note, so
 * the recruiter can revise and resubmit).
 * ────────────────────────────────────────────────────────────────────────── */
router.patch("/jobs/:jobId/reject", validate({ body: RejectJobBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!["platform_admin", "tenant_admin", "recruiter_admin", "hiring_manager"].includes(user.role)) {
    res.status(403).json({ error: "Only hiring managers, recruiter admins, and tenant admins can reject jobs" }); return;
  }

  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Job not found" }); return; }

  /* Same tenant ceiling as approve: recruiter_admin → assigned clients only;
     others → their subtree. 404 for out-of-scope jobs. */
  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(existing.tenantId)) {
      res.status(404).json({ error: "Job not found" }); return;
    }
  }

  // No one may reject a work order they themselves created.
  if (existing.createdById === user.id) {
    res.status(403).json({ error: "You cannot return a work order you created. It must be reviewed by someone else." }); return;
  }

  if (user.role === "hiring_manager" && existing.assignedHiringManagerId !== user.id) {
    res.status(403).json({ error: "You are not the assigned hiring manager for this job" }); return;
  }

  if (existing.status !== "pending_approval") {
    res.status(400).json({ error: `Job is ${existing.status} — only pending_approval jobs can be rejected` }); return;
  }

  const { note } = req.body as { note?: string };

  const [updated] = await db.update(jobsTable)
    // Return to draft so the recruiter can revise and resubmit
    .set({ status: "draft", rejectionNote: note ?? null, approvedById: null, updatedAt: new Date() })
    .where(eq(jobsTable.id, req.params.jobId))
    .returning();

  logger.info({ jobId: updated.id, rejectedBy: user.id, note }, "Job rejected → back to draft");
  res.json(await jobWithCount(updated));
});

/* ── DELETE /jobs/:jobId ──────────────────────────────────────────────── */
router.delete("/jobs/:jobId", async (req, res) => {
  const user = await getCallerUser(req);
  /* Mandatory auth — destructive op; never allow anonymous deletes. */
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [existing] = await db.select({ id: jobsTable.id, tenantId: jobsTable.tenantId, assignedRecruiterId: jobsTable.assignedRecruiterId }).from(jobsTable)
    .where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  if (user.role !== "platform_admin") {
    /* recruiter_admin → assigned client sub-tenants only; everyone else uses
       the full subtree. No assigned clients ⇒ nothing. */
    const allowed = await getDataScopeTenantIds(user);
    if (!allowed || !allowed.includes(existing.tenantId)) {
      res.status(404).json({ error: "Not found" }); return;
    }
    /* A plain recruiter may only delete requisitions assigned to them. */
    if (await recruiterBlockedFromJob(user, existing)) {
      res.status(404).json({ error: "Not found" }); return;
    }
  }

  await db.delete(jobsTable).where(eq(jobsTable.id, req.params.jobId));
  res.json({ success: true, message: "Job deleted" });
});

/* ── PATCH /jobs/:jobId/publish ───────────────────────────────────────────
 * Posts the job to the public career site by transitioning active → published.
 * Only active jobs can be published; closed/paused/pending jobs cannot.
 * Status transitions: active → published  (or published → active to unpublish)
 * ────────────────────────────────────────────────────────────────────────── */
router.patch("/jobs/:jobId/publish", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  if (!["platform_admin", "tenant_admin", "recruiter", "hiring_manager"].includes(user.role)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Job not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getAllowedTenantIds(user);
    if (allowed && !allowed.includes(existing.tenantId)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    /* A plain recruiter may only publish/unpublish requisitions assigned to them. */
    if (await recruiterBlockedFromJob(user, existing)) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
  }

  const { unpublish } = req.body as { unpublish?: boolean };

  if (unpublish) {
    // Unpublish: published → active
    if (existing.status !== "published") {
      res.status(400).json({ error: `Job is ${existing.status} — only published jobs can be unpublished` }); return;
    }
    const [updated] = await db.update(jobsTable)
      .set({ status: "active", updatedAt: new Date() })
      .where(eq(jobsTable.id, req.params.jobId))
      .returning();
    logger.info({ jobId: updated.id, by: user.id }, "Job unpublished → active");
    res.json(await jobWithCount(updated));
    return;
  }

  // Publish: active → published
  if (existing.status !== "active") {
    res.status(400).json({ error: `Job is ${existing.status} — only active jobs can be published to the career site` }); return;
  }
  const [updated] = await db.update(jobsTable)
    .set({ status: "published", updatedAt: new Date() })
    .where(eq(jobsTable.id, req.params.jobId))
    .returning();
  logger.info({ jobId: updated.id, by: user.id }, "Job published → career site");
  res.json(await jobWithCount(updated));
});

/* ── PATCH /jobs/:jobId/close ─────────────────────────────────────────────
 * Closes a work order. Side effects:
 *   1. Any candidate with an in-flight offer (offer / offer_recommended /
 *      offer_extended / offer_accepted) is automatically advanced to "hired"
 *      because the role is filled.
 *   2. Returns the list of hired candidates so the frontend can prompt
 *      the recruiter for outcome feedback ("did they succeed in the role?").
 * ────────────────────────────────────────────────────────────────────────── */
router.patch("/jobs/:jobId/close", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Job not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(existing.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    /* A plain recruiter may only close requisitions assigned to them. */
    if (await recruiterBlockedFromJob(user, existing)) { res.status(403).json({ error: "Forbidden" }); return; }
  }
  if (existing.status === "closed") { res.status(400).json({ error: "Work order is already closed" }); return; }

  // ── 1. Find applications that need auto-advancing to hired ────────────
  const AUTO_HIRE_STAGES = ["offer", "offer_recommended", "offer_extended", "offer_accepted"];
  const pendingApps = await db
    .select({
      id: applicationsTable.id,
      candidateId: applicationsTable.candidateId,
      tenantId: applicationsTable.tenantId,
      stage: applicationsTable.stage,
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
    })
    .from(applicationsTable)
    .leftJoin(candidatesTable, eq(applicationsTable.candidateId, candidatesTable.id))
    .where(and(
      eq(applicationsTable.jobId, req.params.jobId),
      inArray(applicationsTable.stage, AUTO_HIRE_STAGES as any),
    ));

  // ── 2. Auto-hire them ─────────────────────────────────────────────────
  const autoHired: { applicationId: string; candidateId: string; candidateName: string }[] = [];
  for (const app of pendingApps) {
    await changeCandidateStage({
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      jobId: req.params.jobId,
      to: "hired",
      from: app.stage,
      actor: { type: "system", id: user.id, label: "Auto-hire on job close" },
      source: "job_close_autohire",
      applicationId: app.id,
      metadata: { autoHiredOnClose: true, previousStage: app.stage },
    });

    await logCandidateEvent({
      candidateId:   app.candidateId,
      jobId:         req.params.jobId,
      tenantId:      app.tenantId,
      applicationId: app.id,
      eventType:     "HIRED",
      actorType:     "system",
      source:        "lexy_app",
      metadata:      { autoHiredOnClose: true, previousStage: app.stage },
    });

    autoHired.push({
      applicationId: app.id,
      candidateId:   app.candidateId,
      candidateName: [app.firstName, app.lastName].filter(Boolean).join(" ") || "Candidate",
    });
    logger.info({ applicationId: app.id, previousStage: app.stage }, "Auto-hired on job close");
  }

  // ── 3. Also collect already-hired/started candidates for outcome dialog ─
  const alreadyHiredApps = await db
    .select({
      id: applicationsTable.id,
      candidateId: applicationsTable.candidateId,
      stage: applicationsTable.stage,
      firstName: candidatesTable.firstName,
      lastName: candidatesTable.lastName,
    })
    .from(applicationsTable)
    .leftJoin(candidatesTable, eq(applicationsTable.candidateId, candidatesTable.id))
    .where(and(
      eq(applicationsTable.jobId, req.params.jobId),
      inArray(applicationsTable.stage as any, ["hired", "started"]),
    ));

  const outcomeEligible = [
    ...autoHired,
    ...alreadyHiredApps.map(a => ({
      applicationId: a.id,
      candidateId:   a.candidateId,
      candidateName: [a.firstName, a.lastName].filter(Boolean).join(" ") || "Candidate",
    })),
  ];

  // ── 4. Close the job ──────────────────────────────────────────────────
  const [closed] = await db.update(jobsTable)
    .set({ status: "closed", updatedAt: new Date() })
    .where(eq(jobsTable.id, req.params.jobId))
    .returning();

  logger.info({ jobId: closed.id, by: user.id, autoHiredCount: autoHired.length }, "Work order closed");

  /* LINX loop-closure (Step 4): if this job is a LINX-side requisition,
   * mirror the terminal state onto the originating request. Any hire on the
   * req = filled; closed without a hire = closed. Fire-and-forget; the
   * choke-point hook already covers per-hire fills — this covers the
   * closed-without-fill case (and is idempotent for the filled one). */
  void resolveLinxRequisitionTerminal(
    req.params.jobId,
    outcomeEligible.length > 0 ? "filled" : "closed",
  );

  res.json({ job: await jobWithCount(closed), autoHired, outcomeEligible });
});

/* ── PATCH /jobs/:jobId/reopen ────────────────────────────────────────────
 * Reopens a closed work order back to "active".
 * ────────────────────────────────────────────────────────────────────────── */
router.patch("/jobs/:jobId/reopen", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [existing] = await db.select().from(jobsTable).where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Job not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(existing.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    /* A plain recruiter may only reopen requisitions assigned to them. */
    if (await recruiterBlockedFromJob(user, existing)) { res.status(403).json({ error: "Forbidden" }); return; }
  }
  if (existing.status !== "closed") { res.status(400).json({ error: `Work order is ${existing.status}, not closed` }); return; }

  const [updated] = await db.update(jobsTable)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(jobsTable.id, req.params.jobId))
    .returning();

  logger.info({ jobId: updated.id, by: user.id }, "Work order reopened → active");

  /* LINX loop-closure (Step 4): reopening a LINX requisition undoes the
   * terminal mirror — the originating request returns to 'accepted'. */
  void revertLinxRequisitionTerminal(req.params.jobId);

  res.json(await jobWithCount(updated));
});

/* ── POST /jobs/:jobId/role-outcome ───────────────────────────────────────
 * One-click recruiter feedback: "did this candidate succeed in the role?"
 * Logs a ROLE_OUTCOME_REPORTED event and, on success, also logs STARTED.
 * This feeds Lexy's intelligence for future recommendations.
 * ────────────────────────────────────────────────────────────────────────── */
router.post("/jobs/:jobId/role-outcome", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { applicationId, succeeded } = req.body as { applicationId: string; succeeded: boolean };
  if (!applicationId || succeeded === undefined) {
    res.status(400).json({ error: "applicationId and succeeded are required" }); return;
  }

  const [app] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, applicationId)).limit(1);
  if (!app) { res.status(404).json({ error: "Application not found" }); return; }

  if (user.role !== "platform_admin") {
    const allowed = await getDataScopeTenantIds(user);
    if (allowed && !allowed.includes(app.tenantId)) { res.status(403).json({ error: "Forbidden" }); return; }
    /* A plain recruiter may only report outcomes for requisitions assigned to
       them — resolve the application's job and check ownership. */
    if (user.role === "recruiter") {
      const [j] = await db.select({ assignedRecruiterId: jobsTable.assignedRecruiterId })
        .from(jobsTable).where(eq(jobsTable.id, app.jobId)).limit(1);
      if (await recruiterBlockedFromJob(user, { id: app.jobId, assignedRecruiterId: j?.assignedRecruiterId ?? null })) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
    }
  }

  await logCandidateEvent({
    candidateId:   app.candidateId,
    jobId:         app.jobId,
    tenantId:      app.tenantId,
    applicationId: app.id,
    eventType:     "ROLE_OUTCOME_REPORTED",
    actorType:     actorTypeFromRole(user.role),
    actorId:       user.id,
    source:        "recruiter_action",
    metadata:      { succeeded, reportedAt: new Date().toISOString() },
  });

  // If they succeeded, also advance to "started" and upsert an outcome row
  if (succeeded && app.stage === "hired") {
    await changeCandidateStage({
      tenantId: app.tenantId,
      candidateId: app.candidateId,
      jobId: app.jobId,
      to: "started",
      from: app.stage,
      actor: { type: "user", role: user.role, id: user.id },
      source: "recruiter_action",
      applicationId: app.id,
    });

    await db.insert(candidateOutcomesTable).values({
      id: crypto.randomUUID(),
      tenantId:      app.tenantId,
      applicationId: app.id,
      candidateId:   app.candidateId,
      jobId:         app.jobId,
      startDate:     new Date(),
      offerAccepted: true,
      outcomeSource: "recruiter_feedback",
    }).onConflictDoNothing();

    await logCandidateEvent({
      candidateId:   app.candidateId,
      jobId:         app.jobId,
      tenantId:      app.tenantId,
      applicationId: app.id,
      eventType:     "STARTED",
      actorType:     actorTypeFromRole(user.role),
      actorId:       user.id,
      source:        "recruiter_action",
      metadata:      { triggeredByOutcomeFeedback: true },
    });
  }

  logger.info({ applicationId, jobId: req.params.jobId, succeeded, by: user.id }, "Role outcome reported");
  res.json({ ok: true, succeeded });
});

/* ── PATCH /jobs/:jobId/platform-recommendations ─────────────────────────
 * Toggles the "open to platform candidate recommendations" flag on a work
 * order. This is the tenant's CONSENT for Lexy platform admins to push
 * candidates from the platform talent pool into their pipeline. It MUST
 * therefore be controlled exclusively by the tenant — a platform admin
 * cannot opt a tenant in on their behalf (that would violate the trust
 * model: platform admins would gain visibility into the tenant's work
 * order on the /platform/open-work-orders page without the tenant ever
 * agreeing). Allowed roles: tenant_admin, recruiter, hiring_manager —
 * scoped to a tenant that owns the work order. Platform admins are
 * explicitly blocked (403).
 *
 * Every flip is recorded to audit_logs with the previous + new value so
 * the trail of who turned it on/off is permanent.
 */
// Roles permitted to grant/revoke a tenant's consent to platform candidate
// recommendations. Intentionally narrower than STAFF_ROLES — interviewers
// and platform_admin are excluded because this is a tenant-level consent
// decision, not an operational task.
const PLATFORM_RECS_CONSENT_ROLES = ["tenant_admin", "recruiter", "hiring_manager"] as const;

router.patch("/jobs/:jobId/platform-recommendations", validate({ body: PlatformRecommendationsBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  // Platform admins cannot opt a tenant in to platform recommendations on
  // the tenant's behalf — only the tenant's own staff can grant that consent.
  if (user.role === "platform_admin") {
    res.status(403).json({
      error: "Forbidden",
      message:
        "Platform admins cannot toggle a tenant's platform-recommendations opt-in. " +
        "This setting must be changed by a user inside the tenant (tenant admin, recruiter, or hiring manager).",
    });
    return;
  }

  // Only tenant-side roles with hiring authority may grant/revoke this
  // consent. Interviewers and other staff roles are not permitted.
  if (!(PLATFORM_RECS_CONSENT_ROLES as readonly string[]).includes(user.role)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled (boolean) is required" }); return;
  }

  const [existing] = await db.select({
    id: jobsTable.id,
    tenantId: jobsTable.tenantId,
    title: jobsTable.title,
    assignedRecruiterId: jobsTable.assignedRecruiterId,
    platformRecommendationsEnabled: jobsTable.platformRecommendationsEnabled,
  }).from(jobsTable).where(eq(jobsTable.id, req.params.jobId)).limit(1);
  if (!existing) { res.status(404).json({ error: "Not found" }); return; }

  const allowed = await getAllowedTenantIds(user);
  if (allowed && !allowed.includes(existing.tenantId)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  /* A plain recruiter may only toggle platform-recs on requisitions assigned to them. */
  if (await recruiterBlockedFromJob(user, existing)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const previousValue = !!existing.platformRecommendationsEnabled;

  // Flip atomically — only update rows that still hold the previous value. This
  // makes the toggle idempotent under concurrent requests: if two opt-in
  // requests race, only the one that actually flips false→true gets a row back
  // and triggers the immediate scan.
  const flippedRows = await db.update(jobsTable)
    .set({ platformRecommendationsEnabled: enabled, updatedAt: new Date() })
    .where(and(
      eq(jobsTable.id, req.params.jobId),
      eq(jobsTable.platformRecommendationsEnabled, previousValue),
    ))
    .returning();

  // If nothing flipped (already at the requested value), report the current
  // state without re-auditing or re-triggering.
  const updated = flippedRows[0] ?? existing;
  const didFlip = flippedRows.length > 0 && previousValue !== enabled;

  // Audit trail — fire-and-forget so an audit-write failure can't break
  // the toggle itself. recordAudit() is internally exception-safe.
  if (didFlip) {
    void recordAudit({
      tenantId: existing.tenantId,
      actorType: "user",
      actorId: user.id,
      actorLabel: user.name || user.email || user.id,
      subjectType: "system",
      subjectId: existing.id,
      subjectLabel: existing.title || `job:${existing.id}`,
      channel: "system",
      direction: "internal",
      action: enabled ? "platform_recommendations.enabled" : "platform_recommendations.disabled",
      title: enabled
        ? `Opted in to platform candidate recommendations`
        : `Opted out of platform candidate recommendations`,
      metadata: {
        jobId: existing.id,
        previousValue,
        newValue: enabled,
        actorRole: user.role,
      },
    });
  }

  // When a job opts IN (false → true), kick off an immediate single-job
  // recommendation scan so perfectly-aligned candidates are surfaced right away
  // instead of waiting for the next 24-hour scan. Fire-and-forget — never block
  // or fail the toggle on the scan.
  if (didFlip && enabled) {
    void (async () => {
      try {
        const { runPlatformRecommendationForJob } = await import("../lib/platform-recommendation-engine");
        await runPlatformRecommendationForJob(existing.id);
      } catch (err: any) {
        logger.warn(
          { jobId: existing.id, err: err?.message },
          "[jobs] Immediate platform recommendation scan failed",
        );
      }
    })();
  }

  res.json({ ok: true, platformRecommendationsEnabled: updated.platformRecommendationsEnabled });
});

/* ── GET /platform/recommendation-scan-status ────────────────────────────
 * Returns the last scan result and whether a scan is currently in progress.
 */
router.get("/platform/recommendation-scan-status", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user || user.role !== "platform_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const { lastScanResult, scanInProgress } = await import("../lib/platform-recommendation-scheduler");
  res.json({ scanInProgress, lastScanResult });
});

/* ── POST /platform/run-recommendation-scan ──────────────────────────────
 * Manually triggers an immediate platform recommendation scan.
 * Platform admin only. Returns the scan summary when complete.
 */
router.post("/platform/run-recommendation-scan", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user || user.role !== "platform_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  try {
    const { triggerScan } = await import("../lib/platform-recommendation-scheduler");
    const result = await triggerScan();
    res.json({ ok: true, result });
  } catch (err: any) {
    res.status(409).json({ error: err.message });
  }
});

/* ── GET /platform/open-work-orders ──────────────────────────────────────
 * Platform admin: lists ALL work orders that are currently active OR have
 * ever had platform candidate pushes (so paused jobs remain visible).
 * Returns jobs enriched with tenant name, counts, and recommendation status.
 */
router.get("/platform/open-work-orders", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user || user.role !== "platform_admin") {
    res.status(403).json({ error: "Forbidden" }); return;
  }

  const parentTenants = alias(tenantsTable, "parent_tenant");

  // Show jobs that are active OR have ever had talent pool submissions
  const jobs = await db.select({
    id: jobsTable.id,
    title: jobsTable.title,
    department: jobsTable.department,
    location: jobsTable.location,
    workType: jobsTable.workType,
    employmentType: jobsTable.employmentType,
    status: jobsTable.status,
    tenantId: jobsTable.tenantId,
    tenantName: tenantsTable.name,
    parentTenantId: tenantsTable.parentId,
    parentTenantName: parentTenants.name,
    workOrderNumber: jobsTable.workOrderNumber,
    clientWorkOrderNumber: jobsTable.clientWorkOrderNumber,
    platformRecommendationsEnabled: jobsTable.platformRecommendationsEnabled,
    createdAt: jobsTable.createdAt,
    updatedAt: jobsTable.updatedAt,
  })
  .from(jobsTable)
  .leftJoin(tenantsTable, eq(jobsTable.tenantId, tenantsTable.id))
  .leftJoin(parentTenants, eq(tenantsTable.parentId, parentTenants.id))
  .where(
    or(
      eq(jobsTable.platformRecommendationsEnabled, true),
      inArray(
        jobsTable.id,
        db.select({ id: sql<string>`DISTINCT job_posting_id` })
          .from(sql`talent_pool_submissions`)
          .where(sql`job_posting_id IS NOT NULL`) as any,
      ),
    )
  )
  .orderBy(desc(jobsTable.platformRecommendationsEnabled), desc(jobsTable.updatedAt));

  const { talentPoolSubmissionsTable } = await import("@workspace/db");

  const withCounts = await Promise.all(jobs.map(async (j) => {
    const [apps] = await db.select({ count: count() }).from(applicationsTable).where(eq(applicationsTable.jobId, j.id));
    const [pushed] = await db.select({ count: count() })
      .from(talentPoolSubmissionsTable)
      .where(eq((talentPoolSubmissionsTable as any).jobPostingId, j.id));
    const lastPushRow = await db.execute<{ max_pushed_at: string | null }>(
      sql`SELECT MAX(pushed_at)::text AS max_pushed_at FROM talent_pool_submissions WHERE job_posting_id = ${j.id}`,
    );
    return {
      ...j,
      applicationCount: Number(apps.count),
      platformPushCount: Number(pushed.count),
      lastPushAt: (lastPushRow.rows[0] as any)?.max_pushed_at ?? null,
      createdAt: j.createdAt instanceof Date ? j.createdAt.toISOString() : j.createdAt,
      updatedAt: j.updatedAt instanceof Date ? j.updatedAt.toISOString() : j.updatedAt,
    };
  }));

  res.json({ jobs: withCounts });
});

export default router;
