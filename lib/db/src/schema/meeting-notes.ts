import { pgTable, text, timestamp, integer, index, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { candidatesTable } from "./candidates";
import { jobsTable } from "./jobs";

export interface MeetingSpeakerEvidence {
  revision: string;
  generatedAt: string;
  provider: "deepgram";
  model: string;
  diarizerModel: "v1";
  diarizerBuild: string;
  segments: Array<{ speaker: number; start: number; end: number; text: string }>;
  review?: {
    revision: string;
    reviewedBy: string;
    reviewedAt: string;
    labels: Array<{
      speaker: number;
      label: string;
      role: "candidate" | "interviewer" | "other" | "unknown";
    }>;
  };
}

export interface MeetingQuestionReview {
  revision: string;
  sourceHash: string;
  reviewedBy: string;
  reviewedAt: string;
  entries: Array<{
    questionIndex: number;
    status: "covered" | "partial" | "not_covered";
    excerpt: string;
    note: string;
    evidenceStart: number | null;
    evidenceEnd: number | null;
  }>;
}

/** Private human-interview source material; never an assessment/scoring input. */
export const meetingNotesTable = pgTable(
  "meeting_notes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidatesTable.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull(),
    title: text("title").notNull(),
    language: text("language").notNull(),
    consentAt: timestamp("consent_at", { withTimezone: true }).notNull(),
    consentStatement: text("consent_statement").notNull(),
    plannedQuestions: text("planned_questions").notNull().default(""),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    objectPath: text("object_path").notNull(),
    status: text("status").notNull().default("uploaded"),
    processingToken: text("processing_token"),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    transcript: text("transcript"),
    summary: text("summary"),
    questionReview: jsonb("question_review").$type<MeetingQuestionReview>(),
    speakerEvidence: jsonb("speaker_evidence").$type<MeetingSpeakerEvidence>(),
    sourceKey: text("source_key"),
    nativeSource: jsonb("native_source").$type<{
      provider: "zoom" | "google_meet" | "recall";
      scheduleId: string;
      meetingId: string;
      meetingUuid: string;
      fileId: string;
      hostUserId: string;
      recordingStart: string;
      recordingEnd: string;
    }>(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("meeting_notes_candidate_job_idx").on(table.candidateId, table.jobId),
    uniqueIndex("meeting_notes_source_key_unique").on(table.sourceKey),
  ],
);
