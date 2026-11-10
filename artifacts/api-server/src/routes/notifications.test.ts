import { readJsonObject, readJsonRows } from "../test-utils/json-response";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray, sql } from "drizzle-orm";
import { dbAdmin, tenantsTable, usersTable, userNotificationsTable } from "@workspace/db";
import router from "./notifications";
import { withTenantContext } from "../middlewares/withTenantContext";
import { issueToken } from "../lib/auth-token";
import { notificationCursor } from "../lib/notification-cursor";

const prefix = `notif_${randomUUID()}`;
const tenant = `${prefix}_tenant`;
const foreignTenant = `${prefix}_foreign`;
const own = `${prefix}_own`;
const peer = `${prefix}_peer`;
const foreign = `${prefix}_other`;
const suspended = `${prefix}_suspended`;
const userIds = [own, peer, foreign, suspended];
let server: Server;
let base: string;
const headers = (userId = own) => ({
  Authorization: `Bearer ${issueToken({
    userId,
    role: "tenant_admin",
    tenantId: userId === foreign ? foreignTenant : tenant,
  })}`,
});
const get = (path: string, userId = own) => fetch(`${base}${path}`, { headers: headers(userId) });

before(async () => {
  await dbAdmin.insert(tenantsTable).values(
    [tenant, foreignTenant].map((id) => ({
      id,
      name: "Synthetic notification test",
      slug: id,
      type: "direct" as const,
    })),
  );
  await dbAdmin.insert(usersTable).values(
    userIds.map((id) => ({
      id,
      tenantId: id === foreign ? foreignTenant : tenant,
      name: "Synthetic notification operator",
      email: `${id}@example.invalid`,
      passwordHash: "unused-fixture-password",
      role: "tenant_admin" as const,
      status: id === suspended ? ("suspended" as const) : ("active" as const),
    })),
  );
  await dbAdmin.insert(userNotificationsTable).values([
    ...Array.from({ length: 130 }, (_, i) => ({
      id: `${prefix}_${String(i).padStart(3, "0")}`,
      tenantId: tenant,
      userId: own,
      type: "offer_action",
      title: `Synthetic alert ${i}`,
      message: "No live offer or send",
      // Deliberately narrower than one JS millisecond, including timestamp ties.
      createdAt: sql`'2026-10-01 00:00:00'::timestamp + ${Math.floor(i / 2)} * interval '1 microsecond'`,
    })),
    ...[peer, foreign].map((userId) => ({
      id: `${userId}_notification`,
      tenantId: userId === foreign ? foreignTenant : tenant,
      userId,
      type: "offer_action",
      title: "Other user's private alert",
      message: "Must not leak",
    })),
  ]);
  const app = express();
  app.use(express.json());
  app.use(withTenantContext);
  app.use(router);
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    },
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbAdmin
    .delete(userNotificationsTable)
    .where(inArray(userNotificationsTable.userId, userIds));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, userIds));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [tenant, foreignTenant]));
});

test("notification history preserves the array contract and reaches every microsecond/tied row", async () => {
  const first = await get("/user-notifications");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  const firstItems = (await first.json()) as { id: string; createdAt: string }[];
  assert.equal(firstItems.length, 50);
  assert.equal(firstItems[0].id, `${prefix}_129`);
  assert.ok(firstItems.every((item) => typeof item.createdAt === "string"));
  assert.ok(first.headers.get("x-next-cursor"));
  const seen = firstItems.map((item) => item.id);
  let cursor = first.headers.get("x-next-cursor");
  while (cursor) {
    const r = await get(`/user-notifications?cursor=${encodeURIComponent(cursor)}`);
    assert.equal(r.status, 200);
    seen.push(...((await r.json()) as { id: string }[]).map((item) => item.id));
    cursor = r.headers.get("x-next-cursor");
  }
  assert.equal(seen.length, 130);
  assert.equal(new Set(seen).size, 130);
  assert.deepEqual(
    seen,
    Array.from({ length: 130 }, (_, i) => `${prefix}_${String(129 - i).padStart(3, "0")}`),
  );
});

test("new alerts do not shift an older page; count and read actions cover unloaded history", async () => {
  const first = await get("/user-notifications?limit=100");
  assert.equal((await readJsonRows(first)).length, 100);
  const cursor = first.headers.get("x-next-cursor")!;
  await dbAdmin.insert(userNotificationsTable).values({
    id: `${prefix}_fresh`,
    tenantId: tenant,
    userId: own,
    type: "offer_action",
    title: "Fresh fixture alert",
    message: "No send",
  });
  const older = await get(`/user-notifications?cursor=${encodeURIComponent(cursor)}&limit=100`);
  assert.equal((await readJsonRows(older)).length, 30);
  assert.equal(older.headers.get("x-next-cursor"), null);
  assert.equal((await readJsonObject(await get("/user-notifications/unread-count"))).count, 131);
  assert.equal(
    (
      await fetch(`${base}/user-notifications/${prefix}_000/read`, {
        method: "POST",
        headers: headers(),
      })
    ).status,
    200,
  );
  assert.equal((await readJsonObject(await get("/user-notifications/unread-count"))).count, 130);
  const oldRead = await get(`/user-notifications?cursor=${encodeURIComponent(cursor)}&limit=100`);
  const oldNotification = (await readJsonRows(oldRead)).find((n) => n.id === `${prefix}_000`);
  assert.ok(oldNotification, "the older notification must remain present");
  assert.equal(oldNotification.isRead, true);
});

test("invalid, foreign-user cursors and unauthenticated/suspended callers are rejected", async () => {
  assert.equal((await fetch(`${base}/user-notifications`)).status, 401);
  assert.equal((await get("/user-notifications", suspended)).status, 403);
  for (const query of ["limit=0", "limit=101", "limit=1.5", "cursor=bad!", "cursor="]) {
    assert.equal((await get(`/user-notifications?${query}`)).status, 400);
  }
  const foreignCursor = notificationCursor(foreign, "x", "2026-10-01T00:00:00.000000Z");
  assert.equal((await get(`/user-notifications?cursor=${foreignCursor}`)).status, 400);
  const badDate = Buffer.from(
    JSON.stringify({
      v: 1,
      userId: own,
      id: "x",
      at: "2026-02-30T00:00:00.000000Z",
    }),
  ).toString("base64url");
  assert.equal((await get(`/user-notifications?cursor=${badDate}`)).status, 400);
  const foreignRows = await readJsonRows(await get("/user-notifications", foreign));
  assert.equal(foreignRows.length, 1);
  assert.equal(foreignRows[0].userId, foreign);
  const peerRows = await readJsonRows(await get("/user-notifications", peer));
  assert.equal(peerRows.length, 1);
  assert.equal(peerRows[0].userId, peer);
  await fetch(`${base}/user-notifications/${peer}_notification/read`, {
    method: "POST",
    headers: headers(),
  });
  const [privateRow] = await dbAdmin
    .select()
    .from(userNotificationsTable)
    .where(eq(userNotificationsTable.id, `${peer}_notification`));
  assert.equal(privateRow.isRead, false);
});

test("mark-all-read remains caller scoped", async () => {
  assert.equal(
    (
      await fetch(`${base}/user-notifications/read-all`, {
        method: "POST",
        headers: headers(),
      })
    ).status,
    200,
  );
  assert.equal((await readJsonObject(await get("/user-notifications/unread-count"))).count, 0);
  assert.equal(
    (await readJsonObject(await get("/user-notifications/unread-count", peer))).count,
    1,
  );
  assert.equal(
    (await readJsonObject(await get("/user-notifications/unread-count", foreign))).count,
    1,
  );
});
