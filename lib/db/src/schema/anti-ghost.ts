/**
 * schema/anti-ghost.ts — Anti-Ghosting & Nurture Pool Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   ghosting_alerts   — Open alerts raised when a candidate goes dark at a
 *                       pipeline stage (no-show / dropout / stale / offer limbo).
 *                       One row per open event; closed when resolved.
 *   nurture_pool      — Candidates who have truly gone cold and are being
 *                       re-engaged on a scheduled nurture cadence.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/anti-ghost-engine.ts  — reads/writes both tables
 *   routes/anti-ghost.ts      — exposes alert management API
 */
import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";

export const ghostingAlertsTable = pgTable("ghosting_alerts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  type: text("type").notNull(),
  severity: text("severity").notNull().default("medium"),
  status: text("status").notNull().default("open"),
  jobId: text("job_id"),
  candidateId: text("candidate_id"),
  applicationId: text("application_id"),
  enrollmentId: text("enrollment_id"),
  scheduleId: text("schedule_id"),
  candidateName: text("candidate_name"),
  description: text("description").notNull(),
  aiRecommendation: text("ai_recommendation"),
  suggestedAction: text("suggested_action"),
  resolvedBy: text("resolved_by"),
  resolvedAt: timestamp("resolved_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type GhostingAlert = typeof ghostingAlertsTable.$inferSelect;

export const nurturePoolTable = pgTable("nurture_pool", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  candidateName: text("candidate_name"),
  candidateEmail: text("candidate_email"),
  status: text("status").notNull().default("active"),
  cadenceDays: integer("cadence_days").notNull().default(90),
  reason: text("reason"),
  lastContactedAt: timestamp("last_contacted_at"),
  nextContactAt: timestamp("next_contact_at"),
  totalTouchpoints: integer("total_touchpoints").notNull().default(0),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export type NurturePoolMember = typeof nurturePoolTable.$inferSelect;
