/**
 * batch/utils.ts — Concurrency-limited, auto-retrying batch runner for LLM/API calls.
 * Provides batchProcess (parallel with p-limit + shared withRetry) and
 * batchProcessWithSSE (sequential, emitting Server-Sent-Event progress).
 * Retry classification lives in ../shared/retry (429/408/5xx/network are
 * retryable; other 4xx abort immediately). isRateLimitError remains exported
 * for backward compatibility but is no longer used internally.
 */
import pLimit from "p-limit";

import { withRetry, isRetryableOpenAIError } from "../shared/retry";

/**
 * Batch retry classification: legacy generic rate-limit message heuristic
 * (works for any provider whose errors mention 429/quota/rate limit) OR the
 * OpenAI status-based classification (429/408/5xx/network). Preserves the
 * pre-refactor generic batch contract while gaining 5xx/network coverage.
 */
const batchShouldRetry = (error: unknown): boolean =>
  isRateLimitError(error) || isRetryableOpenAIError(error);

/**
 * Batch Processing Utilities
 *
 * Generic batch processing with built-in rate limiting and automatic retries.
 * Use for any task that requires processing multiple items through an LLM or external API.
 *
 * USAGE:
 * ```typescript
 * import { batchProcess } from "@workspace/integrations-openai-ai-server/batch";
 * import { openai } from "@workspace/integrations-openai-ai-server";
 *
 * const results = await batchProcess(
 *   artworks,
 *   async (artwork) => {
 *     const response = await openai.chat.completions.create({
 *       model: "gpt-5.2",
 *       messages: [{ role: "user", content: `Categorize: ${artwork.name}` }],
 *       response_format: { type: "json_object" },
 *     });
 *     return JSON.parse(response.choices[0]?.message?.content || "{}");
 *   },
 *   { concurrency: 2, retries: 5 }
 * );
 * ```
 */

export interface BatchOptions {
  concurrency?: number;
  retries?: number;
  minTimeout?: number;
  maxTimeout?: number;
  onProgress?: (completed: number, total: number, item: unknown) => void;
}

export function isRateLimitError(error: unknown): boolean {
  const errorMsg = error instanceof Error ? error.message : String(error);
  return (
    errorMsg.includes("429") ||
    errorMsg.includes("RATELIMIT_EXCEEDED") ||
    errorMsg.toLowerCase().includes("quota") ||
    errorMsg.toLowerCase().includes("rate limit")
  );
}

export async function batchProcess<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  options: BatchOptions = {}
): Promise<R[]> {
  const {
    concurrency = 2,
    retries = 7,
    minTimeout = 2000,
    maxTimeout = 128000,
    onProgress,
  } = options;

  const limit = pLimit(concurrency);
  let completed = 0;

  const promises = items.map((item, index) =>
    limit(() =>
      withRetry(
        async () => {
          const result = await processor(item, index);
          completed++;
          onProgress?.(completed, items.length, item);
          return result;
        },
        { retries, minTimeout, maxTimeout, factor: 2, shouldRetry: batchShouldRetry }
      )
    )
  );

  return Promise.all(promises);
}

export async function batchProcessWithSSE<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  sendEvent: (event: { type: string; [key: string]: unknown }) => void,
  options: Omit<BatchOptions, "concurrency" | "onProgress"> = {}
): Promise<R[]> {
  const { retries = 5, minTimeout = 1000, maxTimeout = 15000 } = options;

  sendEvent({ type: "started", total: items.length });

  const results: R[] = [];
  let errors = 0;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    sendEvent({ type: "processing", index, item });

    try {
      const result = await withRetry(
        () => processor(item, index),
        { retries, minTimeout, maxTimeout, factor: 2, shouldRetry: batchShouldRetry }
      );
      results.push(result);
      sendEvent({ type: "progress", index, result });
    } catch (error) {
      errors++;
      results.push(undefined as R);
      sendEvent({
        type: "progress",
        index,
        error: error instanceof Error ? error.message : "Processing failed",
      });
    }
  }

  sendEvent({ type: "complete", processed: items.length, errors });
  return results;
}
