import assert from "node:assert/strict";
import { test } from "node:test";
import { previewJob, previewApplications, sealPreviewCursor, openPreviewCursor } from "./preview";

const app = {
  id: 303,
  candidate_id: 202,
  job_id: 101,
  prospect: false,
  status: "in_process",
  stage_name: "Screen",
  answers: "PRIVATE",
};
test("preview normalizes allowlisted metadata only", () => {
  assert.deepEqual(
    previewJob(
      [{ id: 101, name: "Engineer", status: "open", confidential: false, notes: "PRIVATE" }],
      "101",
    ),
    { id: "101", name: "Engineer", status: "open" },
  );
  assert.deepEqual(previewApplications([app], "101"), [
    { id: "303", candidateId: "202", status: "in_process", stageName: "Screen" },
  ]);
  assert.deepEqual(previewApplications([], "101"), []);
});
test("preview fails closed on wrong jobs, prospects, duplicates, excess rows and malformed records", () => {
  for (const records of [
    [app, app],
    Array.from({ length: 26 }, (_, i) => ({ ...app, id: i + 1 })),
    [{ ...app, job_id: 404 }],
    [{ ...app, job_id: null }],
    [{ ...app, prospect: true }],
    [{ ...app, candidate_id: 1.5 }],
    [{ ...app, status: "invented" }],
    [{ ...app, stage_name: {} }],
    { data: [app] },
  ])
    assert.throws(() => previewApplications(records, "101"));
  for (const confidential of [true, undefined]) {
    assert.throws(() =>
      previewJob([{ id: 101, name: "Secret", status: "open", confidential }], "101"),
    );
  }
  assert.throws(() =>
    previewJob([{ id: 404, name: "Other", status: "open", confidential: false }], "101"),
  );
});
test("opaque continuation tokens cannot cross actor/binding/mapping scopes or be altered", () => {
  const token = sealPreviewCursor("opaque-provider-cursor", "actor:tenant:revision:mapping");
  assert.equal(token.includes("opaque-provider"), false);
  assert.equal(openPreviewCursor(token, "actor:tenant:revision:mapping"), "opaque-provider-cursor");
  assert.throws(() => openPreviewCursor(token, "other-actor"));
  const index = Math.floor(token.length / 2);
  const altered =
    token.slice(0, index) + (token[index] === "a" ? "b" : "a") + token.slice(index + 1);
  assert.throws(() => openPreviewCursor(altered, "actor:tenant:revision:mapping"));
  assert.throws(() => openPreviewCursor("raw-provider-cursor", "actor:tenant:revision:mapping"));
});
