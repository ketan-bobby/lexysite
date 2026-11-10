import { randomUUID } from "node:crypto";
import { fingerprint, WorkflowConflict } from "./recruiting-workflows";
import type { CostRequest } from "./sourcing-meter";

// Lease ownership carries a permanent plan digest plus a fresh process identity.
// Never store request bodies, prompts or vendor request IDs in the owner field.
const PREFIX = "sourcing-plan:";
export function workerPlanHash(owner: string): string | null {
  if (!owner.startsWith(PREFIX)) return null;
  const match = /^sourcing-plan:([a-f0-9]{64}):[a-f0-9-]{36}$/.exec(owner);
  if (!match) throw new WorkflowConflict("Invalid plan-bound worker identity.");
  return match[1];
}

export function snapshotWorkerPlan(requests: readonly CostRequest[]) {
  if (!requests.length || requests.length > 1000)
    throw new WorkflowConflict("A bounded, nonempty execution plan is required.");
  const plan = structuredClone(requests);
  const keys = new Set<string>();
  for (const request of plan) {
    if (!request.operationKey || keys.has(request.operationKey))
      throw new WorkflowConflict("Every planned request needs a unique stable identity.");
    keys.add(request.operationKey);
  }
  const hash = fingerprint(plan);
  return { plan, owner: `${PREFIX}${hash}:${randomUUID()}` };
}

export function internalSourcingPlanHash(hold: {
  id: string;
  briefHash: string;
  policyHash: string;
}) {
  return fingerprint({
    kind: "local-internal-discovery",
    reservationId: hold.id,
    briefHash: hold.briefHash,
    policyHash: hold.policyHash,
    version: 1,
  });
}
