/**
 * Default read-only. --send-approved is only for the owner's explicit approval
 * of one held Stage-3 test message. Never generates another draft or invitation.
 * A previously attempted, uncertain, sent or otherwise changed message is not retried.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  usersTable,
  jobsTable,
  candidatesTable,
  outreachMessagesTable,
  interviewSessionsTable,
  vendorUsageAttemptsTable,
} from "@workspace/db";
import { issueToken } from "../src/lib/auth-token";

async function main() {
  const fixture = JSON.parse(await readFile("/tmp/workflow-screening-ui-fixture.json", "utf8"));
  assert.equal(fixture.engagementPilot, true);
  assert.ok(String(fixture.tenantId).startsWith("evidence_ui_"));
  assert.ok(String(fixture.jobId).startsWith(`${fixture.tenantId}_`));
  assert.ok(String(fixture.candidateId).startsWith(`${fixture.tenantId}_`));
  const [actor] = await dbAdmin
    .select()
    .from(usersTable)
    .where(
      and(eq(usersTable.id, `${fixture.tenantId}_user`), eq(usersTable.tenantId, fixture.tenantId)),
    );
  assert.ok(actor?.role === "tenant_admin" && actor.status === "active");
  const [job] = await dbAdmin
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, fixture.jobId), eq(jobsTable.tenantId, fixture.tenantId)));
  assert.ok(
    job?.title.startsWith("[AUTONOMY PILOT]") &&
      job.recruitingMode === "lexy_autonomous" &&
      job.status === "active",
  );
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, fixture.candidateId),
        eq(candidatesTable.tenantId, fixture.tenantId),
      ),
    );
  assert.ok(candidate && !candidate.doNotContact && !candidate.dataErasedAt);
  assert.equal(candidate.email, fixture.controlledRecipient);
  assert.equal(candidate.verificationStatus, "pending");
  assert.ok((candidate.verificationResult as any)?.syntheticFixture);
  const messages = await dbAdmin
    .select()
    .from(outreachMessagesTable)
    .where(
      and(
        eq(outreachMessagesTable.jobId, fixture.jobId),
        eq(outreachMessagesTable.tenantId, fixture.tenantId),
        eq(outreachMessagesTable.candidateId, fixture.candidateId),
      ),
    );
  assert.equal(messages.length, 1);
  const message = messages[0];
  if (message.status !== "pending_approval" || message.sentAt || message.approvedAt) {
    console.log(
      JSON.stringify({
        messageId: message.id,
        status: message.status,
        sentAt: message.sentAt,
        repliedAt: message.repliedAt,
        replySentiment: message.replySentiment,
        action: "Existing attempt preserved; no resend or transport retry.",
      }),
    );
    return;
  }
  assert.match(message.subject ?? "", /Lexy.*Linx internal test/);
  assert.match(message.body, /not a real job opportunity or hiring decision/);
  console.log(
    "One held, owner-designated Stage-3 message ready. No invitation; no contact without --send-approved.",
  );
  if (!process.argv.includes("--send-approved")) return;
  assert.ok(process.env.REPLIT_DEV_DOMAIN);
  const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const endpoint = `${origin}/api/jobs/${fixture.jobId}/candidate-workflows/${fixture.workflowId}`;
  const token = issueToken({ userId: actor.id, tenantId: fixture.tenantId, role: actor.role });
  async function request(url: string, body?: Record<string, unknown>) {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(150_000),
    });
    const data = await response.json();
    assert.ok(
      response.ok,
      `Controlled request failed (${response.status}): ${JSON.stringify(data)}. Inspect the saved attempt; do not retry transport.`,
    );
    return data;
  }
  async function workflow() {
    const state = await request(`${origin}/api/jobs/${fixture.jobId}/workflow-state`);
    assert.equal(state.jobApproved, true);
    const wf = state.workflows.find((row: any) => row.id === fixture.workflowId);
    assert.ok(wf?.candidateId === fixture.candidateId && wf.status === "ready" && !wf.stale);
    assert.equal(wf.steps.find((step: any) => step.status !== "completed")?.key, "engagement");
    return wf;
  }
  let wf = await workflow();
  // Renew the same explicitly approved inbox, never change its account role.
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    action: "approve_recipient",
    controlledEmail: fixture.controlledRecipient,
    acknowledgeTestRecipient: true,
  });
  wf = await workflow();
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    action: "activate",
    stepKey: "engagement",
    controlledEmail: fixture.controlledRecipient,
    acknowledgeUnknownCosts: true,
  });
  // Ordinary human approval uses the canonical, durable first-touch dispatcher.
  // Never invokes /execute again and never directly changes a message to sent.
  await request(`${origin}/api/outreach/messages/${message.id}/approve`, {});
  const [saved] = await dbAdmin
    .select()
    .from(outreachMessagesTable)
    .where(
      and(
        eq(outreachMessagesTable.id, message.id),
        eq(outreachMessagesTable.tenantId, fixture.tenantId),
      ),
    );
  assert.ok(
    saved.status === "sent" && saved.sentAt,
    "Provider acceptance was not confirmed; inspect the attempt rather than resend.",
  );
  assert.equal(saved.repliedAt, null);
  const sessions = await dbAdmin
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.tenantId, fixture.tenantId));
  assert.equal(sessions.length, 0);
  wf = await workflow();
  assert.ok(wf.steps.slice(2).every((step: any) => step.status === "pending"));
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    action: "revoke",
    stepKey: "engagement",
    controlledEmail: fixture.controlledRecipient,
  });
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
  const report = {
    messageId: saved.id,
    status: saved.status,
    sentAt: saved.sentAt,
    providerAccepted: true,
    inboxReceiptConfirmed: false,
    replyRecorded: false,
    interviewSessionsCreated: 0,
    executionPermissionRevoked: true,
    providerUsage: usage,
    next: "Owner must receive and click Interested; no reply has been simulated.",
  };
  await writeFile(
    new URL("../../../docs/qa/controlled-engagement-send-2026-10-09.json", import.meta.url),
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
