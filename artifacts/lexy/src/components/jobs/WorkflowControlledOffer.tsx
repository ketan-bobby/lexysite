import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateWorkflowOfferQueryKey,
  getGetJobWorkflowStateQueryKey,
  useControlCandidateWorkflowOffer,
  useGetCandidateWorkflowOffer,
  type ControlledOffer,
  type ControlledOfferInput,
  type ControlledOfferTerms,
  getGetEmployerOfferInboxItemQueryKey,
  getGetEmployerOfferInboxQueryKey,
  type PlannedCandidateWorkflow,
} from "@workspace/api-client-react";
import { getGetCandidateOfferRoutingQueryKey } from "@workspace/api-client-react";
import { DeliveryReconcilePanel, ReconciliationSummary } from "./DeliveryReconcilePanel";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { ErrorLine, errText, useIdempotency } from "./workflow-shared";
import { offerDraftSync } from "@/lib/offer-draft-sync";
import { OfferDraftConflict } from "./OfferDraftConflict";
import { OfferReplacementNotice } from "./OfferReplacementNotice";
import { offerDraftAvailability } from "@/lib/offer-draft-availability";
import { validateOfferTerms, type OfferTermsForm } from "@/lib/offer-terms-validation";
import { canControlOffer } from "@/lib/offer-action-availability";

type Action = ControlledOfferInput["action"];
type Form = OfferTermsForm;
const EMPTY: Form = {
  employerName: "",
  roleTitle: "",
  amount: "",
  currency: "USD",
  frequency: "annual",
  location: "",
  startDate: "",
  expiresAt: "",
  letter: "",
};
const FIELDS: { key: keyof Form; label: string; type?: string }[] = [
  { key: "employerName", label: "Employer name" },
  { key: "roleTitle", label: "Role title" },
  { key: "amount", label: "Amount", type: "number" },
  { key: "currency", label: "Currency (3 letters)" },
  { key: "frequency", label: "Pay frequency" },
  { key: "location", label: "Location" },
  { key: "startDate", label: "Start date", type: "date" },
  { key: "expiresAt", label: "Offer expires", type: "datetime-local" },
];
const STATUS_TEXT: Record<string, string> = {
  draft: "Draft: not submitted for review.",
  review_required: "Waiting for approver review.",
  approved: "Approved for this version. Nothing has been sent yet.",
  sending: "Sending in progress. Editing is locked.",
  sent: "Sent to the candidate. This is not an acceptance.",
  accepted: "Candidate accepted this offer. This is not confirmed employment and creates no fee.",
  declined: "Candidate declined this offer.",
  expired: "The offer expired without a response.",
  withdrawn: "Withdrawn: the candidate link no longer works.",
  send_uncertain:
    "Delivery is uncertain. Review delivery with the provider; do not resend blindly.",
};
const LOCKED = ["sending", "sent", "accepted", "declined", "send_uncertain"];
const CLOSED = ["accepted", "declined", "expired", "withdrawn"];

const toLocal = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromTerms = (t: ControlledOfferTerms): Form => ({
  employerName: t.employerName,
  roleTitle: t.roleTitle,
  amount: String(t.amount),
  currency: t.currency,
  frequency: t.frequency,
  location: t.location,
  startDate: t.startDate,
  expiresAt: toLocal(t.expiresAt),
  letter: t.letter,
});

function TermsView({ o, id }: { o: ControlledOffer; id: string }) {
  const t = o.terms;
  return (
    <div
      className="space-y-1 rounded-md border border-border p-2 text-sm print:border-0"
      data-testid={`controlled-offer-terms-${id}`}
    >
      <p>
        <b>{t.roleTitle}</b> at {t.employerName}, {t.location}
      </p>
      <p>
        {t.amount} {t.currency} {t.frequency}; starts {t.startDate}; expires{" "}
        {new Date(t.expiresAt).toLocaleString()}
      </p>
      <p className="whitespace-pre-wrap text-xs [overflow-wrap:anywhere]">{t.letter}</p>
    </div>
  );
}

type OfferProps = {
  wf: Pick<PlannedCandidateWorkflow, "id">;
  jobId: string;
};

export function WorkflowControlledOffer(props: OfferProps) {
  return <ControlledOfferEditor key={`${props.jobId}:${props.wf.id}`} {...props} />;
}

function ControlledOfferEditor({ wf, jobId }: OfferProps) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const q = useGetCandidateWorkflowOffer(jobId, wf.id, {
    query: {
      queryKey: getGetCandidateWorkflowOfferQueryKey(jobId, wf.id),
      refetchInterval: (query) => {
        if (query.state.data?.offer?.deliveryAttemptId) return 8000;
        const s = query.state.data?.offer?.status;
        return s === "sending" ||
          s === "send_uncertain" ||
          s === "sent" ||
          s === "approved" ||
          s === "draft" ||
          s === "review_required"
          ? 8000
          : 15_000;
      },
    },
  });
  const m = useControlCandidateWorkflowOffer({});
  const st = q.data;
  const offer = st?.offer ?? null;
  const [form, setForm] = useState<Form>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [letterOk, setLetterOk] = useState(false);
  const [baseOfferKey, setBaseOfferKey] = useState<string | null>(null);
  const [replacementKey, setReplacementKey] = useState<string | null>(null);

  const offerKey = offer ? `${offer.id}:${offer.version}` : "none";
  const sync = offerDraftSync(baseOfferKey, offerKey, dirty);
  const draftConflict = sync === "conflict";
  useEffect(() => {
    if (!st || sync !== "sync") return;
    setBaseOfferKey(offerKey);
    setForm(offer ? fromTerms(offer.terms) : EMPTY);
    setDirty(false);
  }, [st, offer, offerKey, sync]);
  const sig = useMemo(
    () =>
      JSON.stringify([
        form,
        reason,
        offerKey,
        offer?.status,
        st?.workflowRevision,
        st?.eligible,
        st?.canEdit,
        st?.canApprove,
        st?.canSend,
        st?.canWithdraw,
      ]),
    [form, reason, offerKey, offer, st],
  );
  useEffect(() => {
    setConfirm(null);
  }, [sig]);
  useEffect(() => {
    setLetterOk(false);
  }, [confirm, offerKey]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getGetCandidateWorkflowOfferQueryKey(jobId, wf.id) });
    qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
    qc.invalidateQueries({ queryKey: getGetCandidateOfferRoutingQueryKey(jobId, wf.id) });
    qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxQueryKey() });
    qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxItemQueryKey(wf.id) });
  };

  if (q.isLoading)
    return (
      <div
        className="h-12 animate-pulse rounded-md bg-muted"
        data-testid={`controlled-offer-loading-${wf.id}`}
      />
    );
  if (q.isError || !st)
    return (
      <div className="space-y-1 text-sm" data-testid={`controlled-offer-error-${wf.id}`}>
        <p role="alert" className="text-destructive">
          Could not load the offer. {errText(q.error)}
        </p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    );
  if (!offer && !st.eligible && st.history.length === 0)
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid={`controlled-offer-ineligible-${wf.id}`}
      >
        Offer preparation unavailable{st.reason ? `: ${st.reason}` : "."}
      </p>
    );

  const status = offer?.status;
  const locked = !!status && LOCKED.includes(status);
  const closed = !!status && CLOSED.includes(status);
  const draftMode = offerDraftAvailability(status, st.canEdit, st.eligible);
  const replacing = draftMode === "replace";
  const replacementStarted =
    replacing && (replacementKey === offerKey || (dirty && replacementKey !== null));
  const canDraft = draftMode === "edit" || replacementStarted;
  const setF = (k: keyof Form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };
  const reasonOk = reason.trim().length >= 10;
  const resolveDraft = (keep: boolean) => {
    setBaseOfferKey(offerKey);
    setReplacementKey(keep && replacing ? offerKey : null);
    if (!keep) {
      setForm(offer ? fromTerms(offer.terms) : EMPTY);
      setDirty(false);
    }
    setConfirm(null);
    setLetterOk(false);
    setError(null);
  };

  const run = (action: Action) => {
    setError(null);
    if (!canControlOffer(action, st)) {
      setError(st.reason ?? "This offer action is no longer available to you. Refresh and review.");
      return;
    }
    if (draftConflict) {
      setError("Review the changed saved offer and resolve the draft conflict first.");
      return;
    }
    if (action === "approve" && !letterOk) {
      setError("Confirm that the letter matches the structured terms.");
      return;
    }
    if (dirty && action !== "save_draft") {
      setError("Save or discard your edits first.");
      return;
    }
    const data: ControlledOfferInput = {
      action,
      idempotencyKey: idem.get(
        `${wf.id}:${st.workflowRevision}:${offerKey}:${action}:${action === "save_draft" ? JSON.stringify(form) : reason}`,
      ),
      expectedRevision: st.workflowRevision,
    };
    if (action === "save_draft") {
      const v = validateOfferTerms(form);
      if (!v.terms) {
        setError(v.error ?? "Check the terms.");
        return;
      }
      data.terms = v.terms;
    }
    if (action === "withdraw") data.reason = reason.trim();
    m.mutate(
      { jobId, workflowId: wf.id, data },
      {
        onSuccess: (saved) => {
          qc.setQueryData(getGetCandidateWorkflowOfferQueryKey(jobId, wf.id), saved);
          idem.clear();
          setConfirm(null);
          setReason("");
          setDirty(false);
          setReplacementKey(null);
          setBaseOfferKey(saved.offer ? `${saved.offer.id}:${saved.offer.version}` : "none");
          setForm(saved.offer ? fromTerms(saved.offer.terms) : EMPTY);
          refresh();
        },
        onError: (e) => {
          setError(errText(e));
          refresh();
        },
      },
    );
  };

  const needsConfirm = (a: Action) => a === "approve" || a === "send" || a === "withdraw";
  const click = (a: Action) => (needsConfirm(a) ? setConfirm(a) : run(a));
  const btn = (a: Action, label: string, extra = false) => (
    <Button
      size="sm"
      variant={a === "withdraw" ? "destructive" : "outline"}
      disabled={m.isPending || draftConflict || !canControlOffer(a, st) || extra}
      onClick={() => click(a)}
      data-testid={`offer-action-${a}-${wf.id}`}
    >
      {label}
    </Button>
  );
  const hasUnsaved = dirty;
  const prev = offer
    ? st.history
        .filter((h) => h.id === offer.id && h.version < offer.version)
        .sort((a, b) => b.version - a.version)[0]
    : undefined;
  const sameLetterChanged =
    !!offer &&
    !!prev &&
    prev.terms.letter === offer.terms.letter &&
    (
      [
        "amount",
        "currency",
        "frequency",
        "startDate",
        "expiresAt",
        "employerName",
        "roleTitle",
        "location",
      ] as const
    ).some((k) => prev.terms[k] !== offer.terms[k]);
  const draftLetterSame =
    !!offer &&
    dirty &&
    form.letter.trim() === offer.terms.letter &&
    (form.amount !== String(offer.terms.amount) ||
      form.currency !== offer.terms.currency ||
      form.frequency !== offer.terms.frequency ||
      form.startDate !== offer.terms.startDate ||
      form.expiresAt !== toLocal(offer.terms.expiresAt));
  const list = [
    ...(offer ? [offer] : []),
    ...st.history.filter((h) => !offer || h.id !== offer.id || h.version !== offer.version),
  ];

  return (
    <section
      className="min-w-0 space-y-2 border-t border-border pt-2"
      data-testid={`controlled-offer-${wf.id}`}
      aria-label="Controlled offer"
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Controlled offer</p>
        {offer && (
          <Badge variant="outline" data-testid={`controlled-offer-status-${wf.id}`}>
            {status!.replace("_", " ")}
          </Badge>
        )}
        {offer && <span className="text-xs text-muted-foreground">version {offer.version}</span>}
        {offer?.testOnly && (
          <Badge variant="destructive" data-testid={`controlled-offer-test-only-${wf.id}`}>
            TEST ONLY
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        A workflow Hire decision only allows offer preparation; it is not a confirmed hire. The
        letter is manual, employer-approved text; nothing is generated.
      </p>
      {draftConflict && (
        <OfferDraftConflict
          workflowId={wf.id}
          pending={m.isPending}
          onKeep={() => resolveDraft(true)}
          onDiscard={() => resolveDraft(false)}
        >
          {offer ? (
            <TermsView o={offer} id={`${wf.id}-latest`} />
          ) : (
            <p className="text-xs">There is currently no saved offer.</p>
          )}
        </OfferDraftConflict>
      )}
      {offer && (
        <p className="text-xs" role="status" data-testid={`controlled-offer-status-text-${wf.id}`}>
          {STATUS_TEXT[status!]}
        </p>
      )}
      {offer && (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`controlled-offer-approval-${wf.id}`}
        >
          Prepared by {offer.createdBy} {new Date(offer.createdAt).toLocaleString()}
          {offer.approvedBy &&
            ` · approved by ${offer.approvedBy}${offer.approvedAt ? ` ${new Date(offer.approvedAt).toLocaleString()}` : ""}`}
          {offer.sentAt && ` · sent ${new Date(offer.sentAt).toLocaleString()}`}
          {offer.respondedAt && ` · responded ${new Date(offer.respondedAt).toLocaleString()}`}
        </p>
      )}
      {offer?.responseReason && (
        <p className="text-xs [overflow-wrap:anywhere]">Candidate reason: {offer.responseReason}</p>
      )}
      {offer?.deliveryAttemptId && (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          data-testid={`controlled-offer-provider-delivery-${wf.id}`}
        >
          {offer.providerDelivery
            ? `AWS email status: ${offer.providerDelivery.status} · ${new Date(offer.providerDelivery.occurredAt).toLocaleString()}. `
            : "No provider delivery-event confirmation received. "}
          Delivery means the receiving mail server accepted the email—not that the candidate read
          it.
          {offer.providerDelivery &&
            ["delayed", "bounced", "rejected", "complained"].includes(
              offer.providerDelivery.status,
            ) &&
            " Review the delivery issue; Lexy will not automatically resend this offer."}
          {["sending", "send_uncertain"].includes(status!) &&
            " The send remains held pending human reconciliation."}
        </p>
      )}
      {sameLetterChanged && (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid={`controlled-offer-letter-stale-${wf.id}`}
        >
          Structured terms changed from the previous version but the letter text is identical.
          Update or recheck the letter before approving.
        </p>
      )}
      {offer && (locked || closed || !canDraft) && <TermsView o={offer} id={wf.id} />}
      {replacing && (
        <OfferReplacementNotice
          workflowId={wf.id}
          preparing={replacementStarted}
          pending={m.isPending || draftConflict}
          onPrepare={() => {
            if (!offer) return;
            setReplacementKey(offerKey);
            setForm({ ...fromTerms(offer.terms), expiresAt: "" });
            setConfirm(null);
            setLetterOk(false);
            setError(null);
          }}
        />
      )}
      {!st.eligible && st.reason && (
        <p role="status" className="text-xs text-muted-foreground">
          Offer preparation, review and sending unavailable: {st.reason}
        </p>
      )}
      {offer?.deliveryReconciliation && status !== "send_uncertain" && (
        <ReconciliationSummary rec={offer.deliveryReconciliation} id={wf.id} />
      )}
      {offer && status === "send_uncertain" && (
        <DeliveryReconcilePanel
          wfId={wf.id}
          jobId={jobId}
          offer={offer}
          revision={st.workflowRevision}
          canReconcile={!!st.canReconcile}
          onDone={refresh}
        />
      )}
      {!st.canEdit && !st.canApprove && !st.canSend && !st.canWithdraw && (
        <p className="text-xs text-muted-foreground">
          Read-only: you are not a designated owner, approver or sender for this offer.
        </p>
      )}

      {canDraft && (
        <div className="grid gap-2 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="min-w-0 space-y-0.5 text-xs">
              <span>{f.label}</span>
              {f.key === "frequency" ? (
                <select
                  className="w-full rounded-md border border-border bg-background p-2 text-sm"
                  value={form.frequency}
                  onChange={(e) => setF("frequency", e.target.value)}
                  disabled={m.isPending}
                  data-testid={`offer-field-frequency-${wf.id}`}
                >
                  <option value="hourly">Hourly</option>
                  <option value="monthly">Monthly</option>
                  <option value="annual">Annual</option>
                </select>
              ) : (
                <input
                  className="w-full rounded-md border border-border bg-background p-2 text-sm"
                  type={f.type ?? "text"}
                  step={f.key === "amount" ? "any" : undefined}
                  value={form[f.key]}
                  disabled={m.isPending}
                  maxLength={f.key === "currency" ? 3 : undefined}
                  onChange={(e) =>
                    setF(
                      f.key,
                      f.key === "currency" ? e.target.value.toUpperCase() : e.target.value,
                    )
                  }
                  data-testid={`offer-field-${f.key}-${wf.id}`}
                />
              )}
            </label>
          ))}
          <label className="min-w-0 space-y-0.5 text-xs sm:col-span-2">
            <span>Offer letter (manual text, 10 to 12000 characters)</span>
            <textarea
              className="w-full rounded-md border border-border bg-background p-2 text-sm"
              rows={6}
              maxLength={12000}
              value={form.letter}
              onChange={(e) => setF("letter", e.target.value)}
              disabled={m.isPending}
              data-testid={`offer-field-letter-${wf.id}`}
            />
          </label>
          {draftLetterSame && (
            <p
              role="alert"
              className="text-xs text-destructive sm:col-span-2"
              data-testid={`controlled-offer-letter-same-${wf.id}`}
            >
              You changed structured terms but not the letter. Editing terms does not rewrite the
              letter; update or recheck it.
            </p>
          )}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Saving changed terms creates a new version and invalidates any approval.
          </p>
        </div>
      )}

      {(st.canEdit || st.canApprove || st.canSend || st.canWithdraw) && (
        <div className="flex flex-wrap items-center gap-2">
          {canDraft &&
            btn(
              "save_draft",
              replacing ? "Save fresh draft" : offer ? "Save new version" : "Save draft",
            )}
          {st.canEdit &&
            offer &&
            status === "draft" &&
            btn("submit_review", "Submit for review", hasUnsaved)}
          {st.canApprove &&
            offer &&
            status === "review_required" &&
            btn("approve", "Approve", hasUnsaved)}
          {st.canSend &&
            offer &&
            status === "approved" &&
            btn("send", "Send to candidate", hasUnsaved)}
          {st.canWithdraw &&
            offer &&
            ["draft", "review_required", "approved", "sent", "send_uncertain"].includes(status!) &&
            btn("withdraw", "Withdraw", !reasonOk && false)}
          <Button
            size="sm"
            variant="ghost"
            className="print:hidden"
            onClick={() => window.print()}
            data-testid={`controlled-offer-print-${wf.id}`}
          >
            Print terms
          </Button>
        </div>
      )}
      {hasUnsaved && offer && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
          data-testid={`controlled-offer-dirty-${wf.id}`}
        >
          <span>
            Unsaved edits: approve, send and submit are disabled. Saving creates a new version and
            invalidates approval.
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={m.isPending}
            data-testid={`offer-action-discard-${wf.id}`}
            onClick={() => resolveDraft(false)}
          >
            Discard edits
          </Button>
        </div>
      )}

      {st.canWithdraw &&
        offer &&
        ["draft", "review_required", "approved", "sent", "send_uncertain"].includes(status!) && (
          <label className="block space-y-0.5 text-xs">
            <span>Withdraw reason (10 or more characters, required to withdraw)</span>
            <textarea
              className="w-full rounded-md border border-border bg-background p-2 text-sm"
              rows={2}
              maxLength={4000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              data-testid={`offer-field-reason-${wf.id}`}
            />
          </label>
        )}

      {confirm && offer && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm"
          role="alertdialog"
          aria-label={`Confirm ${confirm}`}
          data-testid={`offer-confirm-${wf.id}`}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {confirm === "approve" &&
              `Approve version ${offer.version} under your name? Any later edit invalidates this approval.`}
            {confirm === "send" &&
              `Send version ${offer.version} to ${offer.recipientEmail}? The recipient is fixed and this version cannot be edited after sending.`}
            {confirm === "withdraw" &&
              (reasonOk
                ? `Withdraw version ${offer.version}? The candidate link stops working.`
                : "Enter a withdraw reason of at least 10 characters first.")}
          </span>
          {confirm === "send" && offer.testOnly && (
            <p
              className="w-full text-xs font-semibold text-destructive"
              data-testid={`offer-confirm-test-only-${wf.id}`}
            >
              TEST ONLY: this is a test offer, not a real employment offer.
            </p>
          )}
          {confirm === "approve" && (
            <div className="w-full space-y-2" data-testid={`offer-approve-review-${wf.id}`}>
              <TermsView o={offer} id={`${wf.id}-approve`} />
              <p className="text-xs text-muted-foreground">
                Editing salary, currency, frequency, dates or other structured terms does not
                rewrite the letter. The letter is manual text and is not checked automatically.
              </p>
              <textarea
                readOnly
                rows={6}
                value={offer.terms.letter}
                aria-label="Saved letter (read-only)"
                className="w-full rounded-md border border-border bg-muted p-2 text-xs"
                data-testid={`offer-approve-letter-${wf.id}`}
              />
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={letterOk}
                  onChange={(e) => setLetterOk(e.target.checked)}
                  data-testid={`offer-approve-letter-check-${wf.id}`}
                />
                <span>
                  I reviewed the letter and it matches the salary, currency, frequency, start date
                  and expiry shown above.
                </span>
              </label>
            </div>
          )}
          <Button
            size="sm"
            disabled={
              m.isPending ||
              draftConflict ||
              !canControlOffer(confirm, st) ||
              (confirm === "withdraw" && !reasonOk) ||
              (confirm === "approve" && !letterOk)
            }
            onClick={() => run(confirm)}
            data-testid={`offer-confirm-action-${wf.id}`}
          >
            {m.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Confirm {confirm}
          </Button>
          <Button size="sm" variant="ghost" disabled={m.isPending} onClick={() => setConfirm(null)}>
            Back
          </Button>
        </div>
      )}
      <ErrorLine message={error} testId={`controlled-offer-action-error-${wf.id}`} />

      {list.length > 0 && (
        <div className="space-y-1" data-testid={`controlled-offer-history-${wf.id}`}>
          <p className="text-xs font-medium">Offer history</p>
          {list.map((h) => (
            <details
              key={`${h.id}-${h.version}`}
              className="rounded-md border border-border p-2 text-xs"
            >
              <summary className="cursor-pointer">
                Version {h.version} · {h.status.replace("_", " ")} ·{" "}
                {new Date(h.createdAt).toLocaleString()}
                {h.testOnly && " · TEST ONLY"}
              </summary>
              <TermsView o={h} id={`${wf.id}-${h.version}`} />
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
