import assert from "node:assert/strict";
import { test } from "node:test";
import { offerDraftAvailability } from "./offer-draft-availability";

for (const status of [undefined, "draft", "review_required", "approved"] as const) {
  test(`offer draft: ${status ?? "new"} permits eligible designated editing`, () => {
    assert.equal(offerDraftAvailability(status, true, true), "edit");
  });
}
for (const status of ["expired", "withdrawn"] as const) {
  test(`offer draft: ${status} permits only explicit fresh preparation`, () => {
    assert.equal(offerDraftAvailability(status, true, true), "replace");
    assert.equal(offerDraftAvailability(status, false, true), "none");
    assert.equal(offerDraftAvailability(status, true, false), "none");
  });
}
for (const status of ["sent", "sending", "send_uncertain", "accepted", "declined"] as const) {
  test(`offer draft: ${status} cannot be replaced from the editor`, () => {
    assert.equal(offerDraftAvailability(status, true, true), "none");
  });
}
test("offer draft: ordinary editing also requires current eligibility and ownership", () => {
  assert.equal(offerDraftAvailability("draft", false, true), "none");
  assert.equal(offerDraftAvailability(undefined, true, false), "none");
});
