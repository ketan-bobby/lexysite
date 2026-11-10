import { pgTable, text, timestamp, uniqueIndex, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { usersTable } from "./users";

/** Private staff authorization, never a project-wide connector grant. */
export const staffGoogleCalendarsTable = pgTable(
  "staff_google_calendars",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    revision: text("revision").notNull(),
    clientFingerprint: text("client_fingerprint").notNull(),
    subject: text("subject"),
    accountEmail: text("account_email"),
    refreshTokenEnc: text("refresh_token_enc"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    invitationConsent: boolean("invitation_consent").notNull().default(false),
    flowInvitations: boolean("flow_invitations").notNull().default(false),
    flowHash: text("flow_hash"),
    browserHash: text("browser_hash"),
    verifierEnc: text("verifier_enc"),
    nonceHash: text("nonce_hash"),
    flowExpiresAt: timestamp("flow_expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("staff_google_calendars_flow_unique").on(table.flowHash)],
);
export const insertStaffGoogleCalendarSchema = createInsertSchema(staffGoogleCalendarsTable);
export type StaffGoogleCalendar = typeof staffGoogleCalendarsTable.$inferSelect;
