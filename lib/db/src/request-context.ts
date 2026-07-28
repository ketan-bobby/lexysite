/**
 * request-context.ts — Per-request DB context for RLS pilot
 *
 * Holds the request-scoped Drizzle instance (bound to a dedicated PoolClient
 * that has `SET ROLE lexy_app` + the tenant GUCs applied). The exported `db`
 * in ./index.ts checks this storage on every property access and, if a
 * context is present, forwards the call to the request-scoped instance
 * instead of the raw pool-backed admin one.
 *
 * This is what makes the RLS pilot transparent to existing handlers: they
 * keep writing `db.select().from(candidates)…` and Postgres takes care of
 * filtering by tenant_id automatically because the underlying connection
 * has been downgraded to a non-BYPASSRLS role with the right GUCs.
 *
 * Code paths that explicitly need to read across tenants (schedulers,
 * webhook handlers, seeders, the platform-admin console) should import
 * `dbAdmin` from @workspace/db instead — that always uses the raw pool
 * connection running as the superuser, which bypasses RLS by design.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

/**
 * Two shapes share this storage:
 *
 *   1. Authenticated HTTP request → { db, tenantId, isPlatformAdmin }
 *      The Proxy in ./index.ts forwards every call to `db`, which is the
 *      RLS-bound, tenant-scoped connection.
 *
 *   2. HTTP request that did NOT pass auth → { failClosed: true, path }
 *      The Proxy throws when touched. This is what prevents a route that
 *      forgot its `resolveUser` / `requireAuth` middleware from silently
 *      using the admin pool (which would defeat RLS). Bypass routes
 *      (/public, /webhooks, /healthz, /auth/login, etc.) deliberately
 *      DO NOT set the store at all — they continue to fall through to
 *      dbAdmin exactly as before.
 *
 *   3. Background work (schedulers, startup, scripts) → store is empty.
 *      Falls through to dbAdmin unchanged.
 */
export type RequestDbContext =
  | {
      /** Drizzle instance bound to a request-scoped PoolClient (lexy_app role). */
      db: NodePgDatabase<typeof schema>;
      /** The tenantId set on this connection, for log/audit lines. */
      tenantId: string;
      /** True when the request is acting as platform_admin (RLS bypass). */
      isPlatformAdmin: boolean;
      failClosed?: false;
    }
  | {
      db?: undefined;
      tenantId?: undefined;
      isPlatformAdmin?: undefined;
      /** When true, any access of the `db` Proxy throws — fail closed
       * instead of silently falling through to dbAdmin. */
      failClosed: true;
      /** Original request path, included in the thrown error for debugging. */
      path: string;
    };

export const requestDbContext = new AsyncLocalStorage<RequestDbContext>();
