/**
 * One native screening request against an isolated qualified fixture via the real
 * HTTP boundary. No contact, verification, sourcing, or subsequent stage dispatch.
 * Without --execute this is read-only. Never retry an uncertain claimed effect.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  applicationsTable,
  candidatesTable,
  sourcedCandidatesTable,
  candidateEventsTable,
  vendorUsageAttemptsTable,
} from "@workspace/db";

async function main() {
  const fixture = JSON.parse(await readFile("/tmp/workflow-screening-ui-fixture.json", "utf8"));
  for (const key of ["tenantId", "jobId", "candidateId"])
    assert.ok(
      String(fixture[key]).startsWith("evidence_ui_"),
      "Only isolated fixtures are allowed.",
    );
  assert.ok(String(fixture.jobId).startsWith(`${fixture.tenantId}_`));
  assert.ok(String(fixture.candidateId).startsWith(`${fixture.tenantId}_`));
  assert.ok(process.env.REPLIT_DEV_DOMAIN, "Development app domain is required.");
  const base = `https://${process.env.REPLIT_DEV_DOMAIN}/api/jobs/${fixture.jobId}`;
  const endpoint = `${base}/candidate-workflows/${fixture.workflowId}`;
  async function request(url: string, body?: Record<string, unknown>, method?: string) {
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
    if (!response.ok)
      throw new Error(`Controlled request failed (${response.status}): ${JSON.stringify(data)}`);
    return data;
  }
  const snapshot = () => request(`${base}/workflow-state`);
  const bound = (state: any) => {
    const workflow = state.workflows.find((row: any) => row.id === fixture.workflowId);
    assert.ok(
      workflow && workflow.candidateId === fixture.candidateId,
      "Bound fixture is missing.",
    );
    return workflow;
  };
  let state = await snapshot();
  let workflow = bound(state);
  if (process.argv.includes("--inspect")) {
    const scope = (table: any) =>
      and(eq(table.tenantId, fixture.tenantId), eq(table.jobId, fixture.jobId));
    const [candidate] = await dbAdmin
      .select({ score: candidatesTable.resumeScreenScore })
      .from(candidatesTable)
      .where(
        and(
          eq(candidatesTable.id, fixture.candidateId),
          eq(candidatesTable.tenantId, fixture.tenantId),
        ),
      );
    const applications = await dbAdmin
      .select({ id: applicationsTable.id, stage: applicationsTable.stage })
      .from(applicationsTable)
      .where(and(scope(applicationsTable), eq(applicationsTable.candidateId, fixture.candidateId)));
    const sources = await dbAdmin
      .select({ id: sourcedCandidatesTable.id, data: sourcedCandidatesTable.rawData })
      .from(sourcedCandidatesTable)
      .where(
        and(
          eq(sourcedCandidatesTable.tenantId, fixture.tenantId),
          eq(sourcedCandidatesTable.normalizedCandidateId, fixture.candidateId),
        ),
      );
    const events = await dbAdmin
      .select({ type: candidateEventsTable.eventType })
      .from(candidateEventsTable)
      .where(
        and(scope(candidateEventsTable), eq(candidateEventsTable.candidateId, fixture.candidateId)),
      );
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
          eq(vendorUsageAttemptsTable.area, `workflow:${fixture.workflowId}:screening`),
        ),
      );
    const source = sources.find((row) => (row.data as any)?.jobId === fixture.jobId);
    assert.ok(source, "A job-bound native screening source is required.");
    const grade = (source.data as any).screeningResult;
    assert.equal(candidate.score, grade.score);
    assert.equal(applications.length, 1);
    if (process.argv.includes("--sync-saved-fixture")) {
      assert.equal(
        applications[0].stage,
        "sourced",
        "Only this fixture's missed initial handoff may be repaired.",
      );
      assert.ok(usage.some((row) => row.status === "succeeded"));
      const stage = grade.recommendation === "reject" ? "rejected" : "screening";
      await request(
        `https://${process.env.REPLIT_DEV_DOMAIN}/api/applications/${applications[0].id}`,
        { stage, skipAutomation: true },
        "PUT",
      );
      console.log("Isolated fixture synchronized from its saved grade; no assessor was re-run.");
      return;
    }
    assert.equal(
      applications[0].stage,
      grade.recommendation === "reject" ? "rejected" : "screening",
    );
    assert.ok(events.some((row) => row.type === "STAGE_CHANGED"));
    assert.ok(
      usage.some((row) => row.status === "succeeded"),
      "Attributed provider usage is missing.",
    );
    assert.ok(workflow.steps.slice(1).every((step: any) => step.status === "pending"));
    const persistence = {
      score: candidate.score,
      grade,
      pipelineStage: applications[0].stage,
      stageChangeEvents: events,
      usage,
      workflowSteps: workflow.steps,
      noSubsequentDispatch: workflow.steps.slice(1).every((step: any) => step.status === "pending"),
    };
    await writeFile(
      new URL("../../../docs/qa/controlled-screening-persistence-2026-10-09.json", import.meta.url),
      JSON.stringify(persistence, null, 2),
    );
    console.log(JSON.stringify(persistence, null, 2));
    return;
  }
  assert.equal(workflow.steps[0].key, "screening");
  assert.equal(workflow.steps[0].status, "pending");
  assert.equal(workflow.screeningReadiness.ready, true);
  console.log("Qualified fixture is ready for one controlled screening action.");
  if (!process.argv.includes("--execute")) return;
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: workflow.revision,
    action: "activate",
    stepKey: "screening",
    controlledEmail: `${fixture.tenantId}@example.invalid`,
    acknowledgeUnknownCosts: true,
  });
  state = await snapshot();
  workflow = bound(state);
  const execution = await request(`${endpoint}/execute`, {
    idempotencyKey: randomUUID(),
    expectedRevision: workflow.revision,
  });
  state = await snapshot();
  workflow = bound(state);
  const report = {
    execution,
    workflowStatus: workflow.status,
    steps: workflow.steps,
    runtimeEvidence: workflow.runtimeEvidence,
    screeningReadiness: workflow.screeningReadiness,
    livePilot: workflow.livePilot,
    reviewed: false,
    note: "Native assessment only. No human evidence approval or subsequent dispatch.",
  };
  await writeFile(
    new URL("../../../docs/qa/controlled-screening-result-2026-10-09.json", import.meta.url),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  assert.equal(execution.status, "completed");
  assert.equal(workflow.steps[0].status, "pending", "A grade must not auto-approve the workflow.");
  assert.ok(workflow.steps.slice(1).every((step: any) => step.status === "pending"));
  assert.ok(
    workflow.runtimeEvidence.some(
      (entry: any) => entry.stepKey === "screening" && entry.readyForReview,
    ),
    "Native screening evidence must be visible and reviewable after reload.",
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
