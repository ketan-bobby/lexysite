import { beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";

// Process-local fake configuration and SDK; no real secrets, DB, or Microsoft calls.
process.env.ENTRA_CLIENT_ID = "fixture-client";
process.env.ENTRA_CLIENT_SECRET = "fixture-secret-not-a-credential";
const identity = "fixture-user.fixture-directory";
const granted = ["Mail.Send", "Mail.Read", "Calendars.ReadWrite"];
function mailbox() {
  return {
    tenantId: "fixture-tenant",
    provider: "microsoft",
    email: "staff@example.invalid",
    homeAccountId: identity,
    scopes: granted.join(" "),
    status: "connected",
    refreshTokenEnc: "fixture-envelope",
  };
}
function fresh() {
  return {
    current: mailbox() as ReturnType<typeof mailbox> | null,
    result: {
      account: { homeAccountId: identity, username: "staff@example.invalid" },
      scopes: [...granted],
      accessToken: "fixture-access",
    },
    cache: {
      RefreshToken: {
        [`${identity}-login-fixture-refresh`]: {
          secret: "fixture-refresh",
          home_account_id: identity,
        },
      },
    } as { RefreshToken: Record<string, { secret: string; home_account_id?: string }> },
    failure: null as Error | null,
    decryptFailure: false,
    stored: [] as Record<string, unknown>[],
    unhealthy: [] as unknown[][],
    authRequests: [] as Record<string, unknown>[],
    refreshRequests: [] as Record<string, unknown>[],
    logs: [] as unknown[],
  };
}
let state = fresh();
mock.module("@azure/msal-node", {
  namedExports: {
    LogLevel: { Error: 0 },
    CryptoProvider: class {
      generatePkceCodes() {
        return { verifier: "fixture-verifier", challenge: "fixture-challenge" };
      }
      createNewGuid() {
        return "fixture-state";
      }
    },
    ConfidentialClientApplication: class {
      getTokenCache() {
        return { serialize: () => JSON.stringify(state.cache) };
      }
      async getAuthCodeUrl(request: Record<string, unknown>) {
        state.authRequests.push(request);
        return "https://example.invalid/consent";
      }
      async acquireTokenByCode(request: Record<string, unknown>) {
        state.authRequests.push(request);
        if (state.failure) throw state.failure;
        return state.result;
      }
      async acquireTokenByRefreshToken(request: Record<string, unknown>) {
        state.refreshRequests.push(request);
        if (state.failure) throw state.failure;
        return state.result;
      }
    },
  },
});
mock.module(new URL("./recruiter-mail.ts", import.meta.url), {
  namedExports: {
    getMailAccount: async () => state.current,
    upsertMailAccountTokens: async (value: Record<string, unknown>) => {
      state.stored.push(value);
    },
    markMailAccountError: async (...args: unknown[]) => {
      state.unhealthy.push(args);
    },
  },
});
mock.module(new URL("./crypto-secrets.ts", import.meta.url), {
  namedExports: {
    encryptSecret: (value: string) => `fixture-sealed:${value}`,
    decryptSecret: () => {
      if (state.decryptFailure) throw new Error("fixture-private-decryption-detail");
      return "fixture-refresh";
    },
  },
});
mock.module(new URL("./logger.ts", import.meta.url), {
  namedExports: {
    logger: Object.fromEntries(
      ["info", "warn", "error"].map((level) => [
        level,
        (...args: unknown[]) => state.logs.push(args),
      ]),
    ),
  },
});
const { buildConsentUrl, redeemCodeAndStore, getAccessTokenForUser } = await import("./graph-auth");
beforeEach(() => {
  state = fresh();
});
const consent = {
  userId: "fixture-user",
  tenantId: "fixture-tenant",
  code: "fixture-code",
  verifier: "fixture-verifier",
  redirectUri: "https://example.invalid/callback",
  calendar: true,
};

test("mail-only consent stays mail-only while calendar consent requests the additional permission", async () => {
  const options = {
    redirectUri: consent.redirectUri,
    challenge: consent.verifier,
    state: "fixture-state",
  };
  await buildConsentUrl(options);
  await buildConsentUrl({ ...options, calendar: true });
  assert.deepEqual(state.authRequests[0].scopes, ["offline_access", "Mail.Send", "Mail.Read"]);
  assert.deepEqual(state.authRequests[1].scopes, [
    "offline_access",
    "Mail.Send",
    "Mail.Read",
    "Calendars.ReadWrite",
  ]);
});
test("verified same-account consent stores actual granted scopes and a sealed refresh token", async () => {
  assert.deepEqual(await redeemCodeAndStore(consent), { ok: true, email: "staff@example.invalid" });
  assert.equal(state.stored[0].scopes, granted.join(" "));
  assert.equal(state.stored[0].refreshTokenEnc, "fixture-sealed:fixture-refresh");
});
test("partial or wrong-resource grants never replace a working email connection", async () => {
  for (const scopes of [
    ["Mail.Read", "Mail.Send"],
    ["Calendars.ReadWrite"],
    ["Mail.Read", "Calendars.ReadWrite"],
    ["Mail.Send", "Mail.Read", "api://other/Calendars.ReadWrite"],
  ]) {
    state = fresh();
    state.result.scopes = scopes;
    assert.equal((await redeemCodeAndStore(consent)).ok, false);
    assert.equal(state.stored.length, 0);
    assert.equal(state.unhealthy.length, 0);
  }
});
test("another Microsoft account cannot replace the mailbox during calendar consent", async () => {
  state.result.account.homeAccountId = "another.identity";
  assert.deepEqual(await redeemCodeAndStore(consent), { ok: false, error: "no_refresh_token" });
  state.cache.RefreshToken = {
    "another.identity-login": {
      secret: "other-fixture-refresh",
      home_account_id: "another.identity",
    },
  };
  assert.deepEqual(await redeemCodeAndStore(consent), {
    ok: false,
    error: "calendar_account_mismatch",
  });
  assert.equal(state.stored.length, 0);
});
test("legacy mailbox identity falls back to its normalized address, not an arbitrary account", async () => {
  Object.assign(state.current!, { homeAccountId: null, email: " STAFF@EXAMPLE.INVALID " });
  assert.equal((await redeemCodeAndStore(consent)).ok, true);
  state.stored = [];
  state.result.account.username = "different@example.invalid";
  assert.deepEqual(await redeemCodeAndStore(consent), {
    ok: false,
    error: "calendar_account_mismatch",
  });
  assert.equal(state.stored.length, 0);
});
test("missing identity and missing refresh token cannot create an incomplete connection", async () => {
  state.result.account.username = "";
  assert.deepEqual(await redeemCodeAndStore(consent), {
    ok: false,
    error: "account_identity_missing",
  });
  state = fresh();
  state.cache.RefreshToken = {};
  assert.deepEqual(await redeemCodeAndStore(consent), { ok: false, error: "no_refresh_token" });
  assert.equal(state.stored.length, 0);
});
test("cache keys with a matching prefix but a foreign home account are rejected", async () => {
  state.cache.RefreshToken = {
    [`${identity}-foreign`]: {
      secret: "foreign-fixture-refresh",
      home_account_id: "another.identity",
    },
  };
  assert.deepEqual(await redeemCodeAndStore(consent), { ok: false, error: "no_refresh_token" });
  assert.equal(state.stored.length, 0);
});
test("calendar refresh asks only for calendar scope and rotates the correct user's token", async () => {
  state.cache.RefreshToken[`${identity}-login-fixture-refresh`].secret = "rotated-fixture-refresh";
  assert.equal(
    await getAccessTokenForUser("fixture-user", ["Calendars.ReadWrite"]),
    "fixture-access",
  );
  assert.deepEqual(state.refreshRequests[0].scopes, ["Calendars.ReadWrite"]);
  assert.equal(state.stored[0].userId, "fixture-user");
  assert.equal(state.stored[0].scopes, granted.join(" "));
});
test("calendar decrypt, missing-token and revoked-grant failures do not poison mail health", async () => {
  for (const mode of ["decrypt", "missing", "revoked"] as const) {
    state = fresh();
    if (mode === "decrypt") state.decryptFailure = true;
    if (mode === "missing") state.result.accessToken = "";
    if (mode === "revoked")
      state.failure = Object.assign(new Error("fixture-private-provider-detail"), {
        errorCode: "invalid_grant",
      });
    assert.equal(await getAccessTokenForUser("fixture-user", ["Calendars.ReadWrite"]), null);
    assert.equal(state.unhealthy.length, 0);
    assert.equal(state.stored.length, 0);
  }
});
test("mail refresh keeps its normal scopes and revoked-grant fallback behavior", async () => {
  state.failure = Object.assign(new Error("fixture-private-provider-detail"), {
    errorCode: "invalid_grant",
  });
  assert.equal(await getAccessTokenForUser("fixture-user"), null);
  assert.deepEqual(state.refreshRequests[0].scopes, ["Mail.Send", "Mail.Read"]);
  assert.deepEqual(state.unhealthy[0], ["fixture-user", "invalid_grant", true]);
});
test("provider exception payloads are neither logged nor saved as mailbox errors", async () => {
  state.failure = new Error("fixture-private-provider-detail");
  assert.equal((await redeemCodeAndStore(consent)).ok, false);
  assert.equal(await getAccessTokenForUser("fixture-user"), null);
  assert.equal(
    JSON.stringify({ logs: state.logs, unhealthy: state.unhealthy }).includes(
      "fixture-private-provider-detail",
    ),
    false,
  );
  assert.equal(state.unhealthy[0][1], "token_request_failed");
});
test("a revoked or absent mailbox never refreshes credentials", async () => {
  state.current!.status = "revoked";
  assert.equal(await getAccessTokenForUser("fixture-user"), null);
  state.current = null;
  assert.equal(await getAccessTokenForUser("fixture-user"), null);
  assert.equal(state.refreshRequests.length, 0);
});
