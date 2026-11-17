import assert from "node:assert/strict";
import { test } from "node:test";
import { hasScheduleApplication, parseScheduleApplications } from "./schedule-applications";

const row = {
  id: "fixture-application",
  stage: "screening",
  candidate: { name: "Fixture", privateField: "not needed" },
  job: { title: "Fixture role" },
};

test("picker accepts legacy full-name responses and retains only display fields", () => {
  assert.deepEqual(parseScheduleApplications([row]), [
    {
      id: row.id,
      stage: row.stage,
      candidate: { name: "Fixture" },
      job: row.job,
    },
  ]);
  assert.deepEqual(parseScheduleApplications([]), []);
  assert.equal(hasScheduleApplication(parseScheduleApplications([row]), row.id), true);
  assert.equal(hasScheduleApplication(parseScheduleApplications([row]), "missing"), false);
});

test("canonical API name parts produce searchable and selectable candidate options", () => {
  const rows = parseScheduleApplications([
    {
      ...row,
      candidate: {
        firstName: "  Test ",
        lastName: " Candidate  ",
        email: "private@example.invalid",
        contactInfo: { phone: "private" },
      },
    },
  ]);
  assert.deepEqual(rows, [
    {
      id: row.id,
      stage: row.stage,
      candidate: { name: "Test Candidate" },
      job: row.job,
    },
  ]);
  assert.equal(rows[0].candidate?.name?.toLowerCase().includes("candidate"), true);
  assert.equal(hasScheduleApplication(rows, row.id), true);
});

test("canonical partial and blank names do not reject the entire candidate list", () => {
  for (const [candidate, expected] of [
    [{ firstName: "Test", lastName: null }, "Test"],
    [{ firstName: null, lastName: "Candidate" }, "Candidate"],
    [{ firstName: "Test" }, "Test"],
    [{ lastName: "Candidate" }, "Candidate"],
    [{ firstName: " ", lastName: "" }, null],
  ] as const) {
    const rows = parseScheduleApplications([{ ...row, candidate }]);
    assert.equal(rows[0].candidate?.name, expected);
    assert.equal(hasScheduleApplication(rows, row.id), true);
  }
});

test("malformed or duplicate records cannot masquerade as an empty or selectable list", () => {
  for (const body of [
    null,
    {},
    { data: [row] },
    [null],
    [{ ...row, id: "" }],
    [{ ...row, stage: {} }],
    [{ ...row, candidate: {} }],
    [{ ...row, candidate: { name: {} } }],
    [{ ...row, candidate: { firstName: {}, lastName: "Candidate" } }],
    [{ ...row, candidate: { firstName: "Test", lastName: [] } }],
    [{ ...row, job: { title: [] } }],
    [row, row],
  ])
    assert.throws(() => parseScheduleApplications(body), /could not be verified/);
});

test("missing joined records are representable but cannot be scheduled", () => {
  for (const value of [
    { ...row, candidate: null },
    { ...row, job: null },
  ]) {
    const rows = parseScheduleApplications([value]);
    assert.equal(rows.length, 1);
    assert.equal(hasScheduleApplication(rows, row.id), false);
  }
  assert.equal(
    hasScheduleApplication(
      parseScheduleApplications([
        {
          ...row,
          candidate: { name: null },
          job: { title: null },
        },
      ]),
      row.id,
    ),
    true,
  );
});
