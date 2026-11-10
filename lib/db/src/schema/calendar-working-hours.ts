import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { usersTable } from "./users";

export const calendarWorkingHoursTable = pgTable("calendar_working_hours", {
  userId: text("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  revision: text("revision").notNull(),
  timeZone: text("time_zone"),
  windows: jsonb("windows").$type<Array<{ day: number; start: string; end: string }>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertCalendarWorkingHoursSchema = createInsertSchema(calendarWorkingHoursTable);
export type CalendarWorkingHours = typeof calendarWorkingHoursTable.$inferSelect;
