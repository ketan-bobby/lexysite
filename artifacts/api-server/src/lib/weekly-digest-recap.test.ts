import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  dbAdmin,
  candidatesTable,
  tenantsTable,
  communicationEventsTable,
  candidateNotificationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createCadencedCommunicationSender,
  cadencedCommunicationStore,
  type CadencedCommunication,
} from "./cadenced-communication";
import {
  createWeeklyDigestRecapStore,
  persistWeeklyDigestRecap,
  recoverWeeklyDigestRecaps,
} from "./weekly-digest-recap";
import type { SendEmailResult } from "./email";

async function fixture(
  t: TestContext,
  result: SendEmailResult = { ok: true, acceptance: "accepted" },
) {
  const tenantId = `recap_test_${randomUUID()}`,
    candidateId = randomUUID();
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: tenantId, name: "Synthetic recap fixture", slug: tenantId });
  t.after(async () => {
    await dbAdmin
      .delete(candidateNotificationsTable)
      .where(eq(candidateNotificationsTable.candidateId, candidateId));
    await dbAdmin
      .delete(communicationEventsTable)
      .where(eq(communicationEventsTable.candidateId, candidateId));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, candidateId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId,
    pool: "platform",
    userId: 'synthetic-owner:"é"',
    firstName: "Synthetic",
    lastName: "Recap",
    email: "récovery@example.invalid",
  });
  let sends = 0;
  const send = createCadencedCommunicationSender({
    ...cadencedCommunicationStore,
    send: async () => {
      sends++;
      return result;
    },
  });
  const input: CadencedCommunication = {
    candidateId,
    tenantId: "platform",
    ownerTenantId: tenantId,
    kind: "weekly_digest",
    intervalDays: 6,
    to: "récovery@example.invalid",
    subject: "Synthetic weekly email",
    body: "Candidate-owned weekly digest",
    actorLabel: "Synthetic recap fixture",
    action: "weekly_digest",
    weeklyRecap: { userId: 'synthetic-owner:"é"', periodEnd: new Date("2026-11-01T15:22:00Z") },
  };
  const receipt = await send(input);
  assert.ok(receipt.operationId);
  const operationId = receipt.operationId;
  const notifications = () =>
    dbAdmin
      .select()
      .from(candidateNotificationsTable)
      .where(eq(candidateNotificationsTable.candidateId, candidateId));
  return { tenantId, candidateId, input, send, operationId, notifications, sends: () => sends };
}

test("accepted receipt recovers a dated recap after a failed insert without sending again", async (t) => {
  const f = await fixture(t);
  const dialect = new PgDialect();
  let fail = true;
  const store = createWeeklyDigestRecapStore(async (query) => {
    if (dialect.sqlToQuery(query).sql.includes("INSERT INTO candidate_notifications") && fail) {
      fail = false;
      throw Error("Synthetic notification failure");
    }
    return dbAdmin.execute(query);
  });
  // The scheduler mirrors acceptance before attempting its bell write.
  // That unrelated timestamp change must not invalidate account identity.
  await dbAdmin
    .update(candidatesTable)
    .set({ weeklyDigestLastSentAt: new Date() })
    .where(eq(candidatesTable.id, f.candidateId));
  await assert.rejects(store.persistWeeklyDigestRecap(f.operationId));
  assert.equal((await f.notifications()).length, 0);
  assert.deepEqual(await store.recoverWeeklyDigestRecaps(f.operationId), {
    recovered: 1,
    failed: 0,
  });
  const [notification] = await f.notifications();
  assert.equal(notification.tenantId, "platform");
  assert.equal(notification.actionUrl, "/portal");
  assert.match(notification.title, /2026-11-01/);
  assert.match(notification.message, /period ending 2026-11-01/);
  assert.doesNotMatch(notification.message, /new badge|skill score|recruiters viewed/i);
  assert.equal(f.sends(), 1);
  assert.equal((await f.send(f.input)).reason, "cooldown");
  assert.equal(f.sends(), 1);
});

test("concurrent recap recovery creates one bell entry and preserves a read flag on replay", async (t) => {
  const f = await fixture(t);
  const outcomes = await Promise.all(
    Array.from({ length: 6 }, () => persistWeeklyDigestRecap(f.operationId)),
  );
  assert.equal(outcomes.filter(Boolean).length, 1);
  const [row] = await f.notifications();
  await dbAdmin
    .update(candidateNotificationsTable)
    .set({ isRead: true })
    .where(eq(candidateNotificationsTable.id, row.id));
  assert.equal(await persistWeeklyDigestRecap(f.operationId), false);
  assert.deepEqual(await recoverWeeklyDigestRecaps(f.operationId), { recovered: 0, failed: 0 });
  assert.equal((await f.notifications())[0].isRead, true);
  assert.equal(f.sends(), 1);
});

test("unknown, rejected, simulated and suppressed sends cannot create recovery notifications", async (t) => {
  for (const result of [
    { ok: false, reviewRequired: true },
    { ok: false, acceptance: "rejected" },
    { ok: true, simulated: true },
    { ok: true, suppressed: true },
  ] satisfies SendEmailResult[]) {
    const f = await fixture(t, result);
    assert.equal(await persistWeeklyDigestRecap(f.operationId), false);
    assert.deepEqual(await recoverWeeklyDigestRecaps(f.operationId), { recovered: 0, failed: 0 });
    assert.equal((await f.notifications()).length, 0);
    assert.equal(f.sends(), 1);
  }
});

test("current account, tenant, address, pool, DNC and erasure changes fence recovery", async (t) => {
  for (const change of [
    { userId: "different-synthetic-owner" },
    { tenantId: "platform" },
    { email: "different@example.invalid" },
    { pool: "tenant" },
    { doNotContact: true },
    { dataErasedAt: new Date() },
  ] as const) {
    const f = await fixture(t);
    await dbAdmin.update(candidatesTable).set(change).where(eq(candidatesTable.id, f.candidateId));
    assert.equal(await persistWeeklyDigestRecap(f.operationId), false);
    assert.deepEqual(await recoverWeeklyDigestRecaps(f.operationId), { recovered: 0, failed: 0 });
    assert.equal((await f.notifications()).length, 0);
  }
});

test("legacy, foreign-tenant and non-email receipts are not backfilled", async (t) => {
  for (const change of [
    { id: `candidate-cadence:weekly_digest:${randomUUID()}` },
    { tenantId: "foreign-recap-fixture" },
    { channel: "sms" as const },
    { sentAt: null },
    { status: "failed" as const },
    { status: "pending" as const },
  ]) {
    const f = await fixture(t);
    await dbAdmin
      .update(communicationEventsTable)
      .set(change)
      .where(eq(communicationEventsTable.id, f.operationId));
    const id = change.id ?? f.operationId;
    assert.equal(await persistWeeklyDigestRecap(id), false);
    assert.deepEqual(await recoverWeeklyDigestRecaps(id), { recovered: 0, failed: 0 });
  }
});

test("later delivered or opened status still proves acceptance for recap recovery", async (t) => {
  for (const status of ["delivered", "opened"] as const) {
    const f = await fixture(t);
    await dbAdmin
      .update(communicationEventsTable)
      .set({ status })
      .where(eq(communicationEventsTable.id, f.operationId));
    assert.equal(await persistWeeklyDigestRecap(f.operationId), true);
    assert.equal((await f.notifications()).length, 1);
    assert.equal(f.sends(), 1);
  }
});

test("account drift before reservation is rejected before transport", async (t) => {
  const f = await fixture(t);
  await dbAdmin
    .delete(communicationEventsTable)
    .where(eq(communicationEventsTable.id, f.operationId));
  await dbAdmin
    .update(candidatesTable)
    .set({ userId: "different-owner" })
    .where(eq(candidatesTable.id, f.candidateId));
  assert.equal((await f.send(f.input)).reason, "profile_changed");
  assert.equal(f.sends(), 1);
});
