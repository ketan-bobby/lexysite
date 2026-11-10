import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBookingUrl, parseBookingToken, parseLinkCreated } from "./booking-link";

const t = "A".repeat(43);
test("token parsing is fragment-strict", () => {
  assert.equal(parseBookingToken(`#token=${t}`), t);
  assert.equal(parseBookingToken(`#token=${t}&x=1`), null);
  assert.equal(parseBookingToken("#token=short"), null);
  assert.equal(parseBookingToken(""), null);
});
test("url keeps token in fragment", () => {
  assert.equal(
    buildBookingUrl("https://a.test", "/lexy/", t),
    `https://a.test/lexy/book-interview#token=${t}`,
  );
  assert.equal(
    buildBookingUrl("https://a.test", "/", t),
    `https://a.test/book-interview#token=${t}`,
  );
});
test("created response is validated", () => {
  assert.throws(() =>
    parseLinkCreated({ version: "v", active: true, expiresAt: "2030-01-01T00:00:00Z", token: "x" }),
  );
  assert.ok(
    parseLinkCreated({ version: "v", active: true, expiresAt: "2030-01-01T00:00:00Z", token: t }),
  );
});
