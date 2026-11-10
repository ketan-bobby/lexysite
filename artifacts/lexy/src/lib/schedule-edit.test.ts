import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readAssignedSchedules,
  readNativeSchedules,
  readUpdatedSchedule,
  requireScheduleVersion,
} from "./schedule-edit";

const row = {
  type: "technical",
  id: "fixture-schedule",
  applicationId: "fixture-app",
  interviewerId: "fixture-user",
  interviewerName: "Same Name",
  scheduledAt: "2030-11-01T10:00:00Z",
  durationMinutes: 60,
  status: "pending",
  version: `v1_${"a".repeat(64)}`,
  feedbackRating: null,
  feedbackNotes: null,
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("only the exact assigned interviewer ID is accepted, never a matching name", async () => {
  const rows = await readAssignedSchedules(
    reply([row, { ...row, id: "foreign", interviewerId: "another-user" }]),
    "fixture-user",
  );
  assert.deepEqual(
    rows.map((item) => item.id),
    ["fixture-schedule"],
  );
});

test("HTTP conflicts and denied reads do not become empty queues or false saves", async () => {
  for (const status of [403, 404, 409, 500]) {
    await assert.rejects(
      readUpdatedSchedule(reply({ error: "fixture error" }, status), row.id),
      (error: unknown) => error instanceof Error && "status" in error && error.status === status,
    );
    await assert.rejects(readAssignedSchedules(reply([], status), "fixture-user"));
  }
});

test("malformed, unversioned and wrong-interview replies cannot confirm feedback", async () => {
  for (const body of [
    null,
    {},
    { ...row, version: "bad" },
    { ...row, feedbackRating: 6 },
    { ...row, scheduledAt: "invalid" },
    { ...row, id: "other" },
  ])
    await assert.rejects(readUpdatedSchedule(reply(body), row.id));
  await assert.rejects(readAssignedSchedules(reply({ interviews: [row] }), "fixture-user"));
  assert.throws(() => requireScheduleVersion({}), /Refresh/);
});

test("saved feedback consumes the authoritative returned revision and preserves nulls", async () => {
  const saved = await readUpdatedSchedule(
    reply({
      ...row,
      feedbackRating: 4,
      feedbackNotes: "Saved fixture notes",
      version: `v1_${"b".repeat(64)}`,
    }),
    row.id,
  );
  assert.equal(saved.feedbackRating, 4);
  assert.equal(saved.version, `v1_${"b".repeat(64)}`);
});

test("coordinator reads validate optional display fields without applying an interviewer filter", async () => {
  const rows = await readNativeSchedules(
    reply([row, { ...row, id: "other", interviewerId: null }]),
  );
  assert.equal(rows.length, 2);
  for (const body of [
    { ...row, applicationId: "" },
    { ...row, type: {} },
    { ...row, candidateName: {} },
  ])
    await assert.rejects(readNativeSchedules(reply([body])));
});
