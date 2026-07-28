/**
 * routes/icp.ts — Ideal Candidate Profile (ICP) CRUD
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for creating and managing ICP records per job. The actual prompt,
 * field-merge, and insert/update logic lives in lib/icp-generator.ts so the
 * orchestrator's pipeline-run path uses the exact same generation flow.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /jobs/:jobId/icp           Fetch the latest ICP version for a job
 *   POST /jobs/:jobId/icp           Generate / regenerate the ICP via shared helper
 *   GET  /jobs/:jobId/icp/versions  List all historical ICP versions
 *
 * ─── Tenant isolation (2026-05-23 audit fix) ────────────────────────────────
 * Previously all three routes were COMPLETELY UNAUTHENTICATED: anyone who
 * could guess a jobId could read another tenant's ICP, regenerate it (burning
 * the target tenant's AI credits), or list every historical version. Closed
 * by `gateJobAccess` below — every route now requires a valid Bearer token
 * AND the caller's tenant must own (or be parent of) the job's tenant.
 */
import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import { icpTable, jobsTable, usersTable } from "@workspace/db";
import { getAllowedTenantIds, recruiterIsAssignedToJob } from "../lib/tenantUtils.js";
import { eq, desc, and, sql } from "drizzle-orm";
import { generateIcpForJob } from "../lib/icp-generator.js";
import { logger } from "../lib/logger.js";
import { getAuthUserId } from "../lib/auth-token.js";
import { validate } from "../middlewares/validate";

const GenerateIcpBody = z.object({
  recruiterNotes: z.string().optional(),
  hiringManagerNotes: z.string().optional(),
}).passthrough();

/* Editable list fields a recruiter may hand-tune after generation. Mirrors the
 * chip sections shown on the ICP tab. Each is an array of short strings. */
const ICP_EDITABLE_FIELDS = [
  "requiredSkills",
  "preferredSkills",
  "alternateTitles",
  "requiredCertifications",
  "toolsAndSystems",
  "compliance",
  "negativeKeywords",
  "disqualifiers",
] as const;

const stringList = z.array(z.string()).max(200).optional();
const UpdateIcpBody = z.object({
  requiredSkills: stringList,
  preferredSkills: stringList,
  alternateTitles: stringList,
  requiredCertifications: stringList,
  toolsAndSystems: stringList,
  compliance: stringList,
  negativeKeywords: stringList,
  disqualifiers: stringList,
  // Target sourcing location/region. Nullable string (not a chip list) — clearing
  // it removes the geo constraint.
  location: z.string().max(200).nullable().optional(),
}).strict();

/* Trim, drop blanks, cap length, and dedupe (case-insensitive, first wins). */
function cleanList(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = String(raw).trim().slice(0, 200);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

const router: IRouter = Router();

function mapIcp(icp: any) {
  return {
    ...icp,
    createdAt: icp.createdAt.toISOString(),
  };
}

/* ─── Async ICP generation tracking ─────────────────────────────────────────
 *
 * ICP generation hits gpt-4o and routinely takes 45–90s. The Replit dev
 * proxy and most production HTTP edges close idle connections at ~60s, so
 * a synchronous POST handler produced a 504 Gateway Time-out toast for
 * users even when the LLM eventually succeeded (see attached_assets/
 * image_1779893922899.png).
 *
 * Fix: POST kicks off the work in the background, returns 202 immediately,
 * and the UI polls GET /jobs/:jobId/icp/status until it flips to 'idle'
 * (success) or 'failed'. State is tracked in-process; the api-server runs
 * as a single leader instance, so this is safe today. If the service is
 * ever scaled horizontally, promote this map to a small DB table.
 *
 * Failed entries are kept for FAILED_TTL_MS so the next status poll can
 * deliver the error message once, then evicted.
 */
type IcpJobStatus = "pending" | "failed";
interface IcpJob {
  status: IcpJobStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  previousVersion: number;
}
const icpJobs = new Map<string, IcpJob>();
const FAILED_TTL_MS = 60_000;

function readIcpJob(jobId: string): IcpJob | null {
  const j = icpJobs.get(jobId);
  if (!j) return null;
  if (j.status === "failed" && j.finishedAt && Date.now() - j.finishedAt > FAILED_TTL_MS) {
    icpJobs.delete(jobId);
    return null;
  }
  return j;
}

/* Auth + tenant gate for every job-scoped route below. Mirrors the pattern
   used by routes/pipeline.ts:gateJobAccess. Returns `{ user, job }` on
   success or null after writing the 401/404 response. */
async function gateJobAccess(
  req: Request,
  res: Response,
  jobId: string,
): Promise<{ user: any; job: any } | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1);
  if (!job) { res.status(404).json({ error: "Not found" }); return null; }
  /* Subtree scope: own tenant + ALL descendants via the shared helper, in
     lock-step with the RLS app_tenant_in_scope() policy. null = platform_admin.
     404 not 403 — never confirm cross-tenant job existence. */
  const allowed = await getAllowedTenantIds(user);
  if (allowed !== null && !allowed.includes(job.tenantId ?? "")) {
    res.status(404).json({ error: "Not found" }); return null;
  }
  return { user, job };
}

/* Admin-class roles that may WRITE an ICP for ANY in-scope requisition,
 * including UNASSIGNED ones. */
const ICP_WRITE_ADMIN_ROLES = new Set(["platform_admin", "tenant_admin", "recruiter_admin"]);

/* WRITE authorization for ICP generate/edit. Reads follow standard ownership
 * (gateJobAccess). Writes to an UNASSIGNED requisition are admin-only: a plain
 * recruiter may only generate/edit the ICP of a requisition they are assigned
 * to. Any job with no assigned recruiter (or assigned to a different recruiter)
 * is writable only by an admin-class role. Returns true when allowed; otherwise
 * writes a 403 and returns false. */
async function requireIcpWriteAccess(res: Response, user: any, job: any): Promise<boolean> {
  if (ICP_WRITE_ADMIN_ROLES.has(user.role)) return true;
  if (user.role === "recruiter" && (await recruiterIsAssignedToJob(user.id, job))) return true;
  res.status(403).json({
    error: "Forbidden — ICPs for unassigned requisitions can only be edited by an administrator.",
  });
  return false;
}

router.get("/jobs/:jobId/icp", async (req, res) => {
  if (!(await gateJobAccess(req, res, req.params.jobId))) return;
  const [icp] = await db.select().from(icpTable)
    .where(eq(icpTable.jobId, req.params.jobId))
    .orderBy(desc(icpTable.version))
    .limit(1);
  if (!icp) { res.status(404).json({ error: "ICP not found" }); return; }
  res.json(mapIcp(icp));
});

/* POST kicks off the LLM generation in the background and returns 202
 * immediately so the request never sits on a long-lived HTTP connection
 * (see the IcpJob comment above). Frontend polls /icp/status. */
router.post("/jobs/:jobId/icp", validate({ body: GenerateIcpBody }), async (req, res) => {
  try {
    const gate = await gateJobAccess(req, res, req.params.jobId);
    if (!gate) return;
    if (!(await requireIcpWriteAccess(res, gate.user, gate.job))) return;
    const jobId = req.params.jobId;

    // Idempotency: a second click while a generation is already running
    // returns the existing job rather than starting a duplicate LLM call.
    // The pending entry MUST be claimed before any subsequent await,
    // otherwise two concurrent POSTs can both observe "no pending" while
    // they each await the version lookup, then both enqueue the LLM call.
    const existing = readIcpJob(jobId);
    if (existing && existing.status === "pending") {
      res.status(202).json({
        status: "pending",
        previousVersion: existing.previousVersion,
        startedAt: existing.startedAt,
      });
      return;
    }
    // Claim the slot synchronously with a placeholder previousVersion; we'll
    // backfill the real version below. Any concurrent POST landing between
    // here and the version lookup will see this entry and short-circuit.
    icpJobs.set(jobId, { status: "pending", startedAt: Date.now(), previousVersion: 0 });

    const [latest] = await db.select({ version: icpTable.version })
      .from(icpTable)
      .where(eq(icpTable.jobId, jobId))
      .orderBy(desc(icpTable.version))
      .limit(1);
    const previousVersion = latest?.version ?? 0;
    // Backfill the real previous version on the already-claimed entry.
    const claimed = icpJobs.get(jobId);
    if (claimed && claimed.status === "pending") claimed.previousVersion = previousVersion;

    // Fire-and-forget. Capture body up front so the request object can be
    // garbage-collected as soon as we respond.
    const recruiterNotes = req.body?.recruiterNotes;
    const hiringManagerNotes = req.body?.hiringManagerNotes;
    void (async () => {
      try {
        const icp = await generateIcpForJob({ jobId, recruiterNotes, hiringManagerNotes });
        if (!icp) {
          icpJobs.set(jobId, {
            status: "failed",
            startedAt: icpJobs.get(jobId)?.startedAt ?? Date.now(),
            finishedAt: Date.now(),
            previousVersion,
            error: "AI was unable to generate the profile. Please try again in a moment.",
          });
          logger.warn({ jobId }, "[POST /jobs/:jobId/icp] generator returned null");
          return;
        }
        // Success: drop the tracking entry; the new row is visible via GET.
        icpJobs.delete(jobId);
        logger.info({ jobId, version: icp.version }, "[POST /jobs/:jobId/icp] generation complete");
      } catch (err: any) {
        icpJobs.set(jobId, {
          status: "failed",
          startedAt: icpJobs.get(jobId)?.startedAt ?? Date.now(),
          finishedAt: Date.now(),
          previousVersion,
          error: err?.message?.slice(0, 300) || "Generation failed. Please try again.",
        });
        logger.error({ err: err?.message, jobId }, "[POST /jobs/:jobId/icp] generation threw");
      }
    })();

    res.status(202).json({ status: "pending", previousVersion, startedAt: Date.now() });
  } catch (err: any) {
    logger.error({ err: err?.message, jobId: req.params.jobId }, "[POST /jobs/:jobId/icp] failed to enqueue");
    res.status(500).json({
      error: "ICP_GENERATION_ERROR",
      message: err?.message?.slice(0, 300) || "Could not start ICP generation.",
    });
  }
});

/* PATCH lets a recruiter hand-tune the editable list fields (skills, titles,
 * tools, etc.) of the LATEST ICP version in place — no new version, no LLM call.
 * Only the fields present in the body are touched; each is trimmed/deduped. */
router.patch("/jobs/:jobId/icp", validate({ body: UpdateIcpBody }), async (req, res) => {
  const gate = await gateJobAccess(req, res, req.params.jobId);
  if (!gate) return;
  if (!(await requireIcpWriteAccess(res, gate.user, gate.job))) return;
  const jobId = req.params.jobId;

  const [icp] = await db.select().from(icpTable)
    .where(eq(icpTable.jobId, jobId))
    .orderBy(desc(icpTable.version))
    .limit(1);
  if (!icp) { res.status(404).json({ error: "ICP not found" }); return; }

  const updates: Partial<typeof icpTable.$inferInsert> = {};
  for (const field of ICP_EDITABLE_FIELDS) {
    const val = (req.body as any)[field];
    if (Array.isArray(val)) (updates as any)[field] = cleanList(val);
  }
  // Location is a single string (not a chip list). Trim; an empty string clears
  // the geo constraint (stored as null).
  if ("location" in req.body) {
    const loc = (req.body as any).location;
    updates.location = typeof loc === "string" && loc.trim() ? loc.trim().slice(0, 200) : null;
  }
  if (Object.keys(updates).length === 0) { res.json(mapIcp(icp)); return; }

  // Target the CURRENT latest version atomically: if a regeneration inserts a
  // newer row between the select above and this update, this still writes the
  // now-latest row (max version) rather than a stale id. Returns null if no row
  // matches (e.g. the ICP was deleted) — fall back to the row we read.
  const [updated] = await db.update(icpTable)
    .set(updates)
    .where(and(
      eq(icpTable.jobId, jobId),
      eq(icpTable.version, sql<number>`(select max(${icpTable.version}) from ${icpTable} where ${icpTable.jobId} = ${jobId})`),
    ))
    .returning();
  logger.info({ jobId, fields: Object.keys(updates) }, "[PATCH /jobs/:jobId/icp] manual edit saved");
  res.json(mapIcp(updated ?? icp));
});

/* Polling endpoint used by the recruiter UI while a regeneration is in
 * flight. Returns one of:
 *   { status: "pending",  previousVersion, startedAt }
 *   { status: "failed",   previousVersion, error }
 *   { status: "idle",     currentVersion }   ← work finished (or never running)
 *
 * A 'failed' read consumes the failure (one-shot delivery) so a subsequent
 * poll returns 'idle' and the UI doesn't loop on the same error. */
router.get("/jobs/:jobId/icp/status", async (req, res) => {
  const gate = await gateJobAccess(req, res, req.params.jobId);
  if (!gate) return;
  const jobId = req.params.jobId;

  const job = readIcpJob(jobId);
  if (job?.status === "pending") {
    res.json({
      status: "pending",
      previousVersion: job.previousVersion,
      startedAt: job.startedAt,
    });
    return;
  }
  if (job?.status === "failed") {
    icpJobs.delete(jobId);
    res.json({
      status: "failed",
      previousVersion: job.previousVersion,
      error: job.error || "Generation failed.",
    });
    return;
  }

  const [latest] = await db.select({ version: icpTable.version })
    .from(icpTable)
    .where(eq(icpTable.jobId, jobId))
    .orderBy(desc(icpTable.version))
    .limit(1);
  res.json({ status: "idle", currentVersion: latest?.version ?? 0 });
});

router.get("/jobs/:jobId/icp/versions", async (req, res) => {
  if (!(await gateJobAccess(req, res, req.params.jobId))) return;
  const versions = await db.select().from(icpTable).where(eq(icpTable.jobId, req.params.jobId)).orderBy(desc(icpTable.version));
  res.json(versions.map(mapIcp));
});

export default router;
