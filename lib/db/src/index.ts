/**
 * index.ts — @workspace/db package entry point
 *
 * Owns the single pg connection Pool and exposes three Drizzle handles:
 *   • dbAdmin — raw pool as the BYPASSRLS superuser; cross-tenant access for
 *               schedulers, webhooks, seeders, and platform-admin tooling.
 *   • db      — RLS-aware Proxy that forwards to a request-scoped, tenant-
 *               bound connection when inside withTenantContext, fails closed
 *               on unauthenticated routes, and otherwise falls back to dbAdmin.
 *   • forRegion/controlDb — multi-region router (single-cell today).
 * Also re-exports the full schema namespace and request-context helpers.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { requestDbContext } from "./request-context";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/* Explicit pool sizing so production behaviour matches expectations:
 *   max                : upper bound on concurrent connections (PG default
 *                        max_connections is 100; allow ~20 per app replica
 *                        before requests start queueing).
 *   idleTimeoutMillis  : drop idle connections to free server slots; 30s
 *                        is the standard heroku/RDS recommendation.
 *   connectionTimeoutMillis : fast-fail when the DB is unreachable rather
 *                        than holding requests open until the load balancer
 *                        gives up.
 *
 * Override any of these with PGPOOL_MAX / PGPOOL_IDLE_MS / PGPOOL_CONN_MS
 * env vars when sizing for larger deploys. */
const poolMax  = Number(process.env.PGPOOL_MAX) || 20;
const poolIdle = Number(process.env.PGPOOL_IDLE_MS) || 30_000;
const poolConn = Number(process.env.PGPOOL_CONN_MS) || 10_000;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis: poolIdle,
  connectionTimeoutMillis: poolConn,
});

/* Surface unexpected pool errors so they don't get swallowed and silently
 * crash the process when a connection is killed by the DB server. */
pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("[pg-pool] Idle client error", err);
});

/**
 * Admin-mode Drizzle instance. Runs every query on the raw pool connection
 * as the `postgres` superuser, which has BYPASSRLS — so RLS policies do
 * NOT apply.
 *
 * Use this ONLY for code paths that legitimately need cross-tenant access:
 *   • Schedulers (recruiter-digest, weekly-digest, peer-percentile, etc.)
 *   • Webhook handlers that receive events for arbitrary tenants
 *   • Platform-admin tools that scan across the whole database
 *   • Seeders and migration helpers
 *
 * For everything else, import `db` instead — it transparently switches
 * to a request-scoped, RLS-enforced connection when called from inside
 * the withTenantContext middleware.
 */
export const dbAdmin: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

/**
 * Request-aware Drizzle instance.
 *
 * When called from inside an HTTP request that went through
 * withTenantContext, every property/method access is forwarded to a
 * request-scoped Drizzle instance whose connection has:
 *   SET ROLE lexy_app                              (no BYPASSRLS)
 *   SET app.current_tenant_id = '<caller tenant>'  (read by RLS policy)
 *   SET app.is_platform_admin = 'true'|'false'     (read by RLS policy)
 * Result: queries against any RLS-protected table automatically refuse to
 * return cross-tenant rows. As of the Phase A extension (migration
 * 0001_rls_extension.sql, with carve-outs in 0003_rls_extension_fix.sql)
 * that covers 33 tables — the original 3 pilot tables (candidates,
 * applications, interview_sessions) plus 30 more spanning jobs, outreach,
 * talent matching, pipeline, billing, notifications, interview plans,
 * and most other tenant-scoped tables.
 * The tables NOT covered fall into two groups:
 *   • Phase B / deferred (cross-tenant by design): users, tenants,
 *     invite_tokens, staff_invite_tokens, pending_trial_signups,
 *     partners, partner_attribution_events — see Phase B section of
 *     0001_rls_extension.sql.
 *   • Carved out from Phase A pending bespoke policies:
 *     candidate_action_events (viewer_tenant_id is nullable for most
 *     event types) and talent_pool_submissions (queried by candidate_id
 *     across destinations from the recruiter side) — see
 *     0003_rls_extension_fix.sql for the full rationale.
 * Note: ALL 35 tenant-scoped tables (including the two carve-outs)
 * still carry a tenant_id FK to tenants(id) ON DELETE CASCADE from
 * migration 0002_tenant_id_fks.sql.
 *
 * When called from anywhere else (schedulers, startup code, scripts),
 * the AsyncLocalStorage store is empty and we fall through to `dbAdmin`,
 * preserving existing behaviour.
 *
 * Note: `db.query.<table>.<method>` style is NOT currently used in the
 * codebase (verified via ripgrep). If that style is introduced later,
 * this Proxy will need a nested-property trap to make it dynamic too.
 */
/**
 * FAIL-CLOSED BEHAVIOUR
 *
 * If the AsyncLocalStorage store is populated with `failClosed: true`
 * (set by withTenantContext for requests that landed on a non-bypass
 * route without valid auth), this Proxy refuses to hand out the
 * admin-pool db. The previous behaviour silently fell through to
 * `dbAdmin` (BYPASSRLS), which meant a developer who shipped a new
 * /api/* route and forgot to add `resolveUser`/`requireAuth` would
 * also silently bypass RLS — the exact failure mode the pilot is
 * meant to prevent.
 *
 * Bypass-listed routes (/public, /webhooks, /healthz, /auth/login,
 * etc.) do NOT set the store at all and continue to fall through to
 * dbAdmin. Schedulers and background code also have no store and
 * continue to use dbAdmin. So this throw fires ONLY for HTTP requests
 * to a route that was supposed to be authed but wasn't — which is
 * exactly the bug class we want to surface.
 */
const FAIL_CLOSED_MESSAGE =
  "[db] Refusing to use admin pool inside an unauthenticated HTTP request. " +
  "The route handler needs resolveUser/requireAuth (so RLS context is set), " +
  "OR the route's prefix needs to be added to BYPASS_PREFIXES in " +
  "withTenantContext.ts if it is intentionally callable without a bearer token.";

export const db: NodePgDatabase<typeof schema> = new Proxy(dbAdmin, {
  get(adminTarget, prop, _receiver) {
    const ctx = requestDbContext.getStore();
    if (ctx?.failClosed) {
      throw new Error(`${FAIL_CLOSED_MESSAGE} (path=${ctx.path}, op=${String(prop)})`);
    }
    const target = ctx?.db ?? adminTarget;
    const value = Reflect.get(target, prop, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
}) as NodePgDatabase<typeof schema>;

export * from "./schema";

/**
 * Re-export of the full schema namespace.
 *
 * Use this when you need to pass `{ schema }` to `drizzle(client, { schema })`
 * — for example inside the withTenantContext middleware, which constructs
 * a per-request Drizzle handle bound to a checked-out PoolClient.
 *
 * `import * as schema from "@workspace/db"` would NOT work because the
 * package also exports `db`, `pool`, `dbAdmin`, etc., which drizzle would
 * misinterpret as additional tables.
 */
export * as schema from "./schema";

export { requestDbContext } from "./request-context";
export type { RequestDbContext } from "./request-context";

/* Multi-region routing (Phase 0). Today both helpers resolve to the
 * single existing pool; Phase 1 wires per-cell pools without touching
 * any caller code. See lib/db/src/db-router.ts. */
export { forRegion, controlDb, REGIONS, isRegion } from "./db-router";
export type { Region } from "./db-router";
