import assert from "node:assert/strict";
import { test } from "node:test";
import { zohoInterviewNoteProvider } from "./zoho-interview-note-provider";
import { ZOHO_DATA_CENTERS, type ZohoOAuthConfig } from "./zoho-oauth-provider";

function fixture() {
  const actor = { id: "staff", tenantId: "employer" };
  const binding = {
    accountRef: "account",
    connectionRevision: "revision",
    externalCandidateId: "123",
    externalJobId: "456",
    applicationId: "789",
  };
  const config = { fingerprint: "fixture", region: ZOHO_DATA_CENTERS.us } as ZohoOAuthConfig;
  const row = {
    tenantId: actor.tenantId,
    userId: actor.id,
    approvedAt: new Date(),
    refreshTokenEnc: "synthetic-encrypted-fixture",
    accountRef: binding.accountRef,
    revision: binding.connectionRevision,
    fingerprint: config.fingerprint,
  };
  let scope = true,
    org = "account",
    candidate = "123",
    calls = 0;
  let status = 200,
    body: unknown = { data: [{ code: "SUCCESS", status: "success", details: { id: "999" } }] };
  const captured: { url: string; init: RequestInit }[] = [];
  type Deps = NonNullable<Parameters<typeof zohoInterviewNoteProvider>[0]>;
  const provider = zohoInterviewNoteProvider({
    config,
    store: { get: async () => ({ ...row }) },
    actorLookup: async () => actor,
    unseal: () =>
      JSON.stringify({
        purpose: "zoho-recruit",
        tenantId: actor.tenantId,
        userId: actor.id,
        accountRef: "account",
        fingerprint: "fixture",
        token: "synthetic-token",
        interviewNotes: scope,
      }),
    providerFactory: () => ({
      refresh: async () => "synthetic-access",
      organization: async () => ({ accountRef: org }),
      readApplication: async () => ({
        data: [
          {
            id: "789",
            $Job_Opening_Id: "456",
            $Candidate_Id: candidate,
            Application_Status: "New",
          },
        ],
      }),
    }),
    request: async (url: string, init: RequestInit) => {
      calls++;
      captured.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    },
  } as unknown as Deps);
  return {
    actor,
    binding,
    row,
    provider,
    captured,
    calls: () => calls,
    scope: (v: boolean) => {
      scope = v;
    },
    organization: (v: string) => {
      org = v;
    },
    candidate: (v: string) => {
      candidate = v;
    },
    response: (s: number, b: unknown) => {
      status = s;
      body = b;
    },
  };
}
test("provider creates one candidate note at the pinned Recruit origin, never a stage write", async () => {
  const f = fixture(),
    connection = await f.provider.connect(f.actor, f.binding);
  assert.equal(await connection.create("Approved title", "Approved content"), "999");
  assert.equal(f.calls(), 1);
  const { url, init } = f.captured[0];
  assert.equal(url, "https://recruit.zoho.com/recruit/v2/Notes");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal);
  assert.deepEqual(JSON.parse(String(init.body)), {
    data: [
      {
        Note_Title: "Approved title",
        Note_Content: "Approved content",
        Parent_Id: "123",
        se_module: "Candidates",
      },
    ],
  });
});
test("read-only custody cannot publish even if the provider account has broader permissions", async () => {
  const f = fixture();
  f.scope(false);
  assert.equal(await f.provider.permitted(f.actor, f.binding), false);
  await assert.rejects(f.provider.connect(f.actor, f.binding), /reconnect/);
  assert.equal(f.calls(), 0);
});
test("foreign organization, application binding and replaced connection prevent notes", async () => {
  const f = fixture();
  f.organization("foreign");
  await assert.rejects(f.provider.connect(f.actor, f.binding));
  f.organization("account");
  f.candidate("321");
  await assert.rejects(f.provider.connect(f.actor, f.binding));
  f.candidate("123");
  const connection = await f.provider.connect(f.actor, f.binding);
  f.row.revision = "changed";
  await assert.rejects(connection.create("title", "content"));
  assert.equal(f.calls(), 0);
});
test("provider denial, malformed success and oversized response are not accepted or retried", async () => {
  for (const [status, body] of [
    [403, { message: "raw private provider message" }],
    [200, { data: [{ status: "success", code: "SUCCESS", details: {} }] }],
    [200, { payload: "x".repeat(128001) }],
  ] as const) {
    const f = fixture(),
      c = await f.provider.connect(f.actor, f.binding);
    f.response(status, body);
    await assert.rejects(c.create("title", "content"));
    assert.equal(f.calls(), 1);
  }
});
