import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AtsImportedRecord } from "@workspace/api-client-react";
import { WorkflowAtsStage } from "./WorkflowAtsStage";

// The tsx runner uses classic JSX for the app's jsx:preserve configuration.
Object.assign(globalThis, { React });
const record: AtsImportedRecord = {
  id: "stage-render-fixture",
  job: { id: "101", name: "Fixture", status: "open" },
  application: {
    id: "303",
    candidateId: "202",
    status: "in_process",
    stageName: "Technical interview",
  },
  importedAt: "2020-01-01T00:00:00.000Z",
  observedAt: "2020-01-01T00:00:00.000Z",
  lastCheckedAt: new Date().toISOString(),
  refreshRevision: 1,
  availability: "available",
};
const render = (value = record) =>
  renderToStaticMarkup(React.createElement(WorkflowAtsStage, { record: value }));

test("stage and status are explicitly external, read-only, and separate from Lexy", () => {
  const html = render();
  for (const text of [
    "Greenhouse stage:",
    "Technical interview",
    "Greenhouse application status:",
    "in_process",
    "Saved check within 24h (not live)",
    "separate from the Lexy workflow stage",
    "Read-only",
  ]) {
    assert.ok(html.includes(text), `Missing ${text}`);
  }
  assert.doesNotMatch(html, /<button|<form|Invalid Date/);
});

test("an old saved check is visibly outdated", () => {
  assert.match(
    render({ ...record, lastCheckedAt: "2020-01-01T00:00:00.000Z" }),
    /Outdated: last saved check 24h\+ ago/,
  );
});

test("unchecked imports never display the recent saved-check label", () => {
  const html = render({ ...record, availability: "unchecked", lastCheckedAt: null });
  assert.match(html, /Imported, not refreshed since/);
  assert.doesNotMatch(html, /Saved check within/);
});

test("unavailable records label retained data and do not imply a rejection", () => {
  const html = render({ ...record, availability: "unavailable" });
  assert.match(html, /last-known values/);
  assert.match(html, /not proof of deletion or rejection/);
  assert.match(html, /Last successful stage observation: unknown/);
  assert.match(html, /Technical interview/);
  assert.doesNotMatch(html, /Saved check within/);
});

test("provider text is escaped and missing dates render unknown safely", () => {
  const html = render({
    ...record,
    lastCheckedAt: "invalid",
    application: { ...record.application, stageName: "<script>alert(1)</script>" },
  });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /Freshness unknown/);
  assert.match(html, /Latest check: unknown/);
  assert.doesNotMatch(html, /<script|Invalid Date/);
});
