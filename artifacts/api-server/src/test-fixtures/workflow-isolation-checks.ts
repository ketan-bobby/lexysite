import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

type Actor = "admin" | "outsider" | "candidate" | null;
export type IsolationCase = {
  jobId: string;
  candidateId: string;
  workflowId: string;
  journeyId: string;
  revision: number;
  briefHash: string;
  stepKeys: string[];
};
type Probe = { path: string; body?: unknown };
type Request = (
  path: string,
  body: unknown,
  actor: Actor,
) => Promise<{ status: number; body: unknown }>;

function probes(c: IsolationCase, workflowId = c.workflowId): Probe[] {
  const job = `/jobs/${c.jobId}`;
  const workflow = `${job}/candidate-workflows/${workflowId}`;
  const input = () => ({
    idempotencyKey: randomUUID(),
    expectedRevision: c.revision,
  });
  return [
    { path: `${job}/workflow-state` },
    { path: `${job}/workflow-shadow` },
    { path: `${workflow}/follow-ups` },
    { path: `${workflow}/control`, body: { ...input(), action: "pause" } },
    { path: `${workflow}/execute`, body: input() },
    ...c.stepKeys.map((stepKey) => ({
      path: `${workflow}/evidence`,
      body: {
        ...input(),
        stepKey,
        status: "review_required",
        evidence: "Fictional isolation probe; never save a foreign review.",
      },
    })),
  ];
}

export async function checkWorkflowIsolation(input: {
  primary: IsolationCase;
  sibling: IsolationCase;
  foreign: IsolationCase;
  request: Request;
  snapshot: () => Promise<unknown>;
}) {
  const { primary, sibling, foreign, request, snapshot } = input;
  assert.equal(primary.stepKeys.length, 6);
  const before = await snapshot();
  let denied = 0;
  const reject = async (probe: Probe, actor: Actor, status: number) => {
    const response = await request(probe.path, probe.body, actor);
    assert.equal(response.status, status, `${actor ?? "anonymous"}: ${probe.path}`);
    const text = JSON.stringify(response.body);
    for (const c of [primary, sibling, foreign]) {
      assert.ok(!text.includes(c.candidateId), "Denied response exposed candidate identity");
      assert.ok(!text.includes(c.workflowId), "Denied response exposed workflow identity");
    }
    denied++;
    return response;
  };
  for (const [actor, status] of [
    [null, 401],
    ["candidate", 403],
    ["outsider", 404],
  ] as const) {
    for (const probe of probes(primary)) await reject(probe, actor, status);
  }
  for (const probe of probes(foreign)) {
    const deniedResponse = await reject(probe, "admin", 404);
    const missingResponse = await reject(
      { ...probe, path: probe.path.replace(foreign.jobId, randomUUID()) },
      "admin",
      404,
    );
    assert.deepEqual(deniedResponse.body, missingResponse.body);
  }
  // An authorized job must not grant access to another job's child workflow,
  // even when both jobs belong to the same customer.
  for (const child of [sibling, foreign]) {
    for (const probe of probes(primary, child.workflowId).slice(2)) {
      const deniedResponse = await reject(probe, "admin", 404);
      const absent = {
        ...probe,
        path: probe.path.replace(child.workflowId, randomUUID()),
      };
      const missingResponse = await reject(absent, "admin", 404);
      assert.deepEqual(deniedResponse.body, missingResponse.body);
    }
  }
  for (const child of [sibling, foreign]) {
    for (const body of [
      { journeyId: child.journeyId, candidateId: primary.candidateId },
      { journeyId: primary.journeyId, candidateId: child.candidateId },
    ]) {
      await reject(
        {
          path: `/jobs/${primary.jobId}/candidate-workflows`,
          body: {
            ...body,
            idempotencyKey: randomUUID(),
            expectedBriefHash: primary.briefHash,
          },
        },
        "admin",
        404,
      );
    }
  }
  assert.deepEqual(await snapshot(), before, "Denied requests changed persisted state");
  for (const [c, actor] of [
    [primary, "admin"],
    [foreign, "outsider"],
  ] as const) {
    for (const probe of probes(c).slice(0, 3)) {
      const response = await request(probe.path, undefined, actor);
      assert.equal(response.status, 200);
      const text = JSON.stringify(response.body);
      for (const other of [primary, sibling, foreign].filter((row) => row !== c)) {
        assert.ok(!text.includes(other.candidateId), "Authorized read leaked another candidate");
        assert.ok(!text.includes(other.workflowId), "Authorized read leaked another workflow");
      }
    }
    const pause = probes(c).find((probe) => probe.path.endsWith("/control"))!;
    assert.equal((await request(pause.path, pause.body, actor)).status, 200);
  }
  return { denied, stages: primary.stepKeys.length };
}
