/**
 * Explicit operator-only live pilot. Preserves the separate requisition and
 * its real results for inspection. Never calls outreach or interview actions.
 * Execute with: pnpm --filter @workspace/api-server exec tsx
 *   src/scripts/live-sourcing-pilot.ts --execute-live --isolated
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  icpTable,
  candidatesTable,
  applicationsTable,
  sourcedCandidatesTable,
  candidateJobIntelligenceTable,
  agentRunsTable,
  agentRunEventsTable,
  vendorUsageAttemptsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { logger } from "../lib/logger";

const PilotRunStartReply = z.object({ runId: z.string().min(1) }).passthrough();
const PilotRunStateReply = z
  .object({
    run: z.object({ status: z.string().min(1) }).passthrough(),
  })
  .passthrough();

async function main() {
  if (!process.argv.includes("--execute-live") || !process.argv.includes("--isolated"))
    throw new Error("Explicit --execute-live --isolated approval is required.");
  if (process.env.NODE_ENV === "production")
    throw new Error("This pilot seeds the development database only.");
  const domain = process.env.REPLIT_DEV_DOMAIN;
  if (!domain) throw new Error("Development preview domain is required.");
  const prefix = `livepilot_${randomUUID().slice(0, 8)}`;
  const tenantId = `${prefix}_tenant`,
    actorId = `${prefix}_operator`,
    jobId = `${prefix}_job`;
  const createdAt = new Date();
  await dbAdmin.transaction(async (tx) => {
    await tx.insert(tenantsTable).values({
      id: tenantId,
      name: "Live Sourcing Pilot — Isolated Test",
      slug: prefix,
    });
    await tx.insert(usersTable).values({
      id: actorId,
      tenantId,
      role: "tenant_admin",
      status: "active",
      name: "Live Pilot Operator",
      email: `${prefix}@example.invalid`,
      // Not a usable password; the operator token remains in memory only.
      passwordHash: "operator-only-no-password-login",
    });
    await tx.insert(jobsTable).values({
      id: jobId,
      tenantId,
      title: "[LIVE TEST] TypeScript Backend Engineer",
      description:
        "Isolated, approved provider/pipeline verification. TypeScript, Node.js, PostgreSQL backend engineering in Bengaluru, India. Not a customer opening. Do not contact discovered candidates or schedule interviews.",
      location: "Bengaluru, India",
      workType: "onsite",
      status: "active",
      recruitingMode: "lexy_autonomous",
      interviewPath: "human",
      internalMobility: false,
      platformRecommendationsEnabled: false,
      createdById: actorId,
      assignedHiringManagerId: actorId,
    });
    await tx.insert(icpTable).values({
      tenantId,
      jobId,
      version: 1,
      jobTitle: "TypeScript Backend Engineer",
      location: "Bengaluru, India",
      domain: "Software",
      seniority: "mid",
      requiredSkills: ["TypeScript", "Node.js", "PostgreSQL"],
      preferredSkills: ["REST APIs"],
      alternateTitles: ["Backend Engineer", "Software Engineer"],
    });
  });
  const token = issueToken({ userId: actorId, tenantId, role: "tenant_admin" });
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(`https://${domain}/api${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(`Pilot API ${path}: HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data;
  };
  const providerStatus = await api("/sourcing/status");
  // This is the same authenticated start endpoint used by the real app.
  // The existing executor discovers up to 15 profiles per source even for a
  // small shortlist. No verified dollar cap is claimed for this approved pilot.
  const started = PilotRunStartReply.parse(
    await api("/agent-runs/simulate", {
      workOrderId: jobId,
      shortlistSize: 2,
      simulated: false,
    }),
  );
  const runId: string = started.runId;
  logger.info({ jobId, runId, tenantId }, "Isolated live sourcing pilot started");
  let state = PilotRunStateReply.parse(await api(`/agent-runs/${runId}`));
  const stopAt = Date.now() + 8 * 60_000;
  while (["running", "queued"].includes(state.run.status) && Date.now() < stopAt) {
    await new Promise((done) => setTimeout(done, 3000));
    state = PilotRunStateReply.parse(await api(`/agent-runs/${runId}`));
  }
  if (["running", "queued"].includes(state.run.status)) {
    await api(`/agent-runs/${runId}/cancel`, {});
    state = PilotRunStateReply.parse(await api(`/agent-runs/${runId}`));
  }
  // Allow best-effort usage writes to flush. The time-window observation is
  // not exclusive run attribution when telemetry has no tenant context.
  await new Promise((done) => setTimeout(done, 1000));
  const finishedAt = new Date();
  const candidateRows = await dbAdmin
    .select({
      id: candidatesTable.id,
      pool: candidatesTable.pool,
    })
    .from(candidatesTable)
    .where(eq(candidatesTable.tenantId, tenantId));
  const apps = await dbAdmin
    .select({
      candidateId: applicationsTable.candidateId,
      stage: applicationsTable.stage,
      matchScore: applicationsTable.matchScore,
    })
    .from(applicationsTable)
    .where(and(eq(applicationsTable.jobId, jobId), eq(applicationsTable.tenantId, tenantId)));
  const sourced = await dbAdmin
    .select({
      source: sourcedCandidatesTable.source,
      rawData: sourcedCandidatesTable.rawData,
    })
    .from(sourcedCandidatesTable)
    .where(
      and(
        sql`${sourcedCandidatesTable.rawData}->>'runId' = ${runId}`,
        eq(sourcedCandidatesTable.tenantId, tenantId),
      ),
    );
  const intel = await dbAdmin
    .select({ candidateId: candidateJobIntelligenceTable.candidateId })
    .from(candidateJobIntelligenceTable)
    .where(
      and(
        eq(candidateJobIntelligenceTable.jobId, jobId),
        eq(candidateJobIntelligenceTable.tenantId, tenantId),
      ),
    );
  const usage = await dbAdmin
    .select({
      provider: vendorUsageAttemptsTable.provider,
      operation: vendorUsageAttemptsTable.operation,
      status: vendorUsageAttemptsTable.status,
      httpStatus: vendorUsageAttemptsTable.httpStatus,
      attempts: sql<number>`count(*)::int`,
    })
    .from(vendorUsageAttemptsTable)
    .where(
      and(
        gte(vendorUsageAttemptsTable.createdAt, createdAt),
        lte(vendorUsageAttemptsTable.createdAt, finishedAt),
      ),
    )
    .groupBy(
      vendorUsageAttemptsTable.provider,
      vendorUsageAttemptsTable.operation,
      vendorUsageAttemptsTable.status,
      vendorUsageAttemptsTable.httpStatus,
    );
  const [storedRun] = await dbAdmin
    .select()
    .from(agentRunsTable)
    .where(and(eq(agentRunsTable.id, runId), eq(agentRunsTable.tenantId, tenantId)));
  const storedEvents = await dbAdmin
    .select({
      type: agentRunEventsTable.type,
      stepName: agentRunEventsTable.stepName,
      message: agentRunEventsTable.message,
    })
    .from(agentRunEventsTable)
    .where(and(eq(agentRunEventsTable.runId, runId), eq(agentRunEventsTable.tenantId, tenantId)))
    .orderBy(agentRunEventsTable.seq);
  const report = {
    jobId,
    runId,
    tenantId,
    createdAt,
    finishedAt,
    status: storedRun.status,
    isSimulated: storedRun.isSimulated,
    providerStatus,
    candidates: candidateRows.length,
    applications: apps,
    sourcedRows: sourced.length,
    intelligenceRows: intel.length,
    events: storedEvents,
    usageObservation: usage,
    usageCaveat:
      "Time-window counts can include unrelated traffic and are not verified invoice costs.",
    costs: "unknown",
    outreachSentByPilot: false,
    interviewInvitesSentByPilot: false,
    resultScope: "Existing live sourcing path; not acceptance of all autonomous phases.",
    retained: "Isolated test requisition and its real results retained for inspection.",
  };
  const reportPath = resolve("../../reports/live-sourcing", `${prefix}.json`);
  await mkdir(resolve("../../reports/live-sourcing"), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  logger.info(
    {
      reportPath,
      jobId,
      runId,
      status: report.status,
      candidates: report.candidates,
      applications: apps.length,
      sourced: sourced.length,
      intelligence: intel.length,
    },
    "Live sourcing pilot evidence saved",
  );
}

main()
  .catch((error) => {
    logger.error(
      { error: String(error) },
      "Live pilot failed; any created isolated requisition is retained",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
