import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useRecordCandidateWorkflowEvidence,
  type PlannedCandidateWorkflow,
  type WorkflowHumanDecision as Decision,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { WorkflowDecisionCorrection } from "./WorkflowDecisionCorrection";
import { ErrorLine, FINAL_STEP, errText, useIdempotency } from "./workflow-shared";
import { refreshWorkflowDecisionViews } from "@/lib/workflow-decision-cache";

type Outcome = "hire" | "hold" | "decline";
const LABEL: Record<Outcome, string> = { hire: "Hire", hold: "Hold", decline: "Decline" };
const MEANING: Record<Outcome, string> = {
  hire: "Records a human decision to hire. This is not confirmed employment.",
  hold: "Keeps the decision open for further review.",
  decline: "Records a human decision to decline.",
};

function DecisionCard({
  d,
  wfId,
  label,
  idx,
}: {
  d: Decision;
  wfId: string;
  label: string;
  idx: string;
}) {
  return (
    <div
      className="min-w-0 space-y-1 rounded-md border border-border p-2 text-sm"
      data-testid={`human-decision-${label}-${wfId}${idx}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" data-testid={`text-decision-outcome-${wfId}${idx}`}>
          {LABEL[d.outcome as Outcome] ?? d.outcome}
        </Badge>
        {d.testOnly && (
          <Badge variant="destructive" data-testid={`badge-decision-test-only-${wfId}${idx}`}>
            TEST ONLY
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {d.actorName} · {new Date(d.decidedAt).toLocaleString()}
        </span>
      </div>
      <p
        className="whitespace-pre-wrap text-xs [overflow-wrap:anywhere]"
        data-testid={`text-decision-reason-${wfId}${idx}`}
      >
        {d.reason}
      </p>
      {d.correctionReason && (
        <p
          className="text-xs [overflow-wrap:anywhere]"
          data-testid={`text-decision-correction-${wfId}${idx}`}
        >
          Correction reason: {d.correctionReason}
          {d.supersedesDecidedAt &&
            ` (supersedes ${new Date(d.supersedesDecidedAt).toLocaleString()})`}
        </p>
      )}
      {d.offerEffect && d.offerEffect !== "none" && (
        <p className="text-xs text-muted-foreground">
          {d.offerEffect === "approval_reset"
            ? "Unsent offer reset to a new draft; fresh review required."
            : "Delivered offer retained unchanged."}
        </p>
      )}
      {d.testOnly && (
        <p className="text-xs text-muted-foreground">
          Test-only decision: not a real hiring outcome.
        </p>
      )}
    </div>
  );
}

type HumanDecisionProps = {
  wf: PlannedCandidateWorkflow;
  jobId: string;
  canApprove: boolean;
  jobApproved: boolean;
};

export function WorkflowHumanDecision(props: HumanDecisionProps) {
  return <HumanDecisionEditor key={`${props.jobId}:${props.wf.id}`} {...props} />;
}

function HumanDecisionEditor({ wf, jobId, canApprove, jobApproved }: HumanDecisionProps) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const m = useRecordCandidateWorkflowEvidence({});
  const step = wf.steps.find((s) => s.key === FINAL_STEP);
  const [outcome, setOutcome] = useState<Outcome | "">("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  useEffect(() => {
    setConfirming(false);
  }, [outcome, reason, wf.revision, wf.status, wf.stale, canApprove, jobApproved]);
  if (!step) return null;
  const next = wf.steps.find((s) => s.status !== "completed");
  const isNext = next?.key === FINAL_STEP;
  const current = step.humanDecision;
  const history = step.humanDecisionHistory ?? [];
  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= 10 && trimmed.length <= 4000;
  const stateOk = wf.status === "ready" && !wf.stale && jobApproved;
  const formVisible =
    !correcting && isNext && wf.status !== "cancelled" && wf.status !== "completed";
  const canSubmit = canApprove && stateOk && !!outcome && reasonOk && !m.isPending;

  const refresh = () => refreshWorkflowDecisionViews(qc, jobId, wf.id);
  const submit = () => {
    if (!canSubmit || !outcome || !confirming) return;
    setError(null);
    m.mutate(
      {
        jobId,
        workflowId: wf.id,
        data: {
          idempotencyKey: idem.get(`${wf.id}:${wf.revision}:decision:${outcome}:${trimmed}`),
          expectedRevision: wf.revision,
          stepKey: FINAL_STEP,
          status: outcome === "hold" ? "review_required" : "completed",
          evidence: trimmed,
          decision: outcome,
        },
      },
      {
        onSuccess: () => {
          idem.clear();
          setReason("");
          setOutcome("");
          setConfirming(false);
          refresh();
        },
        onError: (e) => {
          setError(errText(e));
          refresh();
        },
      },
    );
  };

  return (
    <div
      className="min-w-0 space-y-2 border-t border-border pt-2"
      data-testid={`human-decision-${wf.id}`}
    >
      <p className="text-sm font-medium">Final hiring decision</p>
      <p
        className="text-xs text-muted-foreground"
        data-testid={`text-decision-distinction-${wf.id}`}
      >
        An AI recommendation is advice only. The human decision below is a recorded approver choice.
        Neither is confirmed employment, and saving a decision creates no offer, hire record,
        pipeline move, reporting entry or fee.
      </p>
      {current ? (
        <DecisionCard d={current} wfId={wf.id} label="current" idx="" />
      ) : step.status === "completed" ? (
        <p className="text-xs text-muted-foreground" data-testid={`text-decision-legacy-${wf.id}`}>
          Legacy completed step: it has a note but no structured human decision. It is not treated
          as a Hire.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid={`text-decision-none-${wf.id}`}>
          No human decision recorded yet.
        </p>
      )}
      {(current || (step.status === "completed" && wf.status === "completed")) && (
        <WorkflowDecisionCorrection
          wf={wf}
          jobId={jobId}
          canApprove={canApprove}
          jobApproved={jobApproved}
          onOpenChange={setCorrecting}
        />
      )}
      {history.length > 0 && (
        <div className="space-y-1" data-testid={`list-decision-history-${wf.id}`}>
          <p className="text-xs font-medium">Earlier decisions</p>
          {history.map((h, i) => (
            <DecisionCard
              key={`${h.decidedAt}-${i}`}
              d={h}
              wfId={wf.id}
              label="history"
              idx={`-${i}`}
            />
          ))}
        </div>
      )}
      {formVisible &&
        (!canApprove ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`text-decision-no-authority-${wf.id}`}
          >
            Read-only: only an approver can record the hiring decision.
          </p>
        ) : !stateOk ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`text-decision-blocked-${wf.id}`}
          >
            Decision unavailable: the workflow must be ready, current with the brief, and the job
            approved.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Decision outcome">
              {(["hire", "hold", "decline"] as Outcome[]).map((o) => (
                <Button
                  key={o}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={outcome === o}
                  variant={outcome === o ? "default" : "outline"}
                  disabled={m.isPending}
                  onClick={() => setOutcome(o)}
                  data-testid={`button-decision-${o}-${wf.id}`}
                >
                  {LABEL[o]}
                </Button>
              ))}
            </div>
            {outcome && <p className="text-xs text-muted-foreground">{MEANING[outcome]}</p>}
            <textarea
              className="w-full rounded-md border border-border bg-background p-2 text-sm"
              rows={3}
              maxLength={4000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for this decision (10 to 4000 characters, required)"
              aria-label="Decision reason"
              disabled={m.isPending}
              data-testid={`input-decision-reason-${wf.id}`}
            />
            <p className="text-xs text-muted-foreground">{trimmed.length}/4000 characters</p>
            {!confirming ? (
              <Button
                size="sm"
                disabled={!canSubmit}
                onClick={() => setConfirming(true)}
                data-testid={`button-decision-review-${wf.id}`}
              >
                Review decision
              </Button>
            ) : (
              <div
                className="flex flex-wrap items-center gap-2 text-sm"
                role="alertdialog"
                aria-label="Confirm decision"
                data-testid={`confirm-decision-${wf.id}`}
              >
                <span>
                  Save {outcome ? LABEL[outcome] : ""} for {wf.candidateName}? This is recorded
                  under your name.
                </span>
                <Button
                  size="sm"
                  disabled={!canSubmit}
                  onClick={submit}
                  data-testid={`button-decision-confirm-${wf.id}`}
                >
                  {m.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
                  Confirm and save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={m.isPending}
                  onClick={() => setConfirming(false)}
                  data-testid={`button-decision-cancel-${wf.id}`}
                >
                  Back
                </Button>
              </div>
            )}
          </div>
        ))}
      <ErrorLine message={error} testId={`text-decision-error-${wf.id}`} />
    </div>
  );
}
