import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const zohoInterviewCampaignsTable = pgTable("zoho_interview_campaigns", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  accountRef: text("account_ref").notNull(),
  revision: text("revision").notNull(),
  jobId: text("job_id").notNull(),
  externalJobId: text("external_job_id").notNull(),
  planId: text("plan_id").notNull(),
  frozenPlanId: text("frozen_plan_id"),
  requestId: text("request_id").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  briefHash: text("brief_hash").notNull(),
  applicationCount: integer("application_count").notNull(),
  state: text("state").notNull().default("draft"),
  dispatchLane: text("dispatch_lane").$type<"live" | "isolated_test">().notNull().default("live"),
  createdBy: text("created_by").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const zohoCampaignRecipientsTable = pgTable("zoho_campaign_recipients", {
  id: text("id").primaryKey(),
  campaignId: text("campaign_id")
    .notNull()
    .references(() => zohoInterviewCampaignsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  accountRef: text("account_ref").notNull(),
  externalJobId: text("external_job_id").notNull(),
  externalApplicationId: text("external_application_id").notNull(),
  externalCandidateId: text("external_candidate_id").notNull(),
  candidateId: text("candidate_id"),
  sessionId: text("session_id"),
  state: text("state").notNull().default("draft"),
  reason: text("reason"),
  messageId: text("message_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertZohoInterviewCampaignSchema = createInsertSchema(zohoInterviewCampaignsTable);
export type InsertZohoInterviewCampaign = z.infer<typeof insertZohoInterviewCampaignSchema>;
export const insertZohoCampaignRecipientSchema = createInsertSchema(zohoCampaignRecipientsTable);
export type InsertZohoCampaignRecipient = z.infer<typeof insertZohoCampaignRecipientSchema>;
