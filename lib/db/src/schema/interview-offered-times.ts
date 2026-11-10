import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { interviewSchedulesTable } from "./interviews";

// Private scheduling state. Access is through explicitly authorized server
// paths only; ordinary tenant membership grants no reads or writes.
export const interviewOfferedTimesTable = pgTable("interview_offered_times", {
  scheduleId: text("schedule_id")
    .primaryKey()
    .references(() => interviewSchedulesTable.id, { onDelete: "cascade" }),
  candidateId: text("candidate_id").notNull(),
  applicationId: text("application_id").notNull(),
  proposalVersion: text("proposal_version").notNull(),
  version: text("version").notNull(),
  alternatives: jsonb("alternatives").$type<string[]>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
