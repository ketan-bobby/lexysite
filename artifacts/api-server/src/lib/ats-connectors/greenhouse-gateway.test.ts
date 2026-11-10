import assert from "node:assert/strict";
import { test } from "node:test";
import { greenhouseDirect } from "./greenhouse-direct";
import {
  greenhouseGateway,
  boundedAtsRead,
  applicationPreviewPath,
  nextApplicationCursor,
} from "./greenhouse-gateway";

function fixture(response = () => new Response(JSON.stringify([{ id: 101 }]))) {
  const calls: { provider: string; connectionId?: string; path: string; init?: RequestInit }[] = [];
  const sdk = {
    async listConnections() {
      return [
        { id: "one", connector_name: "greenhouse-harvest-partner", customer_id: "private" },
        { id: "wrong", connector_name: "greenhouse", customer_id: "private" },
      ];
    },
    createProxyFetch(provider: string, selection?: { connectionId?: string }): typeof fetch {
      return async (input, init) => {
        calls.push({ provider, connectionId: selection?.connectionId, path: String(input), init });
        return response();
      };
    },
  };
  return {
    gateway: greenhouseGateway(sdk, greenhouseDirect({ credentials: () => null })),
    calls,
  };
}

test("gateway selects Harvest only, strips metadata and pins filtered GET requests", async () => {
  const f = fixture();
  assert.deepEqual(await f.gateway.connections(), [{ id: "one" }]);
  assert.deepEqual(await f.gateway.read("one", "/v3/jobs?ids=101"), [{ id: 101 }]);
  assert.equal(f.calls[0].provider, "greenhouse-harvest-partner");
  assert.equal(f.calls[0].connectionId, "one");
  assert.equal(f.calls[0].init?.method, "GET");
  assert.equal(f.calls[0].init?.redirect, "error");
  assert.ok(f.calls[0].init?.signal instanceof AbortSignal);
  assert.equal(f.calls[0].init?.body, undefined);
});

test("gateway rejects arbitrary hosts, bulk reads, offers and query injection before transport", async () => {
  const f = fixture();
  for (const path of [
    "https://example.com/v3/jobs?ids=101",
    "/v3/jobs",
    "/v1/jobs/101",
    "/v3/offers?ids=101",
    "/v3/jobs?ids=101&ids=202",
    "/v3/jobs?ids=01",
  ])
    await assert.rejects(f.gateway.read("one", path));
  assert.equal(f.calls.length, 0);
});

test("HTTP failures, invalid JSON and oversized responses do not return success", async () => {
  for (const makeResponse of [
    () => new Response("PRIVATE", { status: 401 }),
    () => new Response("PRIVATE", { status: 429 }),
    () => new Response("PRIVATE", { status: 500 }),
    () => new Response("invalid json"),
    () => new Response("x".repeat(2_000_001)),
  ]) {
    const f = fixture(makeResponse);
    await assert.rejects(f.gateway.read("one", "/v3/jobs?ids=101"));
    assert.equal(f.calls.length, 1);
  }
});

test("diagnostic wait is bounded without turning a timeout into success", async () => {
  await assert.rejects(boundedAtsRead(new Promise<never>(() => undefined), 5));
});

test("preview transport follows only pinned application cursors and bounded filtered pages", async () => {
  const f = fixture(
    () =>
      new Response("[]", {
        headers: {
          Link: '<https://harvest.greenhouse.io/v3/applications?cursor=opaque%2Bcursor>; rel="next"',
        },
      }),
  );
  assert.deepEqual(await f.gateway.page!("one", applicationPreviewPath("101")), {
    records: [],
    nextCursor: "opaque+cursor",
  });
  await f.gateway.page!("one", applicationPreviewPath("101", "opaque+cursor"));
  assert.equal(f.calls[1].path, "/v3/applications?cursor=opaque%2Bcursor");
  assert.equal(f.calls[1].init?.method, "GET");
  assert.equal(f.calls[1].init?.redirect, "error");
  for (const path of [
    "/v3/applications",
    "/v3/jobs?per_page=25",
    "/v3/applications?job_ids=101&per_page=500",
    "/v3/applications?cursor=x&job_ids=404",
    "https://example.com/v3/applications?cursor=x",
  ])
    await assert.rejects(f.gateway.page!("one", path));
  assert.equal(f.calls.length, 2);
  assert.throws(() => applicationPreviewPath("1&job_ids=404"));
  assert.throws(() => applicationPreviewPath("9007199254740992"));
  assert.throws(() => applicationPreviewPath("101", "x".repeat(8001)));
});

test("provider pagination rejects foreign hosts, redirects, duplicate params and resource changes", () => {
  assert.equal(nextApplicationCursor(null), null);
  for (const url of [
    "https://evil.test/v3/applications?cursor=x",
    "https://harvest.greenhouse.io/v3/jobs?cursor=x",
    "http://harvest.greenhouse.io/v3/applications?cursor=x",
    "https://user:pass@harvest.greenhouse.io/v3/applications?cursor=x",
    "https://harvest.greenhouse.io/v3/applications?cursor=x&cursor=y",
    "https://harvest.greenhouse.io/v3/applications?cursor=x&job_ids=404",
    "https://harvest.greenhouse.io/v3/applications?cursor=x#fragment",
  ])
    assert.throws(() => nextApplicationCursor(`<${url}>; rel="next"`));
});
