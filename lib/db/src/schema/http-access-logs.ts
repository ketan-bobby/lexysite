/**
 * schema/http-access-logs.ts — HTTP Access Log (pino-http request sink)
 *
 * ─── What this table holds ───────────────────────────────────────────────────
 * One row per completed HTTP request handled by the api-server. It is the
 * durable, SQL-queryable destination for the `pino-http` access log that is
 * mounted in app.ts — because the hosting platform offers no genuine log
 * drain, the structured request lines land here instead of only in stdout.
 *
 * ─── What is captured (and what is deliberately NOT) ─────────────────────────
 * Captured: method, the REGISTERED route pattern (e.g. `/api/jobs/:id`, never
 * the raw URL — so ids/PII are not embedded where the pattern suffices),
 * status code, response time (ms), client ip, the resolved userId/tenantId
 * (null when unauthenticated / unresolved), and the pino requestId so a row
 * correlates 1-to-1 with the stdout log line.
 * Excluded by design: request bodies, tokens, auth headers, and query strings.
 *
 * ─── Fire-and-forget insert ──────────────────────────────────────────────────
 * lib/http-access-log.ts inserts via dbAdmin (BYPASSRLS) on the response
 * `finish` event. A log-write failure is swallowed and never fails the
 * request — access logging must not itself throw.
 *
 * ─── Platform-operations table, admin-pool only (cross-tenant by design) ─────
 * NOT RLS-protected. tenantId is metadata (whose request it was, if known) —
 * it is NOT an access-control boundary. No tenant-facing route ever reads this
 * table raw; it is a platform-operations surface like the learning tables. See
 * artifacts/api-server/docs/SECURITY_PATTERNS.md for the exemption justification.
 *
 * ─── Retention ───────────────────────────────────────────────────────────────
 * Rows are pruned after 30 days by the daily http-access-log retention
 * scheduler (mirrors the pipeline_run_events retention pattern).
 */
import { pgTable, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const httpAccessLogsTable = pgTable(
  "http_access_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    method: text("method").notNull(),
    /* The registered Express route pattern (`req.baseUrl + req.route.path`),
     * e.g. `/api/jobs/:id`. NULL for requests that never matched a route (404s,
     * or a 401 short-circuited in app-level middleware) — we never derive this
     * from the raw URL, since arbitrary path segments can carry ids/PII. Never
     * the raw URL, never a querystring. */
    routePattern: text("route_pattern"),
    statusCode: integer("status_code").notNull(),
    responseTimeMs: integer("response_time_ms"),
    ip: text("ip"),
    /* Resolved caller identity. Null when the request was unauthenticated
     * (userId) or the tenant could not be resolved (tenantId). Informational
     * only — NOT an ACL key (see header). */
    userId: text("user_id"),
    tenantId: text("tenant_id"),
    /* pino request id, so the stdout log line and this row correlate 1-to-1. */
    requestId: text("request_id"),
  },
  (t) => ({
    occurredAtIdx: index("http_access_logs_occurred_at_idx").on(t.occurredAt),
    statusOccurredIdx: index("http_access_logs_status_occurred_idx").on(t.statusCode, t.occurredAt),
    routeOccurredIdx: index("http_access_logs_route_occurred_idx").on(t.routePattern, t.occurredAt),
  }),
);

export type HttpAccessLog = typeof httpAccessLogsTable.$inferSelect;
