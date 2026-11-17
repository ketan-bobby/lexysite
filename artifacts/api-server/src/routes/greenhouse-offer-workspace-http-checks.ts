import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbAdmin, usersTable, recruitingWorkflowsTable as workflows } from "@workspace/db";
import type { GreenhouseOfferWorkspace, GreenhouseOfferWorkspaceInput } from "@workspace/api-zod";
import { greenhouseOfferWorkspace } from "../lib/greenhouse-offer-workspace";
import { offerDigest, offerTermsHash } from "../lib/ats-connectors/greenhouse-offer-policy";
import type { OfferControlProvider } from "../lib/ats-connectors/greenhouse-offer-controls";
import { safeOfferSteps } from "../lib/controlled-offer-view";

export async function checkGreenhouseOfferWorkspace<A extends string>({
  fixture,
  request,
  actorId,
  tenantId,
  actors,
}: {
  fixture: () => Promise<{ jobId: string; workflowId: string; path: string }>;
  request: (
    method: string,
    path: string,
    input?: unknown,
    actor?: A | null,
  ) => Promise<{ status: number; body: unknown }>;
  actorId: (actor: A) => string;
  tenantId: string;
  actors: { owner: A; approver: A; candidate: A; foreign: A; other: A };
}) {
  const c = await fixture();
  const path = c.path.replace(/\/offer$/, "/greenhouse-offer");
  const routing = `${c.path}-routing`;
  const before = await request("GET", routing, undefined, actors.owner);
  assert.equal(
    (
      await request(
        "POST",
        routing,
        {
          mode: "external",
          ownerUserId: actorId(actors.owner),
          externalSystem: "Greenhouse",
          expectedRevision: (before.body as { workflowRevision: number }).workflowRevision,
          idempotencyKey: randomUUID(),
          reason: "Isolated local HR financial review fixture only.",
        },
        actors.owner,
      )
    ).status,
    200,
  );
  const handoff = c.path.replace(/\/offer$/, "/ats-handoff");
  async function packetAction(action: string, extra = {}) {
    const state = await request("GET", handoff, undefined, actors.owner);
    const result = await request(
      "POST",
      handoff,
      {
        action,
        expectedRevision: (state.body as { workflowRevision: number }).workflowRevision,
        idempotencyKey: randomUUID(),
        ...extra,
      },
      actors.owner,
    );
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body as { packet: { id: string; snapshotHash: string } };
  }
  const account = randomUUID();
  await packetAction("save_mapping", {
    mapping: {
      accountRef: account,
      externalJobId: "101",
      externalCandidateId: "202",
      externalApplicationId: "303",
    },
  });
  const packet = (await packetAction("prepare")).packet;
  const exact = { packetId: packet.id, snapshotHash: packet.snapshotHash };
  await packetAction("approve", { ...exact, acknowledgeReview: true });
  await packetAction("export", exact);
  const read = async (actor = actors.owner) => {
    const r = await request("GET", path, undefined, actor);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as GreenhouseOfferWorkspace;
  };
  assert.equal((await request("GET", path, undefined, null)).status, 401);
  assert.equal((await request("GET", path, undefined, actors.foreign)).status, 404);
  assert.equal((await request("GET", path, undefined, actors.candidate)).status, 403);
  assert.equal((await request("GET", path, undefined, actors.other)).status, 403);
  const empty = await read();
  assert.equal(empty.executionMode, "unavailable");
  assert.deepEqual(empty.history, []);
  const save: GreenhouseOfferWorkspaceInput = {
    action: "save",
    expectedLocalRevision: empty.localRevision,
    idempotencyKey: randomUUID(),
    confirm: true,
    proposal: {
      openingId: "102",
      startDate: "2027-01-15",
      approverId: actorId(actors.approver),
      submitterId: actorId(actors.owner),
      values: { salary: { amountMinor: 12345678, currency: "USD" } },
    },
  };
  const saved = await request("POST", path, save, actors.owner);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const st = saved.body as GreenhouseOfferWorkspace;
  assert.equal((await request("POST", path, save, actors.owner)).status, 200);
  assert.equal((await read()).workflowRevision, st.workflowRevision, "Save replay is a no-op");
  assert.equal(
    (
      await request(
        "POST",
        path,
        {
          ...save,
          idempotencyKey: randomUUID(),
        },
        actors.owner,
      )
    ).status,
    409,
    "Stale editor cannot overwrite the new version",
  );
  assert.equal(
    (
      await request(
        "POST",
        path,
        {
          ...save,
          expectedLocalRevision: st.localRevision,
          confirm: false,
        },
        actors.owner,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        "POST",
        path,
        {
          ...save,
          expectedLocalRevision: st.localRevision,
          executionMode: "simulated",
        },
        actors.owner,
      )
    ).status,
    400,
    "Clients cannot enable simulation or supply evidence",
  );
  for (const action of ["prepare", "approve", "submit", "recover"]) {
    assert.equal(
      (
        await request(
          "POST",
          path,
          {
            action,
            expectedLocalRevision: st.localRevision,
            idempotencyKey: randomUUID(),
            confirm: true,
          },
          actors.owner,
        )
      ).status,
      409,
    );
  }
  const reviewer = await read(actors.approver);
  assert.deepEqual(reviewer.proposal?.values, save.proposal!.values);
  assert.equal(reviewer.canEdit, false);
  assert.equal(
    (
      await request(
        "POST",
        path,
        {
          ...save,
          expectedLocalRevision: st.localRevision,
          idempotencyKey: randomUUID(),
        },
        actors.approver,
      )
    ).status,
    403,
  );
  const [row] = await dbAdmin.select().from(workflows).where(eq(workflows.id, c.workflowId));
  const general = JSON.stringify(safeOfferSteps(row.steps));
  assert(!general.includes("12345678"));
  assert(!general.includes("greenhouseOfferProposal"));
  assert(!JSON.stringify(safeOfferSteps(row.steps, false)).includes("12345678"));
  assert(
    !JSON.stringify(
      (await request("GET", `/jobs/${c.jobId}/workflow-state`, undefined, actors.owner)).body,
    ).includes("12345678"),
    "The generic HTTP workflow response excludes financial proposals",
  );

  // Actual local workflow/HR authority with an injected, in-memory employer contract and provider.
  const binding = { applicationId: "303", candidateId: "202", jobId: "101" };
  let remote: Awaited<ReturnType<OfferControlProvider["read"]>> = {
    accountRef: offerDigest(account),
    binding,
    chain: null,
    termsHash: null,
    approvalState: "none",
  };
  let submissions = 0;
  const verifiedAt = Date.now();
  const simulation: OfferControlProvider = {
    read: async () => structuredClone(remote),
    submitForApproval: async (s) => {
      submissions++;
      remote = {
        ...remote,
        chain: { id: "404", version: 1, revision: "d".repeat(64) },
        termsHash: offerTermsHash(s),
        approvalState: "pending",
      };
      return { status: "accepted", chain: remote.chain! };
    },
  };
  const service = greenhouseOfferWorkspace({
    simulation,
    evidence: {
      resolve: async () => ({
        connectionRevision: "synthetic-verified-connection",
        canReadRemote: true,
        writePermissionConfirmed: true,
        existingChain: remote.chain,
        existingApprovalState: remote.approvalState,
        contract: {
          accountRef: offerDigest(account),
          connectionRevision: "synthetic-verified-connection",
          bindingHash: offerDigest(binding),
          chainHash: offerDigest(remote.chain),
          revision: "e".repeat(64),
          evidenceReference: "isolated-simulated-employer-contract",
          verifiedAt,
          expiresAt: verifiedAt + 600000,
          applicationBound: true,
          sideEffectsReviewed: true,
          approvalFlowConfirmed: true,
          candidateDeliveryDisabled: true,
          startDateRequired: true,
          openingRequired: true,
          allowedOpeningIds: ["102"],
          fields: [
            {
              key: "salary",
              type: "currency",
              required: true,
              choices: [],
              currencies: ["USD"],
              min: 1,
              max: 100000000,
            },
          ],
        },
      }),
    },
  });
  const scope = (actor: A) => ({
    jobId: c.jobId,
    tenantId,
    actorId: actorId(actor),
    canApprove: true,
    canEdit: true,
  });
  const visible = async () => true; // HTTP paths above exercise the real candidate/privacy gate.
  async function control(action: GreenhouseOfferWorkspaceInput["action"], actor = actors.owner) {
    const s = await service.read(scope(actor), c.workflowId, visible);
    return service.control(
      scope(actor),
      c.workflowId,
      {
        action,
        expectedLocalRevision: s.localRevision,
        expectedControlRevision: s.controlRevision!,
        idempotencyKey: randomUUID(),
        confirm: true,
        ...(action === "prepare" ? {} : { attemptId: s.attempt!.id }),
      },
      visible,
    );
  }
  let prepared = await control("prepare");
  assert.equal(prepared.attempt?.state, "prepared");
  await assert.rejects(control("approve"), /designated human/);
  const approved = await control("approve", actors.approver);
  assert.equal(approved.attempt?.state, "approved");
  assert.equal(submissions, 0, "Human approval cannot submit by itself");
  const oldAttempt = prepared.attempt!;
  const current = await read();
  assert.equal(
    (
      await request(
        "POST",
        path,
        {
          ...save,
          expectedLocalRevision: current.localRevision,
          idempotencyKey: randomUUID(),
          proposal: {
            ...save.proposal!,
            values: { salary: { amountMinor: 22345678, currency: "USD" } },
          },
        },
        actors.owner,
      )
    ).status,
    200,
  );
  const [edited] = await dbAdmin.select().from(workflows).where(eq(workflows.id, c.workflowId));
  assert.deepEqual(
    edited.steps.find((step) => step.key === "hiring_decision")!.greenhouseOfferProposalHistory?.[0]
      .values.salary,
    { amountMinor: 12345678, currency: "USD" },
    "Retain the exact previous financial proposal",
  );
  assert(
    !JSON.stringify(safeOfferSteps(edited.steps)).includes("12345678"),
    "Historical financial terms stay private too",
  );
  const changed = await service.read(scope(actors.owner), c.workflowId, visible);
  await assert.rejects(
    service.control(
      scope(actors.owner),
      c.workflowId,
      {
        action: "submit",
        expectedLocalRevision: changed.localRevision,
        expectedControlRevision: oldAttempt.revision,
        attemptId: oldAttempt.id,
        idempotencyKey: randomUUID(),
        confirm: true,
      },
      visible,
    ),
  );
  assert.equal(submissions, 0, "Editing terms invalidates the old approval");
  prepared = await control("prepare");
  await control("approve", actors.approver);
  const submitted = await control("submit");
  assert.equal(submitted.attempt?.state, "verified_submission");
  const journal = (await read()).history;
  assert.equal(
    journal.length,
    7,
    "Both prepared attempts and every committed transition remain visible",
  );
  assert.deepEqual(
    journal.map((entry) => entry.sequence),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(journal.at(-1)?.state, "verified_submission");
  assert.equal(journal.at(-1)?.actorId, actorId(actors.owner));
  assert(journal.some((entry) => entry.actorId === actorId(actors.approver)));
  for (const entry of journal) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "actorId",
      "attemptId",
      "receiptRecorded",
      "recordedAt",
      "sequence",
      "state",
    ]);
  }
  assert(!JSON.stringify(journal).includes("22345678"));
  assert.equal((await request("GET", path, undefined, actors.foreign)).status, 404);
  assert.equal((await request("GET", path, undefined, actors.other)).status, 403);
  assert.equal(remote.approvalState, "pending", "Submission is not remote approval or delivery");
  await assert.rejects(control("submit"));
  assert.equal(submissions, 1, "Copied and repeated requests cannot submit twice");
  await dbAdmin
    .update(usersTable)
    .set({ status: "suspended" })
    .where(eq(usersTable.id, actorId(actors.approver)));
  try {
    await assert.rejects(service.read(scope(actors.approver), c.workflowId, visible));
    const denied = await request("GET", path, undefined, actors.approver);
    assert([401, 403].includes(denied.status));
    assert(!JSON.stringify(denied.body).includes("receiptRecorded"));
  } finally {
    await dbAdmin
      .update(usersTable)
      .set({ status: "active" })
      .where(eq(usersTable.id, actorId(actors.approver)));
  }
}
