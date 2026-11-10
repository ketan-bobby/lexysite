import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsStageOwnershipQueryKey,
  getGetJobWorkflowStateQueryKey,
  useControlCandidateAtsStageOwnership,
  useGetCandidateAtsStageOwnership,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { errText } from "./workflow-shared";

const statusOf = (e: unknown): number | null =>
  typeof e === "object" && e !== null && "status" in e
    ? Number((e as { status: unknown }).status)
    : null;

export function WorkflowAtsStageOwnership({
  jobId,
  workflowId,
}: {
  jobId: string;
  workflowId: string;
}) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsStageOwnershipQueryKey(jobId, workflowId);
  const q = useGetCandidateAtsStageOwnership(jobId, workflowId, {
    query: { queryKey: key, retry: false, staleTime: 0, gcTime: 0, refetchInterval: 15000 },
  });
  const m = useControlCandidateAtsStageOwnership({ mutation: { retry: false, gcTime: 0 } });
  const resetRef = useRef(m.reset);
  resetRef.current = m.reset;
  const mounted = useRef(true);
  const lock = useRef(false);
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resetRef.current();
    };
  }, []);

  const s = q.isError ? undefined : q.data;
  useEffect(() => {
    if (q.isError) {
      setAck(false);
      setMsg(null);
      setError(null);
      if (seen.current !== null) setStale(true);
    }
  }, [q.isError]);
  const version = s
    ? `${s.ownershipRevision}|${s.workflowRevision}|${s.bindingRevision ?? ""}|${s.status}|${s.ownerWorkflowId ?? ""}`
    : null;
  useEffect(() => {
    if (version === null) return;
    if (seen.current !== null && seen.current !== version) {
      // Server state moved: keep typed reason, drop consent until explicitly re-reviewed.
      setAck(false);
      setStale(true);
      setMsg(null);
      setError(null);
    }
    seen.current = version;
  }, [version]);

  const trimmed = reason.trim();
  const reasonOk = trimmed.length >= 10 && trimmed.length <= 500;
  const busy = m.isPending;

  const send = (action: "claim" | "release") => {
    if (lock.current || !s || !reasonOk || !ack || stale) return;
    lock.current = true;
    setError(null);
    setMsg(null);
    m.mutate(
      {
        jobId,
        workflowId,
        data: {
          action,
          expectedWorkflowRevision: s.workflowRevision,
          expectedOwnershipRevision: s.ownershipRevision,
          expectedBindingRevision: s.bindingRevision ?? 0,
          idempotencyKey: crypto.randomUUID(),
          acknowledge: true,
          reason: trimmed,
        },
      },
      {
        onSuccess: (res) => {
          lock.current = false;
          if (!mounted.current) return;
          const latest = qc.getQueryData<typeof res>(key);
          const superseded =
            latest &&
            (latest.workflowRevision > res.workflowRevision ||
              latest.ownershipRevision > res.ownershipRevision ||
              (latest.bindingRevision ?? 0) > (res.bindingRevision ?? 0) ||
              (latest !== s &&
                latest.workflowRevision === res.workflowRevision &&
                (latest.status !== res.status ||
                  latest.ownerWorkflowId !== res.ownerWorkflowId ||
                  latest.canClaim !== res.canClaim ||
                  latest.canRelease !== res.canRelease)));
          if (superseded || qc.getQueryState(key)?.status === "error") {
            setAck(false);
            setMsg(null);
            setStale(true);
            qc.invalidateQueries({ queryKey: key });
            return;
          }
          seen.current = `${res.ownershipRevision}|${res.workflowRevision}|${res.bindingRevision ?? ""}|${res.status}|${res.ownerWorkflowId ?? ""}`;
          qc.setQueryData(key, res);
          qc.invalidateQueries({ queryKey: key });
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
          setReason("");
          setAck(false);
          setStale(false);
          setMsg(
            action === "claim"
              ? "Declared: stage authority is external. Native hiring-stage actions are frozen. No stage outcome, import, send or offer was performed."
              : "Released: native stage authority restored. Nothing was written to the ATS and the current stage is unchanged. Existing Lexy permissions and automation settings apply to future moves.",
          );
        },
        onError: (e) => {
          lock.current = false;
          if (!mounted.current) return;
          qc.invalidateQueries({ queryKey: key });
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
          setAck(false);
          if (statusOf(e) === 409) setStale(true);
          else setError(errText(e));
        },
      },
    );
  };

  const external = s?.status === "external";
  const sameOwner = external && s?.ownerWorkflowId === workflowId;

  return (
    <div
      className="space-y-1.5 border-t border-border pt-2"
      role="group"
      aria-label="Hiring-stage authority"
      data-testid={`ats-ownership-${workflowId}`}
    >
      <p className="font-medium">Hiring-stage authority</p>
      {q.isLoading && (
        <p role="status" className="text-muted-foreground">
          Loading stage authority
        </p>
      )}
      {q.isError && (
        <div role="alert" className="text-destructive">
          {[403, 404].includes(statusOf(q.error) ?? 0)
            ? "Stage authority is unavailable for this workflow."
            : "Could not load stage authority."}{" "}
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {s && (
        <>
          <p data-testid={`ats-ownership-status-${workflowId}`}>
            {external
              ? sameOwner
                ? "External: this workflow is declared as owning hiring-stage authority."
                : "External: another workflow is declared as owning hiring-stage authority."
              : "Native: Lexy staff manage hiring stages."}
            {s.declaredAt ? ` Declared ${new Date(s.declaredAt).toLocaleString()}.` : ""}
          </p>
          <p className="text-muted-foreground">
            This is an employer declaration saved in Lexy. It does not sync with or write to the
            ATS. While external, stage changes are blocked for every native actor, including manual
            moves and skip automation. Notes, evidence, read-only assessments and privacy erasure
            are not blocked.
          </p>
          {!s.canClaim && !s.canRelease && (
            <p className="text-muted-foreground">
              {external
                ? "Only an employer admin on the owning workflow can release this declaration."
                : "Declaring external stage authority needs an employer admin and an approved, currently mapped employer ATS connection for this workflow."}
            </p>
          )}
          {stale && (
            <div role="alert" className="space-y-1 text-destructive">
              <p>
                Stage authority changed since you started. Your reason is kept; review the latest
                state and confirm again.
              </p>
              <Button size="sm" variant="outline" onClick={() => setStale(false)}>
                Review latest
              </Button>
            </div>
          )}
          {(s.canClaim || s.canRelease) && (
            <div className="space-y-1">
              <label className="block">
                <span className="text-muted-foreground">Reason (10 to 500 characters)</span>
                <textarea
                  className="mt-0.5 w-full rounded-md border border-border bg-background p-1.5"
                  rows={2}
                  maxLength={500}
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                  data-testid={`ats-ownership-reason-${workflowId}`}
                />
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={ack}
                  disabled={busy}
                  onChange={(e) => setAck(e.target.checked)}
                  data-testid={`ats-ownership-ack-${workflowId}`}
                />
                <span>
                  {s.canClaim
                    ? "I understand staff will no longer be able to change hiring stages in Lexy for this job while the ATS is authoritative. No stage outcome, import, message or offer is performed."
                    : "I understand releasing writes nothing to the ATS and does not replay anything. The current stage stays unchanged, and later Lexy moves resume only with human confirmation."}
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                {s.canClaim && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!reasonOk || !ack || busy || stale}
                    onClick={() => send("claim")}
                    data-testid={`ats-ownership-claim-${workflowId}`}
                  >
                    Declare external stage authority
                  </Button>
                )}
                {s.canRelease && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!reasonOk || !ack || busy || stale}
                    onClick={() => send("release")}
                    data-testid={`ats-ownership-release-${workflowId}`}
                  >
                    Release to native authority
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}
      {s && busy && (
        <p role="status" className="flex items-center gap-1 text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving
        </p>
      )}
      {s && error && (
        <p
          role="alert"
          className="text-destructive"
          data-testid={`ats-ownership-error-${workflowId}`}
        >
          Update failed. {error}
        </p>
      )}
      {s && msg && <p role="status">{msg}</p>}
    </div>
  );
}
