import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { interviewSchedulesTable } from "./interviews";

// Private staff approval, not a Zoom provider receipt. Null URL is a tombstone.
export const interviewZoomLinksTable = pgTable("interview_zoom_links", {
  scheduleId: text("schedule_id")
    .primaryKey()
    .references(() => interviewSchedulesTable.id, { onDelete: "cascade" }),
  publicationId: text("publication_id").notNull(),
  publisherId: text("publisher_id").notNull(),
  applicationId: text("application_id").notNull(),
  candidateId: text("candidate_id").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  joinUrl: text("join_url"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});
