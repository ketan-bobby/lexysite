import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildAccessLogRow, pruneHttpAccessLogs } from "./http-access-log.js";

/** Minimal Express-ish req/res doubles for the pure mapper. */
function makeReq(overrides: Record<string, unknown> = {}): any {
  return {
    method: "GET",
    baseUrl: "",
    path: "/",
    ip: "203.0.113.7",
    id: "req-abc",
    ...overrides,
  };
}
function makeRes(statusCode: number): any {
  return { statusCode };
}

describe("buildAccessLogRow", () => {
  test("unauthenticated request → null userId and null tenantId", () => {
    // No `resolvedUser` on the request = unauthenticated / 401 short-circuit.
    const req = makeReq({ baseUrl: "/api", path: "/api/jobs", method: "POST" });
    const row = buildAccessLogRow(req, makeRes(401), 12.6);
    assert.equal(row.userId, null);
    assert.equal(row.tenantId, null);
    assert.equal(row.statusCode, 401);
    assert.equal(row.method, "POST");
    assert.equal(row.requestId, "req-abc");
    assert.equal(row.responseTimeMs, 13); // rounded
    assert.equal(row.ip, "203.0.113.7");
  });

  test("prefers the registered route pattern over the raw URL (no ids)", () => {
    const req = makeReq({
      baseUrl: "/api",
      route: { path: "/jobs/:id" },
      path: "/api/jobs/9f1c2d3e-aaaa-bbbb-cccc-1234567890ab",
    });
    const row = buildAccessLogRow(req, makeRes(200), 5);
    assert.equal(row.routePattern, "/api/jobs/:id");
  });

  test("resolves userId/tenantId from req.resolvedUser when present", () => {
    const req = makeReq({
      baseUrl: "/api",
      route: { path: "/me" },
      resolvedUser: { id: "user-1", tenantId: "tenant-9" },
    });
    const row = buildAccessLogRow(req, makeRes(200), 3);
    assert.equal(row.userId, "user-1");
    assert.equal(row.tenantId, "tenant-9");
  });

  test("unmatched route (no route matched) → null pattern, never persists raw path content/PII", () => {
    // No `route` → 404 / middleware short-circuit. The raw path here carries an
    // email + a token-like segment; none of it must ever be persisted.
    const req = makeReq({
      baseUrl: "",
      path: "/api/candidates/jane.doe@example.com/reset/s3cr3t-Tok3n-0000",
    });
    const row = buildAccessLogRow(req, makeRes(404), 2);
    assert.equal(row.routePattern, null);
    assert.ok(!JSON.stringify(row).includes("jane.doe@example.com"));
    assert.ok(!JSON.stringify(row).includes("s3cr3t-Tok3n"));
  });
});

describe("pruneHttpAccessLogs", () => {
  // DB-backed test — only runs where a database is reachable.
  const hasDb = !!process.env.DATABASE_URL;
  let dbAdmin: any;
  let httpAccessLogsTable: any;
  let sql: any;
  const marker = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  before(async () => {
    if (!hasDb) return;
    ({ dbAdmin, httpAccessLogsTable } = await import("@workspace/db"));
    ({ sql } = await import("drizzle-orm"));
  });

  after(async () => {
    if (!hasDb || !dbAdmin) return;
    await dbAdmin.execute(sql`DELETE FROM http_access_logs WHERE request_id = ${marker}`);
  });

  test("drops rows older than the retention window, keeps recent rows", { skip: !hasDb }, async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    const recent = new Date(Date.now() - 1 * 24 * 60 * 60_000);

    await dbAdmin.insert(httpAccessLogsTable).values([
      { occurredAt: old, method: "GET", routePattern: "/api/x", statusCode: 200, requestId: marker },
      { occurredAt: recent, method: "GET", routePattern: "/api/x", statusCode: 200, requestId: marker },
    ]);

    const res = await pruneHttpAccessLogs({ retentionDays: 30 });
    assert.equal(res.error, undefined);
    assert.ok(res.deleted >= 1, "at least the >30d row should be deleted");

    const remaining: any = await dbAdmin.execute(
      sql`SELECT occurred_at FROM http_access_logs WHERE request_id = ${marker}`,
    );
    const rows = (remaining?.rows ?? remaining ?? []) as any[];
    assert.equal(rows.length, 1, "only the recent row should remain");
  });
});
