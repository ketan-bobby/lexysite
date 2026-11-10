import test from "node:test";
import assert from "node:assert/strict";
import { actor, operationFixture } from "./google-operation.test-fixture";
import { googleInvitationService } from "./google-interview-invitation";
import { config } from "./google-operation.test-fixture";
import { randomUUID } from "node:crypto";

const id = "fixture-schedule";
test("Review rotates proofs without changing intent; one approved time-only operation is accepted", async () => {
  const f = operationFixture(),
    input = await f.input();
  assert.equal(f.writes, 0);
  f.elapse(1000);
  const refreshed = await f.service.review(actor, id);
  assert.notEqual(refreshed.approvalToken, input.expectedApprovalToken);
  const sent = await f.service.apply(actor, id, input);
  assert.equal(sent.status, "accepted");
  assert.equal(sent.deliveryConfirmed, false);
  assert.equal(f.writes, 1);
  assert.equal(f.latest()?.kind, "reschedule");
  assert.ok(f.latest()?.acceptedAt);
  assert.equal((await f.service.review(actor, id)).status, "current");
  await assert.rejects(f.service.apply(actor, id, input));
  assert.equal(f.writes, 1);
});
test("Native cancellation is separately approved once; restoring native content does not recreate an event", async () => {
  const f = operationFixture(true),
    input = await f.input();
  assert.equal(input.kind, "cancel");
  const result = await f.service.apply(actor, id, input);
  assert.equal(result.status, "accepted");
  assert.equal(result.targetStart, null);
  assert.equal(result.meetUrl, null);
  assert.equal(f.checks, 0);
  assert.equal(f.writes, 1);
  f.mutate((r) => {
    r.context.schedule.status = "confirmed";
  });
  assert.equal((await f.service.review(actor, id)).kind, "cancel");
  await assert.rejects(f.service.apply(actor, id, input));
  assert.equal(f.writes, 1);
});
test("Malformed, unapproved, stale and expired input cannot append an intent or mutate Google", async () => {
  for (const mode of ["false", "extra", "token", "expired", "kind", "version"]) {
    const f = operationFixture(),
      input = await f.input();
    const raw = {
      ...input,
      ...(mode === "false"
        ? { confirm: false }
        : mode === "extra"
          ? { force: true }
          : mode === "token"
            ? { expectedApprovalToken: "gc_" + "0".repeat(64) }
            : mode === "kind"
              ? { kind: "cancel" }
              : mode === "version"
                ? { expectedVersion: "v1_" + "0".repeat(64) }
                : {}),
    };
    if (mode === "expired") f.elapse(600001);
    await assert.rejects(f.service.apply(actor, id, raw));
    assert.equal(f.writes, 0);
    assert.equal(f.latest(), undefined);
  }
});
test("Ownership, contact, permissions, approved work orders and panels are rechecked before claiming", async () => {
  const changes = [
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.connection!.revision = randomUUID();
      }),
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.connection!.invitationConsent = false;
      }),
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.context.candidate.email = "changed@example.test";
      }),
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.context.candidate.doNotContact = true;
      }),
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.context.job.status = "draft";
      }),
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.context.schedule.panelRevision = "synthetic-panel";
      }),
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.attempt!.provider = "outlook";
      }),
    (f: ReturnType<typeof operationFixture>) => f.remoteChange(),
  ];
  for (const change of changes) {
    const f = operationFixture(),
      input = await f.input();
    change(f);
    await assert.rejects(f.service.apply(actor, id, input));
    assert.equal(f.latest(), undefined);
    assert.equal(f.writes, 0);
  }
});
test("Simultaneous identical approvals converge on one durable operation", async () => {
  const f = operationFixture(),
    input = await f.input();
  const results = await Promise.allSettled([
    f.service.apply(actor, id, input),
    f.service.apply(actor, id, input),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.writes, 1);
  assert.equal(f.state.attempt!.googleSnapshot!.operations!.length, 1);
});
test("A lost PATCH response never retries and reconciles only its exact marker and target", async () => {
  const f = operationFixture(),
    input = await f.input();
  f.lose();
  assert.equal((await f.service.apply(actor, id, input)).status, "needs_review");
  assert.equal(f.latest()?.acceptedAt, null);
  await assert.rejects(f.service.apply(actor, id, input));
  assert.equal(f.writes, 1);
  assert.equal((await f.service.review(actor, id)).status, "current");
  assert.ok(f.latest()?.acceptedAt);
  assert.equal(f.writes, 1);
});
test("A matching time without the operation marker is not attributable success", async () => {
  const f = operationFixture(),
    input = await f.input();
  f.lose();
  await f.service.apply(actor, id, input);
  f.wrongMarker();
  assert.equal((await f.service.review(actor, id)).status, "needs_review");
  assert.equal(f.latest()?.acceptedAt, null);
  assert.equal(f.writes, 1);
});
test("A lost DELETE response stays uncertain: absence is not acceptance and never permits resend", async () => {
  const f = operationFixture(true),
    input = await f.input();
  f.lose();
  assert.equal((await f.service.apply(actor, id, input)).status, "needs_review");
  assert.equal((await f.service.review(actor, id)).status, "needs_review");
  await assert.rejects(f.service.apply(actor, id, input));
  assert.equal(f.writes, 1);
  assert.equal(f.latest()?.acceptedAt, null);
});
test("Privacy, account, native and provider changes after claim fence the mutation", async () => {
  for (const change of [
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.connection!.invitationConsent = false;
      }),
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.context.candidate.doNotContact = true;
      }),
    (f: ReturnType<typeof operationFixture>) =>
      f.mutate((r) => {
        r.context.schedule.durationMinutes = 45;
      }),
    (f: ReturnType<typeof operationFixture>) => f.remoteChange(),
    (f: ReturnType<typeof operationFixture>) => f.elapse(600001),
  ]) {
    const f = operationFixture(),
      input = await f.input();
    f.afterClaim(() => change(f));
    assert.equal((await f.service.apply(actor, id, input)).status, "needs_review");
    assert.equal(f.writes, 0);
    assert.equal(f.latest()?.acceptedAt, null);
  }
});
test("Busy preflight is unclaimed; a later busy interval preserves the committed intent without writing", async () => {
  const f = operationFixture(),
    input = await f.input();
  f.busy();
  await assert.rejects(f.service.apply(actor, id, input));
  assert.equal(f.latest(), undefined);
  const late = operationFixture(),
    lateInput = await late.input();
  late.afterClaim(() => late.busy());
  assert.equal((await late.service.apply(actor, id, lateInput)).status, "needs_review");
  assert.ok(late.latest());
  assert.equal(late.writes, 0);
});
test("Provider success followed by database failure is recovered by read without a second mutation", async () => {
  const f = operationFixture(),
    input = await f.input();
  f.failSave();
  assert.equal((await f.service.apply(actor, id, input)).status, "needs_review");
  assert.equal(f.latest()?.acceptedAt, null);
  f.restoreSave();
  assert.equal((await f.service.review(actor, id)).status, "current");
  assert.equal(f.writes, 1);
});
test("Late authorization failure returns no cached private booking details", async () => {
  const f = operationFixture(),
    input = await f.input();
  f.lose();
  f.denyRecovery();
  await assert.rejects(f.service.apply(actor, id, input));
  assert.equal(f.writes, 1);
  assert.equal(f.latest()?.acceptedAt, null);
});
test("The original send receipt remains immutable and its read reflects an accepted reschedule", async () => {
  const f = operationFixture(),
    input = await f.input(),
    original = structuredClone(f.state.attempt);
  await f.service.apply(actor, id, input);
  assert.equal(f.state.attempt!.transactionId, original!.transactionId);
  assert.equal(
    f.state.attempt!.googleSnapshot!.snapshotHash,
    original!.googleSnapshot!.snapshotHash,
  );
  const service = googleInvitationService({
    store: f.store,
    config: () => config,
    provider: f.provider,
    events: {
      async read() {
        return f.remote;
      },
      async create() {
        throw Error("No replacement");
      },
      async canMeet() {},
    },
  });
  assert.equal((await service.review(actor, id)).status, "accepted");
  await assert.rejects(service.send(actor, id, input));
  assert.equal(f.writes, 1);
});
test("Reconnecting the same verified Google subject needs fresh approval; a different subject never inherits the event", async () => {
  const f = operationFixture(),
    old = await f.input();
  f.mutate((r) => {
    r.connection!.revision = randomUUID();
  });
  await assert.rejects(f.service.apply(actor, id, old));
  assert.equal(f.writes, 0);
  const fresh = await f.input();
  await f.service.apply(actor, id, fresh);
  assert.equal(f.writes, 1);
  const original = googleInvitationService({
    store: f.store,
    config: () => config,
    provider: f.provider,
    events: {
      async read() {
        return f.remote;
      },
      async create() {
        throw Error("No replacement");
      },
      async canMeet() {},
    },
  });
  assert.equal((await original.review(actor, id)).status, "accepted");
  f.mutate((r) => {
    r.connection!.subject = "another-google-subject";
    r.connection!.revision = randomUUID();
  });
  assert.equal((await f.service.review(actor, id)).status, "unavailable");
});

test("A current accepted Google panel reviews all guests and changes the original event once", async () => {
  for (const cancel of [false, true]) {
    const f = operationFixture(cancel);
    f.panel();
    const originalId = f.state.attempt!.eventId;
    const review = await f.service.review(actor, id);
    assert.equal(review.status, "ready");
    assert.deepEqual(review.panelRecipientEmails, ["panel@example.test"]);
    const input = await f.input();
    const result = await f.service.apply(actor, id, input);
    assert.equal(result.status, "accepted");
    assert.deepEqual(result.panelRecipientEmails, ["panel@example.test"]);
    assert.equal(result.deliveryConfirmed, false);
    assert.equal(f.state.attempt!.eventId, originalId);
    assert.equal(f.writes, 1);
    assert.ok(
      f.observedPanels.every((panel) => JSON.stringify(panel) === '["panel@example.test"]'),
    );
    await assert.rejects(f.service.apply(actor, id, input));
    assert.equal(f.writes, 1);
  }
});

test("Panel revision, binding and original Google receipt must agree; solo and Outlook proof cannot be inherited", async () => {
  for (const mutate of [
    (r: ReturnType<typeof operationFixture>["state"]) => {
      r.panel = undefined;
    },
    (r: ReturnType<typeof operationFixture>["state"]) => {
      r.panel!.binding = digestForTest;
    },
    (r: ReturnType<typeof operationFixture>["state"]) => {
      r.context.schedule.panelRevision = "changed";
    },
    (r: ReturnType<typeof operationFixture>["state"]) => {
      delete r.attempt!.googleSnapshot!.panelSnapshot;
    },
    (r: ReturnType<typeof operationFixture>["state"]) => {
      r.context.schedule.panelRevision = null;
      r.panel = undefined;
    },
    (r: ReturnType<typeof operationFixture>["state"]) => {
      r.attempt!.panelSnapshot = {} as NonNullable<typeof r.attempt>["panelSnapshot"];
    },
  ]) {
    const f = operationFixture();
    f.panel();
    const input = await f.input();
    f.mutate(mutate);
    assert.equal((await f.service.review(actor, id)).status, "unavailable");
    await assert.rejects(f.service.apply(actor, id, input));
    assert.equal(f.writes, 0);
    assert.equal(f.latest(), undefined);
  }
});
const digestForTest = "f".repeat(64);

test("panel availability is mandatory before the claim and rechecked before PATCH, never for cancellation", async () => {
  for (const late of [false, true]) {
    const f = operationFixture();
    f.panel();
    const input = await f.input();
    if (late) f.afterClaim(() => f.panelBusy());
    else f.panelBusy();
    if (late) assert.equal((await f.service.apply(actor, id, input)).status, "needs_review");
    else await assert.rejects(f.service.apply(actor, id, input));
    assert.equal(f.writes, 0);
    assert.equal(f.preparations, 1);
    assert.equal(f.panelChecks, late ? 2 : 1);
    assert.equal(!!f.latest(), late);
  }
  const f = operationFixture();
  f.panel();
  await f.service.apply(actor, id, await f.input());
  assert.equal(f.panelChecks, 2);
  assert.equal(f.writes, 1);
  const cancel = operationFixture(true);
  cancel.panel();
  cancel.panelBusy();
  assert.equal((await cancel.service.apply(actor, id, await cancel.input())).status, "accepted");
  assert.equal(cancel.preparations, 0);
  assert.equal(cancel.panelChecks, 0);
});

test("a panel cannot silently fall back to organizer-only checks when preparation is unavailable", async () => {
  const f = operationFixture();
  f.panel();
  const input = await f.input();
  f.store.preparePanelAvailability = undefined;
  await assert.rejects(f.service.apply(actor, id, input));
  assert.equal(f.writes, 0);
  assert.equal(f.latest(), undefined);
});

test("A changed reviewed panel cannot use an old approval, including after a durable claim", async () => {
  for (const late of [false, true]) {
    const f = operationFixture();
    f.panel();
    const input = await f.input();
    const change = () =>
      f.mutate((r) => {
        r.panel!.binding = digestForTest;
        r.panel!.recipients[1].email = "changed@example.test";
        r.attempt!.googleSnapshot!.panelSnapshot!.binding = digestForTest;
      });
    if (late) f.afterClaim(change);
    else change();
    if (late) assert.equal((await f.service.apply(actor, id, input)).status, "needs_review");
    else await assert.rejects(f.service.apply(actor, id, input));
    assert.equal(f.writes, 0);
  }
});

test("Uncertain panel changes never resend; only a correlated PATCH can reconcile", async () => {
  for (const cancel of [false, true]) {
    const f = operationFixture(cancel);
    f.panel();
    const input = await f.input();
    f.lose();
    assert.equal((await f.service.apply(actor, id, input)).status, "needs_review");
    await assert.rejects(f.service.apply(actor, id, input));
    assert.equal((await f.service.review(actor, id)).status, cancel ? "needs_review" : "current");
    assert.equal(f.writes, 1);
  }
});
