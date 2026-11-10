import { useState } from "react";
import {
  useControlCandidateWorkflowOffer,
  type ControlledOffer,
  type ControlledOfferInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { ErrorLine, errText, useIdempotency } from "./workflow-shared";

type Mode = "check" | "settle" | null;
type Snap = { revision: number; attempt: string };

export function ReconciliationSummary({
  rec,
  id,
}: {
  rec: NonNullable<ControlledOffer["deliveryReconciliation"]>;
  id: string;
}) {
  return (
    <div
      className="rounded-md bg-muted p-2 text-xs [overflow-wrap:anywhere]"
      data-testid={`delivery-reconcile-result-${id}`}
    >
      <p className="font-medium">
        Latest delivery reconciliation: {rec.outcome.replace(/_/g, " ")} ·{" "}
        {new Date(rec.checkedAt).toLocaleString()} by {rec.checkedBy}
      </p>
      <p>Reason: {rec.reason}</p>
      {rec.evidenceReference && <p>Evidence: {rec.evidenceReference}</p>}
      {rec.outcome === "provider_accepted" && (
        <p>
          The provider accepted the message. This is NOT confirmation of inbox receipt or reading.
        </p>
      )}
      {rec.outcome === "confirmed_not_sent" && (
        <p>Settled by a human: the provider request was terminated and never accepted.</p>
      )}
      {rec.outcome === "uncertain" && <p>Still uncertain. Do not resend.</p>}
    </div>
  );
}

export function DeliveryReconcilePanel({
  wfId,
  jobId,
  offer,
  revision,
  canReconcile,
  onDone,
}: {
  wfId: string;
  jobId: string;
  offer: ControlledOffer;
  revision: number;
  canReconcile: boolean;
  onDone: () => void;
}) {
  const idem = useIdempotency();
  const m = useControlCandidateWorkflowOffer({});
  const [mode, setMode] = useState<Mode>(null);
  const [snap, setSnap] = useState<Snap | null>(null);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [ack, setAck] = useState(false);
  const [sure, setSure] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = offer.deliveryAttemptId;
  const rec = offer.deliveryReconciliation;
  const stale = !!snap && (snap.revision !== revision || snap.attempt !== attempt);

  const reset = () => {
    setMode(null);
    setSnap(null);
    setReason("");
    setEvidence("");
    setAck(false);
    setSure(false);
    setConfirming(false);
    setError(null);
  };
  const open = (md: Exclude<Mode, null>) => {
    if (!attempt) return;
    reset();
    setMode(md);
    setSnap({ revision, attempt });
  };
  const settleOk = reason.trim().length >= 10 && evidence.trim().length >= 10 && ack;
  const checkOk = sure;
  const canSubmit =
    !!snap &&
    !stale &&
    !m.isPending &&
    (mode === "check" ? checkOk : mode === "settle" && settleOk && confirming);

  const submit = () => {
    if (!snap || !canSubmit || !mode) return;
    setError(null);
    const data: ControlledOfferInput = {
      action: "reconcile_delivery",
      idempotencyKey: idem.get(
        `${wfId}:${snap.revision}:${snap.attempt}:${mode}:${reason.trim()}:${evidence.trim()}`,
      ),
      expectedRevision: snap.revision,
      deliveryAttemptId: snap.attempt,
      deliveryResolution: mode === "check" ? "check_provider" : "confirmed_not_sent",
    };
    if (mode === "settle") {
      data.reason = reason.trim();
      data.evidenceReference = evidence.trim();
      data.acknowledgeNoDelivery = true;
    }
    m.mutate(
      { jobId, workflowId: wfId, data },
      {
        onSuccess: () => {
          idem.clear();
          reset();
          onDone();
        },
        onError: (e) => {
          setError(errText(e));
          setConfirming(false);
          setAck(false);
          onDone();
        },
      },
    );
  };

  const box = "w-full rounded-md border border-border bg-background p-2 text-sm";
  return (
    <div
      className="space-y-2 rounded-md border border-destructive/40 p-2 text-xs"
      data-testid={`delivery-reconcile-${wfId}`}
    >
      <p className="text-sm font-medium">Delivery uncertain: reconcile the original attempt</p>
      <p>
        Lexy does not know whether the original send reached the provider. Do not resend. Provider
        acceptance is not inbox delivery, and Lexy never confirms that the candidate received it.
      </p>
      {rec && <ReconciliationSummary rec={rec} id={wfId} />}
      {!attempt ? (
        <p
          role="alert"
          className="text-destructive"
          data-testid={`delivery-reconcile-legacy-${wfId}`}
        >
          This offer has no recorded delivery attempt (legacy). It stays held for investigation and
          cannot be unlocked here.
        </p>
      ) : !canReconcile ? (
        <p className="text-muted-foreground">
          Only the designated owner or sender can reconcile delivery.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="h-auto whitespace-normal text-left"
              variant={mode === "check" ? "default" : "outline"}
              disabled={m.isPending}
              onClick={() => open("check")}
              data-testid={`reconcile-open-check-${wfId}`}
            >
              Check original attempt evidence
            </Button>
            <Button
              size="sm"
              className="h-auto whitespace-normal text-left"
              variant={mode === "settle" ? "default" : "outline"}
              disabled={m.isPending}
              onClick={() => open("settle")}
              data-testid={`reconcile-open-settle-${wfId}`}
            >
              Settle: provider verified request never accepted
            </Button>
          </div>
          {mode === "check" && (
            <div className="space-y-2">
              <p>
                This checks Lexy's existing server-written records for attempt {attempt}. It sends
                nothing and makes no provider call, but the server may update delivery status, audit
                and revision.
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={sure}
                  onChange={(e) => setSure(e.target.checked)}
                  data-testid={`reconcile-check-confirm-${wfId}`}
                />
                <span>I want to check the evidence for this original attempt now.</span>
              </label>
            </div>
          )}
          {mode === "settle" && (
            <div className="space-y-2">
              <p className="font-medium">
                Missing receipts, errors, bounces or unopened emails do NOT prove the message had no
                effect. Use this only after verifying with the provider that the provider request
                was terminated and was NEVER accepted (not bounced, not delivered). It resets the
                draft and clears approval; nothing is sent automatically.
              </p>
              <label className="block space-y-0.5">
                <span>Reason (10 or more characters)</span>
                <textarea
                  className={box}
                  rows={2}
                  maxLength={4000}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setConfirming(false);
                  }}
                  data-testid={`reconcile-reason-${wfId}`}
                />
              </label>
              <label className="block space-y-0.5">
                <span>Provider evidence reference (10 or more characters)</span>
                <input
                  className={box}
                  maxLength={1000}
                  value={evidence}
                  onChange={(e) => {
                    setEvidence(e.target.value);
                    setConfirming(false);
                  }}
                  data-testid={`reconcile-evidence-${wfId}`}
                />
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => {
                    setAck(e.target.checked);
                    setConfirming(false);
                  }}
                  data-testid={`reconcile-ack-${wfId}`}
                />
                <span>
                  I verified that the original provider request terminated without acceptance.
                  Missing receipts, bounces or unread emails are not that proof.
                </span>
              </label>
              {!confirming && (
                <Button
                  size="sm"
                  className="h-auto whitespace-normal text-left"
                  disabled={!settleOk || stale || m.isPending}
                  onClick={() => setConfirming(true)}
                  data-testid={`reconcile-review-${wfId}`}
                >
                  Review settlement
                </Button>
              )}
              {confirming && (
                <div
                  role="alertdialog"
                  aria-label="Confirm settlement"
                  className="rounded-md border border-destructive/40 p-2 font-medium [overflow-wrap:anywhere]"
                  data-testid={`reconcile-confirm-dialog-${wfId}`}
                >
                  Confirm: the provider request was terminated and was NEVER accepted (not bounced,
                  not merely undelivered). This returns the same offer version to Draft and clears
                  approval. Nothing is sent automatically.
                </div>
              )}
            </div>
          )}
          {stale && (
            <p role="alert" className="text-destructive" data-testid={`reconcile-stale-${wfId}`}>
              The offer changed since you started. Submission is disabled; discard and review the
              latest state.
            </p>
          )}
          {mode && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="h-auto whitespace-normal text-left"
                disabled={!canSubmit}
                onClick={submit}
                data-testid={`reconcile-submit-${wfId}`}
              >
                {m.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                {mode === "check" ? "Check evidence" : "Confirm settlement"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={m.isPending}
                onClick={() => {
                  reset();
                  onDone();
                }}
                data-testid={`reconcile-discard-${wfId}`}
              >
                {stale ? "Discard and refetch" : "Cancel"}
              </Button>
            </div>
          )}
        </>
      )}
      <ErrorLine message={error} testId={`reconcile-error-${wfId}`} />
    </div>
  );
}
