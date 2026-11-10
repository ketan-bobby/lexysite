import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";

// Service-only tables: access is through fresh job/candidate and host checks.
export const meetingAssistantWorkspacesTable = pgTable("meeting_assistant_workspaces", {
  tenantId: text("tenant_id").primaryKey(),
  connectionId: text("connection_id").notNull(),
  revision: text("revision").notNull(),
  authorizedBy: text("authorized_by").notNull(),
  authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
export const meetingAttendanceTable = pgTable(
  "meeting_attendance",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    scheduleId: text("schedule_id").notNull(),
    hostUserId: text("host_user_id").notNull(),
    connectionId: text("connection_id").notNull(),
    workspaceRevision: text("workspace_revision").notNull(),
    contextHash: text("context_hash").notNull(),
    consentStatement: text("consent_statement").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    dispatchToken: text("dispatch_token"),
    state: text("state").notNull().default("approved"),
    botId: text("bot_id"),
    providerState: text("provider_state"),
    eventAt: timestamp("event_at", { withTimezone: true }),
    stopRequestedAt: timestamp("stop_requested_at", { withTimezone: true }),
    mediaDeletedAt: timestamp("media_deleted_at", { withTimezone: true }),
    importedNoteId: text("imported_note_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("meeting_attendance_appointment_unique")
      .on(t.scheduleId)
      .where(sql`${t.state} <> 'deleted'`),
    uniqueIndex("meeting_attendance_bot_unique").on(t.botId),
  ],
);
export const meetingAssistantEventsTable = pgTable("meeting_assistant_events", {
  id: text("id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
// A minimal, independently committed erasure intent. No candidate payloads or
// credentials; it survives rollback of an erasure held for remote cleanup.
export const meetingAssistantCleanupTable = pgTable("meeting_assistant_cleanup", {
  attemptId: text("attempt_id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertMeetingAttendanceSchema = createInsertSchema(meetingAttendanceTable);
export type MeetingAttendance = typeof meetingAttendanceTable.$inferSelect;
