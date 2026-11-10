import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dbAdmin, recruitingWorkflowEventsTable as events } from "@workspace/db";
import type { AtsInvitationEvidence } from "@workspace/api-zod";
import {
  invitationEmailTags,
  parseInvitationProviderEvent,
} from "../lib/interview-provider-policy";
import { recordInvitationProviderEvent } from "../lib/interview-provider-events";
type Actor = "admin" | "candidate" | "foreign" | "platform" | null;
type Request = (
  method: string,
  path: string,
  body?: unknown,
  actor?: Actor,
) => Promise<{ status: number; body: unknown }>;
export async function checkInvitationEvidenceHttp(p: {
  request: Request;
  path: string;
  jobId: string;
  workflowId: string;
  recipient: string;
  simulated: boolean;
  sendCount: () => number;
  readCount: () => number;
}) {
  const { request } = p,
    count = p.sendCount(),
    reads = p.readCount();
  const get = async () => {
    const result = await request("GET", p.path);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body as AtsInvitationEvidence;
  };
  let view = await get();
  assert.equal(view.providerStatus, "unobserved");
  assert.equal(view.canReconcile, false);
  assert.ok(view.attemptId, "new claims retain an exact attempt identity");
  const ack = { attemptId: view.attemptId, reviewHash: view.reviewHash, acknowledge: true };
  for (const [actor, status] of [
    [null, 401],
    ["candidate", 403],
    ["foreign", 404],
    ["platform", 403],
  ] as const) {
    assert.equal((await request("GET", p.path, undefined, actor)).status, status);
    assert.equal((await request("POST", p.path, ack, actor)).status, status);
  }
  assert.equal((await request("POST", p.path, { ...ack, acknowledge: false })).status, 400);
  assert.equal(
    (await request("POST", p.path, { ...ack, providerStatus: "delivered" })).status,
    400,
  );
  assert.equal((await request("POST", p.path, ack)).status, 409);
  const tags = Object.fromEntries(
    invitationEmailTags("interview.greenhouse.invite", {
      attemptId: view.attemptId,
      sessionId: view.sessionId,
      jobId: p.jobId,
      workflowId: p.workflowId,
    })!.map((t) => [t.Name, [t.Value]]),
  );
  const build = (kind: string, recipient = p.recipient, messageId = "fixture-signed-ses") =>
    parseInvitationProviderEvent({
      eventType: kind,
      mail: { messageId, tags, destination: [recipient], timestamp: "2026-11-08T01:00:00Z" },
      delivery: { timestamp: "2026-11-08T02:00:00Z", recipients: [recipient] },
      deliveryDelay: {
        timestamp: "2026-11-08T03:00:00Z",
        delayedRecipients: [{ emailAddress: recipient }],
      },
      bounce: {
        timestamp: "2026-11-08T04:00:00Z",
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: recipient }],
      },
    })!;
  const accepted = build("Send");
  for (const bad of [
    { ...accepted, attemptId: randomUUID() },
    { ...accepted, sessionId: randomUUID() },
    { ...accepted, jobId: randomUUID() },
    { ...accepted, workflowId: randomUUID() },
    build("Send", "foreign@example.invalid"),
  ])
    assert.equal((await recordInvitationProviderEvent(bad)).updated, false);
  if (p.simulated) {
    assert.equal((await recordInvitationProviderEvent(accepted)).updated, false);
    assert.equal((await get()).providerStatus, "unobserved");
    assert.equal((await request("POST", p.path, ack)).status, 409);
    assert.equal(p.sendCount(), count);
    return accepted;
  }
  assert.equal((await recordInvitationProviderEvent(accepted)).updated, true);
  assert.equal((await recordInvitationProviderEvent(accepted)).updated, false);
  view = await get();
  assert.equal(view.providerStatus, "accepted");
  assert.equal(view.sendStatus, "review_required");
  assert.equal(view.canReconcile, true, "observations alone never rewrite the dispatch outcome");
  const stale = { attemptId: view.attemptId, reviewHash: view.reviewHash, acknowledge: true };
  assert.equal((await recordInvitationProviderEvent(build("Delivery"))).updated, true);
  assert.equal((await recordInvitationProviderEvent(build("DeliveryDelay"))).updated, true);
  assert.equal(
    (await get()).providerStatus,
    "delivered",
    "later delay cannot erase mail-server acceptance",
  );
  assert.equal((await recordInvitationProviderEvent(build("Bounce"))).updated, true);
  assert.equal((await get()).providerStatus, "bounced");
  assert.equal(
    (await recordInvitationProviderEvent({ ...build("Delivery"), id: randomUUID() })).updated,
    true,
  );
  assert.equal(
    (await get()).providerStatus,
    "bounced",
    "late delivery cannot erase terminal failure",
  );
  assert.equal(
    (await recordInvitationProviderEvent(build("Send", p.recipient, "conflicting-message")))
      .updated,
    false,
  );
  assert.equal((await request("POST", p.path, stale)).status, 409);
  view = await get();
  const confirm = { attemptId: view.attemptId, reviewHash: view.reviewHash, acknowledge: true };
  const pair = await Promise.all([
    request("POST", p.path, confirm),
    request("POST", p.path, confirm),
  ]);
  assert.ok(
    pair.every((r) => r.status === 200),
    JSON.stringify(pair),
  );
  view = pair[0].body as AtsInvitationEvidence;
  assert.equal(view.sendStatus, "provider_accepted");
  assert.equal(view.providerStatus, "bounced");
  assert.equal(view.canReconcile, false);
  assert.equal((await request("POST", p.path, confirm)).status, 200);
  const rows = await dbAdmin
    .select()
    .from(events)
    .where(
      and(
        eq(events.jobId, p.jobId),
        eq(events.workflowId, p.workflowId),
        eq(events.action, "ats.interview.invitation.reconciled"),
      ),
    );
  assert.equal(rows.filter((r) => r.note?.includes(String(view.attemptId))).length, 1);
  assert.ok(!JSON.stringify(rows).includes(p.recipient), "audit does not copy recipient addresses");
  assert.equal(p.sendCount(), count, "reconciliation never resends");
  assert.equal(
    p.readCount(),
    reads,
    "provider observations and recognition require no provider calls",
  );
  return accepted;
}
