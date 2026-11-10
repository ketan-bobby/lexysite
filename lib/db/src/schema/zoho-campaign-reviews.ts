import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { zohoCampaignRecipientsTable } from "./zoho-interview-campaigns";

export const zohoCampaignReviewsTable = pgTable("zoho_campaign_reviews", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  campaignId: text("campaign_id").notNull(),
  recipientId: text("recipient_id")
    .notNull()
    .references(() => zohoCampaignRecipientsTable.id, { onDelete: "cascade" }),
  candidateId: text("candidate_id").notNull(),
  sessionId: text("session_id").notNull(),
  decision: text("decision").notNull(),
  reason: text("reason").notNull(),
  evidenceHash: text("evidence_hash").notNull(),
  previousReviewId: text("previous_review_id"),
  reviewedBy: text("reviewed_by").notNull(),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertZohoCampaignReviewSchema = createInsertSchema(zohoCampaignReviewsTable);
export type InsertZohoCampaignReview = z.infer<typeof insertZohoCampaignReviewSchema>;
