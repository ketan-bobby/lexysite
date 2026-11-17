import { useEffect, useRef, useState } from "react";
import {
  resolveZohoStageExecution,
  type ZohoStageExecutionRequest,
  type ZohoStageResolutionInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

/** An explicit local administrative closure, never delivery attribution or retry consent. */
export function ZohoStageResolution({
  row,
  campaignId,
  recipientId,
  sourceRevision,
  locked,
  refresh,
}: {
  row: ZohoStageExecutionRequest;
  campaignId: string;
  recipientId: string;
  sourceRevision: string;
  locked: boolean;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [noRetry, setNoRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const commands = useRef(new Map<string, string>());
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const r = row.resolution;
  const closed = r?.review?.action === "approve";
  const canAct = row.canProposeResolution || row.canReviewResolution;
  const valid =
    reason.trim().length >= 20 &&
    reason.trim().length <= 1000 &&
    evidence.trim().length >= 10 &&
    evidence.trim().length <= 200 &&
    unknown &&
    noRetry &&
    !locked &&
    !busy;

  // The parent keys this form by exact actor/source/sequence/capabilities.
  // Its lifetime token suppresses completion messages from a previous scope.
  const lifetime = useRef(Symbol());
  const token = lifetime.current;
  async function act(action: ZohoStageResolutionInput["action"]) {
    if (!valid || (action === "propose" ? !row.canProposeResolution : !row.canReviewResolution))
      return;
    const key = JSON.stringify([action, reason.trim(), evidence.trim()]);
    let commandId = commands.current.get(key);
    if (!commandId) {
      commandId = crypto.randomUUID();
      commands.current.set(key, commandId);
    }
    setBusy(true);
    setError("");
    try {
      await resolveZohoStageExecution(campaignId, recipientId, row.id, {
        action,
        commandId,
        expectedRevision: row.revision,
        expectedSourceRevision: sourceRevision,
        expectedSequence: row.sequence,
        reason: reason.trim(),
        evidenceReference: evidence.trim(),
        confirm: true,
        acknowledgeUnknown: true,
        acknowledgeNoRetry: true,
      });
      if (active.current && lifetime.current === token) {
        commands.current.delete(key);
        setOpen(false);
      }
    } catch {
      if (active.current && lifetime.current === token)
        setError(
          "The result could not be confirmed. Check refreshed history before acting again. Nothing was resent. An unchanged manual retry uses the same command ID.",
        );
    } finally {
      if (active.current && lifetime.current === token) {
        setBusy(false);
        setUnknown(false);
        setNoRetry(false);
        await refresh();
      }
    }
  }

  if (!canAct && !r) return null;
  return (
    <div
      className="space-y-2 rounded border border-amber-600/40 p-3 text-xs"
      data-testid={`stage-resolution-${row.id}`}
    >
      <p className="font-semibold">
        {closed
          ? "Closed after independent review — delivery remains unknown"
          : r && !r.review
            ? "Closure proposed — hold remains"
            : r?.review?.action === "reject"
              ? "Closure rejected — hold remains"
              : "Review uncertain attempt"}
      </p>
      <p>
        Closing is a local administrative decision, not proof of delivery or permission to resend.
        Any later stage change needs fresh evidence, approval and a separate deliberate execution.
      </p>
      {r && (
        <dl className="space-y-1 [overflow-wrap:anywhere]">
          <div>
            <dt className="inline font-medium">Proposed by: </dt>
            <dd className="inline">{r.proposedBy}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Proposal reason: </dt>
            <dd className="inline">{r.reason}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Evidence reference: </dt>
            <dd className="inline">{r.evidenceReference}</dd>
          </div>
          <div>
            <dt className="inline font-medium">Read-only observation: </dt>
            <dd className="inline">{r.observedStatus}</dd>
          </div>
          {r.review && (
            <>
              <div>
                <dt className="inline font-medium">Reviewed by: </dt>
                <dd className="inline">{r.review.by}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Review reason: </dt>
                <dd className="inline">{r.review.reason}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Review evidence: </dt>
                <dd className="inline">{r.review.evidenceReference}</dd>
              </div>
            </>
          )}
        </dl>
      )}
      {canAct && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={locked || busy}
          data-testid={`open-resolution-${row.id}`}
          onClick={() => setOpen(!open)}
        >
          {open
            ? "Cancel review"
            : row.canReviewResolution
              ? "Independently review closure"
              : "Propose local closure"}
        </Button>
      )}
      {open && canAct && (
        <div className="space-y-2">
          <p>
            Each action checks Zoho read-only. A different authorized administrator must review a
            proposal within 15 minutes. Include reference IDs only—no credentials or private
            document contents.
          </p>
          <label className="block">
            Reason (20–1000 characters)
            <textarea
              className="mt-1 block w-full rounded border bg-background p-2"
              maxLength={1000}
              disabled={busy || locked}
              value={reason}
              data-testid={`resolution-reason-${row.id}`}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="block">
            Evidence reference (10–200 characters)
            <input
              className="mt-1 block w-full rounded border bg-background p-2"
              maxLength={200}
              disabled={busy || locked}
              value={evidence}
              data-testid={`resolution-evidence-${row.id}`}
              onChange={(e) => setEvidence(e.target.value)}
            />
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={unknown}
              disabled={busy || locked}
              data-testid={`resolution-unknown-${row.id}`}
              onChange={(e) => setUnknown(e.target.checked)}
            />
            Delivery attribution remains unknown. An observed status does not prove Lexy delivered
            it.
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={noRetry}
              disabled={busy || locked}
              data-testid={`resolution-no-retry-${row.id}`}
              onChange={(e) => setNoRetry(e.target.checked)}
            />
            This does not resend or reuse an old approval. Future changes need fresh evidence and
            approval.
          </label>
          <div className="flex flex-wrap gap-2">
            {row.canReviewResolution ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={!valid}
                  data-testid={`approve-resolution-${row.id}`}
                  onClick={() => void act("approve")}
                >
                  Approve local closure (no send)
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!valid}
                  data-testid={`reject-resolution-${row.id}`}
                  onClick={() => void act("reject")}
                >
                  Reject closure and keep hold
                </Button>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={!valid}
                data-testid={`propose-resolution-${row.id}`}
                onClick={() => void act("propose")}
              >
                Save proposal (hold remains)
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
