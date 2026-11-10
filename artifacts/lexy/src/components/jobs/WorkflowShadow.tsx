import { useState } from "react";
import {
  useGetJobWorkflowShadow,
  getGetJobWorkflowShadowQueryKey,
  type WorkflowShadowProposal,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { errText } from "./workflow-shared";

const dispositions: Record<WorkflowShadowProposal["disposition"], string> = {
  proposed: "Proposal only",
  blocked: "Blocked",
  review_required: "Human review required",
  terminal: "No further work",
};

export function WorkflowShadow({ jobId, stateVersion }: { jobId: string; stateVersion: string }) {
  const [expanded, setExpanded] = useState(false);
  const query = useGetJobWorkflowShadow(jobId, {
    query: {
      queryKey: [...getGetJobWorkflowShadowQueryKey(jobId), stateVersion],
      enabled: expanded && !!jobId,
      staleTime: 0,
      refetchInterval: 30_000,
    },
  });
  return (
    <section
      className="min-w-0 max-w-full rounded-lg border border-border bg-muted/20 p-4 space-y-3"
      data-testid="workflow-shadow"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Lexy shadow proposals</h4>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setExpanded((value) => !value)}
          data-testid="button-toggle-shadow"
        >
          {expanded ? "Hide proposals" : "Explain proposed next work"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Phase 3 is a read-only, rule-based preview—not an AI assessment or live agent run. It does
        not change stages, record evidence, contact candidates, book interviews or spend credits. A
        proposal and an approved journey do not grant execution authority.
      </p>
      {expanded && query.isLoading && (
        <p className="text-sm" role="status">
          Reading current workflow context…
        </p>
      )}
      {expanded && query.isError && (
        <div role="alert" className="text-sm space-y-2">
          <p>Could not read shadow proposals: {errText(query.error)}</p>
          <Button size="sm" variant="outline" onClick={() => query.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {expanded && !query.isError && query.data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <p>Deterministic workflow rules · 0 model calls · Execution disabled</p>
            <Button
              size="sm"
              variant="ghost"
              disabled={query.isFetching}
              onClick={() => query.refetch()}
              data-testid="button-refresh-shadow"
            >
              {query.isFetching ? "Refreshing…" : "Refresh proposals"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" data-testid="text-shadow-cost">
            {query.data.costExplanation}
          </p>
          <p className="text-xs text-muted-foreground">
            Mode preset:{" "}
            {query.data.recruitingMode === "human_assisted"
              ? "Human Assisted"
              : "Lexy Autonomous (planned)"}
            . Sourcing scope:{" "}
            {query.data.sourcingScope === "client_current_employees"
              ? "this client's current employees only"
              : "known nonemployees first, then permitted external discovery"}
            . The Intelligence Engine remains separate; no new scoring is performed here.
          </p>
          {query.data.proposals.map((proposal) => (
            <article
              key={proposal.id}
              className="min-w-0 rounded-md border border-border p-3 space-y-2 break-words"
              data-testid={`shadow-proposal-${proposal.workflowId ?? "requisition"}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h5 className="text-sm font-semibold">{proposal.title}</h5>
                <Badge variant="outline">{dispositions[proposal.disposition]}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                {proposal.scope === "candidate"
                  ? `${proposal.candidateName} · journey v${proposal.journeyVersion} · revision ${proposal.workflowRevision}`
                  : "Requisition-level internal-first sourcing"}
              </p>
              <p className="text-sm">{proposal.explanation}</p>
              {proposal.reasons.length > 0 && (
                <ul className="list-disc pl-5 text-xs space-y-1">
                  {proposal.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              )}
              {proposal.requiredChecks.length > 0 && (
                <div className="text-xs space-y-1">
                  <p className="font-medium">
                    Required before any real action—not verified by this preview
                  </p>
                  <ul className="list-disc pl-5 space-y-1">
                    {proposal.requiredChecks.map((check) => (
                      <li key={check}>{check}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                No execution permitted from this proposal.
              </p>
            </article>
          ))}
          <p className="text-xs text-muted-foreground">
            Current snapshot: {new Date(query.data.generatedAt).toLocaleString()}. This view
            refreshes while open; proposals are not stored as approvals, evidence or execution
            history.
          </p>
        </>
      )}
    </section>
  );
}
