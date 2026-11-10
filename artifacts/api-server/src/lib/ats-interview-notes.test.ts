import assert from "node:assert/strict";
import { test } from "node:test";
import { assessmentNoteText } from "./ats-interview-notes";
import type { interviewSummariesTable } from "@workspace/db";
import {
  recoveredGreenhouseNote,
  savedGreenhouseNoteId,
} from "./ats-connectors/greenhouse-note-policy";

const summary: typeof interviewSummariesTable.$inferSelect = {
  id: "summary",
  interviewSessionId: "session",
  overallScore: 0,
  strengths: ["Clear example"],
  weaknesses: ["More depth"],
  redFlags: [],
  recommendation: "maybe",
  recruiterSummary: "Job assessment. https://invalid.test/interviews/private/room",
  recruiterComments: "PRIVATE comments",
  transcript: ["PRIVATE transcript"],
  createdAt: new Date(0),
};
test("publication selects job assessment fields only, preserves zero and omits URLs", () => {
  const content = assessmentNoteText(summary).join("\n");
  assert.ok(content.includes("Interview score: 0"));
  assert.ok(content.includes("[link omitted]"));
  assert.ok(!content.includes("https://") && !content.includes("PRIVATE"));
  assert.ok(!content.includes("/interviews/"));
  assert.throws(() => assessmentNoteText({ ...summary, overallScore: NaN }), /valid completed/);
  assert.throws(() => assessmentNoteText({ ...summary, recruiterSummary: "" }), /valid completed/);
});
test("recovery accepts one exact private application note and rejects corrupt saved receipts", () => {
  const note = {
    id: 7,
    candidate_id: 2,
    application_id: 3,
    type: "NOTE",
    visibility: "admin_only_visible",
    subject: "Lexy progress",
    body: "Interview completed.",
  };
  assert.equal(recoveredGreenhouseNote([note], "7").visibility, "admin_only");
  for (const evidence of [
    [],
    [note, note],
    [{ ...note, id: 8 }],
    [{ ...note, visibility: "publicly_visible" }],
    [{ ...note, application_id: null }],
    [{ ...note, type: "EMAIL" }],
    [{ ...note, body: "" }],
  ]) {
    assert.throws(() => recoveredGreenhouseNote(evidence, "7"));
  }
  for (const action of ["ats.interview.note.published", "ats.interview.note.reconciled"]) {
    assert.equal(savedGreenhouseNoteId(action, '{"noteId":"7"}'), "7");
    for (const value of ["{}", '{"noteId":7}', '{"noteId":"9007199254740992"}', "invalid"]) {
      assert.equal(savedGreenhouseNoteId(action, value), null);
    }
  }
  assert.equal(savedGreenhouseNoteId("ats.interview.note.claimed", '{"noteId":"7"}'), null);
});
