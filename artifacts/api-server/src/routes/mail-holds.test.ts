import assert from "node:assert/strict";
import { once } from "node:events";
import { test, mock } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import * as schema from "@workspace/db";

let callerId: string | null = "admin";
let caller: { id: string; role: string; status: string } | undefined = {
  id: "admin",
  role: "platform_admin",
  status: "active",
};
let reads = 0,
  reviews = 0,
  unavailable = false;
const fakeControlDb = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => (caller ? [caller] : []) }) }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...schema, controlDb: fakeControlDb } });
mock.module("../lib/auth-token", { namedExports: { getAuthUserId: () => callerId } });
class Conflict extends Error {
  constructor(public status: 404 | 409) {
    super("Hold changed");
  }
}
mock.module("../lib/mail-hold-review", {
  namedExports: {
    MailHoldConflict: Conflict,
    listMailHolds: async () => {
      reads++;
      return { data: [], hasMore: false, nextCursor: null };
    },
    reviewMailHold: async (_actor: string, input: Record<string, unknown>) => {
      reviews++;
      if (unavailable) throw new Error("private internal detail");
      if (input.operationId === "stale") throw new Conflict(409);
      return { reviewId: "review", disposition: input.disposition, holdRetained: true };
    },
  },
});
const { default: router } = await import("./mail-holds");
test("real HTTP router gates active platform admins, validates strict input, and preserves holds on errors", async (t) => {
  const app = express();
  app.use(
    express.json(),
    (req, _res, next) => {
      req.log = { error: () => {} } as unknown as typeof req.log;
      next();
    },
    router,
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/platform/mail-holds`;
  const body = {
    operationId: "fixture",
    version: "a".repeat(64),
    disposition: "closed_no_resend",
    evidenceReference: "CASE-123",
    acknowledgeNoResend: true,
  };
  const post = (data: unknown) =>
    fetch(`${base}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  callerId = null;
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await post(body)).status, 401);
  callerId = "admin";
  caller = undefined;
  assert.equal((await fetch(base)).status, 401);
  for (const role of [
    "candidate",
    "recruiter",
    "tenant_admin",
    "recruiter_admin",
    "hiring_manager",
  ]) {
    caller = { id: "admin", role, status: "active" };
    assert.equal((await fetch(base)).status, 403);
    assert.equal((await post(body)).status, 403);
  }
  caller = { id: "admin", role: "platform_admin", status: "suspended" };
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await post(body)).status, 401);
  assert.equal(reads, 0);
  assert.equal(reviews, 0);
  caller.status = "active";
  assert.equal((await fetch(base)).status, 200);
  assert.equal(reads, 1);
  for (const data of [
    { ...body, acknowledgeNoResend: false },
    { ...body, acknowledgeNoResend: "true" },
    { ...body, status: "sent" },
    { ...body, evidenceReference: "https://private" },
    { ...body, disposition: "retry" },
  ]) {
    assert.equal((await post(data)).status, 400);
  }
  assert.equal(reviews, 0);
  assert.equal((await post(body)).status, 200);
  assert.equal((await post({ ...body, operationId: "stale" })).status, 409);
  unavailable = true;
  const failed = await post(body);
  assert.equal(failed.status, 503);
  assert(!JSON.stringify(await failed.json()).includes("private internal"));
});
