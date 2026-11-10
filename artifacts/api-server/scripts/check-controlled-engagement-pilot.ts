/**
 * Real native draft, held for approval. No approve/send route is called.
 * Predecessors are explicitly synthetic setup, not repeated live assessments.
 * Never changes the designated inbox's existing user account or role.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  candidatesTable,
  verificationRecordsTable,
  outreachMessagesTable,
  interviewSessionsTable,
  vendorUsageAttemptsTable,
} from "@workspace/db";
import { persistWorkflowIdentityAdvice } from "../src/lib/workflow-identity-review";

async function main() {
  const fixture = JSON.parse(await readFile("/tmp/workflow-screening-ui-fixture.json", "utf8"));
  assert.equal(fixture.engagementPilot, true);
  assert.equal(fixture.verificationPilot, true);
  assert.ok(fixture.tenantId.startsWith("evidence_ui_"));
  for (const key of ["jobId", "candidateId"])
    assert.ok(fixture[key].startsWith(`${fixture.tenantId}_`));
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, fixture.candidateId),
        eq(candidatesTable.tenantId, fixture.tenantId),
      ),
    );
  assert.equal(candidate.email, fixture.controlledRecipient);
  assert.equal(candidate.verificationStatus, "pending");
  assert.ok(process.env.REPLIT_DEV_DOMAIN);
  const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const base = `${origin}/api/jobs/${fixture.jobId}`;
  const endpoint = `${base}/candidate-workflows/${fixture.workflowId}`;
  async function request(
    url: string,
    body?: Record<string, unknown>,
    method?: string,
    reject = false,
  ) {
    const response = await fetch(url, {
      method: method ?? (body ? "POST" : "GET"),
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(150_000),
    });
    const data = await response.json();
    if (reject)
      assert.ok(
        [400, 409].includes(response.status),
        `Unsafe advance was not rejected (${response.status}).`,
      );
    else
      assert.ok(
        response.ok,
        `Controlled API request failed (${response.status}): ${JSON.stringify(data)}`,
      );
    return { status: response.status, data };
  }
  async function workflow() {
    const { data } = await request(`${base}/workflow-state`);
    const row = data.workflows.find((item: any) => item.id === fixture.workflowId);
    assert.ok(row?.candidateId === fixture.candidateId);
    return row;
  }
  let wf = await workflow();
  if (!process.argv.includes("--execute-draft")) {
    console.log(
      "Stage-3 isolated preparation ready. No model request, approval, email or invitation performed.",
    );
    return;
  }
  assert.equal(wf.steps[0].status, "completed");
  assert.match(wf.steps[0].evidence, /SYNTHETIC FIXTURE SETUP ONLY/);
  assert.equal(wf.steps[1].status, "pending");
  const existing = await dbAdmin
    .select()
    .from(verificationRecordsTable)
    .where(
      and(
        eq(verificationRecordsTable.candidateId, fixture.candidateId),
        eq(verificationRecordsTable.tenantId, fixture.tenantId),
      ),
    );
  assert.equal(
    existing.length,
    0,
    "Review existing evidence; never repeat claimed assessment/draft work.",
  );
  await persistWorkflowIdentityAdvice(fixture.candidateId, fixture.tenantId, {
    linkedinMatch: "unverified",
    resumeConsistency: "consistent",
    emailValidity: "valid",
    profileCompleteness: 0,
    overallScore: 0,
    riskFlags: ["Synthetic fixture, no identity assessment"],
    verdict: "review",
    notes:
      "SYNTHETIC STAGE-3 SETUP ONLY: invented pending advice for workflow plumbing. No identity provider or model was called; no real identity claim.",
  });
  wf = await workflow();
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    action: "approve_recipient",
    controlledEmail: fixture.controlledRecipient,
    acknowledgeTestRecipient: true,
  });
  wf = await workflow();
  const evidence = wf.runtimeEvidence.find((item: any) => item.stepKey === "verification");
  assert.ok(evidence && !evidence.readyForReview);
  await request(`${endpoint}/identity-resolution`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    recordId: evidence.sourceId,
    recordUpdatedAt: evidence.occurredAt,
    decision: "internal_test",
    acknowledge: true,
    evidence:
      "Owner-authorized Stage-3 synthetic-profile test, restricted to the previously designated Linx test inbox. Workflow-only clearance; no real identity verification or hiring assessment is claimed.",
  });
  wf = await workflow();
  assert.equal(wf.steps[1].status, "completed");
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    action: "activate",
    stepKey: "engagement",
    controlledEmail: fixture.controlledRecipient,
    acknowledgeUnknownCosts: true,
  });
  wf = await workflow();
  const { data: execution } = await request(`${endpoint}/execute`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
  });
  assert.equal(execution.status, "completed");
  const messages = await dbAdmin
    .select()
    .from(outreachMessagesTable)
    .where(
      and(
        eq(outreachMessagesTable.tenantId, fixture.tenantId),
        eq(outreachMessagesTable.jobId, fixture.jobId),
        eq(outreachMessagesTable.candidateId, fixture.candidateId),
      ),
    );
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.equal(message.status, "pending_approval");
  assert.equal(message.approvedAt, null);
  assert.equal(message.approvedBy, null);
  assert.equal(message.sentAt, null);
  assert.equal(message.repliedAt, null);
  // Ordinary edit-before-approval surface adds truthful test disclosure without
  // changing the model's prompt, provider or configuration.
  const body = [
    "Hi,",
    "",
    "This is Lexy’s controlled Linx internal test—not a real job opportunity or hiring decision.",
    "We are testing the order: interest-check email, your Interested response, then a separately approved interview invitation.",
    "There is no interview link in this message and no invitation will be sent automatically.",
    "",
    "--- AI-generated draft being tested ---",
    message.body,
    "",
    "Please use the Interested button if you want to continue this internal test.",
    "Lexy",
  ].join("\n");
  await request(
    `${origin}/api/outreach/messages/${message.id}`,
    {
      subject: "Lexy / Linx internal test — are you interested?",
      body,
    },
    "PATCH",
  );
  wf = await workflow();
  const rejected = await request(
    `${endpoint}/live-pilot`,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: wf.revision,
      action: "activate",
      stepKey: "ai_interview",
      controlledEmail: fixture.controlledRecipient,
      acknowledgeUnknownCosts: true,
    },
    undefined,
    true,
  );
  assert.equal(wf.steps[2].status, "pending");
  assert.ok(wf.steps.slice(3).every((step: any) => step.status === "pending"));
  const sessions = await dbAdmin
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.tenantId, fixture.tenantId));
  assert.equal(sessions.length, 0);
  const [identity] = await dbAdmin
    .select()
    .from(verificationRecordsTable)
    .where(eq(verificationRecordsTable.id, evidence.sourceId));
  assert.equal(identity.status, "pending");
  assert.equal(identity.identityVerified, false);
  const usage = await dbAdmin
    .select({
      provider: vendorUsageAttemptsTable.provider,
      model: vendorUsageAttemptsTable.model,
      status: vendorUsageAttemptsTable.status,
      costStatus: vendorUsageAttemptsTable.costStatus,
      units: vendorUsageAttemptsTable.units,
    })
    .from(vendorUsageAttemptsTable)
    .where(
      and(
        eq(vendorUsageAttemptsTable.tenantId, fixture.tenantId),
        eq(vendorUsageAttemptsTable.area, `workflow:${fixture.workflowId}:engagement`),
      ),
    );
  assert.ok(usage.length > 0 && usage.every((item) => item.status === "succeeded"));
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    action: "revoke",
    stepKey: "engagement",
    controlledEmail: fixture.controlledRecipient,
  });
  const final = await workflow();
  assert.equal(final.livePilot.active, false);
  const report = {
    execution,
    workflowId: fixture.workflowId,
    jobId: fixture.jobId,
    messageId: message.id,
    messageStatus: "pending_approval",
    subject: "Lexy / Linx internal test — are you interested?",
    body,
    identityVerified: false,
    identityRecordStatus: identity.status,
    prerequisites:
      "Explicit synthetic screening setup and workflow-only identity clearance; no new assessments.",
    providerUsage: usage,
    prematureInvitationRejected: rejected.status,
    emailsSent: 0,
    interviewSessionsCreated: 0,
    interestedReplyRecorded: false,
    executionPermissionRevoked: true,
    steps: final.steps,
    next: "Explicit approval of the held first-send; then the owner must actually receive and click Interested. Do not simulate that reply.",
  };
  await writeFile(
    new URL("../../../docs/qa/controlled-engagement-draft-2026-10-09.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
