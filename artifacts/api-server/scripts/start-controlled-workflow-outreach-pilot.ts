/**
 * Owner-authorized, single-recipient live outreach check.
 * Default is read-only. Uses the ordinary authenticated approval/dispatch route;
 * never enables workers, bypasses paid dispatch, or creates an interview.
 */
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  jobsTable,
  candidatesTable,
  usersTable,
  outreachMessagesTable,
} from "@workspace/db";
import { issueToken } from "../src/lib/auth-token";
import { buildMessageQuickReplyBlocks } from "../src/lib/outreach-reply-tokens";

const jobId = "livepilot_e2e_20261006_job";
const candidateId = "livepilot_candidate_9edb4934";
const messageId = "livepilot_e2e_20261006_outreach_01";
const { values } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    recipient: { type: "string" },
  },
});

async function main() {
  const [job] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId));
  if (
    !job?.tenantId.startsWith("livepilot_") ||
    job.status !== "active" ||
    job.interviewPath !== "ai"
  )
    throw new Error("Only the approved isolated AI-path pilot is allowed.");
  if (
    !candidate ||
    candidate.tenantId !== job.tenantId ||
    candidate.email?.trim().toLowerCase() !== values.recipient?.trim().toLowerCase() ||
    candidate.doNotContact ||
    candidate.dataErasedAt
  )
    throw new Error(
      "Recipient, ownership or contact permission did not match the authorized pilot.",
    );
  const [operator] = await dbAdmin
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, job.assignedRecruiterId!));
  if (
    !operator ||
    operator.tenantId !== job.tenantId ||
    operator.status !== "active" ||
    operator.role !== "tenant_admin" ||
    !operator.id.startsWith("livepilot_")
  )
    throw new Error("Dedicated pilot operator is missing or unauthorized.");
  const host = process.env.REPLIT_DEV_DOMAIN;
  if (!host?.endsWith(".replit.dev")) throw new Error("A trusted development origin is required.");
  const origin = `https://${host}`;
  if (!buildMessageQuickReplyBlocks(messageId, origin).html)
    throw new Error("Signed candidate reply buttons are unavailable; no email was sent.");
  const headers = {
    Authorization: `Bearer ${issueToken({ userId: operator.id, tenantId: operator.tenantId, role: operator.role })}`,
    "Content-Type": "application/json",
  };
  const stateResponse = await fetch(`${origin}/api/jobs/${jobId}/workflow-state`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!stateResponse.ok)
    throw new Error(`Workflow authorization failed: HTTP ${stateResponse.status}`);
  const state = await stateResponse.json();
  const workflow = state.workflows.find(
    (w: any) => w.candidateId === candidateId && w.status === "ready",
  );
  if (!state.jobApproved || !workflow || workflow.stale || workflow.interviewPath !== "ai")
    throw new Error("No current approved, enrolled pilot workflow was found.");
  const [existing] = await dbAdmin
    .select()
    .from(outreachMessagesTable)
    .where(and(eq(outreachMessagesTable.id, messageId), eq(outreachMessagesTable.jobId, jobId)));
  if (existing && existing.status !== "pending_approval") {
    process.stdout.write(
      JSON.stringify({
        messageId,
        status: existing.status,
        sentAt: existing.sentAt,
        repliedAt: existing.repliedAt,
        replySentiment: existing.replySentiment,
        action: "Existing attempt preserved; no duplicate send or automatic retry.",
      }) + "\n",
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      prerequisitesPassed: true,
      execute: values.execute,
      jobId,
      workflowId: workflow.id,
      scope: "One owner-approved interest-check message; no invitation or hiring action.",
    }) + "\n",
  );
  if (!values.execute) return;
  await dbAdmin
    .insert(outreachMessagesTable)
    .values({
      id: messageId,
      tenantId: job.tenantId,
      jobId,
      candidateId,
      status: "pending_approval",
      subject: "Linx / Lexy internal pilot — are you interested?",
      body: [
        "Hi,",
        "",
        "This is Lexy, following up on the controlled Linx recruiting pilot you approved.",
        "This is an internal test, not an actual job application or hiring decision.",
        "",
        "Would you like to continue to the pilot interview? Please click the Interested button below.",
        "We are checking the sequence: outreach first, your confirmed interest next, then the interview invitation.",
        "There is deliberately no interview link in this message.",
        "",
        "This is a fresh workflow test, separate from the interview you already completed. Your earlier answers and recording are unchanged.",
        "",
        "Lexy",
      ].join("\n"),
      tone: "Owner-approved internal pilot; explicitly test-only",
    })
    .onConflictDoNothing({ target: outreachMessagesTable.id });
  const response = await fetch(`${origin}/api/outreach/messages/${messageId}/approve`, {
    method: "POST",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(
      `Approval/dispatch failed: HTTP ${response.status}; ${result.error ?? "Inspect the saved attempt before retrying."}`,
    );
  }
  const [saved] = await dbAdmin
    .select()
    .from(outreachMessagesTable)
    .where(
      and(
        eq(outreachMessagesTable.id, messageId),
        eq(outreachMessagesTable.tenantId, job.tenantId),
      ),
    );
  process.stdout.write(
    JSON.stringify({
      messageId,
      status: saved?.status,
      sentAt: saved?.sentAt,
      repliedAt: saved?.repliedAt,
      replySentiment: saved?.replySentiment,
      providerAccepted: saved?.status === "sent",
      inboxReceiptConfirmed: false,
      next: "Owner must receive the email and click Interested. No reply or assessment is simulated.",
    }) + "\n",
  );
}
main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
