import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readInvitationChange,
  sameChange,
  type InvitationChange,
} from "./outlook-invitation-change-state";
const preview: InvitationChange = {
  scheduleId: "test",
  version: `v1_${"a".repeat(64)}`,
  scheduledAt: "2035-11-01T11:00:00.000Z",
  durationMinutes: 30,
  recipientEmail: "candidate@example.invalid",
  status: "ready",
  approvalVersion: `change_${"b".repeat(64)}`,
  organizerEmail: "staff@example.invalid",
  previousScheduledAt: "2035-11-01T10:00:00.000Z",
  previousEndAt: "2035-11-01T10:30:00.000Z",
};
test("Outlook preview requires complete explicit approval details", () => {
  assert.deepEqual(readInvitationChange(preview, "test"), preview);
  for (const field of [
    "approvalVersion",
    "organizerEmail",
    "previousScheduledAt",
    "previousEndAt",
  ]) {
    assert.throws(() => readInvitationChange({ ...preview, [field]: null }, "test"));
  }
  assert.throws(() => readInvitationChange(preview, "foreign"));
  assert.throws(() => readInvitationChange({ ...preview, scheduledAt: "invalid" }, "test"));
});
test("review snapshot invalidates on recipient, organizer, time and provider revision changes", () => {
  assert.ok(sameChange(preview, { ...preview }));
  for (const field of [
    "recipientEmail",
    "organizerEmail",
    "scheduledAt",
    "version",
    "approvalVersion",
    "previousEndAt",
  ]) {
    assert.equal(sameChange(preview, { ...preview, [field]: "changed" }), false);
  }
});
