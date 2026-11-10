import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { StaffGoogleCalendar } from "@workspace/db";
import { googleStaffService } from "./google-staff-service";
import { googleStaffConfig } from "./google-staff-config";
import {
  clearedGoogleFlow,
  clearedGoogleGrant,
  type GoogleStaffStore,
  type GoogleStaffActor,
} from "./google-staff-store";
import type { GoogleStaffProvider } from "./google-staff-provider";
import { CalendarError } from "./outlook-calendar-core";
import { encryptSecret } from "./crypto-secrets";

process.env.SESSION_SECRET = "synthetic-google-calendar-unit-secret-only";
const actor = { id: "staff-fixture", tenantId: "employer-fixture" };
const config = googleStaffConfig({
  GOOGLE_CALENDAR_CLIENT_ID: "fixture.apps.googleusercontent.com",
  GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic-client-secret",
  GOOGLE_CALENDAR_REDIRECT_URI: "https://api.example.test/api/google-calendar/callback",
  GOOGLE_CALENDAR_SETTINGS_URL: "https://app.example.test/settings/calendar",
  SESSION_SECRET: "synthetic-session",
})!;
function fixture() {
  let row: StaffGoogleCalendar | undefined,
    active = true,
    allowed = true;
  const instant = new Date("2035-01-01T00:00:00Z");
  let authorizeHook = async () => {},
    refreshHook = async () => {},
    busyHook = async () => {},
    busy = false;
  const calls = { authorize: 0, refresh: 0, busy: 0, allows: 0 };
  const owned = (a: GoogleStaffActor) => row?.userId === a.id && row.tenantId === a.tenantId;
  const store: GoogleStaffStore = {
    async get(a) {
      return owned(a) ? structuredClone(row) : undefined;
    },
    async begin(a, flow) {
      row = {
        userId: a.id,
        tenantId: a.tenantId,
        ...flow,
        ...clearedGoogleGrant,
        needsReconnect: false,
        updatedAt: instant,
      };
    },
    async consume(a, stateHash, browserHash, now) {
      if (
        !owned(a) ||
        row!.flowHash !== stateHash ||
        row!.browserHash !== browserHash ||
        !row!.flowExpiresAt ||
        row!.flowExpiresAt <= now
      )
        return undefined;
      const result = structuredClone(row!);
      row = { ...row!, ...clearedGoogleFlow };
      return result;
    },
    async bind(a, revision, grant) {
      if (!owned(a) || row!.revision !== revision || row!.flowHash) return false;
      row = {
        ...row!,
        ...grant,
        ...clearedGoogleFlow,
        needsReconnect: false,
        revision: randomUUID(),
      };
      return true;
    },
    async clear(a, revision, reconnect = false) {
      if (!owned(a) || row!.revision !== revision) return false;
      row = {
        ...row!,
        ...clearedGoogleGrant,
        ...clearedGoogleFlow,
        needsReconnect: reconnect,
        revision: randomUUID(),
      };
      return true;
    },
    async rotate(a, revision, previous, next) {
      if (!owned(a) || row!.revision !== revision || row!.refreshTokenEnc !== previous)
        return false;
      row!.refreshTokenEnc = next;
      return true;
    },
    async allows() {
      calls.allows++;
      return allowed;
    },
  };
  const provider: GoogleStaffProvider = {
    async authorize() {
      calls.authorize++;
      await authorizeHook();
      return {
        subject: "google-subject-fixture",
        email: "calendar@example.test",
        refreshToken: "synthetic-refresh-token",
      };
    },
    async refresh() {
      calls.refresh++;
      await refreshHook();
      return { accessToken: "synthetic-access-token" };
    },
    async busy() {
      calls.busy++;
      await busyHook();
      return busy;
    },
  };
  const svc = (cfg: typeof config | null = config) =>
    googleStaffService({
      store,
      config: cfg,
      provider: () => provider,
      now: () => instant,
      revalidate: async (a) => {
        if (!active || a.id !== actor.id || a.tenantId !== actor.tenantId)
          throw new CalendarError(403, "staff_changed", "Staff changed.");
      },
    });
  async function begin() {
    const started = await svc().begin(actor);
    return {
      ...started,
      state: new URL(started.receipt.authorizationUrl).searchParams.get("state")!,
    };
  }
  async function connect() {
    const flow = await begin();
    await svc().finish(actor, {
      state: flow.state,
      browser: flow.browser,
      code: "synthetic-code",
      denied: false,
    });
    return (await svc().status(actor)).revision!;
  }
  const input = (revision: string) => ({
    revision,
    startAt: "2035-01-02T10:00:00Z",
    durationMinutes: 30,
  });
  return {
    svc,
    store,
    calls,
    begin,
    connect,
    input,
    getRow: () => row!,
    instant,
    active: (v: boolean) => {
      active = v;
    },
    allowed: (v: boolean) => {
      allowed = v;
    },
    busy: (v: boolean) => {
      busy = v;
    },
    onAuthorize: (fn: () => Promise<void>) => {
      authorizeHook = fn;
    },
    onRefresh: (fn: () => Promise<void>) => {
      refreshHook = fn;
    },
    onBusy: (fn: () => Promise<void>) => {
      busyHook = fn;
    },
  };
}
test("OAuth uses read-only scopes, PKCE/nonce and encrypted actor-bound values; one-time completion", async () => {
  const f = fixture(),
    flow = await f.begin(),
    url = new URL(flow.receipt.authorizationUrl);
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope")!.includes("calendar.events "), false);
  assert.equal(url.searchParams.get("scope")!.includes("calendar.freebusy"), true);
  assert.ok(url.searchParams.get("nonce"));
  assert.equal(f.getRow().verifierEnc!.includes(url.searchParams.get("code_challenge")!), false);
  await f
    .svc()
    .finish(actor, { state: flow.state, browser: flow.browser, code: "code", denied: false });
  const status = await f.svc().status(actor);
  assert.equal(status.state, "connected");
  assert.equal(status.accountEmail, "calendar@example.test");
  assert.equal(JSON.stringify(status).includes("Token"), false);
  assert.equal(f.getRow().refreshTokenEnc!.includes("synthetic-refresh-token"), false);
  await assert.rejects(
    f
      .svc()
      .finish(actor, { state: flow.state, browser: flow.browser, code: "code", denied: false }),
    /could not be verified/,
  );
  assert.equal(f.calls.authorize, 1);
});
test("foreign employer/user, missing browser, wrong state and expired flow never redeem", async () => {
  for (const mode of ["user", "tenant", "browser", "state", "expired"]) {
    const f = fixture(),
      flow = await f.begin(),
      a = { ...actor };
    if (mode === "user") a.id = "foreign";
    if (mode === "tenant") a.tenantId = "foreign";
    if (mode === "expired") f.getRow().flowExpiresAt = new Date("2000-01-01");
    await assert.rejects(
      f.svc().finish(a, {
        state: mode === "state" ? "x".repeat(43) : flow.state,
        browser: mode === "browser" ? "" : flow.browser,
        code: "code",
        denied: false,
      }),
    );
    assert.equal(f.calls.authorize, 0);
  }
});
test("Google denial consumes the flow without token exchange", async () => {
  const f = fixture(),
    flow = await f.begin();
  await assert.rejects(
    f.svc().finish(actor, { state: flow.state, browser: flow.browser, code: "", denied: true }),
  );
  assert.equal(f.getRow().flowHash, null);
  assert.equal(f.calls.authorize, 0);
});
test("disconnect and a newer authorization fence late callback credential writes", async () => {
  for (const mode of ["disconnect", "new-flow", "suspend"]) {
    const f = fixture(),
      flow = await f.begin();
    f.onAuthorize(async () => {
      if (mode === "disconnect") await f.svc().disconnect(actor, f.getRow().revision);
      if (mode === "new-flow") await f.begin();
      if (mode === "suspend") f.active(false);
    });
    await assert.rejects(
      f
        .svc()
        .finish(actor, { state: flow.state, browser: flow.browser, code: "code", denied: false }),
    );
    assert.equal(f.getRow().refreshTokenEnc, null);
  }
});
test("connection replacement clears the old grant; stale disconnect cannot clear newer connection", async () => {
  const f = fixture(),
    old = await f.connect();
  await f.begin();
  assert.equal(f.getRow().refreshTokenEnc, null);
  const fresh = await f.connect();
  assert.notEqual(fresh, old);
  await assert.rejects(f.svc().disconnect(actor, old));
  assert.equal((await f.svc().status(actor)).state, "connected");
});
test("free/busy is self-only, bounded, respects working hours and never reserves", async () => {
  const f = fixture(),
    revision = await f.connect();
  const receipt = await f.svc().availability(actor, f.input(revision));
  assert.equal(receipt.status, "free");
  assert.equal(receipt.reserved, false);
  assert.equal(receipt.invitationsEnabled, false);
  assert.deepEqual(
    Object.keys(receipt).sort(),
    [
      "checkedAt",
      "endAt",
      "invitationsEnabled",
      "reserved",
      "revision",
      "startAt",
      "status",
    ].sort(),
  );
  f.busy(true);
  assert.equal((await f.svc().availability(actor, f.input(revision))).status, "busy");
  f.allowed(false);
  const reads = f.calls.busy,
    refresh = f.calls.refresh;
  assert.equal(
    (await f.svc().availability(actor, f.input(revision))).status,
    "outside_working_hours",
  );
  assert.equal(f.calls.busy, reads);
  assert.equal(f.calls.refresh, refresh);
});
test("invalid, expanded and foreign-revision intervals stop before Google", async () => {
  const f = fixture(),
    revision = await f.connect(),
    input = f.input(revision);
  for (const bad of [
    { ...input, startAt: "yesterday" },
    { ...input, startAt: "2034-01-01T00:00:00Z" },
    { ...input, startAt: "2036-01-01T00:00:00Z" },
    { ...input, durationMinutes: 481 },
    { ...input, durationMinutes: 0 },
    { ...input, calendarId: "foreign" },
    { ...input, userId: "foreign" },
    { ...input, tenantId: "foreign" },
    { ...input, revision: randomUUID() },
  ])
    await assert.rejects(f.svc().availability(actor, bad));
  assert.equal(f.calls.refresh, 0);
  assert.equal(f.calls.busy, 0);
});
test("disconnect during refresh or free/busy discards the late result", async () => {
  for (const mode of ["refresh", "busy"]) {
    const f = fixture(),
      revision = await f.connect();
    const disconnect = async () => {
      await f.svc().disconnect(actor, revision);
    };
    if (mode === "refresh") f.onRefresh(disconnect);
    else f.onBusy(disconnect);
    await assert.rejects(f.svc().availability(actor, f.input(revision)));
    assert.equal(f.getRow().refreshTokenEnc, null);
  }
});
test("revoked Google grant clears local credentials, while transient failure stays unknown", async () => {
  for (const code of ["google_reconnect_required", "google_calendar_unavailable"]) {
    const f = fixture(),
      revision = await f.connect();
    f.onRefresh(async () => {
      throw new CalendarError(code === "google_reconnect_required" ? 409 : 503, code, "Unknown.");
    });
    await assert.rejects(f.svc().availability(actor, f.input(revision)));
    assert.equal(
      (await f.svc().status(actor)).state,
      code === "google_reconnect_required" ? "reconnect_required" : "connected",
    );
    assert.equal(f.calls.busy, 0);
  }
});
test("invitation permission requires an explicit new authorization; read-only and disconnect stay least-privilege", async () => {
  const f = fixture();
  await f.connect();
  assert.equal((await f.svc().status(actor)).canSendInvitations, false);
  const started = await f.svc().begin(actor, true);
  assert.equal(f.getRow().flowInvitations, true);
  assert.equal(f.getRow().invitationConsent, false);
  const state = new URL(started.receipt.authorizationUrl).searchParams.get("state")!;
  await f
    .svc()
    .finish(actor, { state, browser: started.browser, code: "synthetic-code", denied: false });
  assert.equal((await f.svc().status(actor)).canSendInvitations, true);
  await f.svc().disconnect(actor, f.getRow().revision);
  assert.equal(f.getRow().invitationConsent, false);
  assert.equal((await f.svc().status(actor)).canSendInvitations, false);
});
test("ciphertext cannot be moved across owner context or used after client change", async () => {
  for (const changed of [
    { userId: "foreign" },
    { tenantId: "foreign" },
    { kind: "verifier" },
    { purpose: "mail" },
  ]) {
    const f = fixture(),
      revision = await f.connect();
    f.getRow().refreshTokenEnc = encryptSecret(
      JSON.stringify({
        purpose: "google-calendar",
        userId: actor.id,
        tenantId: actor.tenantId,
        kind: "refresh",
        value: "synthetic-refresh",
        ...changed,
      }),
    );
    await assert.rejects(f.svc().availability(actor, f.input(revision)));
    assert.equal(f.calls.refresh, 0);
    assert.equal((await f.svc(null).status(actor)).canCheckAvailability, false);
  }
});
