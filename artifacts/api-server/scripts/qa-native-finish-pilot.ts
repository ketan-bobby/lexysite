/**
 * Read-only by default. Resume a specifically selected retained synthetic pilot.
 * --prepare-browser saves scoped test authentication, never sends or assesses.
 * --verify checks the human intent/draft and the absence of employment/fee effects.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  recruitingWorkflowsTable as workflows,
  candidatesTable as candidates,
  usersTable as users,
  applicationsTable as applications,
  interviewSessionsTable as sessions,
  interviewPlansTable as plans,
  interviewSummariesTable as summaries,
} from "@workspace/db";
import { issueToken } from "../src/lib/auth-token";
import {
  interviewEvaluationWarning,
  isValidInterviewScore,
} from "../src/lib/interview-turn-policy";
import { restrictToRealCandidates } from "../src/lib/synthetic-fixture-scope";
import { fingerprint } from "../src/lib/recruiting-workflows";

const privateFile = "/tmp/native-finish-pilot-browser.json";
async function main() {
  if (process.argv.includes("--cleanup-auth")) {
    await unlink(privateFile);
    process.stdout.write("Removed temporary browser authentication; retained pilot unchanged.\n");
    return;
  }
  const workflowId = process.argv.find((arg) => arg.startsWith("--workflow="))?.slice(11);
  assert.ok(workflowId, "Select the exact retained pilot with --workflow=<id>.");
  const [workflow] = await dbAdmin.select().from(workflows).where(eq(workflows.id, workflowId));
  assert.ok(workflow && workflow.tenantId.startsWith("evidence_ui_"), "Not the isolated pilot.");
  const [candidate] = await dbAdmin
    .select()
    .from(candidates)
    .where(
      and(eq(candidates.id, workflow.candidateId), eq(candidates.tenantId, workflow.tenantId)),
    );
  const marker = (candidate?.verificationResult as any)?.syntheticFixture;
  assert.ok(
    marker?.kind === "controlled_inbox" && marker.workflowId === workflow.id,
    "Require the server-owned fixture marker, not a name/email heuristic.",
  );
  const [actor] = await dbAdmin
    .select()
    .from(users)
    .where(
      and(
        eq(users.tenantId, workflow.tenantId),
        eq(users.role, "tenant_admin"),
        eq(users.status, "active"),
      ),
    );
  assert.ok(actor, "No active isolated reviewer. Never promote the real recipient's account.");
  assert.equal(workflow.steps.length, 6);
  assert.ok(
    workflow.steps.every((step) => step.status === "completed"),
    "Review incomplete stages first.",
  );
  const interviewRows = await dbAdmin
    .select({
      sessionId: sessions.id,
      status: sessions.status,
      total: sessions.totalQuestions,
      answers: sessions.answers,
      score: summaries.overallScore,
      recommendation: summaries.recommendation,
    })
    .from(sessions)
    .innerJoin(plans, eq(sessions.planId, plans.id))
    .leftJoin(summaries, eq(summaries.interviewSessionId, sessions.id))
    .where(
      and(
        eq(sessions.candidateId, workflow.candidateId),
        eq(sessions.tenantId, workflow.tenantId),
        eq(plans.jobId, workflow.jobId),
        eq(plans.tenantId, workflow.tenantId),
      ),
    );
  const applicationRows = await dbAdmin
    .select({ id: applications.id, stage: applications.stage })
    .from(applications)
    .where(
      and(
        eq(applications.jobId, workflow.jobId),
        eq(applications.candidateId, workflow.candidateId),
        eq(applications.tenantId, workflow.tenantId),
      ),
    );
  const outcomes = await dbAdmin.execute(sql`SELECT count(*) AS count FROM candidate_outcomes
    WHERE candidate_id=${workflow.candidateId}`);
  const fees = await dbAdmin.execute(sql`SELECT count(*) AS count FROM fee_line_items
    WHERE tenant_id=${workflow.tenantId} OR candidate_id=${workflow.candidateId}`);
  const eligible = await dbAdmin
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.id, workflow.candidateId), restrictToRealCandidates(candidates.id)));
  assert.equal(
    eligible.length,
    0,
    "The synthetic pilot must stay excluded from real hiring statistics.",
  );
  const final = workflow.steps.find((step) => step.key === "hiring_decision")!;
  const assessment = interviewRows.map((row) => {
    const answers = (row.answers ?? []) as { answer?: unknown; score?: unknown }[];
    return {
      status: row.status,
      expectedQuestions: row.total,
      captured: answers.filter((a) => typeof a.answer === "string" && a.answer.trim()).length,
      graded: answers.filter(
        (a) => isValidInterviewScore(a.score) && typeof a.answer === "string" && a.answer.trim(),
      ).length,
      score: row.score,
      recommendation: row.recommendation,
      warning: interviewEvaluationWarning(row.score, row.recommendation, answers, row.total),
    };
  });
  assert.ok(
    assessment.some((a) => a.status === "completed" && a.graded > 0),
    "A completed interview with usable grades is required; do not invent a substitute.",
  );
  assert.equal(Number(outcomes.rows[0].count), 0);
  assert.equal(Number(fees.rows[0].count), 0);
  assert.notEqual(candidate.verificationStatus, "verified");
  if (process.argv.includes("--prepare-draft")) {
    const baseline = JSON.parse(await readFile(privateFile, "utf8"));
    assert.equal(baseline.workflowId, workflowId);
    assert.equal(baseline.actorId, actor.id);
    assert.equal(
      final.humanDecision,
      undefined,
      "This operation only records a missing legacy intent.",
    );
    assert.equal(final.controlledOffer, undefined);
    assert.ok(process.env.REPLIT_DEV_DOMAIN, "Use the environment owning this pilot.");
    const base = `https://${process.env.REPLIT_DEV_DOMAIN}/api/jobs/${workflow.jobId}/candidate-workflows/${workflowId}`;
    async function request(path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${baseline.sessionToken}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      assert.ok(
        response.ok,
        `Scoped pilot operation failed (${response.status}): ${JSON.stringify(result)}`,
      );
      return result;
    }
    await request("/decision-correction", {
      expectedRevision: workflow.revision,
      idempotencyKey: randomUUID(),
      outcome: "hire",
      acknowledgeLegacyCompletion: true,
      decisionReason:
        "INTERNAL SYNTHETIC WORKFLOW TEST ONLY: score 46 conflicts with AI Yes. This checks offer controls, not candidate qualification or real employment.",
      correctionReason:
        "Record a new explicit test-only intent while retaining the legacy completion note and outstanding evidence warnings.",
    });
    const before = await request("/offer");
    await request("/offer", {
      action: "save_draft",
      expectedRevision: before.workflowRevision,
      idempotencyKey: randomUUID(),
      terms: {
        employerName: "Lexy / Linx INTERNAL TEST ONLY",
        roleTitle: "Synthetic SQL Test Role",
        amount: 1,
        currency: "USD",
        frequency: "annual",
        location: "Remote internal test",
        startDate: "2026-11-01",
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        letter:
          "INTERNAL SYNTHETIC TEST ONLY — not a real job or legal offer. Fictional terms: Lexy / Linx INTERNAL TEST ONLY; Synthetic SQL Test Role; USD 1 per year; Remote internal test; anticipated fictional start 2026-11-01. An acceptance only records a test response, not verified identity, confirmed employment or fees.",
      },
    });
    const saved = await request("/offer");
    assert.equal(saved.offer?.status, "draft");
    assert.equal(saved.offer?.testOnly, true);
    assert.equal(saved.offer?.approvedBy, undefined);
    process.stdout.write(
      "Explicit synthetic intent and unapproved test-only offer draft saved. No send, approval, employment or fee action requested.\n",
    );
    return;
  }
  if (process.argv.includes("--capture-baseline")) {
    assert.equal(final.humanDecision, undefined, "Capture evidence before the new decision.");
    assert.equal(final.controlledOffer, undefined, "Capture evidence before any offer.");
    const baseline = JSON.parse(await readFile(privateFile, "utf8"));
    assert.equal(baseline.workflowId, workflowId);
    baseline.earlierStepFingerprints = workflow.steps.slice(0, 5).map(fingerprint);
    baseline.assessmentFingerprint = fingerprint(interviewRows);
    await writeFile(privateFile, JSON.stringify(baseline), { mode: 0o600 });
  }
  if (process.argv.includes("--prepare-browser")) {
    const sessionToken = issueToken({
      userId: actor.id,
      tenantId: workflow.tenantId,
      role: actor.role,
    });
    await writeFile(
      privateFile,
      JSON.stringify({
        workflowId,
        tenantId: workflow.tenantId,
        candidateId: workflow.candidateId,
        actorId: actor.id,
        staffPath: `/jobs/${workflow.jobId}`,
        jobId: workflow.jobId,
        sessionToken,
        applicationBaseline: applicationRows,
        earlierStepFingerprints: workflow.steps.slice(0, 5).map(fingerprint),
        assessmentFingerprint: fingerprint(interviewRows),
      }),
      { mode: 0o600, flag: "wx" },
    );
  }
  const verifyDelivery = process.argv.includes("--verify-delivery");
  if (process.argv.includes("--verify") || verifyDelivery) {
    const baseline = JSON.parse(await readFile(privateFile, "utf8"));
    assert.equal(baseline.workflowId, workflowId);
    assert.deepEqual(
      applicationRows,
      baseline.applicationBaseline,
      "No implicit pipeline/employment change.",
    );
    assert.deepEqual(
      workflow.steps.slice(0, 5).map(fingerprint),
      baseline.earlierStepFingerprints,
      "Do not rewrite prior stage evidence just to continue the test.",
    );
    assert.equal(
      fingerprint(interviewRows),
      baseline.assessmentFingerprint,
      "The retained interview and assessment must not be reassessed or rewritten.",
    );
    assert.equal(final.humanDecision?.outcome, "hire");
    assert.equal(final.humanDecision?.testOnly, true);
    if (verifyDelivery) {
      assert.equal(final.controlledOffer?.status, "sent");
      assert.equal(final.controlledOffer?.version, 2);
      assert.ok(final.controlledOffer?.approvedBy);
      assert.ok(final.controlledOffer?.sentAt);
      assert.ok(final.controlledOffer?.deliveryReceiptId);
      assert.doesNotMatch(final.controlledOffer!.deliveryReceiptId!, /^(sim|demo)-/);
    } else {
      assert.ok(
        ["draft", "approved"].includes(final.controlledOffer?.status ?? ""),
        "A reviewed test draft must remain unsent.",
      );
    }
    assert.match(final.controlledOffer?.terms.letter ?? "", /internal test|synthetic/i);
  }
  process.stdout.write(
    JSON.stringify(
      {
        allSixStepsCompleted: true,
        assessment,
        structuredIntent: final.humanDecision?.outcome ?? null,
        offerStatus: final.controlledOffer?.status ?? null,
        applicationStages: applicationRows.map((a) => a.stage),
        identityRemainsPending: true,
        realHiringStatisticsExcluded: true,
        employmentOutcomes: 0,
        feeItems: 0,
        browserAuthPrepared: process.argv.includes("--prepare-browser"),
        readOnlyCheck: true,
      },
      null,
      2,
    ) + "\n",
  );
}
try {
  await main();
} finally {
  await pool.end();
}
