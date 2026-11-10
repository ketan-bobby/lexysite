import { before, after, test, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { eq, inArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  recruiterAdminClientsTable,
  jobRecruitersTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
  resumeScreensTable,
  verificationRecordsTable,
  outreachMessagesTable,
  sourcedCandidatesTable,
  interviewPlansTable,
  interviewSessionsTable,
  interviewSummariesTable,
  auditLogsTable,
  userNotificationsTable,
  employerAtsBindingsTable as atsBindings,
  atsRefreshSchedulesTable as atsSchedules,
  atsRefreshRunsTable as atsScheduledRuns,
  atsImportedApplicationsTable as atsImports,
  atsMappingVerificationsTable as atsChecks,
  atsCandidateProfilesTable as atsProfiles,
} from "@workspace/db";
import type { RuntimeEvidence } from "../lib/workflow-runtime-evidence";
import router from "./recruiting-workflows";
import { createControlledOffersRouter } from "./controlled-offers";
import { checkAtsCampaignHttp } from "./ats-campaign-http-checks";
import { checkInvitationEvidenceHttp } from "./ats-invitation-evidence-http-checks";
import { recordInvitationProviderEvent } from "../lib/interview-provider-events";
import type { InvitationProviderEvent } from "../lib/interview-provider-policy";
import offerInboxRouter from "./offer-inbox";
import type {
  ControlledOfferState,
  OfferRoutingState,
  OfferInboxPage,
  OfferInboxItem,
  AtsVerificationState,
  AtsHandoffState,
  AtsScheduleState,
  AtsStageOwnershipState,
} from "@workspace/api-zod";
import { hasControlledOffer } from "../lib/controlled-offers";
import {
  offerEmailTags,
  parseOfferProviderEvent,
  recordOfferProviderEvent,
} from "../lib/offer-provider-events";
import { syncOfferNotifications } from "../lib/offer-notifications";
import { issueToken } from "../lib/auth-token";
import { orchestrator } from "../lib/agents/orchestrator";
import type { WorkflowShadowView } from "@workspace/api-zod";
import { journeySteps, fingerprint } from "../lib/recruiting-workflows";
import { runAtsRefreshTick } from "../lib/ats-refresh-scheduler";
import { changeCandidateStage } from "../lib/change-candidate-stage";
import { AtsStageOwnershipConflict } from "../lib/ats-stage-owner";
import { purgeCandidateLinkedData } from "../lib/candidate-erasure";

const prefix = `workflow_${randomUUID()}`;
const offerEmails: string[] = [];
const greenhouseInvitations: { text: string; singleAttempt: boolean }[] = [];
let greenhouseDeliveryMode: "success" | "simulated" | "uncertain" = "success";
const greenhouseNotes: {
  candidate_id: number;
  application_id: number;
  body: string;
  visibility: string;
}[] = [];
let greenhouseNotesEnabled = true;
const atsCampaignPeople = new Map<number, { applicationId: number; email: string }>();
let greenhouseRecoveryEvidence: unknown = [];
let greenhouseRecoveryFailure = false;
let greenhouseRecoveryDuringRead: (() => Promise<void>) | null = null;
const greenhouseRecoveryReads: string[] = [];
let greenhouseNoteFailure = false;
const atsReadPaths: string[] = [];
const atsPagePaths: string[] = [];
let atsPreviewMode: "success" | "mismatch" | "failure" | "revoke" = "success";
let atsReadMode:
  | "success"
  | "failure"
  | "mismatch"
  | "revoke"
  | "changed"
  | "missing"
  | "reidentify" = "success";
const atsConnectionId = `ats-fixture-${prefix}`;
let atsReadHook: (() => Promise<void>) | undefined;
let atsProfileIdentity = 202;
const atsGateway = {
  canPublishNotes: () => greenhouseNotesEnabled,
  canReadNotes: () => greenhouseNotesEnabled,
  async readNote(_id: string, noteId: string) {
    greenhouseRecoveryReads.push(noteId);
    if (greenhouseRecoveryFailure) throw new Error("PRIVATE note lookup failure");
    if (greenhouseRecoveryDuringRead) await greenhouseRecoveryDuringRead();
    return greenhouseRecoveryEvidence;
  },
  async publishNote(_id: string, input: (typeof greenhouseNotes)[number]) {
    greenhouseNotes.push(input);
    if (greenhouseNoteFailure) throw new Error("PRIVATE ambiguous note response");
    return String(9000 + greenhouseNotes.length);
  },
  async connections() {
    return [{ id: atsConnectionId }];
  },
  async read(_connectionId: string, path: string): Promise<unknown> {
    atsReadPaths.push(path);
    const hook = atsReadHook;
    atsReadHook = undefined;
    await hook?.();
    if (atsReadMode === "failure") throw new Error("PRIVATE provider token and payload");
    if (atsReadMode === "revoke") {
      await dbAdmin
        .update(atsBindings)
        .set({ status: "disconnected", revision: 99 })
        .where(eq(atsBindings.tenantId, tenant));
    }
    if (path.includes("/jobs?"))
      return [
        { id: 101, name: "Fixture job", status: "open", confidential: false, notes: "PRIVATE" },
      ];
    if (path.includes("/candidates?"))
      return [
        {
          id: atsCampaignPeople.has(Number(path.split("ids=")[1]))
            ? Number(path.split("ids=")[1])
            : atsProfileIdentity,
          first_name: "ATS",
          last_name: "Fixture",
          email_addresses: [
            {
              value:
                atsCampaignPeople.get(Number(path.split("ids=")[1]))?.email ??
                `ats-profile-${prefix}@example.invalid`,
            },
          ],
          private: false,
          can_email: true,
          title: "ATS title",
          company: "ATS company",
          custom_fields: { sensitive: "PRIVATE" },
        },
      ];
    if (atsReadMode === "missing") return [];
    const campaignPerson = [...atsCampaignPeople].find(
      ([, value]) => value.applicationId === Number(path.split("ids=")[1]),
    );
    if (campaignPerson)
      return [
        {
          id: campaignPerson[1].applicationId,
          job_id: 101,
          candidate_id: campaignPerson[0],
          prospect: false,
          status: "in_process",
          stage_name: "Screen",
        },
      ];
    return [
      {
        id: path.endsWith("ids=304") ? 304 : 303,
        job_id: atsReadMode === "mismatch" ? 999 : 101,
        candidate_id: atsReadMode === "reidentify" ? 909 : atsProfileIdentity,
        prospect: false,
        status: atsReadMode === "changed" ? "rejected" : "in_process",
        stage_name: atsReadMode === "changed" ? null : "Screen",
        answers: ["PRIVATE"],
      },
    ];
  },
  async page(_connectionId: string, path: string) {
    atsPagePaths.push(path);
    if (atsPreviewMode === "failure") throw new Error("PRIVATE provider failure");
    if (atsPreviewMode === "revoke") {
      await dbAdmin
        .update(atsBindings)
        .set({ status: "disconnected", revision: 98 })
        .where(eq(atsBindings.tenantId, tenant));
    }
    return {
      records: path.includes("cursor=")
        ? []
        : [
            {
              id: 303,
              candidate_id: 202,
              job_id: atsPreviewMode === "mismatch" ? 404 : 101,
              prospect: false,
              status: "in_process",
              stage_name: "Screen",
              answers: ["PRIVATE"],
            },
          ],
      nextCursor: path.includes("cursor=") ? null : "provider-next",
    };
  },
};
let offerDeliveryMode: "success" | "simulated" | "uncertain" = "success";
const agency = `${prefix}_agency`,
  tenant = `${prefix}_client`,
  foreign = `${prefix}_foreign`;
const candidateId = `${prefix}_candidate`,
  unlinked = `${prefix}_unlinked`;
const roles = {
  admin: "tenant_admin",
  agencyAdmin: "tenant_admin",
  employerApprover: "tenant_admin",
  platform: "platform_admin",
  manager: "recruiter_admin",
  unmanaged: "recruiter_admin",
  recruiter: "recruiter",
  joined: "recruiter",
  peer: "recruiter",
  hm: "hiring_manager",
  hmPeer: "hiring_manager",
  interviewer: "interviewer",
  candidate: "candidate",
  foreign: "tenant_admin",
} as const;
type Actor = keyof typeof roles;
type ResponseBody = WorkflowShadowView & {
  id: string;
  briefHash: string;
  replayed: boolean;
  autonomyExecutionEnabled: boolean;
  canEdit: boolean;
  canApprove: boolean;
  journeys: (typeof journeys.$inferSelect & { stale: boolean })[];
  workflows: (typeof workflows.$inferSelect & {
    stale: boolean;
    runtimeEvidence: RuntimeEvidence[];
  })[];
  candidates: { id: string; name: string }[];
  events: (typeof events.$inferSelect)[];
};
const actorId = (a: Actor) => `${prefix}_${a}`;
let base: string, server: Server, mainJob: string;
let beforeEffects: unknown;
const agent = mock.method(orchestrator, "triggerAgent", async () => {
  throw Error("Phase 2 cannot execute agents");
});

async function request(
  method: string,
  path: string,
  body?: unknown,
  actor: Actor | null = "admin",
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: base,
      ...(actor
        ? {
            Authorization: `Bearer ${issueToken({
              userId: actorId(actor),
              tenantId: actor === "foreign" ? foreign : agency,
              role: roles[actor],
            })}`,
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as ResponseBody };
}
const get = (jobId: string, actor: Actor | null = "admin") =>
  request("GET", `/jobs/${jobId}/workflow-state`, undefined, actor);
const post = (jobId: string, suffix: string, body: unknown, actor: Actor | null = "admin") =>
  request("POST", `/jobs/${jobId}/${suffix}`, body, actor);

test("controlled offers bind approval to version, send once and record recipient response without employment", async (t) => {
  const offerCandidate = `${prefix}_offer_candidate`;
  const offerJobs: string[] = [];
  await dbAdmin.insert(candidatesTable).values({
    id: offerCandidate,
    tenantId: tenant,
    firstName: "Controlled",
    lastName: "Offer fixture",
    email: `${prefix}_offer@example.invalid`,
    pool: "tenant",
    verificationResult: { syntheticFixture: { kind: "controlled_inbox" } },
  });
  async function fixture() {
    const jobId = await newJob();
    offerJobs.push(jobId);
    await dbAdmin
      .insert(applicationsTable)
      .values({ tenantId: tenant, candidateId: offerCandidate, jobId, stage: "applied" });
    const state = await get(jobId);
    const journeyId = randomUUID(),
      workflowId = randomUUID();
    const steps = journeySteps("human").map((step) => ({
      ...step,
      status: "completed" as const,
      evidence: "Isolated fixture only.",
      ...(step.key === "hiring_decision"
        ? {
            humanDecision: {
              outcome: "hire" as const,
              actorId: actorId("admin"),
              actorName: "Fixture approver",
              decidedAt: new Date().toISOString(),
              reason: "Workflow-only fixture; not a real assessment.",
              testOnly: true,
            },
            offerRouting: {
              mode: "native" as const,
              ownerUserId: actorId("admin"),
              approverUserId: actorId("admin"),
              senderUserId: actorId("admin"),
              externalSystem: null,
              externalApplicationUrl: null,
              configuredBy: actorId("admin"),
              configuredAt: new Date().toISOString(),
            },
          }
        : {}),
    }));
    await dbAdmin.insert(journeys).values({
      id: journeyId,
      tenantId: tenant,
      jobId,
      version: 1,
      status: "approved",
      briefHash: state.body.briefHash,
      brief: {},
      interviewPath: "human",
      steps,
      createdById: actorId("admin"),
      approvedById: actorId("admin"),
      approvedAt: new Date(),
    });
    await dbAdmin.insert(workflows).values({
      id: workflowId,
      tenantId: tenant,
      jobId,
      candidateId: offerCandidate,
      journeyId,
      journeyVersion: 1,
      status: "completed",
      interviewPath: "human",
      steps,
      createdById: actorId("admin"),
    });
    const path = `/jobs/${jobId}/candidate-workflows/${workflowId}/offer`;
    async function read(actor: Actor | null = "admin") {
      const r = await request("GET", path, undefined, actor);
      return { ...r, body: r.body as unknown as ControlledOfferState };
    }
    async function act(
      action: string,
      extra: Record<string, unknown> = {},
      actor: Actor | null = "admin",
    ) {
      const state = await read();
      return request(
        "POST",
        path,
        {
          action,
          expectedRevision: state.body.workflowRevision,
          idempotencyKey: randomUUID(),
          ...extra,
        },
        actor,
      );
    }
    return { jobId, workflowId, path, read, act };
  }
  const terms = {
    employerName: "Fixture employer",
    roleTitle: "Fixture engineer",
    amount: 100000,
    currency: "USD",
    frequency: "annual",
    location: "Remote",
    startDate: "2027-01-15",
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    letter: "Approved fixture terms only. This is not a real employment offer.",
  };
  await t.test(
    "verified provider evidence requires human reconciliation and prevents no-effect retry",
    async () => {
      const f = await fixture();
      await f.act("save_draft", { terms });
      await f.act("submit_review");
      await f.act("approve");
      offerDeliveryMode = "uncertain";
      try {
        assert.equal((await f.act("send")).status, 503);
        const saved = (await f.read()).body.offer!;
        const attempts = offerEmails.length;
        const tags = offerEmailTags("offer.delivery", {
          workflowId: f.workflowId,
          offerId: saved.id,
          version: saved.version,
          deliveryAttemptId: saved.deliveryAttemptId,
        })!;
        const providerEvent = parseOfferProviderEvent({
          eventType: "Delivery",
          mail: {
            messageId: "verified-fixture-provider-receipt",
            timestamp: new Date().toISOString(),
            destination: [saved.recipientEmail],
            tags: Object.fromEntries(tags.map((tag) => [tag.Name, [tag.Value]])),
          },
          delivery: { timestamp: new Date().toISOString(), recipients: [saved.recipientEmail] },
        })!;
        assert.equal((await recordOfferProviderEvent(providerEvent)).updated, true);
        assert.equal(
          (await f.read()).body.offer?.status,
          "send_uncertain",
          "webhook cannot activate the letter",
        );
        assert.equal(
          (
            await f.act("reconcile_delivery", {
              deliveryAttemptId: saved.deliveryAttemptId,
              deliveryResolution: "confirmed_not_sent",
              acknowledgeNoDelivery: true,
              reason: "Fictional no-effect attestation must be refused.",
              evidenceReference: "Fictional reference conflicts with verified provider evidence.",
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await f.act("reconcile_delivery", {
              deliveryAttemptId: saved.deliveryAttemptId,
              deliveryResolution: "check_provider",
            })
          ).status,
          200,
        );
        const reconciled = (await f.read()).body.offer!;
        assert.equal(reconciled.status, "sent");
        assert.equal(reconciled.deliveryReceiptId, providerEvent.messageId);
        assert.equal(reconciled.providerDelivery?.status, "delivered");
        assert.equal(reconciled.deliveryReconciliation?.outcome, "provider_accepted");
        assert.equal(offerEmails.length, attempts, "reconciliation cannot redeliver the letter");
      } finally {
        offerDeliveryMode = "success";
      }
    },
  );
  await t.test(
    "offer alerts follow exact employer roles, dedupe, preserve read state and avoid historical backfill",
    async () => {
      const f = await fixture();
      const alerts = async () =>
        dbAdmin
          .select()
          .from(userNotificationsTable)
          .where(
            eq(
              userNotificationsTable.actionUrl,
              `/offer-inbox?workflow=${encodeURIComponent(f.workflowId)}`,
            ),
          );
      const sync = () =>
        dbAdmin.transaction((tx) =>
          syncOfferNotifications(
            tx,
            {
              jobId: f.jobId,
              tenantId: tenant,
              actorId: actorId("admin"),
              canApprove: true,
            },
            f.workflowId,
          ),
        );
      await sync();
      assert.equal((await alerts()).length, 0, "untouched historical fixture is not enrolled");
      const [row] = await dbAdmin.select().from(workflows).where(eq(workflows.id, f.workflowId));
      row.steps.find((s) => s.key === "hiring_decision")!.offerRouting!.approverUserId =
        actorId("employerApprover");
      await dbAdmin
        .update(workflows)
        .set({ steps: row.steps })
        .where(eq(workflows.id, f.workflowId));
      assert.equal((await f.act("save_draft", { terms })).status, 200);
      let pending = await alerts();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].userId, actorId("admin"));
      assert.match(pending[0].title, /TEST ONLY.*preparation/);
      assert.ok(!pending[0].message?.includes(terms.letter));
      const before = await f.read();
      const body = {
        action: "submit_review",
        expectedRevision: before.body.workflowRevision,
        idempotencyKey: randomUUID(),
      };
      assert.equal((await request("POST", f.path, body)).status, 200);
      assert.equal((await request("POST", f.path, body)).status, 200);
      pending = await alerts();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].userId, actorId("employerApprover"));
      assert.match(pending[0].title, /review required/);
      await dbAdmin
        .update(userNotificationsTable)
        .set({ isRead: true })
        .where(eq(userNotificationsTable.id, pending[0].id));
      await sync();
      assert.equal(
        (await alerts())[0].isRead,
        true,
        "polling does not re-alert a read pending task",
      );
      const restoreRouting = async () => {
        const [saved] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, f.workflowId));
        saved.steps.find((s) => s.key === "hiring_decision")!.offerRouting!.approverUserId =
          actorId("admin");
        await dbAdmin
          .update(workflows)
          .set({ steps: saved.steps })
          .where(eq(workflows.id, f.workflowId));
        await sync();
      };
      assert.equal((await f.act("approve", {}, "employerApprover")).status, 200);
      pending = await alerts();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].userId, actorId("admin"));
      assert.match(pending[0].title, /human send/);
      const sends = offerEmails.length;
      await sync();
      assert.equal(offerEmails.length, sends, "notification refresh never sends");
      await dbAdmin
        .update(candidatesTable)
        .set({ doNotContact: true })
        .where(eq(candidatesTable.id, offerCandidate));
      try {
        await sync();
        assert.equal((await alerts()).length, 0);
      } finally {
        await dbAdmin
          .update(candidatesTable)
          .set({ doNotContact: false })
          .where(eq(candidatesTable.id, offerCandidate));
        await restoreRouting();
      }
    },
  );
  await t.test(
    "unavailable offer operators alert employer recovery admins, not agency staff",
    async () => {
      const f = await fixture();
      const [row] = await dbAdmin.select().from(workflows).where(eq(workflows.id, f.workflowId));
      row.steps.find((s) => s.key === "hiring_decision")!.offerRouting!.approverUserId =
        actorId("employerApprover");
      await dbAdmin
        .update(workflows)
        .set({ steps: row.steps })
        .where(eq(workflows.id, f.workflowId));
      assert.equal((await f.act("save_draft", { terms })).status, 200);
      assert.equal((await f.act("submit_review")).status, 200);
      await dbAdmin
        .update(usersTable)
        .set({ status: "suspended" })
        .where(eq(usersTable.id, actorId("employerApprover")));
      try {
        await dbAdmin.transaction((tx) =>
          syncOfferNotifications(
            tx,
            {
              jobId: f.jobId,
              tenantId: tenant,
              actorId: actorId("admin"),
              canApprove: true,
            },
            f.workflowId,
          ),
        );
        const rows = await dbAdmin
          .select()
          .from(userNotificationsTable)
          .where(
            eq(
              userNotificationsTable.actionUrl,
              `/jobs/${encodeURIComponent(f.jobId)}?tab=overview`,
            ),
          );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].userId, actorId("admin"));
        assert.match(rows[0].title, /ownership needs recovery/);
        const state = await f.read();
        assert.equal(state.body.offer?.status, "review_required");
        assert.equal(state.body.offer?.approvedAt, undefined);
      } finally {
        await dbAdmin
          .update(usersTable)
          .set({ status: "active" })
          .where(eq(usersTable.id, actorId("employerApprover")));
        const [saved] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, f.workflowId));
        saved.steps.find((s) => s.key === "hiring_decision")!.offerRouting!.approverUserId =
          actorId("admin");
        await dbAdmin
          .update(workflows)
          .set({ steps: saved.steps })
          .where(eq(workflows.id, f.workflowId));
        await dbAdmin.transaction((tx) =>
          syncOfferNotifications(
            tx,
            {
              jobId: f.jobId,
              tenantId: tenant,
              actorId: actorId("admin"),
              canApprove: true,
            },
            f.workflowId,
          ),
        );
      }
    },
  );
  try {
    await t.test(
      "uncertain delivery reconciles only exact attempt evidence and never automatically resends",
      async () => {
        const auditIds: string[] = [];
        const prepare = async () => {
          const f = await fixture();
          await f.act("save_draft", { terms });
          await f.act("submit_review");
          await f.act("approve");
          offerDeliveryMode = "uncertain";
          assert.equal((await f.act("send")).status, 503);
          const state = (await f.read()).body;
          assert.ok(state.offer?.deliveryAttemptId);
          const [row] = await dbAdmin
            .select()
            .from(workflows)
            .where(eq(workflows.id, f.workflowId));
          assert.ok(
            row.steps.find((s) => s.controlledOffer)?.controlledOffer?.tokenHash,
            "Unknown delivery must preserve the original response capability",
          );
          return { ...f, offer: state.offer!, initial: row };
        };
        const insertReceipt = async (
          f: Awaited<ReturnType<typeof prepare>>,
          overrides: Record<string, unknown> = {},
          rowOverrides: Record<string, unknown> = {},
        ) => {
          const id = randomUUID();
          auditIds.push(id);
          await dbAdmin.insert(auditLogsTable).values({
            id,
            tenantId: tenant,
            actorType: "system",
            subjectType: "candidate",
            subjectId: offerCandidate,
            channel: "email",
            direction: "outbound",
            action: "offer.delivery",
            ...rowOverrides,
            metadata: {
              workflowId: f.workflowId,
              offerId: f.offer.id,
              version: f.offer.version,
              deliveryAttemptId: f.offer.deliveryAttemptId,
              to: f.offer.recipientEmail,
              messageId: `provider-${randomUUID()}`,
              ...overrides,
            },
          });
        };
        const check = (
          f: Awaited<ReturnType<typeof prepare>>,
          extra: Record<string, unknown> = {},
          actor: Actor | null = "admin",
        ) =>
          f.act(
            "reconcile_delivery",
            {
              deliveryResolution: "check_provider",
              deliveryAttemptId: f.offer.deliveryAttemptId,
              ...extra,
            },
            actor,
          );
        try {
          const f = await prepare();
          const emails = offerEmails.length;
          assert.equal((await check(f, {}, null)).status, 401);
          assert.equal((await check(f, {}, "foreign")).status, 404);
          assert.equal((await check(f, {}, "recruiter")).status, 403);
          assert.equal(
            (await check(f, {}, "employerApprover")).status,
            403,
            "An employer role without owner/sender designation is not reconciliation authority",
          );
          assert.equal((await check(f, { deliveryAttemptId: randomUUID() })).status, 409);
          assert.equal((await check(f)).status, 200);
          assert.equal((await f.read()).body.offer?.status, "send_uncertain");
          assert.equal((await f.read()).body.offer?.deliveryReconciliation?.outcome, "uncertain");
          await insertReceipt(f, { deliveryAttemptId: "different-attempt" });
          await insertReceipt(f, { version: f.offer.version + 1 });
          await insertReceipt(f, { to: "other@example.invalid" });
          await insertReceipt(f, {}, { tenantId: foreign });
          await insertReceipt(f, {}, { actorType: "user" });
          await insertReceipt(f, { messageId: "sim-no-effect" });
          await insertReceipt(f, {}, { action: "email.failed" });
          assert.equal((await check(f)).status, 200);
          assert.equal(
            (await f.read()).body.offer?.status,
            "send_uncertain",
            "Wrong tenant, version, recipient, attempt, actor and simulation/error logs cannot clear uncertainty",
          );
          await insertReceipt(f);
          const before = (await f.read()).body;
          assert.equal(
            (await check(f, { expectedRevision: before.workflowRevision - 1 })).status,
            409,
          );
          const input = {
            action: "reconcile_delivery",
            deliveryResolution: "check_provider",
            deliveryAttemptId: f.offer.deliveryAttemptId,
            idempotencyKey: randomUUID(),
            expectedRevision: before.workflowRevision,
          };
          const both = await Promise.all([
            request("POST", f.path, input),
            request("POST", f.path, input),
          ]);
          assert.ok(both.every((r) => r.status === 200));
          const resolved = (await f.read()).body;
          assert.equal(resolved.offer?.status, "sent");
          assert.equal(resolved.offer?.deliveryReconciliation?.outcome, "provider_accepted");
          assert.deepEqual(resolved.offer?.terms, f.offer.terms);
          assert.equal(resolved.offer?.version, f.offer.version);
          const [after] = await dbAdmin
            .select()
            .from(workflows)
            .where(eq(workflows.id, f.workflowId));
          assert.deepEqual(after.steps.slice(0, 5), f.initial.steps.slice(0, 5));
          const token = offerEmails[emails - 1].match(/\/offer\/([a-f0-9]{64})/)![1];
          assert.equal(
            (await request("GET", `/controlled-offers/public/${token}`, undefined, null)).status,
            200,
          );
          assert.equal((await f.act("send")).status, 409);
          assert.equal(
            (
              await check(f, {
                deliveryResolution: "confirmed_not_sent",
                reason: "Provider checked original request.",
                evidenceReference: "case-original-attempt",
                acknowledgeNoDelivery: true,
              })
            ).status,
            409,
          );
          assert.equal(offerEmails.length, emails);

          const noEffect = await prepare();
          const clear = {
            deliveryResolution: "confirmed_not_sent",
            reason: "Provider verified request terminated without acceptance.",
            evidenceReference: "provider-support-case-original-attempt",
            acknowledgeNoDelivery: true,
          };
          assert.equal(
            (await check(noEffect, { ...clear, acknowledgeNoDelivery: false })).status,
            400,
          );
          assert.equal((await check(noEffect, { ...clear, reason: "          " })).status, 400);
          assert.equal(
            (await check(noEffect, { ...clear, evidenceReference: "          " })).status,
            400,
          );
          assert.equal((await check(noEffect, clear)).status, 200);
          const reset = (await noEffect.read()).body;
          assert.equal(reset.offer?.status, "draft");
          assert.equal(reset.offer?.approvedAt, undefined);
          assert.equal(reset.history.at(-1)?.status, "send_uncertain");
          assert.equal(reset.offer?.deliveryReconciliation?.outcome, "confirmed_not_sent");
          assert.equal((await noEffect.act("send")).status, 409);
          const oldToken = offerEmails.at(-1)!.match(/\/offer\/([a-f0-9]{64})/)![1];
          assert.equal(
            (await request("GET", `/controlled-offers/public/${oldToken}`, undefined, null)).status,
            404,
          );
          await noEffect.act("submit_review");
          await noEffect.act("approve");
          offerDeliveryMode = "success";
          assert.equal((await noEffect.act("send")).status, 200);
          assert.notEqual(
            (await noEffect.read()).body.offer?.deliveryAttemptId,
            noEffect.offer.deliveryAttemptId,
          );

          const live = await prepare();
          await dbAdmin
            .update(workflows)
            .set({
              steps: live.initial.steps.map((s) =>
                s.controlledOffer
                  ? {
                      ...s,
                      controlledOffer: {
                        ...s.controlledOffer,
                        status: "sending" as const,
                        deliveryStartedAt: new Date(Date.now() - 600000).toISOString(),
                      },
                    }
                  : s,
              ),
            })
            .where(eq(workflows.id, live.workflowId));
          assert.equal(
            (await check(live, clear)).status,
            409,
            "An unsettled request is not eligible for no-effect release",
          );
          assert.equal((await check(live)).status, 200);
          const [stillLive] = await dbAdmin
            .select()
            .from(workflows)
            .where(eq(workflows.id, live.workflowId));
          assert.equal(
            stillLive.steps.find((s) => s.controlledOffer)?.controlledOffer?.status,
            "sending",
            "An inconclusive check must not interfere with an in-flight finalizer",
          );
          assert.equal((await live.read()).body.offer?.status, "send_uncertain");
          const legacy = await prepare();
          await dbAdmin
            .update(workflows)
            .set({
              steps: legacy.initial.steps.map((s) => {
                if (!s.controlledOffer) return s;
                const { deliveryAttemptId: _, ...old } = s.controlledOffer;
                return { ...s, controlledOffer: old };
              }),
            })
            .where(eq(workflows.id, legacy.workflowId));
          assert.equal(
            (await check(legacy, clear)).status,
            409,
            "Unattributable older attempts stay held",
          );
          const ambiguous = await prepare();
          await insertReceipt(ambiguous);
          await insertReceipt(ambiguous);
          assert.equal(
            (await check(ambiguous)).status,
            409,
            "Conflicting receipts cannot be guessed",
          );
          const visibleRevision = (await ambiguous.read()).body.workflowRevision;
          try {
            await dbAdmin
              .update(candidatesTable)
              .set({ doNotContact: true })
              .where(eq(candidatesTable.id, offerCandidate));
            assert.equal(
              (
                await request("POST", ambiguous.path, {
                  action: "reconcile_delivery",
                  deliveryResolution: "check_provider",
                  deliveryAttemptId: ambiguous.offer.deliveryAttemptId,
                  expectedRevision: visibleRevision,
                  idempotencyKey: randomUUID(),
                })
              ).status,
              404,
            );
          } finally {
            await dbAdmin
              .update(candidatesTable)
              .set({ doNotContact: false })
              .where(eq(candidatesTable.id, offerCandidate));
          }
        } finally {
          offerDeliveryMode = "success";
          if (auditIds.length)
            await dbAdmin.delete(auditLogsTable).where(inArray(auditLogsTable.id, auditIds));
        }
      },
    );
    await t.test(
      "ATS employer allocation, two-party consent, verification receipts and revocation are scoped and read-only",
      async () => {
        const c = await fixture();
        const route = `${c.path}-routing`;
        const routing = await request("GET", route);
        assert.equal(
          (
            await request("POST", route, {
              mode: "external",
              ownerUserId: actorId("admin"),
              externalSystem: "Greenhouse",
              approverUserId: null,
              senderUserId: null,
              expectedRevision: (routing.body as unknown as OfferRoutingState).workflowRevision,
              idempotencyKey: randomUUID(),
              reason: "Isolated ATS verification only.",
            })
          ).status,
          200,
        );
        const handoff = c.path.replace(/\/offer$/, "/ats-handoff");
        const mapState = await request("GET", handoff);
        assert.equal(
          (
            await request("POST", handoff, {
              action: "save_mapping",
              expectedRevision: (mapState.body as unknown as AtsHandoffState).workflowRevision,
              idempotencyKey: randomUUID(),
              mapping: {
                accountRef: "fixture-employer",
                externalJobId: "101",
                externalCandidateId: "202",
                externalApplicationId: "303",
              },
            })
          ).status,
          200,
        );
        const path = c.path.replace(/\/offer$/, "/ats-verification");
        const verificationRequest = async (
          method: string,
          input?: unknown,
          actor: Actor | null = "admin",
        ) => {
          const result = await request(method, path, input, actor);
          return { ...result, body: result.body as unknown as AtsVerificationState };
        };
        const read = async (actor: Actor | null = "admin") =>
          verificationRequest("GET", undefined, actor);
        const act = async (
          action: string,
          actor: Actor = "admin",
          extra: Record<string, unknown> = {},
        ) => {
          const st = await read(actor);
          assert.equal(st.status, 200, JSON.stringify(st.body));
          return verificationRequest(
            "POST",
            {
              action,
              expectedBindingRevision: st.body.bindingRevision,
              expectedWorkflowRevision: st.body.workflowRevision,
              ...extra,
            },
            actor,
          );
        };
        const emailsBefore = offerEmails.length;
        assert.equal((await read(null)).status, 401);
        assert.equal((await read("foreign")).status, 404);
        assert.equal((await read("candidate")).status, 403);
        assert.equal(
          (
            await act("allocate", "admin", {
              connectionId: atsConnectionId,
              accountRef: "fixture-employer",
              acknowledgeEmployerOwnership: true,
            })
          ).status,
          403,
        );
        assert.deepEqual((await read()).body.choices, []);
        assert.equal((await act("verify", "admin", { idempotencyKey: randomUUID() })).status, 409);
        assert.equal(atsReadPaths.length, 0);
        const allocated = await act("allocate", "platform", {
          connectionId: atsConnectionId,
          accountRef: "fixture-employer",
          acknowledgeEmployerOwnership: true,
        });
        assert.equal(allocated.status, 200, JSON.stringify(allocated.body));
        assert.equal(allocated.body.binding?.status, "pending_employer");
        assert.equal(
          (await act("confirm", "platform", { acknowledgeEmployerOwnership: true })).status,
          403,
        );
        assert.equal((await act("confirm", "admin")).status, 403);
        assert.equal(
          (await act("confirm", "admin", { acknowledgeEmployerOwnership: true })).status,
          200,
        );
        const active = await read();
        const verifyInput = {
          action: "verify",
          expectedBindingRevision: active.body.bindingRevision,
          expectedWorkflowRevision: active.body.workflowRevision,
          idempotencyKey: randomUUID(),
        };
        const result = await verificationRequest("POST", verifyInput);
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.body.history[0].status, "verified");
        assert.equal(result.body.history[0].currentMapping, true);
        assert.equal(JSON.stringify(result.body).includes("PRIVATE"), false);
        assert.equal(atsReadPaths.length, 3);
        assert.equal((await request("POST", path, verifyInput)).status, 200);
        assert.equal(atsReadPaths.length, 3, "same key must not re-read");
        assert.equal(
          (await request("POST", path, { ...verifyInput, expectedWorkflowRevision: -1 })).status,
          400,
        );
        assert.equal(
          (await request("POST", path, { ...verifyInput, expectedBindingRevision: 0 })).status,
          409,
        );
        const previewPath = path.replace(/ats-verification$/, "ats-preview");
        const previewInput = {
          expectedBindingRevision: active.body.bindingRevision,
          expectedWorkflowRevision: active.body.workflowRevision,
        };
        for (const [actor, status] of [
          [null, 401],
          ["candidate", 403],
          ["foreign", 404],
          ["platform", 403],
        ] as const) {
          assert.equal((await request("POST", previewPath, previewInput, actor)).status, status);
        }
        assert.equal(atsPagePaths.length, 0);
        assert.equal(
          (await request("POST", previewPath, { ...previewInput, expectedBindingRevision: 0 }))
            .status,
          400,
        );
        assert.equal(
          (await request("POST", previewPath, { ...previewInput, expectedBindingRevision: 44 }))
            .status,
          409,
        );
        assert.equal(
          (await request("POST", previewPath, { ...previewInput, connectionId: "other" })).status,
          400,
        );
        assert.equal(atsPagePaths.length, 0);
        const preview = await request("POST", previewPath, previewInput);
        assert.equal(preview.status, 200, JSON.stringify(preview.body));
        const previewData = preview.body as unknown as {
          job: { id: string };
          applications: { id: string }[];
          nextCursor: string | null;
        };
        assert.equal(previewData.job.id, "101");
        assert.deepEqual(
          previewData.applications.map((a) => a.id),
          ["303"],
        );
        assert.equal(JSON.stringify(preview.body).includes("PRIVATE"), false);
        assert.equal(atsPagePaths[0], "/v3/applications?job_ids=101&per_page=25");
        assert.ok(previewData.nextCursor);
        const importPath = path.replace(/ats-verification$/, "ats-imports");
        const importInput = {
          ...previewInput,
          previewToken: (preview.body as unknown as { previewToken: string }).previewToken,
          applicationIds: ["303"],
          acknowledgeMetadataOnly: true,
        };
        const readsBeforeDenied = atsReadPaths.length;
        for (const [actor, status] of [
          [null, 401],
          ["candidate", 403],
          ["foreign", 404],
          ["platform", 403],
        ] as const) {
          assert.equal((await request("GET", importPath, undefined, actor)).status, status);
          assert.equal((await request("POST", importPath, importInput, actor)).status, status);
        }
        assert.equal(atsReadPaths.length, readsBeforeDenied);
        assert.equal(
          (await request("POST", importPath, { ...importInput, acknowledgeMetadataOnly: false }))
            .status,
          400,
        );
        assert.equal(
          (await request("POST", importPath, { ...importInput, applicationIds: ["999"] })).status,
          409,
        );
        assert.equal(
          (await request("POST", importPath, { ...importInput, applicationIds: ["303", "303"] }))
            .status,
          400,
        );
        assert.equal(
          (await request("POST", importPath, { ...importInput, applicationIds: [] })).status,
          400,
        );
        assert.equal(
          (await request("POST", importPath, { ...importInput, expectedBindingRevision: 44 }))
            .status,
          409,
        );
        assert.equal(
          (await request("POST", importPath, { ...importInput, previewToken: "forged" })).status,
          409,
        );
        assert.equal(atsReadPaths.length, readsBeforeDenied);
        const imported = await request("POST", importPath, importInput);
        assert.equal(imported.status, 200, JSON.stringify(imported.body));
        type ImportData = {
          importedCount: number;
          existingCount: number;
          records: { id: string; application: { id: string } }[];
        };
        const importedData = imported.body as unknown as ImportData;
        assert.equal(importedData.importedCount, 1);
        assert.equal(importedData.existingCount, 0);
        assert.equal(importedData.records.length, 1);
        assert.equal(importedData.records[0].application.id, "303");
        assert.equal(JSON.stringify(imported.body).includes("PRIVATE"), false);
        const replay = await request("POST", importPath, importInput);
        assert.equal(replay.status, 200);
        assert.equal((replay.body as unknown as ImportData).importedCount, 0);
        assert.equal((replay.body as unknown as ImportData).existingCount, 1);
        assert.equal(
          (replay.body as unknown as ImportData).records[0].id,
          importedData.records[0].id,
        );
        const history = await request("GET", importPath);
        assert.equal(history.status, 200);
        assert.deepEqual((history.body as unknown as ImportData).records, importedData.records);
        const recordPath = `${importPath}/${importedData.records[0].id}`;
        const requestProfile = request;
        // Keep this in the current subtest: awaiting a sibling on the outer
        // TestContext would wait for this very subtest to finish.
        {
          const request: typeof requestProfile = (method, path, body, actor = "employerApprover") =>
            requestProfile(method, path, body, actor);
          const profilePath = `${recordPath}/profile`;
          const input = {
            action: "preview",
            expectedWorkflowRevision: previewInput.expectedWorkflowRevision,
            expectedBindingRevision: previewInput.expectedBindingRevision,
            expectedImportRevision: 0,
            includeProfessional: false,
            idempotencyKey: randomUUID(),
            acknowledge: true,
          };
          const calls = atsReadPaths.length;
          for (const [actor, status] of [
            [null, 401],
            ["candidate", 403],
            ["foreign", 404],
            ["platform", 403],
          ] as const) {
            assert.equal((await request("POST", profilePath, input, actor)).status, status);
          }
          assert.equal(
            (await request("POST", profilePath, { ...input, acknowledge: false })).status,
            400,
          );
          assert.equal(
            (await request("POST", profilePath, { ...input, expectedImportRevision: 77 })).status,
            409,
          );
          assert.equal(
            (await request("POST", profilePath, { ...input, firstName: "forged" })).status,
            400,
          );
          const initial = await request("GET", profilePath);
          assert.equal(initial.status, 200, JSON.stringify(initial.body));
          assert.equal(atsReadPaths.length, calls, "denied requests and GET do not read provider");
          type PreviewResult = {
            preview: {
              token: string;
              emails: string[];
              currentTitle: string | null;
              matches: { candidateId: string }[];
            };
            state: { candidateId: string; importedAt: string };
            outcome: string;
          };
          const shown = await request("POST", profilePath, input);
          assert.equal(shown.status, 200, JSON.stringify(shown.body));
          const data = shown.body as unknown as PreviewResult;
          assert.equal(data.preview.currentTitle, null);
          assert.equal(JSON.stringify(shown.body).includes("PRIVATE"), false);
          assert.equal(
            data.preview.matches.length,
            1,
            "the existing ATS mapping prevents a duplicate even when email differs",
          );
          const existingId = data.preview.matches[0].candidateId;
          const [oldPerson] = await dbAdmin
            .select()
            .from(candidatesTable)
            .where(eq(candidatesTable.id, existingId));
          const commit = {
            ...input,
            action: "import",
            idempotencyKey: randomUUID(),
            previewToken: data.preview.token,
            email: data.preview.emails[0],
          };
          assert.equal(
            (await request("POST", profilePath, commit)).status,
            409,
            "existing profile requires explicit link",
          );
          const providerCalls = atsReadPaths.length;
          const linked = await request("POST", profilePath, {
            ...commit,
            existingCandidateId: existingId,
          });
          assert.equal(linked.status, 200, JSON.stringify(linked.body));
          assert.equal((linked.body as unknown as PreviewResult).outcome, "linked");
          const [afterPerson] = await dbAdmin
            .select()
            .from(candidatesTable)
            .where(eq(candidatesTable.id, existingId));
          assert.deepEqual(
            afterPerson,
            oldPerson,
            "linking does not overwrite candidate fields, privacy or consent",
          );
          assert.equal(atsReadPaths.length, providerCalls, "commit does not replay remote reads");
          await dbAdmin.delete(atsProfiles).where(eq(atsProfiles.tenantId, tenant));

          const [source] = await dbAdmin
            .select()
            .from(atsImports)
            .where(eq(atsImports.id, importedData.records[0].id));
          const newRecordId = randomUUID();
          await dbAdmin.insert(atsImports).values({
            ...source,
            id: newRecordId,
            externalApplicationId: "304",
            snapshot: {
              ...source.snapshot,
              application: { ...source.snapshot.application, id: "304", candidateId: "505" },
            },
            currentSnapshot: null,
          });
          const nextPath = `${importPath}/${newRecordId}/profile`;
          let createdId: string | undefined;
          const beforeApps = await dbAdmin
            .select()
            .from(applicationsTable)
            .where(eq(applicationsTable.jobId, source.jobId));
          try {
            atsProfileIdentity = 505;
            const next = await request("POST", nextPath, { ...input, includeProfessional: true });
            assert.equal(next.status, 200, JSON.stringify(next.body));
            const previewed = next.body as unknown as PreviewResult;
            assert.equal(previewed.preview.matches.length, 0);
            assert.equal(previewed.preview.currentTitle, "ATS title");
            const save = {
              ...commit,
              includeProfessional: true,
              previewToken: previewed.preview.token,
              idempotencyKey: randomUUID(),
            };
            assert.equal(
              (await request("POST", nextPath, { ...save, email: "forged@example.invalid" }))
                .status,
              400,
            );
            const readCount = atsReadPaths.length;
            const saves = await Promise.all([
              request("POST", nextPath, save),
              request("POST", nextPath, save),
            ]);
            createdId = (
              saves.find((r) => r.status === 200)?.body as unknown as PreviewResult | undefined
            )?.state?.candidateId;
            assert.ok(
              saves.every((r) => r.status === 200),
              JSON.stringify(saves),
            );
            assert.deepEqual(
              saves.map((r) => (r.body as unknown as PreviewResult).outcome).sort(),
              ["already_imported", "created"],
            );
            createdId = (saves[0].body as unknown as PreviewResult).state.candidateId;
            assert.ok(createdId);
            const [person] = await dbAdmin
              .select()
              .from(candidatesTable)
              .where(eq(candidatesTable.id, createdId));
            assert.equal(person.currentTitle, "ATS title");
            assert.equal(person.pool, "tenant");
            assert.equal(person.userId, null);
            assert.equal(person.isCurrentEmployee, false);
            assert.equal(person.verificationStatus, "unverified");
            assert.equal(person.resumeUrl, null);
            assert.equal(
              atsReadPaths.length,
              readCount,
              "local import retries make no provider calls",
            );
            // Greenhouse interview preparation uses the reviewed canonical
            // profile, a frozen existing plan and no contact or native enrollment.
            const interviewPath = nextPath.replace(/\/profile$/, "/interview");
            const planId = `${prefix}_greenhouse_preparation`;
            await dbAdmin.insert(interviewPlansTable).values({
              id: planId,
              tenantId: tenant,
              jobId: source.jobId,
              title: "Reviewed Greenhouse preparation plan",
              language: "en-US",
              interviewType: "general",
              questions: [{ question: "Describe an API you built.", category: "technical" }],
            });
            const noContact = offerEmails.length;
            const localReads = atsReadPaths.length;
            const prepView = await request("GET", interviewPath);
            assert.equal(prepView.status, 200, JSON.stringify(prepView.body));
            assert.equal(atsReadPaths.length, localReads, "preparation GET remains local");
            type PreparationState = {
              workflowRevision: number;
              bindingRevision: number;
              importRevision: number;
              plans: { id: string; approvalHash: string }[];
              session: { id: string; roomUrl: string; preparedFromThisImport: boolean } | null;
            };
            const prep = prepView.body as unknown as PreparationState;
            const selected = prep.plans.find((p) => p.id === planId)!;
            assert.ok(selected);
            const prepareInput = {
              planId,
              expectedPlanHash: selected.approvalHash,
              acknowledge: true,
              expectedWorkflowRevision: prep.workflowRevision,
              expectedBindingRevision: prep.bindingRevision,
              expectedImportRevision: prep.importRevision,
            };
            assert.equal(
              (await request("POST", interviewPath, { ...prepareInput, acknowledge: false }))
                .status,
              400,
            );
            assert.equal(
              (
                await request("POST", interviewPath, {
                  ...prepareInput,
                  expectedPlanHash: "0".repeat(64),
                })
              ).status,
              409,
            );
            assert.equal(
              (await request("POST", interviewPath, { ...prepareInput, sendInvite: true })).status,
              400,
            );
            for (const [actor, status] of [
              [null, 401],
              ["candidate", 403],
              ["foreign", 404],
              ["platform", 403],
            ] as const)
              assert.equal(
                (await request("POST", interviewPath, prepareInput, actor)).status,
                status,
              );
            assert.equal(
              atsReadPaths.length,
              localReads,
              "denied preparations make no remote reads",
            );
            atsReadMode = "failure";
            assert.equal((await request("POST", interviewPath, prepareInput)).status, 503);
            atsReadMode = "success";
            const prepared = await Promise.all([
              request("POST", interviewPath, prepareInput),
              request("POST", interviewPath, prepareInput),
            ]);
            assert.ok(
              prepared.every((x) => x.status === 200),
              JSON.stringify(prepared),
            );
            const minted = prepared.map((x) => (x.body as unknown as PreparationState).session!);
            assert.equal(
              minted[0].id,
              minted[1].id,
              "concurrent preparations preserve one interview",
            );
            assert.equal(minted[0].preparedFromThisImport, true);
            const [savedSession] = await dbAdmin
              .select()
              .from(interviewSessionsTable)
              .where(eq(interviewSessionsTable.id, minted[0].id));
            const [frozen] = await dbAdmin
              .select()
              .from(interviewPlansTable)
              .where(eq(interviewPlansTable.id, savedSession.planId));
            assert.equal(savedSession.candidateId, createdId);
            assert.equal(savedSession.inviteSentAt, null);
            assert.notEqual(frozen.id, planId);
            assert.deepEqual(frozen.questions, [
              { question: "Describe an API you built.", category: "technical" },
            ]);
            assert.equal(offerEmails.length, noContact, "preparing never contacts a candidate");
            const reloaded = await request("GET", interviewPath);
            assert.equal(reloaded.status, 200);
            assert.equal(
              (reloaded.body as unknown as PreparationState).session?.id,
              savedSession.id,
            );
            assert.equal(JSON.stringify(reloaded.body).includes("PRIVATE"), false);
            const invitationPath = interviewPath.replace(/\/interview$/, "/interview-invitation");
            const invitationReview = await request("GET", invitationPath);
            assert.equal(invitationReview.status, 200, JSON.stringify(invitationReview.body));
            type Invitation = {
              reviewHash: string;
              status: string;
              canSend: boolean;
              recipient: string;
            };
            const invitation = invitationReview.body as unknown as Invitation;
            const noInvites = greenhouseInvitations.length;
            assert.equal(invitation.status, "not_sent");
            assert.equal(invitation.canSend, true);
            assert.equal(invitation.recipient, person.email.trim().toLowerCase());
            assert.equal(offerEmails.length, noContact, "invitation review sends nothing");
            const send = { reviewHash: invitation.reviewHash, acknowledge: true };
            assert.equal(
              (await request("POST", invitationPath, { ...send, acknowledge: false })).status,
              400,
            );
            assert.equal(
              (await request("POST", invitationPath, { ...send, to: "forged@example.invalid" }))
                .status,
              400,
            );
            assert.equal(
              (await request("POST", invitationPath, { ...send, reviewHash: "0".repeat(64) }))
                .status,
              409,
            );
            for (const [actor, status] of [
              [null, 401],
              ["candidate", 403],
              ["foreign", 404],
              ["platform", 403],
            ] as const)
              assert.equal((await request("POST", invitationPath, send, actor)).status, status);
            atsReadMode = "failure";
            assert.equal((await request("POST", invitationPath, send)).status, 503);
            atsReadMode = "changed";
            assert.equal((await request("POST", invitationPath, send)).status, 409);
            atsReadMode = "success";
            assert.equal(
              greenhouseInvitations.length,
              noInvites,
              "denied/stale invitations never reach transport",
            );
            const sends = await Promise.all([
              request("POST", invitationPath, send),
              request("POST", invitationPath, send),
            ]);
            assert.ok(
              sends.every((x) => x.status === 200),
              JSON.stringify(sends),
            );
            assert.equal(
              greenhouseInvitations.length,
              noInvites + 1,
              "concurrent sends call transport once",
            );
            assert.ok(greenhouseInvitations.at(-1)?.text.includes(savedSession.id));
            assert.equal(greenhouseInvitations.at(-1)?.singleAttempt, true);
            const sent = await request("GET", invitationPath);
            assert.equal((sent.body as unknown as Invitation).status, "provider_accepted");
            assert.equal((sent.body as unknown as Invitation).canSend, false);
            assert.equal((await request("POST", invitationPath, send)).status, 200);
            assert.equal(greenhouseInvitations.length, noInvites + 1, "retry never resends");
            const [invited] = await dbAdmin
              .select()
              .from(interviewSessionsTable)
              .where(eq(interviewSessionsTable.id, savedSession.id));
            assert.ok(invited.inviteSentAt);
            const notePath = interviewPath.replace(/\/interview$/, "/interview-note");
            type NoteState = {
              reviewHash: string;
              status: string;
              canPublish: boolean;
              content: string;
              noteId: string | null;
            };
            const notePreview = async (mode = "progress") => {
              const response = await request("GET", `${notePath}/${mode}`);
              assert.equal(response.status, 200, JSON.stringify(response.body));
              return response.body as unknown as NoteState;
            };
            const noteReads = atsReadPaths.length;
            const noteCount = greenhouseNotes.length;
            const progress = await notePreview();
            assert.equal(atsReadPaths.length, noteReads, "note preview is local");
            assert.equal(progress.status, "not_published");
            assert.ok(progress.canPublish);
            assert.ok(!progress.content.includes("/room"));
            assert.equal((await request("GET", `${notePath}/assessment`)).status, 409);
            const noteInput = {
              mode: "progress",
              reviewHash: progress.reviewHash,
              acknowledge: true,
            };
            assert.equal(
              (await request("POST", notePath, { ...noteInput, acknowledge: false })).status,
              400,
            );
            assert.equal(
              (await request("POST", notePath, { ...noteInput, content: "forged" })).status,
              400,
            );
            assert.equal(
              (await request("POST", notePath, { ...noteInput, reviewHash: "0".repeat(64) }))
                .status,
              409,
            );
            for (const [actor, status] of [
              [null, 401],
              ["candidate", 403],
              ["foreign", 404],
              ["platform", 403],
            ] as const) {
              assert.equal((await request("POST", notePath, noteInput, actor)).status, status);
              assert.equal(
                (await request("GET", `${notePath}/progress`, undefined, actor)).status,
                status,
              );
            }
            greenhouseNotesEnabled = false;
            assert.equal((await notePreview()).canPublish, false);
            assert.equal((await request("POST", notePath, noteInput)).status, 409);
            greenhouseNotesEnabled = true;
            atsReadMode = "failure";
            assert.equal((await request("POST", notePath, noteInput)).status, 503);
            atsReadMode = "changed";
            assert.equal((await request("POST", notePath, noteInput)).status, 409);
            atsReadMode = "success";
            assert.equal(
              greenhouseNotes.length,
              noteCount,
              "denied publication has no remote effects",
            );
            const publications = await Promise.all([
              request("POST", notePath, noteInput),
              request("POST", notePath, noteInput),
            ]);
            assert.ok(
              publications.every((x) => x.status === 200),
              JSON.stringify(publications),
            );
            assert.equal(
              greenhouseNotes.length,
              noteCount + 1,
              "concurrent publication creates one note",
            );
            assert.equal((await notePreview()).status, "published");
            assert.ok((await notePreview()).noteId);
            assert.equal((await request("POST", notePath, noteInput)).status, 200);
            assert.equal(greenhouseNotes.length, noteCount + 1, "replay cannot republish");
            assert.equal(greenhouseNotes.at(-1)?.application_id, 304);
            assert.equal(greenhouseNotes.at(-1)?.candidate_id, 505);
            assert.equal(greenhouseNotes.at(-1)?.visibility, "admin_only");
            const completedAt = new Date();
            await dbAdmin
              .update(interviewSessionsTable)
              .set({
                status: "completed",
                completedAt,
                answers: [{ question: "Role question", answer: "Job answer" }],
              })
              .where(eq(interviewSessionsTable.id, savedSession.id));
            const summaryId = randomUUID();
            await dbAdmin.insert(interviewSummariesTable).values({
              id: summaryId,
              interviewSessionId: savedSession.id,
              overallScore: 0,
              recruiterSummary: "Role-specific synthetic assessment",
              recruiterComments: "PRIVATE staff note",
              transcript: ["PRIVATE transcript"],
              strengths: ["Example"],
              weaknesses: [],
              redFlags: [],
            });
            const assessment = await notePreview("assessment");
            assert.ok(assessment.content.includes("Interview score: 0"));
            assert.ok(!assessment.content.includes("PRIVATE"));
            const assessmentInput = {
              mode: "assessment",
              reviewHash: assessment.reviewHash,
              acknowledge: true,
            };
            await dbAdmin
              .update(interviewSummariesTable)
              .set({ recruiterSummary: "Changed assessment" })
              .where(eq(interviewSummariesTable.id, summaryId));
            assert.equal((await request("POST", notePath, assessmentInput)).status, 409);
            const freshAssessment = await notePreview("assessment");
            const approved = await request("POST", notePath, {
              ...assessmentInput,
              reviewHash: freshAssessment.reviewHash,
            });
            assert.equal(approved.status, 200, JSON.stringify(approved.body));
            assert.equal((approved.body as unknown as NoteState).status, "published");
            assert.equal(greenhouseNotes.length, noteCount + 2);
            // A changed progress note gets one attempt; ambiguity fences later
            // content changes as well as identical request retries.
            greenhouseNoteFailure = true;
            const completedProgress = await notePreview();
            const heldInput = { ...noteInput, reviewHash: completedProgress.reviewHash };
            const heldNote = await request("POST", notePath, heldInput);
            assert.equal(heldNote.status, 200, JSON.stringify(heldNote.body));
            assert.equal((heldNote.body as unknown as NoteState).status, "review_required");
            const heldCount = greenhouseNotes.length;
            await dbAdmin
              .update(interviewSessionsTable)
              .set({ completedAt: new Date(completedAt.getTime() + 1000) })
              .where(eq(interviewSessionsTable.id, savedSession.id));
            const changedProgress = await notePreview();
            assert.equal(changedProgress.canPublish, false);
            assert.equal(
              (
                await request("POST", notePath, {
                  ...heldInput,
                  reviewHash: changedProgress.reviewHash,
                })
              ).status,
              200,
            );
            assert.equal(
              greenhouseNotes.length,
              heldCount,
              "changed content cannot bypass an uncertain attempt",
            );
            assert.ok(!JSON.stringify(heldNote.body).includes("PRIVATE"));
            greenhouseNoteFailure = false;
            // Recovery verifies an existing exact note without writing again.
            const recoveryPath = `${notePath}-recovery`;
            type RecoveryAttempt = {
              receiptId: string;
              reviewHash: string;
              status: string;
              noteId: string | null;
              canVerify: boolean;
            };
            const recovery = async () => {
              const res = await request("GET", recoveryPath);
              assert.equal(res.status, 200, JSON.stringify(res.body));
              return res.body as unknown as RecoveryAttempt[];
            };
            const noLookup = greenhouseRecoveryReads.length;
            const heldAttempt = (await recovery()).find((x) => x.status === "held")!;
            assert.ok(heldAttempt.canVerify);
            assert.equal(
              greenhouseRecoveryReads.length,
              noLookup,
              "local recovery view has no provider I/O",
            );
            const recovering = {
              receiptId: heldAttempt.receiptId,
              reviewHash: heldAttempt.reviewHash,
              noteId: "92001",
              acknowledge: true,
            };
            assert.equal(
              (await request("POST", recoveryPath, { ...recovering, acknowledge: false })).status,
              400,
            );
            assert.equal(
              (await request("POST", recoveryPath, { ...recovering, outcome: "not_sent" })).status,
              400,
            );
            assert.equal(
              (await request("POST", recoveryPath, { ...recovering, noteId: "9007199254740992" }))
                .status,
              400,
            );
            assert.equal(
              (await request("POST", recoveryPath, { ...recovering, reviewHash: "0".repeat(64) }))
                .status,
              409,
            );
            assert.equal(
              (await request("POST", recoveryPath, { ...recovering, receiptId: randomUUID() }))
                .status,
              404,
            );
            for (const [actor, status] of [
              [null, 401],
              ["candidate", 403],
              ["foreign", 404],
              ["platform", 403],
            ] as const) {
              assert.equal((await request("GET", recoveryPath, undefined, actor)).status, status);
              assert.equal((await request("POST", recoveryPath, recovering, actor)).status, status);
            }
            assert.equal(
              greenhouseRecoveryReads.length,
              noLookup,
              "invalid or unauthorized recovery never reads the provider",
            );
            greenhouseNotesEnabled = false;
            assert.equal(
              (await recovery()).find((x) => x.receiptId === heldAttempt.receiptId)?.canVerify,
              false,
            );
            assert.equal((await request("POST", recoveryPath, recovering)).status, 409);
            greenhouseNotesEnabled = true;
            greenhouseRecoveryFailure = true;
            const unavailable = await request("POST", recoveryPath, recovering);
            assert.equal(unavailable.status, 503);
            assert.ok(!JSON.stringify(unavailable.body).includes("PRIVATE"));
            greenhouseRecoveryFailure = false;
            const originalBody = greenhouseNotes.at(-1)!;
            const providerNote = {
              ...originalBody,
              id: 92001,
              type: "NOTE",
              visibility: "admin_only_visible",
            };
            for (const evidence of [
              [],
              [providerNote, providerNote],
              [{ ...providerNote, id: 99 }],
              [{ ...providerNote, visibility: "publicly_visible" }],
              [{ ...providerNote, candidate_id: 999 }],
              [{ ...providerNote, application_id: 999 }],
              [{ ...providerNote, body: "PRIVATE unrelated evidence" }],
              [{ ...providerNote, subject: "Unrelated note" }],
              [{ ...providerNote, type: "EMAIL" }],
            ]) {
              greenhouseRecoveryEvidence = evidence;
              const rejected = await request("POST", recoveryPath, recovering);
              assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
              assert.ok(!JSON.stringify(rejected.body).includes("PRIVATE"));
              assert.equal(
                (await notePreview()).canPublish,
                false,
                "mismatched or absent evidence preserves the hold",
              );
            }
            greenhouseRecoveryEvidence = [providerNote];
            greenhouseRecoveryDuringRead = async () => {
              await dbAdmin
                .update(atsImports)
                .set({ refreshRevision: sql`${atsImports.refreshRevision} + 1` })
                .where(eq(atsImports.id, newRecordId));
            };
            assert.equal(
              (await request("POST", recoveryPath, recovering)).status,
              409,
              "authority revision rechecked after provider evidence",
            );
            greenhouseRecoveryDuringRead = null;
            const freshHeld = (await recovery()).find(
              (x) => x.receiptId === heldAttempt.receiptId,
            )!;
            const freshRecovery = { ...recovering, reviewHash: freshHeld.reviewHash };
            const recovered = await Promise.all([
              request("POST", recoveryPath, freshRecovery),
              request("POST", recoveryPath, freshRecovery),
            ]);
            assert.ok(
              recovered.every((x) => x.status === 200),
              JSON.stringify(recovered),
            );
            const savedRecovery = (await recovery()).find(
              (x) => x.receiptId === heldAttempt.receiptId,
            )!;
            assert.equal(savedRecovery.status, "verified_existing");
            assert.equal(savedRecovery.noteId, "92001");
            assert.equal(savedRecovery.canVerify, false);
            const afterLookups = greenhouseRecoveryReads.length;
            assert.equal((await request("POST", recoveryPath, freshRecovery)).status, 200);
            assert.equal(
              greenhouseRecoveryReads.length,
              afterLookups,
              "saved recovery replay performs no provider read or write",
            );
            assert.equal(
              (await request("POST", recoveryPath, { ...freshRecovery, noteId: "92002" })).status,
              409,
            );
            assert.equal(
              greenhouseNotes.length,
              heldCount,
              "recovery never writes another provider note",
            );
            assert.equal(greenhouseInvitations.length, noInvites + 1, "recovery never sends email");
            assert.equal(
              (await notePreview()).canPublish,
              true,
              "new distinct content requires fresh publication approval after original evidence is resolved",
            );
            const recoveredEvents = await dbAdmin
              .select()
              .from(events)
              .where(eq(events.workflowId, c.workflowId));
            assert.equal(
              recoveredEvents.filter((e) => e.action === "ats.interview.note.reconciled").length,
              1,
            );
            const [campaignProfile] = await dbAdmin
              .select()
              .from(atsProfiles)
              .where(eq(atsProfiles.candidateId, createdId));
            assert.ok(campaignProfile);
            await checkAtsCampaignHttp({
              request,
              tenant,
              jobId: source.jobId,
              workflowId: c.workflowId,
              path: importPath.replace(/ats-imports$/, "ats-interview-campaigns"),
              person,
              source,
              profile: campaignProfile,
              planId,
              providerPeople: atsCampaignPeople,
              sendCount: () => greenhouseInvitations.length,
              readCount: () => atsReadPaths.length,
              readMode: (mode) => {
                atsReadMode = mode;
              },
              deliveryMode: (mode) => {
                greenhouseDeliveryMode = mode;
              },
              onRead: (work) => {
                atsReadHook = work;
              },
            });
            // Isolated extra sessions exercise uncertain/simulated transport
            // without permitting real sends or deleting a durable claim.
            const invitationSessionIds = [savedSession.id];
            const invitationProviderSamples: InvitationProviderEvent[] = [];
            for (const mode of ["uncertain", "simulated"] as const) {
              const id = randomUUID();
              invitationSessionIds.push(id);
              await dbAdmin.insert(interviewSessionsTable).values({
                ...savedSession,
                id,
                createdAt: new Date(Date.now() + invitationSessionIds.length * 1000),
              });
              greenhouseDeliveryMode = mode;
              const preview = await request("GET", invitationPath);
              assert.equal(preview.status, 200);
              const input = {
                reviewHash: (preview.body as unknown as Invitation).reviewHash,
                acknowledge: true,
              };
              const count = greenhouseInvitations.length;
              const held = await request("POST", invitationPath, input);
              assert.equal(held.status, 200, JSON.stringify(held.body));
              assert.equal(
                (held.body as unknown as Invitation).status,
                mode === "uncertain" ? "review_required" : "simulated",
              );
              assert.equal((held.body as unknown as Invitation).canSend, false);
              assert.equal((await request("POST", invitationPath, input)).status, 200);
              assert.equal(greenhouseInvitations.length, count + 1, "held attempt cannot resend");
              const [unsent] = await dbAdmin
                .select()
                .from(interviewSessionsTable)
                .where(eq(interviewSessionsTable.id, id));
              assert.equal(unsent.inviteSentAt, null);
              invitationProviderSamples.push(
                await checkInvitationEvidenceHttp({
                  request,
                  path: invitationPath.replace(
                    /interview-invitation$/,
                    "interview-invitation-evidence",
                  ),
                  jobId: source.jobId,
                  workflowId: c.workflowId,
                  recipient: String((preview.body as { recipient?: string }).recipient),
                  simulated: mode === "simulated",
                  sendCount: () => greenhouseInvitations.length,
                  readCount: () => atsReadPaths.length,
                }),
              );
            }
            greenhouseDeliveryMode = "success";
            assert.equal(
              (await request("GET", nextPath)).status,
              200,
              "linked receipt survives GET/reload",
            );
            const afterApps = await dbAdmin
              .select()
              .from(applicationsTable)
              .where(eq(applicationsTable.jobId, source.jobId));
            assert.deepEqual(
              afterApps,
              beforeApps,
              "profile intake neither initializes nor changes native application stages",
            );
            await dbAdmin
              .update(candidatesTable)
              .set({ doNotContact: true })
              .where(eq(candidatesTable.id, createdId));
            const hidden = await request("GET", nextPath);
            assert.equal(hidden.status, 409);
            assert.equal(
              JSON.stringify(hidden.body).includes(createdId),
              false,
              "a private linked profile is never exposed",
            );
            await dbAdmin.transaction(async (tx) => {
              await purgeCandidateLinkedData(tx, createdId!);
            });
            for (const event of invitationProviderSamples)
              assert.equal(
                (await recordInvitationProviderEvent(event)).updated,
                false,
                "late provider callbacks cannot recreate erased invitation evidence",
              );
            const invitationReceipts = await dbAdmin
              .select()
              .from(receipts)
              .where(eq(receipts.tenantId, tenant));
            assert.ok(
              !invitationReceipts.some((x) =>
                invitationSessionIds.some(
                  (id) =>
                    x.key === `gh-interview-invitation:${id}` ||
                    x.key.startsWith(`gh-interview-note:${id}:`),
                ),
              ),
            );
            const invitationEvents = await dbAdmin
              .select()
              .from(events)
              .where(eq(events.tenantId, tenant));
            assert.ok(
              !invitationEvents.some(
                (x) =>
                  (x.action.startsWith("ats.interview.invitation.") ||
                    x.action.startsWith("ats.interview.note.")) &&
                  invitationSessionIds.some((id) => x.note?.includes(id)),
              ),
            );
            assert.equal(
              (await request("GET", nextPath)).status,
              404,
              "erasure removes indirect source metadata",
            );
            await dbAdmin.insert(atsImports).values({
              ...source,
              id: newRecordId,
              externalApplicationId: "304",
              snapshot: {
                ...source.snapshot,
                application: { ...source.snapshot.application, id: "304", candidateId: "505" },
              },
              currentSnapshot: null,
            });
            const callsAfterErasure = atsReadPaths.length;
            assert.equal(
              (await request("POST", nextPath, { ...input, includeProfessional: true })).status,
              409,
              "hashed ATS identity fence prevents later re-import",
            );
            assert.equal(atsReadPaths.length, callsAfterErasure);
          } finally {
            greenhouseDeliveryMode = "success";
            greenhouseNotesEnabled = true;
            greenhouseNoteFailure = false;
            atsProfileIdentity = 202;
            if (createdId)
              await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, createdId));
            await dbAdmin.delete(atsProfiles).where(eq(atsProfiles.tenantId, tenant));
            await dbAdmin.delete(atsImports).where(eq(atsImports.id, newRecordId));
          }
        }
        const refreshInput = {
          ...previewInput,
          expectedRecordRevision: 0,
          idempotencyKey: randomUUID(),
        };
        type RefreshData = {
          record: {
            refreshRevision: number;
            availability: string;
            application: { status: string };
          };
          history: { revision: number; application: { status: string } | null }[];
        };
        const callsBeforeRefreshDenied = atsReadPaths.length;
        for (const [actor, status] of [
          [null, 401],
          ["candidate", 403],
          ["foreign", 404],
          ["platform", 403],
        ] as const) {
          assert.equal(
            (await request("POST", `${recordPath}/refresh`, refreshInput, actor)).status,
            status,
          );
          assert.equal(
            (await request("GET", `${recordPath}/history`, undefined, actor)).status,
            status,
          );
        }
        assert.equal(
          (await request("POST", `${importPath}/foreign-record/refresh`, refreshInput)).status,
          404,
        );
        assert.equal(
          (
            await request("POST", `${recordPath}/refresh`, {
              ...refreshInput,
              expectedRecordRevision: 99,
            })
          ).status,
          409,
        );
        assert.equal(atsReadPaths.length, callsBeforeRefreshDenied);
        const refreshed = await request("POST", `${recordPath}/refresh`, refreshInput);
        assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
        assert.equal((refreshed.body as unknown as RefreshData).record.refreshRevision, 1);
        assert.equal((refreshed.body as unknown as RefreshData).record.availability, "available");
        const readsAfterRefresh = atsReadPaths.length;
        assert.equal((await request("POST", `${recordPath}/refresh`, refreshInput)).status, 200);
        assert.equal(
          atsReadPaths.length,
          readsAfterRefresh,
          "successful refresh replay does not re-read",
        );
        assert.equal(
          (
            await request("POST", `${recordPath}/refresh`, {
              ...refreshInput,
              expectedRecordRevision: 1,
            })
          ).status,
          409,
        );
        const refresh = (revision: number) =>
          request("POST", `${recordPath}/refresh`, {
            ...refreshInput,
            expectedRecordRevision: revision,
            idempotencyKey: randomUUID(),
          });
        atsReadMode = "changed";
        const changed = await refresh(1);
        assert.equal(changed.status, 200);
        const changedData = changed.body as unknown as RefreshData;
        assert.equal(changedData.record.application.status, "rejected");
        assert.equal(
          changedData.history.find((r) => r.revision === 0)?.application?.status,
          "in_process",
        );
        assert.equal(
          changedData.history.find((r) => r.revision === 1)?.application?.status,
          "in_process",
        );
        atsReadMode = "missing";
        const missing = await refresh(2);
        assert.equal(missing.status, 200);
        assert.equal((missing.body as unknown as RefreshData).record.availability, "unavailable");
        assert.equal(
          (missing.body as unknown as RefreshData).record.application.status,
          "rejected",
        );
        assert.equal(
          (missing.body as unknown as RefreshData).history.find((r) => r.revision === 3)
            ?.application,
          null,
        );
        atsReadMode = "success";
        assert.equal((await refresh(3)).status, 200, "a record can become available again");
        for (const [mode, status] of [
          ["failure", 503],
          ["mismatch", 503],
          ["reidentify", 409],
          ["revoke", 409],
        ] as const) {
          atsReadMode = mode;
          const result = await refresh(4);
          assert.equal(result.status, status, JSON.stringify(result.body));
          assert.equal(JSON.stringify(result.body).includes("PRIVATE"), false);
        }
        assert.equal((await request("GET", `${recordPath}/history`)).status, 409);
        await dbAdmin
          .update(atsBindings)
          .set({ status: "active", revision: active.body.bindingRevision })
          .where(eq(atsBindings.tenantId, tenant));
        atsReadMode = "success";
        const afterFailure = await request("GET", `${recordPath}/history`);
        assert.equal(afterFailure.status, 200);
        assert.equal((afterFailure.body as unknown as RefreshData).record.refreshRevision, 4);
        assert.equal((afterFailure.body as unknown as RefreshData).history.length, 5);
        const parallel = await Promise.all([refresh(4), refresh(4)]);
        assert.deepEqual(parallel.map((r) => r.status).sort(), [200, 409]);
        const schedulePath = c.path.replace(/\/offer$/, "/ats-refresh-schedule");
        const savedId = importedData.records[0].id;
        const readSchedule = async () => {
          const r = await request("GET", schedulePath);
          assert.equal(r.status, 200, JSON.stringify(r.body));
          return r.body as unknown as AtsScheduleState;
        };
        const scheduleInput = {
          action: "enable",
          expectedScheduleRevision: 0,
          ...previewInput,
          recordIds: [savedId],
          intervalMinutes: 60,
          acknowledgeReadOnly: true,
        };
        const scheduleReadsBefore = atsReadPaths.length;
        assert.equal((await readSchedule()).schedule, null);
        for (const [actor, status] of [
          [null, 401],
          ["candidate", 403],
          ["foreign", 404],
          ["platform", 403],
          ["recruiter", 403],
        ] as const) {
          assert.equal((await request("POST", schedulePath, scheduleInput, actor)).status, status);
        }
        assert.equal(
          (await request("POST", schedulePath, { ...scheduleInput, acknowledgeReadOnly: false }))
            .status,
          400,
        );
        assert.equal(
          (await request("POST", schedulePath, { ...scheduleInput, recordIds: ["foreign"] }))
            .status,
          404,
        );
        assert.equal(
          (await request("POST", schedulePath, { ...scheduleInput, recordIds: [savedId, savedId] }))
            .status,
          400,
        );
        assert.equal((await request("POST", schedulePath, scheduleInput)).status, 200);
        assert.equal(
          atsReadPaths.length,
          scheduleReadsBefore,
          "schedule reads/configuration never call the provider",
        );
        assert.equal((await request("POST", schedulePath, scheduleInput)).status, 409);
        let scheduleState = await readSchedule();
        assert.equal(scheduleState.schedule!.status, "enabled");
        assert.ok(Date.parse(scheduleState.schedule!.nextRunAt!) > Date.now() + 59 * 60_000);
        const [savedSchedule] = await dbAdmin
          .select()
          .from(atsSchedules)
          .where(eq(atsSchedules.workflowId, c.workflowId));
        const tick = () => runAtsRefreshTick(atsGateway, [savedSchedule.id]);
        const due = () =>
          dbAdmin
            .update(atsSchedules)
            .set({ nextRunAt: new Date(Date.now() - 1000) })
            .where(eq(atsSchedules.id, savedSchedule.id));
        assert.equal((await tick()).processed, 0, "future schedule is not run early");
        await due();
        assert.equal((await tick()).processed, 1);
        scheduleState = await readSchedule();
        assert.equal(scheduleState.runs[0].status, "completed");
        assert.equal(scheduleState.runs[0].items[0].status, "available");
        assert.equal((await tick()).processed, 0, "successful run advances the next due time");
        const [firstRecord] = await dbAdmin
          .select()
          .from(atsImports)
          .where(eq(atsImports.id, savedId));
        const secondId = randomUUID();
        await dbAdmin.insert(atsImports).values({
          ...firstRecord,
          id: secondId,
          externalApplicationId: "304",
          refreshRevision: 0,
          currentSnapshot: null,
          lastCheckedAt: null,
          availability: "unchecked",
          snapshot: {
            ...firstRecord.snapshot,
            application: { ...firstRecord.snapshot.application, id: "304" },
          },
        });
        const reapprove = async (ids = [savedId, secondId]) => {
          const state = await readSchedule();
          const r = await request("POST", schedulePath, {
            ...scheduleInput,
            recordIds: ids,
            expectedScheduleRevision: state.schedule!.revision,
          });
          assert.equal(r.status, 200, JSON.stringify(r.body));
        };
        await reapprove();
        atsReadMode = "missing";
        await due();
        await tick();
        scheduleState = await readSchedule();
        assert.equal(scheduleState.runs[0].status, "completed");
        assert.ok(scheduleState.runs[0].items.every((i) => i.status === "unavailable"));
        atsReadMode = "success";
        await reapprove();
        await due();
        const [beforePausedRecord] = await dbAdmin
          .select()
          .from(atsImports)
          .where(eq(atsImports.id, savedId));
        let releaseRead!: () => void;
        let enteredRead!: () => void;
        const entered = new Promise<void>((resolve) => {
          enteredRead = resolve;
        });
        const held = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        atsReadHook = async () => {
          enteredRead();
          await held;
        };
        const pendingTick = tick();
        await entered;
        assert.equal((await tick()).busy, true, "worker lease excludes a second worker");
        scheduleState = await readSchedule();
        const pause = await request("POST", schedulePath, {
          ...scheduleInput,
          action: "pause",
          expectedScheduleRevision: scheduleState.schedule!.revision,
        });
        assert.equal(pause.status, 200);
        releaseRead();
        await pendingTick;
        scheduleState = await readSchedule();
        assert.equal(scheduleState.schedule!.status, "paused");
        assert.equal(scheduleState.runs[0].status, "stopped");
        assert.deepEqual(
          scheduleState.runs[0].items.map((i) => i.status),
          ["unconfirmed", "not_started"],
        );
        assert.equal((await tick()).processed, 0, "paused work never silently retries");
        const [afterPausedRecord] = await dbAdmin
          .select()
          .from(atsImports)
          .where(eq(atsImports.id, savedId));
        assert.equal(
          afterPausedRecord.refreshRevision,
          beforePausedRecord.refreshRevision,
          "pause fences a late metadata commit",
        );
        await reapprove();
        await due();
        atsReadMode = "revoke";
        await tick();
        await dbAdmin
          .update(atsBindings)
          .set({ status: "active", revision: active.body.bindingRevision })
          .where(eq(atsBindings.tenantId, tenant));
        atsReadMode = "success";
        assert.equal(
          (await readSchedule()).schedule!.status,
          "paused",
          "revocation during provider read stops scheduled work",
        );
        await reapprove();
        atsReadMode = "failure";
        await due();
        const beforeScheduledFailure = atsReadPaths.length;
        await tick();
        assert.equal(atsReadPaths.length, beforeScheduledFailure + 1);
        scheduleState = await readSchedule();
        assert.equal(scheduleState.schedule!.status, "paused");
        assert.deepEqual(
          scheduleState.runs[0].items.map((i) => i.status),
          ["unconfirmed", "not_started"],
        );
        assert.equal(JSON.stringify(scheduleState).includes("PRIVATE"), false);
        atsReadMode = "success";
        await reapprove();
        scheduleState = await readSchedule();
        await dbAdmin.insert(atsScheduledRuns).values({
          id: randomUUID(),
          tenantId: tenant,
          jobId: c.jobId,
          workflowId: c.workflowId,
          scheduleId: savedSchedule.id,
          scheduleRevision: scheduleState.schedule!.revision,
          status: "running",
          startedAt: new Date(),
          items: [
            {
              recordId: savedId,
              expectedRevision: 0,
              status: "available",
              checkedAt: new Date().toISOString(),
            },
            { recordId: secondId, expectedRevision: 0, status: "checking", checkedAt: null },
          ],
        });
        const beforeRecoveryReads = atsReadPaths.length;
        assert.equal((await tick()).interrupted, 1);
        assert.equal(
          atsReadPaths.length,
          beforeRecoveryReads,
          "recovery never replays provider calls",
        );
        scheduleState = await readSchedule();
        assert.equal(scheduleState.runs[0].status, "interrupted");
        assert.deepEqual(
          scheduleState.runs[0].items.map((i) => i.status),
          ["available", "unconfirmed"],
        );
        assert.equal(scheduleState.schedule!.status, "paused");
        await reapprove();
        await due();
        const [approver] = await dbAdmin
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, actorId("admin")));
        assert.ok(approver);
        await dbAdmin
          .update(usersTable)
          .set({ status: "suspended" })
          .where(eq(usersTable.id, approver.id));
        const beforeSuspensionReads = atsReadPaths.length;
        try {
          await tick();
        } finally {
          await dbAdmin
            .update(usersTable)
            .set({ status: approver.status })
            .where(eq(usersTable.id, approver.id));
        }
        assert.equal(atsReadPaths.length, beforeSuspensionReads);
        assert.equal((await readSchedule()).schedule!.status, "paused");
        await dbAdmin.delete(atsImports).where(eq(atsImports.id, secondId));
        atsReadMode = "mismatch";
        assert.equal((await request("POST", importPath, importInput)).status, 503);
        atsReadMode = "failure";
        assert.equal((await request("POST", importPath, importInput)).status, 503);
        atsReadMode = "revoke";
        assert.equal((await request("POST", importPath, importInput)).status, 409);
        assert.equal((await request("GET", importPath)).status, 409);
        await dbAdmin
          .update(atsBindings)
          .set({ status: "active", revision: active.body.bindingRevision })
          .where(eq(atsBindings.tenantId, tenant));
        atsReadMode = "success";
        const nextPage = await request("POST", previewPath, {
          ...previewInput,
          cursor: previewData.nextCursor,
        });
        assert.equal(nextPage.status, 200);
        assert.deepEqual(
          (nextPage.body as unknown as { applications: unknown[] }).applications,
          [],
        );
        assert.equal(atsPagePaths[1], "/v3/applications?cursor=provider-next");
        const callsBeforeInvalid = atsReadPaths.length;
        assert.equal(
          (await request("POST", previewPath, { ...previewInput, cursor: "raw-forged-cursor" }))
            .status,
          409,
        );
        assert.equal(atsReadPaths.length, callsBeforeInvalid);
        for (const mode of ["mismatch", "failure"] as const) {
          atsPreviewMode = mode;
          const bad = await request("POST", previewPath, previewInput);
          assert.equal(bad.status, 503);
          assert.equal(JSON.stringify(bad.body).includes("PRIVATE"), false);
        }
        atsPreviewMode = "revoke";
        assert.equal((await request("POST", previewPath, previewInput)).status, 409);
        // Restore only this isolated fixture for the verification regressions below.
        await dbAdmin
          .update(atsBindings)
          .set({
            status: "active",
            revision: active.body.bindingRevision,
          })
          .where(eq(atsBindings.tenantId, tenant));
        atsPreviewMode = "success";
        atsReadMode = "failure";
        const failed = await act("verify", "admin", { idempotencyKey: randomUUID() });
        assert.equal(failed.status, 200);
        assert.equal(failed.body.history[0].status, "failed");
        assert.equal(JSON.stringify(failed.body).includes("PRIVATE"), false);
        atsReadMode = "mismatch";
        assert.equal(
          (await act("verify", "admin", { idempotencyKey: randomUUID() })).body.history[0].status,
          "failed",
        );
        atsReadMode = "revoke";
        const revoked = await act("verify", "admin", { idempotencyKey: randomUUID() });
        assert.equal(revoked.body.history[0].status, "discarded");
        assert.equal(revoked.body.canVerify, false);
        assert.ok(
          revoked.body.history.every((r: { currentMapping: boolean }) => !r.currentMapping),
        );
        const before = atsReadPaths.length;
        assert.equal((await act("verify", "admin", { idempotencyKey: randomUUID() })).status, 409);
        assert.equal(atsReadPaths.length, before);
        assert.equal(offerEmails.length, emailsBefore);
        assert.equal(
          ((await request("GET", handoff)).body as unknown as AtsHandoffState).connectionState,
          "not_connected",
          "Manual handoff never becomes synchronized after read verification",
        );
        await dbAdmin
          .update(atsBindings)
          .set({ status: "active", revision: active.body.bindingRevision })
          .where(eq(atsBindings.tenantId, tenant));
        atsReadMode = "success";
        const ownershipPath = c.path.replace(/\/offer$/, "/ats-stage-ownership");
        const ownershipState = async () => {
          const result = await request("GET", ownershipPath);
          assert.equal(result.status, 200, JSON.stringify(result.body));
          return result.body as unknown as AtsStageOwnershipState;
        };
        let stageAuthority = await ownershipState();
        assert.equal(stageAuthority.status, "native");
        assert.equal(stageAuthority.canClaim, true);
        const stageInput = {
          action: "claim",
          expectedWorkflowRevision: stageAuthority.workflowRevision,
          expectedOwnershipRevision: stageAuthority.ownershipRevision,
          expectedBindingRevision: stageAuthority.bindingRevision,
          acknowledge: true,
          reason: "Employer explicitly controls hiring stages in its ATS.",
          idempotencyKey: randomUUID(),
        };
        for (const [actor, status] of [
          [null, 401],
          ["candidate", 403],
          ["foreign", 404],
          ["platform", 403],
          ["recruiter", 403],
        ] as const)
          assert.equal((await request("POST", ownershipPath, stageInput, actor)).status, status);
        assert.equal(
          (await request("POST", ownershipPath, { ...stageInput, acknowledge: false })).status,
          400,
        );
        const [ownedRow] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, c.workflowId));
        const ownedApp = (
          await dbAdmin.select().from(applicationsTable).where(eq(applicationsTable.jobId, c.jobId))
        ).find((a) => a.candidateId === ownedRow.candidateId);
        assert.ok(ownedApp);
        const [ownedSource] = await dbAdmin
          .insert(sourcedCandidatesTable)
          .values({
            tenantId: tenant,
            source: "internal",
            normalizedCandidateId: ownedRow.candidateId,
            rawData: { jobId: c.jobId, stage: ownedApp.stage },
          })
          .returning();
        const ownershipReadCount = atsReadPaths.length;
        const secondStageInput = { ...stageInput, idempotencyKey: randomUUID() };
        const claims = await Promise.all([
          request("POST", ownershipPath, stageInput),
          request("POST", ownershipPath, secondStageInput),
        ]);
        assert.deepEqual(claims.map((c) => c.status).sort(), [200, 409]);
        assert.equal(
          atsReadPaths.length,
          ownershipReadCount,
          "ownership declaration performs no provider operation",
        );
        assert.equal(
          (
            await request(
              "POST",
              ownershipPath,
              claims[0].status === 200 ? stageInput : secondStageInput,
            )
          ).status,
          200,
          "exact replay is safe",
        );
        stageAuthority = await ownershipState();
        assert.equal(stageAuthority.status, "external");
        assert.equal(stageAuthority.canRelease, true);
        const policyClient = await pool.connect();
        try {
          await policyClient.query("BEGIN");
          await policyClient.query("SET LOCAL ROLE lexy_app");
          const policy = await policyClient.query(
            "SELECT public.ats_stage_is_external($1,$2) AS owned",
            [ownedRow.candidateId, c.jobId],
          );
          assert.equal(
            policy.rows[0].owned,
            true,
            "app-role transitions can evaluate policy without direct private workflow access",
          );
          const direct = await policyClient.query(
            "SELECT id FROM public.recruiting_workflows WHERE id=$1",
            [c.workflowId],
          );
          assert.equal(
            direct.rowCount,
            0,
            "RLS hides the private workflow while the policy predicate still protects its stages",
          );
        } finally {
          await policyClient.query("ROLLBACK");
          policyClient.release();
        }
        const movement = {
          tenantId: ownedApp.tenantId,
          candidateId: ownedRow.candidateId,
          jobId: c.jobId,
          applicationId: ownedApp.id,
          sourcedId: ownedSource.id,
          to: "interview",
        };
        for (const type of ["user", "hiring_manager", "candidate", "agent", "system"] as const)
          await assert.rejects(
            changeCandidateStage({ ...movement, actor: { type } }),
            AtsStageOwnershipConflict,
          );
        await assert.rejects(
          changeCandidateStage({
            ...movement,
            to: ownedApp.stage,
            actor: { type: "user" },
            applicationPatch: { notes: "must not be patched by a blocked stage command" },
          }),
          AtsStageOwnershipConflict,
        );
        await assert.rejects(
          changeCandidateStage({ ...movement, candidateId: unlinked, actor: { type: "user" } }),
          /identity does not match/,
        );
        const [stillOwnedApp] = await dbAdmin
          .select()
          .from(applicationsTable)
          .where(eq(applicationsTable.id, ownedApp.id));
        const [stillOwnedSource] = await dbAdmin
          .select()
          .from(sourcedCandidatesTable)
          .where(eq(sourcedCandidatesTable.id, ownedSource.id));
        assert.equal(stillOwnedApp.stage, ownedApp.stage);
        assert.equal(stillOwnedApp.notes, ownedApp.notes);
        assert.equal((stillOwnedSource.rawData as { stage: string }).stage, ownedApp.stage);
        const blockedInsert = (error: unknown) =>
          error instanceof Error &&
          (String(error.cause).includes("ATS_STAGE_OWNED") ||
            error.message.includes("ATS_STAGE_OWNED"));
        await assert.rejects(
          dbAdmin.insert(applicationsTable).values({
            tenantId: tenant,
            jobId: c.jobId,
            candidateId: ownedRow.candidateId,
            stage: "hired",
          }),
          blockedInsert,
        );
        await assert.rejects(
          dbAdmin.insert(sourcedCandidatesTable).values({
            tenantId: tenant,
            source: "internal",
            normalizedCandidateId: ownedRow.candidateId,
            rawData: { jobId: c.jobId, stage: "hired" },
          }),
          blockedInsert,
        );
        const [deferredSource] = await dbAdmin
          .insert(sourcedCandidatesTable)
          .values({
            tenantId: tenant,
            source: "internal",
            rawData: { jobId: c.jobId, stage: "sourced" },
          })
          .returning();
        await assert.rejects(
          dbAdmin
            .update(sourcedCandidatesTable)
            .set({ normalizedCandidateId: ownedRow.candidateId })
            .where(eq(sourcedCandidatesTable.id, deferredSource.id)),
          blockedInsert,
        );
        const [deferredIdentity] = await dbAdmin
          .insert(candidatesTable)
          .values({
            tenantId: tenant,
            firstName: "Deferred",
            lastName: "Fixture",
            email: `deferred-${randomUUID()}@ats-fixture.invalid`,
            createdById: ownedRow.createdById,
          })
          .returning();
        const [deferredApp] = await dbAdmin
          .insert(applicationsTable)
          .values({
            tenantId: tenant,
            jobId: c.jobId,
            stage: "sourced",
            candidateId: deferredIdentity.id,
          })
          .returning();
        await assert.rejects(
          dbAdmin
            .update(applicationsTable)
            .set({ candidateId: ownedRow.candidateId })
            .where(eq(applicationsTable.id, deferredApp.id)),
          blockedInsert,
        );
        await dbAdmin
          .delete(sourcedCandidatesTable)
          .where(eq(sourcedCandidatesTable.id, deferredSource.id));
        await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.id, deferredApp.id));
        await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, deferredIdentity.id));
        await dbAdmin
          .update(applicationsTable)
          .set({ notes: "Notes remain editable without a stage action." })
          .where(eq(applicationsTable.id, ownedApp.id));
        await dbAdmin
          .update(workflows)
          .set({ status: "cancelled", revision: sql`${workflows.revision}+1` })
          .where(eq(workflows.id, c.workflowId));
        await dbAdmin
          .update(atsBindings)
          .set({ status: "disconnected", revision: 99 })
          .where(eq(atsBindings.tenantId, tenant));
        await assert.rejects(
          changeCandidateStage({ ...movement, actor: { type: "user" } }),
          AtsStageOwnershipConflict,
        );
        stageAuthority = await ownershipState();
        assert.equal(
          stageAuthority.status,
          "external",
          "disconnect does not transfer stage authority",
        );
        assert.equal(
          stageAuthority.canRelease,
          true,
          "release remains available without provider access",
        );
        const release = await request("POST", ownershipPath, {
          ...stageInput,
          action: "release",
          expectedWorkflowRevision: stageAuthority.workflowRevision,
          expectedOwnershipRevision: stageAuthority.ownershipRevision,
          idempotencyKey: randomUUID(),
          reason: "Employer explicitly resumes future hiring-stage changes in Lexy.",
        });
        assert.equal(release.status, 200, JSON.stringify(release.body));
        assert.equal((release.body as unknown as AtsStageOwnershipState).status, "native");
        const [afterRelease] = await dbAdmin
          .select()
          .from(applicationsTable)
          .where(eq(applicationsTable.id, ownedApp.id));
        assert.equal(
          afterRelease.stage,
          ownedApp.stage,
          "release itself never moves the candidate",
        );
        await changeCandidateStage({ ...movement, actor: { type: "user" } });
        const [afterNativeMove] = await dbAdmin
          .select()
          .from(applicationsTable)
          .where(eq(applicationsTable.id, ownedApp.id));
        assert.equal(afterNativeMove.stage, "interview");
        const [ownershipHistory] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, c.workflowId));
        assert.equal(
          ownershipHistory.steps.find((s) => s.key === "hiring_decision")?.atsStageOwnershipHistory
            ?.length,
          1,
        );
        await dbAdmin
          .delete(sourcedCandidatesTable)
          .where(eq(sourcedCandidatesTable.id, ownedSource.id));
        await dbAdmin.delete(atsChecks).where(eq(atsChecks.workflowId, c.workflowId));
        await dbAdmin.delete(atsBindings).where(eq(atsBindings.tenantId, tenant));
        atsReadMode = "success";
      },
    );
    await t.test(
      "offer inbox is assignment-scoped, privacy-sealed, fresh and never sends automatically",
      async () => {
        const c = await fixture();
        const emailsBefore = offerEmails.length;
        const page = async (actor: Actor | null = "admin", suffix = "") => {
          const r = await request("GET", `/offer-inbox${suffix}`, undefined, actor);
          return { status: r.status, body: r.body as unknown as OfferInboxPage };
        };
        const detail = async (actor: Actor | null = "admin", id = c.workflowId) => {
          const r = await request("GET", `/offer-inbox/${id}`, undefined, actor);
          return { status: r.status, body: r.body as unknown as OfferInboxItem };
        };
        assert.equal((await page(null)).status, 401);
        for (const actor of ["candidate", "interviewer", "platform"] as Actor[])
          assert.equal((await page(actor)).status, 403);
        for (const actor of ["agencyAdmin", "employerApprover", "foreign"] as Actor[]) {
          assert.equal((await page(actor)).body.items.length, 0);
          assert.equal((await detail(actor)).status, 404);
        }
        assert.equal((await detail("admin", randomUUID())).status, 404);
        assert.equal((await page("admin", "?cursor=broken")).status, 400);
        assert.equal((await page("admin", "?limit=51")).status, 400);
        let item = (await detail()).body;
        assert.equal(item.entry.nextAction, "prepare");
        assert.equal(item.entry.testOnly, true);
        assert.deepEqual(item.entry.roles, ["owner", "approver", "sender"]);
        assert.ok(item.entry.warnings.some((s) => /identity/i.test(s)));
        assert.ok(
          item.routing.packet?.evidence.every((s) => s.evidence === "Isolated fixture only."),
        );
        assert.ok((await page()).body.items.some((e) => e.workflowId === c.workflowId));
        assert.equal((await c.act("save_draft", { terms })).status, 200);
        assert.equal((await c.act("submit_review")).status, 200);
        assert.equal((await detail()).body.entry.nextAction, "review");
        assert.equal(
          (await c.act("approve", { reason: "Reviewed this exact synthetic offer version only." }))
            .status,
          200,
        );
        item = (await detail()).body;
        assert.equal(item.entry.nextAction, "send");
        assert.equal(item.offer?.offer?.status, "approved");
        assert.equal(item.offer?.offer?.sentAt, undefined);
        assert.equal(offerEmails.length, emailsBefore);
        const [live] = await dbAdmin.select().from(workflows).where(eq(workflows.id, c.workflowId));
        const expiredSteps = live.steps.map((s) =>
          s.controlledOffer
            ? {
                ...s,
                controlledOffer: {
                  ...s.controlledOffer,
                  terms: {
                    ...s.controlledOffer.terms,
                    expiresAt: new Date(Date.now() - 1000).toISOString(),
                  },
                },
              }
            : s,
        );
        await dbAdmin
          .update(workflows)
          .set({ steps: expiredSteps })
          .where(eq(workflows.id, c.workflowId));
        assert.equal((await detail()).body.entry.nextAction, "prepare");
        assert.ok((await detail()).body.entry.warnings.some((s) => /expired/.test(s)));
        await dbAdmin
          .update(workflows)
          .set({ steps: live.steps })
          .where(eq(workflows.id, c.workflowId));
        await dbAdmin
          .update(candidatesTable)
          .set({ doNotContact: true })
          .where(eq(candidatesTable.id, offerCandidate));
        assert.equal((await page()).body.items.length, 0);
        assert.equal((await detail()).status, 404);
        await dbAdmin
          .update(candidatesTable)
          .set({ doNotContact: false })
          .where(eq(candidatesTable.id, offerCandidate));
        // Existing controlled action withdraws; configuration changes remain exact-revision-bound.
        assert.equal(
          (await c.act("withdraw", { reason: "Retiring only this synthetic inbox approval." }))
            .status,
          200,
        );
        const route = `${c.path}-routing`;
        const current = await request("GET", route);
        const changed = await request("POST", route, {
          mode: "external",
          ownerUserId: actorId("employerApprover"),
          externalSystem: "Greenhouse",
          externalApplicationUrl: "https://app.greenhouse.io/fixtures/inbox",
          expectedRevision: (current.body as unknown as OfferRoutingState).workflowRevision,
          idempotencyKey: randomUUID(),
          reason: "Employer contact handles this manual synthetic handoff.",
        });
        assert.equal(changed.status, 200, JSON.stringify(changed.body));
        assert.equal((await detail()).status, 404);
        const external = await detail("employerApprover");
        assert.equal(external.status, 200);
        assert.equal(external.body.entry.mode, "external");
        assert.equal(external.body.entry.nextAction, "external_handoff");
        assert.deepEqual(external.body.entry.roles, ["contact"]);
        assert.equal(external.body.offer, null);
        assert.ok(external.body.entry.warnings.some((s) => /not a connected/.test(s)));
        assert.equal(offerEmails.length, emailsBefore);
        // Two eligible rows in the same tenant demonstrate stable pagination, without global counts.
        const second = await fixture();
        const third = await fixture();
        const firstPage = await page("admin", "?limit=1");
        assert.equal(firstPage.body.items.length, 1);
        assert.ok(firstPage.body.nextCursor);
        const secondPage = await page(
          "admin",
          `?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor!)}`,
        );
        assert.equal(secondPage.body.items.length, 1);
        assert.notEqual(firstPage.body.items[0].workflowId, secondPage.body.items[0].workflowId);
        assert.deepEqual(
          new Set([firstPage.body.items[0].workflowId, secondPage.body.items[0].workflowId]),
          new Set([second.workflowId, third.workflowId]),
        );
      },
    );
    await t.test(
      "ATS manual handoff requires scoped mappings and fresh human approval without external effects",
      async () => {
        const c = await fixture();
        const external = async (f: typeof c) => {
          const p = f.path.replace(/\/offer$/, "/offer-routing");
          const s = await request("GET", p);
          assert.equal(
            (
              await request("POST", p, {
                expectedRevision: (s.body as unknown as OfferRoutingState).workflowRevision,
                idempotencyKey: randomUUID(),
                mode: "external",
                externalSystem: "Unconnected ATS fixture",
                ownerUserId: actorId("admin"),
                approverUserId: null,
                senderUserId: null,
                reason: "Employer-owned test handoff only; no connection or real offer.",
              })
            ).status,
            200,
          );
        };
        await external(c);
        const path = c.path.replace(/\/offer$/, "/ats-handoff");
        const state = async (actor: Actor | null = "admin") =>
          (await request("GET", path, undefined, actor)).body as unknown as AtsHandoffState;
        const action = async (
          kind: string,
          extra: Record<string, unknown> = {},
          actor: Actor | null = "admin",
        ) =>
          request(
            "POST",
            path,
            {
              action: kind,
              expectedRevision: (await state()).workflowRevision,
              idempotencyKey: randomUUID(),
              ...extra,
            },
            actor,
          );
        const mapping = {
          accountRef: randomUUID(),
          externalJobId: "job-fixture",
          externalCandidateId: "candidate-fixture",
          externalApplicationId: "application-fixture",
        };
        assert.equal((await request("GET", path, undefined, null)).status, 401);
        assert.equal((await request("GET", path, undefined, "foreign")).status, 404);
        assert.equal((await action("save_mapping", { mapping }, "manager")).status, 403);
        assert.equal((await action("save_mapping", { mapping }, "agencyAdmin")).status, 403);
        assert.equal((await action("prepare")).status, 409);
        assert.equal(
          (await action("save_mapping", { mapping: { ...mapping, externalJobId: "   " } })).status,
          400,
        );
        const oldRevision = (await state()).workflowRevision;
        assert.equal((await action("save_mapping", { mapping })).status, 200);
        assert.equal((await action("prepare", { expectedRevision: oldRevision })).status, 409);
        const other = await fixture();
        await external(other);
        const otherPath = other.path.replace(/\/offer$/, "/ats-handoff");
        assert.equal(
          (
            await request("POST", otherPath, {
              action: "save_mapping",
              expectedRevision: (
                (await request("GET", otherPath)).body as unknown as AtsHandoffState
              ).workflowRevision,
              idempotencyKey: randomUUID(),
              mapping,
            })
          ).status,
          409,
          "cross-job collision is rejected",
        );
        const [raw] = await dbAdmin.select().from(workflows).where(eq(workflows.id, c.workflowId));
        await dbAdmin
          .update(workflows)
          .set({
            steps: raw.steps.map((s) => ({
              ...s,
              evidence: "PRIVATE_COACHING_AND_RAW_ANSWERS_MUST_NOT_EXPORT",
            })),
          })
          .where(eq(workflows.id, c.workflowId));
        assert.equal((await action("prepare")).status, 200);
        let packet = (await state()).packet!;
        const exact = () => ({ packetId: packet.id, snapshotHash: packet.snapshotHash });
        assert.equal((await state()).connectionState, "not_connected");
        assert.equal(packet.content.decision.testOnly, true);
        assert.ok(!JSON.stringify(packet).includes("PRIVATE_COACHING_AND_RAW_ANSWERS"));
        const general = await get(c.jobId);
        assert.ok(
          !JSON.stringify(general.body).includes("externalCandidateId"),
          "general workflow state does not expose ATS identifiers",
        );
        assert.equal((await state("recruiter")).mapping, null);
        assert.equal((await action("export", exact())).status, 409);
        assert.equal((await action("approve", exact())).status, 400);
        assert.equal(
          (await action("approve", { ...exact(), acknowledgeReview: true })).status,
          200,
        );
        const exportKey = randomUUID();
        const exported = await action("export", { ...exact(), idempotencyKey: exportKey });
        assert.equal(exported.status, 200);
        assert.equal(
          (exported.body as unknown as AtsHandoffState).exportPacket!.content.offerOwner,
          "external_employer",
        );
        const exportRevision = (await state()).workflowRevision;
        assert.equal(
          (
            await action("export", {
              ...exact(),
              idempotencyKey: exportKey,
              expectedRevision: exportRevision - 1,
            })
          ).status,
          200,
          "identical export replay is safe",
        );
        assert.equal((await state()).workflowRevision, exportRevision);
        assert.equal((await action("record_handoff", exact())).status, 400);
        assert.equal(
          (
            await action("record_handoff", {
              ...exact(),
              acknowledgeReview: true,
              evidenceReference: "https://not-a-case.invalid",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await action(
              "record_handoff",
              { ...exact(), acknowledgeReview: true, evidenceReference: "HR-CASE-123" },
              "recruiter",
            )
          ).status,
          403,
        );
        const handoffKey = randomUUID();
        const handoffInput = {
          ...exact(),
          expectedRevision: (await state()).workflowRevision,
          acknowledgeReview: true,
          evidenceReference: "HR-CASE-123",
          idempotencyKey: handoffKey,
        };
        assert.equal((await action("record_handoff", handoffInput)).status, 200);
        assert.equal((await state()).packet!.handoffReceipt!.verification, "human_reported_only");
        const recordedRevision = (await state()).workflowRevision;
        assert.equal(
          (await action("record_handoff", handoffInput)).status,
          200,
          "Same request is idempotent",
        );
        assert.equal((await state()).workflowRevision, recordedRevision);
        assert.equal(
          (
            await action("record_handoff", {
              ...exact(),
              acknowledgeReview: true,
              evidenceReference: "HR-NEW",
            })
          ).status,
          409,
        );
        const [changed] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, c.workflowId));
        await dbAdmin
          .update(workflows)
          .set({
            steps: changed.steps.map((s) =>
              s.humanDecision
                ? {
                    ...s,
                    humanDecision: {
                      ...s.humanDecision,
                      reason: "Corrected human decision requires fresh review.",
                    },
                  }
                : s,
            ),
          })
          .where(eq(workflows.id, c.workflowId));
        assert.equal((await state()).stale, true);
        assert.equal((await action("export", exact())).status, 409);
        assert.equal(
          (await action("approve", { ...exact(), acknowledgeReview: true })).status,
          409,
        );
        assert.equal((await action("prepare")).status, 200);
        packet = (await state()).packet!;
        assert.notEqual(packet.id, (exported.body as unknown as AtsHandoffState).exportPacket!.id);
        assert.equal(packet.approvedAt, undefined);
        assert.equal(
          packet.handoffReceipt,
          undefined,
          "A new snapshot cannot inherit manual handoff authority",
        );
        assert.equal((await action("clear_mapping")).status, 400);
        assert.equal((await action("clear_mapping", { acknowledgeReview: true })).status, 200);
        assert.equal((await state()).mapping, null);
        const [archived] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, c.workflowId));
        assert.ok(
          archived.steps
            .find((s) => s.key === "hiring_decision")!
            .atsHandoffHistory!.some((r) => r.packet?.exportedAt),
          "previous exports remain recorded after remapping/clear",
        );
        assert.equal(
          (await c.act("save_draft", { terms })).status,
          403,
          "external and native offer send paths cannot coexist",
        );
      },
    );
    await t.test(
      "offer authority belongs to explicitly designated employer humans, not recruiting roles",
      async () => {
        const c = await fixture();
        const [row] = await dbAdmin.select().from(workflows).where(eq(workflows.id, c.workflowId));
        const initial = row.steps.map((s) => {
          const next = { ...s };
          delete next.offerRouting;
          return next;
        });
        await dbAdmin
          .update(workflows)
          .set({ steps: initial })
          .where(eq(workflows.id, c.workflowId));
        assert.equal(
          await hasControlledOffer(c.jobId, row.candidateId),
          true,
          "An unconfigured managed hiring decision must not fall through legacy offer/fee actions",
        );
        const routingPath = c.path.replace(/\/offer$/, "/offer-routing");
        const readRouting = async () => {
          const response = await request("GET", routingPath);
          return { ...response, body: response.body as unknown as OfferRoutingState };
        };
        const configure = async (
          extra: Record<string, unknown> = {},
          actor: Actor | null = "admin",
        ) => {
          const state = await readRouting();
          const response = await request(
            "POST",
            routingPath,
            {
              idempotencyKey: randomUUID(),
              expectedRevision: state.body.workflowRevision,
              reason: "Employer explicitly assigns human offer authority.",
              mode: "native",
              ownerUserId: actorId("admin"),
              approverUserId: actorId("employerApprover"),
              senderUserId: actorId("admin"),
              ...extra,
            },
            actor,
          );
          return { ...response, body: response.body as unknown as OfferRoutingState };
        };
        assert.equal((await readRouting()).body.canConfigure, true);
        assert.equal((await c.read()).body.canApprove, false);
        assert.equal((await c.act("save_draft", { terms })).status, 403);
        assert.equal((await configure({}, null)).status, 401);
        assert.equal((await configure({}, "agencyAdmin")).status, 403);
        assert.equal((await configure({}, "manager")).status, 403);
        assert.equal((await configure({}, "platform")).status, 403);
        assert.equal((await configure({}, "recruiter")).status, 403);
        assert.equal((await configure({}, "foreign")).status, 404);
        assert.equal((await configure({ ownerUserId: actorId("foreign") })).status, 404);
        assert.equal((await configure({ ownerUserId: actorId("manager") })).status, 404);
        assert.equal((await configure()).status, 200);
        assert.equal((await c.read()).body.canApprove, false);
        assert.equal((await c.read()).body.canSend, true);
        assert.equal((await c.read("employerApprover")).body.canEdit, false);
        assert.equal((await c.read("employerApprover")).body.canApprove, true);
        assert.equal((await c.read("employerApprover")).body.canSend, false);
        assert.equal((await c.act("save_draft", { terms }, "employerApprover")).status, 403);
        assert.equal((await c.act("save_draft", { terms })).status, 200);
        assert.equal((await c.act("submit_review")).status, 200);
        assert.equal((await c.act("approve")).status, 403);
        assert.equal((await c.act("approve", {}, "manager")).status, 403);
        assert.equal((await c.act("approve", {}, "employerApprover")).status, 200);
        assert.equal((await c.act("send", {}, "employerApprover")).status, 403);
        assert.equal(
          (await configure()).status,
          409,
          "Changing assignments must not inherit an approved offer",
        );
        assert.equal(
          (
            await c.act("withdraw", {
              reason: "Explicit withdrawal before a manual external handoff.",
            })
          ).status,
          200,
        );
        const deliveredBefore = offerEmails.length;
        assert.equal(
          (
            await configure({
              mode: "external",
              ownerUserId: null,
              approverUserId: null,
              senderUserId: null,
              externalSystem: "Greenhouse",
              externalApplicationUrl: "javascript:alert(1)",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await configure({
              mode: "external",
              ownerUserId: null,
              approverUserId: null,
              senderUserId: null,
              externalSystem: "Greenhouse",
              externalApplicationUrl: "https://user:password@example.invalid/app",
            })
          ).status,
          400,
        );
        const external = await configure({
          mode: "external",
          ownerUserId: null,
          approverUserId: null,
          senderUserId: null,
          externalSystem: "Greenhouse",
          externalApplicationUrl: "https://app.greenhouse.io/",
        });
        assert.equal(external.status, 200);
        assert.equal(external.body.handoffStatus, "awaiting_employer");
        assert.equal(
          await hasControlledOffer(c.jobId, row.candidateId),
          true,
          "External ownership blocks legacy native offer and acceptance/fee actions even without a native offer record",
        );
        assert.ok(external.body.packet);
        assert.equal(external.body.packet.testOnly, true);
        assert.equal(external.body.packet.decision, "hire");
        assert.equal(external.body.packet.evidence.length, 6);
        const competingId = randomUUID();
        await dbAdmin.insert(workflows).values({ ...row, id: competingId, steps: initial });
        assert.equal(
          (
            await request(
              "POST",
              `/jobs/${c.jobId}/candidate-workflows/${competingId}/offer-routing`,
              {
                idempotencyKey: randomUUID(),
                expectedRevision: row.revision,
                reason: "Do not create a competing offer process for the same application.",
                mode: "native",
                ownerUserId: actorId("admin"),
                approverUserId: actorId("admin"),
                senderUserId: actorId("admin"),
              },
            )
          ).status,
          409,
        );
        for (const action of ["save_draft", "submit_review", "approve", "send", "withdraw"])
          assert.equal(
            (await c.act(action, { terms, reason: "Not an authorised native offer process." }))
              .status,
            403,
          );
        assert.equal((await c.read()).body.eligible, false);
        assert.equal(
          offerEmails.length,
          deliveredBefore,
          "External routing never dispatches an email",
        );
        const [after] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, c.workflowId));
        assert.deepEqual(after.steps.slice(0, 5), initial.slice(0, 5));
        assert.equal(
          after.steps.at(-1)?.humanDecision?.reason,
          initial.at(-1)?.humanDecision?.reason,
        );
        assert.equal(after.steps.at(-1)?.offerRoutingHistory?.length, 1);
        await dbAdmin
          .update(workflows)
          .set({
            steps: after.steps.map((s) =>
              s.key === "hiring_decision"
                ? {
                    ...s,
                    humanDecision: { ...s.humanDecision!, outcome: "hold" },
                  }
                : s,
            ),
          })
          .where(eq(workflows.id, c.workflowId));
        assert.equal((await readRouting()).body.handoffStatus, "paused");
      },
    );
    await t.test(
      "ownership recovery replaces only unavailable employer staff and resets unsent approval once",
      async () => {
        const c = await fixture();
        const path = c.path.replace(/\/offer$/, "/offer-routing");
        const routing = async () =>
          (await request("GET", path)).body as unknown as OfferRoutingState;
        const configuration = {
          mode: "native",
          ownerUserId: actorId("admin"),
          approverUserId: actorId("employerApprover"),
          senderUserId: actorId("admin"),
          reason: "Explicitly designate this employer's staff for the isolated offer.",
        };
        assert.equal(
          (
            await request("POST", path, {
              ...configuration,
              expectedRevision: (await routing()).workflowRevision,
              idempotencyKey: randomUUID(),
            })
          ).status,
          200,
        );
        await c.act("save_draft", { terms });
        await c.act("submit_review", { reason: "Review these exact synthetic terms." });
        assert.equal(
          (
            await c.act(
              "approve",
              { reason: "Approve this synthetic version only." },
              "employerApprover",
            )
          ).status,
          200,
        );
        const [before] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, c.workflowId));
        const originalOffer = before.steps.at(-1)!.controlledOffer!;
        const mailCount = offerEmails.length;
        await dbAdmin
          .update(usersTable)
          .set({ status: "suspended" })
          .where(eq(usersTable.id, actorId("employerApprover")));
        try {
          const st = await routing();
          assert.deepEqual(st.recovery?.unavailableRoles, ["approver"]);
          assert.equal(st.recovery?.canRecover, true);
          assert.equal(st.recovery?.resetsApproval, true);
          const data = {
            ...configuration,
            approverUserId: actorId("admin"),
            expectedRevision: st.workflowRevision,
            idempotencyKey: randomUUID(),
            acknowledgeOwnershipRecovery: true,
            reason: "Replace the suspended approver; keep terms and the other assignees.",
          };
          assert.equal(
            (await request("POST", path, { ...data, acknowledgeOwnershipRecovery: false })).status,
            409,
          );
          assert.equal(
            (await request("POST", path, { ...data, reason: " ".repeat(12) })).status,
            400,
          );
          assert.equal(
            (await request("POST", path, { ...data, acknowledgeExistingOffer: true })).status,
            400,
          );
          assert.equal((await request("POST", path, { ...data, mode: "external" })).status, 400);
          assert.equal(
            (await request("POST", path, { ...data, ownerUserId: actorId("employerApprover") }))
              .status,
            409,
          );
          assert.equal(
            (await request("POST", path, { ...data, approverUserId: actorId("agencyAdmin") }))
              .status,
            404,
          );
          assert.equal((await request("POST", path, data, "manager")).status, 403);
          assert.equal((await request("POST", path, data, "agencyAdmin")).status, 403);
          assert.equal((await request("POST", path, data, "foreign")).status, 404);
          const hidden = await request("GET", path, undefined, "foreign");
          assert.equal(hidden.status, 404);
          assert.equal(
            (await request("POST", path, { ...data, expectedRevision: st.workflowRevision - 1 }))
              .status,
            409,
          );
          assert.equal((await request("POST", path, data)).status, 200);
          const afterState = await routing();
          assert.equal(afterState.recovery, null);
          assert.equal(afterState.workflowRevision, st.workflowRevision + 1);
          assert.equal(
            (await request("POST", path, data)).status,
            200,
            "Same recovery replays without resetting twice.",
          );
          assert.equal((await routing()).workflowRevision, afterState.workflowRevision);
          const [after] = await dbAdmin
            .select()
            .from(workflows)
            .where(eq(workflows.id, c.workflowId));
          const step = after.steps.at(-1)!;
          const recovered = step.controlledOffer!;
          assert.equal(recovered.status, "draft");
          assert.equal(recovered.approvedBy, undefined);
          assert.equal(recovered.approvedAt, undefined);
          assert.equal(recovered.id, originalOffer.id);
          assert.equal(recovered.version, originalOffer.version);
          assert.deepEqual(recovered.terms, originalOffer.terms);
          assert.deepEqual(step.controlledOfferHistory?.at(-1), originalOffer);
          assert.deepEqual(step.offerRoutingHistory?.at(-1), before.steps.at(-1)!.offerRouting);
          assert.deepEqual(step.humanDecision, before.steps.at(-1)!.humanDecision);
          assert.deepEqual(after.steps.slice(0, 5), before.steps.slice(0, 5));
          assert.equal(after.status, before.status);
          assert.equal(
            (await c.act("send")).status,
            409,
            "Fresh human review and approval remain mandatory.",
          );
          assert.equal(offerEmails.length, mailCount);
        } finally {
          await dbAdmin
            .update(usersTable)
            .set({ status: "active" })
            .where(eq(usersTable.id, actorId("employerApprover")));
        }
      },
    );
    await t.test(
      "recovery preserves delivered responses and blocks unavailable authority during uncertain delivery",
      async () => {
        const mailCount = offerEmails.length;
        for (const status of [
          "draft",
          "review_required",
          "sent",
          "accepted",
          "declined",
          "sending",
          "send_uncertain",
          "approved",
        ] as const) {
          const c = await fixture();
          await c.act("save_draft", { terms });
          const [row] = await dbAdmin
            .select()
            .from(workflows)
            .where(eq(workflows.id, c.workflowId));
          const delivered = ["sent", "accepted", "declined"].includes(status);
          const final = row.steps.at(-1)!;
          const offer = {
            ...final.controlledOffer!,
            status,
            ...(status !== "draft"
              ? { approvedBy: "Original isolated approver", approvedAt: new Date().toISOString() }
              : {}),
            ...(delivered
              ? {
                  sentAt: new Date().toISOString(),
                  deliveryReceiptId: "synthetic-receipt",
                  deliveryStartedAt: new Date().toISOString(),
                  tokenHash: "synthetic-capability-hash",
                }
              : {}),
            ...(["accepted", "declined"].includes(status)
              ? {
                  respondedAt: new Date().toISOString(),
                  responseReason: "Fictional response, not employment.",
                }
              : {}),
            ...(["sending", "send_uncertain", "approved"].includes(status)
              ? {
                  deliveryStartedAt: new Date(Date.now() - 600000).toISOString(),
                }
              : {}),
          };
          const previousConfig = {
            ...final.offerRouting!,
            ownerUserId: actorId("employerApprover"),
            approverUserId: actorId("employerApprover"),
            senderUserId: actorId("employerApprover"),
          };
          await dbAdmin
            .update(workflows)
            .set({
              steps: row.steps.map((s) =>
                s.key === "hiring_decision"
                  ? { ...s, offerRouting: previousConfig, controlledOffer: offer }
                  : s,
              ),
            })
            .where(eq(workflows.id, c.workflowId));
          await dbAdmin
            .update(usersTable)
            .set({ status: "suspended" })
            .where(eq(usersTable.id, actorId("employerApprover")));
          try {
            const path = c.path.replace(/\/offer$/, "/offer-routing");
            const st = (await request("GET", path)).body as unknown as OfferRoutingState;
            assert.deepEqual(st.recovery?.unavailableRoles, ["owner", "approver", "sender"]);
            const blocked = ["sending", "send_uncertain", "approved"].includes(status);
            assert.equal(st.recovery?.canRecover, !blocked);
            const r = await request("POST", path, {
              mode: "native",
              ownerUserId: actorId("admin"),
              approverUserId: actorId("admin"),
              senderUserId: actorId("admin"),
              expectedRevision: st.workflowRevision,
              idempotencyKey: randomUUID(),
              acknowledgeOwnershipRecovery: true,
              reason:
                "Recover unavailable staff without changing the synthetic offer or its delivery.",
            });
            assert.equal(r.status, blocked ? 409 : 200, status);
            const [after] = await dbAdmin
              .select()
              .from(workflows)
              .where(eq(workflows.id, c.workflowId));
            const recovered = after.steps.at(-1)!.controlledOffer!;
            if (status === "review_required") {
              assert.equal(recovered.status, "draft");
              assert.equal(recovered.approvedBy, undefined);
              assert.deepEqual(after.steps.at(-1)!.controlledOfferHistory?.at(-1), offer);
            } else assert.deepEqual(recovered, offer, status);
            assert.deepEqual(after.steps.slice(0, 5), row.steps.slice(0, 5));
            if (blocked) assert.deepEqual(after.steps.at(-1)!.offerRouting, previousConfig);
            if (delivered)
              assert.equal((await c.act("send")).status, 409, "Do not resend a delivered version.");
          } finally {
            await dbAdmin
              .update(usersTable)
              .set({ status: "active" })
              .where(eq(usersTable.id, actorId("employerApprover")));
          }
        }
        const normal = await fixture();
        await normal.act("save_draft", { terms });
        assert.equal(
          (
            await request("POST", normal.path.replace(/\/offer$/, "/offer-routing"), {
              mode: "native",
              ownerUserId: actorId("admin"),
              approverUserId: actorId("admin"),
              senderUserId: actorId("admin"),
              acknowledgeOwnershipRecovery: true,
              expectedRevision: (await normal.read()).body.workflowRevision,
              idempotencyKey: randomUUID(),
              reason: "Do not bypass ordinary ownership locks when all assignees remain eligible.",
            })
          ).status,
          409,
        );
        assert.equal(offerEmails.length, mailCount);
      },
    );
    await t.test(
      "legacy native ownership adoption preserves sent responses and resets unsent approval",
      async () => {
        for (const sent of [false, true]) {
          const c = await fixture();
          await c.act("save_draft", { terms });
          await c.act("submit_review");
          await c.act("approve");
          if (sent) assert.equal((await c.act("send")).status, 200);
          const [row] = await dbAdmin
            .select()
            .from(workflows)
            .where(eq(workflows.id, c.workflowId));
          const priorOffer = row.steps.at(-1)!.controlledOffer!;
          await dbAdmin
            .update(workflows)
            .set({
              steps: row.steps.map((s) => {
                const next = { ...s };
                delete next.offerRouting;
                return next;
              }),
            })
            .where(eq(workflows.id, c.workflowId));
          const path = c.path.replace(/\/offer$/, "/offer-routing");
          const payload = {
            idempotencyKey: randomUUID(),
            expectedRevision: row.revision,
            reason: "Explicit employer adoption of an unchanged legacy native offer.",
            mode: "native",
            ownerUserId: actorId("admin"),
            approverUserId: actorId("admin"),
            senderUserId: actorId("admin"),
          };
          assert.equal((await request("POST", path, payload)).status, 409);
          assert.equal(
            (await request("POST", path, { ...payload, acknowledgeExistingOffer: true })).status,
            200,
          );
          const [after] = await dbAdmin
            .select()
            .from(workflows)
            .where(eq(workflows.id, c.workflowId));
          const offer = after.steps.at(-1)!.controlledOffer!;
          assert.deepEqual(after.steps.slice(0, 5), row.steps.slice(0, 5));
          assert.deepEqual(offer.terms, priorOffer.terms);
          if (sent) assert.deepEqual(offer, priorOffer);
          else {
            assert.equal(offer.status, "draft");
            assert.equal(offer.approvedBy, undefined);
            assert.equal((await c.act("send")).status, 409);
          }
        }
      },
    );
    async function correct(
      f: Awaited<ReturnType<typeof fixture>>,
      extra: Record<string, unknown> = {},
      actor: Actor | null = "admin",
    ) {
      const state = await f.read();
      return post(
        f.jobId,
        `candidate-workflows/${f.workflowId}/decision-correction`,
        {
          idempotencyKey: randomUUID(),
          expectedRevision: state.body.workflowRevision,
          outcome: "hold",
          decisionReason: "Further review is needed before hiring.",
          correctionReason: "Original hiring intent requires a second evidence review.",
          ...extra,
        },
        actor,
      );
    }
    await t.test(
      "decision correction preserves evidence/history, clears unsent approval and never creates employment or fees",
      async () => {
        const c = await fixture();
        await c.act("save_draft", { terms });
        await c.act("submit_review");
        await c.act("approve");
        const before = (await get(c.jobId)).body.workflows[0];
        const previous = before.steps.at(-1)!;
        const input = {
          idempotencyKey: randomUUID(),
          expectedRevision: before.revision,
          outcome: "hold",
          decisionReason: "Further evidence review needed before deciding.",
          correctionReason: "The original decision overlooked an unresolved question.",
        };
        const suffix = `candidate-workflows/${c.workflowId}/decision-correction`;
        assert.equal((await post(c.jobId, suffix, input, "recruiter")).status, 403);
        assert.equal((await post(c.jobId, suffix, input, "interviewer")).status, 403);
        assert.equal((await post(c.jobId, suffix, input, null)).status, 401);
        assert.equal((await post(c.jobId, suffix, input, "foreign")).status, 404);
        assert.equal((await post(c.jobId, suffix, { ...input, actorId: "forged" })).status, 400);
        assert.equal((await post(c.jobId, suffix, { ...input, testOnly: false })).status, 400);
        assert.equal(
          (await post(c.jobId, suffix, { ...input, correctionReason: "          " })).status,
          400,
        );
        assert.equal(
          (await post(c.jobId, suffix, { ...input, decisionReason: "short" })).status,
          400,
        );
        assert.equal(
          (await post(c.jobId, suffix, { ...input, expectedRevision: before.revision - 1 })).status,
          409,
        );
        assert.equal((await post(c.jobId, suffix, input)).status, 200);
        assert.equal((await post(c.jobId, suffix, input)).body.replayed, true);
        assert.equal((await post(c.jobId, suffix, { ...input, outcome: "decline" })).status, 409);
        const after = (await get(c.jobId)).body.workflows[0];
        const final = after.steps.at(-1)!;
        assert.equal(after.status, "ready");
        assert.equal(after.revision, before.revision + 1);
        assert.equal(final.evidence, previous.evidence);
        assert.deepEqual(final.humanDecisionHistory, [previous.humanDecision]);
        assert.equal(final.humanDecision?.outcome, "hold");
        assert.equal(final.humanDecision?.actorId, actorId("admin"));
        assert.equal(final.humanDecision?.testOnly, true);
        assert.equal(final.humanDecision?.correctionReason, input.correctionReason);
        assert.equal(final.humanDecision?.supersedesDecidedAt, previous.humanDecision?.decidedAt);
        assert.equal(final.humanDecision?.offerEffect, "approval_reset");
        const offers = (await c.read()).body;
        assert.equal(offers.offer?.status, "draft");
        assert.equal(offers.offer?.version, 2);
        assert.notEqual(offers.offer?.id, previous.controlledOffer?.id);
        assert.equal(offers.offer?.approvedBy, undefined);
        assert.equal(offers.history.at(-1)?.status, "approved");
        assert.equal((await c.act("send")).status, 409);
        assert.equal((await correct(c, { outcome: "decline" })).status, 200);
        const decided = (await get(c.jobId)).body.workflows[0];
        assert.equal(decided.status, "completed");
        assert.equal(decided.steps.at(-1)?.humanDecisionHistory?.length, 2);
        assert.equal(decided.steps.at(-1)?.humanDecisionHistory?.[0].outcome, "hire");
        assert.equal(decided.steps.at(-1)?.humanDecisionHistory?.[1].outcome, "hold");
        const [app] = await dbAdmin
          .select()
          .from(applicationsTable)
          .where(eq(applicationsTable.jobId, c.jobId));
        assert.equal(app.stage, "applied");
        const outcomes = await dbAdmin.execute(
          sql`SELECT count(*) AS count FROM candidate_outcomes WHERE candidate_id=${offerCandidate}`,
        );
        const fees = await dbAdmin.execute(
          sql`SELECT count(*) AS count FROM fee_line_items WHERE candidate_id=${offerCandidate}`,
        );
        assert.equal(Number(outcomes.rows[0].count), 0);
        assert.equal(Number(fees.rows[0].count), 0);
      },
    );
    await t.test(
      "sent and accepted offers require acknowledgement and remain valid after a corrected decision",
      async () => {
        const c = await fixture();
        await c.act("save_draft", { terms });
        await c.act("submit_review");
        await c.act("approve");
        assert.equal((await c.act("send")).status, 200);
        const publicPath = `/controlled-offers/public/${offerEmails.at(-1)!.match(/\/offer\/([a-f0-9]{64})/)![1]}`;
        const original = (await c.read()).body.offer;
        assert.equal((await correct(c, { outcome: "decline" })).status, 409);
        assert.equal(
          (await correct(c, { outcome: "decline", acknowledgeDeliveredOffer: true })).status,
          200,
        );
        assert.deepEqual((await c.read()).body.offer, original);
        assert.equal((await request("GET", publicPath, undefined, null)).status, 200);
        assert.equal((await request("POST", publicPath, { decision: "accept" }, null)).status, 200);
        assert.equal((await correct(c)).status, 409);
        assert.equal((await correct(c, { acknowledgeDeliveredOffer: true })).status, 200);
        assert.equal((await c.read()).body.offer?.status, "accepted");
        const current = (await get(c.jobId)).body.workflows[0];
        assert.equal(current.steps.at(-1)?.humanDecision?.offerEffect, "sent_retained");
        assert.equal(current.status, "ready");
      },
    );
    await t.test(
      "legacy completion requires explicit new intent and preserves earlier evidence without effects",
      async () => {
        const c = await fixture();
        const [original] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, c.workflowId));
        const legacySteps = original.steps.map((s) => {
          if (s.key !== "hiring_decision") return s;
          const { humanDecision: _, ...rest } = s;
          return { ...rest, evidence: "Historical completion note is not an inferred Hire." };
        });
        await dbAdmin
          .update(workflows)
          .set({ status: "completed", steps: legacySteps })
          .where(eq(workflows.id, c.workflowId));
        assert.equal((await correct(c, { outcome: "hire" })).status, 409);
        const input = {
          outcome: "hire",
          acknowledgeLegacyCompletion: true,
          expectedRevision: (await c.read()).body.workflowRevision,
          idempotencyKey: randomUUID(),
        };
        assert.equal((await correct(c, input, "recruiter")).status, 403);
        const recorded = await correct(c, input);
        assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
        assert.equal((await correct(c, input)).body.replayed, true);
        const wf = (await get(c.jobId)).body.workflows[0];
        assert.deepEqual(wf.steps.slice(0, -1), legacySteps.slice(0, -1));
        const decision = wf.steps.at(-1)!;
        assert.equal(decision.evidence, legacySteps.at(-1)!.evidence);
        assert.equal(decision.humanDecision?.outcome, "hire");
        assert.equal(decision.humanDecision?.testOnly, true);
        assert.equal(decision.humanDecision?.supersedesDecidedAt, undefined);
        assert.deepEqual(decision.humanDecisionHistory, []);
        assert.equal((await correct(c, { acknowledgeLegacyCompletion: true })).status, 400);
        assert.equal((await c.act("save_draft", { terms })).status, 200);
        assert.equal((await c.act("send")).status, 409);
        assert.equal((await c.act("submit_review")).status, 200);
        assert.equal((await c.act("approve")).status, 200);
        assert.equal((await c.act("send")).status, 200);
        const publicPath = `/controlled-offers/public/${offerEmails.at(-1)!.match(/\/offer\/([a-f0-9]{64})/)![1]}`;
        assert.equal((await request("POST", publicPath, { decision: "accept" }, null)).status, 200);
        assert.equal((await c.read()).body.offer?.status, "accepted");
        const [app] = await dbAdmin
          .select()
          .from(applicationsTable)
          .where(eq(applicationsTable.jobId, c.jobId));
        assert.equal(app.stage, "applied");
        const outcomes = await dbAdmin.execute(
          sql`SELECT count(*) AS count FROM candidate_outcomes WHERE candidate_id=${offerCandidate}`,
        );
        const fees = await dbAdmin.execute(
          sql`SELECT count(*) AS count FROM fee_line_items WHERE candidate_id=${offerCandidate}`,
        );
        assert.equal(Number(outcomes.rows[0].count), 0);
        assert.equal(Number(fees.rows[0].count), 0);
      },
    );
    await t.test(
      "corrections reject in-flight, stale, cancelled, legacy and hidden records; concurrency saves once",
      async () => {
        const c = await fixture(),
          other = await fixture();
        assert.equal(
          (
            await post(c.jobId, `candidate-workflows/${other.workflowId}/decision-correction`, {
              idempotencyKey: randomUUID(),
              expectedRevision: 0,
              outcome: "hold",
              decisionReason: "A valid independent decision reason.",
              correctionReason: "Correcting the previous decision reason.",
            })
          ).status,
          404,
        );
        const revision = (await c.read()).body.workflowRevision;
        const results = await Promise.all([
          correct(c, { expectedRevision: revision, outcome: "decline" }),
          correct(c, { expectedRevision: revision, outcome: "hold" }),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(
          (await get(c.jobId)).body.workflows[0].steps.at(-1)?.humanDecisionHistory?.length,
          1,
        );
        await dbAdmin
          .update(workflows)
          .set({ status: "cancelled" })
          .where(eq(workflows.id, c.workflowId));
        assert.equal((await correct(c)).status, 409);
        await dbAdmin
          .update(workflows)
          .set({ status: "paused" })
          .where(eq(workflows.id, c.workflowId));
        assert.equal((await correct(c)).status, 409);
        await dbAdmin
          .update(jobsTable)
          .set({ description: "Changed brief invalidates the original approved journey." })
          .where(eq(jobsTable.id, other.jobId));
        assert.equal((await correct(other)).status, 409);
        const sending = await fixture();
        await sending.act("save_draft", { terms });
        const [row] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, sending.workflowId));
        await dbAdmin
          .update(workflows)
          .set({
            steps: row.steps.map((s) =>
              s.controlledOffer
                ? {
                    ...s,
                    controlledOffer: {
                      ...s.controlledOffer,
                      status: "sending",
                      deliveryStartedAt: new Date().toISOString(),
                    },
                  }
                : s,
            ),
          })
          .where(eq(workflows.id, row.id));
        assert.equal((await correct(sending, { acknowledgeDeliveredOffer: true })).status, 409);
        const legacy = await fixture();
        const [old] = await dbAdmin
          .select()
          .from(workflows)
          .where(eq(workflows.id, legacy.workflowId));
        await dbAdmin
          .update(workflows)
          .set({
            steps: old.steps.map((s) => {
              if (s.key !== "hiring_decision") return s;
              const { humanDecision: _, ...rest } = s;
              return rest;
            }),
          })
          .where(eq(workflows.id, old.id));
        assert.equal((await correct(legacy)).status, 409);
        const hidden = await fixture();
        const hiddenRevision = (await hidden.read()).body.workflowRevision;
        try {
          await dbAdmin
            .update(candidatesTable)
            .set({ doNotContact: true })
            .where(eq(candidatesTable.id, offerCandidate));
          assert.equal(
            (
              await post(
                hidden.jobId,
                `candidate-workflows/${hidden.workflowId}/decision-correction`,
                {
                  idempotencyKey: randomUUID(),
                  expectedRevision: hiddenRevision,
                  outcome: "hold",
                  decisionReason: "A valid independent decision reason.",
                  correctionReason: "Correcting the previous decision reason.",
                },
              )
            ).status,
            404,
          );
        } finally {
          await dbAdmin
            .update(candidatesTable)
            .set({ doNotContact: false })
            .where(eq(candidatesTable.id, offerCandidate));
        }
      },
    );
    const f = await fixture();
    const initialOfferState = await f.read();
    assert.equal(initialOfferState.status, 200, JSON.stringify(initialOfferState.body));
    assert.equal((await f.read(null)).status, 401);
    assert.equal((await f.read("foreign")).status, 404);
    assert.equal((await f.read("peer")).status, 404);
    assert.equal((await f.read("interviewer")).status, 403);
    assert.equal((await f.act("save_draft", { terms }, "interviewer")).status, 403);
    assert.equal((await f.act("save_draft", { terms, testOnly: false })).status, 400);
    assert.equal(
      (await f.act("save_draft", { terms: { ...terms, startDate: "2027-02-31" } })).status,
      400,
    );
    assert.equal(
      (await f.act("save_draft", { terms: { ...terms, expiresAt: "2027-02-31T00:00:00Z" } }))
        .status,
      400,
    );
    assert.equal((await f.act("save_draft", { terms: { ...terms, amount: 0 } })).status, 400);
    assert.equal((await f.act("save_draft", { terms }, "recruiter")).status, 403);
    assert.equal((await f.act("save_draft", { terms })).status, 200);
    let s = (await f.read()).body;
    assert.equal(s.offer?.version, 1);
    assert.equal(s.offer?.testOnly, true);
    assert.equal((await f.act("send")).status, 409);
    assert.equal((await f.act("approve")).status, 409);
    assert.equal((await f.act("submit_review")).status, 200);
    assert.equal((await f.act("approve", {}, "recruiter")).status, 403);
    assert.equal((await f.act("approve")).status, 200);
    assert.equal((await f.act("save_draft", { terms: { ...terms, amount: 110000 } })).status, 200);
    s = (await f.read()).body;
    assert.equal(s.offer?.version, 2);
    assert.equal(s.offer?.approvedBy, undefined);
    assert.equal(s.history[0].status, "approved");
    assert.equal((await f.act("send")).status, 409);
    assert.equal((await f.act("submit_review")).status, 200);
    assert.equal((await f.act("approve")).status, 200);
    const sendInput = {
      action: "send",
      expectedRevision: (await f.read()).body.workflowRevision,
      idempotencyKey: randomUUID(),
    };
    const before = offerEmails.length;
    const sent = await Promise.all([
      request("POST", f.path, sendInput),
      request("POST", f.path, sendInput),
    ]);
    assert.ok(sent.every((r) => r.status === 200));
    assert.equal(offerEmails.length, before + 1);
    const token = offerEmails.at(-1)!.match(/\/offer\/([a-f0-9]{64})/)![1];
    assert.equal((await f.read()).body.offer?.status, "sent");
    assert.ok(!JSON.stringify((await get(f.jobId)).body).includes("tokenHash"));
    assert.equal((await f.act("save_draft", { terms })).status, 409);
    const publicPath = `/controlled-offers/public/${token}`;
    assert.equal(
      (await request("GET", "/controlled-offers/public/" + "0".repeat(64), undefined, null)).status,
      404,
    );
    const publicView = await request("GET", publicPath, undefined, null);
    assert.equal(publicView.status, 200);
    assert.ok(!JSON.stringify(publicView.body).includes("recipientEmail"));
    assert.ok(!JSON.stringify(publicView.body).includes("actorId"));
    assert.equal(
      (await request("POST", publicPath, { decision: "accept", actorId: "forged" }, null)).status,
      400,
    );
    assert.equal((await request("POST", publicPath, { decision: "accept" }, null)).status, 200);
    assert.equal((await request("POST", publicPath, { decision: "accept" }, null)).status, 200);
    assert.equal((await request("POST", publicPath, { decision: "decline" }, null)).status, 409);
    assert.equal((await f.read()).body.offer?.status, "accepted");
    assert.equal((await f.act("withdraw", { reason: "Fixture withdrawal reason" })).status, 409);
    const [app] = await dbAdmin
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.jobId, f.jobId));
    assert.equal(
      app.stage,
      "applied",
      "Offer response must not fabricate employment or call legacy acceptance",
    );
    const g = await fixture();
    await g.act("save_draft", { terms });
    await g.act("submit_review");
    await g.act("approve");
    await g.act("send");
    const revoked = offerEmails.at(-1)!.match(/\/offer\/([a-f0-9]{64})/)![1];
    assert.equal(
      (await g.act("withdraw", { reason: "Revoke the isolated fixture offer." })).status,
      200,
    );
    assert.equal(
      (await request("GET", `/controlled-offers/public/${revoked}`, undefined, null)).status,
      404,
    );
    const withdrawnOffer = (await g.read()).body.offer!;
    const beforeReplacement = offerEmails.length;
    assert.equal((await g.act("save_draft", { terms })).status, 200);
    const withdrawnReplacement = (await g.read()).body;
    assert.equal(withdrawnReplacement.offer?.status, "draft");
    assert.equal(withdrawnReplacement.offer?.version, withdrawnOffer.version + 1);
    assert.notEqual(withdrawnReplacement.offer?.id, withdrawnOffer.id);
    assert.equal(withdrawnReplacement.offer?.approvedBy, undefined);
    assert.equal(withdrawnReplacement.offer?.deliveryAttemptId, undefined);
    assert.deepEqual(withdrawnReplacement.history[0], withdrawnOffer);
    assert.equal((await g.act("approve")).status, 409);
    assert.equal((await g.act("send")).status, 409);
    assert.equal(offerEmails.length, beforeReplacement);
    assert.equal(
      (await request("POST", `/controlled-offers/public/${revoked}`, { decision: "accept" }, null))
        .status,
      404,
    );
    const h = await fixture();
    await h.act("save_draft", { terms });
    await h.act("submit_review");
    await h.act("approve");
    await h.act("send");
    const expired = offerEmails.at(-1)!.match(/\/offer\/([a-f0-9]{64})/)![1];
    const [row] = await dbAdmin.select().from(workflows).where(eq(workflows.id, h.workflowId));
    await dbAdmin
      .update(workflows)
      .set({
        steps: row.steps.map((step) =>
          step.controlledOffer
            ? {
                ...step,
                controlledOffer: {
                  ...step.controlledOffer,
                  terms: {
                    ...terms,
                    frequency: "annual" as const,
                    expiresAt: new Date(Date.now() - 1000).toISOString(),
                  },
                },
              }
            : step,
        ),
      })
      .where(eq(workflows.id, h.workflowId));
    assert.equal(
      (await request("GET", `/controlled-offers/public/${expired}`, undefined, null)).status,
      410,
    );
    assert.equal(
      (await request("POST", `/controlled-offers/public/${expired}`, { decision: "accept" }, null))
        .status,
      410,
    );
    assert.equal((await h.read()).body.offer?.status, "expired");
    const expiredOffer = (await h.read()).body.offer!;
    const beforeExpiredReplacement = offerEmails.length;
    assert.equal((await h.act("save_draft", { terms })).status, 200);
    const expiredReplacement = (await h.read()).body;
    assert.equal(expiredReplacement.offer?.status, "draft");
    assert.equal(expiredReplacement.offer?.version, expiredOffer.version + 1);
    assert.notEqual(expiredReplacement.offer?.id, expiredOffer.id);
    assert.equal(expiredReplacement.offer?.approvedBy, undefined);
    assert.equal(expiredReplacement.offer?.sentAt, undefined);
    assert.ok(!("tokenHash" in expiredReplacement.offer!));
    assert.deepEqual(expiredReplacement.history[0], expiredOffer);
    assert.equal((await h.act("approve")).status, 409);
    assert.equal((await h.act("send")).status, 409);
    assert.equal(offerEmails.length, beforeExpiredReplacement);
    for (const method of ["GET", "POST"] as const) {
      const result = await request(
        method,
        `/controlled-offers/public/${expired}`,
        method === "POST" ? { decision: "accept" } : undefined,
        null,
      );
      assert.ok([404, 410].includes(result.status), "Old expired capability became active");
    }
    const uncertain = await fixture();
    await uncertain.act("save_draft", { terms });
    await uncertain.act("submit_review");
    await uncertain.act("approve");
    offerDeliveryMode = "uncertain";
    assert.equal((await uncertain.act("send")).status, 503);
    assert.equal((await uncertain.read()).body.offer?.status, "send_uncertain");
    const attempts = offerEmails.length;
    assert.equal((await uncertain.act("send")).status, 409);
    assert.equal(offerEmails.length, attempts, "Uncertain delivery must not be retried");
    assert.equal(
      (await uncertain.act("withdraw", { reason: "Withdraw the uncertain fixture delivery." }))
        .status,
      200,
    );
    const simulated = await fixture();
    await simulated.act("save_draft", { terms });
    await simulated.act("submit_review");
    await simulated.act("approve");
    offerDeliveryMode = "simulated";
    assert.equal((await simulated.act("send")).status, 503);
    assert.equal((await simulated.read()).body.offer?.status, "approved");
    offerDeliveryMode = "success";
    assert.equal(
      (await simulated.act("send")).status,
      200,
      "An explicit retry after a proven no-effect simulation must finalize its own attempt",
    );
    assert.equal((await simulated.read()).body.offer?.status, "sent");
  } finally {
    offerDeliveryMode = "success";
    await dbAdmin.delete(atsChecks).where(inArray(atsChecks.jobId, offerJobs));
    await dbAdmin.delete(atsBindings).where(eq(atsBindings.tenantId, tenant));
    await dbAdmin.delete(receipts).where(inArray(receipts.jobId, offerJobs));
    await dbAdmin.delete(events).where(inArray(events.jobId, offerJobs));
    await dbAdmin.delete(workflows).where(inArray(workflows.jobId, offerJobs));
    await dbAdmin.delete(journeys).where(inArray(journeys.jobId, offerJobs));
    await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.jobId, offerJobs));
    await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, offerJobs));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, offerCandidate));
  }
});
const mutation = (briefHash: string) => ({
  idempotencyKey: randomUUID(),
  expectedBriefHash: briefHash,
});

async function newJob(
  path: "ai" | "human" | "ai_then_human" | "human_then_ai" | "recruiter_choice" = "human",
) {
  const id = `${prefix}_${randomUUID()}`;
  await dbAdmin.insert(jobsTable).values({
    id,
    tenantId: tenant,
    title: "Workflow fixture",
    description: "Short fixture",
    status: "active",
    assignedRecruiterId: actorId("recruiter"),
    assignedHiringManagerId: actorId("hm"),
    interviewPath: path,
  });
  await dbAdmin
    .insert(applicationsTable)
    .values({ tenantId: tenant, candidateId, jobId: id, stage: "applied" });
  return id;
}
async function plan(jobId: string) {
  const state = (await get(jobId)).body;
  const drafted = await post(jobId, "workflow-journeys", mutation(state.briefHash));
  assert.equal(drafted.status, 200, JSON.stringify(drafted.body));
  const approved = await post(
    jobId,
    `workflow-journeys/${drafted.body.id}/approve`,
    mutation(state.briefHash),
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { id: drafted.body.id as string, hash: state.briefHash as string };
}
async function enroll(jobId: string, journey: { id: string; hash: string }, path?: string) {
  const result = await post(jobId, "candidate-workflows", {
    ...mutation(journey.hash),
    journeyId: journey.id,
    candidateId,
    ...(path ? { interviewPath: path } : {}),
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.id as string;
}
const evidence = (revision = 1, stepKey = "screening", status = "completed") => ({
  idempotencyKey: randomUUID(),
  expectedRevision: revision,
  stepKey,
  status,
  evidence: "Human-reviewed evidence; no automated action",
  ...(stepKey === "hiring_decision" && status !== "failed"
    ? { decision: status === "completed" ? "hire" : "hold" }
    : {}),
});
async function effects() {
  const result = await dbAdmin.execute(sql`SELECT
    (SELECT count(*) FROM ai_jobs WHERE tenant_id=${tenant}) AS queued,
    (SELECT count(*) FROM pipeline_runs WHERE tenant_id=${tenant}) AS runs,
    (SELECT count(*) FROM interview_sessions WHERE tenant_id=${tenant}) AS interviews,
    (SELECT count(*) FROM outreach_messages WHERE tenant_id=${tenant}) AS messages,
    (SELECT count(*) FROM credit_usage_events WHERE tenant_id=${tenant}) AS credits,
    (SELECT count(*) FROM applications WHERE tenant_id=${tenant} AND stage<>'applied') AS changed_stages`);
  return { ...result.rows[0], agents: agent.mock.callCount() };
}
before(async () => {
  await dbAdmin.insert(tenantsTable).values([
    { id: agency, name: "Workflow test agency", slug: agency },
    { id: tenant, parentId: agency, name: "Workflow test client", slug: tenant },
    { id: foreign, name: "Workflow foreign", slug: foreign },
  ]);
  await dbAdmin.insert(usersTable).values(
    Object.entries(roles).map(([name, role]) => ({
      id: actorId(name as Actor),
      tenantId:
        name === "foreign"
          ? foreign
          : ["admin", "employerApprover"].includes(name)
            ? tenant
            : agency,
      name: `Workflow ${name}`,
      email: `${prefix}_${name}@example.invalid`,
      role,
      status: "active" as const,
      passwordHash: "unused-fixture-password",
    })),
  );
  await dbAdmin.insert(recruiterAdminClientsTable).values({
    tenantId: agency,
    recruiterAdminUserId: actorId("manager"),
    clientTenantId: tenant,
    assignedByUserId: actorId("admin"),
  });
  await dbAdmin.insert(candidatesTable).values(
    [candidateId, unlinked].map((id) => ({
      id,
      tenantId: tenant,
      firstName: "Workflow",
      lastName: "Candidate",
      email: `${id}@example.invalid`,
      pool: "tenant" as const,
    })),
  );
  mainJob = await newJob();
  await dbAdmin
    .insert(jobRecruitersTable)
    .values({ jobId: mainJob, tenantId: tenant, recruiterUserId: actorId("joined") });
  beforeEffects = await effects();
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(offerInboxRouter);
  app.use(
    createControlledOffersRouter(async (input) => {
      if (input.audit?.action === "interview.greenhouse.invite") {
        greenhouseInvitations.push({
          text: input.text ?? "",
          singleAttempt: input.singleAttempt === true,
        });
        if (greenhouseDeliveryMode === "uncertain") throw new Error("PRIVATE provider timeout");
        if (greenhouseDeliveryMode === "simulated") return { ok: true, simulated: true };
        return { ok: true, messageId: "isolated-greenhouse-receipt" };
      }
      offerEmails.push(input.text ?? "");
      if (offerDeliveryMode === "uncertain") throw new Error("Isolated delivery timeout");
      if (offerDeliveryMode === "simulated") return { ok: true, simulated: true };
      return { ok: true, messageId: "isolated-fake-transport" };
    }, atsGateway),
  );
  app.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: error.message });
    },
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbAdmin.delete(interviewSummariesTable).where(
    inArray(
      interviewSummariesTable.id,
      ["current", "old", "private"].map((kind) => `${prefix}_assessment_${kind}`),
    ),
  );
  await dbAdmin.delete(interviewSessionsTable).where(eq(interviewSessionsTable.tenantId, tenant));
  await dbAdmin.delete(interviewPlansTable).where(eq(interviewPlansTable.tenantId, tenant));
  await dbAdmin.delete(resumeScreensTable).where(eq(resumeScreensTable.candidateId, candidateId));
  await dbAdmin
    .delete(verificationRecordsTable)
    .where(eq(verificationRecordsTable.candidateId, candidateId));
  await dbAdmin.delete(outreachMessagesTable).where(eq(outreachMessagesTable.tenantId, tenant));
  await dbAdmin.delete(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.tenantId, tenant));
  for (const table of [events, receipts, workflows, journeys])
    await dbAdmin.delete(table).where(eq(table.tenantId, tenant));
  await dbAdmin.delete(userNotificationsTable).where(eq(userNotificationsTable.tenantId, tenant));
  await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.tenantId, tenant));
  await dbAdmin.delete(jobRecruitersTable).where(eq(jobRecruitersTable.tenantId, tenant));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, tenant));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, tenant));
  await dbAdmin
    .delete(recruiterAdminClientsTable)
    .where(eq(recruiterAdminClientsTable.clientTenantId, tenant));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, [agency, foreign]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [tenant, agency, foreign]));
  agent.mock.restore();
});

test("canonical fingerprints ignore object order; all steps retain human authority", () => {
  assert.equal(
    fingerprint({ x: 1, nested: { b: 2, a: 3 } }),
    fingerprint({ nested: { a: 3, b: 2 }, x: 1 }),
  );
  for (const path of ["ai", "human", "ai_then_human", "human_then_ai", "recruiter_choice"]) {
    const steps = journeySteps(path);
    assert.equal(steps.at(-1)?.key, "hiring_decision");
    assert.ok(
      steps.every(
        (s) => s.authority === "human_review" && s.evidence === null && s.status === "pending",
      ),
    );
  }
  assert.throws(() => journeySteps("automatic_hire"));
});
for (const actor of [
  "platform",
  "admin",
  "manager",
  "recruiter",
  "joined",
  "hm",
  "interviewer",
] as const) {
  test(`${actor} reads only its authorized requisition with truthful capabilities`, async () => {
    const response = await get(mainJob, actor);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.autonomyExecutionEnabled, false);
    assert.equal(response.body.canEdit, actor !== "interviewer");
    assert.equal(response.body.canApprove, ["platform", "admin", "manager", "hm"].includes(actor));
    const shadow = await request("GET", `/jobs/${mainJob}/workflow-shadow`, undefined, actor);
    assert.equal(shadow.status, 200);
    assert.equal(shadow.body.executionAllowed, false);
    assert.equal(shadow.body.modelCalls, 0);
  });
}
for (const actor of ["foreign", "peer", "unmanaged", "hmPeer", "candidate", null] as const) {
  test(`${actor ?? "anonymous"} cannot read or draft a forbidden requisition`, async () => {
    const expected = actor === null ? 401 : actor === "candidate" ? 403 : 404;
    assert.equal((await get(mainJob, actor)).status, expected);
    assert.equal(
      (await request("GET", `/jobs/${mainJob}/workflow-shadow`, undefined, actor)).status,
      expected,
    );
    assert.equal(
      (await post(mainJob, "workflow-journeys", mutation("0".repeat(64)), actor)).status,
      expected,
    );
  });
}
test("read-only interviewer and ordinary recruiter cannot grant approval authority", async () => {
  const hash = (await get(mainJob)).body.briefHash;
  assert.equal(
    (await post(mainJob, "workflow-journeys", mutation(hash), "interviewer")).status,
    403,
  );
  const draft = await post(mainJob, "workflow-journeys", mutation(hash), "recruiter");
  assert.equal(draft.status, 200);
  assert.equal(
    (await post(mainJob, `workflow-journeys/${draft.body.id}/approve`, mutation(hash), "recruiter"))
      .status,
    403,
  );
});
test("invalid and forged authority fields produce no draft or receipt", async () => {
  const hash = (await get(mainJob)).body.briefHash;
  const before = (await get(mainJob)).body.journeys.length;
  for (const body of [
    {},
    { ...mutation(hash), autonomyExecutionEnabled: true },
    { ...mutation(hash), steps: [] },
    mutation("bad"),
  ]) {
    assert.equal((await post(mainJob, "workflow-journeys", body)).status, 400);
  }
  assert.equal((await get(mainJob)).body.journeys.length, before);
});
test("saved source evidence is job/tenant scoped, read-only, human-reviewed and retry safe", async () => {
  const job = await newJob("ai");
  const journey = await plan(job);
  const id = await enroll(job, journey);
  const wf = (await get(job)).body.workflows.find((w) => w.id === id)!;
  const sourceId = `${prefix}_screen`;
  await dbAdmin.insert(resumeScreensTable).values([
    {
      id: sourceId,
      tenantId: tenant,
      candidateId,
      jobId: job,
      screeningScore: 0,
      recruiterSummary: "Fixture score zero",
    },
    {
      id: `${sourceId}_old`,
      tenantId: tenant,
      candidateId,
      jobId: job,
      screeningScore: 90,
      recruiterSummary: "Old attempt",
      createdAt: new Date(new Date(wf.createdAt ?? Date.now()).getTime() - 60_000),
    },
    {
      id: `${sourceId}_foreign`,
      tenantId: foreign,
      candidateId,
      jobId: job,
      screeningScore: 99,
      recruiterSummary: "Foreign orphan",
    },
    {
      id: `${sourceId}_other_job`,
      tenantId: tenant,
      candidateId,
      jobId: `${job}_other`,
      screeningScore: 99,
      recruiterSummary: "Other role",
    },
  ]);
  const before = await effects();
  const first = (await get(job)).body;
  const observed = first.workflows.find((w) => w.id === id)!;
  assert.equal(observed.revision, 1);
  assert.equal(observed.steps[0].status, "pending");
  assert.equal(observed.runtimeEvidence.length, 1);
  const saved = observed.runtimeEvidence[0];
  assert.equal(saved.sourceId, sourceId);
  assert.ok(saved.summary.includes("score 0/100"));
  assert.equal(saved.readyForReview, true);
  assert.equal((await get(job, "foreign")).status, 404);
  assert.deepEqual((await get(job)).body, first);
  assert.deepEqual(await effects(), before);
  const bad = await post(job, `candidate-workflows/${id}/evidence`, {
    ...evidence(),
    runtimeEvidenceId: "foreign-source",
  });
  assert.equal(bad.status, 409);
  assert.equal((await get(job)).body.workflows[0].revision, 1);
  const input = { ...evidence(), runtimeEvidenceId: saved.id };
  const reviewed = await post(job, `candidate-workflows/${id}/evidence`, input);
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal((await post(job, `candidate-workflows/${id}/evidence`, input)).body.replayed, true);
  const after = (await get(job)).body.workflows.find((w) => w.id === id)!;
  assert.equal(after.revision, 2);
  assert.ok(after.steps[0].evidence?.includes(sourceId));
  assert.ok(after.steps[0].evidence?.includes(saved.id));
  assert.deepEqual(await effects(), before);
  await dbAdmin.delete(resumeScreensTable).where(eq(resumeScreensTable.candidateId, candidateId));
});

test("current identity records and normalized sourced replies are visible without counting sent mail as interest", async () => {
  const job = await newJob("ai");
  const id = await enroll(job, await plan(job));
  const sourceId = `${prefix}_reply_source`;
  await dbAdmin.insert(sourcedCandidatesTable).values({
    id: sourceId,
    tenantId: tenant,
    source: "manual",
    normalizedCandidateId: candidateId,
    rawData: {},
  });
  await dbAdmin.insert(verificationRecordsTable).values({
    id: `${prefix}_verify`,
    tenantId: tenant,
    candidateId,
    status: "review",
    riskScore: 50,
  });
  await dbAdmin.insert(outreachMessagesTable).values([
    {
      id: `${prefix}_sent`,
      tenantId: tenant,
      jobId: job,
      candidateId,
      subject: "Fixture",
      body: "No delivery",
      status: "sent",
      sentAt: new Date(),
    },
    {
      id: `${prefix}_reply`,
      tenantId: tenant,
      jobId: job,
      candidateId: sourceId,
      subject: "Fixture",
      body: "No delivery",
      status: "replied",
      sentAt: new Date(Date.now() - 5),
      repliedAt: new Date(),
      replySentiment: "positive",
    },
  ]);
  const observed = (await get(job)).body.workflows.find((w) => w.id === id)!;
  assert.equal(
    observed.steps.every((s) => s.status === "pending"),
    true,
  );
  const verification = observed.runtimeEvidence.find((e) => e.stepKey === "verification")!;
  assert.equal(verification.scope, "candidate_identity");
  assert.equal(verification.attentionRequired, true);
  const sent = observed.runtimeEvidence.find((e) => e.sourceId === `${prefix}_sent`)!;
  assert.equal(sent.readyForReview, false);
  const reply = observed.runtimeEvidence.find((e) => e.sourceId === `${prefix}_reply`)!;
  assert.equal(reply.attentionRequired, false);
  assert.equal(reply.readyForReview, false); // Previous steps still require human review.
  await dbAdmin
    .delete(verificationRecordsTable)
    .where(eq(verificationRecordsTable.candidateId, candidateId));
  await dbAdmin.delete(outreachMessagesTable).where(eq(outreachMessagesTable.jobId, job));
  await dbAdmin.delete(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, sourceId));
});

test("job interview evidence excludes older attempts and private/unrelated plans, with no answers exposed", async () => {
  const job = await newJob("ai");
  const id = await enroll(job, await plan(job));
  for (const kind of ["current", "old", "private"]) {
    const planId = `${prefix}_plan_${kind}`,
      sessionId = `${prefix}_session_${kind}`;
    await dbAdmin.insert(interviewPlansTable).values({
      id: planId,
      tenantId: tenant,
      jobId: kind === "private" ? `${job}_private_practice` : job,
      title: "Disposable assessment fixture",
    });
    await dbAdmin.insert(interviewSessionsTable).values({
      id: sessionId,
      tenantId: tenant,
      planId,
      applicationId: `${prefix}_placeholder_${kind}`,
      candidateId,
      status: "completed",
      completedAt: new Date(),
      ...(kind === "old" ? { createdAt: new Date(Date.now() - 60_000) } : {}),
    });
    await dbAdmin.insert(interviewSummariesTable).values({
      id: `${prefix}_assessment_${kind}`,
      interviewSessionId: sessionId,
      overallScore: 0,
      recommendation: "no",
      recruiterSummary: "Private fixture detail",
      transcript: [{ content: "Do not expose fixture answers." }],
    });
  }
  const before = await effects();
  const state = (await get(job)).body;
  const observed = state.workflows.find((w) => w.id === id)!;
  assert.equal(observed.runtimeEvidence.length, 2);
  assert.ok(observed.runtimeEvidence.every((e) => e.sourceId === `${prefix}_assessment_current`));
  assert.ok(observed.runtimeEvidence.every((e) => !e.readyForReview));
  assert.equal(
    observed.steps.every((step) => step.status === "pending"),
    true,
  );
  assert.ok(!JSON.stringify(state).includes("Do not expose fixture answers."));
  assert.ok(!JSON.stringify(state).includes("Private fixture detail"));
  assert.deepEqual(await effects(), before);
  await dbAdmin.delete(interviewSummariesTable).where(
    inArray(
      interviewSummariesTable.id,
      ["current", "old", "private"].map((kind) => `${prefix}_assessment_${kind}`),
    ),
  );
  await dbAdmin.delete(interviewSessionsTable).where(eq(interviewSessionsTable.tenantId, tenant));
  await dbAdmin.delete(interviewPlansTable).where(eq(interviewPlansTable.tenantId, tenant));
});

test("parallel draft retries produce exactly one version and one event", async () => {
  const job = await newJob(),
    hash = (await get(job)).body.briefHash,
    body = mutation(hash);
  const results = await Promise.all([
    post(job, "workflow-journeys", body),
    post(job, "workflow-journeys", body),
  ]);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results[0].body.id, results[1].body.id);
  assert.deepEqual(results.map((r) => r.body.replayed).sort(), [false, true]);
  const state = (await get(job)).body;
  assert.equal(state.journeys.length, 1);
  assert.equal(state.events.length, 1);
  assert.equal(
    (await post(job, "workflow-journeys", { ...body, expectedBriefHash: "0".repeat(64) })).status,
    409,
  );
});
for (const path of ["ai", "human", "ai_then_human", "human_then_ai", "recruiter_choice"] as const) {
  test(`approved ${path} journey enrolls explicitly and independently`, async () => {
    const job = await newJob(path),
      journey = await plan(job);
    if (path === "recruiter_choice") {
      assert.equal(
        (
          await post(job, "candidate-workflows", {
            ...mutation(journey.hash),
            journeyId: journey.id,
            candidateId,
          })
        ).status,
        400,
      );
    }
    const id = await enroll(
      job,
      journey,
      path === "recruiter_choice" ? "human_then_ai" : undefined,
    );
    const state = (await get(job)).body,
      row = state.workflows.find((w: { id: string }) => w.id === id);
    assert.ok(row);
    assert.equal(row.journeyVersion, 1);
    assert.equal(row.revision, 1);
    assert.equal(row.status, "ready");
    assert.deepEqual(row.steps, journeySteps(path === "recruiter_choice" ? "human_then_ai" : path));
    assert.equal(
      (
        await post(job, "candidate-workflows", {
          ...mutation(journey.hash),
          journeyId: journey.id,
          candidateId,
          ...(path === "recruiter_choice" ? { interviewPath: "human_then_ai" } : {}),
        })
      ).status,
      409,
    );
  });
}
test("unlinked candidates and foreign journey/workflow IDs are never accepted", async () => {
  const job = await newJob(),
    other = await newJob(),
    journey = await plan(job),
    otherJourney = await plan(other);
  assert.equal(
    (
      await post(job, "candidate-workflows", {
        ...mutation(journey.hash),
        journeyId: journey.id,
        candidateId: unlinked,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await post(job, "candidate-workflows", {
        ...mutation(journey.hash),
        journeyId: otherJourney.id,
        candidateId,
      })
    ).status,
    404,
  );
  const otherWorkflow = await enroll(other, otherJourney);
  assert.equal(
    (
      await post(job, `candidate-workflows/${otherWorkflow}/control`, {
        idempotencyKey: randomUUID(),
        expectedRevision: 1,
        action: "cancel",
      })
    ).status,
    404,
  );
});
test("material brief changes require a new approved version and never reroute existing candidates", async () => {
  const job = await newJob(),
    old = await plan(job),
    id = await enroll(job, old);
  await dbAdmin
    .update(jobsTable)
    .set({ description: "Changed material requirements", interviewPath: "ai" })
    .where(eq(jobsTable.id, job));
  const state = (await get(job)).body;
  assert.ok(state.journeys[0].stale);
  assert.ok(state.workflows[0].stale);
  assert.equal(state.workflows[0].interviewPath, "human");
  assert.equal((await post(job, `candidate-workflows/${id}/evidence`, evidence())).status, 409);
  const latest = await plan(job);
  assert.equal((await get(job)).body.journeys[0].version, 2);
  assert.equal((await get(job)).body.workflows[0].journeyId, old.id);
  assert.notEqual(latest.id, old.id);
  await assert.rejects(
    dbAdmin
      .update(journeys)
      .set({ briefHash: "0".repeat(64) })
      .where(eq(journeys.id, old.id)),
    (error: unknown) => error instanceof Error && /immutable/.test(String(error.cause)),
  );
});
test("unapproved and paused requisitions cannot grant ready-work authority", async () => {
  const job = await newJob(),
    hash = (await get(job)).body.briefHash;
  const draft = await post(job, "workflow-journeys", mutation(hash));
  for (const status of ["pending_approval", "draft", "rejected", "paused"] as const) {
    await dbAdmin.update(jobsTable).set({ status }).where(eq(jobsTable.id, job));
    assert.equal(
      (await post(job, `workflow-journeys/${draft.body.id}/approve`, mutation(hash))).status,
      409,
    );
  }
});
test("step evidence is ordered, uncertain/failed is reviewable, and candidate/job state is isolated", async () => {
  const job = await newJob(),
    other = await newJob(),
    id = await enroll(job, await plan(job)),
    otherId = await enroll(other, await plan(other));
  assert.equal(
    (await post(job, `candidate-workflows/${id}/evidence`, evidence(1, "verification"))).status,
    409,
  );
  for (const [revision, status] of [
    [1, "review_required"],
    [2, "failed"],
    [3, "completed"],
  ] as const) {
    assert.equal(
      (
        await post(
          job,
          `candidate-workflows/${id}/evidence`,
          evidence(revision, "screening", status),
        )
      ).status,
      200,
    );
  }
  const row = (await get(job)).body.workflows[0];
  assert.equal(row.steps[0].status, "completed");
  assert.equal(row.steps[1].status, "pending");
  const untouched = (await get(other)).body.workflows.find((w: { id: string }) => w.id === otherId);
  assert.ok(untouched);
  assert.equal(untouched.revision, 1);
  assert.equal(untouched.steps[0].status, "pending");
});
test("atomic evidence retries are exact-once; competing revisions reject without partial history", async () => {
  const job = await newJob(),
    id = await enroll(job, await plan(job)),
    body = evidence();
  const same = await Promise.all([
    post(job, `candidate-workflows/${id}/evidence`, body),
    post(job, `candidate-workflows/${id}/evidence`, body),
  ]);
  assert.ok(same.every((r) => r.status === 200));
  const different = await Promise.all([
    post(job, `candidate-workflows/${id}/evidence`, evidence(2, "verification")),
    post(job, `candidate-workflows/${id}/evidence`, evidence(2, "verification", "review_required")),
  ]);
  assert.deepEqual(different.map((r) => r.status).sort(), [200, 409]);
  const state = (await get(job)).body;
  assert.equal(state.workflows[0].revision, 3);
  assert.equal(
    state.events.filter((e: { action: string }) => e.action === "workflow.evidence_recorded")
      .length,
    2,
  );
});
test("pause blocks new work; stale resume fails; cancel preserves evidence and is terminal", async () => {
  const job = await newJob(),
    id = await enroll(job, await plan(job));
  await post(job, `candidate-workflows/${id}/evidence`, evidence());
  const pause = { idempotencyKey: randomUUID(), expectedRevision: 2, action: "pause" };
  assert.equal((await post(job, `candidate-workflows/${id}/control`, pause)).status, 200);
  assert.equal(
    (await post(job, `candidate-workflows/${id}/evidence`, evidence(3, "verification"))).status,
    409,
  );
  assert.equal(
    (
      await post(job, `candidate-workflows/${id}/control`, {
        idempotencyKey: randomUUID(),
        expectedRevision: 3,
        action: "resume",
      })
    ).status,
    200,
  );
  await post(job, `candidate-workflows/${id}/control`, {
    idempotencyKey: randomUUID(),
    expectedRevision: 4,
    action: "pause",
  });
  await dbAdmin.update(jobsTable).set({ title: "Changed brief" }).where(eq(jobsTable.id, job));
  assert.equal(
    (
      await post(job, `candidate-workflows/${id}/control`, {
        idempotencyKey: randomUUID(),
        expectedRevision: 5,
        action: "resume",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await post(job, `candidate-workflows/${id}/control`, {
        idempotencyKey: randomUUID(),
        expectedRevision: 5,
        action: "cancel",
      })
    ).status,
    200,
  );
  const row = (await get(job)).body.workflows[0];
  assert.equal(row.status, "cancelled");
  assert.equal(row.steps[0].status, "completed");
  assert.ok(row.steps[0].evidence);
  assert.ok(row.steps.slice(1).every((s: { status: string }) => s.status === "cancelled"));
  assert.equal(
    (
      await post(job, `candidate-workflows/${id}/control`, {
        idempotencyKey: randomUUID(),
        expectedRevision: 6,
        action: "resume",
      })
    ).status,
    409,
  );
});
test("final human hiring decision requires an approver and does not write pipeline stages", async () => {
  // This disposable authorization fixture must satisfy the current identity
  // prerequisite. Never bypass that gate with a generic completion note.
  const [beforeCandidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId));
  const identityId = `${prefix}_decision_identity`;
  await dbAdmin.insert(verificationRecordsTable).values({
    id: identityId,
    tenantId: tenant,
    candidateId,
    status: "verified",
    identityVerified: true,
    reviewNotes: "Fictional authorization-test prerequisite; not a real identity assertion.",
  });
  await dbAdmin
    .update(candidatesTable)
    .set({ verificationStatus: "verified" })
    .where(eq(candidatesTable.id, candidateId));
  try {
    const job = await newJob(),
      id = await enroll(job, await plan(job));
    const beforeStages = await dbAdmin
      .select({ id: applicationsTable.id, stage: applicationsTable.stage })
      .from(applicationsTable)
      .where(eq(applicationsTable.jobId, job));
    const steps = journeySteps("human");
    for (let i = 0; i < steps.length - 1; i++)
      assert.equal(
        (
          await post(
            job,
            `candidate-workflows/${id}/evidence`,
            evidence(i + 1, steps[i].key),
            "recruiter",
          )
        ).status,
        200,
      );
    const final = evidence(steps.length, "hiring_decision");
    const { decision: _decision, ...missingDecision } = final;
    assert.equal(
      (await post(job, `candidate-workflows/${id}/evidence`, missingDecision)).status,
      400,
    );
    assert.equal(
      (await post(job, `candidate-workflows/${id}/evidence`, { ...final, decision: "hold" }))
        .status,
      400,
    );
    assert.equal(
      (await post(job, `candidate-workflows/${id}/evidence`, final, "recruiter")).status,
      403,
    );
    const hold = {
      ...final,
      idempotencyKey: randomUUID(),
      status: "review_required",
      decision: "hold",
      evidence: "Need independent review before a final decision.",
    };
    assert.equal(
      (await post(job, `candidate-workflows/${id}/evidence`, { ...hold, evidence: "brief" }, "hm"))
        .status,
      400,
    );
    assert.equal(
      (await post(job, `candidate-workflows/${id}/evidence`, { ...hold, actorId: "forged" }, "hm"))
        .status,
      400,
    );
    assert.equal((await post(job, `candidate-workflows/${id}/evidence`, hold, "hm")).status, 200);
    assert.equal(
      (await post(job, `candidate-workflows/${id}/evidence`, hold, "hm")).body.replayed,
      true,
    );
    const held = (await get(job)).body.workflows[0];
    assert.equal(held.status, "ready");
    assert.equal(held.steps.at(-1)?.humanDecision?.outcome, "hold");
    assert.equal(held.steps.at(-1)?.humanDecision?.actorId, actorId("hm"));
    assert.equal(held.steps.at(-1)?.humanDecision?.testOnly, false);
    assert.ok(held.steps.at(-1)?.humanDecision?.actorName);
    assert.ok(held.steps.at(-1)?.humanDecision?.decidedAt);
    assert.equal((await post(job, `candidate-workflows/${id}/evidence`, final, "hm")).status, 409);
    const approved = { ...final, expectedRevision: held.revision };
    assert.equal(
      (await post(job, `candidate-workflows/${id}/evidence`, approved, "hm")).status,
      200,
    );
    assert.equal(
      (await post(job, `candidate-workflows/${id}/evidence`, approved, "hm")).body.replayed,
      true,
    );
    assert.equal((await get(job)).body.workflows[0].status, "completed");
    const decided = (await get(job)).body.workflows[0].steps.at(-1)!;
    assert.equal(decided.humanDecision?.outcome, "hire");
    assert.equal(decided.humanDecision?.reason, final.evidence);
    assert.equal(decided.humanDecision?.actorId, actorId("hm"));
    assert.deepEqual(decided.humanDecisionHistory, [held.steps.at(-1)?.humanDecision]);
    assert.deepEqual(
      await dbAdmin
        .select({ id: applicationsTable.id, stage: applicationsTable.stage })
        .from(applicationsTable)
        .where(eq(applicationsTable.jobId, job)),
      beforeStages,
    );
  } finally {
    await dbAdmin
      .delete(verificationRecordsTable)
      .where(eq(verificationRecordsTable.id, identityId));
    await dbAdmin
      .update(candidatesTable)
      .set({ verificationStatus: beforeCandidate.verificationStatus })
      .where(eq(candidatesTable.id, candidateId));
  }
});
test("current DNC privacy suppresses candidate state and related evidence/history", async () => {
  const job = await newJob(),
    id = await enroll(job, await plan(job));
  await post(job, `candidate-workflows/${id}/evidence`, evidence());
  await post(job, `candidate-workflows/${id}/control`, {
    idempotencyKey: randomUUID(),
    expectedRevision: 2,
    action: "pause",
  });
  await dbAdmin
    .update(candidatesTable)
    .set({ doNotContact: true })
    .where(eq(candidatesTable.id, candidateId));
  try {
    const state = (await get(job)).body;
    assert.equal(state.candidates.length, 0);
    assert.equal(state.workflows.length, 0);
    assert.ok(state.events.every((e: { workflowId: string | null }) => e.workflowId === null));
    const shadow = await request("GET", `/jobs/${job}/workflow-shadow`);
    assert.equal(shadow.body.proposals.length, 1);
    assert.equal(shadow.body.proposals[0].candidateId, null);
    assert.equal(
      (
        await post(job, `candidate-workflows/${id}/control`, {
          idempotencyKey: randomUUID(),
          expectedRevision: 3,
          action: "resume",
        })
      ).status,
      404,
    );
  } finally {
    await dbAdmin
      .update(candidatesTable)
      .set({ doNotContact: false })
      .where(eq(candidatesTable.id, candidateId));
  }
});
test("shadow reads derive current progress without writing evidence, approval, receipts or stages", async () => {
  const job = await newJob(),
    id = await enroll(job, await plan(job));
  const before = (await get(job)).body;
  const countersBefore = await effects();
  for (let i = 0; i < 3; i++) {
    const shadow = await request("GET", `/jobs/${job}/workflow-shadow?executionAllowed=true`);
    assert.equal(shadow.status, 200);
    assert.equal(shadow.body.proposals.find((p) => p.workflowId === id)?.nextStepKey, "screening");
    assert.ok(shadow.body.proposals.every((p) => p.executionAllowed === false));
    assert.equal(shadow.body.estimatedExecutionCost, null);
  }
  assert.deepEqual((await get(job)).body, before);
  assert.deepEqual(await effects(), countersBefore);
  await post(job, `candidate-workflows/${id}/evidence`, evidence());
  const next = await request("GET", `/jobs/${job}/workflow-shadow`);
  assert.equal(next.body.proposals.find((p) => p.workflowId === id)?.nextStepKey, "verification");
  await dbAdmin
    .update(jobsTable)
    .set({ description: "Material brief change" })
    .where(eq(jobsTable.id, job));
  const stale = await request("GET", `/jobs/${job}/workflow-shadow`);
  assert.equal(stale.body.proposals.find((p) => p.workflowId === id)?.disposition, "blocked");
  const unsupported = await fetch(`${base}/jobs/${job}/workflow-shadow`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ executionAllowed: true }),
  });
  assert.equal(unsupported.status, 404);
});

test("new tables enforce RLS for a foreign app-role connection", async () => {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL ROLE lexy_app");
    await connection.query(
      "SELECT set_config('app.allowed_tenant_ids',$1,true),set_config('app.is_platform_admin','false',true)",
      [foreign],
    );
    for (const table of [
      "recruiting_journeys",
      "recruiting_workflows",
      "recruiting_workflow_events",
      "recruiting_workflow_receipts",
    ]) {
      const result = await connection.query(
        `SELECT count(*)::int AS count FROM ${table} WHERE tenant_id=$1`,
        [tenant],
      );
      assert.equal(result.rows[0].count, 0);
    }
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
});
test("planning, approval, evidence and controls incur no provider calls, spend, contact or assisted stage changes", async () => {
  assert.deepEqual(await effects(), beforeEffects);
});
