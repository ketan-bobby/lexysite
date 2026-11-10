/**
 * Explicitly authorised, single-recipient retained-pilot delivery only.
 * Uses ordinary scoped HTTP controls; never responds on the recipient's behalf.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  recruitingWorkflowsTable as workflows,
  candidatesTable as candidates,
  usersTable as users,
} from "@workspace/db";

async function main() {
  assert.ok(process.argv.includes("--send-one"), "Explicit single-send authorisation required.");
  const recipient = process.argv.find((v) => v.startsWith("--recipient="))?.slice(12);
  assert.ok(recipient, "Specify the expressly authorised test inbox.");
  const baseline = JSON.parse(await readFile("/tmp/native-finish-pilot-browser.json", "utf8"));
  const [workflow] = await dbAdmin
    .select()
    .from(workflows)
    .where(eq(workflows.id, baseline.workflowId));
  assert.ok(workflow && workflow.tenantId.startsWith("evidence_ui_"));
  assert.equal(workflow.tenantId, baseline.tenantId);
  assert.equal(workflow.jobId, baseline.jobId);
  assert.equal(workflow.candidateId, baseline.candidateId);
  const [candidate] = await dbAdmin
    .select()
    .from(candidates)
    .where(
      and(eq(candidates.id, workflow.candidateId), eq(candidates.tenantId, workflow.tenantId)),
    );
  const marker = (candidate.verificationResult as any)?.syntheticFixture;
  assert.equal(marker?.kind, "controlled_inbox");
  assert.equal(marker.workflowId, workflow.id);
  assert.equal(candidate.email?.toLowerCase(), recipient.toLowerCase());
  const [actor] = await dbAdmin
    .select()
    .from(users)
    .where(
      and(
        eq(users.id, baseline.actorId),
        eq(users.tenantId, workflow.tenantId),
        eq(users.status, "active"),
        eq(users.role, "tenant_admin"),
      ),
    );
  assert.ok(actor, "Only the existing isolated reviewer may execute this test.");
  assert.ok(process.env.REPLIT_DEV_DOMAIN);
  const origin = `https://${process.env.REPLIT_DEV_DOMAIN}`;
  const endpoint = `${origin}/api/jobs/${workflow.jobId}/candidate-workflows/${workflow.id}/offer`;
  async function request(body?: unknown) {
    const response = await fetch(endpoint, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${baseline.sessionToken}`,
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    assert.ok(
      response.ok,
      `Scoped offer request failed: HTTP ${response.status}; ${result.error ?? "inspect the saved delivery state; do not resend"}`,
    );
    return result;
  }
  let state = await request();
  assert.equal(state.eligible, true);
  assert.equal(state.canApprove, true);
  assert.equal(state.offer?.status, "draft", "Never retry a sent or uncertain offer.");
  assert.equal(state.offer.testOnly, true);
  assert.equal(state.offer.version, 1, "Require the exact retained, unsubmitted draft.");
  assert.equal(state.offer.recipientEmail.toLowerCase(), recipient.toLowerCase());
  const terms = state.offer.terms;
  assert.equal(terms.employerName, "Lexy / Linx INTERNAL TEST ONLY");
  assert.equal(terms.roleTitle, "Synthetic SQL Test Role");
  assert.equal(terms.location, "Remote internal test");
  assert.equal(terms.amount, 1);
  assert.equal(terms.currency, "USD");
  assert.equal(terms.frequency, "annual");
  assert.equal(terms.startDate, "2026-11-01");
  assert.equal(new Date(terms.expiresAt).toISOString().slice(0, 10), "2026-10-17");
  const journal = {
    workflowId: workflow.id,
    previousOfferId: state.offer.id,
    authorisedAt: new Date().toISOString(),
    keys: {
      save_draft: randomUUID(),
      submit_review: randomUUID(),
      approve: randomUUID(),
      send: randomUUID(),
    },
  };
  await writeFile("/tmp/native-finish-offer-send-journal.json", JSON.stringify(journal), {
    mode: 0o600,
    flag: "wx",
  });
  const letter = [
    "INTERNAL SYNTHETIC TEST ONLY — NOT A REAL JOB OR LEGAL OFFER.",
    "Employer: Lexy / Linx INTERNAL TEST ONLY. Role: Synthetic SQL Test Role.",
    "Fictional compensation: USD 1 per year. Location: Remote internal test.",
    "Fictional start date: 2026-11-01. Test response deadline: 2026-10-17.",
    "Please open the private Review and respond link and choose Accept or Decline solely to test the controlled-offer workflow.",
    "Either choice records an internal test response only. It does not establish candidate qualification, verified identity, a legal signature, actual employment, a payment, or a placement fee.",
    "The interview score/recommendation disagreement and identity-pending warnings remain unresolved; this test does not waive them.",
    "Do not forward this private test link.",
  ].join("\n\n");
  for (const action of ["save_draft", "submit_review", "approve", "send"] as const) {
    state = await request({
      action,
      expectedRevision: state.workflowRevision,
      idempotencyKey: journal.keys[action],
      ...(action === "save_draft" ? { terms: { ...terms, letter } } : {}),
    });
    assert.equal(state.offer.testOnly, true);
    assert.equal(state.offer.version, 2);
    assert.deepEqual(state.offer.terms, { ...terms, letter });
    assert.equal(
      state.offer.status,
      {
        save_draft: "draft",
        submit_review: "review_required",
        approve: "approved",
        send: "sent",
      }[action],
    );
    process.stdout.write(`${action}: version 2 ${state.offer.status}\n`);
  }
  assert.ok(state.offer.deliveryReceiptId && !/^(sim|demo)-/.test(state.offer.deliveryReceiptId));
  process.stdout.write(
    "One real transport receipt recorded; recipient inbox receipt and response remain unconfirmed. No automatic resend.\n",
  );
}
try {
  await main();
} finally {
  await pool.end();
}
