/**
 * anti-ghost-scheduler.ts — Ghosting Detection & Nurture Scheduler
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Registers two recurring timers that drive the anti-ghost-engine:
 *
 *   Detection timer (every 30 min)
 *     Calls runScanForAllTenants() which runs all four ghosting detectors
 *     (no-show, outreach dropout, stale pipeline, offer limbo) across every
 *     tenant in the database and inserts new ghosting_alerts rows.
 *
 *   Nurture timer (every 6 hours)
 *     Iterates over all tenants and calls processNurtureCycle(tenantId) which
 *     sends AI-generated re-engagement emails to nurture pool members whose
 *     nextContactAt has passed.
 *
 * Both timers run immediately on startup (no cold-start gap) and then on their
 * respective intervals. Errors are caught and logged — a failed tick never
 * crashes the scheduler or the API process.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/index.ts  — startAntiGhostScheduler() on server boot
 */
import { runScanForAllTenants, processNurtureCycle } from "./anti-ghost-engine";
import { db } from "@workspace/db";
import { tenantsTable } from "@workspace/db";
import { logger } from "./logger";
import { heartbeat } from "./heartbeat";

const DETECTION_INTERVAL_MS = 30 * 60 * 1000;  // Every 30 minutes
const NURTURE_INTERVAL_MS   =  6 * 60 * 60 * 1000; // Every 6 hours

export function startAntiGhostScheduler() {
  logger.info("[anti-ghost-scheduler] Started — detection every 30 min, nurture every 6 h");

  async function detectTick() {
    try {
      const total = await runScanForAllTenants();
      if (total > 0) logger.info({ total }, "[anti-ghost-scheduler] Scan complete — new alerts");
      heartbeat("anti_ghost");
    } catch (err: any) {
      logger.error({ err: err.message }, "[anti-ghost-scheduler] Detection error");
      heartbeat("anti_ghost", "fail", err);
    }
  }

  async function nurtureTick() {
    try {
      const tenants = await db.select({ id: tenantsTable.id }).from(tenantsTable);
      for (const tenant of tenants) {
        await processNurtureCycle(tenant.id);
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "[anti-ghost-scheduler] Nurture error");
    }
  }

  // Run immediately on boot, then on intervals
  detectTick();
  nurtureTick();
  setInterval(detectTick, DETECTION_INTERVAL_MS);
  setInterval(nurtureTick, NURTURE_INTERVAL_MS);
}
