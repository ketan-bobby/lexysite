/**
 * schema/notifications.ts — In-App Notification Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   candidate_notifications  — Bell-icon notifications shown to candidates in
 *                              the portal: interview invites, stage changes,
 *                              match alerts, re-engagement nudges.
 *   user_notifications       — Bell-icon notifications shown to recruiters /
 *                              admins: candidate reply alerts, screening results,
 *                              system alerts.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/notifications.ts     — notification list + mark-read API
 *   lib/outreach-engine.ts      — creates notifications on candidate reply
 */
import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const candidateNotificationsTable = pgTable("candidate_notifications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  actionUrl: text("action_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertNotificationSchema = createInsertSchema(candidateNotificationsTable).omit({ id: true, createdAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type CandidateNotification = typeof candidateNotificationsTable.$inferSelect;

export const userNotificationsTable = pgTable("user_notifications", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  actionUrl: text("action_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UserNotification = typeof userNotificationsTable.$inferSelect;
