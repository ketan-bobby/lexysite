import { pgTable, text, timestamp, integer, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

/** Numeric observations plus strictly whitelisted, non-secret receipt IDs.
 * Stored in the existing JSON column; no database migration is needed. */
export type VendorUsageUnits = Record<string, number | string | null>;

/** Internal operations only. No prompts, answers, audio, identities or invoices. */
export const vendorUsageAttemptsTable = pgTable(
  "vendor_usage_attempts",
  {
    id: text("id").primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    tenantId: text("tenant_id"),
    area: text("area").notNull(),
    provider: text("provider").notNull(),
    operation: text("operation").notNull(),
    model: text("model"),
    retryIndex: integer("retry_index"),
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    units: jsonb("units").$type<VendorUsageUnits>().notNull(),
    costStatus: text("cost_status").notNull().default("unknown"),
  },
  (t) => [
    index("vendor_usage_attempts_created_idx").on(t.createdAt),
    index("vendor_usage_attempts_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

export const insertVendorUsageAttemptSchema = createInsertSchema(vendorUsageAttemptsTable);
export type VendorUsageAttempt = typeof vendorUsageAttemptsTable.$inferSelect;
