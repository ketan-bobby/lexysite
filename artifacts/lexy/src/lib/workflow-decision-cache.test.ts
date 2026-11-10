import assert from "node:assert/strict";
import { test } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
  getGetCandidateOfferRoutingQueryKey,
  getGetCandidateWorkflowOfferQueryKey,
  getGetEmployerOfferInboxItemQueryKey,
  getGetEmployerOfferInboxQueryKey,
  getGetJobWorkflowStateQueryKey,
} from "@workspace/api-client-react";
import { refreshWorkflowDecisionViews } from "./workflow-decision-cache";

const job = "synthetic-job";
const workflow = "synthetic-workflow";
for (const [label, key] of [
  ["workflow", getGetJobWorkflowStateQueryKey(job)],
  ["offer", getGetCandidateWorkflowOfferQueryKey(job, workflow)],
  ["offer routing", getGetCandidateOfferRoutingQueryKey(job, workflow)],
  ["employer inbox item", getGetEmployerOfferInboxItemQueryKey(workflow)],
  ["employer inbox", getGetEmployerOfferInboxQueryKey()],
  ["filtered employer inbox", [...getGetEmployerOfferInboxQueryKey(), { status: "approved" }]],
] as const) {
  test(`decision refresh invalidates ${label} using real React Query matching`, async () => {
    const client = new QueryClient();
    try {
      client.setQueryData(key, { synthetic: true });
      assert.equal(client.getQueryState(key)?.isInvalidated, false);
      await refreshWorkflowDecisionViews(client, job, workflow);
      assert.equal(client.getQueryState(key)?.isInvalidated, true);
    } finally {
      client.clear();
    }
  });
}
test("decision refresh does not invalidate another job, workflow or unrelated private data", async () => {
  const client = new QueryClient();
  const unrelated = [
    getGetJobWorkflowStateQueryKey("other-job"),
    getGetCandidateWorkflowOfferQueryKey(job, "other-workflow"),
    getGetCandidateWorkflowOfferQueryKey("other-job", workflow),
    getGetCandidateOfferRoutingQueryKey(job, "other-workflow"),
    getGetEmployerOfferInboxItemQueryKey("other-workflow"),
    ["/api/private-learning"],
  ];
  try {
    for (const key of unrelated) client.setQueryData(key, { synthetic: true });
    await refreshWorkflowDecisionViews(client, job, workflow);
    for (const key of unrelated) assert.equal(client.getQueryState(key)?.isInvalidated, false);
  } finally {
    client.clear();
  }
});
