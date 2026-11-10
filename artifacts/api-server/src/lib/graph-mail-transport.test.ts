import { test } from "node:test";
import assert from "node:assert/strict";
import { submitGraphMail, routeRecruiterMail, type GraphMailResult } from "./graph-mail-transport";
import { isAuditViewerRole } from "./audit-view-policy";
const input = {
  to: "candidate@example.invalid",
  subject: "Synthetic interview",
  text: "No live send",
  replyTo: "recruiter@example.invalid",
  attachments: [
    { filename: "logo.png", content: "AA==", contentType: "image/png", contentId: "lexy-logo" },
  ],
};

test("202 is processing acceptance, with distinct bounded request IDs and no invented message ID", async () => {
  let calls = 0;
  const result = await submitGraphMail(input, {
    token: async () => "synthetic-only",
    fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://graph.microsoft.com/v1.0/me/sendMail");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer synthetic-only");
      const body = JSON.parse(String(init.body));
      assert.equal(body.saveToSentItems, true);
      assert.equal(body.message.toRecipients[0].emailAddress.address, input.to);
      assert.equal(body.message.replyTo[0].emailAddress.address, input.replyTo);
      assert.equal(body.message.attachments[0].contentId, "lexy-logo");
      assert.equal(body.message.attachments[0].isInline, true);
      assert.deepEqual(body.message.internetMessageHeaders, [
        { name: "x-lexy-mail-attempt", value: headers["client-request-id"] },
      ]);
      assert.match(headers["client-request-id"], /^[a-f0-9-]{36}$/);
      return new Response(null, { status: 202, headers: { "request-id": "provider-request-1" } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.acceptance, "accepted");
  assert.equal(result.delivery, "unverified");
  assert.equal(result.providerRequestId, "provider-request-1");
  assert.notEqual(result.clientRequestId, result.providerRequestId);
  assert.ok(!("messageId" in result));
  assert.ok(!JSON.stringify(result).includes(input.to));
});
test("missing or failing token never calls Graph and permits existing SES fallback", async () => {
  for (const token of [
    async () => null,
    async () => {
      throw new Error("private-token-error");
    },
  ]) {
    let calls = 0;
    const result = await submitGraphMail(input, {
      token,
      fetch: async () => {
        calls++;
        throw Error("unexpected");
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.acceptance, "not_attempted");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.fallbackSafe, true);
    assert.ok(!JSON.stringify(result).includes("private-token-error"));
  }
});
test("explicit Graph rejection is distinguishable and permits one alternate-provider decision", async () => {
  for (const status of [400, 401, 403, 404, 405, 413, 415, 422, 429]) {
    let graph = 0,
      ses = 0;
    const routed = await routeRecruiterMail({
      healthy: async () => true,
      send: () =>
        submitGraphMail(input, {
          token: async () => "synthetic-only",
          fetch: async () => {
            graph++;
            return new Response("Do not persist provider body", { status });
          },
        }),
    });
    if (routed.kind === "fallback") ses++;
    assert.equal(graph, 1);
    assert.equal(ses, 1);
    assert.equal(routed.evidence?.acceptance, "rejected");
    assert.ok(!JSON.stringify(routed).includes("Do not persist"));
  }
});
test("timeouts, 5xx, redirects and unexpected success never fall through to SES", async () => {
  for (const status of [200, 201, 204, 301, 408, 499, 500, 502, 503, 504]) {
    let graph = 0,
      ses = 0;
    const routed = await routeRecruiterMail({
      healthy: async () => true,
      send: () =>
        submitGraphMail(input, {
          token: async () => "synthetic-only",
          fetch: async () => {
            graph++;
            return new Response(null, { status });
          },
        }),
    });
    if (routed.kind === "fallback") ses++;
    assert.equal(graph, 1);
    assert.equal(ses, 0);
    assert.equal(routed.kind, "complete");
    assert.equal(routed.evidence?.acceptance, "unknown");
  }
});
test("network failure after dispatch is uncertain, one-shot, sanitized and not resent", async () => {
  let calls = 0;
  const routed = await routeRecruiterMail({
    healthy: async () => true,
    send: () =>
      submitGraphMail(input, {
        token: async () => "synthetic-only",
        fetch: async () => {
          calls++;
          throw new Error("candidate@example.invalid private response");
        },
      }),
  });
  assert.equal(calls, 1);
  assert.equal(routed.kind, "complete");
  assert.equal(routed.evidence?.acceptance, "unknown");
  assert.ok(!JSON.stringify(routed).includes(input.to));
});
test("bookkeeping exceptions after starting Graph cannot release a second provider send", async () => {
  for (const healthy of [async () => true]) {
    const result = await routeRecruiterMail({
      healthy,
      send: async () => {
        throw Error("unexpected adapter exception");
      },
    });
    assert.equal(result.kind, "complete");
    assert.equal(result.evidence?.acceptance, "unknown");
  }
  for (const healthy of [
    async () => false,
    async () => {
      throw Error("lookup failed before send");
    },
  ]) {
    let sent = 0;
    assert.equal(
      (
        await routeRecruiterMail({
          healthy,
          send: async () => {
            sent++;
            throw Error("unexpected");
          },
        })
      ).kind,
      "fallback",
    );
    assert.equal(sent, 0);
  }
});
test("accepted mail ends the provider route without an alternate send", async () => {
  const evidence: GraphMailResult = {
    ok: true,
    transport: "graph",
    acceptance: "accepted",
    delivery: "unverified",
  };
  assert.deepEqual(
    await routeRecruiterMail({ healthy: async () => true, send: async () => evidence }),
    { kind: "complete", evidence },
  );
});
test("malformed request IDs are not retained and request identifiers never cross accounts", async () => {
  const tokens: string[] = [];
  const ids: string[] = [];
  for (const token of ["synthetic-account-one", "synthetic-account-two"]) {
    const result = await submitGraphMail(input, {
      token: async () => token,
      fetch: async (_url, init) => {
        tokens.push((init.headers as Record<string, string>).Authorization);
        return new Response(null, { status: 202, headers: { "request-id": "x".repeat(129) } });
      },
    });
    assert.equal(result.providerRequestId, undefined);
    ids.push(result.clientRequestId!);
  }
  assert.notEqual(ids[0], ids[1]);
  assert.deepEqual(tokens, ["Bearer synthetic-account-one", "Bearer synthetic-account-two"]);
});
test("staff audit evidence is not authorized by tenant membership alone", () => {
  for (const role of [
    "platform_admin",
    "tenant_admin",
    "recruiter_admin",
    "recruiter",
    "hiring_manager",
  ])
    assert.equal(isAuditViewerRole(role), true);
  for (const role of ["candidate", "interviewer", "client", "unknown", ""])
    assert.equal(isAuditViewerRole(role), false);
});
