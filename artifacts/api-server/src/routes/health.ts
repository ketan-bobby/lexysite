/**
 * routes/health.ts — API Health Check Endpoint
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Two endpoints used by infrastructure health checkers (AWS ALB target
 * groups, ECS service checks, uptime monitors):
 *
 *   GET /healthz   Deep health: pings Postgres with `SELECT 1` under a
 *                  2-second timeout. Returns 200 only if the DB responds.
 *                  Returns 503 with `{ status: "degraded", checks: {...} }`
 *                  if any dependency is unhealthy. THIS is the one load
 *                  balancers should use as the readiness probe — a server
 *                  whose database is unreachable can't serve traffic.
 *
 *   GET /healthz/live  Liveness only: returns 200 unconditionally. Use as
 *                      the LIVENESS probe — k8s/ECS should restart the
 *                      container only when the process itself is wedged,
 *                      not when Postgres is briefly flapping (otherwise
 *                      every transient DB blip restarts every replica).
 *
 * ─── Why this was rewritten (2026-05-16) ─────────────────────────────────────
 * Previously /healthz returned `{ status: "ok" }` unconditionally. That
 * meant the load balancer kept routing requests to a replica whose DB
 * connection pool was exhausted or whose DATABASE_URL was wrong — every
 * request 500'd while the LB cheerfully reported the target as healthy.
 * The deep check below makes the readiness signal honest.
 */
import { Router, type IRouter } from "express";
import { logger } from "../lib/logger";
import { healthCheck } from "../lib/health-check";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const result = await healthCheck();
  if (!result.ok) {
    logger.warn({ checks: result.payload.checks }, "[healthz] degraded");
    res.status(503).json(result.payload);
    return;
  }
  res.status(200).json(result.payload);
});

/* Liveness — minimal, dependency-free. The process is up, the event loop
 * is responsive enough to handle this request. Suitable for the liveness
 * (NOT readiness) probe. */
router.get("/healthz/live", (_req, res) => {
  res.status(200).json({ status: "alive", timestamp: new Date().toISOString() });
});

export default router;
