import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRecordedCommunicationSender,
  inboxReplyOperationId,
  type RecordedCommunication,
} from "./recorded-communication";
import type { SendEmailResult } from "./email";

const input: RecordedCommunication = {
  id: "synthetic-operation",
  tenantId: "synthetic-tenant",
  candidateId: "synthetic-candidate",
  type: "follow_up",
  to: "fixture@example.invalid",
  subject: "Synthetic",
  body: "Private synthetic reply",
  actorLabel: "Fixture",
  action: "outreach.inbox_reply.sent",
  senderUserId: "synthetic-staff",
};
function fixture(
  send: (
    ...args: Parameters<Parameters<typeof createRecordedCommunicationSender>[0]["send"]>
  ) => Promise<SendEmailResult>,
) {
  let state: "sent" | "pending" | "failed" | undefined;
  let calls = 0;
  const sender = createRecordedCommunicationSender({
    insertPending: async () => {
      if (state) return false;
      state = "pending";
      return true;
    },
    readState: async () => state,
    retryRejected: async () => {
      if (state !== "failed") return false;
      state = "pending";
      return true;
    },
    finish: async (_input, result, next) => {
      assert.equal(state, "pending");
      state = result.ok && (result.simulated || result.suppressed) ? undefined : next;
      return true;
    },
    send: async (opts) => {
      calls++;
      assert.equal(opts.singleAttempt, true);
      assert.equal(opts.senderUserId, input.senderUserId);
      assert.equal(opts.useRecruiterMailbox, true);
      assert.equal(opts.audit?.metadata?.mailOperationId, input.id);
      return send(opts);
    },
  });
  return {
    sender,
    get state() {
      return state;
    },
    get calls() {
      return calls;
    },
  };
}
test("stable reply intent survives whitespace, while a new message or actor remains a separate operation", () => {
  const base = { tenantId: "t", inboxId: "i", senderId: "s", subject: "Re: Test", body: "Reply" };
  const id = inboxReplyOperationId(base);
  assert.equal(inboxReplyOperationId({ ...base, subject: " Re: Test ", body: " Reply " }), id);
  for (const change of [
    { tenantId: "other" },
    { inboxId: "other" },
    { senderId: "other" },
    { body: "A different reply" },
  ])
    assert.notEqual(inboxReplyOperationId({ ...base, ...change }), id);
  assert.ok(!id.includes("Reply"));
});
test("concurrent and accepted replays do not call the provider twice", async () => {
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const f = fixture(async () => {
    began();
    await wait;
    return { ok: true, acceptance: "accepted" };
  });
  const first = f.sender(input);
  await started;
  assert.equal((await f.sender(input)).reviewRequired, true);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await f.sender(input)).ok, true);
  assert.equal(f.calls, 1);
  assert.equal(f.state, "sent");
});
test("unknown and unclassified failures stay pending on reload/retry", async () => {
  for (const response of [
    { ok: false, reviewRequired: true, error: "private provider payload" },
    { ok: false, acceptance: "unknown", error: "private provider payload" },
    { ok: false, error: "private provider payload" },
  ] as SendEmailResult[]) {
    const f = fixture(async () => response);
    const result = await f.sender(input);
    assert.equal(result.reviewRequired, true);
    assert.ok(!result.error?.includes("private"));
    assert.equal(f.state, "pending");
    assert.equal((await f.sender(input)).reviewRequired, true);
    assert.equal(f.calls, 1);
  }
});
test("known rejected and not-attempted requests can be retried without releasing ambiguous ones", async () => {
  for (const acceptance of ["rejected", "not_attempted"] as const) {
    let first = true;
    const f = fixture(async () => {
      if (first) {
        first = false;
        return { ok: false, acceptance, error: "Known rejection" };
      }
      return { ok: true };
    });
    assert.equal((await f.sender(input)).reviewRequired, undefined);
    assert.equal(f.state, "failed");
    assert.equal((await f.sender(input)).ok, true);
    assert.equal(f.state, "sent");
    assert.equal(f.calls, 2);
  }
});
test("provider exception retains the pending attempt", async () => {
  const f = fixture(async () => {
    throw Error("private SDK exception");
  });
  assert.equal((await f.sender(input)).reviewRequired, true);
  assert.equal(f.state, "pending");
  await f.sender(input);
  assert.equal(f.calls, 1);
});
test("claim/final persistence failures never cause an additional send", async () => {
  for (const stage of ["claim", "finish"]) {
    let sends = 0;
    const sender = createRecordedCommunicationSender({
      insertPending: async () => {
        if (stage === "claim") throw Error("private SQL payload");
        return true;
      },
      readState: async () => undefined,
      retryRejected: async () => false,
      finish: async () => {
        throw Error("write lost after acceptance");
      },
      send: async () => {
        sends++;
        return { ok: true };
      },
    });
    assert.equal((await sender(input)).reviewRequired, true);
    assert.equal(sends, stage === "claim" ? 0 : 1);
  }
});
test("saved acceptance is recovered after an interrupted final-write response, without sending again", async () => {
  let state: "pending" | "sent" | undefined,
    sends = 0;
  const sender = createRecordedCommunicationSender({
    insertPending: async () => {
      if (state) return false;
      state = "pending";
      return true;
    },
    readState: async () => state,
    retryRejected: async () => false,
    finish: async () => {
      state = "sent";
      throw Error("response lost after commit");
    },
    send: async () => {
      sends++;
      return { ok: true };
    },
  });
  assert.equal((await sender(input)).reviewRequired, true);
  assert.equal((await sender(input)).ok, true);
  assert.equal(sends, 1);
});
test("explicit simulation/suppression remains a no-send result, not false sent history or permanent hold", async () => {
  for (const flags of [{ simulated: true }, { suppressed: true }]) {
    const f = fixture(async () => ({ ok: true, ...flags }));
    assert.equal((await f.sender(input)).ok, true);
    assert.equal(f.state, undefined);
    assert.equal((await f.sender(input)).ok, true);
  }
});
