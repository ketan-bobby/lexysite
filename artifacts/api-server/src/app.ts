/**
 * app.ts — Express Application Factory
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Constructs and exports the Express app instance with all middleware and
 * routes mounted. Kept separate from index.ts so the app can be imported
 * for testing without binding to a port.
 *
 * ─── Middleware stack (in order) ─────────────────────────────────────────────
 *   cors()          Permissive in dev; restricted to CORS_ORIGIN in production.
 *                   Credentials: true so the browser can send cookies alongside
 *                   Bearer tokens (needed for candidate portal sessions).
 *   pino-http       Structured request/response logging. Strips query strings
 *                   from logged URLs and redacts auth headers automatically.
 *   express.json()  Parse JSON bodies (default 100kb limit).
 *   express.urlencoded() Parse form-encoded bodies.
 *   express.raw()   Raw binary body parser mounted ONLY at
 *                   /api/interviews/transcribe for audio chunk uploads.
 *                   Must be registered before express.json() takes over for
 *                   that path.
 *
 * ─── Route mount ─────────────────────────────────────────────────────────────
 *   GET /health     Health check endpoint (AWS ALB / ECS / EC2 Auto Scaling)
 *   /api/*          All API routes via the central router (routes/index.ts)
 *   /*              Static frontend serve (production only, when
 *                   FRONTEND_DIST_PATH is set). Serves the React SPA with a
 *                   catch-all that returns index.html for client-side routing.
 *
 * ─── Demo data seeding ───────────────────────────────────────────────────────
 * On startup, if the database is empty, seedDemoData() and seedClientHierarchy()
 * are called to populate the platform with realistic fixture data. This is
 * controlled by a flag in lib/seed.ts and never runs if rows already exist.
 */
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import { logger } from "./lib/logger";
import { httpAccessLogMiddleware } from "./lib/http-access-log";
import { withTenantContext } from "./middlewares/withTenantContext";
import { csrfOriginGuard } from "./middlewares/requireSameOriginPost";
import { seedDemoData } from "./lib/seed";
import { seedClientHierarchy } from "./lib/seedClients";

const app: Express = express();
// Trust exactly one proxy hop (the Replit platform proxy that fronts this
// container). With this set, `req.ip` is derived from the rightmost-trusted
// X-Forwarded-For entry instead of the client-controllable leftmost value,
// which is required for the per-IP rate limiter on /api/public/signup-checkout
// to be unspoofable.
app.set("trust proxy", 1);

const corsOrigin = process.env.CORS_ORIGIN;
app.use(
  cors(
    corsOrigin
      ? { origin: corsOrigin.split(",").map((o) => o.trim()), credentials: true }
      : undefined,
  ),
);

/* Security response headers via Helmet.
 *   - contentSecurityPolicy: disabled here because the Lexy SPA has not been
 *     audited for inline scripts/styles yet. Enable per-route once the front-
 *     end is CSP-clean. The other defaults (X-Content-Type-Options, frame-
 *     guard, Referrer-Policy, Cross-Origin-Opener/Resource-Policy, etc.) are
 *     safe to ship today.
 *   - HSTS starts at a SHORT max-age (1 day) so a misconfiguration during
 *     rollout can be backed out without bricking returning visitors for
 *     months. Bump to 15552000 (180 days) + `preload: true` once we've run
 *     in prod for a week without issues. */
app.use(
  helmet({
    contentSecurityPolicy: false,
    hsts: { maxAge: 86400, includeSubDomains: true },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    /* frameguard is disabled here and applied selectively below.
     * `/careers/:slug?embed=1` is an intentional cross-origin embed feature
     * (see lexy/src/components/jobs/ShareAndEmbedPanel.tsx) used by tenants
     * to drop a job card into their own marketing site. A blanket
     * X-Frame-Options: SAMEORIGIN would break that. */
    frameguard: false,
  }),
);

/* Selective X-Frame-Options: deny framing for every response EXCEPT the
 * public careers embed endpoints. Public careers pages may be served either
 * by the API (when this server hosts the SPA in prod) or via the public
 * JSON endpoint consumed by the embed iframe — both live under `/careers`
 * or `/api/public/careers`. */
app.use((req, res, next) => {
  const p = req.path;
  const isEmbeddable =
    p.startsWith("/careers/") ||
    p.startsWith("/api/public/careers/");
  if (!isEmbeddable) {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
  }
  next();
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

/* Durable copy of the pino-http access log. Mounted directly after pino-http so
 * it observes the same request lifecycle: on response `finish` it fire-and-forget
 * persists one row to the `http_access_logs` platform-ops table (the hosting
 * platform offers no log drain). Never blocks or fails the request. Captures
 * only method, registered route pattern, status, response time, ip, resolved
 * user/tenant, and requestId — never bodies, tokens, auth headers, or query
 * strings. See lib/http-access-log.ts. */
app.use(httpAccessLogMiddleware);

/* Stripe webhook needs RAW bytes for HMAC-SHA256 signature verification.
 * CRITICAL: this MUST be mounted BEFORE `express.json()` — otherwise the JSON
 * body parser consumes the request stream first and `express.raw()` sees an
 * empty buffer, causing every signature to fail to verify. The Stripe Dashboard
 * is configured to POST to https://www.l3xy.ai/api/billing/webhook. We capture
 * the raw buffer in `req.rawBody` and *also* parse it into `req.body` so the
 * downstream handler can read the JSON event without re-parsing. */
function rawBodyCapture(req: any, _res: any, next: any) {
  req.rawBody = req.body;
  try { req.body = JSON.parse((req.body as Buffer).toString("utf8")); } catch { req.body = {}; }
  next();
}
app.post("/api/billing/webhook", express.raw({ type: "application/json", limit: "1mb" }), rawBodyCapture);

/* 12mb JSON limit (default is 100kb): the "Send to hiring manager" package POSTs
 * a client-generated evaluation PDF as base64 (base64 inflates ~33%), which blew
 * past the default and returned 413 "request entity too large". */
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));
/* Cookie parser — required for the resumable interview-session cookie that
   binds candidate sessions to a fingerprint with HMAC + nonce. */
app.use(cookieParser());

/* Raw binary body for the session-scoped audio transcription endpoint
   (POST /api/interviews/:interviewId/transcribe). Regex-mounted so only that
   exact shape gets raw-body treatment; JSON routes are unaffected. */
app.use(/^\/api\/interviews\/[A-Za-z0-9_-]+\/transcribe$/, express.raw({ type: "*/*", limit: "10mb" }));

/* Health check — required by AWS ALB / ECS / EC2 Auto Scaling.
 *
 * NOTE the /api-mounted /healthz and /healthz/live (see routes/health.ts)
 * do a real DB ping and should be the readiness probe in production. This
 * unmounted /health is kept for legacy LB targets that point at it; it
 * also does a DB ping for honesty. */
app.get("/health", async (_req: Request, res: Response) => {
  const { healthCheck } = await import("./lib/health-check");
  const result = await healthCheck();
  res.status(result.ok ? 200 : 503).json(result.payload);
});

/* CSRF guard (Phase 3a-1) — conditional Origin/Referer check for
 * cookie-authenticated state-changing requests. Skips bearer-authed and
 * anonymous callers; explicit exemption list for machine/webhook/email-link
 * routes lives in requireSameOriginPost.ts (CSRF_EXEMPT). Must be mounted
 * after cookieParser() and before the /api router. */
app.use("/api", csrfOriginGuard);

/* RLS pilot — per-request tenant context.
 *
 * MUST be mounted before the /api router so the AsyncLocalStorage context
 * is in scope for every route handler. The middleware itself is a no-op
 * for unauthenticated and bypass-listed paths (webhooks, public endpoints,
 * candidate cookies); see withTenantContext.ts for the full bypass list.
 *
 * Pilot coverage: tables candidates, applications, interview_sessions.
 * Cross-tenant access on those 3 tables is now refused by Postgres itself
 * (RLS policy + lexy_app role) when called from within an authed request. */
app.use("/api", withTenantContext);

app.use("/api", router);

/* Serve the built Lexy frontend in production.
 * Set FRONTEND_DIST_PATH to the absolute path of the built frontend's
 * public folder (e.g. /app/lexy-dist or /workspace/artifacts/lexy/dist/public).
 * If not set, static serving is skipped (dev mode uses the Vite dev server). */
const frontendDist = process.env.FRONTEND_DIST_PATH;
if (frontendDist && fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));

  /* SPA fallback — all non-API routes serve index.html */
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });

  logger.info({ frontendDist }, "Serving frontend static files");
}

/* ── Global error handler ────────────────────────────────────────────────────
 * Captures everything any route handler or downstream middleware `throw`s
 * or `next(err)`s. Without this, Express's built-in handler returns a plain
 * 500 with a stack trace in dev (leaking internals to clients) and silently
 * logs nothing in prod. We log via pino AND persist to the system_errors
 * SQL table so a platform admin can see every 500 from the
 * GET /api/admin/system-errors dashboard.
 *
 * MUST be registered LAST — including AFTER the static / SPA fallback above
 * — so it catches errors thrown by sendFile, express.static, and any other
 * downstream handler. Express identifies error middleware by its 4-argument
 * signature; ordering still matters for which throws reach it. */
app.use(async (err: any, req: Request, res: Response, next: any) => {
  const statusCode = typeof err?.statusCode === "number" ? err.statusCode : 500;
  /* Log via pino first so even a DB-down error tracker doesn't lose the
   * stack trace. */
  (req as any).log?.error?.(
    { err, statusCode, route: req.path, method: req.method },
    "Unhandled error in request handler",
  );
  /* Persist to system_errors (fire-and-forget). */
  try {
    const { captureError } = await import("./lib/error-tracking");
    const ctx: any = {
      source: "express" as const,
      statusCode,
      method: req.method,
      routePath: req.path,
      requestId: (req as any).id ?? null,
      tenantId: (req as any).resolvedUser?.tenantId ?? null,
      userId: (req as any).resolvedUser?.id ?? null,
    };
    await captureError(err, ctx);
  } catch { /* never throw from the error handler */ }
  /* If the response is already partially written (streaming endpoints,
   * sendFile mid-flight), we cannot safely write a JSON body — delegate to
   * Express's default handler so the connection gets closed properly. */
  if (res.headersSent) {
    return next(err);
  }
  /* Don't leak stack traces to clients. */
  res.status(statusCode).json({
    error: statusCode >= 500 ? "Internal Server Error" : (err?.message ?? "Request failed"),
    ...((req as any).id ? { requestId: (req as any).id } : {}),
  });
});

// Seeding disabled — all demo data lives under the Linx tenant

export default app;
