import assert from "node:assert/strict";
import test from "node:test";
import { meetingTranscriptHash } from "./meeting-notes-core";
import { meetingNotesExportReady, meetingNotesExportText } from "./meeting-notes-export";

const transcript = "😀 We launched the API. நன்றி.";
const exportedAt = new Date("2026-11-03T12:00:00.000Z");
const note = {
  id: "recording-fixture",
  candidateId: "candidate-fixture",
  jobId: "job-fixture",
  title: "Synthetic staff discussion",
  language: "en",
  status: "completed",
  transcript,
  summary: "Draft: the API launch was discussed.",
  plannedQuestions: "What launched?\nWhat is next?",
  consentAt: new Date("2026-11-02T12:00:00.000Z"),
  consentStatement: "Every participant consented to recording and AI processing.",
  updatedAt: new Date("2026-11-03T11:00:00.000Z"),
  questionReview: {
    revision: "review-fixture",
    sourceHash: meetingTranscriptHash(transcript)!,
    reviewedBy: "staff-fixture",
    reviewedAt: "2026-11-03T11:00:00.000Z",
    entries: [
      {
        questionIndex: 0,
        status: "covered" as const,
        excerpt: "We launched the API.",
        note: "Human-entered observation.",
        evidenceStart: 3,
        evidenceEnd: 23,
      },
    ],
  },
};

test("saved notes preserve Unicode source, draft boundaries, saved review and unreviewed questions", () => {
  const text = meetingNotesExportText(note, exportedAt);
  assert.ok(text.includes(transcript));
  for (const expected of [
    "NOT AN APPROVED HIRING ASSESSMENT",
    "Speakers are not identified",
    "unsaved edits are not included",
    "cannot recall downloaded copies",
    "STAFF ATTESTATION, NOT INDEPENDENT VERIFICATION",
    "Exported at: 2026-11-03T12:00:00.000Z",
    "Saved revision: review-fixture",
    "Reviewer reference: staff-fixture",
    "Staff status: Covered",
    "Staff status: Unreviewed",
    "Human-entered observation.",
    "UTF-16 text offsets, not audio timestamps",
  ])
    assert.ok(text.includes(expected), expected);
});

test("stale review evidence is not exported as applying to changed source", () => {
  const text = meetingNotesExportText(
    { ...note, transcript: transcript + " Changed." },
    exportedAt,
  );
  assert.match(text, /No review is saved for this transcript/);
  assert.doesNotMatch(text, /review-fixture|Human-entered observation/);
  assert.equal((text.match(/Staff status: Unreviewed/g) ?? []).length, 2);
});

test("failed summary still permits source export; missing summary and questions are honest", () => {
  const text = meetingNotesExportText(
    { ...note, status: "failed", summary: null, plannedQuestions: "", questionReview: null },
    exportedAt,
  );
  assert.match(text, /No saved summary is available/);
  assert.match(text, /No planned questions were recorded/);
  assert.ok(text.includes(transcript));
});

test("uploaded/processing and empty transcripts cannot produce misleading completed notes", () => {
  for (const input of [
    { ...note, status: "uploaded" },
    { ...note, status: "processing" },
    { ...note, transcript: null },
    { ...note, transcript: "  " },
  ]) {
    assert.equal(meetingNotesExportReady(input), false);
    assert.throws(() => meetingNotesExportText(input, exportedAt));
  }
});

test("exports explicitly select fields and never dump storage paths, process state or credentials", () => {
  const privateNote = {
    ...note,
    objectPath: "/objects/private-do-not-export",
    processingToken: "secret-process-token",
    createdBy: "private-creator",
    tenantId: "private-tenant",
    error: "internal-provider-error",
  };
  const text = meetingNotesExportText(privateNote, exportedAt);
  for (const privateValue of [
    privateNote.objectPath,
    privateNote.processingToken,
    privateNote.createdBy,
    privateNote.tenantId,
    privateNote.error,
  ])
    assert.ok(!text.includes(privateValue));
});

test("not-covered and cleared reviews never invent evidence or change the source", () => {
  const input = {
    ...note,
    questionReview: {
      ...note.questionReview,
      entries: [
        {
          ...note.questionReview.entries[0]!,
          status: "not_covered" as const,
          excerpt: "",
          note: "",
          evidenceStart: null,
          evidenceEnd: null,
        },
      ],
    },
  };
  assert.match(meetingNotesExportText(input, exportedAt), /Staff status: Not covered/);
  assert.doesNotMatch(meetingNotesExportText(input, exportedAt), /Verbatim excerpt:/);
  const cleared = meetingNotesExportText(
    { ...note, questionReview: { ...note.questionReview, entries: [] } },
    exportedAt,
  );
  assert.equal((cleared.match(/Staff status: Unreviewed/g) ?? []).length, 2);
  assert.ok(cleared.includes(transcript));
});
