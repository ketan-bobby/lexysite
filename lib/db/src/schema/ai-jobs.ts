/**
 * schema/ai-jobs.ts — Asynchronous AI Job Queue
 *
 * ─── Why this table exists ────────────────────────────────────────────────────
 * Live interviews used to run every expensive LLM step (per-answer grading,
 * post-interview summary, intelligence enrichment, candidate↔job rescoring)
 * INLINE inside the synchronous `POST /interviews/:id/end` request. With many
 * concurrent interviews that serialized 8+ OpenAI calls per request behind one
 * shared API key, making `/end` slow and starving the live `/converse` path.
 *
 * `ai_jobs` is a durable Postgres-backed work queue. `/end` now persists state
 * and ENQUEUES jobs; a separate worker drains them with retries, backoff and a
 * per-job timeout. Claiming uses `FOR UPDATE SKIP LOCKED` so any number of
 * worker processes can pull from the queue without double-processing a row.
 *
 * ─── Status lifecycle ────────────────────────────────────────────────────────
 *   pending     — waiting to be claimed (runAt <= now())
 *   processing  — claimed by a worker (lockedAt/lockedBy set)
 *   completed   — finished successfully (result stored)
 *   failed      — exhausted maxAttempts (lastError stored)
 *
 * A processing job whose lockedAt is older than the stuck-timeout is reclaimed
 * back to `pending` so a crashed worker never strands a job.
 */
import { pgTable, text, timestamp, integer, jsonb, pgEnum, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const aiJobStatusEnum = pgEnum("ai_job_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

/* Job types map 1:1 to a handler in src/lib/ai-queue/handlers.ts.
 * `transcribe_answer` is reserved for a future fully-async recording flow; the
 * current "keep-live" interview transcribes in real time and never enqueues it. */
export const aiJobTypeEnum = pgEnum("ai_job_type", [
  "score_answer",
  "summarize_interview",
  "match_candidate_to_job",
  "generate_candidate_insights",
  "transcribe_answer",
]);

export const aiJobsTable = pgTable("ai_jobs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /* Nullable: most jobs are tenant-scoped, but some platform-level work is not
     bound to a single tenant. The worker runs as the BYPASSRLS admin role. */
  tenantId: text("tenant_id"),
  type: aiJobTypeEnum("type").notNull(),
  status: aiJobStatusEnum("status").notNull().default("pending"),
  /* Arbitrary handler input (session id, scoring context, etc.). */
  payload: jsonb("payload").notNull().default({}),
  /* Handler output, stored on success for the admin dashboard / debugging. */
  result: jsonb("result"),
  /* Idempotency key (e.g. "summarize:<sessionId>"). When set, enqueueAiJob
     skips inserting a duplicate if a non-terminal or completed job already
     exists with the same key — so a retried /end never double-enqueues. */
  dedupeKey: text("dedupe_key"),
  /* Higher runs first. Live-adjacent work (summary) outranks bulk enrichment. */
  priority: integer("priority").notNull().default(0),
  /* Incremented at the start of every processing attempt. */
  retryCount: integer("retry_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  lastError: text("last_error"),
  /* Earliest time the job may be claimed. Backoff pushes this into the future
     after a failed attempt. */
  runAt: timestamp("run_at").notNull().defaultNow(),
  lockedAt: timestamp("locked_at"),
  lockedBy: text("locked_by"),
  /* Convenience FK for the admin dashboard: group jobs under their session. */
  interviewSessionId: text("interview_session_id"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  /* Atomic dedupe backstop: at most one LIVE job (pending/processing/completed)
     per dedupeKey. A `failed` terminal job is excluded so a fresh /end may
     re-enqueue the same work after a permanent failure. enqueueAiJob relies on
     this to make dedupe race-safe under concurrent /end calls — the pre-SELECT
     is just a fast path; this index is the source of truth (catches 23505). */
  dedupeLiveUq: uniqueIndex("ai_jobs_dedupe_live_uq")
    .on(table.dedupeKey)
    .where(sql`${table.dedupeKey} is not null and ${table.status} <> 'failed'`),
}));

export const insertAiJobSchema = createInsertSchema(aiJobsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAiJob = z.infer<typeof insertAiJobSchema>;
export type AiJob = typeof aiJobsTable.$inferSelect;
export type AiJobType = (typeof aiJobTypeEnum.enumValues)[number];
export type AiJobStatus = (typeof aiJobStatusEnum.enumValues)[number];
