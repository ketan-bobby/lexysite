import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import {
  zohoInterviewCampaignsTable,
  zohoCampaignRecipientsTable,
} from "./zoho-interview-campaigns";

export const zohoStageMappingsTable = pgTable("zoho_stage_mappings", {
  campaignId: text("campaign_id")
    .primaryKey()
    .references(() => zohoInterviewCampaignsTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  revision: text("revision").notNull(),
  advance: text("advance"),
  hold: text("hold"),
  decline: text("decline"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const zohoStageHandoffEventsTable = pgTable("zoho_stage_handoff_events", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  campaignId: text("campaign_id").notNull(),
  recipientId: text("recipient_id")
    .notNull()
    .references(() => zohoCampaignRecipientsTable.id, { onDelete: "cascade" }),
  candidateId: text("candidate_id").notNull(),
  requestId: text("request_id").notNull(),
  requestHash: text("request_hash").notNull(),
  reviewRevision: text("review_revision").notNull(),
  mappingRevision: text("mapping_revision").notNull(),
  decision: text("decision").notNull(),
  targetStatus: text("target_status").notNull(),
  state: text("state").notNull(),
  approvedBy: text("approved_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
