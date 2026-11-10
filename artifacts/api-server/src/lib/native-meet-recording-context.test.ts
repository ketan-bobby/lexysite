import { test } from "node:test";
import assert from "node:assert/strict";
import { operationFixture, actor, config } from "./google-operation.test-fixture";
import { verifyNativeMeetReceipt } from "./native-meet-recording-context";
import {
  googleCandidateInvitationSnapshot,
  googleInvitationSnapshot,
} from "./google-invitation-identity";
import type { GoogleInvitationReview } from "./google-invitation-store";

function fixture() {
  const f = operationFixture();
  const row = f.state;
  row.context.job.status = "active";
  row.connection!.connectedAt = new Date();
  row.context.schedule.interviewerId = actor.id;
  const g = row.attempt!.googleSnapshot!;
  g.meetUrl = "https://meet.google.com/abc-defg-hij";
  g.conferenceStatus = "ready";
  g.operations = [];
  g.candidateSnapshotHash = googleCandidateInvitationSnapshot(row, actor);
  return { f, row };
}
const recordingActor = { id: actor.id, tenantId: actor.tenantId! };
test("receipt proof binds the native appointment, original Google organizer and server-derived window", () => {
  const { row } = fixture();
  const proof = verifyNativeMeetReceipt(row, recordingActor, config.fingerprint);
  assert.equal(proof.window.meetingCode, "abc-defg-hij");
  assert.equal(
    Date.parse(proof.window.windowStart),
    row.context.schedule.scheduledAt.getTime() - 30 * 60_000,
  );
  assert.equal(
    Date.parse(proof.window.windowEnd),
    row.context.schedule.scheduledAt.getTime() + 90 * 60_000,
  );
  assert.equal(proof.binding.length, 64);
});
test("unapproved, cancelled, AI/panel, foreign-recipient and unaccepted Google receipts are not import authority", () => {
  const mutations: Array<(row: GoogleInvitationReview) => void> = [
    (r) => {
      r.context.job.status = "draft";
    },
    (r) => {
      r.context.schedule.status = "cancelled";
    },
    (r) => {
      r.context.schedule.type = "ai_interview";
    },
    (r) => {
      r.context.schedule.panelRevision = "new-panel";
    },
    (r) => {
      r.attempt!.recipientHash = "foreign";
    },
    (r) => {
      r.attempt!.organizerId = "foreign";
    },
    (r) => {
      r.attempt!.eventId = "unverified";
    },
    (r) => {
      r.attempt!.status = "attempted";
    },
    (r) => {
      r.attempt!.acceptedAt = null;
    },
    (r) => {
      r.attempt!.provider = "outlook";
    },
    (r) => {
      r.attempt!.candidateId = "foreign";
    },
    (r) => {
      r.connection!.needsReconnect = true;
    },
    (r) => {
      r.connection!.invitationConsent = false;
    },
    (r) => {
      r.connection!.subject = "foreign-subject";
    },
    (r) => {
      r.connection!.tenantId = "foreign-employer";
    },
    (r) => {
      r.attempt!.googleSnapshot!.meetUrl = "https://attacker.example.invalid/abc-defg-hij";
    },
    (r) => {
      r.attempt!.googleSnapshot!.conferenceStatus = "pending";
    },
    (r) => {
      r.attempt!.googleSnapshot!.candidateSnapshotHash = "stale";
    },
  ];
  for (const mutate of mutations) {
    const { row } = fixture();
    mutate(row);
    assert.throws(() => verifyNativeMeetReceipt(row, recordingActor, config.fingerprint));
  }
});
test("recording proof cannot survive caller, client, appointment time or pending/cancelled operation changes", () => {
  const { row } = fixture();
  assert.throws(() =>
    verifyNativeMeetReceipt(row, { ...recordingActor, id: "foreign" }, config.fingerprint),
  );
  assert.throws(() => verifyNativeMeetReceipt(row, recordingActor, "different-oauth-app"));
  assert.throws(() => verifyNativeMeetReceipt(row, recordingActor, undefined));
  row.context.schedule.scheduledAt = new Date(row.context.schedule.scheduledAt.getTime() + 60_000);
  assert.throws(() => verifyNativeMeetReceipt(row, recordingActor, config.fingerprint));
  const next = fixture().row;
  next.attempt!.googleSnapshot!.operations = [{ id: "bad", acceptedAt: null }] as never;
  assert.throws(() => verifyNativeMeetReceipt(next, recordingActor, config.fingerprint));
});
function acceptedPanel(row: GoogleInvitationReview) {
  row.context.schedule.panelRevision = "panel-version-fixture";
  row.panel = {
    revision: "panel-version-fixture",
    binding: "verified-current-panel-binding",
    recipients: [
      {
        userId: "panel-staff",
        email: "panel@example.test",
        subjectHash: "panel-subject",
        connectionRevision: "panel-grant",
        grantedAt: new Date().toISOString(),
      },
    ],
  };
  const g = row.attempt!.googleSnapshot!;
  g.panelSnapshot = { revision: row.panel.revision, binding: row.panel.binding };
  g.snapshotHash = googleInvitationSnapshot(row, actor);
  g.candidateSnapshotHash = googleCandidateInvitationSnapshot(row, actor);
  return row;
}
test("a provider-accepted current Google panel receipt can authorize its original organizer's recording", () => {
  const row = acceptedPanel(fixture().row);
  const proof = verifyNativeMeetReceipt(row, recordingActor, config.fingerprint);
  assert.equal(proof.window.meetingCode, "abc-defg-hij");
  assert.throws(() =>
    verifyNativeMeetReceipt(row, { ...recordingActor, id: "panel-staff" }, config.fingerprint),
  );
});

test("Panel recording authority follows an accepted reschedule and never a pending or cancelled change", async () => {
  for (const mode of ["accepted", "pending", "cancelled"]) {
    const f = operationFixture(mode === "cancelled", true);
    f.panel();
    f.mutate((r) => {
      r.connection!.connectedAt = new Date();
    });
    const input = await f.input();
    if (mode === "pending") f.lose();
    const result = await f.service.apply(actor, "fixture-schedule", input);
    assert.equal(result.status, mode === "pending" ? "needs_review" : "accepted");
    if (mode === "accepted") {
      const proof = verifyNativeMeetReceipt(f.state, recordingActor, config.fingerprint);
      assert.equal(
        Date.parse(proof.window.windowStart),
        f.state.context.schedule.scheduledAt.getTime() - 30 * 60_000,
      );
      f.mutate((r) => {
        r.panel!.binding = "revoked-panel";
      });
      assert.throws(() => verifyNativeMeetReceipt(f.state, recordingActor, config.fingerprint));
    } else {
      assert.throws(() => verifyNativeMeetReceipt(f.state, recordingActor, config.fingerprint));
    }
  }
});
test("solo/Outlook approval, orphan panel proof and stale panel bindings are not Google panel authority", () => {
  const mutations: Array<(r: GoogleInvitationReview) => void> = [
    (r) => {
      r.panel = undefined;
    },
    (r) => {
      r.panel!.binding = "changed-account-email-or-membership";
    },
    (r) => {
      r.context.schedule.panelRevision = "another-panel";
    },
    (r) => {
      r.context.schedule.panelRevision = null;
    },
    (r) => {
      delete r.attempt!.googleSnapshot!.panelSnapshot;
    },
    (r) => {
      r.attempt!.googleSnapshot!.panelSnapshot!.revision = "older-panel";
    },
    (r) => {
      r.attempt!.panelSnapshot = {
        approvalToken: "outlook",
        organizerMailboxHash: "foreign",
        organizerEmailHash: "foreign",
        recipients: [],
      };
    },
    (r) => {
      r.attempt!.status = "attempted";
    },
    (r) => {
      r.attempt!.googleSnapshot!.operations = [{ acceptedAt: null }] as never;
    },
  ];
  for (const mutate of mutations) {
    const row = acceptedPanel(fixture().row);
    mutate(row);
    assert.throws(() => verifyNativeMeetReceipt(row, recordingActor, config.fingerprint));
  }
  const solo = fixture().row;
  solo.context.schedule.panelRevision = "newly-saved-panel";
  assert.throws(() => verifyNativeMeetReceipt(solo, recordingActor, config.fingerprint));
});
