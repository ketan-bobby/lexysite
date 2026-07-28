/**
 * worker.ts — Standalone AI job worker process
 *
 * Entry point for running the AI job queue consumer as its OWN process,
 * separate from the HTTP API server. Use this to scale interview/AI processing
 * horizontally: run N copies of this process (e.g. a dedicated Replit
 * deployment) and set WORKER_INLINE=false on the web replicas so they stop
 * draining the queue themselves.
 *
 * The queue claims rows with FOR UPDATE SKIP LOCKED, so any mix of inline and
 * standalone workers is safe — a job is processed exactly once.
 *
 * This process does NOT bind a port and does NOT run the HTTP schedulers; it
 * only drains `ai_jobs`.
 */
import { logger } from "./lib/logger";
import { startAiWorker, stopAiWorker } from "./lib/ai-queue/worker";

logger.info("[worker] standalone AI worker process starting");
startAiWorker();

async function shutdown(signal: string) {
  logger.info({ signal }, "[worker] shutdown signal received — draining");
  await stopAiWorker();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "[worker] unhandledRejection");
});
