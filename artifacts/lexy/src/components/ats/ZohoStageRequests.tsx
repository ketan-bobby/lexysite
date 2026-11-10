import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  actOnZohoStageRequest,
  getGetZohoStageRequestsQueryKey,
  getZohoStageRequests,
  prepareZohoStageRequest,
} from "@workspace/api-client-react";
import type {
  ZohoStageRequest,
  ZohoStageRequestWorkspace as Workspace,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";

type Action = "approve" | "withdraw" | "recover";
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
const DECISIONS: Record<string, string> = {
  advance: "Advance to next-round review",
  hold: "Hold",
  decline: "Do not advance",
};
const STATES: Record<ZohoStageRequest["state"], { label: string; detail: string }> = {
  prepared: {
    label: "Prepared in Lexy",
    detail: "Saved locally after a read-only Zoho check. Awaiting human approval.",
  },
  approved: {
    label: "Approved in Lexy, not sent",
    detail: "Local approval only. Nothing was dispatched to Zoho.",
  },
  withdrawn: { label: "Withdrawn", detail: "Withdrawn in Lexy. Nothing was sent to Zoho." },
  claimed: {
    label: "Write claimed, outcome unknown",
    detail: "A write attempt was claimed but its result is uncertain. Recovery check available.",
  },
  provider_accepted: {
    label: "Accepted by Zoho, unverified",
    detail: "Zoho accepted a request. The resulting stage has not been verified.",
  },
  verified: { label: "Verified in Zoho", detail: "The target status was verified in Zoho." },
  not_sent: { label: "Not sent", detail: "Confirmed that nothing reached Zoho." },
  review_required: {
    label: "Human review required",
    detail: "The outcome could not be determined. Check Zoho directly before acting.",
  },
  observed_target: {
    label: "Target status observed, not verified delivery",
    detail:
      "A read-only check saw the target status in Zoho. This does not prove Lexy's request caused it.",
  },
  observed_other: {
    label: "Different status observed",
    detail: "A read-only check saw a status other than the target in Zoho.",
  },
};
const BLOCKERS: Record<Workspace["blocker"], string> = {
  employer_connection_required: "Employer Zoho connection required",
  current_decision_and_mapping_required: "Current decision and mapping required",
  employer_write_consent_required: "Employer write consent required",
  application_transition_contract_required: "Application transition contract not verified",
};
const ACK: Record<Action, string> = {
  approve:
    "I approve this request in Lexy only. I understand approval is saved locally, nothing is sent to Zoho, and the candidate is not contacted.",
  withdraw: "Withdraw this request in Lexy. Nothing is sent to Zoho.",
  recover:
    "Run a read-only Zoho check of this uncertain write. It changes nothing. An observed target status is not verified delivery.",
};

function errorText(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    const data = cause.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) return data.error;
    return `${fallback} (HTTP ${cause.status}).`;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
function isWorkspace(v: unknown, c: string, r: string): v is Workspace {
  const w = v as Workspace | null;
  return (
    !!w &&
    w.campaignId === c &&
    w.recipientId === r &&
    typeof w.handoffRevision === "string" &&
    w.liveEnabled === false &&
    w.transitionVerified === false &&
    Array.isArray(w.requests)
  );
}

/** Prepares, approves, withdraws and recovers local Zoho stage requests. Never dispatches a live write. */
export function ZohoStageRequests({
  campaignId,
  recipientId,
  reviewRevision,
}: {
  campaignId: string;
  recipientId: string;
  reviewRevision: string;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const isAdmin = user?.role === "tenant_admin";
  const scope = `${user?.id}:${user?.tenantId}:${user?.role}:${campaignId}:${recipientId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const [prepAck, setPrepAck] = useState(false);
  const [rowAck, setRowAck] = useState<{ id: string; action: Action; revision: string } | null>(
    null,
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const prepRef = useRef<{ key: string; id: string } | null>(null);

  const key = [...getGetZohoStageRequestsQueryKey(campaignId, recipientId), scope];
  const q = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const body = await getZohoStageRequests(campaignId, recipientId, {
        signal,
        cache: "no-store",
      });
      if (!isWorkspace(body, campaignId, recipientId))
        throw new Error("Stage requests returned an unexpected response.");
      return body;
    },
    enabled: !!user && isAdmin,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => (query.state.error ? false : 30_000),
  });
  const failed = q.isError || !!q.failureReason;
  const w = failed ? undefined : q.data;

  const reset = () => {
    setPrepAck(false);
    setRowAck(null);
  };

  useEffect(() => {
    reset();
    setBusy("");
    setError("");
    setNotice("");
    prepRef.current = null;
  }, [scope]);

  const firstRev = useRef(true);
  useEffect(() => {
    if (firstRev.current) {
      firstRev.current = false;
      return;
    }
    reset();
    prepRef.current = null;
    void qc.invalidateQueries({ queryKey: key });
  }, [reviewRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Source changed: drop acknowledgments and the retry request ID.
  const seen = useRef<string | null>(null);
  const handoffRevision = w?.handoffRevision;
  useEffect(() => {
    if (handoffRevision && seen.current && seen.current !== handoffRevision) {
      reset();
      prepRef.current = null;
    }
    seen.current = handoffRevision ?? null;
  }, [handoffRevision]);

  // Row revision changed under an acknowledgment: require it again.
  const ackRow = rowAck && w?.requests.find((r) => r.id === rowAck.id);
  useEffect(() => {
    if (rowAck && (!ackRow || ackRow.revision !== rowAck.revision)) setRowAck(null);
  }, [ackRow?.revision, rowAck?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = !!busy || q.isFetching || failed;

  async function refresh(started: string) {
    if (scopeRef.current === started) await qc.invalidateQueries({ queryKey: key });
  }

  async function prepare() {
    if (!w || !isAdmin || !w.canPrepare || !prepAck || locked) return;
    const started = scope;
    const revision = w.handoffRevision;
    const k = `${scope}:${revision}:${reviewRevision}`;
    if (prepRef.current?.key !== k) prepRef.current = { key: k, id: crypto.randomUUID() };
    setBusy("prepare");
    setError("");
    setNotice("");
    try {
      await prepareZohoStageRequest(campaignId, recipientId, {
        expectedRevision: revision,
        requestId: prepRef.current.id,
        confirm: true,
      });
      if (scopeRef.current !== started) return;
      prepRef.current = null;
      setNotice(
        "Request prepared and saved in Lexy after a read-only Zoho check. Zoho was not changed. It still needs human approval, and approval will not send it.",
      );
    } catch (cause) {
      if (scopeRef.current !== started) return;
      if (cause instanceof ApiError && cause.status === 409) {
        prepRef.current = null;
        setError(
          "The request outcome needs review. Reload history; the decision, mapping, connection or provider access may have changed.",
        );
      } else
        setError(
          errorText(
            cause,
            "The result could not be confirmed. Refresh history before retrying; the same request ID will be reused",
          ),
        );
    } finally {
      if (scopeRef.current === started) {
        setBusy("");
        setPrepAck(false);
        await refresh(started);
      }
    }
  }

  async function act(row: ZohoStageRequest, action: Action) {
    if (!isAdmin || locked || (row.stale && action === "approve")) return;
    if (
      (action === "approve" && !row.canApprove) ||
      (action === "withdraw" && !row.canWithdraw) ||
      (action === "recover" && !row.canRecover)
    )
      return;
    if (!rowAck || rowAck.id !== row.id || rowAck.action !== action) return;
    if (rowAck.revision !== row.revision) return;
    const started = scope;
    setBusy(`${action}:${row.id}`);
    setError("");
    setNotice("");
    try {
      await actOnZohoStageRequest(campaignId, recipientId, row.id, {
        expectedRevision: row.revision,
        action,
        confirm: true,
      });
      if (scopeRef.current !== started) return;
      setNotice(
        action === "approve"
          ? "Approval saved in Lexy only. Nothing was sent to Zoho and the candidate was not contacted."
          : action === "withdraw"
            ? "Request withdrawn in Lexy. Nothing was sent to Zoho."
            : "Read-only recovery check recorded. Zoho was not changed. An observed status is not verified delivery.",
      );
    } catch (cause) {
      if (scopeRef.current !== started) return;
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "This request may have changed. Review the refreshed history before confirming again."
          : errorText(
              cause,
              "The result could not be confirmed. Refresh history before acting again",
            ),
      );
    } finally {
      if (scopeRef.current === started) {
        setBusy("");
        setRowAck(null);
        await refresh(started);
      }
    }
  }

  if (!isAdmin)
    return (
      <section
        className="min-w-0 border-t border-dashed pt-3 text-xs text-muted-foreground sm:rounded sm:border sm:p-3"
        data-testid="section-stage-requests"
      >
        <p data-testid="text-stage-requests-role">
          Only a tenant admin can prepare or approve Zoho stage requests.
        </p>
      </section>
    );

  return (
    <section
      className="min-w-0 space-y-4 border-t border-dashed pt-3 sm:rounded sm:border sm:p-3"
      aria-label="Zoho stage requests"
      data-testid="section-stage-requests"
    >
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Stage requests, local approval only
        </p>
        <h5 className="text-sm font-medium">Human-approved Zoho stage requests</h5>
        <div
          className="space-y-1 rounded border border-amber-600/40 bg-amber-500/5 p-2 text-xs"
          data-testid="text-stage-requests-scope"
        >
          <p className="font-semibold">Live Zoho stage updates are disabled. Nothing here sends.</p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>Prepare runs a read-only Zoho check and saves a request in Lexy.</li>
            <li>Approve saves a local approval. It does not dispatch anything to Zoho.</li>
            <li>
              Recovery is a read-only check for claimed or uncertain writes. Seeing the target
              status in Zoho is not verified delivery.
            </li>
          </ul>
        </div>
      </header>

      {q.isLoading && !failed && (
        <div className="space-y-2" role="status" aria-label="Loading stage requests">
          <div className="h-12 animate-pulse rounded bg-muted" />
          <div className="h-20 animate-pulse rounded bg-muted" />
        </div>
      )}
      {failed && (
        <div role="alert" className="space-y-2 rounded border border-destructive/40 p-3">
          <p className="break-words text-destructive" data-testid="text-stage-requests-load-error">
            {errorText(q.error ?? q.failureReason, "Stage requests could not be loaded")}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={q.isFetching}
            data-testid="button-retry-stage-requests"
            onClick={() => void q.refetch()}
          >
            {q.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}

      {w && (
        <>
          <dl className="grid min-w-0 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Write consent</dt>
            <dd data-testid="text-stage-requests-consent">
              {w.writeConsentSaved ? "Saved in Lexy" : "Not saved"}
            </dd>
            <dt className="text-muted-foreground">Transition</dt>
            <dd data-testid="text-stage-requests-transition">Not verified</dd>
            <dt className="text-muted-foreground">Live execution</dt>
            <dd data-testid="text-stage-requests-live">Disabled</dd>
            <dt className="text-muted-foreground">Blocker</dt>
            <dd className="break-words" data-testid="text-stage-requests-blocker">
              {BLOCKERS[w.blocker] ?? w.blocker}
            </dd>
          </dl>
          <p
            className="break-words rounded border border-dashed p-2 text-xs text-muted-foreground"
            data-testid="text-stage-requests-reason"
          >
            {w.reason}
          </p>
          {q.isFetching && (
            <p className="text-xs text-muted-foreground" role="status">
              Refreshing requests… actions are paused until the latest data loads.
            </p>
          )}

          <div
            className="min-w-0 space-y-3 rounded bg-muted/30 p-2 sm:p-3"
            data-testid="panel-prepare-request"
          >
            <p className="text-sm font-medium">Prepare a request</p>
            <label className="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={prepAck}
                disabled={!w.canPrepare || locked}
                data-testid="checkbox-prepare-ack"
                onChange={(e) => setPrepAck(e.target.checked)}
              />
              <span className="min-w-0 break-words text-sm">
                Run a read-only Zoho check and save a prepared request in Lexy. I understand no Zoho
                status will change and the candidate will not be contacted.
              </span>
            </label>
            {!w.canPrepare && (
              <p className="text-xs text-muted-foreground">Preparation is blocked: {w.reason}</p>
            )}
            <Button
              size="sm"
              className="h-auto whitespace-normal"
              disabled={!w.canPrepare || !prepAck || locked}
              data-testid="button-prepare-request"
              onClick={() => void prepare()}
            >
              {busy === "prepare" ? "Checking Zoho read-only…" : "Prepare request"}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Request history</p>
            {w.requests.length === 0 ? (
              <p
                className="rounded border border-dashed p-2 text-muted-foreground"
                data-testid="text-no-stage-requests"
              >
                No stage requests prepared yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {w.requests.map((r) => {
                  const st = STATES[r.state] ?? { label: r.state, detail: "" };
                  const actions: Action[] = [
                    ...(r.canApprove ? (["approve"] as const) : []),
                    ...(r.canWithdraw ? (["withdraw"] as const) : []),
                    ...(r.canRecover ? (["recover"] as const) : []),
                  ];
                  return (
                    <li
                      key={r.id}
                      className="min-w-0 space-y-2 rounded border p-2 text-sm [overflow-wrap:anywhere]"
                      data-testid={`row-stage-request-${r.id}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="rounded-full border border-dashed px-2 py-0.5 text-xs"
                          data-testid={`status-stage-request-${r.id}`}
                        >
                          {st.label}
                        </span>
                        {r.stale && (
                          <span className="rounded-full border border-amber-600/50 px-2 py-0.5 text-xs">
                            Stale: decision or mapping changed
                          </span>
                        )}
                      </div>
                      <p className="break-words">
                        {DECISIONS[r.decision] ?? r.decision}: "{r.currentStatus}" to "
                        {r.targetStatus}"
                      </p>
                      <p className="text-xs text-muted-foreground">{st.detail}</p>
                      <p className="break-all text-xs text-muted-foreground">
                        Prepared by {r.preparedBy} · {fmt(r.createdAt)}
                        {r.approvedBy ? ` · Approved in Lexy by ${r.approvedBy}` : ""} · Updated{" "}
                        {fmt(r.updatedAt)}
                      </p>
                      {actions.length > 0 && (
                        <div className="space-y-2">
                          {actions
                            .filter((a) => !r.stale || a === "withdraw" || a === "recover")
                            .map((a) => (
                              <div key={a} className="space-y-1">
                                <label className="flex min-w-0 items-start gap-3 text-xs">
                                  <input
                                    type="checkbox"
                                    className="mt-0.5 shrink-0"
                                    checked={rowAck?.id === r.id && rowAck?.action === a}
                                    disabled={locked}
                                    data-testid={`checkbox-${a}-${r.id}`}
                                    onChange={(e) =>
                                      setRowAck(
                                        e.target.checked
                                          ? { id: r.id, action: a, revision: r.revision }
                                          : null,
                                      )
                                    }
                                  />
                                  <span>{ACK[a]}</span>
                                </label>
                                <Button
                                  size="sm"
                                  variant={a === "approve" ? "default" : "outline"}
                                  className="h-auto whitespace-normal"
                                  disabled={
                                    locked ||
                                    rowAck?.id !== r.id ||
                                    rowAck?.action !== a ||
                                    rowAck?.revision !== r.revision
                                  }
                                  data-testid={`button-${a}-${r.id}`}
                                  onClick={() => void act(r, a)}
                                >
                                  {busy === `${a}:${r.id}`
                                    ? "Saving…"
                                    : a === "approve"
                                      ? "Approve in Lexy (no send)"
                                      : a === "withdraw"
                                        ? "Withdraw request"
                                        : "Run read-only recovery check"}
                                </Button>
                              </div>
                            ))}
                        </div>
                      )}
                      {r.stale && actions.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Approval is disabled because this request no longer matches the current
                          decision or mapping. Local withdrawal and eligible read-only recovery
                          remain available.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {notice && (
        <p
          role="status"
          className="break-words rounded border border-primary/40 bg-primary/5 p-3"
          data-testid="text-stage-requests-notice"
        >
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="break-words rounded border border-destructive/40 p-3 text-destructive"
          data-testid="text-stage-requests-error"
        >
          {error}
        </p>
      )}
    </section>
  );
}
