import { pgTable, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { interviewSchedulesTable } from "./interviews";

export type SavedOutlookPanelMember = { userId: string; mailboxHash: string; grantedAt: string };
export type SavedGooglePanelMember = {
  provider: "google";
  userId: string;
  connectionRevision: string;
  subjectHash: string;
  grantedAt: string;
};
// Untagged legacy Outlook rows remain valid. Google bindings are never represented
// by synthetic Outlook mailbox identifiers.
export type SavedPanelMember = SavedOutlookPanelMember | SavedGooglePanelMember;
export const interviewSchedulePanelsTable = pgTable("interview_schedule_panels", {
  scheduleId: text("schedule_id")
    .primaryKey()
    .references(() => interviewSchedulesTable.id, { onDelete: "cascade" }),
  revision: text("revision").notNull(),
  coordinatorId: text("coordinator_id").notNull(),
  members: jsonb("members").$type<SavedPanelMember[]>().notNull(),
  bufferMinutes: integer("buffer_minutes").notNull(),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertInterviewSchedulePanelSchema = createInsertSchema(interviewSchedulePanelsTable);
export type InterviewSchedulePanel = typeof interviewSchedulePanelsTable.$inferSelect;
