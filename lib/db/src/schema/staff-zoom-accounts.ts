import { boolean, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { interviewSchedulesTable } from "./interviews";
import { candidatesTable } from "./candidates";

/** Staff-owned Zoom OAuth grants. The project connector cannot populate these rows. */
export const staffZoomAccountsTable = pgTable(
  "staff_zoom_accounts",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    revision: text("revision").notNull(),
    clientFingerprint: text("client_fingerprint").notNull(),
    zoomUserId: text("zoom_user_id"),
    email: text("email"),
    refreshTokenEnc: text("refresh_token_enc"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    flowHash: text("flow_hash"),
    browserHash: text("browser_hash"),
    flowExpiresAt: timestamp("flow_expires_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("staff_zoom_accounts_flow_unique").on(table.flowHash)],
);

/** Durable request state: an uncertain provider call can never auto-create twice. */
export const interviewZoomMeetingsTable = pgTable("interview_zoom_meetings", {
  scheduleId: text("schedule_id")
    .primaryKey()
    .references(() => interviewSchedulesTable.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull(),
  candidateId: text("candidate_id")
    .notNull()
    .references(() => candidatesTable.id),
  hostUserId: text("host_user_id")
    .notNull()
    .references(() => usersTable.id),
  hostZoomId: text("host_zoom_id").notNull(),
  operationId: text("operation_id").notNull(),
  status: text("status").notNull(),
  action: text("action").notNull(),
  meetingId: text("meeting_id"),
  joinUrl: text("join_url"),
  snapshotHash: text("snapshot_hash").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
});
