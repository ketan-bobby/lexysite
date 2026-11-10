/**
 * One live native identity-advice call, using only the isolated Stage-2 fixture.
 * Screening prerequisite is explicitly synthetic setup, not another paid screen.
 * No identity clearance, outreach or invitation is authorized by this runner.
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
  vendorUsageAttemptsTable,
  outreachMessagesTable,
  interviewSessionsTable,
} from "@workspace/db";

async function main() {
  const fixture = JSON.parse(await readFile("/tmp/workflow-screening-ui-fixture.json", "utf8"));
  assert.equal(fixture.verificationPilot, true);
  assert.ok(String(fixture.tenantId).startsWith("evidence_ui_"));
  for (const key of ["jobId", "candidateId"])
    assert.ok(String(fixture[key]).startsWith(`${fixture.tenantId}_`));
  assert.ok(process.env.REPLIT_DEV_DOMAIN);
  const base = `https://${process.env.REPLIT_DEV_DOMAIN}/api/jobs/${fixture.jobId}`;
  const endpoint = `${base}/candidate-workflows/${fixture.workflowId}`;
  const checks: { name: string; status: number }[] = [];
  async function request(url: string, body?: Record<string, unknown>, rejected?: string) {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${fixture.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(150_000),
    });
    const data = await response.json();
    if (rejected) {
      assert.ok(
        [400, 409].includes(response.status),
        `${rejected} was not safely rejected (${response.status}).`,
      );
      checks.push({ name: rejected, status: response.status });
    } else {
      assert.ok(
        response.ok,
        `Controlled API request failed (${response.status}): ${JSON.stringify(data)}`,
      );
    }
    return data;
  }
  async function workflow() {
    const state = await request(`${base}/workflow-state`);
    const row = state.workflows.find((item: any) => item.id === fixture.workflowId);
    assert.ok(row && row.candidateId === fixture.candidateId);
    return row;
  }
  let wf = await workflow();
  assert.equal(wf.steps[0].status, "completed");
  assert.match(wf.steps[0].evidence, /SYNTHETIC FIXTURE SETUP ONLY/);
  assert.equal(wf.steps[1].key, "verification");
  assert.equal(wf.steps[1].status, "pending");
  const existing = await dbAdmin
    .select()
    .from(verificationRecordsTable)
    .where(
      and(
        eq(verificationRecordsTable.tenantId, fixture.tenantId),
        eq(verificationRecordsTable.candidateId, fixture.candidateId),
      ),
    );
  assert.equal(existing.length, 0, "Existing identity activity must be reviewed, never re-run.");
  console.log("Isolated Stage-2 fixture ready; predecessor clearance is synthetic setup only.");
  if (!process.argv.includes("--execute")) return;
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
    action: "activate",
    stepKey: "verification",
    controlledEmail: `${fixture.tenantId}@example.invalid`,
    acknowledgeUnknownCosts: true,
  });
  wf = await workflow();
  const execution = await request(`${endpoint}/execute`, {
    idempotencyKey: randomUUID(),
    expectedRevision: wf.revision,
  });
  assert.equal(execution.status, "completed");
  wf = await workflow();
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, fixture.candidateId),
        eq(candidatesTable.tenantId, fixture.tenantId),
      ),
    );
  const [record] = await dbAdmin
    .select()
    .from(verificationRecordsTable)
    .where(
      and(
        eq(verificationRecordsTable.candidateId, fixture.candidateId),
        eq(verificationRecordsTable.tenantId, fixture.tenantId),
      ),
    );
  assert.ok(record);
  assert.equal(candidate.verificationStatus, "pending");
  assert.equal(record.status, "pending");
  assert.equal(record.identityVerified, false);
  assert.equal((candidate.verificationResult as any).overallScore, null);
  assert.ok((candidate.verificationResult as any).syntheticFixture);
  assert.equal(wf.steps[1].status, "pending");
  const evidence = wf.runtimeEvidence.find((entry: any) => entry.stepKey === "verification");
  assert.ok(evidence && evidence.attentionRequired && !evidence.readyForReview);
  await request(
    `${endpoint}/evidence`,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: wf.revision,
      stepKey: "verification",
      status: "completed",
      evidence:
        "Synthetic negative test: a manual note does not independently corroborate identity.",
    },
    "Manual note cannot complete pending verification",
  );
  await request(
    `${endpoint}/evidence`,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: wf.revision,
      stepKey: "verification",
      status: "completed",
      runtimeEvidenceId: evidence.id,
      evidence:
        "Synthetic negative test: the saved AI advice is pending, not verified identity evidence.",
    },
    "Pending AI source cannot complete verification",
  );
  await request(
    `${endpoint}/identity-resolution`,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: wf.revision,
      recordId: record.id,
      recordUpdatedAt: record.updatedAt.toISOString(),
      decision: "corroborated",
      acknowledge: false,
      evidence:
        "Synthetic negative test only. No independent corroboration exists and no verification is attested.",
    },
    "Unacknowledged corroboration cannot verify identity",
  );
  await request(
    `${endpoint}/live-pilot`,
    {
      idempotencyKey: randomUUID(),
      expectedRevision: wf.revision,
      action: "activate",
      stepKey: "engagement",
      controlledEmail: `${fixture.tenantId}@example.invalid`,
      acknowledgeUnknownCosts: true,
    },
    "Outreach activation cannot skip unresolved verification",
  );
  const unchanged = await workflow();
  assert.equal(unchanged.revision, wf.revision);
  assert.equal(unchanged.steps[1].status, "pending");
  assert.ok(unchanged.steps.slice(2).every((step: any) => step.status === "pending"));
  const [afterRecord] = await dbAdmin
    .select()
    .from(verificationRecordsTable)
    .where(eq(verificationRecordsTable.id, record.id));
  assert.equal(afterRecord.status, "pending");
  assert.equal(afterRecord.identityVerified, false);
  assert.equal(afterRecord.updatedAt.toISOString(), record.updatedAt.toISOString());
  for (const table of [outreachMessagesTable, interviewSessionsTable]) {
    const rows = await dbAdmin.select().from(table).where(eq(table.tenantId, fixture.tenantId));
    assert.equal(rows.length, 0, "No downstream candidate-contact records may be created.");
  }
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
        eq(vendorUsageAttemptsTable.area, `workflow:${fixture.workflowId}:verification`),
      ),
    );
  assert.equal(usage.length, 1);
  assert.equal(usage[0].status, "succeeded");
  await request(`${endpoint}/live-pilot`, {
    idempotencyKey: randomUUID(),
    expectedRevision: unchanged.revision,
    action: "revoke",
    stepKey: "verification",
    controlledEmail: `${fixture.tenantId}@example.invalid`,
  });
  const final = await workflow();
  assert.equal(final.livePilot.active, false);
  const report = {
    execution,
    candidateStatus: candidate.verificationStatus,
    recordStatus: record.status,
    identityVerified: record.identityVerified,
    displayedOverallScore: (candidate.verificationResult as any).overallScore,
    modelAdviceVerdict: (candidate.verificationResult as any).advisory?.verdict,
    screeningPrerequisite: "synthetic setup only; no screening provider call",
    runtimeEvidence: evidence,
    negativeChecks: checks,
    steps: final.steps,
    providerUsage: usage,
    downstreamContactRecords: 0,
    pilotRevoked: true,
    note: "AI profile-consistency advice only; independent identity verification is not established.",
  };
  await writeFile(
    new URL("../../../docs/qa/controlled-verification-result-2026-10-09.json", import.meta.url),
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
