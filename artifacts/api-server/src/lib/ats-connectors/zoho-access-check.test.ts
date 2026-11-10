import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import { zohoOAuthService } from "./zoho-oauth-service";
import { zohoAccessCheck } from "./zoho-access-check";
import { zohoOAuthConfig, zohoOAuthProvider, zohoFailure } from "./zoho-oauth-provider";
import type { ZohoRow, ZohoStore } from "./zoho-oauth-store";

const config = zohoOAuthConfig({
  ZOHO_CLIENT_ID: "1000.synthetic",
  ZOHO_CLIENT_SECRET: "synthetic-client-secret",
  ZOHO_REDIRECT_URI: "https://api.example.test/api/zoho-recruit/callback",
  ZOHO_SETTINGS_URL: "https://app.example.test/settings/ats",
  SESSION_SECRET: "synthetic",
  ZOHO_DATA_CENTER: "us",
})!;
const actor = { id: "synthetic-admin", tenantId: "synthetic-employer" };
const revision = "11111111-1111-4111-8111-111111111111";
function fixture() {
  let row: ZohoRow | undefined = {
    tenantId: actor.tenantId,
    userId: actor.id,
    revision,
    fingerprint: config.fingerprint,
    accountRef: "synthetic-account",
    companyName: "Synthetic Company",
    refreshTokenEnc: "sealed",
    approvedAt: new Date(),
    updatedAt: new Date(),
    flowHash: null,
    browserHash: null,
    flowExpiresAt: null,
  };
  let active = true;
  let payload = {
    purpose: "zoho-recruit",
    tenantId: actor.tenantId,
    userId: actor.id,
    accountRef: row.accountRef,
    fingerprint: config.fingerprint,
    token: "synthetic-refresh",
  };
  let hook = (_stage: string) => {};
  let moduleError: string | null = null;
  let returnedAccount = row.accountRef;
  const calls: string[] = [];
  const noWrite = async () => {
    throw new Error("diagnostic must not write");
  };
  const store: ZohoStore = {
    get: async (a) => (a.tenantId === row?.tenantId ? { ...row } : undefined),
    begin: noWrite,
    consume: noWrite,
    save: noWrite,
    approve: noWrite,
    disconnect: noWrite,
  };
  const service = zohoAccessCheck({
    store,
    config,
    actorLookup: async (id) => {
      if (!active || id !== actor.id) throw zohoFailure("zoho_authority_changed", 403);
      return actor;
    },
    unseal: () => JSON.stringify(payload),
    providerFactory: () => ({
      authorize: async () => {
        throw new Error("unexpected authorization");
      },
      async refresh(token) {
        assert.equal(token, "synthetic-refresh");
        calls.push("refresh");
        hook("refresh");
        return "synthetic-access";
      },
      async organization() {
        calls.push("organization");
        hook("organization");
        return { accountRef: returnedAccount!, companyName: "Synthetic Company" };
      },
      async probeModule(_token, module) {
        calls.push(module);
        hook(module);
        if (moduleError && module === "Candidates") throw zohoFailure(moduleError);
        return module === "Applications" ? "empty" : "readable";
      },
    }),
  });
  return {
    service,
    calls,
    row: () => row,
    mutate: (patch: Partial<ZohoRow>) => {
      row = { ...row!, ...patch };
    },
    payload: (patch: Partial<typeof payload>) => {
      payload = { ...payload, ...patch };
    },
    suspend: () => {
      active = false;
    },
    hook: (fn: typeof hook) => {
      hook = fn;
    },
    failCandidate: (code: string) => {
      moduleError = code;
    },
    foreignOrg: () => {
      returnedAccount = "foreign-account";
    },
  };
}
test("approved access check is bounded, read-only, and returns no credentials or records", async () => {
  const f = fixture();
  const result = await f.service.check(actor, revision);
  assert.deepEqual(f.calls, [
    "refresh",
    "organization",
    "Job_Openings",
    "Candidates",
    "Applications",
  ]);
  assert.deepEqual(
    result.modules.map((x) => x.status),
    ["readable", "readable", "empty"],
  );
  assert.equal(result.importsEnabled, false);
  assert.ok(result.checkedAt instanceof Date);
  const text = JSON.stringify(result);
  for (const secret of [
    "synthetic-refresh",
    "synthetic-access",
    "synthetic-account",
    "Synthetic Company",
  ])
    assert.ok(!text.includes(secret));
});
test("missing approval, stale revisions, foreign tenants, and suspended admins perform no remote calls", async () => {
  for (const patch of [
    { approvedAt: null },
    { refreshTokenEnc: null },
    { accountRef: null },
    { fingerprint: "old-config" },
    { revision: "replaced" },
  ]) {
    const f = fixture();
    f.mutate(patch);
    await assert.rejects(f.service.check(actor, revision));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  await assert.rejects(f.service.check({ ...actor, tenantId: "foreign-employer" }, revision));
  f.suspend();
  await assert.rejects(f.service.check(actor, revision));
  assert.equal(f.calls.length, 0);
});
test("encrypted custody must bind purpose, employer, authorizer, account and configuration", async () => {
  for (const patch of [
    { purpose: "other" },
    { tenantId: "foreign" },
    { userId: "foreign" },
    { accountRef: "foreign" },
    { fingerprint: "foreign" },
    { token: "" },
  ]) {
    const f = fixture();
    f.payload(patch);
    await assert.rejects(f.service.check(actor, revision));
    assert.equal(f.calls.length, 0);
  }
});
test("disconnect, replacement, and admin suspension during I/O stop the next read and final response", async () => {
  for (const stage of ["refresh", "organization", "Job_Openings", "Candidates", "Applications"]) {
    for (const change of ["disconnect", "replace", "suspend"]) {
      const f = fixture();
      f.hook((s) => {
        if (s !== stage) return;
        if (change === "disconnect") f.mutate({ refreshTokenEnc: null, approvedAt: null });
        else if (change === "replace") f.mutate({ revision: "replaced" });
        else f.suspend();
      });
      await assert.rejects(f.service.check(actor, revision));
      assert.equal(f.calls.at(-1), stage);
    }
  }
});
test("organization mismatch stops before all module reads", async () => {
  const f = fixture();
  f.foreignOrg();
  await assert.rejects(f.service.check(actor, revision));
  assert.deepEqual(f.calls, ["refresh", "organization"]);
});
test("permission failures are per-module observations, never fabricated empty success", async () => {
  for (const [code, reason] of [
    ["zoho_module_scope_missing", "scope_missing"],
    ["zoho_module_access_denied", "access_denied"],
    ["zoho_module_unsupported", "unsupported"],
    ["zoho_module_request_failed", "request_failed"],
  ]) {
    const f = fixture();
    f.failCandidate(code);
    const result = await f.service.check(actor, revision);
    assert.deepEqual(result.modules[1], { module: "Candidates", status: "unavailable", reason });
  }
  const f = fixture();
  f.failCandidate("zoho_module_token_rejected");
  await assert.rejects(f.service.check(actor, revision));
  assert.equal(f.calls.at(-1), "Candidates");
});
test("refresh and minimal module probes use fixed product hosts without returning sampled records", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const provider = zohoOAuthProvider(config, async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1)
      return Response.json({
        access_token: "synthetic-access",
        api_domain: config.region.api,
        token_type: "Bearer",
        expires_in: 3600,
      });
    return Response.json({ data: [{ id: "12345678901234567890", Email: "private@example.test" }] });
  });
  const token = await provider.refresh("synthetic-refresh");
  assert.equal(calls[0].url, "https://accounts.zoho.com/oauth/v2/token");
  assert.equal(
    new URLSearchParams(calls[0].init?.body as URLSearchParams).get("grant_type"),
    "refresh_token",
  );
  assert.ok(!calls[0].url.includes("synthetic-refresh"));
  assert.equal(await provider.probeModule(token, "Candidates"), "readable");
  assert.equal(
    calls[1].url,
    "https://recruit.zoho.com/recruit/v2/Candidates?fields=id&page=1&per_page=1",
  );
  assert.equal(calls[1].init?.redirect, "error");
});
test("empty 204 is accepted, malformed or unexpectedly broad record responses fail closed", async () => {
  const empty = zohoOAuthProvider(config, async () => new Response(null, { status: 204 }));
  assert.equal(await empty.probeModule("synthetic-access", "Applications"), "empty");
  for (const body of [
    { data: [{ id: 123 }] },
    { data: [{ id: "1" }, { id: "2" }] },
    { private: "payload" },
  ]) {
    await assert.rejects(
      zohoOAuthProvider(config, async () => Response.json(body)).probeModule("a", "Candidates"),
    );
  }
});
test("HTTP access check requires an authenticated employer admin and explicit strict confirmation", async () => {
  let authorized = true;
  const f = fixture();
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    zohoRecruitAccountRouter(
      {
        actor: async () => {
          if (!authorized) throw zohoFailure("zoho_employer_admin_required", 403);
          return actor;
        },
        config: () => config,
        service: zohoOAuthService,
      },
      () => f.service,
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/zoho-recruit/account/check-access`;
    const post = (body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      {},
      { revision, confirm: false },
      { revision, confirm: "true" },
      { revision, confirm: true, tenantId: "foreign-employer" },
    ])
      assert.equal((await post(body)).status, 400);
    authorized = false;
    assert.equal((await post({ revision, confirm: true })).status, 403);
    assert.equal(f.calls.length, 0);
    authorized = true;
    const response = await post({ revision, confirm: true });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = (await response.json()) as {
      importsEnabled: boolean;
      modules: unknown[];
      checkedAt: string;
    };
    assert.equal(result.importsEnabled, false);
    assert.equal(result.modules.length, 3);
    assert.ok(!Number.isNaN(Date.parse(result.checkedAt)));
    assert.ok(!JSON.stringify(result).includes("synthetic-"));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
