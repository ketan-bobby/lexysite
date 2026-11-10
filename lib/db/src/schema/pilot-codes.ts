import { pgTable, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const pilotCodesTable = pgTable("pilot_codes", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  label: text("label").notNull(),
  maxRedemptions: integer("max_redemptions").notNull(),
  redemptionCount: integer("redemption_count").notNull().default(0),
  disabled: boolean("disabled").notNull().default(false),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const tenantPilotGrantsTable = pgTable("tenant_pilot_grants", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  codeId: text("code_id")
    .notNull()
    .references(() => pilotCodesTable.id),
  previousPlans: jsonb("previous_plans").notNull(),
  redeemedBy: text("redeemed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedBy: text("ended_by"),
});
