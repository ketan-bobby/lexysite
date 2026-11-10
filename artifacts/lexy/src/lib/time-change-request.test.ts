import assert from "node:assert/strict";
import { test } from "node:test";
import { readTimeChangeView } from "./time-change-request";
const view = {
  scheduleId: "own-schedule",
  version: `v1_${"a".repeat(64)}`,
  scheduledAt: "2035-11-01T10:00:00Z",
  durationMinutes: 60,
  canRequest: false,
  canWithdraw: true,
  appointmentChanged: false,
  invitationSent: false,
  request: {
    id: "request-1",
    requestedAt: "2026-10-23T05:00:00Z",
    reviewedAt: null,
    withdrawnAt: null,
    currentProposal: true,
  },
};
test("a time-change receipt is explicit about unchanged appointments and no invitation", () => {
  assert.deepEqual(readTimeChangeView(view, view.scheduleId), view);
  for (const bad of [
    { ...view, scheduleId: "foreign" },
    { ...view, appointmentChanged: true },
    { ...view, invitationSent: true },
    { ...view, request: undefined },
    { ...view, version: "invalid" },
    { ...view, durationMinutes: 0 },
    { ...view, request: { ...view.request, requestedAt: "invalid" } },
  ])
    assert.throws(() => readTimeChangeView(bad, view.scheduleId));
});
test("pending, reviewed and absent request states survive a reload", () => {
  assert.equal(
    readTimeChangeView({ ...view, request: null, canRequest: true, canWithdraw: false }).canRequest,
    true,
  );
  assert.equal(
    readTimeChangeView({
      ...view,
      canWithdraw: false,
      request: { ...view.request, reviewedAt: view.request.requestedAt },
    }).request?.reviewedAt,
    view.request.requestedAt,
  );
});
test("withdrawn requests persist without allowing another withdrawal or staff review", () => {
  const withdrawn = {
    ...view,
    canWithdraw: false,
    request: { ...view.request, withdrawnAt: "2026-10-23T06:00:00Z" },
  };
  assert.equal(readTimeChangeView(withdrawn).request?.withdrawnAt, withdrawn.request.withdrawnAt);
  for (const bad of [
    { ...withdrawn, canWithdraw: true },
    { ...withdrawn, request: { ...withdrawn.request, reviewedAt: view.request.requestedAt } },
    { ...withdrawn, request: { ...withdrawn.request, withdrawnAt: "invalid" } },
    { ...withdrawn, request: { ...withdrawn.request, withdrawnAt: undefined } },
    { ...view, request: null },
  ])
    assert.throws(() => readTimeChangeView(bad));
});
