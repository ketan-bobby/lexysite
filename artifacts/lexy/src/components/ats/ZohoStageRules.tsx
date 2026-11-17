import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetZohoStageRulesQueryKey,
  useActOnZohoStageRule,
  useGetZohoStageRules,
  useProposeZohoStageRule,
} from "@workspace/api-client-react";
import type {
  ZohoStageRule,
  ZohoStageRuleAction,
  ZohoStageRuleEvidence,
  ZohoStageRuleInput,
  ZohoStageRuleWorkspace,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";

const REQUIREMENTS: ZohoStageRuleEvidence["requirements"] =
  "no_additional_fields_or_blueprint_actions";
const NOTIFICATIONS: ZohoStageRuleEvidence["notifications"] =
  "no_automatic_messages_or_cross_application_changes";

type RefKey =
  | "contractReference"
  | "isolationReference"
  | "requirementsReference"
  | "sideEffectsReference";
const REF_FIELDS: { key: RefKey; label: string; hint: string }[] = [
  {
    key: "contractReference",
    label: "Transition contract reference",
    hint: "Where the allowed current-to-target status transition is documented.",
  },
  {
    key: "isolationReference",
    label: "Application isolation reference",
    hint: "Evidence the change affects only this one application.",
  },
  {
    key: "requirementsReference",
    label: "Field and Blueprint requirements reference",
    hint: "Evidence no extra mandatory fields or Blueprint actions are required.",
  },
  {
    key: "sideEffectsReference",
    label: "Side-effects reference",
    hint: "Evidence no automatic messages or cross-application changes fire.",
  },
];
const EMPTY_REFS: Record<RefKey, string> = {
  contractReference: "",
  isolationReference: "",
  requirementsReference: "",
  sideEffectsReference: "",
};

const STATUS: Record<ZohoStageRuleWorkspace["status"], { label: string; tone: string }> = {
  unavailable: { label: "Unavailable", tone: "border-dashed" },
  proposal_required: { label: "Evidence proposal required", tone: "border-dashed" },
  pending_review: { label: "Pending independent reviewer", tone: "border-amber-600/50" },
  verified: { label: "Verified by employer review", tone: "border-emerald-600/50" },
  expired: { label: "Expired", tone: "border-amber-600/50" },
  stale: { label: "Stale: source changed", tone: "border-amber-600/50" },
  revoked: { label: "Revoked", tone: "border-dashed" },
};
const RULE_STATE: Record<ZohoStageRule["state"], string> = {
  proposed: "Proposed",
  verified: "Verified (human review)",
  revoked: "Revoked",
};
const DECISIONS: Record<string, string> = {
  advance: "Advance to next-round review",
  hold: "Hold",
  decline: "Do not advance",
};

const fmt = (n: number | null) => (n ? new Date(n).toLocaleString() : "—");

/** Returns an error string if a reference is unacceptable, otherwise "". Plain-text only. */
function refProblem(raw: string): string {
  const v = raw.trim();
  if (v.length < 8) return "At least 8 characters.";
  if (v.length > 200) return "At most 200 characters.";
  if (/[?&][^=\s]+=/.test(v)) return "Remove query parameters; signed URLs are not accepted.";
  if (/(password|passwd|secret|token|api[_-]?key|bearer|signature|credential)/i.test(v))
    return "Looks like a credential. Use a non-sensitive document reference.";
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(v))
    return "Looks like an email address. Do not include personal data.";
  if (/:\/\/[^/\s]*@/.test(v)) return "Remove embedded credentials from the reference.";
  if (/[\u0000-\u001f\u007f]/u.test(v)) return "Control characters are not accepted.";
  if (v.includes("://")) {
    try {
      const url = new URL(v);
      if (url.protocol !== "https:" || url.search || url.hash)
        return "Use unsigned HTTPS URLs without query parameters or fragments.";
    } catch {
      return "Use a document reference or a valid HTTPS URL.";
    }
  } else if (!/^[A-Za-z0-9][A-Za-z0-9_./:# -]+$/.test(v))
    return "Use a non-sensitive document reference.";
  return "";
}

function errorText(cause: unknown, fallback: string) {
  if (cause instanceof ApiError) {
    const data = cause.data as { error?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) return data.error;
    return `${fallback} (HTTP ${cause.status}).`;
  }
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function isWorkspace(v: unknown, c: string, r: string): v is ZohoStageRuleWorkspace {
  const w = v as ZohoStageRuleWorkspace | null;
  return (
    !!w &&
    w.campaignId === c &&
    w.recipientId === r &&
    typeof w.sourceRevision === "string" &&
    typeof w.currentApplication?.applicationId === "string" &&
    typeof w.currentApplication?.candidateId === "string" &&
    typeof w.currentApplication?.jobId === "string" &&
    w.liveEnabled === false &&
    Array.isArray(w.history)
  );
}

/** Employer evidence review of Zoho application transition rules. Local only; never executes. */
export function ZohoStageRules({
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

  const key = [...getGetZohoStageRulesQueryKey(campaignId, recipientId), scope];
  const q = useGetZohoStageRules(campaignId, recipientId, {
    query: {
      queryKey: key,
      enabled: !!user && isAdmin,
      retry: false,
      staleTime: 0,
      refetchInterval: (query) => (query.state.error ? false : 30_000),
    },
    request: { cache: "no-store" },
  });
  const propose = useProposeZohoStageRule();
  const act = useActOnZohoStageRule();

  const shapeOk = q.data === undefined || isWorkspace(q.data, campaignId, recipientId);
  const failed = q.isError || !!q.failureReason || !shapeOk;
  const w = failed ? undefined : q.data;
  const rule = w?.currentRule ?? null;

  const [refs, setRefs] = useState(EMPTY_REFS);
  const [ackReq, setAckReq] = useState(false);
  const [ackNotif, setAckNotif] = useState(false);
  const [ackPropose, setAckPropose] = useState(false);
  const [reviewRef, setReviewRef] = useState("");
  const [ackVerify, setAckVerify] = useState(false);
  const [ackRevoke, setAckRevoke] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [messageKey, setMessageKey] = useState("");
  const proposeIdRef = useRef<{ key: string; id: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const resetForms = () => {
    setRefs(EMPTY_REFS);
    setAckReq(false);
    setAckNotif(false);
    setAckPropose(false);
    setReviewRef("");
    setAckVerify(false);
    setAckRevoke(false);
    proposeIdRef.current = null;
  };

  useEffect(() => {
    resetForms();
    setBusy("");
    setError("");
    setNotice("");
  }, [scope]);

  const firstRev = useRef(true);
  useEffect(() => {
    if (firstRev.current) {
      firstRev.current = false;
      return;
    }
    resetForms();
    void qc.invalidateQueries({ queryKey: key });
  }, [reviewRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  const sourceRevision = w?.sourceRevision;
  const ruleRevision = rule?.revision;
  const currentMessageKey = `${scope}:${sourceRevision ?? ""}:${ruleRevision ?? ""}`;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const sig = `${sourceRevision ?? ""}:${ruleRevision ?? ""}`;
    if (seen.current !== null && seen.current !== sig) resetForms();
    seen.current = sig;
  }, [sourceRevision, ruleRevision]);

  const locked = !!busy || q.isFetching || failed;
  const expiredLocally =
    rule?.state === "verified" && rule.expiresAt !== null && rule.expiresAt <= now;
  const status: ZohoStageRuleWorkspace["status"] | undefined = w
    ? w.status === "verified" && expiredLocally
      ? "expired"
      : w.status
    : undefined;

  const refErrors = REF_FIELDS.map((f) => refProblem(refs[f.key]));
  const trimmed = REF_FIELDS.map((f) => refs[f.key].trim().toLowerCase());
  const distinct = new Set(trimmed).size === trimmed.length;
  const canSubmitProposal =
    !!w &&
    w.canPropose &&
    !locked &&
    refErrors.every((e) => !e) &&
    distinct &&
    ackReq &&
    ackNotif &&
    ackPropose;

  const proposalRefs = rule
    ? [
        rule.evidence.contractReference,
        rule.evidence.isolationReference,
        rule.evidence.requirementsReference,
        rule.evidence.sideEffectsReference,
      ].map((s) => s.trim().toLowerCase())
    : [];
  const reviewProblem = reviewRef
    ? refProblem(reviewRef) ||
      (proposalRefs.includes(reviewRef.trim().toLowerCase())
        ? "Must differ from all four proposal references."
        : "")
    : "";
  const isSubmitter = !!rule && !!user && rule.submittedBy === user.id;
  const canVerifyNow =
    !!w &&
    w.canVerify &&
    !!rule &&
    rule.state === "proposed" &&
    !isSubmitter &&
    !locked &&
    !!reviewRef &&
    !reviewProblem &&
    ackVerify;
  const canRevokeNow =
    !!w && w.canRevoke && !!rule && rule.state !== "revoked" && !locked && ackRevoke;

  async function refresh(started: string) {
    if (scopeRef.current === started) await qc.invalidateQueries({ queryKey: key });
  }

  async function submitProposal() {
    if (!w || !isAdmin || !canSubmitProposal) return;
    const started = scope;
    const k = `${scope}:${w.sourceRevision}:${rule?.revision ?? ""}:${reviewRevision}:${JSON.stringify(REF_FIELDS.map((f) => refs[f.key].trim()))}`;
    if (proposeIdRef.current?.key !== k) proposeIdRef.current = { key: k, id: crypto.randomUUID() };
    const body: ZohoStageRuleInput = {
      expectedRevision: w.sourceRevision,
      expectedRuleRevision: rule?.revision ?? null,
      requestId: proposeIdRef.current.id,
      confirm: true,
      evidence: {
        contractReference: refs.contractReference.trim(),
        isolationReference: refs.isolationReference.trim(),
        requirementsReference: refs.requirementsReference.trim(),
        sideEffectsReference: refs.sideEffectsReference.trim(),
        requirements: REQUIREMENTS,
        notifications: NOTIFICATIONS,
      },
    };
    setBusy("propose");
    setError("");
    setNotice("");
    setMessageKey(currentMessageKey);
    try {
      const result = await propose.mutateAsync({ id: campaignId, recipientId, data: body });
      if (scopeRef.current !== started) return;
      if (!isWorkspace(result, campaignId, recipientId))
        throw new Error("Unexpected evidence response. Reload before acting again.");
      setMessageKey(`${started}:${result.sourceRevision}:${result.currentRule?.revision ?? ""}`);
      resetForms();
      setNotice(
        "Evidence proposal saved in Lexy. A different employer admin must review it. Nothing was sent to Zoho.",
      );
    } catch (cause) {
      if (scopeRef.current !== started) return;
      if (cause instanceof ApiError && cause.status === 409) {
        proposeIdRef.current = null;
        setError(
          "The source changed or a rule already exists. Review the refreshed state before proposing again.",
        );
      } else
        setError(
          errorText(
            cause,
            "The proposal result could not be confirmed. Refresh before retrying; the same request ID will be reused",
          ),
        );
    } finally {
      if (scopeRef.current === started) {
        setBusy("");
        setAckPropose(false);
        await refresh(started);
      }
    }
  }

  async function runAction(action: ZohoStageRuleAction["action"]) {
    if (!w || !rule || !isAdmin) return;
    if (action === "verify" && !canVerifyNow) return;
    if (action === "revoke" && !canRevokeNow) return;
    const started = scope;
    const data: ZohoStageRuleAction = {
      expectedRevision: rule.revision,
      requestId: crypto.randomUUID(),
      action,
      confirm: true,
      ...(action === "verify" ? { reviewReference: reviewRef.trim() } : {}),
    };
    setBusy(action);
    setError("");
    setNotice("");
    setMessageKey(currentMessageKey);
    try {
      const result = await act.mutateAsync({ id: campaignId, recipientId, ruleId: rule.id, data });
      if (scopeRef.current !== started) return;
      if (!isWorkspace(result, campaignId, recipientId))
        throw new Error("Unexpected evidence response. Reload before acting again.");
      setMessageKey(`${started}:${result.sourceRevision}:${result.currentRule?.revision ?? ""}`);
      setNotice(
        action === "verify"
          ? result.status === "verified" && result.currentRule?.verifiedBy === user?.id
            ? "Independent employer review recorded in Lexy. It expires in 15 minutes and will not renew. This review does not execute a stage change."
            : "Your action was recorded. The current rule changed; review the refreshed state."
          : result.currentRule?.state === "revoked"
            ? "Rule revoked in Lexy. Nothing was sent to Zoho."
            : "Your action was recorded. Review the refreshed rule.",
      );
    } catch (cause) {
      if (scopeRef.current !== started) return;
      setError(
        cause instanceof ApiError && cause.status === 409
          ? "This rule changed. Review the refreshed evidence before acting again."
          : errorText(cause, "The result could not be confirmed. Refresh before acting again"),
      );
    } finally {
      if (scopeRef.current === started) {
        setBusy("");
        setReviewRef("");
        setAckVerify(false);
        setAckRevoke(false);
        await refresh(started);
      }
    }
  }

  if (!isAdmin)
    return (
      <section
        className="min-w-0 border-t border-dashed pt-3 text-xs text-muted-foreground sm:rounded sm:border sm:p-3"
        data-testid="stage-rules-section"
      >
        <p data-testid="stage-rules-role">
          Only a tenant admin can review Zoho transition rule evidence.
        </p>
      </section>
    );

  const st = status ? STATUS[status] : undefined;

  return (
    <section
      className="min-w-0 space-y-4 border-t border-dashed pt-3 sm:rounded sm:border sm:p-3"
      aria-label="Zoho transition rule evidence"
      data-testid="stage-rules-section"
    >
      <header className="space-y-2">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Transition rules, employer evidence review
        </p>
        <h5 className="text-sm font-medium">Application transition rule evidence</h5>
        <div
          className="space-y-1 rounded border border-amber-600/40 bg-amber-500/5 p-2 text-xs"
          data-testid="stage-rules-live-disabled"
        >
          <p className="font-semibold">
            Evidence review never sends a stage change. Controlled execution is a separate workflow.
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              Verification is employer human review of your evidence, not a Zoho-certified list of
              allowed next actions.
            </li>
            <li>
              It is separate from stage-request approval and does not approve or send any request.
            </li>
            <li>
              A verification expires 15 minutes after it is recorded and is never renewed
              automatically.
            </li>
            <li>
              Applications needing extra mandatory fields, Blueprint actions, notifications or
              cross-application effects are unsupported. They are not bypassed.
            </li>
          </ul>
        </div>
      </header>

      {q.isLoading && !failed && (
        <div
          className="space-y-2"
          role="status"
          aria-label="Loading transition rules"
          data-testid="stage-rules-loading"
        >
          <div className="h-8 animate-pulse rounded bg-muted" />
          <div className="h-24 animate-pulse rounded bg-muted" />
        </div>
      )}
      {failed && (
        <div
          role="alert"
          className="space-y-2 rounded border border-destructive/40 p-3"
          data-testid="stage-rules-load-error"
        >
          <p className="break-words text-sm text-destructive">
            {!shapeOk && !q.isError && !q.failureReason
              ? "Transition rules returned an unexpected response."
              : errorText(q.error ?? q.failureReason, "Transition rules could not be loaded")}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={q.isFetching}
            data-testid="stage-rules-retry"
            onClick={() => void q.refetch()}
          >
            {q.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      )}

      {w && st && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full border px-2 py-0.5 text-xs ${st.tone}`}
              data-testid="stage-rules-status"
            >
              {st.label}
            </span>
            <span
              className="rounded-full border border-dashed px-2 py-0.5 font-mono text-[11px]"
              data-testid="stage-rules-live"
            >
              Evidence workflow: no execution
            </span>
          </div>
          <p
            className="break-words rounded border border-dashed p-2 text-xs text-muted-foreground"
            data-testid="stage-rules-reason"
          >
            {expiredLocally
              ? "This verification has expired locally. A new proposal and independent review are required."
              : w.reason}
          </p>
          <dl
            className="grid min-w-0 gap-1 text-xs [overflow-wrap:anywhere]"
            data-testid="stage-rules-application"
          >
            <dt className="font-medium">Current Zoho source identifiers</dt>
            <dd>Application: {w.currentApplication.applicationId}</dd>
            <dd>Candidate: {w.currentApplication.candidateId}</dd>
            <dd>Job: {w.currentApplication.jobId}</dd>
            <dd className="text-muted-foreground">
              Review evidence for this exact application, candidate and job. Older history is not
              proof for a changed source.
            </dd>
          </dl>
          {q.isFetching && (
            <p
              className="text-xs text-muted-foreground"
              role="status"
              data-testid="stage-rules-refreshing"
            >
              Refreshing rules… actions are paused until the latest data loads.
            </p>
          )}

          {rule ? (
            <RuleCard rule={rule} now={now} current />
          ) : (
            <p
              className="rounded border border-dashed p-2 text-sm text-muted-foreground"
              data-testid="stage-rules-empty"
            >
              No transition rule evidence has been proposed for this application yet.
            </p>
          )}

          {rule?.state === "proposed" && (
            <div
              className="min-w-0 space-y-3 rounded bg-muted/30 p-2 sm:p-3"
              data-testid="stage-rules-verify-form"
            >
              <p className="text-sm font-medium">Independent review</p>
              {isSubmitter ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="stage-rules-pending-reviewer"
                >
                  You submitted this evidence. A different currently authorized employer admin must
                  review it.
                </p>
              ) : !w.canVerify ? (
                <p
                  className="text-xs text-muted-foreground"
                  data-testid="stage-rules-verify-blocked"
                >
                  Review is blocked: {w.reason}
                </p>
              ) : null}
              {!isSubmitter && w.canVerify && (
                <>
                  <label className="block space-y-1 text-xs">
                    <span className="font-medium">Your review reference</span>
                    <input
                      type="text"
                      value={reviewRef}
                      maxLength={200}
                      disabled={locked}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={!!reviewProblem}
                      onChange={(e) => setReviewRef(e.target.value)}
                      className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs"
                      data-testid="stage-rules-input-review-reference"
                    />
                    <span className={reviewProblem ? "text-destructive" : "text-muted-foreground"}>
                      {reviewProblem ||
                        "Plain text, 8 to 200 characters, distinct from the four proposal references."}
                    </span>
                  </label>
                  <label className="flex min-w-0 items-start gap-3 text-xs">
                    <input
                      type="checkbox"
                      className="mt-0.5 shrink-0"
                      checked={ackVerify}
                      disabled={locked}
                      onChange={(e) => setAckVerify(e.target.checked)}
                      data-testid="stage-rules-checkbox-verify"
                    />
                    <span>
                      I independently reviewed all four references. I understand this is employer
                      human review, not Zoho certification, it expires in 15 minutes, and this
                      verification does not execute a stage change.
                    </span>
                  </label>
                  <Button
                    size="sm"
                    className="h-auto whitespace-normal"
                    disabled={!canVerifyNow}
                    onClick={() => void runAction("verify")}
                    data-testid="stage-rules-button-verify"
                  >
                    {busy === "verify" ? "Saving…" : "Record independent review (no send)"}
                  </Button>
                </>
              )}
            </div>
          )}

          {rule && rule.state !== "revoked" && w.canRevoke && (
            <div
              className="min-w-0 space-y-2 rounded border p-2 sm:p-3"
              data-testid="stage-rules-revoke-form"
            >
              <label className="flex min-w-0 items-start gap-3 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={ackRevoke}
                  disabled={locked}
                  onChange={(e) => setAckRevoke(e.target.checked)}
                  data-testid="stage-rules-checkbox-revoke"
                />
                <span>Revoke this rule in Lexy. Nothing is sent to Zoho.</span>
              </label>
              <Button
                size="sm"
                variant="outline"
                className="h-auto whitespace-normal"
                disabled={!canRevokeNow}
                onClick={() => void runAction("revoke")}
                data-testid="stage-rules-button-revoke"
              >
                {busy === "revoke" ? "Saving…" : "Revoke rule"}
              </Button>
            </div>
          )}

          {w.canPropose ? (
            <form
              className="min-w-0 space-y-3 rounded bg-muted/30 p-2 sm:p-3"
              data-testid="stage-rules-propose-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitProposal();
              }}
            >
              <p className="text-sm font-medium">Propose transition evidence</p>
              <p className="text-xs text-muted-foreground">
                Enter four distinct, non-sensitive plain-text references. Do not paste signed URLs,
                query parameters, credentials or candidate personal data. Lexy never opens these
                references.
              </p>
              {rule && (
                <p className="text-xs text-amber-600">
                  A new proposal supersedes this application’s current rule and requires a new
                  independent review.
                </p>
              )}
              {REF_FIELDS.map((f, i) => (
                <label key={f.key} className="block space-y-1 text-xs">
                  <span className="font-medium">{f.label}</span>
                  <input
                    type="text"
                    value={refs[f.key]}
                    maxLength={200}
                    disabled={locked}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={!!refs[f.key] && !!refErrors[i]}
                    onChange={(e) => setRefs((r) => ({ ...r, [f.key]: e.target.value }))}
                    className="w-full rounded border bg-background px-2 py-1.5 font-mono text-xs"
                    data-testid={`stage-rules-input-${f.key}`}
                  />
                  <span
                    className={
                      refs[f.key] && refErrors[i] ? "text-destructive" : "text-muted-foreground"
                    }
                  >
                    {refs[f.key] && refErrors[i] ? refErrors[i] : f.hint}
                  </span>
                </label>
              ))}
              {!distinct && refErrors.every((e) => !e) && (
                <p className="text-xs text-destructive" data-testid="stage-rules-distinct-error">
                  All four references must be different.
                </p>
              )}
              <label className="flex min-w-0 items-start gap-3 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={ackReq}
                  disabled={locked}
                  onChange={(e) => setAckReq(e.target.checked)}
                  data-testid="stage-rules-checkbox-requirements"
                />
                <span>
                  I confirm this transition needs no additional mandatory fields or Blueprint
                  actions. Applications that do are unsupported, not bypassed.
                </span>
              </label>
              <label className="flex min-w-0 items-start gap-3 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={ackNotif}
                  disabled={locked}
                  onChange={(e) => setAckNotif(e.target.checked)}
                  data-testid="stage-rules-checkbox-notifications"
                />
                <span>
                  I confirm this transition sends no automatic messages and changes no other
                  application. Applications that would are unsupported, not bypassed.
                </span>
              </label>
              <label className="flex min-w-0 items-start gap-3 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 shrink-0"
                  checked={ackPropose}
                  disabled={locked}
                  onChange={(e) => setAckPropose(e.target.checked)}
                  data-testid="stage-rules-checkbox-propose"
                />
                <span>
                  Save this proposal in Lexy only. A different employer admin must review it.
                  Nothing is sent to Zoho.
                </span>
              </label>
              <Button
                type="submit"
                size="sm"
                className="h-auto whitespace-normal"
                disabled={!canSubmitProposal}
                data-testid="stage-rules-button-propose"
              >
                {busy === "propose" ? "Saving…" : "Propose evidence (no send)"}
              </Button>
            </form>
          ) : !rule || rule.state === "revoked" || status === "stale" || status === "expired" ? (
            <p className="text-xs text-muted-foreground" data-testid="stage-rules-propose-blocked">
              Proposing is blocked: {w.reason}
            </p>
          ) : null}

          <div className="space-y-2" data-testid="stage-rules-history">
            <p className="text-sm font-medium">Audit history</p>
            {w.history.length === 0 ? (
              <p
                className="rounded border border-dashed p-2 text-xs text-muted-foreground"
                data-testid="stage-rules-history-empty"
              >
                No rule history yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {w.history.map((r) => (
                  <li key={`${r.id}:${r.revision}`}>
                    <RuleCard rule={r} now={now} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {notice && !failed && w && messageKey === currentMessageKey && (
        <p
          role="status"
          className="break-words rounded border border-primary/40 bg-primary/5 p-3 text-sm"
          data-testid="stage-rules-notice"
        >
          {notice}
        </p>
      )}
      {error && !failed && w && messageKey === currentMessageKey && (
        <p
          role="alert"
          className="break-words rounded border border-destructive/40 p-3 text-sm text-destructive"
          data-testid="stage-rules-error"
        >
          {error}
        </p>
      )}
    </section>
  );
}

function RuleCard({ rule, now, current }: { rule: ZohoStageRule; now: number; current?: boolean }) {
  const expired = rule.state === "verified" && rule.expiresAt !== null && rule.expiresAt <= now;
  const tid = current
    ? "stage-rules-current"
    : `stage-rules-history-row-${rule.id}-${rule.revision.slice(0, 8)}`;
  return (
    <div
      className="min-w-0 space-y-2 rounded border p-2 text-sm [overflow-wrap:anywhere]"
      data-testid={tid}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-full border border-dashed px-2 py-0.5 text-xs"
          data-testid={`${tid}-state`}
        >
          {expired ? "Verified, now expired" : (RULE_STATE[rule.state] ?? rule.state)}
        </span>
        {current && (
          <span className="font-mono text-[11px] text-muted-foreground">Current rule</span>
        )}
      </div>
      <p className="break-words">
        {DECISIONS[rule.decision] ?? rule.decision}: "{rule.currentStatus}" to "{rule.targetStatus}"
      </p>
      <dl className="grid min-w-0 gap-x-4 gap-y-1 font-mono text-xs sm:grid-cols-[auto_1fr]">
        {REF_FIELDS.map((f) => (
          <div key={f.key} className="contents">
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd className="break-all">{rule.evidence[f.key]}</dd>
          </div>
        ))}
        <dt className="text-muted-foreground">Field/Blueprint policy</dt>
        <dd className="break-all">{rule.evidence.requirements}</dd>
        <dt className="text-muted-foreground">Notification policy</dt>
        <dd className="break-all">{rule.evidence.notifications}</dd>
        <dt className="text-muted-foreground">Submitted</dt>
        <dd className="break-all">
          {rule.submittedBy} · {fmt(rule.submittedAt)}
        </dd>
        <dt className="text-muted-foreground">Verified</dt>
        <dd className="break-all">
          {rule.verifiedBy ? `${rule.verifiedBy} · ${fmt(rule.verifiedAt)}` : "Not verified"}
        </dd>
        {rule.reviewReference && (
          <>
            <dt className="text-muted-foreground">Review reference</dt>
            <dd className="break-all">{rule.reviewReference}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Expires</dt>
        <dd data-testid={`${tid}-expiry`}>
          {rule.expiresAt ? `${fmt(rule.expiresAt)}${expired ? " (expired)" : ""}` : "—"}
        </dd>
        {rule.revokedBy && (
          <>
            <dt className="text-muted-foreground">Revoked by</dt>
            <dd className="break-all">{rule.revokedBy}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Revision</dt>
        <dd className="break-all">{rule.revision.slice(0, 16)}</dd>
      </dl>
    </div>
  );
}
