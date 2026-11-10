import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsHandoffQueryKey,
  getGetCandidateOfferRoutingQueryKey,
  getGetCandidateWorkflowOfferQueryKey,
  getGetJobWorkflowStateQueryKey,
  useControlCandidateAtsHandoff,
  useGetCandidateAtsHandoff,
  type AtsHandoffInput,
  type AtsHandoffPacket,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { errText } from "./workflow-shared";
import { WorkflowAtsVerification } from "./WorkflowAtsVerification";
import { WorkflowHandoffReceipt } from "./WorkflowHandoffReceipt";

type MapForm = {
  accountRef: string;
  externalJobId: string;
  externalCandidateId: string;
  externalApplicationId: string;
};
const EMPTY: MapForm = {
  accountRef: "",
  externalJobId: "",
  externalCandidateId: "",
  externalApplicationId: "",
};
const FIELDS: [keyof MapForm, string][] = [
  ["accountRef", "ATS account reference"],
  ["externalJobId", "External job ID"],
  ["externalCandidateId", "External candidate ID"],
  ["externalApplicationId", "External application ID"],
];
const inputCls = "w-full rounded-md border border-border bg-background p-2 text-sm";

export function WorkflowAtsHandoff({ jobId, workflowId }: { jobId: string; workflowId: string }) {
  const qc = useQueryClient();
  const key = getGetCandidateAtsHandoffQueryKey(jobId, workflowId);
  const q = useGetCandidateAtsHandoff(jobId, workflowId, {
    query: { queryKey: key, refetchInterval: 8000, retry: false },
  });
  const m = useControlCandidateAtsHandoff({});
  const st = q.data;
  const [form, setForm] = useState<MapForm>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mapKey = st?.mapping
    ? `${st.mapping.externalApplicationId}:${st.mapping.mappedAt}`
    : "none";
  useEffect(() => {
    if (!st || dirty) return;
    const mp = st.mapping;
    setForm(
      mp
        ? {
            accountRef: mp.accountRef,
            externalJobId: mp.externalJobId,
            externalCandidateId: mp.externalCandidateId,
            externalApplicationId: mp.externalApplicationId,
          }
        : EMPTY,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey, dirty, !!st]);

  const pktId = st?.packet?.id;
  const pktHash = st?.packet?.snapshotHash;
  useEffect(() => {
    setAck(false);
  }, [pktId, pktHash]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: getGetJobWorkflowStateQueryKey(jobId) });
    qc.invalidateQueries({ queryKey: getGetCandidateOfferRoutingQueryKey(jobId, workflowId) });
    qc.invalidateQueries({ queryKey: getGetCandidateWorkflowOfferQueryKey(jobId, workflowId) });
  };

  if (q.isLoading)
    return (
      <div
        className="h-12 animate-pulse rounded-md bg-muted"
        data-testid={`ats-handoff-loading-${workflowId}`}
      />
    );
  if (q.isError || q.failureReason || !st)
    return (
      <div className="space-y-1 text-sm" data-testid={`ats-handoff-error-${workflowId}`}>
        <p role="alert" className="text-destructive">
          Could not load the ATS handoff. {errText(q.error ?? q.failureReason)}
        </p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          Retry
        </Button>
      </div>
    );

  const pkt = st.packet;
  const current = !!pkt && !st.stale;
  const approved = !!pkt?.approvedAt;
  const mapOk = FIELDS.every(([k]) => form[k].trim().length > 0);
  const busy = m.isPending;

  const run = (
    extra: Partial<AtsHandoffInput> & Pick<AtsHandoffInput, "action">,
    onDone?: (r: Awaited<ReturnType<typeof m.mutateAsync>>) => void,
  ) => {
    setError(null);
    setNotice(null);
    const data: AtsHandoffInput = {
      idempotencyKey: crypto.randomUUID(),
      expectedRevision: st.workflowRevision,
      ...extra,
    };
    m.mutate(
      { jobId, workflowId, data },
      {
        onSuccess: (r) => {
          onDone?.(r);
          refresh();
        },
        onError: (e) => {
          setError(errText(e));
          refresh();
        },
      },
    );
  };

  const saveMapping = () => {
    if (!st.canManage || !mapOk) return;
    run(
      {
        action: "save_mapping",
        mapping: {
          accountRef: form.accountRef.trim(),
          externalJobId: form.externalJobId.trim(),
          externalCandidateId: form.externalCandidateId.trim(),
          externalApplicationId: form.externalApplicationId.trim(),
        },
      },
      () => {
        setDirty(false);
        setNotice("Mapping saved. Any prepared packet must be reviewed again if it is now stale.");
      },
    );
  };
  const clearMapping = () =>
    run({ action: "clear_mapping", acknowledgeReview: true }, () => {
      setDirty(false);
      setConfirmClear(false);
      setForm(EMPTY);
      setNotice("Mapping cleared.");
    });
  const prepare = () =>
    run({ action: "prepare" }, () => setNotice("Packet prepared. Review the snapshot below."));
  const approve = () => {
    if (!pkt || !current || !ack || dirty) return;
    run(
      {
        action: "approve",
        packetId: pkt.id,
        snapshotHash: pkt.snapshotHash,
        acknowledgeReview: true,
      },
      () => {
        setAck(false);
        setNotice("Snapshot approved for manual export.");
      },
    );
  };
  const exportPkt = () => {
    if (!pkt || !current || !approved || dirty) return;
    run({ action: "export", packetId: pkt.id, snapshotHash: pkt.snapshotHash }, (r) => {
      const ep: AtsHandoffPacket | undefined = r.exportPacket;
      if (!ep) {
        setError("The server did not return an export packet. Nothing was downloaded.");
        return;
      }
      const blob = new Blob([JSON.stringify(ep, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `ats-handoff-${workflowId}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setNotice("Reviewed packet downloaded. Nothing was sent to any ATS.");
    });
  };

  const c = pkt?.content;
  return (
    <section
      className="min-w-0 space-y-2 rounded-lg border border-border bg-card p-2 sm:p-3"
      aria-label="ATS manual handoff"
      data-testid={`ats-handoff-${workflowId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">ATS manual handoff</p>
        <Badge variant="outline">Not connected</Badge>
        <Badge variant="outline">Manual export only</Badge>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        This packet is a manual handoff, not ATS synchronization, and sends no offer. You map IDs by
        hand, review an exact snapshot and download a file yourself. The separate Greenhouse
        verification section below can check mapped records through an employer-approved connection.
      </p>

      {!st.canManage && (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`ats-handoff-denied-${workflowId}`}
        >
          You do not have permission to manage this ATS handoff.
        </p>
      )}

      {!st.ready && st.blockers.length > 0 && (
        <div
          role="status"
          className="space-y-1 rounded-md border border-border p-2 text-xs text-destructive"
          data-testid={`ats-handoff-blockers-${workflowId}`}
        >
          <p className="font-medium">Packet preparation, approval and export are blocked.</p>
          <ul className="list-disc pl-4">
            {st.blockers.map((b) => (
              <li key={b} className="[overflow-wrap:anywhere]">
                {b}
              </li>
            ))}
          </ul>
        </div>
      )}

      {st.mapping && (
        <p className="text-xs [overflow-wrap:anywhere]">
          Mapped to {st.mapping.system} account {st.mapping.accountRef} by {st.mapping.mappedBy} on{" "}
          {new Date(st.mapping.mappedAt).toLocaleString()}.
        </p>
      )}

      {st.canManage && (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {FIELDS.map(([k, label]) => (
              <label key={k} className="min-w-0 space-y-0.5 text-xs">
                <span>{label}</span>
                <input
                  className={inputCls}
                  maxLength={128}
                  value={form[k]}
                  disabled={busy}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, [k]: e.target.value }));
                    setDirty(true);
                  }}
                  data-testid={`ats-handoff-${k}-${workflowId}`}
                />
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={!mapOk || !dirty || busy}
              onClick={saveMapping}
              data-testid={`ats-handoff-save-${workflowId}`}
            >
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Save mapping
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
              >
                Discard edits
              </Button>
            )}
            {st.mapping && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || confirmClear}
                onClick={() => setConfirmClear(true)}
              >
                Clear mapping
              </Button>
            )}
          </div>
          {confirmClear && (
            <div
              role="alertdialog"
              aria-label="Confirm clear mapping"
              className="space-y-2 rounded-md border border-border bg-muted p-2 text-xs"
            >
              <p>
                Clear this mapping? This removes the saved external IDs and makes any prepared
                packet stale. It cannot be undone, and nothing changes in any ATS.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={clearMapping}
                  data-testid={`ats-handoff-clear-confirm-${workflowId}`}
                >
                  Clear mapping permanently
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmClear(false)}
                >
                  Back
                </Button>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!st.ready || !st.mapping || dirty || busy}
              onClick={prepare}
              data-testid={`ats-handoff-prepare-${workflowId}`}
            >
              {pkt ? "Prepare fresh packet" : "Prepare packet"}
            </Button>
          </div>
        </div>
      )}

      {pkt && c && (
        <div
          className="space-y-1.5 rounded-md border border-border p-2 text-xs"
          data-testid={`ats-handoff-snapshot-${workflowId}`}
        >
          <p className="font-medium">
            Snapshot for review: {c.candidate.name} for {c.job.title}
            {c.decision.testOnly && " · TEST ONLY"}
          </p>
          {st.stale && (
            <p
              role="alert"
              className="text-destructive"
              data-testid={`ats-handoff-stale-${workflowId}`}
            >
              This packet is stale: the workflow or mapping changed after it was prepared. Prepare a
              fresh packet; it cannot be approved or exported.
            </p>
          )}
          <p className="text-muted-foreground [overflow-wrap:anywhere]">
            Prepared by {pkt.preparedBy} on {new Date(pkt.preparedAt).toLocaleString()}. Hash{" "}
            {pkt.snapshotHash}.
            {pkt.approvedAt &&
              ` Approved by ${pkt.approvedBy} on ${new Date(pkt.approvedAt).toLocaleString()}.`}
            {pkt.exportedAt &&
              ` Exported by ${pkt.exportedBy} on ${new Date(pkt.exportedAt).toLocaleString()}.`}
          </p>
          <p className="[overflow-wrap:anywhere]">
            Mapping: account {c.mapping.accountRef}, job {c.mapping.externalJobId}, candidate{" "}
            {c.mapping.externalCandidateId}, application {c.mapping.externalApplicationId}.
          </p>
          <p className="[overflow-wrap:anywhere]">
            Human decision: {c.decision.outcome} by {c.decision.actorName} on{" "}
            {new Date(c.decision.decidedAt).toLocaleString()}. Reason: {c.decision.reason}
            {c.decision.testOnly && " (TEST ONLY)"}
          </p>
          <div>
            <p className="font-medium">Steps</p>
            <ul className="space-y-0.5">
              {c.steps.map((s) => (
                <li key={s.key} className="[overflow-wrap:anywhere]">
                  {s.label}: {s.status.replace(/_/g, " ")}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="font-medium">Assessment summaries</p>
            {c.assessments.length === 0 ? (
              <p className="text-muted-foreground">No assessment summaries recorded.</p>
            ) : (
              <ul className="space-y-0.5">
                {c.assessments.map((a) => (
                  <li key={`${a.sourceType}:${a.sourceId}`} className="[overflow-wrap:anywhere]">
                    {a.attentionRequired && <strong>Attention required · </strong>}
                    {a.stepKey} ({a.scope}, {new Date(a.occurredAt).toLocaleDateString()}):{" "}
                    {a.summary}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="font-medium">Cautions</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {c.cautions.map((x) => (
                <li key={x} className="[overflow-wrap:anywhere]">
                  {x}
                </li>
              ))}
            </ul>
          </div>

          {st.canManage && (
            <div className="space-y-2 border-t border-border pt-2">
              {!approved && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={ack}
                    disabled={busy || !current || !st.ready || dirty}
                    onChange={(e) => setAck(e.target.checked)}
                    data-testid={`ats-handoff-ack-${workflowId}`}
                  />
                  <span>
                    I reviewed this exact snapshot, including the decision and cautions, and approve
                    it for manual export.
                  </span>
                </label>
              )}
              <div className="flex flex-wrap gap-2">
                {!approved && (
                  <Button
                    size="sm"
                    disabled={!st.ready || !current || !ack || busy || dirty}
                    onClick={approve}
                    data-testid={`ats-handoff-approve-${workflowId}`}
                  >
                    Approve snapshot
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!st.ready || !current || !approved || busy || dirty}
                  onClick={exportPkt}
                  data-testid={`ats-handoff-export-${workflowId}`}
                >
                  Export reviewed JSON
                </Button>
              </div>
              <WorkflowHandoffReceipt
                packet={pkt}
                workflowId={workflowId}
                enabled={!busy && current && st.ready && !dirty}
                onRecord={(reference) =>
                  run(
                    {
                      action: "record_handoff",
                      packetId: pkt.id,
                      snapshotHash: pkt.snapshotHash,
                      acknowledgeReview: true,
                      evidenceReference: reference,
                    },
                    () =>
                      setNotice(
                        "Manual handoff recorded locally. No ATS receipt, offer approval or delivery is implied.",
                      ),
                  )
                }
              />
            </div>
          )}
        </div>
      )}

      <WorkflowAtsVerification
        jobId={jobId}
        workflowId={workflowId}
        mappedAccountRef={st.mapping?.accountRef ?? null}
      />

      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="space-y-1 text-sm text-destructive"
          data-testid={`ats-handoff-action-error-${workflowId}`}
        >
          <p>{error}</p>
          <Button size="sm" variant="outline" onClick={() => q.refetch()}>
            Refresh state
          </Button>
        </div>
      )}
    </section>
  );
}
