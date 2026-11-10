import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetJobWorkflowStateQueryKey,
  useControlWorkflowLivePilot,
  type PlannedCandidateWorkflow,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ErrorLine, errText, useIdempotency } from "./workflow-shared";

export function WorkflowLivePilot({
  wf,
  jobId,
  canApprove,
  jobApproved,
}: {
  wf: PlannedCandidateWorkflow;
  jobId: string;
  canApprove: boolean;
  jobApproved: boolean;
}) {
  const qc = useQueryClient();
  const mutation = useControlWorkflowLivePilot({});
  const idem = useIdempotency();
  const [email, setEmail] = useState(wf.livePilot?.testRecipient?.controlledEmail ?? "");
  const [ack, setAck] = useState(false);
  const [testAck, setTestAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pilot = wf.livePilot;
  if (!pilot?.eligible) return null;
  const label =
    pilot.stepKey === "verification"
      ? "identity-check"
      : pilot.stepKey === "engagement"
        ? "outreach"
        : pilot.stepKey === "ai_interview"
          ? "interview-invitation"
          : "screening";
  const control = (action: "activate" | "revoke" | "approve_recipient" | "revoke_recipient") => {
    setError(null);
    mutation.mutate(
      {
        jobId,
        workflowId: wf.id,
        data: {
          expectedRevision: wf.revision,
          idempotencyKey: idem.get(`${wf.id}:${wf.revision}:${action}:${email}:${ack}:${testAck}`),
          action,
          ...(action === "activate"
            ? {
                controlledEmail: email.trim().toLowerCase(),
                acknowledgeUnknownCosts: ack,
                stepKey: pilot.stepKey ?? "screening",
              }
            : {}),
          ...(action === "approve_recipient"
            ? { controlledEmail: email.trim().toLowerCase(), acknowledgeTestRecipient: testAck }
            : {}),
        },
      },
      {
        onSuccess: () => {
          idem.clear();
          setAck(false);
          setTestAck(false);
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
        onError: (e) => {
          setError(errText(e));
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
      },
    );
  };
  return (
    <section
      className="space-y-2 rounded-md border border-border p-3"
      aria-label={`Live ${label} pilot`}
    >
      <p className="text-sm font-medium">Isolated live {label} pilot</p>
      <p className="text-xs text-muted-foreground">
        Explicitly approved {label} work for this candidate and approved journey. Screening may
        update screening scores and pipeline classification; workflow steps still need human review.
        Each later step needs separate activation. Provider charges are unknown; this is not a USD
        spending cap. Activation itself does not run the agent. Pause, Cancel and revocation stop
        new actions; an action already claimed may finish.
      </p>
      <div className="space-y-2 rounded-md border border-border p-2">
        <p className="text-xs font-medium">Candidate-login test inbox</p>
        <p className="text-xs text-muted-foreground">
          Staff inboxes retain their existing checks. For an owner-controlled inbox registered as a
          candidate login, an admin may approve a one-hour exception for this fictional profile and
          this journey only. It does not change the login role, verify identity, activate an agent
          or send email. Fictional evidence stays excluded from hiring reports.
        </p>
        {pilot.testRecipient?.expiresAt && (
          <p className="text-xs" role="status">
            {pilot.testRecipient.active
              ? "Approved test recipient"
              : "Test-recipient permission inactive"}
            : {pilot.testRecipient.controlledEmail}. Window ends{" "}
            {new Date(pilot.testRecipient.expiresAt).toLocaleString()}.
          </p>
        )}
        {canApprove && (
          <>
            <label className="flex items-start gap-2 text-xs">
              <Checkbox checked={testAck} onCheckedChange={(v) => setTestAck(v === true)} />I attest
              that this profile is fictional and this is an internal test inbox I control.
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  mutation.isPending ||
                  !jobApproved ||
                  wf.stale ||
                  wf.status !== "ready" ||
                  !email.trim() ||
                  !testAck
                }
                onClick={() => control("approve_recipient")}
              >
                Approve test recipient for one hour
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={mutation.isPending || !pilot.testRecipient?.expiresAt}
                onClick={() => control("revoke_recipient")}
              >
                Revoke test recipient
              </Button>
            </div>
          </>
        )}
      </div>
      {pilot.stepKey === "engagement" && (
        <p className="text-xs text-muted-foreground">
          Requires resolved identity evidence. Allows one held draft and one separately approved
          first-touch send to the controlled inbox. Review the draft in Outreach Approvals;
          activation and drafting do not send it. Interested records a reply only—no automatic
          invitation. An uncertain send is never automatically retried.
        </p>
      )}
      {pilot.stepKey === "ai_interview" && (
        <p className="text-xs text-muted-foreground">
          Requires a positive reply to this workflow&apos;s sent outreach, human review of that
          reply, and separate activation. Requests one interview invitation to the controlled
          inbox—not a completed interview or assessment.
        </p>
      )}
      {pilot.stepKey === "verification" && (
        <p className="text-xs text-muted-foreground">
          This reviews profile consistency only. AI advice is not independent identity proof:
          identity stays pending until human resolution. Existing checks are reviewed, not
          overwritten.
        </p>
      )}
      {pilot.active && (
        <p role="status" className="text-xs" data-testid={`pilot-active-${wf.id}`}>
          Active until {new Date(pilot.expiresAt!).toLocaleString()}.
          {wf.status === "paused" && " Workflow is paused; no new action may start."}
        </p>
      )}
      {pilot.attempted && (
        <p className="text-xs text-muted-foreground">
          This {label} action has already been claimed. Review its evidence or reconcile an
          uncertain outcome; changing the pilot cannot authorize another attempt.
          {pilot.stepKey === "engagement" &&
            !pilot.sendAttempted &&
            " The held draft can still be approved separately for its first send while authority is active."}
        </p>
      )}
      {canApprove && pilot.active ? (
        <Button
          size="sm"
          variant="outline"
          disabled={mutation.isPending}
          onClick={() => control("revoke")}
          data-testid={`pilot-revoke-${wf.id}`}
        >
          Revoke pilot authority
        </Button>
      ) : canApprove &&
        pilot.stepKey &&
        (!pilot.attempted || (pilot.stepKey === "engagement" && !pilot.sendAttempted)) &&
        wf.status === "ready" &&
        !wf.stale ? (
        <>
          <label className="block text-xs" htmlFor={`pilot-email-${wf.id}`}>
            This candidate&apos;s controlled inbox (staff account or approved test recipient)
          </label>
          <Input
            id={`pilot-email-${wf.id}`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={mutation.isPending}
          />
          <label className="flex items-start gap-2 text-xs">
            <Checkbox
              checked={ack}
              onCheckedChange={(v) => setAck(v === true)}
              disabled={mutation.isPending}
            />
            I approve a one-hour test using a separate synthetic candidate and work order, and
            understand provider charges are unknown.
          </label>
          <Button
            size="sm"
            disabled={!jobApproved || !ack || !email.trim() || mutation.isPending}
            onClick={() => control("activate")}
            data-testid={`pilot-activate-${wf.id}`}
          >
            {mutation.isPending ? "Activating…" : `Activate ${label} pilot`}
          </Button>
        </>
      ) : (
        !pilot.active && (
          <p className="text-xs text-muted-foreground">
            {pilot.stepKey
              ? "Pilot is inactive. An authorised admin must approve this step separately."
              : "Later workflow actions remain locked; this pilot does not cover bulk sourcing, human-interview scheduling or evaluation decisions."}
          </p>
        )
      )}
      <ErrorLine message={error} testId={`pilot-error-${wf.id}`} />
    </section>
  );
}
