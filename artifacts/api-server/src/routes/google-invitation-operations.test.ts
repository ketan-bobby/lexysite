import test, { mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { CalendarError } from "../lib/outlook-calendar-core";
import type { GoogleInvitationCaller } from "../lib/google-invitation-store";
mock.module(new URL("../lib/auth-token.ts", import.meta.url).href, {
  namedExports: {
    getAuthUserId: (req: { headers: Record<string, string> }) =>
      req.headers["x-fixture-actor"] ?? null,
  },
});
const { googleInvitationOperationsRouter } = await import("./google-invitation-operations");
test("Operation HTTP auth precedes service construction for GET and POST; foreign schedules are 404 and uncached", async () => {
  let constructed = 0,
    reads = 0,
    writes = 0;
  const app = express();
  app.use(express.json());
  app.use(
    googleInvitationOperationsRouter({
      async caller(id) {
        if (!id) throw new CalendarError(401, "unauthenticated", "Sign in");
        if (id === "candidate") throw new CalendarError(403, "staff_required", "Staff only");
        return {
          id,
          tenantId: "fixture-employer",
          role: "recruiter",
          status: "active",
        } as GoogleInvitationCaller;
      },
      service() {
        constructed++;
        return {
          async review(c, id) {
            reads++;
            assert.equal(c.id, "staff");
            assert.equal(id, "foreign");
            throw new CalendarError(404, "not_found", "Not found");
          },
          async apply(c, id) {
            writes++;
            assert.equal(c.id, "staff");
            assert.equal(id, "foreign");
            throw new CalendarError(404, "not_found", "Not found");
          },
        };
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/google-calendar/schedules/foreign/invitation/operation`;
  try {
    for (const method of ["GET", "POST"]) {
      for (const [who, code] of [
        ["", 401],
        ["candidate", 403],
      ] as const) {
        const r = await fetch(url, { method, headers: who ? { "x-fixture-actor": who } : {} });
        assert.equal(r.status, code);
        assert.equal(r.headers.get("cache-control"), "no-store");
      }
    }
    assert.equal(constructed, 0);
    for (const method of ["GET", "POST"]) {
      const r = await fetch(url, { method, headers: { "x-fixture-actor": "staff" } });
      assert.equal(r.status, 404);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    assert.equal(reads, 1);
    assert.equal(writes, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
