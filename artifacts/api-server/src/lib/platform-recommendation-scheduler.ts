/**
 * platform-recommendation-scheduler.ts — Platform Recommendation Scan Scheduler
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Wraps the platform-recommendation-engine and:
 *   1. Exposes a triggerScan() function that can be called on-demand from
 *      the sourcing route (manual trigger API).
 *   2. Registers a once-per-24-hour recurring timer to run the scan automatically.
 *
 * A mutex flag (scanInProgress) prevents concurrent scans — if a manual trigger
 * fires while the scheduled scan is running, triggerScan() throws rather than
 * starting a second concurrent scan that would waste API quota.
 *
 * The first automated scan is delayed 30 seconds after boot so the database
 * connection pool and other services are fully initialised before the scan
 * starts making hundreds of GPT-4o calls.
 *
 * ─── Exported state ──────────────────────────────────────────────────────────
 *   lastScanResult  — the ScanSummary from the most recent completed scan
 *   scanInProgress  — true while a scan is running (used by the manual trigger route)
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/index.ts       — startPlatformRecommendationScheduler() on server boot
 *   routes/sourcing.ts — triggerScan() for the manual trigger endpoint
 */
import { runPlatformRecommendationScan, type ScanSummary } from "./platform-recommendation-engine";
import { logger } from "./logger";

const SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export let lastScanResult: ScanSummary | null = null;
export let scanInProgress = false;

export async function triggerScan(): Promise<ScanSummary> {
  if (scanInProgress) {
    throw new Error("A recommendation scan is already in progress. Please wait.");
  }
  scanInProgress = true;
  try {
    lastScanResult = await runPlatformRecommendationScan();
    return lastScanResult;
  } finally {
    scanInProgress = false;
  }
}

export function startPlatformRecommendationScheduler() {
  logger.info("[platform-rec-scheduler] Started — runs every 24 hours");

  async function tick() {
    try {
      await triggerScan();
    } catch (err: any) {
      logger.error({ err: err.message }, "[platform-rec-scheduler] Scan error");
      scanInProgress = false;
    }
  }

  // First run: wait 30 s after boot so other services are ready
  setTimeout(tick, 30_000);
  setInterval(tick, SCAN_INTERVAL_MS);
}
