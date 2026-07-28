/**
 * peer-percentile-scheduler.ts — Daily peer-percentile recomputation.
 *
 * Runs runPeerPercentileSweep() every 24h so the dashboard's "Top quarter in
 * United States · Above average globally" badge stays fresh as new candidates
 * join the platform and existing ones improve.
 */
import { runPeerPercentileSweep } from "./peer-percentile.js";
import { logger } from "./logger.js";

let _timer: ReturnType<typeof setTimeout> | null = null;

export function startPeerPercentileScheduler(): void {
  const INTERVAL_MS = 24 * 60 * 60 * 1000;
  const INITIAL_DELAY_MS = 6 * 60 * 1000; // 6 min after boot

  const runLoop = async () => {
    try {
      await runPeerPercentileSweep();
    } catch (err: any) {
      logger.error({ err: err?.message }, "[peer-percentile] scheduler error");
    }
    _timer = setTimeout(runLoop, INTERVAL_MS);
  };

  _timer = setTimeout(runLoop, INITIAL_DELAY_MS);
  logger.info("[peer-percentile-scheduler] Started — runs every 24 hours");
}
