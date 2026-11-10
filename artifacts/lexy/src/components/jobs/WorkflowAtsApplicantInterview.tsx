import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsInterviewQueryKey,
  useGetCandidateAtsInterview,
  usePrepareCandidateAtsInterview,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { errText } from "./workflow-shared";
import { WorkflowAtsInterviewInvitation } from "./WorkflowAtsInterviewInvitation";
import { WorkflowAtsInterviewNote } from "./WorkflowAtsInterviewNote";

type Props = {
  jobId: string;
  workflowId: string;
  recordId: string;
  bindingRevision: number;
  workflowRevision: number;
  importRevision: number;
};

/** Read only on deliberate expansion, not for every collapsed imported row. */
export function WorkflowAtsApplicantInterview(props: Props) {
  const [open, setOpen] = useState(false);
  const scope = `${props.jobId}:${props.workflowId}:${props.recordId}:${props.bindingRevision}:${props.workflowRevision}:${props.importRevision}`;
  return (
    <div className="space-y-2 border-t border-border pt-2">
      <Button
        size="sm"
        variant="outline"
        data-testid={`ats-interview-open-${props.recordId}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Close interview preparation" : "Prepare Greenhouse applicant interview"}
      </Button>
      {open && <Preparation key={scope} {...props} />}
    </div>
  );
}

function Preparation(p: Props) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsInterviewQueryKey(p.jobId, p.workflowId, p.recordId);
  const q = useGetCandidateAtsInterview(p.jobId, p.workflowId, p.recordId, {
    query: {
      queryKey: key,
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: "always",
    },
  });
  const m = usePrepareCandidateAtsInterview({ mutation: { retry: false, gcTime: 0 } });
  const [planId, setPlanId] = useState("");
  const [ackHash, setAckHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Refetches and authority failures must not expose a previous private link.
  const st = q.isSuccess && !q.isFetching && !q.failureReason ? q.data : undefined;
  const stale =
    !!st &&
    (st.workflowRevision !== p.workflowRevision ||
      st.bindingRevision !== p.bindingRevision ||
      st.importRevision !== p.importRevision);
  const selected = st?.plans.find((x) => x.id === planId);
  const acknowledged = !!selected && ackHash === selected.approvalHash;
  const busy = m.isPending;
  return (
    <section className="space-y-2 text-xs" aria-label="Greenhouse applicant interview">
      <p className="text-muted-foreground">
        Import or explicitly link the reviewed candidate profile first. This prepares a personal
        interview link from an existing job plan. It does not email the applicant, move an ATS
        stage, enroll a native application, or issue an offer.
      </p>
      {q.isFetching && <p role="status">Checking current preparation authority…</p>}
      {q.isError && (
        <div role="alert">
          <p>Interview preparation unavailable. {errText(q.error)}</p>
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {stale && (
        <p role="alert">
          The employer grant or applicant revision changed. Refresh the imported record.
        </p>
      )}
      {st && !stale && st.session && (
        <div data-testid={`ats-interview-existing-${p.recordId}`}>
          <p>
            {st.session.preparedFromThisImport
              ? "Prepared interview"
              : "Existing interview preserved"}
            {" · "}
            {st.session.status}. No invitation was sent by this action.
          </p>
          <a className="underline" href={st.session.roomUrl} target="_blank" rel="noreferrer">
            Open personal interview link
          </a>
          {st.session.preparedFromThisImport && (
            <WorkflowAtsInterviewInvitation
              jobId={p.jobId}
              workflowId={p.workflowId}
              recordId={p.recordId}
            />
          )}
          {st.session.preparedFromThisImport && (
            <WorkflowAtsInterviewNote
              jobId={p.jobId}
              workflowId={p.workflowId}
              recordId={p.recordId}
            />
          )}
        </div>
      )}
      {st && !stale && !st.session && (
        <>
          <label className="block">
            Existing job interview plan
            <select
              className="mt-1 block w-full rounded-md border border-border bg-background p-2"
              value={planId}
              disabled={busy}
              onChange={(e) => {
                setPlanId(e.target.value);
                setAckHash(null);
              }}
            >
              <option value="">Choose a reviewed plan</option>
              {st.plans.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title} · {x.language} · {x.questionCount} questions
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(e) =>
                setAckHash(e.target.checked && selected ? selected.approvalHash : null)
              }
            />
            I reviewed this job’s selected interview plan. Prepare a link only; do not email the
            applicant.
          </label>
          {!st.canPrepare && (
            <p role="status">
              A nonempty job plan and an applicant without a bound outreach approval are required.
              Use the existing workflow’s invitation controls when outreach is already bound.
            </p>
          )}
          <Button
            size="sm"
            disabled={busy || !st.canPrepare || !selected || !acknowledged}
            data-testid={`ats-interview-prepare-${p.recordId}`}
            onClick={() => {
              if (!selected) return;
              setError(null);
              m.mutate(
                {
                  jobId: p.jobId,
                  workflowId: p.workflowId,
                  recordId: p.recordId,
                  data: {
                    planId: selected.id,
                    expectedPlanHash: selected.approvalHash,
                    acknowledge: true,
                    expectedWorkflowRevision: st.workflowRevision,
                    expectedBindingRevision: st.bindingRevision,
                    expectedImportRevision: st.importRevision,
                  },
                },
                {
                  onSuccess: (result) => {
                    qc.setQueryData(key, result);
                    setAckHash(null);
                    void qc.invalidateQueries({ queryKey: key });
                  },
                  onError: (e) => {
                    setError(errText(e));
                    setAckHash(null);
                    void qc.invalidateQueries({ queryKey: key });
                  },
                },
              );
            }}
          >
            {busy ? "Preparing…" : "Prepare link without sending"}
          </Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
