import assert from "node:assert/strict";
import { test } from "node:test";
import { googlePilotReceipt } from "./google-calendar-pilot-state";

const good = {
  status: "verified",
  checkedAt: "2035-11-01T10:00:00Z",
  calendarReadVerified: true,
  availabilityReadVerified: true,
  meetSupported: true,
  accountBinding: "not_configured",
  invitationsEnabled: false,
};
test("verified reads retain explicit non-authorization and non-invitation boundaries", () => {
  assert.deepEqual(googlePilotReceipt(good), good);
  assert.ok(googlePilotReceipt({ ...good, meetSupported: null }));
  assert.ok(googlePilotReceipt({ ...good, meetSupported: false }));
});
test("disconnected/ambiguous connections cannot claim verified reads", () => {
  for (const status of ["not_connected", "selection_required"]) {
    assert.equal(googlePilotReceipt({ ...good, status }), null);
    assert.ok(
      googlePilotReceipt({
        ...good,
        status,
        calendarReadVerified: false,
        availabilityReadVerified: false,
        meetSupported: null,
      }),
    );
  }
});
test("malformed, inconsistent, write-enabled or private receipts fail closed", () => {
  for (const value of [
    null,
    [],
    {},
    { ...good, invitationsEnabled: true },
    { ...good, accountBinding: "staff" },
    { ...good, calendarReadVerified: false },
    { ...good, availabilityReadVerified: false },
    { ...good, checkedAt: "bad" },
    { ...good, meetSupported: "yes" },
    { ...good, calendarId: "private@example.invalid" },
    { ...good, status: "connected" },
  ])
    assert.equal(googlePilotReceipt(value), null);
});
