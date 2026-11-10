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
// Node's test workers must not spawn a pretty-print transport thread: forced
// runner shutdown can deadlock Pino's synchronous transport flush.
const isTestWorker = Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === "test";

export function serializeApplicationError(error: unknown) {
  let cause: any = error;
  for (let depth = 0; cause && depth < 5; depth++, cause = cause.cause) {
    if (cause.message === "candidate_erased") {
      // Drizzle error wrappers contain SQL parameters: logging them would
      // retain the stale private result that the write barrier just rejected.
      return { type: "CandidateErased", message: "candidate_erased" };
    }
  }
  return pino.stdSerializers.err(error as Error);
}

export const logger = pino({
  serializers: { err: serializeApplicationError, error: serializeApplicationError },
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction || isTestWorker
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
