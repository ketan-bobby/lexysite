import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicControlledOffer } from "@workspace/api-client-react";
import { publicOfferAvailability } from "./public-offer-availability";

const expiry = Date.parse("2030-01-01T00:00:00Z");
const offer = {
  status: "sent",
  canRespond: true,
  terms: { expiresAt: new Date(expiry).toISOString() },
} as PublicControlledOffer;

test("only a currently permitted, unexpired sent offer can be answered", () => {
  assert.deepEqual(publicOfferAvailability(offer, expiry - 1), {
    expired: false,
    canRespond: true,
  });
  assert.equal(
    publicOfferAvailability({ ...offer, canRespond: false }, expiry - 1).canRespond,
    false,
  );
});

test("the exact expiry boundary and later times disable responses", () => {
  for (const now of [expiry, expiry + 1, expiry + 86_400_000]) {
    assert.deepEqual(publicOfferAvailability(offer, now), {
      expired: true,
      canRespond: false,
    });
  }
});

for (const status of ["accepted", "declined", "expired"] as const) {
  test(`${status} cannot be answered even if the server flag is inconsistent`, () => {
    assert.equal(publicOfferAvailability({ ...offer, status }, expiry - 1).canRespond, false);
  });
}

test("missing offers or invalid clock/expiry fail closed", () => {
  assert.equal(publicOfferAvailability(undefined, expiry).canRespond, false);
  assert.equal(publicOfferAvailability(offer, NaN).canRespond, false);
  assert.equal(publicOfferAvailability(offer, Infinity).canRespond, false);
  assert.equal(
    publicOfferAvailability({ ...offer, terms: { ...offer.terms, expiresAt: "invalid" } }, expiry)
      .canRespond,
    false,
  );
});

test("accepted and declined responses are not relabelled expired by elapsed time", () => {
  for (const status of ["accepted", "declined"] as const) {
    assert.equal(publicOfferAvailability({ ...offer, status }, expiry + 1).expired, false);
  }
});
