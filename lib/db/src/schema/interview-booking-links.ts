import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { interviewSchedulesTable } from "./interviews";

// Server-private bearer grants. Never persist the raw token.
export const interviewBookingLinksTable = pgTable("interview_booking_links", {
  scheduleId: text("schedule_id")
    .primaryKey()
    .references(() => interviewSchedulesTable.id, { onDelete: "cascade" }),
  candidateId: text("candidate_id").notNull(),
  applicationId: text("application_id").notNull(),
  proposalVersion: text("proposal_version").notNull(),
  offerVersion: text("offer_version"),
  version: text("version").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  selectedAt: timestamp("selected_at", { withTimezone: true }),
  confirmedVersion: text("confirmed_version"),
});
