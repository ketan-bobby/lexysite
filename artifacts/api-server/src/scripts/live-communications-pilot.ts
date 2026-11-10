/**
 * Explicitly approved live sends to an operator-controlled inbox only.
 * Recipient is supplied at runtime; no inbox address is stored in this script.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  outreachMessagesTable,
  interviewSessionsTable,
  auditLogsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { logger } from "../lib/logger";
import { interviewRoomUrl } from "../lib/interview-link-url";

const PilotInterviewReply = z
  .object({
    sessionId: z.string().min(1),
    emailSent: z.boolean().optional(),
    interviewType: z.string().optional(),
    questionCount: z.number().int().positive().optional(),
    reused: z.boolean().optional(),
  })
  .passthrough();

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => args[args.indexOf(key) + 1];
  const evidencePath = value("--source-evidence");
  const recipient = value("--recipient");
  if (
    !args.includes("--execute-live") ||
    !args.includes("--recipient") ||
    !args.includes("--source-evidence") ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)
  )
    throw new Error("Explicit --execute-live, --source-evidence and --recipient are required.");
  if (process.env.NODE_ENV === "production") throw new Error("Development pilot only.");
  const evidence = JSON.parse(await readFile(resolve(evidencePath), "utf8"));
  const { jobId, tenantId } = evidence;
  if (!String(jobId).startsWith("livepilot_") || !String(tenantId).startsWith("livepilot_"))
    throw new Error("Only a previously created isolated pilot is allowed.");
  const [job] = await dbAdmin
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, tenantId)));
  if (!job || !job.title.startsWith("[LIVE TEST]") || job.status !== "active")
    throw new Error("Approved isolated test work order not found.");
  const [actor] = await dbAdmin
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(
      and(
        eq(usersTable.tenantId, tenantId),
        eq(usersTable.role, "tenant_admin"),
        eq(usersTable.status, "active"),
      ),
    )
    .limit(1);
  if (!actor) throw new Error("Isolated operator not found.");
  // Ensure the email origin can be resolved before any paid generation or send.
  interviewRoomUrl("preflight");
  const domain = process.env.REPLIT_DEV_DOMAIN;
  if (!domain) throw new Error("Development domain missing.");
  const existing = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(and(eq(candidatesTable.tenantId, tenantId), eq(candidatesTable.email, recipient)));
  if (existing.length)
    throw new Error(
      "This inbox already has a pilot candidate; inspect it instead of repeating sends.",
    );
  const suffix = randomUUID().slice(0, 8);
  const candidateId = `livepilot_candidate_${suffix}`;
  const applicationId = `livepilot_application_${suffix}`;
  const messageId = `livepilot_outreach_${suffix}`;
  await dbAdmin.transaction(async (tx) => {
    await tx.insert(candidatesTable).values({
      id: candidateId,
      tenantId,
      email: recipient,
      firstName: "Live Test",
      lastName: "Candidate",
      pool: "tenant",
      currentTitle: "Synthetic Backend Engineer — Test Only",
      skills: ["TypeScript", "Node.js", "PostgreSQL"],
      createdById: actor.id,
    });
    await tx.insert(applicationsTable).values({
      id: applicationId,
      tenantId,
      jobId,
      candidateId,
      stage: "sourced",
    });
    await tx.insert(outreachMessagesTable).values({
      id: messageId,
      tenantId,
      jobId,
      candidateId,
      status: "pending_approval",
      subject: "[LIVE TEST] Lexy outreach delivery check — no real vacancy",
      body: "This is the live test you requested for Lexy. This candidate and work order are synthetic; this is not an actual recruiting message. This checks the real approval and email-send path. A separate clearly labelled interview invitation will follow. No response is required, and no discovered candidates have been contacted.",
      followUpSchedule: [],
      followUpsDispatched: [],
    });
  });
  const token = issueToken({ userId: actor.id, tenantId, role: "tenant_admin" });
  const api = async (path: string, body: unknown) => {
    const response = await fetch(`https://${domain}/api${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(`HTTP ${response.status} on ${path}; inspect pilot records before retrying.`);
    return data;
  };
  await api(`/outreach/messages/${messageId}/approve`, {});
  const [sent] = await dbAdmin
    .select({ status: outreachMessagesTable.status, sentAt: outreachMessagesTable.sentAt })
    .from(outreachMessagesTable)
    .where(
      and(eq(outreachMessagesTable.id, messageId), eq(outreachMessagesTable.tenantId, tenantId)),
    );
  if (sent.status !== "sent" || !sent.sentAt)
    throw new Error("Outreach was not recorded as a real send; no invitation will be attempted.");
  logger.info(
    { candidateId, messageId, status: sent.status },
    "Live test outreach submitted to provider",
  );
  const interview = PilotInterviewReply.parse(
    await api("/interviews/generate-link", {
      jobId,
      candidateId,
      applicationId,
      interviewType: "technical",
      questionCount: 3,
      language: "en",
      focusDirective:
        "Synthetic test only. Ask concise backend-engineering questions. Do not treat this as an actual hiring assessment.",
    }),
  );
  // Retry the mint, not the send. Existing live sessions must be reused.
  const reused = PilotInterviewReply.parse(
    await api("/interviews/generate-link", {
      jobId,
      candidateId,
      applicationId,
      interviewType: "technical",
      questionCount: 3,
      language: "en",
    }),
  );
  const [session] = await dbAdmin
    .select({
      id: interviewSessionsTable.id,
      status: interviewSessionsTable.status,
    })
    .from(interviewSessionsTable)
    .where(
      and(
        eq(interviewSessionsTable.id, interview.sessionId),
        eq(interviewSessionsTable.tenantId, tenantId),
      ),
    );
  await new Promise((done) => setTimeout(done, 500));
  const audits = await dbAdmin
    .select({ action: auditLogsTable.action, metadata: auditLogsTable.metadata })
    .from(auditLogsTable)
    .where(and(eq(auditLogsTable.tenantId, tenantId), eq(auditLogsTable.subjectId, candidateId)));
  const report = {
    jobId,
    tenantId,
    candidateId,
    applicationId,
    messageId,
    sessionId: session.id,
    completedAt: new Date(),
    outreachStatus: sent.status,
    outreachSentAt: sent.sentAt,
    interviewEmailSent: interview.emailSent === true,
    interviewType: interview.interviewType,
    questionCount: interview.questionCount,
    interviewStatus: session.status,
    reusedSession: reused.sessionId === interview.sessionId && reused.reused === true,
    invitationAuditCount: audits.filter((a) => a.action === "interview.invite.sent").length,
    outreachAuditCount: audits.filter((a) => a.action === "outreach.message.sent").length,
    deliveryScope: "Provider acceptance, not independent confirmation of inbox arrival.",
    recipient: "Operator-controlled test inbox supplied at runtime; omitted from this report.",
    actualCandidateContacted: false,
    followUpSchedule: [],
    costs: "unknown",
    browserInterviewJourney: "Not tested yet",
  };
  const reportPath = resolve("../../reports/live-sourcing/communications-pilot.json");
  await mkdir(resolve("../../reports/live-sourcing"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  logger.info(
    {
      reportPath,
      sessionId: session.id,
      emailSent: report.interviewEmailSent,
      reused: report.reusedSession,
    },
    "Live communications evidence saved",
  );
  if (!report.interviewEmailSent || !report.reusedSession)
    throw new Error(
      "Invitation acceptance or mint reuse failed; inspect saved evidence before retrying.",
    );
}
main()
  .catch((error) => {
    logger.error(
      { error: String(error) },
      "Live communications pilot failed; do not blindly repeat sends.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
