import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsCampaignQueryKey,
  getGetCandidateAtsCampaignsQueryKey,
  getGetCandidateAtsInterviewInvitationQueryKey,
  getGetCandidateAtsInterviewQueryKey,
  useControlCandidateAtsCampaign,
  useDispatchCandidateAtsCampaignMember,
  useGetCandidateAtsCampaign,
  type AtsCampaignDetail,
} from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { errText } from "./workflow-shared";
import { WorkflowAtsInvitationEvidence } from "./WorkflowAtsInvitationEvidence";
import {
  CampaignStatusBadge,
  MEMBER_NOTE,
  MemberBadge,
  isRetryableBlocked,
  isRunnable,
  type RunItem,
} from "./ats-campaign-shared";

type Props = { jobId: string; workflowId: string; campaignId: string };

export function WorkflowAtsCampaignDetail(p: Props) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsCampaignQueryKey(p.jobId, p.workflowId, p.campaignId);
  const indexKey = getGetCandidateAtsCampaignsQueryKey(p.jobId, p.workflowId);
  const q = useGetCandidateAtsCampaign(p.jobId, p.workflowId, p.campaignId, {
    query: { queryKey: key, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" },
  });
  const control = useControlCandidateAtsCampaign({ mutation: { retry: false, gcTime: 0 } });
  const dispatch = useDispatchCandidateAtsCampaignMember({ mutation: { retry: false, gcTime: 0 } });
  const dispatchRef = useRef(dispatch.mutateAsync);
  dispatchRef.current = dispatch.mutateAsync;

  const [evidenceHeld, setEvidenceHeld] = useState(false);
  const fresh: AtsCampaignDetail | undefined =
    !evidenceHeld && q.isSuccess && !q.isFetching && !q.isError && !q.failureReason
      ? q.data
      : undefined;

  const [approveAck, setApproveAck] = useState<string | null>(null);
  const [cancelAck, setCancelAck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<RunItem[] | null>(null);
  const [singleId, setSingleId] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const stopRef = useRef(false);
  const lockRef = useRef(false);
  const latestRef = useRef<AtsCampaignDetail | null>(null);
  const reviewHash = fresh?.reviewHash ?? null;
  const scope = `${p.jobId}|${p.workflowId}|${p.campaignId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      stopRef.current = true;
    };
  }, []);

  useEffect(() => {
    stopRef.current = true;
    lockRef.current = false;
    latestRef.current = null;
    setRunning(false);
    setStopping(false);
    setProgress(null);
    setError(null);
    setSingleId(null);
    setEvidenceHeld(false);
  }, [scope]);

  useEffect(() => {
    setApproveAck(null);
    setCancelAck(null);
  }, [scope, reviewHash]);

  const touchRecord = (recordId: string | null) => {
    if (!recordId) return;
    void qc.invalidateQueries({
      queryKey: getGetCandidateAtsInterviewInvitationQueryKey(p.jobId, p.workflowId, recordId),
    });
    void qc.invalidateQueries({
      queryKey: getGetCandidateAtsInterviewQueryKey(p.jobId, p.workflowId, recordId),
    });
  };

  const busy = running || !!singleId || control.isPending;

  const doControl = (action: "approve" | "cancel") => {
    if (!fresh) return;
    if (action === "cancel") stopRef.current = true;
    setError(null);
    control.mutate(
      { ...p, data: { action, reviewHash: fresh.reviewHash, acknowledge: true } },
      {
        onSuccess: (d) => {
          latestRef.current = d;
          qc.setQueryData(key, d);
          void qc.invalidateQueries({ queryKey: indexKey });
          void qc.invalidateQueries({ queryKey: key });
        },
        onError: (e) => {
          setError(errText(e));
          void qc.invalidateQueries({ queryKey: indexKey });
          void qc.invalidateQueries({ queryKey: key });
        },
        onSettled: () => {
          setApproveAck(null);
          setCancelAck(null);
        },
      },
    );
  };

  const runBatch = async () => {
    if (!fresh || fresh.status !== "approved" || lockRef.current || control.isPending) return;
    lockRef.current = true;
    stopRef.current = false;
    const startScope = scope;
    const live = () => aliveRef.current && scopeRef.current === startScope;
    let latest: AtsCampaignDetail = fresh;
    latestRef.current = latest;
    const attempted = new Set<string>();
    const items: RunItem[] = [];
    setRunning(true);
    setStopping(false);
    setError(null);
    setProgress([]);
    try {
      for (;;) {
        if (stopRef.current || !live() || latest.status !== "approved") break;
        const next = latest.members.find((m) => isRunnable(m) && !attempted.has(m.id));
        if (!next) break;
        attempted.add(next.id);
        const label = next.recipient ?? `Member ${next.id}`;
        try {
          const res = await dispatchRef.current({
            ...p,
            memberId: next.id,
            data: { reviewHash: latest.reviewHash, acknowledge: true },
          });
          if (!live()) break;
          latest = res;
          latestRef.current = res;
          qc.setQueryData(key, res);
          const after = res.members.find((m) => m.id === next.id);
          items.push({
            memberId: next.id,
            label,
            state:
              after && after.invitationStatus !== "ready" && after.invitationStatus !== "blocked"
                ? "sent"
                : "failed",
            message: after?.reason ?? undefined,
          });
          setProgress([...items]);
          touchRecord(next.recordId);
        } catch (e) {
          if (!live()) break;
          items.push({ memberId: next.id, label, state: "failed", message: errText(e) });
          setProgress([...items]);
          setError(
            `Run stopped after a failed send. ${errText(e)} Nothing is retried automatically.`,
          );
          touchRecord(next.recordId);
          break;
        }
      }
    } finally {
      if (live()) {
        const remaining = latest.members.filter((m) => isRunnable(m) && !attempted.has(m.id));
        if (remaining.length && items.length) {
          setProgress([
            ...items,
            ...remaining.map((m) => ({
              memberId: m.id,
              label: m.recipient ?? m.id,
              state: "stopped" as const,
            })),
          ]);
        }
        lockRef.current = false;
        setRunning(false);
        setStopping(false);
        void qc.invalidateQueries({ queryKey: key });
      }
    }
  };

  const retryOne = (memberId: string, recordId: string | null) => {
    if (!fresh || busy) return;
    const startScope = scope;
    setSingleId(memberId);
    setError(null);
    dispatch.mutate(
      { ...p, memberId, data: { reviewHash: fresh.reviewHash, acknowledge: true } },
      {
        onSuccess: (d) => {
          if (scopeRef.current !== startScope) return;
          qc.setQueryData(key, d);
          void qc.invalidateQueries({ queryKey: key });
        },
        onError: (e) => {
          if (scopeRef.current === startScope) setError(errText(e));
          void qc.invalidateQueries({ queryKey: key });
        },
        onSettled: () => {
          if (scopeRef.current === startScope) setSingleId(null);
          touchRecord(recordId);
        },
      },
    );
  };

  const counts = fresh
    ? {
        ready: fresh.members.filter(isRunnable).length,
        accepted: fresh.members.filter((m) => m.invitationStatus === "provider_accepted").length,
        prior: fresh.members.filter((m) => m.invitationStatus === "previously_sent").length,
        held: fresh.members.filter(
          (m) => m.invitationStatus === "review_required" || m.invitationStatus === "simulated",
        ).length,
        blocked: fresh.members.filter((m) => m.invitationStatus === "blocked").length,
      }
    : null;
  // Never expose historical run labels after a fresh privacy/source rejection.
  const visibleProgress = fresh
    ? progress?.filter((x) =>
        fresh.members.some((m) => m.id === x.memberId && m.recipient === x.label),
      )
    : null;

  return (
    <section
      className="space-y-3 rounded-xl border border-border bg-panel p-3"
      aria-label="Campaign review"
      data-testid={`ats-campaign-detail-${p.campaignId}`}
    >
      {(q.isFetching || q.isLoading) && (
        <div role="status" className="space-y-2" aria-label="Loading campaign">
          <div className="h-4 w-1/3 rounded skeleton-shimmer" />
          <div className="h-16 rounded skeleton-shimmer" />
          {running && (
            <p className="text-xs text-muted-foreground">
              Refreshing campaign while the run continues.
            </p>
          )}
        </div>
      )}
      {!q.isFetching && (q.isError || q.failureReason) && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {errText(q.error ?? q.failureReason)}
          <Button
            size="sm"
            variant="outline"
            onClick={() => q.refetch()}
            data-testid="ats-campaign-detail-retry"
          >
            Retry loading
          </Button>
        </div>
      )}
      {evidenceHeld && (
        <div role="alert">
          Evidence verification failed. Cached campaign details are hidden until a fresh successful
          review.
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void q.refetch().then((result) => {
                if (result.isSuccess && !result.isFetching && !result.failureReason)
                  setEvidenceHeld(false);
              })
            }
          >
            Retry current campaign review
          </Button>
        </div>
      )}

      {fresh && counts && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CampaignStatusBadge status={fresh.status} />
              <span className="text-xs text-muted-foreground">
                Plan {fresh.planId} · review {fresh.reviewHash.slice(0, 10)}
              </span>
            </div>
            <dl
              className="flex flex-wrap gap-x-3 gap-y-1 text-xs"
              data-testid="ats-campaign-counts"
            >
              <div>
                <dt className="inline text-muted-foreground">Ready </dt>
                <dd className="inline font-semibold tabular-nums">{counts.ready}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">
                  Provider accepted, inbox unverified{" "}
                </dt>
                <dd className="inline font-semibold tabular-nums">{counts.accepted}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Previously sent </dt>
                <dd className="inline font-semibold tabular-nums">{counts.prior}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Held </dt>
                <dd className="inline font-semibold tabular-nums">{counts.held}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">Blocked </dt>
                <dd className="inline font-semibold tabular-nums">{counts.blocked}</dd>
              </div>
            </dl>
          </div>

          {fresh.status === "needs_review" && (
            <p role="status" className="text-sm text-signal-amber">
              This approval snapshot is no longer valid. No further sends are permitted. Prepare a
              new batch from currently eligible, unsent applicants; this batch cannot be reapproved.
            </p>
          )}

          <ol className="space-y-2">
            {fresh.members.map((m, i) => (
              <li
                key={m.id}
                className="run-row-in rounded-lg border border-border bg-card p-3 text-sm"
                data-testid={`ats-campaign-member-${m.id}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium [overflow-wrap:anywhere]">
                    <span className="mr-2 text-xs tabular-nums text-muted-foreground">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    {m.recipient ?? "No recipient available"}
                  </p>
                  <div className="flex items-center gap-2">
                    {m.interviewStatus && (
                      <span className="text-xs text-muted-foreground">
                        Interview {m.interviewStatus.replace(/_/g, " ")}
                      </span>
                    )}
                    <MemberBadge status={m.invitationStatus} />
                  </div>
                </div>
                {m.subject && (
                  <p className="mt-1.5">
                    <span className="text-muted-foreground">Subject </span>
                    {m.subject}
                  </p>
                )}
                {m.text && (
                  <details className="mt-1.5">
                    <summary className="text-xs text-primary">Exact message text</summary>
                    <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-panel p-2.5 font-sans text-sm">
                      {m.text}
                    </pre>
                  </details>
                )}
                {(m.reason || MEMBER_NOTE[m.invitationStatus]) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {m.reason ?? MEMBER_NOTE[m.invitationStatus]}
                  </p>
                )}
                {isRetryableBlocked(m) && fresh.status === "approved" && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => retryOne(m.id, m.recordId)}
                    data-testid={`ats-campaign-retry-${m.id}`}
                  >
                    {singleId === m.id
                      ? "Sending to this recipient…"
                      : "Send to this one recipient"}
                  </Button>
                )}
                {m.recordId &&
                  !["ready", "blocked", "unavailable"].includes(m.invitationStatus) && (
                    <WorkflowAtsInvitationEvidence
                      jobId={p.jobId}
                      workflowId={p.workflowId}
                      recordId={m.recordId}
                      disabled={busy}
                      onFault={() => {
                        stopRef.current = true;
                        setEvidenceHeld(true);
                      }}
                    />
                  )}
              </li>
            ))}
          </ol>

          {fresh.canApprove && fresh.status === "review" && (
            <div className="space-y-2 rounded-lg border border-primary/30 bg-accent-soft/20 p-3">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={approveAck === fresh.reviewHash}
                  disabled={busy}
                  onChange={(e) => setApproveAck(e.target.checked ? fresh.reviewHash : null)}
                  data-testid="ats-campaign-approve-ack"
                />
                I reviewed every recipient, subject and message above and authorize exactly these{" "}
                {fresh.members.length} messages. Approval sends nothing.
              </label>
              <Button
                size="sm"
                disabled={busy || approveAck !== fresh.reviewHash}
                onClick={() => doControl("approve")}
                data-testid="ats-campaign-approve"
              >
                {control.isPending && control.variables?.data.action === "approve"
                  ? "Approving…"
                  : "Approve batch"}
              </Button>
            </div>
          )}

          {fresh.status === "approved" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={busy || counts.ready === 0}
                onClick={() => void runBatch()}
                data-testid="ats-campaign-run"
              >
                {running ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Sending sequentially
                  </>
                ) : (
                  `Run approved batch (${counts.ready} ready)`
                )}
              </Button>
              {running && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={stopping}
                  onClick={() => {
                    stopRef.current = true;
                    setStopping(true);
                  }}
                  data-testid="ats-campaign-stop"
                >
                  {stopping ? "Stopping after current" : "Stop after current"}
                </Button>
              )}
              <span className="text-xs text-muted-foreground">
                Blocked rows are never included; use their single-recipient button.
              </span>
            </div>
          )}

          {fresh.canCancel && (
            <div className="space-y-2 border-t border-border pt-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={cancelAck === fresh.reviewHash}
                  disabled={control.isPending}
                  onChange={(e) => setCancelAck(e.target.checked ? fresh.reviewHash : null)}
                  data-testid="ats-campaign-cancel-ack"
                />
                Cancel all remaining sends. Already accepted or in-flight messages cannot be
                recalled.
              </label>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={control.isPending || cancelAck !== fresh.reviewHash}
                onClick={() => doControl("cancel")}
                data-testid="ats-campaign-cancel"
              >
                {control.isPending && control.variables?.data.action === "cancel"
                  ? "Cancelling…"
                  : "Cancel remaining"}
              </Button>
            </div>
          )}
        </>
      )}

      {visibleProgress && visibleProgress.length > 0 && (
        <div aria-live="polite" className="space-y-1 text-sm" data-testid="ats-campaign-progress">
          <p role="status" className="font-medium">
            {running ? "Run in progress" : "Last run"}:{" "}
            {visibleProgress.filter((x) => x.state === "sent").length} processed ·{" "}
            {visibleProgress.filter((x) => x.state === "failed").length} failed ·{" "}
            {visibleProgress.filter((x) => x.state === "stopped").length} not started
          </p>
          <ul className="space-y-0.5">
            {visibleProgress.map((x) => (
              <li
                key={x.memberId}
                className={`[overflow-wrap:anywhere] ${x.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {x.label} ·{" "}
                {x.state === "sent"
                  ? "processed — check receipt above"
                  : x.state === "failed"
                    ? "failed"
                    : "not started"}
                {x.message ? ` · ${x.message}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
