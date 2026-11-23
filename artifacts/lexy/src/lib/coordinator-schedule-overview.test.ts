import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readCoordinatorSchedules, readNativeSchedules, readUpdatedSchedule } from "./schedule-edit";

const row = {
  id: "fixture-schedule", applicationId: "fixture-application",
  interviewerId: null, type: "technical", candidateName: "Fixture Candidate",
  jobTitle: "Fixture Role", scheduledAt: "2030-11-01T10:00:00Z",
  durationMinutes: 60, status: "scheduled", version: `v1_${"a".repeat(64)}`,
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("one invalid row does not hide valid interviews from the coordinator", async () => {
  const overview = await readCoordinatorSchedules(response([
    row, { ...row, id: "legacy", version: null },
  ]));
  assert.equal(overview.total, 2);
  assert.deepEqual(overview.schedules, [row]);
  assert.equal(overview.unverified[0].candidateName, row.candidateName);
  assert.deepEqual(overview.unverified[0].invalidFields, ["version"]);
});

test("invalid fields are diagnosed without coercing values or fabricating revisions", async () => {
  for (const [key, value] of [
    ["durationMinutes", "60"], ["feedbackRating", 0], ["scheduledAt", "bad"],
    ["candidateName", {}], ["interviewerId", undefined], ["applicationId", ""],
    ["status", "unknown"],
  ] as const) {
    const overview = await readCoordinatorSchedules(response([{ ...row, [key]: value }]));
    assert.equal(overview.schedules.length, 0, key);
    assert.ok(overview.unverified[0].invalidFields.includes(key), key);
  }
});

test("unverified summaries whitelist display fields and never expose mutation credentials", async () => {
  const overview = await readCoordinatorSchedules(response([{
    ...row, version: null, notes: "private", feedbackNotes: "private", extra: "private",
  }]));
  assert.deepEqual(Object.keys(overview.unverified[0]).sort(), [
    "candidateName", "id", "invalidFields", "jobTitle", "position", "scheduledAt",
  ]);
  await assert.rejects(readUpdatedSchedule(response({ ...row, version: null }), row.id));
  await assert.rejects(readNativeSchedules(response([{ ...row, version: null }])));
});

test("all-invalid, malformed, duplicate and empty lists have honest results", async () => {
  const invalid = await readCoordinatorSchedules(response([null, [], { id: "partial" }]));
  assert.equal(invalid.schedules.length, 0);
  assert.equal(invalid.unverified.length, 3);
  const duplicate = await readCoordinatorSchedules(response([row, row]));
  assert.equal(duplicate.schedules.length, 0);
  assert.ok(duplicate.unverified.every(item => item.invalidFields.includes("duplicate id")));
  assert.deepEqual(await readCoordinatorSchedules(response([])), { total: 0, schedules: [], unverified: [] });
});

test("HTTP failures and invalid envelopes never masquerade as successful partial lists", async () => {
  for (const status of [401, 403, 404, 500])
    await assert.rejects(readCoordinatorSchedules(response([row], status)));
  for (const body of [null, {}, { schedules: [row] }])
    await assert.rejects(readCoordinatorSchedules(response(body)));
});

test("coordinator renders read-only problems separately and keeps cache updates in the overview shape", () => {
  const source = readFileSync(new URL("../pages/recruiter/coordinator.tsx", import.meta.url), "utf8");
  assert.match(source, /readCoordinatorSchedules\(await authenticatedFetch/);
  assert.match(source, /\["coordinator-schedules", "overview", user\?\.id, user\?\.tenantId, user\?\.role\]/);
  assert.match(source, /queryKey: scheduleQueryKey/);
  assert.match(source, /enabled: !authLoading && !!user/);
  assert.match(source, /setQueryData<CoordinatorScheduleOverview>/);
  assert.match(source, /sortedDates.length === 0 && unverified.length === 0/);
  const section = source.slice(source.indexOf('<section className="mb-6'), source.indexOf("{isError ? ("));
  assert.match(section, /Read-only/);
  assert.match(section, /invalidFields.join/);
  assert.doesNotMatch(section, /ScheduleActions|Invitation|StaffNativeZoom|setEditingSchedule/);
});
