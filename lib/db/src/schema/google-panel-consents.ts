import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** Separate from Outlook sharing and from Google invitation permission. */
export const googlePanelConsentsTable = pgTable("google_panel_consents", {
  userId: text("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  connectionRevision: text("connection_revision").notNull(),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
});
