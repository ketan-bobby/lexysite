import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canSendInvitation,
  readInvitationStatus,
  sameInvitationDetails,
} from "./outlook-invitation-state";

const schedule = {
  id: "synthetic-interview",
  status: "confirmed",
  scheduledAt: "2035-11-01T10:00:00.000Z",
  durationMinutes: 60,
  version: `v1_${"a".repeat(64)}`,
};
const ready = {
  scheduleId: schedule.id,
  status: "not_sent" as const,
  version: schedule.version,
  scheduledAt: schedule.scheduledAt,
  durationMinutes: schedule.durationMinutes,
  recipientEmail: "candidate@example.invalid",
  acceptedAt: null,
};

test("only an exact, future, confirmed native schedule enables the one-click send path", () => {
  assert.equal(canSendInvitation(schedule, ready, Date.parse("2035-01-01")), true);
  assert.equal(canSendInvitation({ ...schedule, status: "pending" }, ready), false);
  assert.equal(canSendInvitation({ ...schedule, version: `v1_${"b".repeat(64)}` }, ready), false);
  assert.equal(
    canSendInvitation(schedule, { ...ready, scheduledAt: "2035-11-02T10:00:00Z" }),
    false,
  );
  assert.equal(
    canSendInvitation(schedule, {
      ...ready,
      recipientEmail: "candidate2@example.invalid",
      status: "needs_review",
    }),
    false,
  );
  assert.equal(canSendInvitation(schedule, { ...ready, status: "accepted" }), false);
  assert.equal(canSendInvitation(schedule, ready, Date.parse(schedule.scheduledAt)), false);
});

test("untrusted invitation status is rejected before being shown as accepted", () => {
  assert.deepEqual(readInvitationStatus(ready, schedule.id), ready);
  for (const invalid of [
    { ...ready, version: "bad" },
    { ...ready, recipientEmail: "not-email" },
    { ...ready, status: "sent" },
    { ...ready, scheduleId: "someone-else" },
    { ...ready, durationMinutes: -1 },
  ])
    assert.throws(() => readInvitationStatus(invalid, schedule.id));
});

test("review cannot move to another recipient, schedule, revision, instant or duration", () => {
  assert.equal(sameInvitationDetails(null, ready), false);
  assert.equal(sameInvitationDetails(ready, null), false);
  assert.equal(sameInvitationDetails({ ...ready }, ready), true);
  for (const change of [
    { recipientEmail: "replacement@example.invalid" },
    { scheduleId: "another-interview" },
    { version: `v1_${"b".repeat(64)}` },
    { scheduledAt: "2035-11-01T11:00:00.000Z" },
    { durationMinutes: 30 },
  ])
    assert.equal(sameInvitationDetails(ready, { ...ready, ...change }), false);
});

test("delivery receipt must retain the reviewed details without treating acceptance as permission", () => {
  const accepted = { ...ready, status: "accepted" as const, acceptedAt: "2035-01-01T00:00:00Z" };
  assert.equal(sameInvitationDetails(ready, accepted), true);
  assert.equal(canSendInvitation(schedule, accepted), false);
  for (const change of [
    { recipientEmail: "unexpected@example.invalid" },
    { scheduleId: "another-interview" },
    { version: `v1_${"b".repeat(64)}` },
    { scheduledAt: "2035-11-01T11:00:00.000Z" },
    { durationMinutes: 30 },
  ])
    assert.equal(sameInvitationDetails(ready, { ...accepted, ...change }), false);
  assert.equal(
    sameInvitationDetails(ready, { ...ready, scheduledAt: "2035-11-01T05:00:00-05:00" }),
    true,
  );
});
