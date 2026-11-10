import type { meetingNotesTable } from "@workspace/db";
import { meetingQuestions, meetingTranscriptHash } from "./meeting-notes-core";

type ExportNote = Pick<
  typeof meetingNotesTable.$inferSelect,
  | "id"
  | "candidateId"
  | "jobId"
  | "title"
  | "language"
  | "status"
  | "transcript"
  | "summary"
  | "plannedQuestions"
  | "questionReview"
  | "consentAt"
  | "consentStatement"
  | "updatedAt"
>;

export function meetingNotesExportReady(note: Pick<ExportNote, "status" | "transcript">) {
  return (
    (note.status === "completed" || note.status === "failed") &&
    meetingTranscriptHash(note.transcript) !== null
  );
}

/** Explicit fields only. No storage paths, credentials, media bytes or process state. */
export function meetingNotesExportText(note: ExportNote, exportedAt: Date): string {
  if (!meetingNotesExportReady(note)) throw new Error("Saved transcript unavailable.");
  const hash = meetingTranscriptHash(note.transcript)!;
  const review = note.questionReview?.sourceHash === hash ? note.questionReview : null;
  const questions = meetingQuestions(note.plannedQuestions);
  const lines = [
    "LEXY — PRIVATE STAFF MEETING NOTES",
    "SOURCE MATERIAL — NOT AN APPROVED HIRING ASSESSMENT",
    "",
    "Transcripts and AI summaries are drafts. Verify against the recording.",
    "Speakers are not identified. Coverage notes are manually entered by staff.",
    "This file is a snapshot of SAVED notes; unsaved edits are not included.",
    "Keep this file private. Later access revocation or deletion in Lexy cannot recall downloaded copies.",
    "",
    `Exported at: ${exportedAt.toISOString()}`,
    `Notes last updated: ${note.updatedAt.toISOString()}`,
    `Recording reference: ${note.id}`,
    `Candidate reference: ${note.candidateId}`,
    `Job reference: ${note.jobId}`,
    `Title: ${note.title}`,
    `Language: ${note.language}`,
    `Processing status: ${note.status}`,
    `Transcript SHA-256: ${hash}`,
    "",
    "CONSENT — STAFF ATTESTATION, NOT INDEPENDENT VERIFICATION",
    `Recorded at: ${note.consentAt.toISOString()}`,
    note.consentStatement,
    "",
    "TRANSCRIPT — DRAFT, SPEAKERS UNLABELLED",
    note.transcript!,
    "",
    "SUMMARY — AI-GENERATED DRAFT, NOT A HIRING RECOMMENDATION",
    note.summary?.trim() ? note.summary : "No saved summary is available.",
    "",
    "PLANNED QUESTION REVIEW — HUMAN-ENTERED SOURCE NOTES",
    review
      ? `Saved revision: ${review.revision}\nReviewed at: ${review.reviewedAt}\nReviewer reference: ${review.reviewedBy}`
      : "No review is saved for this transcript.",
    "Evidence positions below are UTF-16 text offsets, not audio timestamps.",
  ];
  if (!questions.length) lines.push("No planned questions were recorded.");
  questions.forEach((question, questionIndex) => {
    const entry = review?.entries.find((item) => item.questionIndex === questionIndex);
    const status = entry
      ? { covered: "Covered", partial: "Partly covered", not_covered: "Not covered" }[entry.status]
      : "Unreviewed";
    lines.push("", `${questionIndex + 1}. ${question}`, `Staff status: ${status}`);
    if (entry?.excerpt) {
      lines.push(
        `Source text offsets: ${entry.evidenceStart}–${entry.evidenceEnd}`,
        "Verbatim excerpt:",
        entry.excerpt,
      );
    }
    if (entry?.note) lines.push("Staff comment:", entry.note);
  });
  lines.push("", "END OF SAVED SOURCE NOTES", "");
  return lines.join("\n");
}
