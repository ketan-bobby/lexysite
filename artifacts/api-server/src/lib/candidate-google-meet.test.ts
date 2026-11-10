import assert from "node:assert/strict";
import test from "node:test";
import { operationFixture, actor, config } from "./google-operation.test-fixture";
import { projectCandidateGoogleMeet } from "./candidate-google-meet";
import {
  googleInvitationSnapshot,
  googleCandidateInvitationSnapshot,
} from "./google-invitation-identity";
import { scheduleVersion } from "./coordinator-schedule-version";
import type { GoogleInvitationReview } from "./google-invitation-store";
import type { GoogleInvitationOperation } from "@workspace/db";
import { googleInvitationService } from "./google-interview-invitation";
import {
  readVerifiedCandidateGoogleMeet,
  verifyCandidateGoogleEvent,
} from "./candidate-google-meet-verification";
import { googleInterviewEventChanges } from "./google-interview-event-changes";
import { googleInterviewEventId } from "./google-interview-event";
import { digest } from "./google-staff-config";
import type { CandidateMeetRecord } from "./candidate-google-meet";
type Evidence = GoogleInvitationReview & {
  connection: NonNullable<GoogleInvitationReview["connection"]>;
  attempt: NonNullable<GoogleInvitationReview["attempt"]> & {
    googleSnapshot: NonNullable<
      NonNullable<GoogleInvitationReview["attempt"]>["googleSnapshot"]
    > & { operations: GoogleInvitationOperation[] };
  };
};

function remoteEvent(r: CandidateMeetRecord) {
  const a = r.attempt!;
  const s = r.context.schedule;
  return {
    id: googleInterviewEventId(a.transactionId),
    etag: '"synthetic-current"',
    status: "confirmed",
    summary: `Interview: ${r.context.job.title}`.slice(0, 300),
    start: { dateTime: s.scheduledAt.toISOString() },
    end: { dateTime: new Date(s.scheduledAt.getTime() + s.durationMinutes * 60_000).toISOString() },
    organizer: { email: r.connection!.accountEmail!, self: true },
    attendees: [
      { email: r.context.candidate.email },
      ...(r.panel?.recipients
        .filter((p) => p.email !== r.connection!.accountEmail!.trim().toLowerCase())
        .map((p) => ({ email: p.email })) ?? []),
    ],
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    visibility: "private",
    extendedProperties: {
      private: {
        lexySchedule: digest(`${s.tenantId}|${s.id}`),
        lexyAttempt: a.transactionId,
        ...(a.googleSnapshot?.operations?.at(-1)
          ? { lexyChange: a.googleSnapshot.operations.at(-1)!.id }
          : {}),
      },
    },
    conferenceData: {
      conferenceSolution: { key: { type: "hangoutsMeet" } },
      entryPoints: [{ entryPointType: "video", uri: a.googleSnapshot!.meetUrl! }],
    },
  };
}

test("candidate Join verifies the original Google event with GET only before initial and rescheduled publication", async () => {
  for (const moved of [false, true]) {
    const { f, self } = await ready(moved);
    const r = { ...f.state, organizer: actor };
    let reads = 0;
    let calls = 0;
    const events = googleInterviewEventChanges(async (url, init) => {
      calls++;
      assert.equal(init?.method, "GET");
      assert.equal(
        String(url),
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${r.attempt!.eventId}`,
      );
      return Response.json(remoteEvent(r));
    });
    const view = await readVerifiedCandidateGoogleMeet(
      {
        read: async () => {
          reads++;
          return structuredClone(r);
        },
        verify: (record) => verifyCandidateGoogleEvent(record, "synthetic-access", events),
        fingerprint: () => config.fingerprint,
      },
      self,
    );
    assert.equal(view?.status, "ready");
    assert.equal(reads, 2);
    assert.equal(calls, 1);
    assert.deepEqual(Object.keys(view!).sort(), [
      "durationMinutes",
      "meetUrl",
      "scheduleId",
      "scheduledAt",
      "status",
    ]);
  }
});

test("external edits, deletion, private-data changes and unverifiable responses cannot publish a stored Meet URL", async () => {
  const { f, self } = await ready();
  const r = { ...f.state, organizer: actor };
  const variants: Array<[string, (e: ReturnType<typeof remoteEvent>) => unknown, number?]> = [
    ["moved start", (e) => ({ ...e, start: { dateTime: "2060-01-05T13:00:00.000Z" } })],
    ["moved end", (e) => ({ ...e, end: { dateTime: "2060-01-05T15:00:00.000Z" } })],
    ["cancelled", (e) => ({ ...e, status: "cancelled" })],
    [
      "new Meet code",
      (e) => ({
        ...e,
        conferenceData: {
          ...e.conferenceData,
          entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" }],
        },
      }),
    ],
    ["missing conference", (e) => ({ ...e, conferenceData: undefined })],
    [
      "extra guest",
      (e) => ({ ...e, attendees: [...e.attendees, { email: "private@example.test" }] }),
    ],
    ["removed guest", (e) => ({ ...e, attendees: [] })],
    [
      "changed organizer",
      (e) => ({ ...e, organizer: { email: "private@example.test", self: true } }),
    ],
    ["changed title", (e) => ({ ...e, summary: "Private calendar detail" })],
    ["missing binding", (e) => ({ ...e, extendedProperties: {} })],
    [
      "wrong change marker",
      (e) => ({
        ...e,
        extendedProperties: {
          private: {
            ...e.extendedProperties.private,
            lexyChange: "unrelated",
          },
        },
      }),
    ],
    ["public event", (e) => ({ ...e, visibility: "public" })],
    ["guest disclosure", (e) => ({ ...e, guestsCanSeeOtherGuests: true })],
    ["incomplete guests", (e) => ({ ...e, attendeesOmitted: true })],
    ["recurring event", (e) => ({ ...e, recurringEventId: "another-event" })],
    ["deleted", () => ({ privateDetail: "never exposed" }), 404],
    ["gone", () => ({}), 410],
    ["revoked", () => ({}), 403],
    ["throttled", () => ({}), 429],
    ["provider error", () => ({}), 503],
    ["malformed", () => ({})],
  ];
  for (const [label, change, status = 200] of variants) {
    const events = googleInterviewEventChanges(async () =>
      Response.json(change(remoteEvent(r)), { status }),
    );
    const view = await readVerifiedCandidateGoogleMeet(
      {
        read: async () => structuredClone(r),
        verify: (record) => verifyCandidateGoogleEvent(record, "synthetic", events),
        fingerprint: () => config.fingerprint,
      },
      self,
    );
    assert.equal(view?.status, "unavailable", label);
    assert.equal(view?.meetUrl, null, label);
    assert.doesNotMatch(JSON.stringify(view), /private@example|Private calendar|never exposed/);
  }
});

test("Google verification fails closed on network failure and rechecks local authority after provider reads", async () => {
  for (const scenario of [
    "network",
    "cancelled",
    "consent",
    "erased",
    "owner",
    "missing",
    "receipt",
    "config",
    "notes",
  ]) {
    const { f, self } = await ready();
    const original = { ...f.state, organizer: actor };
    original.attempt!.googleSnapshot!.candidateSnapshotHash = googleCandidateInvitationSnapshot(
      original,
      actor,
    );
    const current = structuredClone(original);
    let reads = 0;
    let fingerprint = config.fingerprint;
    const view = await readVerifiedCandidateGoogleMeet(
      {
        read: async () => {
          reads++;
          if (reads > 1 && scenario === "missing") return null;
          return structuredClone(reads === 1 ? original : current);
        },
        fingerprint: () => fingerprint,
        verify: async () => {
          if (scenario === "network") throw new Error("private provider details");
          if (scenario === "cancelled") current.context.schedule.status = "cancelled";
          if (scenario === "consent") current.connection!.invitationConsent = false;
          if (scenario === "erased") current.context.candidate.dataErasedAt = new Date();
          if (scenario === "owner") current.context.candidate.userId = "foreign-user";
          if (scenario === "receipt") current.attempt!.googleSnapshot!.snapshotHash = "changed";
          if (scenario === "config") fingerprint = "different";
          if (scenario === "notes") current.context.schedule.notes = "private staff-only notes";
          return true;
        },
      },
      self,
    );
    if (scenario === "notes") assert.equal(view?.status, "ready");
    else assert.equal(view?.meetUrl ?? null, null, scenario);
    assert.doesNotMatch(JSON.stringify(view), /private provider|staff-only notes/);
  }
});

test("Google calls never precede self-ownership, receipt or current consent validation", async () => {
  for (const scenario of ["owner", "consent", "pending", "missing"]) {
    const { f, self } = await ready();
    const r = { ...f.state, organizer: actor };
    if (scenario === "owner") r.context.candidate.userId = "foreign";
    if (scenario === "consent") r.connection!.invitationConsent = false;
    if (scenario === "pending") r.attempt!.status = "needs_review";
    let calls = 0;
    const view = await readVerifiedCandidateGoogleMeet(
      {
        read: async () => (scenario === "missing" ? null : r),
        verify: async () => {
          calls++;
          return true;
        },
        fingerprint: () => config.fingerprint,
      },
      self,
    );
    assert.equal(calls, 0, scenario);
    assert.equal(view?.meetUrl ?? null, null);
  }
});

async function ready(move = true) {
  const f = operationFixture();
  const self = { candidateId: f.state.context.candidate.id, userId: "fixture-portal-user" };
  f.mutate((r) => {
    r.context.candidate.userId = self.userId;
    r.connection!.userId = actor.id;
    r.connection!.tenantId = actor.tenantId!;
    r.connection!.connectedAt = new Date("2060-01-01");
  });
  if (move) await f.service.apply(actor, f.state.context.schedule.id, await f.input());
  else
    f.mutate((r) => {
      r.attempt!.googleSnapshot!.operations = [];
      r.attempt!.scheduleVersion = scheduleVersion(r.context.schedule);
      r.attempt!.googleSnapshot!.snapshotHash = googleInvitationSnapshot(r, actor);
    });
  const read = () =>
    projectCandidateGoogleMeet({ ...f.state, organizer: actor }, self, config.fingerprint);
  return { f, self, read };
}
test("initial accepted Google receipt projects only five public fields", async () => {
  const { read, f } = await ready(false),
    v = read()!;
  assert.equal(v.status, "ready");
  assert.equal(v.meetUrl, f.state.attempt!.googleSnapshot!.meetUrl);
  assert.deepEqual(Object.keys(v).sort(), [
    "durationMinutes",
    "meetUrl",
    "scheduleId",
    "scheduledAt",
    "status",
  ]);
  assert.doesNotMatch(
    JSON.stringify(v),
    /refreshToken|organizer|subjectHash|snapshotHash|approvalHash|fixture-staff/,
  );
});
test("accepted original-event move projects the preserved Meet link", async () => {
  const { read, f } = await ready();
  assert.equal(read()!.status, "ready");
  const previousReads = f.reads;
  assert.equal(f.writes, 1);
  read();
  read();
  assert.equal(f.writes, 1);
  assert.equal(f.reads, previousReads); // projection makes no provider reads either
});
test("canonical candidate and owning portal user must both match", async () => {
  const { f, self } = await ready();
  for (const other of [
    { ...self, userId: "other-user" },
    { ...self, candidateId: "other-candidate" },
  ]) {
    assert.equal(
      projectCandidateGoogleMeet({ ...f.state, organizer: actor }, other, config.fingerprint),
      null,
    );
  }
});
test("native state, time, duration and private-field drift suppress the old receipt", async () => {
  const changes = [
    (r: Evidence) => {
      r.context.schedule.status = "cancelled";
    },
    (r: Evidence) => {
      r.context.schedule.status = "pending";
    },
    (r: Evidence) => {
      r.context.schedule.scheduledAt = new Date("2020-01-01");
    },
    (r: Evidence) => {
      r.context.schedule.scheduledAt = new Date(r.context.schedule.scheduledAt.getTime() + 60_000);
    },
    (r: Evidence) => {
      r.context.schedule.durationMinutes += 5;
    },
    (r: Evidence) => {
      r.context.schedule.feedbackNotes = "private edit";
    },
    (r: Evidence) => {
      r.context.schedule.type = "ai_interview";
    },
    (r: Evidence) => {
      r.context.schedule.panelRevision = "panel";
    },
    (r: Evidence) => {
      r.context.job.status = "draft";
    },
    (r: Evidence) => {
      r.context.candidate.doNotContact = true;
    },
    (r: Evidence) => {
      r.context.candidate.dataErasedAt = new Date();
    },
    (r: Evidence) => {
      r.context.candidate.email = "changed@example.test";
    },
  ];
  for (const change of changes) {
    const { f, read } = await ready();
    f.mutate((r) => change(r as Evidence));
    assert.equal(read()!.status, "unavailable", change.toString());
    assert.equal(read()!.meetUrl, null);
  }
});
test("connection, event identity, recipient, owner and provider mismatches never project a link", async () => {
  const changes = [
    (r: Evidence) => {
      r.connection.needsReconnect = true;
    },
    (r: Evidence) => {
      r.connection.invitationConsent = false;
    },
    (r: Evidence) => {
      r.connection.refreshTokenEnc = null;
    },
    (r: Evidence) => {
      r.connection.subject = "other-subject";
    },
    (r: Evidence) => {
      r.connection.revision = "other-revision";
    },
    (r: Evidence) => {
      r.connection.clientFingerprint = "other-client";
    },
    (r: Evidence) => {
      r.connection.userId = "other-owner";
    },
    (r: Evidence) => {
      r.connection.tenantId = "other-tenant";
    },
    (r: Evidence) => {
      r.attempt.eventId = "other-event";
    },
    (r: Evidence) => {
      r.attempt.recipientHash = "other-recipient";
    },
    (r: Evidence) => {
      r.attempt.organizerId = "other-owner";
    },
    (r: Evidence) => {
      r.attempt.candidateId = "other-candidate";
    },
    (r: Evidence) => {
      r.attempt.applicationId = "other-application";
    },
    (r: Evidence) => {
      r.attempt.scheduleId = "other-schedule";
    },
    (r: Evidence) => {
      r.attempt.provider = "outlook";
    },
    (r: Evidence) => {
      r.attempt.panelSnapshot = {
        approvalToken: "synthetic",
        organizerMailboxHash: "synthetic",
        organizerEmailHash: "synthetic",
        recipients: [],
      };
    },
    (r: Evidence) => {
      r.attempt.status = "attempted";
    },
    (r: Evidence) => {
      r.attempt.acceptedAt = null;
    },
    (r: Evidence) => {
      r.attempt.googleSnapshot.conferenceStatus = "pending";
    },
    (r: Evidence) => {
      r.attempt.googleSnapshot.conferenceStatus = "failed";
    },
  ];
  for (const change of changes) {
    const { f, read } = await ready();
    f.mutate((r) => change(r as Evidence));
    assert.equal(read()!.meetUrl, null);
  }
});
test("missing, inactive or nonstaff organizer and absent setup cannot expose a receipt", async () => {
  const { f, self } = await ready();
  for (const organizer of [
    undefined,
    { ...actor, status: "suspended" as const },
    { ...actor, role: "candidate" as const },
    { ...actor, accountErasedAt: new Date() },
  ]) {
    assert.equal(
      projectCandidateGoogleMeet({ ...f.state, organizer }, self, config.fingerprint)!.meetUrl,
      null,
    );
  }
  assert.equal(
    projectCandidateGoogleMeet({ ...f.state, organizer: actor }, self, undefined)!.meetUrl,
    null,
  );
  f.mutate((r) => {
    r.attempt = undefined;
  });
  assert.equal(
    projectCandidateGoogleMeet({ ...f.state, organizer: actor }, self, config.fingerprint)!.meetUrl,
    null,
  );
});
test("unaccepted intent and any cancellation keep the link hidden even after native restoration", async () => {
  for (const change of [
    (r: Evidence) => {
      r.attempt.googleSnapshot.operations[0].acceptedAt = null;
    },
    (r: Evidence) => {
      r.attempt.googleSnapshot.operations[0].kind = "cancel";
    },
    (r: Evidence) => {
      r.attempt.googleSnapshot.operations[0].targetSnapshotHash = "stale";
    },
    (r: Evidence) => {
      r.attempt.googleSnapshot.operations[0].targetStart = "2061-01-01T00:00:00Z";
    },
    (r: Evidence) => {
      r.attempt.googleSnapshot.operations[0].targetEnd = "2061-01-01T00:00:00Z";
    },
    (r: Evidence) => {
      r.attempt.googleSnapshot.operations[0].nativeVersion = "stale";
    },
  ]) {
    const { f, read } = await ready();
    f.mutate((r) => change(r as Evidence));
    assert.equal(read()!.meetUrl, null);
  }
});
test("malformed or broken operation history cannot resurrect a stale link", async () => {
  for (const operations of [
    null,
    {},
    [null],
    [{}],
    [{ id: "bad", acceptedAt: "bad", kind: "reschedule", priorId: null }],
  ]) {
    const { f, read } = await ready();
    f.mutate((r) => {
      r.attempt!.googleSnapshot!.operations = operations as unknown as GoogleInvitationOperation[];
    });
    assert.equal(read()!.meetUrl, null);
  }
  const { f, read } = await ready();
  f.mutate((r) => {
    r.attempt!.googleSnapshot!.operations!.push({ ...r.attempt!.googleSnapshot!.operations![0] });
  });
  assert.equal(read()!.meetUrl, null);
});
test("unsafe and substituted Meet URLs are rejected without serialization", async () => {
  for (const url of [
    "javascript:alert(1)",
    "http://meet.google.com/abc-defg-hij",
    "https://evil.test/abc-defg-hij",
    "https://meet.google.com.evil.test/abc-defg-hij",
    "https://user@meet.google.com/abc-defg-hij",
    "https://meet.google.com/abc-defg-hij?token=private",
    "https://meet.google.com/abc-defg-hij#private",
    "https://meet.google.com:8443/abc-defg-hij",
    "https://meet.google.com/xyz-abcd-efg",
  ]) {
    const { f, read } = await ready();
    f.mutate((r) => {
      r.attempt!.googleSnapshot!.meetUrl = url;
    });
    assert.equal(read()!.meetUrl, null);
  }
});
test("provider-accepted candidate binding survives staff-only notes and feedback without exposing their digest", async () => {
  const { f, self } = await ready();
  f.mutate((r) => {
    r.attempt!.googleSnapshot!.candidateSnapshotHash = googleCandidateInvitationSnapshot(r, actor);
  });
  const before = projectCandidateGoogleMeet(
    { ...f.state, organizer: actor },
    self,
    config.fingerprint,
  );
  f.mutate((r) => {
    r.context.schedule.notes = "staff-only notes";
    r.context.schedule.feedbackNotes = "staff-only feedback";
    r.context.schedule.feedbackRating = 4;
  });
  assert.deepEqual(
    projectCandidateGoogleMeet({ ...f.state, organizer: actor }, self, config.fingerprint),
    before,
  );
  f.mutate((r) => {
    r.context.schedule.durationMinutes += 5;
  });
  assert.equal(
    projectCandidateGoogleMeet({ ...f.state, organizer: actor }, self, config.fingerprint)!.meetUrl,
    null,
  );
});
test("malformed candidate binding cannot downgrade to an otherwise valid legacy snapshot", async () => {
  const { f, read } = await ready(false);
  f.mutate((r) => {
    r.attempt!.googleSnapshot!.candidateSnapshotHash = "";
  });
  assert.equal(read()!.meetUrl, null);
});
test("staff read may refresh a provider-accepted candidate binding after private feedback edits without resending", async () => {
  const { f } = await ready();
  f.mutate((r) => {
    r.attempt!.googleSnapshot!.candidateSnapshotHash = googleCandidateInvitationSnapshot(r, actor);
    r.context.schedule.feedbackNotes = "private update after acceptance";
  });
  const writes = f.writes;
  const service = googleInvitationService({
    store: f.store,
    config: () => config,
    provider: f.provider,
    events: {
      async read() {
        return f.remote;
      },
      async create() {
        throw new Error("Must never resend.");
      },
      async canMeet() {},
    },
  });
  assert.equal((await service.review(actor, f.state.context.schedule.id)).status, "accepted");
  assert.equal(f.writes, writes);
});
test("joining works before and during the meeting and through a bounded reconnection grace, not indefinitely", async () => {
  const { f, self } = await ready();
  const row = { ...f.state, organizer: actor };
  const start = f.state.context.schedule.scheduledAt.getTime();
  const end = start + f.state.context.schedule.durationMinutes * 60_000;
  for (const now of [start - 60_000, start, start + 5 * 60_000, end, end + 59 * 60_000]) {
    assert.equal(projectCandidateGoogleMeet(row, self, config.fingerprint, now)!.status, "ready");
  }
  assert.equal(
    projectCandidateGoogleMeet(row, self, config.fingerprint, end + 60 * 60_000)!.meetUrl,
    null,
  );
});

async function readyPanel(move = true) {
  const f = operationFixture(false, true);
  const self = { candidateId: f.state.context.candidate.id, userId: "panel-portal-user" };
  f.panel();
  f.mutate((r) => {
    r.context.candidate.userId = self.userId;
    r.connection!.connectedAt = new Date();
  });
  if (move) await f.service.apply(actor, f.state.context.schedule.id, await f.input());
  else
    f.mutate((r) => {
      r.attempt!.googleSnapshot!.snapshotHash = googleInvitationSnapshot(r, actor);
      r.attempt!.googleSnapshot!.candidateSnapshotHash = googleCandidateInvitationSnapshot(
        r,
        actor,
      );
    });
  const read = (now?: number) =>
    projectCandidateGoogleMeet({ ...f.state, organizer: actor }, self, config.fingerprint, now);
  return { f, self, read };
}

test("live Google panel verification requires every original guest, without returning the roster", async () => {
  for (const move of [false, true]) {
    const { f, self } = await readyPanel(move);
    const r = { ...f.state, organizer: actor };
    for (const matching of [true, false]) {
      const events = googleInterviewEventChanges(async () => {
        const e = remoteEvent(r);
        if (!matching) e.attendees = e.attendees.slice(0, 1);
        return Response.json(e);
      });
      const view = await readVerifiedCandidateGoogleMeet(
        {
          read: async () => structuredClone(r),
          verify: (record) => verifyCandidateGoogleEvent(record, "synthetic", events),
          fingerprint: () => config.fingerprint,
        },
        self,
      );
      assert.equal(view?.status, matching ? "ready" : "unavailable");
      assert.doesNotMatch(JSON.stringify(view), /panel@example|recipients|subject|etag/i);
    }
  }
});

test("current accepted panel receipts publish only the candidate's five public appointment fields", async () => {
  for (const move of [false, true]) {
    const { f, self, read } = await readyPanel(move);
    const reads = f.reads,
      writes = f.writes;
    const view = read()!;
    assert.equal(view.status, "ready");
    assert.equal(view.meetUrl, "https://meet.google.com/abc-defg-hij");
    assert.deepEqual(Object.keys(view).sort(), [
      "durationMinutes",
      "meetUrl",
      "scheduleId",
      "scheduledAt",
      "status",
    ]);
    assert.doesNotMatch(
      JSON.stringify(view),
      /panel@example|staff@example|panel-grant|binding|organizer|recipients|subject|refresh|approval/i,
    );
    assert.equal(
      projectCandidateGoogleMeet(
        { ...f.state, organizer: actor },
        { ...self, userId: "foreign-user" },
        config.fingerprint,
      ),
      null,
    );
    const start = f.state.context.schedule.scheduledAt.getTime();
    assert.equal(read(start)!.status, "ready");
    assert.equal(
      read(start + (f.state.context.schedule.durationMinutes + 60) * 60_000)!.meetUrl,
      null,
    );
    assert.equal(f.reads, reads);
    assert.equal(f.writes, writes);
  }
});

test("panel Join never inherits a solo/Outlook receipt or survives changed current panel evidence", async () => {
  const changes: Array<(r: GoogleInvitationReview) => void> = [
    (r) => {
      r.panel = undefined;
    },
    (r) => {
      r.panel!.binding = "changed-account-or-consent";
    },
    (r) => {
      r.panel!.revision = "different-panel";
    },
    (r) => {
      r.context.schedule.panelRevision = null;
    },
    (r) => {
      delete r.attempt!.googleSnapshot!.panelSnapshot;
    },
    (r) => {
      r.attempt!.googleSnapshot!.panelSnapshot!.binding = "foreign";
    },
    (r) => {
      r.attempt!.panelSnapshot = {} as NonNullable<typeof r.attempt>["panelSnapshot"];
    },
    (r) => {
      r.attempt!.provider = "outlook";
    },
    (r) => {
      r.context.schedule.status = "cancelled";
    },
    (r) => {
      r.context.schedule.scheduledAt = new Date(r.context.schedule.scheduledAt.getTime() + 60_000);
    },
    (r) => {
      r.context.candidate.email = "other@example.test";
    },
    (r) => {
      r.connection!.subject = "different-google-account";
    },
  ];
  for (const change of changes) {
    const { f, read } = await readyPanel();
    f.mutate(change);
    assert.equal(read()!.meetUrl, null, change.toString());
  }
});

test("panel Join hides pending/uncertain/cancelled operations and keeps private notes out of its binding", async () => {
  const { f, read } = await readyPanel();
  f.mutate((r) => {
    r.context.schedule.notes = "private coordinator notes";
    r.context.schedule.feedbackNotes = "private panel assessment";
    r.context.schedule.feedbackRating = 4;
  });
  assert.equal(read()!.status, "ready");
  f.mutate((r) => {
    r.attempt!.googleSnapshot!.operations!.at(-1)!.acceptedAt = null;
  });
  assert.equal(read()!.meetUrl, null);
  for (const cancel of [false, true]) {
    const fixture = await readyPanel(false);
    fixture.f.mutate((r) => {
      if (cancel) r.context.schedule.status = "cancelled";
    });
    if (!cancel) fixture.f.lose();
    const input = await fixture.f.input();
    const result = await fixture.f.service.apply(actor, fixture.f.state.context.schedule.id, input);
    assert.equal(result.status, cancel ? "accepted" : "needs_review");
    assert.equal(fixture.read()!.meetUrl, null);
    if (cancel) {
      fixture.f.mutate((r) => {
        r.context.schedule.status = "confirmed";
      });
      assert.equal(fixture.read()!.meetUrl, null);
    }
  }
});
