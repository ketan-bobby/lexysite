/**
 * Shared low-level retry helper for OpenAI API calls.
 *
 * Classification is based on the OpenAI SDK's APIError.status (with a
 * fallback for plain network errors that never got an HTTP status):
 * - Retryable: 429 (rate limit), 408 (request timeout), all 5xx, and
 *   connection-level failures (APIConnectionError / no status).
 * - Non-retryable: all other 4xx (400, 401, 403, 404, ...) — these are
 *   deterministic and will fail identically on every attempt.
 *
 * Callers supply their own tuning: the live voice/interview path uses few
 * retries with short backoff (a candidate is waiting); batch jobs use many
 * retries with long backoff.
 */
import pRetry, { AbortError } from "p-retry";
import { APIError } from "openai";

export interface RetryOptions {
  /** Number of retries after the first attempt. */
  retries: number;
  /** Initial backoff in ms. */
  minTimeout: number;
  /** Backoff ceiling in ms. */
  maxTimeout: number;
  /** Exponential factor (default 2). */
  factor?: number;
  /**
   * Custom retryability classifier. Defaults to isRetryableOpenAIError.
   * Callers with non-OpenAI processors (e.g. the generic batch runner)
   * can widen or replace the classification.
   */
  shouldRetry?: (error: unknown) => boolean;
}

export function isRetryableOpenAIError(error: unknown): boolean {
  if (error instanceof APIError) {
    const status = error.status;
    if (status === undefined) return true; // connection error, no response
    return status === 429 || status === 408 || status >= 500;
  }
  if (error instanceof Error) {
    // Non-APIError network failures (fetch/undici level).
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED" ||
      code === "EPIPE" ||
      error.name === "AbortError" ||
      error.name === "FetchError"
    ) {
      return true;
    }
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    retries,
    minTimeout,
    maxTimeout,
    factor = 2,
    shouldRetry = isRetryableOpenAIError,
  } = options;
  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (error: unknown) {
        if (shouldRetry(error)) {
          throw error; // retried by p-retry
        }
        throw new AbortError(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    { retries, minTimeout, maxTimeout, factor },
  );
}

/**
 * Live-path tuning: fail fast — worst case adds roughly
 * 250ms + 500ms of backoff across 2 retries before surfacing the error.
 */
export const LIVE_RETRY: RetryOptions = {
  retries: 2,
  minTimeout: 250,
  maxTimeout: 2000,
};
