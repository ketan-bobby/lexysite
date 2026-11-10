import assert from "node:assert/strict";

const clone = (v) => structuredClone(v);
function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

export const REV1 = "rev-one";
export const REV2 = "rev-two";
export const AUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&scope=calendar.readonly";
export const statuses = {
  setup: {
    configured: false,
    state: "setup_required",
    revision: null,
    accountEmail: null,
    connectedAt: null,
    canCheckAvailability: false,
    canSendInvitations: false,
  },
  disconnected: {
    configured: true,
    state: "disconnected",
    revision: "rev-zero",
    accountEmail: null,
    connectedAt: null,
    canCheckAvailability: false,
    canSendInvitations: false,
  },
  pending: {
    configured: true,
    state: "authorization_pending",
    revision: "rev-pending",
    accountEmail: null,
    connectedAt: null,
    canCheckAvailability: false,
    canSendInvitations: false,
  },
  connected: {
    configured: true,
    state: "connected",
    revision: REV1,
    accountEmail: "staff.own@example.invalid",
    connectedAt: "2035-10-01T09:00:00.000Z",
    canCheckAvailability: true,
    canSendInvitations: false,
  },
  reconnect: {
    configured: true,
    state: "reconnect_required",
    revision: "rev-rc",
    accountEmail: "staff.own@example.invalid",
    connectedAt: "2035-10-01T09:00:00.000Z",
    canCheckAvailability: false,
    canSendInvitations: false,
  },
};

/** Scoped fake of the five staff Google endpoints. Receipts are synthetic. */
export function createStaffApi(initial = statuses.connected) {
  const s = {
    status: clone(initial),
    gets: 0,
    connects: [],
    disconnects: [],
    checks: [],
    authUrl: AUTH_URL,
    failNext: {},
    holds: {},
    receipt: null, // (body) => receipt override
    unexpected: [],
  };
  const hold = (kind) => {
    const gate = deferred();
    gate.started = deferred();
    s.holds[kind] = gate;
    return { started: gate.started.promise, release: gate.resolve };
  };
  async function handle(url, request, reply) {
    const p = url.pathname;
    const method = request.method();
    const take = async (kind) => {
      const gate = s.holds[kind];
      delete s.holds[kind];
      if (gate) {
        gate.started.resolve();
        await gate.promise;
      }
      const fail = s.failNext[kind];
      delete s.failNext[kind];
      return fail;
    };
    if (p === "/api/google-calendar/me" && method === "GET") {
      s.gets++;
      return reply(clone(s.status));
    }
    assert.equal(method, "POST", "Unexpected Google staff method");
    const body = JSON.parse(request.postData() ?? "{}");
    if (p === "/api/google-calendar/me/connect") {
      assert.equal(body.confirmOwnCalendar, true);
      assert.equal(typeof body.allowInvitations, "boolean");
      s.connects.push(body);
      const snapshotUrl = s.authUrl;
      const fail = await take("connect");
      if (fail) return reply({ error: "Synthetic connect failure." }, fail);
      return reply({ authorizationUrl: snapshotUrl, expiresAt: "2035-10-01T10:00:00.000Z" });
    }
    if (p === "/api/google-calendar/me/disconnect") {
      assert.deepEqual(Object.keys(body).sort(), ["confirmDisconnect", "revision"]);
      assert.equal(body.confirmDisconnect, true);
      s.disconnects.push(body);
      const fail = await take("disconnect");
      if (fail) return reply({ error: "Synthetic disconnect failure." }, fail);
      assert.equal(body.revision, s.status.revision, "Disconnect must use the current revision");
      s.status = { ...statuses.disconnected, revision: "rev-after-disconnect" };
      return reply(clone(s.status));
    }
    if (p === "/api/google-calendar/me/availability") {
      assert.deepEqual(Object.keys(body).sort(), ["durationMinutes", "revision", "startAt"]);
      assert.match(body.startAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(
        Number.isInteger(body.durationMinutes) &&
          body.durationMinutes >= 15 &&
          body.durationMinutes <= 480,
      );
      s.checks.push(body);
      const fail = await take("check");
      if (fail) return reply({ error: "Synthetic provider failure." }, fail);
      const end = new Date(
        new Date(body.startAt).getTime() + body.durationMinutes * 60000,
      ).toISOString();
      const receipt = {
        revision: body.revision,
        startAt: body.startAt,
        endAt: end,
        checkedAt: "2035-10-01T09:30:00.000Z",
        status: "free",
        reserved: false,
        invitationsEnabled: false,
      };
      return reply(s.receipt ? { ...receipt, ...s.receipt(body, receipt) } : receipt);
    }
    throw new Error("Unexpected Google staff API request");
  }
  return { state: s, handle, hold };
}
