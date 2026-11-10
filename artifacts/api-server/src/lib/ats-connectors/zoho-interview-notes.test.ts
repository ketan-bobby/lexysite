import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { zohoInterviewNotes, notePublishInput } from "./zoho-interview-notes";
import { zohoConsent, ZOHO_DATA_CENTERS, type ZohoOAuthConfig } from "./zoho-oauth-provider";
import type { NoteReceipt } from "./zoho-interview-note-store";

function fixture() {
  const actor = { id: "staff", tenantId: "employer" };
  const context = {
    tenantId: actor.tenantId,
    campaignId: randomUUID(),
    recipientId: randomUUID(),
    candidateId: randomUUID(),
    accountRef: "account",
    connectionRevision: randomUUID(),
    externalCandidateId: "123",
    externalJobId: "456",
    applicationId: "789",
    invitation: { state: "sent", accepted: true, at: "2026-11-05T01:00:00.000Z" },
    sessionId: randomUUID(),
    sessionStatus: "completed",
    startedAt: "2026-11-05T02:00:00.000Z",
    completedAt: "2026-11-05T02:10:00.000Z",
  };
  const assessment = {
    campaignId: context.campaignId,
    recipientId: context.recipientId,
    revision: "a".repeat(64),
    reviewable: true,
    decisionStale: false,
    answersTruncated: false,
    sessionStatus: "completed",
    completedAt: context.completedAt,
    history: [
      {
        evidenceCurrent: true,
        decision: "advance",
        createdAt: context.completedAt,
        reason: "Reviewed the job-specific evidence.",
      },
    ],
    assessment: {
      score: 0,
      summary: "Demonstrated relevant experience.",
      recommendation: "Review",
      strengths: ["Reasoning"],
      developmentAreas: ["Practice"],
      concerns: [],
    },
    // These must never be serialized, even though a detail reader can return them.
    answers: [{ answer: "PRIVATE RAW ANSWER" }],
    privateCoaching: "PRIVATE COACHING",
    recordingUrl: "PRIVATE RECORDING",
  };
  let grantRevision = context.connectionRevision;
  let calls = 0,
    allowed = true,
    fail = false,
    failReceipt = false,
    denyRead = false;
  const history: NoteReceipt[] = [];
  type Deps = NonNullable<Parameters<typeof zohoInterviewNotes>[0]>;
  const deps = {
    reviews: {
      async noteContext() {
        if (denyRead) throw new Error("not found");
        return structuredClone(context);
      },
      async detail() {
        return structuredClone(assessment);
      },
    },
    provider: {
      async publicationRevision() {
        return grantRevision;
      },
      async permitted() {
        return allowed;
      },
      async connect() {
        if (!allowed) throw new Error("consent required");
        return {
          guard: async () => {},
          create: async () => {
            calls++;
            if (fail) throw new Error("untrusted remote text");
            return "999";
          },
        };
      },
    },
    store: {
      async receipts() {
        return structuredClone(history);
      },
      async claim(_a: unknown, _c: unknown, revision: string) {
        const previous = history.find((r) => r.revision === revision);
        if (previous) return { receipt: previous, acquired: false };
        if (history.some((r) => r.state === "review_required")) throw new Error("unresolved");
        const receipt: NoteReceipt = {
          id: randomUUID(),
          revision,
          state: "review_required",
          providerNoteId: null,
          at: new Date().toISOString(),
        };
        history.push(receipt);
        return { receipt, acquired: true };
      },
      async fence(_a: unknown, _c: unknown, work: () => Promise<NoteReceipt>) {
        return work();
      },
      async delivered(_a: unknown, _c: unknown, receipt: NoteReceipt, id: string) {
        if (failReceipt) throw new Error("database unavailable");
        const next = { ...receipt, state: "published" as const, providerNoteId: id };
        history[history.findIndex((r) => r.id === receipt.id)] = next;
        return next;
      },
    },
    staffLink: () => "https://fixture.invalid/interviews/staff-only",
  } as unknown as Deps;
  const service = zohoInterviewNotes(deps);
  const preview = (includeAssessment = false) =>
    service.preview(actor, context.campaignId, context.recipientId, { includeAssessment });
  const publish = async (includeAssessment = false, revision?: string) => {
    const v = await preview(includeAssessment);
    return service.publish(actor, context.campaignId, context.recipientId, {
      includeAssessment,
      expectedRevision: revision ?? v.revision,
      confirm: true,
    });
  };
  return {
    actor,
    context,
    assessment,
    service,
    preview,
    publish,
    history,
    calls: () => calls,
    renew: () => {
      grantRevision = randomUUID();
    },
    permission: (v: boolean) => {
      allowed = v;
    },
    fail: () => {
      fail = true;
    },
    failReceipt: () => {
      failReceipt = true;
    },
    revoke: () => {
      denyRead = true;
    },
  };
}

test("preview contains only progress, exact ATS references and a staff-only link", async () => {
  const f = fixture(),
    v = await f.preview();
  assert.equal(v.destination, "Candidates");
  assert.match(v.content, /Zoho application: 789/);
  assert.match(v.content, /not a confirmed send time/);
  assert.match(v.content, /sign-in and employer access required/);
  assert.doesNotMatch(v.content, /Demonstrated|PRIVATE|token|\/room/);
  assert.equal(f.calls(), 0);
});
test("assessment is explicit, current-human-review-bound, and preserves zero scores", async () => {
  const f = fixture(),
    v = await f.preview(true);
  assert.match(v.content, /Interview score: 0/);
  assert.match(v.content, /Demonstrated relevant experience/);
  assert.doesNotMatch(v.content, /PRIVATE/);
  f.assessment.decisionStale = true;
  await assert.rejects(f.preview(true), /current human review/);
  assert.equal(f.calls(), 0);
});
test("incomplete and truncated assessment evidence is rejected, progress still works", async () => {
  const f = fixture();
  f.assessment.sessionStatus = "in_progress";
  await assert.rejects(f.preview(true));
  assert.ok(await f.preview());
  f.assessment.sessionStatus = "completed";
  f.assessment.answersTruncated = true;
  await assert.rejects(f.preview(true));
});
test("missing write consent is visible and cannot publish", async () => {
  const f = fixture();
  f.permission(false);
  assert.equal((await f.preview()).canPublish, false);
  await assert.rejects(f.publish(), /consent/);
  assert.equal(f.calls(), 0);
});
test("source revisions and strict affirmative approval prevent stale or injected publication", async () => {
  const f = fixture(),
    before = await f.preview();
  f.context.sessionStatus = "reviewed";
  await assert.rejects(f.publish(false, before.revision), /changed/);
  assert.equal(
    notePublishInput.safeParse({
      includeAssessment: false,
      expectedRevision: before.revision,
      confirm: false,
    }).success,
    false,
  );
  assert.equal(
    notePublishInput.safeParse({
      includeAssessment: false,
      expectedRevision: before.revision,
      confirm: true,
      content: "override",
    }).success,
    false,
  );
  assert.equal(f.calls(), 0);
});
test("duplicate and concurrent approval publishes one note", async () => {
  const f = fixture();
  await Promise.all([f.publish(), f.publish()]);
  assert.equal(f.calls(), 1);
  assert.equal((await f.publish()).state, "published");
  assert.equal((await f.preview()).canPublish, false);
});
test("a new milestone can be published without resending the old snapshot", async () => {
  const f = fixture();
  await f.publish();
  f.context.sessionStatus = "reviewed";
  assert.equal((await f.preview()).canPublish, true);
  await f.publish();
  assert.equal(f.calls(), 2);
});
test("renewed note authorization invalidates approval but never duplicates already-published content", async () => {
  const f = fixture(),
    before = await f.preview();
  f.renew();
  await assert.rejects(f.publish(false, before.revision), /changed/);
  await f.publish();
  f.renew();
  assert.equal((await f.preview()).canPublish, false);
  assert.equal((await f.publish()).state, "published");
  assert.equal(f.calls(), 1);
});
test("provider ambiguity remains unresolved across retries and changed snapshots", async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.publish(), /No automatic retry/);
  assert.equal((await f.publish()).state, "review_required");
  f.context.sessionStatus = "reviewed";
  assert.equal((await f.preview()).canPublish, false);
  await assert.rejects(f.publish());
  assert.equal(f.calls(), 1);
});
test("local receipt failure after provider acceptance never causes a second note", async () => {
  const f = fixture();
  f.failReceipt();
  await assert.rejects(f.publish(), /No automatic retry/);
  assert.equal((await f.publish()).state, "review_required");
  assert.equal(f.calls(), 1);
});
test("privacy or authority failure suppresses preview and new writes", async () => {
  const f = fixture();
  f.revoke();
  await assert.rejects(f.preview());
  await assert.rejects(f.publish());
  assert.equal(f.calls(), 0);
});
test("read-only OAuth default is unchanged; note creation scope is opt-in only", () => {
  const cfg = {
    clientId: "synthetic",
    redirectUri: "https://fixture.invalid/api/zoho-recruit/callback",
    region: ZOHO_DATA_CENTERS.us,
  } as ZohoOAuthConfig;
  const normal = new URL(zohoConsent(cfg, "state"));
  const notes = new URL(zohoConsent(cfg, "state", false, true));
  assert.doesNotMatch(normal.searchParams.get("scope")!, /notes|UPDATE|CREATE/);
  assert.match(notes.searchParams.get("scope")!, /ZohoRecruit.modules.notes.CREATE/);
  assert.doesNotMatch(notes.searchParams.get("scope")!, /stage|UPDATE/);
});
