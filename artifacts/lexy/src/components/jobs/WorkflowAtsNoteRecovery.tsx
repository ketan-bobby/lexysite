import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCandidateAtsNoteRecovery,
  getGetCandidateAtsNoteRecoveryQueryKey,
  useReconcileCandidateAtsNote,
  type AtsNoteRecoveryAttempt,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { errText } from "./workflow-shared";

type Props = { jobId: string; workflowId: string; recordId: string; onVerified: () => void };
export function WorkflowAtsNoteRecovery(p: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 space-y-2 border-t border-border pt-2">
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Close note recovery" : "Review saved note attempts"}
      </Button>
      {open && <RecoveryReview {...p} />}
    </div>
  );
}
function RecoveryReview(p: Props) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsNoteRecoveryQueryKey(p.jobId, p.workflowId, p.recordId);
  const q = useGetCandidateAtsNoteRecovery(p.jobId, p.workflowId, p.recordId, {
    query: { queryKey: key, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" },
  });
  const m = useReconcileCandidateAtsNote({ mutation: { retry: false, gcTime: 0 } });
  const [error, setError] = useState<string | null>(null);
  const data = q.isSuccess && !q.isFetching && !q.failureReason ? q.data : undefined;
  return (
    <section className="min-w-0 space-y-2" aria-label="Greenhouse note recovery">
      <p>
        Verify a note that already exists in Greenhouse. This only reads provider evidence and
        records the result locally. It never creates, resends or deletes a note. A missing or
        different note keeps the hold; email delivery is not verified here.
      </p>
      {q.isFetching && <p role="status">Checking current recovery authority…</p>}
      {q.isError && (
        <div role="alert">
          {errText(q.error)}{" "}
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Retry recovery view
          </Button>
        </div>
      )}
      {data && !data.length && <p>No saved note attempts.</p>}
      {data && (
        <ul className="min-w-0 space-y-3">
          {data.map((a) => (
            <Attempt
              key={`${a.receiptId}:${a.reviewHash}`}
              attempt={a}
              pending={m.isPending}
              verify={(noteId) => {
                setError(null);
                m.mutate(
                  {
                    jobId: p.jobId,
                    workflowId: p.workflowId,
                    recordId: p.recordId,
                    data: {
                      receiptId: a.receiptId,
                      reviewHash: a.reviewHash,
                      noteId,
                      acknowledge: true,
                    },
                  },
                  {
                    onSuccess: (result) => {
                      qc.setQueryData(key, result);
                      void qc.invalidateQueries({ queryKey: key });
                      p.onVerified();
                    },
                    onError: (e) => {
                      setError(errText(e));
                      void qc.invalidateQueries({ queryKey: key });
                    },
                  },
                );
              }}
            />
          ))}
        </ul>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function Attempt({
  attempt: a,
  pending,
  verify,
}: {
  attempt: AtsNoteRecoveryAttempt;
  pending: boolean;
  verify: (noteId: string) => void;
}) {
  const [noteId, setNoteId] = useState("");
  const [approved, setApproved] = useState(false);
  const id = noteId.trim();
  const valid = /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id));
  return (
    <li className="min-w-0 space-y-2 rounded-md border border-border p-3">
      <p className="font-medium">
        {a.mode} note ·{" "}
        {a.status === "held"
          ? "Held for evidence"
          : a.status === "verified_existing"
            ? "Matching existing note verified"
            : "Provider receipt saved"}
      </p>
      <p className="break-all text-xs">Attempt reference: {a.receiptId}</p>
      <p className="text-xs">Claim recorded: {new Date(a.claimedAt).toLocaleString()}</p>
      {a.noteId && <p>Greenhouse note {a.noteId}</p>}
      {a.reason && <p>{a.reason}</p>}
      {a.canVerify && (
        <>
          <label className="block min-w-0">
            Existing Greenhouse note ID
            <input
              className="mt-1 block w-full min-w-0 rounded-md border border-border bg-background p-2"
              inputMode="numeric"
              maxLength={16}
              value={noteId}
              disabled={pending}
              onChange={(e) => {
                setNoteId(e.target.value);
                setApproved(false);
              }}
            />
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={approved}
              disabled={pending || !valid}
              onChange={(e) => setApproved(e.target.checked)}
            />
            I selected this existing note for this held attempt. Verify the exact approved content,
            applicant and employer-only visibility; do not resend anything.
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={!valid || !approved || pending}
            onClick={() => verify(id)}
          >
            {pending ? "Verifying…" : "Verify existing note"}
          </Button>
        </>
      )}
    </li>
  );
}
