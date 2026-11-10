import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsInterviewNoteQueryKey,
  useGetCandidateAtsInterviewNote,
  usePublishCandidateAtsInterviewNote,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { errText } from "./workflow-shared";
import { WorkflowAtsNoteRecovery } from "./WorkflowAtsNoteRecovery";

type Props = { jobId: string; workflowId: string; recordId: string };
export function WorkflowAtsInterviewNote(p: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"progress" | "assessment">("progress");
  return (
    <div className="min-w-0 max-w-full space-y-2 border-t border-border pt-2">
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Close Greenhouse note" : "Review Greenhouse write-back"}
      </Button>
      {open && (
        <>
          <label className="block min-w-0">
            Note content
            <select
              className="mt-1 block w-full min-w-0 max-w-full rounded-md border border-border bg-background p-2"
              value={mode}
              onChange={(e) => setMode(e.target.value as "progress" | "assessment")}
            >
              <option value="progress">Interview progress only</option>
              <option value="assessment">Progress and assessment for approval</option>
            </select>
          </label>
          <NoteReview key={mode} {...p} mode={mode} />
        </>
      )}
    </div>
  );
}
function NoteReview(p: Props & { mode: "progress" | "assessment" }) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsInterviewNoteQueryKey(p.jobId, p.workflowId, p.recordId, p.mode);
  const q = useGetCandidateAtsInterviewNote(p.jobId, p.workflowId, p.recordId, p.mode, {
    query: { queryKey: key, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" },
  });
  const m = usePublishCandidateAtsInterviewNote({ mutation: { retry: false, gcTime: 0 } });
  const [approval, setApproval] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const st = q.isSuccess && !q.isFetching && !q.failureReason ? q.data : undefined;
  return (
    <section className="min-w-0 max-w-full space-y-2" aria-label="Greenhouse note approval">
      <p>
        Publish an employer-only Greenhouse note. This does not advance or reject the applicant,
        send an offer, or publish private coaching, transcripts or recording links.
      </p>
      {q.isFetching && <p role="status">Checking current publication authority…</p>}
      {q.isError && (
        <div role="alert">
          {errText(q.error)}{" "}
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Retry preview
          </Button>
        </div>
      )}
      {st && (
        <>
          {verified && (
            <p role="status">An existing approved note was verified. No new note was sent.</p>
          )}
          <p className="font-medium">{st.title}</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-border p-3 font-sans">
            {st.content}
          </pre>
          <p role="status">
            {st.status === "published"
              ? `Published · Greenhouse note ${st.noteId ?? "receipt recorded"}.`
              : st.status === "review_required"
                ? "Publication held for review. No automatic retry."
                : "Not published."}
          </p>
          {st.reason && <p>{st.reason}</p>}
          {st.canPublish && (
            <>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={approval === st.reviewHash}
                  disabled={m.isPending}
                  onChange={(e) => setApproval(e.target.checked ? st.reviewHash : null)}
                />
                {p.mode === "assessment"
                  ? "I reviewed this job-interview assessment and explicitly approve disclosure of this exact note to the employer’s Greenhouse account."
                  : "I reviewed and approve publishing this exact progress note to the employer’s Greenhouse account."}
              </label>
              <Button
                size="sm"
                disabled={m.isPending || approval !== st.reviewHash}
                onClick={() => {
                  setError(null);
                  m.mutate(
                    {
                      jobId: p.jobId,
                      workflowId: p.workflowId,
                      recordId: p.recordId,
                      data: { mode: p.mode, reviewHash: st.reviewHash, acknowledge: true },
                    },
                    {
                      onSuccess: (result) => {
                        qc.setQueryData(key, result);
                        setApproval(null);
                        void qc.invalidateQueries({ queryKey: key });
                      },
                      onError: (e) => {
                        setError(errText(e));
                        setApproval(null);
                        void qc.invalidateQueries({ queryKey: key });
                      },
                    },
                  );
                }}
              >
                {m.isPending ? "Publishing…" : "Approve and publish one note"}
              </Button>
            </>
          )}
          <WorkflowAtsNoteRecovery
            {...p}
            onVerified={() => {
              setVerified(true);
              setApproval(null);
              void qc.invalidateQueries({ queryKey: key });
            }}
          />
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
