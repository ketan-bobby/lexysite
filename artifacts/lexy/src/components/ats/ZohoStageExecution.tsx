import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  actOnZohoStageExecution,
  getGetZohoStageExecutionQueryKey,
  getZohoStageExecution,
  prepareZohoStageExecution,
} from "@workspace/api-client-react";
import type {
  ZohoStageExecutionAction,
  ZohoStageExecutionRequest as Row,
  ZohoStageExecutionWorkspace as Workspace,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { ZohoStageResolution } from "./ZohoStageResolution";

type Action = ZohoStageExecutionAction["action"];
const HEX = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
const DECISIONS: Record<string, string> = {
  advance: "Advance to next-round review",
  hold: "Hold",
  decline: "Do not advance",
};
const STATES: Record<string, { label: string; detail: string; tone: string }> = {
  prepared: {
    label: "Prepared for execution",
    detail: "Saved in Lexy after a read-only check. Needs a separate approval. Nothing sent.",
    tone: "border-dashed",
  },
  approved: {
    label: "Approved, not executed",
    detail:
      "Approval is saved in Lexy only. Zoho has not been changed. Execution is a separate step.",
    tone: "border-sky-600/50",
  },
  withdrawn: {
    label: "Withdrawn",
    detail: "Withdrawn in Lexy. Nothing was sent to Zoho.",
    tone: "border-dashed",
  },
  claimed: {
    label: "Execution claimed, outcome unknown",
    detail:
      "A Zoho write may or may not have happened. Do not resend. Review Zoho directly or run a read-only recovery check.",
    tone: "border-amber-600/60",
  },
  provider_accepted: {
    label: "Accepted by Zoho, unverified",
    detail: "Zoho accepted the write. The resulting status has not been verified.",
    tone: "border-amber-600/60",
  },
  verified: {
    label: "Verified in Zoho",
    detail: "The target status was verified in Zoho after execution.",
    tone: "border-emerald-600/50",
  },
  not_sent: {
    label: "Not sent",
    detail: "Confirmed that nothing reached Zoho.",
    tone: "border-dashed",
  },
  review_required: {
    label: "Human review required",
    detail:
      "The outcome could not be determined. Check Zoho directly. Lexy will not retry or resend.",
    tone: "border-destructive/60",
  },
  observed_target: {
    label: "Target observed, delivery not proven",
    detail:
      "A read-only check saw the target status in Zoho. This is an observation only, not proof Lexy delivered the change.",
    tone: "border-amber-600/60",
  },
  observed_other: {
    label: "Different status observed",
    detail:
      "A read-only check saw a status other than the target. Review in Zoho. Lexy will not resend.",
    tone: "border-amber-600/60",
  },
};
const ACK: Record<Action, string> = {
  approve:
    "Approve this execution request in Lexy. I understand approval never sends anything to Zoho and execution is a separate, deliberate step.",
  execute:
    "Change this real Zoho application now. I understand this writes to the employer's ATS, will not be retried automatically, and an uncertain result must be reviewed rather than resent.",
  withdraw: "Withdraw this execution request in Lexy. Nothing is sent to Zoho.",
  recover:
    "Run a read-only Zoho check of this uncertain execution. It changes nothing. An observed target status is not proof of delivery.",
};
const LABEL: Record<Action, string> = {
  approve: "Approve in Lexy (no send)",
  execute: "Execute: change Zoho application",
  withdraw: "Withdraw request",
  recover: "Run read-only recovery check",
};

function errorText(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    const data = cause.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) return data.error;
    return `${fallback} (HTTP ${cause.status}).`;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
function isRow(v: unknown): v is Row {
  const r = v as Row | null;
  return (
    !!r &&
    typeof r.id === "string" &&
    UUID.test(r.id) &&
    typeof r.revision === "string" &&
    HEX.test(r.revision) &&
    typeof r.state === "string" &&
    Object.prototype.hasOwnProperty.call(STATES, r.state) &&
    ["advance", "hold", "decline"].includes(r.decision) &&
    typeof r.preparedBy === "string" &&
    (r.approvedBy === null || typeof r.approvedBy === "string") &&
    typeof r.createdAt === "string" &&
    Number.isFinite(Date.parse(r.createdAt)) &&
    typeof r.updatedAt === "string" &&
    Number.isFinite(Date.parse(r.updatedAt)) &&
    typeof r.currentStatus === "string" &&
    typeof r.targetStatus === "string" &&
    typeof r.stale === "boolean" &&
    typeof r.canApprove === "boolean" &&
    typeof r.canWithdraw === "boolean" &&
    typeof r.canRecover === "boolean" &&
    typeof r.canExecute === "boolean" &&
    Number.isInteger(r.sequence) &&
    r.sequence > 0 &&
    typeof r.canProposeResolution === "boolean" &&
    typeof r.canReviewResolution === "boolean" &&
    (r.resolution === null ||
      (typeof r.resolution === "object" &&
        !!r.resolution &&
        typeof r.resolution.proposedBy === "string" &&
        Number.isFinite(r.resolution.proposedAt) &&
        typeof r.resolution.reason === "string" &&
        typeof r.resolution.evidenceReference === "string" &&
        typeof r.resolution.observedStatus === "string" &&
        (r.resolution.review === null ||
          (!!r.resolution.review &&
            ["approve", "reject"].includes(r.resolution.review.action) &&
            typeof r.resolution.review.by === "string" &&
            Number.isFinite(r.resolution.review.at) &&
            typeof r.resolution.review.reason === "string" &&
            typeof r.resolution.review.evidenceReference === "string")))) &&
    (r.executionRequestId === null ||
      (typeof r.executionRequestId === "string" && UUID.test(r.executionRequestId)))
  );
}
function isWorkspace(v: unknown, c: string, r: string): v is Workspace {
  const w = v as Workspace | null;
  return (
    !!w &&
    w.campaignId === c &&
    w.recipientId === r &&
    typeof w.handoffRevision === "string" &&
    HEX.test(w.handoffRevision) &&
    (w.ruleRevision === null || (typeof w.ruleRevision === "string" && HEX.test(w.ruleRevision))) &&
    typeof w.transitionVerified === "boolean" &&
    typeof w.liveEnabled === "boolean" &&
    typeof w.canPrepare === "boolean" &&
    typeof w.reason === "string" &&
    Array.isArray(w.requests) &&
    w.requests.length <= 1000 &&
    w.requests.every(isRow) &&
    new Set(w.requests.map((row) => row.id)).size === w.requests.length
  );
}

/** Controlled Zoho stage execution: prepare, approve (no send), execute (live write), withdraw, recover. */
export function ZohoStageExecution({
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
  const [rowAck, setRowAck] = useState<{
    id: string;
    action: Action;
    revision: string;
    rule: string | null;
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [msgKey, setMsgKey] = useState("");
  // Stable command IDs per exact logical command; reused for manual retry after ambiguity.
  const cmdIds = useRef(new Map<string, string>());
  const cmdId = (k: string) => {
    let id = cmdIds.current.get(k);
    if (!id) {
      id = crypto.randomUUID();
      cmdIds.current.set(k, id);
    }
    return id;
  };

  const key = [...getGetZohoStageExecutionQueryKey(campaignId, recipientId), scope];
  const q = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const body = await getZohoStageExecution(campaignId, recipientId, {
        signal,
        cache: "no-store",
      });
      if (!isWorkspace(body, campaignId, recipientId))
        throw new Error(
          "Stage execution returned an unexpected response. Nothing is authorized until it reloads correctly.",
        );
      return body;
    },
    enabled: !!user && isAdmin,
    retry: false,
    staleTime: 0,
    refetchInterval: (query) => (query.state.error ? false : 30_000),
  });
  const failed = q.isError || !!q.failureReason;
  const w = failed ? undefined : q.data;
  const authorityKey = `${scope}:${w?.handoffRevision ?? ""}:${w?.ruleRevision ?? ""}:${w?.liveEnabled ?? ""}:${w?.transitionVerified ?? ""}`;
  const rowAuthority = JSON.stringify(
    w?.requests.map((row) => [
      row.id,
      row.revision,
      row.state,
      row.stale,
      row.canApprove,
      row.canExecute,
      row.canWithdraw,
      row.canRecover,
      row.executionRequestId,
      row.sequence,
      row.canProposeResolution,
      row.canReviewResolution,
    ]),
  );

  const reset = () => {
    setPrepAck(false);
    setRowAck(null);
  };

  useEffect(() => {
    reset();
    setBusy("");
    setError("");
    setNotice("");
    cmdIds.current.clear();
  }, [scope]);

  const firstRev = useRef(true);
  useEffect(() => {
    if (firstRev.current) {
      firstRev.current = false;
      return;
    }
    reset();
    void qc.invalidateQueries({ queryKey: key });
  }, [reviewRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Authority changed (source, rule, live/transition flags): drop acknowledgements and stale notices.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!w) return;
    if (seen.current !== null && seen.current !== authorityKey) {
      reset();
      setNotice("");
      setError("");
    }
    seen.current = authorityKey;
  }, [authorityKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // A failed read or changed action authority must never restore an earlier
    // acknowledgement after permissions/state recover.
    reset();
    setNotice("");
  }, [failed, rowAuthority]);

  const ackRow = rowAck && w?.requests.find((r) => r.id === rowAck.id);
  useEffect(() => {
    if (rowAck && (!ackRow || ackRow.revision !== rowAck.revision)) setRowAck(null);
  }, [ackRow?.revision, rowAck?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const locked = !!busy || q.isFetching || failed;
  const evidenceOk = !!w && w.transitionVerified && w.ruleRevision !== null;

  function allowed(r: Row, a: Action) {
    if (!w) return false;
    if (a === "withdraw") return r.canWithdraw;
    if (a === "recover") return r.canRecover;
    if (r.stale || !evidenceOk) return false;
    if (a === "approve") return r.canApprove;
    return r.canExecute && w.liveEnabled === true;
  }

  async function refresh(started: string) {
    if (scopeRef.current === started) await qc.invalidateQueries({ queryKey: key });
  }

  async function prepare() {
    if (!w || !isAdmin || !w.canPrepare || !evidenceOk || !prepAck || locked || !w.ruleRevision)
      return;
    const started = scope;
    const k = `prepare:${scope}:${w.handoffRevision}:${w.ruleRevision}:${reviewRevision}`;
    const requestId = cmdId(k);
    setBusy("prepare");
    setError("");
    setNotice("");
    setMsgKey(authorityKey);
    try {
      await prepareZohoStageExecution(campaignId, recipientId, {
        expectedRevision: w.handoffRevision,
        expectedRuleRevision: w.ruleRevision,
        requestId,
        confirm: true,
      });
      if (scopeRef.current !== started) return;
      cmdIds.current.delete(k);
      setNotice(
        "Execution request prepared in Lexy. Zoho was not changed. It still needs a separate approval, then a separate execute step.",
      );
    } catch (cause) {
      if (scopeRef.current !== started) return;
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        setError(
          cause.status === 409
            ? "The handoff or rule evidence changed. Review the refreshed state before preparing again."
            : errorText(cause, "Preparation was rejected"),
        );
      } else
        setError(
          errorText(
            cause,
            "The result could not be confirmed. Review the refreshed history; a manual retry reuses the same request ID",
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

  async function act(r: Row, a: Action) {
    if (!w || !isAdmin || locked || !allowed(r, a)) return;
    if (
      !rowAck ||
      rowAck.id !== r.id ||
      rowAck.action !== a ||
      rowAck.revision !== r.revision ||
      rowAck.rule !== w.ruleRevision
    )
      return;
    const started = scope;
    const k = `${a}:${scope}:${r.id}:${r.revision}:${w.ruleRevision ?? ""}`;
    const requestId = cmdId(k);
    setBusy(`${a}:${r.id}`);
    setError("");
    setNotice("");
    setMsgKey(authorityKey);
    try {
      await actOnZohoStageExecution(campaignId, recipientId, r.id, {
        expectedRevision: r.revision,
        expectedRuleRevision: w.ruleRevision,
        requestId,
        action: a,
        confirm: true,
      });
      if (scopeRef.current !== started) return;
      cmdIds.current.delete(k);
      setNotice(
        a === "approve"
          ? "Approval saved in Lexy only. Nothing was sent to Zoho."
          : a === "execute"
            ? "Execution submitted. Check the refreshed status below; only 'Verified in Zoho' confirms the change. Lexy will not retry automatically."
            : a === "withdraw"
              ? "Request withdrawn in Lexy. Nothing was sent to Zoho."
              : "Read-only recovery check recorded. Zoho was not changed. An observed status is not proof of delivery.",
      );
    } catch (cause) {
      if (scopeRef.current !== started) return;
      const clientError = cause instanceof ApiError && cause.status >= 400 && cause.status < 500;
      // Even a 4xx may follow a committed effect if a later scope/read check
      // failed. Retain the command identity until confirmed success or a new scope.
      const detail =
        cause instanceof ApiError && cause.status === 409
          ? "This request, its evidence or runtime authority changed. Review the refreshed history before acting again."
          : clientError
            ? errorText(cause, "The action was rejected")
            : a === "execute"
              ? "The execution outcome is unknown. Do not assume it failed. Review the refreshed history and Zoho directly. If you retry manually, the same request ID is reused so it cannot double-write."
              : errorText(
                  cause,
                  "The result could not be confirmed. Review the refreshed history; a manual retry reuses the same request ID",
                );
      setError(
        detail +
          (a === "execute" && clientError
            ? " A Zoho write may already have happened before this response failed. Do not assume it failed; check the refreshed history and Zoho directly. Lexy will not resend automatically."
            : ""),
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
        data-testid="section-stage-execution"
      >
        <p data-testid="text-stage-execution-role">
          Only a tenant admin can prepare, approve or execute Zoho stage changes.
        </p>
      </section>
    );

  const showMsg = msgKey === authorityKey;

  return (
    <section
      className="min-w-0 space-y-4 rounded border-2 border-primary/30 p-3"
      aria-label="Controlled Zoho stage execution"
      data-testid="section-stage-execution"
    >
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-primary">
            Controlled execution, separate from local simulation
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={q.isFetching || !!busy}
            data-testid="button-refresh-stage-execution"
            onClick={() => void q.refetch()}
          >
            {q.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        <h5 className="text-sm font-medium">Change the real Zoho application</h5>
        <div
          className="space-y-1 rounded border border-amber-600/40 bg-amber-500/5 p-2 text-xs"
          data-testid="text-stage-execution-scope"
        >
          <p className="font-semibold">Three distinct steps. Only the last one can change Zoho.</p>
          <ol className="list-decimal space-y-0.5 pl-4">
            <li>
              Prepare: read-only check, saves a new execution request. Prior local approvals above
              are never promoted.
            </li>
            <li>Approve: saved in Lexy only. Approval never sends.</li>
            <li>
              Execute: writes to Zoho, only when the server allows it and live execution is enabled.
              Never automatic, never retried.
            </li>
          </ol>
          <p className="text-muted-foreground">
            Transition evidence is employer human review, not Zoho-certified eligibility. Expired,
            stale or unsupported evidence blocks prepare, approve and execute.
          </p>
        </div>
      </header>

      {q.isLoading && !failed && (
        <div className="space-y-2" role="status" aria-label="Loading stage execution">
          <div className="h-10 animate-pulse rounded bg-muted" />
          <div className="h-20 animate-pulse rounded bg-muted" />
        </div>
      )}
      {failed && (
        <div role="alert" className="space-y-2 rounded border border-destructive/40 p-3">
          <p
            className="break-words text-sm text-destructive"
            data-testid="text-stage-execution-load-error"
          >
            {errorText(q.error ?? q.failureReason, "Stage execution could not be loaded")}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={q.isFetching}
            data-testid="button-retry-stage-execution"
            onClick={() => void q.refetch()}
          >
            {q.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}

      {w && (
        <>
          <dl className="grid min-w-0 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Transition evidence</dt>
            <dd data-testid="text-stage-execution-transition">
              {w.transitionVerified && w.ruleRevision ? "Current employer review" : "Not current"}
            </dd>
            <dt className="text-muted-foreground">Live execution</dt>
            <dd
              data-testid="text-stage-execution-live"
              className={w.liveEnabled ? "font-semibold text-amber-700 dark:text-amber-400" : ""}
            >
              {w.liveEnabled ? "Enabled on server" : "Disabled on server"}
            </dd>
          </dl>
          <p
            className="break-words rounded border border-dashed p-2 text-xs text-muted-foreground"
            data-testid="text-stage-execution-reason"
          >
            {w.reason}
          </p>
          {q.isFetching && (
            <p className="text-xs text-muted-foreground" role="status">
              Refreshing… actions are paused until the latest data loads.
            </p>
          )}

          <div
            className="min-w-0 space-y-3 rounded bg-muted/30 p-2 sm:p-3"
            data-testid="panel-prepare-execution"
          >
            <p className="text-sm font-medium">Step 1. Prepare an execution request</p>
            <label className="flex min-w-0 items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={prepAck}
                disabled={!w.canPrepare || !evidenceOk || locked}
                data-testid="checkbox-prepare-execution-ack"
                onChange={(e) => setPrepAck(e.target.checked)}
              />
              <span className="min-w-0 break-words text-sm">
                Run a read-only Zoho check and save a new execution request. I understand nothing
                changes in Zoho and earlier local approvals are not carried over.
              </span>
            </label>
            {(!w.canPrepare || !evidenceOk) && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="text-prepare-execution-blocked"
              >
                Preparation is blocked: {w.reason}
              </p>
            )}
            <Button
              size="sm"
              className="h-auto whitespace-normal"
              disabled={!w.canPrepare || !evidenceOk || !prepAck || locked}
              data-testid="button-prepare-execution"
              onClick={() => void prepare()}
            >
              {busy === "prepare" ? "Checking Zoho read-only…" : "Prepare execution request"}
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Execution history</p>
            {w.requests.length === 0 ? (
              <p
                className="rounded border border-dashed p-2 text-sm text-muted-foreground"
                data-testid="text-no-stage-executions"
              >
                No execution requests yet. Local simulation requests above are not shown here.
              </p>
            ) : (
              <ul className="space-y-2">
                {w.requests.map((r) => {
                  const st = STATES[r.state] ?? {
                    label: r.state,
                    detail: "Unrecognized state. Review in Zoho before acting.",
                    tone: "border-destructive/60",
                  };
                  const actions = (["approve", "execute", "withdraw", "recover"] as const).filter(
                    (a) => allowed(r, a),
                  );
                  const blockedExec = r.canExecute && !allowed(r, "execute");
                  return (
                    <li
                      key={r.id}
                      className="min-w-0 space-y-2 rounded border p-2 text-sm [overflow-wrap:anywhere]"
                      data-testid={`row-stage-execution-${r.id}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs ${st.tone}`}
                          data-testid={`status-stage-execution-${r.id}`}
                        >
                          {st.label}
                        </span>
                        {r.stale && (
                          <span className="rounded-full border border-amber-600/50 px-2 py-0.5 text-xs">
                            Stale: source or evidence changed
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
                        {r.executionRequestId ? ` · Execution ref ${r.executionRequestId}` : ""}
                      </p>
                      {blockedExec && (
                        <p
                          className="text-xs text-muted-foreground"
                          data-testid={`text-execute-blocked-${r.id}`}
                        >
                          Execution is unavailable:{" "}
                          {!w.liveEnabled
                            ? "live execution is disabled on the server."
                            : "transition evidence is not current or the request is stale."}
                        </p>
                      )}
                      {actions.map((a) => (
                        <div
                          key={a}
                          className={`space-y-1 ${a === "execute" ? "rounded border border-amber-600/50 bg-amber-500/5 p-2" : ""}`}
                        >
                          <label className="flex min-w-0 items-start gap-3 text-xs">
                            <input
                              type="checkbox"
                              className="mt-0.5 shrink-0"
                              checked={rowAck?.id === r.id && rowAck?.action === a}
                              disabled={locked}
                              data-testid={`checkbox-execution-${a}-${r.id}`}
                              onChange={(e) =>
                                setRowAck(
                                  e.target.checked
                                    ? {
                                        id: r.id,
                                        action: a,
                                        revision: r.revision,
                                        rule: w.ruleRevision,
                                      }
                                    : null,
                                )
                              }
                            />
                            <span>{ACK[a]}</span>
                          </label>
                          <Button
                            size="sm"
                            variant={
                              a === "execute"
                                ? "destructive"
                                : a === "approve"
                                  ? "default"
                                  : "outline"
                            }
                            className="h-auto whitespace-normal"
                            disabled={
                              locked ||
                              rowAck?.id !== r.id ||
                              rowAck?.action !== a ||
                              rowAck?.revision !== r.revision ||
                              rowAck?.rule !== w.ruleRevision
                            }
                            data-testid={`button-execution-${a}-${r.id}`}
                            onClick={() => void act(r, a)}
                          >
                            {busy === `${a}:${r.id}`
                              ? a === "execute"
                                ? "Writing to Zoho…"
                                : "Saving…"
                              : LABEL[a]}
                          </Button>
                        </div>
                      ))}
                      <ZohoStageResolution
                        key={`${authorityKey}:${r.id}:${r.sequence}:${r.canProposeResolution}:${r.canReviewResolution}:${failed}`}
                        row={r}
                        campaignId={campaignId}
                        recipientId={recipientId}
                        sourceRevision={w.handoffRevision}
                        locked={locked}
                        refresh={() => refresh(scope)}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}

      {notice && showMsg && (
        <p
          role="status"
          className="break-words rounded border border-primary/40 bg-primary/5 p-3"
          data-testid="text-stage-execution-notice"
        >
          {notice}
        </p>
      )}
      {error && showMsg && (
        <p
          role="alert"
          className="break-words rounded border border-destructive/40 p-3 text-destructive"
          data-testid="text-stage-execution-error"
        >
          {error}
        </p>
      )}
    </section>
  );
}
