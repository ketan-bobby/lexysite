import { randomUUID } from "node:crypto";
import type { GoogleInvitationOperation } from "@workspace/db";
import { googleInvitationOperationService } from "./google-invitation-operation";
import {
  googleCandidateInvitationSnapshot,
  googleInvitationSnapshot,
} from "./google-invitation-identity";
import { googleInterviewEventId } from "./google-interview-event";
import { invitationRecipientHash } from "./outlook-candidate-invitation";
import { digest, googleStaffFailure } from "./google-staff-config";
import { sealGoogleCredential } from "./google-staff-service";
import type {
  GoogleInvitationReview,
  GoogleInvitationCaller,
  GoogleInvitationStore,
} from "./google-invitation-store";

export const actor = {
  id: "fixture-staff",
  tenantId: "fixture-employer",
  role: "recruiter",
  status: "active",
} as GoogleInvitationCaller;
export const config = {
  clientId: "synthetic.apps.googleusercontent.com",
  clientSecret: "synthetic-only",
  redirectUri: "https://example.test/api/google-calendar/callback",
  settingsUrl: "https://example.test/settings/calendar",
  fingerprint: "synthetic-client",
};
// Default keeps legacy full-content receipts for candidate-projection regressions.
// Current storage also publishes the separate candidate-visible booking binding.
export function operationFixture(cancel = false, withCandidateBinding = false) {
  process.env.SESSION_SECRET = "synthetic-google-operation-test-key-not-production";
  let clock = Date.now(),
    queue = Promise.resolve();
  const old = new Date(clock + 86400000),
    next = new Date(old.getTime() + 3600000),
    transactionId = randomUUID();
  let state = {
    context: {
      schedule: {
        id: "fixture-schedule",
        tenantId: actor.tenantId,
        applicationId: "fixture-app",
        scheduledAt: next,
        durationMinutes: 30,
        status: cancel ? "cancelled" : "confirmed",
        type: "video",
        interviewerId: actor.id,
        panelRevision: null,
      },
      application: { id: "fixture-app", jobId: "fixture-job", candidateId: "fixture-candidate" },
      job: { id: "fixture-job", tenantId: actor.tenantId, status: "approved", title: "Engineer" },
      candidate: {
        id: "fixture-candidate",
        email: "candidate@example.test",
        doNotContact: false,
        dataErasedAt: null,
      },
    },
    connection: {
      userId: actor.id,
      tenantId: actor.tenantId,
      revision: randomUUID(),
      subject: "fixture-google-subject",
      accountEmail: "staff@example.test",
      clientFingerprint: config.fingerprint,
      invitationConsent: true,
      needsReconnect: false,
      refreshTokenEnc: sealGoogleCredential(
        { id: actor.id, tenantId: actor.tenantId! },
        "refresh",
        "fixture-refresh",
      ),
    },
    hoursAllowed: true,
    attempt: {
      scheduleId: "fixture-schedule",
      applicationId: "fixture-app",
      candidateId: "fixture-candidate",
      organizerId: actor.id,
      recipientHash: invitationRecipientHash("candidate@example.test"),
      transactionId,
      provider: "google",
      status: "accepted",
      eventId: googleInterviewEventId(transactionId),
      acceptedAt: new Date(clock - 1000),
      changes: [],
      googleSnapshot: {
        connectionRevision: "",
        subjectHash: digest("fixture-google-subject"),
        snapshotHash: "",
        meetUrl: "https://meet.google.com/abc-defg-hij",
        conferenceStatus: "ready",
        operations: [],
      },
    },
  } as unknown as GoogleInvitationReview;
  state.attempt!.googleSnapshot!.connectionRevision = state.connection!.revision;
  const initial = structuredClone(state);
  initial.context.schedule.scheduledAt = old;
  initial.context.schedule.status = "confirmed";
  state.attempt!.googleSnapshot!.snapshotHash = googleInvitationSnapshot(initial, actor);
  let remote = {
    id: googleInterviewEventId(transactionId),
    etag: '"source-etag"',
    startAt: old.toISOString(),
    endAt: new Date(old.getTime() + 1800000).toISOString(),
    meetUrl: "https://meet.google.com/abc-defg-hij",
    conferenceStatus: "ready" as const,
    changeId: null as string | null,
  };
  let writes = 0,
    reads = 0,
    checks = 0,
    reconnects = 0,
    busy = false,
    lost = false,
    gone = false,
    saveFails = false,
    denyRecovery = false,
    panelBusy = false,
    panelChecks = 0,
    preparations = 0;
  let afterClaim: ((r: GoogleInvitationReview) => void) | undefined;
  const store: GoogleInvitationStore = {
    async preparePanelAvailability(c, original) {
      preparations++;
      const snapshot = googleInvitationSnapshot(original, c);
      return {
        access(current) {
          if (googleInvitationSnapshot(current, c) !== snapshot) throw googleStaffFailure();
          return "synthetic-access";
        },
        async check() {
          panelChecks++;
          if (panelBusy) throw googleStaffFailure("google_interval_busy", 409);
        },
      };
    },
    async read() {
      if (denyRecovery && writes) throw googleStaffFailure("schedule_not_found", 404);
      return structuredClone(state);
    },
    async reconnect() {
      reconnects++;
      state.connection!.needsReconnect = true;
    },
    async run(c, original, fn) {
      const prior = queue;
      let release!: () => void;
      queue = new Promise<void>((r) => (release = r));
      await prior;
      const copy = structuredClone(state);
      try {
        const before = copy.attempt!.googleSnapshot!.operations!.length;
        const result = await fn(copy, {
          async insert() {
            throw Error("No new send allowed");
          },
          async save(attempt, receipt) {
            if (attempt.transactionId !== copy.attempt!.transactionId)
              throw Error("Changed original");
            copy.attempt!.googleSnapshot!.meetUrl = receipt.meetUrl;
            copy.attempt!.googleSnapshot!.conferenceStatus = receipt.conferenceStatus;
          },
          async rotate(oldToken, nextToken) {
            copy.connection!.refreshTokenEnc = nextToken;
          },
          async appendOperation(op) {
            copy.attempt!.googleSnapshot!.operations!.push(op);
          },
          async finishOperation(id, receipt) {
            if (saveFails) throw Error("Synthetic persistence failure");
            const op = copy.attempt!.googleSnapshot!.operations!.at(-1)!;
            if (op.id !== id || op.acceptedAt) throw googleStaffFailure();
            op.acceptedAt = new Date(clock).toISOString();
            if (withCandidateBinding)
              copy.attempt!.googleSnapshot!.candidateSnapshotHash =
                googleCandidateInvitationSnapshot(copy, c);
            if (receipt) {
              copy.attempt!.googleSnapshot!.meetUrl = receipt.meetUrl;
              copy.attempt!.googleSnapshot!.conferenceStatus = receipt.conferenceStatus;
            }
          },
        });
        state = copy;
        if (before < copy.attempt!.googleSnapshot!.operations!.length) afterClaim?.(state);
        return result;
      } finally {
        release();
      }
    },
  };
  const events = {
    async observe(_token: string, d: { panelEmails?: string[] }) {
      reads++;
      observedPanels.push(d.panelEmails);
      if (gone) throw googleStaffFailure("google_event_unverified", 409);
      return structuredClone(remote);
    },
    async available() {
      checks++;
      if (busy) throw googleStaffFailure("google_interval_busy", 409);
    },
    async reschedule(
      _token: unknown,
      d: { startAt: string; endAt: string },
      _source: unknown,
      id: string,
    ) {
      writes++;
      remote = {
        ...remote,
        etag: '"updated-etag"',
        startAt: d.startAt,
        endAt: d.endAt,
        changeId: id,
      };
      if (lost) throw Error("Lost provider response");
      return structuredClone(remote);
    },
    async cancel() {
      writes++;
      gone = true;
      if (lost) throw Error("Lost delete response");
    },
  };
  const observedPanels: Array<string[] | undefined> = [];
  const provider = (() => ({
    async refresh() {
      return { accessToken: "synthetic-access" };
    },
  })) as unknown as NonNullable<Parameters<typeof googleInvitationOperationService>[0]["provider"]>;
  const service = googleInvitationOperationService({
    store,
    events,
    provider,
    config: () => config,
    now: () => new Date(clock),
  });
  return {
    service,
    store,
    events,
    provider,
    get state() {
      return state;
    },
    get remote() {
      return remote;
    },
    get writes() {
      return writes;
    },
    get reads() {
      return reads;
    },
    get checks() {
      return checks;
    },
    get reconnects() {
      return reconnects;
    },
    observedPanels,
    get panelChecks() {
      return panelChecks;
    },
    get preparations() {
      return preparations;
    },
    panelBusy() {
      panelBusy = true;
    },
    panel() {
      state.context.schedule.panelRevision = "synthetic-panel";
      state.panel = {
        revision: "synthetic-panel",
        binding: digest("synthetic-panel-binding"),
        recipients: [
          {
            userId: actor.id,
            email: "staff@example.test",
            subjectHash: digest("fixture-google-subject"),
            connectionRevision: state.connection!.revision,
            grantedAt: new Date(clock).toISOString(),
          },
          {
            userId: "panel-member",
            email: "panel@example.test",
            subjectHash: digest("panel-subject"),
            connectionRevision: "panel-grant",
            grantedAt: new Date(clock).toISOString(),
          },
        ],
      };
      state.attempt!.googleSnapshot!.panelSnapshot = {
        revision: state.panel.revision,
        binding: state.panel.binding,
      };
    },
    mutate(fn: (r: GoogleInvitationReview) => void) {
      fn(state);
    },
    remoteChange() {
      remote.etag = '"another-etag"';
    },
    busy() {
      busy = true;
    },
    lose() {
      lost = true;
    },
    failSave() {
      saveFails = true;
    },
    restoreSave() {
      saveFails = false;
    },
    denyRecovery() {
      denyRecovery = true;
    },
    afterClaim(fn: (r: GoogleInvitationReview) => void) {
      afterClaim = fn;
    },
    elapse(ms: number) {
      clock += ms;
    },
    wrongMarker() {
      remote.changeId = "not-this-operation";
    },
    async input() {
      const r = await service.review(actor, "fixture-schedule");
      return {
        confirm: true,
        kind: r.kind,
        expectedVersion: r.version,
        expectedApprovalToken: r.approvalToken!,
        reviewExpiresAt: r.reviewExpiresAt!.toISOString(),
      };
    },
    latest: () =>
      state.attempt!.googleSnapshot!.operations!.at(-1) as GoogleInvitationOperation | undefined,
  };
}
