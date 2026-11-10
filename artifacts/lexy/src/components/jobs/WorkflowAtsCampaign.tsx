import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateAtsCampaignQueryKey,
  getGetCandidateAtsCampaignsQueryKey,
  useGetCandidateAtsCampaigns,
  usePrepareCandidateAtsCampaign,
  type AtsImportedRecord,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { errText, useIdempotency } from "./workflow-shared";
import { MAX_CAMPAIGN_RECIPIENTS, prepareSignature } from "./ats-campaign-shared";
import { WorkflowAtsCampaignDetail } from "./WorkflowAtsCampaignDetail";

type Props = {
  jobId: string;
  workflowId: string;
  records: AtsImportedRecord[];
  truncated: boolean;
};

export function WorkflowAtsCampaign({ jobId, workflowId, records, truncated }: Props) {
  const qc = useQueryClient();
  const indexKey = getGetCandidateAtsCampaignsQueryKey(jobId, workflowId);
  const q = useGetCandidateAtsCampaigns(jobId, workflowId, {
    query: { queryKey: indexKey, retry: false, staleTime: 0, gcTime: 0, refetchOnMount: "always" },
  });
  const prepare = usePrepareCandidateAtsCampaign({ mutation: { retry: false, gcTime: 0 } });
  const idem = useIdempotency();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [planId, setPlanId] = useState<string>("");
  const [ackSig, setAckSig] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = `${jobId}|${workflowId}`;

  useEffect(() => {
    setSelected(new Set());
    setPlanId("");
    setAckSig(null);
    setCampaignId(null);
    setError(null);
    idem.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const idx = q.isSuccess && !q.isFetching && !q.isError && !q.failureReason ? q.data : undefined;
  const plan = idx?.plans.find((x) => x.id === planId);
  const visibleIds = records.filter((r) => selected.has(r.id)).map((r) => r.id);
  const sig =
    idx && plan ? prepareSignature(visibleIds, plan.id, plan.approvalHash, idx.sourceHash) : null;
  const ackValid = !!sig && ackSig === sig;
  const canPrepare =
    !!sig &&
    ackValid &&
    visibleIds.length >= 1 &&
    visibleIds.length <= MAX_CAMPAIGN_RECIPIENTS &&
    !prepare.isPending;

  const toggle = (id: string) => {
    setAckSig(null);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else if (n.size < MAX_CAMPAIGN_RECIPIENTS) n.add(id);
      return n;
    });
  };

  const doPrepare = () => {
    if (!canPrepare || !idx || !plan || !sig) return;
    setError(null);
    const idempotencyKey = idem.get(sig);
    prepare.mutate(
      {
        jobId,
        workflowId,
        data: {
          recordIds: visibleIds,
          planId: plan.id,
          planHash: plan.approvalHash,
          sourceHash: idx.sourceHash,
          idempotencyKey,
          acknowledge: true,
        },
      },
      {
        onSuccess: (d) => {
          idem.clear();
          qc.setQueryData(getGetCandidateAtsCampaignQueryKey(jobId, workflowId, d.id), d);
          void qc.invalidateQueries({ queryKey: indexKey });
          setSelected(new Set());
          setAckSig(null);
          setCampaignId(d.id);
        },
        onError: (e) => {
          setError(`${errText(e)} Retrying with the same selection reuses the same request key.`);
          void qc.invalidateQueries({ queryKey: indexKey });
        },
      },
    );
  };

  return (
    <section
      className="space-y-3 border-t border-border pt-3"
      aria-labelledby={`ats-campaign-title-${workflowId}`}
      data-testid={`ats-campaign-${workflowId}`}
    >
      <header className="space-y-0.5">
        <h4 id={`ats-campaign-title-${workflowId}`} className="text-sm font-semibold">
          Greenhouse interview campaign
        </h4>
        <p className="text-sm text-muted-foreground">
          Prepare interview links for up to {MAX_CAMPAIGN_RECIPIENTS} linked applicants, review
          every exact message, approve, then run sends yourself. Nothing is emailed until you press
          Run.
        </p>
      </header>

      {q.isFetching && (
        <div role="status" aria-label="Loading campaigns" className="space-y-1.5">
          <div className="h-4 w-1/2 rounded skeleton-shimmer" />
          <div className="h-4 w-1/3 rounded skeleton-shimmer" />
        </div>
      )}
      {!q.isFetching && (q.isError || q.failureReason) && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          {errText(q.error ?? q.failureReason)}
          <Button
            size="sm"
            variant="outline"
            onClick={() => q.refetch()}
            data-testid="ats-campaigns-retry"
          >
            Retry
          </Button>
        </div>
      )}

      {idx && (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
          <div className="space-y-2 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                1 · Applicants
              </p>
              <span
                className="text-xs tabular-nums text-muted-foreground"
                data-testid="ats-campaign-selected-count"
              >
                {visibleIds.length}/{MAX_CAMPAIGN_RECIPIENTS} selected
              </span>
            </div>
            {records.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No imported applicants are listed yet.
              </p>
            ) : (
              <ul className="max-h-56 space-y-1 overflow-auto pr-1">
                {records.map((r) => {
                  const on = selected.has(r.id);
                  return (
                    <li key={r.id}>
                      <label
                        className={`flex items-start gap-2 rounded-md px-1.5 py-1 text-sm transition-colors ${on ? "bg-accent-soft/30" : "hover:bg-muted"}`}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={
                            prepare.isPending || (!on && selected.size >= MAX_CAMPAIGN_RECIPIENTS)
                          }
                          onChange={() => toggle(r.id)}
                          data-testid={`ats-campaign-select-${r.id}`}
                        />
                        <span className="[overflow-wrap:anywhere]">
                          Application {r.application.id} · Candidate {r.application.candidateId}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {truncated && (
              <p className="text-xs text-muted-foreground">
                Only the 100 most recent imports are selectable.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Candidate profiles must already be linked. Unlinked applicants are rejected, never
              imported implicitly.
            </p>
          </div>

          <div className="space-y-2 rounded-xl border border-border bg-card p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              2 · Interview plan
            </p>
            {idx.plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No approved interview plan is available.
              </p>
            ) : (
              <fieldset className="space-y-1" disabled={prepare.isPending}>
                <legend className="sr-only">Interview plan</legend>
                {idx.plans.map((pl) => (
                  <label key={pl.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name={`ats-campaign-plan-${workflowId}`}
                      checked={planId === pl.id}
                      onChange={() => {
                        setPlanId(pl.id);
                        setAckSig(null);
                      }}
                      data-testid={`ats-campaign-plan-${pl.id}`}
                    />
                    <span>
                      {pl.title}
                      <span className="block text-xs text-muted-foreground">
                        {pl.questionCount} questions · {pl.language}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={ackValid}
                disabled={!sig || prepare.isPending}
                onChange={(e) => setAckSig(e.target.checked ? sig : null)}
                data-testid="ats-campaign-prepare-ack"
              />
              Prepare interview links for these applicants without emailing anyone. Messages are
              only sent after separate approval and Run.
            </label>
            <Button
              size="sm"
              disabled={!canPrepare}
              onClick={doPrepare}
              data-testid="ats-campaign-prepare"
            >
              {prepare.isPending ? "Preparing preview…" : "Prepare batch preview"}
            </Button>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>
      )}

      {idx && (
        <div className="space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent campaigns
          </p>
          {idx.campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No campaigns prepared yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" data-testid="ats-campaign-list">
              {idx.campaigns.slice(0, 20).map((c) => {
                const active = c.id === campaignId;
                const state = c.cancelled ? "cancelled" : c.approved ? "approved" : "in review";
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={active}
                      onClick={() => setCampaignId(active ? null : c.id)}
                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card hover:bg-muted"}`}
                      data-testid={`ats-campaign-open-${c.id}`}
                    >
                      {new Date(c.createdAt).toLocaleString()} · {c.recipientCount} selected at
                      preparation · {state}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {idx.truncated && (
            <p className="text-xs text-muted-foreground" data-testid="ats-campaign-truncated">
              Showing the 20 most recent campaigns; older campaigns are not listed.
            </p>
          )}
        </div>
      )}

      {campaignId && (
        <WorkflowAtsCampaignDetail
          key={campaignId}
          jobId={jobId}
          workflowId={workflowId}
          campaignId={campaignId}
        />
      )}
    </section>
  );
}
