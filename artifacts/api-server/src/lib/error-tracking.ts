/**
 * lib/error-tracking.ts — Self-Hosted Error Capture
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Persists every runtime crash to the `system_errors` SQL table so platform
 * admins can see, in one place, every 500 / uncaught exception / unhandled
 * rejection the api-server has thrown — independent of whatever happens to
 * the pino log stream. It's the in-house equivalent of Sentry's capture API
 * but uses Postgres as the backend so there's no external dependency, no
 * DSN to configure, and no PII leaving the deployment.
 *
 * ─── Public API ──────────────────────────────────────────────────────────────
 *   captureError(err, context?) — Fire-and-forget. Awaiting is allowed but
 *                                 the call site shouldn't depend on the
 *                                 promise resolving (errors during capture
 *                                 are swallowed and logged at warn level).
 *
 * ─── Why dbAdmin and not db ──────────────────────────────────────────────────
 * The Proxy `db` in lib/db throws when the request context is fail-closed
 * (post-2026-05 hardening). That's exactly the case we most need to capture
 * — the request crashed because the tenant context was bad. We use dbAdmin
 * (BYPASSRLS connection) so insert succeeds regardless. system_errors is
 * not RLS-protected anyway.
 *
 * ─── Never throw ─────────────────────────────────────────────────────────────
 * Every insert is wrapped in try/catch. If the DB itself is down (the case
 * the new /healthz check now reports), the error is logged via pino and
 * dropped. Crashing the error tracker because tracking failed would be a
 * crash loop.
 *
 * ─── Drop-in Sentry path ─────────────────────────────────────────────────────
 * If a SENTRY_DSN env var is ever added, this is the single place to call
 * Sentry.captureException(err, { extra: context }) alongside the SQL insert.
 * No call sites would need to change.
 */
import { dbAdmin, systemErrorsTable } from "@workspace/db";
import { logger } from "./logger";

const MAX_STACK_BYTES = 16 * 1024;

export type ErrorSource =
  | "express"
  | "uncaughtException"
  | "unhandledRejection"
  | "scheduler"
  | "manual"
  | "rate-limit-redis";

export interface ErrorContext {
  source: ErrorSource;
  statusCode?: number;
  method?: string;
  routePath?: string;
  tenantId?: string | null;
  userId?: string | null;
  requestId?: string | null;
  extra?: Record<string, unknown>;
}

function clipStack(stack: unknown): string | null {
  if (typeof stack !== "string") return null;
  if (stack.length <= MAX_STACK_BYTES) return stack;
  return stack.slice(0, MAX_STACK_BYTES) + `\n…[truncated, original ${stack.length} bytes]`;
}

function normaliseError(err: unknown): { name: string; message: string; stack: string | null } {
  if (err instanceof Error) {
    return { name: err.name || "Error", message: err.message || String(err), stack: clipStack(err.stack) };
  }
  if (typeof err === "string") return { name: "StringError", message: err, stack: null };
  try {
    return { name: "UnknownError", message: JSON.stringify(err) ?? String(err), stack: null };
  } catch {
    return { name: "UnknownError", message: String(err), stack: null };
  }
}

export async function captureError(err: unknown, context: ErrorContext): Promise<void> {
  const { name, message, stack } = normaliseError(err);
  try {
    await dbAdmin.insert(systemErrorsTable).values({
      source: context.source,
      statusCode: context.statusCode ?? null,
      method: context.method ?? null,
      routePath: context.routePath ?? null,
      errorName: name,
      message,
      stack,
      tenantId: context.tenantId ?? null,
      userId: context.userId ?? null,
      requestId: context.requestId ?? null,
      extra: (context.extra ?? null) as any,
    });
  } catch (insertErr) {
    /* Never throw from the error tracker — that would be a crash loop. */
    logger.warn(
      { err: (insertErr as Error)?.message, originalErr: message },
      "[error-tracking] failed to persist system error row",
    );
  }
}
