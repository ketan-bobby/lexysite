import assert from "node:assert/strict";
import { test } from "node:test";
import { greenhouseDirect } from "./greenhouse-direct";
import { greenhouseGateway } from "./greenhouse-gateway";

const sample = { clientId: "fixture-client", clientSecret: "fixture-secret" };
const noteInput = {
  candidate_id: 202,
  application_id: 303,
  note_type: "NOTE" as const,
  visibility: "admin_only" as const,
  subject: "Lexy progress",
  body: "Interview completed.",
};
test("recovery reads exactly one direct note ID without widening the general GET proxy", async () => {
  const f = fixture();
  const id = f.direct.connectionId()!;
  const gateway = greenhouseGateway(
    {
      listConnections: async () => [],
      createProxyFetch: () => {
        throw new Error("No managed access");
      },
    },
    f.direct,
  );
  assert.equal(gateway.canReadNotes?.(id), true);
  assert.equal(gateway.canReadNotes?.("managed"), false);
  for (const invalid of [
    "0",
    "-1",
    "1&candidate_ids=202",
    "1,2",
    "9007199254740992",
    "https://invalid.test",
  ]) {
    await assert.rejects(gateway.readNote!(id, invalid));
  }
  await assert.rejects(gateway.readNote!("managed", "101"));
  await assert.rejects(gateway.read(id, "/v3/notes?ids=101"));
  assert.equal(f.calls.length, 0, "invalid requests do not exchange credentials");
  assert.deepEqual(await gateway.readNote!(id, "101"), [{ id: 101 }]);
  const call = f.calls.at(-1)!;
  assert.equal(call.url, "https://harvest.greenhouse.io/v3/notes?ids=101");
  assert.equal(call.init?.method, "GET");
  assert.equal(call.init?.body, undefined);
  assert.equal(call.init?.redirect, "error");
});
function fixture() {
  let credentials: typeof sample | null = { ...sample };
  let time = 0;
  const calls: { url: string; init?: RequestInit }[] = [];
  let respond = (url: string): Response =>
    url.startsWith("https://auth.")
      ? Response.json({ access_token: "fixture-token", expires_in: 120, token_type: "Bearer" })
      : Response.json([{ id: 101 }]);
  const direct = greenhouseDirect({
    credentials: () => credentials,
    now: () => time,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      return respond(String(url));
    },
  });
  return {
    direct,
    calls,
    setCredentials: (value: typeof sample | null) => (credentials = value),
    setTime: (value: number) => (time = value),
    respond: (handler: typeof respond) => (respond = handler),
  };
}
test("direct reads use fixed OAuth and Harvest v3 URLs without a workspace connector", async () => {
  const f = fixture();
  const id = f.direct.connectionId()!;
  assert.ok(!id.includes(sample.clientId) && !id.includes(sample.clientSecret));
  const gateway = greenhouseGateway(
    {
      listConnections: async () => {
        throw new Error("Workspace discovery must not run.");
      },
      createProxyFetch: () => {
        throw new Error("Workspace proxy must not run.");
      },
    },
    f.direct,
  );
  assert.deepEqual(await gateway.connections(), [{ id }]);
  assert.deepEqual(await gateway.read(id, "/v3/jobs?ids=101"), [{ id: 101 }]);
  assert.equal(f.calls[0].url, "https://auth.greenhouse.io/token?grant_type=client_credentials");
  assert.equal(f.calls[0].init?.method, "POST");
  assert.equal(f.calls[1].url, "https://harvest.greenhouse.io/v3/jobs?ids=101");
  assert.equal(f.calls[1].init?.method, "GET");
  for (const c of f.calls) {
    assert.equal(c.init?.redirect, "error");
    assert.ok(c.init?.signal instanceof AbortSignal);
  }
});
test("explicit note publication uses one fixed POST and verifies the exact note receipt", async () => {
  const f = fixture();
  const gateway = greenhouseGateway(undefined, f.direct);
  const id = f.direct.connectionId()!;
  f.respond((url) =>
    url.startsWith("https://auth.")
      ? Response.json({ access_token: "fixture-token", expires_in: 120, token_type: "Bearer" })
      : Response.json(
          {
            id: 404,
            candidate_id: 202,
            application_id: 303,
            type: "NOTE",
            visibility: "admin_only_visible",
            subject: noteInput.subject,
            body: noteInput.body,
          },
          { status: 201 },
        ),
  );
  assert.equal(gateway.canPublishNotes?.(id), true);
  assert.equal(gateway.canPublishNotes?.("managed"), false);
  assert.equal(await gateway.publishNote!(id, noteInput), "404");
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, "https://harvest.greenhouse.io/v3/notes");
  assert.equal(f.calls[1].init?.method, "POST");
  assert.equal(f.calls[1].init?.redirect, "error");
  assert.deepEqual(JSON.parse(String(f.calls[1].init?.body)), noteInput);
  await assert.rejects(gateway.publishNote!("managed", noteInput));
  await assert.rejects(f.direct.request(id, "/v3/notes"));
  assert.equal(f.calls.length, 2, "unsupported writes/read paths cannot exchange credentials");
});
test("note transport rejects broadened payloads before I/O and never retries ambiguous responses", async () => {
  for (const field of [{ visibility: "public" }, { note_type: "EMAIL" }, { user_id: 999 }]) {
    const f = fixture();
    await assert.rejects(
      f.direct.createNote!(f.direct.connectionId()!, {
        ...noteInput,
        ...field,
      } as typeof noteInput),
    );
    assert.equal(f.calls.length, 0);
  }
  for (const response of [
    Response.json({ PRIVATE: "payload" }, { status: 403 }),
    Response.json({ id: 404, candidate_id: 909 }, { status: 201 }),
  ]) {
    const f = fixture();
    f.respond((url) =>
      url.startsWith("https://auth.")
        ? Response.json({ access_token: "fixture-token", expires_in: 120, token_type: "Bearer" })
        : response,
    );
    await assert.rejects(
      greenhouseGateway(undefined, f.direct).publishNote!(f.direct.connectionId()!, noteInput),
    );
    assert.equal(f.calls.length, 2, "one token exchange and one write only");
  }
});
test("missing, partial and malformed credentials never become a discoverable connection", () => {
  assert.equal(greenhouseDirect({ credentials: () => null }).connectionId(), null);
  for (const value of [
    { clientId: "", clientSecret: "fixture" },
    { clientId: "fixture", clientSecret: "" },
    { clientId: "a:b", clientSecret: "fixture" },
    { clientId: "fixture", clientSecret: "line\nbreak" },
  ])
    assert.throws(() => greenhouseDirect({ credentials: () => value }).connectionId());
});
test("rotation or removal invalidates old identities before transport", async () => {
  const f = fixture();
  const id = f.direct.connectionId()!;
  f.setCredentials({ ...sample, clientSecret: "rotated-fixture" });
  assert.notEqual(f.direct.connectionId(), id);
  await assert.rejects(f.direct.request(id, "/v3/jobs?ids=101"));
  f.setCredentials(null);
  await assert.rejects(f.direct.request(id, "/v3/jobs?ids=101"));
  assert.equal(f.calls.length, 0);
});
test("unfiltered, injected, foreign-host and consequential paths never exchange credentials", async () => {
  const f = fixture();
  for (const path of [
    "/v3/jobs",
    "/v3/notes",
    "/v3/offers?ids=101",
    "/v3/applications/101/move",
    "/v3/applications?job_ids=101&per_page=100",
    "/v3/jobs?ids=101&ids=202",
    "https://other.test/v3/jobs?ids=101",
    "/v1/jobs?ids=101",
  ])
    await assert.rejects(f.direct.request(f.direct.connectionId()!, path));
  assert.equal(f.calls.length, 0);
});
test("token reuse is bounded and expiration exchanges once without retrying requests", async () => {
  const f = fixture();
  const id = f.direct.connectionId()!;
  await Promise.all([
    f.direct.request(id, "/v3/jobs?ids=101"),
    f.direct.request(id, "/v3/candidates?ids=101"),
  ]);
  assert.equal(f.calls.filter((c) => c.url.startsWith("https://auth.")).length, 1);
  f.setTime(91_000);
  await f.direct.request(id, "/v3/applications?ids=101");
  assert.equal(f.calls.filter((c) => c.url.startsWith("https://auth.")).length, 2);
});
test("malformed/oversized token responses and provider errors are sanitized with no automatic retry", async () => {
  for (const make of [
    () => Response.json({ access_token: "invalid token", expires_in: 120, token_type: "Bearer" }),
    () => Response.json({ access_token: "fixture", expires_in: -1, token_type: "Bearer" }),
    () => Response.json({ access_token: "fixture", expires_in: 120, token_type: "Basic" }),
    () => new Response("private-token-body", { status: 401 }),
    () => new Response("x".repeat(65_537)),
    () => new Response("private-invalid-json"),
  ]) {
    const f = fixture();
    f.respond(make);
    await assert.rejects(f.direct.request(f.direct.connectionId()!, "/v3/jobs?ids=101"), {
      message: "Greenhouse direct read unavailable.",
    });
    assert.equal(f.calls.length, 1);
  }
});
test("credential revocation during token exchange or resource read prevents returned data", async () => {
  for (const duringToken of [true, false]) {
    const f = fixture();
    f.respond((url) => {
      if (url.startsWith("https://auth.")) {
        if (duringToken) f.setCredentials(null);
        return Response.json({ access_token: "fixture", expires_in: 120, token_type: "Bearer" });
      }
      f.setCredentials(null);
      return Response.json([{ id: 101 }]);
    });
    await assert.rejects(f.direct.request(f.direct.connectionId()!, "/v3/jobs?ids=101"));
    assert.equal(f.calls.length, duringToken ? 1 : 2);
  }
});
test("resource 401/403 revokes cache and never triggers an automatic replay", async () => {
  const f = fixture();
  f.respond((url) =>
    url.startsWith("https://auth.")
      ? Response.json({ access_token: "fixture", expires_in: 120, token_type: "Bearer" })
      : new Response("private-provider-body", { status: 403 }),
  );
  const id = f.direct.connectionId()!;
  await assert.rejects(f.direct.request(id, "/v3/jobs?ids=101"));
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.direct.request(id, "/v3/jobs?ids=101"));
  assert.equal(f.calls.length, 4);
});

test("gateway discards a completed body when credentials change while it streams", async () => {
  const f = fixture();
  f.respond((url) =>
    url.startsWith("https://auth.")
      ? Response.json({ access_token: "fixture", expires_in: 120, token_type: "Bearer" })
      : new Response(
          new ReadableStream(
            {
              pull(controller) {
                f.setCredentials(null);
                controller.enqueue(new TextEncoder().encode('[{"id":101}]'));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        ),
  );
  const gateway = greenhouseGateway(
    {
      listConnections: async () => [],
      createProxyFetch: () => {
        throw new Error("No managed fallback.");
      },
    },
    f.direct,
  );
  await assert.rejects(gateway.read(f.direct.connectionId()!, "/v3/jobs?ids=101"));
});
