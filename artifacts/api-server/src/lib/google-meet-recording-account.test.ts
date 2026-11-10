import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { StaffGoogleMeetRecording as Row } from "@workspace/db";
import {
  googleMeetRecordingAccount,
  openMeetCredential,
  sealMeetCredential,
} from "./google-meet-recording-account";
import {
  googleMeetRecordingConfig,
  meetAccountFailure,
  type MeetRecordingOAuthProvider,
} from "./google-meet-recording-oauth";
import { googleStaffConfig } from "./google-staff-config";
import {
  clearedMeetFlow,
  clearedMeetGrant,
  type MeetRecordingStore,
} from "./google-meet-recording-store";
import type { GoogleStaffActor as Actor } from "./google-staff-store";
import { sealGoogleCredential } from "./google-staff-service";

process.env.SESSION_SECRET = "synthetic-meet-recording-unit-only";
const actor = { id: "synthetic-staff", tenantId: "synthetic-employer" };
const config = googleMeetRecordingConfig(
  googleStaffConfig({
    GOOGLE_CALENDAR_CLIENT_ID: "fixture.apps.googleusercontent.com",
    GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic-only",
    GOOGLE_CALENDAR_REDIRECT_URI: "https://api.example.test/api/google-calendar/callback",
    GOOGLE_CALENDAR_SETTINGS_URL: "https://app.example.test/settings/calendar",
    SESSION_SECRET: "synthetic-only",
  }),
)!;
function fixture() {
  let row: Row | undefined,
    active = true;
  let instant = new Date("2035-01-01T00:00:00Z");
  let authorizeHook = async () => {},
    refreshHook = async () => {};
  let refreshError: Error | undefined;
  const calls = { authorize: 0, refresh: 0 };
  const owned = (a: Actor) => row?.userId === a.id && row.tenantId === a.tenantId;
  const store: MeetRecordingStore = {
    async get(a) {
      return owned(a) ? structuredClone(row) : undefined;
    },
    async begin(a, flow) {
      row = {
        userId: a.id,
        tenantId: a.tenantId,
        ...flow,
        ...clearedMeetGrant,
        needsReconnect: false,
        updatedAt: instant,
      };
    },
    async consume(a, state, browser, now) {
      if (
        !owned(a) ||
        row!.flowHash !== state ||
        row!.browserHash !== browser ||
        !row!.flowExpiresAt ||
        row!.flowExpiresAt <= now
      )
        return undefined;
      const value = structuredClone(row);
      Object.assign(row!, clearedMeetFlow);
      return value;
    },
    async bind(a, revision, grant) {
      if (!owned(a) || row!.revision !== revision || row!.flowHash !== null) return false;
      Object.assign(row!, grant, clearedMeetFlow, {
        needsReconnect: false,
        revision: randomUUID(),
      });
      return true;
    },
    async clear(a, revision, reconnect = false) {
      if (!owned(a) || row!.revision !== revision) return false;
      Object.assign(row!, clearedMeetGrant, clearedMeetFlow, {
        needsReconnect: reconnect,
        revision: randomUUID(),
      });
      return true;
    },
    async rotate(a, revision, previous, next) {
      if (!owned(a) || row!.revision !== revision || row!.refreshTokenEnc !== previous)
        return false;
      row!.refreshTokenEnc = next;
      return true;
    },
  };
  const provider: MeetRecordingOAuthProvider = {
    async authorize() {
      calls.authorize++;
      await authorizeHook();
      return {
        subject: "subject-fixture",
        email: "staff@example.test",
        refreshToken: "synthetic-refresh",
      };
    },
    async refresh() {
      calls.refresh++;
      await refreshHook();
      if (refreshError) throw refreshError;
      return { accessToken: "synthetic-access", refreshToken: "synthetic-rotated" };
    },
  };
  const service = googleMeetRecordingAccount({
    store,
    config,
    provider: () => provider,
    now: () => instant,
    revalidate: async (a) => {
      if (!active || a.id !== actor.id || a.tenantId !== actor.tenantId)
        throw meetAccountFailure("staff_required", 403);
    },
  });
  const input = (flow: Awaited<ReturnType<typeof service.begin>>) => ({
    state: new URL(flow.receipt.authorizationUrl).searchParams.get("state")!,
    browser: flow.browser,
    code: "synthetic-code",
    denied: false,
  });
  async function connect() {
    const flow = await service.begin(actor);
    await service.finish(actor, input(flow));
    return (await service.status(actor)).revision!;
  }
  return {
    service,
    store,
    calls,
    input,
    connect,
    row: () => row!,
    suspend: () => {
      active = false;
    },
    advance: () => {
      instant = new Date(instant.getTime() + 11 * 60_000);
    },
    authorizeHook: (fn: () => Promise<void>) => {
      authorizeHook = fn;
    },
    refreshHook: (fn: () => Promise<void>) => {
      refreshHook = fn;
    },
    refreshError: (error: Error) => {
      refreshError = error;
    },
  };
}
test("recording connection is separate PKCE/nonce/browser authorization and stores no cleartext secret", async () => {
  const f = fixture();
  const flow = await f.service.begin(actor);
  const url = new URL(flow.receipt.authorizationUrl);
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://api.example.test/api/google-meet-recordings/callback",
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("include_granted_scopes"), "false");
  assert.ok(!url.searchParams.get("scope")!.includes("calendar."));
  assert.ok(!JSON.stringify(f.row()).includes(flow.browser));
  assert.ok(!JSON.stringify(f.row()).includes(f.input(flow).state));
  assert.ok(!JSON.stringify(f.row()).includes(url.searchParams.get("nonce")!));
  await f.service.finish(actor, f.input(flow));
  const status = await f.service.status(actor);
  assert.equal(status.state, "connected");
  assert.equal(status.accountEmail, "staff@example.test");
  assert.equal(status.canReadRecordings, true);
  assert.ok(!JSON.stringify(status).includes("synthetic-refresh"));
  assert.equal(openMeetCredential(actor, "refresh", f.row().refreshTokenEnc!), "synthetic-refresh");
});
test("wrong browser, state, actor and employer never exchange a token", async () => {
  for (const patch of [
    { browser: "x".repeat(43) },
    { state: "x".repeat(43) },
    { state: "invalid" },
  ]) {
    const f = fixture();
    const flow = await f.service.begin(actor);
    await assert.rejects(f.service.finish(actor, { ...f.input(flow), ...patch }));
    assert.equal(f.calls.authorize, 0);
  }
  for (const other of [
    { ...actor, id: "other" },
    { ...actor, tenantId: "other" },
  ]) {
    const f = fixture();
    const flow = await f.service.begin(actor);
    await assert.rejects(f.service.finish(other, f.input(flow)));
    assert.equal(f.calls.authorize, 0);
    await assert.rejects(f.service.status(other));
  }
});
test("denial, expiry and replay cannot bind a recording grant", async () => {
  const f = fixture();
  const flow = await f.service.begin(actor);
  await assert.rejects(f.service.finish(actor, { ...f.input(flow), denied: true }));
  await assert.rejects(f.service.finish(actor, f.input(flow)));
  assert.equal(f.calls.authorize, 0);
  const g = fixture();
  const expired = await g.service.begin(actor);
  g.advance();
  await assert.rejects(g.service.finish(actor, g.input(expired)));
  assert.equal(g.calls.authorize, 0);
  const h = fixture();
  const once = await h.service.begin(actor);
  await h.service.finish(actor, h.input(once));
  await assert.rejects(h.service.finish(actor, h.input(once)));
  assert.equal(h.calls.authorize, 1);
});
test("concurrent callbacks consume authorization exactly once", async () => {
  const f = fixture();
  const flow = await f.service.begin(actor);
  const results = await Promise.allSettled([
    f.service.finish(actor, f.input(flow)),
    f.service.finish(actor, f.input(flow)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.authorize, 1);
});
test("new flow, disconnect or staff suspension during token exchange cannot resurrect credentials", async () => {
  for (const mutation of ["begin", "disconnect", "suspend"]) {
    const f = fixture();
    const flow = await f.service.begin(actor);
    f.authorizeHook(async () => {
      if (mutation === "begin") await f.service.begin(actor);
      if (mutation === "disconnect") await f.service.disconnect(actor, f.row().revision);
      if (mutation === "suspend") f.suspend();
    });
    await assert.rejects(f.service.finish(actor, f.input(flow)));
    assert.equal(f.row().refreshTokenEnc, null);
  }
});
test("refresh rotation stays actor-bound and stale disconnect revisions fail", async () => {
  const f = fixture();
  const revision = await f.connect();
  assert.equal((await f.service.access(actor, revision)).subject, "subject-fixture");
  assert.equal(openMeetCredential(actor, "refresh", f.row().refreshTokenEnc!), "synthetic-rotated");
  await assert.rejects(f.service.disconnect(actor, randomUUID()));
  assert.equal((await f.service.status(actor)).canReadRecordings, true);
  await f.service.disconnect(actor, revision);
  await assert.rejects(f.service.access(actor, revision));
  assert.equal((await f.service.status(actor)).accountEmail, null);
});
test("revocation during refresh discards access and cannot restore a cleared grant", async () => {
  const f = fixture();
  const revision = await f.connect();
  f.refreshHook(async () => {
    await f.service.disconnect(actor, revision);
  });
  await assert.rejects(f.service.access(actor, revision));
  assert.equal(f.row().refreshTokenEnc, null);
});
test("invalid-grant refresh clears only its current recording grant, ordinary provider failure does not", async () => {
  const f = fixture();
  const revision = await f.connect();
  f.refreshError(meetAccountFailure("meet_recording_reconnect_required", 409));
  await assert.rejects(f.service.access(actor, revision));
  assert.equal((await f.service.status(actor)).state, "reconnect_required");
  assert.equal(f.row().refreshTokenEnc, null);
  const g = fixture();
  const current = await g.connect();
  g.refreshError(meetAccountFailure());
  await assert.rejects(g.service.access(actor, current));
  assert.equal((await g.service.status(actor)).state, "connected");
});
test("credential envelopes cannot cross calendar purpose, staff, employer or token kind", () => {
  const sealed = sealMeetCredential(actor, "refresh", "synthetic-refresh");
  for (const a of [
    { ...actor, id: "other" },
    { ...actor, tenantId: "other" },
  ])
    assert.throws(() => openMeetCredential(a, "refresh", sealed));
  assert.throws(() => openMeetCredential(actor, "verifier", sealed));
  assert.throws(() =>
    openMeetCredential(
      actor,
      "refresh",
      sealGoogleCredential(actor, "refresh", "synthetic-calendar"),
    ),
  );
  assert.throws(() => openMeetCredential(actor, "refresh", "not-ciphertext"));
});
test("setup-required status is explicit and cannot initiate authorization", async () => {
  const f = fixture();
  const service = googleMeetRecordingAccount({
    store: f.store,
    config: null,
    provider: () => {
      throw new Error("must not construct provider");
    },
    revalidate: async () => {},
  });
  assert.equal((await service.status(actor)).state, "setup_required");
  await assert.rejects(service.begin(actor));
});
