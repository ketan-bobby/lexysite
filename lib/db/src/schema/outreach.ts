/**
 * schema/outreach.ts — Outreach Campaign & Recruiter Inbox Tables
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   outreach_campaigns      — One row per recruiter campaign. Defines the name,
 *                             target ICP, enrolled/sent/replied counts, A/B test
 *                             config, and active/paused status.
 *   recruiter_inbox_items   — Notification items that appear in the recruiter's
 *                             reply inbox: candidate replies, question flags,
 *                             re-engagement signals.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   campaign_status   — draft · active · paused · completed · archived
 *   inbox_item_type   — interested · question · referral · not_interested ·
 *                       unsubscribe · re_engagement · out_of_office
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/outreach-engine.ts     — reads campaigns, creates inbox items on reply
 *   routes/outreach.ts         — campaign CRUD and inbox API
 */
import { pgTable, text, timestamp, integer, real, boolean, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const campaignStatusEnum = pgEnum("campaign_status", [
  "draft",
  "active",
  "paused",
  "completed",
  "stopped",
]);

export const inboxItemTypeEnum = pgEnum("inbox_item_type", [
  "positive_reply",
  "question",
  "negative_reply",
  "unsubscribe",
  "needs_followup",
]);

export const outreachCampaignsTable = pgTable("outreach_campaigns", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id").notNull(),
  name: text("name").notNull(),
  status: campaignStatusEnum("status").notNull().default("draft"),
  autopilotEnabled: boolean("autopilot_enabled").notNull().default(false),
  targetPositiveReplies: integer("target_positive_replies"),
  enrollmentThresholdScore: real("enrollment_threshold_score"),
  enrolledCount: integer("enrolled_count").notNull().default(0),
  repliedCount: integer("replied_count").notNull().default(0),
  positiveRepliesCount: integer("positive_replies_count").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  openRate: real("open_rate").notNull().default(0),
  replyRate: real("reply_rate").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const recruiterInboxTable = pgTable("recruiter_inbox_items", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  type: inboxItemTypeEnum("type").notNull(),
  candidateId: text("candidate_id").notNull(),
  campaignId: text("campaign_id").notNull(),
  subject: text("subject").notNull(),
  preview: text("preview").notNull(),
  body: text("body"),
  /**
   * Inline image attachments referenced by `[cid:xxx]` tokens in `body`.
   * Each item: { cid, url, filename?, contentType? }. Currently populated for
   * demo rows; webhook-driven population (mailparser → object storage) is
   * deferred to a follow-up task.
   */
  attachments: jsonb("attachments").$type<Array<{
    cid: string;
    url: string;
    filename?: string;
    contentType?: string;
  }>>(),
  isRead: boolean("is_read").notNull().default(false),
  priority: text("priority").notNull().default("normal"),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
});

export const insertCampaignSchema = createInsertSchema(outreachCampaignsTable).omit({ id: true, createdAt: true });
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof outreachCampaignsTable.$inferSelect;
