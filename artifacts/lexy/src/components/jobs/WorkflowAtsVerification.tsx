import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsHandoffQueryKey,
  getGetCandidateAtsVerificationQueryKey,
  getGetCandidateOfferRoutingQueryKey,
  getGetCandidateWorkflowOfferQueryKey,
  getGetJobWorkflowStateQueryKey,
  useControlCandidateAtsVerification,
  useGetCandidateAtsVerification,
  type AtsVerificationInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { errText } from "./workflow-shared";
import { WorkflowAtsPreview } from "./WorkflowAtsPreview";

export function WorkflowAtsVerification({
  jobId,
  workflowId,
  mappedAccountRef,
}: {
  jobId: string;
  workflowId: string;
  mappedAccountRef: string | null;
}) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsVerificationQueryKey(jobId, workflowId);
  const q = useGetCandidateAtsVerification(jobId, workflowId, {
    query: { queryKey: key, refetchInterval: 8000, refetchOnMount: "always" },
  });
  const m = useControlCandidateAtsVerification({});
  const st = q.data;
  const [connectionId, setConnectionId] = useState("");
  const [ackAllocate, setAckAllocate] = useState(false);
  const [ackConfirm, setAckConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: getGetCandidateAtsHandoffQueryKey(jobId, workflowId) });
    qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
    qc.invalidateQueries({ queryKey: getGetCandidateOfferRoutingQueryKey(jobId, workflowId) });
    qc.invalidateQueries({ queryKey: getGetCandidateWorkflowOfferQueryKey(jobId, workflowId) });
  };

  if (q.isLoading)
    return (
      <div
        className="h-10 animate-pulse rounded-md bg-muted"
        data-testid={`ats-verification-loading-${workflowId}`}
      />
    );
  if (q.isError || !st)
    return (
      <div className="space-y-1 text-sm" data-testid={`ats-verification-error-${workflowId}`}>
        <p role="alert" className="text-destructive">
          Could not load Greenhouse verification. {errText(q.error)}
        </p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    );

  const busy = m.isPending;
  const b = st.binding;
  const run = (
    extra: Partial<AtsVerificationInput> & Pick<AtsVerificationInput, "action">,
    done: string,
  ) => {
    setError(null);
    setNotice(null);
    m.mutate(
      {
        jobId,
        workflowId,
        data: {
          expectedBindingRevision: st.bindingRevision,
          expectedWorkflowRevision: st.workflowRevision,
          ...extra,
        },
      },
      {
        onSuccess: () => {
          setNotice(done);
          setAckAllocate(false);
          setAckConfirm(false);
          refresh();
        },
        onError: (e) => {
          setError(errText(e));
          refresh();
        },
      },
    );
  };

  const canDoAllocate =
    st.canAllocate &&
    !!connectionId &&
    st.choices.some((c) => c.id === connectionId) &&
    !!mappedAccountRef &&
    ackAllocate &&
    !busy;
  const statusLabel: Record<string, string> = {
    not_connected: "No Greenhouse connection available",
    available: "Connection available, not allocated",
    unavailable: "Connection unavailable",
    allocated: "Connection allocated",
  };

  return (
    <div
      className="space-y-2 rounded-md border border-border p-2 text-xs"
      role="group"
      aria-label="Greenhouse verification"
      data-testid={`ats-verification-${workflowId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Greenhouse verification</p>
        <Badge variant="outline">{statusLabel[st.connectorStatus] ?? st.connectorStatus}</Badge>
        {b && <Badge variant="outline">Binding: {b.status.replace(/_/g, " ")}</Badge>}
      </div>
      <p className="text-muted-foreground">
        A platform admin must first configure an employer-owned direct Greenhouse connection or
        connect the managed Greenhouse connector, then allocate it and obtain separate employer
        confirmation. This panel verifies reads; reviewed imports and refresh controls are separate.
        It does not write to Greenhouse or automate offers. Disconnecting here only stops Lexy using
        the binding; it does not revoke credentials at Greenhouse. An active binding means the
        employer authorized this local allocation, not that remote reads have passed.
      </p>

      {b ? (
        <p
          className="[overflow-wrap:anywhere]"
          data-testid={`ats-verification-binding-${workflowId}`}
        >
          Account {b.accountRef} · revision {b.revision} · updated{" "}
          {new Date(b.updatedAt).toLocaleString()}.
        </p>
      ) : (
        <p className="text-muted-foreground">No account allocated to this workflow.</p>
      )}

      {st.canAllocate && (!b || b.status === "disconnected") && (
        <div className="space-y-1.5">
          {st.choices.length === 0 ? (
            <p className="text-muted-foreground">
              No connector choices are available. A platform admin must connect the project
              Greenhouse connector first.
            </p>
          ) : (
            <label className="block space-y-0.5">
              <span>Connector</span>
              <select
                className="w-full rounded-md border border-border bg-background p-2 text-sm"
                value={connectionId}
                disabled={busy}
                onChange={(e) => setConnectionId(e.target.value)}
                data-testid={`ats-verification-connection-${workflowId}`}
              >
                <option value="">Select a connection</option>
                {st.choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!mappedAccountRef && (
            <p className="text-destructive">Save an ATS account mapping above before allocating.</p>
          )}
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={ackAllocate}
              disabled={busy}
              onChange={(e) => setAckAllocate(e.target.checked)}
              data-testid={`ats-verification-ack-allocate-${workflowId}`}
            />
            <span>
              I acknowledge this Greenhouse account
              {mappedAccountRef ? ` (${mappedAccountRef})` : ""} is owned by the employer.
            </span>
          </label>
          <Button
            size="sm"
            disabled={!canDoAllocate}
            onClick={() =>
              run(
                {
                  action: "allocate",
                  connectionId,
                  accountRef: mappedAccountRef ?? undefined,
                  acknowledgeEmployerOwnership: true,
                },
                "Allocated. The employer must now confirm.",
              )
            }
            data-testid={`ats-verification-allocate-${workflowId}`}
          >
            {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            Allocate connector
          </Button>
        </div>
      )}

      {b?.status === "pending_employer" && st.canConfirm && (
        <div className="space-y-1.5">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={ackConfirm}
              disabled={busy}
              onChange={(e) => setAckConfirm(e.target.checked)}
              data-testid={`ats-verification-ack-confirm-${workflowId}`}
            />
            <span>I confirm this Greenhouse account belongs to my organization.</span>
          </label>
          <Button
            size="sm"
            disabled={!ackConfirm || busy}
            onClick={() =>
              run(
                { action: "confirm", acknowledgeEmployerOwnership: true },
                "Employer confirmed. Binding is active.",
              )
            }
            data-testid={`ats-verification-confirm-${workflowId}`}
          >
            Confirm ownership
          </Button>
        </div>
      )}
      {b?.status === "pending_employer" && !st.canConfirm && (
        <p className="text-muted-foreground">Waiting for an employer admin to confirm.</p>
      )}

      <div className="flex flex-wrap gap-2">
        {b?.status === "active" && (
          <Button
            size="sm"
            variant="outline"
            disabled={!st.canVerify || busy}
            onClick={() =>
              run(
                { action: "verify", idempotencyKey: crypto.randomUUID() },
                "Verification requested.",
              )
            }
            data-testid={`ats-verification-verify-${workflowId}`}
          >
            Run verification
          </Button>
        )}
        {b && b.status !== "disconnected" && st.canDisconnect && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => run({ action: "disconnect" }, "Disconnected locally.")}
            data-testid={`ats-verification-disconnect-${workflowId}`}
          >
            Disconnect locally
          </Button>
        )}
      </div>
      {b?.status === "active" && !st.canVerify && (
        <p className="text-muted-foreground">
          Verification needs an employer admin or designated owner, an active binding and a saved
          Greenhouse mapping.
        </p>
      )}

      <div>
        <p className="font-medium">Verification history (dated evidence only)</p>
        {st.history.length === 0 ? (
          <p className="text-muted-foreground">No verification receipts yet.</p>
        ) : (
          <ul className="space-y-0.5" data-testid={`ats-verification-history-${workflowId}`}>
            {st.history.map((r) => (
              <li key={r.id} className="[overflow-wrap:anywhere]">
                {r.status} · {new Date(r.checkedAt).toLocaleString()} · binding revision{" "}
                {r.bindingRevision} ·{" "}
                {r.currentMapping ? "matches current mapping" : "not the current mapping"}
                <span className="block text-muted-foreground [overflow-wrap:anywhere]">
                  Account {r.accountRef} · Job {r.externalJobId} · Candidate {r.externalCandidateId}{" "}
                  · Application {r.externalApplicationId}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground">
          Receipts show what was checked at that time, not current live health.
        </p>
      </div>

      {st.canVerify && (
        <WorkflowAtsPreview
          key={`${workflowId}:${st.bindingRevision}:${st.workflowRevision}`}
          jobId={jobId}
          workflowId={workflowId}
          bindingRevision={st.bindingRevision}
          workflowRevision={st.workflowRevision}
        />
      )}

      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="space-y-1 text-sm text-destructive"
          data-testid={`ats-verification-action-error-${workflowId}`}
        >
          <p>{error}</p>
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Retry loading state
          </Button>
        </div>
      )}
    </div>
  );
}
