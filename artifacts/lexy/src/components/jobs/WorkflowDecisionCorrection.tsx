import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateWorkflowOfferQueryKey,
  useCorrectCandidateWorkflowDecision,
  useGetCandidateWorkflowOffer,
  type PlannedCandidateWorkflow,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { ErrorLine, FINAL_STEP, errText, useIdempotency } from "./workflow-shared";
import { refreshWorkflowDecisionViews } from "@/lib/workflow-decision-cache";

type Outcome = "hire" | "hold" | "decline";
const LABEL: Record<Outcome, string> = { hire: "Hire", hold: "Hold", decline: "Decline" };
const RETAINED = ["sent", "accepted", "declined", "expired", "send_uncertain"];
const UNSENT = ["draft", "review_required", "approved"];

export function WorkflowDecisionCorrection({
  wf,
  jobId,
  canApprove,
  jobApproved,
  disabled,
  onOpenChange,
}: {
  wf: PlannedCandidateWorkflow;
  jobId: string;
  canApprove: boolean;
  jobApproved: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const m = useCorrectCandidateWorkflowDecision({});
  const step = wf.steps.find((s) => s.key === FINAL_STEP);
  const current = step?.humanDecision;
  const legacy = !current && step?.status === "completed" && wf.status === "completed";
  const precedingDone = wf.steps
    .filter((s) => s.key !== FINAL_STEP)
    .every((s) => s.status === "completed");
  const eligible =
    !!step &&
    (!!current || legacy) &&
    canApprove &&
    jobApproved &&
    !wf.stale &&
    (wf.status === "ready" || wf.status === "completed") &&
    precedingDone &&
    !disabled;
  const [open, setOpenState] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>((current?.outcome as Outcome) ?? "hold");
  const [reason, setReason] = useState(current?.reason ?? "");
  const [why, setWhy] = useState("");
  const [ack, setAck] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [reviewedRevision, setReviewedRevision] = useState<number | null>(null);
  const offerQ = useGetCandidateWorkflowOffer(jobId, wf.id, {
    query: {
      enabled: open && eligible,
      queryKey: getGetCandidateWorkflowOfferQueryKey(jobId, wf.id),
      staleTime: 0,
      refetchInterval: open ? 5000 : false,
    },
  });
  const setOpen = (v: boolean) => {
    if (v) {
      setOutcome((current?.outcome as Outcome) ?? "hold");
      setReason(current?.reason ?? "");
      setWhy("");
      setAck(false);
      setError(null);
      setNeedsRefresh(false);
      setReviewedRevision(wf.revision);
      setConfirming(false);
      idem.clear();
    }
    setOpenState(v);
    onOpenChange?.(v);
  };
  useEffect(() => {
    setConfirming(false);
  }, [outcome, reason, why, ack, wf.revision, eligible]);
  useEffect(() => {
    if (!eligible && open) {
      setOpenState(false);
      setAck(false);
      setConfirming(false);
      setReviewedRevision(null);
      onOpenChange?.(false);
    }
  }, [eligible, open, onOpenChange]);
  if (!eligible || !step) return null;

  const offer = offerQ.data?.offer ?? null;
  const status = offer?.status as string | undefined;
  const sending = status === "sending";
  const retained = !!status && RETAINED.includes(status);
  const unsent = !!status && UNSENT.includes(status);
  const offerKnown = offerQ.isSuccess && offerQ.data?.workflowRevision === wf.revision;
  const reviewStale = needsRefresh || reviewedRevision !== wf.revision;
  const r = reason.trim();
  const w = why.trim();
  const valid = r.length >= 10 && r.length <= 4000 && w.length >= 10 && w.length <= 2000;
  const changed = !current || outcome !== current.outcome || r !== current.reason.trim();
  const canSubmit =
    valid &&
    changed &&
    offerKnown &&
    !sending &&
    (!retained || ack) &&
    (!legacy || (ack && !offer)) &&
    !m.isPending &&
    !reviewStale;
  const refresh = () => refreshWorkflowDecisionViews(qc, jobId, wf.id);
  const submit = () => {
    if (!canSubmit || !confirming) return;
    setError(null);
    m.mutate(
      {
        jobId,
        workflowId: wf.id,
        data: {
          idempotencyKey: idem.get(
            `${wf.id}:${wf.revision}:${outcome}:${r}:${w}:${retained && ack}`,
          ),
          expectedRevision: wf.revision,
          outcome,
          decisionReason: r,
          correctionReason: w,
          ...(retained ? { acknowledgeDeliveredOffer: true } : {}),
          ...(legacy ? { acknowledgeLegacyCompletion: true } : {}),
        },
      },
      {
        onSuccess: () => {
          idem.clear();
          setWhy("");
          setAck(false);
          setConfirming(false);
          setOpen(false);
          refresh();
        },
        onError: (e) => {
          setError(errText(e));
          setConfirming(false);
          setNeedsRefresh(true);
          refresh();
        },
      },
    );
  };
  const field = "w-full rounded-md border border-border bg-background p-2 text-sm";

  return (
    <div className="min-w-0 space-y-2" data-testid={`correction-history-${wf.id}`}>
      {!open ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          data-testid={`correction-open-${wf.id}`}
        >
          {legacy ? "Record structured decision" : "Correct decision"}
        </Button>
      ) : (
        <form
          className="min-w-0 space-y-2 rounded-md border border-border p-2"
          aria-label={
            legacy ? "Record first structured hiring decision" : "Correct hiring decision"
          }
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) setConfirming(true);
          }}
        >
          <p className="text-sm font-medium">
            {legacy ? "Record a first structured decision" : "Correct recorded decision"}
          </p>
          <p className="text-xs text-muted-foreground">
            {legacy
              ? "The legacy note and earlier evidence stay unchanged. Choose a new explicit human intent; no Hire is inferred. Evidence warnings remain for human review. This is not employment."
              : "The original decision stays in history. A correction is not employment and does not rewrite AI advice."}
          </p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Corrected outcome">
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
                data-testid={`correction-outcome-${o}-${wf.id}`}
              >
                {LABEL[o]}
              </Button>
            ))}
          </div>
          <label className="block text-xs font-medium" htmlFor={`corr-reason-${wf.id}`}>
            Decision reason (10 to 4000 characters)
          </label>
          <textarea
            id={`corr-reason-${wf.id}`}
            className={field}
            rows={3}
            maxLength={4000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={m.isPending}
            data-testid={`correction-reason-${wf.id}`}
          />
          <label className="block text-xs font-medium" htmlFor={`corr-why-${wf.id}`}>
            {legacy ? "Why record a structured decision now?" : "Why are you correcting it?"} (10 to
            2000 characters, required)
          </label>
          <textarea
            id={`corr-why-${wf.id}`}
            className={field}
            rows={2}
            maxLength={2000}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            disabled={m.isPending}
            data-testid={`correction-why-${wf.id}`}
          />
          {offerQ.isLoading && (
            <p className="text-xs text-muted-foreground">Checking offer state...</p>
          )}
          {legacy && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={ack}
                disabled={m.isPending}
                onChange={(e) => setAck(e.target.checked)}
                data-testid={`legacy-decision-ack-${wf.id}`}
              />
              I reviewed the saved evidence and its outstanding warnings. The legacy note is not a
              Hire; this records my new explicit intent without clearing those warnings or
              confirming employment.
            </label>
          )}
          {offerQ.isError && (
            <p role="alert" className="text-xs text-destructive">
              Offer state could not be loaded; correction is blocked.{" "}
              <button type="button" className="underline" onClick={() => offerQ.refetch()}>
                Retry
              </button>
            </p>
          )}
          {sending && (
            <p role="alert" className="text-xs text-destructive">
              An offer is being sent. Correction is blocked until delivery settles.
            </p>
          )}
          {(unsent || (offerKnown && !offer)) && unsent && (
            <p
              role="alert"
              className="rounded-md border border-destructive p-2 text-xs font-medium text-destructive"
            >
              Saving any correction, even Hire to Hire, turns the unsent offer into a new draft
              version and clears its approval. The offer must be freshly reviewed and approved.
            </p>
          )}
          {retained && (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={ack}
                onChange={(e) => setAck(e.target.checked)}
                data-testid={`correction-ack-${wf.id}`}
              />
              <span>
                I understand the existing {status?.replace("_", " ")} offer remains unchanged.
                Withdrawal is a separate action and is not implied.
              </span>
            </label>
          )}
          {!confirming ? (
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              data-testid={`correction-review-${wf.id}`}
            >
              Review correction
            </Button>
          ) : (
            <div
              className="flex flex-wrap items-center gap-2 text-sm"
              role="alertdialog"
              aria-label="Confirm correction"
              data-testid={`correction-confirm-${wf.id}`}
            >
              <span>
                {current
                  ? `Correct ${LABEL[current.outcome as Outcome] ?? current.outcome} to`
                  : "Record"}{" "}
                {LABEL[outcome]} for {wf.candidateName}? Recorded under your name.
              </span>
              <Button
                type="button"
                size="sm"
                disabled={!canSubmit}
                onClick={submit}
                data-testid={`correction-confirm-button-${wf.id}`}
              >
                {m.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
                Confirm correction
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={m.isPending}
                onClick={() => setConfirming(false)}
              >
                Back
              </Button>
            </div>
          )}
          {reviewStale && (
            <p className="text-xs text-muted-foreground">
              The workflow changed or the request failed. Your inputs are kept; review again once
              refreshed.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setReviewedRevision(wf.revision);
                  setNeedsRefresh(false);
                  setConfirming(false);
                }}
              >
                I reviewed the refreshed state
              </button>
            </p>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={m.isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <ErrorLine message={error} testId={`correction-error-${wf.id}`} />
        </form>
      )}
    </div>
  );
}
