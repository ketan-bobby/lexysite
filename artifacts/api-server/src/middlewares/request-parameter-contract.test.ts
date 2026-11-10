import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express, { type RequestHandler } from "express";
import { admit, createSemaphore } from "../lib/admission";
import { fingerprintFor, requireInterviewSessionCookie } from "../lib/interview-session-cookie";
import { rateLimit, stringRouteParam } from "./rateLimit";
import { csrfOriginGuard, requireSameOriginPost } from "./requireSameOriginPost";

let server: Server;
let origin: string;
const keys: string[] = [];
const semaphore = createSemaphore(1, 50);
let releases = 0;
const capacity = {
  ...semaphore,
  release() {
    releases++;
    semaphore.release();
  },
};
const limiter = rateLimit({
  windowMs: 1000,
  max: 2,
  keyFn: (req) => stringRouteParam(req, "id") || "non-scalar",
  store: {
    backend: "memory",
    async hit(key) {
      keys.push(key);
      return { count: key.startsWith("blocked::") ? 3 : 1, ttlMs: 1000 };
    },
  },
});

before(async () => {
  const app = express();
  app.post(
    "/named/:id",
    requireSameOriginPost,
    csrfOriginGuard,
    limiter,
    admit(capacity),
    (req, res) => {
      const id: string = req.params.id;
      // @ts-expect-error Named parameters are not wildcard arrays.
      const array: string[] = req.params.id;
      void array;
      res.json({ id });
    },
  );
  app.post(
    "/wild/*id",
    requireSameOriginPost,
    csrfOriginGuard,
    limiter,
    admit(capacity),
    (req, res) => {
      const id: string[] = req.params.id;
      // @ts-expect-error Wildcard parameters are not scalar IDs.
      const scalar: string = req.params.id;
      void scalar;
      res.json({ id });
    },
  );
  app.post(
    /^\/regex\/([^/]+)$/,
    requireSameOriginPost,
    csrfOriginGuard,
    limiter,
    admit(capacity),
    (req, res) => {
      const id: string = req.params[0];
      res.json({ id });
    },
  );
  // Compile the cookie guard against both route shapes; never hit a live DB.
  const namedCookie: RequestHandler<{ interviewId: string }> = requireInterviewSessionCookie;
  const wildcardCookie: RequestHandler<{ interviewId: string[] }> = requireInterviewSessionCookie;
  void wildcardCookie;
  app.post("/cookie-missing", namedCookie, (_req, res) => res.json({ unexpected: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
});

test("shared middleware preserves named, wildcard and regex parameter contracts", async () => {
  for (const [path, expected] of [
    ["/named/one%20two", { id: "one two" }],
    ["/wild/one/two", { id: ["one", "two"] }],
    ["/regex/old-id", { id: "old-id" }],
  ] as const) {
    const result = await fetch(`${origin}${path}`, { method: "POST", headers: { Origin: origin } });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), expected);
  }
  assert.equal(releases, 3, "finish and close must release capacity only once per response");
  assert.equal(semaphore.inFlight(), 0);
  assert.ok(keys.some((key) => key.startsWith("one two::")));
  assert.ok(keys.some((key) => key.startsWith("non-scalar::")));
});

test("hostile origins and rate-limit rejection still precede capacity admission", async () => {
  const before = releases;
  const denied = await fetch(`${origin}/named/one`, {
    method: "POST",
    headers: { Origin: "https://hostile.invalid" },
  });
  assert.equal(denied.status, 403);
  const limited = await fetch(`${origin}/named/blocked`, {
    method: "POST",
    headers: { Origin: origin },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.equal(releases, before);
  assert.equal(semaphore.inFlight(), 0);
});

test("scalar key extraction never coerces arrays or absent values into session IDs", () => {
  for (const params of [null, undefined, [], { id: ["one", "two"] }, { id: 12 }]) {
    assert.equal(stringRouteParam({ params }, "id"), undefined);
  }
  assert.equal(stringRouteParam({ params: { id: "one" } }, "id"), "one");
});

test("cookie guard still rejects absent session IDs before database access", async () => {
  const result = await fetch(`${origin}/cookie-missing`, { method: "POST" });
  assert.equal(result.status, 400);
  assert.deepEqual(await result.json(), { error: "interviewId required" });
});

test("fingerprint calculation retains user-agent binding and IPv4 network prefix", () => {
  const value = fingerprintFor({
    headers: { "user-agent": "fixture" },
    ip: "192.0.2.19",
  } as express.Request<unknown>);
  assert.equal(value.ipPrefix, "192.0.2.0/24");
  assert.equal(value.fp.length, 64);
});
