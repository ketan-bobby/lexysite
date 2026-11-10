/**
 * routes/admin-deletion.ts — Right-to-Erasure Admin Fulfilment
 *
 * Platform_admin endpoints for reviewing and fulfilling candidate
 * deletion requests submitted via POST /portal/candidate/deletion-request.
 *
 * Runbook: docs/RUNBOOK_DATA_DELETION.md.
 *
 * ─── Fulfilment design ─────────────────────────────────────────────────────
 * The legacy schema does NOT have ON DELETE CASCADE foreign keys from
 * candidate-linked tables back to `candidates`. (Verified by querying
 * information_schema.referential_constraints — zero FKs reference
 * candidates.) A raw `DELETE FROM candidates` would silently leave
 * orphan PII in 38+ child tables.
 *
 * Adding cascades retroactively is risky (would alter the behaviour of
 * every existing flow). Instead we perform an explicit transactional
 * cascade: enumerate every table with a `candidate_id` column and
 * issue an explicit DELETE inside a single transaction. If any
 * statement fails the entire fulfilment aborts and the request remains
 * `in_progress`, so the operator sees a clear failure and can retry.
 *
 * IMPORTANT — keep CANDIDATE_LINKED_TABLES in sync:
 *   scripts/check-deletion-cascade-drift.mjs queries information_schema
 *   for every public.* table with a `candidate_id` column and refuses
 *   to pass if the on-disk list below diverges. Run it in CI.
 *
 * ─── Object-storage cleanup ────────────────────────────────────────────────
 * Resume PDFs and interview recordings live in S3, not Postgres. The
 * fulfilment first SELECTs all file references the candidate owns
 * (candidates.resume_url, candidate_career_profiles.recording_url,
 * interview_sessions.recording_url, recruiter_inbox_items.attachments)
 * BEFORE the tx commits — those rows are about to be deleted. After
 * the tx commits successfully we issue best-effort deletes against S3
 * for each collected path, plus a catch-all prefix sweep of
 * `interview-recordings/<candidateId>/` to remove abandoned chunks that
 * never landed in a DB row. Storage delete failures are recorded into
 * the audit row's `objectStorage` metadata but do NOT undo the DB
 * deletion (the regulator's primary concern is the DB; orphan blobs
 * are recoverable from S3 ops).
 *
 * Endpoints
 *   GET    /admin/deletion-requests                       list (filterable by status)
 *   POST   /admin/deletion-requests/:id/fulfil            transactional cascade + storage sweep + audit
 *   POST   /admin/deletion-requests/:id/deny              mark denied with notes
 */
import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { db, deletionRequestsTable, candidatesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { and, desc, eq } from "drizzle-orm";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { validate } from "../middlewares/validate";
import { recordAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { stageErasureCleanup, processErasureCleanup, serializeErasureRequest } from "../lib/erasure-cleanup";
import { CANDIDATE_LINKED_TABLES, purgeCandidateLinkedData, collectCandidateRecordingPaths } from "../lib/candidate-erasure";
export { CANDIDATE_LINKED_TABLES } from "../lib/candidate-erasure";

const router: IRouter = Router();

/* The shared inventory deletes indirect/FK children before their parents.
 * The candidates row is removed last. Immutable decision and financial
 * history has an explicit, separately documented retention basis. */

/* Helper: gather every /objects/... path the candidate owns BEFORE we
 * delete the rows that contain them. We must read first because once
 * the cascade commits, the only way to find the resume URL would be
 * the (deliberately retained) audit log — which we don't want to grep
 * for storage cleanup. */
/* Accepts the active transaction so SELECTs run on the same connection /
 * snapshot as the cascade DELETEs. Calling with global `db` would defeat
 * the in-tx race protection — every query MUST go through `tx`. */
async function collectCandidateObjectPaths(
  tx: { execute: <T>(q: any) => Promise<{ rows: T[] }> },
  candidateId: string,
): Promise<string[]> {
  const paths = new Set<string>();
  const push = (p: unknown) => {
    if (typeof p === "string" && p.startsWith("/objects/")) paths.add(p);
  };
  const resumes = await tx.execute<{ resume_url: string | null }>(
    sql`SELECT resume_url FROM candidates WHERE id = ${candidateId}`,
  );
  for (const r of resumes.rows ?? []) push((r as any).resume_url);

  const profileRecs = await tx.execute<{ recording_url: string | null }>(
    sql`SELECT recording_url FROM candidate_career_profiles WHERE candidate_id = ${candidateId}`,
  );
  for (const r of profileRecs.rows ?? []) push((r as any).recording_url);

  const sessionRecs = await tx.execute<{ id: string; recording_url: string | null }>(
    sql`SELECT id, recording_url FROM interview_sessions WHERE candidate_id = ${candidateId}`,
  );
  for (const r of sessionRecs.rows ?? []) {
    push((r as any).recording_url);
    if (/^[0-9a-f-]{36}$/i.test(r.id)) push(`/objects/recording-segments/${r.id}/`);
  }

  /* recruiter_inbox_items.attachments is jsonb — could be string[] or
   * [{url}]. Be defensive: extract any string that looks like an
   * /objects/ path. */
  const inbox = await tx.execute<{ attachments: any }>(
    sql`SELECT attachments FROM recruiter_inbox_items WHERE candidate_id = ${candidateId}`,
  );
  for (const r of inbox.rows ?? []) {
    const att = (r as any).attachments;
    if (Array.isArray(att)) for (const item of att) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") push(item.url ?? item.objectPath ?? item.path);
    }
  }
  return [...paths];
}

/* GDPR Art. 12(3) — erasure requests must be fulfilled "without undue
 * delay and in any event within one month". Configurable in case a
 * jurisdiction demands a tighter clock. */
const ERASURE_SLA_DAYS = Number(process.env.ERASURE_SLA_DAYS ?? "30");
const ERASURE_WARNING_HOURS = 72;

function erasureSlaStatus(createdAt: Date, status: string): { slaDueAt: string; slaStatus: string } {
  const dueAt = new Date(createdAt.getTime() + ERASURE_SLA_DAYS * 24 * 60 * 60 * 1000);
  const terminal = status === "fulfilled" || status === "denied";
  const now = Date.now();
  const slaStatus = terminal
    ? "resolved"
    : dueAt.getTime() < now
      ? "breached"
      : dueAt.getTime() - now < ERASURE_WARNING_HOURS * 60 * 60 * 1000
        ? "warning"
        : "on_track";
  return { slaDueAt: dueAt.toISOString(), slaStatus };
}

router.get(
  "/admin/deletion-requests",
  resolveUser,
  requireRole("platform_admin"),
  async (req: any, res) => {
    const status = (req.query.status as string) || null;
    const conds = status ? [eq(deletionRequestsTable.status, status)] : [];
    const rows = await db.select().from(deletionRequestsTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(deletionRequestsTable.createdAt))
      .limit(200);
    res.json({
      data: rows.map((r) => ({ ...serializeErasureRequest(r), ...erasureSlaStatus(r.createdAt, r.status) })),
      slaDays: ERASURE_SLA_DAYS,
    });
  },
);

const HandlerNotes         = z.object({ handlerNotes: z.string().max(2000).optional() }).strict();
const HandlerNotesRequired = z.object({ handlerNotes: z.string().min(1).max(2000) }).strict();

router.post(
  "/admin/deletion-requests/:id/retry-cleanup",
  resolveUser,
  requireRole("platform_admin"),
  validate({ body: z.object({}).strict() }),
  async (req: any, res) => {
    const [request] = await db.select().from(deletionRequestsTable)
      .where(eq(deletionRequestsTable.id, req.params.id)).limit(1);
    if (!request) { res.status(404).json({ error: "Not found" }); return; }
    if (!request.storageCleanup) {
      res.status(409).json({ error: "No durable file receipt. Historical requests require manual review." }); return;
    }
    try {
      const result = await processErasureCleanup(request.id);
      res.json(result);
    } catch {
      res.status(503).json({ error: "Cleanup remains queued. Refresh the request to check its progress." });
    }
  },
);

router.post(
  "/admin/deletion-requests/:id/fulfil",
  resolveUser,
  requireRole("platform_admin"),
  validate({ body: HandlerNotes }),
  async (req: any, res) => {
    const user = req.resolvedUser!;
    const [request] = await db.select().from(deletionRequestsTable)
      .where(eq(deletionRequestsTable.id, req.params.id)).limit(1);
    if (!request) { res.status(404).json({ error: "Not found" }); return; }
    if (request.status === "fulfilled") { res.status(409).json({ error: "Already fulfilled" }); return; }

    /* Phase 1 — atomic single-owner claim. Two admins clicking Fulfil
     * concurrently must not both proceed; only a `pending` row may be
     * claimed. If status is `in_progress` (another admin holds the claim, OR
     * a prior run crashed mid-way) we return 409 with a clear hint — the
     * operator must investigate before retrying. This trades easy retry for
     * guaranteed at-most-one execution, which is the right trade for a
     * destructive irreversible action. To recover a stuck `in_progress`
     * row, the runbook (RUNBOOK_DATA_DELETION.md) directs the operator to
     * verify what was actually deleted, then UPDATE the row back to
     * `pending` via the DB before retrying. */
    const claim = await db.update(deletionRequestsTable).set({
      status: "in_progress",
      handledByUserId: user.id,
      updatedAt: new Date(),
    }).where(and(
      eq(deletionRequestsTable.id, request.id),
      eq(deletionRequestsTable.status, "pending"),
    )).returning({ id: deletionRequestsTable.id });
    if (claim.length === 0) {
      /* Re-read to give a precise error message — was it already done, or claimed? */
      const [latest] = await db.select({ status: deletionRequestsTable.status })
        .from(deletionRequestsTable).where(eq(deletionRequestsTable.id, request.id)).limit(1);
      res.status(409).json({
        error: "request_not_claimable",
        currentStatus: latest?.status ?? "unknown",
        message: latest?.status === "in_progress"
          ? "Request is already in_progress (another admin is fulfilling, or a prior run failed). See runbook before retrying."
          : `Request status is ${latest?.status ?? "unknown"} — cannot fulfil.`,
      });
      return;
    }

    /* Phase 2 — atomic snapshot + cascade in ONE transaction. Snapshotting
     * inside the tx eliminates the race where a concurrent upload writes a
     * new object reference between an external snapshot and the cascade
     * commit. SELECT ... FOR UPDATE on the candidate row serialises against
     * any handler that locks the candidate before writing a new file ref.
     *
     * Residual risk: an upload flow that obtained a presigned URL BEFORE
     * this tx began and PUTs to S3 AFTER the tx commits will leave an
     * orphan blob (no DB row references it, no candidateId-keyed prefix
     * catches it if it's under /uploads/<uuid>). This is documented in
     * RUNBOOK_DATA_DELETION.md and surfaced in the audit metadata via
     * `snapshotMethod: "in-tx"` so the auditor can see the basis. */
    let objectPaths: string[] = [];
    try {
      await db.transaction(async (tx) => {
        /* Row-lock the candidate first. Concurrent writers that take this
         * lock before inserting a file ref will block here. */
        await tx.execute(sql`SELECT 1 FROM candidates WHERE id = ${request.candidateId} FOR UPDATE`);
        objectPaths = [...new Set([
          ...await collectCandidateObjectPaths(tx as any, request.candidateId),
          ...await collectCandidateRecordingPaths(tx, request.candidateId),
        ])];
        await stageErasureCleanup(tx, {
          requestId: request.id, candidateId: request.candidateId, paths: objectPaths,
          origin: "admin", email: request.candidateEmailSnapshot, notify: true,
        });
        await purgeCandidateLinkedData(tx, request.candidateId);
        await tx.execute(
          sql`DELETE FROM candidates WHERE id = ${request.candidateId}`,
        );
        await tx.update(deletionRequestsTable).set({
          status: "in_progress",
          handledByUserId: user.id,
          handlerNotes: req.body.handlerNotes ?? null,
          updatedAt: new Date(),
        }).where(eq(deletionRequestsTable.id, request.id));
      });
    } catch (err: any) {
      logger.error({
        err: err?.message, stack: err?.stack,
        candidateId: request.candidateId, requestId: request.id,
      }, "[admin-deletion] cascade transaction failed; request remains in_progress");
      res.status(500).json({
        error: "deletion_failed",
        message: err?.message ?? "unknown",
        hint: "Request status is in_progress. Investigate and retry — partial deletions did not commit.",
      });
      return;
    }

    /* The receipt committed atomically with the DB cascade. A crash here
     * leaves a recoverable job; neither references nor progress are lost. */
    let cleanup: Awaited<ReturnType<typeof processErasureCleanup>>;
    try { cleanup = await processErasureCleanup(request.id); }
    catch {
      logger.warn({ requestId: request.id }, "[admin-deletion] cleanup deferred to durable retry");
      cleanup = { requestId: request.id, cleanupPending: true, cleanup: null };
    }

    /* Phase 4: audit row, written OUTSIDE the transaction so a
     * rolled-back cascade cannot leave a misleading "fulfilled" entry.
     * audit_logs intentionally retains the candidateId (tombstoned via
     * subjectLabel) under the legal-claims retention basis. */
    void recordAudit({
      tenantId: null,
      actorType: "user",
      actorId: user.id,
      actorLabel: user.email ?? null,
      subjectType: "candidate",
      subjectId: request.candidateId,
      subjectLabel: "deleted-candidate",
      channel: "system",
      direction: "internal",
      action: "candidate.database_erased",
      title: `Candidate database erased (${request.jurisdiction}); file cleanup tracked separately`,
      body: req.body.handlerNotes ?? null,
      metadata: {
        requestId: request.id,
        jurisdiction: request.jurisdiction,
        emailSnapshot: request.candidateEmailSnapshot,
        tablesCascaded: CANDIDATE_LINKED_TABLES.length,
        objectStorage: {
          snapshotMethod: "in-tx",
          snapshotError: null,
          enumerated: objectPaths.length,
          cleanup: cleanup.cleanup,
          residualRiskNote: "Presigned URLs minted before tx-start and PUT after tx-commit may leak under /uploads/<uuid>/. See docs/RUNBOOK_DATA_DELETION.md.",
        },
      },
    });

    const cleanupPending = cleanup.cleanupPending;

    logger.info({
      actor: user.id, candidateId: request.candidateId, requestId: request.id,
      jurisdiction: request.jurisdiction, tables: CANDIDATE_LINKED_TABLES.length,
      storage: { enumerated: objectPaths.length, cleanupPending },
    }, "[admin-deletion] database erased");

    const [updated] = await db.select().from(deletionRequestsTable)
      .where(eq(deletionRequestsTable.id, request.id)).limit(1);
    res.json({ data: serializeErasureRequest(updated), cleanupPending });
  },
);

router.post(
  "/admin/deletion-requests/:id/deny",
  resolveUser,
  requireRole("platform_admin"),
  validate({ body: HandlerNotesRequired }),
  async (req: any, res) => {
    const user = req.resolvedUser!;
    const [updated] = await db.update(deletionRequestsTable).set({
      status: "denied",
      handledByUserId: user.id,
      handledAt: new Date(),
      handlerNotes: req.body.handlerNotes,
      updatedAt: new Date(),
    }).where(and(
      eq(deletionRequestsTable.id, req.params.id),
      eq(deletionRequestsTable.status, "pending"),
      sql`${deletionRequestsTable.storageCleanup} IS NULL`,
    )).returning();
    if (!updated) { res.status(404).json({ error: "Not found" }); return; }
    void recordAudit({
      tenantId: null,
      actorType: "user",
      actorId: user.id,
      subjectType: "candidate",
      subjectId: updated.candidateId,
      channel: "system",
      direction: "internal",
      action: "candidate.deletion_denied",
      body: req.body.handlerNotes,
      metadata: { requestId: updated.id, jurisdiction: updated.jurisdiction },
    });
    res.json({ data: updated });
  },
);

/* Silence the linter — candidatesTable is imported for type-completeness
 * (the cascade uses raw sql.identifier) but not directly referenced. */
void candidatesTable;

export default router;
