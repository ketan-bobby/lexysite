/**
 * external-click-scheduler.ts — External Click Follow-up Scheduler
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Registers a recurring timer that calls processExternalClickFollowUps() every
 * 6 hours. The function scans for candidate external job clicks older than 7
 * days that haven't yet received a follow-up email, and sends AI-generated
 * check-in emails for each.
 *
 * The first tick runs immediately on startup so any backlog from a server
 * restart is processed without waiting 6 hours.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/index.ts — startExternalClickScheduler() on server boot
 */
import { processExternalClickFollowUps } from "./external-click-engine";
import { logger } from "./logger";

const FOLLOW_UP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 hours

export function startExternalClickScheduler() {
  logger.info("[external-click-scheduler] Started — follow-ups checked every 6 h");

  async function tick() {
    try {
      const sent = await processExternalClickFollowUps();
      if (sent > 0) logger.info({ sent }, "[external-click-scheduler] Follow-ups sent");
    } catch (err: any) {
      logger.error({ err: err.message }, "[external-click-scheduler] Error");
    }
  }

  tick();
  setInterval(tick, FOLLOW_UP_INTERVAL_MS);
}
