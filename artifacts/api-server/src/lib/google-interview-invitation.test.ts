import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { googleInvitationService } from "./google-interview-invitation";
import { sealGoogleCredential } from "./google-staff-service";
import { googleStaffFailure } from "./google-staff-config";
import type {
  GoogleInvitationReview,
  GoogleInvitationCaller,
  GoogleInvitationStore,
  GoogleInvitationAttempt,
} from "./google-invitation-store";
process.env.SESSION_SECRET = "synthetic-google-invitation-test-secret-not-a-production-secret";
const caller = {
  id: "staff",
  tenantId: "employer",
  role: "recruiter",
  status: "active",
} as unknown as GoogleInvitationCaller;
const config = {
  clientId: "synthetic.apps.googleusercontent.com",
  clientSecret: "synthetic-client-secret",
  redirectUri: "https://example.test/api/google-calendar/callback",
  settingsUrl: "https://example.test/settings/calendar",
  fingerprint: "synthetic-fingerprint",
};
function fixture() {
  const start = new Date(Date.now() + 86400000),
    revision = randomUUID();
  let state = {
    context: {
      schedule: {
        id: "schedule",
        tenantId: "employer",
        applicationId: "app",
        scheduledAt: start,
        durationMinutes: 30,
        status: "confirmed",
        type: "video",
        interviewerId: "staff",
        panelRevision: null,
      },
      application: { id: "app", candidateId: "candidate", jobId: "job" },
      job: { id: "job", tenantId: "employer", title: "Engineer", status: "approved" },
      candidate: {
        id: "candidate",
        email: "candidate@example.test",
        dataErasedAt: null,
        doNotContact: false,
      },
    },
    connection: {
      userId: "staff",
      tenantId: "employer",
      revision,
      clientFingerprint: config.fingerprint,
      subject: "google-subject",
      accountEmail: "staff@example.test",
      refreshTokenEnc: sealGoogleCredential(
        { id: caller.id, tenantId: caller.tenantId ?? "" },
        "refresh",
        "synthetic-refresh",
      ),
      needsReconnect: false,
      invitationConsent: true,
    },
    attempt: undefined,
    hoursAllowed: true,
  } as unknown as GoogleInvitationReview;
  let queue = Promise.resolve();
  let calls = 0,
    reads = 0,
    busy = false,
    unsupported = false,
    lost = false,
    readLost = false,
    clock = Date.now();
  let configure: typeof config | null = config;
  let denyRecovery = false;
  let afterClaim: ((r: GoogleInvitationReview) => void) | undefined;
  const store: GoogleInvitationStore = {
    async reconnect(_caller, revision) {
      if (state.connection?.revision === revision) {
        state.connection.needsReconnect = true;
        state.connection.refreshTokenEnc = null;
      }
    },
    async read() {
      if (denyRecovery && calls > 0) throw googleStaffFailure("schedule_not_found", 404);
      return structuredClone(state);
    },
    async run(_caller, _old, fn) {
      let release!: () => void;
      const before = queue;
      queue = new Promise((r) => {
        release = r;
      });
      await before;
      const copy = structuredClone(state);
      try {
        const result = await fn(copy, {
          async insert(value) {
            assert.equal(copy.attempt, undefined);
            copy.attempt = {
              ...value,
              acceptedAt: null,
              eventId: null,
              changes: [],
              panelSnapshot: null,
            } as GoogleInvitationAttempt;
            return copy.attempt;
          },
          async save(attempt, receipt) {
            copy.attempt = {
              ...attempt,
              status: "accepted",
              eventId: receipt.id,
              acceptedAt: new Date(clock),
              googleSnapshot: {
                ...attempt.googleSnapshot!,
                meetUrl: receipt.meetUrl,
                conferenceStatus: receipt.conferenceStatus,
              },
            };
          },
          async rotate(_old, next) {
            copy.connection!.refreshTokenEnc = next;
          },
        });
        const claimed = !state.attempt && !!copy.attempt;
        state = copy;
        if (claimed) afterClaim?.(state);
        return result;
      } finally {
        release();
      }
    },
  };
  const svc = () =>
    googleInvitationService({
      store,
      config: () => configure,
      now: () => new Date(clock),
      provider: () => ({
        async authorize() {
          throw Error("unused");
        },
        async refresh() {
          return { accessToken: "synthetic-access" };
        },
        async busy() {
          return busy;
        },
      }),
      events: {
        async canMeet() {
          if (unsupported) throw googleStaffFailure();
        },
        async create() {
          calls++;
          if (lost) throw Error("lost response");
          return { id: "synthetic-event", meetUrl: null, conferenceStatus: "pending" };
        },
        async read() {
          reads++;
          if (readLost) throw Error("lost read");
          return {
            id: "synthetic-event",
            meetUrl: "https://meet.google.com/abc-defg-hij",
            conferenceStatus: "ready",
          };
        },
      },
    });
  return {
    svc,
    get state() {
      return state;
    },
    calls: () => calls,
    reads: () => reads,
    setBusy() {
      busy = true;
    },
    setUnsupported() {
      unsupported = true;
    },
    lose() {
      lost = true;
    },
    loseRead() {
      readLost = true;
    },
    denyRecovery() {
      denyRecovery = true;
    },
    afterClaim(fn: (r: GoogleInvitationReview) => void) {
      afterClaim = fn;
    },
    elapse(n: number) {
      clock += n;
    },
    unconfigure() {
      configure = null;
    },
    async input() {
      const r = await svc().review(caller, "schedule");
      assert.equal(r.status, "ready");
      return {
        confirm: true,
        expectedVersion: r.version,
        expectedApprovalToken: r.approvalToken,
        reviewExpiresAt: r.reviewExpiresAt!.toISOString(),
      };
    },
  };
}
test("Google panel review includes every recipient and persists its approved binding before provider send", async () => {
  const f = fixture();
  f.state.context.schedule.panelRevision = "panel-revision";
  f.state.panel = {
    revision: "panel-revision",
    binding: "current-panel-bindings",
    recipients: [
      {
        userId: "panel-staff",
        email: "panel@example.test",
        subjectHash: "subject",
        connectionRevision: randomUUID(),
        grantedAt: new Date().toISOString(),
      },
    ],
  };
  const review = await f.svc().review(caller, "schedule");
  assert.equal(review.status, "ready");
  assert.deepEqual(review.panelRecipientEmails, ["panel@example.test"]);
  const result = await f.svc().send(caller, "schedule", await f.input());
  assert.equal(result.status, "accepted");
  assert.equal(f.calls(), 1);
  assert.deepEqual(f.state.attempt!.googleSnapshot!.panelSnapshot, {
    revision: "panel-revision",
    binding: "current-panel-bindings",
  });
});
test("changing Google panel bindings invalidates approval and never upgrades an old solo invitation", async () => {
  const f = fixture();
  f.state.context.schedule.panelRevision = "panel-revision";
  f.state.panel = { revision: "panel-revision", binding: "current", recipients: [] };
  const input = await f.input();
  f.state.panel.binding = "reconnected-account-or-edited-members";
  await assert.rejects(f.svc().send(caller, "schedule", input));
  assert.equal(f.calls(), 0);
  const g = fixture();
  await g.svc().send(caller, "schedule", await g.input());
  g.state.context.schedule.panelRevision = "new-panel";
  g.state.panel = { revision: "new-panel", binding: "new", recipients: [] };
  const status = await g.svc().review(caller, "schedule");
  assert.equal(status.status, "needs_review");
  assert.equal(status.approvalToken, null);
  assert.equal(g.calls(), 1);
});
test("Review performs no provider writes; approval sends once, then Meet recovers only through reads", async () => {
  const f = fixture(),
    input = await f.input();
  assert.equal(f.calls(), 0);
  assert.equal(f.reads(), 0);
  f.elapse(1000);
  const refreshed = await f.svc().review(caller, "schedule");
  assert.notEqual(refreshed.approvalToken, input.expectedApprovalToken);
  // Re-reading may rotate the signed proof without invalidating the original review.
  const result = await f.svc().send(caller, "schedule", input);
  assert.equal(result.status, "accepted");
  assert.equal(result.conferenceStatus, "pending");
  assert.equal(result.meetUrl, null);
  assert.equal(result.deliveryConfirmed, false);
  assert.equal(f.state.attempt?.status, "accepted");
  assert.equal(f.calls(), 1);
  await assert.rejects(f.svc().send(caller, "schedule", input));
  assert.equal(f.calls(), 1);
  const read = await f.svc().review(caller, "schedule");
  assert.equal(read.meetUrl, "https://meet.google.com/abc-defg-hij");
  assert.equal(f.calls(), 1);
  assert.equal(f.reads(), 1);
});
test("Ambiguous sends retain committed intent and reject every retry, including another staff user", async () => {
  const f = fixture(),
    input = await f.input();
  f.lose();
  const result = await f.svc().send(caller, "schedule", input);
  assert.equal(result.status, "needs_review");
  assert.equal(f.state.attempt?.status, "attempted");
  await assert.rejects(f.svc().send(caller, "schedule", input));
  await assert.rejects(f.svc().send({ ...caller, id: "other" }, "schedule", input));
  assert.equal(f.calls(), 1);
  assert.equal((await f.svc().review(caller, "schedule")).status, "accepted");
  assert.equal(f.calls(), 1);
});
test("Simultaneous approvals converge on one durable claim and one provider mutation", async () => {
  const f = fixture(),
    input = await f.input();
  const results = await Promise.allSettled([
    f.svc().send(caller, "schedule", input),
    f.svc().send(caller, "schedule", input),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.calls(), 1);
});
test("Approval binds email, title, interval, native revision, Google identity and connection revision", async () => {
  const changes = [
    (r: GoogleInvitationReview) => {
      r.context.candidate.email = "changed@example.test";
    },
    (r: GoogleInvitationReview) => {
      r.context.job.title = "Another title";
    },
    (r: GoogleInvitationReview) => {
      r.context.schedule.durationMinutes = 45;
    },
    (r: GoogleInvitationReview) => {
      r.context.schedule.scheduledAt = new Date(Date.now() + 172800000);
    },
    (r: GoogleInvitationReview) => {
      r.connection!.revision = randomUUID();
    },
    (r: GoogleInvitationReview) => {
      r.connection!.subject = "another-google-account";
    },
    (r: GoogleInvitationReview) => {
      r.connection!.accountEmail = "other@example.test";
    },
  ];
  for (const mutate of changes) {
    const f = fixture(),
      input = await f.input();
    mutate(f.state);
    await assert.rejects(f.svc().send(caller, "schedule", input));
    assert.equal(f.calls(), 0);
    assert.equal(f.state.attempt, undefined);
  }
});
test("Expired/tampered/non-explicit approval cannot create an intent or call Google", async () => {
  for (const patch of [
    { confirm: false },
    { confirm: "true" },
    { confirm: true, extra: "foreign" },
    { expectedApprovalToken: `gi_${"0".repeat(64)}` },
    { reviewExpiresAt: new Date(Date.now() + 3600000).toISOString() },
  ]) {
    const f = fixture(),
      input = await f.input();
    await assert.rejects(f.svc().send(caller, "schedule", { ...input, ...patch }));
    assert.equal(f.calls(), 0);
  }
  const f = fixture(),
    input = await f.input();
  f.elapse(601000);
  await assert.rejects(f.svc().send(caller, "schedule", input));
  assert.equal(f.calls(), 0);
});
test("Permission, privacy, job approval, saved panels and busy/unsupported calendars fail before intent", async () => {
  for (const mutate of [
    (r: GoogleInvitationReview) => {
      r.connection!.invitationConsent = false;
    },
    (r: GoogleInvitationReview) => {
      r.connection!.needsReconnect = true;
    },
    (r: GoogleInvitationReview) => {
      r.context.candidate.doNotContact = true;
    },
    (r: GoogleInvitationReview) => {
      r.context.candidate.dataErasedAt = new Date();
    },
    (r: GoogleInvitationReview) => {
      r.context.job.status = "draft";
    },
    (r: GoogleInvitationReview) => {
      r.context.schedule.panelRevision = "panel";
    },
    (r: GoogleInvitationReview) => {
      r.context.schedule.status = "pending";
    },
    (r: GoogleInvitationReview) => {
      r.hoursAllowed = false;
    },
  ]) {
    const f = fixture(),
      input = await f.input();
    mutate(f.state);
    await assert.rejects(f.svc().send(caller, "schedule", input));
    assert.equal(f.calls(), 0);
    assert.equal(f.state.attempt, undefined);
  }
  for (const change of ["setBusy", "setUnsupported", "unconfigure"] as const) {
    const f = fixture(),
      input = await f.input();
    f[change]();
    await assert.rejects(f.svc().send(caller, "schedule", input));
    assert.equal(f.state.attempt, undefined);
  }
});
test("Outlook intent blocks Google, and changed/revoked evidence blocks read reconciliation", async () => {
  const f = fixture(),
    input = await f.input();
  await f.svc().send(caller, "schedule", input);
  f.state.attempt!.provider = "outlook";
  assert.equal((await f.svc().review(caller, "schedule")).status, "blocked_other_provider");
  await assert.rejects(f.svc().send(caller, "schedule", input));
  assert.equal(f.calls(), 1);
  assert.equal(f.reads(), 0);
  f.state.attempt!.provider = "google";
  f.state.connection!.revision = randomUUID();
  assert.equal((await f.svc().review(caller, "schedule")).status, "needs_review");
  assert.equal(f.reads(), 0);
});
test("Read uncertainty never restores acceptance or permits another write", async () => {
  const f = fixture(),
    input = await f.input();
  await f.svc().send(caller, "schedule", input);
  f.loseRead();
  const r = await f.svc().review(caller, "schedule");
  assert.equal(r.status, "needs_review");
  assert.equal(r.meetUrl, null);
  await assert.rejects(f.svc().send(caller, "schedule", input));
  assert.equal(f.calls(), 1);
});
test("Privacy/ownership failure during uncertain recovery never returns cached private details", async () => {
  const f = fixture(),
    input = await f.input();
  f.lose();
  f.denyRecovery();
  await assert.rejects(
    f.svc().send(caller, "schedule", input),
    (error) => error instanceof Error && "status" in error && error.status === 404,
  );
  assert.equal(f.calls(), 1);
  assert.equal(f.state.attempt?.status, "attempted");
});
test("Consent, connection and privacy changes after the durable claim stop the external write", async () => {
  for (const change of [
    (r: GoogleInvitationReview) => {
      r.connection!.revision = randomUUID();
    },
    (r: GoogleInvitationReview) => {
      r.connection!.invitationConsent = false;
    },
    (r: GoogleInvitationReview) => {
      r.context.candidate.doNotContact = true;
    },
  ]) {
    const f = fixture(),
      input = await f.input();
    f.afterClaim(change);
    const response = await f.svc().send(caller, "schedule", input);
    assert.equal(response.status, "needs_review");
    assert.equal(f.calls(), 0);
    assert.equal(f.state.attempt?.status, "attempted");
  }
});
