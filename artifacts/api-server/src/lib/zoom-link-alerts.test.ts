import assert from "node:assert/strict";
import { test } from "node:test";
import type { interviewZoomLinksTable } from "@workspace/db";
import type { PanelSchedule } from "./calendar-panel-access";
import { zoomSnapshot } from "./staff-zoom-link";
import { zoomAlertEvidence } from "./zoom-link-alerts";

function fixture() {
  const row = {
    schedule: {
      id: "s",
      tenantId: "t",
      applicationId: "a",
      scheduledAt: new Date("2000-01-01"),
      durationMinutes: 30,
      type: "video",
      status: "confirmed",
      interviewerId: "staff",
    },
    application: { id: "a", tenantId: "t", candidateId: "c", jobId: "j" },
    job: { id: "j", tenantId: "t" },
    candidate: { id: "c", userId: "u", tenantId: "t", email: "candidate@example.test" },
  } as unknown as PanelSchedule;
  const saved: typeof interviewZoomLinksTable.$inferSelect = {
    scheduleId: "s",
    applicationId: "a",
    candidateId: "c",
    publisherId: "staff",
    publicationId: "publication",
    snapshotHash: zoomSnapshot(row),
    joinUrl: "https://zoom.us/j/123456789?pwd=private",
    approvedAt: new Date(),
  };
  return { row, saved };
}
test("Zoom alert evidence ignores natural clock expiry and private feedback", () => {
  const { row, saved } = fixture();
  assert.equal(zoomAlertEvidence(row, saved, false, true), null);
  row.schedule.feedbackNotes = "Private staff note";
  assert.equal(zoomAlertEvidence(row, saved, false, true), null);
  row.schedule.durationMinutes = 60;
  const evidence = zoomAlertEvidence(row, saved, false, true);
  assert.match(evidence!, /^[a-f0-9]{64}$/);
  row.schedule.feedbackNotes = "Another private note";
  assert.equal(zoomAlertEvidence(row, saved, false, true), evidence);
  assert.notEqual(
    zoomAlertEvidence(row, { ...saved, publicationId: "replacement" }, false, true),
    evidence,
  );
});
test("Zoom alert evidence detects conflicts, lost publisher authority and invalid links without exposing them", () => {
  const { row, saved } = fixture();
  assert.ok(zoomAlertEvidence(row, saved, true, true));
  assert.ok(zoomAlertEvidence(row, saved, false, false));
  assert.ok(
    zoomAlertEvidence(
      row,
      { ...saved, joinUrl: "https://zoom.us/s/123456789?zak=host" },
      false,
      true,
    ),
  );
  row.schedule.status = "completed";
  assert.equal(zoomAlertEvidence(row, saved, true, false), null);
  row.schedule.status = "confirmed";
  assert.equal(zoomAlertEvidence(row, { ...saved, joinUrl: null }, true, false), null);
});
