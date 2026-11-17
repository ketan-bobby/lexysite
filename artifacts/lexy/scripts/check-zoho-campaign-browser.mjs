import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import puppeteer from "puppeteer";

// Real UI/client with default-deny interception. No application server or provider is used.
const root = path.resolve(import.meta.dirname, "..");
const server = await createServer({
  configFile: false,
  root,
  base: "/",
  cacheDir: mkdtempSync(path.join(tmpdir(), "lexy-zoho-browser-")),
  plugins: [react(), tailwindcss()],
  optimizeDeps: { entries: [path.join(root, "src/test-fixtures/zoho-campaign-browser.tsx")] },
  resolve: { alias: { "@": path.join(root, "src") }, dedupe: ["react", "react-dom"] },
  server: { host: "127.0.0.1", port: 0, hmr: false, proxy: {} },
  logLevel: "error",
});
let browser;
const failures = [];
const T = (id) => `[data-testid="${id}"]`;
const stamp = "2026-01-01T00:00:00.000Z";
const revision = "a".repeat(64);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Synthetic, deterministic 64-hex revisions for seeded rows; fresh ones for mutations.
const hexRev = (n) => n.toString(16).padStart(2, "0").repeat(32);
const newRev = () => randomUUID().replaceAll("-", "").repeat(2);
const ROW_A = "00000000-0000-4000-8000-00000000000a";
const ROW_R = "00000000-0000-4000-8000-00000000000b";
const ROW_O = "00000000-0000-4000-8000-00000000000c";
// Observed-state row that can carry a local administrative closure (resolution contract).
const ROW_P = "00000000-0000-4000-8000-00000000000d";
const HEX64 = /^[a-f0-9]{64}$/;
const PROPOSAL_REASON =
  "Zoho shows a different status than the approved target; closure proposed for independent review.";
const PROPOSAL_EVIDENCE = "PROPOSAL-REF-0001";
const REVIEW_REASON = "Independent reviewer checked the observed status against the reference.";
const REVIEW_EVIDENCE = "REVIEW-REF-0002";
const DRAFT_REASON = "Unsent reviewer note that must not survive a failed read.";
const DRAFT_EVIDENCE = "DRAFT-REF-0003";
const UNRESOLVED = [
  "claimed",
  "provider_accepted",
  "review_required",
  "observed_target",
  "observed_other",
];
const execRow = (id, state, rev, extra = {}) => ({
  id,
  revision: rev,
  state,
  decision: "advance",
  currentStatus: "New",
  targetStatus: "Panel interview",
  preparedBy: "staff",
  approvedBy: state === "prepared" ? null : "staff",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  executionRequestId: null,
  // Safe defaults for the resolution contract: existing rows carry no closure and no closure capability.
  sequence: 1,
  canProposeResolution: false,
  canReviewResolution: false,
  resolution: null,
  ...extra,
});
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const html = await server.transformIndexHtml(
    "/__zoho",
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
import { mountZohoFixture } from "/src/test-fixtures/zoho-campaign-browser.tsx";
window.mountFixture = (connected = true) => mountZohoFixture(document.getElementById("root"), connected);
</script></body></html>`,
  );
  let executablePath = puppeteer.executablePath();
  if (!existsSync(executablePath))
    executablePath = execFileSync("which", ["chromium"], { encoding: "utf8" }).trim();
  browser = await puppeteer.launch({
    executablePath,
    headless: true,
    pipe: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  async function scenario(
    name,
    run,
    {
      incomplete = false,
      mobile = false,
      deliveryState = "sent",
      receipt = true,
      evidence = true,
      connected = true,
      auditFailure = false,
      holdInitialDetail = false,
      noteWriteAuthorized = true,
      notePreviewFailure = false,
      notePublicationState = "published",
      // Synthetic stage-execution authority. Default: unverified evidence, live disabled, no rows.
      stageExecution = null,
      // Fixture identity id. A distinct id models an independent reviewer or a changed actor.
      actorId = "staff",
    } = {},
  ) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const unexpected = [];
    const errors = [];
    const writes = [];
    const notePreviews = [];
    let noteHistory = [];
    let noteCanPublish = true;
    let fixtureAuth = {
      id: actorId,
      tenantId: "tenant",
      name: "Fixture admin",
      role: "tenant_admin",
      email: "fixture@example.invalid",
      createdAt: stamp,
    };
    let conflict = false;
    let responseGate = null;
    const holdResponse = (suffix, method = "POST") => {
      let release;
      let start;
      const gate = {
        suffix,
        method,
        promise: new Promise((resolve) => {
          release = resolve;
        }),
        started: new Promise((resolve) => {
          start = resolve;
        }),
        start: () => start(),
        release: () => release(),
      };
      responseGate = gate;
      return gate;
    };
    const campaign = {
      id: "campaign",
      jobId: "job",
      externalJobId: "external-job",
      planId: "plan",
      state: "draft",
      snapshotHash: revision,
      applicationCount: 1,
      recipientCount: 1,
      createdAt: stamp,
      counts: [{ state: "queued", count: 1 }],
    };
    const review = {
      campaignId: "campaign",
      recipientId: "recipient",
      candidateName: "Synthetic applicant",
      sessionId: "session",
      sessionStatus: incomplete ? "in_progress" : "completed",
      completedAt: incomplete ? null : stamp,
      revision,
      reviewable: !incomplete,
      decisionStale: false,
      assessment: {
        score: 0,
        summary: null,
        recommendation: null,
        strengths: [],
        developmentAreas: [],
        concerns: [],
      },
      answers: [
        { question: "Describe your work.", answer: "Synthetic job-related answer.", score: 0 },
      ],
      answersTruncated: false,
      history: [],
    };
    const handoff = {
      campaignId: "campaign",
      recipientId: "recipient",
      applicationId: "application",
      externalJobId: "external-job",
      externalCandidateId: "candidate",
      revision,
      liveEnabled: false,
      ready: false,
      decision: null,
      targetStatus: null,
      reason: "Record a current human decision first.",
      mapping: {
        revision,
        advance: null,
        hold: null,
        decline: null,
        updatedAt: null,
        updatedBy: null,
      },
      history: [],
    };
    const prefix = "/api/zoho-recruit/campaigns";
    const execPath = `${prefix}/campaign/recipients/recipient/stage-execution`;
    // Synthetic Lexy-local ledger. Never a real Zoho or database client; every
    // stage-execution call is recorded here and answered by this fixture only.
    const exec = {
      verified: !!stageExecution?.verified,
      liveEnabled: !!stageExecution?.liveEnabled,
      ruleRevision: stageExecution?.ruleRevision ?? "f".repeat(64),
      rows: (stageExecution?.rows ?? []).map((r) => ({ ...r })),
      // Consumed per execute POST; empty means one accepted, unverified write.
      outcomes: [...(stageExecution?.executeOutcomes ?? [])],
      // Consumed per resolution POST; empty means one accepted, unverified local closure write.
      resolutionOutcomes: [...(stageExecution?.resolutionOutcomes ?? [])],
      // Test-only failed authority read status for the stage-execution GET (null = normal).
      getFailure: null,
      recoverOutcome: "observed_target",
      forbidden: false,
      calls: [],
    };
    const execWorkspace = () => {
      const held = exec.rows.some((r) => UNRESOLVED.includes(r.state));
      return {
        campaignId: "campaign",
        recipientId: "recipient",
        handoffRevision: handoff.revision,
        ruleRevision: exec.verified ? exec.ruleRevision : null,
        transitionVerified: exec.verified,
        liveEnabled: exec.liveEnabled,
        canPrepare: exec.verified && !held,
        reason: held
          ? "An earlier attempt remains unresolved. Only read-only recovery is available."
          : !exec.verified
            ? "Current application-specific evidence and independent employer review are required."
            : !exec.liveEnabled
              ? "Execution is disabled on this server. Preparation and approval never send."
              : "Execution requires a separate deliberate action on the exact approved request. No automatic retries.",
        requests: exec.rows.map((r) => ({
          id: r.id,
          revision: r.revision,
          state: r.state,
          currentStatus: r.currentStatus,
          targetStatus: r.targetStatus,
          decision: r.decision,
          preparedBy: r.preparedBy,
          approvedBy: r.approvedBy,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          stale: false,
          canApprove: r.state === "prepared" && exec.verified && !held,
          canWithdraw: ["prepared", "approved"].includes(r.state),
          canRecover: ["claimed", "review_required"].includes(r.state),
          // Test-only override: lets a case prove the client refuses execute even when a row claims canExecute.
          canExecute:
            r.canExecuteOverride ??
            (exec.liveEnabled && exec.verified && r.state === "approved" && !held),
          executionRequestId: r.executionRequestId,
          sequence: r.sequence,
          canProposeResolution: r.canProposeResolution,
          canReviewResolution: r.canReviewResolution,
          resolution: r.resolution ? { ...r.resolution } : null,
        })),
      };
    };
    await page.setViewport({ width: mobile ? 390 : 1200, height: 900 });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on("request", async (request) => {
      const url = new URL(request.url());
      const send = (body, status = 200) =>
        request.respond({ status, contentType: "application/json", body: JSON.stringify(body) });
      try {
        if (url.protocol === "data:") return await request.continue();
        // Resolve stylesheet imports locally; never contact the font provider.
        if (url.hostname === "fonts.googleapis.com")
          return await request.respond({ status: 200, contentType: "text/css", body: "" });
        assert.equal(url.origin, origin, "External network request blocked");
        const p = url.pathname;
        const method = request.method();
        if (responseGate && method === responseGate.method && p.endsWith(responseGate.suffix)) {
          const gate = responseGate;
          responseGate = null;
          gate.start();
          await gate.promise;
        }
        if (p === "/__zoho" && method === "GET")
          return await request.respond({ status: 200, contentType: "text/html", body: html });
        if (p === "/api/auth/me" && method === "GET") return await send(fixtureAuth);
        if (p === "/__fixture/set-auth" && method === "POST") {
          fixtureAuth = JSON.parse(request.postData());
          return await send({ ok: true });
        }
        const detail = () => ({
          campaign,
          recipients: [
            {
              id: "recipient",
              applicationId: "application",
              candidateId: "candidate",
              state: deliveryState,
              reason: null,
              sessionId: "session",
              interviewStatus: review.sessionStatus,
              ...(evidence
                ? {
                    deliveryEvidence: {
                      acceptance: deliveryState === "sent" && receipt ? "recorded" : "unknown",
                      providerMessageId: receipt ? "saved-provider-reference" : null,
                      lastStateChangeAt: stamp,
                      needsReview: ["sending", "review_required"].includes(deliveryState),
                      delivery: "unverified",
                    },
                  }
                : {}),
            },
          ],
        });
        const notePreviewPath = `${prefix}/campaign/recipients/recipient/note-preview`;
        const notePublicationPath = `${prefix}/campaign/recipients/recipient/note-publication`;
        if (method === "POST" && p === notePreviewPath) {
          const body = JSON.parse(request.postData());
          notePreviews.push(body);
          assert.deepEqual(body, { includeAssessment: !!body.includeAssessment });
          if (notePreviewFailure)
            return await send({ error: "Synthetic note preview unavailable" }, 503);
          return await send({
            revision,
            title: "Lexy note",
            content: "EXACT APPROVED TEXT",
            destination: "Candidates",
            externalCandidateId: "123",
            externalJobId: "456",
            applicationId: "789",
            includeAssessment: body.includeAssessment,
            writeAuthorized: noteWriteAuthorized,
            canPublish: noteCanPublish && noteWriteAuthorized,
            history: noteHistory,
          });
        }
        if (method === "POST" && p === notePublicationPath) {
          const body = JSON.parse(request.postData());
          writes.push({ p, body });
          assert.deepEqual(body, {
            includeAssessment: !!body.includeAssessment,
            expectedRevision: revision,
            confirm: true,
          });
          if (noteHistory.length) throw new Error("Second note publication was blocked");
          if (notePublicationState === "published") {
            const receipt = {
              id: "11111111-1111-4111-8111-111111111111",
              revision,
              state: "published",
              providerNoteId: "999",
              at: stamp,
            };
            noteHistory = [receipt];
            noteCanPublish = false;
            return await send(receipt);
          }
          const receipt = {
            id: "22222222-2222-4222-8222-222222222222",
            revision,
            state: "unconfirmed",
            providerNoteId: null,
            at: stamp,
          };
          noteHistory = [receipt];
          noteCanPublish = false;
          return await send(receipt);
        }
        if (method === "POST" && p === `${prefix}/campaign/recipients/recipient/review-export`) {
          const body = JSON.parse(request.postData());
          writes.push({ p, body });
          assert.deepEqual(body, {
            expectedRevision: review.revision,
            expectedHandoffRevision: handoff.revision,
            confirm: true,
          });
          if (auditFailure) return await send({ error: "Audit preparation unavailable" }, 503);
          return await send({
            id: "11111111-1111-4111-8111-111111111111",
            campaignId: "campaign",
            recipientId: "recipient",
            reviewId: review.history[0].id,
            reviewRevision: review.revision,
            handoffRevision: handoff.revision,
            preparedAt: stamp,
            state: "prepared",
            delivery: "unverified",
          });
        }
        if (p === prefix && method === "POST") {
          const body = JSON.parse(request.postData());
          writes.push({ p, body });
          assert.equal(body.revision, revision);
          assert.equal(body.jobId, "job");
          assert.equal(body.planId, "plan");
          assert.equal(body.confirm, true);
          assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
          return await send(detail());
        }
        // Stage execution: local ledger only. Zoho writes are represented by the
        // fixture outcome; the real execute endpoint is never reached.
        if (method === "GET" && p === execPath) {
          if (exec.forbidden)
            return await send({ error: "Stage execution is not available to this account." }, 403);
          if (exec.getFailure)
            return await send(
              { error: "Stage execution is temporarily unavailable." },
              exec.getFailure,
            );
          return await send(execWorkspace());
        }
        if (method === "POST" && p === execPath) {
          const body = JSON.parse(request.postData());
          exec.calls.push({ kind: "prepare", body, path: p });
          assert.deepEqual(Object.keys(body).sort(), [
            "confirm",
            "expectedRevision",
            "expectedRuleRevision",
            "requestId",
          ]);
          assert.equal(body.confirm, true);
          assert.match(body.requestId, UUID_RE);
          assert.equal(body.expectedRevision, handoff.revision);
          assert.equal(body.expectedRuleRevision, exec.ruleRevision);
          assert.ok(exec.verified, "prepare requires verified evidence");
          exec.rows.unshift(execRow(body.requestId, "prepared", newRev(), { approvedBy: null }));
          return await send(execWorkspace());
        }
        // Local closure ledger only: contract and UI gating, never Zoho or a provider.
        if (method === "POST" && p.startsWith(`${execPath}/`) && p.endsWith("/resolution")) {
          const id = p.slice(execPath.length + 1, -"/resolution".length);
          const body = JSON.parse(request.postData());
          const row = exec.rows.find((r) => r.id === id);
          assert.ok(row, "Unknown stage-execution row for resolution");
          assert.deepEqual(Object.keys(body).sort(), [
            "acknowledgeNoRetry",
            "acknowledgeUnknown",
            "action",
            "commandId",
            "confirm",
            "evidenceReference",
            "expectedRevision",
            "expectedSequence",
            "expectedSourceRevision",
            "reason",
          ]);
          assert.equal(body.confirm, true);
          assert.equal(body.acknowledgeUnknown, true);
          assert.equal(body.acknowledgeNoRetry, true);
          assert.match(body.commandId, UUID_RE);
          assert.match(body.expectedRevision, HEX64, "revision is 64 lowercase hex");
          assert.match(body.expectedSourceRevision, HEX64, "source revision is 64 lowercase hex");
          assert.equal(body.expectedRevision, row.revision, "exact row revision");
          assert.equal(body.expectedSourceRevision, handoff.revision, "exact source revision");
          assert.equal(body.expectedSequence, row.sequence, "exact sequence");
          assert.ok(["propose", "approve", "reject"].includes(body.action), "closed action set");
          assert.ok(body.reason.length >= 20 && body.reason.length <= 1000, "reason 20..1000");
          assert.ok(
            body.evidenceReference.length >= 10 && body.evidenceReference.length <= 200,
            "reference 10..200",
          );
          // UI gating contract: the client may only send what the row's capability flags allow.
          if (body.action === "propose")
            assert.ok(row.canProposeResolution && !row.resolution, "propose only when offered");
          else
            assert.ok(
              row.canReviewResolution && row.resolution && !row.resolution.review,
              "review only when offered",
            );
          exec.calls.push({ kind: `resolution:${body.action}`, body, path: p });
          const outcome = exec.resolutionOutcomes.shift() ?? "accepted";
          if (outcome === "uncommitted-network") return await request.abort("failed");
          if (body.action === "propose") {
            row.resolution = {
              proposedBy: fixtureAuth.id,
              proposedAt: Date.parse(stamp),
              reason: body.reason,
              evidenceReference: body.evidenceReference,
              observedStatus: "Screening",
              review: null,
            };
          } else {
            row.resolution = {
              ...row.resolution,
              review: {
                action: body.action,
                by: fixtureAuth.id,
                at: Date.parse(stamp),
                reason: body.reason,
                evidenceReference: body.evidenceReference,
              },
            };
          }
          // Either a proposal or a review closes the offered capability for this actor.
          row.canProposeResolution = false;
          row.canReviewResolution = false;
          // Closure changes the journal sequence, not the frozen stage-request revision.
          row.sequence++;
          // Model a committed server transaction whose response never reaches
          // the caller, or whose response fails after commit. GET must reveal it.
          if (outcome === "committed-network") return await request.abort("failed");
          if (outcome === "committed-409")
            return await send({ error: "Synthetic failure after saved closure" }, 409);
          if (outcome === "committed-422")
            return await send({ error: "Synthetic response validation failure after commit" }, 422);
          return await send(execWorkspace());
        }
        if (method === "POST" && p.startsWith(`${execPath}/`) && p.endsWith("/actions")) {
          const id = p.slice(execPath.length + 1, -"/actions".length);
          const body = JSON.parse(request.postData());
          const row = exec.rows.find((r) => r.id === id);
          assert.ok(row, "Unknown stage-execution row");
          assert.deepEqual(Object.keys(body).sort(), [
            "action",
            "confirm",
            "expectedRevision",
            "expectedRuleRevision",
            "requestId",
          ]);
          assert.equal(body.confirm, true);
          assert.match(body.requestId, UUID_RE);
          assert.equal(body.expectedRevision, row.revision, "exact row revision");
          assert.equal(
            body.expectedRuleRevision,
            exec.verified ? exec.ruleRevision : null,
            "exact rule revision",
          );
          exec.calls.push({ kind: body.action, body, path: p });
          if (body.action === "approve") {
            assert.equal(row.state, "prepared");
            row.state = "approved";
            row.approvedBy = "staff";
            row.revision = newRev();
            return await send(execWorkspace());
          }
          if (body.action === "execute") {
            assert.equal(row.state, "approved", "execute only from an approved row");
            assert.ok(exec.liveEnabled && exec.verified, "execute requires runtime and evidence");
            const outcome = exec.outcomes.shift() ?? "accepted";
            if (outcome === "uncommitted-network") return await request.abort("failed");
            row.state = outcome === "accepted" ? "provider_accepted" : "claimed";
            row.revision = newRev();
            row.executionRequestId = body.requestId;
            if (outcome === "claimed-network") return await request.abort("failed");
            if (outcome === "claimed-409")
              return await send({ error: "Stage execution changed." }, 409);
            if (outcome === "claimed-422")
              return await send({ error: "Stage execution response could not be confirmed." }, 422);
            return await send(execWorkspace());
          }
          if (body.action === "recover") {
            assert.ok(
              ["claimed", "review_required"].includes(row.state),
              "recover only unresolved",
            );
            row.state = exec.recoverOutcome;
            row.revision = newRev();
            return await send(execWorkspace());
          }
          assert.fail(`Unsupported stage-execution action ${body.action}`);
        }
        if (method === "GET") {
          if (p === prefix)
            return await send({
              jobs: [
                {
                  id: "job",
                  externalJobId: "external-job",
                  title: "Fixture engineer",
                  plans: [{ id: "plan", title: "Fixture plan", language: "en", questionCount: 1 }],
                },
              ],
              campaigns: [campaign],
            });
          if (p === `${prefix}/campaign`) return await send(detail());
          if (p === `${prefix}/campaign/reviews`)
            return await send({
              campaignId: "campaign",
              rows: [
                {
                  recipientId: "recipient",
                  applicationId: "application",
                  externalCandidateId: "candidate",
                  candidateName: review.candidateName,
                  sessionStatus: review.sessionStatus,
                  score: 0,
                  reviewable: review.reviewable,
                  decision: review.history[0]?.decision ?? null,
                  decisionStale: review.decisionStale,
                },
              ],
            });
          if (p === `${prefix}/campaign/recipients/recipient/review`) return await send(review);
          // This legacy journey exercises simulations. The separate stage-request
          // fixture covers local approval/recovery; never silently forward its reads.
          if (p === `${prefix}/campaign/recipients/recipient/stage-requests`)
            return await send({
              campaignId: "campaign",
              recipientId: "recipient",
              handoffRevision: handoff.revision,
              writeConsentSaved: false,
              transitionVerified: false,
              liveEnabled: false,
              canPrepare: false,
              blocker: "application_transition_contract_required",
              reason: "Separate local stage-request journey; live execution is unavailable.",
              requests: [],
            });
          // Parent mounts ZohoStageRules: default closed, no saved employer rule, live disabled.
          if (p === `${prefix}/campaign/recipients/recipient/stage-rules`)
            return await send({
              campaignId: "campaign",
              recipientId: "recipient",
              sourceRevision: handoff.revision,
              currentApplication: {
                applicationId: "application",
                candidateId: "candidate",
                jobId: "job",
              },
              status: "proposal_required",
              canPropose: false,
              canVerify: false,
              canRevoke: false,
              liveEnabled: false,
              reason: "No employer-reviewed transition rule is saved for this application.",
              currentRule: null,
              history: [],
            });
          if (p === `${prefix}/campaign/recipients/recipient/handoff`) return await send(handoff);
        }
        if (method === "POST" && p === `${prefix}/campaign/recipients/recipient/stage-validation`) {
          const body = JSON.parse(request.postData());
          writes.push({ p, body });
          assert.deepEqual(body, { expectedRevision: handoff.revision, confirm: true });
          return await send({
            handoffRevision: handoff.revision,
            mappingRevision: handoff.mapping.revision,
            connectionRevision: "11111111-1111-4111-8111-111111111111",
            checkedAt: stamp,
            applicationId: handoff.applicationId,
            externalJobId: handoff.externalJobId,
            externalCandidateId: handoff.externalCandidateId,
            currentApplicationStatus: "New",
            identityVerified: true,
            catalogScope: "organization_default",
            transitionEligibilityVerified: false,
            liveEnabled: false,
            catalogRevision: "e".repeat(64),
            mappings: ["advance", "hold", "decline"].map((decision) => ({
              decision,
              targetStatus: handoff.mapping[decision],
              result: handoff.mapping[decision] ? "matched" : "unset",
              statusId: handoff.mapping[decision] ? "11" : null,
              stageId: handoff.mapping[decision] ? "10" : null,
              nextAction: handoff.mapping[decision]
                ? "transition_verification_required"
                : "mapping_required",
              explanation: handoff.mapping[decision]
                ? "Permitted next transitions for this application have not been verified. Do not send an update from this result."
                : "Save a proposed canonical Zoho status for this decision, then check again.",
              canWrite: false,
            })),
            reason: "Default catalog match only; no transition permission or status change.",
          });
        }
        if (method === "PUT" && p === `${prefix}/campaign/stage-mapping`) {
          const body = JSON.parse(request.postData());
          writes.push({ p, body });
          assert.equal(body.confirm, true);
          assert.equal(body.expectedRevision, handoff.mapping.revision);
          handoff.mapping = {
            revision: "b".repeat(64),
            advance: body.advance,
            hold: body.hold,
            decline: body.decline,
            updatedAt: stamp,
            updatedBy: "staff",
          };
          handoff.revision = "c".repeat(64);
          handoff.targetStatus = handoff.mapping.advance;
          handoff.ready = !!handoff.decision && !!handoff.targetStatus;
          return await send(handoff.mapping);
        }
        if (method === "POST" && p === `${prefix}/campaign/recipients/recipient/handoff`) {
          const body = JSON.parse(request.postData());
          writes.push({ p, body });
          assert.equal(body.mode, "simulation");
          assert.equal(body.confirm, true);
          assert.equal(body.expectedRevision, handoff.revision);
          assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
          assert.ok(handoff.ready);
          handoff.history.push({
            id: "test-event",
            state: "simulated",
            targetStatus: handoff.targetStatus,
            decision: handoff.decision,
            approvedBy: "staff",
            createdAt: stamp,
          });
          return await send(handoff);
        }
        if (
          method === "POST" &&
          [`${prefix}/campaign/action`, `${prefix}/campaign/recipients/recipient/review`].includes(
            p,
          )
        ) {
          const body = JSON.parse(request.postData());
          writes.push({ p, body });
          if (p.endsWith("/action")) {
            assert.deepEqual(body, { action: "approve", snapshotHash: revision, confirm: true });
            campaign.state = "approved";
            return await send(detail());
          }
          assert.equal(body.confirm, true);
          assert.equal(body.expectedRevision, review.revision);
          assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
          assert.ok(body.reason.trim().length >= 10);
          if (conflict) {
            conflict = false;
            review.revision = "b".repeat(64);
            return await send({ error: "Evidence changed" }, 409);
          }
          review.history.unshift({
            id: `history-${review.history.length}`,
            decision: body.decision,
            reason: body.reason,
            reviewedBy: "staff",
            createdAt: stamp,
            evidenceCurrent: true,
          });
          review.revision = "c".repeat(64);
          handoff.decision = body.decision;
          handoff.targetStatus = handoff.mapping[body.decision];
          handoff.ready = !!handoff.targetStatus;
          handoff.revision = "d".repeat(64);
          return await send(review);
        }
        assert.ok(
          !p.startsWith("/api/") && ["GET", "HEAD"].includes(method),
          `Unexpected request ${method} ${p}`,
        );
        await request.continue();
      } catch (e) {
        unexpected.push(e.message);
        if (!request.isInterceptResolutionHandled()) await request.abort("blockedbyclient");
      }
    });
    const click = (id) => page.click(T(id));
    const disabled = (id) => page.$eval(T(id), (el) => el.disabled);
    const wait = (id) => page.waitForSelector(T(id));
    const text = (id) => page.$eval(T(id), (el) => el.textContent);
    try {
      await page.goto(`${origin}/__zoho`);
      await page.waitForFunction(() => typeof window.mountFixture === "function");
      await page.evaluate((available) => window.mountFixture(available), connected);
      const initialDetail = holdInitialDetail ? holdResponse("/campaign", "GET") : null;
      await wait("button-select-campaign-campaign");
      await click("button-select-campaign-campaign");
      await wait(connected ? "button-approve-campaign" : "text-provider-unavailable");
      await run({
        page,
        click,
        disabled,
        wait,
        text,
        writes,
        notePreviews,
        review,
        handoff,
        holdResponse,
        exec,
        initialDetail,
        conflict: () => {
          conflict = true;
        },
      });
      assert.deepEqual(unexpected, [], "No unhandled API or external requests allowed");
      assert.deepEqual(errors, [], "No browser exceptions allowed");
      console.log(`PASS ${name}`);
    } finally {
      await context.close();
    }
  }
  const openReview = async (f) => {
    await f.wait("row-review-recipient");
    await f.click("row-review-recipient");
    await f.wait("select-review-decision");
  };
  const fill = async (f, reason = "Job-related evidence supports this decision.") => {
    await f.page.select(T("select-review-decision"), "advance");
    await f.page.type(T("input-review-reason"), reason);
  };
  const waitStatus = (f, id, label) =>
    f.page.waitForFunction(
      (testid, text) =>
        document.querySelector(`[data-testid="${testid}"]`)?.textContent.includes(text),
      { timeout: 4000 },
      `status-stage-execution-${id}`,
      label,
    );
  const waitEnabled = (f, testid) =>
    f.page.waitForFunction(
      (t) => {
        const el = document.querySelector(`[data-testid="${t}"]`);
        return !!el && !el.disabled;
      },
      { timeout: 4000 },
      testid,
    );
  const waitGone = (f, testid) =>
    f.page.waitForFunction(
      (t) => !document.querySelector(`[data-testid="${t}"]`),
      { timeout: 4000 },
      testid,
    );
  const isChecked = (f, testid) => f.page.$eval(T(testid), (el) => el.checked);
  const noneChecked = (f) =>
    f.page.evaluate(
      () =>
        document.querySelectorAll(
          '[data-testid="section-stage-execution"] input[type="checkbox"]:checked',
        ).length === 0,
    );
  const callsOf = (f, kind) => f.exec.calls.filter((c) => c.kind === kind);
  const settle = (f) => f.page.waitForNetworkIdle({ idleTime: 300, timeout: 4000 });
  const rowText = (f, id) => f.text(`row-stage-execution-${id}`);
  const refreshStage = async (f) => {
    await waitEnabled(f, "button-refresh-stage-execution");
    await f.click("button-refresh-stage-execution");
    await settle(f);
  };
  const openStageExecution = async (f) => {
    await openReview(f);
    await f.wait("section-stage-execution");
    await f.wait("checkbox-prepare-execution-ack");
  };
  // Each action has its own acknowledgement; the button is inert until it is checked.
  const armAndClick = async (f, action, id) => {
    await f.click(`checkbox-execution-${action}-${id}`);
    await waitEnabled(f, `button-execution-${action}-${id}`);
    await f.click(`button-execution-${action}-${id}`);
  };
  const approvedRows = () => [execRow(ROW_A, "approved", hexRev(0x41))];
  const journeyFixture = {
    verified: true,
    liveEnabled: true,
    executeOutcomes: ["claimed-network"],
  };
  // Full critical journey: prepare -> approve -> explicit execute -> uncertain -> recovery.
  const journey = async (f) => {
    await openStageExecution(f);
    assert.equal((await f.text("text-stage-execution-live")).trim(), "Enabled on server");
    assert.equal(
      await f.disabled("button-prepare-execution"),
      true,
      "prepare waits for its checkbox",
    );
    await f.click("checkbox-prepare-execution-ack");
    await waitEnabled(f, "button-prepare-execution");
    assert.equal(f.exec.calls.length, 0, "acknowledging prepare writes nothing");
    await f.click("button-prepare-execution");
    await f.page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid^="status-stage-execution-"]')
          ?.textContent.includes("Prepared for execution"),
      { timeout: 4000 },
    );
    const [prepare] = callsOf(f, "prepare");
    const id = prepare.body.requestId;
    assert.equal(f.exec.calls.length, 1, "prepare is the only call so far");
    assert.match(id, UUID_RE);
    assert.deepEqual(prepare.body, {
      expectedRevision: f.handoff.revision,
      expectedRuleRevision: f.exec.ruleRevision,
      requestId: id,
      confirm: true,
    });
    assert.equal(f.writes.length, 0, "no legacy write channel is used");
    assert.equal(
      await f.page.$(T(`checkbox-execution-execute-${id}`)),
      null,
      "prepared row has no execute control",
    );
    assert.equal(
      await f.disabled(`button-execution-approve-${id}`),
      true,
      "approve needs its own checkbox",
    );
    assert.doesNotMatch(await rowText(f, id), /Execution ref/);

    // Approval: local state change only.
    const preparedRev = f.exec.rows[0].revision;
    await armAndClick(f, "approve", id);
    await waitStatus(f, id, "Approved, not executed");
    assert.deepEqual(
      f.exec.calls.map((c) => c.kind),
      ["prepare", "approve"],
      "approval never calls execute",
    );
    const [approve] = callsOf(f, "approve");
    assert.deepEqual(approve.body, {
      expectedRevision: preparedRev,
      expectedRuleRevision: f.exec.ruleRevision,
      requestId: approve.body.requestId,
      action: "approve",
      confirm: true,
    });
    assert.match(approve.body.requestId, UUID_RE);
    assert.notEqual(approve.body.requestId, id, "approval is its own command");
    assert.equal(await isChecked(f, `checkbox-execution-execute-${id}`), false);
    assert.equal(
      await f.disabled(`button-execution-execute-${id}`),
      true,
      "approval does not arm execute",
    );
    assert.equal(
      await f.page.$(T("text-stage-execution-notice")),
      null,
      "success notice must not outlive the row state change it describes",
    );

    // Explicit execute: its own checkbox and button, exact revisions, no retry.
    const approvedRev = f.exec.rows[0].revision;
    await f.click(`checkbox-execution-execute-${id}`);
    await waitEnabled(f, `button-execution-execute-${id}`);
    assert.equal(callsOf(f, "execute").length, 0, "arming execute calls nothing");
    await f.click(`button-execution-execute-${id}`);
    await waitStatus(f, id, "Execution claimed, outcome unknown");
    await f.wait("text-stage-execution-error");
    const error = await f.text("text-stage-execution-error");
    assert.match(error, /outcome is unknown/);
    assert.match(error, /Do not assume it failed/);
    await settle(f);
    const executes = callsOf(f, "execute");
    assert.equal(executes.length, 1, "no automatic resend after an ambiguous response");
    const [execute] = executes;
    assert.deepEqual(execute.body, {
      expectedRevision: approvedRev,
      expectedRuleRevision: f.exec.ruleRevision,
      requestId: execute.body.requestId,
      action: "execute",
      confirm: true,
    });
    assert.match(execute.body.requestId, UUID_RE);
    assert.match(await rowText(f, id), new RegExp(`Execution ref ${execute.body.requestId}`));
    assert.equal(
      await f.page.$(T(`button-execution-execute-${id}`)),
      null,
      "claimed row cannot execute",
    );
    assert.equal(await f.page.$(T(`checkbox-execution-execute-${id}`)), null);
    assert.equal(
      await f.disabled(`button-execution-recover-${id}`),
      true,
      "recover needs its own checkbox",
    );

    // Recovery: read-only, observed target is not delivery proof.
    const claimedRev = f.exec.rows[0].revision;
    await armAndClick(f, "recover", id);
    await waitStatus(f, id, "Target observed, delivery not proven");
    const [recover] = callsOf(f, "recover");
    assert.deepEqual(recover.body, {
      expectedRevision: claimedRev,
      expectedRuleRevision: f.exec.ruleRevision,
      requestId: recover.body.requestId,
      action: "recover",
      confirm: true,
    });
    assert.deepEqual(
      f.exec.calls.map((c) => c.kind),
      ["prepare", "approve", "execute", "recover"],
    );
    assert.doesNotMatch(
      await rowText(f, id),
      /Verified in Zoho/,
      "observed target is not delivery proof",
    );
    assert.equal(await f.page.$(T(`button-execution-execute-${id}`)), null);
    assert.equal(await f.page.$(T(`button-execution-recover-${id}`)), null);
    assert.equal(await noneChecked(f), true, "recovery leaves no stale acknowledgement");
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "no horizontal overflow",
    );
    assert.equal(
      await f.page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="section-stage-execution"] button')].every(
          (el) => el.getBoundingClientRect().right <= window.innerWidth + 1,
        ),
      ),
      true,
      "stage-execution buttons stay inside the viewport",
    );
    assert.equal(f.writes.length, 0);
  };
  // Shared: an uncertain execute (4xx or network) must not be resent automatically.
  const uncertainExecute = async (f, label) => {
    await openStageExecution(f);
    await f.wait(`checkbox-execution-execute-${ROW_A}`);
    await armAndClick(f, "execute", ROW_A);
    await waitStatus(f, ROW_A, label);
    await f.wait("text-stage-execution-error");
    await settle(f);
    assert.equal(callsOf(f, "execute").length, 1, "a failed-after-effect response is never resent");
    assert.equal(
      await f.page.$(T(`button-execution-execute-${ROW_A}`)),
      null,
      "no execute after claim",
    );
    assert.equal(await f.page.$(T(`checkbox-execution-execute-${ROW_A}`)), null);
    await f.wait(`checkbox-execution-recover-${ROW_A}`);
    assert.equal(f.exec.calls.length, 1);
    return f.text("text-stage-execution-error");
  };
  // Local closure (resolution) helpers. Test ids come from the component's data-testids.
  const RES = {
    panel: `stage-resolution-${ROW_P}`,
    open: `open-resolution-${ROW_P}`,
    reason: `resolution-reason-${ROW_P}`,
    evidence: `resolution-evidence-${ROW_P}`,
    unknown: `resolution-unknown-${ROW_P}`,
    noRetry: `resolution-no-retry-${ROW_P}`,
    propose: `propose-resolution-${ROW_P}`,
    approve: `approve-resolution-${ROW_P}`,
    reject: `reject-resolution-${ROW_P}`,
  };
  const RES_PATH = `/api/zoho-recruit/campaigns/campaign/recipients/recipient/stage-execution/${ROW_P}/resolution`;
  const resolutionCalls = (f) => f.exec.calls.filter((c) => c.kind.startsWith("resolution:"));
  const waitResolution = (f, label) =>
    f.page.waitForFunction(
      (testid, text) =>
        document.querySelector(`[data-testid="${testid}"]`)?.textContent.includes(text),
      { timeout: 4000 },
      RES.panel,
      label,
    );
  const waitAlert = (f, label) =>
    f.page.waitForFunction(
      (testid, text) =>
        document
          .querySelector(`[data-testid="${testid}"] [role="alert"]`)
          ?.textContent.includes(text),
      { timeout: 4000 },
      RES.panel,
      label,
    );
  const openClosure = async (f) => {
    await f.click(RES.open);
    await f.wait(RES.reason);
  };
  const fillDraft = async (f, reason, evidence) => {
    await f.page.type(T(RES.reason), reason);
    await f.page.type(T(RES.evidence), evidence);
  };
  const confirmDraft = async (f) => {
    await f.click(RES.unknown);
    await f.click(RES.noRetry);
  };
  const draftIsEmpty = async (f) => {
    assert.equal(await f.page.$eval(T(RES.reason), (el) => el.value), "", "reason starts empty");
    assert.equal(
      await f.page.$eval(T(RES.evidence), (el) => el.value),
      "",
      "reference starts empty",
    );
    assert.equal(await isChecked(f, RES.unknown), false, "attribution box starts unchecked");
    assert.equal(await isChecked(f, RES.noRetry), false, "no-retry box starts unchecked");
  };
  const expectDraftCleared = async (f) => {
    await waitGone(f, RES.reason);
    await f.wait(RES.open);
    await openClosure(f);
    await draftIsEmpty(f);
  };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assertFitsViewport = async (f, label) => {
    assert.equal(
      await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      `${label}: no horizontal overflow`,
    );
    assert.equal(
      await f.page.evaluate(() =>
        [
          ...document.querySelectorAll(
            '[data-testid="section-stage-execution"] button, [data-testid="section-stage-execution"] textarea, [data-testid="section-stage-execution"] input',
          ),
        ].every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1),
      ),
      true,
      `${label}: controls stay inside the viewport`,
    );
  };
  const proposableRows = () => [
    execRow(ROW_P, "observed_other", hexRev(0x61), { canProposeResolution: true }),
  ];
  const reviewableRows = () => [
    execRow(ROW_P, "observed_other", hexRev(0x62), {
      canReviewResolution: true,
      resolution: {
        proposedBy: "staff",
        proposedAt: Date.parse(stamp),
        reason: PROPOSAL_REASON,
        evidenceReference: PROPOSAL_EVIDENCE,
        observedStatus: "Screening",
        review: null,
      },
    }),
  ];
  const resolvedStage = (rows, extra = {}) => ({
    verified: true,
    liveEnabled: true,
    rows,
    ...extra,
  });
  const both = (name, run, options = {}) => [
    [`${name} (desktop)`, run, options],
    [`${name} (390px)`, run, { ...options, mobile: true }],
  ];
  const committedClosureFailure = (action) => async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await openClosure(f);
    const reason = action === "propose" ? PROPOSAL_REASON : REVIEW_REASON;
    const evidence = action === "propose" ? PROPOSAL_EVIDENCE : REVIEW_EVIDENCE;
    const revision = f.exec.rows[0].revision;
    const sequence = f.exec.rows[0].sequence;
    await fillDraft(f, reason, evidence);
    await confirmDraft(f);
    await waitEnabled(f, RES[action]);
    await f.click(RES[action]);
    const savedLabel =
      action === "propose"
        ? "Closure proposed — hold remains"
        : action === "approve"
          ? "Closed after independent review — delivery remains unknown"
          : "Closure rejected — hold remains";
    await waitResolution(f, savedLabel);
    await pause(1000);
    assert.equal(resolutionCalls(f).length, 1, "committed failure must never automatically repeat");
    assert.equal(f.exec.calls.length, 1, "no execute, prepare or recovery request is triggered");
    const [call] = resolutionCalls(f);
    assert.equal(call.kind, `resolution:${action}`);
    assert.equal(call.path, RES_PATH);
    assert.equal(call.body.expectedSequence, sequence);
    assert.equal(call.body.expectedRevision, revision);
    assert.equal(call.body.expectedSourceRevision, f.handoff.revision);
    assert.match(call.body.commandId, UUID_RE);
    assert.equal(call.body.reason, reason);
    assert.equal(call.body.evidenceReference, evidence);
    assert.equal(f.exec.rows[0].sequence, sequence + 1);
    assert.equal(f.exec.rows[0].revision, revision, "frozen request revision is unchanged");
    await refreshStage(f);
    await waitResolution(f, savedLabel);
    const panel = await f.text(RES.panel);
    assert(
      panel.includes(reason) && panel.includes(evidence),
      "saved review evidence survives refresh",
    );
    assert.match(panel, /not proof of delivery or permission to resend/);
    assert.match(await rowText(f, ROW_P), /Different status observed/);
    assert.doesNotMatch(await rowText(f, ROW_P), /Verified in Zoho|Execution ref/);
    for (const id of [
      RES.reason,
      RES.evidence,
      RES.unknown,
      RES.noRetry,
      RES.propose,
      RES.approve,
      RES.reject,
      `button-execution-execute-${ROW_P}`,
    ])
      assert.equal(await f.page.$(T(id)), null, `${id}: no stale confirmation or resend control`);
    assert.equal(resolutionCalls(f).length, 1, "explicit GET refresh never repeats a command");
    assert.equal(f.writes.length, 0, "no legacy write side channel");
    await assertFitsViewport(f, `saved ${action} after interrupted response`);
  };
  const otherAdmin = (role = "tenant_admin") => ({
    id: "other-admin",
    tenantId: "tenant",
    name: "Other admin",
    role,
    email: "other@example.invalid",
    createdAt: stamp,
  });
  // Proposer: draft, two explicit confirmations, one proposal; no send and no execute.
  const proposeClosure = async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    assert.match(await f.text("text-stage-execution-reason"), /earlier attempt remains unresolved/);
    assert.equal(await f.disabled("button-prepare-execution"), true, "held: no new preparation");
    assert.equal(await f.page.$(T(RES.propose)), null, "no proposal control before opening");
    await openClosure(f);
    assert.equal(await f.disabled(RES.propose), true, "an empty draft cannot propose");
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    assert.equal(await f.disabled(RES.propose), true, "explicit confirmations are still required");
    await f.click(RES.unknown);
    assert.equal(await f.disabled(RES.propose), true, "the no-retry confirmation is also required");
    await f.click(RES.noRetry);
    await waitEnabled(f, RES.propose);
    await assertFitsViewport(f, "open closure form");
    assert.equal(f.exec.calls.length, 0, "drafting and confirming call nothing");
    const before = f.exec.rows[0].revision;
    await f.click(RES.propose);
    await waitResolution(f, "Closure proposed");
    await settle(f);
    assert.equal(f.exec.calls.length, 1, "the proposal is the only stage-execution call");
    const calls = resolutionCalls(f);
    assert.equal(calls.length, 1, "exactly one resolution POST");
    const [call] = calls;
    assert.equal(call.path, RES_PATH);
    assert.match(call.body.commandId, UUID_RE);
    assert.deepEqual(call.body, {
      action: "propose",
      commandId: call.body.commandId,
      expectedRevision: before,
      expectedSourceRevision: f.handoff.revision,
      expectedSequence: 1,
      reason: PROPOSAL_REASON,
      evidenceReference: PROPOSAL_EVIDENCE,
      confirm: true,
      acknowledgeUnknown: true,
      acknowledgeNoRetry: true,
    });
    const panel = await f.text(RES.panel);
    assert.match(panel, /Closure proposed — hold remains/);
    assert.ok(panel.includes(PROPOSAL_REASON) && panel.includes(PROPOSAL_EVIDENCE));
    for (const id of [RES.open, RES.propose, RES.approve, RES.reject])
      assert.equal(await f.page.$(T(id)), null, `${id} is gone after proposing`);
    assert.match(await rowText(f, ROW_P), /Different status observed/, "observation persists");
    assert.doesNotMatch(await rowText(f, ROW_P), /Verified in Zoho|Execution ref/);
    assert.equal(await f.page.$(T(`checkbox-execution-execute-${ROW_P}`)), null);
    assert.equal(await f.page.$(T(`button-execution-execute-${ROW_P}`)), null);
    assert.equal(f.writes.length, 0, "no legacy write channel");
    await assertFitsViewport(f, "after proposal");
  };
  // Distinct reviewer: starts with an empty form, then approves or rejects with its own evidence.
  const reviewClosure = async (f, decision) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await waitResolution(f, "Closure proposed — hold remains");
    assert.equal(await f.page.$(T(RES.propose)), null, "reviewer is not offered a new proposal");
    await openClosure(f);
    await draftIsEmpty(f);
    assert.equal(await f.disabled(RES.approve), true, "approve needs both confirmations");
    assert.equal(await f.disabled(RES.reject), true, "reject needs both confirmations");
    await fillDraft(f, REVIEW_REASON, REVIEW_EVIDENCE);
    await confirmDraft(f);
    const button = decision === "approve" ? RES.approve : RES.reject;
    await waitEnabled(f, button);
    assert.equal(f.exec.calls.length, 0, "reviewing drafts call nothing");
    const before = f.exec.rows[0].revision;
    await f.click(button);
    await waitResolution(
      f,
      decision === "approve"
        ? "Closed after independent review"
        : "Closure rejected — hold remains",
    );
    await settle(f);
    assert.equal(f.exec.calls.length, 1, "the review is the only stage-execution call");
    const [call] = resolutionCalls(f);
    assert.equal(call.kind, `resolution:${decision}`);
    assert.equal(call.path, RES_PATH);
    assert.deepEqual(call.body, {
      action: decision,
      commandId: call.body.commandId,
      expectedRevision: before,
      expectedSourceRevision: f.handoff.revision,
      expectedSequence: 1,
      reason: REVIEW_REASON,
      evidenceReference: REVIEW_EVIDENCE,
      confirm: true,
      acknowledgeUnknown: true,
      acknowledgeNoRetry: true,
    });
    assert.match(call.body.commandId, UUID_RE);
    const panel = await f.text(RES.panel);
    assert.ok(
      panel.includes(REVIEW_REASON) && panel.includes(REVIEW_EVIDENCE),
      "own evidence shown",
    );
    if (decision === "approve") {
      assert.match(panel, /Closed after independent review — delivery remains unknown/);
      assert.match(panel, /Read-only observation: Screening/, "original observation persists");
    } else {
      assert.match(panel, /Closure rejected — hold remains/);
    }
    assert.match(await rowText(f, ROW_P), /Different status observed/, "observed state persists");
    assert.doesNotMatch(await rowText(f, ROW_P), /Verified in Zoho/);
    // No resend or execute surface remains for this row: no buttons, no inputs.
    assert.equal(
      await f.page.$(`[data-testid="row-stage-execution-${ROW_P}"] button`),
      null,
      "closed or rejected row exposes no buttons",
    );
    assert.equal(
      await f.page.$(`[data-testid="row-stage-execution-${ROW_P}"] input`),
      null,
      "closed or rejected row exposes no inputs",
    );
    assert.equal(f.writes.length, 0);
    await assertFitsViewport(f, `after ${decision}`);
  };
  // Uncommitted failure: draft kept, confirmations cleared, no auto-retry, same UUID on deliberate retry.
  const ambiguousRetry = async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await openClosure(f);
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    await f.click(RES.propose);
    await waitAlert(f, "could not be confirmed");
    await settle(f);
    await pause(1000);
    assert.equal(resolutionCalls(f).length, 1, "no automatic retry after an uncommitted failure");
    assert.equal(await f.disabled(RES.propose), true, "failure clears confirmations");
    assert.equal(await isChecked(f, RES.unknown), false);
    assert.equal(await isChecked(f, RES.noRetry), false);
    assert.equal(await f.page.$eval(T(RES.reason), (el) => el.value), PROPOSAL_REASON);
    assert.match(await f.text(RES.panel), /could not be confirmed/);
    assert.match(await f.text(RES.panel), /Nothing was resent/);
    const [first] = resolutionCalls(f);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    await f.click(RES.propose);
    await waitResolution(f, "Closure proposed — hold remains");
    await settle(f);
    const calls = resolutionCalls(f);
    assert.equal(calls.length, 2, "one deliberate retry, not more");
    const { commandId: firstId, ...firstRest } = first.body;
    const { commandId: retryId, ...retryRest } = calls[1].body;
    assert.equal(retryId, firstId, "unchanged deliberate retry reuses the command UUID");
    assert.deepEqual(retryRest, firstRest, "the retry is the identical command");
    assert.equal(f.exec.calls.length, 2);
  };
  // Changed reason after an uncommitted failure is a different command and gets a fresh UUID.
  const changedRetry = async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await openClosure(f);
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    await f.click(RES.propose);
    await waitAlert(f, "could not be confirmed");
    await settle(f);
    const [first] = resolutionCalls(f);
    const revised = "Revised proposal reason after the uncommitted attempt failed.";
    await f.click(RES.reason);
    await f.page.keyboard.down("Control");
    await f.page.keyboard.press("KeyA");
    await f.page.keyboard.up("Control");
    await f.page.keyboard.type(revised);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    await f.click(RES.propose);
    await waitResolution(f, "Closure proposed — hold remains");
    await settle(f);
    const calls = resolutionCalls(f);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.reason, revised);
    assert.notEqual(calls[1].body.commandId, first.body.commandId, "changed command is not reused");
  };
  // Sequence change: the open draft is dropped; the next proposal carries the new sequence.
  const sequenceChange = async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await openClosure(f);
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    f.exec.rows[0].sequence = 2;
    await refreshStage(f);
    await expectDraftCleared(f);
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    const before = f.exec.rows[0].revision;
    await f.click(RES.propose);
    await waitResolution(f, "Closure proposed — hold remains");
    await settle(f);
    const [call] = resolutionCalls(f);
    assert.equal(resolutionCalls(f).length, 1);
    assert.equal(call.body.expectedSequence, 2, "exact new sequence");
    assert.equal(call.body.expectedRevision, before);
  };
  // Source change: the handoff revision moves; the next proposal carries the new source revision.
  const sourceChange = async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await openClosure(f);
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    f.handoff.revision = hexRev(0x77);
    await refreshStage(f);
    await expectDraftCleared(f);
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    await f.click(RES.propose);
    await waitResolution(f, "Closure proposed — hold remains");
    await settle(f);
    const calls = resolutionCalls(f);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.expectedSourceRevision, hexRev(0x77), "exact new source revision");
  };
  // Actor change: an identity switch drops the draft; a non-admin sees no closure controls.
  const actorChange = async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await openClosure(f);
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    await f.page.evaluate((user) => window.setFixtureIdentity(user), otherAdmin());
    // An identity change returns the app to the campaign list, so the open draft cannot survive.
    await f.wait("button-select-campaign-campaign");
    assert.equal(await f.page.$(T(RES.panel)), null, "identity change leaves no closure panel");
    assert.equal(await f.page.$(T(RES.reason)), null, "identity change drops the draft");
    await f.click("button-select-campaign-campaign");
    await f.wait("button-approve-campaign");
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await openClosure(f);
    await draftIsEmpty(f);
    assert.equal(f.exec.calls.length, 0, "identity changes call nothing");
    // Campaigns are enabled only for tenant_admin, so a recruiter reaches no closure surface at all.
    await f.page.evaluate((user) => window.setFixtureIdentity(user), otherAdmin("recruiter"));
    await pause(1000);
    assert.equal(
      await f.page.$(T("button-select-campaign-campaign")),
      null,
      "non-admin: no campaign list",
    );
    assert.equal(
      await f.page.$('[data-testid^="row-stage-execution-"]'),
      null,
      "non-admin: no rows",
    );
    for (const id of [RES.open, RES.reason, RES.panel, RES.propose])
      assert.equal(await f.page.$(T(id)), null, `non-admin: ${id} is not rendered`);
    assert.equal(f.exec.calls.length, 0, "role change calls nothing");
  };
  // Capability change: the same row now offers review only; the proposal draft is dropped.
  const capabilityChange = async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await openClosure(f);
    await fillDraft(f, PROPOSAL_REASON, PROPOSAL_EVIDENCE);
    await confirmDraft(f);
    await waitEnabled(f, RES.propose);
    f.exec.rows[0].canProposeResolution = false;
    f.exec.rows[0].canReviewResolution = true;
    await refreshStage(f);
    await waitGone(f, RES.reason);
    await f.wait(RES.open);
    assert.match(await f.text(RES.open), /Independently review closure/);
    assert.equal(await f.page.$(T(RES.propose)), null, "proposal control is gone");
    await openClosure(f);
    await draftIsEmpty(f);
    assert.equal(await f.disabled(RES.approve), true);
    assert.equal(f.exec.calls.length, 0);
  };
  // Failed authority read: cached closure details and drafts must not remain visible.
  const failedReadHidesPrivate = (status) => async (f) => {
    await openStageExecution(f);
    await f.wait(`row-stage-execution-${ROW_P}`);
    await waitResolution(f, PROPOSAL_REASON.slice(0, 40));
    await openClosure(f);
    await fillDraft(f, DRAFT_REASON, DRAFT_EVIDENCE);
    if (status === 403) f.exec.forbidden = true;
    else f.exec.getFailure = status;
    await refreshStage(f);
    await f.wait("text-stage-execution-load-error");
    const message = await f.text("text-stage-execution-load-error");
    assert.match(
      message,
      status === 403 ? /not available to this account/ : /temporarily unavailable/,
    );
    assert.equal(await f.page.$('[data-testid^="row-stage-execution-"]'), null, "no rows");
    for (const id of [
      RES.panel,
      RES.open,
      RES.reason,
      RES.evidence,
      RES.propose,
      RES.approve,
      RES.reject,
    ])
      assert.equal(await f.page.$(T(id)), null, `${id} must not survive a failed read`);
    const visible = await f.page.evaluate(() => document.body.innerText);
    for (const secret of [PROPOSAL_REASON, PROPOSAL_EVIDENCE, DRAFT_REASON])
      assert.equal(visible.includes(secret), false, "private closure text is hidden");
    assert.notEqual(await f.page.$(T("section-stage-execution")), null);
    assert.equal(f.exec.calls.length, 0);
    await assertFitsViewport(f, `after ${status} read`);
  };
  const cases = [
    ...[
      { stale: false, connected: true },
      { stale: true, connected: true },
      { stale: false, connected: false },
      { stale: false, connected: true, auditFailure: true },
    ].map(({ stale, connected, auditFailure = false }) => [
      auditFailure
        ? "audit preparation failure blocks download without retry or a cached fallback"
        : stale
          ? "handoff download rechecks changed evidence instead of exporting cached review"
          : connected
            ? "current human-reviewed handoff downloads with no ATS write or candidate contact"
            : "disconnected employer can review and download saved evidence without contact authority",
      async (f) => {
        if (!connected) {
          // The provider banner renders before campaign details. Hold the actual
          // detail response to make that ordering deterministic, not a lucky wait.
          await f.initialDetail.started;
          assert.equal(await f.page.$(T("button-cancel-campaign")), null);
          f.initialDetail.release();
          await f.wait("button-cancel-campaign");
          assert.equal(await f.page.$(T("button-create-draft")), null);
          assert.equal(await f.page.$(T("button-approve-campaign")), null);
          assert.equal(await f.disabled("button-cancel-campaign"), false);
        }
        await openReview(f);
        await f.wait("button-download-reviewed-handoff");
        assert.equal(await f.disabled("button-download-reviewed-handoff"), true);
        await fill(f);
        await f.click("checkbox-review-confirm");
        await f.click("button-save-review");
        await f.wait("row-history-history-0");
        await f.page.waitForFunction(
          () =>
            !document.querySelector('[data-testid="button-download-reviewed-handoff"]').disabled,
        );
        f.handoff.applicationId = "9007199254740993001";
        f.handoff.externalJobId = "9007199254740993002";
        f.handoff.externalCandidateId = "9007199254740993003";
        await f.page.evaluate(() => {
          window.reviewDownloadCount = 0;
          URL.createObjectURL = (blob) => {
            blob.text().then((text) => {
              window.reviewDownloadJson = text;
            });
            return "blob:local-reviewed-handoff";
          };
          HTMLAnchorElement.prototype.click = function () {
            window.reviewDownloadCount++;
            window.reviewDownloadFilename = this.download;
          };
        });
        if (stale) f.review.decisionStale = true;
        await f.click("button-download-reviewed-handoff");
        if (stale || auditFailure) {
          await f.wait("text-review-error");
          assert.match(
            await f.text("text-review-error"),
            auditFailure ? /Audit preparation unavailable/ : /changed/,
          );
          assert.equal(await f.page.evaluate(() => window.reviewDownloadCount), 0);
        } else {
          await f.page.waitForFunction(() => typeof window.reviewDownloadJson === "string");
          const download = await f.page.evaluate(() => ({
            packet: JSON.parse(window.reviewDownloadJson),
            filename: window.reviewDownloadFilename,
            count: window.reviewDownloadCount,
          }));
          assert.equal(download.count, 1);
          assert.equal(download.filename, "lexy-zoho-reviewed-handoff-recipient.json");
          assert.equal(download.packet.humanReview.decision, "advance");
          assert.equal(download.packet.aiAssessment.score, 0);
          assert.equal(download.packet.externalRecords.applicationId, f.handoff.applicationId);
          assert.equal(download.packet.externalRecords.liveVerifiedByThisExport, false);
          assert.equal(download.packet.preparation.state, "prepared");
          assert.equal(download.packet.preparation.delivery, "unverified");
          assert.equal("answers" in download.packet, false);
          await f.wait("text-review-notice");
          assert.match(await f.text("text-review-notice"), /nothing changed in Zoho/);
        }
        assert.equal(
          f.writes.length,
          stale ? 1 : 2,
          "Only the human review and one local preparation attempt may write",
        );
      },
      { connected, auditFailure, holdInitialDetail: !connected },
    ]),
    [
      "connection loss preserves saved reviews but clears contact consent before reconnection",
      async (f) => {
        await f.page.select(T("select-campaign-job"), "job");
        await f.page.select(T("select-campaign-plan"), "plan");
        await f.click("checkbox-approve-campaign");
        assert.equal(await f.disabled("button-approve-campaign"), false);
        await openReview(f);
        await f.page.evaluate(() => window.setZohoConnection(false));
        await f.wait("text-provider-unavailable");
        assert.equal(await f.page.$(T("button-create-draft")), null);
        assert.equal(await f.page.$(T("button-approve-campaign")), null);
        await f.wait("select-review-decision");
        assert.equal(await f.text("text-snapshot-hash"), revision);
        await f.page.evaluate(() => window.setZohoConnection(true));
        await f.wait("button-approve-campaign");
        assert.equal(await f.disabled("button-approve-campaign"), true);
        assert.equal(await f.disabled("button-create-draft"), true);
        assert.equal(await f.page.$eval(T("checkbox-approve-campaign"), (el) => el.checked), false);
        assert.equal(f.writes.length, 0);
      },
    ],
    [
      "late snapshot response cannot restore contact authority after connection loss",
      async (f) => {
        await f.page.select(T("select-campaign-job"), "job");
        await f.page.select(T("select-campaign-plan"), "plan");
        const gate = f.holdResponse("/campaigns");
        await f.click("button-create-draft");
        await gate.started;
        await f.page.evaluate(() => window.setZohoConnection(false));
        await f.wait("text-provider-unavailable");
        const response = f.page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/zoho-recruit/campaigns",
        );
        gate.release();
        await response;
        await f.wait("row-review-recipient");
        assert.equal(await f.page.$(T("button-approve-campaign")), null);
        assert.equal(await f.page.$(T("button-create-draft")), null);
        assert.equal(f.writes.length, 1);
        assert.equal(
          await f.page.evaluate(() => document.body.textContent.includes("Draft saved with")),
          false,
        );
      },
    ],
    ...["sending", "review_required"].map((deliveryState) => [
      `${deliveryState} evidence stays unknown and read-only without a receipt`,
      async (f) => {
        await f.wait("delivery-review-notice");
        const evidence = await f.text("delivery-evidence-recipient");
        assert.match(evidence, /Unknown — no confirmed acceptance/);
        assert.match(evidence, /does not prove no send/);
        assert.match(evidence, /not a confirmed send time/);
        assert.equal(await f.page.$eval(T("delivery-evidence-recipient"), (el) => el.open), true);
        assert.equal(
          await f.page.$$eval(`${T("delivery-evidence-recipient")} button`, (els) => els.length),
          0,
        );
        assert.equal(f.writes.length, 0);
      },
      { deliveryState, receipt: false },
    ]),
    [
      "saved acceptance never implies inbox delivery",
      async (f) => {
        const evidence = await f.text("delivery-evidence-recipient");
        assert.match(evidence, /Recorded — not proof of inbox delivery/);
        assert.match(evidence, /saved-provider-reference/);
        assert.match(evidence, /Unverified/);
        assert.equal(f.writes.length, 0);
      },
    ],
    [
      "older responses without evidence remain explicitly unknown",
      async (f) => {
        assert.match(await f.text("delivery-evidence-recipient"), /Evidence unavailable/);
        assert.equal(f.writes.length, 0);
      },
      { evidence: false, deliveryState: "review_required", mobile: true },
    ],
    [
      "late approval cannot repopulate notices after leaving and reopening the same campaign",
      async (f) => {
        const gate = f.holdResponse("/action");
        await f.click("checkbox-approve-campaign");
        await f.click("button-approve-campaign");
        await gate.started;
        await f.click("button-select-campaign-campaign");
        await f.page.waitForFunction(
          () => !document.querySelector('[data-testid="button-approve-campaign"]'),
        );
        await f.click("button-select-campaign-campaign");
        await f.wait("checkbox-approve-campaign");
        await f.click("checkbox-approve-campaign");
        gate.release();
        await f.page.waitForNetworkIdle({ idleTime: 150, timeout: 4000 });
        assert.equal(await f.page.$(T("text-campaign-notice")), null);
        assert.equal(await f.page.$eval(T("checkbox-approve-campaign"), (el) => el.checked), true);
        assert.equal(f.writes.length, 1);
      },
    ],
    [
      "late review save cannot clear a newly reopened applicant form",
      async (f) => {
        await openReview(f);
        await fill(f);
        await f.click("checkbox-review-confirm");
        const gate = f.holdResponse("/review");
        await f.click("button-save-review");
        await gate.started;
        await f.click("row-review-recipient");
        await f.page.waitForFunction(
          () => !document.querySelector('[data-testid="input-review-reason"]'),
        );
        await f.click("row-review-recipient");
        await f.wait("input-review-reason");
        await fill(f, "New draft reason must survive an earlier response.");
        await f.click("checkbox-review-confirm");
        gate.release();
        await f.page.waitForNetworkIdle({ idleTime: 150, timeout: 4000 });
        assert.equal(
          await f.page.$eval(T("input-review-reason"), (el) => el.value),
          "New draft reason must survive an earlier response.",
        );
        assert.equal(await f.page.$eval(T("checkbox-review-confirm"), (el) => el.checked), true);
        assert.equal(await f.page.$(T("text-review-notice")), null);
        assert.equal(f.writes.length, 1);
      },
    ],
    [
      "late draft creation cannot reopen a campaign after the reviewer leaves it",
      async (f) => {
        await f.page.select(T("select-campaign-job"), "job");
        await f.page.select(T("select-campaign-plan"), "plan");
        const gate = f.holdResponse("/campaigns");
        await f.click("button-create-draft");
        await gate.started;
        await f.click("button-select-campaign-campaign");
        await f.page.waitForFunction(
          () => !document.querySelector('[data-testid="button-approve-campaign"]'),
        );
        gate.release();
        await f.page.waitForNetworkIdle({ idleTime: 150, timeout: 4000 });
        assert.equal(await f.page.$(T("button-approve-campaign")), null);
        assert.equal(await f.page.$(T("text-campaign-notice")), null);
        assert.equal(f.writes.length, 1);
      },
    ],
    [
      "explicit read-only metadata check reports catalog matches without transition authorization",
      async (f) => {
        await openReview(f);
        await f.wait("button-check-stage-metadata");
        assert.equal(await f.disabled("button-check-stage-metadata"), true);
        await f.page.type(T("input-mapping-advance"), "Qualified");
        await f.click("checkbox-mapping-ack");
        await f.click("button-save-mapping");
        await f.wait("text-handoff-notice");
        await f.click("checkbox-stage-metadata");
        await f.click("button-check-stage-metadata");
        await f.wait("result-stage-metadata");
        const text = await f.text("result-stage-metadata");
        assert.ok(text.includes("Found in default catalogue only"));
        assert.ok(text.includes("transition permission remains unverified"));
        assert.ok(text.includes("Do not send an update from this result"));
        assert.ok(text.includes("Save a proposed canonical Zoho status"));
        assert.equal(await f.disabled("button-check-stage-metadata"), true);
        assert.equal((await f.text("text-handoff-live")).trim(), "Disabled");
        assert.equal(f.writes.length, 2);
        // Unsaved edits never check different values as if they had been saved.
        await f.page.type(T("input-mapping-advance"), " edit");
        assert.equal(await f.disabled("button-check-stage-metadata"), true);
      },
    ],
    [
      "proposed mapping and separately confirmed simulation never enable live writes",
      async (f) => {
        await openReview(f);
        await f.wait("input-mapping-advance");
        assert.equal((await f.text("text-handoff-live")).trim(), "Disabled");
        await f.page.type(T("input-mapping-advance"), "Panel interview");
        assert.equal(await f.disabled("button-save-mapping"), true);
        await f.click("checkbox-mapping-ack");
        await f.click("button-save-mapping");
        await f.wait("text-handoff-notice");
        assert.equal(f.writes.length, 1);
        assert.equal(await f.disabled("button-simulate-handoff"), true);
        await fill(f);
        await f.click("checkbox-review-confirm");
        await f.click("button-save-review");
        await f.wait("row-history-history-0");
        await f.page.waitForFunction(() =>
          document
            .querySelector('[data-testid="text-handoff-target"]')
            ?.textContent.includes("Panel interview"),
        );
        assert.equal(await f.disabled("button-simulate-handoff"), true);
        await f.click("checkbox-handoff-ack");
        await f.click("button-simulate-handoff");
        await f.wait("row-handoff-history-test-event");
        assert.equal(f.writes.length, 3);
        assert.equal(f.writes[2].body.mode, "simulation");
        assert.equal((await f.text("text-handoff-live")).trim(), "Disabled");
      },
    ],
    [
      "creating a draft uses the selected job/plan and never approves or sends",
      async (f) => {
        assert.equal(await f.disabled("button-create-draft"), true);
        await f.page.select(T("select-campaign-job"), "job");
        await f.page.select(T("select-campaign-plan"), "plan");
        await f.click("button-create-draft");
        await f.page.waitForFunction(() =>
          document
            .querySelector('[data-testid="text-campaign-notice"]')
            ?.textContent.includes("Draft saved"),
        );
        assert.equal(f.writes.length, 1);
        assert.equal(f.writes[0].p, "/api/zoho-recruit/campaigns");
        assert.equal(await f.disabled("button-approve-campaign"), true);
      },
    ],
    [
      "campaign approval requires acknowledgment and exact snapshot",
      async (f) => {
        assert.equal(await f.disabled("button-approve-campaign"), true);
        assert.equal(f.writes.length, 0);
        await f.click("checkbox-approve-campaign");
        await f.click("button-approve-campaign");
        await f.page.waitForFunction(
          () => !document.querySelector('[data-testid="button-approve-campaign"]'),
        );
        assert.equal(f.writes.length, 1);
      },
    ],
    [
      "zero score, reason/confirmation gates and persisted human history",
      async (f) => {
        await openReview(f);
        assert.equal((await f.text("text-assessment-score")).trim(), "0");
        await fill(f, "short");
        await f.click("checkbox-review-confirm");
        assert.equal(await f.disabled("button-save-review"), true);
        await f.page.type(T("input-review-reason"), " sufficient job-related evidence");
        assert.equal(await f.disabled("button-save-review"), true);
        await f.click("checkbox-review-confirm");
        await f.click("button-save-review");
        await f.wait("row-history-history-0");
        assert.equal(f.writes.length, 1);
        await f.click("row-review-recipient");
        await f.click("row-review-recipient");
        await f.wait("row-history-history-0");
      },
    ],
    [
      "409 preserves reason, clears confirmation and never retries a write",
      async (f) => {
        await openReview(f);
        await fill(f);
        await f.click("checkbox-review-confirm");
        f.conflict();
        await f.click("button-save-review");
        await f.wait("text-review-error");
        assert.equal(await f.page.$eval(T("checkbox-review-confirm"), (el) => el.checked), false);
        assert.match(await f.page.$eval(T("input-review-reason"), (el) => el.value), /Job-related/);
        assert.equal(await f.disabled("button-save-review"), true);
        assert.equal(f.writes.length, 1);
      },
    ],
    [
      "incomplete evidence cannot be reviewed",
      async (f) => {
        await openReview(f);
        assert.equal(await f.disabled("select-review-decision"), true);
        assert.equal(await f.disabled("button-save-review"), true);
        assert.equal(f.writes.length, 0);
      },
      { incomplete: true },
    ],
    [
      "missing assessment is displayed without inventing a score",
      async (f) => {
        f.review.assessment.score = null;
        f.review.answers[0].score = null;
        await openReview(f);
        await f.wait("text-assessment-missing");
        assert.equal((await f.text("text-assessment-score")).trim(), "—");
        assert.equal(f.writes.length, 0);
      },
    ],
    [
      "mobile review has no horizontal overflow and stale history is explicit",
      async (f) => {
        f.review.decisionStale = true;
        f.review.history.push({
          id: "old",
          decision: "hold",
          reason: "Earlier evidence requires reconsideration.",
          reviewedBy: "staff",
          createdAt: stamp,
          evidenceCurrent: false,
        });
        await openReview(f);
        await f.wait("text-decision-stale");
        assert.equal(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
      },
      { mobile: true },
    ],
    [
      "reviewed Zoho note publishes the exact preview once after explicit confirmation",
      async (f) => {
        const note = (await f.page.$$(T("zoho-note-recipient")))[0];
        await (await note.$("button")).click();
        await f.page.waitForFunction(() =>
          document.body.textContent.includes("EXACT APPROVED TEXT"),
        );
        assert.equal(await note.$eval("pre", (el) => el.textContent), "EXACT APPROVED TEXT");
        assert.equal(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
        assert.equal(await note.$$eval('input[type="checkbox"]', (els) => els.length), 1);
        let buttons = await note.$$("button");
        assert.equal(await buttons[1].evaluate((el) => el.disabled), true);
        assert.deepEqual(f.notePreviews[0], { includeAssessment: false });
        await (await note.$("label input")).click();
        buttons = await note.$$("button");
        assert.equal(await buttons[1].evaluate((el) => el.disabled), false);
        await buttons[1].click();
        await f.page.waitForFunction(() =>
          document
            .querySelector('[data-testid="zoho-note-recipient"]')
            ?.textContent.includes("Zoho acknowledged note 999"),
        );
        assert.match(await note.evaluate((el) => el.textContent), /No hiring stage was changed/);
        assert.equal(
          f.writes.filter((w) => w.p.endsWith("/note-publication")).length,
          1,
          "exactly one note-publication POST; no stage or campaign writes",
        );
        assert.deepEqual(f.writes[0], {
          p: "/api/zoho-recruit/campaigns/campaign/recipients/recipient/note-publication",
          body: { includeAssessment: false, expectedRevision: revision, confirm: true },
        });
      },
      { mobile: true },
    ],
    [
      "assessment option exists only in review detail and sends an assessment-specific preview",
      async (f) => {
        await openReview(f);
        const notes = await f.page.$$(T("zoho-note-recipient"));
        assert.equal(notes.length, 2);
        assert.doesNotMatch(
          await notes[0].evaluate((el) => el.textContent),
          /Include assessment from the current human-reviewed interview/,
        );
        const reviewNote = notes[1];
        await (await reviewNote.$("button")).click();
        await f.page.waitForFunction(() =>
          document.body.textContent.includes("EXACT APPROVED TEXT"),
        );
        await (await reviewNote.$("label input")).click();
        await f.page.waitForFunction(() =>
          document.body.textContent.includes("including the assessment"),
        );
        assert.equal(f.notePreviews.at(-1).includeAssessment, true);
        assert.equal(await reviewNote.$eval("pre", (el) => el.textContent), "EXACT APPROVED TEXT");
        assert.equal(f.writes.length, 0);
      },
    ],
    [
      "missing note-write consent shows reconnect guidance and disables publication",
      async (f) => {
        const note = (await f.page.$$(T("zoho-note-recipient")))[0];
        await (await note.$("button")).click();
        await f.page.waitForFunction(() =>
          document
            .querySelector('[data-testid="zoho-note-recipient"]')
            ?.textContent.includes("Note write permission is not enabled"),
        );
        assert.match(await note.evaluate((el) => el.textContent), /reconnect in ATS connections/);
        assert.equal(await note.$eval("pre", (el) => el.textContent), "EXACT APPROVED TEXT");
        const buttons = await note.$$("button");
        assert.equal(await buttons[1].evaluate((el) => el.disabled), true);
        assert.equal(await note.$eval("label input", (el) => el.disabled), true);
        assert.equal(f.writes.length, 0);
      },
      // A connected read-only account is different from a disconnected provider:
      // only the former can preview notes and display missing-write guidance.
      { noteWriteAuthorized: false },
    ],
    [
      "uncertain publication receipt is visible and blocks resend",
      async (f) => {
        const note = (await f.page.$$(T("zoho-note-recipient")))[0];
        await (await note.$("button")).click();
        await f.page.waitForFunction(() =>
          document.body.textContent.includes("EXACT APPROVED TEXT"),
        );
        await (await note.$("label input")).click();
        let buttons = await note.$$("button");
        await buttons[1].click();
        await f.page.waitForFunction(() =>
          document
            .querySelector('[data-testid="zoho-note-recipient"]')
            ?.textContent.includes("automatic retry blocked"),
        );
        assert.match(await note.evaluate((el) => el.textContent), /Unconfirmed attempt/);
        buttons = await note.$$("button");
        assert.equal(await buttons[1].evaluate((el) => el.disabled), true);
        assert.equal(f.writes.filter((w) => w.p.endsWith("/note-publication")).length, 1);
        assert.equal(f.notePreviews.length >= 2, true);
      },
      { notePublicationState: "unconfirmed" },
    ],
    [
      "failed preview hides note text and publication authority",
      async (f) => {
        const note = (await f.page.$$(T("zoho-note-recipient")))[0];
        await (await note.$("button")).click();
        await f.page.waitForSelector(`${T("zoho-note-recipient")} [role="alert"]`);
        assert.equal(await note.$("pre"), null);
        assert.equal(await note.$$("button").then((buttons) => buttons.length), 2);
        assert.equal(f.writes.length, 0);
      },
      { notePreviewFailure: true },
    ],
    [
      "staff identity change closes an open note preview and clears publication authority",
      async (f) => {
        const note = (await f.page.$$(T("zoho-note-recipient")))[0];
        await (await note.$("button")).click();
        await f.page.waitForFunction(() =>
          document.body.textContent.includes("EXACT APPROVED TEXT"),
        );
        const changedIdentity = await f.page.evaluate(() =>
          window.setFixtureIdentity({
            id: "other-staff",
            tenantId: "other-tenant",
            name: "Other fixture admin",
            role: "tenant_admin",
            email: "other@example.invalid",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        );
        assert.equal(
          changedIdentity.id,
          "other-staff",
          "fixture switched the authenticated staff identity",
        );
        const capturedHandle = await note.evaluate((el) => ({
          isConnected: el.isConnected,
          text: el.textContent,
        }));
        const liveDom = await f.page.evaluate(() => ({
          bodyText: document.body.innerText,
          connectedNotes: [...document.querySelectorAll('[data-testid="zoho-note-recipient"]')]
            .filter((el) => el.isConnected)
            .map((el) => el.textContent),
        }));
        console.log("IDENTITY_CHANGE_DOM", JSON.stringify({ capturedHandle, liveDom }));
        assert.doesNotMatch(
          liveDom.bodyText,
          /EXACT APPROVED TEXT|Approve and publish note/,
          "stale note content/authority must not remain in the live document after identity change",
        );
        assert.equal(f.writes.length, 0);
      },
    ],
    [
      "stage execution is closed by default: unverified evidence blocks prepare and shows no rows",
      async (f) => {
        await openStageExecution(f);
        assert.equal((await f.text("text-stage-execution-live")).trim(), "Disabled on server");
        assert.equal((await f.text("text-stage-execution-transition")).trim(), "Not current");
        assert.equal(await f.disabled("checkbox-prepare-execution-ack"), true);
        assert.equal(await f.disabled("button-prepare-execution"), true);
        await f.wait("text-prepare-execution-blocked");
        await f.wait("text-no-stage-executions");
        assert.equal(await f.page.$('[data-testid^="row-stage-execution-"]'), null);
        assert.equal(f.exec.calls.length, 0);
        assert.equal(f.writes.length, 0);
      },
    ],
    [
      "stage execution journey: evidence gates prepare, approval is local, uncertain execute only offers recovery",
      journey,
      { stageExecution: journeyFixture },
    ],
    [
      "stage execution journey on a mobile width has no overflow and keeps the same gates",
      journey,
      { mobile: true, stageExecution: journeyFixture },
    ],
    [
      "stage execution runtime disabled shows no execute control for an approved request",
      async (f) => {
        await openStageExecution(f);
        await f.wait(`row-stage-execution-${ROW_A}`);
        assert.equal((await f.text("text-stage-execution-live")).trim(), "Disabled on server");
        assert.match(
          await f.text("text-stage-execution-reason"),
          /Execution is disabled on this server/,
        );
        assert.equal(await f.page.$(T(`checkbox-execution-execute-${ROW_A}`)), null);
        assert.equal(await f.page.$(T(`button-execution-execute-${ROW_A}`)), null);
        assert.equal(f.exec.calls.length, 0);
      },
      { stageExecution: { verified: true, liveEnabled: false, rows: approvedRows() } },
    ],
    [
      "stage execution client refuses execute when runtime is disabled even if a row claims canExecute",
      async (f) => {
        await openStageExecution(f);
        await f.wait(`row-stage-execution-${ROW_A}`);
        assert.match(await f.text(`text-execute-blocked-${ROW_A}`), /live execution is disabled/);
        assert.equal(await f.page.$(T(`checkbox-execution-execute-${ROW_A}`)), null);
        assert.equal(await f.page.$(T(`button-execution-execute-${ROW_A}`)), null);
        assert.equal(f.exec.calls.length, 0);
      },
      {
        stageExecution: {
          verified: true,
          liveEnabled: false,
          rows: [execRow(ROW_A, "approved", hexRev(0x41), { canExecuteOverride: true })],
        },
      },
    ],
    [
      "stage execution runtime enabled sends one exact execute command with a stable command UUID",
      async (f) => {
        await openStageExecution(f);
        await f.wait(`checkbox-execution-execute-${ROW_A}`);
        assert.equal((await f.text("text-stage-execution-live")).trim(), "Enabled on server");
        const approvedRev = f.exec.rows[0].revision;
        await armAndClick(f, "execute", ROW_A);
        await waitStatus(f, ROW_A, "Accepted by Zoho, unverified");
        await settle(f);
        const executes = callsOf(f, "execute");
        assert.equal(executes.length, 1);
        assert.deepEqual(executes[0].body, {
          expectedRevision: approvedRev,
          expectedRuleRevision: f.exec.ruleRevision,
          requestId: executes[0].body.requestId,
          action: "execute",
          confirm: true,
        });
        assert.match(executes[0].body.requestId, UUID_RE);
        assert.match(
          await rowText(f, ROW_A),
          new RegExp(`Execution ref ${executes[0].body.requestId}`),
        );
        assert.doesNotMatch(await rowText(f, ROW_A), /Verified in Zoho/);
        assert.equal(
          await f.page.$(T(`button-execution-execute-${ROW_A}`)),
          null,
          "accepted is not executable again",
        );
        assert.equal(f.exec.calls.length, 1);
        assert.equal(f.writes.length, 0);
      },
      {
        stageExecution: {
          verified: true,
          liveEnabled: true,
          rows: approvedRows(),
          executeOutcomes: ["accepted"],
        },
      },
    ],
    [
      "stage execution: committed execute followed by a 409 shows claimed history, no resend, and recovery only",
      async (f) => {
        const message = await uncertainExecute(f, "Execution claimed");
        assert.ok(message.trim().length > 0, "the failure is visible to the operator");
        console.log("STAGE_EXECUTION_409_COPY", JSON.stringify(message));
      },
      {
        stageExecution: {
          verified: true,
          liveEnabled: true,
          rows: approvedRows(),
          executeOutcomes: ["claimed-409"],
        },
      },
    ],
    [
      "stage execution: committed execute followed by a 422 shows claimed history, no resend, and recovery only",
      async (f) => {
        const message = await uncertainExecute(f, "Execution claimed");
        assert.match(message, /could not be confirmed/);
      },
      {
        stageExecution: {
          verified: true,
          liveEnabled: true,
          rows: approvedRows(),
          executeOutcomes: ["claimed-422"],
        },
      },
    ],
    [
      "stage execution: uncommitted network failure keeps approval and a manual retry reuses the command UUID",
      async (f) => {
        await openStageExecution(f);
        await f.wait(`checkbox-execution-execute-${ROW_A}`);
        await armAndClick(f, "execute", ROW_A);
        await f.page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="text-stage-execution-error"]')
              ?.textContent.includes("outcome is unknown"),
          { timeout: 4000 },
        );
        await settle(f);
        assert.equal(
          callsOf(f, "execute").length,
          1,
          "no automatic resend after a network failure",
        );
        await waitStatus(f, ROW_A, "Approved, not executed");
        assert.equal(await isChecked(f, `checkbox-execution-execute-${ROW_A}`), false);
        assert.equal(
          await f.disabled(`button-execution-execute-${ROW_A}`),
          true,
          "failure clears the acknowledgement",
        );
        await armAndClick(f, "execute", ROW_A);
        await waitStatus(f, ROW_A, "Accepted by Zoho, unverified");
        await settle(f);
        const executes = callsOf(f, "execute");
        assert.equal(executes.length, 2);
        assert.equal(
          executes[1].body.requestId,
          executes[0].body.requestId,
          "manual retry reuses the command UUID",
        );
        assert.equal(executes[1].body.expectedRevision, executes[0].body.expectedRevision);
        assert.equal(executes[1].body.expectedRuleRevision, executes[0].body.expectedRuleRevision);
        assert.equal(await f.page.$(T(`button-execution-execute-${ROW_A}`)), null);
      },
      {
        stageExecution: {
          verified: true,
          liveEnabled: true,
          rows: approvedRows(),
          executeOutcomes: ["uncommitted-network", "accepted"],
        },
      },
    ],
    [
      "stage execution: review-required and observed-target rows expose read-only recovery only, never execute",
      async (f) => {
        await openStageExecution(f);
        await f.wait(`row-stage-execution-${ROW_R}`);
        await f.wait(`row-stage-execution-${ROW_O}`);
        assert.match(
          await f.text("text-stage-execution-reason"),
          /earlier attempt remains unresolved/,
        );
        assert.equal(
          await f.disabled("button-prepare-execution"),
          true,
          "unresolved evidence blocks new preparation",
        );
        assert.match(await rowText(f, ROW_R), /Human review required/);
        assert.equal(await f.page.$(T(`button-execution-execute-${ROW_R}`)), null);
        assert.equal(await f.page.$(T(`checkbox-execution-execute-${ROW_R}`)), null);
        await f.wait(`checkbox-execution-recover-${ROW_R}`);
        assert.match(await rowText(f, ROW_O), /Target observed, delivery not proven/);
        assert.doesNotMatch(await rowText(f, ROW_O), /Verified in Zoho/);
        assert.equal(
          await f.page.$(`[data-testid="row-stage-execution-${ROW_O}"] button`),
          null,
          "observed target has no actions",
        );
        assert.equal(await f.page.$(T(`checkbox-execution-execute-${ROW_O}`)), null);
        const rev = f.exec.rows.find((r) => r.id === ROW_R).revision;
        await armAndClick(f, "recover", ROW_R);
        await waitStatus(f, ROW_R, "Target observed, delivery not proven");
        const [recover] = callsOf(f, "recover");
        assert.deepEqual(recover.body, {
          expectedRevision: rev,
          expectedRuleRevision: f.exec.ruleRevision,
          requestId: recover.body.requestId,
          action: "recover",
          confirm: true,
        });
        assert.equal(callsOf(f, "execute").length, 0);
        assert.equal(await noneChecked(f), true);
        assert.equal(
          await f.page.$(T(`button-execution-recover-${ROW_R}`)),
          null,
          "recovery does not repeat",
        );
      },
      {
        stageExecution: {
          verified: true,
          liveEnabled: true,
          rows: [
            execRow(ROW_R, "review_required", hexRev(0x51)),
            execRow(ROW_O, "observed_target", hexRev(0x52)),
          ],
        },
      },
    ],
    [
      "stage execution: authorization 403 after cached execution history removes private rows and actions",
      async (f) => {
        await openStageExecution(f);
        await f.wait(`button-execution-execute-${ROW_A}`);
        f.exec.forbidden = true;
        await refreshStage(f);
        await f.wait("text-stage-execution-load-error");
        assert.match(
          await f.text("text-stage-execution-load-error"),
          /not available to this account/,
        );
        assert.equal(await f.page.$('[data-testid^="row-stage-execution-"]'), null);
        for (const testid of [
          `button-execution-execute-${ROW_A}`,
          `checkbox-execution-execute-${ROW_A}`,
          "button-prepare-execution",
          "checkbox-prepare-execution-ack",
          "text-stage-execution-live",
          "text-stage-execution-reason",
        ])
          assert.equal(await f.page.$(T(testid)), null, `${testid} must not survive 403`);
        assert.notEqual(await f.page.$(T("section-stage-execution")), null);
        assert.equal(f.exec.calls.length, 0);
      },
      { stageExecution: { verified: true, liveEnabled: true, rows: approvedRows() } },
    ],
    [
      "stage execution: runtime and evidence changes clear execution acknowledgements before any call",
      async (f) => {
        await openStageExecution(f);
        await f.wait(`checkbox-execution-execute-${ROW_A}`);
        // Tick only the acknowledgement here: the execute button must not be pressed in this case.
        await f.click(`checkbox-execution-execute-${ROW_A}`);
        await f.page.waitForFunction(
          (t) => document.querySelector(`[data-testid="${t}"]`)?.checked === true,
          { timeout: 4000 },
          `checkbox-execution-execute-${ROW_A}`,
        );
        // Evidence changes (new rule revision): the acknowledgement is dropped.
        f.exec.ruleRevision = newRev();
        await refreshStage(f);
        await f.page.waitForFunction(
          (t) => document.querySelector(`[data-testid="${t}"]`)?.checked === false,
          { timeout: 4000 },
          `checkbox-execution-execute-${ROW_A}`,
        );
        assert.equal(await f.disabled(`button-execution-execute-${ROW_A}`), true);
        // Runtime disabled: execute controls disappear; re-enabling does not restore the old tick.
        await f.click(`checkbox-execution-execute-${ROW_A}`);
        await waitEnabled(f, `button-execution-execute-${ROW_A}`);
        f.exec.liveEnabled = false;
        await refreshStage(f);
        await waitGone(f, `checkbox-execution-execute-${ROW_A}`);
        f.exec.liveEnabled = true;
        await refreshStage(f);
        await f.wait(`checkbox-execution-execute-${ROW_A}`);
        assert.equal(await isChecked(f, `checkbox-execution-execute-${ROW_A}`), false);
        assert.equal(await f.disabled(`button-execution-execute-${ROW_A}`), true);
        assert.equal(f.exec.calls.length, 0, "no execute call during authority changes");
      },
      { stageExecution: { verified: true, liveEnabled: true, rows: approvedRows() } },
    ],
    ...both(
      "stage resolution: observed state proposes a held closure after two explicit confirmations and sends nothing",
      proposeClosure,
      {
        stageExecution: resolvedStage(proposableRows()),
      },
    ),
    ...both(
      "stage resolution: distinct reviewer approves with independent evidence; delivery stays unknown with no resend controls",
      (f) => reviewClosure(f, "approve"),
      {
        actorId: "reviewer",
        stageExecution: resolvedStage(reviewableRows()),
      },
    ),
    ...both(
      "stage resolution: distinct reviewer rejection keeps the proposal held",
      (f) => reviewClosure(f, "reject"),
      {
        actorId: "reviewer",
        stageExecution: resolvedStage(reviewableRows()),
      },
    ),
    ...both(
      "stage resolution: uncommitted proposal failure keeps the draft, never auto-retries, and a deliberate retry reuses the command UUID",
      ambiguousRetry,
      {
        stageExecution: resolvedStage(proposableRows(), {
          resolutionOutcomes: ["uncommitted-network", "accepted"],
        }),
      },
    ),
    ...["propose", "approve", "reject"].flatMap((action) =>
      ["committed-network", "committed-409", "committed-422"].flatMap((outcome) =>
        both(
          `stage resolution: committed closure ${action} survives ${outcome} without repeating`,
          committedClosureFailure(action),
          {
            actorId: action === "propose" ? "staff" : "reviewer",
            stageExecution: resolvedStage(
              action === "propose" ? proposableRows() : reviewableRows(),
              {
                resolutionOutcomes: [outcome],
              },
            ),
          },
        ),
      ),
    ),
    ...both(
      "stage resolution: a changed reason after an uncommitted failure is a new command, not a reused UUID",
      changedRetry,
      {
        stageExecution: resolvedStage(proposableRows(), {
          resolutionOutcomes: ["uncommitted-network", "accepted"],
        }),
      },
    ),
    ...both(
      "stage resolution: sequence change clears confirmations; next proposal carries the new sequence",
      sequenceChange,
      {
        stageExecution: resolvedStage(proposableRows()),
      },
    ),
    ...both(
      "stage resolution: source revision change clears confirmations; next proposal carries the new source revision",
      sourceChange,
      {
        stageExecution: resolvedStage(proposableRows()),
      },
    ),
    ...both(
      "stage resolution: actor change clears drafts and a non-admin actor sees no closure controls",
      actorChange,
      {
        stageExecution: resolvedStage(proposableRows()),
      },
    ),
    ...both(
      "stage resolution: capability change clears proposal confirmations and offers review only",
      capabilityChange,
      {
        stageExecution: resolvedStage(proposableRows()),
      },
    ),
    ...both(
      "stage resolution: failed authority read (403) hides cached closure details and drafts",
      failedReadHidesPrivate(403),
      {
        actorId: "reviewer",
        stageExecution: resolvedStage(reviewableRows()),
      },
    ),
    ...both(
      "stage resolution: failed authority read (500) hides cached closure details and drafts",
      failedReadHidesPrivate(500),
      {
        actorId: "reviewer",
        stageExecution: resolvedStage(reviewableRows()),
      },
    ),
  ];
  const caseFilter = process.env.ZOHO_CASE_FILTER;
  const selectedCases = caseFilter ? cases.filter(([name]) => name.includes(caseFilter)) : cases;
  assert.ok(selectedCases.length > 0, `No Zoho scenarios matched ZOHO_CASE_FILTER=${caseFilter}`);
  for (const [name, run, options] of selectedCases) {
    try {
      await scenario(name, run, options);
    } catch (e) {
      failures.push(name);
      console.error(`FAIL ${name}\n${e.stack}`);
    }
  }
  assert.deepEqual(failures, [], "Zoho browser regressions");
} finally {
  await browser?.close();
  await server.close();
}
