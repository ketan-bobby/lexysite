import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { candidateGoogleMeetRouter } from "./candidate-google-meet";

test("candidate Meet route denies other roles, hides foreign IDs and never leaks private evidence", async () => {
  let reads = 0;
  const self = {
    userId: "portal-user",
    candidateId: "canonical-candidate",
    tenantId: "portal-tenant",
  };
  const app = express().use(
    candidateGoogleMeetRouter({
      session: async (req) => (req.headers.authorization === "candidate" ? self : null),
      read: async (session, id) => {
        reads++;
        assert.deepEqual(session, self);
        if (id === "unavailable") throw new Error("private evidence must not escape");
        return id === "owned"
          ? {
              scheduleId: id,
              scheduledAt: new Date("2060-01-01"),
              durationMinutes: 30,
              status: "ready" as const,
              meetUrl: "https://meet.google.com/abc-defg-hij",
            }
          : null;
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    for (const authorization of ["", "staff", "admin"]) {
      const r = await fetch(
        `http://127.0.0.1:${address.port}/portal/interview-schedules/owned/google-meet`,
        { headers: { authorization } },
      );
      assert.equal(r.status, 401);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    assert.equal(reads, 0);
    for (const id of ["foreign", "missing"]) {
      const r = await fetch(
        `http://127.0.0.1:${address.port}/portal/interview-schedules/${id}/google-meet`,
        { headers: { authorization: "candidate" } },
      );
      assert.equal(r.status, 404);
      assert.deepEqual(await r.json(), { error: "Appointment not found." });
    }
    const r = await fetch(
      `http://127.0.0.1:${address.port}/portal/interview-schedules/owned/google-meet`,
      { headers: { authorization: "candidate" } },
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const body = await r.json();
    assert.ok(body && typeof body === "object");
    assert.deepEqual(Object.keys(body).sort(), [
      "durationMinutes",
      "meetUrl",
      "scheduleId",
      "scheduledAt",
      "status",
    ]);
    const p = await fetch(
      `http://127.0.0.1:${address.port}/portal/interview-schedules/owned/google-meet`,
      { method: "POST", headers: { authorization: "candidate" } },
    );
    assert.equal(p.status, 404);
    const unavailable = await fetch(
      `http://127.0.0.1:${address.port}/portal/interview-schedules/unavailable/google-meet`,
      { headers: { authorization: "candidate" } },
    );
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await unavailable.text(), /private evidence/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
