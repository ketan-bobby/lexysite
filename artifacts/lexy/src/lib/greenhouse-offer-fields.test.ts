import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canApproveOp,
  canPrepare,
  canRecover,
  canSubmitOp,
  fromProposal,
  toProposal,
  type Form,
} from "./greenhouse-offer-fields";

const base: Form = { openingId: "", startDate: "", approverId: "a", submitterId: "s", rows: [] };
const row = (
  type: "text" | "number" | "currency",
  value: string,
  currency = "",
  name = "base",
) => ({
  id: name,
  name,
  type,
  value,
  currency,
});

test("requires roles", () => {
  assert.ok(toProposal({ ...base, approverId: "" }).error);
});
test("currency must be integer minor units with code", () => {
  assert.ok(toProposal({ ...base, rows: [row("currency", "875.50", "USD")] }).error);
  assert.ok(toProposal({ ...base, rows: [row("currency", "87550", "usd")] }).error);
  assert.deepEqual(
    toProposal({ ...base, rows: [row("currency", "87550", "USD")] }).proposal?.values,
    {
      base: { amountMinor: 87550, currency: "USD" },
    },
  );
});
test("number, text, duplicates, empty optional", () => {
  assert.ok(toProposal({ ...base, rows: [row("number", "abc")] }).error);
  assert.ok(toProposal({ ...base, rows: [row("text", "x"), row("text", "y")] }).error);
  const p = toProposal({ ...base, rows: [row("number", "4.5")] }).proposal!;
  assert.equal(p.values.base, 4.5);
  assert.equal(p.openingId, null);
  assert.equal(p.startDate, null);
});
test("round trip", () => {
  const p = toProposal({
    ...base,
    rows: [row("currency", "100", "EUR"), row("text", "hi", "", "note")],
  }).proposal!;
  assert.ok(p, "Positive round-trip control must contain real saved terms");
  assert.deepEqual(toProposal(fromProposal(p, () => "x")).proposal, p);
});
test("employer field keys reject unsafe and unsupported names", () => {
  for (const key of ["Base", "base salary", "__proto__", "constructor", "prototype"]) {
    assert.ok(toProposal({ ...base, rows: [row("text", "value", "", key)] }).error);
  }
});

const ws = {
  executionMode: "simulated" as const,
  blockers: [] as string[],
  controlRevision: "c",
  canEdit: true,
  canApprove: true,
  canSubmit: true,
  proposal: { openingId: null, startDate: null, approverId: "a", submitterId: "s", values: {} },
  attempt: { id: "1", revision: "r", state: "claimed" },
};
test("prepare gates", () => {
  assert.ok(canPrepare(ws));
  assert.ok(!canPrepare({ ...ws, controlRevision: null }));
  assert.ok(!canPrepare({ ...ws, blockers: ["x"] }));
  assert.ok(!canPrepare({ ...ws, proposal: null }));
  assert.ok(!canPrepare({ ...ws, canEdit: false }));
  assert.ok(!canPrepare({ ...ws, executionMode: "unavailable" }));
  assert.ok(!canApproveOp({ ...ws, executionMode: "unavailable" }));
  assert.ok(!canSubmitOp({ ...ws, attempt: null }));
});
test("recovery states exact", () => {
  for (const s of [
    "claimed",
    "draft_created",
    "provider_accepted",
    "review_required",
    "observed_match",
    "observed_other",
  ])
    assert.ok(
      canRecover({ ...ws, controlRevision: null, attempt: { ...ws.attempt, state: s } }),
      s,
    );
  for (const s of ["prepared", "approved", "verified_submission", "not_sent", "failed", "unknown"])
    assert.ok(!canRecover({ ...ws, attempt: { ...ws.attempt, state: s } }), s);
  assert.ok(!canRecover({ ...ws, executionMode: "unavailable" }));
});
