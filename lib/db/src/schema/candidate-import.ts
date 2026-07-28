/**
 * schema/candidate-import.ts — Bulk Candidate Import Batch & Record Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_import_batches  — One row per CSV upload. Tracks total/processed/
 *                               failed counts, status, and source metadata.
 *   candidate_import_records  — One row per CSV row. Stores the raw input JSON,
 *                               validation errors, and the resulting candidateId
 *                               once successfully inserted.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/candidate-import.ts  — batch creation and per-record status API
 *   lib/seed.ts                 — not used; import is always user-driven
 */
import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

export const candidateImportStatusEnum = [
  "uploaded",
  "parsed",
  "imported",
  "duplicate_updated",
  "duplicate_skipped",
  "failed",
  "needs_review",
] as const;

export type CandidateImportStatus = typeof candidateImportStatusEnum[number];

/**
 * One row per import batch (a single call from the .NET API may import many
 * resumes — this table tracks the batch-level stats).
 */
export const candidateImportBatchesTable = pgTable("candidate_import_batches", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  source:      text("source").notNull().default("bulk_resume_import"),
  tenantId:    text("tenant_id"),          // null = platform pool; set = tenant-private import
  initiatedBy: text("initiated_by"),
  totalFiles:  text("total_files"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
  updatedAt:   timestamp("updated_at").notNull().defaultNow(),
});

/**
 * One row per individual resume/candidate import attempt within a batch.
 */
export const candidateImportRecordsTable = pgTable("candidate_import_records", {
  id:           text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  batchId:      text("batch_id"),
  tenantId:     text("tenant_id"),         // mirrors the batch tenantId for easy filtering
  fileName:     text("file_name"),
  status:       text("status").notNull().default("uploaded"),
  candidateId:  text("candidate_id"),
  errorMessage: text("error_message"),
  parsedData:   jsonb("parsed_data"),
  createdAt:    timestamp("created_at").notNull().defaultNow(),
  updatedAt:    timestamp("updated_at").notNull().defaultNow(),
});
