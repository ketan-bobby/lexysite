import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateOfferRoutingQueryKey,
  getGetCandidateWorkflowOfferQueryKey,
  getGetJobWorkflowStateQueryKey,
  useConfigureCandidateOfferRouting,
  useGetCandidateOfferRouting,
  useGetCandidateWorkflowOffer,
  type OfferRoutingInput,
  type OfferRoutingState,
  getGetEmployerOfferInboxItemQueryKey,
  getGetEmployerOfferInboxQueryKey,
  type PlannedCandidateWorkflow,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { WorkflowAtsHandoff } from "./WorkflowAtsHandoff";
import { ErrorLine, errText, useIdempotency } from "./workflow-shared";

type Mode = "native" | "external";
type Form = {
  mode: Mode;
  ownerUserId: string;
  approverUserId: string;
  senderUserId: string;
  externalSystem: string;
  externalApplicationUrl: string;
};
const EMPTY: Form = {
  mode: "native",
  ownerUserId: "",
  approverUserId: "",
  senderUserId: "",
  externalSystem: "",
  externalApplicationUrl: "",
};
const HANDOFF: Record<string, string> = {
  unconfigured: "Not configured: no one owns the offer yet.",
  native: "Native Lexy offer ownership.",
  awaiting_hiring_decision: "Waiting for a human hiring decision.",
  awaiting_employer:
    "Awaiting employer: manual handoff after an explicit Hire. Lexy is not connected to or synced with the employer system.",
  paused: "Paused: hold or decline decision. No handoff.",
};
const inputCls = "w-full rounded-md border border-border bg-background p-2 text-sm";

function fromConfig(s: OfferRoutingState): Form {
  const c = s.configuration;
  if (!c) return EMPTY;
  const ids = new Set(s.people.map((p) => p.id));
  const ok = (v: string | null) => (v && ids.has(v) ? v : "");
  return {
    mode: c.mode,
    ownerUserId: ok(c.ownerUserId),
    approverUserId: ok(c.approverUserId),
    senderUserId: ok(c.senderUserId),
    externalSystem: c.externalSystem ?? "",
    externalApplicationUrl: c.externalApplicationUrl ?? "",
  };
}

export function WorkflowOfferRouting({
  wf,
  jobId,
}: {
  wf: Pick<PlannedCandidateWorkflow, "id">;
  jobId: string;
}) {
  const qc = useQueryClient();
  const idem = useIdempotency();
  const q = useGetCandidateOfferRouting(jobId, wf.id, {
    query: {
      queryKey: getGetCandidateOfferRoutingQueryKey(jobId, wf.id),
      refetchInterval: 15000,
    },
  });
  const offerQ = useGetCandidateWorkflowOffer(jobId, wf.id, {
    query: {
      queryKey: getGetCandidateWorkflowOfferQueryKey(jobId, wf.id),
      refetchInterval: 15000,
    },
  });
  const m = useConfigureCandidateOfferRouting({});
  const st = q.data;
  const [form, setForm] = useState<Form>(EMPTY);
  const [reason, setReason] = useState("");
  const [dirty, setDirty] = useState(false);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initKey = useRef<string | null>(null);
  type Role = "owner" | "approver" | "sender";
  const [rec, setRec] = useState<Record<Role, string>>({ owner: "", approver: "", sender: "" });
  const [recReason, setRecReason] = useState("");
  const [recAck, setRecAck] = useState(false);
  const [recConfirm, setRecConfirm] = useState(false);
  const [recBase, setRecBase] = useState<number | null>(null);

  const key = st ? `${st.configuration?.configuredAt ?? "none"}:${st.workflowRevision}` : null;
  useEffect(() => {
    if (!st || !key || dirty || initKey.current === key) return;
    initKey.current = key;
    setForm(fromConfig(st));
  }, [st, key, dirty]);

  if (q.isLoading)
    return (
      <div
        className="h-12 animate-pulse rounded-md bg-muted"
        data-testid={`offer-routing-loading-${wf.id}`}
      />
    );
  if (q.isError || !st)
    return (
      <div className="space-y-1 text-sm" data-testid={`offer-routing-error-${wf.id}`}>
        <p role="alert" className="text-destructive">
          Could not load offer ownership. {errText(q.error)}
        </p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    );

  const cfg = st.configuration;
  const ids = new Set(st.people.map((p) => p.id));
  const lost =
    st.canConfigure &&
    cfg?.mode === "native" &&
    [cfg.ownerUserId, cfg.approverUserId, cfg.senderUserId].some((v) => !v || !ids.has(v));
  const current = offerQ.data?.offer ?? null;
  const offerStatus = current?.status;
  const curActive = !!current && current.status !== "withdrawn" && current.status !== "expired";
  const legacy = !cfg && curActive;
  const blocking = cfg
    ? curActive
    : legacy && (offerStatus === "sending" || form.mode === "external");
  const needsAck = legacy && form.mode === "native";
  const setF = (k: keyof Form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };
  const reasonOk = reason.trim().length >= 10;
  const url = form.externalApplicationUrl.trim();
  let formErr: string | null = null;
  if (form.mode === "native") {
    if (!form.ownerUserId || !form.approverUserId || !form.senderUserId)
      formErr = "Choose an owner, approver and sender.";
  } else {
    if (!form.externalSystem.trim()) formErr = "Name the external employer system.";
    else if (url && !/^https:\/\/\S+$/i.test(url)) formErr = "Application link must be HTTPS.";
  }
  const canSubmit =
    st.canConfigure && !formErr && reasonOk && !blocking && dirty && (!needsAck || ack);

  const recovery = st.recovery;
  const recoverable =
    !!recovery?.canRecover &&
    st.canConfigure &&
    cfg?.mode === "native" &&
    recovery.unavailableRoles.length > 0;
  const recBlocked = !!recovery && !recovery.canRecover && recovery.blockers.length > 0;
  const recStale = recBase !== null && recBase !== st.workflowRevision;
  const recRoles = recovery?.unavailableRoles ?? [];
  const recReasonOk = recReason.trim().length >= 10;
  const recFilled = recRoles.every((r) => !!rec[r]);
  const recReady = recoverable && recFilled && recReasonOk && recAck && !recStale;
  const recReset = () => {
    setRec({ owner: "", approver: "", sender: "" });
    setRecReason("");
    setRecAck(false);
    setRecConfirm(false);
    setRecBase(null);
    setError(null);
  };
  const recTouch = () => {
    setRecAck(false);
    setRecConfirm(false);
    setRecBase((b) => b ?? st.workflowRevision);
  };
  const recover = () => {
    setError(null);
    if (!recReady || !recConfirm || !cfg) return;
    const pick = (r: Role, cur: string | null) => (recRoles.includes(r) ? rec[r] : cur);
    const data: OfferRoutingInput = {
      idempotencyKey: "",
      expectedRevision: recBase ?? st.workflowRevision,
      reason: recReason.trim(),
      mode: "native",
      ownerUserId: pick("owner", cfg.ownerUserId),
      approverUserId: pick("approver", cfg.approverUserId),
      senderUserId: pick("sender", cfg.senderUserId),
      externalSystem: null,
      externalApplicationUrl: null,
      acknowledgeOwnershipRecovery: true,
    };
    data.idempotencyKey = idem.get(`${wf.id}:recovery:${JSON.stringify(data)}`);
    m.mutate(
      { jobId, workflowId: wf.id, data },
      {
        onSuccess: () => {
          idem.clear();
          recReset();
          initKey.current = null;
          qc.invalidateQueries({ queryKey: getGetCandidateOfferRoutingQueryKey(jobId, wf.id) });
          qc.invalidateQueries({ queryKey: getGetCandidateWorkflowOfferQueryKey(jobId, wf.id) });
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
          qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxQueryKey() });
          qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxItemQueryKey(wf.id) });
        },
        onError: (e) => {
          setError(errText(e));
          setRecConfirm(false);
          setRecAck(false);
          qc.invalidateQueries({ queryKey: getGetCandidateOfferRoutingQueryKey(jobId, wf.id) });
          qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxQueryKey() });
          qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxItemQueryKey(wf.id) });
        },
      },
    );
  };

  const save = () => {
    setError(null);
    if (!canSubmit) return;
    const data: OfferRoutingInput =
      form.mode === "native"
        ? {
            idempotencyKey: "",
            expectedRevision: st.workflowRevision,
            reason: reason.trim(),
            mode: "native",
            ownerUserId: form.ownerUserId,
            approverUserId: form.approverUserId,
            senderUserId: form.senderUserId,
            ...(needsAck ? { acknowledgeExistingOffer: true } : {}),
            externalSystem: null,
            externalApplicationUrl: null,
          }
        : {
            idempotencyKey: "",
            expectedRevision: st.workflowRevision,
            reason: reason.trim(),
            mode: "external",
            ownerUserId: form.ownerUserId || null,
            approverUserId: null,
            senderUserId: null,
            externalSystem: form.externalSystem.trim(),
            externalApplicationUrl: url || null,
          };
    data.idempotencyKey = idem.get(`${wf.id}:${JSON.stringify(data)}`);
    m.mutate(
      { jobId, workflowId: wf.id, data },
      {
        onSuccess: () => {
          idem.clear();
          setReason("");
          setDirty(false);
          setAck(false);
          initKey.current = null;
          qc.invalidateQueries({ queryKey: getGetCandidateOfferRoutingQueryKey(jobId, wf.id) });
          qc.invalidateQueries({ queryKey: getGetCandidateWorkflowOfferQueryKey(jobId, wf.id) });
          qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
          qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxQueryKey() });
          qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxItemQueryKey(wf.id) });
        },
        onError: (e) => {
          setError(errText(e));
          qc.invalidateQueries({ queryKey: getGetCandidateOfferRoutingQueryKey(jobId, wf.id) });
          qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxQueryKey() });
          qc.invalidateQueries({ queryKey: getGetEmployerOfferInboxItemQueryKey(wf.id) });
        },
      },
    );
  };

  const downloadPacket = () => {
    if (!st.packet) return;
    const blob = new Blob([JSON.stringify(st.packet, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `employer-packet-${wf.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const personSelect = (k: "ownerUserId" | "approverUserId" | "senderUserId", label: string) => (
    <label className="min-w-0 space-y-0.5 text-xs">
      <span>{label}</span>
      <select
        className={inputCls}
        value={form[k]}
        disabled={!st.canConfigure || m.isPending}
        onChange={(e) => setF(k, e.target.value)}
        data-testid={`offer-routing-${k}-${wf.id}`}
      >
        <option value="">{form.mode === "external" ? "None" : "Select a person"}</option>
        {st.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <section
      className="min-w-0 space-y-2 rounded-lg border border-border bg-card p-2 sm:p-3"
      aria-label="Offer ownership"
      data-testid={`offer-routing-${wf.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Offer ownership</p>
        <Badge variant="outline" data-testid={`offer-routing-mode-${wf.id}`}>
          {cfg ? (cfg.mode === "native" ? "Native Lexy" : "External employer") : "unconfigured"}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {HANDOFF[st.handoffStatus]}
      </p>
      {cfg?.mode === "native" && (
        <p className="text-xs [overflow-wrap:anywhere]">
          Owner {st.ownerName ?? "unavailable"} · Approver {st.approverName ?? "unavailable"} ·
          Sender {st.senderName ?? "unavailable"}
        </p>
      )}
      {cfg?.mode === "external" && (
        <p className="text-xs [overflow-wrap:anywhere]">
          Manual handoff to {cfg.externalSystem}
          {st.ownerName ? ` · contact ${st.ownerName}` : ""}.{" "}
          {cfg.externalApplicationUrl && (
            <a
              href={cfg.externalApplicationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              Open employer application
            </a>
          )}
        </p>
      )}
      {!cfg && (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`offer-routing-unconfigured-${wf.id}`}
        >
          Native offer controls stay disabled until an employer admin chooses who owns this
          candidate's offer. Offers are never sent automatically.
        </p>
      )}
      {lost && (
        <p
          role="alert"
          className="text-xs text-destructive"
          data-testid={`offer-routing-reassign-${wf.id}`}
        >
          A designated person is no longer available for this requisition. An employer admin must
          reassign; nobody was chosen automatically.
        </p>
      )}

      {st.packet && (
        <div
          className="space-y-1 rounded-md border border-border p-2 text-xs"
          data-testid={`offer-routing-packet-${wf.id}`}
        >
          <p className="font-medium">
            Employer packet: {st.packet.candidateName}
            {st.packet.testOnly && " · TEST ONLY"}
          </p>
          <p className="[overflow-wrap:anywhere]">
            Human decision: {st.packet.decision} by {st.packet.decisionBy} on{" "}
            {new Date(st.packet.decisionAt).toLocaleString()}. Reason: {st.packet.decisionReason}
          </p>
          <ul className="space-y-0.5">
            {st.packet.evidence.map((e) => (
              <li key={e.label} className="[overflow-wrap:anywhere]">
                {e.label} ({e.status.replace("_", " ")}): {e.evidence ?? "no evidence recorded"}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Recorded workflow evidence may be incomplete. This packet is not employment or identity
            clearance.
          </p>
          {cfg?.mode !== "external" && (
            <Button
              size="sm"
              variant="outline"
              onClick={downloadPacket}
              data-testid={`offer-routing-download-${wf.id}`}
            >
              Download packet
            </Button>
          )}
        </div>
      )}

      {cfg?.mode === "external" && <WorkflowAtsHandoff jobId={jobId} workflowId={wf.id} />}

      {recBlocked && recovery && (
        <div
          role="status"
          className="space-y-1 rounded-md border border-border p-2 text-xs text-destructive"
          data-testid={`offer-recovery-blocked-${wf.id}`}
        >
          <p className="font-medium">Ownership recovery is not available right now.</p>
          <ul className="list-disc pl-4">
            {recovery.blockers.map((b) => (
              <li key={b} className="[overflow-wrap:anywhere]">
                {b}
              </li>
            ))}
          </ul>
          <p>
            Contact the employer admin or reconcile the delivery attempt. Lexy offers no send or
            retry shortcut here.
          </p>
        </div>
      )}
      {recoverable && recovery && (
        <div
          className="space-y-2 rounded-md border border-border p-2 text-xs"
          aria-label="Recover offer ownership"
          data-testid={`offer-recovery-${wf.id}`}
        >
          <p className="text-sm font-medium">Recover unavailable ownership</p>
          <p>
            Unavailable: {recRoles.join(", ")}. Everyone still available keeps their role and the
            mode stays native. Choose replacements only for the unavailable roles.
            {recovery.resetsApproval &&
              " An unsent review or approval resets to draft and needs fresh human review."}{" "}
            Delivered terms, candidate responses and any claim are unchanged. No email is sent and
            there is no ATS sync, employment or fee effect.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {recRoles.map((r) => (
              <label key={r} className="min-w-0 space-y-0.5">
                <span className="capitalize">Replacement {r}</span>
                <select
                  className={inputCls}
                  value={rec[r]}
                  disabled={m.isPending}
                  onChange={(e) => {
                    setRec((x) => ({ ...x, [r]: e.target.value }));
                    recTouch();
                  }}
                  data-testid={`offer-recovery-${r}-${wf.id}`}
                >
                  <option value="">Select a person</option>
                  {st.people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="min-w-0 space-y-0.5 sm:col-span-2">
              <span>Written recovery reason (10 or more characters)</span>
              <textarea
                className={inputCls}
                rows={2}
                maxLength={4000}
                value={recReason}
                disabled={m.isPending}
                onChange={(e) => {
                  setRecReason(e.target.value);
                  recTouch();
                }}
                data-testid={`offer-recovery-reason-${wf.id}`}
              />
            </label>
          </div>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={recAck}
              disabled={m.isPending || recStale}
              onChange={(e) => {
                setRecAck(e.target.checked);
                setRecConfirm(false);
              }}
              data-testid={`offer-recovery-ack-${wf.id}`}
            />
            <span>
              I acknowledge this ownership recovery for the unavailable roles only, including the
              reset of any unsent approval.
            </span>
          </label>
          {recStale && (
            <p
              role="alert"
              className="text-destructive"
              data-testid={`offer-recovery-stale-${wf.id}`}
            >
              Ownership changed while you were editing. Discard your edits to load the latest state;
              nothing was adopted silently.
            </p>
          )}
          {recConfirm && recReady && (
            <div
              role="alertdialog"
              aria-label="Confirm ownership recovery"
              className="space-y-2 rounded-md border border-border bg-muted p-2"
              data-testid={`offer-recovery-confirm-${wf.id}`}
            >
              <p>
                Confirm recovery of {recRoles.join(", ")}? Available assignees stay unchanged and
                nothing is sent.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={m.isPending}
                  onClick={recover}
                  data-testid={`offer-recovery-confirm-action-${wf.id}`}
                >
                  {m.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                  Confirm recovery
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={m.isPending}
                  onClick={() => setRecConfirm(false)}
                >
                  Back
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!recReady || m.isPending || recConfirm}
              onClick={() => setRecConfirm(true)}
              data-testid={`offer-recovery-review-${wf.id}`}
            >
              Review recovery
            </Button>
            {recBase !== null && (
              <Button size="sm" variant="ghost" disabled={m.isPending} onClick={recReset}>
                Discard edits
              </Button>
            )}
          </div>
        </div>
      )}

      {st.canConfigure && !recoverable ? (
        <div className="space-y-2">
          <fieldset className="flex flex-wrap gap-3 text-xs" disabled={m.isPending}>
            <legend className="sr-only">Offer owner</legend>
            {(["native", "external"] as const).map((md) => (
              <label key={md} className="flex items-center gap-1">
                <input
                  type="radio"
                  name={`routing-mode-${wf.id}`}
                  checked={form.mode === md}
                  onChange={() => {
                    setForm((f) => ({
                      ...f,
                      mode: md,
                      ownerUserId: "",
                      approverUserId: "",
                      senderUserId: "",
                    }));
                    setAck(false);
                    setDirty(true);
                  }}
                  data-testid={`offer-routing-radio-${md}-${wf.id}`}
                />
                {md === "native" ? "Native Lexy" : "External employer / ATS"}
              </label>
            ))}
          </fieldset>
          <div className="grid gap-2 sm:grid-cols-2">
            {personSelect(
              "ownerUserId",
              form.mode === "native" ? "Owner (terms, review)" : "Employer contact (optional)",
            )}
            {form.mode === "native" && personSelect("approverUserId", "Approver")}
            {form.mode === "native" && personSelect("senderUserId", "Sender")}
            {form.mode === "external" && (
              <>
                <label className="min-w-0 space-y-0.5 text-xs">
                  <span>External system name</span>
                  <input
                    className={inputCls}
                    maxLength={160}
                    value={form.externalSystem}
                    onChange={(e) => setF("externalSystem", e.target.value)}
                    data-testid={`offer-routing-system-${wf.id}`}
                  />
                </label>
                <label className="min-w-0 space-y-0.5 text-xs sm:col-span-2">
                  <span>Application link (optional, HTTPS)</span>
                  <input
                    className={inputCls}
                    type="url"
                    maxLength={2000}
                    value={form.externalApplicationUrl}
                    onChange={(e) => setF("externalApplicationUrl", e.target.value)}
                    data-testid={`offer-routing-url-${wf.id}`}
                  />
                </label>
              </>
            )}
            <label className="min-w-0 space-y-0.5 text-xs sm:col-span-2">
              <span>Written reason (10 or more characters)</span>
              <textarea
                className={inputCls}
                rows={2}
                maxLength={4000}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setDirty(true);
                }}
                data-testid={`offer-routing-reason-${wf.id}`}
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            The same person may fill several roles, but approval and send remain separate actions.
            External is a manual handoff, not a connected or synced integration.
          </p>
          {needsAck && (
            <label
              className="flex items-start gap-2 rounded-md border border-border p-2 text-xs"
              data-testid={`offer-routing-legacy-${wf.id}`}
            >
              <input
                type="checkbox"
                checked={ack}
                disabled={m.isPending || offerStatus === "sending"}
                onChange={(e) => {
                  setAck(e.target.checked);
                  setDirty(true);
                }}
                data-testid={`offer-routing-ack-${wf.id}`}
              />
              <span>
                An existing offer ({offerStatus?.replace("_", " ")}) predates ownership. I
                acknowledge adopting it as native Lexy: a sent offer and any candidate response are
                preserved, while unsent approvals are reset and need fresh review. Nothing is
                withdrawn or reassigned silently.
              </span>
            </label>
          )}
          {legacy && form.mode === "external" && (
            <p role="status" className="text-xs text-destructive">
              External ownership cannot adopt an existing offer. Withdraw it explicitly first, or
              choose native.
            </p>
          )}
          {legacy && offerStatus === "sending" && (
            <p role="status" className="text-xs text-destructive">
              The offer is sending. Wait until delivery finishes before adopting it.
            </p>
          )}
          {blocking && cfg && (
            <p
              role="status"
              className="text-xs text-destructive"
              data-testid={`offer-routing-blocked-${wf.id}`}
            >
              The current offer{offerStatus ? ` (${offerStatus.replace("_", " ")})` : ""} must be
              explicitly withdrawn before ownership can change. Nothing is withdrawn automatically.
            </p>
          )}
          {formErr && dirty && <p className="text-xs text-destructive">{formErr}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!canSubmit || m.isPending}
              onClick={save}
              data-testid={`offer-routing-save-${wf.id}`}
            >
              {m.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Save ownership
            </Button>
            {dirty && (
              <Button
                size="sm"
                variant="ghost"
                disabled={m.isPending}
                onClick={() => {
                  setForm(fromConfig(st));
                  setReason("");
                  setDirty(false);
                  setAck(false);
                  setError(null);
                }}
              >
                Discard edits
              </Button>
            )}
          </div>
        </div>
      ) : !st.canConfigure ? (
        <p className="text-xs text-muted-foreground">
          Only the employer's tenant admin can choose offer ownership.
        </p>
      ) : null}
      <ErrorLine message={error} testId={`offer-routing-action-error-${wf.id}`} />
    </section>
  );
}
