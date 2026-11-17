import assert from "node:assert/strict";
import { test } from "node:test";
import type { AtsHandoffState } from "@workspace/api-client-react";
import { greenhouseHrHandoff } from "./greenhouse-hr-handoff";

function fixture(): AtsHandoffState {
  const mapping = {
    system: "Greenhouse",
    accountRef: "private-account",
    externalJobId: "101",
    externalCandidateId: "202",
    externalApplicationId: "303",
    mappedBy: "owner",
    mappedAt: "2026-01-01T00:00:00Z",
  };
  // Only the production fields consumed by this explicit allowlist are needed.
  return {
    connectionState: "not_connected",
    workflowRevision: 1,
    canManage: true,
    ready: true,
    stale: false,
    blockers: [],
    mapping,
    packet: {
      id: "packet",
      snapshotHash: "a".repeat(64),
      approvedBy: "approver",
      approvedAt: "2026-01-01T00:00:00Z",
      exportedBy: "owner",
      exportedAt: "2026-01-02T00:00:00Z",
      content: {
        offerOwner: "external_employer",
        mapping: { ...mapping },
        candidate: { name: "private name" },
        assessments: [{ summary: "private assessment" }],
        decision: { outcome: "hire", testOnly: true, reason: "private reasoning" },
      },
    },
  } as AtsHandoffState;
}

test("Greenhouse HR reference is allowlisted and makes no provider or offer claims", () => {
  const text = greenhouseHrHandoff(fixture())!;
  assert.match(text, /Greenhouse application ID: 303/);
  assert.match(text, /TEST ONLY/);
  assert.match(text, /not been published to Greenhouse/);
  assert.match(text, /not verified ATS receipt/);
  assert.doesNotMatch(text, /private name|private assessment|private reasoning|private-account/);
});

test("missing approval or export evidence cannot produce an HR reference", () => {
  for (const field of ["approvedBy", "approvedAt", "exportedBy", "exportedAt"] as const) {
    const state = fixture();
    delete state.packet![field];
    assert.equal(greenhouseHrHandoff(state), null);
  }
  for (const field of ["approvedAt", "exportedAt"] as const) {
    const state = fixture();
    state.packet![field] = "invalid";
    assert.equal(greenhouseHrHandoff(state), null);
  }
});

test("stale, unavailable and foreign-provider handoffs stay closed", () => {
  for (const change of [
    { stale: true },
    { canManage: false },
    { ready: false },
    { packet: null },
    { mapping: null },
  ]) {
    assert.equal(greenhouseHrHandoff({ ...fixture(), ...change }), null);
  }
  const state = fixture();
  state.mapping!.system = "Zoho";
  assert.equal(greenhouseHrHandoff(state), null);
});

test("mapping changes cannot reuse an approved packet", () => {
  for (const field of [
    "system",
    "accountRef",
    "externalJobId",
    "externalCandidateId",
    "externalApplicationId",
    "mappedBy",
    "mappedAt",
  ] as const) {
    const state = fixture();
    state.mapping![field] = "changed";
    assert.equal(greenhouseHrHandoff(state), null);
  }
});

test("unsafe external IDs and invalid fingerprints cannot reach the copy reference", () => {
  for (const id of [
    "0",
    "-1",
    "1e3",
    "https://example.invalid",
    "9007199254740992",
    "1\ninjected",
  ]) {
    const state = fixture();
    state.mapping!.externalApplicationId = id;
    state.packet!.content.mapping.externalApplicationId = id;
    assert.equal(greenhouseHrHandoff(state), null);
  }
  const state = fixture();
  state.packet!.snapshotHash = "invalid";
  assert.equal(greenhouseHrHandoff(state), null);
});

test("hold and decline remain hiring intent, never an instruction to create an offer", () => {
  for (const outcome of ["hold", "decline"] as const) {
    const state = fixture();
    state.packet!.content.decision.outcome = outcome;
    state.packet!.content.decision.testOnly = false;
    const text = greenhouseHrHandoff(state)!;
    assert.match(text, new RegExp(`Recorded human hiring intent: ${outcome}`));
    assert.doesNotMatch(text, /TEST ONLY/);
    assert.match(text, /not approval of financial terms/);
  }
});
