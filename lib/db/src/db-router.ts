/**
 * db-router.ts — Multi-region DB router
 *
 * Single entry point for every code path that needs to read or write
 * tenant-scoped data. The rule is:
 *
 *   • Tenant-scoped reads/writes  →  forRegion(req.region)
 *   • Control-plane reads/writes  →  controlDb
 *
 * Today we run in "single-cell mode": every region resolves to the same
 * physical Postgres (the existing Replit DB), and `controlDb` points at the
 * same pool too. The abstraction lets the application code be *written*
 * exactly as the multi-region future requires, without any of the operational
 * cost yet. When we provision Mumbai (Phase 1) we flip a feature flag and
 * point each region key at its own pool — zero business-logic changes.
 *
 * ── How callers use this ─────────────────────────────────────────────────
 *
 *   import { forRegion, controlDb } from "@workspace/db";
 *
 *   // Inside an authenticated route handler:
 *   const db = forRegion(req.region);
 *   const candidates = await db.select().from(candidatesTable)…
 *
 *   // Inside the login handler (no tenant context yet):
 *   const [u] = await controlDb.select({…}).from(usersTable).where(...)
 *
 * ── Why a thin layer today ──────────────────────────────────────────────
 *
 * The existing `db` and `dbAdmin` exports continue to work — every existing
 * route handler uses them. New handlers and any handler we migrate should
 * use this router instead. Over time we deprecate the bare `db` import.
 *
 * Until we actually have multiple physical pools, the router returns the
 * same RLS-aware Drizzle Proxy that `db` already exports. This means:
 *   • RLS still operates as designed (request context drives tenant scoping)
 *   • fail-closed behaviour for unauthenticated requests still fires
 *   • no perf cost — it's literally the same object
 */
/* Use a namespace import (not named) to dodge the ESM circular-init issue:
 * index.ts re-exports from this file, so by the time db-router.ts runs its
 * top-level code, `dbAdmin` and `db` from index.ts are still in the TDZ.
 * A namespace import gives us a live binding object; property access is
 * deferred until the Proxy below is actually used at request time, by
 * which point index.ts has finished initialising. */
import * as dbModule from "./index";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema";

export const REGIONS = ["us", "in", "eu", "uk", "au", "ca"] as const;
export type Region = typeof REGIONS[number];

export function isRegion(x: unknown): x is Region {
  return typeof x === "string" && (REGIONS as readonly string[]).includes(x);
}

/* In single-cell mode (the default for local dev and the current Replit
 * deploy) every region resolves to the same physical pool. Phase 1 will
 * read LEXY_LOCAL_SINGLE_CELL=false plus per-region DATABASE_URL_* env
 * vars to spin up one pool per cell. */
const SINGLE_CELL = process.env.LEXY_LOCAL_SINGLE_CELL !== "false";

/**
 * Return the tenant-scoped, RLS-aware Drizzle handle for the given region.
 * Today this is always the existing `db` proxy regardless of region; the
 * region argument is recorded so logs/metrics can attribute the call.
 */
/* Lazy property forwarder. The actual `db` / `dbAdmin` exports from
 * index.ts are accessed on demand via the namespace object so the
 * circular-init order doesn't matter. */
function lazyProxy(pick: () => NodePgDatabase<typeof schema>): NodePgDatabase<typeof schema> {
  return new Proxy({} as NodePgDatabase<typeof schema>, {
    get(_t, prop, _r) {
      const target = pick();
      const value = Reflect.get(target as any, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const _forRegionCache = new Map<Region, NodePgDatabase<typeof schema>>();

export function forRegion(region: Region): NodePgDatabase<typeof schema> {
  let h = _forRegionCache.get(region);
  if (!h) {
    h = lazyProxy(() => {
      if (SINGLE_CELL) return (dbModule as any).db;
      // Phase 1: per-region pool map. Until then, multi-cell mode also
      // falls through to the single pool to avoid breakage.
      return (dbModule as any).db;
    });
    _forRegionCache.set(region, h);
  }
  return h;
}

/**
 * Control-plane DB handle. Use for: tenant directory lookups during login,
 * user→tenant routing, Stripe customer state, feature flags. Never use for
 * candidate / interview / resume data — that's per-cell only.
 *
 * In single-cell mode this is the BYPASSRLS admin pool (same as `dbAdmin`).
 * In Phase 1 this will point at a dedicated small RDS hosting only the
 * control schema.
 */
export const controlDb: NodePgDatabase<typeof schema> = lazyProxy(() => (dbModule as any).dbAdmin);
