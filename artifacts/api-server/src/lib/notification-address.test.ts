import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicNotificationAddress } from "./notification-address";

test("startup warnings never send public mail to fixture or reserved domains", () => {
  for (const domain of [
    "fixture.invalid",
    "test.invalid",
    "demo.local",
    "company.test",
    "localhost",
    "localhost.localdomain",
    "example.com",
    "sub.example.org",
    "EXAMPLE.NET",
    "invalid.",
    "sub.example",
    "sub.localhost",
  ]) {
    assert.equal(isPublicNotificationAddress(`admin@${domain}`), false, domain);
  }
});
test("real addresses are not suppressed because their name contains test", () => {
  for (const email of ["test@linxap.com", "admin@l3xy.ai", " Admin@Linxap.com "]) {
    assert.equal(isPublicNotificationAddress(email), true);
  }
});
test("malformed notification addresses are not submitted", () => {
  for (const email of ["", "no-at-sign", "@linxap.com", "admin@@linxap.com", "admin @linxap.com"]) {
    assert.equal(isPublicNotificationAddress(email), false);
  }
});
