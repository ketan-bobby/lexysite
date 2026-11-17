import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGreenhouseOfferWorkspaceQueryKey,
  getGetJobWorkflowStateQueryKey,
  useControlGreenhouseOfferWorkspace,
  useGetGreenhouseOfferWorkspace,
  type GreenhouseOfferWorkspace as Ws,
  type GreenhouseOfferWorkspaceInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { errText } from "./workflow-shared";
import { GreenhouseOfferHistory } from "./GreenhouseOfferHistory";
import {
  EMPTY_FORM,
  canApproveOp,
  canPrepare,
  canRecover,
  canSubmitOp,
  fromProposal as fromP,
  toProposal,
  type FieldType,
  type Form,
  type Row,
} from "@/lib/greenhouse-offer-fields";

const fromProposal = (p: Parameters<typeof fromP>[0]) => fromP(p, () => crypto.randomUUID());

type Action = GreenhouseOfferWorkspaceInput["action"];
const EMPTY = EMPTY_FORM;
const inputCls = "w-full rounded-md border border-border bg-background p-2 text-sm";
const rid = () => crypto.randomUUID();

const status = (e: unknown) => (e as { status?: number } | null)?.status;

function TermsReview({ ws, id }: { ws: Ws; id: string }) {
  const p = ws.proposal;
  const who = (pid: string) =>
    ws.people.find((x) => x.id === pid)?.name ?? `${pid} (unknown person)`;
  if (!p) return <p className="text-xs text-muted-foreground">No terms saved yet.</p>;
  const entries = Object.entries(p.values);
  return (
    <div
      className="space-y-1.5 rounded-md border border-border bg-muted/40 p-2 text-xs"
      data-testid={`gh-offer-review-${id}`}
    >
      <p className="font-medium">Saved local terms (human review)</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 [overflow-wrap:anywhere]">
        <dt className="text-muted-foreground">Opening ID</dt>
        <dd>{p.openingId ?? "Not set"}</dd>
        <dt className="text-muted-foreground">Start date</dt>
        <dd>{p.startDate ?? "Not set"}</dd>
        <dt className="text-muted-foreground">Financial approver</dt>
        <dd>{who(p.approverId)}</dd>
        <dt className="text-muted-foreground">Submitter</dt>
        <dd>{who(p.submitterId)}</dd>
      </dl>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">No named fields.</p>
      ) : (
        <ul className="divide-y divide-border rounded border border-border bg-background">
          {entries.map(([k, v]) => (
            <li
              key={k}
              className="flex flex-wrap justify-between gap-2 px-2 py-1 [overflow-wrap:anywhere]"
            >
              <span className="font-medium">{k}</span>
              <span className="font-mono">
                {typeof v === "object" ? `${v.amountMinor} minor units ${v.currency}` : String(v)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground">
        Field names are unverified local proposals. Employer Greenhouse field configuration is
        pending, so nothing here is checked against real Greenhouse custom fields.
      </p>
    </div>
  );
}

export function GreenhouseOfferWorkspace({
  jobId,
  workflowId,
  enabled,
}: {
  jobId: string;
  workflowId: string;
  enabled: boolean;
}) {
  const qc = useQueryClient();
  const key = getGetGreenhouseOfferWorkspaceQueryKey(jobId, workflowId);
  const q = useGetGreenhouseOfferWorkspace(jobId, workflowId, {
    query: { queryKey: key, retry: false, enabled, refetchOnMount: "always" },
  });
  const m = useControlGreenhouseOfferWorkspace();
  const ws = q.isError || q.failureReason ? undefined : q.data;
  const [form, setForm] = useState<Form>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [base, setBase] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rev = ws?.localRevision ?? null;
  const conflict = dirty && base !== null && rev !== null && rev !== base;
  useEffect(() => {
    if (!ws || dirty) return;
    setBase(ws.localRevision);
    setForm(fromProposal(ws.proposal));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rev, dirty, !!ws]);
  useEffect(() => {
    setConfirm(null);
    setAck(false);
  }, [
    rev,
    ws?.controlRevision,
    ws?.attempt?.revision,
    ws?.attempt?.state,
    ws?.canApprove,
    ws?.canSubmit,
    ws?.executionMode,
    dirty,
    enabled,
  ]);

  if (!enabled) return null;
  if (q.isLoading || q.isFetching)
    return (
      <div
        className="h-16 animate-pulse rounded-md bg-muted"
        data-testid={`gh-offer-loading-${workflowId}`}
      />
    );
  if (q.isError || q.failureReason || !ws) {
    const failure = q.error ?? q.failureReason;
    const s = status(failure);
    return (
      <div className="space-y-1 border-t pt-2 text-sm" data-testid={`gh-offer-error-${workflowId}`}>
        <p role="alert" className="text-destructive">
          {s === 403
            ? "You do not have access to the Greenhouse offer workspace for this candidate."
            : s === 404
              ? "No Greenhouse offer workspace exists for this workflow."
              : `Could not load the Greenhouse offer workspace. ${errText(failure)}`}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => q.refetch()}
          data-testid={`gh-offer-retry-${workflowId}`}
        >
          Retry
        </Button>
      </div>
    );
  }

  const busy = m.isPending;
  const stale = base !== null && base !== ws.localRevision;
  const providerOff =
    ws.executionMode === "unavailable" || ws.blockers.length > 0 || !ws.controlRevision;
  const att = ws.attempt;
  const set = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setDirty(true);
  };
  const setRow = (id: string, patch: Partial<Row>) =>
    set({ rows: form.rows.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const run = (action: Action) => {
    setError(null);
    setNotice(null);
    const allowed =
      action === "save"
        ? ws.canEdit
        : action === "prepare"
          ? canPrepare(ws)
          : action === "approve"
            ? canApproveOp(ws)
            : action === "submit"
              ? canSubmitOp(ws)
              : canRecover(ws);
    if (!allowed) {
      setError("This action is no longer available. Reload and review the current workspace.");
      return;
    }
    if (action !== "save" && (dirty || stale)) {
      setError("Save or discard edits and reload the latest workspace first.");
      return;
    }
    const data: GreenhouseOfferWorkspaceInput = {
      action,
      expectedLocalRevision: action === "save" ? (base ?? ws.localRevision) : ws.localRevision,
      idempotencyKey: crypto.randomUUID(),
      confirm: true,
    };
    if (action === "save") {
      const r = toProposal(form);
      if (!r.proposal) return setError(r.error ?? "Check the fields.");
      data.proposal = r.proposal;
    } else {
      if (ws.controlRevision) data.expectedControlRevision = ws.controlRevision;
      if (action !== "prepare") {
        if (!att) return setError("No attempt to act on. Reload the workspace.");
        data.attemptId = att.id;
      }
    }
    m.mutate(
      { jobId, workflowId, data },
      {
        onSuccess: (next) => {
          qc.setQueryData(key, next);
          setBase(next.localRevision);
          setForm(fromProposal(next.proposal));
          setDirty(false);
          setConfirm(null);
          setAck(false);
          setNotice(
            action === "save"
              ? "Local terms saved. Nothing was sent to Greenhouse or the candidate."
              : action === "submit"
                ? next.executionMode !== "controlled"
                  ? "Simulation submission recorded. No candidate received anything."
                  : next.attempt?.state === "verified_submission"
                    ? "Greenhouse draft and internal approval submission verified. No candidate offer was sent."
                    : next.attempt?.state === "not_sent"
                      ? "No new Greenhouse submission was made. Review the saved attempt status."
                      : "The submission needs human review. Do not submit again; use the read-only status check. No candidate-delivery action was requested."
                : `${action} recorded. Check the attempt state below.`,
          );
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
        },
        onError: (e) => {
          setError(errText(e));
          qc.invalidateQueries({ queryKey: key });
        },
      },
    );
  };

  const opBtn = (a: Action, label: string, allowed: boolean) => (
    <Button
      size="sm"
      variant="outline"
      disabled={busy || dirty || stale || !allowed}
      onClick={() => (a === "approve" || a === "submit" ? setConfirm(a) : run(a))}
      data-testid={`gh-offer-${a}-${workflowId}`}
    >
      {label}
    </Button>
  );

  return (
    <section
      className="min-w-0 space-y-2 border-t border-border pt-2 text-xs"
      aria-label="Greenhouse offer workspace"
      data-testid={`gh-offer-${workflowId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Greenhouse offer workspace</p>
        <Badge variant="destructive" data-testid={`gh-offer-local-${workflowId}`}>
          LOCAL DRAFT
        </Badge>
        <Badge variant="outline">
          {ws.executionMode === "controlled"
            ? "Human-controlled provider configured"
            : ws.executionMode === "simulated"
              ? "Simulation only"
              : "Connection unavailable"}
        </Badge>
      </div>
      <p className="text-muted-foreground">
        {ws.executionMode === "controlled"
          ? "Saving and approving these terms stays local. Only a separate confirmed submission creates or versions a Greenhouse draft and may email internal approvers. It never sends an offer to the candidate. Employer HR retains financial approval, negotiation and candidate-delivery authority."
          : "These financial terms are stored in Lexy only. They are not sent to Greenhouse or to the candidate. Employer HR keeps financial and delivery authority; Lexy only records what people write and approve."}
      </p>

      {conflict && (
        <div
          role="alertdialog"
          aria-label="Saved terms changed"
          className="space-y-2 rounded-md border border-destructive p-2"
          data-testid={`gh-offer-conflict-${workflowId}`}
        >
          <p className="font-medium text-destructive">
            Someone saved different terms while you were editing.
          </p>
          <TermsReview ws={ws} id={`${workflowId}-latest`} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setBase(ws.localRevision)}
              data-testid={`gh-offer-keep-${workflowId}`}
              className="h-auto max-w-full whitespace-normal py-2 text-left"
            >
              Keep my edits (I reviewed the new terms; save replaces them)
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDirty(false);
                setError(null);
              }}
              data-testid={`gh-offer-discard-conflict-${workflowId}`}
            >
              Discard my edits
            </Button>
          </div>
        </div>
      )}

      <TermsReview ws={ws} id={workflowId} />

      {ws.canEdit ? (
        <div className="space-y-2 rounded-md border border-border p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="space-y-0.5">
              <span>Opening ID (optional)</span>
              <input
                className={inputCls}
                maxLength={128}
                value={form.openingId}
                disabled={busy}
                onChange={(e) => set({ openingId: e.target.value })}
                data-testid={`gh-offer-opening-${workflowId}`}
              />
            </label>
            <label className="space-y-0.5">
              <span>Start date (optional)</span>
              <input
                type="date"
                className={inputCls}
                value={form.startDate}
                disabled={busy}
                onChange={(e) => set({ startDate: e.target.value })}
                data-testid={`gh-offer-start-${workflowId}`}
              />
            </label>
            {(["approverId", "submitterId"] as const).map((k) => (
              <label key={k} className="space-y-0.5">
                <span>{k === "approverId" ? "Financial approver" : "Submitter"}</span>
                <select
                  className={inputCls}
                  value={form[k]}
                  disabled={busy}
                  onChange={(e) => set({ [k]: e.target.value })}
                  data-testid={`gh-offer-${k}-${workflowId}`}
                >
                  <option value="">Choose a person</option>
                  {ws.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {form[k] && !ws.people.some((p) => p.id === form[k]) && (
                    <option value={form[k]}>{form[k]} (no longer eligible)</option>
                  )}
                </select>
              </label>
            ))}
          </div>
          <div className="space-y-1">
            <p className="font-medium">Named fields</p>
            <p className="text-muted-foreground">
              Add only fields HR asked for. Currency amounts are whole integer minor units: 8750000
              USD means $87,500.00.
            </p>
            {form.rows.map((r) => (
              <div
                key={r.id}
                className="grid grid-cols-2 gap-1 sm:grid-cols-[1.2fr_0.8fr_1.2fr_0.6fr_auto]"
                data-testid={`gh-offer-row-${r.id}`}
              >
                <input
                  className={inputCls}
                  placeholder="Field name"
                  maxLength={128}
                  value={r.name}
                  disabled={busy}
                  onChange={(e) => setRow(r.id, { name: e.target.value })}
                  aria-label="Field name"
                />
                <select
                  className={inputCls}
                  value={r.type}
                  disabled={busy}
                  onChange={(e) => setRow(r.id, { type: e.target.value as FieldType })}
                  aria-label="Field type"
                >
                  <option value="text">Text</option>
                  <option value="number">Number</option>
                  <option value="currency">Currency (minor units)</option>
                </select>
                <input
                  className={inputCls}
                  inputMode={r.type === "text" ? "text" : "numeric"}
                  placeholder={r.type === "currency" ? "Integer minor units" : "Value"}
                  value={r.value}
                  disabled={busy}
                  onChange={(e) => setRow(r.id, { value: e.target.value })}
                  aria-label="Value"
                />
                {r.type === "currency" ? (
                  <input
                    className={inputCls}
                    placeholder="USD"
                    maxLength={3}
                    value={r.currency}
                    disabled={busy}
                    onChange={(e) => setRow(r.id, { currency: e.target.value.toUpperCase() })}
                    aria-label="Currency code"
                  />
                ) : (
                  <span />
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => set({ rows: form.rows.filter((x) => x.id !== r.id) })}
                  aria-label="Remove field"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                set({
                  rows: [
                    ...form.rows,
                    { id: rid(), name: "", type: "text", value: "", currency: "" },
                  ],
                })
              }
              data-testid={`gh-offer-add-field-${workflowId}`}
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add field
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !dirty || conflict}
              onClick={() => run("save")}
              data-testid={`gh-offer-save-${workflowId}`}
            >
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Save local terms
            </Button>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setDirty(false);
                  setError(null);
                }}
                data-testid={`gh-offer-discard-${workflowId}`}
              >
                Discard edits
              </Button>
            )}
          </div>
          {dirty && (
            <p className="text-muted-foreground">
              Unsaved edits: prepare, approve, submit and recover are disabled.
            </p>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground">Read-only: you cannot edit these terms.</p>
      )}

      {stale && !dirty && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-destructive">
          <span>The saved workspace changed. Reload before taking any action.</span>
          <Button size="sm" variant="outline" onClick={() => setBase(ws.localRevision)}>
            Reload latest
          </Button>
        </div>
      )}

      <div
        className="space-y-1.5 rounded-md border border-border p-2"
        data-testid={`gh-offer-control-${workflowId}`}
      >
        <p className="font-medium">Provider operations</p>
        <p role="status" data-testid={`gh-offer-attempt-${workflowId}`}>
          {att
            ? `Current attempt ${att.id}: ${att.state.replace(/_/g, " ")}.`
            : "No attempt has been started."}
        </p>
        {providerOff && (
          <div className="text-muted-foreground">
            <p>
              {ws.executionMode === "unavailable"
                ? "No employer-approved Greenhouse connection is ready. Prepare, approve and submit are unavailable."
                : "Operations are blocked until the server reports readiness."}
            </p>
            {ws.blockers.length > 0 && (
              <ul className="list-disc pl-4">
                {ws.blockers.map((b) => (
                  <li key={b} className="[overflow-wrap:anywhere]">
                    {b}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {opBtn("prepare", "Prepare", canPrepare(ws))}
          {opBtn("approve", "Approve financial terms", canApproveOp(ws))}
          {opBtn(
            "submit",
            ws.executionMode === "controlled"
              ? "Submit to Greenhouse approval"
              : "Submit simulation",
            canSubmitOp(ws),
          )}
          {canRecover(ws) && opBtn("recover", "Check attempt status (read-only recovery)", true)}
        </div>
      </div>

      <GreenhouseOfferHistory history={ws.history} />

      {confirm && (
        <div
          role="alertdialog"
          aria-label={`Confirm ${confirm}`}
          className="space-y-2 rounded-md border border-border bg-muted p-2"
          data-testid={`gh-offer-confirm-${workflowId}`}
        >
          <TermsReview ws={ws} id={`${workflowId}-confirm`} />
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
              data-testid={`gh-offer-ack-${workflowId}`}
            />
            <span>
              {confirm === "approve"
                ? "I reviewed these exact financial terms and roles and approve them under my name."
                : ws.executionMode === "controlled"
                  ? "I authorize creating or versioning these exact terms in Greenhouse and requesting internal approval, which may email employer approvers. This does not send an offer to the candidate."
                  : "I understand this records a simulation submission. It is not sent to the candidate and does not create a Greenhouse offer."}
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!ack || busy}
              onClick={() => run(confirm)}
              data-testid={`gh-offer-confirm-action-${workflowId}`}
            >
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {confirm === "approve"
                ? "Confirm financial approval"
                : ws.executionMode === "controlled"
                  ? "Confirm Greenhouse submission"
                  : "Confirm simulation submission"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Back
            </Button>
          </div>
        </div>
      )}

      {notice && (
        <p role="status" data-testid={`gh-offer-notice-${workflowId}`}>
          {notice}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="text-destructive"
          data-testid={`gh-offer-action-error-${workflowId}`}
        >
          {error}
        </p>
      )}
    </section>
  );
}
