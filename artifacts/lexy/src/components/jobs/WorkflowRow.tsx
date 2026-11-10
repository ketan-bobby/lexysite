import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetJobWorkflowStateQueryKey,
  useControlCandidateWorkflow,
  useLaunchCandidateWorkflowAction,
  type JobWorkflowState,
  type PlannedCandidateWorkflow,
} from "@workspace/api-client-react";
import { WorkflowHumanDecision } from "./WorkflowHumanDecision";
import { WorkflowControlledOffer } from "./WorkflowControlledOffer";
import { WorkflowOfferRouting } from "./WorkflowOfferRouting";
import { EvidenceForm } from "./WorkflowEvidenceForm";
import { WorkflowObservedEvidence } from "./WorkflowObservedEvidence";
import { WorkflowAtsStageOwnership } from "./WorkflowAtsStageOwnership";
import { WorkflowLivePilot } from "./WorkflowLivePilot";
import { WorkflowIdentityResolution } from "./WorkflowIdentityResolution";
import { WorkflowRecovery } from "./WorkflowRecovery";
import { WorkflowFollowUps } from "./WorkflowFollowUps";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import {
  ErrorLine,
  FINAL_STEP,
  StepList,
  errText,
  useIdempotency,
  pathLabel,
} from "./workflow-shared";

export function WorkflowRow({
  wf,
  state,
  jobId,
}: {
  wf: PlannedCandidateWorkflow;
  state: JobWorkflowState;
  jobId: string;
}) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const m = useControlCandidateWorkflow({});
  const launch = useLaunchCandidateWorkflowAction({});
  const launchIdem = useIdempotency();
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const nextStep = wf.steps.find((step) => step.status !== "completed");
  const needsScreeningInput =
    nextStep?.key === "screening" && nextStep.status === "pending" && !wf.screeningReadiness?.ready;
  const canRequest =
    nextStep?.status === "pending" &&
    ["screening", "verification", "engagement", "ai_interview"].includes(nextStep.key);
  const requestAction = () => {
    if (needsScreeningInput) return;
    setLaunchMessage(null);
    launch.mutate(
      {
        jobId,
        workflowId: wf.id,
        data: {
          expectedRevision: wf.revision,
          idempotencyKey: launchIdem.get(`${wf.id}:${wf.revision}:${nextStep?.key}`),
        },
      },
      {
        onSuccess: (result) => {
          launchIdem.clear();
          setLaunchMessage(`Action ${result.status}. Evidence still needs human review.`);
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
        onError: (error) => {
          setLaunchMessage(errText(error));
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
      },
    );
  };
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const open = wf.status === "ready" || wf.status === "paused";
  const control = (action: "pause" | "resume" | "cancel") => {
    setError(null);
    m.mutate(
      {
        jobId,
        workflowId: wf.id,
        data: {
          idempotencyKey: idem.get(`${wf.id}:${wf.revision}:${action}`),
          expectedRevision: wf.revision,
          action,
        },
      },
      {
        onSuccess: () => {
          idem.clear();
          setConfirmCancel(false);
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
        onError: (e) => setError(errText(e)),
      },
    );
  };
  const resumeBlocked = wf.stale || !state.jobApproved;
  return (
    <div
      className="min-w-0 break-words rounded-lg border border-border p-2 sm:p-3 space-y-2"
      data-testid={`workflow-${wf.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <b>{wf.candidateName}</b>
        <Badge variant="outline">{wf.status}</Badge>
        {wf.stale && <Badge variant="destructive">bound to older brief</Badge>}
        <span className="text-muted-foreground">
          Journey v{wf.journeyVersion} · {pathLabel(wf.interviewPath)} · revision {wf.revision}
        </span>
      </div>
      <StepList steps={wf.steps} />
      {wf.steps.some((x) => x.key === FINAL_STEP) &&
        (nextStep?.key === FINAL_STEP ||
          wf.steps.find((x) => x.key === FINAL_STEP)?.status === "completed" ||
          wf.steps.find((x) => x.key === FINAL_STEP)?.humanDecision) && (
          <WorkflowHumanDecision
            wf={wf}
            jobId={jobId}
            canApprove={state.canApprove}
            jobApproved={state.jobApproved}
          />
        )}
      {state.canEdit &&
        (wf.steps.find((x) => x.key === FINAL_STEP)?.humanDecision ||
          wf.steps.some((x) => x.controlledOffer)) && (
          <>
            <WorkflowOfferRouting wf={wf} jobId={jobId} />
            <WorkflowControlledOffer wf={wf} jobId={jobId} />
          </>
        )}
      <WorkflowAtsStageOwnership key={`${jobId}|${wf.id}`} jobId={jobId} workflowId={wf.id} />
      <WorkflowObservedEvidence wf={wf} />
      <WorkflowFollowUps
        wf={wf}
        jobId={jobId}
        canEdit={state.canEdit}
        canApprove={state.canApprove}
      />
      <WorkflowLivePilot
        wf={wf}
        jobId={jobId}
        canApprove={state.canControlLivePilot === true}
        jobApproved={state.jobApproved}
      />
      {wf.status === "paused" && (
        <p className="text-xs text-muted-foreground">Paused: evidence is blocked until resumed.</p>
      )}
      {wf.status === "cancelled" && (
        <p className="text-xs text-muted-foreground">
          Cancelled: existing evidence and history are preserved.
        </p>
      )}
      {wf.status === "completed" && (
        <p className="text-xs text-muted-foreground">Completed: terminal.</p>
      )}
      {wf.status === "ready" && !wf.stale && state.canEdit && (
        <>
          {state.canApprove && wf.identityResolutionAllowed !== false && (
            <WorkflowIdentityResolution wf={wf} jobId={jobId} />
          )}
          {nextStep?.key !== FINAL_STEP && (
            <EvidenceForm wf={wf} jobId={jobId} canApprove={state.canApprove} />
          )}
          <WorkflowRecovery
            wf={wf}
            jobId={jobId}
            canApprove={state.canControlLivePilot === true}
            jobApproved={state.jobApproved}
          />
          {canRequest && (
            <div className="min-w-0 space-y-1">
              <Button
                size="sm"
                variant="outline"
                className="h-auto min-h-8 max-w-full whitespace-normal text-left"
                onClick={requestAction}
                disabled={
                  launch.isPending ||
                  needsScreeningInput ||
                  m.isPending ||
                  !state.jobApproved ||
                  (wf.livePilot?.eligible &&
                    (!state.canApprove ||
                      !wf.livePilot.active ||
                      wf.livePilot.stepKey !== nextStep?.key ||
                      wf.livePilot.attempted))
                }
                data-testid={`button-workflow-launch-${wf.id}`}
              >
                {launch.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
                Request next action: {nextStep?.label}
              </Button>
              <p className="text-xs text-muted-foreground">
                {wf.livePilot?.active && wf.livePilot.stepKey === nextStep?.key
                  ? "This requests only the separately approved step. Outreach creates a held draft; invitations require reviewed positive interest. Evidence still needs human review."
                  : "Live execution remains locked outside a separately approved step pilot. This request cannot bypass activation or evidence review."}
              </p>
            </div>
          )}
        </>
      )}
      {launchMessage && (
        <p
          role="status"
          className="text-xs text-muted-foreground"
          data-testid={`text-workflow-launch-result-${wf.id}`}
        >
          {launchMessage}
        </p>
      )}
      {needsScreeningInput && (
        <div className="space-y-1 text-xs" role="status" data-testid={`screening-input-${wf.id}`}>
          <p>
            {wf.screeningReadiness?.reason ??
              "Refresh the workflow to check screening qualifications."}
          </p>
          <Link href={`/candidates/${wf.candidateId}`} className="underline">
            Review candidate profile and résumé
          </Link>
          <p className="text-muted-foreground">
            Adding details does not run an assessment, verify identity or make a hiring decision.
          </p>
        </div>
      )}
      {open && state.canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          {wf.status === "ready" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={m.isPending}
              onClick={() => control("pause")}
              data-testid={`button-pause-${wf.id}`}
            >
              Pause
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={resumeBlocked || m.isPending}
              onClick={() => control("resume")}
              data-testid={`button-resume-${wf.id}`}
            >
              Resume
            </Button>
          )}
          {wf.status === "paused" && resumeBlocked && (
            <span className="text-xs text-muted-foreground">
              Resume needs a current brief and an approved job.
            </span>
          )}
          {!confirmCancel ? (
            <Button
              size="sm"
              variant="outline"
              disabled={m.isPending}
              onClick={() => setConfirmCancel(true)}
              data-testid={`button-cancel-${wf.id}`}
            >
              Cancel plan
            </Button>
          ) : (
            <span
              className="flex flex-wrap items-center gap-2 text-sm"
              role="alertdialog"
              aria-label="Confirm cancel"
            >
              Cancel this planned workflow for {wf.candidateName}? Evidence and history are kept.
              <Button
                size="sm"
                variant="destructive"
                disabled={m.isPending}
                onClick={() => control("cancel")}
                data-testid={`button-confirm-cancel-${wf.id}`}
              >
                {m.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
                Confirm cancel
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
                Keep
              </Button>
            </span>
          )}
        </div>
      )}
      <ErrorLine message={error} testId={`text-control-error-${wf.id}`} />
    </div>
  );
}
