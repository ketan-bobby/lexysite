import assert from "node:assert/strict";
import { test } from "node:test";
import { invitationOutcome } from "./ats-interview-invitations";

test("invitation outcomes distinguish provider acceptance from simulation and uncertainty", () => {
  assert.equal(invitationOutcome({ ok: true, messageId: "receipt" }), "provider_accepted");
  for (const result of [{ ok: false }, { ok: true }, { ok: false, messageId: "ambiguous" }])
    assert.equal(invitationOutcome(result), "review_required");
  assert.equal(invitationOutcome({ ok: true, simulated: true }), "simulated");
  assert.equal(invitationOutcome({ ok: true, suppressed: true }), "simulated");
});
