/**
 * lib/health-check.ts — Shared DB-aware health check.
 *
 * Used by both the legacy app-level GET /health route and the api-mounted
 * GET /healthz in routes/health.ts. Centralised here so both endpoints
 * report identical shape and behavior, and so adding more dependency
 * checks (Redis, S3, etc.) is a single-file change.
 */
import { pool } from "@workspace/db";

const DB_PING_TIMEOUT_MS = 2_000;

/* Why this pings via a dedicated client + statement_timeout instead of
 * `dbAdmin.execute(SELECT 1)` raced against setTimeout:
 *
 * A raw Promise.race leaves the SQL query running on the server after the
 * timeout — under sustained DB slowness, every health probe (LBs ping every
 * few seconds, often from multiple sources) accumulates orphaned in-flight
 * `SELECT 1`s on the pool, making the degradation worse. Acquiring a
 * client and `SET LOCAL statement_timeout` lets Postgres itself cancel the
 * query when the timeout elapses, and `client.release()` frees the slot. */
export async function healthCheck(): Promise<{
  ok: boolean;
  payload: {
    status: "ok" | "degraded";
    timestamp: string;
    checks: { db: { ok: boolean; latencyMs: number; error?: string } };
  };
}> {
  const started = Date.now();
  let dbOk = false;
  let dbErr: string | undefined;
  let client: any;
  try {
    /* Acquire a client with its own timeout — pool exhaustion is itself a
     * health failure we want to surface. */
    client = await Promise.race([
      pool.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Pool acquire timed out after ${DB_PING_TIMEOUT_MS}ms`)), DB_PING_TIMEOUT_MS),
      ),
    ]);
    /* Postgres-side cancellation: if the query runs longer than the
     * timeout, the server aborts it and pg throws — no orphaned work. */
    await client.query(`SET LOCAL statement_timeout = ${DB_PING_TIMEOUT_MS}`);
    await client.query("SELECT 1");
    dbOk = true;
  } catch (err: any) {
    dbErr = err?.message || String(err);
  } finally {
    /* Always release; pg.Pool tolerates release() being called on a
     * never-acquired client only if we guard. */
    try { client?.release(); } catch { /* ignore */ }
  }
  const latencyMs = Date.now() - started;
  const payload = {
    status: dbOk ? ("ok" as const) : ("degraded" as const),
    timestamp: new Date().toISOString(),
    checks: { db: { ok: dbOk, latencyMs, ...(dbErr ? { error: dbErr } : {}) } },
  };
  return { ok: dbOk, payload };
}
