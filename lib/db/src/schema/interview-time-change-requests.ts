import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { interviewSchedulesTable } from "./interviews";

// Server-private, fixed-purpose requests. No free-text availability or private calendar data.
export const interviewTimeChangeRequestsTable = pgTable(
  "interview_time_change_requests",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => interviewSchedulesTable.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id").notNull(),
    applicationId: text("application_id").notNull(),
    proposalVersion: text("proposal_version").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("interview_time_change_request_proposal").on(
      table.scheduleId,
      table.candidateId,
      table.applicationId,
      table.proposalVersion,
    ),
  ],
);
