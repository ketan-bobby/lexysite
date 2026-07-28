/**
 * lib/http-access-log.ts — Durable HTTP Access-Log Sink
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * The api-server mounts `pino-http` (see app.ts) which emits one structured
 * access-log line per request to stdout. The hosting platform offers no
 * genuine log drain, so this module ALSO persists each completed request to
 * the `http_access_logs` Postgres table — the durable, SQL-queryable copy that
 * outlives whatever happens to the stdout stream.
 *
 * ─── Public API ──────────────────────────────────────────────────────────────
 *   httpAccessLogMiddleware   Express middleware. Attaches a one-shot response
 *                             `finish` listener and fire-and-forget inserts one
 *                             row. NEVER throws / never fails the request.
 *   buildAccessLogRow         Pure req/res → row mapper (unit-testable).
 *   pruneHttpAccessLogs       Batched delete of rows older than N days.
 *
 * ─── What is captured (and what is NOT) ──────────────────────────────────────
 * Captured: method, the REGISTERED route pattern (`req.baseUrl + req.route.path`,
 * e.g. `/api/jobs/:id`), status code, response time (ms), client ip, resolved
 * userId/tenantId (null when unauth / unresolved), and the pino requestId.
 * For requests that never matched a route (404s, a 401 short-circuited in
 * app-level middleware such as withTenantContext), `routePattern` is left NULL
 * — we deliberately never derive it from the raw URL, because arbitrary path
 * segments can carry ids/PII (emails, tokens, names) that no redaction pass can
 * reliably strip. The status code + method still give useful ops signal.
 * Deliberately EXCLUDED: request bodies, tokens, auth headers, query strings,
 * and the raw request URL/path.
 *
 * ─── Why dbAdmin and never `db` ──────────────────────────────────────────────
 * Access logging must work for every request, including unauthenticated /
 * fail-closed ones where the RLS Proxy `db` throws. http_access_logs is a
 * platform-ops table (not RLS-protected); writes go through dbAdmin (BYPASSRLS).
 *
 * ─── Never throw ─────────────────────────────────────────────────────────────
 * A log-write failure is swallowed and logged at warn level. Crashing (or
 * delaying) a request because access logging failed would be unacceptable.
 */
import type { Request, Response, NextFunction } from "express";
import { dbAdmin, httpAccessLogsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

export interface AccessLogRow {
  method: string;
  routePattern: string | null;
  statusCode: number;
  responseTimeMs: number | null;
  ip: string | null;
  userId: string | null;
  tenantId: string | null;
  requestId: string | null;
}

/**
 * Pure mapper: build the row to persist from the finished request/response.
 * Kept side-effect-free so it can be unit-tested without a DB or a live server.
 */
export function buildAccessLogRow(req: Request, res: Response, responseTimeMs: number | null): AccessLogRow {
  const anyReq = req as any;
  // Only ever persist the REGISTERED route pattern (has `:param` placeholders,
  // no ids). `req.route` is set once a route handler matched. For requests that
  // never matched a route (404s, or a 401 short-circuited in app-level
  // middleware like withTenantContext) we store null — we never derive the
  // pattern from the raw URL/path, since arbitrary segments can carry ids/PII
  // (emails, tokens, names) and no redaction pass strips those reliably.
  const routePattern =
    anyReq.route?.path != null ? `${req.baseUrl ?? ""}${anyReq.route.path}` || "/" : null;

  const resolved = anyReq.resolvedUser;
  return {
    method: req.method,
    routePattern: routePattern || null,
    statusCode: res.statusCode,
    responseTimeMs: responseTimeMs == null ? null : Math.round(responseTimeMs),
    ip: req.ip ?? null,
    userId: resolved?.id ?? null,
    tenantId: resolved?.tenantId ?? null,
    requestId: anyReq.id != null ? String(anyReq.id) : null,
  };
}

async function persist(row: AccessLogRow): Promise<void> {
  try {
    await dbAdmin.insert(httpAccessLogsTable).values(row);
  } catch (err) {
    // Never throw from the access-log sink — that would be a crash loop.
    logger.warn(
      { err: (err as Error)?.message, route: row.routePattern, status: row.statusCode },
      "[http-access-log] failed to persist access-log row",
    );
  }
}

/**
 * Express middleware. Mount it directly after pino-http so it observes the same
 * request lifecycle. It records the start time, then on response `finish`
 * (once, guaranteed) fire-and-forget persists one row. The request is never
 * blocked on, or failed by, the DB write.
 */
export function httpAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  let recorded = false;
  const onFinish = () => {
    if (recorded) return;
    recorded = true;
    let ms: number | null = null;
    try {
      ms = Number(process.hrtime.bigint() - start) / 1e6;
    } catch {
      ms = null;
    }
    let row: AccessLogRow | null = null;
    try {
      row = buildAccessLogRow(req, res, ms);
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, "[http-access-log] failed to build access-log row");
      return;
    }
    // Fire-and-forget: do not await, and never let a rejection escape.
    void persist(row);
  };
  res.on("finish", onFinish);
  next();
}

export interface HttpAccessLogPruneResult {
  deleted: number;
  batches: number;
  moreRemaining: boolean;
  error?: string;
}

/**
 * Delete http_access_logs rows older than `retentionDays`, in batches so a
 * large backlog never locks the table. Best-effort: returns {error} rather
 * than throwing. Mirrors prunePipelineRunEvents.
 */
export async function pruneHttpAccessLogs(opts: {
  retentionDays: number;
  batchSize?: number;
  maxBatches?: number;
}): Promise<HttpAccessLogPruneResult> {
  const retentionDays = opts.retentionDays;
  const batchSize = opts.batchSize ?? 5_000;
  const maxBatches = opts.maxBatches ?? 100;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000);

  let deleted = 0;
  let batches = 0;
  let moreRemaining = false;

  try {
    for (let i = 0; i < maxBatches; i++) {
      const res: any = await dbAdmin.execute(sql`
        WITH doomed AS (
          SELECT id FROM http_access_logs
           WHERE occurred_at < ${cutoff}
           LIMIT ${batchSize}
        )
        DELETE FROM http_access_logs e
         USING doomed d
         WHERE e.id = d.id
      `);
      const n = (res?.rowCount ?? res?.count ?? (Array.isArray(res) ? res.length : 0)) as number;
      deleted += n;
      batches += 1;
      if (n < batchSize) break;
      if (i === maxBatches - 1) moreRemaining = true;
    }
    return { deleted, batches, moreRemaining };
  } catch (err: any) {
    logger.warn({ err: err?.message, retentionDays }, "[http-access-log] pruneHttpAccessLogs failed");
    return { deleted, batches, moreRemaining, error: err?.message ?? "prune failed" };
  }
}
