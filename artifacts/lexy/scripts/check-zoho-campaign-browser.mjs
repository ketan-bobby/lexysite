import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
      id: "staff",
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
