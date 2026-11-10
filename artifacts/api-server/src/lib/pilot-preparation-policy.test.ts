import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPilotPreparationScope,
  assertReusablePreparedPilot,
} from "./pilot-preparation-policy";

const source = {
  id: "livepilot_source",
  tenantId: "livepilot_tenant",
  status: "active",
  createdById: "livepilot_admin",
};
const operator = {
  id: "livepilot_admin",
  tenantId: source.tenantId,
  role: "tenant_admin",
  status: "active",
};
const candidate = {
  id: "livepilot_candidate_fixture",
  tenantId: source.tenantId,
  email: "fixture@example.invalid",
  pool: "tenant",
  doNotContact: false,
  dataErasedAt: null,
};

test("configuration preparation accepts only the isolated, owner-authorized fixture", () => {
  assert.doesNotThrow(() =>
    assertPilotPreparationScope(source, operator, candidate, " FIXTURE@example.invalid "),
  );
});
test("ordinary jobs, inactive sources and foreign operators cannot be copied", () => {
  for (const patch of [
    { id: "customer_job" },
    { tenantId: "customer" },
    { status: "pending_approval" },
  ])
    assert.throws(() =>
      assertPilotPreparationScope({ ...source, ...patch }, operator, candidate, candidate.email),
    );
  for (const patch of [
    { id: "livepilot_other" },
    { tenantId: "foreign" },
    { role: "candidate" },
    { status: "suspended" },
  ])
    assert.throws(() =>
      assertPilotPreparationScope(source, { ...operator, ...patch }, candidate, candidate.email),
    );
});
test("erasure, do-not-contact, foreign ownership, platform pool and changed recipients fail closed", () => {
  for (const patch of [
    { dataErasedAt: new Date() },
    { doNotContact: true },
    { tenantId: "foreign" },
    { pool: "platform" },
    { email: "other@example.invalid" },
    { id: "real_candidate" },
  ])
    assert.throws(() =>
      assertPilotPreparationScope(source, operator, { ...candidate, ...patch }, candidate.email),
    );
  assert.throws(() => assertPilotPreparationScope(source, operator, candidate, ""));
});
test("reusing a prepared work order requires the controlled label, path and ownership", () => {
  const job = {
    tenantId: source.tenantId,
    createdById: operator.id,
    interviewPath: "ai",
    title: "[AUTONOMY PILOT] Fixture",
  };
  assert.doesNotThrow(() => assertReusablePreparedPilot(job, source.tenantId, operator.id));
  for (const patch of [
    { title: "[LIVE TEST E2E] Legacy fixture" },
    { interviewPath: "human" },
    { tenantId: "foreign" },
    { createdById: "other" },
  ])
    assert.throws(() =>
      assertReusablePreparedPilot({ ...job, ...patch }, source.tenantId, operator.id),
    );
});
