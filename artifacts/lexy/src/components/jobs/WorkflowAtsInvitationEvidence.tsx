import { useEffect, useLayoutEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsInvitationEvidenceQueryKey,
  getGetCandidateAtsInterviewInvitationQueryKey,
  getGetCandidateAtsCampaignsQueryKey,
  useGetCandidateAtsInvitationEvidence,
  useReconcileCandidateAtsInvitation,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { errText } from "./workflow-shared";
type Props = {
  jobId: string;
  workflowId: string;
  recordId: string;
  disabled?: boolean;
  onFault?: () => void;
};
export function WorkflowAtsInvitationEvidence(p: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <Button
        size="sm"
        variant="outline"
        disabled={p.disabled}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Close signed delivery evidence" : "Review signed delivery evidence"}
      </Button>
      {open && <EvidenceReview {...p} />}
    </div>
  );
}
function EvidenceReview(p: Props) {
  const qc = useQueryClient(),
    key = getGetCandidateAtsInvitationEvidenceQueryKey(p.jobId, p.workflowId, p.recordId);
  const q = useGetCandidateAtsInvitationEvidence(p.jobId, p.workflowId, p.recordId, {
    query: { queryKey: key, retry: false, gcTime: 0, staleTime: 0, refetchOnMount: "always" },
  });
  const m = useReconcileCandidateAtsInvitation({
    mutation: {
      retry: false,
      gcTime: 0,
      // Mutation-level invalidation survives closing the panel. Variables, not
      // current props, identify the scope whose request actually completed.
      onSuccess: (result, variables) => {
        const evidenceKey = getGetCandidateAtsInvitationEvidenceQueryKey(
          variables.jobId,
          variables.workflowId,
          variables.recordId,
        );
        qc.setQueryData(evidenceKey, result);
        void qc.invalidateQueries({
          queryKey: getGetCandidateAtsInterviewInvitationQueryKey(
            variables.jobId,
            variables.workflowId,
            variables.recordId,
          ),
        });
        const base = getGetCandidateAtsCampaignsQueryKey(
          variables.jobId,
          variables.workflowId,
        )[0] as string;
        void qc.invalidateQueries({
          predicate: (query) =>
            typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith(`${base}/`),
        });
        void qc.invalidateQueries({ queryKey: evidenceKey });
      },
    },
  });
  const st = q.isSuccess && !q.isFetching && !q.failureReason && !q.isError ? q.data : undefined;
  const [ack, setAck] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const onFault = p.onFault;
  useEffect(() => {
    setAck(null);
    setError(null);
  }, [p.jobId, p.workflowId, p.recordId]);
  useEffect(() => setAck(null), [st?.reviewHash]);
  useLayoutEffect(() => {
    if (q.isError || q.failureReason) onFault?.();
  }, [q.isError, q.failureReason, onFault]);
  return (
    <section
      className="space-y-2 text-sm [overflow-wrap:anywhere]"
      aria-label="Signed invitation evidence"
    >
      {q.isFetching && <p role="status">Checking current evidence and employer access…</p>}
      {(q.isError || q.failureReason) && !q.isFetching && (
        <div role="alert">
          {errText(q.error ?? q.failureReason)}{" "}
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Retry evidence
          </Button>
        </div>
      )}
      {st && (
        <>
          <dl className="space-y-1">
            <div>
              <dt className="inline font-semibold">Local send status: </dt>
              <dd className="inline">{st.sendStatus.replace(/_/g, " ")}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Signed SES status: </dt>
              <dd className="inline">
                {st.providerStatus === "delivered"
                  ? "Recipient mail server accepted"
                  : st.providerStatus.replace(/_/g, " ")}
              </dd>
            </div>
            {st.attemptId && (
              <div>
                <dt className="inline font-semibold">Original attempt: </dt>
                <dd className="inline">{st.attemptId}</dd>
              </div>
            )}
            {st.messageId && (
              <div>
                <dt className="inline font-semibold">Verified provider reference: </dt>
                <dd className="inline">{st.messageId}</dd>
              </div>
            )}
            {st.occurredAt && (
              <div>
                <dt className="inline font-semibold">Provider event time: </dt>
                <dd className="inline">{st.occurredAt}</dd>
              </div>
            )}
            {st.receivedAt && (
              <div>
                <dt className="inline font-semibold">Last evidence recorded: </dt>
                <dd className="inline">{st.receivedAt}</dd>
              </div>
            )}
          </dl>
          <p>{st.explanation}</p>
          {st.observations.length > 0 && (
            <details>
              <summary>Recent signed observations</summary>
              <ul className="list-inside list-disc">
                {st.observations.map((o, i) => (
                  <li key={`${o.status}|${o.occurredAt}|${i}`}>
                    {o.status} · {o.occurredAt}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {st.canReconcile && (
            <>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={ack === st.reviewHash}
                  disabled={m.isPending || p.disabled}
                  onChange={(e) => setAck(e.target.checked ? st.reviewHash : null)}
                />
                I reviewed the exact signed evidence and authorize recording provider processing for
                this original attempt. This does not prove inbox placement, resend the email or
                release it for retry.
              </label>
              <Button
                size="sm"
                disabled={m.isPending || p.disabled || ack !== st.reviewHash || !st.attemptId}
                onClick={() => {
                  if (!st.attemptId) return;
                  setError(null);
                  m.mutate(
                    {
                      jobId: p.jobId,
                      workflowId: p.workflowId,
                      recordId: p.recordId,
                      data: {
                        attemptId: st.attemptId,
                        reviewHash: st.reviewHash,
                        acknowledge: true,
                      },
                    },
                    {
                      onError: (e) => {
                        setError(errText(e));
                        p.onFault?.();
                        void qc.invalidateQueries({ queryKey: key });
                      },
                      onSettled: () => setAck(null),
                    },
                  );
                }}
              >
                {m.isPending ? "Recording recognition…" : "Record observed provider processing"}
              </Button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
