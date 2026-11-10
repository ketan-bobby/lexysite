import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { once } from "node:events";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import {
  zohoCallbackReason,
  zohoConsent,
  zohoDigest,
  zohoFailure,
  zohoOAuthConfig,
  zohoOAuthProvider,
  ZOHO_DATA_CENTERS,
} from "./zoho-oauth-provider";
import { zohoOAuthService } from "./zoho-oauth-service";
import type { ZohoStore, ZohoRow } from "./zoho-oauth-store";

const env = {
  ZOHO_CLIENT_ID: "1000.synthetic",
  ZOHO_CLIENT_SECRET: "synthetic-secret",
  ZOHO_REDIRECT_URI: "https://api.example.test/api/zoho-recruit/callback",
  ZOHO_SETTINGS_URL: "https://app.example.test/settings/ats",
  SESSION_SECRET: "synthetic",
  ZOHO_DATA_CENTER: "in",
};
const config = zohoOAuthConfig(env)!;
const ZOHO_API = config.region.api;
const actor = { id: "synthetic-admin", tenantId: "synthetic-employer" };
function fixture(cfg = config) {
  let row: ZohoRow | undefined;
  let active = true,
    calls = 0,
    saveAllowed = true;
  const store: ZohoStore = {
    async get(a) {
      return a.tenantId === row?.tenantId ? row : undefined;
    },
    async begin(a, flow) {
      if (row?.refreshTokenEnc) return false;
      row = {
        tenantId: a.tenantId,
        userId: a.id,
        ...flow,
        accountRef: null,
        companyName: null,
        refreshTokenEnc: null,
        approvedAt: null,
        updatedAt: new Date(),
      };
      return true;
    },
    async consume(a, input) {
      if (
        !row ||
        row.userId !== a.id ||
        row.tenantId !== a.tenantId ||
        row.fingerprint !== input.fingerprint ||
        row.flowHash !== input.stateHash ||
        row.browserHash !== input.browserHash ||
        !row.flowExpiresAt ||
        row.flowExpiresAt <= input.now
      )
        return undefined;
      row = { ...row, flowHash: null, browserHash: null, flowExpiresAt: null };
      return { ...row };
    },
    async save(a, revision, grant) {
      if (!row || row.tenantId !== a.tenantId || row.revision !== revision || !saveAllowed)
        return false;
      row = { ...row, ...grant };
      return true;
    },
    async approve(a, revision, now) {
      if (
        !row ||
        row.userId !== a.id ||
        row.tenantId !== a.tenantId ||
        row.revision !== revision ||
        row.approvedAt
      )
        return false;
      row = { ...row, approvedAt: now };
      return true;
    },
    async disconnect(a, revision, next) {
      if (!row || row.tenantId !== a.tenantId || row.revision !== revision) return false;
      row = {
        ...row,
        revision: next,
        refreshTokenEnc: null,
        approvedAt: null,
        accountRef: null,
        companyName: null,
        flowHash: null,
        browserHash: null,
        flowExpiresAt: null,
      };
      return true;
    },
  };
  const service = zohoOAuthService(
    store,
    cfg,
    async () => {
      if (!active) throw new Error("synthetic suspended admin");
      return actor;
    },
    () => ({
      async authorize() {
        calls++;
        return {
          refreshToken: "synthetic-refresh",
          accountRef: "synthetic-ref",
          companyName: "Synthetic Company",
        };
      },
    }),
    () => "sealed-not-plaintext",
  );
  return {
    service,
    region: cfg.region,
    calls: () => calls,
    row: () => row,
    expire: () => {
      row!.flowExpiresAt = new Date(0);
    },
    suspend: () => {
      active = false;
    },
    preventSave: () => {
      saveAllowed = false;
    },
  };
}
async function started(f: ReturnType<typeof fixture>) {
  const receipt = await f.service.begin(actor);
  return {
    state: new URL(receipt.authorizationUrl).searchParams.get("state")!,
    browser: receipt.browser,
    code: "synthetic-code",
    denied: false,
    location: f.region.location,
    accountsServer: f.region.accounts,
  };
}
test("stage write opt-in is browser-bound and composes with note consent", async () => {
  const readOnly = fixture(),
    input = await started(readOnly);
  await assert.rejects(
    readOnly.service.finish(actor, { ...input, browser: input.browser + ".stages" }),
  );
  assert.equal(readOnly.calls(), 0);
  const combined = fixture();
  const begin = await combined.service.begin(actor, true, true, true);
  const url = new URL(begin.authorizationUrl);
  assert.ok(url.searchParams.get("scope")!.includes("ZohoRecruit.modules.candidate.UPDATE"));
  assert.ok(url.searchParams.get("scope")!.includes("ZohoRecruit.modules.notes.CREATE"));
  assert.ok(begin.browser.endsWith(".notes.stages"));
  await combined.service.finish(actor, {
    ...input,
    browser: begin.browser,
    state: url.searchParams.get("state")!,
  });
  assert.equal(combined.calls(), 1);
});
test("note write opt-in is browser-bound and cannot be appended to a read-only callback", async () => {
  const readOnly = fixture(),
    input = await started(readOnly);
  await assert.rejects(
    readOnly.service.finish(actor, { ...input, browser: input.browser + ".notes" }),
  );
  assert.equal(readOnly.calls(), 0);
  const notes = fixture();
  const start = await notes.service.begin(actor, false, true);
  assert.match(start.browser, /^[A-Za-z0-9_-]{43}\.notes$/);
  assert.match(new URL(start.authorizationUrl).searchParams.get("scope")!, /notes.CREATE/);
  await notes.service.finish(actor, {
    ...input,
    state: new URL(start.authorizationUrl).searchParams.get("state")!,
    browser: start.browser,
  });
  assert.equal(notes.calls(), 1);
});
test("config fails closed for missing secrets, insecure URLs and wrong callback", () => {
  assert.ok(config);
  for (const change of [
    { ZOHO_CLIENT_ID: "email@example.test" },
    { ZOHO_CLIENT_SECRET: "" },
    { SESSION_SECRET: "" },
    { ZOHO_REDIRECT_URI: "http://api.example.test/api/zoho-recruit/callback" },
    { ZOHO_REDIRECT_URI: "https://replit.com/connectors/oauth/callback" },
    { ZOHO_SETTINGS_URL: "https://app.example.test/settings/ats?redirect=evil" },
    { ZOHO_DATA_CENTER: "https://evil.example.test" },
  ])
    assert.equal(zohoOAuthConfig({ ...env, ...change }), null);
  assert.notEqual(
    config.fingerprint,
    zohoOAuthConfig({ ...env, ZOHO_CLIENT_SECRET: "rotated" })!.fingerprint,
  );
  assert.notEqual(
    config.fingerprint,
    zohoOAuthConfig({ ...env, ZOHO_DATA_CENTER: "us" })!.fingerprint,
  );
});
test("consent is India-only, read-module-only and never includes client secret", () => {
  const url = new URL(zohoConsent(config, "synthetic-state"));
  assert.equal(url.origin, "https://accounts.zoho.in");
  assert.equal(url.searchParams.get("state"), "synthetic-state");
  assert.equal(url.searchParams.get("client_secret"), null);
  assert.ok(!url.searchParams.get("scope")!.includes("modules.all"));
  assert.ok(!url.toString().includes(env.ZOHO_CLIENT_SECRET));
});
test("US authorization, token exchange and metadata use only the configured US origins", async () => {
  const us = zohoOAuthConfig({ ...env, ZOHO_DATA_CENTER: "us" })!;
  assert.deepEqual(us.region, ZOHO_DATA_CENTERS.us);
  assert.equal(new URL(zohoConsent(us, "synthetic-state")).origin, us.region.accounts);
  const calls: string[] = [];
  const result = await zohoOAuthProvider(us, async (url) => {
    calls.push(String(url));
    return Response.json(
      calls.length === 1
        ? {
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
            api_domain: us.region.api,
            token_type: "Bearer",
            expires_in: 3600,
          }
        : { org: [{ primary_userid: "123456789", company_name: "Synthetic US Company" }] },
    );
  }).authorize("synthetic-code");
  assert.deepEqual(calls, [
    "https://accounts.zoho.com/oauth/v2/token",
    "https://recruit.zoho.com/recruit/v2/org",
  ]);
  assert.equal(result.companyName, "Synthetic US Company");
  const f = fixture(us);
  const view = await f.service.finish(actor, await started(f));
  assert.equal(view.region, "United States");
  assert.equal(view.state, "review_required");
  assert.equal(f.calls(), 1);
});
test("callback region and accounts server must both match before any provider exchange", async () => {
  for (const overrides of [
    { location: "us", accountsServer: "https://accounts.zoho.com" },
    { location: "in", accountsServer: "https://evil.example.test" },
    { location: "in", accountsServer: "https://accounts.zoho.in.evil.example.test" },
    { location: "in", accountsServer: "https://accounts.zoho.in@evil.example.test" },
    { location: "", accountsServer: "" },
    { location: "in", accountsServer: "" },
  ]) {
    const f = fixture();
    const input = { ...(await started(f)), ...overrides };
    await assert.rejects(
      f.service.finish(actor, input),
      (error) => zohoCallbackReason(error) === "zoho_region_mismatch",
    );
    assert.equal(f.calls(), 0);
    await assert.rejects(f.service.finish(actor, input));
    assert.equal(f.calls(), 0);
  }
  const us = zohoOAuthConfig({ ...env, ZOHO_DATA_CENTER: "us" })!;
  let calls = 0;
  await assert.rejects(
    zohoOAuthProvider(us, async () => {
      calls++;
      return Response.json({
        access_token: "a",
        refresh_token: "r",
        api_domain: ZOHO_DATA_CENTERS.in.api,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }).authorize("synthetic-code"),
    (error) => zohoCallbackReason(error) === "zoho_token_or_region_invalid",
  );
  assert.equal(calls, 1);
});
test("token exchange uses fixed regional hosts, POST body and sanitized organization metadata", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const result = await zohoOAuthProvider(config, async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return Response.json(
      calls.length === 1
        ? {
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
            api_domain: ZOHO_API,
            token_type: "Bearer",
            expires_in: 3600,
          }
        : {
            org: [
              {
                primary_userid: "12345678901234567890",
                company_name: "Synthetic Company",
                primary_email: "do-not-expose@example.test",
              },
            ],
          },
    );
  }).authorize("synthetic-code");
  assert.equal(calls[0].url, "https://accounts.zoho.in/oauth/v2/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(
    new URLSearchParams(calls[0].init.body as URLSearchParams).get("client_secret"),
    env.ZOHO_CLIENT_SECRET,
  );
  assert.equal(calls[1].url, "https://recruit.zoho.in/recruit/v2/org");
  assert.deepEqual(Object.keys(result).sort(), ["accountRef", "companyName", "refreshToken"]);
});
test("organization verification uses Recruit's product endpoint, not the token API gateway", async () => {
  for (const dataCenter of ["us", "in"]) {
    const cfg = zohoOAuthConfig({ ...env, ZOHO_DATA_CENTER: dataCenter })!;
    const calls: string[] = [];
    const result = await zohoOAuthProvider(cfg, async (url, init) => {
      calls.push(String(url));
      if (calls.length === 1)
        return Response.json({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          api_domain: cfg.region.api,
          token_type: "Bearer",
          expires_in: 3600,
        });
      // Reproduce the live gateway 404 instead of blessing any requested URL.
      if (String(url).startsWith(cfg.region.api)) return new Response("Not Found", { status: 404 });
      assert.equal(String(url), `${cfg.region.organization}/recruit/v2/org`);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Zoho-oauthtoken synthetic-access",
      );
      return Response.json({
        org: [{ primary_userid: "123456789", company_name: "Synthetic Company" }],
      });
    }).authorize("synthetic-code");
    assert.equal(result.companyName, "Synthetic Company");
    assert.equal(calls.length, 2);
  }
});
test("rejects provider token errors, foreign api domains, missing refresh and malformed org", async () => {
  for (const token of [
    { error: "invalid_client", detail: "private-provider-error" },
    {
      access_token: "a",
      refresh_token: "r",
      api_domain: "https://evil.example.test",
      token_type: "Bearer",
      expires_in: 3600,
    },
    { access_token: "a", api_domain: ZOHO_API, token_type: "Bearer", expires_in: 3600 },
  ]) {
    let calls = 0;
    await assert.rejects(
      zohoOAuthProvider(config, async () => {
        calls++;
        return Response.json(token);
      }).authorize("synthetic"),
      (e) => e instanceof Error && !e.message.includes("private-provider-error"),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(
    zohoOAuthProvider(config, async () =>
      Response.json(
        ++calls === 1
          ? {
              access_token: "a",
              refresh_token: "r",
              api_domain: ZOHO_API,
              token_type: "Bearer",
              expires_in: 3600,
            }
          : { org: [{ primary_userid: 123, company_name: "Synthetic" }] },
      ),
    ).authorize("synthetic"),
  );
});
test("response size and network errors fail without leaking upstream details", async () => {
  await assert.rejects(
    zohoOAuthProvider(config, async () => new Response("x".repeat(128001))).authorize("synthetic"),
  );
  await assert.rejects(
    zohoOAuthProvider(config, async () => {
      throw new Error("private-secret");
    }).authorize("synthetic"),
    (e) => e instanceof Error && !e.message.includes("private-secret"),
  );
});
test("provider failures preserve only allowlisted token and organization reasons", async () => {
  for (const [stage, status, body, expected] of [
    [
      "token",
      200,
      { error: "invalid_client", detail: "private-provider-detail" },
      "zoho_invalid_client",
    ],
    ["token", 400, { error: "invalid_code" }, "zoho_invalid_code"],
    ["token", 400, { error: "invalid_redirect_uri" }, "zoho_invalid_redirect_uri"],
    ["token", 400, { error: "invalid_scope" }, "zoho_invalid_scope"],
    ["token", 503, { error: "private-provider-detail" }, "zoho_token_exchange_failed"],
    ["token", 400, { error: "constructor" }, "zoho_token_exchange_failed"],
    ["org", 401, { code: "OAUTH_SCOPE_MISMATCH" }, "zoho_org_scope_missing"],
    ["org", 403, { code: "NO_PERMISSION" }, "zoho_org_access_denied"],
    ["org", 401, { code: "INVALID_TOKEN" }, "zoho_org_token_rejected"],
    ["org", 500, { code: "private-provider-detail" }, "zoho_org_request_failed"],
  ] as const) {
    let calls = 0;
    const provider = zohoOAuthProvider(config, async () => {
      calls++;
      return Response.json(
        stage === "org" && calls === 1
          ? {
              access_token: "private-access-token",
              refresh_token: "private-refresh-token",
              api_domain: ZOHO_API,
              token_type: "Bearer",
              expires_in: 3600,
            }
          : body,
        { status: stage === "org" && calls === 1 ? 200 : status },
      );
    });
    await assert.rejects(provider.authorize("private-code"), (error) => {
      assert.equal(zohoCallbackReason(error), expected);
      assert.ok(!JSON.stringify(error).includes("private-"));
      return true;
    });
    assert.equal(calls, stage === "org" ? 2 : 1);
  }
});
test("unparseable organization responses retain stage, never the response text", async () => {
  let calls = 0;
  await assert.rejects(
    zohoOAuthProvider(config, async () =>
      ++calls === 1
        ? Response.json({
            access_token: "a",
            refresh_token: "r",
            api_domain: ZOHO_API,
            token_type: "Bearer",
            expires_in: 3600,
          })
        : new Response("<html>private-upstream-page</html>", { status: 502 }),
    ).authorize("synthetic"),
    (error) => zohoCallbackReason(error) === "zoho_org_request_failed",
  );
  assert.equal(zohoCallbackReason(new Error("private-secret")), "zoho_unavailable");
  assert.equal(zohoCallbackReason(zohoFailure("private-code")), "zoho_unavailable");
});
test("callback redirects with a sanitized reason and never echoes query or error details", async () => {
  let error: unknown = zohoFailure("zoho_invalid_client", 409);
  const app = express();
  app.use(
    "/api",
    zohoRecruitAccountRouter({
      actor: async () => actor,
      config: () => config,
      service: () => ({
        ...fixture().service,
        async finish() {
          throw error;
        },
      }),
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/api/zoho-recruit/callback?code=private-code&state=private-state&error_description=private-provider-error`;
    for (const expected of ["zoho_invalid_client", "zoho_unavailable"]) {
      const response = await fetch(url, { redirect: "manual" });
      assert.equal(response.status, 303);
      const location = response.headers.get("location")!;
      const target = new URL(location);
      assert.equal(target.origin, "https://app.example.test");
      assert.equal(target.pathname, "/settings/ats");
      assert.equal(target.searchParams.get("zoho"), "error");
      assert.equal(target.searchParams.get("reason"), expected);
      assert.ok(!location.includes("private-"));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      error = new Error("private-token-or-database-error");
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((failure) => (failure ? reject(failure) : resolve())),
    );
  }
});
test("authorization stays pending employer review; only encrypted grant persisted", async () => {
  const f = fixture(),
    input = await started(f);
  assert.equal(f.row()!.flowHash, zohoDigest(input.state));
  assert.notEqual(f.row()!.browserHash, input.browser);
  const view = await f.service.finish(actor, input);
  assert.equal(view.state, "review_required");
  assert.equal(view.canApprove, true);
  assert.equal(f.row()!.refreshTokenEnc, "sealed-not-plaintext");
  assert.ok(!JSON.stringify(view).includes("refresh"));
  const approved = await f.service.approve(actor, view.revision!);
  assert.equal(approved.state, "connected");
  assert.equal(approved.importsEnabled, true);
  await assert.rejects(f.service.approve(actor, view.revision!));
});
test("callback requires matching browser, tenant, state and unexpired single-use flow", async () => {
  for (const mode of ["browser", "tenant", "state", "expired", "denied"] as const) {
    const f = fixture(),
      input = await started(f);
    if (mode === "browser") input.browser = "a".repeat(43);
    if (mode === "state") input.state = "b".repeat(43);
    if (mode === "expired") f.expire();
    if (mode === "denied") input.denied = true;
    await assert.rejects(
      f.service.finish(mode === "tenant" ? { ...actor, tenantId: "foreign" } : actor, input),
    );
    assert.equal(f.calls(), 0);
  }
  const f = fixture(),
    input = await started(f);
  await f.service.finish(actor, input);
  await assert.rejects(f.service.finish(actor, input));
  assert.equal(f.calls(), 1);
});
test("suspension and concurrent replacement cannot save or activate a grant", async () => {
  const suspended = fixture(),
    input = await started(suspended);
  suspended.suspend();
  await assert.rejects(suspended.service.finish(actor, input));
  assert.equal(suspended.calls(), 0);
  const changed = fixture(),
    changedInput = await started(changed);
  changed.preventSave();
  await assert.rejects(changed.service.finish(actor, changedInput));
  assert.equal(changed.row()!.refreshTokenEnc, null);
});
test("replacement requires explicit disconnect and stale approvals cannot restore grant", async () => {
  const f = fixture(),
    input = await started(f);
  const pending = await f.service.finish(actor, input);
  await assert.rejects(f.service.begin(actor));
  await f.service.disconnect(actor, pending.revision!);
  await assert.rejects(f.service.approve(actor, pending.revision!));
  assert.equal((await f.service.status(actor)).state, "disconnected");
});
