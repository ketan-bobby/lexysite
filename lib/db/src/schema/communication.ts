/**
 * schema/communication.ts — Communication Events & Ghosting Risk Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   communication_events   — Immutable log of every outbound/inbound touchpoint
 *                            between Lexy and a candidate (email sent, reply
 *                            received, interview booked, etc.). Drives ghosting
 *                            detection and the communication health dashboard.
 *   ghosting_risks         — Computed risk assessment rows: one per
 *                            candidate+job, updated after each communication event.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   communication_type     — outreach · interview · invite · rejection · re_engagement
 *   communication_channel  — email · sms · in_app · linkedin
 *   communication_event_status — sent · delivered · opened · replied · bounced · failed
 *   ghosting_risk_level    — low · medium · high · critical
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/communication.ts      — communication event API
 *   lib/anti-ghost-engine.ts     — ghosting detection reads these tables
 */
import { pgTable, text, timestamp, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const communicationTypeEnum = pgEnum("communication_type", [
  "interview_reminder",
  "scheduling_nudge",
  "follow_up",
  "next_steps",
  "re_engagement",
  "status_update",
]);

export const communicationChannelEnum = pgEnum("communication_channel", [
  "email",
  "sms",
  "whatsapp",
]);

export const communicationStatusEnum = pgEnum("communication_event_status", [
  "pending",
  "sent",
  "delivered",
  "opened",
  "failed",
]);

export const ghostingRiskLevelEnum = pgEnum("ghosting_risk_level", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const communicationEventsTable = pgTable("communication_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  applicationId: text("application_id"),
  type: communicationTypeEnum("type").notNull(),
  channel: communicationChannelEnum("channel").notNull().default("email"),
  status: communicationStatusEnum("status").notNull().default("pending"),
  subject: text("subject"),
  body: text("body").notNull(),
  sentAt: timestamp("sent_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const ghostingRisksTable = pgTable("ghosting_risk_flags", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  applicationId: text("application_id").notNull(),
  riskLevel: ghostingRiskLevelEnum("risk_level").notNull().default("low"),
  daysSinceLastContact: integer("days_since_last_contact").notNull().default(0),
  lastContactType: text("last_contact_type"),
  nextRequiredAction: text("next_required_action"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCommunicationEventSchema = createInsertSchema(communicationEventsTable).omit({ id: true, createdAt: true });
export type InsertCommunicationEvent = z.infer<typeof insertCommunicationEventSchema>;
export type CommunicationEvent = typeof communicationEventsTable.$inferSelect;
