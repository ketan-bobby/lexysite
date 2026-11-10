import assert from "node:assert/strict";
import { test } from "node:test";
import { readIntelligenceActionResult } from "./intelligence-action-result";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("accepted run is not described as completed or delivered", async () => {
  const result = await readIntelligenceActionResult(
    json({ triggered: true, action: "advance", runId: "run-fixture", status: "running" }),
  );
  assert.equal(result.triggered, true);
  assert.equal(result.runId, "run-fixture");
  assert.match(result.message, /does not confirm completion or delivery/);
});

test("HTTP failures never become success receipts or expose server diagnostics", async () => {
  for (const status of [400, 401, 403, 404, 409, 429, 500, 502]) {
    await assert.rejects(
      readIntelligenceActionResult(json({ error: "PRIVATE_SERVER_DETAILS" }, status)),
      (error: Error) => !error.message.includes("PRIVATE_SERVER_DETAILS"),
    );
  }
});

test("policy and approval blocks remain not executed, including HTTP 200", async () => {
  for (const blocked of ["approval_required", "policy_disabled_automation", "future_gate"]) {
    const result = await readIntelligenceActionResult(
      json({ triggered: false, action: "advance", blocked, message: "Misleading success" }),
    );
    assert.equal(result.triggered, false);
    assert.equal(result.runId, undefined);
    assert.match(result.message, /^Not executed/);
    assert.doesNotMatch(result.message, /Misleading success/);
  }
});

test("manual steps preserve the actual server explanation without claiming a run", async () => {
  const result = await readIntelligenceActionResult(
    json({ triggered: false, action: "hold", message: "Hold is a manual step." }),
  );
  assert.equal(result.triggered, false);
  assert.equal(result.message, "Hold is a manual step.");
});

test("HTML, malformed JSON and incomplete receipts fail explicitly", async () => {
  for (const data of [
    null,
    {},
    { error: "PRIVATE_ERROR" },
    { triggered: "true", action: "advance" },
    { triggered: true, action: "advance" },
    { triggered: true, action: "", runId: "run-fixture" },
    { triggered: true, action: "advance", runId: " " },
  ]) {
    await assert.rejects(readIntelligenceActionResult(json(data)), /receipt|reference/);
  }
  await assert.rejects(
    readIntelligenceActionResult(new Response("<html>Proxy error</html>")),
    /unreadable receipt/,
  );
});
