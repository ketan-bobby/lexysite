import { test } from "node:test";
import assert from "node:assert/strict";
import { invitationEmailTags, parseInvitationProviderEvent } from "./interview-provider-policy";
const metadata = {
  attemptId: "attempt-1",
  sessionId: "session-1",
  jobId: "job-1",
  workflowId: "workflow-1",
};
function payload(kind = "Delivery") {
  return {
    eventType: kind,
    mail: {
      messageId: "ses-message-1",
      timestamp: "2026-11-08T01:00:00Z",
      destination: ["candidate@example.invalid"],
      tags: Object.fromEntries(
        invitationEmailTags("interview.greenhouse.invite", metadata)!.map((t) => [
          t.Name,
          [t.Value],
        ]),
      ),
    },
    delivery: { timestamp: "2026-11-08T02:00:00Z", recipients: ["candidate@example.invalid"] },
    bounce: {
      bounceType: "Permanent",
      bouncedRecipients: [{ emailAddress: "candidate@example.invalid" }],
    },
    complaint: { complainedRecipients: [{ emailAddress: "candidate@example.invalid" }] },
    deliveryDelay: { delayedRecipients: [{ emailAddress: "candidate@example.invalid" }] },
  };
}
test("invitation tags require server-owned invitation action and complete safe identifiers", () => {
  assert.equal(invitationEmailTags("offer.delivery", metadata), undefined);
  assert.equal(
    invitationEmailTags("interview.greenhouse.invite", {
      ...metadata,
      attemptId: "bad secret/tag",
    }),
    undefined,
  );
  assert.equal(
    invitationEmailTags("interview.greenhouse.invite", { sessionId: "only-one" }),
    undefined,
  );
  const tags = invitationEmailTags("interview.greenhouse.invite", metadata)!;
  assert.equal(tags.length, 4);
  assert.ok(!JSON.stringify(tags).includes("candidate@example.invalid"));
});
test("signed invitation facts distinguish SES acceptance, server delivery and failure events", () => {
  for (const [kind, status] of Object.entries({
    Send: "accepted",
    Delivery: "delivered",
    DeliveryDelay: "delayed",
    Bounce: "bounced",
    Reject: "rejected",
    "Rendering Failure": "rejected",
    Complaint: "complained",
  }))
    assert.equal(parseInvitationProviderEvent(payload(kind))?.status, status);
  assert.equal(
    parseInvitationProviderEvent(payload("Open")),
    null,
    "opens do not establish authorized evidence",
  );
  assert.equal(parseInvitationProviderEvent(payload())?.sessionId, "session-1");
});
test("ambiguous tags, multiple recipients, malformed dates and oversized references are refused", () => {
  const p = payload();
  p.mail.tags.lexy_interview_attempt.push("second-attempt");
  assert.equal(parseInvitationProviderEvent(p), null);
  const multiple = payload();
  multiple.delivery.recipients.push("other@example.invalid");
  assert.equal(parseInvitationProviderEvent(multiple), null);
  const badDate = payload();
  badDate.delivery.timestamp = "not-a-date";
  assert.equal(parseInvitationProviderEvent(badDate), null);
  const long = payload();
  long.mail.messageId = "x".repeat(257);
  assert.equal(parseInvitationProviderEvent(long), null);
  assert.equal(parseInvitationProviderEvent({}), null);
});
test("event identities are deterministic and distinguish provider messages and facts", () => {
  assert.equal(
    parseInvitationProviderEvent(payload())?.id,
    parseInvitationProviderEvent(payload())?.id,
  );
  assert.notEqual(
    parseInvitationProviderEvent(payload())?.id,
    parseInvitationProviderEvent(payload("Send"))?.id,
  );
  const other = payload();
  other.mail.messageId = "different-message";
  assert.notEqual(
    parseInvitationProviderEvent(payload())?.id,
    parseInvitationProviderEvent(other)?.id,
  );
});
