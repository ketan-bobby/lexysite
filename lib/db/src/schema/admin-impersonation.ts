/**
 * schema/admin-impersonation.ts — admin_impersonation_sessions (Migration 0017)
 *
 * SOC2 CC6.6 audit. Every "view as" session opened by a platform_admin
 * is a row here. Only ended_at + ended_reason may be mutated after
 * insert (enforced by DB trigger). Deletes are blocked. The session
 * token issued in this row is what the impersonation middleware
 * checks on every request, so a leaked admin banner cannot give
 * indefinite access — the row's expires_at is the hard cap.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const adminImpersonationSessionsTable = pgTable("admin_impersonation_sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  platformAdminUserId: text("platform_admin_user_id").notNull(),
  impersonatedUserId: text("impersonated_user_id").notNull(),
  impersonatedTenantId: text("impersonated_tenant_id"),
  reason: text("reason").notNull(),
  sessionToken: text("session_token").notNull().unique(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endedReason: text("ended_reason"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AdminImpersonationSession = typeof adminImpersonationSessionsTable.$inferSelect;
