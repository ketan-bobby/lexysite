/**
 * outreach-scheduler.ts — Outreach Campaign Autopilot Scheduler
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Registers a recurring timer that drives all active outreach campaigns.
 * Every 15 minutes it fetches all campaigns with status="active" and calls
 * runAutopilot(campaignId) on each one.
 *
 * runAutopilot() (in outreach-engine.ts) executes phases 2 & 3 of the
 * outreach pipeline for that campaign:
 *   Phase 2 — generateMessages()  Generate pending AI email drafts
 *   Phase 3 — sendScheduledMessages()  Send all ready drafts via SES
 *
 * Each campaign tick logs only when it produced work (generated > 0 or
 * sent > 0) to avoid noisy heartbeat logs.
 *
 * The scheduler runs one tick immediately on startup so the first batch of
 * emails isn't delayed by up to 15 minutes after a restart.
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/index.ts  — startOutreachScheduler() on server boot
 */
import { db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { outreachCampaignsTable } from "@workspace/db";
import { runAutopilot } from "./outreach-engine";
import { logger } from "./logger";
import { heartbeat } from "./heartbeat";

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export function startOutreachScheduler() {
  logger.info("[outreach-scheduler] Started – runs every 15 minutes");

  async function tick() {
    try {
      const activeCampaigns = await db.select()
        .from(outreachCampaignsTable)
        .where(eq(outreachCampaignsTable.status, "active"));

      if (activeCampaigns.length > 0) {
        logger.info({ count: activeCampaigns.length }, "[outreach-scheduler] Running autopilot for active campaigns");

        for (const campaign of activeCampaigns) {
          try {
            const result = await runAutopilot(campaign.id);
            if (result.generated > 0 || result.sent > 0) {
              logger.info(
                { campaign: campaign.name, generated: result.generated, sent: result.sent, failed: result.failed },
                "[outreach-scheduler] Campaign tick"
              );
            }
          } catch (err: any) {
            logger.error({ campaignId: campaign.id, err: err.message }, "[outreach-scheduler] Campaign error");
          }
        }
      }
      /* Ping AFTER a clean tick — zero-campaign ticks still count as "the
       * scheduler is alive and well", which is what BetterStack monitors. */
      heartbeat("outreach");
    } catch (err: any) {
      logger.error({ err: err.message }, "[outreach-scheduler] Tick error");
      heartbeat("outreach", "fail", err);
    }
  }

  // Run immediately on startup, then every 15 minutes
  tick();
  setInterval(tick, INTERVAL_MS);
}
