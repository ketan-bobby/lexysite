import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsInterviewInvitationQueryKey,
  useGetCandidateAtsInterviewInvitation,
  useSendCandidateAtsInterviewInvitation,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { errText } from "./workflow-shared";
import { WorkflowAtsInvitationEvidence } from "./WorkflowAtsInvitationEvidence";

type Props = { jobId: string; workflowId: string; recordId: string };
export function WorkflowAtsInterviewInvitation(p: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Close invitation review" : "Review invitation delivery"}
      </Button>
      {open && <InvitationReview {...p} />}
    </div>
  );
}

function InvitationReview(p: Props) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsInterviewInvitationQueryKey(p.jobId, p.workflowId, p.recordId);
  const q = useGetCandidateAtsInterviewInvitation(p.jobId, p.workflowId, p.recordId, {
    query: { queryKey: key, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" },
  });
  const m = useSendCandidateAtsInterviewInvitation({ mutation: { retry: false, gcTime: 0 } });
  const [approvedHash, setApprovedHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidenceHeld, setEvidenceHeld] = useState(false);
  const st = !evidenceHeld && q.isSuccess && !q.isFetching && !q.failureReason ? q.data : undefined;
  const messages = {
    not_sent: "No invitation has been sent through this control.",
    provider_accepted:
      "An invitation for this interview was accepted by the email provider. This is not proof of inbox delivery.",
    review_required:
      "A send was claimed or its outcome is uncertain. Held for review; no automatic resend.",
    simulated:
      "No real email was sent: transport simulated or suppressed it. This attempt remains held.",
    previously_sent: "This interview already records an invitation. No duplicate send is allowed.",
  };
  return (
    <section className="space-y-2" aria-label="Greenhouse invitation approval">
      <p>
        Review the recipient and message, then explicitly approve and send one invitation. Standard
        Lexy branding and interview guidance are added. No ATS stage or offer changes.
      </p>
      {q.isFetching && <p role="status">Checking invitation authority…</p>}
      {evidenceHeld && (
        <div role="alert">
          Evidence verification failed. Cached invitation details are hidden until a fresh
          successful review.
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void q.refetch().then((result) => {
                if (result.isSuccess && !result.isFetching && !result.failureReason)
                  setEvidenceHeld(false);
              })
            }
          >
            Retry current invitation review
          </Button>
        </div>
      )}
      {q.isError && (
        <div role="alert">
          {errText(q.error)}{" "}
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Retry review
          </Button>
        </div>
      )}
      {st && (
        <>
          <p role="status">{messages[st.status]}</p>
          <p className="text-muted-foreground">
            Current invitation preview. After a send, these current details are not a historical
            copy of the sent email.
          </p>
          <p>
            <strong>To:</strong> {st.recipient}
          </p>
          <p>
            <strong>Subject:</strong> {st.subject}
          </p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 font-sans">
            {st.text}
          </pre>
          {st.canSend && (
            <>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={approvedHash === st.reviewHash}
                  disabled={m.isPending}
                  onChange={(e) => setApprovedHash(e.target.checked ? st.reviewHash : null)}
                />
                I reviewed this recipient and invitation and authorize sending one email now.
              </label>
              <Button
                size="sm"
                disabled={m.isPending || approvedHash !== st.reviewHash}
                onClick={() => {
                  setError(null);
                  m.mutate(
                    { ...p, data: { reviewHash: st.reviewHash, acknowledge: true } },
                    {
                      onSuccess: (result) => {
                        qc.setQueryData(key, result);
                        setApprovedHash(null);
                        void qc.invalidateQueries({ queryKey: key });
                      },
                      onError: (e) => {
                        setError(errText(e));
                        setApprovedHash(null);
                        void qc.invalidateQueries({ queryKey: key });
                      },
                    },
                  );
                }}
              >
                {m.isPending ? "Submitting invitation…" : "Approve and send one invitation"}
              </Button>
            </>
          )}
          {!st.canSend && st.status === "not_sent" && (
            <p role="status">
              Sending is unavailable. The interview must still be scheduled, employer messaging must
              be enabled, and any existing outreach approval must use its own invitation controls.
            </p>
          )}
          {st.status !== "not_sent" && (
            <WorkflowAtsInvitationEvidence {...p} onFault={() => setEvidenceHeld(true)} />
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
