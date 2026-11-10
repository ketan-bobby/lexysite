import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOfferTerms, type OfferTermsForm } from "./offer-terms-validation";

const now = Date.parse("2026-10-12T12:00:00Z");
const valid: OfferTermsForm = {
  employerName: " Synthetic Employer ",
  roleTitle: " Engineer ",
  amount: "120000",
  currency: "USD",
  frequency: "annual",
  location: " Remote ",
  startDate: "2028-02-29",
  expiresAt: "2030-03-01T12:00",
  letter: " Synthetic human-authored letter. ",
};
test("offer terms: normalize valid terms and serialize local expiry to UTC", () => {
  const result = validateOfferTerms(valid, now);
  assert.equal(result.error, undefined);
  assert.equal(result.terms?.employerName, "Synthetic Employer");
  assert.equal(result.terms?.amount, 120000);
  assert.equal(result.terms?.letter, "Synthetic human-authored letter.");
  assert.equal(result.terms?.expiresAt, new Date(valid.expiresAt).toISOString());
});
for (const [name, patch] of [
  ["blank employer", { employerName: " " }],
  ["blank role", { roleTitle: "" }],
  ["blank location", { location: "" }],
  ["overlong employer", { employerName: "a".repeat(201) }],
  ["overlong role", { roleTitle: "a".repeat(201) }],
  ["overlong location", { location: "a".repeat(301) }],
  ["blank amount", { amount: "" }],
  ["zero amount", { amount: "0" }],
  ["negative amount", { amount: "-10" }],
  ["not a number", { amount: "invalid" }],
  ["infinite amount", { amount: "Infinity" }],
  ["overflowed amount", { amount: "1e999" }],
  ["lowercase currency", { currency: "usd" }],
  ["invalid currency length", { currency: "USDD" }],
  ["invalid frequency", { frequency: "daily" }],
  ["blank start", { startDate: "" }],
  ["invalid start format", { startDate: "2028-2-29" }],
  ["non-leap date", { startDate: "2027-02-29" }],
  ["invalid day", { startDate: "2028-04-31" }],
  ["invalid month", { startDate: "2028-13-01" }],
  ["blank expiry", { expiresAt: "" }],
  ["invalid expiry", { expiresAt: "invalid" }],
  ["past expiry", { expiresAt: "2026-10-11T12:00:00Z" }],
  ["expiry equal to now", { expiresAt: "2026-10-12T12:00:00Z" }],
  ["short letter", { letter: " tiny " }],
  ["overlong letter", { letter: "a".repeat(12001) }],
] as const) {
  test(`offer terms: rejects ${name} without producing a payload`, () => {
    const result = validateOfferTerms({ ...valid, ...patch }, now);
    assert.ok(result.error);
    assert.equal(result.terms, undefined);
  });
}
test("offer terms: expiry that was valid at render is checked again when saving", () => {
  const expiry = "2026-10-12T12:00:01Z";
  assert.ok(validateOfferTerms({ ...valid, expiresAt: expiry }, now).terms);
  assert.ok(validateOfferTerms({ ...valid, expiresAt: expiry }, now + 2000).error);
});
for (const frequency of ["annual", "monthly", "hourly"]) {
  test(`offer terms: accepts ${frequency} pay frequency`, () => {
    assert.equal(validateOfferTerms({ ...valid, frequency }, now).terms?.frequency, frequency);
  });
}
