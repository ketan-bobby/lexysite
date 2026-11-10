import assert from "node:assert/strict";
import test from "node:test";
import {
  googlePanelShared,
  googlePanelConsentView,
  searchGooglePanelTimes,
  type GooglePanelDependencies,
  type GooglePanelInput,
  type GooglePanelPerson,
  type GooglePanelSnapshot,
} from "./google-panel-times";
import { operationFixture } from "./google-operation.test-fixture";
import {
  googlePanelBinding,
  assertGooglePanelBindings,
  readSavedPanelMembers,
} from "./saved-panel-members";

const now = Date.parse("2035-01-01T08:00:00Z");
const input: GooglePanelInput = {
  expectedVersion: "native-version",
  userIds: ["a", "b"],
  start: "2035-01-01T10:00:00Z",
  end: "2035-01-01T12:00:00Z",
  bufferMinutes: 15,
};
function person(id: string): GooglePanelPerson {
  const connection = operationFixture().state.connection;
  assert.ok(connection);
  return {
    member: {
      id,
      tenantId: "employer",
      name: "Reviewer",
      role: "interviewer",
      status: "active",
      accountErasedAt: null,
    },
    connection: {
      ...connection,
      userId: id,
      tenantId: "employer",
      clientFingerprint: "fp",
      connectedAt: new Date(now),
      needsReconnect: false,
      subject: `private-${id}`,
      refreshTokenEnc: "private-cipher",
      accountEmail: `${id}@example.test`,
    },
    consent: {
      userId: id,
      tenantId: "employer",
      connectionRevision: connection.revision,
      grantedAt: new Date(now),
    },
  };
}
function fixture() {
  const first: GooglePanelSnapshot = {
    scheduleId: "schedule",
    version: input.expectedVersion,
    durationMinutes: 30,
    people: ["a", "b"].map(person),
    allows: () => true,
  };
  const current = { ...first, people: structuredClone(first.people) };
  const calls = { snapshot: 0, refresh: 0, read: 0, range: [] as string[] };
  const deps: GooglePanelDependencies = {
    fingerprint: "fp",
    now: () => now,
    snapshot: async () => {
      calls.snapshot++;
      return first;
    },
    refresh: async (p) => {
      calls.refresh++;
      return p.member.id;
    },
    locked: (work) => work(current),
    read: async (_token, a, b) => {
      calls.read++;
      calls.range = [a, b];
      return [];
    },
  };
  return { first, current, calls, deps };
}
test("Google common times serialize only public suggestions and pad the provider range", async () => {
  const f = fixture();
  const result = await searchGooglePanelTimes(input, f.deps);
  assert.equal(result.panelSize, 2);
  assert.equal(result.slots.length, 7);
  assert.equal(result.calendarReserved, false);
  assert.equal(result.invitationSent, false);
  assert.deepEqual(f.calls.range, ["2035-01-01T09:45:00.000Z", "2035-01-01T12:15:00.000Z"]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /private|cipher|example.test|subject|accountEmail|userIds/,
  );
});
test("Google busy intervals, buffers and all-person hours intersect", async () => {
  const f = fixture();
  f.deps.read = async (token) =>
    token === "a"
      ? [
          {
            showAs: "busy",
            start: { dateTime: "2035-01-01T10:00:00Z", timeZone: "UTC" },
            end: { dateTime: "2035-01-01T10:30:00Z", timeZone: "UTC" },
          },
        ]
      : [];
  f.current.allows = (a, b) =>
    a >= Date.parse("2035-01-01T11:00:00Z") && b <= Date.parse(input.end);
  const result = await searchGooglePanelTimes(input, f.deps);
  assert.equal(result.slots[0].start, "2035-01-01T11:00:00.000Z");
  assert.ok(result.slots.every((s) => Date.parse(s.start) >= Date.parse("2035-01-01T11:00:00Z")));
});
test("invalid panel/window inputs touch neither snapshots nor providers", async () => {
  for (const bad of [
    { userIds: [] },
    { userIds: ["a", "a"] },
    { userIds: ["a", "b", "c", "d", "e", "f"] },
    { start: "not-a-time" },
    { start: "2034-01-01T10:00:00Z" },
    { end: "2036-01-01T12:00:00Z" },
    { end: "2035-01-03T12:00:00Z" },
    { bufferMinutes: -1 },
  ]) {
    const f = fixture();
    await assert.rejects(searchGooglePanelTimes({ ...input, ...bad }, f.deps));
    assert.deepEqual([f.calls.snapshot, f.calls.refresh, f.calls.read], [0, 0, 0]);
  }
});
test("a stale native version or partial selection stops before refresh", async () => {
  for (const mutate of [
    (s: GooglePanelSnapshot) => {
      s.version = "changed";
    },
    (s: GooglePanelSnapshot) => {
      s.people.pop();
    },
    (s: GooglePanelSnapshot) => {
      s.people[1] = s.people[0];
    },
  ]) {
    const f = fixture();
    mutate(f.first);
    await assert.rejects(searchGooglePanelTimes(input, f.deps));
    assert.equal(f.calls.refresh, 0);
    assert.equal(f.calls.read, 0);
  }
});
test("every member must have explicit current Google sharing, not just invitation consent", async () => {
  const mutations: Array<(p: GooglePanelPerson) => void> = [
    (p) => {
      p.member.role = "candidate";
    },
    (p) => {
      p.member.status = "suspended";
    },
    (p) => {
      p.member.accountErasedAt = new Date(now);
    },
    (p) => {
      p.member.tenantId = "other";
    },
    (p) => {
      p.connection.userId = "other";
    },
    (p) => {
      p.connection.tenantId = "other";
    },
    (p) => {
      p.connection.subject = null;
    },
    (p) => {
      p.connection.connectedAt = null;
    },
    (p) => {
      p.connection.refreshTokenEnc = null;
    },
    (p) => {
      p.connection.needsReconnect = true;
    },
    (p) => {
      p.connection.clientFingerprint = "old";
    },
    (p) => {
      p.consent.connectionRevision = "old";
      p.connection.invitationConsent = true;
    },
    (p) => {
      p.consent.userId = "other";
    },
    (p) => {
      p.consent.tenantId = "other";
    },
    (p) => {
      p.consent.grantedAt = new Date("invalid");
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f.first.people[0]);
    assert.equal(googlePanelShared(f.first.people[0], "fp"), false);
    await assert.rejects(searchGooglePanelTimes(input, f.deps));
    assert.equal(f.calls.refresh, 0);
    assert.equal(f.calls.read, 0);
  }
});
test("revalidation after token refresh rejects revocation, reconnect, role and appointment changes", async () => {
  for (const mutate of [
    (s: GooglePanelSnapshot) => {
      s.people[0].consent.connectionRevision = "revoked";
    },
    (s: GooglePanelSnapshot) => {
      s.people[0].consent.grantedAt = new Date(now + 1);
    },
    (s: GooglePanelSnapshot) => {
      s.people[0].connection.subject = "replaced";
    },
    (s: GooglePanelSnapshot) => {
      s.people[0].member.role = "candidate";
    },
    (s: GooglePanelSnapshot) => {
      s.version = "changed";
    },
    (s: GooglePanelSnapshot) => {
      s.durationMinutes = 45;
    },
    (s: GooglePanelSnapshot) => {
      s.scheduleId = "other";
    },
  ]) {
    const f = fixture();
    mutate(f.current);
    await assert.rejects(searchGooglePanelTimes(input, f.deps));
    assert.equal(f.calls.refresh, 2);
    assert.equal(f.calls.read, 0);
  }
});
test("one failed calendar or refresh never yields partial-panel free times", async () => {
  for (const phase of ["refresh", "read"] as const) {
    const f = fixture();
    if (phase === "refresh")
      f.deps.refresh = async () => {
        throw new Error("private credential");
      };
    else
      f.deps.read = async (token) => {
        if (token === "b") throw new Error("private calendar");
        return [];
      };
    await assert.rejects(
      searchGooglePanelTimes(input, f.deps),
      (e) => e instanceof Error && e.message.includes("unknown") && !e.message.includes("private"),
    );
  }
});
test("unknown or absent working hours never imply unrestricted availability", async () => {
  const f = fixture();
  f.current.allows = () => false;
  assert.deepEqual((await searchGooglePanelTimes(input, f.deps)).slots, []);
});
test("own consent exposes real revision without sharing and supports unhealthy withdrawal", () => {
  const p = person("a");
  assert.deepEqual(googlePanelConsentView(p.member, p.connection, undefined, "fp"), {
    enabled: false,
    canEnable: true,
    revision: p.connection.revision,
    grantedAt: null,
  });
  assert.deepEqual(googlePanelConsentView(p.member, undefined, undefined, "fp"), {
    enabled: false,
    canEnable: false,
    revision: null,
    grantedAt: null,
  });
  p.connection.needsReconnect = true;
  const v = googlePanelConsentView(p.member, p.connection, p.consent, null);
  assert.equal(v.enabled, true);
  assert.equal(v.canEnable, false);
  assert.equal(v.revision, p.connection.revision);
  assert.equal(googlePanelShared(p, "fp"), false);
});

test("saved Google bindings are private, provider-specific and reject changed consent or identity", () => {
  const p = person("a");
  const binding = googlePanelBinding(p);
  assertGooglePanelBindings([binding], [p]);
  assert.doesNotMatch(JSON.stringify(binding), /private-|mailboxHash|cipher|@example/);
  for (const change of [
    { connectionRevision: "22222222-2222-4222-8222-222222222222" },
    { subjectHash: "0".repeat(64) },
    { grantedAt: "2035-01-02T00:00:00.000Z" },
    { userId: "other" },
  ])
    assert.throws(() => assertGooglePanelBindings([{ ...binding, ...change }], [p]));
  const legacy = { userId: "b", mailboxHash: "a".repeat(64), grantedAt: binding.grantedAt };
  assert.deepEqual(readSavedPanelMembers([legacy]), [legacy]);
  assert.throws(() => readSavedPanelMembers([binding, legacy]));
  assert.throws(() => readSavedPanelMembers([binding, binding]));
  assert.throws(() => readSavedPanelMembers([{ ...binding, subject: "private" }]));
});

test("confirmation can recheck an already-offered imminent time without relaxing discovery notice", async () => {
  const imminent = {
    ...input,
    start: "2035-01-01T08:05:00Z",
    end: "2035-01-01T08:35:00Z",
  };
  const discovery = fixture();
  assert.equal((await searchGooglePanelTimes(imminent, discovery.deps)).slots.length, 0);
  const confirmation = fixture();
  confirmation.deps.minimumNoticeMinutes = 0;
  assert.equal((await searchGooglePanelTimes(imminent, confirmation.deps)).slots.length, 1);
});
