/**
 * logger.ts — Application Logger (Pino)
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Exports a single pino logger instance used everywhere in the API server.
 * Centralising it here means log level, transport, and redaction rules are
 * configured once and applied consistently across all modules.
 *
 * ─── Configuration ───────────────────────────────────────────────────────────
 *   LOG_LEVEL env var   Controls verbosity (default "info").
 *                       Values: "trace" | "debug" | "info" | "warn" | "error" | "fatal"
 *
 *   Production          JSON output (newline-delimited) for log aggregators
 *                       (Datadog, CloudWatch, etc.).
 *
 *   Development         pino-pretty transport for coloured, human-readable output.
 *
 * ─── Redaction ───────────────────────────────────────────────────────────────
 * Authorization headers and cookies are redacted automatically so access tokens
 * and session cookies never appear in log output — even at "trace" level.
 */
import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
