/**
 * lib/run-verification.ts — Verification Agent runner
 *
 * Single home for Lexy's Verification Agent so every path that moves a
 * candidate into the "verification" stage runs the SAME identity check and
 * produces the SAME result shape:
 *
 *   - Sourced candidates  → pipeline.ts `send_to_verify` card-action
 *   - Application-based    → applications.ts PUT when stage becomes "verification"
 *     (manual / applied candidates that have no sourced_candidates row)
 *
 * `runVerificationAgent()` is the pure AI call + verdict mapping (no DB).
 * `runCandidateVerification()` loads the normalized candidate, runs the agent,
 * and persists the verdict to candidates + verification_records.
 */
import { db, candidatesTable, verificationRecordsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { generateJSON } from "./ai.js";
import { logger } from "./logger.js";
import { getSubtreeTenantIds } from "./tenantUtils.js";

export interface VerificationAgentContext {
  name: string;
  email: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  currentTitle?: string | null;
  currentCompany?: string | null;
  location?: string | null;
  skills?: string[];
  source?: string | null;
}

export type VerificationStatus = "verified" | "flagged" | "pending";

export interface VerificationAgentOutput {
  verificationResult: any;
  verificationStatus: VerificationStatus;
}

/** Pure agent call: runs the identity check and maps the verdict to a status.
 *  Never throws — on AI failure it returns a "review"/pending result so the
 *  stage move is never blocked. */
export async function runVerificationAgent(ctx: VerificationAgentContext): Promise<VerificationAgentOutput> {
  let verificationResult: any = null;
  try {
    verificationResult = await generateJSON<any>(
      `Run digital identity verification on this candidate.\n\nCandidate data:\n${JSON.stringify(ctx, null, 2)}\n\n` +
      `Be pragmatic — manual/CSV-imported candidates often have sparse data; treat unknown fields as "unknown" not "suspicious", ` +
      `and only "flag" when there is positive evidence of fraud or impersonation. Default to "review" when info is incomplete.\n\n` +
      `Return JSON: { "linkedinMatch": "verified"|"partial"|"unverified"|"mismatch", "resumeConsistency": "consistent"|"minor_discrepancies"|"major_discrepancies", "emailValidity": "valid"|"suspicious"|"disposable", "profileCompleteness": number (0-100), "riskFlags": string[], "checksPerformed": string[], "overallScore": number (0-100), "verdict": "clear"|"review"|"flag", "notes": string }`,
      "You are Lexy's Verification Agent. Conduct fair, pragmatic digital identity checks. JSON only.",
    );
  } catch (err: any) {
    verificationResult = { verdict: "review", notes: `Verification check failed: ${err?.message || "AI error"}`, riskFlags: [], checksPerformed: [] };
  }

  const verdict = verificationResult?.verdict || "review";
  const verificationStatus: VerificationStatus = verdict === "clear" ? "verified" : verdict === "flag" ? "flagged" : "pending";

  return { verificationResult, verificationStatus };
}

/** Run verification for a normalized candidate (manual / application-based) and
 *  persist the result. Writes the full agent output + status onto the candidate
 *  row (surfaced on the kanban card) and upserts the verification_records row
 *  (surfaced in the verification panel / used for dup detection). Best-effort:
 *  resolves to the result even if a non-fatal write fails. */
export async function runCandidateVerification(args: { candidateId: string; tenantId: string }): Promise<VerificationAgentOutput | null> {
  const { candidateId, tenantId } = args;

  const [c] = await db.select().from(candidatesTable).where(eq(candidatesTable.id, candidateId)).limit(1);
  if (!c) {
    logger.warn({ candidateId }, "[verification] candidate not found — skipping");
    return null;
  }
  /* Authorize the verification run. The candidate must be reachable from the
     triggering tenant. Besides an exact tenant match, this covers two legitimate
     cross-tenant cases that the strict equality check used to wrongly reject:
       1. Platform-pool candidates (pool="platform") are shared across tenants,
          so any tenant that placed them in a job pipeline may verify them.
       2. Parent↔child org hierarchies — the candidate's tenant and the
          triggering tenant may belong to the same subtree (in either
          direction), e.g. a parent-owned candidate sourced into a child's job.
     Without this, a candidate owned by another part of the org would silently
     land in Verify with no verdict ("No identity verification yet"). */
  let authorized = c.tenantId === tenantId || (c as any).pool === "platform";
  if (!authorized && c.tenantId) {
    const [triggerSubtree, candidateSubtree] = await Promise.all([
      getSubtreeTenantIds(tenantId),
      getSubtreeTenantIds(c.tenantId),
    ]);
    authorized = candidateSubtree.includes(tenantId) || triggerSubtree.includes(c.tenantId);
  }
  if (!authorized) {
    logger.warn({ candidateId, tenantId, candidateTenant: c.tenantId }, "[verification] tenant not authorized — skipping");
    return null;
  }

  /* Debounce: the stage-transition trigger is read-before-write and
   * fire-and-forget, so a duplicate/rapid stage advance could otherwise kick
   * off two concurrent AI runs. Skip if this candidate was verified in the
   * last few seconds and return the existing verdict instead. */
  const [recent] = await db.select({ updatedAt: verificationRecordsTable.updatedAt, status: verificationRecordsTable.status })
    .from(verificationRecordsTable)
    .where(eq(verificationRecordsTable.candidateId, candidateId))
    .limit(1);
  if (recent?.updatedAt && Date.now() - new Date(recent.updatedAt).getTime() < 15_000) {
    logger.info({ candidateId }, "[verification] recently verified — skipping duplicate run");
    return { verificationResult: (c as any).verificationResult ?? null, verificationStatus: (recent.status as VerificationStatus) ?? "pending" };
  }

  const ctx: VerificationAgentContext = {
    name: `${c.firstName || ""} ${c.lastName || ""}`.trim(),
    email: c.email || null,
    phone: c.phone || null,
    linkedinUrl: c.linkedinUrl || null,
    currentTitle: c.currentTitle || "",
    currentCompany: c.currentCompany || "",
    location: c.location || "",
    skills: c.skills || [],
    source: c.source || null,
  };

  const { verificationResult, verificationStatus } = await runVerificationAgent(ctx);

  await db.update(candidatesTable).set({
    verificationStatus: verificationStatus as any,
    verificationResult,
    updatedAt: new Date(),
  }).where(eq(candidatesTable.id, candidateId)).catch(err => logger.warn({ err, candidateId }, "[verification] failed to write candidate row (non-fatal)"));

  // Upsert the verification_records row so the verification panel + duplicate
  // detection stay consistent with the kanban verdict.
  const riskFlags: string[] = Array.isArray(verificationResult?.riskFlags) ? verificationResult.riskFlags : [];
  const overallScore: number = typeof verificationResult?.overallScore === "number" ? verificationResult.overallScore : 0;
  const recordValues = {
    /* verification_records is one row per candidate (onConflict target =
       candidateId), so its tenant must be the candidate's canonical owner —
       NOT the triggering job/application tenant. Using the trigger tenant would
       let the row's tenant_id "flip" each time a different authorized tenant
       (e.g. a parent vs a child sharing a platform-pool candidate) re-runs
       verification, mis-scoping the row over time. */
    tenantId: c.tenantId,
    candidateId,
    status: verificationStatus,
    // riskScore is "higher = more risk"; overallScore is "higher = better", so invert.
    riskScore: Math.max(0, Math.min(100, 100 - overallScore)),
    flags: riskFlags,
    identityVerified: verificationResult?.linkedinMatch === "verified",
    duplicateDetected: riskFlags.some(f => /duplicate/i.test(f)),
    resumeConsistencyScore: typeof verificationResult?.profileCompleteness === "number" ? verificationResult.profileCompleteness : null,
    reviewNotes: typeof verificationResult?.notes === "string" ? verificationResult.notes : null,
    updatedAt: new Date(),
  };

  await db.insert(verificationRecordsTable)
    .values(recordValues as any)
    .onConflictDoUpdate({ target: verificationRecordsTable.candidateId, set: recordValues as any })
    .catch(err => logger.warn({ err, candidateId }, "[verification] failed to upsert verification_records (non-fatal)"));

  logger.info({ candidateId, verificationStatus }, "[verification] candidate verification complete");
  return { verificationResult, verificationStatus };
}
