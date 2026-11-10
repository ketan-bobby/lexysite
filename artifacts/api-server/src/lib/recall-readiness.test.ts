import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRecallReadiness } from "./recall-readiness";

const connection = { id: "selected", connector_name: "recall-ai", customer_id: "private" };
test("readiness pins the sole Recall connection and discards all provider data", async () => {
  const calls: unknown[] = [];
  const view = await checkRecallReadiness({
    listConnections: async (options) => {
      calls.push(options);
      return [connection];
    },
    proxy: async (...args) => {
      calls.push(args);
      return new Response('{"results":[{"meeting_url":"PRIVATE","id":"PRIVATE"}]}');
    },
  });
  assert.deepEqual(calls, [
    { connector_names: "recall-ai" },
    ["recall-ai", "/api/v1/bot/?page_size=1", { connectionId: "selected", method: "GET" }],
  ]);
  assert.equal(view.state, "connected");
  assert.equal(view.attendanceEnabled, false);
  assert.ok(!JSON.stringify(view).includes("PRIVATE"));
  assert.ok(!JSON.stringify(view).includes("selected"));
});
test("ambiguous, inaccessible and non-Recall connections never reach the provider", async () => {
  for (const connections of [
    [],
    [connection, { ...connection, id: "second" }],
    [{ ...connection, connector_name: "zoom" }],
  ]) {
    const view = await checkRecallReadiness({
      listConnections: async () => connections,
      proxy: async () => {
        assert.fail("The provider must not be called.");
      },
    });
    assert.notEqual(view.state, "connected");
    assert.equal(view.attendanceEnabled, false);
  }
});
test("credentials, region errors, rate limits and upstream failures are sanitized without retries", async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    const view = await checkRecallReadiness({
      listConnections: async () => [connection],
      proxy: async () => {
        calls++;
        return new Response("SECRET PROVIDER DETAIL", { status });
      },
    });
    assert.equal(calls, 1);
    assert.equal(
      view.state,
      [401, 403].includes(status) ? "authorization_required" : "unavailable",
    );
    assert.ok(!JSON.stringify(view).includes("SECRET"));
  }
});
test("throwing SDK calls and bounded timeouts cannot dispatch or report enabled attendance", async () => {
  for (const proxy of [
    async (): Promise<Response> => {
      throw new Error("sensitive provider exception");
    },
    () => new Promise<Response>(() => {}),
  ]) {
    const view = await checkRecallReadiness(
      { listConnections: async () => [connection], proxy },
      5,
    );
    assert.equal(view.state, "unavailable");
    assert.equal(view.attendanceEnabled, false);
    assert.ok(!JSON.stringify(view).includes("sensitive"));
  }
});
