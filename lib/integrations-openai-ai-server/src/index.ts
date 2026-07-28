/**
 * Public entry point for the server-side OpenAI AI integration package.
 * Re-exports the shared openai client plus image generation and batch helpers.
 * (Audio helpers live under the ./audio subpath export.)
 */
export { openai } from "./client";
export { generateImageBuffer, editImages } from "./image";
export { batchProcess, batchProcessWithSSE, isRateLimitError, type BatchOptions } from "./batch";
