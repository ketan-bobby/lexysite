import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { usersTable } from "./users";

// Staff-only opt-in. Calendar OAuth alone does not grant panel sharing.
export const calendarPanelConsentsTable = pgTable("calendar_panel_consents", {
  userId: text("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  mailboxHash: text("mailbox_hash").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertCalendarPanelConsentSchema = createInsertSchema(calendarPanelConsentsTable);
export type CalendarPanelConsent = typeof calendarPanelConsentsTable.$inferSelect;
