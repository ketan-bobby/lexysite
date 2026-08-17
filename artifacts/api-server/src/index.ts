/**
 * index.ts — API Server Entry Point
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Bootstraps the HTTP server and all background schedulers. This is the only
 * file that should call listen() and start timers — app.ts registers routes
 * and middleware but never binds to a port.
 *
 * ─── Startup sequence ────────────────────────────────────────────────────────
 *   1. Validate PORT env var (required — no default to avoid silent port conflicts)
 *   2. Create an http.Server wrapping the Express app
 *   3. Register SIGTERM / SIGINT handlers for graceful shutdown
 *   4. Call server.listen(port) with an EADDRINUSE retry loop (up to 5 attempts,
 *      1 second apart) — handles the short window after a restart where the OS
 *      hasn't yet released the port
 *   5. On the first successful "listening" event, start all schedulers:
 *      • startOutreachScheduler()              — campaign autopilot (every 15 min)
 *      • startAntiGhostScheduler()             — ghosting detection (every 30 min)
 *      • startExternalClickScheduler()         — click follow-ups (every 6h)
 *      • startInterviewInviteScheduler()       — invite lifecycle (every 1h)
 *      • startRecruiterDigestScheduler()       — daily digest (every 1h)
 *      • startPlatformRecommendationScheduler() — AI recommendations (every 24h)
 *      • startCandidateReengagementScheduler() — inactivity emails (every 24h)
 *      • startLinkedInProfileMonitor()         — job-change detection (every 24h)
 *
 * ─── Graceful shutdown ───────────────────────────────────────────────────────
 * gracefulShutdown() drains existing connections via server.close() and then
 * exits. A 5-second hard-exit timer ensures the process never hangs if a
 * connection refuses to close (e.g. a long-running SSE stream).
 */
import { createServer } from "http";
import app from "./app";
import { logger } from "./lib/logger";
import { startOutreachScheduler } from "./lib/outreach-scheduler";
import { startAntiGhostScheduler } from "./lib/anti-ghost-scheduler";
import { startExternalClickScheduler } from "./lib/external-click-scheduler";
import { startInterviewInviteScheduler } from "./lib/interview-invite-scheduler";
import { startTrialExpiryScheduler } from "./lib/trial-expiry-scheduler";
import { startSubscriptionLifecycleScheduler } from "./lib/subscription-lifecycle-scheduler";
import { startRecruiterDigestScheduler } from "./lib/recruiter-digest-scheduler";
import { startPlatformRecommendationScheduler } from "./lib/platform-recommendation-scheduler";
import { startCandidateReengagementScheduler } from "./lib/candidate-reengagement-scheduler";
import { startPeerPercentileScheduler } from "./lib/peer-percentile-scheduler";
import { startGraphReplyPollScheduler } from "./lib/graph-reply-sync";
import { startWeeklyDigestScheduler } from "./lib/weekly-digest-scheduler";
import { startSttAlertScheduler } from "./lib/stt-alert-scheduler";
import { startSttRetentionScheduler } from "./lib/stt-retention-scheduler";
import { startPipelineRunEventsRetentionScheduler } from "./lib/pipeline-run-events-retention-scheduler";
import { startHttpAccessLogRetentionScheduler } from "./lib/http-access-log-retention-scheduler";
import { startHistoryRetentionScheduler } from "./lib/history-retention-scheduler";
import { startLearnedScoringRefreshScheduler } from "./lib/learned-scoring-scheduler";
import { startPostHirePulseScheduler } from "./lib/post-hire-pulse-scheduler";
import { startLinkedInProfileMonitor, runLinkedInProfileMonitor, getLastLinkedInScanResult } from "./lib/linkedin-profile-monitor";
import { startAiWorker } from "./lib/ai-queue/worker";
import { reconcileStaleAgentRuns } from "./lib/agent-runs/recorder";
import { reconcileStalePipelineRuns } from "./lib/pipeline-runs/reconcile";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/* ── Create HTTP server ──────────────────────────────────────────────────── */
const server = createServer(app);

/* ── Graceful shutdown ───────────────────────────────────────────────────── */
/* Replit sends SIGTERM to restart a workflow. Calling server.close() drains *
 * existing connections and releases the port before the process exits, so   *
 * the next start can bind immediately without EADDRINUSE.                   */
function gracefulShutdown(signal: string) {
  logger.info({ signal }, "Shutdown signal received — closing server");
  server.close(() => {
    logger.info("Server closed cleanly");
    process.exit(0);
  });
  /* Force-exit if graceful close hangs for more than 30 s — long enough for
     in-flight transcription / S3 upload streams to drain, short enough that
     Replit / k8s won't SIGKILL us first. */
  setTimeout(() => {
    logger.warn("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 30_000).unref();
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

/* ── Process-level error capture ─────────────────────────────────────────────
 * Anything that escapes an async handler or fires from a setTimeout /
 * setInterval (most of our schedulers) lands here. We persist to
 * system_errors so the platform-admin dashboard sees every crash.
 *
 * Policy difference between the two events:
 *
 *   uncaughtException   — Process state may be corrupted (open handles,
 *                         half-initialised modules, stuck transactions).
 *                         Continuing risks silently bad behavior across
 *                         tenants. Capture, then graceful shutdown so the
 *                         supervisor (Replit workflow / k8s) restarts us.
 *
 *   unhandledRejection  — Almost always an awaited Promise that lost its
 *                         catch handler. Process state is usually fine.
 *                         Capture and KEEP RUNNING — killing the server
 *                         for one stray scheduler rejection would take
 *                         down every tenant for one bad row. Fix at the
 *                         scheduler boundary instead.
 *
 * (If we ever observe unhandledRejections that DO corrupt state, escalate
 * that handler to the same exit-on-capture policy. Until then, exit-on-
 * unhandledRejection causes more outages than it prevents.) */
async function persistProcessError(
  source: "uncaughtException" | "unhandledRejection",
  err: unknown,
) {
  try {
    const { captureError } = await import("./lib/error-tracking");
    await captureError(err, { source });
  } catch { /* swallow — see error-tracking.ts header */ }
  logger.error({ err, source }, `[${source}] captured`);
}

let exitingOnUncaught = false;
process.on("uncaughtException", (err) => {
  if (exitingOnUncaught) return;
  exitingOnUncaught = true;
  /* Best-effort capture; then graceful shutdown. We give captureError a
   * short window to complete, but exit either way — the supervisor will
   * restart the process. */
  persistProcessError("uncaughtException", err).finally(() => {
    try { gracefulShutdown("uncaughtException"); } catch { process.exit(1); }
    /* Hard ceiling so a stuck close() can't keep a corrupted process alive. */
    setTimeout(() => process.exit(1), 5_000).unref();
  });
});
process.on("unhandledRejection", (reason) => {
  /* Capture but keep running — see policy comment above. */
  persistProcessError("unhandledRejection", reason);
});

/* ── Start listening with EADDRINUSE retry ───────────────────────────────── */
/* Even with graceful shutdown, there can be a short window where the OS has  *
 * not yet released the port. We retry up to MAX_RETRIES times (1 s apart)   *
 * before giving up, so restarts are always stable.                          */
const MAX_RETRIES = 5;
let attempts = 0;
let schedulersStarted = false;

function startListening() {
  attempts += 1;
  server.listen(port);
}

/* ── Scheduler election ──────────────────────────────────────────────────── */
/* All background schedulers (digests, anti-ghost, outreach autopilot, etc.)  *
 * run in-process. In a multi-replica deployment that means N copies of every  *
 * email, every webhook, every Stripe sync. SCHEDULER_LEADER gates them so    *
 * only one replica acts as the leader. Default: true (single-replica), so    *
 * dev + small prod stay zero-config. Set SCHEDULER_LEADER=false on every     *
 * non-leader replica when scaling out.                                        */
const isSchedulerLeader = (process.env.SCHEDULER_LEADER ?? "true").toLowerCase() !== "false";

/* ── Stripe dormancy sentinel ─────────────────────────────────────────────── *
 * Real billing today is manual ACH + the fee ledger; the Stripe scaffolding   *
 * in routes/billing.ts and routes/public.ts activates on the PRESENCE of      *
 * STRIPE_SECRET_KEY + STRIPE_ENABLE_ACK. There is no infra-level approval     *
 * gate on secrets, so this sentinel is the guardrail: if the key is set       *
 * without the ack, log an ERROR at startup + hourly AND — because stdout      *
 * scrolls away unmonitored — escalate to channels a human actually sees:      *
 * in-app bell notifications + email to every platform_admin, at boot and      *
 * then daily (best-effort, never blocks startup).                             */
function stripeDormancySentinel() {
  if (!process.env.STRIPE_SECRET_KEY) return;
  if ((process.env.STRIPE_ENABLE_ACK ?? "").toLowerCase() === "true") {
    logger.warn("[stripe-sentinel] STRIPE_SECRET_KEY is set and acknowledged (STRIPE_ENABLE_ACK=true) — self-serve Stripe checkout is LIVE.");
    return;
  }
  const message =
    "STRIPE_SECRET_KEY is SET on this deployment but Stripe billing is supposed to be DORMANT (real billing = manual ACH + fee ledger). " +
    "Self-serve checkout stays disabled until STRIPE_ENABLE_ACK=true is also set, but an unexpected key means someone changed billing secrets without acknowledgment. " +
    "Remove the secret, or set STRIPE_ENABLE_ACK=true if turning Stripe on is intentional.";
  const alarm = () => logger.error(`[stripe-sentinel] ${message} This alert repeats hourly.`);
  alarm();
  setInterval(alarm, 60 * 60 * 1000);

  // Human-facing escalation: in-app + email to platform_admins, daily.
  const escalate = async () => {
    try {
      const { db, usersTable, userNotificationsTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const { sendEmail, plainToHtml } = await import("./lib/email");
      const admins = await db
        .select({ id: usersTable.id, email: usersTable.email, tenantId: usersTable.tenantId })
        .from(usersTable)
        .where(eq(usersTable.role, "platform_admin"));
      for (const admin of admins) {
        await db
          .insert(userNotificationsTable)
          .values({
            tenantId: admin.tenantId,
            userId: admin.id,
            type: "stripe_sentinel",
            title: "ALERT: Unacknowledged STRIPE_SECRET_KEY detected",
            message,
            actionUrl: "/platform/subscriptions",
          })
          .catch(() => {});
        if (!admin.email) continue;
        const text = `${message}\n\n— L3xy Platform Sentinel`;
        await sendEmail({
          to: admin.email,
          subject: "L3xy ALERT: unacknowledged Stripe key on deployment",
          text,
          html: plainToHtml(text),
          audit: {
            tenantId: admin.tenantId,
            actorLabel: "Stripe Dormancy Sentinel",
            subjectType: "external",
            subjectLabel: admin.email,
            action: "stripe.sentinel.alerted",
            metadata: {},
          },
        }).catch(() => {});
      }
      logger.warn({ admins: admins.length }, "[stripe-sentinel] escalated to platform_admins (in-app + email)");
    } catch (err) {
      logger.error({ err }, "[stripe-sentinel] escalation failed — hourly log remains the fallback");
    }
  };
  void escalate();
  setInterval(() => void escalate(), 24 * 60 * 60 * 1000);
}

server.on("listening", () => {
  logger.info({ port, schedulerLeader: isSchedulerLeader }, "Server listening");
  stripeDormancySentinel();
  if (!schedulersStarted) {
    schedulersStarted = true;
    if (isSchedulerLeader) {
      startOutreachScheduler();
      startAntiGhostScheduler();
      startExternalClickScheduler();
      startInterviewInviteScheduler();
      startTrialExpiryScheduler();
      startSubscriptionLifecycleScheduler();
      startRecruiterDigestScheduler();
      startPlatformRecommendationScheduler();
      startCandidateReengagementScheduler();
      startPeerPercentileScheduler();
      startWeeklyDigestScheduler();
      startSttAlertScheduler();
      startSttRetentionScheduler();
      startPipelineRunEventsRetentionScheduler();
      startHttpAccessLogRetentionScheduler();
      startHistoryRetentionScheduler();
      startLearnedScoringRefreshScheduler();
      startPostHirePulseScheduler();
      /* Candidate Status Check-in engine — runs DAILY, emails candidates whose
       * profile hasn't been updated in 6+ months (90-day per-candidate cooldown).
       * LinkedIn scanning inside it is optional and only activates when
       * ENRICH_LAYER_API_KEY is set; without it no third-party lookup happens.
       * Opt out via STATUS_CHECKIN_ENABLED=false. */
      if (process.env.STATUS_CHECKIN_ENABLED !== "false") {
        startLinkedInProfileMonitor();
      } else {
        logger.info("[status-checkin-scheduler] Disabled (STATUS_CHECKIN_ENABLED=false)");
      }
      startGraphReplyPollScheduler();
      /* Agent runs execute in-process; reconcile any left mid-flight by a prior
       * restart so their audit trail terminates and the UI stops spinning. */
      void reconcileStaleAgentRuns();
      /* Pipeline runs (routes/agents.ts + routes/pipeline.ts) also execute
       * in-process; flip any stuck past the staleness threshold to the distinct
       * terminal `interrupted` status (kept out of failure metrics). */
      void reconcileStalePipelineRuns();
    } else {
      logger.info("Schedulers disabled on this replica (SCHEDULER_LEADER=false)");
    }
    /* AI job queue worker — drains `ai_jobs` (interview scoring, summaries,
     * intelligence enrichment, match rescoring) that POST /interviews/:id/end
     * enqueues instead of running inline. Runs in-process by default so a single
     * deployment "just works". For horizontal scale, run the standalone
     * src/worker.ts process and set WORKER_INLINE=false here so the web replicas
     * stop competing for jobs. Gated to the scheduler leader to avoid every
     * replica spinning its own inline worker. */
    const workerInline = (process.env.WORKER_INLINE ?? "true").toLowerCase() !== "false";
    if (isSchedulerLeader && workerInline) {
      startAiWorker();
    } else {
      logger.info({ isSchedulerLeader, workerInline }, "Inline AI worker disabled — expecting a standalone worker process");
    }
    /* S3 bucket CORS is configured once per environment via Terraform/IaC
     * or the AWS console — NOT by this server. See docs/RELEASE_CHECKLIST.md
     * ("S3 bucket CORS") for the required policy and origins. The app's IAM
     * role intentionally lacks s3:PutBucketCORS. */
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE" && attempts < MAX_RETRIES) {
    logger.warn(
      { port, attempt: attempts, maxRetries: MAX_RETRIES },
      "Port still in use — retrying in 1 s",
    );
    setTimeout(startListening, 1_000);
  } else {
    logger.error({ err }, "Fatal error listening on port");
    process.exit(1);
  }
});

startListening();
