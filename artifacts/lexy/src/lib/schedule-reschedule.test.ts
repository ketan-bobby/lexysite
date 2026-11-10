import assert from "node:assert/strict";
import { test } from "node:test";
import type { ScheduleEditRecord } from "./schedule-edit";
import {
  canReschedule,
  hasRequestedTiming,
  initialRescheduleDraft,
  rescheduleUpdate,
} from "./schedule-reschedule";

const original: ScheduleEditRecord = {
  id: "fixture-schedule",
  applicationId: "fixture-application",
  interviewerId: "fixture-interviewer",
  type: "technical",
  status: "confirmed",
  version: `v1_${"a".repeat(64)}`,
  scheduledAt: "2030-11-01T10:00:00.000Z",
  durationMinutes: 60,
  notes: "Preserve notes",
  feedbackRating: 4,
  feedbackNotes: "Preserve feedback",
};
const future = { ...original, scheduledAt: "2030-11-02T10:00:00.000Z" };
const now = Date.parse("2030-10-30T00:00:00Z");

test("reschedule updates contain only timing, status and the displayed revision", () => {
  const before = { ...original };
  const update = rescheduleUpdate(
    original,
    initialRescheduleDraft(future),
    original.scheduledAt,
    now,
  );
  assert.deepEqual(update, {
    scheduledAt: future.scheduledAt,
    durationMinutes: 60,
    status: "rescheduled",
    expectedVersion: original.version,
  });
  assert.deepEqual(original, before);
  assert.deepEqual(Object.keys(update).sort(), [
    "durationMinutes",
    "expectedVersion",
    "scheduledAt",
    "status",
  ]);
});

test("all open native statuses permit changes; closed and unknown states do not", () => {
  for (const status of ["pending", "scheduled", "confirmed", "rescheduled"])
    assert.equal(canReschedule({ status }), true);
  for (const status of ["completed", "cancelled", "unknown"]) {
    assert.equal(canReschedule({ status }), false);
    assert.throws(
      () =>
        rescheduleUpdate(
          { ...original, status },
          initialRescheduleDraft(future),
          original.scheduledAt,
          now,
        ),
      /closed/,
    );
  }
});

test("whole-minute duration boundaries are enforced without changing other fields", () => {
  for (const durationMinutes of ["5", "480"]) {
    const update = rescheduleUpdate(
      original,
      { ...initialRescheduleDraft(future), durationMinutes },
      original.scheduledAt,
      now,
    );
    assert.equal(update.durationMinutes, Number(durationMinutes));
  }
  for (const durationMinutes of ["", "4", "481", "5.5", "invalid"])
    assert.throws(
      () =>
        rescheduleUpdate(
          original,
          { ...initialRescheduleDraft(future), durationMinutes },
          original.scheduledAt,
          now,
        ),
      /Duration/,
    );
});

test("invalid, past and unchanged inputs cannot issue an update", () => {
  for (const draft of [
    { ...initialRescheduleDraft(future), date: "2030-02-30" },
    { ...initialRescheduleDraft(future), date: "2030-2-3" },
    { ...initialRescheduleDraft(future), time: "25:61" },
  ])
    assert.throws(() => rescheduleUpdate(original, draft, original.scheduledAt, now));
  assert.throws(
    () =>
      rescheduleUpdate(
        original,
        initialRescheduleDraft(future),
        original.scheduledAt,
        Date.parse(future.scheduledAt),
      ),
    /future/,
  );
  assert.throws(
    () => rescheduleUpdate(original, initialRescheduleDraft(original), original.scheduledAt, now),
    /different/,
  );
  assert.throws(
    () =>
      rescheduleUpdate(
        { ...original, version: "" },
        initialRescheduleDraft(future),
        original.scheduledAt,
        now,
      ),
    /Refresh/,
  );
});

test("matching saved timing can be recovered read-only even if time has passed or status differs", () => {
  const saved = { ...future, version: `v1_${"b".repeat(64)}`, status: "confirmed" };
  assert.equal(
    hasRequestedTiming(saved, initialRescheduleDraft(future), original.scheduledAt),
    true,
  );
  assert.equal(
    hasRequestedTiming(
      { ...saved, durationMinutes: 45 },
      initialRescheduleDraft(future),
      original.scheduledAt,
    ),
    false,
  );
  assert.equal(
    hasRequestedTiming(saved, { date: "", time: "", durationMinutes: "" }, original.scheduledAt),
    false,
  );
  assert.throws(
    () =>
      rescheduleUpdate(
        original,
        initialRescheduleDraft(saved),
        original.scheduledAt,
        Date.parse(saved.scheduledAt) + 1,
      ),
    /future/,
  );
});

test("duration-only changes preserve the original seconds and milliseconds", () => {
  const precise = { ...original, scheduledAt: "2030-11-01T10:00:21.123Z" };
  const update = rescheduleUpdate(
    precise,
    { ...initialRescheduleDraft(precise), durationMinutes: "75" },
    precise.scheduledAt,
    now,
  );
  assert.equal(update.scheduledAt, precise.scheduledAt);
  assert.equal(update.durationMinutes, 75);
});

test("rebasing a draft never changes its original DST-fold instant", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const first = { ...original, scheduledAt: "2026-11-01T01:30:00-04:00" };
    const second = {
      ...first,
      scheduledAt: "2026-11-01T01:30:00-05:00",
      version: `v1_${"b".repeat(64)}`,
    };
    const draft = initialRescheduleDraft(first);
    assert.equal(hasRequestedTiming(second, draft, first.scheduledAt), false);
    const update = rescheduleUpdate(
      second,
      draft,
      first.scheduledAt,
      Date.parse("2026-10-30T00:00:00Z"),
    );
    assert.equal(update.scheduledAt, "2026-11-01T05:30:00.000Z");
    assert.equal(update.expectedVersion, second.version);
    assert.throws(
      () =>
        rescheduleUpdate(
          original,
          {
            date: "2027-03-14",
            time: "02:30",
            durationMinutes: "60",
          },
          original.scheduledAt,
          Date.parse("2027-03-01T00:00:00Z"),
        ),
      /does not exist/,
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
