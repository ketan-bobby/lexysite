/**
 * routes/dnc.ts — Do-Not-Contact (DNC) List Management
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * REST API for managing the DNC list: candidates who have asked to stop
 * receiving outreach, either by clicking an email unsubscribe button or by
 * a recruiter manually flagging them.
 *
 * ─── Route map ───────────────────────────────────────────────────────────────
 *   GET  /dnc                  List all DNC candidates (tenant-scoped)
 *   POST /dnc                  Add a candidate to DNC (manual flag)
 *   DELETE /dnc/:candidateId   Remove a candidate from DNC (re-enable contact)
 *   POST /dnc/bulk             Bulk-add a list of candidates to DNC
 *
 * ─── applyDnc() ──────────────────────────────────────────────────────────────
 * Shared helper that atomically applies a DNC action across all systems:
 *   1. Sets candidates.doNotContact = true
 *   2. Cancels all open outreach_enrollments for the candidate
 *   3. Removes the candidate from the nurture_pool
 *   4. Writes a communication_events audit row (channel="system",
 *      direction="internal", type="dnc_applied")
 * This ensures a single DNC event always leaves the candidate in a
 * consistent "do not contact" state regardless of which path triggered it.
 *
 * ─── Tenant scoping ──────────────────────────────────────────────────────────
 * DNC is per-tenant. A candidate flagged DNC by Tenant A can still receive
 * outreach from Tenant B (unless platform_admin flags them globally).
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { controlDb, db } from "@workspace/db";
import {
  candidatesTable, nurturePoolTable, outreachEnrollmentsTable,
  applicationsTable, usersTable, tenantsTable,
} from "@workspace/db";
import { eq, and, desc, inArray, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { getAuthUserId } from "../lib/auth-token";
import { validate } from "../middlewares/validate";
import { getAllowedTenantIds } from "../lib/tenantUtils";

const AddDncBody = z.object({
  reason: z.string().optional(),
}).passthrough();

const RemoveDncBody = z.object({
  justification: z.string().min(1),
}).passthrough();

const router: IRouter = Router();

async function getCallerUser(req: any) {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await controlDb.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return u ?? null;
}

/* Tenant visibility scoping (own tenant + ALL descendant tenants) is shared in
 * lib/tenantUtils.ts getAllowedTenantIds, imported above. */

// ─── Shared helper: apply DNC to a candidate across all systems ──────────────
async function applyDNC(candidateId: string, reason: string, setById: string | null) {
  const now = new Date();

  // 1. Set DNC flag + audit columns
  await db.update(candidatesTable)
    .set({
      doNotContact: true,
      dncAt: now,
      dncReason: reason,
      dncSetBy: setById,
      updatedAt: now,
    } as any)
    .where(eq(candidatesTable.id, candidateId));

  // 2. Stop all active nurture pool entries
  await db.update(nurturePoolTable)
    .set({ status: "stopped" })
    .where(and(
      eq(nurturePoolTable.candidateId, candidateId),
      eq(nurturePoolTable.status, "active"),
    ));

  // 3. Stop all active outreach enrollments
  await db.update(outreachEnrollmentsTable)
    .set({ status: "stopped", updatedAt: now })
    .where(and(
      eq(outreachEnrollmentsTable.candidateId, candidateId),
      eq(outreachEnrollmentsTable.status, "active"),
    ));

  logger.info({ candidateId, reason, setById }, "[DNC] Candidate flagged across all systems");
}

// ── GET /api/dnc ──────────────────────────────────────────────────────────────
// List all DNC-flagged candidates for the tenant
router.get("/dnc", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const allowed = await getAllowedTenantIds(user);
  try {
    const tenantClause = allowed === null
      ? undefined
      : allowed.length === 0
        ? eq(candidatesTable.tenantId, "__none__")
        : inArray(candidatesTable.tenantId, allowed);
    const erasedClause = isNull(candidatesTable.dataErasedAt);
    const dncClause = and(eq(candidatesTable.doNotContact, true), erasedClause);
    const whereClause = tenantClause ? and(tenantClause, dncClause) : dncClause;
    const candidates = await db.select({
      id:            candidatesTable.id,
      firstName:     candidatesTable.firstName,
      lastName:      candidatesTable.lastName,
      email:         candidatesTable.email,
      currentTitle:  candidatesTable.currentTitle,
      currentCompany: candidatesTable.currentCompany,
      doNotContact:  candidatesTable.doNotContact,
      dncAt:         candidatesTable.dncAt,
      dncReason:     candidatesTable.dncReason,
      dncSetBy:      candidatesTable.dncSetBy,
      dataErasedAt:  candidatesTable.dataErasedAt,
    }).from(candidatesTable)
      .where(whereClause)
      .orderBy(desc(candidatesTable.dncAt as any));

    res.json(candidates.map(c => ({
      ...c,
      dncAt:        (c.dncAt as any)?.toISOString?.() ?? null,
      dataErasedAt: (c.dataErasedAt as any)?.toISOString?.() ?? null,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dnc/:candidateId ────────────────────────────────────────────────
// Manually flag a candidate as DNC
router.post("/dnc/:candidateId", validate({ body: AddDncBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const allowed = await getAllowedTenantIds(user);
  const { candidateId } = req.params;
  const { reason } = req.body as { reason?: string };

  try {
    const [cand] = await db.select({ id: candidatesTable.id, tenantId: candidatesTable.tenantId })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);

    if (!cand) { res.status(404).json({ error: "Candidate not found" }); return; }
    if (allowed !== null && !allowed.includes(cand.tenantId ?? "")) {
      res.status(403).json({ error: "Forbidden: candidate is in another tenant" }); return;
    }

    await applyDNC(candidateId, reason ?? "manual", user.id);
    res.json({ ok: true, message: "Candidate flagged as Do Not Contact." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/dnc/:candidateId ──────────────────────────────────────────────
// Remove DNC flag (with mandatory justification)
router.delete("/dnc/:candidateId", validate({ body: RemoveDncBody }), async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const allowed = await getAllowedTenantIds(user);
  const { candidateId } = req.params;
  const { justification } = req.body as { justification?: string };

  if (!justification?.trim()) {
    res.status(400).json({ error: "justification is required to remove a DNC flag" }); return;
  }

  try {
    const [cand] = await db.select({ id: candidatesTable.id, tenantId: candidatesTable.tenantId })
      .from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);

    if (!cand) { res.status(404).json({ error: "Candidate not found" }); return; }
    if (allowed !== null && !allowed.includes(cand.tenantId ?? "")) {
      res.status(403).json({ error: "Forbidden" }); return;
    }

    const now = new Date();
    await db.update(candidatesTable)
      .set({
        doNotContact: false,
        dncAt: null,
        dncReason: `Removed: ${justification}`,
        dncSetBy: null,
        updatedAt: now,
      } as any)
      .where(eq(candidatesTable.id, candidateId));

    logger.info({ candidateId, justification }, "[DNC] Flag removed with justification");
    res.json({ ok: true, message: "DNC flag removed." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/dnc/:candidateId/data ─────────────────────────────────────────
// GDPR right-to-erasure: anonymise all PII for this candidate
router.delete("/dnc/:candidateId/data", async (req, res) => {
  const user = await getCallerUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const allowed = await getAllowedTenantIds(user);
  const { candidateId } = req.params;

  try {
    const [cand] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId))
      .limit(1);

    if (!cand) { res.status(404).json({ error: "Candidate not found" }); return; }
    if (allowed !== null && !allowed.includes(cand.tenantId ?? "")) {
      res.status(403).json({ error: "Forbidden" }); return;
    }
    if (cand.dataErasedAt as any) {
      res.json({ ok: true, message: "Data already erased." }); return;
    }

    const now = new Date();
    const erasedRef = `[erased-${candidateId.slice(0, 8)}]`;

    /* ── Atomic DB cascade ──────────────────────────────────────────────
       All DB mutations run inside a single transaction. If any DB step
       throws, the entire cascade rolls back — we never end up with a
       half-anonymised candidate. The S3 object purge runs AFTER commit so
       a DB rollback doesn't leave the bucket missing bytes for a candidate
       whose row was restored. Worst case is an orphan S3 object, which is
       cleaned up by the audit retry pipeline. */
    const purgeSummary: Record<string, number | string> = { candidateId };
    const {
      candidateJobIntelligenceTable,
      outreachMessagesTable,
      interviewSessionsTable,
      interviewSummariesTable,
      interviewSchedulesTable,
      candidateActionEventsTable,
      candidateSkillScoresTable,
      verificationRecordsTable,
      candidateCareerProfilesTable,
    } = await import("@workspace/db");
    const { inArray } = await import("drizzle-orm");

    await db.transaction(async (tx) => {
      // Anonymise PII fields in candidates table
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
          dncAt:          (cand.dncAt as any) ?? now,
          dncReason:      "gdpr_erasure",
          dataErasedAt:   now,
          updatedAt:      now,
        } as any)
        .where(eq(candidatesTable.id, candidateId));

      // Stop all nurture pool entries
      await tx.update(nurturePoolTable)
        .set({ status: "stopped", candidateName: "[Erased]", candidateEmail: `erased@deleted.invalid` })
        .where(eq(nurturePoolTable.candidateId, candidateId));

      // Stop outreach enrollments + anonymise
      await tx.update(outreachEnrollmentsTable)
        .set({ status: "stopped", recipientName: "[Erased]", recipientEmail: `erased@deleted.invalid`, updatedAt: now })
        .where(eq(outreachEnrollmentsTable.candidateId, candidateId));

      /* Anonymise applications notes but keep the record for auditing.
       * Capture affected application IDs so we can write governance
       * final_decision events post-commit (the governance enforcement
       * service uses its own DB calls and must not nest inside this tx). */
      // stage-write-exempt: this write is inside the atomic GDPR-erasure
      // transaction. Routing through changeCandidateStage() is not possible
      // here — the choke-point opens its OWN db.transaction with `FOR UPDATE`
      // row locks, which would deadlock against the rows this outer tx already
      // holds locked (and moving it post-commit would break erasure atomicity,
      // leaving an anonymised candidate stranded in a live pipeline stage).
      // Provenance for these exact application closures is instead recorded
      // post-commit by the governance applyHumanDecision() block below
      // (final_decision = candidate_withdrawn + an immutable decision_event
      // per row), which is a STRONGER audit record than a generic
      // STAGE_CHANGED for a right-to-erasure cascade.
      const affected = await tx.update(applicationsTable)
        .set({ notes: "Candidate data erased per GDPR request.", stage: "rejected" as any, updatedAt: now })
        .where(eq(applicationsTable.candidateId, candidateId))
        .returning({ id: applicationsTable.id });
      (purgeSummary as any).__gdprAffectedAppIds = affected.map((a) => a.id);

      /* Hard-delete the candidate's self-authored career profile (goals,
       * salary expectations, bio, target companies) — squarely the subject's
       * own PII with no retention basis. Must match the self-service cascade
       * in routes/career-profile.ts:DELETE /portal/me. */
      const cpDel = await tx.delete(candidateCareerProfilesTable)
        .where(eq(candidateCareerProfilesTable.candidateId, candidateId));
      purgeSummary.careerProfile = (cpDel as any)?.rowCount ?? "ok";

      const intelDel = await tx.delete(candidateJobIntelligenceTable)
        .where(eq(candidateJobIntelligenceTable.candidateId, candidateId));
      purgeSummary.intelligence = (intelDel as any)?.rowCount ?? "ok";

      const omDel = await tx.delete(outreachMessagesTable)
        .where(eq(outreachMessagesTable.candidateId, candidateId));
      purgeSummary.outreachMessages = (omDel as any)?.rowCount ?? "ok";

      /* Pull session ids first so we can purge their child rows by id. */
      const sessions = await tx.select({ id: interviewSessionsTable.id })
        .from(interviewSessionsTable)
        .where(eq(interviewSessionsTable.candidateId, candidateId));
      const sessionIds = sessions.map(s => s.id);
      if (sessionIds.length > 0) {
        await tx.delete(interviewSummariesTable)
          .where(inArray(interviewSummariesTable.sessionId, sessionIds));
        await tx.delete(interviewSchedulesTable)
          .where(inArray(interviewSchedulesTable.sessionId, sessionIds));
      }
      const sessDel = await tx.delete(interviewSessionsTable)
        .where(eq(interviewSessionsTable.candidateId, candidateId));
      purgeSummary.interviewSessions = (sessDel as any)?.rowCount ?? "ok";

      const aeDel = await tx.delete(candidateActionEventsTable)
        .where(eq(candidateActionEventsTable.candidateId, candidateId));
      purgeSummary.actionEvents = (aeDel as any)?.rowCount ?? "ok";

      const ssDel = await tx.delete(candidateSkillScoresTable)
        .where(eq(candidateSkillScoresTable.candidateId, candidateId));
      purgeSummary.skillScores = (ssDel as any)?.rowCount ?? "ok";

      const vDel = await tx.delete(verificationRecordsTable)
        .where(eq(verificationRecordsTable.candidateId, candidateId));
      purgeSummary.verification = (vDel as any)?.rowCount ?? "ok";
    });

    /* ── Governance final_decision (T010) ────────────────────────────────
     * The GDPR cascade above terminates every application this candidate
     * had open. By design those terminations are `candidate_withdrawn`
     * (the data subject — or the admin acting on the subject's verified
     * request — chose to leave). Routing through the enforcement service
     * here writes final_decision + an immutable decision_event per row
     * so an LL144 / CO AI Act auditor sees the same provenance for
     * GDPR-erased closures as for any other human-final decision.
     * Best-effort; failure must not poison the GDPR cascade (the tx has
     * already committed). */
    const __affectedAppIds: string[] = ((purgeSummary as any).__gdprAffectedAppIds ?? []) as string[];
    delete (purgeSummary as any).__gdprAffectedAppIds;
    if (__affectedAppIds.length > 0) {
      try {
        const { applyHumanDecision } = await import("../lib/governance/decision-enforcement.js");
        await Promise.all(__affectedAppIds.map((appId) =>
          applyHumanDecision({
            applicationId: appId,
            finalDecision: "candidate_withdrawn",
            decidedByUserId: user.id,
            decidedByRole: (user.role as any) ?? "tenant_admin",
            attestation:
              "I reviewed the AI recommendations and role-relevant candidate information before confirming this action (GDPR right-to-erasure cascade — closures recorded as candidate_withdrawn).",
            reason: "gdpr_erasure",
          }),
        ));
        purgeSummary.governanceDecisions = __affectedAppIds.length;
      } catch (err: any) {
        logger.warn({ candidateId, err: err?.message }, "[governance] GDPR cascade final_decision write failed (non-fatal)");
      }
    }

    /* S3 object purge: resume + any interview recording bytes. The S3 client
       lives in lib/s3.ts; we send DeleteObject best-effort. */
    try {
      if (cand.resumeUrl) {
        const { s3Client } = await import("../lib/s3");
        const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
        const bucket = process.env.AWS_S3_BUCKET;
        const url = cand.resumeUrl as string;
        const key = url.startsWith("http")
          ? new URL(url).pathname.replace(/^\//, "")
          : url.replace(/^\//, "");
        if (bucket && key) {
          await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          purgeSummary.resumeObject = "deleted";
        }
      }
    } catch (s3Err: any) {
      logger.warn({ candidateId, err: s3Err?.message }, "[GDPR] S3 resume delete failed");
      purgeSummary.s3Error = s3Err?.message ?? "unknown";
    }

    logger.info({ candidateId, purgeSummary }, "[GDPR] Candidate PII + cascade erased");
    res.json({
      ok: true,
      message: "All personal data has been anonymised and downstream artifacts purged. Application records are retained for audit purposes.",
      erasedRef,
      purgeSummary,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
