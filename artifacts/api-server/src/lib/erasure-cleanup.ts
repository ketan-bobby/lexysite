import { createHash, randomUUID } from "node:crypto";
import { controlDb, deletionRequestsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import type { AccountErasureState } from "./candidate-account-erasure";

type Transaction = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };
type Target = {
  id: string;
  kind: "object" | "prefix" | "legacy_resume";
  path: string | null;
  state: "pending" | "done" | "blocked";
  attempts: number;
  error?: string;
  proof?: string;
};
export type CleanupReceipt = {
  version: 1;
  origin: "admin" | "self" | "staff" | "fixture";
  state: "pending" | "running" | "complete" | "needs_review";
  targets: Target[];
  attempts: number;
  databaseErasedAt: string;
  nextAttemptAt: string;
  leaseToken?: string;
  leaseUntil?: string;
  lastFailure?: string;
  confirmation: "pending" | "sending" | "sent" | "uncertain" | "not_requested";
  account?: AccountErasureState;
};
export type CleanupStorage = {
  deleteObjectByPath(path: string): Promise<{ ok: boolean; error?: string }>;
  deleteObjectsUnderPrefix(path: string): Promise<{ deleted: number; error?: string }>;
  deleteLegacyResumeKey?(key: string): Promise<{ ok: boolean; error?: string }>;
};
type Dependencies = {
  storage?: CleanupStorage;
  createStorage?: () => Promise<CleanupStorage>;
  sendConfirmation?: (request: typeof deletionRequestsTable.$inferSelect) => Promise<boolean>;
  now?: () => Date;
};

function target(path: string, candidateId: string): Target {
  let kind: Target["kind"] = path.endsWith("/") ? "prefix" : "object";
  let safe =
    path.startsWith("/objects/") &&
    path.length > 9 &&
    !/[\\?#\x00]/.test(path) &&
    !/%(?:2e|2f|5c)/i.test(path) &&
    !path.split("/").some((part) => part === "." || part === "..");
  if (kind === "prefix") {
    safe =
      path === `/objects/interview-recordings/${candidateId}/` ||
      /^\/objects\/recording-segments\/[0-9a-f-]{36}\/$/i.test(path);
  }
  // Older, server-stored résumés use our bucket's absolute S3 URL. Never
  // interpret an arbitrary remote URL, signed query string or prefix as a key.
  if (!safe && kind === "object" && process.env.AWS_S3_BUCKET) {
    try {
      const url = new URL(path);
      const bucket = process.env.AWS_S3_BUCKET;
      if (
        url.protocol === "https:" &&
        (url.hostname === `${bucket}.s3.amazonaws.com` ||
          new RegExp(
            `^${bucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.s3\\.[a-z0-9-]+\\.amazonaws\\.com$`,
          ).test(url.hostname))
      ) {
        path = decodeURIComponent(url.pathname.slice(1));
        safe = Boolean(path) && !path.split("/").some((part) => part === "." || part === "..");
        kind = "legacy_resume";
      }
    } catch {
      /* Unsupported references require human review, not remote I/O. */
    }
  }
  return {
    id: randomUUID(),
    kind,
    path: safe ? path : null,
    state: safe ? "pending" : "blocked",
    attempts: 0,
    ...(safe
      ? {}
      : { error: "unsupported_reference", proof: createHash("sha256").update(path).digest("hex") }),
  };
}

/** Called inside the already-authorised erasure transaction, BEFORE deleting rows. */
export async function stageErasureCleanup(
  tx: Transaction,
  input: {
    requestId?: string;
    candidateId: string;
    email?: string | null;
    actorId?: string;
    paths: string[];
    origin: CleanupReceipt["origin"];
    notify?: boolean;
  },
) {
  if (!/^[a-z0-9_-]+$/i.test(input.candidateId))
    throw new Error("Unsafe candidate cleanup namespace");
  // Independent snapshots for one subject could miss references removed
  // by an earlier cascade. Recover that receipt instead of replacing it.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.candidateId},0))`);
  const existing = (await tx.execute(sql`SELECT id FROM deletion_requests
    WHERE candidate_id=${input.candidateId} AND status='in_progress' AND storage_cleanup IS NOT NULL
      AND id<>${input.requestId ?? ""} LIMIT 1`)) as { rows: unknown[] };
  if (existing.rows.length)
    throw new Error("Existing file-cleanup receipt must be recovered first");
  const requestId = input.requestId ?? randomUUID();
  const paths = [
    ...new Set([...input.paths, `/objects/interview-recordings/${input.candidateId}/`]),
  ];
  const receipt: CleanupReceipt = {
    version: 1,
    origin: input.origin,
    state: "pending",
    targets: paths.map((path) => target(path, input.candidateId)),
    attempts: 0,
    databaseErasedAt: new Date().toISOString(),
    nextAttemptAt: new Date().toISOString(),
    confirmation: input.notify && input.email ? "pending" : "not_requested",
  };
  const encoded = JSON.stringify(receipt);
  if (input.requestId) {
    const result = (await tx.execute(sql`UPDATE deletion_requests
      SET storage_cleanup=${encoded}::jsonb, status='in_progress', updated_at=now()
      WHERE id=${requestId} AND storage_cleanup IS NULL RETURNING id`)) as { rows: unknown[] };
    if (result.rows.length !== 1)
      throw new Error("Cleanup receipt already exists or request is missing");
  } else {
    await tx.execute(sql`INSERT INTO deletion_requests
      (id,candidate_id,candidate_email_snapshot,jurisdiction,status,handled_by_user_id,handler_notes,storage_cleanup)
      VALUES (${requestId},${input.candidateId},${input.email ?? null},'other','in_progress',
        ${input.actorId ?? null},${`${input.origin} erasure: database complete; file cleanup pending`},${encoded}::jsonb)`);
  }
  return requestId;
}

export function cleanupSummary(value: unknown) {
  const receipt = value as CleanupReceipt | null;
  if (!receipt || receipt.version !== 1) return null;
  return {
    databaseErased: true,
    state: receipt.state,
    attempts: receipt.attempts,
    remaining: receipt.targets.filter((item) => item.state !== "done").length,
    nextAttemptAt: receipt.state === "pending" ? receipt.nextAttemptAt : null,
    lastFailure: receipt.lastFailure ?? null,
    confirmation: receipt.confirmation,
    account: receipt.account ?? null,
  };
}
export function serializeErasureRequest(row: typeof deletionRequestsTable.$inferSelect) {
  const { storageCleanup, ...publicRow } = row;
  return { ...publicRow, cleanup: cleanupSummary(storageCleanup) };
}

/** Caller must first prove owner/staff access to this candidate. */
export async function latestCandidateCleanup(candidateId: string) {
  const [row] = await controlDb
    .select()
    .from(deletionRequestsTable)
    .where(
      and(
        eq(deletionRequestsTable.candidateId, candidateId),
        sql`${deletionRequestsTable.storageCleanup} IS NOT NULL`,
      ),
    )
    .orderBy(desc(deletionRequestsTable.createdAt))
    .limit(1);
  return {
    cleanupRequestId: row?.id ?? null,
    cleanupPending: !row || (row.storageCleanup as CleanupReceipt).state !== "complete",
    cleanup: row ? cleanupSummary(row.storageCleanup) : null,
  };
}

async function defaultStorage(): Promise<CleanupStorage> {
  const { ObjectStorageService } = await import("./objectStorage");
  const storage = new ObjectStorageService();
  return {
    deleteObjectByPath: (path) => storage.deleteObjectByPath(path),
    deleteObjectsUnderPrefix: (path) => storage.deleteObjectsUnderPrefix(path),
    async deleteLegacyResumeKey(key) {
      const { s3Client } = await import("./s3");
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
      const bucket = process.env.AWS_S3_BUCKET;
      if (!bucket) return { ok: false, error: "storage_unconfigured" };
      await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { ok: true };
    },
  };
}

/** Post-commit only. A fenced DB lease protects against workers and manual retries racing. */
export async function processErasureCleanup(requestId: string, deps: Dependencies = {}) {
  const now = deps.now ?? (() => new Date());
  const token = randomUUID();
  const result = (await controlDb.execute(sql`UPDATE deletion_requests
    SET storage_cleanup=storage_cleanup || ${JSON.stringify({
      state: "running",
      leaseToken: token,
      leaseUntil: new Date(now().getTime() + 10 * 60_000).toISOString(),
    })}::jsonb, updated_at=now()
    WHERE id=${requestId} AND status='in_progress' AND storage_cleanup IS NOT NULL
      AND storage_cleanup->>'state' IN ('pending','running','needs_review')
      AND (storage_cleanup->>'leaseUntil' IS NULL OR (storage_cleanup->>'leaseUntil')::timestamptz < ${now()})
    RETURNING *`)) as { rows: Record<string, unknown>[] };
  if (!result.rows.length) {
    const [row] = await controlDb
      .select()
      .from(deletionRequestsTable)
      .where(eq(deletionRequestsTable.id, requestId));
    return {
      cleanupPending: row
        ? (row.storageCleanup as CleanupReceipt | null)?.state !== "complete"
        : true,
      requestId,
      cleanup: row ? cleanupSummary(row.storageCleanup) : null,
    };
  }
  const raw = result.rows[0]!;
  const receipt = raw.storage_cleanup as CleanupReceipt;
  receipt.attempts++;
  const save = async (finish = false) => {
    const rows = (await controlDb.execute(sql`UPDATE deletion_requests
      SET storage_cleanup=${JSON.stringify(receipt)}::jsonb,
        status=${finish ? "fulfilled" : "in_progress"},
        handled_at=CASE WHEN ${finish} THEN now() ELSE handled_at END, updated_at=now()
      WHERE id=${requestId} AND status='in_progress' AND storage_cleanup->>'leaseToken'=${token} RETURNING id`)) as {
      rows: unknown[];
    };
    if (rows.rows.length !== 1) throw new Error("Cleanup lease lost");
  };
  try {
    const storage = receipt.targets.some((item) => item.state === "pending")
      ? (deps.storage ?? (await (deps.createStorage ?? defaultStorage)()))
      : null;
    for (const item of receipt.targets) {
      if (item.state !== "pending" || !item.path || !storage) continue;
      // Extend the lease before each network operation. A stale worker cannot
      // acknowledge work after another owner has acquired the job.
      receipt.leaseUntil = new Date(now().getTime() + 10 * 60_000).toISOString();
      await save();
      item.attempts++;
      try {
        const response =
          item.kind === "prefix"
            ? await storage.deleteObjectsUnderPrefix(item.path.slice("/objects/".length))
            : item.kind === "legacy_resume"
              ? await storage.deleteLegacyResumeKey?.(item.path)
              : await storage.deleteObjectByPath(item.path);
        if (!response || ("ok" in response ? !response.ok : Boolean(response.error))) {
          item.error = "storage_operation_failed";
        } else {
          item.state = "done";
          item.proof = createHash("sha256").update(item.path).digest("hex");
          item.path = null; // Do not retain filenames once cleanup has succeeded.
          delete item.error;
        }
      } catch {
        item.error = "storage_operation_failed";
      }
      await save();
    }
  } catch {
    // Constructor failures are retryable too. Lease loss is safe: subsequent
    // writes below are fenced, and the next worker repeats idempotent deletes.
    receipt.lastFailure = "storage_client_unavailable";
    logger.warn({ requestId }, "[erasure-cleanup] storage unavailable or lease lost");
  }
  const unfinished = receipt.targets.filter((item) => item.state !== "done");
  if (unfinished.length) {
    receipt.state = unfinished.some((item) => item.state === "blocked")
      ? "needs_review"
      : "pending";
    receipt.lastFailure ??= unfinished.some((item) => item.error)
      ? "storage_operation_failed"
      : "cleanup_incomplete";
    receipt.nextAttemptAt = new Date(
      now().getTime() + Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.min(receipt.attempts - 1, 12)),
    ).toISOString();
    receipt.leaseUntil = new Date(0).toISOString();
    await save();
  } else {
    receipt.state = "complete";
    delete receipt.lastFailure;
    if (receipt.confirmation === "sending") {
      // The previous owner may have sent mail before crashing. Never resend
      // automatically: SES does not provide an exactly-once delivery contract.
      receipt.confirmation = "uncertain";
    } else if (receipt.confirmation === "pending") {
      receipt.confirmation = "sending";
      receipt.state = "running"; // Recoverable if the process crashes during notification.
      await save(); // Durable at-most-once dispatch claim, BEFORE external I/O.
      try {
        const [request] = await controlDb
          .select()
          .from(deletionRequestsTable)
          .where(eq(deletionRequestsTable.id, requestId));
        const send =
          deps.sendConfirmation ??
          (async (row) => {
            const { sendDeletionFulfilledConfirmationToCandidate } =
              await import("./deletion-emails");
            return sendDeletionFulfilledConfirmationToCandidate({
              requestId: row.id,
              candidateEmailSnapshot: row.candidateEmailSnapshot,
              jurisdiction: row.jurisdiction,
              fulfilledAt: now(),
            });
          });
        receipt.confirmation = request && (await send(request)) ? "sent" : "uncertain";
      } catch {
        receipt.confirmation = "uncertain";
      }
    }
    receipt.state = "complete";
    receipt.leaseUntil = new Date(0).toISOString();
    await save(true);
  }
  return {
    requestId,
    cleanupPending: receipt.state !== "complete",
    cleanup: cleanupSummary(receipt),
  };
}

let ticking = false;
export async function runErasureCleanupTick() {
  if (ticking) return;
  ticking = true;
  try {
    const result = (await controlDb.execute(sql`SELECT id FROM deletion_requests
      WHERE status='in_progress' AND storage_cleanup->>'origin' IN ('admin','self','staff')
        AND (storage_cleanup->>'state' IN ('pending','running') OR
          (storage_cleanup->>'state'='needs_review' AND storage_cleanup->'targets' @> '[{"state":"pending"}]'::jsonb))
        AND (storage_cleanup->>'nextAttemptAt')::timestamptz <= now()
        AND (storage_cleanup->>'leaseUntil' IS NULL OR (storage_cleanup->>'leaseUntil')::timestamptz < now())
      ORDER BY created_at LIMIT 5`)) as { rows: { id: string }[] };
    for (const row of result.rows) await processErasureCleanup(row.id);
  } catch {
    logger.error("[erasure-cleanup] retry tick failed; receipts remain durable");
  } finally {
    ticking = false;
  }
}
export function startErasureCleanupScheduler() {
  const timer = setInterval(() => void runErasureCleanupTick(), 60_000);
  timer.unref();
  logger.info("[erasure-cleanup] retry scheduler started");
}
