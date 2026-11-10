import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import {
  dbAdmin,
  candidatesTable,
  tenantsTable,
  communicationEventsTable,
  auditLogsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { listMailHolds, reviewMailHold, MailHoldConflict } from "./mail-hold-review";
import {
  cadencedCommunicationStore,
  createCadencedCommunicationSender,
} from "./cadenced-communication";

async function fixture(t: TestContext, count = 1) {
  const tenantId = `hold_test_${randomUUID()}`,
    candidateId = randomUUID();
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: tenantId, name: "Synthetic mail hold", slug: tenantId });
  t.after(async () => {
    await dbAdmin
      .delete(auditLogsTable)
      .where(and(eq(auditLogsTable.subjectId, candidateId), eq(auditLogsTable.tenantId, tenantId)));
    await dbAdmin
      .delete(communicationEventsTable)
      .where(eq(communicationEventsTable.candidateId, candidateId));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, candidateId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId,
    firstName: "Synthetic",
    lastName: "Hold",
    email: "hold@example.invalid",
    pool: "tenant",
  });
  const records = Array.from({ length: count }, () => ({
    id: `candidate-cadence:self_report:${randomUUID()}`,
    tenantId,
    candidateId,
    type: "follow_up" as const,
    channel: "email" as const,
    status: "pending" as const,
    subject: "Private subject",
    body: "Private content",
  }));
  await dbAdmin.insert(communicationEventsTable).values(records);
  const rows = () => listMailHolds(undefined, candidateId);
  const input = async () => ({
    operationId: records[0]!.id,
    version: (await rows()).data.find((r) => r.operationId === records[0]!.id)!.version,
    disposition: "closed_no_resend" as const,
    evidenceReference: "CASE-123",
    acknowledgeNoResend: true as const,
  });
  return { tenantId, candidateId, records, rows, input };
}
test("hold close is audited without changing send state or exposing message content", async (t) => {
  const f = await fixture(t);
  const before = await f.rows();
  assert.equal(before.data.length, 1);
  assert.deepEqual(
    Object.keys(before.data[0]!).sort(),
    [
      "candidateId",
      "kind",
      "lastReview",
      "lastReviewedAt",
      "operationId",
      "reservedAt",
      "tenantId",
      "version",
    ].sort(),
  );
  assert(!JSON.stringify(before).includes("Private"));
  const result = await reviewMailHold("synthetic-operator", await f.input());
  assert.equal(result.holdRetained, true);
  const [event] = await dbAdmin
    .select()
    .from(communicationEventsTable)
    .where(eq(communicationEventsTable.id, f.records[0]!.id));
  assert.equal(event!.status, "pending");
  assert.equal(event!.sentAt, null);
  const [audit] = await dbAdmin
    .select()
    .from(auditLogsTable)
    .where(eq(auditLogsTable.id, result.reviewId));
  assert.equal(audit!.actorId, "synthetic-operator");
  assert.equal(audit!.subjectId, f.candidateId);
  assert.equal((audit!.metadata as Record<string, unknown>).holdRetained, true);
  assert.equal((await f.rows()).data[0]!.lastReview, "closed_no_resend");
  let sends = 0;
  const sender = createCadencedCommunicationSender({
    ...cadencedCommunicationStore,
    send: async () => {
      sends++;
      return { ok: true, acceptance: "accepted" };
    },
  });
  const retry = await sender({
    tenantId: f.tenantId,
    candidateId: f.candidateId,
    ownerTenantId: f.tenantId,
    kind: "self_report",
    intervalDays: 30,
    to: "hold@example.invalid",
    subject: "Synthetic",
    body: "Synthetic",
    actorLabel: "Synthetic",
    action: "fixture",
  });
  assert.equal(retry.reviewRequired, true);
  assert.equal(sends, 0, "closing review must not release the original cadence hold");
});
test("concurrent reviews allow one winner and stale replay cannot append a second decision", async (t) => {
  const f = await fixture(t),
    input = await f.input();
  const results = await Promise.allSettled([
    reviewMailHold("operator-a", input),
    reviewMailHold("operator-b", input),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert(failed.reason instanceof MailHoldConflict);
  assert.equal(failed.reason.status, 409);
  await assert.rejects(
    reviewMailHold("operator-a", input),
    (e) => e instanceof MailHoldConflict && e.status === 409,
  );
});
test("sender completion invalidates the queue; review never overwrites accepted mail", async (t) => {
  const f = await fixture(t),
    input = await f.input();
  await dbAdmin
    .update(communicationEventsTable)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(communicationEventsTable.id, input.operationId));
  await assert.rejects(
    reviewMailHold("operator", input),
    (e) => e instanceof MailHoldConflict && e.status === 404,
  );
  assert.equal((await f.rows()).data.length, 0);
});
test("same-status sender bookkeeping changes xmin and invalidates an old review token", async (t) => {
  const f = await fixture(t),
    input = await f.input();
  await dbAdmin
    .update(communicationEventsTable)
    .set({ status: "pending" })
    .where(eq(communicationEventsTable.id, input.operationId));
  await assert.rejects(
    reviewMailHold("operator", input),
    (e) => e instanceof MailHoldConflict && e.status === 409,
  );
});
test("erasure, DNC and tenant drift block review and listing", async (t) => {
  for (const update of [
    { doNotContact: true },
    { tenantId: "platform" },
    { dataErasedAt: new Date() },
  ]) {
    const f = await fixture(t),
      input = await f.input();
    await dbAdmin.update(candidatesTable).set(update).where(eq(candidatesTable.id, f.candidateId));
    assert.equal((await f.rows()).data.length, 0);
    await assert.rejects(
      reviewMailHold("operator", input),
      (e) => e instanceof MailHoldConflict && e.status === 404,
    );
  }
});
test("unrecognized ledgers and non-email records cannot be resolved by this tool", async (t) => {
  const f = await fixture(t),
    input = await f.input();
  await dbAdmin
    .update(communicationEventsTable)
    .set({ channel: "sms" })
    .where(eq(communicationEventsTable.id, input.operationId));
  assert.equal((await f.rows()).data.length, 0);
  await assert.rejects(
    reviewMailHold("operator", input),
    (e) => e instanceof MailHoldConflict && e.status === 404,
  );
  await dbAdmin
    .update(communicationEventsTable)
    .set({ channel: "email", id: `unrecognized:${randomUUID()}` })
    .where(eq(communicationEventsTable.id, input.operationId));
  assert.equal((await f.rows()).data.length, 0);
});
test("cursor queue is bounded and review can be retained after fresh reload", async (t) => {
  const f = await fixture(t, 51),
    first = await f.rows();
  assert.equal(first.data.length, 50);
  assert.equal(first.hasMore, true);
  const next = await listMailHolds(first.nextCursor!, f.candidateId);
  assert.equal(next.data.length, 1);
  assert.equal(next.hasMore, false);
  assert.equal(next.nextCursor, null);
  assert(!first.data.some((r) => r.operationId === next.data[0]!.operationId));
  await reviewMailHold("operator", await f.input());
  const retained = await reviewMailHold("operator", {
    ...(await f.input()),
    disposition: "keep_held",
  });
  assert.equal(retained.holdRetained, true);
  assert.equal(
    (await f.rows()).data.find((r) => r.operationId === f.records[0]!.id)!.lastReview,
    "keep_held",
  );
});
