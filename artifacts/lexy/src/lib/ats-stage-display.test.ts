import assert from "node:assert/strict";
import { test } from "node:test";
import type { AtsImportedRecord } from "@workspace/api-client-react";
import { atsStageDisplay, ATS_STAGE_STALE_AFTER_MS } from "./ats-stage-display";

const now = Date.parse("2026-10-28T12:00:00Z");
const iso = (offset: number) => new Date(now + offset).toISOString();
const record: AtsImportedRecord = {
  id: "stage-fixture",
  job: { id: "101", name: "Fixture", status: "open" },
  application: {
    id: "303",
    candidateId: "202",
    status: "in_process",
    stageName: "Technical interview",
  },
  importedAt: iso(-172_800_000),
  observedAt: iso(-172_800_000),
  lastCheckedAt: iso(-1_000),
  refreshRevision: 1,
  availability: "available",
};

test("stage uses the latest saved application, not an inferred native stage", () => {
  const result = atsStageDisplay(record, now);
  assert.equal(result.stage, "Technical interview");
  assert.equal(result.status, "in_process");
  assert.equal(result.observedAt, record.lastCheckedAt);
  assert.equal(result.freshness, "recent");
});

test("a saved check becomes outdated at exactly 24 hours", () => {
  assert.equal(
    atsStageDisplay({ ...record, lastCheckedAt: iso(-ATS_STAGE_STALE_AFTER_MS + 1) }, now)
      .freshness,
    "recent",
  );
  assert.equal(
    atsStageDisplay({ ...record, lastCheckedAt: iso(-ATS_STAGE_STALE_AFTER_MS) }, now).freshness,
    "outdated",
  );
});

test("time advancing changes freshness without another provider read", () => {
  assert.equal(atsStageDisplay(record, now + ATS_STAGE_STALE_AFTER_MS).freshness, "outdated");
});

test("an unrefreshed import is never represented as a successful current check", () => {
  const result = atsStageDisplay(
    { ...record, availability: "unchecked", lastCheckedAt: null, observedAt: iso(-1) },
    now,
  );
  assert.equal(result.freshness, "unchecked");
  assert.equal(result.checkedAt, null);
  assert.equal(result.observedAt, iso(-1));
});

test("unavailable preserves last-known stage without inventing its observation date", () => {
  const result = atsStageDisplay({ ...record, availability: "unavailable" }, now);
  assert.equal(result.freshness, "unavailable");
  assert.equal(result.stage, "Technical interview");
  assert.equal(result.status, "in_process");
  assert.equal(result.observedAt, null);
  assert.equal(result.checkedAt, iso(-1_000));
});

test("an unavailable record stays unavailable regardless of the age of its check", () => {
  assert.equal(
    atsStageDisplay(
      { ...record, availability: "unavailable", lastCheckedAt: iso(-172_800_000) },
      now,
    ).freshness,
    "unavailable",
  );
});

test("missing or invalid successful check times do not imply freshness", () => {
  for (const lastCheckedAt of [null, "", "invalid", iso(120_000)]) {
    const result = atsStageDisplay({ ...record, lastCheckedAt }, now);
    assert.equal(result.freshness, "unknown");
    assert.equal(result.observedAt, null);
    assert.equal(result.checkedAt, null);
  }
});

test("invalid baseline date stays absent and never produces Invalid Date", () => {
  const result = atsStageDisplay(
    { ...record, availability: "unchecked", observedAt: "invalid", lastCheckedAt: null },
    now,
  );
  assert.equal(result.observedAt, null);
  assert.equal(result.checkedAt, null);
  assert.equal(result.freshness, "unchecked");
});

test("missing stage is explicit even when the external status is hired or rejected", () => {
  for (const status of ["hired", "rejected"]) {
    const result = atsStageDisplay(
      { ...record, application: { ...record.application, status, stageName: null } },
      now,
    );
    assert.equal(result.stage, "Not supplied");
    assert.equal(result.status, status);
  }
});

test("display does not mutate imported metadata or invent a Lexy stage", () => {
  const before = structuredClone(record);
  const result = atsStageDisplay(record, now);
  assert.deepEqual(record, before);
  assert.deepEqual(Object.keys(result).sort(), [
    "checkedAt",
    "freshness",
    "observedAt",
    "stage",
    "status",
  ]);
});
