/**
 * Unit tests for csrfOriginGuard (Phase 3a-1) — the conditional, API-wide
 * CSRF guard. Exercises every branch of the decision ladder:
 *
 *   safe method → skip
 *   Authorization header → skip (bearer is CSRF-immune)
 *   no session cookie → skip (nothing to forge)
 *   exempt path → skip
 *   cookie-only + same-origin Origin → pass
 *   cookie-only + cross-origin Origin → 403
 *   cookie-only + no Origin/Referer → 403 (fail closed)
 *
 * Pure middleware test — no DB, no HTTP server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  csrfOriginGuard,
  CSRF_EXEMPT,
  CSRF_SESSION_COOKIE,
} from "./requireSameOriginPost";
import { SESSION_COOKIE_NAME } from "../lib/auth-token";

type Headers = Record<string, string | undefined>;

function makeReq(opts: {
  method?: string;
  path?: string;
  headers?: Headers;
  cookies?: Record<string, string>;
  host?: string;
  protocol?: string;
}) {
  const headers = opts.headers ?? {};
  return {
    method: opts.method ?? "POST",
    path: opts.path ?? "/jobs",
    headers,
    cookies: opts.cookies ?? {},
    protocol: opts.protocol ?? "http",
    get(name: string) {
      if (name.toLowerCase() === "host") return opts.host ?? "api.test.local";
      return headers[name.toLowerCase()];
    },
  } as any;
}

function makeRes() {
  const state = { statusCode: 0, body: undefined as unknown };
  return {
    state,
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  } as any;
}

function run(req: any): { nextCalled: boolean; status: number } {
  const res = makeRes();
  let nextCalled = false;
  csrfOriginGuard(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, status: res.state.statusCode };
}

const COOKIE = { [CSRF_SESSION_COOKIE]: "tok_abc123" };

test("cookie name stays in sync with lib/auth-token", () => {
  assert.equal(CSRF_SESSION_COOKIE, SESSION_COOKIE_NAME);
});

test("safe methods always pass, even cookie-only cross-origin", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const r = run(
      makeReq({ method, cookies: COOKIE, headers: { origin: "https://evil.example" } }),
    );
    assert.equal(r.nextCalled, true, method);
  }
});

test("bearer-authed POST with no Origin passes (curl/mobile unaffected)", () => {
  const r = run(makeReq({ headers: { authorization: "some-token" } }));
  assert.equal(r.nextCalled, true);
});

test("bearer wins even when a cookie is also present (transition state)", () => {
  const r = run(
    makeReq({ headers: { authorization: "some-token" }, cookies: COOKIE }),
  );
  assert.equal(r.nextCalled, true);
});

test("anonymous POST (no cookie, no header, no Origin) passes through to route auth", () => {
  const r = run(makeReq({}));
  assert.equal(r.nextCalled, true);
});

test("cookie-only + same-origin Origin passes", () => {
  const r = run(
    makeReq({ cookies: COOKIE, headers: { origin: "http://api.test.local" } }),
  );
  assert.equal(r.nextCalled, true);
});

test("cookie-only + same-origin Referer (no Origin) passes", () => {
  const r = run(
    makeReq({ cookies: COOKIE, headers: { referer: "http://api.test.local/some/page" } }),
  );
  assert.equal(r.nextCalled, true);
});

test("cookie-only + cross-origin Origin is rejected 403", () => {
  const r = run(
    makeReq({ cookies: COOKIE, headers: { origin: "https://evil.example" } }),
  );
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 403);
});

test("cookie-only + missing Origin AND Referer is rejected 403 (fail closed)", () => {
  const r = run(makeReq({ cookies: COOKIE }));
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 403);
});

test("exempt paths skip the check even cookie-only with a hostile Origin", () => {
  const cases = [
    "/webhooks/inbound-email",
    "/billing/webhook",
    "/candidates/import",
    "/public/hm-share/tok123/decision",
    "/newsletter/subscribe",
    "/plans/start-trial",
    "/plans/demo",
    "/outreach/reply/tok123",
    "/outreach/reply-msg/tok123",
  ];
  for (const path of cases) {
    const r = run(
      makeReq({ path, cookies: COOKIE, headers: { origin: "https://evil.example" } }),
    );
    assert.equal(r.nextCalled, true, path);
  }
});

test("exact-match exemptions do not accidentally prefix-match", () => {
  // /billing/webhook is exact — /billing/webhook-evil must NOT be exempt
  const r = run(
    makeReq({
      path: "/billing/webhook-evil",
      cookies: COOKIE,
      headers: { origin: "https://evil.example" },
    }),
  );
  assert.equal(r.nextCalled, false);
  assert.equal(r.status, 403);
});

test("every exemption entry documents a reason", () => {
  for (const e of CSRF_EXEMPT) {
    assert.ok(e.reason && e.reason.length > 10, e.path);
  }
});

test("protected route sample: /jobs, /candidates, /outreach (non-reply) enforce", () => {
  for (const path of ["/jobs", "/candidates/abc/stage", "/outreach/send"]) {
    const r = run(
      makeReq({ path, cookies: COOKIE, headers: { origin: "https://evil.example" } }),
    );
    assert.equal(r.nextCalled, false, path);
    assert.equal(r.status, 403, path);
  }
});
