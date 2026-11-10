import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { interviewSchedulesTable } from "./interviews";

export type CalendarInvitationChange = {
  id: string;
  version: string;
  approvalVersion: string;
  eventId: string;
  sourceEtag: string;
  mailboxId: string;
  start: string;
  end: string;
  previousStart: string;
  previousEnd: string;
  attemptedAt: string;
  acceptedAt: string | null;
};

export type GoogleInvitationOperation = {
  id: string;
  priorId: string | null;
  kind: "reschedule" | "cancel";
  nativeVersion: string;
  targetSnapshotHash: string;
  sourceEtag: string;
  previousStart: string;
  previousEnd: string;
  targetStart: string | null;
  targetEnd: string | null;
  meetUrl: string | null;
  approvalHash: string;
  attemptedAt: string;
  acceptedAt: string | null;
};

export type PanelInvitationSnapshot = {
  approvalToken: string;
  organizerMailboxHash: string;
  organizerEmailHash: string;
  recipients: Array<{ userId: string; mailboxHash: string; emailHash: string }>;
};

// Durable intent BEFORE a provider mutation. There is no automatic resend.
export const interviewCalendarInvitationAttemptsTable = pgTable(
  "interview_calendar_invitation_attempts",
  {
    scheduleId: text("schedule_id")
      .primaryKey()
      .references(() => interviewSchedulesTable.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id").notNull(),
    applicationId: text("application_id").notNull(),
    organizerId: text("organizer_id").notNull(),
    recipientHash: text("recipient_hash").notNull(),
    scheduleVersion: text("schedule_version").notNull(),
    transactionId: text("transaction_id").notNull(),
    status: text("status").notNull(), // attempted | accepted; unknown stays attempted
    provider: text("provider").notNull().default("outlook"),
    googleSnapshot: jsonb("google_snapshot").$type<{
      connectionRevision: string;
      subjectHash: string;
      snapshotHash: string;
      candidateSnapshotHash?: string;
      meetUrl: string | null;
      conferenceStatus: "pending" | "ready" | "failed";
      operations?: GoogleInvitationOperation[];
      // Recipient hashes only; invitation permission remains organizer-owned.
      panelSnapshot?: { revision: string; binding: string };
    }>(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    eventId: text("event_id"),
    // Append a committed intent before PATCH; never replace the original send receipt.
    changes: jsonb("changes").$type<CalendarInvitationChange[]>().notNull().default([]),
    panelSnapshot: jsonb("panel_snapshot").$type<PanelInvitationSnapshot>(),
  },
);
