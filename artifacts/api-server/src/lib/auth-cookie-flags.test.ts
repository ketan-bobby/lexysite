import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingHttpHeaders } from "node:http";
import { SESSION_COOKIE_NAME, setSessionTokenCookie } from "./auth-token";

test("native HTTP headers preserve the existing HTTPS cookie decision", () => {
  const cases: { headers: IncomingHttpHeaders; secure: boolean }[] = [
    { headers: {}, secure: false },
    { headers: { "x-forwarded-proto": "https" }, secure: true },
    { headers: { "x-forwarded-proto": " HTTPS , http" }, secure: true },
    { headers: { "x-forwarded-proto": ["https", "http"] }, secure: true },
    { headers: { "x-forwarded-proto": ["http", "https"] }, secure: false },
    { headers: { "x-forwarded-proto": "http" }, secure: false },
  ];
  for (const scenario of cases) {
    const calls: { name: string; options: Record<string, unknown> }[] = [];
    setSessionTokenCookie(
      {
        cookie(name, _value, options) {
          calls.push({ name, options });
        },
      },
      "disposable-fixture-value",
      { headers: scenario.headers, protocol: "http" },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, SESSION_COOKIE_NAME);
    assert.equal(calls[0]!.options.secure, scenario.secure);
    assert.equal(calls[0]!.options.httpOnly, true);
    assert.equal(calls[0]!.options.sameSite, "lax");
    assert.equal(calls[0]!.options.path, "/api");
  }
});

test("direct secure requests retain precedence over forwarded HTTP", () => {
  for (const request of [
    { secure: true, protocol: "http", headers: { "x-forwarded-proto": "http" } },
    { secure: false, protocol: "https", headers: { "x-forwarded-proto": "http" } },
  ]) {
    let options: Record<string, unknown> | undefined;
    setSessionTokenCookie(
      {
        cookie(_name, _value, value) {
          options = value;
        },
      },
      "disposable-fixture-value",
      request,
    );
    assert.equal(options?.secure, true);
  }
});
