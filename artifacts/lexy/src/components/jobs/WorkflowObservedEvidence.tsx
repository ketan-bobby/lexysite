import type { PlannedCandidateWorkflow } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";

export function WorkflowObservedEvidence({ wf }: { wf: PlannedCandidateWorkflow }) {
  const entries = wf.runtimeEvidence ?? [];
  return (
    <section
      className="space-y-2 border-t border-border pt-3"
      data-testid={`runtime-evidence-${wf.id}`}
    >
      <h5 className="text-sm font-medium">Observed activity · saved source records</h5>
      <p className="text-xs text-muted-foreground">
        These records do not complete steps automatically. Review their source and sequence before
        saving a human decision. Candidate identity checks are not job-fit assessments.
      </p>
      {wf.runtimeEvidenceBlockedReason && (
        <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
          {wf.runtimeEvidenceBlockedReason}
        </p>
      )}
      {!entries.length && (
        <p className="text-xs text-muted-foreground">
          No eligible saved activity is linked to this workflow attempt yet. Older attempts and
          other work orders are not counted.
        </p>
      )}
      {entries.map((entry) => (
        <article
          key={`${entry.id}:${entry.stepKey}`}
          className="rounded-md border border-border p-2 space-y-1"
        >
          <div className="flex flex-wrap gap-2 items-center text-xs">
            <b>{wf.steps.find((step) => step.key === entry.stepKey)?.label ?? entry.stepKey}</b>
            <Badge variant="outline">
              {entry.attentionRequired
                ? "Needs attention"
                : entry.readyForReview
                  ? "Ready for human review"
                  : "Observed"}
            </Badge>
          </div>
          <p className="text-xs">{entry.summary}</p>
          <p className="text-xs text-muted-foreground break-all">
            {entry.sourceType} · {entry.sourceId} · {new Date(entry.occurredAt).toLocaleString()}
          </p>
          {entry.reason && <p className="text-xs text-muted-foreground">{entry.reason}</p>}
        </article>
      ))}
    </section>
  );
}
