/**
 * schema/system-errors.ts — Captured Runtime Errors
 *
 * ─── What this table holds ───────────────────────────────────────────────────
 * Every uncaught exception, unhandled promise rejection, and Express
 * 5xx error handled by the global error middleware lands here as one row.
 * This is the self-hosted "Sentry" — a SQL-queryable dashboard of every
 * production crash, with enough context to triage without needing the
 * customer to send a screenshot.
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * Before 2026-05-16 a 500 from the api-server only existed in stdout logs.
 * Log lines are easy to lose (rotation, multi-replica, log-level filters),
 * and pino's pretty transport in dev sometimes ate stack traces entirely.
 * Persisting to SQL means "show me every 500 in the last 24 h, grouped by
 * route" is one query, and the row outlives any log retention policy.
 *
 * ─── Fire-and-forget insert ──────────────────────────────────────────────────
 * lib/error-tracking.ts inserts via dbAdmin (BYPASSRLS) so capture works
 * even from a fail-closed request context (the whole point is to record
 * the error that happened because the request was broken). Insert failures
 * are swallowed — error tracking must never itself throw.
 *
 * ─── Cross-tenant by design ──────────────────────────────────────────────────
 * NOT RLS-protected. tenantId is metadata (the tenant whose request failed,
 * if known) — it is NOT an access-control boundary. Reads are gated at the
 * route layer to platform_admin only.
 */
import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";

export const systemErrorsTable = pgTable(
  "system_errors",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /* "express" | "uncaughtException" | "unhandledRejection" | "scheduler" | "manual" */
    source: text("source").notNull(),
    /* HTTP status if the error was surfaced through an Express response.
     * Null for uncaught/unhandled rejections that never reached a request. */
    statusCode: integer("status_code"),
    method: text("method"),
    /* Request path WITHOUT querystring (querystrings can carry tokens). */
    routePath: text("route_path"),
    /* The error's .name (e.g. "TypeError", "ZodError"). */
    errorName: text("error_name"),
    message: text("message").notNull(),
    /* Capped at 16 KB — pathological recursive stacks otherwise eat disk. */
    stack: text("stack"),
    /* Caller context if known. tenantId is informational only, NOT an ACL key. */
    tenantId: text("tenant_id"),
    userId: text("user_id"),
    /* pino request id when the error came from an Express request, so the
     * stdout log line and the SQL row can be correlated 1-to-1. */
    requestId: text("request_id"),
    /* Anything that didn't fit in a column: zod issue list, sql params,
     * the third-party API body that triggered the failure, etc. */
    extra: jsonb("extra"),
  },
  (t) => ({
    occurredAtIdx: index("system_errors_occurred_at_idx").on(t.occurredAt),
    sourceOccurredIdx: index("system_errors_source_occurred_idx").on(t.source, t.occurredAt),
    routeOccurredIdx: index("system_errors_route_occurred_idx").on(t.routePath, t.occurredAt),
  }),
);

export type SystemError = typeof systemErrorsTable.$inferSelect;
