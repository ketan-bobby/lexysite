import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  tenantsTable,
  jobsTable,
  usersTable,
  candidatesTable,
  auditLogsTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
  type ControlledOfferRecord,
} from "@workspace/db";
import {
  applyOfferProviderEvent,
  offerEmailTags,
  parseOfferProviderEvent,
  recordOfferProviderEvent,
} from "./offer-provider-events";
import { journeySteps } from "./recruiting-workflows";
import { invitationEmailTags } from "./interview-provider-policy";

// Private-process test settings only: never saved into workspace Secrets.
process.env.INBOUND_EMAIL_SECRET = "isolated-provider-event-contract";
const topic = "arn:aws:sns:us-east-1:000000000000:isolated-offer-event-test";
process.env.SES_SNS_TOPIC_ARNS = topic;
process.env.ALLOW_UNSIGNED_SES_EVENTS = "false";
const prefix = `provider_event_${randomUUID()}`;
const tenantId = `${prefix}_tenant`,
  actorId = `${prefix}_actor`;
const jobId = randomUUID(),
  workflowId = randomUUID(),
  journeyId = randomUUID();
const candidateId = `${prefix}_candidate`;
const offer: ControlledOfferRecord = {
  id: randomUUID(),
  version: 1,
  status: "sent",
  testOnly: true,
  recipientEmail: `${prefix}@example.invalid`,
  createdBy: actorId,
  createdAt: "2026-10-10T10:00:00.000Z",
  approvedBy: actorId,
  approvedAt: "2026-10-10T10:01:00.000Z",
  deliveryAttemptId: randomUUID(),
  deliveryReceiptId: "isolated-ses-message",
  tokenHash: "private-fixture-capability-hash",
  terms: {
    employerName: "Fictional event-test employer",
    roleTitle: "Test-only role",
    amount: 100000,
    currency: "USD",
    frequency: "annual",
    location: "Remote",
    startDate: "2027-01-01",
    expiresAt: "2027-02-01T00:00:00.000Z",
    letter: "Fictional provider-event fixture, not a real employment offer.",
  },
};
const metadata = {
  workflowId,
  offerId: offer.id,
  version: 1,
  deliveryAttemptId: offer.deliveryAttemptId,
};
function payload(kind = "Delivery", at = "2026-10-10T10:02:00.000Z") {
  return {
    eventType: kind,
    mail: {
      messageId: offer.deliveryReceiptId,
      timestamp: at,
      destination: [offer.recipientEmail],
      tags: Object.fromEntries(
        offerEmailTags("offer.delivery", metadata)!.map((t) => [t.Name, [t.Value]]),
      ),
    },
    delivery: { timestamp: at, recipients: [offer.recipientEmail] },
    bounce: {
      timestamp: at,
      bounceType: "Permanent",
      bouncedRecipients: [{ emailAddress: offer.recipientEmail }],
    },
    deliveryDelay: { timestamp: at, delayedRecipients: [{ emailAddress: offer.recipientEmail }] },
    complaint: { timestamp: at, complainedRecipients: [{ emailAddress: offer.recipientEmail }] },
    reject: { reason: "fictional test rejection" },
  };
}
const event = (kind = "Delivery", at?: string) => parseOfferProviderEvent(payload(kind, at))!;

test("correlation tags contain only the exact offer version and attempt", () => {
  assert.equal(offerEmailTags("outreach.send", metadata), undefined);
  assert.equal(offerEmailTags("offer.delivery", { ...metadata, version: 0 }), undefined);
  assert.equal(offerEmailTags("offer.delivery", { ...metadata, offerId: "unsafe id" }), undefined);
  assert.deepEqual(
    offerEmailTags("offer.delivery", metadata)!.map((t) => t.Name),
    ["lexy_workflow", "lexy_offer", "lexy_version", "lexy_attempt"],
  );
  assert.equal(
    JSON.stringify(offerEmailTags("offer.delivery", metadata)).includes(offer.tokenHash!),
    false,
  );
});
test("SES legacy and configuration-set payloads normalize without inventing delivery", () => {
  for (const [kind, expected] of [
    ["Send", "accepted"],
    ["Delivery", "delivered"],
    ["DeliveryDelay", "delayed"],
    ["Bounce", "bounced"],
    ["Reject", "rejected"],
    ["Rendering Failure", "rejected"],
    ["Complaint", "complained"],
  ]) {
    assert.equal(event(kind).status, expected);
  }
  const transient = payload("Bounce");
  transient.bounce.bounceType = "Transient";
  assert.equal(parseOfferProviderEvent(transient)!.status, "delayed");
  const legacy: any = payload();
  legacy.notificationType = legacy.eventType;
  delete legacy.eventType;
  assert.equal(parseOfferProviderEvent(legacy)!.status, "delivered");
  assert.equal(parseOfferProviderEvent(payload("Open")), null);
  const malformed = payload();
  malformed.mail.tags.lexy_offer = ["ambiguous", offer.id];
  assert.equal(parseOfferProviderEvent(malformed), null);
  const invalidDate = payload("Delivery", "not-a-date");
  assert.equal(parseOfferProviderEvent(invalidDate), null);
  const malformedBounce: any = payload("Bounce");
  malformedBounce.bounce.bouncedRecipients = {};
  assert.equal(parseOfferProviderEvent(malformedBounce), null);
});
test("events require recipient, version, attempt and provider message identity", () => {
  for (const change of [
    { offerId: randomUUID() },
    { version: 2 },
    { attemptId: randomUUID() },
    { messageId: "another-message" },
    { recipients: ["someone-else@example.invalid"] },
  ]) {
    assert.equal(applyOfferProviderEvent(offer, { ...event(), ...change }), null);
  }
  assert.equal(applyOfferProviderEvent({ ...offer, status: "approved" }, event()), null);
});
test("delivery never changes human approval, responses, terms, tokens or uncertainty", () => {
  for (const status of [
    "sending",
    "send_uncertain",
    "accepted",
    "declined",
    "withdrawn",
  ] as const) {
    const input = { ...offer, status, respondedAt: "2026-10-10T10:03:00.000Z" };
    const updated = applyOfferProviderEvent(input, event())!;
    const { providerDelivery: _, ...rest } = updated;
    assert.deepEqual(rest, input);
    assert.equal(updated.providerDelivery!.status, "delivered");
  }
});
test("replays and out-of-order events cannot erase a bounce or complaint", () => {
  const delivered = applyOfferProviderEvent(offer, event())!;
  assert.equal(applyOfferProviderEvent(delivered, event()), null);
  const bounced = applyOfferProviderEvent(delivered, event("Bounce", "2026-10-10T10:01:00.000Z"))!;
  assert.equal(bounced.providerDelivery!.status, "bounced");
  const lateDelivery = applyOfferProviderEvent(
    bounced,
    event("Delivery", "2026-10-10T10:04:00.000Z"),
  )!;
  assert.equal(lateDelivery.providerDelivery!.status, "bounced");
  const complained = applyOfferProviderEvent(lateDelivery, event("Complaint"))!;
  assert.equal(complained.providerDelivery!.status, "complained");
});
test("bounded histories cannot grow on replay of an evicted event", () => {
  let current = offer;
  for (let i = 0; i < 30; i++) {
    current = applyOfferProviderEvent(
      current,
      event("Delivery", new Date(Date.parse("2026-10-10T10:00:00Z") + i * 1000).toISOString()),
    )!;
  }
  assert.equal(current.providerDelivery!.events.length, 16);
  assert.equal(
    applyOfferProviderEvent(current, event("Delivery", "2026-10-10T10:00:00.000Z")),
    null,
  );
});

let server: Server, base: string;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const certificateUrl = "https://sns.us-east-1.amazonaws.com/isolated-test-cert.pem";
const nativeFetch = globalThis.fetch;
function envelope(body: unknown, TopicArn = topic) {
  const value = {
    Type: "Notification",
    Message: JSON.stringify(body),
    MessageId: randomUUID(),
    Timestamp: "2026-10-10T10:03:00.000Z",
    TopicArn,
    SignatureVersion: "2",
    SigningCertURL: certificateUrl,
    Signature: "",
  };
  const canonical = ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
    .map((k) => `${k}\n${value[k as keyof typeof value]}\n`)
    .join("");
  value.Signature = createSign("RSA-SHA256").update(canonical).sign(keys.privateKey, "base64");
  return value;
}
async function request(
  body: unknown,
  secret = process.env.INBOUND_EMAIL_SECRET!,
  contentType = "application/json",
) {
  return nativeFetch(`${base}/webhooks/ses-events`, {
    method: "POST",
    headers: { "Content-Type": contentType, "x-webhook-secret": secret },
    body: JSON.stringify(body),
  });
}
before(async () => {
  await dbAdmin.insert(tenantsTable).values({
    id: tenantId,
    name: "Isolated provider fixture",
    slug: tenantId,
    clientType: "direct",
    status: "active",
  });
  await dbAdmin.insert(usersTable).values({
    id: actorId,
    tenantId,
    role: "tenant_admin",
    status: "active",
    name: "Provider event fixture",
    email: `${prefix}_actor@example.invalid`,
    passwordHash: "non-login-fixture",
  });
  await dbAdmin.insert(jobsTable).values({
    id: jobId,
    tenantId,
    createdById: actorId,
    title: "Isolated provider fixture",
    description: "No live send or provider request.",
    status: "draft",
  });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId,
    firstName: "Fictional",
    lastName: "Provider fixture",
    email: offer.recipientEmail,
    pool: "tenant",
    verificationResult: { syntheticFixture: { kind: "controlled_inbox" } },
  });
  const steps = journeySteps("human").map((s) =>
    s.key === "hiring_decision" ? { ...s, controlledOffer: offer } : s,
  );
  await dbAdmin.insert(journeys).values({
    id: journeyId,
    tenantId,
    jobId,
    version: 1,
    status: "draft",
    briefHash: "isolated",
    brief: {},
    interviewPath: "human",
    steps,
    createdById: actorId,
  });
  await dbAdmin.insert(workflows).values({
    id: workflowId,
    tenantId,
    jobId,
    candidateId,
    journeyId,
    journeyVersion: 1,
    interviewPath: "human",
    steps,
    createdById: actorId,
  });
  mock.method(globalThis, "fetch", async (input: any, init?: RequestInit) =>
    String(input) === certificateUrl
      ? new Response(keys.publicKey.export({ type: "spki", format: "pem" }).toString())
      : nativeFetch(input, init),
  );
  const router = (await import("../routes/webhooks")).default;
  const app = express();
  app.use(express.json(), router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
test("HTTP webhook refuses missing secret, invalid signature, wrong topic and unsigned offers", async () => {
  assert.equal((await request(envelope(payload()), "wrong-secret")).status, 401);
  const invalid = envelope(payload());
  invalid.Message += " ";
  assert.equal((await request(invalid)).status, 403);
  assert.equal((await request(envelope(payload(), topic + "-foreign"))).status, 403);
  assert.equal((await request(payload())).status, 400);
  process.env.ALLOW_UNSIGNED_SES_EVENTS = "true";
  try {
    assert.equal(
      (await request(payload())).status,
      403,
      "unsigned dev bypass cannot update offers",
    );
  } finally {
    process.env.ALLOW_UNSIGNED_SES_EVENTS = "false";
  }
});
test("invitation callbacks require signatures and the exact allowed topic even in unsigned test mode", async () => {
  const p = payload();
  const tags = invitationEmailTags("interview.greenhouse.invite", {
    attemptId: randomUUID(),
    sessionId: randomUUID(),
    jobId,
    workflowId,
  })!;
  p.mail.tags = Object.fromEntries(tags.map((t) => [t.Name, [t.Value]]));
  assert.equal((await request(envelope(p), "wrong-secret")).status, 401);
  const bad = envelope(p);
  bad.Signature = "invalid";
  assert.equal((await request(bad)).status, 403);
  assert.equal((await request(envelope(p, topic + "-foreign"))).status, 403);
  process.env.ALLOW_UNSIGNED_SES_EVENTS = "true";
  try {
    assert.equal((await request(p)).status, 403);
  } finally {
    process.env.ALLOW_UNSIGNED_SES_EVENTS = "false";
  }
  const signed = await request(envelope(p));
  assert.equal(signed.status, 200);
  assert.equal(
    ((await signed.json()) as { invitationDelivery: { updated: boolean } }).invitationDelivery
      .updated,
    false,
    "a signed unknown attempt cannot create evidence",
  );
});
test("signed HTTP delivery survives reload and replay without duplicate revision or audit event", async () => {
  assert.equal(
    (await request(envelope(payload()), process.env.INBOUND_EMAIL_SECRET!, "text/plain")).status,
    200,
  );
  assert.equal((await request(envelope(payload()))).status, 200);
  const [row] = await dbAdmin.select().from(workflows).where(eq(workflows.id, workflowId));
  assert.equal(row.revision, 2);
  const stored = row.steps.find((s) => s.controlledOffer)!.controlledOffer!;
  assert.equal(stored.providerDelivery!.status, "delivered");
  assert.equal(stored.status, "sent");
  assert.equal(stored.tokenHash, offer.tokenHash);
  assert.equal(stored.approvedBy, offer.approvedBy);
  const audit = await dbAdmin.select().from(events).where(eq(events.workflowId, workflowId));
  assert.equal(audit.length, 1);
});
test("concurrent bounce updates serialize and preserve candidate, terms and responses", async () => {
  const results = await Promise.all([
    recordOfferProviderEvent(event("Bounce")),
    recordOfferProviderEvent(event("Bounce")),
  ]);
  assert.equal(results.filter((r) => r.updated).length, 1);
  const [row] = await dbAdmin.select().from(workflows).where(eq(workflows.id, workflowId));
  const stored = row.steps.find((s) => s.controlledOffer)!.controlledOffer!;
  assert.equal(row.revision, 3);
  assert.equal(stored.providerDelivery!.status, "bounced");
  assert.deepEqual(stored.terms, offer.terms);
  assert.equal(stored.status, "sent");
  assert.equal(stored.respondedAt, undefined);
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId));
  assert.equal(candidate.doNotContact, false, "delivery recorder never alters candidate outcomes");
  assert.equal(
    (await recordOfferProviderEvent({ ...event(), workflowId: randomUUID() })).updated,
    false,
  );
  assert.equal(
    (await recordOfferProviderEvent({ ...event(), attemptId: randomUUID() })).updated,
    false,
  );
});
test("SES command carries exact tags and disables automatic financial-letter retries", async (t) => {
  const { sendEmail, isEmailConfigured } = await import("./email");
  if (!isEmailConfigured()) {
    t.skip("SES configuration unavailable; no live provider call attempted");
    return;
  }
  let command: any;
  let attempts: number | undefined;
  const fakeSend = mock.method(
    SESv2Client.prototype,
    "send",
    async function (this: SESv2Client, input: any) {
      command = input.input;
      attempts = await this.config.maxAttempts();
      return { MessageId: "mocked-only-provider-receipt" };
    },
  );
  try {
    const result = await sendEmail({
      to: offer.recipientEmail,
      subject: "Mocked-only provider fixture",
      text: "No live offer delivery.",
      audit: {
        tenantId,
        subjectType: "candidate",
        subjectId: candidateId,
        action: "offer.delivery",
        metadata,
      },
    });
    assert.equal(result.messageId, "mocked-only-provider-receipt");
    assert.equal(fakeSend.mock.callCount(), 1);
    assert.equal(attempts, 1);
    assert.deepEqual(command.EmailTags, offerEmailTags("offer.delivery", metadata));
    const invitationMetadata = {
      attemptId: randomUUID(),
      sessionId: randomUUID(),
      jobId,
      workflowId,
    };
    await sendEmail({
      to: offer.recipientEmail,
      subject: "Mocked-only interview fixture",
      text: "No live invitation.",
      singleAttempt: true,
      audit: {
        tenantId,
        subjectType: "candidate",
        subjectId: candidateId,
        action: "interview.greenhouse.invite",
        metadata: invitationMetadata,
      },
    });
    assert.equal(fakeSend.mock.callCount(), 2);
    assert.equal(attempts, 1);
    assert.deepEqual(
      command.EmailTags,
      invitationEmailTags("interview.greenhouse.invite", invitationMetadata),
    );
  } finally {
    fakeSend.mock.restore();
  }
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  mock.restoreAll();
  await dbAdmin.delete(events).where(eq(events.workflowId, workflowId));
  await dbAdmin.delete(auditLogsTable).where(eq(auditLogsTable.tenantId, tenantId));
  await dbAdmin.delete(workflows).where(eq(workflows.id, workflowId));
  await dbAdmin.delete(journeys).where(eq(journeys.id, journeyId));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, candidateId));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.id, jobId));
  await dbAdmin.delete(usersTable).where(eq(usersTable.id, actorId));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  await pool.end();
});
