import type { GreenhouseOfferHistoryEntry } from "@workspace/api-client-react";

const labels: Record<GreenhouseOfferHistoryEntry["state"], string> = {
  prepared: "Prepared for human review",
  approved: "Financial terms approved in Lexy",
  claimed: "Submission claimed — outcome not yet verified",
  draft_created: "Draft receipt saved — approval request not yet verified",
  provider_accepted: "Provider receipt recorded — verification pending",
  verified_submission: "Submission and requested approval state verified",
  not_sent: "No new submission made",
  review_required: "Uncertain outcome — human review required",
  observed_match: "Read-only recovery found matching terms — submission not attributed",
  observed_other: "Read-only recovery did not verify matching terms",
};

export function GreenhouseOfferHistory({ history }: { history: GreenhouseOfferHistoryEntry[] }) {
  return (
    <section
      aria-label="Greenhouse submission history"
      className="min-w-0 space-y-2 rounded-md border border-border p-3 text-xs"
    >
      <h4 className="font-medium">Submission history</h4>
      <p className="text-muted-foreground">
        Committed journal order for retained entries. Historical entries do not establish live
        execution, employer approval, candidate delivery or acceptance. The current execution mode
        is not applied to older entries.
      </p>
      {history.length === 0 ? (
        <p className="text-muted-foreground">No submission history has been recorded.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            Staff IDs below identify who recorded or authorized work in Lexy, not the
            provider&apos;s integration identity. Recovery observations never authorize a retry.
          </p>
          <ol className="max-h-96 space-y-3 overflow-y-auto [overflow-wrap:anywhere]">
            {history.map((entry) => (
              <li key={entry.sequence} className="space-y-1 border-l-2 border-border pl-3">
                <p className="font-medium">
                  #{entry.sequence} · {labels[entry.state]}
                </p>
                <p className="text-muted-foreground">Attempt {entry.attemptId}</p>
                <p className="text-muted-foreground">
                  <time dateTime={entry.recordedAt}>{entry.recordedAt}</time>
                  {" · "}
                  {entry.actorId
                    ? `Lexy staff ID: ${entry.actorId}`
                    : "Staff identity not retained"}
                </p>
                {entry.receiptRecorded && (
                  <p className="text-muted-foreground">
                    A receipt reference was retained; this alone is not approval or delivery proof.
                  </p>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
