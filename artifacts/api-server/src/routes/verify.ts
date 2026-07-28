/**
 * routes/verify.ts — Candidate Verification Record API
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for reading and updating the verification_records table. A
 * verification record stores the output of the Verification Agent: identity
 * check status, duplicate detection flag, resume-consistency score, and a
 * list of specific risk flags raised.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /verify/:candidateId    Fetch the verification record for a candidate.
 *                                Returns a zeroed-out "unverified" shape if no
 *                                record exists yet (never 404) so the UI can
 *                                always render the verification panel.
 *   POST /verify/:candidateId    Trigger / update verification record. Creates
 *                                the row if it doesn't exist (upsert).
 *
 * ─── Tenant isolation (2026-05-23 audit fix) ────────────────────────────────
 * Previously both routes were COMPLETELY UNAUTHENTICATED. GET let any caller
 * read another tenant's verification flags (risk score, dup-detection, etc.)
 * by guessing a candidateId. POST let any caller WRITE a fake "verified"
 * record for any candidate — including the hardcoded tenantId: "acme" bug
 * which corrupted rows for tenants whose id was anything else. Both now
 * require auth AND the candidate's tenantId must be one the caller owns.
 *
 * ─── Verification fields ─────────────────────────────────────────────────────
 *   status                — "unverified" | "in_progress" | "verified" | "flagged"
 *   riskScore             — 0–100 (higher = more risk signals)
 *   flags                 — string[] of risk flag codes (e.g. "resume_gap",
 *                           "email_domain_mismatch", "duplicate_profile")
 *   identityVerified      — LinkedIn profile confirmed to match candidate data
 *   duplicateDetected     — another candidate row with the same email / LinkedIn
 *   resumeConsistencyScore — 0–100 match between resume text and ICP claims
 *   reviewNotes           — recruiter free-text notes after manual review
 */
import { Router, type IRouter } from "express";
import type { Request, Response } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import { verificationRecordsTable, candidatesTable, usersTable } from "@workspace/db";
import { getDataScopeTenantIds } from "../lib/tenantUtils.js";
import { eq } from "drizzle-orm";
import { getAuthUserId } from "../lib/auth-token.js";
import { validate } from "../middlewares/validate";
import { runCandidateVerification } from "../lib/run-verification.js";
import { enforceOwnership } from "../lib/ownership.js";

/* POST /verify/:candidateId takes no caller-supplied fields — the
 * verification status, score, and flags are produced server-side by the
 * real Verification Agent (runCandidateVerification). Strict empty-body
 * blocks a bug where a caller could forge a "verified" record by sending
 * { status: "verified", riskScore: 0 }. */
const VerifyTriggerBody = z.object({}).strict();

const router: IRouter = Router();

function mapVerification(v: any) {
  return {
    ...v,
    reviewedAt: v.reviewedAt?.toISOString() || null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/* Auth + tenant gate for both verify routes. Returns the resolved candidate
   row on success (so the handler can use the real tenantId for upserts) or
   null after writing the 401/404 response. */
async function gateCandidateAccess(
  req: Request,
  res: Response,
  candidateId: string,
): Promise<{ user: any; candidate: any } | null> {
  const userId = getAuthUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [user] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const [candidate] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!candidate) { res.status(404).json({ error: "Not found" }); return null; }
  /* Subtree scope: own tenant + ALL descendants via the shared helper, in
     lock-step with the RLS app_tenant_in_scope() policy. null = platform_admin. */
  const allowed = await getDataScopeTenantIds(user);
  if (allowed !== null && !allowed.includes(candidate.tenantId ?? "")) {
    res.status(404).json({ error: "Not found" }); return null;
  }
  return { user, candidate };
}

router.get("/verify/:candidateId", enforceOwnership({ kinds: ["candidateId"] }), async (req, res) => {
  if (!(await gateCandidateAccess(req, res, req.params.candidateId))) return;
  const [v] = await db.select().from(verificationRecordsTable).where(eq(verificationRecordsTable.candidateId, req.params.candidateId)).limit(1);
  if (!v) {
    res.json({
      candidateId: req.params.candidateId,
      status: "unverified",
      riskScore: 0,
      flags: [],
      identityVerified: false,
      duplicateDetected: false,
      resumeConsistencyScore: null,
      reviewedAt: null,
      reviewNotes: null,
    });
    return;
  }
  res.json(mapVerification(v));
});

router.post("/verify/:candidateId", validate({ body: VerifyTriggerBody }), enforceOwnership({ kinds: ["candidateId"] }), async (req, res) => {
  const candidateId = String(req.params.candidateId);
  const gate = await gateCandidateAccess(req, res, candidateId);
  if (!gate) return;

  /* Run the REAL Verification Agent (no random stub). This performs the
     digital identity check and persists the verdict to both the candidate
     row (verificationStatus + verificationResult) and the verification_records
     row, keeping this endpoint consistent with the kanban "Send to Verify"
     path. We then return the freshly-written verification_records row. */
  const result = await runCandidateVerification({ candidateId, tenantId: gate.candidate.tenantId });
  if (!result) {
    res.status(409).json({ error: "Verification could not be run for this candidate" });
    return;
  }

  const [v] = await db.select().from(verificationRecordsTable)
    .where(eq(verificationRecordsTable.candidateId, candidateId)).limit(1);
  if (!v) {
    // Agent ran but the (best-effort) record write didn't land — surface the
    // verdict directly rather than fabricating a verification_records shape.
    res.json({
      candidateId,
      status: result.verificationStatus,
      verificationResult: result.verificationResult,
    });
    return;
  }
  res.json(mapVerification(v));
});

export default router;
