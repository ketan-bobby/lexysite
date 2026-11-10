import assert from "node:assert/strict";
import { test } from "node:test";
import { saveScheduleDraft, type ScheduleSaveState } from "./schedule-save";

const payload = { applicationId: "fixture", scheduledAt: "2030-11-01T10:00:00Z", notes: null };
const saved = {
  version: `v1_${"a".repeat(64)}`,
  ...payload,
  id: "fixture-schedule",
  status: "pending",
  replayed: false,
  type: "technical",
  durationMinutes: 60,
  createdAt: "2030-10-01T10:00:00Z",
};
function fixture() {
  const state: ScheduleSaveState = { requestId: "fixture-request", attemptedPayload: null };
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const ports = {
    find: async (_key: string): Promise<typeof saved | null> => {
      calls.push("find");
      return null;
    },
    preflight: async () => {
      calls.push("preflight");
    },
    create: async (body: Record<string, unknown>) => {
      calls.push("create");
      bodies.push(body);
      return saved;
    },
  };
  return { state, calls, bodies, ports };
}

test("first save checks availability then sends one stable request ID", async () => {
  const f = fixture();
  await saveScheduleDraft(f.state, payload, f.ports);
  assert.deepEqual(f.calls, ["preflight", "create"]);
  assert.equal(f.bodies[0]?.requestId, f.state.requestId);
});

test("lost response recovers before calendar preflight and does not create twice", async () => {
  const f = fixture();
  f.ports.create = async () => {
    f.calls.push("create");
    throw new Error("response lost");
  };
  await assert.rejects(saveScheduleDraft(f.state, payload, f.ports), /response lost/);
  f.calls.length = 0;
  f.ports.find = async () => {
    f.calls.push("find");
    return saved;
  };
  f.ports.preflight = async () => {
    throw new Error("now busy or past");
  };
  const result = await saveScheduleDraft(f.state, payload, f.ports);
  assert.equal(result.id, saved.id);
  assert.equal(result.replayed, true);
  assert.deepEqual(f.calls, ["find"]);
});

test("confirmed missing receipt rechecks availability and reuses the same key", async () => {
  const f = fixture();
  f.state.attemptedPayload = JSON.stringify(payload);
  await saveScheduleDraft(f.state, payload, f.ports);
  assert.deepEqual(f.calls, ["find", "preflight", "create"]);
  assert.equal(f.bodies[0]?.requestId, "fixture-request");
});

test("failed recovery read is not treated as missing and never posts", async () => {
  const f = fixture();
  f.state.attemptedPayload = JSON.stringify(payload);
  f.ports.find = async () => {
    throw new Error("unavailable");
  };
  await assert.rejects(saveScheduleDraft(f.state, payload, f.ports), /unavailable/);
  assert.deepEqual(f.calls, []);
});

test("edits after uncertain save are not discarded or silently applied to existing row", async () => {
  const f = fixture();
  f.state.attemptedPayload = JSON.stringify(payload);
  f.ports.find = async () => saved;
  await assert.rejects(
    saveScheduleDraft(f.state, { ...payload, notes: "new edit" }, f.ports),
    /new edits were not applied/,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.state.attemptedPayload, JSON.stringify(payload));
});

test("failed preflight leaves no attempted write and cancelled receipt is not reopened", async () => {
  const f = fixture();
  f.ports.preflight = async () => {
    throw new Error("busy");
  };
  await assert.rejects(saveScheduleDraft(f.state, payload, f.ports), /busy/);
  assert.equal(f.state.attemptedPayload, null);
  f.state.attemptedPayload = JSON.stringify(payload);
  f.ports.find = async () => ({ ...saved, status: "cancelled" });
  assert.equal((await saveScheduleDraft(f.state, payload, f.ports)).status, "cancelled");
  assert.deepEqual(f.bodies, []);
});

test("malformed successful receipts are unknown, not false success or a missing save", async () => {
  const f = fixture();
  f.ports.create = async () => ({ ...saved, id: "" });
  await assert.rejects(saveScheduleDraft(f.state, payload, f.ports), /could not be verified/);
  f.ports.find = async () => ({ ...saved, createdAt: "invalid" });
  await assert.rejects(saveScheduleDraft(f.state, payload, f.ports), /could not be verified/);
  assert.equal(f.bodies.length, 0);
  assert.equal(f.state.attemptedPayload, JSON.stringify(payload));
});
